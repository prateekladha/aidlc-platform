// Run dispatch — the core flow, tenant-scoped end to end. This is where the platform's guarantees compose:
//   resolve per-tenant config → enforce concurrency → mint a REPO-SCOPED short-lived GitHub token →
//   JIT-fetch the tenant's secrets → spin an ISOLATED microVM → run the (ported AIDLC) engine inside →
//   ALWAYS tear the sandbox down (secrets die with it) → meter the cost.
// Every collaborator is an interface, so this is fully testable with mocks (see test/run.ts) and provider-
// agnostic (E2B/Firecracker, Vault, Postgres swap in without touching this file). The `engine` seam is where
// the hardened AIDLC Supervisor is plugged in (Phase-1 port); the scaffold stubs it.

import type { DataStore } from '../db/store';
import type { TenantContext } from '../tenancy/context';
import type { SandboxProvider, Sandbox } from '../sandbox/provider';
import type { SecretProvider } from '../secrets/provider';
import type { Meter } from '../billing/meter';
import type { Run, RunState, ResolvedConfig } from '../types';
import { resolveConfig } from '../tenancy/config';

/** Mints a short-lived token scoped to ONE repo (wraps onboarding/github.mintInstallationToken in prod). */
export interface GitHubTokenMinter {
    mintRepoToken(installationGhId: number, repoFullName: string): Promise<string>;
}

export interface EngineRunInput {
    ctx: TenantContext;
    run: Run;
    sandbox: Sandbox;
    config: ResolvedConfig;
    secrets: Record<string, string>;   // JIT tenant secrets (model key, GitHub App creds) — never persisted
    emit: (type: string, payload?: Record<string, unknown>) => Promise<void>;
}
export interface EngineRunOutput { state: RunState; costTokens: number; prUrl?: string; stage?: string }
/** The ported AIDLC engine plugs in here. */
export interface Engine { run(input: EngineRunInput): Promise<EngineRunOutput> }

export interface DispatchDeps {
    store: DataStore;
    sandbox: SandboxProvider;
    secrets: SecretProvider;
    github: GitHubTokenMinter;
    engine: Engine;
    meter: Meter;
}

export async function dispatchRun(deps: DispatchDeps, ctx: TenantContext, workItemId: string): Promise<Run> {
    const wi = await ctx.getWorkItem(workItemId);
    if (!wi) throw new Error(`work item not found in tenant: ${workItemId}`);
    const repo = await ctx.getRepo(wi.repoId);
    if (!repo) throw new Error(`repo not found in tenant: ${wi.repoId}`);
    const tenant = await deps.store.getTenant(ctx.tenantId);
    const config = await resolveConfig(deps.store, ctx.tenantId, tenant?.modelBilling);

    // Concurrency cap (per-tenant, from config).
    const active = (await ctx.listRuns()).filter((r) => r.state === 'running' || r.state === 'queued');
    if (active.length >= config.maxConcurrentRuns) {
        throw new Error(`concurrency cap reached (${config.maxConcurrentRuns} active runs for this tenant)`);
    }

    const run = await ctx.createRun({ workItemId, state: 'queued', costTokens: 0 });
    let seq = 0;
    const emit = async (type: string, payload?: Record<string, unknown>): Promise<void> => {
        await ctx.appendEvent({ runId: run.id, seq: seq++, ts: new Date().toISOString(), type, payload });
    };

    try {
        await ctx.updateRun(run.id, { state: 'running' });
        await emit('run.started', { repo: repo.fullName });

        // 1) repo-scoped, short-lived GitHub token (the sandbox clones with THIS, nothing broader).
        const installs = await ctx.listInstallations();
        const inst = installs.find((i) => i.id === repo.installationId);
        if (!inst) throw new Error('installation missing for repo');
        const cloneToken = await deps.github.mintRepoToken(inst.installationId, repo.fullName);

        // 2) JIT tenant secrets (plaintext only here; injected into the sandbox, never persisted).
        const secrets = await deps.secrets.bundleForRun(ctx);

        // 3) isolated microVM for this run.
        const sandbox = await deps.sandbox.create({
            tenantId: ctx.tenantId, runId: run.id,
            repoFullName: repo.fullName, branch: repo.defaultBranch,
            cloneToken, secrets, egressAllowlist: config.egressAllowlist,
            timeoutMs: 30 * 60 * 1000,
        });
        await ctx.updateRun(run.id, { sandboxRef: sandbox.ref });

        let out: EngineRunOutput;
        try {
            // 4) the (ported AIDLC) engine runs inside the isolation boundary.
            out = await deps.engine.run({ ctx, run, sandbox, config, secrets, emit });
        } finally {
            await sandbox.destroy(); // secrets die with the sandbox, always
            await emit('sandbox.destroyed');
        }

        await deps.meter.record({ tenantId: ctx.tenantId, runId: run.id, kind: 'tokens', quantity: out.costTokens });
        await deps.meter.record({ tenantId: ctx.tenantId, runId: run.id, kind: 'run', quantity: 1 });
        await emit('run.finished', { state: out.state, prUrl: out.prUrl, costTokens: out.costTokens });
        return await ctx.updateRun(run.id, { state: out.state, prUrl: out.prUrl, costTokens: out.costTokens, stage: out.stage });
    } catch (e: any) {
        await emit('run.error', { error: e?.message || String(e) });
        return await ctx.updateRun(run.id, { state: 'failed' });
    }
}
