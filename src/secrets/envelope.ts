// Envelope-encryption SecretProvider (AES-256-GCM). Ciphertext (iv:tag:data, all base64) is the only thing
// stored at rest (SecretRecord.ciphertext); plaintext is produced only by get()/bundleForRun() JIT and never
// persisted. The master KEK comes from env (MASTER_KEK, base64 32 bytes) — in production a KMS-wrapped data
// key; the Vault-namespaces impl replaces this file entirely behind the same SecretProvider interface.

import crypto from 'node:crypto';
import type { TenantContext } from '../tenancy/context';
import type { SecretProvider } from './provider';

const ALG = 'aes-256-gcm';

function kek(): Buffer {
    const b64 = process.env.MASTER_KEK;
    if (b64) {
        const b = Buffer.from(b64, 'base64');
        if (b.length === 32) return b;
    }
    // Dev-only deterministic key so tests run with no setup. NEVER relied on in prod (set MASTER_KEK).
    return crypto.createHash('sha256').update('aidlc-dev-kek-insecure-do-not-use-in-prod').digest();
}

export class EnvelopeSecretProvider implements SecretProvider {
    async put(ctx: TenantContext, name: string, plaintext: string): Promise<void> {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(ALG, kek(), iv);
        const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        const ciphertext = [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
        await ctx.putSecret({ name, ciphertext });
    }

    async get(ctx: TenantContext, name: string): Promise<string | null> {
        const rec = await ctx.getSecret(name);
        if (!rec) return null;
        const [ivb, tagb, datab] = rec.ciphertext.split(':');
        if (!ivb || !tagb || !datab) return null;
        try {
            const decipher = crypto.createDecipheriv(ALG, kek(), Buffer.from(ivb, 'base64'));
            decipher.setAuthTag(Buffer.from(tagb, 'base64'));
            const dec = Buffer.concat([decipher.update(Buffer.from(datab, 'base64')), decipher.final()]);
            return dec.toString('utf8');
        } catch {
            return null; // tamper / wrong key → fail closed (no plaintext)
        }
    }

    async bundleForRun(ctx: TenantContext): Promise<Record<string, string>> {
        const recs = await ctx.listSecrets();
        const out: Record<string, string> = {};
        for (const r of recs) {
            const v = await this.get(ctx, r.name);
            if (v != null) out[r.name] = v;
        }
        return out;
    }
}
