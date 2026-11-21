# AIDLC Platform — GTM starter (research-backed)

Drafts for the owner to review. Positioning, pricing, the 90-day plan, and actual copy for the homepage, a
competitor-comparison page, FAQ, and the GEO/SEO plan. Substance is from the competitor/GTM research brief.

---

## 1. Positioning
**Lead with GOVERNANCE, prove with COST, deliver END-TO-END.** The market's #1 blocker is *trust* (only ~13%
run AI across the full SDLC; ~46% of agent PRs are rejected), with a hard regulatory tailwind (EU AI Act
high-risk obligations enforceable **2 Aug 2026** — lineage-backed auditability + human oversight). Nobody owns
the whitespace of **PRD→GTM + cloud/AI-cost + governance-as-the-spine** — incumbents are code/PR-anchored and
sell governance as a bolt-on reviewer.

- **One-liner:** *"The autonomous delivery platform you can trust in production — provably correct,
  cost-governed, PRD to GTM."*
- **Beachhead buyer:** mid-market platform-engineering leaders (50–500 devs — fastest-growing segment,
  under-served between $20 PLG toys and $16K/yr enterprise floors).
- **Do NOT** position as "another AI code reviewer" or "another autonomous engineer" — that category is
  consolidating (Graphite→Cursor, Amp out of Sourcegraph) and giants own distribution (Copilot/Jules).
  Position **one level up**: the trust + cost governance spine for autonomous delivery.

### Manifesto (brand spine — publish as the first content)
> Autonomous coding is here; *trustworthy* autonomous delivery is not. Agents write code fast and then get
> rejected ~half the time, rack up unpredictable bills, and leave no audit trail your compliance team will
> accept. We built the opposite: an autonomous delivery platform where **every change is verified by a
> separate, fail-closed check (nothing grades itself)**, **every instruction is provably covered**, **nothing
> merges without your gate**, **every run is cost-governed and auditable** — from PRD to GTM. Delegation you
> can actually put in production.

---

## 2. Competitor matrix (condensed — full sources in the research brief)
| Player | Archetype | Pricing | Wedge | Weak spot we exploit |
|---|---|---|---|---|
| **Devin/Cognition** (~$47B) | autonomous engineer | Free/$20/$200, Teams $80+$40 | async teammate, own VM | trust gap (13.86% SWE-bench; 46% PR rejection); demo credibility |
| **Factory** (~$5B) | agent-native "software factory" | $20/$100/$200, Teams $60+$40 | parallel Missions, enterprise | stopped publishing SWE-bench (transparency); code-anchored |
| **Cursor** (~$29–60B) | agent-first IDE | $20/$60/$200, Teams $40 | editor surface, own model | billing opacity + cost backlash; IDE lock-in |
| **GitHub Copilot** | platform-native | $10/$39/$100, Biz $19 | GitHub distribution | generic; "AI Credits" metering backlash |
| **Google Jules** | platform-native | bundled in AI Pro/Ultra | Gemini economics | GitHub-only; weak on ambiguity |
| **Replit/Lovable** | app builder | $20–100 + credits | idea→app for non-devs | unpredictable effort-billing; not for eng orgs |
| **CodeRabbit** ($1.5B) | review→"governance for agentic dev" | $24/$48/$72 per PR-seat | most-installed GitHub app | nitpick noise; review-only (not delivery) |
| **Qodo / Amp / Tembo / Devlo** | review / agent / maintenance / SMB | credits / usage | niche wedges | cost anxiety; narrow scope |

**The three open lanes:** (1) end-to-end PRD→GTM — unowned; (2) cloud+AI cost optimization inside a coding
platform — unowned (FinOps is separate); (3) governance as the product spine — unowned (sold as add-on).

---

## 3. Pricing strategy
Anchor $20 individual is universal; power tier $100–200; team seats $19–48; the category is moving to
usage/credits (41% hybrid) and getting flamed for unpredictability. **Our edge = predictable + outcome-aligned.**
- **Free / OSS** — top-of-funnel + GEO corpus (copy CodeRabbit/Qodo).
- **$20 Starter** (self-serve, BYO-key) — individual/small team, full governance + cost dashboard.
- **Team** — seats + metered runs, managed-key option, approvers/RBAC, audit exports.
- **Enterprise** — dedicated isolation, SSO, SOC2, data-residency/BYO-cloud.
- **Outcome option (differentiator):** per-merged-PR / per-shipped-feature — *"pay when it ships, and we show
  you exactly what it cost to run."* No incumbent does this credibly; it reinforces trust + cost.

---

## 4. GTM playbook + channels
PLG land → sales-led expand (hybrid "full-stack GTM"). **Marketplace-native** install first (GitHub
Marketplace 2-click, then JetBrains + Google Cloud). **Free-for-OSS** to seed corpus + authority.
**Benchmark + comparison content** is the native currency. **GEO (ChatGPT/Claude citation) is first-class** —
40% of B2B research is in ChatGPT/Perplexity/Gemini; 87% of AI referrals from ChatGPT. Community: HN, Discord,
podcasts, dogfooding ("how we build this platform under governance + cost caps").

## 5. The 90-day plan (prioritized)
1. **Governance/trust manifesto + an open verification/eval benchmark** mapped to EU AI Act Art. 10/12/14.
2. **GEO engine:** allow GPTBot/ClaudeBot/PerplexityBot, publish `llms.txt`, answer-block content on the 3
   target queries, weekly citation tracking across ChatGPT/Claude/Perplexity.
3. **Competitor-comparison + "cost-alternative" pages** (vs Devin / vs Cursor-Copilot-agent).
4. **Public AI/cloud-cost calculator + live cost-governance dashboard.**
5. **GitHub Marketplace + free-OSS** distribution.
6. **PLG beachhead at mid-market platform-eng** ($0/$20 → sales-assist expansion).
7. **Pilot outcome pricing** (per-merged-PR).
8. **Launch with proof, not demos** (open benchmark + a verifiable PRD→GTM reference build + 2–3 design-
   partner logos with hard numbers: merge-acceptance %, cost reduction %, audit completeness).
9. **Weekly dogfooding content.**
10. **Avoid the consolidation trap** (don't fight on IDE surface or model-lab moats).

---

## 6. Homepage copy (draft v1)
**Hero**
> # Autonomous delivery you can trust in production.
> From PRD to GTM — provably correct, cost-governed, and auditable. The autonomous SDLC platform that gates
> every change, verifies its own work with a separate fail-closed check, and shows you exactly what each run
> costs.
> **[Connect your GitHub — free]**   ·   *BYO your model key. Nothing merges without your approval.*

**Three pillars**
1. **Trust it in prod.** Every change gets a separate, fail-closed verification (nothing grades itself).
   Instruction coverage is enforced. Nothing merges without your gate. Full audit trail — built for the way
   EU AI Act high-risk governance actually works.
2. **Know what it costs.** Live cloud + AI spend per run, per repo, per team. Agents pick the cheapest
   adequate model. No surprise bills — predictable, and optionally **pay-per-shipped-feature.**
3. **End to end, not just code.** PRD → UX → build → *tests that actually run* → reviewed PR → GTM. One
   system from idea to shipped-and-measured.

**Proof band:** open eval benchmark · a public PRD→GTM reference build · design-partner numbers (merge
acceptance %, cost reduction %, audit completeness). *(Proof over demos.)*

---

## 7. Competitor-comparison page — outline: "[Product] vs Devin"
- **TL;DR table:** autonomy, governance/audit, cost visibility, end-to-end (PRD→GTM), merge-gating, pricing
  predictability, self-host/BYO-key. (We win on governance, cost, end-to-end, predictability.)
- **"Where Devin shines / where it struggles"** (async teammate; but 46% PR rejection, trust/demo gap).
- **"Why governance-first matters"** (EU AI Act; fail-closed verification; nothing-grades-itself).
- **"The cost question"** (unpredictable usage vs our cost-governed, pay-on-ship option).
- Honest, specific, sourced — these pages rank in Google AND get cited by ChatGPT/Claude. Repeat for "vs
  Cursor/Copilot agent" and a "predictable-cost alternative to [Cursor/Replit/Amp]" page.

## 8. FAQ (seeds SEO + GEO answer-blocks)
- **How is this different from Devin/Cursor/Copilot?** They're code/PR-anchored and sell governance as a
  bolt-on. We're the trust + cost governance spine for autonomous delivery, end to end (PRD→GTM), with
  fail-closed verification and a live cost ledger.
- **Can I trust autonomous changes in production?** Nothing merges without your gate; every change is
  verified by a separate fail-closed check; instruction coverage is enforced; everything is auditable.
- **What does it cost to run?** You see cloud + AI spend per run; agents pick the cheapest adequate model;
  BYO-key or managed; optional pay-per-shipped-feature.
- **Does it support the EU AI Act / audit requirements?** Lineage-backed audit trail + human-in-the-loop
  gates map to high-risk obligations (Art. 10/12/14).
- **Do you train on my code? Where does it run?** No. Per-run isolated microVMs; your secrets are injected
  just-in-time and destroyed with the run; BYO-cloud available for enterprise.
- **Which stacks?** Backend + web today; mobile (Flutter/RN/native) on the roadmap.

## 9. GEO / SEO plan
- **Target queries to own** (be *the answer* in ChatGPT/Claude): "most trustworthy autonomous coding agent,"
  "how to govern AI-generated code," "reduce AI coding / token cost," "EU AI Act compliant AI coding,"
  "autonomous SDLC from PRD to deploy."
- **Tactics:** allow `GPTBot`/`ClaudeBot`/`PerplexityBot` in robots; publish `llms.txt`; answer-block +
  conversational content; comparison tables with schema markup; the open benchmark as a citeable primary
  source; weekly citation tracking across engines. (Leverages the existing ChatGPT-inbound strength.)

_Last updated: 29 Oct 2026. Positioning + numbers from the competitor/GTM research brief; figures vary by
source (Cursor valuation contested; some ARR/funding not public)._
