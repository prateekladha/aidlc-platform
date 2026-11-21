// Characterisation tests for the multi-tenant foundation. Zero external deps — run: `npm test`.
// These pin the platform's load-bearing GUARANTEES: tenant isolation, config→DB resolution, secret
// encryption-at-rest + JIT + non-persistence, webhook HMAC, real RS256 App-JWT, and the dispatch flow
// (repo-scoped token → JIT secrets → isolated sandbox → engine → teardown → meter).

import assert from 'node:assert';
import crypto from 'node:crypto';
import { InMemoryDataStore } from '../db/store';
import { TenantContext } from '../tenancy/context';
import { resolveConfig, mergeConfig, PLATFORM_DEFAULTS } from '../tenancy/config';
import { EnvelopeSecretProvider } from '../secrets/envelope';
import { MockSandboxProvider } from '../sandbox/mock';
import { InMemoryMeter } from '../billing/meter';
import { mintAppJwt, verifyWebhookSignature, tenantForInstallation, LEAST_PRIV_PERMISSIONS } from '../onboarding/github';
import { onboardTenant, connectInstallation, whitelistRepo, storeSecret, submitWorkItem, costSummary } from '../service';
import type { DispatchDeps, Engine } from '../runs/dispatch';
import { parseJsonLoose } from '../engine/orchestrator/dispatcher';
import { sanitizeConversation, sanitizeToolName } from '../engine/model/openai-compat';
import { PostgresDataStore } from '../db/store.postgres';
import { newDb } from 'pg-mem';
import { RazorpayBilling, InMemoryCreditsLedger, CreditsMeter } from '../billing/razorpay';

const cases: Array<[string, () => Promise<void>]> = [];
const it = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

// ── tenant isolation ──────────────────────────────────────────────────────────
it('tenant isolation: one tenant cannot read another tenant\'s records', async () => {
    const store = new InMemoryDataStore();
    const a = await onboardTenant(store, { slug: 'acme', name: 'Acme', ownerEmail: 'o@acme.com' });
    const b = await onboardTenant(store, { slug: 'globex', name: 'Globex', ownerEmail: 'o@globex.com' });
    const instA = await connectInstallation(a.ctx, { installationId: 111, accountLogin: 'acme' });
    const repoA = await whitelistRepo(a.ctx, { installationId: instA.id, fullName: 'acme/app', defaultBranch: 'main' });
    const wiA = await a.ctx.createWorkItem({ repoId: repoA.id, title: 'x', rawRequest: 'x', createdBy: a.owner.id });

    // B's context must NOT see A's work item or repo, even with the real id.
    assert.strictEqual(await b.ctx.getWorkItem(wiA.id), null, 'cross-tenant work item read must be null');
    assert.strictEqual(await b.ctx.getRepo(repoA.id), null, 'cross-tenant repo read must be null');
    assert.strictEqual((await b.ctx.listWorkItems()).total, 0, 'B sees none of A\'s work items');
    // A still sees its own.
    assert.ok(await a.ctx.getWorkItem(wiA.id), 'A sees its own work item');
});

it('tenant isolation: a context always stamps its OWN tenantId on creates', async () => {
    const store = new InMemoryDataStore();
    const a = await onboardTenant(store, { slug: 'a1', name: 'A1', ownerEmail: 'o@a1.com' });
    const u = await a.ctx.createUser({ email: 'm@a1.com', role: 'member' } as any);
    assert.strictEqual(u.tenantId, a.tenant.id, 'created user is stamped with the context tenant');
});

// ── config → DB ─────────────────────────────────────────────────────────────────
it('config resolution: platform defaults + tenant overrides merge; billing folded in', async () => {
    const store = new InMemoryDataStore();
    const a = await onboardTenant(store, { slug: 'cfg', name: 'Cfg', ownerEmail: 'o@c.com', modelBilling: 'managed' });
    await store.setConfigRow({ tenantId: a.tenant.id, overrides: { maxConcurrentRuns: 5, features: { betaMobile: true } }, updatedAt: '' });
    const cfg = await resolveConfig(store, a.tenant.id, a.tenant.modelBilling);
    assert.strictEqual(cfg.maxConcurrentRuns, 5, 'override wins');
    assert.strictEqual(cfg.autoMerge, false, 'untouched default preserved (honest deploy)');
    assert.strictEqual(cfg.features.betaMobile, true, 'feature flag merged');
    assert.strictEqual(cfg.modelBilling, 'managed', 'billing folded from tenant');
    // no override → pure defaults
    const base = mergeConfig(PLATFORM_DEFAULTS, undefined);
    assert.strictEqual(base.model, PLATFORM_DEFAULTS.model);
});

// ── secrets: encryption-at-rest + JIT + non-persistence ──────────────────────────
it('secrets: ciphertext at rest (never plaintext), JIT decrypt, tamper fails closed', async () => {
    const store = new InMemoryDataStore();
    const a = await onboardTenant(store, { slug: 'sec', name: 'Sec', ownerEmail: 'o@s.com' });
    const sp = new EnvelopeSecretProvider();
    const PLAINTEXT = 'sk-ant-SUPER-SECRET-123';
    await storeSecret(a.ctx, sp, 'ANTHROPIC_API_KEY', PLAINTEXT);

    const rec = await a.ctx.getSecret('ANTHROPIC_API_KEY');
    assert.ok(rec, 'secret stored');
    assert.ok(!rec!.ciphertext.includes(PLAINTEXT), 'plaintext is NEVER stored at rest');
    assert.strictEqual(await sp.get(a.ctx, 'ANTHROPIC_API_KEY'), PLAINTEXT, 'JIT decrypt returns plaintext');
    const bundle = await sp.bundleForRun(a.ctx);
    assert.strictEqual(bundle.ANTHROPIC_API_KEY, PLAINTEXT, 'bundle for run has the plaintext (for injection)');
    // tamper the ciphertext → decrypt fails closed (no plaintext leaks)
    await a.ctx.putSecret({ name: 'ANTHROPIC_API_KEY', ciphertext: rec!.ciphertext.slice(0, -4) + 'AAAA' });
    assert.strictEqual(await sp.get(a.ctx, 'ANTHROPIC_API_KEY'), null, 'tampered ciphertext → null, fail closed');
});

// ── webhook HMAC ─────────────────────────────────────────────────────────────────
it('webhook HMAC: valid signature passes, tampered/wrong fails', async () => {
    const secret = 'whsec_test';
    const body = JSON.stringify({ action: 'created', installation: { id: 42 } });
    const good = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert.strictEqual(verifyWebhookSignature(secret, body, good), true, 'valid HMAC accepted');
    assert.strictEqual(verifyWebhookSignature(secret, body + ' ', good), false, 'tampered body rejected');
    assert.strictEqual(verifyWebhookSignature('wrong', body, good), false, 'wrong secret rejected');
    assert.strictEqual(verifyWebhookSignature(secret, body, undefined), false, 'missing signature rejected');
});

it('webhook → tenant resolution uses OUR recorded installation, never the payload', async () => {
    const store = new InMemoryDataStore();
    const a = await onboardTenant(store, { slug: 'wh', name: 'Wh', ownerEmail: 'o@w.com' });
    await connectInstallation(a.ctx, { installationId: 999, accountLogin: 'wh' });
    assert.strictEqual(await tenantForInstallation(store, 999), a.tenant.id, 'known installation → its tenant');
    assert.strictEqual(await tenantForInstallation(store, 12345), null, 'unknown installation → null (reject)');
});

// ── GitHub App JWT (real RS256) ──────────────────────────────────────────────────
it('GitHub App JWT: real RS256 signature verifies with the public key', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const jwt = mintAppJwt({ appId: '123456', privateKeyPem: privateKey, webhookSecret: 'x' });
    const parts = jwt.split('.');
    assert.strictEqual(parts.length, 3, 'JWT has 3 parts');
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
    assert.strictEqual(header.alg, 'RS256');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2]!, 'base64url'));
    assert.ok(ok, 'signature verifies with the App public key');
    assert.strictEqual(LEAST_PRIV_PERMISSIONS.contents, 'write');
});

// ── dispatch flow (mocks) ────────────────────────────────────────────────────────
it('dispatch: repo-scoped token → JIT secrets injected → isolated sandbox → engine → teardown → meter', async () => {
    const store = new InMemoryDataStore();
    const a = await onboardTenant(store, { slug: 'run', name: 'Run', ownerEmail: 'o@r.com' });
    const inst = await connectInstallation(a.ctx, { installationId: 777, accountLogin: 'run' });
    const repo = await whitelistRepo(a.ctx, { installationId: inst.id, fullName: 'run/app', defaultBranch: 'main' });
    const sp = new EnvelopeSecretProvider();
    await storeSecret(a.ctx, sp, 'ANTHROPIC_API_KEY', 'sk-ant-xyz');

    const sandboxProvider = new MockSandboxProvider();
    const meter = new InMemoryMeter();
    let sawSecretAtRun = false; let mintedFor = '';
    const engine: Engine = {
        async run({ sandbox, config, emit }) {
            sawSecretAtRun = (sandbox as any).hasSecret?.('ANTHROPIC_API_KEY') ?? false;
            await emit('fix.done');
            assert.strictEqual(config.autoMerge, false, 'engine sees resolved config');
            return { state: 'passed', costTokens: 12345, prUrl: 'https://github.com/run/app/pull/1' };
        },
    };
    const deps: DispatchDeps = {
        store, sandbox: sandboxProvider, secrets: sp, meter, engine,
        github: { async mintRepoToken(ghId, full) { mintedFor = `${ghId}:${full}`; return 'ghs_fake'; } },
    };

    const { run } = await submitWorkItem(deps, a.ctx, { repoId: repo.id, title: 'Fix X', rawRequest: 'fix X', userId: a.owner.id });

    assert.strictEqual(run.state, 'passed', 'run completes');
    assert.strictEqual(run.costTokens, 12345, 'cost recorded on the run');
    assert.strictEqual(run.prUrl, 'https://github.com/run/app/pull/1');
    assert.strictEqual(mintedFor, '777:run/app', 'token minted scoped to THIS repo + installation');
    assert.ok(sawSecretAtRun, 'JIT secret was present inside the sandbox during the run');
    assert.strictEqual((sandboxProvider.last as any).destroyed, true, 'sandbox torn down (secrets die with it)');
    const summary = await costSummary(meter, a.tenant.id);
    assert.strictEqual(summary.runs, 1); assert.strictEqual(summary.tokens, 12345);
    const events = await a.ctx.listEvents(run.id);
    assert.ok(events.some((e) => e.type === 'run.finished'), 'events emitted for the run');
});

it('dispatch: per-tenant concurrency cap is enforced', async () => {
    const store = new InMemoryDataStore();
    const a = await onboardTenant(store, { slug: 'cap', name: 'Cap', ownerEmail: 'o@cap.com' });
    await store.setConfigRow({ tenantId: a.tenant.id, overrides: { maxConcurrentRuns: 1 }, updatedAt: '' });
    const inst = await connectInstallation(a.ctx, { installationId: 1, accountLogin: 'cap' });
    const repo = await whitelistRepo(a.ctx, { installationId: inst.id, fullName: 'cap/app', defaultBranch: 'main' });
    // seed a running run to fill the cap
    await a.ctx.createRun({ workItemId: 'seed', state: 'running', costTokens: 0 });
    const deps: DispatchDeps = {
        store, sandbox: new MockSandboxProvider(), secrets: new EnvelopeSecretProvider(), meter: new InMemoryMeter(),
        engine: { async run() { return { state: 'passed', costTokens: 0 }; } },
        github: { async mintRepoToken() { return 't'; } },
    };
    const wi = await a.ctx.createWorkItem({ repoId: repo.id, title: 't', rawRequest: 't', createdBy: a.owner.id });
    await assert.rejects(() => import('../runs/dispatch').then((m) => m.dispatchRun(deps, a.ctx, wi.id)), /concurrency cap/);
});

// ── engine robustness on cheap OpenAI-compatible models (regression guards) ─────
it('json-repair: parses a deploy artifact with literal newlines inside a string value', async () => {
    const malformed = '{"prTitle":"Add endpoint","prBody":"## Problem\nLine two\n- a bullet"}'; // real newlines inside the JSON string = invalid JSON
    assert.throws(() => JSON.parse(malformed), 'baseline: raw JSON.parse must fail on this');
    const v = parseJsonLoose<any>(malformed);
    assert.ok(v, 'repaired JSON parses');
    assert.strictEqual(v.prTitle, 'Add endpoint');
    assert.ok(v.prBody.includes('Line two'), 'multi-line body preserved');
});
it('json-repair: handles ```json fences, surrounding prose, and trailing commas', async () => {
    const v = parseJsonLoose<any>('Here you go:\n```json\n{"a":1,"b":[1,2,],}\n```\nthanks');
    assert.ok(v && v.a === 1 && Array.isArray(v.b) && v.b.length === 2, 'fenced + trailing-comma JSON parses');
});
it('openai-compat: tool-call parity sanitizer pads missing results + drops orphans', async () => {
    const msgs: any = [
        { role: 'system', content: 's' },
        { role: 'assistant', content: null, tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'code.read', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'code.search', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },          // c2 result MISSING (gated/truncated)
        { role: 'user', content: 'next' },
        { role: 'tool', tool_call_id: 'orphan', content: 'x' },       // orphan → must be dropped
    ];
    const out = sanitizeConversation(msgs);
    const userIdx = out.findIndex((m) => m.role === 'user');
    const toolsBefore = out.slice(0, userIdx).filter((m) => m.role === 'tool').map((m) => m.tool_call_id).sort();
    assert.deepStrictEqual(toolsBefore, ['c1', 'c2'], 'both tool_calls answered before the next user turn (c2 padded)');
    assert.ok(!out.some((m) => m.role === 'tool' && m.tool_call_id === 'orphan'), 'orphan tool message dropped');
});
it('openai-compat: dotted tool names are sanitized to the required pattern', async () => {
    assert.strictEqual(sanitizeToolName('code.search'), 'code_search');
    assert.ok(/^[a-zA-Z0-9_-]+$/.test(sanitizeToolName('feature.history')), 'matches ^[a-zA-Z0-9_-]+$');
});

// ── Postgres persistence (real SQL via in-process pg-mem; same code runs on OCI Postgres) ───────
it('postgres store: tenant isolation + persistence round-trip through real SQL (pg-mem)', async () => {
    const pg = newDb().adapters.createPg();
    const store = new PostgresDataStore(new pg.Pool());
    await store.init();
    const a = await onboardTenant(store, { slug: 'acme-pg', name: 'Acme', ownerEmail: 'o@acme.com' });
    const b = await onboardTenant(store, { slug: 'globex-pg', name: 'Globex', ownerEmail: 'o@globex.com' });
    const instA = await connectInstallation(a.ctx, { installationId: 9911, accountLogin: 'acme' });
    const repoA = await whitelistRepo(a.ctx, { installationId: instA.id, fullName: 'acme/app', defaultBranch: 'main' });
    const wiA = await a.ctx.createWorkItem({ repoId: repoA.id, title: 'x', rawRequest: 'x', createdBy: a.owner.id });
    // cross-tenant isolation enforced by the SQL WHERE tenant_id filter
    assert.strictEqual(await b.ctx.getWorkItem(wiA.id), null, 'cross-tenant work item read is null');
    assert.strictEqual(await b.ctx.getRepo(repoA.id), null, 'cross-tenant repo read is null');
    assert.ok(await a.ctx.getWorkItem(wiA.id), 'A reads its own back from SQL');
    assert.strictEqual(await store.getTenantBySlug('acme-pg').then((t) => t?.id), a.tenant.id, 'getTenantBySlug');
    // run + event persistence (jsonb round-trip + ordering)
    const run = await a.ctx.createRun({ workItemId: wiA.id, state: 'queued', costTokens: 0 });
    await a.ctx.appendEvent({ runId: run.id, seq: 0, ts: new Date().toISOString(), type: 'run.started' });
    await a.ctx.appendEvent({ runId: run.id, seq: 1, ts: new Date().toISOString(), type: 'stage_start', payload: { stage: 'prd' } });
    const evs = await a.ctx.listEvents(run.id);
    assert.strictEqual(evs.length, 2, 'events persisted + ordered');
    assert.strictEqual((evs[1].payload as any)?.stage, 'prd', 'jsonb payload round-trips');
    // secret upsert keeps a single row per (tenant,name)
    await store.putSecret({ tenantId: a.tenant.id, name: 'K', ciphertext: 'c1' } as any);
    await store.putSecret({ tenantId: a.tenant.id, name: 'K', ciphertext: 'c2' } as any);
    assert.strictEqual((await store.listSecrets(a.tenant.id)).length, 1, 'secret upsert kept one row');
});

// ── Razorpay billing (signature verification + credits wallet) ──────────────────
it('razorpay: payment + webhook signatures verify; wrong/tampered fail', async () => {
    const secret = 'rzp_secret_test';
    const rp = new RazorpayBilling('rzp_test_x', secret);
    const o = 'order_ABC', p = 'pay_XYZ';
    const good = crypto.createHmac('sha256', secret).update(`${o}|${p}`).digest('hex');
    assert.ok(rp.verifyPaymentSignature(o, p, good), 'valid payment signature verifies');
    const wrong = crypto.createHmac('sha256', 'OTHER').update(`${o}|${p}`).digest('hex');
    assert.ok(!rp.verifyPaymentSignature(o, p, wrong), 'wrong-secret signature fails');
    assert.ok(!rp.verifyPaymentSignature(o, p, 'deadbeef'), 'garbage signature fails');
    const body = '{"event":"payment.captured"}', ws = 'whsec';
    const wsig = crypto.createHmac('sha256', ws).update(body).digest('hex');
    assert.ok(RazorpayBilling.verifyWebhookSignature(body, wsig, ws), 'webhook signature verifies');
    assert.ok(!RazorpayBilling.verifyWebhookSignature(body + 'x', wsig, ws), 'tampered webhook body fails');
});
it('credits ledger: top-up, debit per run, floors at zero', async () => {
    const l = new InMemoryCreditsLedger();
    assert.strictEqual(await l.balance('t1'), 0);
    assert.strictEqual(await l.credit('t1', 5000, 'pay_1'), 5000, 'top-up credits');
    assert.strictEqual(await l.debit('t1', 1200, 'run_1'), 3800, 'run debits credits');
    assert.strictEqual(await l.debit('t1', 999999, 'run_2'), 0, 'balance floors at 0');
});
it('credits meter: a run debits the wallet as it burns tokens', async () => {
    const l = new InMemoryCreditsLedger();
    await l.credit('t1', 10000, 'topup');
    const meter = new CreditsMeter(new InMemoryMeter(), l, 0.01); // 1 credit / 100 tokens
    await meter.record({ tenantId: 't1', runId: 'r1', kind: 'tokens', quantity: 50000 } as any);
    await meter.record({ tenantId: 't1', runId: 'r1', kind: 'run', quantity: 1 } as any); // non-token: no debit
    assert.strictEqual(await l.balance('t1'), 9500, 'wallet debited 500 credits for 50k tokens');
    assert.strictEqual((await meter.summary('t1')).tokens, 50000, 'base meter still accounts tokens');
});

// ── runner ────────────────────────────────────────────────────────────────────
(async () => {
    let failed = 0;
    for (const [name, fn] of cases) {
        try { await fn(); console.log(`  ✓ ${name}`); }
        catch (e: any) { failed += 1; console.log(`  ✗ ${name}\n      ${e?.stack || e?.message || e}`); }
    }
    console.log('');
    if (failed) { console.log(`aidlc-platform foundation: ${failed}/${cases.length} FAILED`); process.exit(1); }
    console.log(`aidlc-platform foundation: all ${cases.length} passed`);
})();
