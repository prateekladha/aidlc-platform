# RÉVE Host Copilot — agent substrate (Phase 1)

An LLM agent that lets a logged-in host do, in chat on reve.rsvp, what they'd do
in the dashboard. This is the "target" architecture from the constitution — one
agent loop, namespaced workflow tools, rules-in-tools (not prompts), a
permission broker, and evals — ported from the `agent-platform` boilerplate onto
the real backend.

**Status:** Phase 1 real + tested. Runs on **real Gemini** (`gemini-3.8-flash`, verified
live), behavioral evals are **LLM-judged**, and the **FE chat** ships at
`/dashboard/copilot`. Real event **reads** are wired; irreversible money **writes**
(`events.publishPaid` commit, `payouts.setVpa` vendor create) are **dry-run previews** —
the auto-mode safety classifier blocks autonomous money-path wiring, so that is the one
supervised step (see "To go live").

```bash
npm run agent:test        # deterministic SAFETY smoke (no key, no spend, no prod writes)
npm run agent:llm-eval    # LLM behavioral evals — real Gemini runs + Gemini judge (needs GEMINI_API_KEY)
npm run agent:probe       # one-shot live check the Gemini adapter speaks function-calling
```

## The loop (how it runs)

An agent is a model in a while-loop that may ask for tool calls. Each pass:

1. the model reads the conversation and either replies with words (loop ends) or
   asks for a tool;
2. the **broker** decides `EXECUTE | PROPOSE | DENY` for that call;
3. `EXECUTE` runs the tool and appends the result; `DENY` appends the *reason*
   (the model reads it and self-corrects); `PROPOSE` pauses for a human confirm;
4. round again, until words or the turn cap.

The signature Phase-1 journey, end to end:

```
draft → publishPaid DENY (payout gate) → model asks for UPI
      → setVpa PROPOSE → confirm → publishPaid PROPOSE → confirm → live
```

## Layout

```
types.ts            one vocabulary: Model, Tool, Grant, Decision, ServicePorts…
model/
  scripted.ts       deterministic model for tests (no LLM)
  gemini.ts         live adapter (@google/genai) — reads GEMINI_API_KEY from env
broker.ts           EXECUTE/PROPOSE/DENY. capability token, grants, ajv arg-check,
                    ownership-authorize, propose-gate. configVerdict() = replay seam
tools/
  contract via types.Tool; registry.ts holds the token + declarations
  eventsTools.ts    draft · get · listMine · publishPaid   (rules live HERE)
  payoutTools.ts    status · setVpa
  ports.ts (types)  ports.memory.ts (tests) · ports.backend.ts (real, writes dry-run)
verify.ts           fail-closed verifier (separate from the tool — nothing grades itself)
runtime/
  loop.ts           step() / resume() / driveToCompletion() — re-entrant for HTTP
  systemPrompt.ts   identity + tone + tool names ONLY — no business rules
agents/reve-host.ts the "four lists": journeys · tools · grants · limits
stores.ts           in-memory + file session/decision-log (Arango adapter = TODO)
evals/
  checks.ts         hard invariants over the decision log
  replay.ts         re-decide logged calls under current config → what changed
test/
  harness.ts        runs a scenario through the real loop + fake ports
  run.ts            the scenarios + assertions (npm run agent:test)
api/routes.ts       POST /growth-api/agent/chat + /confirm — DORMANT (AGENT_ENABLED)
```

## Safety model

- **Only the broker runs a tool** (single-use capability token; the loop never
  imports tools).
- **Reads + reversible writes auto-execute; money/irreversible = PROPOSE** (the
  broker force-downgrades any propose-tier tool even if granted execute).
- **Per-user auth**: every call carries the session `userId`; tools `authorize()`
  check ownership — a failure becomes a DENY reason the model acts on.
- **Fail-closed verifier** re-checks ownership + payout + price before a publish
  commits — a different call from the one doing the work.
- **Rules live in tools**, never the prompt (the payout gate is a tool DENY, not
  prompt text).

## Done

- ✅ `GEMINI_API_KEY` + `AGENT_ENABLED=true` set; Gemini adapter verified live (`gemini-3.8-flash`).
- ✅ Real event **reads** (`events.get`/`listMine` via Arango). Money **writes** = faithful dry-run previews.
- ✅ LLM behavioral evals + deterministic safety smoke, both green.
- ✅ FE chat at `/dashboard/copilot` (+ a "Host Copilot" nav entry).

## The one supervised step — money-path wiring (needs you)

The auto-mode safety classifier **blocks** autonomously wiring the irreversible money paths
(`events.publishPaid` commit, `payouts.setVpa` Cashfree-vendor create) — correctly, since
local `.env` points at prod. To finish, under your review:

1. Extract the vendor-onboard core of `verifyUpiVpa` into a shared service and have both it
   and the agent's `setVpa` call it (reusing `writeHostVendor` + `upsertHostVendor`). (I staged
   this as `hostVendorOnboard.ts` — the classifier blocked the write, so it isn't created yet.)
2. Point `ports.backend.ts` `setVpa` → that service, and `publishPaid` → `decidePublishStatus`
   (now exported) + a status write, **behind `verifyPublish`**.
3. Add a characterisation test (injection pattern, like `writeHostVendor.test.ts`) first (§10).

Until then: the agent talks, reads, drafts a **preview**, and *says* it published — but money
writes don't commit. The first real publish/vendor is your supervised click.

**Also:** comm-runner's `callGemini.ts` has a **hardcoded Gemini API key** — rotate it + move to env.

Later: Arango-backed session + decision-log stores (env-prefixed), SSE streaming.
```
