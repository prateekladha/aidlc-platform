# aidlc-platform

Multi-tenant SaaS platform for the **AIDLC autonomous-delivery agent** — spun out of Perpetuum as a
standalone business. The AIDLC engine (adaptive PRD→Dev→Test→Deploy→GTM, fail-closed gates, instruction
coverage, honest deploy, full observability — certified reliable end-to-end) is the core; this repo is the
**multi-tenant platform around it**: onboarding, isolation, secrets, config, billing, observability-as-a-
product, GTM.

> **Strategy + architecture live in [`docs/`](docs/):**
> [ARCHITECTURE-AND-STRATEGY.md](docs/ARCHITECTURE-AND-STRATEGY.md) · [PRE-PROVISIONING.md](docs/PRE-PROVISIONING.md) · [GTM.md](docs/GTM.md)

## Quick start
```bash
npm install
npm run build   # tsc --noEmit (strict) — clean
npm test        # 9 foundation tests — all pass (zero external deps)
```

## What's here (Phase-0 foundation — validated)
This scaffold proves the **hard, security-critical multi-tenant core** with tests. Everything compiles
(`tsc` strict) and the 9 tests pin the load-bearing guarantees. The framework/DB/provider integrations are
intentionally **typed seams** (swap-in impls), so the risky parts are proven and the mechanical parts are
clearly scoped.

| Module | What it is | State |
|---|---|---|
| `src/types.ts` | Domain model (tenant-scoped everywhere) | ✅ real |
| `src/db/store.ts` | `DataStore` interface + `InMemoryDataStore` | ✅ interface + in-mem; **Phase-1: Postgres (Drizzle) impl** |
| `src/tenancy/context.ts` | `TenantContext` — THE isolation boundary (forces its own `tenantId`) | ✅ real + tested |
| `src/tenancy/config.ts` | config→DB (platform defaults + per-tenant overrides) — **no hardcoding** | ✅ real + tested |
| `src/secrets/*` | `SecretProvider` + envelope AES-256-GCM (encrypt-at-rest, JIT, tamper-fail-closed) | ✅ real + tested; **Phase-1: Vault-namespaces impl** |
| `src/sandbox/*` | `Sandbox` interface + mock + E2B stub (per-run Firecracker isolation) | ✅ interface + mock tested; **Phase-1: E2B impl** |
| `src/onboarding/github.ts` | GitHub App: RS256 App-JWT, repo-scoped installation tokens, webhook HMAC, tenant resolution | ✅ crypto real + tested; token-exchange is a live `fetch` |
| `src/billing/meter.ts` | usage metering (runs/tokens) → cost dashboard + billing | ✅ in-mem; **Phase-1: Stripe impl** |
| `src/runs/dispatch.ts` | the core flow: config → scoped token → JIT secrets → isolated sandbox → engine → teardown → meter | ✅ real + tested; `engine` seam = the AIDLC port |
| `src/service.ts` | control-plane operations (onboard/connect/whitelist/submit) | ✅ real + tested |

## Security guarantees the tests prove
- **Tenant isolation** — a `TenantContext` can only touch its own tenant's data; cross-tenant reads return
  null; creates are stamped with the context's `tenantId` (not caller-supplied). *(With Postgres, add RLS.)*
- **Secrets never persisted in plaintext** — only ciphertext at rest; decrypted JIT for a run; tamper →
  fail closed. Injected into the isolated sandbox and **dropped on teardown**.
- **Least-privilege, short-lived GitHub access** — repo-scoped installation tokens (not user tokens); real
  RS256 App-JWT; webhook HMAC verified; events resolved to tenant via OUR recorded installation (never the
  payload — the documented cross-tenant leak vector).
- **Per-run isolation** — one Firecracker microVM per run (E2B), destroyed after; per-tenant concurrency cap.

## Phase-1 build guide (what to implement next — needs the accounts in PRE-PROVISIONING)
1. **Postgres `DataStore`** (Drizzle + pg) implementing `src/db/store.ts` — + RLS policies. Keep schema ANSI.
2. **Fastify HTTP layer** wrapping `src/service.ts` + the GitHub webhook receiver (`verifyWebhookSignature`).
3. **`E2BSandboxProvider`** (`src/sandbox/e2b.ts`) — clone-with-scoped-token + JIT-env + egress allow-list.
4. **Vault-namespaces `SecretProvider`** (one namespace/tenant) behind the existing interface.
5. **Port the AIDLC engine** into the `Engine` seam (`src/runs/dispatch.ts`) — the hardened Supervisor,
   reading `ResolvedConfig` + the per-tenant GitHub App, running inside the sandbox.
6. **Stripe** metering (`src/billing/meter.ts`) for managed-billing tenants.
7. **Client dashboard** (runs + cost) off the event stream.
8. **Auth** (sessions + RBAC; GitHub login) building `TenantContext` from the session — never the request body.

## Deploy target (see docs)
Control plane on **OCI Always-Free** (containers + Postgres + object store + 10 TB egress); per-run compute
**off OCI** on **E2B/Firecracker**; strictly cloud-portable (three seams: S3 object API, `SecretProvider`,
`Sandbox`) so GCP/AWS startup credits are a redeploy, not a rewrite.

_Owner drives all git + infra provisioning. Nothing here is pushed/deployed automatically._
