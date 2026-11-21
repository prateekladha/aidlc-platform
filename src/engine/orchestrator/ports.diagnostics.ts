// Read-only diagnostics for root-causing production bugs from live sources. In the standalone platform these
// sources are per-tenant and provider-agnostic (OCI logs, Postgres, the tenant's observability stack) and are
// wired behind this same interface — NOT the GCP/Arango stack the engine shipped with (removed: no GCP here).
// Until a tenant-scoped diagnostics provider is wired, every method reports {available:false} and never throws,
// so the bug-fix flow degrades gracefully instead of failing. Strictly read-only by construction.
import type { DiagnosticsPort } from './types';

// A no-op used when diagnostics aren't wired — always reports unavailable, never throws, never writes.
export class NoopDiagnosticsPort implements DiagnosticsPort {
    enabled(): boolean { return false; }
    async queryLogs() { return { available: false, entries: [], note: 'diagnostics not wired for this tenant' }; }
    async queryDb() { return { available: false, rows: [], note: 'diagnostics not wired for this tenant' }; }
    async inspectCache() { return { available: false, result: null, note: 'diagnostics not wired for this tenant' }; }
    async runtimeStatus() { return { available: false, status: null, note: 'diagnostics not wired for this tenant' }; }
}

// Back-compat export: callers that constructed the old GCP-backed LiveDiagnosticsPort now get the safe no-op.
// The real per-tenant provider (OCI/Postgres) will re-introduce a live implementation behind this name.
export { NoopDiagnosticsPort as LiveDiagnosticsPort };
