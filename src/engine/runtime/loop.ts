// The agent loop. A model in a while-loop that may ask for tool calls; the broker
// stands between asking and doing. The loop is RE-ENTRANT so it works over HTTP:
//   step()   runs model→tool passes until the model replies with words (done) or
//            the broker returns PROPOSE (paused — waiting for a human confirm).
//   resume() takes the host's decision on a pending proposal and continues.
// A DENY is not a stop: its reason is appended as the tool result and the loop
// rounds again, so the model self-corrects. The turn cap stops a runaway loop.
import type { AgentConfig, Model, Msg, ServicePorts, DecisionLog, GenerateInput, AgentEventSink } from '../types';
import { request as brokerRequest, approve as brokerApprove, type BrokerRequest } from '../broker';
import { toolDeclarations } from '../tools/registry';
import { systemPrompt, runtimeContext } from './systemPrompt';
import { runWithTrace } from './traceContext';
import type { PendingProposal } from '../stores';

export interface LoopDeps {
    agent: AgentConfig;
    userId: string;
    model: Model;
    ports: ServicePorts;
    log: DecisionLog;
    /** The host's IANA timezone (e.g. 'Asia/Kolkata', 'America/New_York'). RÉVE is global —
     *  this resolves "the 25th"/"tonight" in the host's local time. Defaults to UTC if absent. */
    tz?: string;
    /** AIDLC observability (absent for the Host Copilot → no events emitted). The loop emits model.turn /
     *  tool.called / tool.result; tools emit their own domain events via ToolContext.sink. */
    sink?: AgentEventSink;
    traceStage?: string;
    stageRunId?: string;
    /** Per-stage thinking level (AIDLC) — e.g. 'low' for PRD so a thinking model doesn't burn the budget. */
    thinking?: 'low' | 'medium' | 'high';
    /** AIDLC stage brief. Folded into the STABLE `system` prefix (not a user turn) so it is (a) cached —
     *  implicitly every turn + explicitly as a cachedContents block — and (b) ALWAYS present, never slid out
     *  of the context window on a long (90-turn) Dev stage. The volatile per-turn nudges stay in messages. */
    briefContext?: string;
}

export interface Proposal {
    tool: string;
    note: string;
    args: Record<string, unknown>;
}

export type StepResult =
    | { status: 'done'; text: string; messages: Msg[]; spentTokens?: number }
    | { status: 'paused'; proposal: Proposal; pending: PendingProposal; messages: Msg[]; spentTokens?: number }
    | { status: 'error'; error: string; messages: Msg[]; spentTokens?: number };

function reqFor(deps: LoopDeps, runId: string, tool: string, args: Record<string, unknown>): BrokerRequest {
    return {
        agent: deps.agent.name,
        allowedTools: deps.agent.tools,
        grants: deps.agent.grants,
        userId: deps.userId,
        tool,
        args,
        runId,
        ports: deps.ports,
        model: deps.model,
        sink: deps.sink,
        stage: deps.traceStage,
        stageRunId: deps.stageRunId,
    };
}

// Compact a tool arg/result for an event payload (never ship huge blobs through the event stream).
function brief(v: unknown, max = 600): string {
    try { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > max ? s.slice(0, max) + '…' : s; } catch { return ''; }
}

// Prime the turn: recall what we know about this host (hybrid search over their
// memory), scoped to their latest message, and stamp the current time. Best-effort —
// a recall failure must never break the turn.
async function primeContext(deps: LoopDeps, messages: Msg[]): Promise<{ now: string; memories: Awaited<ReturnType<ServicePorts['memory']['recall']>> }> {
    const tz = deps.tz || 'UTC';
    let now: string;
    try {
        now = `${new Date().toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' })} (${tz})`;
    } catch {
        now = `${new Date().toISOString()} (UTC)`; // invalid/unknown tz → fall back to UTC
    }
    const lastUser = [...messages].reverse().find((m) => m.role === 'user' && m.text)?.text ?? '';
    let memories: Awaited<ReturnType<ServicePorts['memory']['recall']>> = [];
    if (lastUser && deps.ports.memory) {
        memories = await deps.ports.memory.recall(deps.userId, lastUser, 5).catch(() => []);
    }
    return { now, memories };
}

// Only the last N messages are sent to the model each turn, so a very long conversation never
// overflows the context window (older context is covered by the injected memory recall + the
// conversation title). The FULL history is still persisted. The window starts at a clean boundary —
// a 'user' message — so the model never sees an orphan tool result (functionResponse without its call).
const MAX_CONTEXT_MSGS = Math.max(8, Number(process.env.AGENT_MAX_CONTEXT_MSGS) || 40);

export function windowForModel(messages: Msg[], max = MAX_CONTEXT_MSGS): Msg[] {
    if (messages.length <= max) return messages;
    let start = messages.length - max;
    let s = start;
    while (s < messages.length && messages[s].role !== 'user') s++;
    if (s < messages.length) start = s;
    else while (start < messages.length && messages[start].role === 'tool') start++;
    return messages.slice(start);
}

// Public entry points establish the ambient turn context (runId/userId/agent) so EVERY LLM call made
// during the turn — including the CRAG grader and the escalation reviewer — attributes to this runId.
export async function step(deps: LoopDeps, messages: Msg[], runId: string): Promise<StepResult> {
    return runWithTrace({ runId, userId: deps.userId, agent: deps.agent.name }, () => stepImpl(deps, messages, runId));
}

async function stepImpl(deps: LoopDeps, messages: Msg[], runId: string): Promise<StepResult> {
    const decls = toolDeclarations(deps.agent.tools);
    const { now, memories } = await primeContext(deps, messages);
    // The stage brief joins the STABLE system prefix (cacheable + never windowed out); only time/memories
    // stay in the volatile context block. For the Host Copilot (no briefContext) this is just the persona.
    const sys = deps.briefContext ? `${systemPrompt(deps.agent)}\n\n${deps.briefContext}` : systemPrompt(deps.agent);
    const context = runtimeContext({ now, memories });
    let toolCalls = 0;
    let proposals = 0;
    let spentTokens = 0;
    const maxTokens = deps.agent.limits.maxTokens || 0;
    // Builder stages (those that can write code) must not over-explore and finish WITHOUT writing. Two
    // escalating guarantees: (1) a "write now" nudge fired EVERY turn once past a threshold, so it is always
    // the most-recent instruction (never diluted by context windowing); (2) a HARD CAP — past
    // AIDLC_HARD_WRITE_CAP read-only calls the search/read tools are REMOVED from the offer, so the model's
    // only moves are to write + self-verify. It cannot explore forever; it transitions to implementing (and
    // if its understanding is imperfect, Testing/coverage catch it → repair — far better than a stage that
    // never produces code). This is what makes the builder RELIABLY finish.
    const isBuilder = (deps.agent.tools || []).includes('sandbox.writeFile');
    const FORCE_WRITE_AFTER = Number(process.env.AIDLC_FORCE_WRITE_AFTER) || 12;
    const HARD_WRITE_CAP = Number(process.env.AIDLC_HARD_WRITE_CAP) || 22;
    const WRITE_PHASE_TOOLS = new Set(['sandbox.writeFile', 'sandbox.readFile', 'sandbox.listDir', 'sandbox.run', 'testing.verify']);
    const writePhaseDecls = decls.filter((d) => WRITE_PHASE_TOOLS.has(d.name));
    let wroteFile = false;
    // BUDGET-AWARE WIND-DOWN: a stage must FINISH its artifact, not hard-fail at the token/turn cap (the
    // feedback: "I dont want any stage to be failed because of these reasons"). As we approach either ceiling
    // we inject ONE escalating "finalize now" instruction so the agent writes its remaining files + emits the
    // JSON while it still has budget — converting a near-miss into a completed stage. Fires at 80% then 92%.
    const WIND_DOWN_FRACS = [0.7, 0.85];
    let windDownIdx = 0;
    let turnWindDownFired = false;
    // Fire the TURN wind-down in the last ~12% of turns (min 4) — a stage can hit the turn ceiling FIRST
    // (e.g. a long write→verify→fix loop that never blows the token budget), and it must still hand off its
    // best artifact to Testing rather than die at the cap. Independent of the token budget.
    const TURN_WIND_DOWN_AT = Math.max(4, Math.floor(deps.agent.limits.maxTurns * 0.12));

    for (let turn = 0; turn < deps.agent.limits.maxTurns; turn++) {
        // TOKEN wind-down (when a token budget is set).
        if (maxTokens && windDownIdx < WIND_DOWN_FRACS.length && spentTokens >= maxTokens * WIND_DOWN_FRACS[windDownIdx]) {
            const pct = Math.round(WIND_DOWN_FRACS[windDownIdx] * 100);
            windDownIdx++;
            messages.push({ role: 'user', text: `BUDGET CHECK: you have used ~${pct}% of your token budget for this stage. STOP exploring now. ${isBuilder && !wroteFile ? 'Write your remaining file(s) with sandbox.writeFile, then ' : ''}finalize: output ONLY the required JSON artifact for this stage, filling any unknowns with reasonable assumptions and noting them. Do not start new investigation — you will run out of budget.`, ts: new Date().toISOString() });
        }
        // TURN wind-down (ALWAYS, independent of tokens) — near the turn ceiling, stop looping and hand off.
        if (!turnWindDownFired && deps.agent.limits.maxTurns - turn <= TURN_WIND_DOWN_AT) {
            turnWindDownFired = true;
            messages.push({ role: 'user', text: `TURN LIMIT APPROACHING — ${deps.agent.limits.maxTurns - turn} turn(s) left. STOP iterating NOW. ${isBuilder && !wroteFile ? 'Write your change with sandbox.writeFile, then ' : ''}output ONLY the final JSON artifact. If self-verify is not perfectly clean, HAND OFF anyway — the Testing stage will catch anything remaining. Do not keep looping on verify/fix.`, ts: new Date().toISOString() });
        }
        // Builder: escalating "write now" nudge EVERY turn once past the threshold (always the latest message).
        const writeLocked = isBuilder && !wroteFile && toolCalls >= HARD_WRITE_CAP && writePhaseDecls.length > 0;
        if (isBuilder && !wroteFile && toolCalls >= FORCE_WRITE_AFTER) {
            messages.push({ role: 'user', text: writeLocked
                ? `You have made ${toolCalls} tool calls and written NOTHING. Search/read tools are now DISABLED — your only moves are sandbox.writeFile (then sandbox.run / testing.verify to self-check). Implement your best change from what you already know NOW. An empty filesTouched fails the stage.`
                : `STOP exploring — ${toolCalls} tool calls, zero writes. You have enough context: call sandbox.writeFile NOW to implement the change. More reading will fail the stage.`,
                ts: new Date().toISOString() });
        }
        const trace = { runId, userId: deps.userId, agent: deps.agent.name, phase: 'agent-step', turnIndex: turn };
        const t0 = Date.now();
        // Tool offer is a structural guarantee that the stage FINISHES:
        //  • builder past the hard cap with no write → only the write/verify tools (it writes, can't keep searching);
        //  • near the turn cap and nothing left to write → NO tools, so the only possible move is to emit the
        //    final JSON artifact (an exploratory agent can ignore a nudge, but it cannot call a tool that isn't offered).
        const forceFinal = turnWindDownFired && !writeLocked;
        const activeDecls = writeLocked ? writePhaseDecls : (forceFinal ? [] : decls);
        const mt = await deps.model.generate({ system: sys, context, messages: windowForModel(messages), tools: activeDecls, trace, thinking: deps.thinking });
        spentTokens += mt.usage?.totalTokens || 0;
        deps.sink?.emit({ type: 'model.turn', level: 'debug', actor: 'agent', stage: deps.traceStage, stageRunId: deps.stageRunId, payload: { turn, tokens: mt.usage?.totalTokens || 0, cachedTokens: mt.usage?.cachedTokens || 0, thinkingTokens: mt.usage?.thinkingTokens || 0, latencyMs: Date.now() - t0, text: mt.text ? brief(mt.text, 400) : undefined, toolCalls: (mt.toolCalls || []).map((c) => c.name) } });
        if (maxTokens && spentTokens > maxTokens) {
            return { status: 'error', error: `limit: token budget exceeded (${spentTokens}/${maxTokens})`, messages, spentTokens };
        }

        // Empty turn (no text AND no tool calls) — usually a gemini-3.x thinking model whose thoughts consumed
        // the whole output budget. Do NOT treat it as "done" (that yields an empty, unparseable artifact) —
        // nudge and retry (bounded by maxTurns).
        if ((!mt.text || !mt.text.trim()) && (!mt.toolCalls || !mt.toolCalls.length)) {
            messages.push({ role: 'assistant', text: '' });
            messages.push({ role: 'user', text: 'Your last response was empty. Continue now: either call a tool, or output your final JSON artifact. Be concise and do not over-think.', ts: new Date().toISOString() });
            continue;
        }

        if (mt.toolCalls && mt.toolCalls.length) {
            messages.push({ role: 'assistant', text: mt.text, toolCalls: mt.toolCalls });

            for (const call of mt.toolCalls) {
                deps.sink?.emit({ type: 'tool.called', level: 'info', actor: 'agent', stage: deps.traceStage, stageRunId: deps.stageRunId, payload: { name: call.name, args: brief(call.args) } });
                const tCall = Date.now();
                const outcome = await brokerRequest(reqFor(deps, runId, call.name, call.args), deps.log);
                deps.sink?.emit({ type: 'tool.result', level: outcome.decision === 'EXECUTE' && outcome.result?.ok ? 'info' : outcome.decision === 'DENY' ? 'warn' : 'info', actor: 'agent', stage: deps.traceStage, stageRunId: deps.stageRunId, payload: { name: call.name, decision: outcome.decision, ok: outcome.decision === 'EXECUTE' ? !!outcome.result?.ok : false, durationMs: Date.now() - tCall, summary: outcome.decision === 'DENY' ? outcome.reason : brief(outcome.result?.output, 300) } });

                if (outcome.decision === 'PROPOSE') {
                    proposals += 1;
                    if (proposals > deps.agent.limits.maxProposals) {
                        return { status: 'error', error: `limit: exceeded maxProposals (${deps.agent.limits.maxProposals})`, messages, spentTokens };
                    }
                    const pending: PendingProposal = {
                        runId, callId: call.id, tool: call.name, args: call.args,
                        note: outcome.preview?.note ?? `confirm ${call.name}?`,
                    };
                    return { status: 'paused', proposal: { tool: call.name, note: pending.note, args: call.args }, pending, messages, spentTokens };
                }

                // EXECUTE or DENY → append the tool result (or the denial reason) and round again.
                const output = outcome.decision === 'DENY' ? { denied: true, reason: outcome.reason } : outcome.result?.output;
                const ok = outcome.decision === 'EXECUTE' ? !!outcome.result?.ok : false;
                messages.push({ role: 'tool', toolResult: { callId: call.id, name: call.name, ok, output } });

                if (outcome.decision === 'EXECUTE') {
                    toolCalls += 1;
                    if (call.name === 'sandbox.writeFile' && outcome.result?.ok) wroteFile = true;
                    if (toolCalls > deps.agent.limits.maxToolCalls) {
                        return { status: 'error', error: `limit: exceeded maxToolCalls (${deps.agent.limits.maxToolCalls})`, messages, spentTokens };
                    }
                }
            }
            continue; // re-read with the new results in context
        }

        // Words, not a tool call → the loop ends.
        const text = mt.text ?? '';
        messages.push({ role: 'assistant', text });
        return { status: 'done', text, messages, spentTokens };
    }

    return { status: 'error', error: `turn cap (${deps.agent.limits.maxTurns}) reached`, messages, spentTokens };
}

export async function resume(deps: LoopDeps, messages: Msg[], pending: PendingProposal, approved: boolean): Promise<StepResult> {
    return runWithTrace({ runId: pending.runId, userId: deps.userId, agent: deps.agent.name }, () => resumeImpl(deps, messages, pending, approved));
}

async function resumeImpl(deps: LoopDeps, messages: Msg[], pending: PendingProposal, approved: boolean): Promise<StepResult> {
    if (approved) {
        const result = await brokerApprove(reqFor(deps, pending.runId, pending.tool, pending.args), deps.log);
        messages.push({ role: 'tool', toolResult: { callId: pending.callId, name: pending.tool, ok: result.ok, output: result.output } });
    } else {
        messages.push({ role: 'tool', toolResult: { callId: pending.callId, name: pending.tool, ok: false, output: { declined: true } } });
    }
    return step(deps, messages, pending.runId);
}

// ── Streaming variant (SSE) ──────────────────────────────────────────────────
// Same machine as step(), but text is streamed token-by-token via `emit` as the model
// produces it. Tool-calling turns run through the broker exactly as before (no token
// output). Returns the same StepResult so the caller can persist the session.
export type StreamEvent =
    | { type: 'token'; text: string }
    | { type: 'done'; text: string }
    | { type: 'paused'; proposal: Proposal }
    | { type: 'error'; error: string };

async function runTurn(deps: LoopDeps, sys: string, context: string, messages: Msg[], decls: ReturnType<typeof toolDeclarations>, emit: (e: StreamEvent) => void, trace: GenerateInput['trace']) {
    // Prefer streaming; fall back to a single generate() (e.g. ScriptedModel) and emit the whole text.
    const windowed = windowForModel(messages);
    if (deps.model.generateStream) {
        return deps.model.generateStream({ system: sys, context, messages: windowed, tools: decls, trace, thinking: deps.thinking }, (t) => emit({ type: 'token', text: t }));
    }
    const mt = await deps.model.generate({ system: sys, context, messages: windowed, tools: decls, trace, thinking: deps.thinking });
    if (mt.text && !(mt.toolCalls && mt.toolCalls.length)) emit({ type: 'token', text: mt.text });
    return mt;
}

export async function stepStream(deps: LoopDeps, messages: Msg[], runId: string, emit: (e: StreamEvent) => void): Promise<StepResult> {
    return runWithTrace({ runId, userId: deps.userId, agent: deps.agent.name }, () => stepStreamImpl(deps, messages, runId, emit));
}

async function stepStreamImpl(deps: LoopDeps, messages: Msg[], runId: string, emit: (e: StreamEvent) => void): Promise<StepResult> {
    const decls = toolDeclarations(deps.agent.tools);
    const { now, memories } = await primeContext(deps, messages);
    const sys = deps.briefContext ? `${systemPrompt(deps.agent)}\n\n${deps.briefContext}` : systemPrompt(deps.agent);
    const context = runtimeContext({ now, memories });
    let toolCalls = 0;
    let proposals = 0;
    let spentTokens = 0;
    const maxTokens = deps.agent.limits.maxTokens || 0;

    for (let turn = 0; turn < deps.agent.limits.maxTurns; turn++) {
        const trace = { runId, userId: deps.userId, agent: deps.agent.name, phase: 'agent-step', turnIndex: turn };
        const mt = await runTurn(deps, sys, context, messages, decls, emit, trace);
        spentTokens += mt.usage?.totalTokens || 0;
        if (maxTokens && spentTokens > maxTokens) {
            const error = `limit: token budget exceeded (${spentTokens}/${maxTokens})`;
            emit({ type: 'error', error });
            return { status: 'error', error, messages };
        }

        if (mt.toolCalls && mt.toolCalls.length) {
            messages.push({ role: 'assistant', text: mt.text, toolCalls: mt.toolCalls });
            for (const call of mt.toolCalls) {
                deps.sink?.emit({ type: 'tool.called', level: 'info', actor: 'agent', stage: deps.traceStage, stageRunId: deps.stageRunId, payload: { name: call.name, args: brief(call.args) } });
                const tCall = Date.now();
                const outcome = await brokerRequest(reqFor(deps, runId, call.name, call.args), deps.log);
                deps.sink?.emit({ type: 'tool.result', level: outcome.decision === 'EXECUTE' && outcome.result?.ok ? 'info' : outcome.decision === 'DENY' ? 'warn' : 'info', actor: 'agent', stage: deps.traceStage, stageRunId: deps.stageRunId, payload: { name: call.name, decision: outcome.decision, ok: outcome.decision === 'EXECUTE' ? !!outcome.result?.ok : false, durationMs: Date.now() - tCall, summary: outcome.decision === 'DENY' ? outcome.reason : brief(outcome.result?.output, 300) } });
                if (outcome.decision === 'PROPOSE') {
                    proposals += 1;
                    if (proposals > deps.agent.limits.maxProposals) {
                        const error = `limit: exceeded maxProposals (${deps.agent.limits.maxProposals})`;
                        emit({ type: 'error', error });
                        return { status: 'error', error, messages };
                    }
                    const pending: PendingProposal = { runId, callId: call.id, tool: call.name, args: call.args, note: outcome.preview?.note ?? `confirm ${call.name}?` };
                    const proposal = { tool: call.name, note: pending.note, args: call.args };
                    emit({ type: 'paused', proposal });
                    return { status: 'paused', proposal, pending, messages };
                }
                const output = outcome.decision === 'DENY' ? { denied: true, reason: outcome.reason } : outcome.result?.output;
                const ok = outcome.decision === 'EXECUTE' ? !!outcome.result?.ok : false;
                messages.push({ role: 'tool', toolResult: { callId: call.id, name: call.name, ok, output } });
                if (outcome.decision === 'EXECUTE') {
                    toolCalls += 1;
                    if (toolCalls > deps.agent.limits.maxToolCalls) {
                        const error = `limit: exceeded maxToolCalls (${deps.agent.limits.maxToolCalls})`;
                        emit({ type: 'error', error });
                        return { status: 'error', error, messages };
                    }
                }
            }
            continue;
        }

        const text = mt.text ?? '';
        messages.push({ role: 'assistant', text });
        emit({ type: 'done', text });
        return { status: 'done', text, messages };
    }
    const error = `turn cap (${deps.agent.limits.maxTurns}) reached`;
    emit({ type: 'error', error });
    return { status: 'error', error, messages };
}

export async function resumeStream(deps: LoopDeps, messages: Msg[], pending: PendingProposal, approved: boolean, emit: (e: StreamEvent) => void): Promise<StepResult> {
    return runWithTrace({ runId: pending.runId, userId: deps.userId, agent: deps.agent.name }, () => resumeStreamImpl(deps, messages, pending, approved, emit));
}

async function resumeStreamImpl(deps: LoopDeps, messages: Msg[], pending: PendingProposal, approved: boolean, emit: (e: StreamEvent) => void): Promise<StepResult> {
    if (approved) {
        const result = await brokerApprove(reqFor(deps, pending.runId, pending.tool, pending.args), deps.log);
        messages.push({ role: 'tool', toolResult: { callId: pending.callId, name: pending.tool, ok: result.ok, output: result.output } });
    } else {
        messages.push({ role: 'tool', toolResult: { callId: pending.callId, name: pending.tool, ok: false, output: { declined: true } } });
    }
    return stepStream(deps, messages, pending.runId, emit);
}

// Convenience driver for tests + simple callers: runs to completion, auto-answering
// each proposal via `approver`. Collects the proposals seen along the way.
export async function driveToCompletion(
    deps: LoopDeps,
    messages: Msg[],
    runId: string,
    approver: (p: Proposal) => Promise<boolean>,
): Promise<{ result: StepResult; proposals: Proposal[] }> {
    const proposals: Proposal[] = [];
    let res = await step(deps, messages, runId);
    while (res.status === 'paused') {
        proposals.push(res.proposal);
        const approved = await approver(res.proposal);
        res = await resume(deps, res.messages, res.pending, approved);
    }
    return { result: res, proposals };
}
