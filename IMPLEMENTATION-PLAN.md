# AIDLC Platform — Implementation Plan

_Last updated: 21 Nov 2026 · Status: **drafted, build PAUSED** (plan only; do not start until the owner unpauses and the M0 unblockers land)._

Companion to the **PRD** (Claude Doc) and the **clickable wireframe** (Signal design identity). This plan is
grounded in the actual state of this repo and the proven AIDLC engine — it is about **productizing a proven
engine as a multi-tenant SaaS**, not building the engine from scratch.

---

## 0. Reality check — what already exists (don't re-plan this)

**AIDLC engine — built & proven.** Stage agents (PRD / UX / Dev / Test / Deploy / Analytics) on one generic
loop, adaptive DAG, quality critic, fail-closed verifiers, eval backbone, honest gated deploy, reliability
watchdog. **4 clean end-to-end runs on real Gemini/Vertex** (PRs #1270–1273: bug → triage → fix → test →
deploy-PR, held honestly at the merge gate). Model adapters already present:
`src/engine/model/claude.ts`, `openai-compat.ts` (DeepSeek/Groq/any OpenAI-compatible), `scripted.ts`.

**Standalone platform (this repo) — Phase-0 validated** (tsc strict clean, foundation tests pass). The hard,
security-critical multi-tenant core is real and tested:

| Area | File(s) | State |
|---|---|---|
| Domain model (tenant-scoped) | `src/types.ts` | ✅ real |
| Data store | `src/db/store.ts` | ✅ interface + in-mem → **Phase-1: Postgres (Drizzle) + RLS** |
| Tenant isolation boundary | `src/tenancy/context.ts`, `config.ts` | ✅ real + tested |
| Secrets (envelope AES-256-GCM, JIT) | `src/secrets/*` | ✅ real + tested → **Phase-1: Vault** |
| Sandbox (per-run isolation) | `src/sandbox/*` | ✅ interface + mock → **Phase-1: E2B/Firecracker** |
| GitHub App (RS256 JWT, scoped tokens, webhook HMAC) | `src/onboarding/github.ts` | ✅ crypto real + tested; live token-exchange |
| Billing / metering | `src/billing/meter.ts` | ✅ in-mem → **Phase-1: Stripe** |
| Run flow (config → token → JIT secrets → sandbox → engine → teardown → meter) | `src/runs/dispatch.ts` | ✅ real + tested; `Engine` seam = the AIDLC port |
| **Control plane (framework-agnostic)** | `src/service.ts` | ✅ real + tested |

**Missing for a shippable product:** (1) the Phase-1 seam impls, (2) a thin HTTP layer over `service.ts`,
(3) the **customer-facing FE** — the wireframe is its spec; the existing `AidlcTab.tsx` is embedded in
Perpetuum's ops console, **not** the standalone product.

**Control-plane API surface already written** (`src/service.ts`, framework-agnostic):
`onboardTenant` · `connectInstallation` · `whitelistRepo` · `storeSecret` · `submitWorkItem` (→ `dispatchRun`)
· `costSummary`.

---

## 1. Strategy

Wrap the proven engine as a multi-tenant SaaS, and **prove one thin vertical slice before breadth.**
Three tracks run in parallel; a thin slice (one tenant → one repo → one stage, human-gated, visible in the
real FE) is the milestone that ties them together. Breadth (all stages, the full manual-surface set, the
Phase-2 hardening layer) comes only after the loop is proven.

Decision (already taken): **no separate high-fidelity design phase** — the wireframe already encodes the
Signal design system in working code. The "design → code" step is **extraction**, not redesign (Track 0).

---

## 2. Track 0 — Design-system extraction (do once)

From the wireframe, not a redesign.

- **Tokens** → `packages/ui/tokens.css` (or a Tailwind theme): the Signal vars (ink-navy `#0b0f14`,
  signal-green `#7CF29B`, Space Grotesk), light/dark, the dark-ink-on-green rule.
- **Components** → `packages/ui/`: the recurring pieces — `StageCard`, `GatePanel`,
  `RunConsole`/`Tabpane`, `ManualSurface`, `CommentThread`, `SsoConsoleModal`, `Chip`, `Button`.
- The wireframe stays the **living spec**; keep the grep-based sync-audit habit (wireframe ⇄ PRD ⇄ FE).

## 3. Track A — Backend Phase-1 (wrap the control plane)

1. **HTTP layer** — a thin Fastify adapter over `src/service.ts` (already framework-agnostic; validate input
   + call the service op):
   - `POST /tenants` → `onboardTenant`
   - `POST /installations` → `connectInstallation`
   - `POST /repos` → `whitelistRepo`
   - `POST /secrets` → `storeSecret`
   - `POST /work-items` → `submitWorkItem` (→ `dispatchRun`)
   - `GET /runs/:id`, `GET /cost` → run state + `costSummary`
   - **SSE / WebSocket** for the live run event stream (the FE run console needs the per-stage events that
     `dispatch.ts`'s `emit` already produces).
2. **Swap the 5 seams** (each a typed interface today — impl behind a flag, keep the in-mem/mock alive until
   the impl passes tests):
   - `db/store.ts` → **Postgres + Drizzle + RLS** (isolation already enforced in code; RLS = defense-in-depth).
   - `secrets/` → **Vault namespaces** (envelope crypto unchanged).
   - `sandbox/` → **E2B / Firecracker**.
   - `onboarding/github.ts` → register the **standalone GitHub App**; wire live installation token-exchange.
   - `billing/meter.ts` → **Stripe** (metered prepaid credits).
3. **Wire the Engine + model** — connect the ported engine (`src/engine/*`) to the `Engine` seam via
   `src/runs/engine.aidlc.ts`; route models through `claude.ts` or `openai-compat.ts` per the monetization
   mode (BYO-key / managed-model / managed-infra).

## 4. Track B — Customer FE (thin-slice screens only)

A Next.js app consuming Track A, built from the wireframe with Track-0 components. Build **only the slice**:

- **Onboard** → **connect GitHub** = a guided one-click App install (GitHub's install UI → callback captures the installation), *not* manual setup → whitelist a repo (`/installations`, `/repos`). The product drives this; the tenant never registers an App.
- **Submit work item** (`/work-items`).
- **Run console** for *one stage*: the DAG strip + the stage inspector + the **gate** (approve /
  request-changes / **edit yourself**), fed by the SSE event stream.
- Defer the full manual-surface set (multi-surface test consoles, infra CRUD, embedded-SSO modals) —
  Phase-2 breadth.

---

## 5. The thin vertical slice (the proof)

**One tenant → one repo → one stage, human-gated, end-to-end in the real FE.** Start with the **Dev/Fix
path** — it is the proven one (the clean runs were bug → triage → fix → test → deploy-PR), held honestly at
the `merge_confirmation` gate.

| Milestone | Done = |
|---|---|
| **M0** | DeepSeek wired; a local target repo; the engine runs locally (local ports + local `gh`) behind a thin API — no Postgres, no App |
| **M1** | API slice: `submitWorkItem` on a real repo → one stage runs → event stream → gate holds |
| **M2** | Track-0 design system extracted; Next.js app skeleton on Signal tokens |
| **M3** | FE slice: onboard → connect repo → submit → watch the stage → clear the gate (the loop, visible) |
| **M4** | Widen: enable the next stage + the first manual surface; re-run the wireframe sync-audit |

---

## 6. Unblockers (gate M0) & what to defer

**Needed before M0:**
- A model key for the standalone — **DeepSeek `deepseek-v4-pro` via `openai-compat`** (done & verified: key +
  balance + model all green; v4-pro is a reasoning model → raise token caps).
- A **target repo on disk** for the slice — the engine's **local ports** (`makeLocalAidlcPorts(repoRoot)`)
  work on a local clone and push / open the PR via the machine's own `gh` / git auth (this is how the 4
  certified CLI runs already worked). **No GitHub App is needed for the slice.**
- Postgres is **not** needed for the slice (the in-memory store runs it); provision **OCI** Postgres (no local
  Docker) when the Drizzle+RLS store lands.

**On the GitHub App — it is a PRODUCT capability, not a manual setup.** It exists only for the **multi-tenant**
path: `ports.git.ts` clones *any tenant's installed repo* with a scoped, short-lived installation token. The
platform has **one** GitHub App (its own identity); a tenant **connects** it during **onboarding** via a
guided **one-click install** (GitHub's install UI → post-install callback captures the `installation_id` →
`connectInstallation`). Tenants never register an App or follow setup steps — the product does it. The
token-minting half is already built (`onboarding/github.ts`); the install-initiation + callback capture is a
Phase-1 onboarding feature to build.

**Defer (documented in the PRD, sequenced Phase-2+):**
- The full manual-surface breadth and all 7 stages at once.
- The hardening layer — release safety (feature flags / canary / blue-green / auto-halt), incident response
  (SLOs / runbooks / on-call / auto-rollback), security-testing depth (SAST/DAST/SBOM/pentest), API
  versioning / i18n / FinOps cost attribution.

**Standing constraints:**
- This is the plan — **do not start building until the owner unpauses** and the M0 unblockers land.
- Git staging / commit / push is the **owner's**; this file is written locally only.

---

## 7. Open follow-ups to detail on request

- Exact Fastify route signatures mapped 1:1 from `src/service.ts` types.
- M1 as a concrete task list (file-by-file) for the Dev/Fix slice.
- Postgres schema + RLS policies derived from `src/types.ts`.
- The FE ↔ event-stream contract (event types emitted by `dispatch.ts`).
