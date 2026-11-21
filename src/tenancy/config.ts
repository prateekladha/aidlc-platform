// Config → DB (no hardcoding, #9/#10). Platform DEFAULTS live here in code; a tenant's row overrides any
// subset; the engine reads ONLY the resolved result. Adding a new knob = add a default here + (optionally) a
// tenant override — never an `if (tenant === ...)` anywhere in the codebase.

import type { DataStore } from '../db/store';
import type { ResolvedConfig, ModelBilling } from '../types';

export const PLATFORM_DEFAULTS: ResolvedConfig = {
    model: 'claude-sonnet-5',               // the main coding model (BYO or managed)
    criticModel: 'claude-haiku-4-5',        // high-volume critic/verifier (separate-quota, cheaper)
    thinkingDefault: 'low',
    autoMerge: false,                       // honest-deploy default: never auto-merge
    maxConcurrentRuns: 2,
    tokenBudgetPerRun: 1_000_000,
    moneyApprovers: [],
    infraApprovers: [],
    egressAllowlist: ['api.github.com', 'github.com', 'api.anthropic.com', 'generativelanguage.googleapis.com'],
    modelBilling: 'byo_key',
    sandboxProvider: 'e2b',
    artifactTtlDays: 30,
    features: {},
};

/** Deep-ish merge: tenant overrides win per-key; arrays/objects replace wholesale (predictable). */
export function mergeConfig(base: ResolvedConfig, overrides?: Partial<ResolvedConfig>): ResolvedConfig {
    if (!overrides) return { ...base };
    return {
        ...base,
        ...overrides,
        features: { ...base.features, ...(overrides.features || {}) },
    };
}

/** The single resolver the engine/dispatcher calls at run start. Tenant's `modelBilling` on the tenant row
 *  is authoritative and folded in, so billing mode can't drift from config. */
export async function resolveConfig(store: DataStore, tenantId: string, tenantBilling?: ModelBilling): Promise<ResolvedConfig> {
    const row = await store.getConfigRow(tenantId);
    const resolved = mergeConfig(PLATFORM_DEFAULTS, row?.overrides);
    if (tenantBilling) resolved.modelBilling = tenantBilling;
    return resolved;
}
