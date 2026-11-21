// Escalate-only confirmation layer — the second half of the "both" safety design.
//
// The TIER is the floor (broker.ts): a propose-tier tool ALWAYS confirms and nothing can downgrade it.
// On top of that floor this module may only RAISE friction — it can turn an auto-EXECUTE into a PROPOSE,
// or strengthen a proposal's confirmation note. It can NEVER lower a gate or approve anything. Composition
// is monotonic: effective_gate = max(tier_gate, escalation). That asymmetry is the whole point — a
// jailbreak can only ever make the agent MORE cautious here, never less.
//
// Two layers feed it:
//   1. DETERMINISTIC anomaly checks (pure, testable, un-gameable) — magnitude/consequence red flags the
//      coarse tier can't see: a big price jump, a capacity cut below already-booked guests, cancelling an
//      event that has bookings or starts imminently.
//   2. MODEL judgement (fuzzy) — a SEPARATE risk-review call for things code can't easily express. Runs
//      for WRITE-tier tools only (where it can lift an auto-EXECUTE to a confirm); propose-tier already
//      pauses, so a round-trip there is wasted. Strictly escalate-only and FAILS OPEN (an error just adds
//      no friction; the tier floor still holds).
import { describeTool } from './tools/registry';
import type { BrokerRequest } from './broker';
import type { Model } from './types';

export interface Escalation { code: string; message: string }
export interface EscalationResult { escalate: boolean; reasons: string[]; codes: string[] }

// World state the deterministic checks compare against (fetched once per assessment).
export interface EventWorld {
    price: number | null;
    capacity: number | null;
    startMs: number | null;
    bookedCount: number;
}

const IMMINENT_MS = 3 * 60 * 60 * 1000; // "starts very soon" = under 3 hours

// ── pure deterministic checks (unit-tested) ────────────────────────────────────────
// A large increase in ticket price — ≥3× the current price, or an absolute jump of ≥ ₹5,000. Returns
// null when there's no meaningful increase (going cheaper/free, or a small bump).
export function priceJump(oldPrice: number | null, newPrice: number): Escalation | null {
    if (!Number.isFinite(newPrice) || newPrice <= 0) return null;
    const old = oldPrice ?? 0;
    if (newPrice <= old) return null;
    const bigRatio = old > 0 && newPrice >= old * 3;
    const bigAbs = newPrice - old >= 5000;
    if (!bigRatio && !bigAbs) return null;
    return { code: 'price_jump', message: `this raises the ticket price from ₹${old} to ₹${newPrice}` };
}

// New capacity set below the guests who have already booked — those seats are already taken.
export function capacityStrand(newCapacity: number, bookedCount: number): Escalation | null {
    if (!Number.isFinite(newCapacity) || newCapacity < 0) return null;
    if (bookedCount > 0 && newCapacity < bookedCount) {
        return { code: 'capacity_strand', message: `the new capacity (${newCapacity}) is below the ${bookedCount} guest(s) already booked` };
    }
    return null;
}

// Acting on an event that starts within the next few hours.
export function imminent(startMs: number | null, nowMs: number): Escalation | null {
    if (startMs == null || !Number.isFinite(startMs)) return null;
    const delta = startMs - nowMs;
    if (delta > 0 && delta < IMMINENT_MS) {
        const mins = Math.max(1, Math.round(delta / 60000));
        return { code: 'imminent', message: `the event starts in about ${mins} minute(s)` };
    }
    return null;
}

// Cancelling an event that has paid/confirmed guests.
export function cancelWithBookings(bookedCount: number): Escalation | null {
    if (bookedCount > 0) return { code: 'cancel_with_bookings', message: `this event has ${bookedCount} guest(s) already booked` };
    return null;
}

// Compose the deterministic checks for a given tool call against the fetched world. PURE.
export function deterministicEscalations(tool: string, args: Record<string, unknown>, world: EventWorld, nowMs: number): Escalation[] {
    const out: Escalation[] = [];
    if (tool === 'events.edit') {
        if (args.pricePerHead != null) { const e = priceJump(world.price, Number(args.pricePerHead)); if (e) out.push(e); }
        if (args.capacity != null) { const e = capacityStrand(Number(args.capacity), world.bookedCount); if (e) out.push(e); }
        if (args.date != null) { const e = imminent(world.startMs, nowMs); if (e) out.push(e); }
    } else if (tool === 'events.cancel') {
        const b = cancelWithBookings(world.bookedCount); if (b) out.push(b);
        const i = imminent(world.startMs, nowMs); if (i) out.push(i);
    }
    return out;
}

// ── model judgement (fuzzy, escalate-only, fail-open) ───────────────────────────────
async function modelEscalation(model: Model | undefined, ctx: { tool: string; args: Record<string, unknown>; world: EventWorld | null }): Promise<Escalation | null> {
    // Disabled explicitly, no model, or the deterministic test model (don't desync a scripted script).
    if (!model || process.env.AGENT_MODEL_ESCALATION === '0' || model.id.startsWith('scripted')) return null;
    const sys = [
        'You review ONE host action on RÉVE and decide only whether the host should DOUBLE-CHECK before it runs —',
        'i.e. does it look unusually risky, destructive, or likely a mistake? You can ONLY add a confirmation;',
        'you never approve, run, or skip anything, and routine actions must not be escalated.',
        'Reply with compact JSON only: {"escalate": true|false, "reason": "<short host-facing reason>"}.',
    ].join(' ');
    const user = `Tool: ${ctx.tool}\nArgs: ${JSON.stringify(ctx.args)}\nEvent state: ${JSON.stringify(ctx.world)}\nIf this is a routine host action, reply {"escalate":false}.`;
    try {
        const turn = await model.generate({ system: sys, messages: [{ role: 'user', text: user }], tools: [], thinking: 'low', trace: { phase: 'escalation' } });
        const m = (turn.text ?? '').match(/\{[\s\S]*\}/);
        if (!m) return null;
        const v = JSON.parse(m[0]);
        if (!v?.escalate) return null;
        return { code: 'model', message: String(v.reason || 'this looks unusual — worth a quick confirm') };
    } catch {
        return null; // fail-open: an escalate-only layer that errors simply adds no friction
    }
}

// ── orchestrator ────────────────────────────────────────────────────────────────────
async function gatherWorld(req: BrokerRequest, eventId: string): Promise<EventWorld | null> {
    const e = await req.ports.events.get(eventId).catch(() => null);
    if (!e) return null;
    let bookedCount = 0;
    try { const g = await req.ports.insights.guests(req.userId, eventId); bookedCount = g?.count ?? 0; } catch { /* best-effort */ }
    return {
        price: Number.isFinite(e.pricePerHead) ? e.pricePerHead : null,
        capacity: e.capacity ?? null,
        startMs: e.date ? Date.parse(e.date) : null,
        bookedCount,
    };
}

/** Assess whether this call should be escalated. Reads never escalate. Deterministic anomaly checks run
 *  for any mutating (write/propose) tool; the model risk-review runs for write-tier only. Returns the
 *  union of deterministic + model reasons. */
export async function assessEscalation(req: BrokerRequest, nowMs: number = Date.now()): Promise<EscalationResult> {
    const tool = describeTool(req.tool);
    if (!tool || tool.tier === 'read') return { escalate: false, reasons: [], codes: [] };

    const eventId = (req.args?.eventId as string) || undefined;
    const world = eventId ? await gatherWorld(req, eventId) : null;

    const det = world ? deterministicEscalations(req.tool, req.args ?? {}, world, nowMs) : [];
    // The model risk-review runs for WRITE-tier tools only — those are the ones it can usefully lift to a
    // confirmation (EXECUTE→PROPOSE). Propose-tier tools already pause for the host, so the extra LLM
    // round-trip there would only add latency before a confirm card that was going to show anyway; the
    // deterministic checks still strengthen those proposals' notes.
    const model = tool.tier === 'write' ? await modelEscalation(req.model, { tool: req.tool, args: req.args ?? {}, world }) : null;
    const all = [...det, ...(model ? [model] : [])];
    return { escalate: all.length > 0, reasons: all.map((e) => e.message), codes: all.map((e) => e.code) };
}
