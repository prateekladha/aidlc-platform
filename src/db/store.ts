// DataStore — the persistence seam. This in-memory impl validates the schema + powers tests; the Phase-1
// Postgres impl (Drizzle/pg) implements the SAME interface, so stage/handler logic never changes. Every
// tenant-scoped method takes tenantId explicitly; the TenantContext (tenancy/context.ts) is the ONLY thing
// handlers touch, and it injects + verifies tenantId so cross-tenant access is structurally impossible.

import type {
    Tenant, User, Installation, Repo, WorkItem, Run, RunEvent, SecretRecord, TenantConfigRow,
} from '../types';

let seq = 0;
export const newId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;
const now = (): string => new Date().toISOString();
const clone = <T>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)));

export interface DataStore {
    // tenants (global)
    createTenant(t: Omit<Tenant, 'id' | 'createdAt'>): Promise<Tenant>;
    getTenant(id: string): Promise<Tenant | null>;
    getTenantBySlug(slug: string): Promise<Tenant | null>;
    // users
    createUser(u: Omit<User, 'id' | 'createdAt'>): Promise<User>;
    getUser(tenantId: string, id: string): Promise<User | null>;
    listUsers(tenantId: string): Promise<User[]>;
    // installations
    createInstallation(i: Omit<Installation, 'id' | 'createdAt'>): Promise<Installation>;
    getInstallationByGh(installationId: number): Promise<Installation | null>; // global — webhook resolves → tenant
    listInstallations(tenantId: string): Promise<Installation[]>;
    // repos
    createRepo(r: Omit<Repo, 'id' | 'createdAt'>): Promise<Repo>;
    getRepo(tenantId: string, id: string): Promise<Repo | null>;
    listRepos(tenantId: string): Promise<Repo[]>;
    // work items
    createWorkItem(w: Omit<WorkItem, 'id' | 'createdAt'>): Promise<WorkItem>;
    getWorkItem(tenantId: string, id: string): Promise<WorkItem | null>;
    listWorkItems(tenantId: string, opts?: { limit?: number; offset?: number }): Promise<{ items: WorkItem[]; total: number }>;
    // runs
    createRun(r: Omit<Run, 'id' | 'createdAt' | 'updatedAt'>): Promise<Run>;
    getRun(tenantId: string, id: string): Promise<Run | null>;
    updateRun(tenantId: string, id: string, patch: Partial<Run>): Promise<Run>;
    listRuns(tenantId: string): Promise<Run[]>;
    // events
    appendEvent(e: Omit<RunEvent, 'id'>): Promise<RunEvent>;
    listEvents(tenantId: string, runId: string): Promise<RunEvent[]>;
    // secrets (ciphertext only ever stored here)
    putSecret(s: Omit<SecretRecord, 'id' | 'createdAt'>): Promise<SecretRecord>;
    getSecret(tenantId: string, name: string): Promise<SecretRecord | null>;
    listSecrets(tenantId: string): Promise<SecretRecord[]>;
    // config overrides
    getConfigRow(tenantId: string): Promise<TenantConfigRow | null>;
    setConfigRow(row: TenantConfigRow): Promise<TenantConfigRow>;
}

export class InMemoryDataStore implements DataStore {
    private tenants = new Map<string, Tenant>();
    private users = new Map<string, User>();
    private installs = new Map<string, Installation>();
    private repos = new Map<string, Repo>();
    private workItems = new Map<string, WorkItem>();
    private runs = new Map<string, Run>();
    private events: RunEvent[] = [];
    private secrets = new Map<string, SecretRecord>();
    private configs = new Map<string, TenantConfigRow>();

    async createTenant(t: Omit<Tenant, 'id' | 'createdAt'>): Promise<Tenant> {
        const full: Tenant = { ...t, id: newId('ten'), createdAt: now() };
        this.tenants.set(full.id, full); return clone(full);
    }
    async getTenant(id: string): Promise<Tenant | null> { return clone(this.tenants.get(id) ?? null); }
    async getTenantBySlug(slug: string): Promise<Tenant | null> {
        return clone([...this.tenants.values()].find((t) => t.slug === slug) ?? null);
    }

    async createUser(u: Omit<User, 'id' | 'createdAt'>): Promise<User> {
        const full: User = { ...u, id: newId('usr'), createdAt: now() };
        this.users.set(full.id, full); return clone(full);
    }
    async getUser(tenantId: string, id: string): Promise<User | null> {
        const u = this.users.get(id); return u && u.tenantId === tenantId ? clone(u) : null;
    }
    async listUsers(tenantId: string): Promise<User[]> {
        return [...this.users.values()].filter((u) => u.tenantId === tenantId).map(clone);
    }

    async createInstallation(i: Omit<Installation, 'id' | 'createdAt'>): Promise<Installation> {
        const full: Installation = { ...i, id: newId('ins'), createdAt: now() };
        this.installs.set(full.id, full); return clone(full);
    }
    async getInstallationByGh(installationId: number): Promise<Installation | null> {
        return clone([...this.installs.values()].find((i) => i.installationId === installationId) ?? null);
    }
    async listInstallations(tenantId: string): Promise<Installation[]> {
        return [...this.installs.values()].filter((i) => i.tenantId === tenantId).map(clone);
    }

    async createRepo(r: Omit<Repo, 'id' | 'createdAt'>): Promise<Repo> {
        const full: Repo = { ...r, id: newId('repo'), createdAt: now() };
        this.repos.set(full.id, full); return clone(full);
    }
    async getRepo(tenantId: string, id: string): Promise<Repo | null> {
        const r = this.repos.get(id); return r && r.tenantId === tenantId ? clone(r) : null;
    }
    async listRepos(tenantId: string): Promise<Repo[]> {
        return [...this.repos.values()].filter((r) => r.tenantId === tenantId).map(clone);
    }

    async createWorkItem(w: Omit<WorkItem, 'id' | 'createdAt'>): Promise<WorkItem> {
        const full: WorkItem = { ...w, id: newId('wi'), createdAt: now() };
        this.workItems.set(full.id, full); return clone(full);
    }
    async getWorkItem(tenantId: string, id: string): Promise<WorkItem | null> {
        const w = this.workItems.get(id); return w && w.tenantId === tenantId ? clone(w) : null;
    }
    async listWorkItems(tenantId: string, opts?: { limit?: number; offset?: number }): Promise<{ items: WorkItem[]; total: number }> {
        const all = [...this.workItems.values()].filter((w) => w.tenantId === tenantId)
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        const offset = Math.max(0, opts?.offset ?? 0), limit = Math.min(100, Math.max(1, opts?.limit ?? 20));
        return { items: all.slice(offset, offset + limit).map(clone), total: all.length };
    }

    async createRun(r: Omit<Run, 'id' | 'createdAt' | 'updatedAt'>): Promise<Run> {
        const ts = now(); const full: Run = { ...r, id: newId('run'), createdAt: ts, updatedAt: ts };
        this.runs.set(full.id, full); return clone(full);
    }
    async getRun(tenantId: string, id: string): Promise<Run | null> {
        const r = this.runs.get(id); return r && r.tenantId === tenantId ? clone(r) : null;
    }
    async updateRun(tenantId: string, id: string, patch: Partial<Run>): Promise<Run> {
        const r = this.runs.get(id);
        if (!r || r.tenantId !== tenantId) throw new Error(`run not found in tenant: ${id}`);
        const next: Run = { ...r, ...patch, id: r.id, tenantId: r.tenantId, updatedAt: now() };
        this.runs.set(id, next); return clone(next);
    }
    async listRuns(tenantId: string): Promise<Run[]> {
        return [...this.runs.values()].filter((r) => r.tenantId === tenantId).map(clone);
    }

    async appendEvent(e: Omit<RunEvent, 'id'>): Promise<RunEvent> {
        const full: RunEvent = { ...e, id: newId('ev') }; this.events.push(full); return clone(full);
    }
    async listEvents(tenantId: string, runId: string): Promise<RunEvent[]> {
        return this.events.filter((e) => e.tenantId === tenantId && e.runId === runId)
            .sort((a, b) => a.seq - b.seq).map(clone);
    }

    async putSecret(s: Omit<SecretRecord, 'id' | 'createdAt'>): Promise<SecretRecord> {
        // upsert by (tenantId, name)
        const existing = [...this.secrets.values()].find((x) => x.tenantId === s.tenantId && x.name === s.name);
        const full: SecretRecord = { ...s, id: existing?.id ?? newId('sec'), createdAt: existing?.createdAt ?? now() };
        this.secrets.set(full.id, full); return clone(full);
    }
    async getSecret(tenantId: string, name: string): Promise<SecretRecord | null> {
        return clone([...this.secrets.values()].find((x) => x.tenantId === tenantId && x.name === name) ?? null);
    }
    async listSecrets(tenantId: string): Promise<SecretRecord[]> {
        return [...this.secrets.values()].filter((x) => x.tenantId === tenantId).map(clone);
    }

    async getConfigRow(tenantId: string): Promise<TenantConfigRow | null> {
        return clone(this.configs.get(tenantId) ?? null);
    }
    async setConfigRow(row: TenantConfigRow): Promise<TenantConfigRow> {
        this.configs.set(row.tenantId, { ...row, updatedAt: now() }); return clone(this.configs.get(row.tenantId)!);
    }
}
