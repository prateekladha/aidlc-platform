// LOCAL-MODE AIDLC engine adapter — the self-hosted / dev / E2E-test git-auth mode.
//
// The production AidlcEngine (engine.aidlc.ts) uses the GIT ports: it clones the tenant's repo with a
// short-lived GitHub-App installation token, pushes, and opens the PR as the App. That is the multi-tenant
// SaaS path, and connecting the App is an ONBOARDING capability (one platform App the tenant installs).
//
// This LOCAL-mode engine is the other git-auth mode: it runs on a LOCAL CLONE of the target repo and
// pushes / opens the PR via the machine's own `gh` / git auth — no App. It is how the platform operator
// self-hosts, and how we test the whole platform end-to-end (control plane → dispatch → engine → gated PR)
// without standing up the App. The port contracts are identical; only the git-auth differs.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Engine, EngineRunInput, EngineRunOutput } from './dispatch';
import type { RunState } from '../types';
import type { Model } from '../engine/types';
import { Supervisor, type AidlcEvent } from '../engine/orchestrator/orchestrator';
import { LocalDispatcher } from '../engine/orchestrator/dispatcher';
import { InMemoryWorkItemStore } from '../engine/orchestrator/workItemStore.memory';
import { InMemoryDecisionLog } from '../engine/stores';
import { makeLocalAidlcPorts } from '../engine/orchestrator/ports.local';
import type { AidlcServicePorts, DeployPort, Stage } from '../engine/orchestrator/types';
import { ClaudeModel } from '../engine/model/claude';
import { OpenAICompatModel, OPENAI_COMPAT_PROVIDERS } from '../engine/model/openai-compat';

const pexec = promisify(exec);

async function sh(cwd: string, cmd: string, timeoutMs = 5 * 60_000): Promise<{ code: number; out: string }> {
    try {
        const { stdout, stderr } = await pexec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: process.env });
        return { code: 0, out: String(stdout || stderr) };
    } catch (e: any) {
        return { code: typeof e?.code === 'number' ? e.code : 1, out: String(e?.stdout || '') + String(e?.stderr || e?.message || '') };
    }
}

/** A git `-c http.extraheader=…` flag that authenticates HTTPS git ops with a GitHub token WITHOUT writing
 *  the token into .git/config on disk. Works for a GitHub-App installation token or a fine-grained PAT. */
function ghAuth(token?: string): string {
    if (!token) return '';
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    return `-c http.extraheader="AUTHORIZATION: basic ${basic}"`;
}

/** Open a PR via the GitHub REST API (no `gh` CLI — so this works on a headless server). Idempotent: if a
 *  PR already exists for the branch, returns its URL; falls back to a non-draft PR if drafts are unsupported. */
async function openPrRest(fullName: string, token: string, head: string, base: string, title: string, body: string): Promise<string | null> {
    const [owner, repo] = fullName.split('/');
    const H = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' };
    const create = (draft: boolean) => fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, { method: 'POST', headers: H, body: JSON.stringify({ title, head, base, body: body.slice(0, 60000), draft }) });
    let res = await create(true);
    if (res.status === 422) {
        const q = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${head}&state=open`, { headers: H });
        const arr: any = await q.json().catch(() => []);
        if (Array.isArray(arr) && arr[0]?.html_url) return arr[0].html_url;
        res = await create(false); // e.g. drafts unsupported on the plan
    }
    if (!res.ok) return null;
    const j: any = await res.json().catch(() => ({}));
    return j.html_url || null;
}

/** Ensure a local clone of `fullName` exists under the runs root. With a token → clone/fetch over HTTPS using
 *  the auth header (headless, no gh). Without → `gh` (local-operator dev mode). */
async function ensureLocalClone(fullName: string, token?: string): Promise<string> {
    const root = process.env.AIDLC_LOCAL_REPO_ROOT || path.join(os.homedir(), 'git', 'aidlc-runs');
    const dir = path.join(root, fullName.split('/').pop()!);
    const fs = await import('node:fs');
    await sh(root, `mkdir -p "${root}"`);
    if (fs.existsSync(path.join(dir, '.git'))) {
        await sh(dir, `git ${ghAuth(token)} fetch --all --prune`);
    } else if (token) {
        const r = await sh(root, `git ${ghAuth(token)} clone https://github.com/${fullName}.git "${dir}"`);
        if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`token clone failed for ${fullName}: ${r.out.slice(-400)}`);
    } else {
        const r = await sh(root, `gh repo clone ${fullName} "${dir}"`);
        if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`clone failed for ${fullName} (no GITHUB_TOKEN and gh not authenticated): ${r.out.slice(-400)}`);
    }
    return dir;
}

/** Real push/PR deploy port for LOCAL mode: commit the worktree, push the branch to origin (via local gh),
 *  open a DRAFT PR (honest: PR open, NOT merged — that is the human gate). Replaces the no-push local port. */
function makePushDeployPort(baseBranch: string, fullName: string, token?: string): DeployPort {
    const sbxRoot = process.env.AIDLC_SANDBOX_ROOT || path.join(os.tmpdir(), 'aidlc-sandboxes');
    return {
        async openPr(branch: string, body: string): Promise<{ prUrl: string }> {
            const sandboxId = branch.replace(/^aidlc\//, '');
            const wt = path.join(sbxRoot, sandboxId);
            // The engine sometimes emits escaped newlines (literal "\n") in the PR body — unescape so the
            // Markdown renders.
            const md = body.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '  ').trim();
            const title = (md.split('\n').find((l) => l.trim()) || `AIDLC: ${branch}`).replace(/^#+\s*/, '').slice(0, 72);
            await sh(wt, 'git add -A');
            await sh(wt, `git -c user.name="${process.env.AIDLC_GIT_AUTHOR_NAME || 'AIDLC Agent'}" -c user.email="${process.env.AIDLC_GIT_AUTHOR_EMAIL || 'agent@aidlc.local'}" commit -m ${JSON.stringify(title)} --no-verify`);
            const push = await sh(wt, `git ${ghAuth(token)} push -u origin ${branch} --force-with-lease`);
            if (push.code !== 0) return { prUrl: `push-failed://${branch} :: ${push.out.slice(-300)}` };
            // Token present → open the PR via REST (works headless). Else fall back to the gh CLI (local dev).
            if (token) {
                const url = await openPrRest(fullName, token, branch, baseBranch, title, md);
                return { prUrl: url || `pr-open-unconfirmed://${branch}` };
            }
            const bodyFile = path.join(os.tmpdir(), `aidlc-pr-${sandboxId}.md`);
            fs.writeFileSync(bodyFile, md.slice(0, 60000));
            const pr = await sh(wt, `gh pr create --base ${baseBranch} --head ${branch} --title ${JSON.stringify(title)} --body-file ${JSON.stringify(bodyFile)} --draft`);
            try { fs.unlinkSync(bodyFile); } catch { /* ignore */ }
            const url = (pr.out.match(/https:\/\/github\.com\/\S+\/pull\/\d+/) || [])[0];
            return { prUrl: url || `pr-open-unconfirmed://${branch} :: ${pr.out.slice(-300)}` };
        },
        async merge() { return { merged: false }; },      // gated — never auto-merge
        async trigger() { return { deployRef: 'local-mode' }; },
        async watch() { return { healthy: true }; },
        async rollback() { return { rolledBack: false }; },
    };
}

function buildModel(provider: string, modelId: string, baseURL: string | undefined, apiKey: string): Model {
    if (provider === 'anthropic' || provider === 'claude') return new ClaudeModel({ apiKey, model: modelId });
    const known = OPENAI_COMPAT_PROVIDERS[provider];
    const url = baseURL || known?.baseURL;
    if (!url) throw new Error(`AIDLC local engine: unknown provider '${provider}' and no modelBaseURL`);
    // Generous output cap: deepseek-v4-pro etc. are reasoning models (reasoning tokens draw from the output budget).
    const maxTokens = Number(process.env.AIDLC_MODEL_MAX_TOKENS) || 16000;
    return new OpenAICompatModel({ baseURL: url, apiKey, model: modelId, maxTokens, providerLabel: known?.label || provider });
}

function withTokenCounter(m: Model, add: (n: number) => void): Model {
    const w: Model = { id: m.id, generate: async (i) => { const t = await m.generate(i); add(t.usage?.totalTokens || 0); return t; } };
    if (m.generateStream) w.generateStream = async (i, cb) => { const t = await m.generateStream!(i, cb); add(t.usage?.totalTokens || 0); return t; };
    return w;
}

// Auto-approve every pre-deploy gate; HOLD at deploy (so we open the PR explicitly, then stop at merge-confirmation).
const AUTO_APPROVE: Stage[] = ['prd', 'ux', 'dev', 'fix', 'testing', 'analytics', 'gtm'];

export class LocalAidlcEngine implements Engine {
    async run(input: EngineRunInput): Promise<EngineRunOutput> {
        const { ctx, run, config, emit } = input;
        const apiKey = input.secrets.MODEL_API_KEY || input.secrets.ANTHROPIC_API_KEY || process.env.AIDLC_OPENAI_COMPAT_API_KEY || '';
        if (!apiKey) throw new Error('AIDLC local engine: no model API key (tenant secret MODEL_API_KEY)');

        const wi = await ctx.getWorkItem(run.workItemId);
        if (!wi) throw new Error(`work item not found: ${run.workItemId}`);
        const repo = await ctx.getRepo(wi.repoId);
        if (!repo) throw new Error(`repo not found: ${wi.repoId}`);

        // GitHub auth for clone/push/PR: a tenant-provided token (fine-grained PAT or a minted GitHub-App
        // installation token), else a platform env token, else fall back to local `gh` (operator dev mode).
        const ghToken = input.secrets.GITHUB_TOKEN || process.env.GITHUB_TOKEN || undefined;
        const repoRoot = await ensureLocalClone(repo.fullName, ghToken);
        await emit('local.clone_ready', { repoRoot, repo: repo.fullName, auth: ghToken ? 'token' : 'gh-cli' });

        const provider = config.modelProvider || 'deepseek';
        let costTokens = 0;
        const add = (n: number) => { costTokens += n; };
        const model = withTokenCounter(buildModel(provider, config.model, config.modelBaseURL, apiKey), add);
        const criticModel = withTokenCounter(buildModel(provider, config.criticModel || config.model, config.modelBaseURL, apiKey), add);

        const store = new InMemoryWorkItemStore();
        const log = new InMemoryDecisionLog();
        const pushDeploy = makePushDeployPort(repo.defaultBranch, repo.fullName, ghToken);
        const portsFactory = (_repoFullName: string): AidlcServicePorts => {
            const ports = makeLocalAidlcPorts(store, repoRoot);
            return { ...ports, deploy: pushDeploy };   // swap in the real push/PR deploy port
        };

        const onEvent = (e: AidlcEvent): void => {
            if (process.env.AIDLC_E2E_LOG) console.log(`   · ${e.type}${(e as any).stage ? ' [' + (e as any).stage + ']' : ''}`);
            void emit(e.type, e as unknown as Record<string, unknown>);
        };

        const sup = new Supervisor({
            store, portsFactory, dispatcher: new LocalDispatcher(), log, model, criticModel,
            targetRepo: repoRoot, baseBranch: repo.defaultBranch,   // LOCAL mode: targetRepo = the local clone PATH (sandbox.create uses it as repoRoot)
            config: { autoApproveStages: AUTO_APPROVE, maxConcurrentWorkItems: config.maxConcurrentRuns },
            onEvent,
            sinks: { bus: (e) => { void emit(`obs.${e.type}`, e as unknown as Record<string, unknown>); } },
            qualityOn: true,
        });

        const created = await sup.submit({ requester: wi.createdBy || 'platform', channel: 'api', rawRequest: wi.rawRequest }, wi.title || wi.rawRequest.slice(0, 60), repoRoot);
        let done = await sup.advance(created.id);
        let gate = await sup.openGate(created.id);

        // At the deploy PR-approval gate: approve ONCE to open the PR, then hold at the merge-confirmation gate.
        if (gate && (gate.stage === 'deploy' || gate.stage === 'infra_apply') && (gate as any).kind !== 'merge_confirmation') {
            await emit('local.deploy_gate_approve', { note: 'open PR, then hold at merge-confirmation' });
            done = await sup.decideGate(created.id, 'approve', 'e2e: open PR; hold at merge');
            done = await sup.advance(created.id);
            gate = await sup.openGate(created.id);
        }

        const st = String((done as any)?.status?.state || '');
        const prUrl: string | undefined = (done as any)?.deploy?.prUrl;
        let state: RunState;
        if (st === 'awaiting_input') state = 'awaiting_input';
        else if (gate) state = 'awaiting_gate';
        else if (st === 'error' || st === 'failed') state = 'failed';
        else if (prUrl || st === 'done' || st === 'complete' || st === 'passed') state = 'passed';
        else state = 'running';

        return { state, costTokens, prUrl, stage: String((done as any)?.status?.stage || gate?.stage || '') };
    }
}
