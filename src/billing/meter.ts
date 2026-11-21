// Metering — records usage per tenant (runs, tokens, seats) for billing AND the client cost dashboard
// (#6 observability + the cost wedge). In-memory impl for tests; StripeMeter (usage-based billing) in prod.

export type MeterKind = 'tokens' | 'run' | 'seat';
export interface MeterEvent { tenantId: string; runId?: string; kind: MeterKind; quantity: number; at: string }

export interface Meter {
    record(ev: Omit<MeterEvent, 'at'>): Promise<void>;
    /** Per-tenant cost rollup for the dashboard (AI tokens + run count). Extend with cloud cost in Phase 2. */
    summary(tenantId: string): Promise<{ runs: number; tokens: number }>;
}

export class InMemoryMeter implements Meter {
    private events: MeterEvent[] = [];
    async record(ev: Omit<MeterEvent, 'at'>): Promise<void> {
        this.events.push({ ...ev, at: new Date().toISOString() });
    }
    async summary(tenantId: string): Promise<{ runs: number; tokens: number }> {
        const mine = this.events.filter((e) => e.tenantId === tenantId);
        return {
            runs: mine.filter((e) => e.kind === 'run').reduce((a, b) => a + b.quantity, 0),
            tokens: mine.filter((e) => e.kind === 'tokens').reduce((a, b) => a + b.quantity, 0),
        };
    }
}

// StripeMeter (prod stub): record() → Stripe usage records for managed-billing tenants; BYO-key tenants are
// billed a platform/seat fee, not tokens. Wire when STRIPE_SECRET_KEY is set (PRE-PROVISIONING §5).
export class StripeMeterStub implements Meter {
    async record(): Promise<void> { /* TODO: stripe.billing.meterEvents.create(...) */ }
    async summary(): Promise<{ runs: number; tokens: number }> { return { runs: 0, tokens: 0 }; }
}
