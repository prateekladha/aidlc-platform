// AIDLC stage tools — namespaced, same `Tool` contract as the Host Copilot tools, registered in the
// SAME registry and governed by the SAME broker (tier → EXECUTE/PROPOSE/DENY). Scoping is per
// stage-agent via allowedTools/grants. Run bodies are THIN: they delegate to AidlcServicePorts (the
// backend/local adapter holds the real logic), mirroring the existing tool→ServicePorts pattern.

import type { Tool, Tier, JSONSchema, ToolContext, ToolResult } from '../../types';
import type { AidlcServicePorts, Viewport } from '../../orchestrator/types';

type Run = (args: Record<string, unknown>, ports: AidlcServicePorts, ctx: ToolContext) => Promise<unknown>;

function tool(name: string, tier: Tier, undoable: boolean, description: string, parameters: JSONSchema, run: Run): Tool {
    return {
        name, tier, undoable, description, parameters,
        async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
            const ports = ctx.ports as AidlcServicePorts;
            if (ctx.mode === 'dry-run') return { ok: true, output: { preview: `would run ${name}`, args }, note: 'dry-run' };
            const output = await run(args, ports, ctx);
            return { ok: true, output };
        },
    };
}

// NOTE: Gemini function declarations reject `additionalProperties` — do NOT add it here.
const obj = (properties: Record<string, unknown>, required: string[] = []): JSONSchema =>
    ({ type: 'object', properties, required });
const str = { type: 'string' };
const num = { type: 'number' };
const arr = (items: unknown) => ({ type: 'array', items });
const S = (a: Record<string, unknown>, k: string) => String(a[k] ?? '');

// ── code.* (read) ─────────────────────────────────────────────────────────────
export const codeSearch = tool('code.search', 'read', false,
    'Semantic/lexical search over the codebase; returns relevant file paths + snippets (not whole files).',
    obj({ query: str, k: num }, ['query']),
    (a, p) => p.code.search(S(a, 'query'), Number(a.k) || 10));

export const codeRead = tool('code.read', 'read', false,
    'Read one file by path from the indexed base repo.',
    obj({ path: str }, ['path']),
    (a, p) => p.code.read(S(a, 'path')));

export const codeDesignSystemLookup = tool('code.designSystemLookup', 'read', false,
    'Find existing design-system components/tokens matching an intent, with usage — so work reuses the system.',
    obj({ query: str }, ['query']),
    (a, p) => p.code.designSystemLookup(S(a, 'query')));

// ── sandbox.* — ephemeral worktree ops (never prod) ──────────────────────────
export const sandboxReadFile = tool('sandbox.readFile', 'read', false,
    'Read a file from the sandbox worktree.',
    obj({ sandboxId: str, path: str }, ['sandboxId', 'path']),
    (a, p) => p.sandbox.readFile(S(a, 'sandboxId'), S(a, 'path')));

export const sandboxWriteFile = tool('sandbox.writeFile', 'write', true,
    'Create or overwrite a file in the sandbox worktree with full content.',
    obj({ sandboxId: str, path: str, content: str }, ['sandboxId', 'path', 'content']),
    async (a, p, ctx) => {
        const path = S(a, 'path');
        // Safety: the agent must NEVER create secret/credential files (it once hallucinated a serviceAccountKey.json).
        if (/(^|\/)(serviceAccountKey\.json|\.env(\.|$)|credentials\.json)|\.(pem|key|p12|pfx)$|(^|\/)id_rsa/i.test(path)) {
            return { ok: false, output: { error: `refused: "${path}" looks like a secret/credential file — never create those. Use existing config/env instead.` } };
        }
        const r = await p.sandbox.writeFile(S(a, 'sandboxId'), path, S(a, 'content'));
        ctx.sink?.emit({ type: 'file.written', level: 'info', actor: 'worker', stage: ctx.stage, stageRunId: ctx.stageRunId, payload: { path, bytes: S(a, 'content').length } });
        return r;
    });

export const sandboxListDir = tool('sandbox.listDir', 'read', false,
    'List a directory in the sandbox worktree.',
    obj({ sandboxId: str, path: str }, ['sandboxId']),
    (a, p) => p.sandbox.listDir(S(a, 'sandboxId'), S(a, 'path')));

export const sandboxRun = tool('sandbox.run', 'write', false,
    'Run a shell command in the sandbox (build/typecheck/install). Returns exitCode + stdout/stderr.',
    obj({ sandboxId: str, cmd: str }, ['sandboxId', 'cmd']),
    async (a, p, ctx) => {
        const cmd = S(a, 'cmd');
        ctx.sink?.emit({ type: 'sandbox.command', level: 'info', actor: 'worker', stage: ctx.stage, stageRunId: ctx.stageRunId, payload: { cmd } });
        const r = await p.sandbox.run(S(a, 'sandboxId'), cmd);
        // Stream the command's output into the run-page log (truncated — full logs go to GCS later).
        const out = (r.stdout || '') + (r.stderr ? `\n${r.stderr}` : '');
        if (out.trim()) ctx.sink?.emit({ type: 'sandbox.output', level: r.exitCode === 0 ? 'debug' : 'warn', actor: 'worker', stage: ctx.stage, stageRunId: ctx.stageRunId, payload: { cmd, exitCode: r.exitCode, chunk: out.length > 4000 ? out.slice(-4000) : out } });
        // Return the TAIL of each stream to the model (errors surface at the end), not the whole thing — a
        // verbose build/tsc would otherwise bloat the context and get re-sent every turn (token blow-up).
        const cap = (s: string | undefined, n = 4000) => { const v = String(s || ''); return v.length > n ? `… (${v.length - n} chars truncated)\n${v.slice(-n)}` : v; };
        return { exitCode: r.exitCode, stdout: cap(r.stdout), stderr: cap(r.stderr) };
    });

// ── testing.* (read — observe, never mutate prod) ────────────────────────────
export const testingVerify = tool('testing.verify', 'read', false,
    'Run the project build/typecheck gate in the sandbox and return a PASS/FAIL TestReport.',
    obj({ sandboxId: str, commands: arr(str) }, ['sandboxId']),
    (a, p) => p.testing.verify(S(a, 'sandboxId'), (a.commands as string[]) || undefined));

export const testingBrowserSession = tool('testing.browserSession', 'read', false,
    'Run the PRD journeys in a REAL browser across viewports — captures screenshots, console, network, video + Lighthouse to the run-page Tests session. Use for UI features when a preview URL is available (else rely on testing.verify).',
    obj({ journeys: arr(obj({ name: str, path: str }, ['name'])), viewports: arr(str), previewUrl: str }, ['journeys']),
    async (a, p, ctx) => {
        const previewUrl = S(a, 'previewUrl') || process.env.AIDLC_PREVIEW_URL || '';
        const workItemId = String(ctx.stageRunId || '').split(':')[0] || 'wi';
        const viewports = Array.isArray(a.viewports) && a.viewports.length ? (a.viewports as any[]).map(String) : ['mobile', 'desktop'];
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { runBrowserSession } = require('../../orchestrator/ports.playwright');
        return runBrowserSession(
            { workItemId, previewUrl, viewports, journeys: (a.journeys as any[]) || [], stage: ctx.stage, stageRunId: ctx.stageRunId },
            (e: any) => ctx.sink?.emit(e),
        );
    });

export const testingLighthouse = tool('testing.lighthouse', 'read', false,
    'Run Lighthouse budgets per viewport (backbone; v1 may report skipped).',
    obj({ sandboxId: str, viewports: arr(str) }, ['sandboxId', 'viewports']),
    (a, p) => (p.testing.lighthouse ? p.testing.lighthouse(S(a, 'sandboxId'), (a.viewports as Viewport[]) || []) : Promise.resolve({ note: 'lighthouse not wired yet' })));

// ── design.* (Stitch) ────────────────────────────────────────────────────────
export const designStitch = tool('design.stitch', 'write', true,
    'Generate a UI design via Stitch from a brief; returns a design artifact ref + spec. Only when new design is needed.',
    obj({ brief: str }, ['brief']),
    (a, p) => p.design.design(S(a, 'brief')));

// ── deploy.* — PR prep is a write; merge/trigger/rollback are propose (gated) ─
export const deployOpenPr = tool('deploy.openPr', 'write', true,
    'Prepare the PR (compute the diff + evidence body). Does NOT merge or deploy.',
    obj({ branch: str, body: str }, ['branch', 'body']),
    (a, p) => p.deploy.openPr(S(a, 'branch'), S(a, 'body')));

export const deployMerge = tool('deploy.merge', 'propose', false,
    'Merge the approved PR. PROPOSE: gated by human PR approval.',
    obj({ prUrl: str }, ['prUrl']),
    (a, p) => p.deploy.merge(S(a, 'prUrl')));

export const deployTrigger = tool('deploy.trigger', 'propose', false,
    'Trigger the deploy for a merged PR. PROPOSE: gated.',
    obj({ prUrl: str }, ['prUrl']),
    (a, p) => p.deploy.trigger(S(a, 'prUrl')));

export const deployWatch = tool('deploy.watch', 'read', false,
    'Watch a deploy (Cloud Run revision health + logs).',
    obj({ deployRef: str }, ['deployRef']),
    (a, p) => p.deploy.watch(S(a, 'deployRef')));

export const deployPostDeployTest = tool('deploy.postDeployTest', 'read', false,
    'Run the critical-path test subset against the live/canary revision (fail-closed gate on the deploy).',
    obj({ deployRef: str }, ['deployRef']),
    (a, p) => p.deploy.watch(S(a, 'deployRef')));

export const deployRollback = tool('deploy.rollback', 'propose', true,
    'Roll back to the last-good revision. PROPOSE/auto on post-deploy failure.',
    obj({ deployRef: str }, ['deployRef']),
    (a, p) => p.deploy.rollback(S(a, 'deployRef')));

// ── analytics.* / gtm.* ──────────────────────────────────────────────────────
export const analyticsInstrument = tool('analytics.instrument', 'propose', true,
    'Wire the approved events (PostHog) into the feature.',
    obj({ events: arr(obj({ name: str, props: arr(str), where: str }, ['name'])) }, ['events']),
    (a, p) => p.analyticsWiring.instrument((a.events as any[]) || []));

export const gtmDraft = tool('gtm.draft', 'write', true,
    'Draft on-brand launch assets for the feature.',
    obj({ brief: str }, ['brief']),
    (a, p) => p.gtm.draft(S(a, 'brief')));

export const gtmOutreach = tool('gtm.outreach', 'propose', false,
    'Send approved outreach to the chosen channels.',
    obj({ channels: arr(str), payload: obj({}, []) }, ['channels']),
    (a, p) => p.gtm.outreach((a.channels as string[]) || [], a.payload));

// ── feature.* — the change-request lineage ledger (read) ─────────────────────
export const featureSearch = tool('feature.search', 'read', false,
    'Find existing feature/product areas this request may belong to, by keywords (name/paths/summary). Call this FIRST at PRD time to establish lineage before planning.',
    obj({ query: str }, ['query']),
    (a, p) => p.feature.search(S(a, 'query')));

export const featureHistory = tool('feature.history', 'read', false,
    'Get a feature\'s chronological change-request chain (every prior work item: problem, acceptance criteria, PR, date) + current spec. Use it so your plan builds on the latest reconciled state and does not contradict or duplicate prior changes.',
    obj({ featureId: str }, ['featureId']),
    (a, p) => p.feature.history(S(a, 'featureId')));

// ── security.* + migration.* — DevSecOps / infra validation, run in the sandbox (never touch prod) ──
export const securityScanDeps = tool('security.scanDeps', 'read', false,
    'Scan dependencies for known CVEs (npm audit) in the sandbox. Returns a vulnerability summary.',
    obj({ sandboxId: str }, ['sandboxId']),
    async (a, p) => {
        const r = await p.sandbox.run(S(a, 'sandboxId'), 'npm audit --json 2>/dev/null || true');
        try {
            const j = JSON.parse(r.stdout || '{}');
            const v = j.metadata?.vulnerabilities || {};
            return { critical: v.critical || 0, high: v.high || 0, moderate: v.moderate || 0, low: v.low || 0, total: v.total || 0 };
        } catch { return { note: 'npm audit produced no parseable output', raw: (r.stdout || r.stderr || '').slice(0, 400) }; }
    });

export const securityScanSecrets = tool('security.scanSecrets', 'read', false,
    'Scan the staged diff for leaked secrets (keys/passwords/tokens/private keys). Returns any suspicious matches.',
    obj({ sandboxId: str }, ['sandboxId']),
    async (a, p) => {
        const r = await p.sandbox.run(S(a, 'sandboxId'), `git add -A >/dev/null 2>&1; git diff --cached | grep -inE '(secret|password|passwd|api[_-]?key|access[_-]?token|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16})' | head -40 || true`);
        const hits = String(r.stdout || '').split('\n').filter(Boolean);
        return { leaks: hits.length, matches: hits.slice(0, 20) };
    });

export const migrationDryRun = tool('migration.dryRun', 'read', false,
    'Dry-run a migration script in the sandbox (it must support a --dry-run flag and be reversible). Returns the exit code + output; a non-zero exit is a failure.',
    obj({ sandboxId: str, scriptPath: str }, ['sandboxId', 'scriptPath']),
    async (a, p) => {
        const r = await p.sandbox.run(S(a, 'sandboxId'), `npx ts-node ${S(a, 'scriptPath')} --dry-run 2>&1 | tail -n 60`);
        return { exitCode: r.exitCode, ok: r.exitCode === 0, output: (r.stdout || r.stderr || '').slice(-3000) };
    });

// ── diagnostics.* (READ-ONLY live-source investigation for root-causing prod bugs; flag-gated) ──────────
const diagUnavailable = (note: string) => ({ available: false, note: `diagnostics unavailable: ${note}` });
export const logsQuery = tool('logs.query', 'read', false,
    'Query production logs (Cloud Logging), READ-ONLY, to investigate a bug. Filter by a Logging filter expression, min severity (e.g. ERROR), and a recent time window. Returns the most recent capped entries.',
    obj({ filter: str, severity: str, sinceMinutes: num, limit: num }, []),
    async (a, p) => p.diagnostics ? p.diagnostics.queryLogs({ filter: a.filter ? S(a, 'filter') : undefined, severity: a.severity ? S(a, 'severity') : undefined, sinceMinutes: Number(a.sinceMinutes) || undefined, limit: Number(a.limit) || undefined }) : diagUnavailable('no diagnostics port'));
export const dbQuery = tool('db.query', 'read', false,
    'Run a READ-ONLY ArangoDB AQL query to inspect live data while root-causing (writes are refused). Prefer narrow, LIMITed queries. Returns capped rows.',
    obj({ aql: str, bindVars: { type: 'object' } }, ['aql']),
    async (a, p) => p.diagnostics ? p.diagnostics.queryDb(S(a, 'aql'), (a.bindVars as Record<string, unknown>) || undefined) : diagUnavailable('no diagnostics port'));
export const cacheInspect = tool('cache.inspect', 'read', false,
    'Inspect Redis READ-ONLY while root-causing: op "get" (value), "ttl" (seconds), or "keys" (matching a pattern). No writes.',
    obj({ op: str, key: str }, ['op', 'key']),
    async (a, p) => p.diagnostics ? p.diagnostics.inspectCache((S(a, 'op') as 'get' | 'keys' | 'ttl'), S(a, 'key')) : diagUnavailable('no diagnostics port'));
export const runtimeStatus = tool('runtime.status', 'read', false,
    'Read a Cloud Run service\'s current status + health conditions (latest revision, ready state) to spot a bad deploy. READ-ONLY.',
    obj({ service: str }, []),
    async (a, p) => p.diagnostics ? p.diagnostics.runtimeStatus(a.service ? S(a, 'service') : undefined) : diagUnavailable('no diagnostics port'));

export const AIDLC_TOOLS: Tool[] = [
    securityScanDeps, securityScanSecrets, migrationDryRun,
    logsQuery, dbQuery, cacheInspect, runtimeStatus,
    codeSearch, codeRead, codeDesignSystemLookup,
    featureSearch, featureHistory,
    sandboxReadFile, sandboxWriteFile, sandboxListDir, sandboxRun,
    testingVerify, testingBrowserSession, testingLighthouse,
    designStitch,
    deployOpenPr, deployMerge, deployTrigger, deployWatch, deployPostDeployTest, deployRollback,
    analyticsInstrument, gtmDraft, gtmOutreach,
];
