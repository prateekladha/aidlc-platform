// Anthropic Claude adapter — the platform's default model, replacing the Google (Vertex/Gemini) adapters
// the engine shipped with. Implements the engine's `Model` port exactly, so it drops into the Supervisor
// unchanged. No Google, no GCP. BYO-key: the platform resolves the tenant's key per run and constructs this
// with it; the managed-billing path passes the platform key. The main loop runs on a strong coding model;
// the high-volume critic runs on a cheap one (see defaults below).
//
// Mapping notes:
//  - role 'tool' → an Anthropic `user` message carrying a tool_result block (that is how the Messages API
//    represents tool output). Adjacent same-role messages are coalesced into one with multiple blocks.
//  - `thinking` maps to Anthropic extended thinking (budget by level). Thinking tokens are billed as output
//    by Anthropic, so they are folded into outputTokens; we surface the split when the API reports it.
//  - usage.promptTokens INCLUDES cached tokens (the engine's cost console assumes this).

import Anthropic from '@anthropic-ai/sdk';
import type { Model, ModelTurn, GenerateInput, Msg, ToolCall } from '../types';

export interface ClaudeModelOptions {
    apiKey?: string;        // defaults to ANTHROPIC_API_KEY; the platform injects the per-run (tenant) key
    model?: string;         // defaults to the main coding model
    maxTokens?: number;     // response cap (must exceed any thinking budget)
    baseURL?: string;       // for gateways/proxies; optional
}

// Claude 5 family (latest). Main loop = Sonnet (the coding workhorse); critic = Haiku (cheap, high-volume).
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const DEFAULT_MAX_TOKENS = 8192;
const THINKING_BUDGET: Record<NonNullable<GenerateInput['thinking']>, number> = {
    low: 1024,
    medium: 4096,
    high: 12288,
};

type Block =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

interface ApiMessage { role: 'user' | 'assistant'; content: Block[] }

/** One engine Msg → its Anthropic role + content blocks. */
function blocksFor(m: Msg): { role: 'user' | 'assistant'; content: Block[] } {
    if (m.role === 'tool') {
        const r = m.toolResult;
        const content: Block[] = [{
            type: 'tool_result',
            tool_use_id: r?.callId || '',
            content: typeof r?.output === 'string' ? r.output : JSON.stringify(r?.output ?? null),
            is_error: r ? !r.ok : false,
        }];
        return { role: 'user', content };
    }
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    const content: Block[] = [];
    if (m.text) content.push({ type: 'text', text: m.text });
    for (const f of m.files || []) {
        if (f.dataBase64) content.push({ type: 'image', source: { type: 'base64', media_type: f.mimeType, data: f.dataBase64 } });
    }
    for (const c of m.toolCalls || []) {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
    }
    if (content.length === 0) content.push({ type: 'text', text: '' });
    return { role, content };
}

/** Coalesce adjacent same-role messages (the Messages API prefers one message per role run). */
function toApiMessages(messages: Msg[]): ApiMessage[] {
    const out: ApiMessage[] = [];
    for (const m of messages) {
        const { role, content } = blocksFor(m);
        const last = out[out.length - 1];
        if (last && last.role === role) last.content.push(...content);
        else out.push({ role, content });
    }
    return out;
}

export class ClaudeModel implements Model {
    readonly id: string;
    private readonly client: Anthropic;
    private readonly maxTokens: number;

    constructor(opts: ClaudeModelOptions = {}) {
        const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error('ClaudeModel: no API key (set ANTHROPIC_API_KEY or pass apiKey)');
        this.client = new Anthropic({ apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
        this.id = opts.model || DEFAULT_MODEL;
        this.maxTokens = opts.maxTokens || DEFAULT_MAX_TOKENS;
    }

    private buildParams(input: GenerateInput): Anthropic.MessageCreateParamsNonStreaming {
        // The volatile per-turn block (time, memories) is kept out of the cache-friendly system prefix by the
        // engine; we append it as a trailing system segment so the stable prefix stays byte-identical.
        const system = input.context ? `${input.system}\n\n${input.context}` : input.system;
        const params: Anthropic.MessageCreateParamsNonStreaming = {
            model: this.id,
            max_tokens: this.maxTokens,
            system,
            messages: toApiMessages(input.messages) as Anthropic.MessageParam[],
        };
        if (input.tools.length) {
            params.tools = input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema }));
        }
        if (input.thinking) {
            const budget = THINKING_BUDGET[input.thinking];
            // Thinking budget must be < max_tokens; widen the cap if needed.
            if (budget >= params.max_tokens) params.max_tokens = budget + 2048;
            params.thinking = { type: 'enabled', budget_tokens: budget };
        }
        return params;
    }

    private usageOf(u: Anthropic.Usage | undefined): ModelTurn['usage'] {
        if (!u) return undefined;
        const cached = (u.cache_read_input_tokens || 0);
        const promptTokens = (u.input_tokens || 0) + cached + (u.cache_creation_input_tokens || 0);
        const outputTokens = u.output_tokens || 0;
        return { promptTokens, cachedTokens: cached, outputTokens, totalTokens: promptTokens + outputTokens };
    }

    async generate(input: GenerateInput): Promise<ModelTurn> {
        const res = await this.client.messages.create(this.buildParams(input));
        let text = '';
        const toolCalls: ToolCall[] = [];
        for (const block of res.content) {
            if (block.type === 'text') text += block.text;
            else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, args: (block.input ?? {}) as Record<string, unknown> });
        }
        const turn: ModelTurn = { usage: this.usageOf(res.usage) };
        if (text) turn.text = text;
        if (toolCalls.length) turn.toolCalls = toolCalls;
        return turn;
    }

    async generateStream(input: GenerateInput, onToken: (delta: string) => void): Promise<ModelTurn> {
        const stream = this.client.messages.stream(this.buildParams(input) as unknown as Parameters<typeof this.client.messages.stream>[0]);
        stream.on('text', (delta: string) => { try { onToken(delta); } catch { /* sink best-effort */ } });
        const res = await stream.finalMessage();
        let text = '';
        const toolCalls: ToolCall[] = [];
        for (const block of res.content) {
            if (block.type === 'text') text += block.text;
            else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, args: (block.input ?? {}) as Record<string, unknown> });
        }
        const turn: ModelTurn = { usage: this.usageOf(res.usage) };
        if (text) turn.text = text;
        if (toolCalls.length) turn.toolCalls = toolCalls;
        return turn;
    }
}

/** The platform's default pair: strong coding model for the loop, cheap model for the high-volume critic. */
export function makeClaudePair(apiKey?: string): { model: Model; criticModel: Model } {
    return {
        model: new ClaudeModel({ apiKey, model: process.env.AIDLC_MODEL || DEFAULT_MODEL }),
        criticModel: new ClaudeModel({ apiKey, model: process.env.AIDLC_CRITIC_MODEL || 'claude-haiku-5-5' }),
    };
}
