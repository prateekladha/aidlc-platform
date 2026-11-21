// Application services — the control-plane operations, framework-agnostic (the Phase-1 HTTP layer, Fastify,
// just validates input + calls these). Each tenant-scoped op takes a TenantContext, so it is structurally
// tenant-safe. onboardTenant is the only global op (creates the tenant + its owner).

import type { DataStore } from './db/store';
import { TenantContext } from './tenancy/context';
import type { SecretProvider } from './secrets/provider';
import type { Meter } from './billing/meter';
import { dispatchRun, type DispatchDeps } from './runs/dispatch';
import type { Tenant, User, ModelBilling, Plan } from './types';
import { hashPassword, verifyPassword, signToken, slugify } from './auth/auth';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export interface AuthResult { tenant: Tenant; user: User; token: string; }

/** Public sign-up: create a workspace (tenant) + its owner with a password, return a session token. */
export async function signup(
    store: DataStore,
    input: { email: string; password: string; workspaceName: string; name?: string },
): Promise<AuthResult> {
    const email = (input.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error('enter a valid email address');
    if ((input.workspaceName || '').trim().length < 2) throw new Error('workspace name is required');
    if (await store.getUserByEmail(email)) throw new Error('an account with that email already exists — sign in instead');
    const passwordHash = hashPassword(input.password);   // throws if < 8 chars
    const tenant = await store.createTenant({ slug: slugify(input.workspaceName), name: input.workspaceName.trim(), plan: 'free', modelBilling: 'byo_key' });
    const ctx = new TenantContext(store, tenant.id);
    const user = await ctx.createUser({ email, role: 'owner', passwordHash, name: input.name });
    const token = signToken({ sub: user.id, tid: tenant.id, role: user.role, email });
    return { tenant, user, token };
}

/** Sign in with email + password. Generic error (never reveal which half failed). */
export async function login(store: DataStore, input: { email: string; password: string }): Promise<AuthResult> {
    const user = await store.getUserByEmail((input.email || '').trim().toLowerCase());
    if (!user || !verifyPassword(input.password || '', user.passwordHash)) throw new Error('invalid email or password');
    const tenant = await store.getTenant(user.tenantId);
    if (!tenant) throw new Error('workspace not found');
    const token = signToken({ sub: user.id, tid: tenant.id, role: user.role, email: user.email });
    return { tenant, user, token };
}

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
