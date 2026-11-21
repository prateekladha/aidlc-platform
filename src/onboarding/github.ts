// GitHub App onboarding (multi-tenant). A GitHub App (NOT an OAuth App): tenants INSTALL it + select repos
// (the whitelist); we mint short-lived, repo-scoped installation tokens for clones/PRs with least-privilege
// permissions. The App JWT (RS256) + the webhook HMAC are implemented with node:crypto (no deps). The only
// network call is the installation-token exchange (real fetch). See ARCHITECTURE §3.6.

import crypto from 'node:crypto';
import type { DataStore } from '../db/store';

export interface GitHubAppConfig {
    appId: string;
    privateKeyPem: string;   // the App's .pem private key
    webhookSecret: string;
}

/** Least-privilege permissions for a "read code + open PRs" agent (see research brief §2a). */
export const LEAST_PRIV_PERMISSIONS = { contents: 'write', pull_requests: 'write', metadata: 'read' } as const;

const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Mint the App-level JWT (RS256), valid ~9 min, to authenticate AS the App. */
export function mintAppJwt(cfg: GitHubAppConfig, nowMs = Date.now()): string {
    const nowSec = Math.floor(nowMs / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = { iat: nowSec - 60, exp: nowSec + 9 * 60, iss: cfg.appId };
    const signingInput = `${b64url(header)}.${b64url(payload)}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), cfg.privateKeyPem).toString('base64url');
    return `${signingInput}.${sig}`;
}

/** Exchange the App JWT for a short-lived installation token (~1h), optionally DOWN-scoped to specific repos
 *  + least-privilege permissions. This token is what the sandbox uses to clone + push — never a user token. */
export async function mintInstallationToken(
    cfg: GitHubAppConfig,
    installationId: number,
    opts?: { repositories?: string[]; permissions?: Record<string, string> },
): Promise<{ token: string; expiresAt: string }> {
    const jwt = mintAppJwt(cfg);
    const body: Record<string, unknown> = {};
    if (opts?.repositories) body.repositories = opts.repositories;
    body.permissions = opts?.permissions ?? LEAST_PRIV_PERMISSIONS;
    const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`installation token exchange failed: ${res.status} ${await res.text().catch(() => '')}`);
    const j: any = await res.json();
    return { token: String(j.token), expiresAt: String(j.expires_at) };
}

/** Verify an inbound webhook's X-Hub-Signature-256 HMAC (constant-time). Reject anything that doesn't match. */
export function verifyWebhookSignature(secret: string, rawBody: string | Buffer, signatureHeader?: string): boolean {
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** THE multi-tenant security rule: resolve a webhook/event to its tenant via the installation WE recorded —
 *  never trust the payload's claimed owner. Returns null if we don't own that installation (reject the event). */
export async function tenantForInstallation(store: DataStore, installationId: number): Promise<string | null> {
    const inst = await store.getInstallationByGh(installationId);
    return inst?.tenantId ?? null;
}
