// Eligibility sweep — the mechanism that makes the agent PROACTIVE instead of reactive.
//
// Every rule/condition/permission already lives in a tool's authorize() (and the services it wraps).
// Rather than restate those rules in the prompt (which would duplicate them and drift), we RUN the
// real authorize() guards speculatively (dry-run) against the current state and hand the agent the
// verdicts as DATA. The agent then offers only what's actually allowed, with the real reasons — and
// ANY rule added to a tool later is reflected automatically, no prompt change. Rules stay in one place.
import type { ToolContext } from './types';
import { describeTool } from './tools/registry';

export interface ActionVerdict { allowed: boolean; reason?: string }

// Event-scoped actions whose availability depends on the event's STATE (not just on args). Edit is
// omitted: its only state rule is ownership (always true for the host's own event) — its other
// "precondition" is just "say what to change", which isn't an eligibility fact.
const EVENT_ACTIONS = ['events.publish', 'events.cancel', 'broadcast.remind', 'broadcast.invite'];

/**
 * For one of the host's events, return which state-gated actions are currently available and why not —
 * computed by the tools' OWN authorize() logic (single source of truth). Attached to events.get output
 * so the agent sees eligibility whenever it looks at an event.
 */
export async function eventCapabilities(ctx: ToolContext, eventId: string): Promise<Record<string, ActionVerdict>> {
    const dryCtx: ToolContext = { ...ctx, mode: 'dry-run' };
    const out: Record<string, ActionVerdict> = {};
    for (const name of EVENT_ACTIONS) {
        const tool = describeTool(name);
        if (!tool) continue;
        if (!tool.authorize) { out[name] = { allowed: true }; continue; }
        try {
            const a = await tool.authorize({ eventId }, dryCtx);
            out[name] = a.ok ? { allowed: true } : { allowed: false, reason: a.reason };
        } catch {
            out[name] = { allowed: false, reason: 'unavailable' };
        }
    }
    // Editing details is always available for an owned event (ownership only, not state-gated).
    out['events.edit'] = { allowed: true };
    // But ADDING A PAID PRICE is payout-gated (same as publishing a paid event) — surface that
    // specific verdict so the agent proactively knows it can't make an event paid without payout.
    const edit = describeTool('events.edit');
    if (edit?.authorize) {
        try {
            const a = await edit.authorize({ eventId, pricePerHead: 1 }, dryCtx);
            out['events.edit:paidPrice'] = a.ok ? { allowed: true } : { allowed: false, reason: a.reason };
        } catch { /* ignore */ }
    }
    return out;
}
