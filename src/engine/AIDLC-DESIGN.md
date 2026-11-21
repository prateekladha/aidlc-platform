# AIDLC — Multi-Agent AI Development Life Cycle (Design v0.3 — architecture LOCKED)

**Status:** architecture decided across the 22 Oct design review. Grounded in the existing RÉVE Host
Copilot substrate (`src/agent/`, see `DESIGN.md`). Built as a **scalable, org-wide, GCP-native, in-house**
system — the whole org uses it; nothing runs outside GCP. This doc is the source of truth; `v0.1/0.2`
framing is superseded.

---

## 0. Locked decisions (the rulings)
- **Purpose:** an AIDLC that takes any feature/bug as a work item and drives it through specialized agents
  to a reviewed, deployed change. **Monetization is the first real work item** (money-path is handled
  *through* the gates, not excluded — see §9).
- **Orchestration substrate:** **GCP-native** (Cloud Workflows + Cloud Tasks + Pub/Sub). We compensate for
  Workflows' weak code-defined control flow by keeping **all stage intelligence in our own code**;
  Workflows holds only the durable skeleton + gates. **Build everything in-house on GCP; nothing outside GCP.**
- **State store:** **Arango** (`aidlc_work_items`) — the uniform house datastore (the work item references
  events/users/orders already in Arango). *Supersedes the earlier Firestore pick* — with SSE push from the
  orchestrator we don't need client change-listeners; a parallel datastore + split-brain isn't worth it.
  (Flip to Firestore later only if we want browser-direct listeners; clean swap behind the store interface.)
- **Real-time channel:** **SSE from `perpettum-backend`** (reuse the Host Copilot `/chat/stream` pattern +
  `authUser`). **NOT** the Firebase web client (no SDK in FE, 2nd auth surface), **NOT** comm-runner
  socket.io (comm-runner is being de-scoped — add nothing to it).
- **Control plane:** **web, inside the ops console** (`app/dashboard/ops/` → new `AidlcTab.tsx`), **org-wide**;
  GitHub/Slack integration later. Staff-gated (`authUser` + in-controller `assertStaff`/isSuperRever).
- **Workflow model:** **declarative, versioned pipeline spec** (config, not code), **opinionated first**;
  per-team authoring later.
- **Execution — heavy stages (Dev, Testing, UX/Stitch) run on ephemeral Cloud Run Jobs.** This is a
  **correctness/security requirement, not scale tuning**: the Dev agent executes arbitrary LLM-written code
  (installs, builds, tests) and MUST be isolated from the orchestrator. In-process remains **only** as a
  local dev-iteration mode behind the `StageDispatcher` seam. Light stages (PRD/Analytics/GTM/Deploy
  orchestration) run in the orchestrator.
- **Gating:** **human approval at EVERY stage boundary** (per-stage configurable in the pipeline spec;
  default = gate at each stage; **never auto-approved**). Corrects the earlier 5-of-7 gating.
- **Human-in-the-loop:** agents **ask clarifying questions at stages** (`ask.user` → `awaiting_input`),
  risky actions are **PROPOSE → user confirm**, and the **PR is user-approved**. The ops console is the
  surface. Everything is audited.
- **Models:** **Vertex AI, `gemini-2.5-flash`, `asia-south1`** (Vertex-only; AI Studio removed — see
  `../model/gemini.ts`, `../model/vertex.ts`). `gemini-2.5-pro` available if the Dev stage needs stronger
  coding (open). Prompt caching works on Vertex (implicit + explicit, verified).
- **Audit:** split by concern, threaded by `workItemId` — **agent-actions → `agent_decisions`** (discriminated
  by `agent` name + new `workItemId`); **human approvals → `ops_audit`** (`action: aidlc_*`, `meta.workItemId`).
  **Arango is the system of record.**
- **GitHub auth (Dev worker):** a **GitHub App** (`contents: write` + `pull_requests: write`), short-lived
  installation tokens minted from the App private key in **Secret Manager** — no long-lived PAT. Installed on
  the target repos (start: `perpettum-backend`, `perpetuum-reve-growth-site`).
- **Deploy:** gated auto-deploy — approve PR → auto-merge → deploy → watch logs/health → post-deploy test →
  auto-rollback on failure.
- **Concurrency:** start at 3 concurrent work items (config). **Risk-tiered gates:** money-path work items get
  mandatory characterization tests + a fail-closed verifier (e.g. `revenueShare == 1.0`) + a rich PR-review surface.

---

## 1. First principles
An org-wide AIDLC is *a durable, observable, governed orchestration of specialized agents across the SDLC,
with humans at decision points, operating on real repos and infra at org scale.* Seven subsystems:
runtime (the reasoning primitive — done), inter-agent comms + state, execution isolation, control plane,
multi-tenancy/governance, evals/quality gates, and the platform's own IaC. The agents reason; the **system**
is the other six — that's where the engineering is.

## 2. What we REUSE (the proven substrate)
`runtime/loop.ts` is generic over `AgentConfig`+`Model`+`ServicePorts` → a stage-agent is a four-list config
+ toolset. Reused unchanged: the loop, the permission **broker** (EXECUTE/PROPOSE/DENY — this IS our
per-action approval), the single-use **tool registry**, **CRAG**, **memory/retrieval** (Arango+RRF),
`verify.ts` (fail-closed), `escalation.ts`, trace context, the **evals/red-team** harness, observability, and
the SSE pattern from `api/routes.ts`. Human **stage gates reuse the propose/approve + `PendingProposal`
re-entrancy** — no new pause primitive.

## 3. Architecture
### 3a. Control plane (ops console)
- **FE:** `app/dashboard/ops/AidlcTab.tsx` (new tab in `OpsConsole.tsx` via `OpsTabBar`). Submit a request;
  live work-item list; detail view = the DAG progress + the agent's **clarify questions (answer inline)** +
  **PROPOSE decisions (approve/reject)** + the **PR (review + approve)** + the per-item audit timeline.
  Live via SSE. Design tokens: the ops wine/cream set.
- **BE:** `src/growth-part/api/ops/aidlc.ts` (controllers) + routes under `/growth-api/ops/aidlc/*`
  (staff-gated, audited): `POST /submit`, `POST /:id/answer`, `POST /:id/gate` (approve|reject), `GET /:id`,
  `GET /` (list), `GET /:id/stream` (SSE). Every human action → `logOpsAction` (`ops_audit`).

### 3b. Orchestration (durable, GCP-native)
A **supervisor** owns the work item + the DAG. Durable skeleton in **Cloud Workflows**; each stage step
calls back into our code (the stage-agent). **Human gates = Workflows callbacks** (the workflow parks until
the console POSTs the approval/answer → it resumes). **Cloud Tasks** dispatches heavy-stage Jobs (retries,
rate limits). **Pub/Sub** carries worker→orchestrator completion. The in-process `Supervisor`
(`orchestrator/orchestrator.ts`) is the local-iteration driver behind the same interface.

### 3c. Execution (ephemeral, isolated)
Heavy stages (Dev, Testing, UX/Stitch) = **Cloud Run Jobs**. Per stage run: a worker container
(`node + git + gh + Playwright/browsers + the stage-agent runtime`) boots, **clones the target repo via a
GitHub App installation token** into the Job's own ephemeral filesystem (the sandbox — real isolation),
runs the stage, writes artifacts to **GCS** + the slice to Arango, **publishes completion to Pub/Sub**, and
tears down. The `StageDispatcher` seam makes this a drop-in vs the local driver.

### 3d. State + real-time
Arango `aidlc_work_items` (env-prefixed) is the state + system-of-record. The orchestrator **pushes every
transition over SSE** to connected ops-console clients (it's the single writer, so it knows). At the
multi-process edge, workers publish to **Pub/Sub** → the SSE-serving process relays to the browser.

### 3e. Inter-agent communication
Agents do **not** message each other directly — they communicate through the **Work Item** (a blackboard):
each stage reads the accumulated artifact, appends its slice, and the DAG hands off. The Work Item is the
contract + the pipeline's memory + the audit spine.

### 3f. Human-in-the-loop
- **Clarify:** a stage-agent calls `ask.user(questions[])` → item enters `awaiting_input` → console shows →
  staff answer → resume injects the answers. (This is how the agent asks the GST/split-param questions.)
- **Propose:** propose-tier tool → broker PROPOSE → surfaced as a gate → approve/reject.
- **Stage gate:** at each stage boundary → `awaiting_gate` → approve to proceed.
- **PR:** user reviews + approves the PR; approval triggers the gated auto-deploy sequence.

### 3g. Audit
`agent_decisions` (+ `workItemId`) for agent-actions; `ops_audit` (`action: aidlc_*`, `meta.workItemId`) for
human approvals; threaded by `workItemId`; reconstruct a full trail by joining on it. Arango = SoR.

### 3h. Models + token economics
Vertex `gemini-2.5-flash` (asia-south1), `2.5-pro` optional for Dev. Explicit `CachedContent` (per-agent
config + per-work-item context) + implicit prefix caching (ordered stable→volatile); per-stage thinking
budgets; structured-JSON handoffs; diffs not full files. Cost surfaced per work item in the ops console.

### 3i. Security & governance
GitHub App (scoped, short-lived tokens, Secret Manager). Job SA gets: Arango creds (Secret Manager),
`aiplatform.user` (Vertex), the App credential, GCS. Per-stage tool allowlist + `authorize()`. **Forbidden
paths** (money/booking/contracts) are enforced as tool `authorize()` + hard escalation — the agent still
*works* on them, but through the risk-tiered gates (characterization test + fail-closed verifier + rich PR
review), never by moving money directly. `AIDLC_ENABLED` kill switch. Per-work-item budget ceiling.

## 4. The Work Item (spine)
Arango doc accumulating: `origin` · `prd{problem,acceptanceCriteria,outOfScope,designNeed,riskTier}` ·
`design?` · `dev{jobRun,branch,diffSummary,filesTouched}` · `tests{functional,visual,lighthouse,verdict}` ·
`deploy{prUrl,approvedBy,deployRef,postDeploy,rolledBack}` · `analytics?` · `gtm?` · `questions[]` (clarify
Q&A) · `gates[]` · `status{stage,state}` · `trace{perStageCost}` · `artifacts{gcsRefs}`. (TS shapes in
`orchestrator/types.ts`.)

## 5. Stage roster + DAG + gating
PRD → [UX if `designNeed==new-design`] → Dev → Testing → (Dev if red, ≤3 repairs / Deploy if green) →
Analytics → GTM. Configs in `agents/aidlc/stages.ts`. **Every stage boundary is a gate by default**
(per-stage overridable in the spec). Heavy = Dev/Testing/UX → Cloud Run Jobs; rest → orchestrator.

## 6. Build order (distributed-first)
1. **Execution layer:** worker image (AR) + GitHub App token-minting + Cloud Run Job + Cloud Tasks dispatch +
   Pub/Sub result bridge + Job SA/IAM.
2. **Orchestrator async-resume** (dispatch → park → resume on Pub/Sub / gate callback) + Arango work-item store.
3. **Control plane:** ops AIDLC APIs + SSE + `AidlcTab.tsx` + the HITL (`ask.user`/gates) + audit wiring.
4. **Run monetization** end-to-end through it (agent asks GST/split params, proposes, user approves each gate + PR).
5. **Harden:** evals per stage, risk-tiered money gates, cost/observability, then flip `AIDLC_ENABLED`.

## 7. Current status (built vs to-build) — updated 22 Oct overnight build
**See `AIDLC-STATUS.md` for the full runbook + the one blocker.**

**Built + verified (tsc-clean, uncommitted):**
- Durable Supervisor (`orchestrator.ts`) — all state on the work item (resumable), dispatcher seam,
  clarify HITL (`needsInput`), async worker-resume, gate at every stage, **safe-by-default deploy**
  (no auto-merge). Full pipeline proven with the scripted model.
- `workItemStore.arango.ts` (SoR, `${env}_aidlc_work_items`), `dispatcher.ts` (Local/Job), `service.ts`
  (singleton + SSE), `ports.git.ts` (real clone→edit→push→PR), `github.ts` (App token-mint — **verified
  live**), `jobDispatch.ts`.
- Control plane: BE `api/ops/aidlc.ts` + `/growth-api/ops/aidlc/*` (submit/gate/answer/stream, audited);
  FE `AidlcTab.tsx` (submit, live DAG via SSE, clarify, gate, PR review).
- GitHub App provisioned + installed; key in Secret Manager. git-clone sandbox verified live.

**⛔ Blocked:** a real LLM run — the project `spilll-be` returns 404 for ALL Vertex Gemini models in all
regions (billing-account change; also likely breaks prod Host Copilot/comm). Must be fixed in GCP console.
The code is LLM-ready and model-agnostic; it's a project-access fix, not a code change. See `AIDLC-STATUS.md §1`.

**To build (deferred until the blocker clears):** Cloud Run Job isolation (worker image + Pub/Sub bridge +
Job SA/IAM) — the production execution path; and the prod deploy of the control plane. Do NOT run
`AIDLC_EXECUTION=local` on prod (Dev agent runs arbitrary code → needs Job isolation).

## 8. What needs the owner (not code)
- Create the **GitHub App** (contents+PR write), install on the target repos, hand over App ID + private key.
- Monetization params (X% cut, N free, Z/Z-dash + the Z-dash Cashfree vendor) + GST stance — **the agent will
  ask these at the PRD stage**, so they're captured in-flow, not pre-collected.

## 9. Monetization as the first work item
Runs through the pipeline like any work item: PRD asks you GST + split params → you approve the PRD → (no new
design) → Dev writes the policy/UX layer AND (risk-tiered) the multi-participant Cashfree split behind a flag,
with a **characterization test** of current `buildHostVendorSplit` first → Testing runs the suite + the
**`revenueShare == 1.0` fail-closed verifier** → you review + approve the PR → gated auto-deploy. The gates +
audit are what make a money-path change safe — not excluding it from the agent.

## 10. Open items
- `gemini-2.5-pro` for Dev stage (coding strength) vs 2.5-flash — decide after first real Dev runs.
- Full Cloud Workflows YAML vs a lighter Cloud-Tasks-driven durable driver for v1 orchestration.
- Per-team workflow authoring (deferred).
