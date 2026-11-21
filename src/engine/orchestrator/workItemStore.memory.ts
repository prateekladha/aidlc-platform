// In-memory Work Item store (v1 + tests). The Arango-backed store (work_items collection, env-prefixed)
// is the production target behind the same interface — a swap, not a logic change.

import type { WorkItem, WorkItemStore, StageState, Stage } from './types';

export class InMemoryWorkItemStore implements WorkItemStore {
    private items = new Map<string, WorkItem>();
    private seq = 0;

    async create(wi: Omit<WorkItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<WorkItem> {
        this.seq += 1;
        const now = new Date().toISOString();
        // Timestamped id (like the Arango store) so each CLI run gets a UNIQUE branch (aidlc/<id>) — repeated
        // runs of the same request never collide on an existing remote branch / open PR.
        const full: WorkItem = { ...wi, id: `wi_${Date.now().toString(36)}_${this.seq}`, createdAt: now, updatedAt: now };
        this.items.set(full.id, full);
        return { ...full };
    }

    async get(id: string): Promise<WorkItem | null> {
        const w = this.items.get(id);
        return w ? { ...w } : null;
    }

    async update(id: string, patch: Partial<WorkItem>): Promise<WorkItem> {
        const cur = this.items.get(id);
        if (!cur) throw new Error(`work item not found: ${id}`);
        const next: WorkItem = { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt, updatedAt: new Date().toISOString() };
        this.items.set(id, next);
        return { ...next };
    }

    async list(filter?: { state?: StageState; stage?: Stage }): Promise<WorkItem[]> {
        let rows = [...this.items.values()];
        if (filter?.state) rows = rows.filter((w) => w.status.state === filter.state);
        if (filter?.stage) rows = rows.filter((w) => w.status.stage === filter.stage);
        return rows.map((w) => ({ ...w }));
    }

    async search(opts: { q?: string; state?: StageState; stage?: Stage; limit?: number; offset?: number }): Promise<{ items: WorkItem[]; total: number }> {
        const limit = Math.min(100, Math.max(1, opts.limit || 20));
        const offset = Math.max(0, opts.offset || 0);
        let rows = [...this.items.values()];
        if (opts.state) rows = rows.filter((w) => w.status.state === opts.state);
        if (opts.stage) rows = rows.filter((w) => w.status.stage === opts.stage);
        const q = (opts.q || '').trim().toLowerCase();
        if (q) {
            // Simple token match for the in-memory store (tests/local). The Arango store uses ArangoSearch.
            const tokens = q.split(/\s+/).filter(Boolean);
            rows = rows.filter((w) => {
                const hay = `${w.title} ${w.origin?.rawRequest || ''} ${w.targetRepo || ''}`.toLowerCase();
                return tokens.some((t) => hay.includes(t));
            });
        }
        rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        const total = rows.length;
        return { total, items: rows.slice(offset, offset + limit).map((w) => ({ ...w })) };
    }
}
