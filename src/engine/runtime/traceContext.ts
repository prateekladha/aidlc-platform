// Ambient per-turn trace context. The loop establishes { runId, userId, agent } for the duration of a
// turn; anything it calls — memory recall → the CRAG grader, the broker → the escalation reviewer, a
// tool's own retrieval — runs inside this async scope. The Gemini adapter reads it so those auxiliary
// LLM calls attribute to the SAME turn (runId) as the main agent-step calls, without threading a trace
// argument through every port signature. AsyncLocalStorage propagates across awaits automatically.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TraceCtx {
    runId?: string;
    userId?: string;
    agent?: string;
}

const als = new AsyncLocalStorage<TraceCtx>();

export function runWithTrace<T>(ctx: TraceCtx, fn: () => Promise<T>): Promise<T> {
    return als.run(ctx, fn);
}

export function currentTrace(): TraceCtx | undefined {
    return als.getStore();
}
