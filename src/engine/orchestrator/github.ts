// GitHub App integration for the AIDLC Dev + Deploy stages. The workers (Cloud Run Jobs) clone the
// target repo, push a branch, and open a PR AS THE APP — never with a long-lived PAT. We mint a
// short-lived installation access token (≤1h) from the App private key on demand and cache it until it
// is near expiry.
//
// Credentials come from the environment (house pattern — every secret is an env var injected at deploy;
// on the worker Job they are mounted via `--set-secrets`, so the private key never lives in a yaml):
//   AIDLC_GITHUB_APP_ID        — numeric App ID
//   AIDLC_GITHUB_INSTALL_ID    — numeric installation ID (the install on @perpetuumhq)
//   AIDLC_GITHUB_APP_KEY       — the PEM private key (Secret Manager: aidlc-github-app-key)
// For local iteration, AIDLC_GITHUB_APP_KEY_FILE may point at the .pem on disk instead.
//
// No octokit / no @google-cloud/secret-manager dependency: Node 22 global fetch + jsonwebtoken (already
// in the tree) keep this lean and auditable.

import fs from 'node:fs';
import jwt from 'jsonwebtoken';

const GH_API = 'https://api.github.com';
const UA = 'perpetuum-aidlc';

export interface GithubAppConfig {
    appId: string;
    installId: string;
    privateKey: string;
}

export function getAppConfig(): GithubAppConfig {
    const appId = process.env.AIDLC_GITHUB_APP_ID?.trim();
    const installId = process.env.AIDLC_GITHUB_INSTALL_ID?.trim();
    // Accept both the canonical names and the shorter AIDLC_GITHUB_KEY / _KEY_FILE aliases (easy to mistype).
    let privateKey = process.env.AIDLC_GITHUB_APP_KEY || process.env.AIDLC_GITHUB_KEY;
    const keyFile = process.env.AIDLC_GITHUB_APP_KEY_FILE || process.env.AIDLC_GITHUB_KEY_FILE;
    if (!privateKey && keyFile) {
        privateKey = fs.readFileSync(keyFile, 'utf8');
    }
    // Env round-trips can turn real newlines into the literal two-char sequence "\n"; restore them.
    if (privateKey && privateKey.includes('\\n') && !privateKey.includes('\n')) {
        privateKey = privateKey.replace(/\\n/g, '\n');
    }
    if (!appId || !installId || !privateKey) {
        throw new Error(
            'GitHub App not configured: set AIDLC_GITHUB_APP_ID, AIDLC_GITHUB_INSTALL_ID, and AIDLC_GITHUB_APP_KEY (or AIDLC_GITHUB_APP_KEY_FILE).',
        );
    }
    return { appId, installId, privateKey };
}

// A 10-minute App JWT (RS256), iat backdated 60s to tolerate clock skew. Used only to mint an
// installation token; never sent to git or stored.
function appJwt(cfg: GithubAppConfig): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign({ iat: now - 60, exp: now + 540, iss: cfg.appId }, cfg.privateKey, { algorithm: 'RS256' });
}

// ── Installation token cache ─────────────────────────────────────────────────
let cached: { token: string; expMs: number } | null = null;
const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh 5 min before the 1h expiry

/** A valid installation access token, cached and refreshed before expiry. */
export async function installationToken(cfg = getAppConfig()): Promise<string> {
    if (cached && cached.expMs - Date.now() > REFRESH_SKEW_MS) return cached.token;
    const res = await fetch(`${GH_API}/app/installations/${cfg.installId}/access_tokens`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${appJwt(cfg)}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': UA,
        },
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.status !== 201 || !body.token) {
        throw new Error(`installation token mint failed: ${res.status} ${body.message || JSON.stringify(body)}`);
    }
    cached = { token: body.token, expMs: new Date(body.expires_at).getTime() };
    return body.token;
}

// ── REST helper (installation-token authed) ──────────────────────────────────
async function gh<T = any>(
    path: string,
    opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: T }> {
    const token = opts.token || (await installationToken());
    const res = await fetch(path.startsWith('http') ? path : `${GH_API}${path}`, {
        method: opts.method || 'GET',
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': UA,
            ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body };
}

/** A clone/push URL with the installation token embedded (x-access-token). Treat as a secret. */
export function authedCloneUrl(repoFullName: string, token: string): string {
    return `https://x-access-token:${token}@github.com/${repoFullName}.git`;
}

export async function defaultBranch(repoFullName: string): Promise<string> {
    const { status, body } = await gh<any>(`/repos/${repoFullName}`);
    if (status !== 200) throw new Error(`repo lookup failed for ${repoFullName}: ${status} ${body?.message}`);
    return body.default_branch;
}

/** The SHA a ref currently points at (ref e.g. "heads/production"). */
export async function refSha(repoFullName: string, ref: string): Promise<string> {
    const { status, body } = await gh<any>(`/repos/${repoFullName}/git/ref/${ref}`);
    if (status !== 200) throw new Error(`ref ${ref} lookup failed: ${status} ${body?.message}`);
    return body.object.sha;
}

export async function createBranch(repoFullName: string, branch: string, fromSha: string): Promise<void> {
    const { status, body } = await gh(`/repos/${repoFullName}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${branch}`, sha: fromSha },
    });
    if (status !== 201 && status !== 422 /* already exists */) {
        throw new Error(`createBranch ${branch} failed: ${status} ${(body as any)?.message}`);
    }
}

export async function deleteBranch(repoFullName: string, branch: string): Promise<void> {
    await gh(`/repos/${repoFullName}/git/refs/heads/${branch}`, { method: 'DELETE' });
}

/** Create or update a single file on a branch (Contents API) — used for API-based commits + smoke tests. */
export async function putFile(args: {
    repoFullName: string;
    path: string;
    branch: string;
    contentBase64: string;
    message: string;
    sha?: string; // required when updating an existing file
}): Promise<{ commitSha: string }> {
    const { status, body } = await gh<any>(`/repos/${args.repoFullName}/contents/${args.path}`, {
        method: 'PUT',
        body: { message: args.message, content: args.contentBase64, branch: args.branch, sha: args.sha },
    });
    if (status !== 200 && status !== 201) {
        throw new Error(`putFile ${args.path} failed: ${status} ${body?.message}`);
    }
    return { commitSha: body.commit?.sha };
}

export interface OpenPrArgs {
    repoFullName: string;
    head: string; // branch with the changes (already pushed)
    base: string; // target branch
    title: string;
    body: string;
    draft?: boolean;
}

export async function openPr(args: OpenPrArgs): Promise<{ prUrl: string; number: number }> {
    const { status, body } = await gh<any>(`/repos/${args.repoFullName}/pulls`, {
        method: 'POST',
        body: { title: args.title, head: args.head, base: args.base, body: args.body, draft: args.draft ?? false },
    });
    if (status === 201) return { prUrl: body.html_url, number: body.number };
    // Idempotent: a PR for this head already exists (422) → return the existing one instead of failing.
    const existsErr = status === 422 && JSON.stringify(body?.errors || body?.message || '').toLowerCase().includes('already exist');
    if (existsErr) {
        const owner = args.repoFullName.split('/')[0];
        const { status: ls, body: list } = await gh<any[]>(`/repos/${args.repoFullName}/pulls?head=${owner}:${args.head}&state=open`);
        if (ls === 200 && Array.isArray(list) && list[0]) return { prUrl: list[0].html_url, number: list[0].number };
    }
    throw new Error(`openPr failed: ${status} ${body?.message || JSON.stringify(body?.errors)}`);
}

export async function mergePr(args: {
    repoFullName: string;
    number: number;
    method?: 'merge' | 'squash' | 'rebase';
}): Promise<{ merged: boolean; sha?: string }> {
    const { status, body } = await gh<any>(`/repos/${args.repoFullName}/pulls/${args.number}/merge`, {
        method: 'PUT',
        body: { merge_method: args.method || 'squash' },
    });
    return { merged: status === 200 && !!body.merged, sha: body.sha };
}

export async function closePr(repoFullName: string, number: number): Promise<void> {
    await gh(`/repos/${repoFullName}/pulls/${number}`, { method: 'PATCH', body: { state: 'closed' } });
}

/** Poll the CI check-runs for a commit until they complete (or time out). Honest post-deploy health:
 *  a merge that trips the repo's GitHub Actions is NOT healthy. Returns the aggregate conclusion. */
export async function watchChecks(
    repoFullName: string,
    sha: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ healthy: boolean; conclusion: string; total: number; completed: number; logsRef?: string }> {
    const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
    const pollMs = opts.pollMs ?? 15 * 1000;
    const deadline = Date.now() + timeoutMs;
    const logsRef = `https://github.com/${repoFullName}/commit/${sha}/checks`;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const { status, body } = await gh<any>(`/repos/${repoFullName}/commits/${sha}/check-runs`);
        if (status !== 200) return { healthy: false, conclusion: `check-runs lookup failed (${status})`, total: 0, completed: 0, logsRef };
        const runs: any[] = body.check_runs || [];
        const total = runs.length;
        const completed = runs.filter((r) => r.status === 'completed').length;
        if (total === 0) {
            // No CI configured for this commit → nothing to gate on. Treat as healthy but say so.
            if (Date.now() > deadline) return { healthy: true, conclusion: 'no-checks', total, completed, logsRef };
        } else if (completed === total) {
            const bad = runs.find((r) => !['success', 'neutral', 'skipped'].includes(r.conclusion));
            return { healthy: !bad, conclusion: bad ? `${bad.name}: ${bad.conclusion}` : 'success', total, completed, logsRef };
        }
        if (Date.now() > deadline) return { healthy: false, conclusion: `timeout (${completed}/${total} checks completed)`, total, completed, logsRef };
        await new Promise((r) => setTimeout(r, pollMs));
    }
}
