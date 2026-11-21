// Live integration check: run isolation + persistence through OracleDataStore against the OCI ADB.
import assert from 'node:assert';
import { makeStore } from './factory';
import { onboardTenant, connectInstallation, whitelistRepo } from '../service';
(async () => {
    const store = await makeStore(); // → OracleDataStore (ORACLE_CONNECT_STRING set)
    const s = Date.now().toString(36);
    const a = await onboardTenant(store, { slug: 'acme-' + s, name: 'Acme', ownerEmail: 'o@a.com' });
    const b = await onboardTenant(store, { slug: 'glob-' + s, name: 'Globex', ownerEmail: 'o@g.com' });
    const inst = await connectInstallation(a.ctx, { installationId: Date.now() % 1_000_000_000, accountLogin: 'acme' });
    const repo = await whitelistRepo(a.ctx, { installationId: inst.id, fullName: 'acme/app', defaultBranch: 'main' });
    const wi = await a.ctx.createWorkItem({ repoId: repo.id, title: 'x', rawRequest: 'x', createdBy: a.owner.id });
    assert.strictEqual(await b.ctx.getWorkItem(wi.id), null, 'cross-tenant isolation');
    assert.ok(await a.ctx.getWorkItem(wi.id), 'self read');
    assert.strictEqual((await store.getTenantBySlug('acme-' + s))?.id, a.tenant.id, 'getTenantBySlug');
    const run = await a.ctx.createRun({ workItemId: wi.id, state: 'queued', costTokens: 0 });
    await a.ctx.appendEvent({ runId: run.id, seq: 0, ts: new Date().toISOString(), type: 'run.started' });
    await a.ctx.appendEvent({ runId: run.id, seq: 1, ts: new Date().toISOString(), type: 'stage_start', payload: { stage: 'prd' } });
    const evs = await a.ctx.listEvents(run.id);
    assert.strictEqual(evs.length, 2, 'events persisted + ordered');
    assert.strictEqual((evs[1].payload as any)?.stage, 'prd', 'JSON payload round-trips');
    await store.putSecret({ tenantId: a.tenant.id, name: 'K', ciphertext: 'c1' } as any);
    await store.putSecret({ tenantId: a.tenant.id, name: 'K', ciphertext: 'c2' } as any);
    assert.strictEqual((await store.listSecrets(a.tenant.id)).length, 1, 'secret MERGE upsert kept one row');
    const r2 = await a.ctx.updateRun ? await store.updateRun(a.tenant.id, run.id, { state: 'passed', costTokens: 123 }) : null;
    assert.strictEqual(r2?.state, 'passed', 'run update persisted');
    console.log('\n✅ Oracle ADB store: isolation + run/event JSON round-trip + MERGE upsert + update — ALL PASS');
    process.exit(0);
})().catch((e) => { console.error('\n✗ Oracle check FAILED:', e?.message || e); process.exit(1); });
