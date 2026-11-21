// AIDLC orchestration vocabulary — the contracts the supervisor, stage-agents, workers and stores
// share. Mirrors the single-agent `../types.ts` style: contracts only, no external systems, no import
// cycles. See AIDLC-DESIGN.md. Nothing here is implemented yet — these are the shapes to review.

import type { AgentConfig, Model, ServicePorts, DecisionLog, Msg } from '../types';
import type { PendingProposal } from '../stores';

// ── Stages ──────────────────────────────────────────────────────────────────
// The SDLC stages. The pipeline is ADAPTIVE: Triage classifies the work item, then the supervisor picks a
// DAG by kind (see AIDLC-SDLC-COVERAGE.md §2). UX is conditional (designNeed==='new-design'). Heavy stages
// (ux, dev, fix, testing) run on ephemeral Cloud Run Jobs. 'triage' is the cheap classifier that runs first;
// 'fix' is a light Dev for bugs; 'research' investigates an ambiguous/spike ask.
export type Stage =
    | 'triage' | 'research'
    | 'prd' | 'ux' | 'dev' | 'fix' | 'testing' | 'deploy' | 'analytics' | 'gtm'
    // Infra / DevOps / DevSecOps pipeline (for kind=infra|data-migration). Writes migration/IaC/config +
    // rollback into a reviewed PR and validates it (dry-run + security scans); never mutates prod directly.
    | 'infra_plan' | 'infra_change' | 'infra_verify' | 'infra_apply';

export const HEAVY_STAGES: readonly Stage[] = ['ux', 'dev', 'fix', 'testing', 'infra_change', 'infra_verify'] as const;

// ── Work-item classification (set by Triage; drives the adaptive DAG) ────────
export type WorkKind = 'bug' | 'feature' | 'change' | 'chore' | 'infra' | 'data-migration' | 'spike';
export type WorkSurface = 'fe' | 'be' | 'infra' | 'data' | 'cross';
export type WorkComplexity = 'trivial' | 'small' | 'standard' | 'large';
export type WorkRisk = 'standard' | 'money' | 'security' | 'migration';
export interface Triage {
    kind: WorkKind;
    surface: WorkSurface;
    complexity: WorkComplexity;
    risk: WorkRisk[];
    rationale: string;            // first-principles: why this classification (surfaced to the human)
    approvedBy?: string;
}

// Lifecycle of a single stage within a work item.
export type StageState =
    | 'pending'        // not started
    | 'running'        // stage-agent is executing (locally or on a worker)
    | 'dispatched'     // a heavy stage was handed to a Cloud Run Job; awaiting the Pub/Sub completion
    | 'awaiting_input' // paused for a human answer to the agent's clarifying questions (ask.user)
    | 'awaiting_gate'  // paused for a human decision (reuses PendingProposal)
    | 'passed'         // stage done, output written to the work item
    | 'failed'         // stage failed its verifier (e.g. testing red) — may route back per the DAG
    | 'skipped';       // conditionally skipped (e.g. UX when no new design needed)

export type DesignNeed = 'none' | 'reuse-existing' | 'new-component-in-system' | 'new-design';

// ── Per-stage output artifacts (accumulate on the work item) ────────────────
export interface Prd {
    problem: string;
    acceptanceCriteria: string[];
    outOfScope: string[];
    designNeed: DesignNeed;       // drives the conditional UX branch
    affectedSurfaces?: string[];  // e.g. ['fe:app/[username]', 'be:api/feedback']
    riskTier?: 'standard' | 'money'; // 'money' → mandatory characterization test + fail-closed verifier
    // Analytics is defined HERE (and implemented in Dev, verified in Testing) — not a separate stage.
    successMetric?: string;
    trackingEvents?: Array<{ name: string; props?: string[]; where?: string }>;
    approvedBy?: string;
}

export interface DesignSpec {
    spec: string;
    stitchRef?: string;           // handle to the Stitch design artifact (GCS)
    componentsUsed: string[];     // existing design-system components to reuse
    newComponents: string[];      // new components to create (must conform to the system)
    approvedBy?: string;
}

export interface DevResult {
    workerRunId: string;
    worktree: string;             // ephemeral git worktree path (on the worker)
    branch: string;
    diffSummary: string;
    filesTouched: string[];
    diff?: string;                // the actual unified diff (truncated) — powers the run page "Changes" tab
    planRef?: string;             // GCS ref to the implementation plan
    // Dev/Fix DICTATE infra: from first principles, does this change need DB schema/migration, provisioning,
    // a config/scaling param, or an IAM/security change? If required, the pipeline runs the Infra sub-flow
    // (plan→change→verify) on THIS branch before testing. Optional — most changes set required=false.
    infraNeed?: { required: boolean; kinds: Array<'schema' | 'migration' | 'provisioning' | 'config' | 'iam' | 'security'>; summary: string };
}

export type Viewport = 'mobile' | 'tablet' | 'desktop';

export interface TestReport {
    functional: { passed: number; failed: number; details?: string };
    visual: { baselineRef?: string; diffRefs: string[]; regressions: number };
    lighthouse: Partial<Record<Viewport, { performance: number; accessibility: number; bestPractices: number }>>;
    verdict: 'green' | 'red';     // fail-closed: red routes back to Dev
    attempts: number;             // self-repair iterations so far
}

export interface DeployRecord {
    prUrl: string;
    reviewers?: string[];
    approvedBy?: string;
    mergedBy?: string;            // 'aidlc' after gated auto-merge; the human's id after a merge confirmation
    mergedAt?: string;            // when the merge/deploy was confirmed (honest: Deploy isn't green until this)
    deployRef?: string;           // Cloud Run revision / CI run id
    postDeploy?: { verdict: 'green' | 'red'; details?: string; logsRef?: string };
    rolledBack?: boolean;
}

export interface AnalyticsSpec {
    events: Array<{ name: string; props?: string[]; where?: string }>;
    successMetric: string;
    approvedBy?: string;
}

export interface GtmPlan {
    assets: Array<{ kind: string; ref?: string }>;
    channels: string[];
    adoption?: { metric: string; value?: number };
    approvedBy?: string;
}

// ── Feature ledger — the chronological change-request chain per product area ─────────────────────────
// A feature/product area evolves across MANY work items. The live code is the current implementation
// (the Dev agent reads it from the clone), but the INTENT/DECISION lineage — what was asked, in what
// order, what superseded what — is not in the code. The Feature ledger captures that chain so a new
// change request builds on the latest reconciled state instead of stale/independent context.
export interface FeatureChange {
    workItemId: string;
    title: string;
    problem?: string;
    acceptanceCriteria?: string[];
    prUrl?: string;
    riskTier?: string;
    at: string;                   // when this change entered the feature's history (chronological key)
}
export interface Feature {
    id: string;                   // stable kebab-case key, e.g. 'host-settlement'
    name: string;
    summary: string;              // reconciled current description (latest decisions win)
    paths: string[];              // code surfaces this feature spans
    changes: FeatureChange[];     // the chronological change-request chain (append-only, oldest→newest)
    createdAt: string;
    updatedAt: string;
}

// The capability stage-agents use to establish + extend a feature's lineage. Backed by Arango in prod;
// a no-op in the CLI. The PRD agent uses search+history to avoid building on stale/forked context.
export interface FeaturePort {
    search(query: string): Promise<Array<{ id: string; name: string; summary: string; paths: string[]; changeCount: number; lastChangeAt?: string }>>;
    history(featureId: string): Promise<Feature | null>;
    upsert(f: { id: string; name: string; summary?: string; paths?: string[] }): Promise<Feature>;
    recordChange(featureId: string, change: FeatureChange): Promise<void>;
}

// ── The Work Item — the spine: handoff contract + pipeline memory + audit trail ──
export interface WorkItemStatus {
    stage: Stage;
    state: StageState;
}

export interface WorkItem {
    id: string;
    title: string;
    status: WorkItemStatus;
    createdAt: string;
    updatedAt: string;
    targetRepo?: string;          // owner/name the Dev stage sandboxes (default: the orchestrator's target)
    featureId?: string;           // the feature/product area this change request targets (lineage key)
    triage?: Triage;              // classification (kind/surface/complexity/risk) → selects the adaptive DAG
    research?: { findings?: string; assumptions?: string[]; approaches?: Array<{ name: string; pros: string; cons: string }>; recommendation?: string }; // spike output
    attachments?: Attachment[];   // multimodal inputs on the submit (screenshots/mockups/PDFs the agent sees)
    conversation?: ConvMsg[];     // free-form human↔agent messages at any stage (conversation-at-stage)
    infra?: { change?: string; blastRadius?: string; rollbackPlan?: string; costImpact?: string; acceptanceCriteria?: string[]; isDataChange?: boolean; approvedBy?: string }; // infra_plan output
    origin: { requester: string; channel: string; rawRequest: string };
    // Accumulating per-stage artifacts (undefined until that stage runs).
    prd?: Prd;
    design?: DesignSpec;
    dev?: DevResult;
    tests?: TestReport;
    deploy?: DeployRecord;
    analytics?: AnalyticsSpec;
    gtm?: GtmPlan;
    // Cost/telemetry + large-artifact refs.
    trace: { perStageCost: Partial<Record<Stage, number>>; decisionsRef?: string };
    artifacts: { gcsRefs: string[] };
    budget?: { ceilingTokens?: number; spentTokens?: number };
    // ── Durable orchestration state (was in-memory Maps in the v1 Supervisor; moved onto the doc so the
    // pipeline is resumable and works across the worker/orchestrator process boundary). ──
    gate?: Gate | null;             // the open human gate, if the item is awaiting_gate
    repairAttempts?: number;        // testing→dev self-repair count (cap MAX_REPAIR_ATTEMPTS)
    sandbox?: SandboxInfo | null;   // the Dev stage's sandbox (worktree locally / clone on the worker)
    questions?: ClarifyRound[];     // human-in-the-loop clarify Q&A (ask.user → awaiting_input → answers)
    dispatch?: { stage: Stage; jobName?: string; execution?: string; taskName?: string; at: string; attempts?: number } | null; // in-flight heavy-stage dispatch
    // Per-stage QUALITY scores (the metric) — a separate critic grades each stage's output against a rubric;
    // shown to the human at the gate. Inlined (not imported) to avoid a types↔quality cycle.
    quality?: Record<string, { score: number; bar: number; pass: boolean; criteria: Array<{ name: string; score: number; feedback: string }>; strengths?: string; weaknesses?: string; improvements?: string[]; revision?: number }>;
    // Money-path fail-closed verifier result (characterization test + revenueShare==1.0 + flagged), when run.
    verifier?: { pass: boolean; findings: string[]; at: string } | null;
    // ── Instruction adherence — the enumerated requirements extracted from the request + PRD + EVERY human
    // message, and the fail-closed coverage check that forbids a stage from passing while any must-have is
    // unmet or SILENTLY dropped. "Deferred" is only valid with a human approver (never the agent's choice).
    requirements?: Requirement[];
    coverage?: Record<string, CoverageReport>; // keyed by stage: the last coverage check for that stage
    preview?: { url?: string; ref?: string } | null; // ephemeral preview-deploy for the Testing browser session
    workflow?: WorkflowOverrides;   // per-item authoring: tweak the adaptive flow without forking the DAG
}

// Workflow authoring — bounded, declarative overrides a human sets at submit (or an org/repo default) to
// customise the pipeline WITHOUT forking the DAG: force a design pass, skip GTM, treat a change as money-tier,
// or auto-approve named gates for an unattended run. The DAG guards + supervisor consult these.
export interface WorkflowOverrides {
    requireUx?: boolean;           // run the UX stage even if the PRD said reuse-existing
    skipGtm?: boolean;             // end at Deploy even for features/changes
    forceMoneyTier?: boolean;      // treat as a money path (max bar + money verifier) regardless of detection
    requireInfra?: boolean;        // force the infra sub-flow even if the builder didn't ask for it
    autoApproveStages?: Stage[];   // gates to auto-approve for THIS item (overrides the global config list)
}

export type RequirementSource = 'request' | 'prd' | 'conversation' | 'clarification';
export interface Requirement {
    id: string;                   // stable, e.g. 'R1'
    text: string;                 // the atomic instruction, in the human's intent
    source: RequirementSource;
    mustHave: boolean;            // true = blocks the gate until met/approved-deferred; false = nice-to-have
    at: string;                   // when it entered the ledger (so new human messages are visibly new reqs)
    // Human-approved deferral: the ONLY way a must-have requirement may be left unmet. Never set by the agent.
    deferral?: { approvedBy: string; reason: string; at: string };
}
export type CoverageStatus = 'met' | 'partial' | 'missing' | 'deferred';
export interface CoverageItem {
    reqId: string;
    status: CoverageStatus;
    evidence: string;             // where/how it was addressed (file, criterion, diff hunk) — or why not
}
export interface CoverageReport {
    stage: Stage;
    pass: boolean;                // false if any must-have is missing/partial (and not an approved deferral)
    items: CoverageItem[];
    unmet: string[];              // reqIds that block (missing/partial must-haves without an approved deferral)
    at: string;
    revision?: number;
}

// A multimodal attachment the human adds (screenshot of a bug, a design mockup, a spec PDF). Stored in GCS;
// passed to the stage-agent as a file part so it can actually SEE/READ it.
export interface Attachment {
    name: string;
    mimeType: string;
    gcsRef: string;              // gs:// URI the model reads directly
    url: string;                 // a viewable (signed) URL for the run page
    kind: 'image' | 'pdf' | 'doc' | 'other';
}

// A free-form conversation turn (human ↔ agent) at a stage — "conversation at each stage". The human can
// redirect/add context any time the item is paused; the message is injected into the stage and it re-plans.
export interface ConvMsg {
    role: 'user' | 'agent';
    stage?: Stage;
    text: string;
    attachments?: Attachment[];
    at: string;
    by?: string;
}

// A round of agent→human clarifying questions (HITL). The item parks in `awaiting_input` until answered.
export interface ClarifyRound {
    stage: Stage;
    askedAt: string;
    questions: string[];
    answers?: string[];
    answeredAt?: string;
    answeredBy?: string;
}

// ── DAG ─────────────────────────────────────────────────────────────────────
// The pipeline graph: from a stage, which stage(s) can follow and under what condition.
export interface DagEdge {
    from: Stage;
    to: Stage;
    /** Guard — evaluated against the current work item to decide if this edge is taken.
     *  e.g. UX edge: wi.prd?.designNeed === 'new-design'. Testing→Dev: wi.tests?.verdict === 'red'. */
    when?: (wi: WorkItem) => boolean;
    kind?: 'next' | 'conditional' | 'repair';   // repair = Testing→Dev self-heal loop
}

export type Dag = DagEdge[];

// ── Human gates ──────────────────────────────────────────────────────────────
// A stage can pause for a human decision. We reuse the loop's PendingProposal mechanism; a Gate wraps
// it with the work-item + stage context the UI needs to render the approval.
export interface Gate {
    workItemId: string;
    stage: Stage;
    // 'merge_confirmation' holds AFTER a PR is approved+opened when auto-merge is OFF (the safe default):
    // the PR is open and awaiting a human MERGE on GitHub, so Deploy is NOT "done" and GTM must not run yet.
    // Approving this gate = "I merged + deployed it" → Deploy goes green, the pipeline continues.
    kind: 'prd_approval' | 'design_approval' | 'metrics_approval' | 'gtm_approval' | 'pr_approval' | 'infra_plan_approval' | 'coverage_review' | 'merge_confirmation';
    summary: string;
    pending?: PendingProposal;    // present when the gate originated from a propose-tier tool
    createdAt: string;
}

export type GateDecision = 'approve' | 'reject';

// ── Stage run (one execution of one stage) ──────────────────────────────────
export interface StageRun {
    workItemId: string;
    stage: Stage;
    runId: string;                // ties to the loop's trace + decision log
    worker?: { jobName: string; execution: string };  // set when dispatched to a Cloud Run Job
    startedAt: string;
    finishedAt?: string;
    state: StageState;
    costTokens?: number;
}

// ── New service ports for the AIDLC tools ────────────────────────────────────
// The stage tools need capabilities beyond the single-agent ServicePorts. The backend adapter will
// implement this SUPERSET; stage tools cast ctx.ports to AidlcServicePorts. (Contracts only here.)
export interface CodePort {
    search(query: string, k?: number): Promise<Array<{ path: string; snippet: string; score: number }>>;
    read(path: string): Promise<string>;
    designSystemLookup(query: string): Promise<Array<{ component: string; path: string; usage: string }>>;
}

export interface SandboxInfo { sandboxId: string; worktree: string; branch: string; repoRoot: string }
export interface SandboxPort {
    create(workItemId: string, repoRoot: string, baseBranch: string): Promise<SandboxInfo>;
    readFile(sandboxId: string, path: string): Promise<string>;
    writeFile(sandboxId: string, path: string, content: string): Promise<{ ok: boolean }>;
    listDir(sandboxId: string, path: string): Promise<string[]>;
    run(sandboxId: string, cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    diff(sandboxId: string): Promise<string>;
    teardown(sandboxId: string): Promise<void>;
    /** Rehydrate a sandbox descriptor the supervisor persisted on the work item (cross-process resume). */
    adopt?(info: SandboxInfo): void;
    /** Commit staged changes and push the work branch to origin (git-backed ports only; local ports no-op). */
    commitAndPush?(sandboxId: string, message: string): Promise<{ branch: string; pushed: boolean }>;
}

export interface TestingPort {
    // v1: run the project's build/typecheck gate in the sandbox and return a verdict. Playwright
    // multi-viewport + visual-diff + Lighthouse plug in here as the backbone matures (same TestReport).
    verify(sandboxId: string, commands?: string[]): Promise<TestReport>;
    playwright?(sandboxId: string, viewports: Viewport[], journeys?: string[]): Promise<Partial<TestReport>>;
    lighthouse?(sandboxId: string, viewports: Viewport[]): Promise<TestReport['lighthouse']>;
}

export interface DeployPort {
    openPr(branch: string, body: string): Promise<{ prUrl: string }>;
    merge(prUrl: string): Promise<{ merged: boolean }>;
    trigger(prUrl: string): Promise<{ deployRef: string }>;
    watch(deployRef: string): Promise<{ healthy: boolean; logsRef?: string }>;
    rollback(deployRef: string): Promise<{ rolledBack: boolean }>;
}

// Ephemeral per-branch preview deploy: stands up a throwaway environment for a branch so the Testing stage's
// browser session runs against a REAL running app, then tears it down. Optional + flag-gated — when absent or
// disabled, Testing falls back to AIDLC_PREVIEW_URL (or skips the browser session). Self-contained (clones the
// branch itself), so it works regardless of where Testing runs.
export interface PreviewDeployPort {
    deploy(repoFullName: string, branch: string, workItemId: string): Promise<{ url: string; ref: string }>;
    teardown(ref: string): Promise<{ torndown: boolean }>;
}

// Read-only diagnostics so the Fix/Research stages can ROOT-CAUSE a production bug from live sources — not
// just the code + what the human pasted. STRICTLY read-only + flag-gated (AIDLC_DIAGNOSTICS=1) + each source
// needs its own credentials; off by default. Never mutates anything. Enabling it reads prod data (PII) — a
// platform-owner decision (constitution §9). Returns compact, capped results (never dumps raw prod data).
export interface DiagnosticsPort {
    enabled(): boolean;
    queryLogs(opts: { filter?: string; severity?: string; sinceMinutes?: number; limit?: number }): Promise<{ available: boolean; entries: Array<{ ts?: string; severity?: string; text: string }>; note?: string }>;
    queryDb(aql: string, bindVars?: Record<string, unknown>): Promise<{ available: boolean; rows: unknown[]; note?: string }>;
    inspectCache(op: 'get' | 'keys' | 'ttl', key: string): Promise<{ available: boolean; result: unknown; note?: string }>;
    runtimeStatus(service?: string): Promise<{ available: boolean; status: unknown; note?: string }>;
}

export interface DesignPort {   // Stitch
    design(brief: string): Promise<{ stitchRef: string; spec: string }>;
}

export interface AnalyticsPort {
    instrument(events: AnalyticsSpec['events']): Promise<{ wired: number }>;
}

export interface GtmPort {
    draft(brief: string): Promise<{ assets: GtmPlan['assets'] }>;
    outreach(channels: string[], payload: unknown): Promise<{ sent: number }>;
}

export interface WorkItemStore {
    create(wi: Omit<WorkItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<WorkItem>;
    get(id: string): Promise<WorkItem | null>;
    update(id: string, patch: Partial<WorkItem>): Promise<WorkItem>;
    list(filter?: { state?: StageState; stage?: Stage }): Promise<WorkItem[]>;
    /** Paginated + searchable listing for the ops UI. `q` searches title + original request + repo via an
     *  ArangoSearch view (never AQL CONTAINS). Returns the page + the total match count for pagination. */
    search(opts: { q?: string; state?: StageState; stage?: Stage; limit?: number; offset?: number }): Promise<{ items: WorkItem[]; total: number }>;
}

// The superset the AIDLC backend ports adapter implements. ServicePorts (the single-agent ports) stays
// unchanged; AIDLC adds these. Stage tools receive this via ToolContext.ports (cast).
export interface AidlcServicePorts extends ServicePorts {
    code: CodePort;
    sandbox: SandboxPort;
    testing: TestingPort;
    deploy: DeployPort;
    design: DesignPort;
    analyticsWiring: AnalyticsPort;
    gtm: GtmPort;
    previewDeploy?: PreviewDeployPort;  // optional: ephemeral per-branch preview for the Testing browser session
    diagnostics?: DiagnosticsPort;      // optional: read-only live-source investigation for root-causing bugs
    workItems: WorkItemStore;
    feature: FeaturePort;
}

// ── Orchestrator (the supervisor above loop.step) ───────────────────────────
export interface StageDeps {
    model: Model;                 // Gemini by default; swappable per stage
    ports: AidlcServicePorts;
    log: DecisionLog;
    tz?: string;
}

// Resolves the AgentConfig + model + thinking budget for a given stage.
export interface StageRegistry {
    configFor(stage: Stage): AgentConfig;
    modelFor(stage: Stage): Model;
    isHeavy(stage: Stage): boolean;
}

// What an isolated worker publishes back when a dispatched heavy stage finishes.
export interface WorkerResult {
    workItemId: string;
    stage: Stage;
    outcome: 'done' | 'needs_input' | 'error';
    artifact?: any;           // the stage's structured output (on 'done')
    questions?: string[];     // on 'needs_input'
    error?: string;           // on 'error'
    sandbox?: SandboxInfo;    // the worker's clone descriptor (for the record)
    branch?: string;          // pushed work branch (Dev)
    quality?: NonNullable<WorkItem['quality']>[string];  // the worker ran the quality critic for this stage
    coverage?: CoverageReport;                           // instruction-adherence coverage (prd/dev/fix/infra_change)
    verifier?: { pass: boolean; findings: string[] };    // money-path verifier (testing stage)
    costTokens?: number;
}

export interface Orchestrator {
    /** Create a work item from an intake request and start the pipeline. */
    submit(origin: WorkItem['origin'], title: string, targetRepo?: string, attachments?: Attachment[], workflow?: WorkItem['workflow']): Promise<WorkItem>;
    /** Advance a work item: run the current stage (locally or dispatch a worker) and follow DAG edges
     *  until a human gate / clarify / terminal state. Idempotent / resumable. */
    advance(workItemId: string): Promise<WorkItem>;
    /** Resolve an open human gate (PRD/design/metrics/GTM/PR approval) and continue. */
    decideGate(workItemId: string, decision: GateDecision, note?: string, by?: string): Promise<WorkItem>;
    /** Supply human answers to the agent's clarifying questions, then re-run the asking stage. */
    answerClarify(workItemId: string, answers: string[], by?: string): Promise<WorkItem>;
    /** Free-form message to the agent at the current stage (redirect / add context / attach files) → re-plan. */
    message(workItemId: string, text: string, attachments?: Attachment[], by?: string): Promise<WorkItem>;
    /** Revise an EARLIER stage (e.g. change the PRD after Dev ran) and re-run it + its downstream stages —
     *  this is the DAG re-plan: reopen the item at `stage` with the human's note and advance from there. */
    reviseStage(workItemId: string, stage: Stage, text: string, attachments?: Attachment[], by?: string): Promise<WorkItem>;
    /** Human-only: defer a requirement the agent can't/shouldn't meet now (the ONLY way past an unmet
     *  must-have at a coverage gate). Audited; may clear the gate and advance. */
    deferRequirement(workItemId: string, reqId: string, reason: string, by: string): Promise<WorkItem>;
    /** The open gate for a work item, if any (for the UI to render). */
    openGate(workItemId: string): Promise<Gate | null>;
    /** Called (via the Pub/Sub bridge) when a dispatched heavy stage finishes on a worker. */
    onWorkerComplete(result: WorkerResult): Promise<void>;
    /** Watchdog: find dispatched stages whose worker never reported within the timeout and
     *  retry once, then dead-letter (fail) them. Idempotent; safe to call on an interval. */
    sweepStuck(now?: number): Promise<{ retried: string[]; deadLettered: string[] }>;
}
