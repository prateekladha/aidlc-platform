// Builds the system prompt from the agent config. Identity, tone, and the names
// of the tools available — NOTHING about business rules (payout gates, caps,
// ownership). Those live in the tools and reach the model only as DENY reasons.
//
// The loop may also pass runtime context: the current date/time (so "the 25th" or
// "next Saturday" resolves correctly) and what the copilot already remembers about
// this host (primed via hybrid recall). Memory is CONTEXT, not a rule.
import type { AgentConfig, MemoryItem } from '../types';

export interface PromptContext {
    now?: string;              // human-readable current date/time, host timezone
    memories?: MemoryItem[];   // recalled facts about this host
}

// The STABLE system prompt: persona + tool names. Byte-identical every turn for this agent, so it forms a
// long cacheable prefix — Gemini's implicit caching (on by default for 2.5/3) bills re-sent prefix tokens
// at a ~90% discount. Keep anything that changes per-turn OUT of here (see runtimeContext).
export function systemPrompt(agent: AgentConfig): string {
    return [
        agent.persona,
        '',
        `Tools available to you this session: ${agent.tools.join(', ')}.`,
        'Call them as functions. The system decides whether each call runs, pauses for the host to confirm,',
        'or is denied with a reason — trust that layer and respond to what it tells you.',
    ].join('\n');
}

// The VOLATILE per-turn context (current time + recalled memories). Sent as a SEPARATE trailing block so it
// never mutates the cacheable prefix above. Returns '' when there's nothing to add.
export function runtimeContext(ctx?: PromptContext): string {
    const lines: string[] = [];
    if (ctx?.now) {
        lines.push(`The current date and time is ${ctx.now}. Resolve relative dates ("the 25th", "next Saturday") against this.`);
    }
    if (ctx?.memories && ctx.memories.length) {
        lines.push('', 'What you already know about this host (use it naturally; do not recite it back):');
        for (const m of ctx.memories) lines.push(`- ${m.text}`);
    }
    return lines.join('\n');
}
