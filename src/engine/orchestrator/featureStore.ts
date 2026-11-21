// Feature registry port — tracks logical "features" (name + paths + change history) the agent has worked on,
// so later runs can find prior work. The Arango-backed implementation was removed with the Perpetuum/Arango
// coupling; the platform will back this with Postgres behind the same `FeaturePort` interface. Until then the
// NoopFeaturePort is used (safe, non-persisting) so the dev/git ports run unchanged.
import type { Feature, FeaturePort } from './types';

export class NoopFeaturePort implements FeaturePort {
    async search() { return []; }
    async history() { return null; }
    async upsert(f: { id: string; name: string; summary?: string; paths?: string[] }): Promise<Feature> {
        const now = new Date().toISOString();
        return { id: f.id, name: f.name, summary: f.summary || f.name, paths: f.paths || [], changes: [], createdAt: now, updatedAt: now };
    }
    async recordChange() { /* no-op */ }
}
