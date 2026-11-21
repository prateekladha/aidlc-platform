// AIDLC observability event spine — the single typed, ordered stream every part of the system emits into.
// Both the LIVE run page (SSE) and REPLAY render off this exact stream (same renderer, same data). See
// AIDLC-OBSERVABILITY.md §2. Keep this contracts-only (no I/O); the Tracer + stores do the work.
import type { Stage } from './types';

export type ObsLevel = 'debug' | 'info' | 'warn' | 'error';
export type ObsActor = 'orchestrator' | 'agent' | 'worker' | 'human' | 'system';

export type ObsEventType =
    // lifecycle
    | 'work_item.created' | 'work_item.completed'
    | 'stage.queued' | 'stage.started' | 'stage.passed' | 'stage.failed' | 'stage.skipped' | 'stage.dispatched'
    | 'worker.started' | 'worker.finished'
    // agent reasoning
    | 'model.turn' | 'tool.called' | 'tool.result' | 'agent.message'
    // dev work
    | 'sandbox.command' | 'sandbox.output' | 'file.written' | 'branch.pushed'
    // testing (first-class)
    | 'test.suite.started' | 'test.case' | 'test.assertion'
    | 'browser.screenshot' | 'browser.console' | 'browser.network' | 'visual.diff' | 'lighthouse.report'
    // human-in-the-loop
    | 'clarify.asked' | 'clarify.answered' | 'gate.opened' | 'gate.decided' | 'proposal.raised' | 'message'
    // quality (the metric) + instruction adherence + cost
    | 'quality.scored' | 'quality.revising' | 'verifier.checked'
    | 'requirements.extracted' | 'coverage.checked' | 'requirement.deferred'
    | 'cost.recorded' | 'cache.hit' | 'budget.exceeded'
    // deploy
    | 'pr.opened' | 'pr.merged' | 'deploy.triggered' | 'deploy.health' | 'deploy.rolledback'
    // errors
    | 'error';

export interface ObsEvent {
    id: string;
    workItemId: string;
    stageRunId?: string;         // ties a batch of events to one execution of one stage
    stage?: Stage;
    seq: number;                 // monotonic per work item (ordering key for live + replay)
    ts: string;                  // ISO timestamp
    type: ObsEventType;
    level: ObsLevel;
    actor: ObsActor;
    payload?: Record<string, any>;   // small, structured; large/binary goes to GCS via artifactRefs
    artifactRefs?: string[];         // GCS refs (full logs, diffs, screenshots, video, traces, reports)
}

// What a caller emits — the sink assigns id/seq/ts/workItemId.
export type EmitInput = Omit<ObsEvent, 'id' | 'seq' | 'ts' | 'workItemId'> & { workItemId?: string };

export interface EventSink {
    emit(e: EmitInput): void;
}

// A no-op sink for contexts without observability (CLI/offline/tests) — keeps call sites unconditional.
export const NO_SINK: EventSink = { emit() { /* noop */ } };

// Durable event store (replay + the system of record for the run timeline).
export interface ObsEventStore {
    append(e: ObsEvent): Promise<void>;
    list(workItemId: string, opts?: { fromSeq?: number; limit?: number; types?: ObsEventType[] }): Promise<ObsEvent[]>;
    maxSeq(workItemId: string): Promise<number>;   // read once at tracer init so seq stays globally monotonic
}

// Convenience payload builders keep emit sites terse + consistent.
export const ev = {
    stageStarted: (stage: Stage, stageRunId: string): EmitInput => ({ type: 'stage.started', level: 'info', actor: 'orchestrator', stage, stageRunId }),
    stageQueued: (stage: Stage): EmitInput => ({ type: 'stage.queued', level: 'info', actor: 'orchestrator', stage }),
    stagePassed: (stage: Stage, stageRunId?: string): EmitInput => ({ type: 'stage.passed', level: 'info', actor: 'orchestrator', stage, stageRunId }),
    stageFailed: (stage: Stage, error: string, stageRunId?: string): EmitInput => ({ type: 'stage.failed', level: 'error', actor: 'orchestrator', stage, stageRunId, payload: { error } }),
    stageSkipped: (stage: Stage, reason: string): EmitInput => ({ type: 'stage.skipped', level: 'info', actor: 'orchestrator', stage, payload: { reason } }),
    modelTurn: (stage: Stage, stageRunId: string, p: { thinking?: string; tokens?: number; latencyMs?: number }): EmitInput => ({ type: 'model.turn', level: 'debug', actor: 'agent', stage, stageRunId, payload: p }),
    toolCalled: (stage: Stage, stageRunId: string, name: string, args: any): EmitInput => ({ type: 'tool.called', level: 'info', actor: 'agent', stage, stageRunId, payload: { name, args } }),
    toolResult: (stage: Stage, stageRunId: string, name: string, p: { ok: boolean; summary?: string; durationMs?: number }): EmitInput => ({ type: 'tool.result', level: p.ok ? 'info' : 'warn', actor: 'agent', stage, stageRunId, payload: { name, ...p } }),
    sandboxCommand: (stage: Stage, stageRunId: string, cmd: string): EmitInput => ({ type: 'sandbox.command', level: 'info', actor: 'worker', stage, stageRunId, payload: { cmd } }),
    sandboxOutput: (stage: Stage, stageRunId: string, chunk: string, streamName: 'stdout' | 'stderr'): EmitInput => ({ type: 'sandbox.output', level: streamName === 'stderr' ? 'warn' : 'debug', actor: 'worker', stage, stageRunId, payload: { chunk, stream: streamName } }),
    fileWritten: (stage: Stage, stageRunId: string, path: string, p?: { added?: number; removed?: number }): EmitInput => ({ type: 'file.written', level: 'info', actor: 'worker', stage, stageRunId, payload: { path, ...p } }),
    gateOpened: (stage: Stage, kind: string, summary: string): EmitInput => ({ type: 'gate.opened', level: 'info', actor: 'orchestrator', stage, payload: { kind, summary } }),
    gateDecided: (stage: Stage, decision: string, by?: string): EmitInput => ({ type: 'gate.decided', level: 'info', actor: 'human', stage, payload: { decision, by } }),
    clarifyAsked: (stage: Stage, questions: string[]): EmitInput => ({ type: 'clarify.asked', level: 'info', actor: 'agent', stage, payload: { questions } }),
    clarifyAnswered: (stage: Stage, answers: string[], by?: string): EmitInput => ({ type: 'clarify.answered', level: 'info', actor: 'human', stage, payload: { answers, by } }),
    message: (stage: Stage, text: string, by?: string, attachments?: number): EmitInput => ({ type: 'message', level: 'info', actor: 'human', stage, payload: { text, by, attachments } }),
    cost: (stage: Stage, stageRunId: string, p: { tokens?: number; usd?: number; cachedTokens?: number }): EmitInput => ({ type: 'cost.recorded', level: 'debug', actor: 'system', stage, stageRunId, payload: p }),
    qualityScored: (stage: Stage, stageRunId: string, p: { score: number; bar: number; pass: boolean; revision: number; weaknesses?: string }): EmitInput => ({ type: 'quality.scored', level: p.pass ? 'info' : 'warn', actor: 'system', stage, stageRunId, payload: p }),
    qualityRevising: (stage: Stage, stageRunId: string, p: { revision: number; improvements: string[] }): EmitInput => ({ type: 'quality.revising', level: 'info', actor: 'system', stage, stageRunId, payload: p }),
    verifierChecked: (stage: Stage, stageRunId: string, p: { pass: boolean; findings: string[] }): EmitInput => ({ type: 'verifier.checked', level: p.pass ? 'info' : 'error', actor: 'system', stage, stageRunId, payload: p }),
    requirementsExtracted: (stage: Stage, p: { count: number; mustHave: number }): EmitInput => ({ type: 'requirements.extracted', level: 'info', actor: 'system', stage, payload: p }),
    coverageChecked: (stage: Stage, stageRunId: string, p: { pass: boolean; unmet: string[]; total: number; revision: number }): EmitInput => ({ type: 'coverage.checked', level: p.pass ? 'info' : 'warn', actor: 'system', stage, stageRunId, payload: p }),
    requirementDeferred: (stage: Stage, p: { reqId: string; by: string; reason: string }): EmitInput => ({ type: 'requirement.deferred', level: 'info', actor: 'human', stage, payload: p }),
    budgetExceeded: (stage: Stage, p: { spentTokens: number; ceilingTokens: number }): EmitInput => ({ type: 'budget.exceeded', level: 'error', actor: 'system', stage, payload: p }),
    error: (stage: Stage | undefined, message: string): EmitInput => ({ type: 'error', level: 'error', actor: 'system', stage, payload: { message } }),
};
