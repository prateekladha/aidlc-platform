/**
 * Characterisation test for work-item search + pagination (the store contract the ops list uses). Runs the
 * in-memory store (the Arango store uses an ArangoSearch view for the same contract). No DB:
 *
 *   npx ts-node src/agent/orchestrator/workItemSearch.test.ts
 */
import assert from 'assert';
import { InMemoryWorkItemStore } from './workItemStore.memory';
import type { WorkItem } from './types';

const cases: Array<[string, () => Promise<void>]> = [];
const it = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

async function seed(n: number) {
    const store = new InMemoryWorkItemStore();
    for (let i = 0; i < n; i++) {
        await store.create({
            title: i === 0 ? 'Add host+venue revenue split' : `Work item ${i}`,
            status: { stage: 'triage', state: i % 2 ? 'running' : 'passed' },
            targetRepo: i === 0 ? 'perpetuumhq/perpettum-backend' : 'perpetuumhq/perpetuum-reve-growth-site',
            origin: { requester: 'ops', channel: 'web', rawRequest: i === 0 ? 'split the venue cut on paid tickets' : `request ${i}` },
        } as any);
    }
    return store;
}

it('paginates: total reflects all, page returns the slice', async () => {
    const store = await seed(25);
    const p0 = await store.search({ limit: 10, offset: 0 });
    assert.strictEqual(p0.total, 25);
    assert.strictEqual(p0.items.length, 10);
    const p2 = await store.search({ limit: 10, offset: 20 });
    assert.strictEqual(p2.items.length, 5, 'last page has the remainder');
});

it('search matches title + request tokens (not substring of unrelated words)', async () => {
    const store = await seed(25);
    const r = await store.search({ q: 'venue split' });
    assert.ok(r.items.length >= 1, 'finds the revenue-split item');
    assert.ok(r.items.some((w: WorkItem) => w.title.includes('revenue split')));
    const none = await store.search({ q: 'zzzznomatch' });
    assert.strictEqual(none.total, 0);
});

it('filters by state alongside search', async () => {
    const store = await seed(10);
    const r = await store.search({ state: 'passed' as any });
    assert.ok(r.items.every((w: WorkItem) => w.status.state === 'passed'));
    assert.ok(r.total > 0 && r.total < 10);
});

(async () => {
    let failed = 0;
    for (const [name, fn] of cases) {
        try { await fn(); console.log(`  ✓ ${name}`); }
        catch (e: any) { failed += 1; console.log(`  ✗ ${name}\n      ${e?.message || e}`); }
    }
    console.log('');
    if (failed) { console.log(`work-item search test: ${failed}/${cases.length} FAILED`); process.exit(1); }
    console.log(`work-item search test: all ${cases.length} passed`);
})();
