// The permission broker. The loop must call this before every tool effect. For
// each request it returns exactly one of EXECUTE / PROPOSE / DENY, and it is the
// only component that can actually run a tool (it holds the registry's token).
//
// Order of checks (any failure → DENY with a reason that feeds back to the model):
//   1. tool exists and is in the agent's allowed list
//   2. a grant exists for (agent, tool)
//   3. args are valid against the tool's JSON-schema
//   4. the grant's optional `when` condition holds
//   5. the tool's own authorize() passes (ownership / business preconditions)
// Then the verdict:
//   • tier 'propose'  → PROPOSE          (always — safety downgrade, even if granted execute)
//   • grant 'propose' → PROPOSE
//   • grant 'execute' + tier read/write → EXECUTE
import Ajv, { type ValidateFunction } from 'ajv';
import { armBroker, invokeTool, describeTool } from './tools/registry';
import { assessEscalation } from './escalation';
import type {
    ServicePorts, Grant, DecisionKind, Decision, DecisionLog, ToolResult, Tier, Model, AgentEventSink,
} from './types';

// Mint the single invocation token at load. If any other module armed first, this throws.
const TOKEN = armBroker();

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ValidateFunction>();
function validatorFor(tool: string, schema: object): ValidateFunction {
    let v = validators.get(tool);
    if (!v) {
        v = ajv.compile(schema);
        validators.set(tool, v);
    }
    return v;
}

export interface BrokerRequest {
    agent: string;
    allowedTools: string[];
    grants: Record<string, Grant>;
    userId: string;
    tool: string;
    args: Record<string, unknown>;
    runId: string;
    ports: ServicePorts;
    resourceId?: string | null;
    /** Optional model handle passed through to tools that need a separate model call (CRAG). */
    model?: Model;
    /** AIDLC observability — passed into ToolContext so tools emit domain events (absent for Host Copilot). */
    sink?: AgentEventSink;
    stage?: string;
    stageRunId?: string;
}

export interface BrokerOutcome {
    decision: DecisionKind;
    tool: string;
    reason: string;
    tier: Tier | null;
    result?: ToolResult;   // EXECUTE
    preview?: ToolResult;  // PROPOSE (dry-run)
}

export interface Verdict {
    decision: DecisionKind;
    reason: string;
    tier: Tier | null;
}

// A tiny, fail-safe condition grammar for grant.when: "<path> is <predicate>".
function evaluateCondition(when: string, args: Record<string, unknown>): { pass: boolean; detail: string } {
    const m = when.trim().match(/^(.+?)\s+is\s+(.+)$/i);
    if (!m) return { pass: false, detail: `unparseable condition: "${when}"` };
    const path = m[1].trim();
    const predicate = m[2].trim().toLowerCase();
    const value = path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as any)[k]), { args });
    const shown = `${path}=${value === undefined ? 'undefined' : String(value)}`;
    switch (predicate) {
        case 'a confirmed number':
            return { pass: typeof value === 'number' && Number.isFinite(value) && value > 0, detail: shown };
        case 'a number':
            return { pass: typeof value === 'number' && Number.isFinite(value), detail: shown };
        case 'present':
        case 'defined':
            return { pass: value !== undefined && value !== null && value !== '', detail: shown };
        default:
            return { pass: false, detail: `unknown predicate "${predicate}" (${shown})` };
    }
}

// The CONFIG-only verdict: everything that depends on the agent config (grants,
// tiers, arg schemas, conditions) and NOT on world state. This is what the replay
// eval regresses — change a grant/tier/schema and see which past calls now decide
// differently. Deterministic, no ports, no authorize.
export interface ConfigVerdictInput {
    allowedTools: string[];
    grants: Record<string, Grant>;
    tool: string;
    args: Record<string, unknown>;
}

export function configVerdict(input: ConfigVerdictInput): Verdict {
    const tool = describeTool(input.tool);
    if (!tool) return { decision: 'DENY', reason: 'unknown tool', tier: null };
    if (!input.allowedTools.includes(input.tool)) {
        return { decision: 'DENY', reason: "tool not in this agent's allowed list", tier: tool.tier };
    }
    const grant = input.grants[input.tool];
    if (!grant) return { decision: 'DENY', reason: 'no grant for this agent', tier: tool.tier };

    let verdict: string;
    let when: string | undefined;
    if (typeof grant === 'string') {
        verdict = grant;
    } else {
        verdict = String(grant.verdict ?? '');
        when = grant.when;
    }

    const validate = validatorFor(input.tool, tool.parameters);
    if (!validate(input.args ?? {})) {
        const msg = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
        return { decision: 'DENY', reason: `invalid args: ${msg || 'schema mismatch'}`, tier: tool.tier };
    }

    if (when) {
        const r = evaluateCondition(when, input.args ?? {});
        if (!r.pass) return { decision: 'DENY', reason: `condition failed [${when}] → ${r.detail}`, tier: tool.tier };
    }

    if (verdict === 'deny') return { decision: 'DENY', reason: 'grant=deny', tier: tool.tier };
    if (tool.tier === 'propose') {
        return { decision: 'PROPOSE', reason: verdict === 'execute' ? 'grant=execute but tool is propose-tier → PROPOSE' : 'grant=propose', tier: tool.tier };
    }
    if (verdict === 'propose') return { decision: 'PROPOSE', reason: 'grant=propose', tier: tool.tier };
    if (verdict === 'execute') return { decision: 'EXECUTE', reason: 'grant=execute, tool reversible', tier: tool.tier };
    return { decision: 'DENY', reason: `malformed grant verdict "${verdict}"`, tier: tool.tier };
}

async function decide(req: BrokerRequest): Promise<Verdict> {
    const cv = configVerdict({ allowedTools: req.allowedTools, grants: req.grants, tool: req.tool, args: req.args });
    if (cv.decision === 'DENY') return cv;

    // World-dependent authorization / business preconditions (ownership, payout gate).
    // Only reached if the config permits the call at all.
    const tool = describeTool(req.tool);
    if (tool?.authorize) {
        const a = await tool.authorize(req.args ?? {}, { userId: req.userId, mode: 'dry-run', ports: req.ports, model: req.model, sink: req.sink, stage: req.stage, stageRunId: req.stageRunId });
        if (!a.ok) return { decision: 'DENY', reason: a.reason ?? 'not authorized', tier: tool.tier };
    }
    return cv;
}

function logEntry(req: BrokerRequest, v: Verdict, mode: Decision['mode'], approved: boolean, ok: boolean | null): Decision {
    return {
        ts: new Date().toISOString(),
        runId: req.runId,
        agent: req.agent,
        userId: req.userId,
        tool: req.tool,
        decision: v.decision,
        reason: v.reason,
        tier: v.tier,
        mode,
        approved,
        ok,
        args: req.args ?? null,
        resourceId: (req.resourceId ?? (req.args?.eventId as string) ?? null) || null,
    };
}

/** Decide, log, and (only on EXECUTE) run the tool. On PROPOSE, run a dry-run preview. */
export async function request(req: BrokerRequest, log: DecisionLog): Promise<BrokerOutcome> {
    let v = await decide(req);

    // Escalate-only confirmation layer. On top of the tier floor, deterministic anomaly checks + an
    // optional model risk-review may RAISE an auto-EXECUTE to a PROPOSE, or strengthen a proposal's note.
    // It can never lower a gate (DENY stays DENY; a propose stays a propose). Monotonic by construction.
    let escNote: string | undefined;
    if (v.decision === 'EXECUTE' || v.decision === 'PROPOSE') {
        const esc = await assessEscalation(req).catch(() => ({ escalate: false, reasons: [] as string[], codes: [] as string[] }));
        if (esc.escalate) {
            escNote = esc.reasons.join(' · ');
            if (v.decision === 'EXECUTE') v = { decision: 'PROPOSE', reason: `escalated to confirm — ${esc.reasons.join('; ')}`, tier: v.tier };
            else v = { ...v, reason: `${v.reason} | escalated — ${esc.reasons.join('; ')}` };
        }
    }

    let result: ToolResult | undefined;
    let preview: ToolResult | undefined;
    let mode: Decision['mode'] = 'none';

    if (v.decision === 'EXECUTE') {
        mode = 'live';
        result = await invokeTool(TOKEN, req.tool, req.args, { userId: req.userId, mode: 'live', ports: req.ports, model: req.model, sink: req.sink, stage: req.stage, stageRunId: req.stageRunId });
    } else if (v.decision === 'PROPOSE') {
        mode = 'dry-run';
        preview = await invokeTool(TOKEN, req.tool, req.args, { userId: req.userId, mode: 'dry-run', ports: req.ports, model: req.model, sink: req.sink, stage: req.stage, stageRunId: req.stageRunId });
        // Surface the escalation reason in the host-facing confirmation note.
        if (escNote && preview) preview = { ...preview, note: `⚠ Heads up: ${escNote}.${preview.note ? ` ${preview.note}` : ''}` };
    }

    await log.append(logEntry(req, v, mode, false, result ? result.ok : preview ? preview.ok : null));
    return { decision: v.decision, tool: req.tool, reason: v.reason, tier: v.tier, result, preview };
}

/** Promote a previously PROPOSED call to a live execution after human approval. */
export async function approve(req: BrokerRequest, log: DecisionLog): Promise<ToolResult> {
    const tool = describeTool(req.tool);
    const result = await invokeTool(TOKEN, req.tool, req.args, { userId: req.userId, mode: 'live', ports: req.ports, model: req.model, sink: req.sink, stage: req.stage, stageRunId: req.stageRunId });
    await log.append(logEntry(
        req,
        { decision: 'EXECUTE', reason: 'approved proposal', tier: tool ? tool.tier : null },
        'live', true, result.ok,
    ));
    return result;
}

/** Re-decide under the CURRENT config with NO real effect and NO log write. Used by replay. */
export async function replay(req: BrokerRequest): Promise<Verdict> {
    const v = await decide(req);
    if (v.decision === 'EXECUTE' || v.decision === 'PROPOSE') {
        await invokeTool(TOKEN, req.tool, req.args, { userId: req.userId, mode: 'dry-run', ports: req.ports, model: req.model, sink: req.sink, stage: req.stage, stageRunId: req.stageRunId });
    }
    return v;
}
