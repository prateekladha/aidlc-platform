// Application services — the control-plane operations, framework-agnostic (the Phase-1 HTTP layer, Fastify,
// just validates input + calls these). Each tenant-scoped op takes a TenantContext, so it is structurally
// tenant-safe. onboardTenant is the only global op (creates the tenant + its owner).

import type { DataStore } from './db/store';
import { TenantContext } from './tenancy/context';
import type { SecretProvider } from './secrets/provider';
import type { Meter } from './billing/meter';
import { dispatchRun, type DispatchDeps } from './runs/dispatch';
import type { Tenant, User, ModelBilling, Plan } from './types';

export async function onboardTenant(
    store: DataStore,
    input: { slug: string; name: string; ownerEmail: string; modelBilling?: ModelBilling; plan?: Plan },
): Promise<{ tenant: Tenant; owner: User; ctx: TenantContext }> {
    if (await store.getTenantBySlug(input.slug)) throw new Error(`slug taken: ${input.slug}`);
    const tenant = await store.createTenant({
        slug: input.slug, name: input.name, plan: input.plan ?? 'free', modelBilling: input.modelBilling ?? 'byo_key',
    });
    const ctx = new TenantContext(store, tenant.id);
    const owner = await ctx.createUser({ email: input.ownerEmail, role: 'owner' });
    return { tenant, owner, ctx };
}

export async function connectInstallation(ctx: TenantContext, input: { installationId: number; accountLogin: string }) {
    return ctx.createInstallation({ provider: 'github', installationId: input.installationId, accountLogin: input.accountLogin });
}

export async function whitelistRepo(ctx: TenantContext, input: { installationId: string; fullName: string; defaultBranch: string }) {
    const inst = (await ctx.listInstallations()).find((i) => i.id === input.installationId);
    if (!inst) throw new Error('installation not found for this tenant');
    return ctx.createRepo({ installationId: inst.id, fullName: input.fullName, defaultBranch: input.defaultBranch });
}

export async function storeSecret(ctx: TenantContext, secrets: SecretProvider, name: string, plaintext: string): Promise<void> {
    await secrets.put(ctx, name, plaintext);
}

export async function submitWorkItem(
    deps: DispatchDeps,
    ctx: TenantContext,
    input: { repoId: string; title: string; rawRequest: string; userId: string },
) {
    const repo = await ctx.getRepo(input.repoId);
    if (!repo) throw new Error('repo not whitelisted for this tenant');
    const wi = await ctx.createWorkItem({ repoId: repo.id, title: input.title, rawRequest: input.rawRequest, createdBy: input.userId });
    const run = await dispatchRun(deps, ctx, wi.id);
    return { workItem: wi, run };
}

export async function costSummary(meter: Meter, tenantId: string) {
    return meter.summary(tenantId);
}
