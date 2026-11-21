# AIDLC Platform — Architecture & Strategy (living doc)

> Standalone SaaS productization of the AIDLC autonomous-delivery agent (spun out of Perpetuum).
> Working dir: `~/git/aidlc-platform/`. Owner drives all git + infra provisioning.
> Status: **v0.1 — founding architecture**, drafted 29 Oct 2026. Research-enriched sections marked ⟳.

---

## 0. The bet, in one paragraph
We are turning the proven AIDLC engine (adaptive PRD→Dev→Test→Deploy→GTM agent, with fail-closed gates,
instruction-coverage, honest deploy, and full observability — now certified reliable end-to-end) into a
**multi-tenant SaaS** that onboards product- and service-companies and delivers software **autonomously,
with governance and cost control built in**. The engine is ~20% of the work; the platform around it
(multi-tenancy, isolation, onboarding, secrets, billing, observability-as-a-product, GTM) is the other ~80%.

## 1. Decided foundations (the four forks — 29 Oct)
| Decision | Choice | Rationale |
|---|---|---|
| **Model economics** | **BYO-key (default) + Managed (upsell), both from day one** | BYO removes margin risk + ships instantly; managed (metered + markup) is the convenience upsell. Both wired → doubles billing surface, accepted. |
| **Cloud** | **Oracle Always-Free to start, strictly cloud-PORTABLE** | $0 to start on genuinely capable free compute; no SLA / idle-reclaim is the known risk → mitigated by portability + a credits escape hatch (GCP/AWS startup programs) the moment a paying/enterprise client needs an SLA. |
| **Tenant isolation** | **Shared control plane (row-level `tenant_id`) + per-run ephemeral isolated compute** | Scalable, secure default. Every agent run executes in a fresh isolated unit with JIT secrets, torn down after. Dedicated stacks reserved for enterprise. |
| **GTM wedge** | **Platform delivers ALL 3**; **LEAD with governance/trust, PROVE with cost, DELIVER end-to-end** (research-refined) | Trust is the market's #1 blocker + EU AI Act tailwind (Aug 2026) → governance is the tip of the spear (and our engine's DNA); cost is the ROI proof; PRD→GTM is the differentiated vision. Beachhead: mid-market platform-eng. See §6. |

**Non-negotiables now (were "nice to have" internally):** scalability, reliability, fail-safe isolation,
no hardcoding, per-tenant config, auditable governance. These are the product's trust surface.

---

## 2. Product
### 2.1 What a tenant gets
- Connect their GitHub (later GitLab/Bitbucket), whitelist repos → submit work items (bug/feature/change/
  infra/migration) in natural language → the agent runs the adaptive SDLC and opens a reviewed PR, with
  gates at every risky step. Nothing merges/deploys without their approval (same honest-deploy model).
- **Observability-as-a-product (wedge #2):** a live dashboard of delivery velocity, reliability, coverage,
  and **cost — both cloud and AI spend** — per repo/team/run. This is how the client tracks their own
  performance AND where our cost-optimization offering lives.
- **Governance (wedge #3):** fail-closed money/migration verifiers, instruction-coverage gates, honest
  "PR open → awaiting merge" states, full audit trail — "autonomous delivery you can trust + audit."
- **End-to-end (wedge #1):** not just code — PRD, UX spec, adaptive testing (runs the real tests),
  deploy-as-PR, and GTM.

### 2.2 Surfaces (current vs needed)
- **Have:** backend + web (Next.js) are first-class; adaptive behavioral testing (runs the dev's tests);
  browser preview/testing; infra/migration sub-flow.
- **Need (#2 Mobile):** mobile **dev** (Flutter / React Native / Swift/Kotlin) + mobile **UI/UX** stage +
  mobile testing (emulator/simulator, or a device-farm integration, or Appium). The stage agents are
  largely language-agnostic (they read the repo + follow its conventions); the gaps are: the UX/design
  stage for mobile, the testing harness (no browser — need emulator/device), and preview (no URL — a build
  artifact / TestFlight-style channel). Treat as a Phase-2 surface expansion, not a rewrite.

---

## 3. Architecture spine

### 3.1 Two planes
```
┌───────────────────────────── CONTROL PLANE (shared, multi-tenant) ─────────────────────────────┐
│  API + Auth (tenant/user/RBAC)   Tenant & Config service (config→DB)   Billing/metering (Stripe) │
│  Onboarding (GitHub App installs, repo whitelist)   Secrets vault (per-tenant)   Observability    │
│  Orchestrator (the AIDLC Supervisor, now tenant-scoped)   Work-item store   Event store           │
└───────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                                 │ dispatch one run
                        ┌────────────────────────▼────────────────────────┐
                        │  DATA PLANE (per-run, ephemeral, ISOLATED)        │
                        │  fresh microVM / container-sandbox per run        │
                        │  • clones ONLY the tenant's whitelisted repo      │
                        │  • JIT-injected tenant secrets (model key, etc.)  │
                        │  • runs the agent + the agent-written + repo code │
                        │  • no network except allow-listed egress         │
                        │  • destroyed on completion; secrets never persist │
                        └───────────────────────────────────────────────────┘
```

### 3.2 Multi-tenancy (row-level)
- Every control-plane record carries `tenant_id`; every query is tenant-scoped at the data-access layer
  (a repository wrapper that injects `tenant_id` — never trust the caller). Enforced centrally so no handler
  can leak across tenants. (If we adopt Postgres, back it with RLS policies as defense-in-depth.)
- `tenant` → `users` (RBAC: owner/admin/member) → `installations` (GitHub) → `repos` (whitelisted) →
  `workItems` → `runs` → `events`. All tenant-scoped.

### 3.3 Per-run isolation & security — THE trust surface  ⟳
This is the make-or-break. We run **agent-written code + the client's repo code** for **untrusted tenants**.
**Decision (research-confirmed):** the per-run compute is a **pluggable `Sandbox` provider**, and the correct
isolation boundary for hostile code is a **Firecracker microVM (dedicated kernel per run)** — NOT plain
Docker, and NOT OCI Always-Free (see §4: A1 is 2 OCPU, capacity-starved, idle-reclaimed — unfit for bursty
run compute). Ship on a **managed microVM sandbox (E2B)** as impl #1 (ms-level create/exec/teardown, TS SDK,
purpose-built for per-agent-run execution, zero capacity risk); keep a `Sandbox` interface so impl #2 can be
self-hosted Firecracker/Kata on GKE/EKS once credits land. The AIDLC `JobDispatcher` already models this
seam — we add an `E2BSandbox` implementation and tenant-scope it.
Rules:
1. **One isolated microVM per run** (Firecracker-class, dedicated kernel). No run shares kernel/FS/network
   with another tenant's run. gVisor (Modal) is the lighter fallback but a weaker boundary for hostile code.
2. **JIT secret injection:** the tenant's model key + any cloud creds are fetched from the vault at run
   start, injected as env into the isolated unit, and **never written to disk, logs, or the shared plane**.
   Destroyed with the unit.
3. **Least privilege:** the run can reach GitHub (only the tenant's whitelisted repo, via a short-lived
   installation token scoped to that repo) + the model endpoint + nothing else (egress allow-list).
4. **Resource caps:** CPU/mem/time/token budget per run (we already have token budget + wind-down); add
   wall-clock + network caps. A runaway/abusive run is killed + billed, never unbounded.
5. **Supply-chain:** the run installs the tenant repo's deps in isolation; we never execute untrusted
   postinstall scripts on the shared plane.

### 3.4 Reuse the engine
The AIDLC engine ports cleanly — it's already parameterized (`AgentConfig`, `ServicePorts`, adaptive DAG,
fail-closed verifiers, observability events, the hardened loop). The port work is: (a) make `targetRepo`,
approvers, policies, model selection, feature flags **per-tenant config** (not env/hardcoded); (b) make the
GitHub App **multi-install** (one installation per tenant, token minted per-tenant-per-repo); (c) make the
dispatcher tenant-aware (isolated unit tagged with tenant+run); (d) point the stores at the control-plane DB
with `tenant_id`.

### 3.5 Config → DB (no hardcoding — #9/#10)
Everything currently in env/const becomes per-tenant DB config, resolved at run start into the engine's
`AgentConfig`/ports:
- repo catalog + default branch rules, model + critic model + thinking levels, stage limits + budgets,
  money/infra approvers + RBAC, auto-merge policy, preview-deploy config, artifact TTLs, feature flags,
  BYO-key vs managed, egress allow-list. A `TenantConfig` service is the single resolver; the engine reads
  only from it. (Platform-level defaults live in code; tenant overrides in DB.)

### 3.6 Onboarding (#10) — ⟳ research-confirmed
A **GitHub App** (NOT an OAuth App — the documented anti-pattern for source access). Flow: tenant admin
installs the App on their org/account → GitHub's **"All vs Only-select repositories"** screen IS our repo
whitelist (default to *select* for least privilege; org repos need an **org Owner** to approve). We get an
**installation id**; authenticate as the App (JWT signed by the App private key) → exchange for a
**per-installation access token (~1h, auto-rotated, down-scopable per repo)** for clones/PRs.
**Least-privilege scopes:** `Contents: Read & Write` (clone + push the PR branch — write is unavoidable for
push-based PRs; the fork-PR alternative drops to Contents:Read but complicates UX), `Pull requests: R/W`,
`Metadata: Read` (mandatory), `Issues: R/W` *(only if issue-triggered)*, `Checks: Write` *(optional)*.
Never request Administration/org-member/secrets. **Webhooks:** one endpoint, verify `X-Hub-Signature-256`
HMAC. **Multi-tenant security rule (the documented cross-tenant leak vector):** always resolve each event to
its installation id AND verify the acting user is entitled to that installation — never trust the payload.

### 3.7 Secrets vault — ⟳ research-confirmed
**`SecretProvider` interface → HashiCorp Vault with namespaces (one namespace per tenant)** as impl #1 — the
reference pattern for cryptographic + policy isolation between tenants on shared infra (AWS SaaS Factory
publishes the EKS+Vault sample), and portable across OCI/GCP/AWS (vs cloud-native Secrets Managers which
can't give per-tenant cryptographic isolation — fine for *platform* secrets, weak for *per-tenant BYO*).
**JIT lease-and-inject:** at run start the control plane fetches the tenant's secret (short-lived Vault
lease) and injects it into the ephemeral microVM at launch, scoped to that single run, destroyed with the
sandbox — **never written to disk/logs/image/shared-plane**. For client cloud creds, prefer short-lived/STS
(OIDC federation) over long-lived keys so a leaked run can't outlive itself. (A Dapr secret-store component
per tenant is the lighter abstraction if we want to defer Vault Enterprise.)

### 3.8 Billing & metering
Stripe. Meter: runs, tokens (for managed), seats. BYO-key tenants are billed platform fee (seat/run);
managed tenants billed usage + markup. Every run already emits cost events → the meter reads those. Hard
caps + alerts per tenant (never a surprise bill, never unbounded spend).

### 3.9 Observability as a product (#6)
The internal event stream (`events.ts`/tracer/eventStore) becomes a **client-facing** product: per-run
timeline, quality/coverage, test evidence (video/logs), and the **cost ledger (cloud + AI)**. This is both
our ops tooling AND the client's dashboard AND the cost-optimization surface. Multi-tenant + RBAC-scoped.

---

## 4. Cloud (Oracle-portable) — ⟳ research-confirmed
**Reality check (changed everything):** OCI Always-Free's A1 ARM was **halved to 2 OCPU / 12 GB RAM** (June
2026), A1 capacity is chronically "out of host capacity," and idle instances are **reclaimed** (7-day p95
CPU/net/mem < 20%). OKE's control plane is free but **worker nodes still consume your 2-OCPU A1 budget**.
So OCI Always-Free is **control-plane-only**, never the hot path.

**The split:**
- **OCI Always-Free hosts (always-on, cheap, fits):** the control-plane API + scheduler + webhook receiver +
  dashboard (containers), the DB (Autonomous DB **2× 1-OCPU/20 GB**, or self-hosted Postgres on A1 — keep
  ANSI so it lifts to Cloud SQL/RDS), object storage (20 GB, S3-compatible), and **10 TB/mo egress** (the
  real sweetener). No SLA → keep warm + health-checked + IaC-reproducible; graduate before any enterprise SLA.
- **Per-run agent compute lives OFF OCI** on the pluggable `Sandbox` provider (**E2B/Firecracker**, §3.3) —
  bursty, untrusted, money-burning, decoupled. This keeps the risky tier out of the capacity-starved free
  tier entirely.
- **Three portability seams** (the only places provider SDKs appear): object storage → **S3 API**; secrets →
  **`SecretProvider`**; per-run compute → **`Sandbox`**. Everything else is OSS (Postgres/Valkey/containers)
  + **Terraform/OpenTofu**, so OCI→GCP/AWS is a provider swap + three impls, not a rewrite. Kubernetes (OKE
  basic now → GKE/EKS on credits) is the substrate.

**Credits sequence (research):** grab **Microsoft Founders Hub ($150K Azure, no gate)** + **AWS Activate
Founders ($5–10K, no investor)** now; pursue **Google for Startups AI-first ($350K)** the moment there's a
SAFE/round or an accelerator (an accelerator Org ID also unlocks AWS's $200K + Google's Scale tier — joining
one is the single highest-leverage credit move). These fund the GKE/EKS + self-hosted-Firecracker move.

---

## 5. Phased roadmap
- **Phase 0 (now):** decisions ✓ · research (competitors/GTM + platform) · this doc · Phase-1 design ·
  pre-provisioning checklist · repo scaffold.
- **Phase 1 — Multi-tenant foundation (MVP):** new repo ✓scaffold · tenant model + RBAC + auth ·
  config→DB · GitHub-App onboarding + repo whitelist · secrets vault · engine ported tenant-aware ·
  per-run isolation (hardened dispatcher) · control-plane API · basic billing (BYO-key) · the client
  dashboard (runs + cost). **Goal: one external pilot tenant runs a real work item → reviewed PR.**
- **Phase 2 — Product depth:** managed-model billing + metering · mobile dev + UI/UX + mobile testing ·
  cost-optimization scans (cloud + AI) as a feature · richer observability · GitLab/Bitbucket.
- **Phase 3 — GTM + scale:** marketing site + domain + SEO/GEO + competitor pages + blogs · ChatGPT/Claude
  discoverability · self-serve signup · enterprise (SSO, dedicated isolation, audit exports) · SOC2 path.

---

## 6. GTM ⟳ (research-confirmed)
**Market:** agentic-SDLC ≈ $1.8B (2025), >40%/yr. The defining fact: **trust is the bottleneck** — only
~13% of orgs run AI across the full SDLC, ~46% of agent PRs get rejected, and every incumbent draws the same
two complaints: **can't-trust-the-output** and **unpredictable cost**. Fastest-growing segment = **mid-market
(50–500 devs)**, under-served between $20 PLG toys and $16K/yr enterprise floors.

**Positioning (the lead hook — refined by research): lead with GOVERNANCE, prove with COST, deliver END-TO-END.**
- The whitespace is real on all three: **no one owns PRD→GTM** (all players are code/PR-anchored), **no
  coding player integrates cloud/AI-cost optimization** (FinOps is a separate category), and **governance is
  sold as a bolt-on review layer, never the spine.**
- **Lead = Governance / trustworthy autonomy** (tip of the spear): it's the market's actual blocker + has a
  hard regulatory tailwind (**EU AI Act high-risk enforceable 2 Aug 2026** — Art. 10/12/14 demand lineage-
  backed auditability + human oversight). It maps *exactly* to our engine's DNA (fail-closed verifiers,
  "nothing grades itself," instruction-coverage, honest deploy, full audit trail). Buyer: enterprise/mid-
  market platform-eng + eng leadership + security/compliance — the people who currently say no.
- **Prove = Cost (cloud + AI):** the ROI artifact that weaponizes the #1 complaint about Cursor/Replit/Amp.
  "Our agents pick the cheapest adequate model + cut token/cloud spend X%, here's the dashboard." (Our #6.)
- **Vision = End-to-end PRD→GTM:** strongest differentiation, land it PLG with founders/SMB/service-cos.
- **One-liner:** *"The autonomous delivery platform you can trust in production — provably correct,
  cost-governed, PRD to GTM."* **Beachhead buyer: mid-market platform-eng leaders.**

**Pricing:** $20 individual anchor is universal; power tier $100–200; team seats $19–48; the category is
migrating to usage/credits (41% hybrid now) and getting flamed for unpredictability. **Open lane: outcome-
based** (per-merged-PR / per-shipped-feature) — nobody does it credibly, and it reinforces both trust + cost.
Plan: $0 (free/OSS) → $20 self-serve → team seats + usage → enterprise (dedicated isolation, SSO, audit
exports); offer an **outcome option** ("pay when it ships; we show you what it cost to run").

**GTM playbook (what works here):** PLG land → sales-led expand (hybrid "full-stack GTM" — Cursor hit $2B
ARR before real enterprise AEs); **marketplace-native** install (GitHub Marketplace 2-click first, then
JetBrains + GCP); **free-for-OSS** top-of-funnel (seeds corpus + GEO authority — CodeRabbit/Qodo model);
**benchmark + competitor-comparison content** as native currency; and **GEO is first-class** — 40% of B2B
research now happens in ChatGPT/Perplexity/Gemini (87% of AI referrals from ChatGPT). Being *the answer* to
"most trustworthy autonomous coding agent / how to govern AI-written code / how to cut AI coding cost" is the
single highest-leverage channel (and leverages our existing ChatGPT-inbound strength).

**90-day moves (prioritized):** (1) ship a **governance/trust manifesto + an open verification/eval
benchmark** mapped to EU AI Act Art. 10/12/14; (2) build the **GEO engine** (allow GPTBot/ClaudeBot/
PerplexityBot, `llms.txt`, answer-block content on the 3 target queries, weekly citation tracking); (3)
**competitor-comparison + "cost alternative" pages** (vs Devin / Cursor-Copilot-agent); (4) a public **AI/
cloud-cost calculator + live cost-governance dashboard**; (5) **GitHub Marketplace + free-OSS** distribution;
(6) **PLG beachhead at mid-market platform-eng**; (7) pilot **outcome pricing**; (8) launch loud with
**proof, not demos** (open benchmark + a verifiable PRD→GTM reference build + 2–3 design-partner logos with
hard numbers — Devin got burned on curated demos); (9) weekly **dogfooding content**; (10) **avoid the
consolidation trap** — do NOT position as "another AI reviewer" or "another autonomous engineer" (the review
category is consolidating: Graphite→Cursor, Amp out of Sourcegraph; giants own distribution) — position one
level up as the **trust + cost governance spine for autonomous delivery.**

**Competitor snapshot:** Devin/Cognition (autonomous engineer, ~$47B, trust-skepticism), Factory (~$5B),
Cursor (agent IDE, ~$29–60B contested), Copilot (platform-native, GitHub distribution), Jules (Gemini econ),
Replit/Lovable (app builders), CodeRabbit ($1.5B, review→"governance for agentic dev"), Qodo, Amp, Tembo
(maintenance wedge), Devlo (SMB). Full matrix + sources in `GTM.md`.

## 7. Pre-provisioning checklist (owner) — see `PRE-PROVISIONING.md`
New GitHub **App** (multi-tenant) · Oracle Cloud account + Always-Free resources · domain + DNS · Stripe ·
secrets vault/KMS · the new GitHub **repo** (to push this scaffold) · CI/CD · (later) GCP/AWS startup credits.

## 8. Open decisions / risks
- **Control-plane DB → Postgres (decided).** Standard SaaS, row-level-security as defense-in-depth, ANSI-
  portable (OCI self-hosted/Autonomous → Cloud SQL/RDS/Aurora on credits). Keep the engine's store
  abstraction so Arango-origin stores become Postgres repos without touching stage logic.
- **Isolation tech → Firecracker microVM (decided), via E2B first, self-hosted later.** gVisor is the
  lighter fallback, weaker boundary — not for hostile code.
- **Secrets → Vault namespaces per tenant (decided)**, behind a `SecretProvider` seam; Dapr secret-store the
  lighter interim if we defer Vault Enterprise.
- **Still open:** SOC2 / data-residency timing (BYO-cloud for enterprise helps) — Phase 3; brand/domain
  (owner); whether to join an accelerator early (unlocks the big credit tiers — recommended).
