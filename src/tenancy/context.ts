// TenantContext — THE tenant-isolation boundary. Handlers + the run dispatcher receive a TenantContext and
// never a raw DataStore, so they cannot query another tenant's data: every method forces `this.tenantId`,
// and creates STAMP it (ignoring any tenantId a caller passes). This is the structural guarantee behind
// row-level multi-tenancy — not a convention a handler can forget. (With Postgres, back it with RLS too.)

import type { DataStore } from '../db/store';
import type {
    User, Installation, Repo, WorkItem, Run, RunEvent, SecretRecord,
} from '../types';

export class TenantContext {
    constructor(private readonly store: DataStore, readonly tenantId: string) {}

    // ── users ──
    listUsers(): Promise<User[]> { return this.store.listUsers(this.tenantId); }
    getUser(id: string): Promise<User | null> { return this.store.getUser(this.tenantId, id); }
    createUser(u: Omit<User, 'id' | 'createdAt' | 'tenantId'>): Promise<User> {
        return this.store.createUser({ ...u, tenantId: this.tenantId });
    }

    // ── installations / repos ──
    listInstallations(): Promise<Installation[]> { return this.store.listInstallations(this.tenantId); }
    createInstallation(i: Omit<Installation, 'id' | 'createdAt' | 'tenantId'>): Promise<Installation> {
        return this.store.createInstallation({ ...i, tenantId: this.tenantId });
    }
    listRepos(): Promise<Repo[]> { return this.store.listRepos(this.tenantId); }
    getRepo(id: string): Promise<Repo | null> { return this.store.getRepo(this.tenantId, id); }
    createRepo(r: Omit<Repo, 'id' | 'createdAt' | 'tenantId'>): Promise<Repo> {
        return this.store.createRepo({ ...r, tenantId: this.tenantId });
    }

    // ── work items ──
    createWorkItem(w: Omit<WorkItem, 'id' | 'createdAt' | 'tenantId'>): Promise<WorkItem> {
        return this.store.createWorkItem({ ...w, tenantId: this.tenantId });
    }
    getWorkItem(id: string): Promise<WorkItem | null> { return this.store.getWorkItem(this.tenantId, id); }
    listWorkItems(opts?: { limit?: number; offset?: number }) { return this.store.listWorkItems(this.tenantId, opts); }

    // ── runs ──
    createRun(r: Omit<Run, 'id' | 'createdAt' | 'updatedAt' | 'tenantId'>): Promise<Run> {
        return this.store.createRun({ ...r, tenantId: this.tenantId });
    }
    getRun(id: string): Promise<Run | null> { return this.store.getRun(this.tenantId, id); }
    updateRun(id: string, patch: Partial<Run>): Promise<Run> { return this.store.updateRun(this.tenantId, id, patch); }
    listRuns(): Promise<Run[]> { return this.store.listRuns(this.tenantId); }

    // ── events ──
    appendEvent(e: Omit<RunEvent, 'id' | 'tenantId'>): Promise<RunEvent> {
        return this.store.appendEvent({ ...e, tenantId: this.tenantId });
    }
    listEvents(runId: string): Promise<RunEvent[]> { return this.store.listEvents(this.tenantId, runId); }

    // ── secrets (ciphertext records; plaintext handled by SecretProvider, never here) ──
    putSecret(s: Omit<SecretRecord, 'id' | 'createdAt' | 'tenantId'>): Promise<SecretRecord> {
        return this.store.putSecret({ ...s, tenantId: this.tenantId });
    }
    getSecret(name: string): Promise<SecretRecord | null> { return this.store.getSecret(this.tenantId, name); }
    listSecrets(): Promise<SecretRecord[]> { return this.store.listSecrets(this.tenantId); }
}

/** Resolve a TenantContext from a tenant id, verifying the tenant exists. The HTTP layer builds this from
 *  the authenticated session's tenant — NEVER from a request body/param (that would be the cross-tenant hole). */
export async function tenantContextFor(store: DataStore, tenantId: string): Promise<TenantContext> {
    const t = await store.getTenant(tenantId);
    if (!t) throw new Error(`unknown tenant: ${tenantId}`);
    return new TenantContext(store, tenantId);
}
