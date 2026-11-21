// Auth primitives — password hashing (scrypt) + stateless session tokens (HMAC-signed, JWT-shaped).
// Zero-dependency (node:crypto). The signing key comes from AIDLC_AUTH_SECRET, else is DERIVED from
// MASTER_KEK (already in Vault), so there is no new secret to provision. Tokens are short JSON claims
// {sub,tid,role,exp}; the server verifies the HMAC + expiry on every protected request. Passwords are
// never stored — only `scrypt$N$salt$hash`, verified in constant time.

import crypto from 'node:crypto';

const SCRYPT_N = 16384, SCRYPT_r = 8, SCRYPT_p = 1, KEYLEN = 32;

export function hashPassword(plain: string): string {
    if (!plain || plain.length < 8) throw new Error('password must be at least 8 characters');
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(plain, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
    return `scrypt$${SCRYPT_N}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(plain: string, stored?: string): boolean {
    if (!stored) return false;
    const [scheme, nStr, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const got = crypto.scryptSync(plain, salt, expected.length, { N: Number(nStr) || SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/** The HMAC signing key: explicit AIDLC_AUTH_SECRET if set, else derived from MASTER_KEK (stable per deploy). */
export function authSecret(): string {
    const explicit = process.env.AIDLC_AUTH_SECRET;
    if (explicit) return explicit;
    const kek = process.env.MASTER_KEK;
    if (kek) return crypto.createHash('sha256').update(`aidlc-auth::${kek}`).digest('base64url');
    // Dev fallback — ephemeral, fine for local/in-memory (tokens reset on restart).
    return 'dev-insecure-auth-secret-change-me';
}

export interface Claims { sub: string; tid: string; role: string; email?: string; exp: number; }

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function signToken(claims: Omit<Claims, 'exp'>, ttlSeconds = 7 * 24 * 3600, secret = authSecret()): string {
    const body: Claims = { ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
    const payload = b64(body);
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}

export function verifyToken(token?: string, secret = authSecret()): Claims | null {
    if (!token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
        if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
        return claims;
    } catch { return null; }
}

/** Parse a Bearer token from an Authorization header. */
export function bearer(authHeader?: string): Claims | null {
    if (!authHeader) return null;
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    return m ? verifyToken(m[1]) : null;
}

/** Slugify a workspace name into a URL-safe tenant slug (with a short random suffix for uniqueness). */
export function slugify(name: string): string {
    const base = (name || 'workspace').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'workspace';
    return `${base}-${crypto.randomBytes(2).toString('hex')}`;
}
