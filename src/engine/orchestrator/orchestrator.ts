// AIDLC supervisor — drives a Work Item through the stage DAG above the existing agent loop. v0.3:
// ALL state lives on the Work Item (Arango), so the pipeline is durable + resumable across process
// restarts and the worker/orchestrator boundary. Execution goes through a StageDispatcher (in-process
// LocalDispatcher or isolated JobDispatcher). Humans are in the loop at every gate + via clarify
// questions. Nothing merges or deploys unless AIDLC_AUTO_MERGE is explicitly enabled. See AIDLC-DESIGN.md.

import type { Model, DecisionLog } from '../types';
import type {
    Orchestrator, WorkItem, WorkItemStore, Stage, Gate, GateDecision, Dag,
    AidlcServicePorts, Prd, DesignSpec, DevResult, TestReport, DeployRecord, AnalyticsSpec, GtmPlan,
    ClarifyRound, WorkerResult, FeaturePort, Attachment, ConvMsg, CoverageReport,
} from './types';
import type { StageDispatcher, StageCtx } from './dispatcher';
import { GATED_STAGES, AIDLC_DAG, MAX_REPAIR_ATTEMPTS, REPO_NAMES } from '../agents/aidlc/stages';
import { Tracer, createTracer, type TracerSinks } from './tracer';
import { critique, verifyMoneyPath, verifyMigration, MAX_QUALITY_REVISIONS, type QualityReport } from './quality';
import { extractRequirements, mergeRequirements, verifyCoverage, buildCoverageReport } from './requirements';
import { ev } from './events';

// Stages where "did you cover EVERY instruction" is the thing that matters — the builder + the spec. A
// fail-closed coverage check gates these; verification/packaging stages (testing/deploy) don't need it.
const COVERAGE_STAGES: ReadonlySet<Stage> = new Set<Stage>(['prd', 'dev', 'fix', 'infra_change']);

export type AidlcEvent =
    | { type: 'stage_start'; stage: Stage; workItemId: string }
    | { type: 'stage_done'; stage: Stage; workItemId: string; slice: Partial<WorkItem> }
    | { type: 'stage_skip'; stage: Stage; workItemId: string; reason: string }
    | { type: 'stage_dispatched'; stage: Stage; workItemId: string; jobName?: string }
    | { type: 'needs_input'; stage: Stage; workItemId: string; questions: string[] }
    | { type: 'gate_open'; stage: Stage; workItemId: string; gate: Gate }
    | { type: 'gate_decided'; stage: Stage; workItemId: string; decision: GateDecision; by?: string }
    | { type: 'repair'; workItemId: string; attempt: number }
    | { type: 'error'; stage: Stage; workItemId: string; error: string };

export interface SupervisorConfig {
    autoApproveStages: Stage[];   // gates to auto-approve in an unattended run (empty = human approves every gate)
    maxConcurrentWorkItems: number;
    autoMerge?: boolean;          // false (default): approving the deploy gate leaves the PR for a human to merge
    tz?: string;
    dispatchTimeoutMs?: number;   // a dispatched worker that doesn't report within this is retried once, then dead-lettered
    maxDispatchAttempts?: number; // total dispatch attempts per stage before dead-letter (default 2 = one retry)
    defaultBudgetTokens?: number; // per-work-item token ceiling (0/undefined = no ceiling). Pauses the item when hit.
}

export interface SupervisorDeps {
    store: WorkItemStore;
    /** Per-work-item ports (own sandbox clone). Called with the item's target repo. */
    portsFactory: (targetRepo: string) => AidlcServicePorts;
    dispatcher: StageDispatcher;
    log: DecisionLog;
    model: Model;                 // the main stage-agent model (coding-strong)
    criticModel?: Model;          // the quality critic + money verifier (high-volume → a lighter, separate-quota model)
    targetRepo: string;           // default repo (owner/name) if the item doesn't set its own
    baseBranch?: string;          // sandbox base; '' → the repo default branch
    dag?: Dag;
    config: SupervisorConfig;
    onEvent?: (e: AidlcEvent) => void;
    /** Observability sinks (durable event store + live bus) — the run page renders off these. */
    sinks?: TracerSinks;
    /** Quality-critic layer: score + bounded-revise each stage's output (default on). */
    qualityOn?: boolean;
}

// Normalize a feature key to a safe, stable Arango _key: lowercase kebab-case, alnum + dashes.
function slugifyKey(s: string): string {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export class Supervisor implements Orchestrator {
    private readonly dag: Dag;
    constructor(private readonly deps: SupervisorDeps) {
        this.dag = deps.dag || AIDLC_DAG;
    }

    // ── public API ───────────────────────────────────────────────────────────

    async submit(origin: WorkItem['origin'], title: string, targetRepo?: string, attachments?: Attachment[], workflow?: WorkItem['workflow']): Promise<WorkItem> {
        const open = await this.deps.store.list();
        const active = open.filter((w) => !this.isDone(w) && w.status.state !== 'failed');
        if (active.length >= this.deps.config.maxConcurrentWorkItems) {
            throw new Error(`concurrency cap reached (${this.deps.config.maxConcurrentWorkItems} active work items)`);
        }
        // Intake only — create the item and return. The caller drives it with advance() (the HTTP layer
        // does this in the background so submit returns immediately; the CLI awaits advance inline).
        const created = await this.deps.store.create({
            title,
            status: { stage: 'triage', state: 'pending' }, // adaptive flow: Triage classifies, then branches
            targetRepo: targetRepo || this.deps.targetRepo,
            attachments: attachments && attachments.length ? attachments : undefined,
            conversation: [],
            workflow: workflow && Object.keys(workflow).length ? workflow : undefined,
            origin,
            trace: { perStageCost: {} },
            artifacts: { gcsRefs: [] },
            repairAttempts: 0,
            questions: [],
            gate: null,
            sandbox: null,
            dispatch: null,
            budget: this.deps.config.defaultBudgetTokens ? { ceilingTokens: this.deps.config.defaultBudgetTokens, spentTokens: 0 } : undefined,
        });
        // Seed the requirements ledger from the raw request (+ any conversation) up front, so the very first
        // stage is already measured for instruction coverage. Best-effort.
        return this.refreshRequirements(created);
    }

    async advance(workItemId: string): Promise<WorkItem> {
        const tracer = await this.tracerFor(workItemId);
        // eslint-disable-next-line no-constant-condition
        while (true) {
            let wi = await this.must(workItemId);
            // Paused / terminal states hold until a human (or worker) acts.
            if (['awaiting_gate', 'awaiting_input', 'dispatched', 'failed'].includes(wi.status.state)) return wi;
            if (this.isDone(wi)) return wi;

            const stage = wi.status.stage;

            // COST CEILING (fail-safe): a runaway item must not burn unbounded tokens. When spend reaches the
            // ceiling, stop BEFORE starting another stage and hold as failed with a clear reason (the human can
            // raise the ceiling + re-submit). A gate at every risky stage already bounds spend; this is the backstop.
            if (wi.budget?.ceilingTokens && (wi.budget.spentTokens || 0) >= wi.budget.ceilingTokens) {
                tracer.emit(ev.budgetExceeded(stage, { spentTokens: wi.budget.spentTokens || 0, ceilingTokens: wi.budget.ceilingTokens }));
                this.emit({ type: 'error', stage, workItemId, error: `token budget ceiling reached (${wi.budget.spentTokens}/${wi.budget.ceilingTokens})` });
                return this.deps.store.update(workItemId, { status: { stage, state: 'failed' } });
            }

            const ports = this.portsFor(wi);
            const stageRunId = `${workItemId}:${stage}:r${wi.repairAttempts || 0}`;
            const ctx = this.ctx(ports, tracer, stageRunId);

            // Conditional skip (UX when no new design needed — unless authoring forced a design pass).
            if (stage === 'ux' && wi.prd?.designNeed !== 'new-design' && wi.workflow?.requireUx !== true) {
                this.emit({ type: 'stage_skip', stage, workItemId, reason: `designNeed=${wi.prd?.designNeed}` });
                tracer.emit(ev.stageSkipped(stage, `designNeed=${wi.prd?.designNeed}`));
                wi = await this.toNextStage(wi, stage);
                if (this.isDone(wi)) return wi;
                continue;
            }

            // Ensure a sandbox (repo clone) exists before a LOCALLY-run stage that reads/writes code (PRD
            // grounds with code.search). Worker-dispatched stages (Dev/Testing in job mode) clone their OWN
            // isolated sandbox inside the Job — the orchestrator must NOT clone for them.
            const needsSandbox = ['triage', 'research', 'prd', 'dev', 'fix', 'testing', 'infra_plan', 'infra_change', 'infra_verify'].includes(stage);
            if (needsSandbox && !this.deps.dispatcher.isAsync(stage)) {
                // If Triage routed to a DIFFERENT repo than the sandbox we cloned at triage, discard it so we
                // clone the chosen repo (local path — the isolated/job path clones per-stage anyway).
                if (wi.sandbox && wi.sandbox.repoRoot !== this.repoOf(wi)) {
                    await ports.sandbox.teardown(wi.sandbox.sandboxId).catch(() => undefined);
                    wi = await this.deps.store.update(workItemId, { sandbox: null });
                }
                if (!wi.sandbox) {
                    const box = await ports.sandbox.create(wi.id, this.repoOf(wi), this.deps.baseBranch || '');
                    wi = await this.deps.store.update(workItemId, { sandbox: box });
                }
            }

            // Adherence safety net: before a coverage-gated stage, if the requirements ledger is somehow empty
            // (an earlier extraction no-op'd), try once more — so the gate has something to enforce against.
            if (COVERAGE_STAGES.has(stage) && !(wi.requirements && wi.requirements.length)) {
                wi = await this.refreshRequirements(wi, tracer);
            }

            // Preview deploy: before a UI item's Testing stage, stand up an ephemeral per-branch environment so
            // the browser session runs against a REAL app. Persisted to wi.preview → the testing brief passes it.
            // Preview deploy runs where the sandbox + gcloud live: here (orchestrator) only when Testing runs
            // LOCALLY; in job mode the Testing WORKER stands it up itself (runStageIsolated) — see below.
            if (stage === 'testing' && !this.deps.dispatcher.isAsync(stage)) wi = await this.maybePreviewDeploy(wi, tracer);

            this.emit({ type: 'stage_start', stage, workItemId });
            tracer.emit(ev.stageStarted(stage, stageRunId));
            wi = await this.deps.store.update(workItemId, { status: { stage, state: 'running' } });

            const brief = await this.buildBrief(wi, stage);
            const outcome = await this.deps.dispatcher.run(wi, stage, brief, ctx);

            // Dispatched to an isolated worker — park and wait for onWorkerComplete.
            if (outcome.kind === 'dispatched') {
                // Carry attempts forward across a watchdog retry of the SAME stage (don't reset to 1).
                const priorAttempts = (wi.dispatch?.stage === stage ? wi.dispatch?.attempts : 0) || 0;
                await this.deps.store.update(workItemId, {
                    status: { stage, state: 'dispatched' },
                    dispatch: { stage, jobName: outcome.jobName, execution: outcome.execution, taskName: outcome.taskName, at: new Date().toISOString(), attempts: priorAttempts + 1 },
                });
                this.emit({ type: 'stage_dispatched', stage, workItemId, jobName: outcome.jobName });
                tracer.emit({ type: 'stage.dispatched', level: 'info', actor: 'orchestrator', stage, stageRunId, payload: { jobName: outcome.jobName } });
                return this.must(workItemId);
            }

            if (outcome.kind === 'needs_input') {
                wi = await this.enterClarify(wi, stage, outcome.questions, tracer);
                return wi;
            }
            if (outcome.kind === 'error') {
                this.emit({ type: 'error', stage, workItemId, error: outcome.error });
                tracer.emit(ev.stageFailed(stage, outcome.error, stageRunId));
                return this.deps.store.update(workItemId, { status: { stage, state: 'failed' } });
            }

            // outcome.kind === 'done'.
            let artifact = outcome.artifact;

            // Cost accounting: fold this stage's token spend into the per-stage trace + the item's running total.
            if (outcome.costTokens) {
                const spent = (wi.budget?.spentTokens || 0) + outcome.costTokens;
                const perStage = { ...(wi.trace?.perStageCost || {}), [stage]: (wi.trace?.perStageCost?.[stage] || 0) + outcome.costTokens };
                wi = await this.deps.store.update(workItemId, { trace: { ...wi.trace, perStageCost: perStage }, budget: { ...(wi.budget || {}), spentTokens: spent } });
                tracer.emit(ev.cost(stage, stageRunId, { tokens: outcome.costTokens }));
            }

            // QUALITY is the metric: a SEPARATE critic scores this stage's output; below the bar → revise
            // (bounded) with the critique's feedback. Local stages only (worker-dispatched stages carry
            // their own critique). The score is persisted + surfaced at the gate.
            let coverageBlocked: CoverageReport | undefined;
            if (this.deps.qualityOn !== false && !this.deps.dispatcher.isAsync(stage)) {
                const q = await this.runQuality(wi, stage, artifact, ctx, tracer);
                artifact = q.artifact;
                const patch: Partial<WorkItem> = { quality: { ...(wi.quality || {}), [stage]: q.report } };
                if (q.coverage) patch.coverage = { ...(wi.coverage || {}), [stage]: q.coverage };
                wi = await this.deps.store.update(workItemId, patch);
                if (q.coverage && !q.coverage.pass) coverageBlocked = q.coverage; // fail-closed: cannot advance
            }

            // Dev/Fix/Infra-change: commit + push the branch so the PR has a head.
            if ((stage === 'dev' || stage === 'fix' || stage === 'infra_change') && ports.sandbox.commitAndPush && wi.sandbox) {
                // Capture the diff BEFORE committing — `git diff --cached` is EMPTY once changes are committed,
                // which would starve the Changes tab AND the money/migration verifiers (they'd see no diff).
                const diff = await ports.sandbox.diff(wi.sandbox.sandboxId).catch(() => '');
                if (diff) artifact = { ...artifact, diff: diff.length > 60000 ? diff.slice(0, 60000) + '\n… (truncated)' : diff };
                const pushed = await ports.sandbox.commitAndPush(wi.sandbox.sandboxId, `AIDLC: ${wi.title}`).catch((e) => {
                    this.emit({ type: 'error', stage, workItemId, error: `commit/push failed: ${e?.message || e}` });
                    tracer.emit(ev.error(stage, `commit/push failed: ${e?.message || e}`));
                    return null;
                });
                if (pushed) { artifact = { ...artifact, branch: pushed.branch }; tracer.emit({ type: 'branch.pushed', level: 'info', actor: 'worker', stage, stageRunId, payload: { branch: pushed.branch } }); }
            }

            // FAIL-CLOSED verifiers (separate call; constitution §8). Money at Testing (revenueShare==1.0 +
            // characterization + flag); Migration at Infra-Verify (reversible + rollback + no data loss).
            // Failing one forces the verify stage red → back to the build stage.
            const runMoney = stage === 'testing' && this.isMoney(wi) && wi.sandbox;
            const runMig = stage === 'infra_verify' && (wi.triage?.risk?.includes('migration') || wi.infra?.isDataChange) && wi.sandbox;
            if ((runMoney || runMig) && wi.sandbox) {
                // Prefer the diff captured at build time (branch vs base). Re-computing here is empty — the
                // changes are already committed on the branch (git diff --cached shows nothing).
                const diff = wi.dev?.diff || await ports.sandbox.diff(wi.sandbox.sandboxId).catch(() => '');
                const v = runMoney
                    ? await verifyMoneyPath(this.deps.criticModel || this.deps.model, diff)
                    : await verifyMigration(this.deps.criticModel || this.deps.model, diff);
                await this.deps.store.update(workItemId, { verifier: { pass: v.pass, findings: v.findings, at: new Date().toISOString() } });
                tracer.emit(ev.verifierChecked(stage, stageRunId, v));
                if (!v.pass) artifact = { ...artifact, verdict: 'red', failures: `${runMoney ? 'Money-path' : 'Migration'} verifier FAILED (fail-closed): ${v.findings.join('; ')}` };
            }

            // Persist the stage's output first (so the human sees it), then — if instruction coverage is unmet —
            // HOLD at a coverage gate instead of advancing. The agent cannot pass dropped instructions; the
            // human either sees it fixed on the next run or explicitly defers each one (audited).
            if (coverageBlocked) {
                wi = await this.deps.store.update(wi.id, { ...this.sliceFor(stage, artifact, wi) });
                wi = await this.enterCoverageGate(wi, stage, coverageBlocked, tracer);
                return wi;
            }

            wi = await this.applyAndRoute(wi, stage, artifact, tracer);
            if (['awaiting_gate', 'awaiting_input', 'dispatched', 'failed'].includes(wi.status.state) || this.isDone(wi)) return wi;
        }
    }

    async decideGate(workItemId: string, decision: GateDecision, note?: string, by?: string): Promise<WorkItem> {
        const wi = await this.must(workItemId);
        const gate = wi.gate;
        if (!gate || wi.status.state !== 'awaiting_gate') return wi;

        this.emit({ type: 'gate_decided', stage: gate.stage, workItemId, decision, by });
        const tracer = await this.tracerFor(workItemId);
        tracer.emit(ev.gateDecided(gate.stage, decision, by));

        // MERGE-CONFIRMATION gate (deploy/infra_apply, auto-merge OFF): "has the PR been merged + deployed?"
        // This is the honest hold — the PR is OPEN, awaiting a human merge on GitHub. Approve = "yes, it's
        // live" → Deploy finally goes green and the pipeline continues (GTM for full features). Reject = "not
        // yet" → stay holding (Deploy is NOT done); we never fabricate a green deploy.
        if (gate.kind === 'merge_confirmation') {
            if (decision !== 'approve') return wi; // still awaiting the merge — hold, do not fail
            // Optionally watch the real merge-commit CI + auto-rollback if we can (no-op locally).
            if (this.deps.config.autoMerge || process.env.AIDLC_AUTO_MERGE === '1') await this.runDeploySequence(workItemId).catch(() => undefined);
            await this.deps.store.update(workItemId, { deploy: { ...(wi.deploy || ({} as DeployRecord)), mergedBy: by || 'human', mergedAt: new Date().toISOString() }, gate: null, status: { stage: gate.stage, state: 'passed' } });
            tracer.emit(ev.stagePassed(gate.stage, `${workItemId}:${gate.stage}:merged`));
            const nx = await this.toNextStage(await this.must(workItemId), gate.stage);
            if (this.isDone(nx)) { await this.cleanup(nx); return nx; }
            return this.advance(workItemId);
        }

        if (decision === 'reject') {
            return this.deps.store.update(workItemId, { gate: null, status: { stage: gate.stage, state: 'failed' } });
        }

        // Coverage gate: "approve" means RE-RUN the stage to try to cover the dropped instructions (it does NOT
        // mean "pass anyway" — the only way past an unmet must-have is an explicit deferral). Re-running goes
        // through the same coverage check; if the human has deferred enough, it will clear.
        if (gate.kind === 'coverage_review') {
            await this.deps.store.update(workItemId, { gate: null, status: { stage: gate.stage, state: 'pending' } });
            return this.advance(workItemId);
        }

        // Record approval on the stage artifact.
        await this.deps.store.update(workItemId, { ...this.recordApproval(gate.stage, wi, by || note || 'approved'), gate: null });

        // PR-approval gate (deploy / infra_apply). Two honest paths:
        if (gate.stage === 'deploy' || gate.stage === 'infra_apply') {
            if (this.deps.config.autoMerge || process.env.AIDLC_AUTO_MERGE === '1') {
                // Auto-merge ON: actually merge → trigger → watch → rollback-on-failure, THEN go green.
                await this.runDeploySequence(workItemId);
                await this.deps.store.update(workItemId, { status: { stage: gate.stage, state: 'passed' } });
                const nx = await this.toNextStage(await this.must(workItemId), gate.stage);
                if (this.isDone(nx)) { await this.cleanup(nx); return nx; }
                return this.advance(workItemId);
            }
            // Auto-merge OFF (safe default, esp. money paths): the PR is OPEN and awaits a human merge. Do NOT
            // mark Deploy green and do NOT run GTM — hold at a merge-confirmation gate that reflects reality.
            const mgate = this.makeMergeGate(await this.must(workItemId), gate.stage);
            await this.deps.store.update(workItemId, { gate: mgate, status: { stage: gate.stage, state: 'awaiting_gate' } });
            this.emit({ type: 'gate_open', stage: gate.stage, workItemId, gate: mgate });
            tracer.emit(ev.gateOpened(gate.stage, 'merge_confirmation', mgate.summary));
            return this.must(workItemId);
        }

        // Non-deploy gate (prd/ux/analytics/gtm/infra_plan) → mark passed + advance.
        await this.deps.store.update(workItemId, { status: { stage: gate.stage, state: 'passed' } });
        const next = await this.toNextStage(await this.must(workItemId), gate.stage);
        if (this.isDone(next)) { await this.cleanup(next); return next; }
        return this.advance(workItemId);
    }

    async answerClarify(workItemId: string, answers: string[], by?: string): Promise<WorkItem> {
        const wi = await this.must(workItemId);
        if (wi.status.state !== 'awaiting_input') return wi;
        const rounds = [...(wi.questions || [])];
        const open = [...rounds].reverse().find((r) => !r.answeredAt);
        if (open) {
            open.answers = answers;
            open.answeredAt = new Date().toISOString();
            open.answeredBy = by;
        }
        (await this.tracerFor(workItemId)).emit(ev.clarifyAnswered(wi.status.stage, answers, by));
        // Re-run the asking stage with the Q&A now in context.
        await this.deps.store.update(workItemId, { questions: rounds, status: { stage: wi.status.stage, state: 'pending' } });
        return this.advance(workItemId);
    }

    // Conversation-at-stage: a free-form human message (redirect / add context / attach files). Appended to
    // the thread; if the item is paused it re-runs the current stage with the message in context; if a stage
    // is mid-run the message is stored and picked up on the next (re-)run. The message + files reach the agent
    // via buildBrief + the dispatcher's file attachment.
    async message(workItemId: string, text: string, attachments?: Attachment[], by?: string): Promise<WorkItem> {
        const wi = await this.must(workItemId);
        const conv: ConvMsg = { role: 'user', stage: wi.status.stage, text, attachments: attachments?.length ? attachments : undefined, at: new Date().toISOString(), by };
        const conversation = [...(wi.conversation || []), conv];
        (await this.tracerFor(workItemId)).emit(ev.message(wi.status.stage, text, by, attachments?.length || 0));
        // Merge any new attachments into the work item so EVERY stage can see them.
        const allAttach = attachments?.length ? [...(wi.attachments || []), ...attachments] : wi.attachments;
        const paused = ['awaiting_gate', 'awaiting_input', 'failed'].includes(wi.status.state);
        if (paused) {
            let updated = await this.deps.store.update(workItemId, { conversation, attachments: allAttach, gate: null, status: { stage: wi.status.stage, state: 'pending' } });
            // A human message is a new instruction → fold it into the requirements ledger before re-planning.
            updated = await this.refreshRequirements(updated);
            return this.advance(workItemId);
        }
        // Mid-run (running/dispatched): store; the message is honoured when the stage next (re-)runs.
        const stored = await this.deps.store.update(workItemId, { conversation, attachments: allAttach });
        return this.refreshRequirements(stored);
    }

    // Revise an EARLIER stage and re-run it + everything downstream (the DAG re-plan). E.g. after Dev is
    // done you change the PRD → PRD re-runs (gated again), then Dev/Testing/… re-run on the updated spec.
    // The human's note is recorded as a stage-scoped message so the re-run sees it; requirements are
    // re-extracted so the new instruction is tracked + coverage-checked.
    async reviseStage(workItemId: string, stage: Stage, text: string, attachments?: Attachment[], by?: string): Promise<WorkItem> {
        let wi = await this.must(workItemId);
        const conv: ConvMsg = { role: 'user', stage, text, attachments: attachments?.length ? attachments : undefined, at: new Date().toISOString(), by };
        const conversation = [...(wi.conversation || []), conv];
        const allAttach = attachments?.length ? [...(wi.attachments || []), ...attachments] : wi.attachments;
        (await this.tracerFor(workItemId)).emit(ev.message(stage, `[revise ${stage}] ${text}`, by, attachments?.length || 0));
        // Reopen AT the chosen stage; advance() re-runs it and follows the DAG forward through the later stages.
        wi = await this.deps.store.update(workItemId, { conversation, attachments: allAttach, gate: null, status: { stage, state: 'pending' } });
        wi = await this.refreshRequirements(wi);
        return this.advance(workItemId);
    }

    async openGate(workItemId: string): Promise<Gate | null> {
        const wi = await this.deps.store.get(workItemId);
        if (!wi || wi.status.state !== 'awaiting_gate') return null;
        return wi.gate || null;
    }

    // Called via the Pub/Sub bridge when an isolated worker finishes a dispatched heavy stage.
    async onWorkerComplete(result: WorkerResult): Promise<void> {
        let wi = await this.must(result.workItemId);
        if (wi.status.state !== 'dispatched' || wi.status.stage !== result.stage) {
            // Stale / duplicate delivery — ignore (idempotent).
            return;
        }
        const patch: Partial<WorkItem> = { dispatch: null };
        if (result.sandbox) patch.sandbox = result.sandbox;
        if (result.quality) patch.quality = { ...(wi.quality || {}), [result.stage]: result.quality };
        if (result.coverage) patch.coverage = { ...(wi.coverage || {}), [result.stage]: result.coverage };
        if (result.verifier) patch.verifier = { pass: result.verifier.pass, findings: result.verifier.findings, at: new Date().toISOString() };
        if (result.costTokens) {
            patch.trace = { ...wi.trace, perStageCost: { ...(wi.trace?.perStageCost || {}), [result.stage]: (wi.trace?.perStageCost?.[result.stage] || 0) + result.costTokens } };
            patch.budget = { ...(wi.budget || {}), spentTokens: (wi.budget?.spentTokens || 0) + result.costTokens };
        }
        wi = await this.deps.store.update(result.workItemId, patch);

        if (result.outcome === 'error') {
            this.emit({ type: 'error', stage: result.stage, workItemId: wi.id, error: result.error || 'worker error' });
            await this.deps.store.update(wi.id, { status: { stage: result.stage, state: 'failed' } });
            return;
        }
        if (result.outcome === 'needs_input') {
            await this.enterClarify(wi, result.stage, result.questions || []);
            return;
        }
        // done — the worker already committed+pushed any Dev branch, ran quality + (money) verifier, and
        // reports them. A failed money verifier forces testing red (fail-closed) → back to Dev.
        let artifact = result.branch ? { ...result.artifact, branch: result.branch } : result.artifact;
        if ((result.stage === 'testing' || result.stage === 'infra_verify') && result.verifier && !result.verifier.pass) {
            const label = result.stage === 'testing' ? 'Money-path' : 'Migration';
            artifact = { ...artifact, verdict: 'red', failures: `${label} verifier FAILED (fail-closed): ${result.verifier.findings.join('; ')}` };
        }
        // Instruction coverage unmet on a dispatched build stage → HOLD at a coverage gate (fail-closed),
        // same as the local path. Persist the output first so the human sees it.
        if (result.coverage && !result.coverage.pass) {
            wi = await this.deps.store.update(wi.id, { ...this.sliceFor(result.stage, artifact, wi) });
            await this.enterCoverageGate(wi, result.stage, result.coverage);
            return;
        }
        wi = await this.applyAndRoute(wi, result.stage, artifact);
        if (!(['awaiting_gate', 'awaiting_input', 'dispatched', 'failed'].includes(wi.status.state) || this.isDone(wi))) {
            await this.advance(wi.id); // continue into the next (light) stages
        }
    }

    // Watchdog (constitution §8 reliability): a dispatched worker can die silently — a Job OOMs, a Pub/Sub
    // result is lost, a Cloud Run revision is torn down mid-run — and the work item would park in 'dispatched'
    // forever. This sweep finds those, RETRIES the stage once (re-dispatch via advance), then DEAD-LETTERS
    // (fails) it with a clear reason. Idempotent + safe on an interval: it only touches items still parked on
    // the SAME stage they were dispatched on, past the timeout.
    async sweepStuck(now = Date.now()): Promise<{ retried: string[]; deadLettered: string[] }> {
        const timeout = this.deps.config.dispatchTimeoutMs ?? 20 * 60 * 1000; // 20 min default
        const maxAttempts = this.deps.config.maxDispatchAttempts ?? 2;        // one retry, then dead-letter
        const retried: string[] = [];
        const deadLettered: string[] = [];
        const parked = await this.deps.store.list({ state: 'dispatched' }).catch(() => [] as WorkItem[]);
        for (const wi of parked) {
            const d = wi.dispatch;
            // Only act on a still-consistent park record past the timeout.
            if (!d || d.stage !== wi.status.stage) continue;
            const age = now - new Date(d.at).getTime();
            if (!(age > timeout)) continue;
            const tracer = await this.tracerFor(wi.id).catch(() => undefined);
            const attempts = d.attempts || 1;
            if (attempts >= maxAttempts) {
                // Dead-letter: give up, fail the item, leave a breadcrumb for the run page.
                await this.deps.store.update(wi.id, { status: { stage: d.stage, state: 'failed' }, dispatch: null });
                this.emit({ type: 'error', stage: d.stage, workItemId: wi.id, error: `worker timed out after ${attempts} attempt(s) — dead-lettered` });
                tracer?.emit(ev.stageFailed(d.stage, `worker did not report within ${Math.round(timeout / 60000)}m after ${attempts} attempt(s) — dead-lettered`));
                deadLettered.push(wi.id);
            } else {
                // Retry: clear the stale park so advance() re-dispatches the same stage (attempts carries forward).
                tracer?.emit({ type: 'stage.dispatched', level: 'warn', actor: 'orchestrator', stage: d.stage, payload: { retry: true, priorAttempts: attempts, reason: `no worker result in ${Math.round(timeout / 60000)}m` } });
                await this.deps.store.update(wi.id, { status: { stage: d.stage, state: 'pending' } });
                await this.advance(wi.id).catch((e) => { this.emit({ type: 'error', stage: d.stage, workItemId: wi.id, error: `retry dispatch failed: ${e?.message || e}` }); });
                retried.push(wi.id);
            }
        }
        return { retried, deadLettered };
    }

    // Run ONE heavy stage inside an isolated Cloud Run Job worker (constructed with a LocalDispatcher).
    // Clones the right branch (Testing → the branch Dev pushed; Dev/UX → the base), runs the stage, scores
    // quality, commits+pushes (Dev) + captures the diff, runs the money verifier (Testing), and returns a
    // WorkerResult. Routing stays with the orchestrator (onWorkerComplete). Emits events via the worker's
    // tracer → Pub/Sub → the run page. See AIDLC-OBSERVABILITY.md §3/§4.
    async runStageIsolated(workItemId: string, stage: Stage): Promise<WorkerResult> {
        const tracer = await this.tracerFor(workItemId);
        const wi = await this.must(workItemId);
        const ports = this.portsFor(wi);
        const stageRunId = `${workItemId}:${stage}:worker`;
        tracer.emit({ type: 'worker.started', level: 'info', actor: 'worker', stage, stageRunId, payload: { repo: this.repoOf(wi) } });
        // The worker owns its own ephemeral clone (true isolation). Testing tests the branch Dev pushed;
        // a Dev REPAIR resumes its own pushed branch (build on prior work, don't start over).
        const resumesOwnBranch = ['testing', 'dev', 'infra_plan', 'infra_change', 'infra_verify'].includes(stage);
        const base = (resumesOwnBranch && wi.dev?.branch) ? wi.dev.branch : (this.deps.baseBranch || '');
        const box = await ports.sandbox.create(wi.id, this.repoOf(wi), base);
        let wiBox = await this.deps.store.update(workItemId, { sandbox: box });
        tracer.emit(ev.stageStarted(stage, stageRunId));
        const ctx = this.ctx(ports, tracer, stageRunId);

        const finish = (r: Omit<WorkerResult, 'workItemId' | 'stage' | 'sandbox'>): WorkerResult => {
            tracer.emit({ type: 'worker.finished', level: 'info', actor: 'worker', stage, stageRunId, payload: { outcome: r.outcome } });
            return { workItemId, stage, sandbox: box, ...r };
        };
        try {
            // Stand up the per-branch preview BEFORE Testing builds its brief, so the browser session targets
            // a REAL running app. Runs HERE (in the worker) where gcloud + Cloud Build access live; no-op
            // unless AIDLC_PREVIEW_DEPLOY=1 + a per-repo preview service is set (else Testing uses AIDLC_PREVIEW_URL).
            if (stage === 'testing') wiBox = await this.maybePreviewDeploy(wiBox, tracer);
            const outcome = await this.deps.dispatcher.run(wiBox, stage, await this.buildBrief(wiBox, stage), ctx);
            if (outcome.kind === 'needs_input') { tracer.emit(ev.clarifyAsked(stage, outcome.questions)); return finish({ outcome: 'needs_input', questions: outcome.questions }); }
            if (outcome.kind === 'dispatched') return finish({ outcome: 'error', error: 'worker received a dispatch outcome (should be local)' });
            if (outcome.kind === 'error') { tracer.emit(ev.stageFailed(stage, outcome.error, stageRunId)); return finish({ outcome: 'error', error: outcome.error }); }

            let artifact = outcome.artifact;
            // Quality critic + bounded revise (the worker has the model + sandbox for revisions).
            let quality: WorkerResult['quality'];
            let coverage: WorkerResult['coverage'];
            if (this.deps.qualityOn !== false) {
                const q = await this.runQuality(wiBox, stage, artifact, ctx, tracer);
                artifact = q.artifact; quality = q.report; coverage = q.coverage;
            }
            let branch: string | undefined;
            if ((stage === 'dev' || stage === 'fix' || stage === 'infra_change') && ports.sandbox.commitAndPush) {
                // Capture the diff BEFORE commit (git diff --cached is empty afterwards).
                const diff = await ports.sandbox.diff(box.sandboxId).catch(() => '');
                if (diff) artifact = { ...artifact, diff: diff.length > 60000 ? diff.slice(0, 60000) + '\n… (truncated)' : diff };
                const pushed = await ports.sandbox.commitAndPush(box.sandboxId, `AIDLC: ${wiBox.title}`).catch(() => null);
                if (pushed) {
                    branch = pushed.branch; artifact = { ...artifact, branch };
                    tracer.emit({ type: 'branch.pushed', level: 'info', actor: 'worker', stage, stageRunId, payload: { branch } });
                }
            }
            let verifier: WorkerResult['verifier'];
            const isoMoney = stage === 'testing' && this.isMoney(wiBox);
            const isoMig = stage === 'infra_verify' && (wiBox.triage?.risk?.includes('migration') || wiBox.infra?.isDataChange);
            if (isoMoney || isoMig) {
                const diff = wiBox.dev?.diff || await ports.sandbox.diff(box.sandboxId).catch(() => '');
                verifier = isoMoney
                    ? await verifyMoneyPath(this.deps.criticModel || this.deps.model, diff)
                    : await verifyMigration(this.deps.criticModel || this.deps.model, diff);
                tracer.emit(ev.verifierChecked(stage, stageRunId, verifier));
            }
            tracer.emit(ev.stagePassed(stage, stageRunId));
            return finish({ outcome: 'done', artifact, branch, quality, coverage, verifier, costTokens: outcome.costTokens });
        } finally {
            // Tear down the per-branch preview (if this worker stood one up) + the sandbox clone.
            if (stage === 'testing') await this.teardownPreview(await this.must(workItemId)).catch(() => undefined);
            await ports.sandbox.teardown(box.sandboxId).catch(() => undefined);
        }
    }

    // ── internals ──────────────────────────────────────────────────────────────

    // Apply a completed stage's artifact to the item, then route: repair loop / gate / DAG advance.
    private async applyAndRoute(wi: WorkItem, stage: Stage, artifact: any, tracer?: Tracer): Promise<WorkItem> {
        const slice = this.sliceFor(stage, artifact, wi);
        wi = await this.deps.store.update(wi.id, { ...slice });
        this.emit({ type: 'stage_done', stage, workItemId: wi.id, slice });

        // Testing is done with the preview — tear it down (a red→repair→testing loop redeploys a fresh one).
        if (stage === 'testing' && wi.preview?.ref) { await this.teardownPreview(wi); wi = await this.must(wi.id); }

        // PRD establishes the feature lineage: upsert the feature area + tag the work item with it, so
        // later stages inject its history and completion appends to its chronological chain.
        if (stage === 'prd' && artifact?.featureKey) {
            const id = slugifyKey(String(artifact.featureKey));
            if (id) {
                try {
                    await this.feature().upsert({ id, name: String(artifact.featureName || id), summary: artifact.problem, paths: Array.isArray(artifact.affectedSurfaces) ? artifact.affectedSurfaces : [] });
                    wi = await this.deps.store.update(wi.id, { featureId: id });
                } catch { /* lineage is best-effort — never block the pipeline */ }
            }
        }

        // PRD done → fold its acceptance criteria into the requirements ledger, so the Dev/Fix coverage check
        // measures the build against the agreed spec, not just the raw request.
        if (stage === 'prd') wi = await this.refreshRequirements(wi, tracer);

        tracer?.emit(ev.stagePassed(stage, `${wi.id}:${stage}`));

        // Verify verdict → repair loop or forward. Repair routes back to whichever stage built it (Fix/Dev
        // for code, Infra-Change for infra) per the DAG's repair edge.
        if ((stage === 'testing' || stage === 'infra_verify') && wi.tests?.verdict === 'red') {
            const n = (wi.repairAttempts || 0) + 1;
            if (n > MAX_REPAIR_ATTEMPTS) {
                tracer?.emit(ev.stageFailed(stage, `red after ${MAX_REPAIR_ATTEMPTS} repair attempts`));
                return this.deps.store.update(wi.id, { repairAttempts: n, status: { stage, state: 'failed' } });
            }
            const repairEdge = this.dag.find((e) => e.from === stage && e.kind === 'repair' && (!e.when || e.when(wi)));
            const target: Stage = repairEdge?.to || 'dev';
            this.emit({ type: 'repair', workItemId: wi.id, attempt: n });
            tracer?.emit({ type: 'stage.queued', level: 'info', actor: 'orchestrator', stage: target, payload: { repair: n } });
            return this.deps.store.update(wi.id, { repairAttempts: n, status: { stage: target, state: 'pending' } });
        }

        // Deploy / Infra-apply: OPEN THE PR DETERMINISTICALLY from the agent's evidence body — capturing the
        // REAL url from GitHub (the agent never fabricates a link). Idempotent: a re-run returns the same PR.
        if ((stage === 'deploy' || stage === 'infra_apply') && wi.dev?.branch) {
            const body = String(artifact?.prBody || artifact?.body || `AIDLC: ${wi.title}`);
            const titled = artifact?.prTitle ? `${artifact.prTitle}\n\n${body}` : body;
            try {
                const { prUrl } = await this.portsFor(wi).deploy.openPr(wi.dev.branch, titled);
                wi = await this.deps.store.update(wi.id, { deploy: { ...(wi.deploy || ({} as DeployRecord)), prUrl } });
                tracer?.emit({ type: 'pr.opened', level: 'info', actor: 'orchestrator', stage, payload: { prUrl } });
            } catch (e: any) {
                this.emit({ type: 'error', stage, workItemId: wi.id, error: `openPr failed: ${e?.message || e}` });
                tracer?.emit(ev.error(stage, `openPr failed: ${e?.message || e}`));
                return this.deps.store.update(wi.id, { status: { stage, state: 'failed' } });
            }
        }

        // Gate?
        if (GATED_STAGES[stage]) {
            const gate = this.makeGate(wi, stage);
            wi = await this.deps.store.update(wi.id, { gate, status: { stage, state: 'awaiting_gate' } });
            this.emit({ type: 'gate_open', stage, workItemId: wi.id, gate });
            tracer?.emit(ev.gateOpened(stage, gate.kind, gate.summary));
            // Per-item authoring can override which gates auto-approve (else the global config list).
            const autoList = wi.workflow?.autoApproveStages ?? this.deps.config.autoApproveStages;
            if (autoList.includes(stage)) {
                return this.decideGate(wi.id, 'approve', 'auto-approved (unattended run)');
            }
            return wi; // hold for a human
        }

        // Not gated → advance along the DAG.
        wi = await this.toNextStage(wi, stage);
        if (this.isDone(wi)) await this.cleanup(wi);
        return wi;
    }

    private async enterClarify(wi: WorkItem, stage: Stage, questions: string[], tracer?: Tracer): Promise<WorkItem> {
        const round: ClarifyRound = { stage, askedAt: new Date().toISOString(), questions };
        const rounds = [...(wi.questions || []), round];
        this.emit({ type: 'needs_input', stage, workItemId: wi.id, questions });
        tracer?.emit(ev.clarifyAsked(stage, questions));
        return this.deps.store.update(wi.id, { questions: rounds, status: { stage, state: 'awaiting_input' } });
    }

    // One tracer per driving call; seeds its seq from the store so the stream stays monotonic on resume.
    private async tracerFor(workItemId: string): Promise<Tracer> {
        return createTracer(workItemId, this.deps.sinks || {});
    }

    // QUALITY critique + bounded revise. Scores the stage output with a SEPARATE critic; if below bar,
    // re-runs the stage with the critique's concrete improvements injected. Returns the best artifact +
    // the (loose) report to persist on the work item. Emits quality.scored / quality.revising.
    private async runQuality(wi: WorkItem, stage: Stage, artifact: any, ctx: StageCtx, tracer: Tracer): Promise<{ artifact: any; report: NonNullable<WorkItem['quality']>[string]; coverage?: CoverageReport }> {
        const moneyTier = this.isMoney(wi);
        const covEligible = COVERAGE_STAGES.has(stage);
        const wantCoverage = covEligible && !!(wi.requirements && wi.requirements.length);
        const isBuild = stage === 'dev' || stage === 'fix' || stage === 'infra_change';
        const srid = ctx.stageRunId || `${wi.id}:${stage}`;
        // The adherence guarantee must never fail SILENTLY: if a coverage-eligible stage has no requirements
        // (extraction returned nothing / errored), surface it loudly instead of passing unchecked. A money/
        // migration item with no coverage is held, not waved through.
        if (covEligible && !wantCoverage) {
            tracer.emit({ type: 'coverage.checked', level: 'warn', actor: 'system', stage, stageRunId: srid, payload: { pass: false, unmet: [], total: 0, revision: 0, note: 'no requirements extracted — instruction adherence NOT enforced for this stage; re-extraction failed or the request was empty' } });
        }
        let current = artifact;
        let report: QualityReport | null = null;
        let coverage: CoverageReport | undefined;
        // Verdict stages (testing / infra_verify) produce a PASS/FAIL, not creative work — a critic "quality
        // score" is meaningless here (and was flakily returning 0 = the "TESTING 0" confusion). Derive the
        // score from the VERDICT itself (the real signal) and skip the critic entirely.
        if (stage === 'testing' || stage === 'infra_verify') {
            const green = (artifact?.verdict === 'green');
            const fails = String(artifact?.failures || artifact?.summary || '').slice(0, 500);
            const vReport = {
                score: green ? 92 : 30, bar: 50, pass: green,
                criteria: [{ name: 'verification', score: green ? 92 : 30, feedback: green ? 'Independently verified green (typecheck / browser session / fail-closed verifiers).' : (fails || 'Verification failed.') }],
                strengths: green ? 'All checks passed.' : '', weaknesses: green ? '' : fails,
                improvements: green ? [] : ['Address the verification failures above.'], revision: 0,
            };
            tracer.emit(ev.qualityScored(stage, srid, { score: vReport.score, bar: vReport.bar, pass: vReport.pass, revision: 0, weaknesses: vReport.weaknesses }));
            return { artifact: current, report: vReport, coverage: undefined };
        }
        // Builder/spec stages get the critic + bounded revise loop.
        const maxRev = MAX_QUALITY_REVISIONS;
        for (let rev = 0; rev <= maxRev; rev++) {
            report = await critique(this.deps.criticModel || this.deps.model, { stage, artifact: current, contextSummary: this.qualityContext(wi, stage), moneyTier, revision: rev });
            tracer.emit(ev.qualityScored(stage, srid, { score: report.score, bar: report.bar, pass: report.pass, revision: rev, weaknesses: report.weaknesses }));
            // Instruction adherence: did this output cover EVERY must-have requirement? Fail-closed.
            if (wantCoverage) {
                let diff = isBuild && wi.sandbox ? await ctx.ports.sandbox.diff(wi.sandbox.sandboxId).catch(() => '') : undefined;
                // A build stage that REPORTED filesTouched but yields an EMPTY diff is a diff-FETCH hiccup, not
                // "no work done" — the fail-closed verifier would then wrongly mark everything missing. Retry
                // the fetch once before trusting an empty diff.
                const filesTouched = Array.isArray((current as any)?.filesTouched) ? (current as any).filesTouched.length : 0;
                if (isBuild && wi.sandbox && (!diff || !diff.trim()) && filesTouched > 0) {
                    diff = await ctx.ports.sandbox.diff(wi.sandbox.sandboxId).catch(() => '');
                }
                const items = await verifyCoverage(this.deps.criticModel || this.deps.model, wi.requirements!, { stage, artifact: current, context: this.qualityContext(wi, stage), diff });
                coverage = buildCoverageReport(stage, wi.requirements!, items, rev);
                // eslint-disable-next-line no-console
                console.log(`[aidlc:coverage] ${stage} rev${rev}: diffChars=${diff?.length ?? 'n/a'} filesTouched=${filesTouched} pass=${coverage.pass} unmet=${coverage.unmet.length} | ${items.map((i) => `${i.reqId}:${i.status}`).join(' ')}`);
                tracer.emit(ev.coverageChecked(stage, srid, { pass: coverage.pass, unmet: coverage.unmet, total: coverage.items.length, revision: rev }));
            }
            const covOk = !wantCoverage || (coverage && coverage.pass);
            if ((report.pass && covOk) || rev === maxRev) break;
            tracer.emit(ev.qualityRevising(stage, srid, { revision: rev + 1, improvements: report.improvements }));
            // The revise brief carries BOTH the quality improvements AND the exact instructions that were dropped.
            const unmetTexts = (coverage?.unmet || []).map((id) => wi.requirements!.find((r) => r.id === id)).filter(Boolean)
                .map((r) => `- [${r!.id}] ${r!.text}`).join('\n');
            const coverageBlock = !covOk && unmetTexts
                ? `\n\nINSTRUCTION ADHERENCE — you did NOT address these REQUIRED instructions. You MUST cover every one (do not skip or silently defer any):\n${unmetTexts}`
                : '';
            const qualityBlock = !report.pass
                ? `\n\nQUALITY REVIEW — scored ${report.score}/100 (bar ${report.bar}). REVISE to address, do not restart:\nWeaknesses: ${report.weaknesses}\nConcrete improvements:\n${report.improvements.map((i) => `- ${i}`).join('\n')}`
                : '';
            const reviseBrief = `${await this.buildBrief(wi, stage)}${qualityBlock}${coverageBlock}`;
            const out = await this.deps.dispatcher.run(wi, stage, reviseBrief, { ...ctx, stageRunId: `${srid}:q${rev + 1}` });
            if (out.kind === 'done') current = out.artifact; else break; // a failed revision keeps the best-so-far
        }
        const r = report!;
        return { artifact: current, report: { score: r.score, bar: r.bar, pass: r.pass, criteria: r.criteria, strengths: r.strengths, weaknesses: r.weaknesses, improvements: r.improvements, revision: r.revision }, coverage };
    }

    // Re-derive the requirements ledger from the request + PRD + EVERY human message, preserving ids +
    // human-approved deferrals. Called on submit, after the PRD lands, and whenever the human sends a message —
    // so a new instruction is always a new, tracked requirement. Best-effort: a failed extraction never blocks.
    private async refreshRequirements(wi: WorkItem, tracer?: Tracer): Promise<WorkItem> {
        try {
            const fresh = await extractRequirements(this.deps.criticModel || this.deps.model, wi, new Date().toISOString());
            if (!fresh.length && !(wi.requirements?.length)) return wi;
            const merged = mergeRequirements(wi.requirements, fresh);
            tracer?.emit(ev.requirementsExtracted(wi.status.stage, { count: merged.length, mustHave: merged.filter((r) => r.mustHave).length }));
            return this.deps.store.update(wi.id, { requirements: merged });
        } catch {
            return wi;
        }
    }

    // Human-only deferral of a requirement the agent couldn't/shouldn't meet now. This is the ONLY sanctioned
    // way past an unmet must-have — audited, attributed. If deferring clears the last blocker on an open
    // coverage gate, the stage advances.
    async deferRequirement(workItemId: string, reqId: string, reason: string, by: string): Promise<WorkItem> {
        let wi = await this.must(workItemId);
        const reqs = (wi.requirements || []).map((r) => r.id === reqId ? { ...r, deferral: { approvedBy: by, reason, at: new Date().toISOString() } } : r);
        wi = await this.deps.store.update(workItemId, { requirements: reqs });
        const tracer = await this.tracerFor(workItemId);
        tracer.emit(ev.requirementDeferred(wi.status.stage, { reqId, by, reason }));
        // If deferral clears the last unmet must-have on an open coverage gate, the stage's output is ACCEPTED
        // (deferrals are the human saying "ship as-is, track these as follow-ups") → mark it passed and ADVANCE
        // to the next stage. Do NOT re-run the stage (that is what "approve" does).
        if (wi.gate?.kind === 'coverage_review') {
            const stage = wi.status.stage;
            const stillUnmet = (wi.coverage?.[stage]?.unmet || []).filter((id) => {
                const r = reqs.find((x) => x.id === id);
                return r && r.mustHave && !r.deferral;
            });
            if (stillUnmet.length === 0) {
                wi = await this.deps.store.update(workItemId, { gate: null, status: { stage, state: 'passed' } });
                const next = await this.toNextStage(await this.must(workItemId), stage);
                if (this.isDone(next)) { await this.cleanup(next); return next; }
                return this.advance(workItemId);
            }
        }
        return wi;
    }

    // What the stage worked from — grounds the critic's judgement (not the full artifact, which it also sees).
    private qualityContext(wi: WorkItem, stage: Stage): string {
        const J = (o: unknown) => JSON.stringify(o, null, 2);
        if (stage === 'triage') return `Original request: ${wi.origin.rawRequest}`;
        if (stage === 'research') return `Request: ${wi.origin.rawRequest}\nTriage: ${J(wi.triage)}`;
        if (stage === 'prd') return `Original request: ${wi.origin.rawRequest}\nTriage: ${J(wi.triage)}`;
        if (stage === 'ux' || stage === 'analytics' || stage === 'gtm') return `PRD:\n${J(wi.prd)}`;
        if (stage === 'fix') return `Bug/chore: ${wi.origin.rawRequest}\nTriage: ${J(wi.triage)}`;
        if (stage === 'dev' || stage === 'testing') return `PRD:\n${J(wi.prd)}\nDesign:\n${J(wi.design ?? 'n/a')}\nRisk: ${wi.prd?.riskTier || wi.triage?.risk?.join(',') || 'standard'}`;
        if (stage === 'infra_plan') return wi.dev?.infraNeed?.required ? `Dev-dictated infra need: ${J(wi.dev.infraNeed)}\nFor code change: ${wi.dev?.diffSummary}` : `Infra/data request: ${wi.origin.rawRequest}\nTriage: ${J(wi.triage)}`;
        if (stage === 'infra_change' || stage === 'infra_verify') return `Infra plan:\n${J(wi.infra)}\nRisk: ${wi.triage?.risk?.join(',') || 'infra'}`;
        if (stage === 'infra_apply') return `Infra plan:\n${J(wi.infra)}\nChange: ${wi.dev?.diffSummary || '(see branch)'}`;
        return `Request: ${wi.origin.rawRequest}`;
    }

    private portsFor(wi: WorkItem): AidlcServicePorts {
        const ports = this.deps.portsFactory(this.repoOf(wi));
        if (wi.sandbox && ports.sandbox.adopt) ports.sandbox.adopt(wi.sandbox);
        return ports;
    }
    private ctx(ports: AidlcServicePorts, tracer?: Tracer, stageRunId?: string): StageCtx {
        return { model: this.deps.model, ports, log: this.deps.log, tz: this.deps.config.tz, sink: tracer, stageRunId };
    }
    private repoOf(wi: WorkItem): string {
        return wi.targetRepo || this.deps.targetRepo;
    }
    // Money-path risk comes from Triage (bugs/changes) or the PRD risk tier (features).
    private isMoney(wi: WorkItem): boolean {
        return wi.prd?.riskTier === 'money' || !!wi.triage?.risk?.includes('money') || wi.workflow?.forceMoneyTier === true;
    }
    // The feature ledger is repo/sandbox-independent, so any ports instance's feature port works.
    private feature(): FeaturePort {
        return this.deps.portsFactory(this.deps.targetRepo).feature;
    }
    // A compact, chronological summary of a feature's prior change requests to inject into a brief.
    private async featureHistoryBlock(wi: WorkItem): Promise<string> {
        if (!wi.featureId) return '';
        const f = await this.feature().history(wi.featureId).catch(() => null);
        if (!f || !f.changes.length) return '';
        const chain = f.changes
            .map((c, i) => `${i + 1}. [${String(c.at).slice(0, 10)}] ${c.title}${c.prUrl ? ` (PR: ${c.prUrl})` : ''}${c.acceptanceCriteria?.length ? ` — ${c.acceptanceCriteria.slice(0, 3).join('; ')}` : ''}`)
            .join('\n');
        return `\nFEATURE LINEAGE — "${f.name}" has these prior change requests (oldest→newest). Build on the LATEST; do not contradict or duplicate:\n${chain}\n`;
    }

    private async buildBrief(wi: WorkItem, stage: Stage): Promise<string> {
        const J = (o: unknown) => JSON.stringify(o, null, 2);
        const answered = (wi.questions || []).filter((r) => r.stage === stage && r.answeredAt);
        const clarifyPart = answered.length
            ? `\nAnswered clarifying questions (use these; do not re-ask):\n${answered.map((r) => r.questions.map((q, i) => `Q: ${q}\nA: ${r.answers?.[i] ?? ''}`).join('\n')).join('\n')}\n`
            : '';
        // Conversation-at-stage: the human's free-form messages direct the agent — honour them.
        const userMsgs = (wi.conversation || []).filter((c) => c.role === 'user');
        const convPart = userMsgs.length
            ? `\nHUMAN MESSAGES (the person is directing you — incorporate these, latest wins):\n${userMsgs.slice(-6).map((c) => `- ${c.text}${c.attachments?.length ? ` [see ${c.attachments.length} attached file(s)]` : ''}`).join('\n')}\n`
            : '';
        const attachPart = (wi.attachments?.length) ? `\n(${wi.attachments.length} attached file(s) are provided as images/PDFs alongside this brief — read them.)\n` : '';
        const clarifyBlock = clarifyPart + convPart + attachPart;
        // Dev/Fix/re-planned-PRD get the feature's prior change chain so they build on the latest state.
        const lineage = (stage === 'dev' || stage === 'fix' || stage === 'prd') ? await this.featureHistoryBlock(wi) : '';
        const box = wi.sandbox;
        const sandboxLine = box
            ? `Sandbox: sandboxId="${box.sandboxId}" (a fresh clone of ${this.repoOf(wi)} on branch ${box.branch}). Use sandbox.* tools for file ops; code.search/code.read read the same clone.`
            : '';
        // On a repair (Testing went red), tell the build stage EXACTLY what failed.
        const repairBlock = (wi.repairAttempts || 0) > 0 && wi.tests?.verdict === 'red'
            ? `\nREPAIR — Testing failed your previous attempt (repair ${wi.repairAttempts}/${MAX_REPAIR_ATTEMPTS}). FIX these specific failures, don't rebuild from scratch:\n${wi.tests.functional?.details || 'see testing output'}\n`
            : '';
        switch (stage) {
            case 'triage':
                return `Classify this request:\n"""${wi.origin.rawRequest}"""\n${clarifyBlock}Ground briefly in the codebase, then output the triage JSON (kind/surface/complexity/risk/rationale) — or a needsInput clarify request if the type is genuinely ambiguous.`;
            case 'research':
                return `Ambiguous/open-ended request:\n"""${wi.origin.rawRequest}"""\nTriage: ${J(wi.triage)}\n${clarifyBlock}Investigate and propose 2-3 approaches with trade-offs + a recommendation. Output the JSON.`;
            case 'prd':
                return `Feature request:\n"""${wi.origin.rawRequest}"""\nTriage: ${J(wi.triage)}\n${lineage}${clarifyBlock}Establish the feature lineage (feature.search/history), ground it in the codebase, and produce the PRD JSON (or a needsInput clarify request).`;
            case 'ux':
                return `PRD:\n${J(wi.prd)}\n${clarifyBlock}Produce the design spec JSON (conform to the existing design system).`;
            case 'fix':
                return `${sandboxLine}\nBug/chore: """${wi.origin.rawRequest}"""\nTriage: ${J(wi.triage)}\n${lineage}${repairBlock}${clarifyBlock}Find the ROOT CAUSE, make the MINIMAL fix + a regression test, don't gold-plate, self-verify with sandbox.run, then output: {"diffSummary":string,"filesTouched":string[],"rootCause":string}.`;
            case 'dev':
                return `${sandboxLine}\nPRD:\n${J(wi.prd)}\nDesign:\n${J(wi.design ?? 'n/a')}\n${lineage}${repairBlock}${clarifyBlock}Implement the acceptance criteria in the sandbox, reuse existing conventions/components, build on the latest state of this feature (don't re-implement or contradict prior changes), self-verify with sandbox.run, then output the DevResult JSON.`;
            case 'testing':
                return `${sandboxLine}\nSurface: ${wi.triage?.surface || 'be'} · Kind: ${wi.triage?.kind || 'change'} · Risk: ${(wi.triage?.risk || ['standard']).join(',')} · Files: ${(wi.dev?.filesTouched || []).join(', ') || '(see sandbox)'}\nChanges summary: ${wi.dev?.diffSummary || '(see sandbox)'}\nVerify what THIS change dictates: typecheck (testing.verify), then RUN the dev's new/related test(s) with sandbox.run (a test that isn't executed proves nothing), and exercise the affected behaviour — API/DB/query/cache as applicable.${(wi.triage?.surface === 'fe' || wi.triage?.surface === 'cross') ? ` This is a FRONTEND change — ALSO run testing.browserSession ONCE (previewUrl is auto-provided${wi.preview?.url ? `: ${wi.preview.url}` : ''}) against the affected route(s).` : ''}\nName exactly what you verified in the summary, then output the verdict JSON.`;
            case 'deploy':
                return `Changes verified green. Branch: ${wi.dev?.branch}. Diff summary: ${wi.dev?.diffSummary}. Prepare the PR with deploy.openPr (body = an evidence pack: problem, acceptance criteria, files touched, test verdict). Output the PR JSON.`;
            case 'analytics':
                return `Feature:\n${J(wi.prd)}\n${clarifyBlock}Define the success metric + events to instrument. Output the JSON.`;
            case 'gtm':
                return `Feature shipped:\n${J(wi.prd)}\n${clarifyBlock}Draft launch copy + channels. Output the JSON.`;
            case 'infra_plan': {
                const devNeed = wi.dev?.infraNeed?.required
                    ? `\nThis infra work was DICTATED BY THE DEV/FIX stage for the change already on branch ${wi.dev?.branch || '(this branch)'}:\n- need: ${wi.dev?.infraNeed?.summary}\n- kinds: ${(wi.dev?.infraNeed?.kinds || []).join(', ')}\nCode changes: ${wi.dev?.diffSummary || '(see the branch)'}\nPlan the infra that makes THAT change work — plan ONLY what those code changes require, nothing extra.\n`
                    : '';
                return `${sandboxLine}\nInfra / DevOps / DevSecOps planning.${devNeed}${devNeed ? '' : `\nStandalone request:\n"""${wi.origin.rawRequest}"""\nTriage: ${J(wi.triage)}`}\n${clarifyBlock}Reason from first principles: what actually changes (DB column/migration, provisioning, config/scaling param, IAM, security), the BLAST RADIUS, a concrete ROLLBACK plan, and cost impact. For a data change, state whether it is backward-compatible (expand→migrate→contract). Output the infra plan JSON (or a needsInput clarify request).`;
            }
            case 'infra_change':
                return `${sandboxLine}\nApproved infra plan:\n${J(wi.infra)}\n${wi.dev?.infraNeed?.required ? `This ADDS to the code change already on this branch (${wi.dev?.diffSummary || 'see branch'}) — do not remove it.\n` : ''}${repairBlock}${clarifyBlock}Make the change AS REVIEWABLE CODE in the sandbox — migration/IaC/config edits plus a committed ROLLBACK. NEVER mutate prod directly. For a data migration use expand→migrate→contract and keep it backward-compatible. Run migration.dryRun and security.scanSecrets to self-verify, then output: {"diffSummary":string,"filesTouched":string[],"rollback":string}.`;
            case 'infra_verify':
                return `${sandboxLine}\nInfra change: ${wi.dev?.diffSummary || '(see sandbox)'}\nIndependently verify (a SEPARATE check, §8): run security.scanDeps, security.scanSecrets and migration.dryRun. Confirm the change is reversible, has a rollback, and causes no data loss. Output the verdict JSON {"verdict":"green"|"red","summary":string,"failures":string}.`;
            case 'infra_apply':
                return `Infra change verified green. Branch: ${wi.dev?.branch}. Plan: ${wi.infra?.change}. Rollback: ${wi.infra?.rollbackPlan}. Prepare the PR with deploy.openPr (body = evidence pack: change, blast radius, rollback, dry-run + scan results). Output the PR JSON.`;
        }
    }

    private sliceFor(stage: Stage, a: any, wi: WorkItem): Partial<WorkItem> {
        switch (stage) {
            case 'triage': {
                const slice: Partial<WorkItem> = { triage: { kind: a.kind, surface: a.surface, complexity: a.complexity, risk: Array.isArray(a.risk) ? a.risk : (a.risk ? [a.risk] : ['standard']), rationale: a.rationale || '' } };
                // Multi-repo routing: Triage picks which repo the change lands in. Honour it only in git mode
                // (the deployment's default target is itself a catalog repo) — in CLI local-worktree mode the
                // target is a filesystem path and must not be rewritten. All later stages clone/PR this repo.
                if (a.targetRepo && REPO_NAMES.has(String(a.targetRepo)) && REPO_NAMES.has(this.deps.targetRepo)) slice.targetRepo = String(a.targetRepo);
                return slice;
            }
            case 'research': return { research: a };
            case 'prd': return { prd: a as Prd };
            case 'ux': return { design: a as DesignSpec };
            case 'infra_plan': return { infra: { ...(wi.infra || {}), change: a.change, blastRadius: a.blastRadius, rollbackPlan: a.rollbackPlan || a.rollback, costImpact: a.costImpact, acceptanceCriteria: Array.isArray(a.acceptanceCriteria) ? a.acceptanceCriteria : [], isDataChange: !!a.isDataChange } };
            case 'fix':
            case 'dev':
            case 'infra_change': {
                // Fix + Dev + Infra-change all produce the reviewable change → stored on `dev` so Verify/Apply/diff
                // read one place. Dev-dictated infra ADDS to the existing branch, so we keep the dev summary and
                // append the infra summary (both commits are on the branch; the diff reflects everything).
                const merged: DevResult = { ...(wi.dev || ({} as DevResult)), ...(a as Partial<DevResult>), workerRunId: wi.sandbox?.sandboxId || wi.dev?.workerRunId || '', worktree: wi.sandbox?.worktree || wi.dev?.worktree || '', branch: a?.branch || wi.sandbox?.branch || wi.dev?.branch || '' };
                if (stage === 'infra_change' && wi.dev?.diffSummary && a?.diffSummary && !wi.dev.diffSummary.includes(a.diffSummary)) {
                    merged.diffSummary = `${wi.dev.diffSummary}\n+ infra: ${a.diffSummary}`;
                    merged.filesTouched = Array.from(new Set([...(wi.dev.filesTouched || []), ...(a.filesTouched || [])]));
                    merged.infraNeed = wi.dev.infraNeed; // preserve the dev-declared need through the infra slice
                }
                return { dev: merged };
            }
            case 'testing':
            case 'infra_verify': {
                const verdict = (a.verdict === 'green' ? 'green' : 'red') as TestReport['verdict'];
                const report: TestReport = { functional: { passed: verdict === 'green' ? 1 : 0, failed: verdict === 'green' ? 0 : 1, details: a.summary || a.failures }, visual: { diffRefs: [], regressions: 0 }, lighthouse: {}, verdict, attempts: wi.repairAttempts || 0 };
                return { tests: report };
            }
            case 'deploy':
            case 'infra_apply':
                // The agent only writes the PR body — the supervisor opens the PR deterministically in
                // applyAndRoute and records the REAL url (the agent must never fabricate a PR link).
                return { deploy: { ...(wi.deploy || ({} as DeployRecord)) } };
            case 'analytics': return { analytics: a as AnalyticsSpec };
            case 'gtm': return { gtm: a as GtmPlan };
        }
    }

    private recordApproval(stage: Stage, wi: WorkItem, by: string): Partial<WorkItem> {
        switch (stage) {
            case 'prd': return { prd: { ...(wi.prd as Prd), approvedBy: by } };
            case 'ux': return { design: { ...(wi.design as DesignSpec), approvedBy: by } };
            case 'deploy': return { deploy: { ...(wi.deploy as DeployRecord), approvedBy: by } };
            case 'analytics': return { analytics: { ...(wi.analytics as AnalyticsSpec), approvedBy: by } };
            case 'gtm': return { gtm: { ...(wi.gtm as GtmPlan), approvedBy: by } };
            case 'infra_plan': return { infra: { ...(wi.infra || {}), approvedBy: by } };
            case 'infra_apply': return { deploy: { ...(wi.deploy as DeployRecord), approvedBy: by } };
            default: return {};
        }
    }

    // Post-approval deploy (only when auto-merge enabled): merge → trigger → watch → post-deploy → rollback.
    // Is this a UI change whose Testing stage benefits from a real running preview?
    private isUiItem(wi: WorkItem): boolean {
        return wi.triage?.surface === 'fe' || wi.triage?.surface === 'cross' || (!!wi.prd?.designNeed && wi.prd.designNeed !== 'none');
    }
    // Deploy an ephemeral preview for the testing browser session (no-op unless a PreviewDeployPort is wired +
    // AIDLC_PREVIEW_DEPLOY=1 + the item is a UI change on a pushed branch). Stores the URL on the work item.
    private async maybePreviewDeploy(wi: WorkItem, tracer?: Tracer): Promise<WorkItem> {
        const port = this.portsFor(wi).previewDeploy;
        const branch = wi.dev?.branch;
        if (!port || !branch || !this.isUiItem(wi) || wi.preview?.url) return wi;
        try {
            const { url, ref } = await port.deploy(this.repoOf(wi), branch, wi.id);
            if (!url) return wi;
            tracer?.emit({ type: 'deploy.triggered', level: 'info', actor: 'orchestrator', stage: 'testing', payload: { preview: true, url } });
            return this.deps.store.update(wi.id, { preview: { url, ref } });
        } catch { return wi; }
    }
    // Tear the preview down once Testing is done with it (freed on both green and red; a repair redeploys).
    private async teardownPreview(wi: WorkItem): Promise<void> {
        const ref = wi.preview?.ref;
        if (!ref) return;
        const port = this.portsFor(wi).previewDeploy;
        if (port) await port.teardown(ref).catch(() => undefined);
        await this.deps.store.update(wi.id, { preview: null }).catch(() => undefined);
    }

    private async runDeploySequence(workItemId: string): Promise<void> {
        const wi = await this.must(workItemId);
        const ports = this.portsFor(wi);
        const pr = wi.deploy?.prUrl || 'pr-ready://local';
        const merged = await ports.deploy.merge(pr);
        if (!merged.merged) { await this.deps.store.update(workItemId, { deploy: { ...(wi.deploy as DeployRecord), mergedBy: 'merge-skipped' } }); return; }
        const dep = await ports.deploy.trigger(pr);
        // Honest post-deploy gate: watch the merge commit's CI. Unhealthy → open a revert PR (auto-rollback).
        const health = await ports.deploy.watch(dep.deployRef);
        const ok = health.healthy;
        const rb = ok ? { rolledBack: false } : await ports.deploy.rollback(dep.deployRef);
        await this.deps.store.update(workItemId, { deploy: { ...(wi.deploy as DeployRecord), mergedBy: 'aidlc', deployRef: dep.deployRef, postDeploy: { verdict: ok ? 'green' : 'red', logsRef: health.logsRef }, rolledBack: rb.rolledBack } });
    }

    private async toNextStage(wi: WorkItem, from: Stage): Promise<WorkItem> {
        const edge = this.dag.find((e) => e.from === from && (!e.when || e.when(wi)));
        if (!edge) {
            const done = await this.deps.store.update(wi.id, { status: { stage: from, state: 'passed' } });
            await this.cleanup(done);
            return done;
        }
        return this.deps.store.update(wi.id, { status: { stage: edge.to, state: 'pending' } });
    }

    private makeGate(wi: WorkItem, stage: Stage): Gate {
        const kind: Gate['kind'] =
            stage === 'deploy' || stage === 'infra_apply' ? 'pr_approval'
            : stage === 'ux' ? 'design_approval'
            : stage === 'prd' ? 'prd_approval'
            : stage === 'analytics' ? 'metrics_approval'
            : stage === 'infra_plan' ? 'infra_plan_approval'
            : 'gtm_approval';
        const summary = (stage === 'deploy' || stage === 'infra_apply') ? `PR ready for "${wi.title}"` : `${stage.toUpperCase()} ready for "${wi.title}"`;
        return { workItemId: wi.id, stage, kind, summary, createdAt: new Date().toISOString() };
    }

    // The honest post-approval hold: the PR is OPEN and awaiting a human merge on GitHub (auto-merge OFF).
    // Deploy is NOT green and GTM does NOT run until the human confirms the merge/deploy actually happened.
    private makeMergeGate(wi: WorkItem, stage: Stage): Gate {
        const pr = wi.deploy?.prUrl;
        const summary = pr
            ? `PR opened for "${wi.title}" — review + MERGE it on GitHub, then confirm here. Nothing is deployed and GTM does not run until you do. ${pr}`
            : `PR opened for "${wi.title}" — merge + deploy it, then confirm here. Nothing is deployed until you do.`;
        return { workItemId: wi.id, stage, kind: 'merge_confirmation', summary, createdAt: new Date().toISOString() };
    }

    // HOLD a stage at a coverage gate: its output dropped one or more REQUIRED instructions. The human either
    // re-runs the stage (approve) or defers specific requirements (deferRequirement); nothing advances until
    // every must-have is met or explicitly deferred. This is the structural guarantee of instruction-following.
    private async enterCoverageGate(wi: WorkItem, stage: Stage, coverage: CoverageReport, tracer?: Tracer): Promise<WorkItem> {
        const unmetTexts = coverage.unmet.map((id) => wi.requirements?.find((r) => r.id === id)?.text || id);
        const summary = `${stage.toUpperCase()} did not cover ${coverage.unmet.length} required instruction(s): ${unmetTexts.join(' | ')}`;
        const gate: Gate = { workItemId: wi.id, stage, kind: 'coverage_review', summary, createdAt: new Date().toISOString() };
        this.emit({ type: 'gate_open', stage, workItemId: wi.id, gate });
        tracer?.emit(ev.gateOpened(stage, 'coverage_review', summary));
        return this.deps.store.update(wi.id, { gate, status: { stage, state: 'awaiting_gate' } });
    }

    // Done = passed with no outgoing edge whose guard is satisfied (must match toNextStage's edge pick,
    // else a stage with only an un-taken conditional edge — e.g. green testing in a DAG without a
    // testing→deploy edge — would loop and re-run).
    private isDone(wi: WorkItem): boolean {
        return wi.status.state === 'passed' && !this.dag.some((e) => e.from === wi.status.stage && (!e.when || e.when(wi)));
    }

    private async cleanup(wi: WorkItem): Promise<void> {
        // On successful completion, append this work item to its feature's chronological chain (deduped by
        // workItemId, so repeat cleanup calls are safe). This is what later change requests read as lineage.
        if (wi.featureId && wi.status.state === 'passed') {
            await this.feature().recordChange(wi.featureId, {
                workItemId: wi.id,
                title: wi.title,
                problem: wi.prd?.problem,
                acceptanceCriteria: wi.prd?.acceptanceCriteria,
                prUrl: wi.deploy?.prUrl,
                riskTier: wi.prd?.riskTier,
                at: new Date().toISOString(),
            }).catch(() => undefined);
        }
        if (wi.sandbox) {
            const ports = this.deps.portsFactory(this.repoOf(wi));
            ports.sandbox.adopt?.(wi.sandbox);
            await ports.sandbox.teardown(wi.sandbox.sandboxId).catch(() => undefined);
        }
    }

    private async must(id: string): Promise<WorkItem> {
        const wi = await this.deps.store.get(id);
        if (!wi) throw new Error(`work item not found: ${id}`);
        return wi;
    }

    private emit(e: AidlcEvent): void { this.deps.onEvent?.(e); }
}
