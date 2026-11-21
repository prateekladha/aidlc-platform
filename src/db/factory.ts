// Store factory — the one place that chooses persistence. Set DATABASE_URL (→ OCI Postgres in prod) to
// persist to Postgres; otherwise the in-memory store runs (dev / tests / the demo). Same DataStore interface
// either way, so nothing upstream changes. RLS is opt-in (AIDLC_APPLY_RLS=1) and only safe once the request
// path sets `app.tenant_id` per connection — app-level tenant filtering already enforces isolation regardless.

import type { DataStore } from './store';
import { InMemoryDataStore } from './store';

export async function makeStore(): Promise<DataStore> {
    const url = process.env.DATABASE_URL;
    if (!url) return new InMemoryDataStore();
    const { Pool } = await import('pg');
    const { PostgresDataStore } = await import('./store.postgres');
    const pool = new Pool({ connectionString: url });
    const store = new PostgresDataStore(pool as any);
    await store.init();
    if (process.env.AIDLC_APPLY_RLS === '1') await store.applyRls();
    // eslint-disable-next-line no-console
    console.log('[store] Postgres (DATABASE_URL)' + (process.env.AIDLC_APPLY_RLS === '1' ? ' + RLS' : ''));
    return store;
}
