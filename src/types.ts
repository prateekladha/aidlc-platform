// Core domain types for the multi-tenant control plane. EVERYTHING is tenant-scoped: every record carries
// tenantId, and the data layer (see db/store.ts + tenancy/context.ts) refuses cross-tenant access centrally.

export type Role = 'owner' | 'admin' | 'member';
export type WorkKind = 'bug' | 'feature' | 'change' | 'chore' | 'infra' | 'data-migration' | 'spike';
export type RunState = 'queued' | 'running' | 'awaiting_gate' | 'awaiting_input' | 'passed' | 'failed';
export type Provider = 'anthropic' | 'google' | 'openai';
export type Plan = 'free' | 'pro' | 'team' | 'enterprise';
/** How a tenant pays for model tokens — the two economics modes wired from day one. */
export type ModelBilling = 'byo_key' | 'managed';

export interface Tenant {
    id: string;
    slug: string;            // used for routing (app/t/<slug>; later <slug>.domain)
    name: string;
    plan: Plan;
    modelBilling: ModelBilling;
    createdAt: string;
}

export interface User {
    id: string;
    tenantId: string;
    email: string;
    role: Role;
    createdAt: string;
}

/** A GitHub App installation a tenant granted us (per-tenant, multi-install). */
export interface Installation {
    id: string;
    tenantId: string;
    provider: 'github';
    installationId: number;  // GitHub's installation id
    accountLogin: string;    // the org/user it's installed on
    createdAt: string;
}

/** A repo the tenant whitelisted for the agent (the "Only select repositories" grant). */
export interface Repo {
    id: string;
    tenantId: string;
    installationId: string;  // FK → Installation.id
    fullName: string;        // owner/name
    defaultBranch: string;
    createdAt: string;
}

export interface WorkItem {
    id: string;
    tenantId: string;
    repoId: string;
    title: string;
    rawRequest: string;
    createdBy: string;       // User.id
    createdAt: string;
}

export interface Run {
    id: string;
    tenantId: string;
    workItemId: string;
    state: RunState;
    stage?: string;
    prUrl?: string;
    costTokens: number;      // AI cost (the #6 observability + #C cost wedge feed)
    sandboxRef?: string;
    createdAt: string;
    updatedAt: string;
}

export interface RunEvent {
    id: string;
    tenantId: string;
    runId: string;
    seq: number;
    ts: string;
    type: string;
    payload?: Record<string, unknown>;
}

/** A per-tenant secret (BYO model key, cloud creds). Stored ENCRYPTED; the plaintext is never persisted on
 *  this record — `ciphertext` is what lives at rest; SecretProvider decrypts JIT at run start only. */
export interface SecretRecord {
    id: string;
    tenantId: string;
    name: string;            // e.g. 'ANTHROPIC_API_KEY'
    ciphertext: string;      // envelope-encrypted; never the plaintext
    createdAt: string;
}

/** Per-tenant config overrides (config→DB, no hardcoding). Platform defaults live in code; a tenant row
 *  overrides any subset. Resolved into the engine's runtime config at run start. See tenancy/config.ts. */
export interface TenantConfigRow {
    tenantId: string;
    overrides: Partial<ResolvedConfig>;
    updatedAt: string;
}

/** The fully-resolved runtime config the engine reads — platform defaults merged with tenant overrides. */
export interface ResolvedConfig {
    model: string;
    criticModel: string;
    thinkingDefault: 'low' | 'medium' | 'high';
    autoMerge: boolean;
    maxConcurrentRuns: number;
    tokenBudgetPerRun: number;
    moneyApprovers: string[];   // user ids
    infraApprovers: string[];
    egressAllowlist: string[];  // hosts the sandbox may reach
    modelBilling: ModelBilling;
    sandboxProvider: 'e2b' | 'mock';
    modelProvider?: string;   // anthropic | deepseek | openrouter | groq | qwen | ... (openai-compat)
    modelBaseURL?: string;    // for a custom OpenAI-compatible endpoint
    artifactTtlDays: number;
    features: Record<string, boolean>;
}
