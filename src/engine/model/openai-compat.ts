// OpenAI-compatible model adapter — the platform's CHEAP, multi-provider default. A huge share of low-cost
// providers expose the exact OpenAI /v1/chat/completions dialect, so ONE adapter + a configurable baseURL +
// model + key covers them all: DeepSeek, Alibaba Qwen (DashScope compat), Zhipu/Z.ai GLM, Moonshot Kimi,
// Sarvam (India), and gateways like OpenRouter / Together / Groq / Fireworks / DeepInfra / Novita — plus any
// self-hosted vLLM/Ollama endpoint. Model + provider + key are per-TENANT onboarding settings (BYO-key); the
// managed path passes the platform's key. Implements the engine's `Model` port exactly, so it drops into the
// Supervisor unchanged. Raw fetch — no SDK dependency, works against any compliant endpoint.
//
// NOTE: pending Node-toolchain access in this environment, this is written but not yet tsc-verified.

import type { Model, ModelTurn, GenerateInput, Msg, ToolCall } from '../types';

export interface OpenAICompatOptions {
    baseURL: string;        // e.g. https://api.deepseek.com/v1 , https://openrouter.ai/api/v1 , https://api.sarvam.ai/v1
    apiKey: string;         // the tenant's (BYO) key or the platform key
    model: string;          // e.g. deepseek-chat , qwen3-coder-plus , glm-4.6 , moonshotai/kimi-k2
    maxTokens?: number;
    providerLabel?: string; // for the model id / telemetry (e.g. 'deepseek', 'openrouter')
    headers?: Record<string, string>; // extra headers some gateways want (e.g. OpenRouter referer/title)
}

const DEFAULT_MAX_TOKENS = 8192;

// ── OpenAI chat wire types (minimal) ────────────────────────────────────────────
interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ChatToolCall[];
    tool_call_id?: string;
}

/** One engine Msg → one (or the start of one) OpenAI chat message. */
function toChatMessage(m: Msg): ChatMessage {
    if (m.role === 'tool') {
        const r = m.toolResult;
        return {
            role: 'tool',
            tool_call_id: r?.callId || '',
            content: typeof r?.output === 'string' ? r.output : JSON.stringify(r?.output ?? null),
        };
    }
    if (m.role === 'assistant') {
        const msg: ChatMessage = { role: 'assistant', content: m.text || null };
        if (m.toolCalls?.length) {
            msg.tool_calls = m.toolCalls.map((c) => ({
                id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
            }));
        }
        return msg;
    }
    return { role: 'user', content: m.text || '' };
}

function safeParseArgs(s: string): Record<string, unknown> {
    try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

// OpenAI-compatible function names must match ^[a-zA-Z0-9_-]+$ — the engine's tools are dot-namespaced
// (code.search, feature.history). Sanitize forward (deterministic) for the wire; a per-request map reverses
// the response's tool_call name back to the original so the engine's registry resolves it.
export const sanitizeToolName = (n: string): string => n.replace(/[^a-zA-Z0-9_-]/g, '_');

// OpenAI requires every assistant message that has tool_calls to be IMMEDIATELY followed by one `tool`
// message per tool_call_id (and no orphan tool messages). The engine can leave an unanswered tool_call when
// a call is proposed-but-not-executed (gated) or truncated — which 400s. This re-pairs the conversation:
// pad any missing tool results, drop orphan tool messages. (Mirrors the Gemini adapter's parity sanitizer.)
export function sanitizeConversation(msgs: ChatMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [];
    let pending: string[] = [];                      // tool_call_ids opened by the last assistant, awaiting results
    const flush = () => { for (const id of pending) out.push({ role: 'tool', tool_call_id: id, content: '(no result captured)' }); pending = []; };
    for (const m of msgs) {
        if (m.role === 'tool') {
            const i = pending.indexOf(m.tool_call_id || '');
            if (i >= 0) { out.push(m); pending.splice(i, 1); }   // else orphan → drop
            continue;
        }
        if (pending.length) flush();                 // satisfy a prior assistant's tool_calls before the next turn
        out.push(m);
        pending = (m.role === 'assistant' && m.tool_calls?.length) ? m.tool_calls.map((t) => t.id) : [];
    }
    if (pending.length) flush();
    return out;
}

export class OpenAICompatModel implements Model {
    readonly id: string;
    private readonly url: string;
    private readonly apiKey: string;
    private readonly model: string;
    private readonly maxTokens: number;
    private readonly extraHeaders: Record<string, string>;

    constructor(opts: OpenAICompatOptions) {
        if (!opts.baseURL) throw new Error('OpenAICompatModel: baseURL required');
        if (!opts.apiKey) throw new Error('OpenAICompatModel: apiKey required');
        if (!opts.model) throw new Error('OpenAICompatModel: model required');
        this.url = opts.baseURL.replace(/\/+$/, '') + '/chat/completions';
        this.apiKey = opts.apiKey;
        this.model = opts.model;
        this.maxTokens = opts.maxTokens || DEFAULT_MAX_TOKENS;
        this.extraHeaders = opts.headers || {};
        this.id = `${opts.providerLabel || 'openai-compat'}:${opts.model}`;
    }

    private body(input: GenerateInput): Record<string, unknown> {
        const system = input.context ? `${input.system}\n\n${input.context}` : input.system;
        const messages: ChatMessage[] = sanitizeConversation([{ role: 'system', content: system }, ...input.messages.map(toChatMessage)]);
        // Sanitize dotted tool names consistently in the assistant history AND the tool defs (parse() reverses).
        for (const msg of messages) if (msg.tool_calls) for (const tc of msg.tool_calls) tc.function.name = sanitizeToolName(tc.function.name);
        const body: Record<string, unknown> = { model: this.model, max_tokens: this.maxTokens, messages };
        if (input.tools.length) {
            body.tools = input.tools.map((t) => ({ type: 'function', function: { name: sanitizeToolName(t.name), description: t.description, parameters: t.parameters } }));
            body.tool_choice = 'auto';
        }
        return body;
    }

    private parse(data: any, nameMap: Map<string, string>): ModelTurn {
        const choice = data?.choices?.[0]?.message || {};
        const toolCalls: ToolCall[] = Array.isArray(choice.tool_calls)
            ? choice.tool_calls.map((tc: ChatToolCall) => ({ id: tc.id, name: nameMap.get(tc.function?.name) || tc.function?.name, args: safeParseArgs(tc.function?.arguments) }))
            : [];
        const u = data?.usage || {};
        const cached = u.prompt_tokens_details?.cached_tokens || 0;
        const promptTokens = u.prompt_tokens || 0; // OpenAI prompt_tokens already INCLUDES cached
        const turn: ModelTurn = {
            usage: {
                promptTokens, cachedTokens: cached,
                outputTokens: u.completion_tokens || 0,
                totalTokens: u.total_tokens || (promptTokens + (u.completion_tokens || 0)),
            },
        };
        const text = typeof choice.content === 'string' ? choice.content : '';
        if (text) turn.text = text;
        if (toolCalls.length) turn.toolCalls = toolCalls;
        return turn;
    }

    async generate(input: GenerateInput): Promise<ModelTurn> {
        const nameMap = new Map<string, string>();               // sanitized → original, to reverse response tool names
        for (const t of input.tools) nameMap.set(sanitizeToolName(t.name), t.name);
        const res = await fetch(this.url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', ...this.extraHeaders },
            body: JSON.stringify(this.body(input)),
        });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = data?.error?.message || data?.message || `HTTP ${res.status}`;
            throw new Error(`OpenAICompatModel(${this.id}) ${res.status}: ${String(msg).slice(0, 300)}`);
        }
        return this.parse(data, nameMap);
    }
}

// Known cheap providers → their OpenAI-compatible base URLs. The onboarding UI maps a provider pick to one of
// these (or a custom baseURL). Model ids are chosen per tenant; defaults refined by live pricing research.
export const OPENAI_COMPAT_PROVIDERS: Record<string, { baseURL: string; label: string }> = {
    deepseek:   { baseURL: 'https://api.deepseek.com/v1',        label: 'deepseek' },
    openrouter: { baseURL: 'https://openrouter.ai/api/v1',       label: 'openrouter' },
    togetherai: { baseURL: 'https://api.together.xyz/v1',        label: 'together' },
    groq:       { baseURL: 'https://api.groq.com/openai/v1',     label: 'groq' },
    moonshot:   { baseURL: 'https://api.moonshot.ai/v1',         label: 'moonshot' },
    zai:        { baseURL: 'https://api.z.ai/api/paas/v4',       label: 'zai' },
    qwen:       { baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', label: 'qwen' },
    sarvam:     { baseURL: 'https://api.sarvam.ai/v1',           label: 'sarvam' },
    // 'custom' → the tenant supplies their own baseURL (self-hosted vLLM/Ollama, a gateway, etc.)
};
