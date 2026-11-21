# AIDLC Platform — Pre-provisioning checklist (owner)

Everything **you** must set up (accounts, apps, keys) before/alongside the Phase-1 build. `[ ]` = your
action. Grouped by what each unblocks. Costs noted — the goal is ~$0 to start (free tiers + BYO-key).

> Rule of thumb: the **control plane** runs on OCI Always-Free; the **per-run agent compute** runs on E2B
> (managed Firecracker microVMs); **secrets** in Vault; **billing** in Stripe. Three accounts gate the MVP:
> the **GitHub App**, **E2B**, and **OCI**.

---

## 1. GitHub App — multi-tenant source access (GATES onboarding)
- [ ] Create a **GitHub App** (NOT an OAuth App): `github.com/settings/apps/new`.
  - **Where can it be installed:** "Any account" (so external tenants can install it).
  - **Permissions (least-privilege):** Repository → `Contents: Read & write`, `Pull requests: Read & write`,
    `Metadata: Read` (auto). Add `Issues: Read & write` only if we trigger from issue comments; `Checks:
    Write` only if we post check runs. **Do NOT** request Administration / org members / secrets.
  - **Webhook:** URL = `https://<api-domain>/webhooks/github` (set once the API is up), generate a **webhook
    secret**, subscribe to: `installation`, `installation_repositories`, `pull_request`, `push`,
    `issue_comment`.
  - **Generate a private key** (.pem) → store as a platform secret (NOT in git).
- [ ] Record: **App ID**, **Client ID**, **private key**, **webhook secret** → platform secret store.
- (Later) GitHub Marketplace listing for discovery; GitLab/Bitbucket apps in Phase 2.

## 2. Per-run sandbox — E2B (GATES running any work item)
- [ ] Create an **E2B** account (e2b.dev) → **API key**. (Firecracker microVMs, per-run isolation, pay-as-
  you-go; free tier to start. This is where untrusted client + agent code executes — never on OCI.)
- [ ] (Deferred) plan the self-hosted Firecracker/Kata path on GKE/EKS for when credits land + volume grows.

## 3. Cloud — OCI Always-Free (control plane only)
- [ ] Oracle Cloud account (free). Provision in your home region:
  - [ ] **1× A1 ARM instance** (up to 2 OCPU / 12 GB — note: A1 capacity is often "out of host capacity";
        use the retry approach / try an alternate AD, or temporarily use an AMD micro VM for a bastion).
  - [ ] **Autonomous Database** (1 OCPU / 20 GB) for the control-plane DB — OR plan self-hosted **Postgres**
        on the A1 (we'll decide in the build; schema stays ANSI-portable either way).
  - [ ] **Object Storage bucket** (artifacts; 20 GB free, S3-compatible — create an S3-compat access key).
  - [ ] VCN + a 10-Mbps flexible load balancer (free) or just expose via the instance.
  - Keep instances **warm + health-checked** (idle < 20% for 7 days → reclaimed).

## 4. Secrets vault (GATES BYO-key + cloud creds)
- [ ] Choose: **HashiCorp Vault** (HCP free/dev, or self-host on the A1) with **namespaces per tenant**
      (strongest isolation) — OR, to start lighter, a **KMS-envelope-encrypted secrets table** behind our
      `SecretProvider` interface (swap to Vault later). Record the Vault address + root/admin token securely.

## 5. Billing — Stripe (GATES paid plans; not needed for the pilot)
- [ ] Stripe account → API keys (test + live), a Product + usage-based Price (for managed) + seat Price.

## 6. Domain + brand
- [ ] Pick the **brand/domain** (TBD by you). Point DNS at the control plane once deployed. Decide tenant
      segregation: **path or subdomain per tenant** (`app.domain/t/<slug>` to start; `tenant.domain` later —
      subdomains are for routing/branding, isolation is already at the data + run layer).

## 7. The new git repo
- [ ] Create the new **GitHub repo** (e.g. `aidlc-platform`) and push the scaffold I'm building in
      `~/git/aidlc-platform/` (you own all git — I won't push). This is the standalone, detached-from-
      Perpetuum codebase.

## 8. Model providers
- [ ] Platform-level keys for **managed** mode: Anthropic + Google (Gemini) + optionally OpenAI. (Tenants in
      **BYO-key** mode bring their own — stored per-tenant in the vault; the pattern mirrors how Claude's
      GitHub App uses the client's own `ANTHROPIC_API_KEY` as a repo secret.)

## 9. Startup credits (do early — unlocks the real cloud)
- [ ] **Microsoft for Startups Founders Hub** — up to $150K Azure, **no gate** (do now).
- [ ] **AWS Activate Founders** — $5–10K, **no investor needed** (do now).
- [ ] **Google for Startups — AI-first** — up to **$350K**, when you have a SAFE/round or join an accelerator.
- [ ] **Join an accelerator** (highest-leverage: its Org ID unlocks AWS $200K + Google Scale tiers).

---

### MVP-critical path (minimum to run one external pilot):
**#1 GitHub App** + **#2 E2B** + **#3 OCI (control plane + DB + bucket)** + **#4 a secrets store** + **#8 a
model key** + **#7 the repo**. Stripe/domain/credits can follow.

_Last updated: 29 Oct 2026. Pairs with ARCHITECTURE-AND-STRATEGY.md._
