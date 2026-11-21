// PostgresDataStore — the Phase-1 persistence impl of the DataStore seam. Same interface as InMemoryDataStore,
// so nothing upstream changes. Each entity is a row of { id, tenant_id, created_at, <query cols>, data jsonb }:
// the full object lives in `data` (evolution-proof vs the nested WorkItem/Run shapes), with a few extracted
// columns for the queries that need them. Tenant-scoped reads ALWAYS filter by tenant_id in SQL (app-level
// isolation, identical to the in-mem store); RLS (applyRls) adds DB-level enforcement in production.
//
// Injectable with any pg-compatible Pool: a real `pg` Pool (DATABASE_URL → OCI Postgres) in prod, or pg-mem's
// in-process Pool in tests. Call init() once to create the schema.

import type { DataStore, } from './store';
import { newId } from './store';
import type {
    Tenant, User, Installation, Repo, WorkItem, Run, RunEvent, SecretRecord, TenantConfigRow,
} from '../types';

export interface SqlPool { query(sql: string, params?: any[]): Promise<{ rows: any[] }>; }

const now = (): string => new Date().toISOString();
const parse = <T>(d: any): T => (typeof d === 'string' ? JSON.parse(d) : d) as T;
const rows = <T>(r: { rows: any[] }, col = 'data'): T[] => r.rows.map((x) => parse<T>(x[col]));
const one = <T>(r: { rows: any[] }, col = 'data'): T | null => (r.rows[0] ? parse<T>(r.rows[0][col]) : null);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants       (id text PRIMARY KEY, slug text UNIQUE, created_at text, data jsonb);
CREATE TABLE IF NOT EXISTS users         (id text PRIMARY KEY, tenant_id text, created_at text, data jsonb);
CREATE TABLE IF NOT EXISTS installations (id text PRIMARY KEY, tenant_id text, gh_install_id bigint, created_at text, data jsonb);
CREATE TABLE IF NOT EXISTS repos         (id text PRIMARY KEY, tenant_id text, created_at text, data jsonb);
CREATE TABLE IF NOT EXISTS work_items    (id text PRIMARY KEY, tenant_id text, created_at text, data jsonb);
CREATE TABLE IF NOT EXISTS runs          (id text PRIMARY KEY, tenant_id text, work_item_id text, created_at text, updated_at text, data jsonb);
CREATE TABLE IF NOT EXISTS run_events    (id text PRIMARY KEY, tenant_id text, run_id text, seq int, data jsonb);
CREATE TABLE IF NOT EXISTS secrets       (id text PRIMARY KEY, tenant_id text, name text, created_at text, data jsonb, UNIQUE (tenant_id, name));
CREATE TABLE IF NOT EXISTS tenant_configs(tenant_id text PRIMARY KEY, updated_at text, data jsonb);
CREATE INDEX IF NOT EXISTS ix_users_t  ON users(tenant_id);
CREATE INDEX IF NOT EXISTS ix_inst_t   ON installations(tenant_id);
CREATE INDEX IF NOT EXISTS ix_inst_gh  ON installations(gh_install_id);
CREATE INDEX IF NOT EXISTS ix_repos_t  ON repos(tenant_id);
CREATE INDEX IF NOT EXISTS ix_wi_t     ON work_items(tenant_id);
CREATE INDEX IF NOT EXISTS ix_runs_t   ON runs(tenant_id);
CREATE INDEX IF NOT EXISTS ix_ev_run   ON run_events(tenant_id, run_id, seq);
CREATE INDEX IF NOT EXISTS ix_sec_t    ON secrets(tenant_id);
`;

// Production-only defense-in-depth: row-level security keyed to a per-connection tenant id. The app also
// filters by tenant_id in every query, so this is belt-and-suspenders. (pg-mem doesn't support RLS, so it is
// applied separately, not in init().)
export const RLS_SQL = `
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['users','installations','repos','work_items','runs','run_events','secrets','tenant_configs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true))', t);
  END LOOP;
END $$;`;

export class PostgresDataStore implements DataStore {
    constructor(private readonly pool: SqlPool) {}
    async init(): Promise<void> { await this.pool.query(SCHEMA); }
    /** Production only: enable RLS policies. No-op-safe to skip in dev/pg-mem. */
    async applyRls(): Promise<void> { await this.pool.query(RLS_SQL); }
    private q(sql: string, params?: any[]) { return this.pool.query(sql, params); }

    // tenants (global)
    async createTenant(t: Omit<Tenant, 'id' | 'createdAt'>): Promise<Tenant> {
        const full: Tenant = { ...t, id: newId('ten'), createdAt: now() } as Tenant;
        await this.q('INSERT INTO tenants(id,slug,created_at,data) VALUES($1,$2,$3,$4)', [full.id, full.slug, full.createdAt, JSON.stringify(full)]);
        return full;
    }
    async getTenant(id: string): Promise<Tenant | null> { return one<Tenant>(await this.q('SELECT data FROM tenants WHERE id=$1', [id])); }
    async getTenantBySlug(slug: string): Promise<Tenant | null> { return one<Tenant>(await this.q('SELECT data FROM tenants WHERE slug=$1', [slug])); }

    // users
    async createUser(u: Omit<User, 'id' | 'createdAt'>): Promise<User> {
        const full: User = { ...u, id: newId('usr'), createdAt: now() } as User;
        await this.q('INSERT INTO users(id,tenant_id,created_at,data) VALUES($1,$2,$3,$4)', [full.id, full.tenantId, full.createdAt, JSON.stringify(full)]);
        return full;
    }
    async getUser(tenantId: string, id: string): Promise<User | null> { return one<User>(await this.q('SELECT data FROM users WHERE id=$1 AND tenant_id=$2', [id, tenantId])); }
    async listUsers(tenantId: string): Promise<User[]> { return rows<User>(await this.q('SELECT data FROM users WHERE tenant_id=$1', [tenantId])); }

    // installations
    async createInstallation(i: Omit<Installation, 'id' | 'createdAt'>): Promise<Installation> {
        const full: Installation = { ...i, id: newId('ins'), createdAt: now() } as Installation;
        await this.q('INSERT INTO installations(id,tenant_id,gh_install_id,created_at,data) VALUES($1,$2,$3,$4,$5)', [full.id, full.tenantId, full.installationId, full.createdAt, JSON.stringify(full)]);
        return full;
    }
    async getInstallationByGh(installationId: number): Promise<Installation | null> { return one<Installation>(await this.q('SELECT data FROM installations WHERE gh_install_id=$1', [installationId])); }
    async listInstallations(tenantId: string): Promise<Installation[]> { return rows<Installation>(await this.q('SELECT data FROM installations WHERE tenant_id=$1', [tenantId])); }

    // repos
    async createRepo(r: Omit<Repo, 'id' | 'createdAt'>): Promise<Repo> {
        const full: Repo = { ...r, id: newId('repo'), createdAt: now() } as Repo;
        await this.q('INSERT INTO repos(id,tenant_id,created_at,data) VALUES($1,$2,$3,$4)', [full.id, full.tenantId, full.createdAt, JSON.stringify(full)]);
        return full;
    }
    async getRepo(tenantId: string, id: string): Promise<Repo | null> { return one<Repo>(await this.q('SELECT data FROM repos WHERE id=$1 AND tenant_id=$2', [id, tenantId])); }
    async listRepos(tenantId: string): Promise<Repo[]> { return rows<Repo>(await this.q('SELECT data FROM repos WHERE tenant_id=$1', [tenantId])); }

    // work items
    async createWorkItem(w: Omit<WorkItem, 'id' | 'createdAt'>): Promise<WorkItem> {
        const full: WorkItem = { ...w, id: newId('wi'), createdAt: now() } as WorkItem;
        await this.q('INSERT INTO work_items(id,tenant_id,created_at,data) VALUES($1,$2,$3,$4)', [full.id, full.tenantId, full.createdAt, JSON.stringify(full)]);
        return full;
    }
    async getWorkItem(tenantId: string, id: string): Promise<WorkItem | null> { return one<WorkItem>(await this.q('SELECT data FROM work_items WHERE id=$1 AND tenant_id=$2', [id, tenantId])); }
    async listWorkItems(tenantId: string, opts?: { limit?: number; offset?: number }): Promise<{ items: WorkItem[]; total: number }> {
        const offset = Math.max(0, opts?.offset ?? 0), limit = Math.min(100, Math.max(1, opts?.limit ?? 20));
        const total = Number((await this.q('SELECT count(*)::int AS n FROM work_items WHERE tenant_id=$1', [tenantId])).rows[0]?.n || 0);
        const items = rows<WorkItem>(await this.q('SELECT data FROM work_items WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [tenantId, limit, offset]));
        return { items, total };
    }

    // runs
    async createRun(r: Omit<Run, 'id' | 'createdAt' | 'updatedAt'>): Promise<Run> {
        const ts = now(); const full: Run = { ...r, id: newId('run'), createdAt: ts, updatedAt: ts } as Run;
        await this.q('INSERT INTO runs(id,tenant_id,work_item_id,created_at,updated_at,data) VALUES($1,$2,$3,$4,$5,$6)', [full.id, full.tenantId, full.workItemId, full.createdAt, full.updatedAt, JSON.stringify(full)]);
        return full;
    }
    async getRun(tenantId: string, id: string): Promise<Run | null> { return one<Run>(await this.q('SELECT data FROM runs WHERE id=$1 AND tenant_id=$2', [id, tenantId])); }
    async updateRun(tenantId: string, id: string, patch: Partial<Run>): Promise<Run> {
        const cur = await this.getRun(tenantId, id);
        if (!cur) throw new Error(`run not found in tenant: ${id}`);
        const next: Run = { ...cur, ...patch, id: cur.id, tenantId: cur.tenantId, updatedAt: now() };
        await this.q('UPDATE runs SET updated_at=$1, data=$2 WHERE id=$3 AND tenant_id=$4', [next.updatedAt, JSON.stringify(next), id, tenantId]);
        return next;
    }
    async listRuns(tenantId: string): Promise<Run[]> { return rows<Run>(await this.q('SELECT data FROM runs WHERE tenant_id=$1', [tenantId])); }

    // events
    async appendEvent(e: Omit<RunEvent, 'id'>): Promise<RunEvent> {
        const full: RunEvent = { ...e, id: newId('ev') } as RunEvent;
        await this.q('INSERT INTO run_events(id,tenant_id,run_id,seq,data) VALUES($1,$2,$3,$4,$5)', [full.id, full.tenantId, full.runId, full.seq, JSON.stringify(full)]);
        return full;
    }
    async listEvents(tenantId: string, runId: string): Promise<RunEvent[]> {
        return rows<RunEvent>(await this.q('SELECT data FROM run_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY seq ASC', [tenantId, runId]));
    }

    // secrets (ciphertext only)
    async putSecret(s: Omit<SecretRecord, 'id' | 'createdAt'>): Promise<SecretRecord> {
        const existing = await this.getSecret(s.tenantId, s.name);
        const full: SecretRecord = { ...s, id: existing?.id ?? newId('sec'), createdAt: existing?.createdAt ?? now() } as SecretRecord;
        await this.q(
            `INSERT INTO secrets(id,tenant_id,name,created_at,data) VALUES($1,$2,$3,$4,$5)
             ON CONFLICT (tenant_id,name) DO UPDATE SET data=EXCLUDED.data`,
            [full.id, full.tenantId, full.name, full.createdAt, JSON.stringify(full)],
        );
        return full;
    }
    async getSecret(tenantId: string, name: string): Promise<SecretRecord | null> { return one<SecretRecord>(await this.q('SELECT data FROM secrets WHERE tenant_id=$1 AND name=$2', [tenantId, name])); }
    async listSecrets(tenantId: string): Promise<SecretRecord[]> { return rows<SecretRecord>(await this.q('SELECT data FROM secrets WHERE tenant_id=$1', [tenantId])); }

    // config overrides
    async getConfigRow(tenantId: string): Promise<TenantConfigRow | null> { return one<TenantConfigRow>(await this.q('SELECT data FROM tenant_configs WHERE tenant_id=$1', [tenantId])); }
    async setConfigRow(row: TenantConfigRow): Promise<TenantConfigRow> {
        const full: TenantConfigRow = { ...row, updatedAt: now() } as TenantConfigRow;
        await this.q(
            `INSERT INTO tenant_configs(tenant_id,updated_at,data) VALUES($1,$2,$3)
             ON CONFLICT (tenant_id) DO UPDATE SET updated_at=EXCLUDED.updated_at, data=EXCLUDED.data`,
            [full.tenantId, full.updatedAt, JSON.stringify(full)],
        );
        return full;
    }
}
