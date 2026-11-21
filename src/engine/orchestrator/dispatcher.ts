// StageDispatcher — the execution seam. A stage either runs IN-PROCESS (LocalDispatcher: fine for local
// iteration + the dev environment) or on an ISOLATED ephemeral Cloud Run Job (JobDispatcher: the
// production path, because the Dev/Testing agents execute arbitrary LLM-written code — installs, builds,
// tests — which must never share the orchestrator process; see AIDLC-DESIGN.md §0/§3c).
//
// The supervisor calls dispatch(); the outcome tells it how to proceed:
//   done        → the stage finished in-process, here is the parsed artifact
//   needs_input → the agent needs human answers before it can finish (HITL clarify)
//   dispatched  → handed to a Job; the supervisor parks in `dispatched` and resumes on onWorkerComplete
//   error       → the stage failed
import { step } from '../runtime/loop';
import type { LoopDeps } from '../runtime/loop';
import type { Model, DecisionLog, Msg, AgentEventSink } from '../types';
import type { AidlcServicePorts, WorkItem, Stage } from './types';
import { STAGE_CONFIGS, thinkingFor, HEAVY } from '../agents/aidlc/stages';

export type StageOutcome =
    | { kind: 'done'; artifact: any; costTokens?: number }
    | { kind: 'needs_input'; questions: string[] }
    | { kind: 'dispatched'; jobName?: string; execution?: string; taskName?: string }
    | { kind: 'error'; error: string };

// Per-run execution context. Ports are per-work-item (own sandbox) so concurrent items never share a
// clone; model/log/tz are shared infra.
export interface StageCtx {
    model: Model;
    ports: AidlcServicePorts;
    log: DecisionLog;
    tz?: string;
    sink?: AgentEventSink;      // observability — threaded into the loop + tools
    stageRunId?: string;        // ties this stage's events together
}

export interface StageDispatcher {
    /** Run (or dispatch) one stage for a work item given its already-built brief + per-run ctx. */
    run(wi: WorkItem, stage: Stage, brief: string, ctx: StageCtx): Promise<StageOutcome>;
    /** True if this dispatcher sends the stage to an out-of-process worker (→ park on `dispatched`). */
    isAsync(stage: Stage): boolean;
}

// The human's attachments (submit + any conversation turn) → model file parts (gs:// URIs read directly).
function collectFiles(wi: WorkItem): Array<{ mimeType: string; fileUri?: string; name?: string }> {
    const atts = [...(wi.attachments || []), ...((wi.conversation || []).flatMap((c) => c.attachments || []))];
    const seen = new Set<string>();
    return atts
        .filter((a) => a?.gcsRef && !seen.has(a.gcsRef) && (seen.add(a.gcsRef), true))
        .slice(0, 16) // cap so a huge attachment set never blows the request
        .map((a) => ({ mimeType: a.mimeType, fileUri: a.gcsRef, name: a.name }));
}

// Tolerant JSON extraction from a model's final text (handles ```json fences / surrounding prose).
export function parseJsonLoose<T = any>(text: string): T | null {
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : text;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const raw = body.slice(start, end + 1);
    try { return JSON.parse(raw) as T; } catch { /* fall through to repair */ }
    try { return JSON.parse(repairJson(raw)) as T; } catch { return null; }
}

// Repair the two defects weaker models emit in otherwise-valid JSON: literal control chars (newlines/tabs)
// inside string values (common in a multi-line PR body), and trailing commas. Escapes control chars only
// while inside a string, leaving already-escaped sequences intact.
function repairJson(s: string): string {
    let out = '', inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) { out += c; esc = false; }
            else if (c === '\\') { out += c; esc = true; }
            else if (c === '"') { out += c; inStr = false; }
            else if (c === '\n') { out += '\\n'; }
            else if (c === '\r') { out += '\\r'; }
            else if (c === '\t') { out += '\\t'; }
            else out += c;
        } else {
            if (c === '"') inStr = true;
            out += c;
        }
    }
    return out.replace(/,\s*([}\]])/g, '$1');
}

const isBuilderStage = (stage: Stage): boolean => stage === 'dev' || stage === 'fix' || stage === 'infra_change';

// Recover the changed file paths from a unified diff (new + modified + deleted), excluding /dev/null.
function filesFromDiff(diff: string): string[] {
    const out = new Set<string>();
    for (const m of diff.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)) out.add(m[1]);
    for (const m of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) out.add(m[1]);
    return [...out].filter((p) => p && p !== '/dev/null');
}

// Synthesise a minimal builder artifact from the actual diff when the agent wrote code but didn't emit JSON.
function synthArtifactFromDiff(stage: Stage, diff: string, prose?: string): any {
    const files = filesFromDiff(diff);
    const note = `Recovered from the working tree — the agent wrote code but did not emit its final JSON.${prose ? ' Agent notes: ' + String(prose).replace(/\s+/g, ' ').slice(0, 400) : ''}`;
    const base: any = { diffSummary: note, filesTouched: files, notes: note, infraNeed: { required: false, kinds: [], summary: '' } };
    if (stage === 'fix') base.rootCause = String(prose || '').replace(/\s+/g, ' ').slice(0, 400) || '(see diff)';
    return base;
}

// A stage-agent signals it needs human input by returning { needsInput:true, questions:[...] } instead
// of its normal artifact. Normalize both shapes.
function clarifyQuestions(artifact: any): string[] | null {
    if (!artifact) return null;
    const flag = artifact.needsInput === true || artifact.needs_input === true || artifact.awaitingInput === true;
    const qs = artifact.questions || artifact.clarifyingQuestions || artifact.openQuestions;
    if (flag && Array.isArray(qs) && qs.length) return qs.map(String);
    return null;
}

// ── LocalDispatcher — runs the stage-agent in THIS process via loop.step() ───
export class LocalDispatcher implements StageDispatcher {
    isAsync(): boolean { return false; }

    async run(wi: WorkItem, stage: Stage, brief: string, ctx: StageCtx): Promise<StageOutcome> {
        const agent = STAGE_CONFIGS[stage];
        // The brief rides in the STABLE system prefix (loop.briefContext) — so it is cached (implicitly every
        // turn + explicitly as a cachedContents block) AND never slid out of the window on a long stage. The
        // first user turn is just a short kickoff + any human attachments (screenshots/mockups/PDFs).
        const loop: LoopDeps = { agent, userId: 'aidlc', model: ctx.model, ports: ctx.ports, log: ctx.log, tz: ctx.tz, sink: ctx.sink, traceStage: stage, stageRunId: ctx.stageRunId, thinking: thinkingFor(stage, wi), briefContext: brief };
        const files = collectFiles(wi);
        const kickoff = `Your full task brief and context are in the system instruction above${files.length ? '; the attached file(s) accompany this message' : ''}. Begin now: use tools as needed, then reply with ONLY the required JSON artifact for your stage.`;
        const messages: Msg[] = [{ role: 'user', text: kickoff, files: files.length ? files : undefined, ts: new Date().toISOString() }];
        const runId = `${wi.id}:${stage}`;
        try {
            let result = await step(loop, messages, runId);
            if (result.status === 'done') {
                let artifact = parseJsonLoose(result.text);
                let salvageTokens = 0;
                // A long tool session sometimes ends in prose instead of the final JSON artifact. Nudge up to
                // TWICE (escalating) before giving up — errors are instructions; give it a real chance to comply.
                for (let attempt = 0; !artifact && attempt < 2; attempt++) {
                    const nudged = [...result.messages, { role: 'user' as const, text: attempt === 0
                        ? 'Reply now with ONLY the required JSON object for this stage — no prose, no markdown fences, nothing else.'
                        : 'Output ONLY the JSON object now: start your reply with { and end with }, nothing before or after.', ts: new Date().toISOString() }];
                    result = await step(loop, nudged, runId);
                    salvageTokens += result.spentTokens || 0;
                    if (result.status === 'done') artifact = parseJsonLoose(result.text);
                }
                // SALVAGE: a BUILDER that actually WROTE code but won't emit JSON should not lose the work —
                // synthesise a minimal artifact from the REAL diff so the pipeline continues. Testing verifies
                // the actual code (what matters), not the self-report.
                if (!artifact && isBuilderStage(stage) && wi.sandbox) {
                    const diff = await ctx.ports.sandbox.diff(wi.sandbox.sandboxId).catch(() => '');
                    const prose = result.status === 'done' ? result.text : '';
                    if (diff && diff.trim()) artifact = synthArtifactFromDiff(stage, diff, prose);
                }
                if (!artifact) return { kind: 'error', error: `stage ${stage} produced no parseable JSON output` };
                const qs = clarifyQuestions(artifact);
                if (qs) return { kind: 'needs_input', questions: qs };
                return { kind: 'done', artifact, costTokens: (result.spentTokens || 0) + salvageTokens };
            }
            if (result.status === 'paused') {
                return { kind: 'error', error: `stage ${stage} paused on an unexpected mid-stage proposal (${result.proposal.tool})` };
            }
            // Budget/turn-cap SALVAGE: the agent ran out of steps (usually over-exploring, or stuck in a
            // write→verify→fix loop) before emitting its artifact. Don't throw away the work — ask ONCE for the
            // best-effort JSON; and for a BUILDER that already wrote code, synthesise the artifact from the real
            // diff so the change still hands off to Testing (which verifies the actual code).
            if (result.status === 'error' && /limit:|turn cap|token budget/i.test(result.error || '')) {
                const nudged = [...result.messages, { role: 'user' as const, text: 'You have reached your step budget. STOP exploring and output ONLY the final JSON artifact for this stage NOW — fill any unknowns with reasonable assumptions and note them in the output. No tool calls, no prose, JSON only.', ts: new Date().toISOString() }];
                const r2 = await step(loop, nudged, runId);
                let art = r2.status === 'done' ? parseJsonLoose(r2.text) : null;
                if (!art && isBuilderStage(stage) && wi.sandbox) {
                    const diff = await ctx.ports.sandbox.diff(wi.sandbox.sandboxId).catch(() => '');
                    const prose = r2.status === 'done' ? r2.text : '';
                    if (diff && diff.trim()) art = synthArtifactFromDiff(stage, diff, prose);
                }
                if (art) {
                    const qs = clarifyQuestions(art);
                    if (qs) return { kind: 'needs_input', questions: qs };
                    return { kind: 'done', artifact: art, costTokens: (result.spentTokens || 0) + (r2.spentTokens || 0) };
                }
            }
            return { kind: 'error', error: result.error };
        } catch (e: any) {
            return { kind: 'error', error: e?.message || String(e) };
        }
    }
}

// ── JobDispatcher — dispatches heavy stages to an isolated Cloud Run Job ──────
// Heavy stages (dev/testing/ux) go to a Job; light stages still run locally. The Job clones the repo,
// runs the same stage-agent, writes its slice to Arango, and publishes completion to Pub/Sub → the
// orchestrator's onWorkerComplete resumes. See orchestrator/worker/main.ts + runJob().
export class JobDispatcher implements StageDispatcher {
    constructor(
        private readonly local: LocalDispatcher,            // light stages fall through to in-process
        private readonly enqueue: (wi: WorkItem, stage: Stage) => Promise<{ jobName: string; execution?: string; taskName?: string }>,
    ) {}

    isAsync(stage: Stage): boolean { return HEAVY.has(stage); }

    async run(wi: WorkItem, stage: Stage, brief: string, ctx: StageCtx): Promise<StageOutcome> {
        if (!this.isAsync(stage)) return this.local.run(wi, stage, brief, ctx);
        try {
            const r = await this.enqueue(wi, stage);
            return { kind: 'dispatched', jobName: r.jobName, execution: r.execution, taskName: r.taskName };
        } catch (e: any) {
            return { kind: 'error', error: `job dispatch failed for ${stage}: ${e?.message || e}` };
        }
    }
}
