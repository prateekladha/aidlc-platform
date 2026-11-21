// Fail-closed verifiers for irreversible journeys (constitution L3). A verifier
// is a SEPARATE call from the tool doing the work — "nothing grades itself". It
// re-establishes the preconditions independently, right before a commit, and is
// also runnable on its own as an eval. Fails closed: any uncertainty → not ok.
import type { ServicePorts } from './types';

export interface VerifyResult {
    ok: boolean;
    reason: string;
}

// Publish-a-paid-event may commit only when ALL hold:
//   • the event exists
//   • it belongs to this user (ownership)
//   • the host's payout account is ACTIVE (money must be routable)
//   • it is actually a paid event (price > 0)
export async function verifyPublish(userId: string, eventId: string, ports: ServicePorts): Promise<VerifyResult> {
    const event = await ports.events.get(eventId).catch(() => null);
    if (!event) return { ok: false, reason: `event ${eventId} not found` };
    if (String(event.hostUserId) !== String(userId)) {
        return { ok: false, reason: 'not your event — publish refused' };
    }
    const payout = await ports.payouts.status(userId).catch(() => ({ active: false }));
    if (!payout.active) {
        return { ok: false, reason: 'payout account is not active — set up payout before publishing a paid event' };
    }
    if (!(event.pricePerHead > 0)) {
        return { ok: false, reason: 'not a paid event (price is 0) — use the free publish path' };
    }
    return { ok: true, reason: 'ownership + active payout + valid price confirmed' };
}
