// Core types for the RÉVE Host Copilot agent substrate. One file so the model
// layer, tools, broker, runtime and evals share one vocabulary with no import
// cycles. Nothing here touches an external system — these are contracts only.

// ── Model layer ───────────────────────────────────────────────────────────────
export type Role = 'user' | 'assistant' | 'tool';

export interface ToolCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
    /** Provider reasoning token (Gemini 3 thought_signature) — must be echoed back
     *  on the functionCall part when continuing the conversation. Opaque elsewhere. */
    thoughtSignature?: string;
}

// One entry in the growing conversation. `assistant` may carry text and/or tool
// calls; `tool` carries the result of one tool call (keyed to its callId).
// A multimodal attachment on a message (screenshot, image, PDF, doc). Passed to the model as a file part.
// Prefer fileUri (a gs:// URI the model reads directly) to avoid shipping base64 through the pipeline.
export interface MsgFile { mimeType: string; fileUri?: string; dataBase64?: string; name?: string }

export interface Msg {
    role: Role;
    text?: string;
    files?: MsgFile[];   // multimodal inputs (images/PDFs) — the model reads them alongside the text
    toolCalls?: ToolCall[];
    toolResult?: { callId: string; name: string; ok: boolean; output: unknown };
    /** ISO timestamp when this message was added. Shown per-message in the UI. Optional
     *  so older/scripted messages without it still type-check; the model layer ignores it. */
    ts?: string;
}

// What one pass through the loop gets back from the model: either words (loop
// ends) or a request for one-or-more tools (loop continues after they run).
export interface ModelTurn {
    text?: string;
    toolCalls?: ToolCall[];
    // Token usage for this one model call, when the adapter can report it (Gemini does via
    // usageMetadata; the scripted test model does not). The loop sums totalTokens across a run
    // to enforce the per-run token budget. Absent = treated as 0 (fail-open on accounting only).
    // The full split (cached / thinking) powers the ops cost console; promptTokens INCLUDES cached.
    usage?: { promptTokens?: number; cachedTokens?: number; thinkingTokens?: number; outputTokens?: number; totalTokens?: number };
}

export type JSONSchema = Record<string, unknown>;

export interface ToolDeclaration {
    name: string;
    description: string;
    parameters: JSONSchema;
}

// The model is a pluggable port. Gemini is one adapter; a scripted model is
// another (used by the deterministic tests). The loop knows only this interface.
// `system` is the STABLE cache-friendly prefix; `context` is the optional volatile per-turn block (time,
// memories) kept out of that prefix. `thinking` tunes reasoning effort per call — 'low' for cheap
// auxiliary calls (title/CRAG/escalation); omit to use the model default for the main loop.
export interface GenerateInput {
    system: string;
    messages: Msg[];
    tools: ToolDeclaration[];
    context?: string;
    thinking?: 'low' | 'medium' | 'high';
    /** Optional telemetry tag. When present, the adapter records a per-call cost/perf row
     *  (agent_calls) for the ops console. Absent (evals/tests) = nothing is recorded. */
    trace?: { runId?: string; userId?: string; agent?: string; phase?: string; turnIndex?: number };
}

// ── Per-LLM-call telemetry (append-only `agent_calls`) ───────────────────────
// One row per model call — the unit the ops cost console attributes spend to. Links to a turn via
// runId + turnIndex, and to the tool(s) it emitted via producedTools. Cost is derived on read.
export interface AgentCall {
    ts: string;
    runId: string | null;
    userId: string | null;
    agent: string | null;
    phase: string;              // agent-step | title | crag-grader | escalation | ...
    turnIndex: number | null;
    model: string;              // e.g. gemini-3.8-flash
    thinkingLevel: string | null;
    maxOutputTokens: number | null;
    toolsExposed: number;       // # function declarations sent on this call
    streamed: boolean;
    promptTokens: number;       // INCLUDES cachedTokens
    cachedTokens: number;
    thinkingTokens: number;
    outputTokens: number;
    totalTokens: number;
    latencyMs: number;          // total wall-clock for the call
    ttftMs: number | null;      // time to first token (streaming only)
    producedTools: string[];    // tool names this call asked for (empty = it replied with words)
    ok: boolean;
}

export interface CallLog {
    append(c: AgentCall): Promise<void>;
}

export interface Model {
    readonly id: string;
    generate(input: GenerateInput): Promise<ModelTurn>;
    /** Optional streaming variant: forwards text deltas via onToken as they arrive, returns the
     *  same ModelTurn as generate(). Used by the SSE endpoint; absent on the scripted test model. */
    generateStream?(input: GenerateInput, onToken: (delta: string) => void): Promise<ModelTurn>;
}

// ── Tools ─────────────────────────────────────────────────────────────────────
// The tier is the governance signal the broker reads:
//   read   → auto-EXECUTE (subject to grant + authorize)
//   write  → auto-EXECUTE (reversible writes)
//   propose→ ALWAYS needs human approval (money / irreversible)
export type Tier = 'read' | 'write' | 'propose';
export type ToolMode = 'live' | 'dry-run';

// A loose, dependency-free observability sink (the AIDLC Tracer implements the strict version and is
// structurally assignable here). Defined in core so the loop + tools can emit without importing the
// orchestrator (which would create a cycle). No-op in the Host Copilot (no sink passed).
export interface AgentEventSink {
    emit(e: {
        type: string;
        level: 'debug' | 'info' | 'warn' | 'error';
        actor: string;
        stage?: string;
        stageRunId?: string;
        payload?: Record<string, any>;
        artifactRefs?: string[];
        workItemId?: string;
    }): void;
}

export interface ToolContext {
    userId: string;   // the authenticated session user — every tool scopes to this
    mode: ToolMode;   // live runs the effect; dry-run must change nothing
    ports: ServicePorts;
    /** Optional model handle for tools that need a SEPARATE model call (e.g. the
     *  knowledge tool's CRAG relevance grader — a different call from the main loop,
     *  so retrieval never grades itself). Absent in pure-config contexts. */
    model?: Model;
    /** AIDLC observability — tools emit domain events (sandbox.command, file.written, …) when present. */
    sink?: AgentEventSink;
    stage?: string;
    stageRunId?: string;
}

export interface ToolResult {
    ok: boolean;
    output: unknown;
    note?: string;
    /** Present only after a live, undoable call. */
    undo?: () => Promise<void>;
}

export interface AuthorizeResult {
    ok: boolean;
    reason?: string;
}

export interface Tool {
    name: string;
    description: string;            // shown to the model
    tier: Tier;
    undoable: boolean;
    parameters: JSONSchema;         // JSON-schema for the model's declaration + ajv validation
    /** Per-user authorization (ownership). A failure becomes a DENY-with-reason. */
    authorize?(args: Record<string, unknown>, ctx: ToolContext): Promise<AuthorizeResult>;
    run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ── Permissions ─────────────────────────────────────────────────────────────
export type DecisionKind = 'EXECUTE' | 'PROPOSE' | 'DENY';
export type GrantVerdict = 'execute' | 'propose' | 'deny';
export type Grant = GrantVerdict | { verdict: GrantVerdict; when?: string };

// ── Agent config — the PDF's "four lists" ───────────────────────────────────
export interface AgentConfig {
    name: string;
    /** Identity + tone for the system prompt. NEVER business rules (those live in tools). */
    persona: string;
    journeys: string[];
    tools: string[];
    grants: Record<string, Grant>;
    // Hard per-run budget. maxTokens caps total model tokens spent in a single step()/resume()
    // run (prompt + output, summed across turns) — a runaway loop or a pathological prompt stops
    // cleanly instead of spending unbounded. 0/undefined = no token cap (turn/tool caps still apply).
    limits: { maxTurns: number; maxToolCalls: number; maxProposals: number; maxTokens?: number };
}

// ── Decision log (append-only) ──────────────────────────────────────────────
export interface Decision {
    ts: string;
    runId: string;
    agent: string;
    userId: string;
    tool: string;
    decision: DecisionKind;
    reason: string;
    tier: Tier | null;
    mode: ToolMode | 'none';
    approved: boolean;
    ok: boolean | null;
    args: Record<string, unknown> | null;
    /** The resource this call touched (e.g. eventId) — for ownership/replay. */
    resourceId: string | null;
}

export interface DecisionLog {
    append(d: Decision): Promise<void>;
    all(): Promise<Decision[]>;
}

// ── Service ports — the seam between tools and the real backend ─────────────
// Tools call these; adapters implement them. The in-memory adapter powers tests
// (zero prod writes); the backend adapter wraps the real services.
export interface EventDraftInput {
    title: string;
    date: string;
    pricePerHead: number;
    venue?: string;
    capacity?: number;
}

export interface EventRecord {
    id: string;
    title: string;
    date: string;
    endDate?: string;         // endDateTime — used to block cancelling an already-ended event
    pricePerHead: number;
    venue?: string;
    capacity?: number;
    hostUserId: string;
    status: 'draft' | 'published';
    deleted?: boolean;        // soft-deleted (status === 'deleted')
    url?: string;
    // Privacy / guest-flow settings — reflected so the agent can confirm edits to them.
    visibility?: 'public' | 'private';
    requiresApproval?: boolean;
    waitlistEnabled?: boolean;
}

export interface CancelResult {
    id: string;
    title: string;
    cancelled: boolean;
}

export interface PayoutStatus {
    active: boolean;
    // Lifecycle of the host's Cashfree payout vendor:
    //   active    → ready to receive money (the publish gate)
    //   verifying → Cashfree bank validation in progress (async, usually a few minutes)
    //   failed    → validation failed; host must re-enter their UPI
    //   none      → no payout set up yet
    state?: 'active' | 'verifying' | 'failed' | 'none';
    vpa?: string;
    message?: string;
}

// Edits the agent can apply to an existing event. Title/description/date/venue are plain reversible
// writes; capacity + pricePerHead go through the characterisation-tested capacity/pricing normalizer
// (buildRevePricingCapacityEdit) so they stay bookable. All edits are propose-gated at the tool layer.
export interface EventEditInput {
    title?: string;
    description?: string;
    date?: string;        // ISO startDateTime
    venue?: string;
    capacity?: number;    // new shared totalSpots
    pricePerHead?: number; // new price for the primary ticket tier (0 = free)
    // Privacy & guest flow — the full set the dashboard edit form exposes, so the agent can change
    // anything the product supports (not a hand-picked subset).
    visibility?: 'public' | 'private'; // private = not publicly discoverable; share the link directly
    requiresApproval?: boolean;        // guests must be approved before they're in
    waitlistEnabled?: boolean;         // collect a waitlist once full
    waitlistSpots?: number;            // optional waitlist cap
    showGuestList?: boolean;           // show "who's coming" on the public page
    showHostDetails?: boolean;         // show the "Hosted by" block
    groupBooking?: boolean;            // let a guest add friends in one booking
}

export interface EventsPort {
    draft(userId: string, input: EventDraftInput, mode: ToolMode): Promise<EventRecord>;
    get(eventId: string): Promise<EventRecord | null>;
    listMine(userId: string): Promise<EventRecord[]>;
    // Publish a draft so it goes live. Handles FREE (direct) and PAID (payout-gated) uniformly.
    publish(userId: string, eventId: string, mode: ToolMode): Promise<EventRecord>;
    edit(userId: string, eventId: string, changes: EventEditInput, mode: ToolMode): Promise<EventRecord>;
    cancel(userId: string, eventId: string, mode: ToolMode): Promise<CancelResult>;
}

// ── Guests (manage-guests journey — reads now; approve/waitlist mutations are a propose-gated follow-up) ──
export interface GuestRequest {
    userId: string;
    name?: string;
    status: string;         // pending | approved | rejected (approval) · waiting | admitted | removed (waitlist)
    createdAt?: string;
}

export interface RsvpEntry {
    name?: string;
    phone?: string;         // guest contact — host-only (the host sees this in the People/leads tab too)
    status?: string;        // going | maybe | cant
    plusOnes?: number;
    answers?: unknown;
    createdAt?: string;
}

export type ApprovalDecision = 'approve' | 'reject';
export type WaitlistDecision = 'admit' | 'remove';

export interface GuestsPort {
    listApprovalRequests(userId: string, eventId: string): Promise<GuestRequest[]>;
    listWaitlist(userId: string, eventId: string): Promise<GuestRequest[]>;
    rsvps(userId: string, eventId: string): Promise<RsvpEntry[]>;
    // Mutations (propose-gated at the tool layer): approve/decline a join request; admit/remove a
    // waitlisted guest (+1/−1 capacity). Both notify the guest on WhatsApp.
    approve(userId: string, eventId: string, guestUserId: string, decision: ApprovalDecision, mode: ToolMode): Promise<{ status: string }>;
    admitWaitlist(userId: string, eventId: string, guestUserId: string, decision: WaitlistDecision, mode: ToolMode): Promise<{ status: string }>;
}

// ── Broadcast (send invites / reminders to guests) ──────────────────────────
export type BroadcastSegment = 'going' | 'checkedin' | 'notcheckedin';

export interface BroadcastResult {
    kind: 'remind' | 'invite';
    recipients: number;      // how many messages were queued (0 = nobody matched / deduped)
    note?: string;
}

export interface BroadcastPort {
    remind(userId: string, eventId: string, segment: BroadcastSegment, mode: ToolMode): Promise<BroadcastResult>;
    invite(userId: string, eventId: string, mode: ToolMode): Promise<BroadcastResult>;
}

export interface PayoutsPort {
    status(userId: string): Promise<PayoutStatus>;
    setVpa(userId: string, vpa: string, mode: ToolMode): Promise<PayoutStatus>;
}

// ── Memory (per-host, cross-conversation) ───────────────────────────────────
// The copilot's long-term memory of a host: durable facts and preferences it has
// learned, recalled by HYBRID search (ArangoSearch BM25 lexical + embedding cosine,
// fused with reciprocal-rank fusion). Small per-host corpus → brute-force semantic.
export type MemoryKind = 'fact' | 'preference' | 'event_context' | 'summary';

export interface MemoryItem {
    id: string;
    userId: string;
    kind: MemoryKind;
    text: string;
    source?: string;      // sessionId that produced it, or 'agent'
    createdAt: string;
    updatedAt: string;
    expiresAt?: string;   // when this memory ages out (by kind TTL); absent = never (legacy rows)
    score?: number;       // retrieval score, set on recall
}

export interface MemoryPort {
    /** Hybrid recall of the most relevant memories for this host + query. */
    recall(userId: string, query: string, k?: number): Promise<MemoryItem[]>;
    /** Persist a durable fact/preference. De-duplicates near-identical text. */
    remember(userId: string, text: string, kind: MemoryKind, source?: string): Promise<MemoryItem>;
    /** Most-recent memories (no query) — used to prime a fresh conversation. */
    list(userId: string, limit?: number): Promise<MemoryItem[]>;
    /** Host-initiated: forget the memories most relevant to `query` (e.g. "forget I host in Gurgaon").
     *  Removes them for good; returns how many went and their text so the agent can confirm. */
    forget(userId: string, query: string, k?: number): Promise<{ removed: number; texts: string[] }>;
}

// ── Knowledge / RAG (RÉVE docs, SOP, FAQ, blog) ──────────────────────────────
export interface KbChunk {
    id: string;
    source: string;       // 'llms' | 'help' | 'blog' | 'seo' | 'legal'
    url?: string;
    title?: string;
    kind?: string;        // faq | blog | legal | marketing | help
    text: string;
    score?: number;
}

// CRAG (corrective RAG) self-assessment of retrieval quality for a query.
export type ContextGrade = 'correct' | 'ambiguous' | 'incorrect';

export interface KnowledgePort {
    /** Hybrid retrieval (BM25 + embedding) over the RÉVE knowledge base. */
    search(query: string, k?: number): Promise<KbChunk[]>;
}

// ── Insights (read-only analytics the host asks about) ───────────────────────
export interface RevenueSummary {
    currency: string;
    totalGross: number;
    ordersCount: number;
    eventsCount: number;
    perEvent: Array<{ eventId: string; title: string; status: string; gross: number; orders: number; capacity?: number | null; paid?: number }>;
}

export interface GuestsSummary {
    eventId: string;
    title?: string;
    count: number;
    hidden?: number;
    guests: Array<{ name?: string; phone?: string; checkedIn?: boolean }>;
}

export interface RatingsSummary {
    overall: { rating: number; reviewCount: number };
    events?: Array<{ eventId: string; title: string; avg: number; count: number; lastComment?: string }>;
}

export interface FeedbackSummary {
    eventId: string;
    title?: string;
    avg: number;
    count: number;
    distribution?: Record<string, number>;
    items: Array<{ rating: number; comment?: string; name?: string }>;
}

export interface SettlementsSummary {
    vendorId?: string;
    totalSettled: number;
    count: number;
    settlements: Array<{ amount: number; status?: string; at?: string }>;
    pendingAmount?: number;
    nextSettlementAt?: string;
}

export interface InsightsPort {
    revenue(userId: string): Promise<RevenueSummary>;
    guests(userId: string, eventId: string): Promise<GuestsSummary>;
    ratings(userId: string): Promise<RatingsSummary>;
    feedback(userId: string, eventId: string): Promise<FeedbackSummary>;
    settlements(userId: string): Promise<SettlementsSummary>;
}

// The invite roster a host builds for an event (name + phone), used to privately invite people and —
// for a PRIVATE event — to gate who can access it.
export interface InviteContact { name?: string; phone?: string }
export interface InviteEntry { name: string; phone: string; invitedAt?: string }
export interface InvitesPort {
    add(userId: string, eventId: string, contacts: InviteContact[]): Promise<{ added: number }>;
    list(userId: string, eventId: string): Promise<InviteEntry[]>;
    remove(userId: string, eventId: string, phone: string): Promise<{ removed: boolean }>;
}

export interface ServicePorts {
    events: EventsPort;
    payouts: PayoutsPort;
    memory: MemoryPort;
    knowledge: KnowledgePort;
    insights: InsightsPort;
    guests: GuestsPort;
    broadcast: BroadcastPort;
    invites: InvitesPort;
}
