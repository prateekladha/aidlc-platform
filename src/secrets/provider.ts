// SecretProvider — the per-tenant secrets seam (BYO model keys, cloud creds). Impl #1 is envelope encryption
// (envelope.ts); the production impl is HashiCorp Vault with a namespace per tenant (strongest isolation).
// Swapping impls never touches run logic. Plaintext is produced ONLY by get()/bundleForRun() at run start
// and must be injected into the ephemeral sandbox + never persisted, logged, or returned to the shared plane.

import type { TenantContext } from '../tenancy/context';

export interface SecretProvider {
    /** Store a plaintext secret for the tenant (encrypted at rest — plaintext is never persisted). */
    put(ctx: TenantContext, name: string, plaintext: string): Promise<void>;
    /** JIT: fetch + decrypt one secret at run start. Caller injects it into the sandbox and drops it. */
    get(ctx: TenantContext, name: string): Promise<string | null>;
    /** JIT: all of a tenant's secrets as { NAME: plaintext }, for injecting into a run's isolated env. */
    bundleForRun(ctx: TenantContext): Promise<Record<string, string>>;
}
