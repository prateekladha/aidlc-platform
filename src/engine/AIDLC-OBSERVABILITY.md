# AIDLC — Observability, Transparency & the Full-System Reframe (v0.4)

**Why this doc exists:** the v0.3 build produced a working reasoning spine + control plane, but the
roadmap that followed under-scoped the system to "get a PR out the door." That is not the vision. The
vision is a **product**: an internal AIDLC that an org trusts to drive real changes — including the money
path — because it is **radically transparent** about what every agent is doing, in real time and in
replay, at the granularity of GitHub Actions logs + BrowserStack session video. This doc reframes the full
system honestly and goes deep on the pillar that was barely started: **observability & transparency.**

---

## 0. The principle (why observability IS the product, not a feature)

An AIDLC agent does work a human would otherwise do, then asks the human to **approve** it. Approval
without visibility is blind trust — and for a money-path change like monetization, blind trust is
unacceptable. **Transparency is the mechanism that makes agentic delivery safe and adoptable.** The human
must be able to answer, at any instant: *what is the agent doing right now, why, what has it changed, what
is passing/failing, what will it cost, and can I watch it happen and replay it later?*

So observability is not "phase N / stage richness / later." It is a **co-equal pillar** with execution.
For the first monetization run, the user must be able to literally **watch** the Dev agent touch
`buildHostVendorSplit`, see the characterization test run green, see the `revenueShare == 1.0` verifier
pass, scrub the logs, and review the diff — before approving the PR. That experience is the deliverable.

## 1. What best-in-class transparency looks like (the references)

| Product | What it gives the user | What AIDLC borrows |
|---|---|---|
| **GitHub Actions** | Run = a **graph of jobs → ordered steps**; each step streams **timestamped logs** (collapsible, searchable, per-line deep links); status + duration per step; inline error annotations; downloadable artifacts; re-run; runs persist forever & replay | The DAG view, per-stage streaming log panels with groups, durations, artifacts, replay |
| **BrowserStack / LambdaTest** | Live + recorded **video** of the session, step **screenshots**, **console** logs, **network** HAR, the live DOM, pass/fail per test with stack traces, a **scrubbable timeline**, a device/viewport matrix | The Testing-stage "session view": live/recorded browser, console, network, visual diff, Lighthouse, per-assertion results |
| **Vercel / CircleCI / Buildkite** | Live build logs, pipeline DAG, per-step timing, deploy previews, status badges | Deploy-stage logs + health + preview + rollback visibility |
| **Datadog / Honeycomb** | A request = a **trace of spans** (tree, timing, attributes); drill any span; correlate logs+metrics+traces | A work item IS a distributed trace across agents; the "reasoning/trace" view is a span tree |

**The AIDLC run page = GitHub Actions' run view ⨉ BrowserStack's session view ⨉ a Datadog trace.** Because
a work item genuinely is a distributed trace across specialized agents that produces **code + browser
artifacts**.

## 2. The observability data model (the spine everything hangs off)

Everything the system does emits a **typed, timestamped, monotonically-ordered event** into a per-work-item
**event stream**. This single stream powers BOTH live view and replay — there is no separate "logging" vs
"UI" path. (Today only coarse orchestrator events exist, in-memory, for SSE. This is the gap.)

**Event shape:** `{ id, workItemId, stageRunId, seq, ts, type, level, actor, payload, artifactRefs[] }`

**Event taxonomy (illustrative, not exhaustive):**
- **Lifecycle:** `work_item.created` · `stage.queued|started|passed|failed|skipped` · `stage.dispatched` · `worker.started|finished` · `work_item.completed`
- **Agent reasoning:** `model.turn` (thinking summary, tokens, latency) · `tool.called` (name, args) · `tool.result` (ok, summary, duration) · `agent.message`
- **Dev work:** `sandbox.command` (cmd) · `sandbox.output` (stdout/stderr chunks, streamed) · `file.written` (path, diff hunk) · `branch.pushed`
- **Testing (first-class):** `test.suite.started` · `test.case` (name, status, duration) · `test.assertion` · `browser.screenshot` (gcs) · `browser.console` · `browser.network` · `visual.diff` (baseline/actual/diff gcs) · `lighthouse.report` (gcs)
- **Human-in-the-loop:** `clarify.asked|answered` · `gate.opened|decided` · `proposal.raised`
- **Cost/metrics:** `cost.recorded` (stage, tokens, $) · `cache.hit`
- **Deploy:** `pr.opened|merged` · `deploy.triggered|health|rolledback`
- **Errors:** `error` (stage, message, stack gcs ref)

**Storage (hot vs durable):**
- **Hot / live:** Pub/Sub (fan-out from workers) + an in-process ring buffer of recent events → SSE/WebSocket to the browser.
- **Durable / replay:** Arango `aidlc_events` (bounded, indexed by `workItemId + seq`) for structured events; **GCS** for large/binary artifacts (full logs, diffs, screenshots, video, Playwright traces, Lighthouse). Events carry **GCS refs**, never blobs.
- **Log lines** are streamed live as `sandbox.output` events (buffered ~250 ms) *and* flushed to a per-stage GCS log file for replay (exactly the Actions model: tail live, download whole).

## 3. The instrumentation layer (what we have to build into the runtime)

Observability can't be bolted on at the UI — it has to be **emitted at the source**. That means a
cross-cutting **event sink / tracer** threaded through the runtime:
- `loop.ts` emits `model.turn`, `tool.called`, `tool.result`, `agent.message` for every turn.
- The **ports** emit as they act: `sandbox.run` **streams** command output as `sandbox.output` events (not just a final blob); `sandbox.writeFile` emits `file.written` with the hunk; `testing.*` emits per-test + per-assertion + browser events; `deploy.*` emits PR/deploy events.
- The **broker** emits `gate.opened`, `proposal.raised`; the supervisor emits lifecycle + `clarify.*`.
- The **model adapter** already measures tokens/latency → emits `cost.recorded` + `cache.hit`.

This is a real engineering layer (a `Tracer`/`EventSink` injected into `LoopDeps` + `AidlcServicePorts`),
and it's the thing that makes every downstream view possible. It did not exist in v0.3.

## 4. The transport (live + replay, across the worker boundary)

The heavy stages run in an **isolated Cloud Run Job** that can't hold a browser connection, so:
```
Worker (Job)  ──emits events──▶  Pub/Sub (events topic)  ──▶  Backend subscriber
   │                                                              │ persist → Arango aidlc_events
   └── writes artifacts ──▶ GCS                                   │ relay  → SSE/WebSocket → Browser
Browser live:  subscribe SSE (seq > last)         Browser replay: GET /events?from=seq + artifact refs
```
- Live log streaming: sandbox output chunked + emitted in near-real-time so logs "type out" like Actions.
- Replay: the UI loads persisted events paginated by `seq` + resolves artifact GCS refs → renders the
  identical views from history. **Live and replay are the same renderer over the same event stream.**

## 5. Testing as a first-class observable (the BrowserStack-grade piece)

Today "Testing" = `tsc`. The vision is a **test session you can watch**:
- Dev/Testing worker runs **Playwright headed** (multi-viewport: mobile/tablet/desktop) against a preview
  of the change, capturing **screenshots + video + console + network (HAR)** per step → GCS, emitting
  `test.case` / `browser.*` / `visual.diff` / `lighthouse.report` events.
- **Visual regression:** baseline vs actual vs diff images, surfaced side-by-side.
- **Lighthouse:** performance / a11y / best-practices scorecards per viewport.
- The UI "Tests" tab renders: the per-test list (pass/fail/duration), the **browser session player**
  (scrub video / step screenshots), **console** + **network** tabs, the **visual diff** gallery, the
  **Lighthouse** cards. This is the literal "running tests on UI — both browser-level and logs" ask.

For a backend/money-path change like monetization, the "browser" half is N/A, but the **test session**
still shows: the **characterization test** running (current `buildHostVendorSplit` behaviour captured),
the new suite, and the **fail-closed verifier** (`revenueShare == 1.0`) as a first-class, green-or-red
gate with its assertion output — which is exactly the evidence needed to approve a money PR.

## 6. The run page (the UX — how we actually show it)

```
┌─ WORK ITEM: "Add a health-check endpoint with a test"  ● Dev · running ─────────────────────┐
│ by Alex · feature: api-health (3 prior changes) · repo: your-org/backend                    │
│ cost ₹— · 4m12s elapsed · branch aidlc/wi_742 · [PR pending]                                │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│  DAG   ✔ PRD ──▶ (UX skipped) ──▶ ◉ DEV ──▶ ○ Testing ⇄ repair ──▶ ○ Deploy ──▶ ○ Analytics…│
│        1m04s        —              running     queued                                         │
├──────────────┬────────────────────────────────────────────────────────────────────────────┤
│ STAGES       │  DEV ·  [ Logs ] [ Reasoning ] [ Changes ] [ Tests ] [ Artifacts ] [ Cost ]  │
│  ✔ PRD       │  ┌──────────────────────────────────────────────────────────────────────┐   │
│  ◉ Dev       │  │ 12:04:01 ▸ sandbox.run  npx tsc --noEmit                               │   │
│  ○ Testing   │  │ 12:04:07   ✓ no errors                                                  │   │
│  ○ Deploy    │  │ 12:04:09 ▸ writeFile src/growth-part/.../buildHostVendorSplit.test.ts   │   │
│  ○ Analytics │  │ 12:04:12   characterization test added (captures CURRENT 98/0 split)    │   │
│  ○ GTM       │  │ 12:04:20 ▸ writeFile .../split.ts  (behind flag MULTI_PARTICIPANT_SPLIT)│   │
│              │  │ … live, timestamped, searchable, grouped-by-tool, jump-to-error …        │   │
│              │  └──────────────────────────────────────────────────────────────────────┘   │
├──────────────┴────────────────────────────────────────────────────────────────────────────┤
│  DECISION RAIL:  (none active — Dev running)   ·   next gate: PR approval                    │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```
- **Header:** title, status, submitter, **feature lineage**, cost, duration, branch, PR link.
- **DAG:** live-colored nodes (queued/running/passed/failed/skipped/awaiting-human), per-node duration +
  cost, conditional branches + repair loops drawn, current node pulsing; click → opens its panel.
- **Stage panel (tabs):** **Logs** (streaming, virtualized to 100k lines, searchable, grouped, deep-link) ·
  **Reasoning** (the tool-call span tree — how it thought) · **Changes** (live diff viewer, file-by-file) ·
  **Tests** (the BrowserStack view above) · **Artifacts** (downloadable) · **Cost** (tokens/$/cache).
- **Decision rail:** the active HITL — clarify (answer inline) / gate (approve-reject with evidence) / PR
  (diff + approve) — always with the panel context beside it.
- **Timeline:** a scrubbable waterfall of all events; jump to any moment, see state then.
- **Runs index:** the list of all work items (status, filter) — the Actions "runs" list.

## 7. The full-system reframe — the real pillars + honest status

| # | Pillar | Status today | Gap to "picture perfect" |
|---|---|---|---|
| 1 | **Reasoning substrate** (agents, loop, tools, broker, feature ledger) | ✅ built + proven | minor |
| 2 | **Execution isolation** (ephemeral Cloud Run Jobs, sandbox, concurrency) | ◐ dispatcher coded; worker/image/IAM not built | large |
| 3 | **Observability & transparency** (event model, instrumentation, transport, run-page UX) | ✗ barely started | **the biggest gap** |
| 4 | **Testing depth** (Playwright headed, visual, Lighthouse + their UI) | ✗ `tsc` only | large |
| 5 | **Control-plane depth** (run page, workflow authoring, RBAC/multi-tenancy) | ◐ basic list/detail tab | large |
| 6 | **Governance & safety** (hard money-gates, verifiers, evals, forbidden paths) | ◐ prompt-level, not enforced | medium |
| 7 | **Platform reliability** (stage timeouts, dead-letter, crash-resume, alerting) | ◐ resume via durable state; no timeouts/DLQ/alerts | medium |

**The honest truth:** v0.3 is the *reasoning primitive proven end-to-end* — roughly the first of seven
pillars, with pieces of two others. Calling it "one chunk from prod" was wrong. It's a credible spine with
five pillars of product work on top.

## 8. Reordered roadmap (observability as a co-equal pillar; monetization as the forcing function)

Each phase ends with something **you can watch and trust**, not just something that runs.

- **Phase A — Instrumentation spine.** The `Tracer`/`EventSink`; thread it through loop + ports + broker;
  `aidlc_events` store + GCS artifacts; extend SSE to the full stream. *Outcome: every action is an event.*
- **Phase B — The run page (v1).** DAG view + streaming log panel + reasoning trace + live diff viewer +
  decision rail + replay. *Outcome: you can watch a work item run like a GitHub Actions run.*
- **Phase C — Execution isolation.** Worker image + Pub/Sub bridge + Job SA/IAM, emitting the full event
  stream from inside the Job. *Outcome: heavy stages run isolated AND fully observable.*
- **Phase D — Testing as a watchable session.** Characterization-test + fail-closed-verifier framework
  first (money path), then Playwright-headed + visual + Lighthouse + the Tests UI. *Outcome: you watch the
  tests, including the `revenueShare == 1.0` verifier.*
- **Phase E — Governance + reliability hardening.** Hard money-gates, per-stage evals, timeouts/DLQ/alerts,
  cost ceilings, RBAC on who approves money. *Outcome: safe to flip `AIDLC_ENABLED` org-wide.*
- **Throughout → Monetization is the first real work item**, used as the forcing function at every phase
  (if you can't observe/trust the monetization run, the phase isn't done).

## 9. The decisions to align on (these change what gets built first)
1. **Transparency depth for the first monetization run** — full run page (A+B) before we run it, or a
   thinner "logs + diff + gate" view first and grow the UI after? (I recommend A + a focused B — the
   trust surface is the point.)
2. **Live transport** — SSE (one-way, simpler, what we have) vs WebSocket (two-way; needed only if we want
   in-UI "pause/intervene"). (I recommend SSE now, WS later.)
3. **Replay fidelity** — event-stream replay (cheaper) vs full session video for every run (BrowserStack-
   grade, heavier GCS). (I recommend event + screenshots now, video for Testing only.)
4. **Scope of "testing" for monetization** — since it's backend money-path, the watchable session is the
   characterization test + verifier (no browser). Browser/visual/Lighthouse can trail for UI features.
