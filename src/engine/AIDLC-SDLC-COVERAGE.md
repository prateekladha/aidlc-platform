# AIDLC v0.5 — Full-SDLC coverage: adaptive flow + the Infra/DevOps/DevSecOps pillar

**Why:** the owner's bar is an AIDLC that taps **every** area of the SDLC and behaves like a **principal
engineer** (first-principles, not pattern-matching). Two structural gaps block that today: (1) one fixed
DAG with PRD-always — wrong for bugs and infra; (2) no Infra/DevOps/DevSecOps capability — real work needs
DB columns, migrations, provisioning, config, IAM, security. This doc designs both, plus the first-principles
behaviors and the interaction upgrades, and is the "before go-live" scope. Monetization runs only once this
is done.

---

## 0. First principles (the lens every stage reasons through)
1. **Understand before building.** Ambiguous ask → investigate + state assumptions + alternatives, don't guess.
2. **Right-size the process.** A one-line CSS bug and a money feature must not share the same ceremony.
3. **Irreversibility is the enemy.** Anything hard to undo (prod data, money, infra, IAM) ships with a
   *verified rollback* and a *dry-run* BEFORE it's applied, behind a human gate.
4. **A change is not done when it compiles.** Done = code + tests + (migration + rollback) + observability
   (metrics/logs/alerts) + security + docs. The agent's Definition of Done enforces all of these.
5. **Blast radius is assessed, not discovered.** Before acting, the agent states what it touches (users,
   events, money, infra) and the risk — surfaced at the gate.
6. **Nothing grades itself.** Separate critics/verifiers for quality, money, security, and migrations.
7. **The human is briefed, not bypassed.** Converse at any stage; approve every irreversible step.

## 1. The flaw today
`PRD → [UX] → Dev → Testing → Deploy → GTM`, entered at PRD, every time. A bug fix is forced through a
product-doc stage; an infra/migration change has nowhere correct to live. One size fits nothing well.

## 2. Work-item typing + the adaptive DAG
A cheap **Triage** stage runs first and classifies the item, then the supervisor selects the DAG + the
*depth* of each stage. Triage is a small, fast, low-thinking classifier (grounded in the codebase) that
asks clarifying questions if the type/surface is genuinely ambiguous.

```
WorkItem.kind:       bug | feature | change | chore | infra | data-migration | spike
WorkItem.surface:    fe | be | infra | data | cross
WorkItem.complexity: trivial | small | standard | large
WorkItem.risk:       standard | money | security | migration     (can be several)
```

**DAG per kind (illustrative — the pipeline spec, not hard-code):**
- **bug (be, small):** Triage → **Fix** (Dev, light brief: root-cause + minimal patch + regression test) → Testing → Deploy. No PRD/UX/analytics/GTM.
- **bug (fe):** Triage → Fix → Testing (+ browser session) → Deploy.
- **feature:** Triage → **PRD** (full) → [UX] → Dev → Testing → Deploy → GTM.
- **change-request:** Triage (loads feature lineage) → PRD (delta-focused) → … (as feature, but scoped to the change).
- **chore (deps/refactor):** Triage → Dev → Testing → Deploy.
- **infra / data-migration:** the Infra pipeline (§3).
- **spike:** Triage → **Research** (investigate, propose 2-3 approaches with trade-offs) → gate → converts into a typed work item.

So **PRD is for features**, bugs get a light fix-spec, infra/data get their own flow. Triage replaces
"PRD-always". The DAG becomes a **selector keyed by kind** (we already have the DAG abstraction + guards;
this generalizes it to multiple named DAGs).

## 3. The 8th pillar — Infra / DevOps / DevSecOps (the missing capability)
Real features/bugs need schema + infra + config + security work. The agent must do it — safely, through
gates, never by mutating prod directly.

### 3a. New tools (namespaced, contract-governed; vendor names never leak up)
- `migration.*` — Arango schema evolution: `plan` (what collections/fields/indexes/ArangoSearch views change),
  `characterize` (snapshot current data shape), `script` (write a reversible migration + backfill + rollback),
  `dryRun` (apply to a scratch copy / a bounded sample), `apply` (PROPOSE-tier, gated).
- `infra.*` — provisioning/config as code: `plan` (diff of Cloud Run/Pub-Sub/GCS/IAM/env), `write` (IaC or a
  reviewed gcloud/Terraform change into a PR), `apply` (PROPOSE-tier, gated), `rollback`.
- `config.*` — env vars, feature flags, scaling/resource params (CPU/mem/concurrency/min-instances), cache TTLs,
  model params: `propose` + `apply` (gated), always reversible, always diffed.
- `security.*` — `scanDeps` (CVEs), `scanSecrets` (leaked creds), `iamAudit` (least-privilege diff), `sast`.

### 3b. New stages / stage-variants (reuse the loop; new personas + rubrics + verifiers)
- **Infra-Plan** (PRD-analogue): the change, its **blast radius**, cost delta, and the **rollback plan**. Gated.
- **Infra-Change** (Dev-analogue): writes the migration script / IaC / config change into a PR (does NOT apply).
- **Infra-Verify** (Testing-analogue): `migration.dryRun` on a copy; `infra.plan` diff; `security.*`; a
  **fail-closed migration verifier** (reversible? backfill correct? rollback proven? no data loss?).
- **Infra-Apply** (Deploy-analogue): gated apply with the rollback staged; watch health; auto-rollback on failure.

### 3c. Safety (mirrors the money path — irreversible ⇒ fail-closed)
- A migration PR MUST contain: a forward script, a **rollback script**, a dry-run result, and a
  characterization of current data. The migration verifier fails closed if any is missing.
- IAM/infra changes are **least-privilege diffed** + human-approved; prod is never mutated without a gate.
- DevSecOps gate: dependency CVEs / secret leaks / SAST run as a stage gate on every change (not just infra).

### 3d. Cross-cutting into normal work
When Dev touches a collection in a way that needs a schema/index/view change, Triage marks
`risk: migration` and the pipeline **inserts the migration sub-flow** (plan → script → dryRun → verify)
alongside the code — so "add a column" is handled as part of the feature, with its rollback, not forgotten.

## 4. First-principles reasoning as a first-class behavior
- Every stage persona must **state its assumptions + the alternatives it considered + why it chose this** —
  surfaced to the human (so a flawed premise is caught early). Add a **"reasoning quality"** criterion to
  every rubric (penalize unexamined assumptions and single-option thinking).
- **Rollback-first / blast-radius** are explicit PRD/Infra-Plan outputs, scored by the critic.
- **Definition of Done** (§0.4) is encoded as acceptance criteria the Testing/verifier stages enforce.

## 5. Interaction upgrades (owner-requested)
- **Conversation at each stage:** a free-form "message the agent" at any stage (redirect, add context, change
  approach) → injected into the stage's thread → it re-plans. A per-work-item conversation thread; the loop
  is already conversational, so this is an intake + re-entry seam, not a new engine.
- **Multimodal inputs:** attach screenshots / images / PDFs to the submit, a clarify answer, or a stage
  message. Stored in GCS; passed to the agent as image/file parts (gemini-3.x is multimodal; the repo
  already does vision extraction). A bug screenshot, a design mockup, a spec PDF become real agent input.

## 6. Before go-live — the complete checklist (prioritized)
**Foundation (everything else builds on it):**
- [ ] Work-item typing + Triage + adaptive DAG selector (§2).
- [ ] Conversation-at-stage + multimodal intake (§5) — the interaction substrate.

**The Infra pillar (§3):** migration/infra/config/security tools + the Infra pipeline + fail-closed verifiers.

**Reliability + ship-tail (the go-live blockers):**
- [ ] Dispatched-stage **timeout + dead-letter + alert** (a dead worker must not hang an item forever).
- [ ] **Gated auto-deploy** made real: merge → deploy → **watch health → post-deploy test → auto-rollback**.
- [ ] **Per-branch preview deploy** so browser testing hits the real change.
- [ ] **Per-stage evals** (golden sets + fail-closed verifier sub-agents) — the L3 regression backbone.

**Depth / polish:**
- [ ] Real UX/Stitch stage; real GTM outreach.
- [ ] Workflow authoring (the versioned pipeline spec that §2's named DAGs formalize).
- [ ] RBAC on money/infra-gate approvals; cost-ceiling enforcement (budget already on the Work Item).

## 7. Build order
1. **Typing + Triage + adaptive DAG** (unblocks bug-flow + the infra pipeline).
2. **Conversation + multimodal** (how it feels to use; needed for good intake).
3. **Infra/DevOps/DevSecOps pillar** (tools + stages + verifiers).
4. **Reliability + ship-tail** (timeout/dead-letter, real gated-deploy, preview, evals).
5. **Depth/polish** (UX/Stitch, GTM, authoring, RBAC, cost ceilings).
6. **Then** run monetization through the finished agent.
