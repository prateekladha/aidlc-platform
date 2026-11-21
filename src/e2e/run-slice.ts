// END-TO-END slice — drives the REAL platform control plane against a test tenant + repo, in LOCAL git mode.
//
// Run:  npx tsx --env-file=.env src/e2e/run-slice.ts
// It exercises: onboardTenant → per-tenant config (DeepSeek) → connect GitHub → whitelist repo → JIT secret →
// submitWorkItem → dispatchRun → (ported AIDLC engine, local git auth) → a REAL draft PR on the repo, held at
// the human merge-confirmation gate. Nothing is merged. This proves the platform works end to end.

import { InMemoryDataStore } from '../db/store';
import { EnvelopeSecretProvider } from '../secrets/envelope';
import { MockSandboxProvider } from '../sandbox/mock';
import { InMemoryMeter } from '../billing/meter';
import { LocalAidlcEngine } from '../runs/engine.aidlc.local';
import type { DispatchDeps } from '../runs/dispatch';
import { onboardTenant, connectInstallation, whitelistRepo, storeSecret, submitWorkItem, costSummary } from '../service';

const REPO = process.env.E2E_REPO || 'prateekladha/rockstar-radar';
const BRANCH = process.env.E2E_BASE_BRANCH || 'main';
const TASK = process.env.E2E_TASK ||
    'Add a lightweight health-check endpoint `GET /api/health` to the FastAPI backend (under server/) that ' +
    'returns JSON {"status":"ok"} with HTTP 200 for uptime monitoring and load-balancer checks. It must NOT ' +
    'require authentication, must be minimal, and must follow the existing FastAPI route/registration style in ' +
    'the codebase. Do not change unrelated behaviour.';

async function main() {
    const t0 = Date.now();
    console.log(`\n=== AIDLC platform · end-to-end slice (local git mode) ===`);
    console.log(`repo: ${REPO}  base: ${BRANCH}`);

    const store = new InMemoryDataStore();
    const secrets = new EnvelopeSecretProvider();
    const deps: DispatchDeps = {
        store,
        secrets,
        meter: new InMemoryMeter(),
        sandbox: new MockSandboxProvider(),
        github: { mintRepoToken: async () => 'local-mode-no-token' }, // local mode: push/PR via local gh, not an App token
        engine: new LocalAidlcEngine(),
    };

    // 1) onboard a tenant (what the onboarding flow does for a tenant owner)
    const { tenant, owner, ctx } = await onboardTenant(store, {
        slug: 'acme-trading', name: 'Acme Trading', ownerEmail: 'owner@acme.test', modelBilling: 'byo_key',
    });
    console.log(`✓ tenant onboarded: ${tenant.slug} (owner ${owner.email})`);

    // 2) per-tenant model config → DeepSeek (overrides the platform default)
    await store.setConfigRow({
        tenantId: tenant.id,
        overrides: { modelProvider: 'deepseek', model: process.env.E2E_MODEL || 'deepseek-flash', criticModel: 'deepseek-flash', maxConcurrentRuns: 1 },
    } as any);
    console.log(`✓ config: ${process.env.E2E_MODEL || 'deepseek-flash'} (critic deepseek-flash)`);

    // 3) connect GitHub + 4) whitelist the repo (onboarding's connect-repo step)
    const inst = await connectInstallation(ctx, { installationId: 424242, accountLogin: REPO.split('/')[0] });
    const repo = await whitelistRepo(ctx, { installationId: inst.id, fullName: REPO, defaultBranch: BRANCH });
    console.log(`✓ repo connected + whitelisted: ${repo.fullName}`);

    // 5) store the model key as a JIT tenant secret (never persisted beyond the run)
    await storeSecret(ctx, secrets, 'MODEL_API_KEY', process.env.AIDLC_OPENAI_COMPAT_API_KEY || '');
    console.log(`✓ model key stored (JIT secret)`);

    // 6) submit the work item → dispatch → engine runs the DAG → gated PR
    console.log(`\n▶ submit + dispatch:  "${TASK.slice(0, 70)}…"\n`);
    const { run } = await submitWorkItem(deps, ctx, {
        repoId: repo.id, title: 'Add /api/health endpoint', rawRequest: TASK, userId: owner.id,
    });

    const events = await ctx.listEvents(run.id);
    console.log(`\n--- events (${events.length}) ---`);
    for (const e of events) console.log(`  ${e.seq}. ${e.type}${e.payload ? '  ' + JSON.stringify(e.payload).slice(0, 400) : ''}`);

    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`\n=== RESULT (${secs}s) ===`);
    console.log(`state:  ${run.state}`);
    console.log(`stage:  ${run.stage || '—'}`);
    console.log(`PR:     ${run.prUrl || '— (no PR produced)'}`);
    console.log(`tokens: ${run.costTokens}`);
    console.log(`meter:  ${JSON.stringify(await costSummary(deps.meter, tenant.id))}`);
    if (run.state === 'awaiting_gate' && run.prUrl && /^https:/.test(run.prUrl)) {
        console.log(`\n✅ END-TO-END PASS — real PR opened and HELD at the human gate (not merged).`);
    } else if (run.state === 'awaiting_gate') {
        console.log(`\n◑ held at a human gate (${run.stage}) — pipeline ran; inspect the PR/gate above.`);
    } else if (run.state === 'awaiting_input') {
        console.log(`\n◑ engine asked for human input (needsInput) — expected when the task needs a decision.`);
    } else if (run.state === 'failed') {
        console.log(`\n✗ run failed — see the event log above.`);
    }
}

main().catch((e) => { console.error('\nE2E ERROR:', e?.stack || e); process.exit(1); });
