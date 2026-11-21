// LOCAL AIDLC ports — the real capability layer for running the pipeline on this machine (v1). Heavy
// stages later move to ephemeral Cloud Run Jobs behind the StageDispatcher; the port contracts stay the
// same, so that's an execution swap, not a logic change. Real git worktrees, fs, and command execution.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type {
    AidlcServicePorts, CodePort, SandboxPort, SandboxInfo, TestingPort, DeployPort,
    DesignPort, AnalyticsPort, GtmPort, WorkItemStore, TestReport, FeaturePort,
} from './types';
import type {
    ServicePorts, MemoryPort, EventsPort, PayoutsPort, KnowledgePort, InsightsPort,
    GuestsPort, BroadcastPort, InvitesPort,
} from '../types';
import { NoopFeaturePort } from './featureStore';
import { scopedTypecheck } from './ports.typecheck';

const pexec = promisify(exec);
const SANDBOX_ROOT = process.env.AIDLC_SANDBOX_ROOT || path.join(os.tmpdir(), 'aidlc-sandboxes');

async function sh(cwd: string, cmd: string, timeoutMs = 10 * 60_000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
        const { stdout, stderr } = await pexec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: process.env });
        return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) };
    } catch (e: any) {
        return { exitCode: typeof e?.code === 'number' ? e.code : 1, stdout: String(e?.stdout ?? ''), stderr: String(e?.stderr ?? e?.message ?? '') };
    }
}

// Guard a path stays inside the sandbox worktree (no ../ escape).
function safeJoin(root: string, rel: string): string {
    const p = path.resolve(root, rel);
    if (p !== root && !p.startsWith(root + path.sep)) throw new Error(`path escapes sandbox: ${rel}`);
    return p;
}

// ── code.* over a base repo (read + simple search) ───────────────────────────
class LocalCodePort implements CodePort {
    constructor(private readonly repoRoot: string) {}
    async search(query: string, k = 10): Promise<Array<{ path: string; snippet: string; score: number }>> {
        // ripgrep if available, else git grep. Returns file:line matches as lightweight snippets.
        const q = query.replace(/"/g, '\\"');
        const r = await sh(this.repoRoot, `rg -n --no-heading -i "${q}" -g '!node_modules' -g '!build' -g '!.next' | head -n ${k * 2}`, 60_000)
            .then((x) => (x.exitCode === 0 || x.stdout ? x : null))
            .catch(() => null);
        const raw = r?.stdout || (await sh(this.repoRoot, `git grep -n -i "${q}" | head -n ${k * 2}`, 60_000)).stdout;
        return String(raw).split('\n').filter(Boolean).slice(0, k).map((line, i) => {
            const m = line.match(/^([^:]+):(\d+):(.*)$/);
            return { path: m?.[1] || line, snippet: (m?.[3] || line).trim().slice(0, 240), score: 1 - i / (k * 2) };
        });
    }
    async read(p: string): Promise<string> {
        const full = await fs.promises.readFile(safeJoin(this.repoRoot, p), 'utf8');
        // Cap exploration reads so one large file can't blow the stage token budget (write-phase uses the
        // uncapped sandbox.readFile). See the git port for the rationale.
        const MAX = Number(process.env.AIDLC_CODE_READ_MAX) || 50000;
        return full.length > MAX ? `${full.slice(0, MAX)}\n\n… [truncated — file is ${full.length} chars; use code.search to locate the specific section you need]` : full;
    }
    async designSystemLookup(query: string): Promise<Array<{ component: string; path: string; usage: string }>> {
        // v1: search the components dir for matching component files.
        const hits = await this.search(query, 8);
        return hits.filter((h) => /components?\//i.test(h.path)).map((h) => ({ component: path.basename(h.path), path: h.path, usage: h.snippet }));
    }
}

// ── sandbox.* — real ephemeral git worktree ──────────────────────────────────
class LocalSandboxPort implements SandboxPort {
    private boxes = new Map<string, SandboxInfo>();
    async create(workItemId: string, repoRoot: string, baseBranch: string): Promise<SandboxInfo> {
        await fs.promises.mkdir(SANDBOX_ROOT, { recursive: true });
        const sandboxId = `sbx_${workItemId}_${Date.now().toString(36)}`;
        const worktree = path.join(SANDBOX_ROOT, sandboxId);
        const branch = `aidlc/${sandboxId}`; // unique per run (the in-memory store resets ids to wi_1)
        // Create a worktree on a fresh branch off baseBranch. Falls back to current HEAD if baseBranch missing.
        const r = await sh(repoRoot, `git worktree add -b ${branch} "${worktree}" ${baseBranch}`, 120_000);
        if (r.exitCode !== 0) {
            const r2 = await sh(repoRoot, `git worktree add -b ${branch} "${worktree}"`, 120_000);
            if (r2.exitCode !== 0) throw new Error(`sandbox.create failed: ${r.stderr || r2.stderr}`);
        }
        // A fresh worktree has no node_modules (gitignored) — symlink the base repo's so build/typecheck
        // runs without a reinstall. Cheap + isolated (read-only deps).
        const nm = path.join(worktree, 'node_modules');
        if (!fs.existsSync(nm) && fs.existsSync(path.join(repoRoot, 'node_modules'))) {
            await fs.promises.symlink(path.join(repoRoot, 'node_modules'), nm, 'dir').catch(() => undefined);
        }
        const info: SandboxInfo = { sandboxId, worktree, branch, repoRoot };
        this.boxes.set(sandboxId, info);
        return info;
    }
    // Re-register a sandbox created in an EARLIER advance iteration (each iteration builds a fresh ports
    // instance). Without this, a later local stage (Dev after PRD) can't find the worktree from wi.sandbox.
    adopt(info: SandboxInfo): void {
        if (info?.sandboxId) this.boxes.set(info.sandboxId, info);
    }
    private box(id: string): SandboxInfo {
        const b = this.boxes.get(id);
        if (b) return b;
        if (this.boxes.size === 1) return [...this.boxes.values()][0]; // tolerate a wrong/"default" id
        throw new Error(`unknown sandbox: ${id} (not adopted on this process?)`);
    }
    async readFile(id: string, p: string): Promise<string> {
        return fs.promises.readFile(safeJoin(this.box(id).worktree, p), 'utf8');
    }
    async writeFile(id: string, p: string, content: string): Promise<{ ok: boolean }> {
        const abs = safeJoin(this.box(id).worktree, p);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, content, 'utf8');
        return { ok: true };
    }
    async listDir(id: string, p: string): Promise<string[]> {
        const abs = safeJoin(this.box(id).worktree, p || '.');
        const ents = await fs.promises.readdir(abs, { withFileTypes: true });
        return ents.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    }
    async run(id: string, cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        // The LOCAL dev port runs commands directly on the host (no microVM — prod E2B sandboxes this), so a
        // whole-filesystem scan or an interactive/long-running command would hang the machine. Reject those with
        // an instructive error the agent can act on, and cap every command's wall-clock so a runaway fails fast.
        const wholeFsScan = /\b(find|grep|rg|fd|ls|du)\s+(-\S+\s+)*\/(\s|$)/.test(cmd);
        const blocking = /\b(top|htop|vim|vi|nano|emacs|less|more|man|watch|tail\s+-f|ssh|ftp|telnet|python\s*$|node\s*$|irb|psql\s*$|mysql\s*$)\b/.test(cmd)
            || /\b(uvicorn|gunicorn|flask\s+run|npm\s+(run\s+)?(start|dev|serve)|yarn\s+(start|dev)|http\.server|manage\.py\s+runserver)\b/.test(cmd);
        if (wholeFsScan) return { exitCode: 1, stdout: '', stderr: 'Rejected: whole-filesystem traversal is not allowed. Scope the search to the repo, e.g. `rg "PATTERN"` or `find . -name "..."` (never `/`).' };
        if (blocking) return { exitCode: 1, stdout: '', stderr: 'Rejected: interactive or long-running/server commands are not allowed (they would block). Run a one-shot command that exits, e.g. a test or a type/lint check.' };
        const timeoutMs = Number(process.env.AIDLC_SANDBOX_CMD_TIMEOUT_MS) || 120_000; // 2 min — a runaway fails fast and the agent adapts
        return sh(this.box(id).worktree, cmd, timeoutMs);
    }
    async diff(id: string): Promise<string> {
        const wt = this.box(id).worktree;
        await sh(wt, 'git add -A');
        const r = await sh(wt, 'git diff --cached');
        return r.stdout;
    }
    async teardown(id: string): Promise<void> {
        const b = this.boxes.get(id);
        if (!b) return;
        await sh(b.repoRoot, `git worktree remove --force "${b.worktree}"`).catch(() => undefined);
        await sh(b.repoRoot, `git branch -D ${b.branch}`).catch(() => undefined);
        this.boxes.delete(id);
    }
}

// ── testing.* — v1 runs the project's build/typecheck gate ───────────────────
class LocalTestingPort implements TestingPort {
    constructor(private readonly sandbox: LocalSandboxPort) {}
    async verify(sandboxId: string, commands?: string[]): Promise<TestReport> {
        // No explicit commands → fast scoped typecheck (only the change + its imports), not the whole repo.
        if (!(commands && commands.length)) {
            const t = await scopedTypecheck(this.sandbox, sandboxId);
            const ok = t.exitCode === 0;
            return {
                functional: { passed: ok ? 1 : 0, failed: ok ? 0 : 1, details: `${ok ? '✓' : '✗'} scoped typecheck (${t.scope || 'nothing'})${ok ? '' : `\n${t.output}`}` },
                visual: { diffRefs: [], regressions: 0 }, lighthouse: {}, verdict: ok ? 'green' : 'red', attempts: 0,
            };
        }
        let passed = 0, failed = 0;
        const details: string[] = [];
        for (const c of commands) {
            const r = await this.sandbox.run(sandboxId, c);
            if (r.exitCode === 0) { passed++; details.push(`✓ ${c}`); }
            else { failed++; details.push(`✗ ${c}\n${(r.stderr || r.stdout).slice(-2000)}`); }
        }
        return {
            functional: { passed, failed, details: details.join('\n\n') },
            visual: { diffRefs: [], regressions: 0 },
            lighthouse: {},
            verdict: failed === 0 ? 'green' : 'red',
            attempts: 0,
        };
    }
}

// ── deploy.* — v1 prepares the PR (diff + body); does NOT push/merge ─────────
class LocalDeployPort implements DeployPort {
    constructor(private readonly sandbox: LocalSandboxPort) {}
    async openPr(branch: string, body: string): Promise<{ prUrl: string }> {
        // v1: no push (git rule + safety). Record the PR intent; the real impl opens a GitHub PR.
        return { prUrl: `pr-ready://${branch}` };
    }
    async merge(): Promise<{ merged: boolean }> { return { merged: false }; }      // gated; not executed in v1
    async trigger(): Promise<{ deployRef: string }> { return { deployRef: 'deploy-skipped-v1' }; }
    async watch(): Promise<{ healthy: boolean; logsRef?: string }> { return { healthy: true }; }
    async rollback(): Promise<{ rolledBack: boolean }> { return { rolledBack: false }; }
}

// Design port. The UX agent ALWAYS writes the spec itself (grounded in the live design system via
// code.designSystemLookup). This optionally calls an external visual generator (Stitch) when a real
// endpoint is configured — otherwise it is HONEST that none is wired (never a fake "TODO"/"pending").
class LocalDesignPort implements DesignPort {
    async design(brief: string): Promise<{ stitchRef: string; spec: string }> {
        const url = process.env.STITCH_API_URL, key = process.env.STITCH_API_KEY;
        if (!url || !key) return { stitchRef: '', spec: `No external visual generator configured (set STITCH_API_URL + STITCH_API_KEY to enable). The UX agent derives the spec from the live design system for: ${brief.slice(0, 500)}` };
        try {
            const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ brief }) });
            const body: any = await res.json().catch(() => ({}));
            if (!res.ok) return { stitchRef: '', spec: `Stitch call failed (${res.status}); UX agent spec stands. ${body?.message || ''}` };
            return { stitchRef: body.id || body.ref || body.url || '', spec: body.spec || body.description || `Stitch design generated for: ${brief.slice(0, 200)}` };
        } catch (e: any) {
            return { stitchRef: '', spec: `Stitch call errored (${e?.message || e}); UX agent spec stands.` };
        }
    }
}
class LocalAnalyticsPort implements AnalyticsPort {
    async instrument(events: any[]): Promise<{ wired: number }> { return { wired: events.length }; }
}
class LocalGtmPort implements GtmPort {
    async draft(): Promise<{ assets: any[] }> { return { assets: [] }; }
    async outreach(): Promise<{ sent: number }> { return { sent: 0 }; }
}

// No-op base ServicePorts (the single-agent ports). AIDLC stages don't use these; memory is a working
// no-op because the loop's primeContext calls memory.recall each turn.
export function noopServicePorts(): ServicePorts {
    const nope = (n: string) => () => { throw new Error(`ServicePorts.${n} not available in AIDLC context`); };
    const memory: MemoryPort = {
        async recall() { return []; },
        async remember(userId, text, kind) { return { id: 'm', userId, kind, text, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; },
        async list() { return []; },
        async forget() { return { removed: 0, texts: [] }; },
    };
    return {
        memory,
        events: new Proxy({}, { get: (_t, p) => nope(`events.${String(p)}`) }) as unknown as EventsPort,
        payouts: new Proxy({}, { get: (_t, p) => nope(`payouts.${String(p)}`) }) as unknown as PayoutsPort,
        knowledge: { async search() { return []; } } as KnowledgePort,
        insights: new Proxy({}, { get: (_t, p) => nope(`insights.${String(p)}`) }) as unknown as InsightsPort,
        guests: new Proxy({}, { get: (_t, p) => nope(`guests.${String(p)}`) }) as unknown as GuestsPort,
        broadcast: new Proxy({}, { get: (_t, p) => nope(`broadcast.${String(p)}`) }) as unknown as BroadcastPort,
        invites: new Proxy({}, { get: (_t, p) => nope(`invites.${String(p)}`) }) as unknown as InvitesPort,
    };
}

export function makeLocalAidlcPorts(workItems: WorkItemStore, repoRoot: string, feature?: FeaturePort): AidlcServicePorts {
    const sandbox = new LocalSandboxPort();
    return {
        ...noopServicePorts(),
        code: new LocalCodePort(repoRoot),
        sandbox,
        testing: new LocalTestingPort(sandbox),
        deploy: new LocalDeployPort(sandbox),
        design: new LocalDesignPort(),
        analyticsWiring: new LocalAnalyticsPort(),
        gtm: new LocalGtmPort(),
        workItems,
        feature: feature || new NoopFeaturePort(),
    };
}
