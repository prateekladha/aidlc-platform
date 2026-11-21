// GIT-CLONE AIDLC ports — the REAL execution capability: clone the target repo fresh via a GitHub App
// installation token, let the Dev stage edit/commit on a branch, push it, and open a PR for human review.
// Identical code runs in-process on the backend (the local-execution path) and inside a Cloud Run Job
// (the isolation path) — only the StageDispatcher differs. Contrast ports.local.ts, which worktrees the
// repo already on disk; this clones any installed repo and can PUSH + open a real PR.
//
// Safety: nothing merges or deploys here. openPr() is the terminal write; merge/trigger are gated and
// only run post-approval via the DeployPort, which the supervisor calls after the human PR gate.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type {
    AidlcServicePorts, CodePort, SandboxPort, SandboxInfo, TestingPort, DeployPort,
    DesignPort, AnalyticsPort, GtmPort, WorkItemStore, TestReport, FeaturePort, PreviewDeployPort,
} from './types';
import { noopServicePorts } from './ports.local';
import { NoopFeaturePort } from './featureStore';
import { LiveDiagnosticsPort } from './ports.diagnostics';
import { scopedTypecheck } from './ports.typecheck';
import {
    installationToken, authedCloneUrl, defaultBranch, openPr as ghOpenPr,
    mergePr as ghMergePr, watchChecks as ghWatchChecks,
} from './github';

const pexec = promisify(exec);
const SANDBOX_ROOT = process.env.AIDLC_SANDBOX_ROOT || path.join(os.tmpdir(), 'aidlc-sandboxes');
// App identity for commits (shows as the bot author on the PR).
const GIT_AUTHOR_NAME = process.env.AIDLC_GIT_AUTHOR_NAME || 'perpetuum-aidlc[bot]';
const GIT_AUTHOR_EMAIL = process.env.AIDLC_GIT_AUTHOR_EMAIL || 'aidlc@perpetuum.local';
// Optional: reuse an existing node_modules so the sandbox can typecheck without a multi-minute install.
// Map repoFullName → absolute node_modules path. On this machine the backend's own deps are reused.
function nodeModulesCacheFor(repoFullName: string): string | undefined {
    const key = `AIDLC_NODE_MODULES_${repoFullName.split('/').pop()?.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
    return process.env[key];
}

async function sh(cwd: string, cmd: string, timeoutMs = 10 * 60_000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
        const { stdout, stderr } = await pexec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: process.env });
        return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) };
    } catch (e: any) {
        return { exitCode: typeof e?.code === 'number' ? e.code : 1, stdout: String(e?.stdout ?? ''), stderr: String(e?.stderr ?? e?.message ?? '') };
    }
}

function safeJoin(root: string, rel: string): string {
    const p = path.resolve(root, rel);
    if (p !== root && !p.startsWith(root + path.sep)) throw new Error(`path escapes sandbox: ${rel}`);
    return p;
}

// Keep the token out of logs: git stores the authed URL in .git/config; we set the remote via a header
// credential that we scrub after push. Simpler + safe-enough for v1: push with an inline authed URL and
// never log the command verbatim.
async function pushBranch(worktree: string, repoFullName: string, branch: string): Promise<void> {
    const token = await installationToken();
    const url = authedCloneUrl(repoFullName, token);
    const r = await sh(worktree, `git push "${url}" HEAD:refs/heads/${branch} --force-with-lease 2>&1 | sed 's#x-access-token:[^@]*@#x-access-token:***@#g'`, 180_000);
    if (r.exitCode !== 0) throw new Error(`git push failed: ${r.stdout || r.stderr}`.replace(/x-access-token:[^@]*@/g, 'x-access-token:***@'));
}

// ── sandbox.* — fresh clone of the target repo on a work branch ──────────────
// `repoRoot` here is the repo FULL NAME (owner/name). baseBranch '' → the repo default branch.
export class GitCloneSandboxPort implements SandboxPort {
    private boxes = new Map<string, SandboxInfo>();

    // Rehydrate a sandbox descriptor the supervisor persisted on the work item (cross-process resume).
    adopt(info: SandboxInfo): void {
        if (info?.sandboxId) this.boxes.set(info.sandboxId, info);
    }

    async create(workItemId: string, repoRoot: string, baseBranch: string): Promise<SandboxInfo> {
        const repoFullName = repoRoot; // owner/name
        await fs.promises.mkdir(SANDBOX_ROOT, { recursive: true });
        const sandboxId = `sbx_${workItemId}_${Date.now().toString(36)}`;
        const worktree = path.join(SANDBOX_ROOT, sandboxId);
        const base = baseBranch || (await defaultBranch(repoFullName));
        const branch = `aidlc/${workItemId}`;

        const token = await installationToken();
        const url = authedCloneUrl(repoFullName, token);
        const clone = await sh(SANDBOX_ROOT, `git clone --depth 1 --branch ${base} "${url}" "${worktree}" 2>&1 | sed 's#x-access-token:[^@]*@#x-access-token:***@#g'`, 300_000);
        if (!fs.existsSync(path.join(worktree, '.git'))) {
            throw new Error(`sandbox clone failed for ${repoFullName}@${base}: ${clone.stdout}`.replace(/x-access-token:[^@]*@/g, 'x-access-token:***@'));
        }
        // Scrub the token from the stored remote; set a clean origin (we push with an inline authed URL).
        await sh(worktree, `git remote set-url origin https://github.com/${repoFullName}.git`);
        await sh(worktree, `git config user.name "${GIT_AUTHOR_NAME}" && git config user.email "${GIT_AUTHOR_EMAIL}"`);
        // New branch off base; but if we cloned the work branch itself (a Dev repair resuming its branch),
        // we're already on it — don't recreate it.
        if (base !== branch) await sh(worktree, `git checkout -b ${branch}`);

        // Reuse cached node_modules if configured, so testing.verify can run tsc without npm ci.
        const nmCache = nodeModulesCacheFor(repoFullName);
        const nm = path.join(worktree, 'node_modules');
        if (nmCache && fs.existsSync(nmCache) && !fs.existsSync(nm)) {
            await fs.promises.symlink(nmCache, nm, 'dir').catch(() => undefined);
        } else if (process.env.AIDLC_SANDBOX_NPM_CI === '1' && fs.existsSync(path.join(worktree, 'package.json'))) {
            await sh(worktree, 'npm ci --no-audit --no-fund', 600_000).catch(() => undefined);
        }

        const info: SandboxInfo = { sandboxId, worktree, branch, repoRoot: repoFullName };
        this.boxes.set(sandboxId, info);
        return info;
    }

    private box(id: string): SandboxInfo {
        const b = this.boxes.get(id);
        if (b) return b;
        // Resilience: the agent sometimes passes "default"/a wrong id. If there is exactly one active sandbox
        // on this instance (the common case — one work item per ports instance), use it rather than failing.
        if (this.boxes.size === 1) return [...this.boxes.values()][0];
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
        return sh(this.box(id).worktree, cmd);
    }
    async diff(id: string): Promise<string> {
        const wt = this.box(id).worktree;
        await sh(wt, 'git add -A');
        return (await sh(wt, 'git diff --cached')).stdout;
    }
    // Commit everything staged + push the branch to origin. Returns the pushed branch.
    async commitAndPush(id: string, message: string): Promise<{ branch: string; pushed: boolean }> {
        const b = this.box(id);
        await sh(b.worktree, 'git add -A');
        const commit = await sh(b.worktree, `git commit -m ${JSON.stringify(message)} --author="${GIT_AUTHOR_NAME} <${GIT_AUTHOR_EMAIL}>"`);
        if (commit.exitCode !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
            throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
        }
        await pushBranch(b.worktree, b.repoRoot, b.branch);
        return { branch: b.branch, pushed: true };
    }
    async teardown(id: string): Promise<void> {
        const b = this.boxes.get(id);
        if (!b) return;
        await fs.promises.rm(b.worktree, { recursive: true, force: true }).catch(() => undefined);
        this.boxes.delete(id);
    }
}

// ── testing.* — runs the project's typecheck/build gate in the clone ─────────
class GitTestingPort implements TestingPort {
    constructor(private readonly sandbox: GitCloneSandboxPort) {}
    async verify(sandboxId: string, commands?: string[]): Promise<TestReport> {
        // No explicit commands → the fast, scoped typecheck (only the change + its imports).
        if (!(commands && commands.length)) {
            const t = await scopedTypecheck(this.sandbox, sandboxId);
            const ok = t.exitCode === 0;
            return {
                functional: { passed: ok ? 1 : 0, failed: ok ? 0 : 1, details: `${ok ? '✓' : '✗'} scoped typecheck (${t.scope || 'nothing'})${ok ? '' : `\n${t.output}`}` },
                visual: { diffRefs: [], regressions: 0 }, lighthouse: {}, verdict: ok ? 'green' : 'red', attempts: 0,
            };
        }
        // Explicit commands → run exactly those (the agent asked for a specific gate).
        let passed = 0, failed = 0;
        const details: string[] = [];
        for (const c of commands) {
            const r = await this.sandbox.run(sandboxId, c);
            const out = `${r.stdout || ''}\n${r.stderr || ''}`;
            // A non-existent npm script is NOT a code regression — skip it rather than fail the gate.
            if (r.exitCode !== 0 && /missing script|could not determine executable|command not found/i.test(out)) {
                details.push(`⚠ skipped "${c}" (not defined in this repo)`); continue;
            }
            if (r.exitCode === 0) { passed++; details.push(`✓ ${c}`); }
            else { failed++; details.push(`✗ ${c}\n${out.slice(-4000)}`); }
        }
        if (passed === 0 && failed === 0) { // everything was skipped → fall back to the scoped typecheck
            const t = await scopedTypecheck(this.sandbox, sandboxId);
            t.exitCode === 0 ? passed++ : failed++;
            details.push(`${t.exitCode === 0 ? '✓' : '✗'} scoped typecheck (${t.scope || 'nothing'})${t.exitCode === 0 ? '' : `\n${t.output}`}`);
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

// ── deploy.* — pushes the branch + opens a REAL PR; merge/trigger are gated ──
class GithubDeployPort implements DeployPort {
    private lastMergeSha?: string; // threaded merge→trigger→watch→rollback (deployRef = the merge SHA)
    constructor(private readonly sandbox: GitCloneSandboxPort, private readonly repoFullName: string) {}
    async openPr(branch: string, body: string): Promise<{ prUrl: string }> {
        const base = await defaultBranch(this.repoFullName);
        const title = (body.split('\n')[0] || `AIDLC: ${branch}`).replace(/^#+\s*/, '').slice(0, 80);
        const pr = await ghOpenPr({ repoFullName: this.repoFullName, head: branch, base, title, body, draft: false });
        return { prUrl: pr.prUrl };
    }
    // merge/trigger/watch/rollback run ONLY after the human PR gate (supervisor.runDeploySequence).
    async merge(prUrl: string): Promise<{ merged: boolean }> {
        const m = prUrl.match(/\/pull\/(\d+)/);
        if (!m) return { merged: false };
        const r = await ghMergePr({ repoFullName: this.repoFullName, number: Number(m[1]), method: 'squash' });
        if (r.merged && r.sha) this.lastMergeSha = r.sha;
        return { merged: r.merged };
    }
    async trigger(): Promise<{ deployRef: string }> {
        // CI deploys on merge to the default branch (existing GitHub Actions). The deployRef IS the merge SHA,
        // so watch() can poll that commit's checks. 'ci-on-merge' only when we somehow lack the SHA.
        return { deployRef: this.lastMergeSha || 'ci-on-merge' };
    }
    async watch(deployRef: string): Promise<{ healthy: boolean; logsRef?: string }> {
        // Honest post-deploy health: poll the merge commit's GitHub Actions checks. No SHA → nothing to gate on.
        if (!deployRef || deployRef === 'ci-on-merge') return { healthy: true };
        const r = await ghWatchChecks(this.repoFullName, deployRef, {
            timeoutMs: Number(process.env.AIDLC_DEPLOY_WATCH_TIMEOUT_MS) || 10 * 60 * 1000,
        }).catch((e) => ({ healthy: false, conclusion: `watch error: ${e?.message || e}`, logsRef: undefined as string | undefined }));
        return { healthy: r.healthy, logsRef: (r as any).logsRef };
    }
    async rollback(deployRef: string): Promise<{ rolledBack: boolean }> {
        // A reviewable, auditable rollback: a revert PR of the merge commit (never a force-push to main).
        if (!deployRef || deployRef === 'ci-on-merge') return { rolledBack: false };
        try {
            const base = await defaultBranch(this.repoFullName);
            const token = await installationToken();
            const url = authedCloneUrl(this.repoFullName, token);
            const dir = path.join(SANDBOX_ROOT, `revert_${deployRef.slice(0, 8)}_${Date.now().toString(36)}`);
            await fs.promises.mkdir(SANDBOX_ROOT, { recursive: true });
            const clone = await sh(SANDBOX_ROOT, `git clone "${url}" "${dir}" 2>&1 | sed 's#x-access-token:[^@]*@#x-access-token:***@#g'`, 300_000);
            if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`revert clone failed: ${clone.stdout}`);
            await sh(dir, `git config user.name "${GIT_AUTHOR_NAME}" && git config user.email "${GIT_AUTHOR_EMAIL}"`);
            const revertBranch = `aidlc/revert-${deployRef.slice(0, 8)}`;
            await sh(dir, `git checkout -b ${revertBranch}`);
            // -m 1 handles both a plain commit and a (non-squash) merge commit; --no-edit keeps it unattended.
            const rev = await sh(dir, `git revert --no-edit -m 1 ${deployRef} 2>&1 || git revert --no-edit ${deployRef} 2>&1`);
            if (/error|conflict|fatal/i.test(rev.stdout + rev.stderr) && !/\[.* [0-9a-f]{7}/.test(rev.stdout)) {
                throw new Error(`git revert failed (manual rollback needed): ${(rev.stdout + rev.stderr).slice(0, 300)}`);
            }
            await pushBranch(dir, this.repoFullName, revertBranch);
            await ghOpenPr({ repoFullName: this.repoFullName, head: revertBranch, base, title: `Revert AIDLC deploy ${deployRef.slice(0, 8)} (failed post-deploy checks)`, body: `Automated rollback: post-deploy CI checks failed for ${deployRef}. This PR reverts it. Review + merge to complete the rollback.`, draft: false });
            await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
            return { rolledBack: true };
        } catch {
            return { rolledBack: false };
        }
    }
}

class GitCodePort implements CodePort {
    // Reads/searches the cloned sandbox worktree (the actual target repo at the work branch).
    constructor(private readonly worktreeOf: () => string | undefined) {}
    private root(): string {
        const r = this.worktreeOf();
        if (!r) throw new Error('code.* unavailable: no sandbox cloned yet for this work item');
        return r;
    }
    async search(query: string, k = 10): Promise<Array<{ path: string; snippet: string; score: number }>> {
        const q = query.replace(/"/g, '\\"');
        const r = await sh(this.root(), `rg -n --no-heading -i "${q}" -g '!node_modules' -g '!build' -g '!.next' | head -n ${k * 2}`, 60_000)
            .then((x) => (x.exitCode === 0 || x.stdout ? x : null)).catch(() => null);
        const raw = r?.stdout || (await sh(this.root(), `git grep -n -i "${q}" | head -n ${k * 2}`, 60_000)).stdout;
        return String(raw).split('\n').filter(Boolean).slice(0, k).map((line, i) => {
            const m = line.match(/^([^:]+):(\d+):(.*)$/);
            return { path: m?.[1] || line, snippet: (m?.[3] || line).trim().slice(0, 240), score: 1 - i / (k * 2) };
        });
    }
    async read(p: string): Promise<string> {
        const full = await fs.promises.readFile(safeJoin(this.root(), p), 'utf8');
        // Cap EXPLORATION reads: an uncapped large file re-enters the context window every turn and blows the
        // stage's token budget (a real failure mode). The write-phase uses sandbox.readFile (uncapped) so
        // edits still see full content. For a big file, the agent should code.search to the needed section.
        const MAX = Number(process.env.AIDLC_CODE_READ_MAX) || 50000;
        return full.length > MAX ? `${full.slice(0, MAX)}\n\n… [truncated — file is ${full.length} chars; use code.search to locate the specific section you need]` : full;
    }
    async designSystemLookup(query: string): Promise<Array<{ component: string; path: string; usage: string }>> {
        const hits = await this.search(query, 8);
        return hits.filter((h) => /components?\//i.test(h.path)).map((h) => ({ component: path.basename(h.path), path: h.path, usage: h.snippet }));
    }
}

// Ephemeral per-branch preview deploy (flag-gated: AIDLC_PREVIEW_DEPLOY=1). Clones the branch, deploys it to
// a throwaway Cloud Run revision under a per-work-item tag (--no-traffic, so it never affects prod traffic),
// and returns the tagged URL for the Testing browser session. Teardown deletes the tagged revision. Needs a
// preview service + Cloud Build + deploy IAM (provisioned once); when not configured it is a no-op that says so.
class GcloudPreviewDeployPort implements PreviewDeployPort {
    async deploy(repoFullName: string, branch: string, workItemId: string): Promise<{ url: string; ref: string }> {
        // Repo-aware: each repo needs its OWN preview service (an FE Next.js build ≠ a backend build). Prefer
        // AIDLC_PREVIEW_SERVICE_<REPO> (e.g. AIDLC_PREVIEW_SERVICE_PERPETUUM_REVE_GROWTH_SITE), else the shared one.
        const repoKey = repoFullName.split('/').pop()?.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
        const svc = process.env[`AIDLC_PREVIEW_SERVICE_${repoKey}`] || process.env.AIDLC_PREVIEW_SERVICE;
        const region = process.env.AIDLC_PREVIEW_REGION || 'asia-south1';
        if (process.env.AIDLC_PREVIEW_DEPLOY !== '1' || !svc) return { url: '', ref: '' };
        const tag = `wi-${workItemId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
        const token = await installationToken();
        const url = authedCloneUrl(repoFullName, token);
        const dir = path.join(SANDBOX_ROOT, `preview_${tag}_${Date.now().toString(36)}`);
        await fs.promises.mkdir(SANDBOX_ROOT, { recursive: true });
        const clone = await sh(SANDBOX_ROOT, `git clone --depth 1 --branch ${branch} "${url}" "${dir}" 2>&1 | sed 's#x-access-token:[^@]*@#x-access-token:***@#g'`, 300_000);
        if (!fs.existsSync(path.join(dir, '.git'))) return { url: '', ref: '' };
        // --no-traffic + --tag → a preview revision reachable at the tagged URL only; prod traffic is untouched.
        const dep = await sh(dir, `gcloud run deploy ${svc} --source . --region ${region} --no-traffic --tag ${tag} --quiet --format="value(status.url)" 2>&1`, 1200_000);
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        const m = (dep.stdout || '').match(/https:\/\/\S+/);
        if (dep.exitCode !== 0 || !m) return { url: '', ref: '' };
        // The tagged URL is the service URL with the tag as a subdomain prefix (Cloud Run convention).
        const tagged = m[0].replace('https://', `https://${tag}---`);
        return { url: tagged, ref: `${svc}:${region}:${tag}` };
    }
    async teardown(ref: string): Promise<{ torndown: boolean }> {
        const [svc, region, tag] = (ref || '').split(':');
        if (!svc || !region || !tag) return { torndown: false };
        const r = await sh(SANDBOX_ROOT, `gcloud run services update-traffic ${svc} --region ${region} --remove-tags ${tag} --quiet 2>&1`, 300_000).catch(() => null);
        return { torndown: !!r && r.exitCode === 0 };
    }
}

// Design port. The UX agent ALWAYS produces the design spec itself (grounded in the live design system via
// code.designSystemLookup). This port optionally calls an external visual generator (Google Stitch) when a
// real endpoint is configured — otherwise it is HONEST that no visual generator is wired (not a fake "pending").
class StitchDesignPort implements DesignPort {
    async design(brief: string): Promise<{ stitchRef: string; spec: string }> {
        const url = process.env.STITCH_API_URL; // only call out when a real endpoint is configured
        const key = process.env.STITCH_API_KEY;
        if (!url || !key) {
            return { stitchRef: '', spec: `No external visual generator is configured (set STITCH_API_URL + STITCH_API_KEY to enable). The design spec is derived by the UX agent from the live design system for: ${brief.slice(0, 500)}` };
        }
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId: process.env.STITCH_MODEL_ID, deviceType: process.env.STITCH_DEVICE_TYPE || 'mobile', prompt: brief }),
            });
            const body: any = await res.json().catch(() => ({}));
            if (!res.ok) return { stitchRef: '', spec: `Stitch call failed (${res.status}); UX agent spec stands. ${body?.message || ''}` };
            return { stitchRef: body.id || body.ref || body.url || '', spec: body.spec || body.description || `Stitch design generated for: ${brief.slice(0, 200)}` };
        } catch (e: any) {
            return { stitchRef: '', spec: `Stitch call errored (${e?.message || e}); UX agent spec stands.` };
        }
    }
}
// Analytics wiring is implemented IN the Dev stage (the PRD's trackingEvents become code). This port just
// reports how many events the stage was asked to wire — the real wiring is in the diff, verified in Testing.
class AnalyticsWiringPort implements AnalyticsPort {
    async instrument(events: any[]): Promise<{ wired: number }> { return { wired: events.length }; }
}
// GTM port. The GTM agent drafts the real copy/channels itself. This port STAGES the campaign for human
// review + handoff — it never auto-sends (comm-runner owns transport; constitution §1/§9). "Sending" is a
// human action through the existing outreach tooling, not something AIDLC does unattended.
class StagedGtmPort implements GtmPort {
    async draft(): Promise<{ assets: any[] }> { return { assets: [] }; }
    async outreach(channels: string[], _payload: unknown): Promise<{ sent: number }> {
        // Staged, not sent: record intent to the log via the return shape (0 sent). A human routes it to the
        // real channels. Returning sent:0 is truthful — AIDLC does not blast messages on its own.
        void channels; void _payload;
        return { sent: 0 };
    }
}

/**
 * Real git-backed AIDLC ports. `targetRepo` is the repo full name (owner/name) the Dev stage clones.
 * Returns the ports plus the sandbox instance (the supervisor needs it to adopt/commit/push across stages).
 */
export function makeGitAidlcPorts(workItems: WorkItemStore, targetRepo: string, feature?: FeaturePort, deps?: { arango?: any; redis?: any }): { ports: AidlcServicePorts; sandbox: GitCloneSandboxPort } {
    const sandbox = new GitCloneSandboxPort();
    const currentWorktree = () => {
        // The most recently created/adopted box, if any (single active work item per ports instance).
        return (sandbox as any).boxes?.values ? [...(sandbox as any).boxes.values()][0]?.worktree : undefined;
    };
    const ports: AidlcServicePorts = {
        ...noopServicePorts(),
        code: new GitCodePort(currentWorktree),
        sandbox,
        testing: new GitTestingPort(sandbox),
        deploy: new GithubDeployPort(sandbox, targetRepo),
        design: new StitchDesignPort(),
        analyticsWiring: new AnalyticsWiringPort(),
        gtm: new StagedGtmPort(),
        previewDeploy: new GcloudPreviewDeployPort(),
        diagnostics: new LiveDiagnosticsPort(),
        workItems,
        feature: feature || new NoopFeaturePort(),
    };
    return { ports, sandbox };
}
