// OracleDataStore — persistence on OCI Autonomous Database (Oracle 23ai, Always-Free). Same DataStore
// interface as the in-mem / Postgres stores, so nothing upstream changes. Uses Oracle's native JSON column
// type + MERGE upserts, via node-oracledb THIN mode (pure JS — no Oracle Instant Client install). Tenant-
// scoped reads always filter by tenant_id (app-level isolation). Inject an oracledb Pool (see db/factory.ts).

import oracledb from 'oracledb';
import type { DataStore } from './store';
import { newId } from './store';
import type {
    Tenant, User, Installation, Repo, WorkItem, Run, RunEvent, SecretRecord, TenantConfigRow,
} from '../types';

const now = (): string => new Date().toISOString();
const J = (o: any) => ({ val: o, type: oracledb.DB_TYPE_JSON });        // bind a JS object to a JSON column
const dataOf = <T>(r: any): T => { const d = r?.DATA; return (typeof d === 'string' ? JSON.parse(d) : d) as T; };
const rowsData = <T>(rs: any[]): T[] => rs.map((r) => dataOf<T>(r));
const first = <T>(rs: any[]): T | null => (rs[0] ? dataOf<T>(rs[0]) : null);

// 23ai supports CREATE TABLE/INDEX IF NOT EXISTS; init() also tolerates ORA-00955 (already exists) as a backstop.
const SCHEMA: string[] = [
    `CREATE TABLE IF NOT EXISTS tenants       (id VARCHAR2(64) PRIMARY KEY, slug VARCHAR2(255) UNIQUE, created_at VARCHAR2(40), data JSON)`,
    `CREATE TABLE IF NOT EXISTS users         (id VARCHAR2(64) PRIMARY KEY, tenant_id VARCHAR2(64), created_at VARCHAR2(40), data JSON)`,
    `CREATE TABLE IF NOT EXISTS installations (id VARCHAR2(64) PRIMARY KEY, tenant_id VARCHAR2(64), gh_install_id NUMBER, created_at VARCHAR2(40), data JSON)`,
    `CREATE TABLE IF NOT EXISTS repos         (id VARCHAR2(64) PRIMARY KEY, tenant_id VARCHAR2(64), created_at VARCHAR2(40), data JSON)`,
    `CREATE TABLE IF NOT EXISTS work_items    (id VARCHAR2(64) PRIMARY KEY, tenant_id VARCHAR2(64), created_at VARCHAR2(40), data JSON)`,
    `CREATE TABLE IF NOT EXISTS runs          (id VARCHAR2(64) PRIMARY KEY, tenant_id VARCHAR2(64), work_item_id VARCHAR2(64), created_at VARCHAR2(40), updated_at VARCHAR2(40), data JSON)`,
    `CREATE TABLE IF NOT EXISTS run_events    (id VARCHAR2(64) PRIMARY KEY, tenant_id VARCHAR2(64), run_id VARCHAR2(64), seq NUMBER, data JSON)`,
    `CREATE TABLE IF NOT EXISTS secrets       (id VARCHAR2(64) PRIMARY KEY, tenant_id VARCHAR2(64), name VARCHAR2(255), created_at VARCHAR2(40), data JSON, CONSTRAINT uq_secret UNIQUE (tenant_id, name))`,
    `CREATE TABLE IF NOT EXISTS tenant_configs(tenant_id VARCHAR2(64) PRIMARY KEY, updated_at VARCHAR2(40), data JSON)`,
    `CREATE INDEX IF NOT EXISTS ix_users_t  ON users(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS ix_inst_t   ON installations(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS ix_inst_gh  ON installations(gh_install_id)`,
    `CREATE INDEX IF NOT EXISTS ix_repos_t  ON repos(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS ix_wi_t     ON work_items(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS ix_runs_t   ON runs(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS ix_ev_run   ON run_events(tenant_id, run_id, seq)`,
    `CREATE INDEX IF NOT EXISTS ix_sec_t    ON secrets(tenant_id)`,
];

export class OracleDataStore implements DataStore {
    constructor(private readonly pool: oracledb.Pool) {}
    private async q(sql: string, binds: Record<string, any> = {}): Promise<any[]> {
        const c = await this.pool.getConnection();
        try {
            const r = await c.execute(sql, binds, { autoCommit: true, outFormat: oracledb.OUT_FORMAT_OBJECT });
            return (r.rows as any[]) || [];
        } finally { await c.close(); }
    }
    async init(): Promise<void> {
        for (const stmt of SCHEMA) {
            try { await this.q(stmt); }
            catch (e: any) { if (!/ORA-00955|ORA-01408|already (exists|used)/i.test(String(e?.message))) throw e; }
        }
    }

    // tenants (global)
    async createTenant(t: Omit<Tenant, 'id' | 'createdAt'>): Promise<Tenant> {
        const full = { ...t, id: newId('ten'), createdAt: now() } as Tenant;
        await this.q('INSERT INTO tenants(id,slug,created_at,data) VALUES(:id,:slug,:ca,:data)', { id: full.id, slug: full.slug, ca: full.createdAt, data: J(full) });
        return full;
    }
    async getTenant(id: string): Promise<Tenant | null> { return first<Tenant>(await this.q('SELECT data FROM tenants WHERE id=:id', { id })); }
    async getTenantBySlug(slug: string): Promise<Tenant | null> { return first<Tenant>(await this.q('SELECT data FROM tenants WHERE slug=:slug', { slug })); }

    // users
    async createUser(u: Omit<User, 'id' | 'createdAt'>): Promise<User> {
        const full = { ...u, id: newId('usr'), createdAt: now() } as User;
        await this.q('INSERT INTO users(id,tenant_id,created_at,data) VALUES(:id,:t,:ca,:data)', { id: full.id, t: full.tenantId, ca: full.createdAt, data: J(full) });
        return full;
    }
    async getUser(tenantId: string, id: string): Promise<User | null> { return first<User>(await this.q('SELECT data FROM users WHERE id=:id AND tenant_id=:t', { id, t: tenantId })); }
    async getUserByEmail(email: string): Promise<User | null> { return first<User>(await this.q(`SELECT data FROM users WHERE LOWER(JSON_VALUE(data, '$.email'))=LOWER(:em) FETCH FIRST 1 ROW ONLY`, { em: email.trim() })); }
    async listUsers(tenantId: string): Promise<User[]> { return rowsData<User>(await this.q('SELECT data FROM users WHERE tenant_id=:t', { t: tenantId })); }

    // installations
    async createInstallation(i: Omit<Installation, 'id' | 'createdAt'>): Promise<Installation> {
        const full = { ...i, id: newId('ins'), createdAt: now() } as Installation;
        await this.q('INSERT INTO installations(id,tenant_id,gh_install_id,created_at,data) VALUES(:id,:t,:gh,:ca,:data)', { id: full.id, t: full.tenantId, gh: full.installationId, ca: full.createdAt, data: J(full) });
        return full;
    }
    async getInstallationByGh(installationId: number): Promise<Installation | null> { return first<Installation>(await this.q('SELECT data FROM installations WHERE gh_install_id=:gh', { gh: installationId })); }
    async listInstallations(tenantId: string): Promise<Installation[]> { return rowsData<Installation>(await this.q('SELECT data FROM installations WHERE tenant_id=:t', { t: tenantId })); }

    // repos
    async createRepo(r: Omit<Repo, 'id' | 'createdAt'>): Promise<Repo> {
        const full = { ...r, id: newId('repo'), createdAt: now() } as Repo;
        await this.q('INSERT INTO repos(id,tenant_id,created_at,data) VALUES(:id,:t,:ca,:data)', { id: full.id, t: full.tenantId, ca: full.createdAt, data: J(full) });
        return full;
    }
    async getRepo(tenantId: string, id: string): Promise<Repo | null> { return first<Repo>(await this.q('SELECT data FROM repos WHERE id=:id AND tenant_id=:t', { id, t: tenantId })); }
    async listRepos(tenantId: string): Promise<Repo[]> { return rowsData<Repo>(await this.q('SELECT data FROM repos WHERE tenant_id=:t', { t: tenantId })); }

    // work items
    async createWorkItem(w: Omit<WorkItem, 'id' | 'createdAt'>): Promise<WorkItem> {
        const full = { ...w, id: newId('wi'), createdAt: now() } as WorkItem;
        await this.q('INSERT INTO work_items(id,tenant_id,created_at,data) VALUES(:id,:t,:ca,:data)', { id: full.id, t: full.tenantId, ca: full.createdAt, data: J(full) });
        return full;
    }
    async getWorkItem(tenantId: string, id: string): Promise<WorkItem | null> { return first<WorkItem>(await this.q('SELECT data FROM work_items WHERE id=:id AND tenant_id=:t', { id, t: tenantId })); }
    async listWorkItems(tenantId: string, opts?: { limit?: number; offset?: number }): Promise<{ items: WorkItem[]; total: number }> {
        const offset = Math.max(0, opts?.offset ?? 0), limit = Math.min(100, Math.max(1, opts?.limit ?? 20));
        const total = Number((await this.q('SELECT count(*) AS N FROM work_items WHERE tenant_id=:t', { t: tenantId }))[0]?.N || 0);
        const items = rowsData<WorkItem>(await this.q('SELECT data FROM work_items WHERE tenant_id=:t ORDER BY created_at DESC OFFSET :o ROWS FETCH NEXT :l ROWS ONLY', { t: tenantId, o: offset, l: limit }));
        return { items, total };
    }

    // runs
    async createRun(r: Omit<Run, 'id' | 'createdAt' | 'updatedAt'>): Promise<Run> {
        const ts = now(); const full = { ...r, id: newId('run'), createdAt: ts, updatedAt: ts } as Run;
        await this.q('INSERT INTO runs(id,tenant_id,work_item_id,created_at,updated_at,data) VALUES(:id,:t,:wi,:ca,:ua,:data)', { id: full.id, t: full.tenantId, wi: full.workItemId, ca: full.createdAt, ua: full.updatedAt, data: J(full) });
        return full;
    }
    async getRun(tenantId: string, id: string): Promise<Run | null> { return first<Run>(await this.q('SELECT data FROM runs WHERE id=:id AND tenant_id=:t', { id, t: tenantId })); }
    async updateRun(tenantId: string, id: string, patch: Partial<Run>): Promise<Run> {
        const cur = await this.getRun(tenantId, id);
        if (!cur) throw new Error(`run not found in tenant: ${id}`);
        const next = { ...cur, ...patch, id: cur.id, tenantId: cur.tenantId, updatedAt: now() } as Run;
        await this.q('UPDATE runs SET updated_at=:ua, data=:data WHERE id=:id AND tenant_id=:t', { ua: next.updatedAt, data: J(next), id, t: tenantId });
        return next;
    }
    async listRuns(tenantId: string): Promise<Run[]> { return rowsData<Run>(await this.q('SELECT data FROM runs WHERE tenant_id=:t', { t: tenantId })); }

    // events
    async appendEvent(e: Omit<RunEvent, 'id'>): Promise<RunEvent> {
        const full = { ...e, id: newId('ev') } as RunEvent;
        await this.q('INSERT INTO run_events(id,tenant_id,run_id,seq,data) VALUES(:id,:t,:r,:s,:data)', { id: full.id, t: full.tenantId, r: full.runId, s: full.seq, data: J(full) });
        return full;
    }
    async listEvents(tenantId: string, runId: string): Promise<RunEvent[]> {
        return rowsData<RunEvent>(await this.q('SELECT data FROM run_events WHERE tenant_id=:t AND run_id=:r ORDER BY seq ASC', { t: tenantId, r: runId }));
    }

    // secrets (ciphertext only) — MERGE upsert by (tenant,name)
    async putSecret(s: Omit<SecretRecord, 'id' | 'createdAt'>): Promise<SecretRecord> {
        const existing = await this.getSecret(s.tenantId, s.name);
        const full = { ...s, id: existing?.id ?? newId('sec'), createdAt: existing?.createdAt ?? now() } as SecretRecord;
        await this.q(
            `MERGE INTO secrets d USING (SELECT :t AS tenant_id, :nm AS name FROM dual) x
             ON (d.tenant_id = x.tenant_id AND d.name = x.name)
             WHEN MATCHED THEN UPDATE SET data = :data
             WHEN NOT MATCHED THEN INSERT (id,tenant_id,name,created_at,data) VALUES (:id,:t,:nm,:ca,:data)`,
            { t: full.tenantId, nm: full.name, data: J(full), id: full.id, ca: full.createdAt },
        );
        return full;
    }
    async getSecret(tenantId: string, name: string): Promise<SecretRecord | null> { return first<SecretRecord>(await this.q('SELECT data FROM secrets WHERE tenant_id=:t AND name=:nm', { t: tenantId, nm: name })); }
    async listSecrets(tenantId: string): Promise<SecretRecord[]> { return rowsData<SecretRecord>(await this.q('SELECT data FROM secrets WHERE tenant_id=:t', { t: tenantId })); }

    // config overrides — MERGE upsert by tenant
    async getConfigRow(tenantId: string): Promise<TenantConfigRow | null> { return first<TenantConfigRow>(await this.q('SELECT data FROM tenant_configs WHERE tenant_id=:t', { t: tenantId })); }
    async setConfigRow(row: TenantConfigRow): Promise<TenantConfigRow> {
        const full = { ...row, updatedAt: now() } as TenantConfigRow;
        await this.q(
            `MERGE INTO tenant_configs d USING (SELECT :t AS tenant_id FROM dual) x
             ON (d.tenant_id = x.tenant_id)
             WHEN MATCHED THEN UPDATE SET updated_at = :ua, data = :data
             WHEN NOT MATCHED THEN INSERT (tenant_id,updated_at,data) VALUES (:t,:ua,:data)`,
            { t: full.tenantId, ua: full.updatedAt, data: J(full) },
        );
        return full;
    }
}
