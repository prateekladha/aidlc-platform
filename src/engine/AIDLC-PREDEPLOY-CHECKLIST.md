# AIDLC — Pre-deployment checklist (living doc)

Everything that must exist / be set BEFORE AIDLC runs in an environment. Keep this updated as the system
grows — it is the single list the platform owner works down. **We do NOT deploy until local is validated
and the owner signs off.** `[ ]` = you (owner) action · `[auto]` = created/handled by code at runtime.

Legend for scope: **dev** = `spill-dev-backend` + `spill-comm-dev-backend` (branch `master`) ·
**prod** = `prod-reve-backend` + `prod-reve-comm-backend` (branch `production`).

---

## 0. Local validation first (before ANY deploy)

- [ ] `gcloud auth application-default login` (ADC) — and `unset GOOGLE_APPLICATION_CREDENTIALS` for this
      repo's evals (a stale key path breaks ADC). Vertex + diagnostics use ADC locally.
- [ ] Run a work item of each path locally and confirm it completes: bug (diagnostics→fix→PR),
      full feature (PRD→…→GTM), money (host/venue split), infra/migration.
- [ ] Confirm the integrity fixes behave: Testing asks for a test account on an auth-walled journey (not
      green); Deploy holds at "PR open — awaiting merge" and GTM does NOT run until you confirm the merge.
- [ ] `npx tsc --noEmit` clean in BOTH repos (backend + reve-growth-site).

---

## 1. GCP resources

### 1a. Artifact storage (GCS)
- [ ] **Create a DEDICATED bucket** for AIDLC artifacts (screenshots/video/lighthouse/trace), e.g.
      `gs://aidlc-artifacts-prod` / `gs://aidlc-artifacts-dev`. Do NOT reuse the shared assets bucket — a
      shared bucket's lifecycle must never be clobbered.
      `gcloud storage buckets create gs://aidlc-artifacts-prod --location=asia-south1 --uniform-bucket-level-access`
- [ ] Set `AIDLC_ARTIFACTS_BUCKET` to that bucket per env (see §4). When set, the backend **`[auto]`**
      installs a prefix-scoped lifecycle rule (`aidlc/*` deletes after `AIDLC_ARTIFACT_TTL_DAYS`, default 30)
      on first upload — appended to existing rules, never replacing them.
- [ ] Grant the runtime SA object admin on the bucket:
      `gcloud storage buckets add-iam-policy-binding gs://aidlc-artifacts-prod --member="serviceAccount:968292609647-compute@developer.gserviceaccount.com" --role=roles/storage.objectAdmin`
- [ ] If the SA lacks `storage.buckets.update` (so the `[auto]` lifecycle can't self-install), apply it manually:
      ```
      printf '{"rule":[{"action":{"type":"Delete"},"condition":{"age":30,"matchesPrefix":["aidlc/"]}}]}' > /tmp/lc.json
      gcloud storage buckets update gs://aidlc-artifacts-prod --lifecycle-file=/tmp/lc.json
      ```

### 1b. Cloud Run Job (isolated heavy-stage worker)
- [ ] Provision via `scripts/provision-aidlc.sh` (Job, Artifact Registry, Pub/Sub, IAM) — once per env.
- [ ] The worker image `Dockerfile.worker` must include: node + the app, **playwright + chromium**
      (browser testing), **lighthouse + chrome-launcher**, and — for prod preview-deploy — the **gcloud SDK**
      (see §6). Confirm the image builds and the Job references it.
- [ ] Job sizing: CPU ≥ 1, memory sized for `tsc`/installs (≥ 2Gi), **task timeout** generous (heavy Dev
      can run 15+ min) but bounded, **max retries = 1** (a stuck stage is dead-lettered by the watchdog, not
      retried forever). Executions auto-expire; no min-instances (Jobs are run-to-completion).

### 1c. Pub/Sub (worker result bridge)
- [ ] Topic + push subscription for worker completion → `/.../aidlc/pubsub` (see provision script).
- [ ] Set message **retention** to a few hours (not days) and attach a **dead-letter topic** (max 5
      delivery attempts) so a poison result doesn't redeliver forever.
- [ ] Push auth: the subscription posts with `AIDLC_PUBSUB_SECRET` (shared secret header) — set it in env + GH
      secrets (§3/§4).

### 1d. Vertex AI (Gemini 3.x)
- [ ] Grant `roles/aiplatform.user` to BOTH the backend runtime SA and the Job SA (Gemini on Vertex, global
      endpoint). Project `spilll-be`, location `global`, models `gemini-3.5-flash` + `gemini-3.5-flash-lite`.
- [ ] We are **not** raising quota in dev — the code stays under it via a global concurrency gate
      (`AIDLC_VERTEX_MAX_CONCURRENCY`, default 3) + exponential-backoff retry + implicit/explicit caching.
      If prod throughput needs more, raise `AIDLC_VERTEX_MAX_CONCURRENCY` **and** request a QPM increase
      together — not one without the other.

---

## 2. IAM grants (summary)

| Grant | On | To | Why |
|---|---|---|---|
| `roles/aiplatform.user` | project | backend SA + Job SA | Vertex Gemini |
| `roles/storage.objectAdmin` | artifacts bucket | runtime SA | write run artifacts |
| `roles/storage.admin` *(or buckets.update)* | artifacts bucket | runtime SA | `[auto]` lifecycle (optional; else manual §1a) |
| `roles/logging.viewer` | project | backend SA | diagnostics `logs.query` (if `AIDLC_DIAGNOSTICS=1`) |
| `roles/run.viewer` | project | backend SA | diagnostics `runtime.status` |
| `roles/run.developer` + `roles/cloudbuild.builds.editor` + `roles/iam.serviceAccountUser` + AR writer | project | deploying identity | prod per-branch preview-deploy (§6) |
| Pub/Sub publisher/subscriber | topic/sub | backend + Job SA | worker result bridge |

---

## 3. GitHub

- [ ] **GitHub App** (writes PRs to every Perpetuum repo): `AIDLC_GITHUB_APP_ID`, `AIDLC_GITHUB_INSTALL_ID`,
      and the private key. Locally a key FILE (`AIDLC_GITHUB_KEY_FILE`); in Cloud Run mount the key as a
      secret (`--set-secrets AIDLC_GITHUB_APP_KEY=...`). PRs target each repo's DEFAULT branch
      (`master`, or `main` for giraffe/Spilll) — never `production`.
- [ ] **GH Actions secrets** (for the deploy workflows that bake env into the services):
      `AIDLC_PUBSUB_SECRET`, `AIDLC_BACKEND_URL`, `AIDLC_DEV_BACKEND_URL`, `AIDLC_MONEY_APPROVERS`,
      `AIDLC_INFRA_APPROVERS`, and the GitHub App id/install/key secret.
- [ ] Keep `AIDLC_AUTO_MERGE` **unset/0** everywhere until explicitly chosen — the honest default leaves the
      PR for a human to merge, and GTM only runs after you confirm the merge.

---

## 4. Env vars (per service, dev + prod deploy yamls)

Set these in BOTH the dev and prod deployment yamls (backend; comm-runner only needs the ones it uses).
**Bold = new this round (25 Oct) — must be added.**

**Core**
- `AIDLC_ENABLED=true`
- `AIDLC_EXECUTION=job` (prod) — NEVER `local` in prod (the Dev agent runs arbitrary code; Job isolation
  contains it). `local` is fine on a dev box only.
- `AIDLC_BACKEND_URL` / `AIDLC_DEV_BACKEND_URL` — the service's own base URL (worker callbacks).
- `AIDLC_PUBSUB_SECRET` — shared push-auth secret.
- `AIDLC_RUNTIME_SERVICE=prod-reve-backend` (diagnostics target) · `AIDLC_PREVIEW_REGION=asia-south1`.

**Model / cost / 429 (new)**
- **`AIDLC_VERTEX_MAX_CONCURRENCY=3`** — global cap on concurrent Vertex calls (the main 429 defense).
- **`AIDLC_VERTEX_MAX_RETRIES=8`** — backoff retries on 429/503/500.
- **`AIDLC_VERTEX_EXPLICIT_CACHE=1`** — cache system+tools block (set `0` to disable; fail-open regardless).
- **`AIDLC_VERTEX_CACHE_TTL=900`**, **`AIDLC_VERTEX_CACHE_MIN_CHARS=16000`** — explicit-cache tuning.
- **`AIDLC_MAX_OUTPUT_TOKENS=16384`** — output cap for the thinking models (lower caused empty turns).
- `AIDLC_VERTEX_PROJECT=spilll-be`, `AIDLC_VERTEX_LOCATION=global`, `AIDLC_VERTEX_MODEL=gemini-3.5-flash`.

**Reliability (new — defaults are fine; override only to tune)**
- **`AIDLC_HARD_WRITE_CAP=22`** — after this many read-only calls a builder's search/read tools are removed so it MUST write (kills the over-exploration spiral).
- **`AIDLC_CODE_READ_MAX=50000`** — cap (chars) on an exploration `code.read` so one huge file can't blow a stage's token budget (write-phase `sandbox.readFile` stays uncapped).
- (No env) a near-turn-cap **tool-strip** forces the final JSON; critic/verifier calls **retry at low thinking**; the Vertex client **refreshes the token on a 401/403**. These are built-in, not configured.

**Retention (new)**
- **`AIDLC_ARTIFACTS_BUCKET=aidlc-artifacts-<env>`** — dedicated bucket (enables the `[auto]` lifecycle).
- **`AIDLC_ARTIFACT_TTL_DAYS=30`** — GCS auto-delete age for `aidlc/*`.
- **`AIDLC_EVENT_TTL_DAYS=30`** — Arango TTL on the run-event collection (`[auto]` index on `ts`).

**Testing (new, optional)**
- **`AIDLC_TEST_STORAGE_STATE`** — a Playwright storageState (JSON or path) for a DISPOSABLE test account, so
  behind-login journeys can actually be verified. Absent → those journeys report BLOCKED and Testing asks
  for one (it never fakes green). Never a real user's credentials.

**Preview-deploy (optional, §6)**
- `AIDLC_PREVIEW_URL` (local only) · `AIDLC_PREVIEW_DEPLOY=1` + `AIDLC_PREVIEW_SERVICE_<REPO>` (prod).

**Approvers / gates**
- `AIDLC_MONEY_APPROVERS`, `AIDLC_INFRA_APPROVERS` — comma-separated user ids allowed to approve money/infra
  gates (empty = any staff, still audited).

**Diagnostics (owner call — reads prod/PII)**
- `AIDLC_DIAGNOSTICS=1` + the logging.viewer/run.viewer grants (§2). Off by default.

---

## 5. ArangoSearch + indexes (`[auto]`, verify)
- `[auto]` The work-item **search view** `${env}_aidlc_work_items_search` is created on first search (title +
  original request + repo, `text_en`). No manual step; verify it exists after first use. (If you prefer
  explicit provisioning, add its key to `rebuildAgentViews.ts` and run it.)
- `[auto]` The event store gets a **TTL index** on `ts` + the `(workItemId, seq)` persistent index.
- Search uses the view (never AQL CONTAINS) — the recurring hard rule.

---

## 6. Preview-deploy in prod (BUILT — needs provisioning + a Cloud-Build cert run)
The BrowserStack-style live Testing capture needs a real running preview. Local works via
`AIDLC_PREVIEW_URL`. Prod per-branch preview is now **implemented in the right place**: the Testing WORKER
stands it up (`runStageIsolated`), and `Dockerfile.worker` now ships the gcloud SDK, so
`GcloudPreviewDeployPort` can `gcloud run deploy --source` from the worker (self-contained clone,
`--no-traffic --tag`, torn down after). Remaining is pure PROVISIONING (can only be certified against real
Cloud Build):
- [ ] Rebuild + push the worker image (now includes google-cloud-cli) and point the Job at it.
- [ ] Enable Cloud Build API; grant the deploying identity the roles in §2; set `AIDLC_PREVIEW_DEPLOY=1` +
      `AIDLC_PREVIEW_SERVICE_<REPO>` per repo (e.g. `AIDLC_PREVIEW_SERVICE_PERPETUUM_REVE_GROWTH_SITE`).
- [ ] Cert run: submit a FE work item and confirm the worker deploys a `wi-<id>` tagged preview revision and
      the browser session hits it (not `AIDLC_PREVIEW_URL`).

### 6b. UX / Stitch (optional external visual generator)
The UX stage writes a concrete, implementable spec grounded in the live design system on its own. To ALSO
get generated visuals, set **`STITCH_API_URL` + `STITCH_API_KEY`** (both the local + git design ports call
it when present, and are honest when absent — never a fake "pending"). Optional; the pipeline is complete
without it.

---

## 7. Demo / housekeeping before go-live
- [ ] Close the demo PRs opened during validation (BE #1266–1269, reve #95/#96) and any new ones.
- [ ] No `git` committed/pushed by Claude — the owner owns all staging/commit/push.

---

_Last updated: 2026-10-25 (added: Vertex concurrency/caching/retry env, GCS + Arango retention, test
storageState, work-item search view, revise-stage re-plan)._
