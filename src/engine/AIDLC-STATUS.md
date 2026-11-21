# AIDLC — build status & runbook (24 Oct 2026)

## ⟐ 25 Oct 2026 — reliability, cost, honesty + UX pass (from the owner's feedback)

Landed (both repos **tsc-clean**; `git` is the owner's):

**Engine (cost / latency / robustness)**
- **429 → non-event:** a GLOBAL concurrency gate on every Vertex call (`AIDLC_VERTEX_MAX_CONCURRENCY=3`)
  + exponential backoff/jitter retry (`AIDLC_VERTEX_MAX_RETRIES=8`, honors `retry-after`). No quota bump —
  we stay under the pay-as-you-go limit by design (model/vertex.ts).
- **400 "function parts" → fixed:** a parity sanitizer guarantees every model turn's functionCall count
  equals the following functionResponse count before each send (pads orphans), + role-alternation merge.
- **Caching (implicit + explicit):** the stage BRIEF now rides in the STABLE `system` prefix (not a user
  turn) → implicitly cached every turn AND never windowed out (Dev no longer "forgets" the PRD on long
  runs); PLUS an explicit `cachedContents` block for system+tools (fail-open, `AIDLC_VERTEX_EXPLICIT_CACHE`).
- **No stage fails on budget:** budget-aware wind-down in the loop (at 80%/92% of the token budget it forces
  "write remaining files + finalize the JSON" instead of hard-failing at the cap).

**Honesty (the "shortcuts" the owner caught)**
- **Testing can't fake green:** the browser session detects an AUTH-WALL redirect → marks the journey
  BLOCKED (not passed); the Testing agent then asks for a test account (`needsInput`) instead of green.
  A real login can be supplied via `AIDLC_TEST_STORAGE_STATE` to actually verify behind-login flows.
- **Deploy/GTM tell the truth:** with auto-merge OFF (default), approving the PR now HOLDS at a
  `merge_confirmation` gate ("PR open — awaiting merge") — Deploy is NOT green and GTM does NOT run until
  the human confirms the merge/deploy actually happened.

**New capability**
- **Revise-stage (DAG re-plan):** edit an earlier stage (e.g. the PRD after Dev) → it re-runs that stage +
  everything downstream. New `reviseStage` on the orchestrator + `/aidlc/:id/revise` + UI ("Apply to:
  Revise <stage> + re-run downstream").
- **Work-item list: search + pagination.** Search via an ArangoSearch view (`${env}_aidlc_work_items_search`,
  auto-created, `text_en`) — never AQL CONTAINS. Paginated endpoint + FE search box + pager.

**Infra cost / retention**
- GCS lifecycle (prefix-scoped `aidlc/*`, dedicated bucket only, append-not-replace) → artifacts auto-delete
  after `AIDLC_ARTIFACT_TTL_DAYS` (30). Arango TTL index on run events (`AIDLC_EVENT_TTL_DAYS`, 30).
- Full infra review + every resource/secret/IAM/env is in **`AIDLC-PREDEPLOY-CHECKLIST.md`** (keep updated).

**UI/IA overhaul (AidlcTab):** URL deep-link (`?item=`); DAG strip shows the adaptive PATH label +
infra sub-flow tint + verdict (pass/fail) on verify stages + repair-loop indicator + non-clipped selection;
expandable log lines; file-grouped collapsible diffs; stage-select auto-switches the detail tab; clearer
Quality tab; subtle Defer action; Tests tab shows embedded VIDEO + honest "blocked"; full Request text shown.

**✅ CLI CERTIFICATION (live, Vertex on the owner's gcloud auth):** the bug→triage→fix→testing→deploy-PR
path is RELIABLE — **4 consecutive clean end-to-end runs** (PRs #1270–1273), each a real, idiomatic
ArangoSearch fix + regression test, coverage all-met, held honestly at the pr_approval gate. Ten runs total
surfaced + root-caused SIX agent-reliability tail modes, each fixed: coverage empty-output (→ critic
low-thinking + retry), over-exploration (→ hard write-cap removing read tools after N calls), code.read
budget blowout (→ read cap), fix turn-cap (→ independent turn wind-down + diff-synthesis salvage), triage
turn-cap (→ near-cap tool-strip), mid-run 401 (→ token refresh-retry). Plus: verdict stages now score from
their verdict (fixes "TESTING 0" → 92), and **testing is now ADAPTIVE + behavioural** — it RUNS the dev's
tests and verifies the areas the change dictates (API/DB/query/cache/UI), naming what it certified, rather
than only typechecking.

**Still open (documented, need the owner / a live env):** preview-deploy IN PROD (gcloud-in-worker or REST —
§6 of the checklist); a real UX/Stitch stage; builder latency measurement across more runs.

---

The AIDLC multi-agent pipeline is **built end-to-end and proven with real Gemini on Vertex** (adaptive
DAG, isolated Cloud Run Job workers, quality critic, fail-closed verifiers, conversation + multimodal,
Infra/DevSecOps pillar, reliability watchdog, honest gated deploy, and an eval backbone). Both repos are
**tsc-clean**. What remains is **provisioning + a local ADC reauth** (§5) and then **running monetization**
through the finished agent (§4).

---

## 1. ✅ Model blocker RESOLVED — Gemini 3.x family, global-only

Root cause was wrong model family + endpoint, never billing/access. Project `spilll-be` has the **Gemini
3.x** family (3.5-flash, 3.5-flash-lite, 3-flash-preview), and **Gemini 3.x on Vertex is GLOBAL-ONLY**
(regional endpoints 404 → location `global` → host `aiplatform.googleapis.com`). Fix applied in code
defaults + all workflow yamls: main loop on **`gemini-3.5-flash`**, high-volume critic/verifiers on
**`gemini-3.5-flash-lite`** (separate per-model quota → no 429 under burst). Two baked-in gotchas handled:
gemini-3.x are **thinking models** (thoughts draw from `maxOutputTokens`) → `thinkingConfig.thinkingLevel`
wired per stage + raised token caps; explicit prompt caching needs ≥4096 tokens on 3.x.

Prod Host Copilot + comm-runner WhatsApp agent were also migrated to Vertex (same family/endpoint) — see
the `gemini-vertex-migration` memory for the IAM grant + traffic-shift still owed on those two.

---

## 2. What is built (all tsc-clean, uncommitted — git is yours)

**Runtime (L0):** generic `runtime/loop.ts` over AgentConfig + Model + ServicePorts; `broker.ts`
(EXECUTE/PROPOSE/DENY); event-driven observability (`events.ts`/`tracer.ts`/`eventStore.arango.ts`).

**Orchestrator (the Supervisor):**
- `github.ts` — GitHub App token-mint (cached), clone/openPr/merge/branch + **`watchChecks`** (CI health). ✓ live.
- `ports.git.ts` — real clone→edit→tsc→commit→push→PR sandbox; **honest `GithubDeployPort`**: real CI
  check-run watch + **revert-PR rollback** (never a force-push). ✓ clone/write/diff/teardown live.
- `orchestrator.ts` — durable, resumable Supervisor: adaptive DAG, quality-critic + bounded revise,
  money + migration **fail-closed verifiers**, conversation-at-stage (`message`), multimodal attachments,
  gate at every risky stage, **safe-by-default deploy** (no auto-merge unless `AIDLC_AUTO_MERGE=1`), and the
  reliability **`sweepStuck` watchdog** (retry-once → dead-letter stranded workers).
- `dispatcher.ts` / `jobDispatch.ts` / `worker/main.ts` — **Cloud Run Job isolation** (the Dev agent runs
  arbitrary code inside a disposable Job, not in-process) + Pub/Sub result bridge. Built.
- `pubsub.ts`, `gcs.ts` (artifact storage), `ports.playwright.ts` (testing-as-a-session: screenshots/video/
  console/network/Lighthouse → GCS), `featureStore.arango.ts` (change-request lineage).
- `quality.ts` — per-stage weighted `STAGE_RUBRICS` (incl. triage/research/fix/infra_*), separate critic,
  `verifyMoneyPath` + `verifyMigration` (both fail-closed; migration rule is **conditional** — additive
  nullable column needs only a rollback, data-touching changes must backfill + expand→migrate→contract).
- `evals/` — **eval backbone** (L3): golden-set runner reusing the live critic + verifiers; structural +
  rubric-floor + verifier assertions; positive + trap cases; CLI (`evals/run-evals.ts`) that exits non-zero
  for CI. Seed set under `evals/golden/seed.ts`.

**Agents/tools:** `agents/aidlc/stages.ts` — all stage configs (triage/research/prd/ux/dev/fix/testing/
deploy/analytics/gtm + infra_plan/infra_change/infra_verify/infra_apply), `STAGE_THINKING`, `GATED_STAGES`,
`HEAVY`, and the **adaptive `AIDLC_DAG`** (triage classifies, then branches: bug/chore→fix, feature/change→
prd, infra/data-migration→infra_plan, spike→research; repair routes back to the builder).
`tools/aidlc/contracts.ts` — namespaced workflow tools incl. feature.*, sandbox.*, testing.browserSession,
security.scanDeps/scanSecrets, migration.dryRun.

**Control plane (`src/growth-part/api/ops/aidlc.ts`):** meta/list/submit/get/stream(SSE)/events/gate/answer/
**message**/**upload**/pubsub, staff-gated + audited.

**Frontend (`app/dashboard/ops/AidlcTab.tsx`):** adaptive DAG strip (incl. the 4 infra stages), triage
pills, Logs/Reasoning/Changes/Quality/Tests/Cost tabs, decision rail (gates incl. infra_plan/infra_apply),
conversation panel + file upload.

**Boot-safe:** the singleton is lazy; the watchdog interval only runs when `AIDLC_EXECUTION=job`.

## 3. The adaptive flow (what runs for what)

| Submitted kind | Pipeline |
|---|---|
| bug / chore | triage → fix → testing → deploy |
| feature / change | triage → prd → (ux) → dev → testing → deploy → gtm |
| spike | triage → research → prd → … |
| **infra / data-migration** | triage → infra_plan → infra_change → infra_verify → infra_apply |

Money path: `payment`/split changes gate at the deploy PR behind the money verifier. Data migrations gate
at infra_apply behind the migration verifier. Both verifiers are a **separate call** from the work.

## 4. Running the monetization work item (first real work item)

Keep `AIDLC_AUTO_MERGE` OFF (default). Submit the monetization brief (below) in the AIDLC tab → PRD agent
asks the fee %/free-event policy/host-vs-venue split → answer inline → approve PRD → Dev implements behind a
flag + a characterization test (riskTier=money) → Testing + money verifier → it opens a **real PR** you
review and merge. Nothing moves money; the output is a reviewed PR.

> Introduce platform monetization on paid RÉVE events: take a platform fee on each paid ticket and split the
> remainder toward the host+venue multi-participant split (R3). Prices stay GST-inclusive. `buildHostVendorSplit`
> today pays ~98% to a single host and the venue gets nothing — close that. Money path: characterization test
> of CURRENT behaviour FIRST, new split behind a flag, fail-closed verifier that revenueShare sums to exactly
> 1.0. Ask me the fee %, the free-event policy, and host-vs-venue split rule before the PRD.

## 5. Before go-live — your actions (I cannot commit/push, mutate prod, or do interactive auth)

1. **Local ADC reauth** (to validate the positive verifier eval cases locally): your shell exports a stale
   `GOOGLE_APPLICATION_CREDENTIALS` pointing at a non-existent `perpettum-assets/serviceAccountKey.json`, and
   the ADC token itself is `invalid_rapt`. Run: `! gcloud auth application-default login` and, for this repo's
   evals, `unset GOOGLE_APPLICATION_CREDENTIALS` first. (Cloud Run is unaffected — it uses the SA identity.)
2. **Provision** (once): `scripts/provision-aidlc.sh` (Job, Pub/Sub, Artifact Registry, IAM). Set backend env
   live: `AIDLC_ENABLED=true`, `AIDLC_EXECUTION=job`, `AIDLC_BACKEND_URL=https://prod-reve-backend-ilhbt7d72a-el.a.run.app`,
   `AIDLC_PUBSUB_SECRET=63d3b2c476d82053d510f68ccafa53281760edb611be9cfdbe9e30a91f24db9a` (+ the GitHub App ids /
   `--set-secrets AIDLC_GITHUB_APP_KEY`). Add the GH Actions secret `AIDLC_PUBSUB_SECRET`.
3. **Grant** `roles/aiplatform.user` to the backend + Job service accounts (Vertex) — see the vertex memory.
4. **Deploy** both repos.
5. **Never** set `AIDLC_EXECUTION=local` on prod (the Dev agent runs arbitrary code — Job isolation contains it).
6. **Enable live diagnostics** (read-only root-causing of prod bugs — §9 platform-owner call; reads prod/PII):
   - Flag: `AIDLC_DIAGNOSTICS=1` on the backend.
   - **Cloud Logging + Cloud Run** (`logs.query`, `runtime.status`): grant the backend's runtime service account
     `roles/logging.viewer` + `roles/run.viewer` (no key files). Project comes from `AGENT_GEMINI_VERTEX_PROJECT`;
     set `AIDLC_RUNTIME_SERVICE=prod-reve-backend` (+ optional `AIDLC_PREVIEW_REGION`, default `asia-south1`).
     Locally it uses your gcloud ADC.
   - **ArangoDB** (`db.query`): already wired to the backend's DB connection, READ-ONLY (writes refused). No creds.
   - **Redis** (`cache.inspect`): already wired to the app's Redis (`app.locals.redis`). No creds.
   All four are read-only by construction and return `{available:false}` until the flag + that source's access exist.

## 5b. Preview-deploy (the BrowserStack-style live Testing capture)

The Testing stage runs a Playwright browser session (screenshots/video/console/network/Lighthouse) against a
URL. Two ways to supply it:

**Local (what's enabled now):** `AIDLC_PREVIEW_URL=http://localhost:3000` points the session at the running
FE — no deploy needed. Requires `playwright` + `lighthouse` + `chromium` installed where Testing runs
(installed locally via `npm i --no-save playwright lighthouse chrome-launcher && npx playwright install chromium`).

**Prod (per-branch ephemeral preview):** set `AIDLC_PREVIEW_DEPLOY=1` and a per-repo service name
`AIDLC_PREVIEW_SERVICE_<REPO>` (e.g. `AIDLC_PREVIEW_SERVICE_PERPETUUM_REVE_GROWTH_SITE=preview-reve-growth`),
plus `AIDLC_PREVIEW_REGION`. Provisioning:
1. Enable Cloud Build API; create (or let `gcloud run deploy --source` create) a preview Cloud Run service per repo.
2. Grant the deploying identity `roles/run.developer`, `roles/cloudbuild.builds.editor`,
   `roles/iam.serviceAccountUser` (on the runtime SA), + Artifact Registry writer.
3. The Job worker image (`Dockerfile.worker`) must include the gcloud SDK + playwright/chromium — the preview
   deploy shells out to `gcloud`, which is NOT in the plain backend container. **KNOWN GAP:** preview-deploy is
   wired + repo-aware but currently runs in the orchestrator (backend, no gcloud); to work in prod it must run
   in the worker (add cloud-sdk to Dockerfile.worker) or via the Cloud Run Admin + Cloud Build REST APIs. This
   is the one remaining preview-deploy build item.

## 6. Deferred (enhancements, not safety gaps — documented so nothing ships silently capped)

- **Per-branch preview deploy** — real value, heavy infra; current deploy path (reviewed PR → existing CI)
  is safe without it.
- **Real UX/Stitch stage** + **real GTM outreach** + **workflow authoring** + **RBAC on money/infra gates**
  + **cost-ceiling enforcement** — Phase 5 depth; the gates + verifiers already enforce the safety invariants.
- **Grow the golden set** — the backbone ships with seed cases; every money/capacity/infra change should add
  a positive + trap case before it is trusted (constitution L3).

## 7. Housekeeping
- No branches pushed; no commits. `git` is yours.
- Scratchpad scripts live under the session scratchpad, not the repo.
