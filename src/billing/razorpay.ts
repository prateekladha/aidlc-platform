// Razorpay billing — the monetization path for the prepaid credits wallet. A tenant tops up credits by
// paying a Razorpay Order; we verify the payment signature (HMAC) before crediting, and verify webhooks the
// same way. India-first, test-mode friendly. Raw REST (no SDK dep). Keys are per-platform (RAZORPAY_KEY_ID /
// RAZORPAY_KEY_SECRET); amounts are in paise (₹1 = 100 paise), Razorpay's unit.

import crypto from 'node:crypto';
import type { Meter } from './meter';

export interface RazorpayOrder { id: string; amount: number; currency: string; status: string; receipt?: string; }

function timingSafeEqualHex(a: string, b: string): boolean {
    try {
        const ba = Buffer.from(a, 'hex'), bb = Buffer.from(b || '', 'hex');
        return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
    } catch { return false; }
}

export class RazorpayBilling {
    constructor(private readonly keyId: string, private readonly keySecret: string) {
        if (!keyId || !keySecret) throw new Error('RazorpayBilling: keyId + keySecret required');
    }
    static fromEnv(): RazorpayBilling | null {
        const id = process.env.RAZORPAY_KEY_ID, sec = process.env.RAZORPAY_KEY_SECRET;
        return id && sec ? new RazorpayBilling(id, sec) : null;
    }
    private auth(): string { return 'Basic ' + Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64'); }

    /** Create a Razorpay Order for a prepaid credits top-up. `amountPaise` = INR × 100. */
    async createCreditOrder(input: { amountPaise: number; receipt?: string; notes?: Record<string, string> }): Promise<RazorpayOrder> {
        if (!Number.isInteger(input.amountPaise) || input.amountPaise < 100) throw new Error('amountPaise must be an integer ≥ 100 (₹1)');
        const res = await fetch('https://api.razorpay.com/v1/orders', {
            method: 'POST',
            headers: { Authorization: this.auth(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: input.amountPaise, currency: 'INR', receipt: input.receipt, notes: input.notes, payment_capture: 1 }),
        });
        const j: any = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`Razorpay order failed (${res.status}): ${j?.error?.description || JSON.stringify(j).slice(0, 200)}`);
        return { id: j.id, amount: j.amount, currency: j.currency, status: j.status, receipt: j.receipt };
    }

    /** Verify a Razorpay Checkout success callback: HMAC_SHA256(`${orderId}|${paymentId}`, keySecret) === signature. */
    verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
        const expected = crypto.createHmac('sha256', this.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
        return timingSafeEqualHex(expected, signature);
    }

    /** Verify a Razorpay webhook: HMAC_SHA256(rawBody, webhookSecret) === X-Razorpay-Signature. */
    static verifyWebhookSignature(rawBody: string, signature: string, webhookSecret: string): boolean {
        const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
        return timingSafeEqualHex(expected, signature);
    }
}

// ── Credits wallet — prepaid balance per tenant, debited per run, topped up by a verified payment ──
// Minimal ledger (in-mem now; moves to the DataStore/Postgres with the rest). The platform's credit unit is
// abstracted from tokens (Devin ACU / Copilot-credit pattern) — here 1 credit = ₹0.01 for a simple demo rate.
export interface CreditsLedger {
    balance(tenantId: string): Promise<number>;
    credit(tenantId: string, credits: number, ref: string): Promise<number>;
    debit(tenantId: string, credits: number, ref: string): Promise<number>;
}
// A Meter that also DEBITS the credits wallet as a run burns tokens — closing the usage→credits loop. Wraps
// the real meter (keeps run/token accounting) and debits credits = tokens × rate from the tenant's wallet.
export class CreditsMeter implements Meter {
    constructor(
        private readonly base: Meter,
        private readonly ledger: CreditsLedger,
        private readonly creditsPerToken = Number(process.env.AIDLC_CREDITS_PER_TOKEN) || 0.006,
    ) {}
    async record(ev: Parameters<Meter['record']>[0]): Promise<void> {
        await this.base.record(ev);
        if (ev.kind === 'tokens' && ev.quantity > 0) await this.ledger.debit(ev.tenantId, ev.quantity * this.creditsPerToken, ev.runId || 'run');
    }
    summary(tenantId: string) { return this.base.summary(tenantId); }
}

export class InMemoryCreditsLedger implements CreditsLedger {
    private bal = new Map<string, number>();
    private log: Array<{ tenantId: string; delta: number; ref: string; at: string }> = [];
    async balance(tenantId: string): Promise<number> { return this.bal.get(tenantId) || 0; }
    async credit(tenantId: string, credits: number, ref: string): Promise<number> {
        const next = (this.bal.get(tenantId) || 0) + Math.max(0, Math.round(credits));
        this.bal.set(tenantId, next); this.log.push({ tenantId, delta: Math.round(credits), ref, at: new Date().toISOString() });
        return next;
    }
    async debit(tenantId: string, credits: number, ref: string): Promise<number> {
        const next = Math.max(0, (this.bal.get(tenantId) || 0) - Math.max(0, Math.round(credits)));
        this.bal.set(tenantId, next); this.log.push({ tenantId, delta: -Math.round(credits), ref, at: new Date().toISOString() });
        return next;
    }
}
