// HTTP API — the control-plane surface the FE (and tenants' own tooling) call. Thin: validate + call the
// framework-agnostic services in service.ts. Zero-dependency (node:http) so it runs with no extra install;
// the production build swaps in Fastify behind the same routes. Run dispatch is async (a run takes minutes):
// POST /work-items returns 202 immediately and the client polls the run + its event stream.
//
// Run:  npx tsx --env-file=.env src/http/server.ts   (PORT=8787 by default)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import type { DataStore } from '../db/store';
import { makeStore } from '../db/factory';
import { EnvelopeSecretProvider } from '../secrets/envelope';
import { MockSandboxProvider } from '../sandbox/mock';
import { InMemoryMeter } from '../billing/meter';
import { LocalAidlcEngine } from '../runs/engine.aidlc.local';
import { dispatchRun, type DispatchDeps } from '../runs/dispatch';
import { TenantContext } from '../tenancy/context';
import { onboardTenant, connectInstallation, whitelistRepo, storeSecret, submitWorkItem, costSummary, signup, login } from '../service';
import { RazorpayBilling, InMemoryCreditsLedger, CreditsMeter } from '../billing/razorpay';
import { bearer, verifyToken, type Claims } from '../auth/auth';

let store: DataStore;
let deps: DispatchDeps;
const secrets = new EnvelopeSecretProvider();
const ledger = new InMemoryCreditsLedger();
const rzp = RazorpayBilling.fromEnv(); // null until RAZORPAY_KEY_ID/SECRET are set
// Tenant contexts, keyed by tenantId (a real deploy resolves these from an auth token → tenant).
const ctxs = new Map<string, TenantContext>();
const ctxFor = (tid: string): TenantContext => { const c = ctxs.get(tid) || new TenantContext(store, tid); ctxs.set(tid, c); return c; };

function send(res: http.ServerResponse, code: number, body: unknown) {
    const s = JSON.stringify(body, null, 2);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(s);
}
async function readJson(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
}
const PAGES: Record<string, string> = { home: 'home.html', signin: 'signin.html', app: 'ui.html' };
function serveHtml(res: http.ServerResponse, name: string) {
    const html = fs.readFileSync(path.join(process.cwd(), 'src', 'http', PAGES[name]), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
}

const server = http.createServer(async (req, res) => {
    try {
        const u = new URL(req.url || '/', 'http://localhost');
        const p = u.pathname.replace(/\/+$/, '') || '/';
        const seg = p.split('/').filter(Boolean);           // e.g. ['v1','tenants','<id>','work-items']
        const m = req.method || 'GET';
        if (m === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); return res.end(); }
        if (p === '/healthz') return send(res, 200, { ok: true, service: 'aidlc-platform' });
        // Pages: public homepage, auth page, and the app (the app itself redirects to /signin if unauthenticated).
        if (m === 'GET' && (p === '/' || p === '/index.html')) return serveHtml(res, 'home');
        if (m === 'GET' && p === '/signin') return serveHtml(res, 'signin');
        if (m === 'GET' && p === '/app') return serveHtml(res, 'app');

        // Auth — public
        if (m === 'POST' && p === '/v1/auth/signup') {
            const b = await readJson(req);
            const r = await signup(store, { email: b.email, password: b.password, workspaceName: b.workspaceName, name: b.name });
            ctxs.set(r.tenant.id, ctxFor(r.tenant.id));
            if (b.config) await store.setConfigRow({ tenantId: r.tenant.id, overrides: b.config } as any);
            return send(res, 201, r);
        }
        if (m === 'POST' && p === '/v1/auth/login') {
            const b = await readJson(req);
            return send(res, 200, await login(store, { email: b.email, password: b.password }));
        }
        if (m === 'GET' && p === '/v1/auth/me') {
            const c = bearer(req.headers.authorization);
            if (!c) return send(res, 401, { error: 'not authenticated' });
            const tenant = await store.getTenant(c.tid); const user = await store.getUser(c.tid, c.sub);
            if (!tenant || !user) return send(res, 401, { error: 'session no longer valid' });
            return send(res, 200, { tenant, user });
        }

        // POST /v1/tenants  → onboard (legacy/internal; public path is /v1/auth/signup)
        if (m === 'POST' && p === '/v1/tenants') {
            const b = await readJson(req);
            const { tenant, owner, ctx } = await onboardTenant(store, { slug: b.slug, name: b.name, ownerEmail: b.ownerEmail, modelBilling: b.modelBilling || 'byo_key', plan: b.plan });
            ctxs.set(tenant.id, ctx);
            if (b.config) await store.setConfigRow({ tenantId: tenant.id, overrides: b.config } as any);
            return send(res, 201, { tenant, owner });
        }
        // /v1/tenants/:tid/...  — AUTH-GUARDED: the Bearer token's tenant must match the path tenant.
        if (seg[0] === 'v1' && seg[1] === 'tenants' && seg[2]) {
            const tid = seg[2];
            // EventSource (SSE) can't set an Authorization header, so the stream route also accepts ?token=.
            const claims: Claims | null = bearer(req.headers.authorization) || verifyToken(u.searchParams.get('token') || undefined);
            if (!claims) return send(res, 401, { error: 'not authenticated' });
            if (claims.tid !== tid) return send(res, 403, { error: 'forbidden: token does not grant access to this workspace' });
            const ctx = ctxFor(tid);
            const sub = seg[3];
            if (m === 'POST' && sub === 'config') { await store.setConfigRow({ tenantId: tid, overrides: (await readJson(req)).overrides } as any); return send(res, 200, { ok: true }); }
            if (m === 'POST' && sub === 'installations') { const b = await readJson(req); return send(res, 201, await connectInstallation(ctx, { installationId: b.installationId, accountLogin: b.accountLogin })); }
            if (m === 'POST' && sub === 'repos') { const b = await readJson(req); return send(res, 201, await whitelistRepo(ctx, { installationId: b.installationId, fullName: b.fullName, defaultBranch: b.defaultBranch })); }
            if (m === 'POST' && sub === 'secrets') { const b = await readJson(req); await storeSecret(ctx, secrets, b.name, b.value); return send(res, 201, { ok: true, name: b.name }); }
            if (m === 'GET' && sub === 'cost') return send(res, 200, await costSummary(deps.meter, tid));
            // billing — prepaid credits wallet via Razorpay
            if (m === 'POST' && sub === 'billing' && seg[4] === 'order') {
                if (!rzp) return send(res, 400, { error: 'billing not configured (set RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET)' });
                const b = await readJson(req);
                const order = await rzp.createCreditOrder({ amountPaise: Number(b.amountPaise), receipt: `credits_${tid}`.slice(0, 40), notes: { tenantId: tid, credits: String(b.credits ?? '') } });
                return send(res, 201, { order, keyId: process.env.RAZORPAY_KEY_ID });
            }
            if (m === 'POST' && sub === 'billing' && seg[4] === 'verify') {
                if (!rzp) return send(res, 400, { error: 'billing not configured' });
                const b = await readJson(req);
                if (!rzp.verifyPaymentSignature(b.orderId, b.paymentId, b.signature)) return send(res, 400, { error: 'invalid payment signature' });
                const balance = await ledger.credit(tid, Number(b.credits) || 0, b.paymentId);
                return send(res, 200, { ok: true, balance });
            }
            if (m === 'GET' && sub === 'billing' && seg[4] === 'balance') return send(res, 200, { balance: await ledger.balance(tid) });
            // GET /repos → whitelisted repos (the app uses this to decide onboarding vs. the task list)
            if (m === 'GET' && sub === 'repos') return send(res, 200, { repos: await ctx.listRepos() });
            // GET /config → resolved tenant config overrides
            if (m === 'GET' && sub === 'config') return send(res, 200, { config: (await store.getConfigRow(tid))?.overrides || null });
            // GET /work-items → the tenant's work items, each with its latest run (state, prUrl, cost)
            if (m === 'GET' && sub === 'work-items' && !seg[4]) {
                const { items } = await ctx.listWorkItems({ limit: 50 });
                const runs = await ctx.listRuns();
                const withRun = items.map((wi) => ({
                    ...wi,
                    run: runs.filter((r) => r.workItemId === wi.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] || null,
                }));
                return send(res, 200, { items: withRun });
            }
            // POST /work-items → create + dispatch ASYNC; return 202 + workItemId
            if (m === 'POST' && sub === 'work-items') {
                const b = await readJson(req);
                const repo = await ctx.getRepo(b.repoId);
                if (!repo) return send(res, 400, { error: 'repo not whitelisted' });
                const wi = await ctx.createWorkItem({ repoId: repo.id, title: b.title, rawRequest: b.rawRequest, createdBy: b.userId });
                dispatchRun(deps, ctx, wi.id).catch((e) => console.error(`[run] ${wi.id} failed:`, e?.message || e));
                return send(res, 202, { workItemId: wi.id, status: 'dispatched', poll: `/v1/tenants/${tid}/work-items/${wi.id}/runs` });
            }
            // GET /work-items/:wid/runs → the runs for a work item (state, prUrl, cost)
            if (m === 'GET' && sub === 'work-items' && seg[4] && seg[5] === 'runs') {
                const runs = (await ctx.listRuns()).filter((r) => r.workItemId === seg[4]);
                return send(res, 200, { runs });
            }
            // GET /runs/:rid/events → the run's event trail (set ?stream=1 for SSE)
            if (m === 'GET' && sub === 'runs' && seg[4] && seg[5] === 'events') {
                const rid = seg[4];
                if (u.searchParams.get('stream') === '1') {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
                    let sent = 0;
                    const tick = setInterval(async () => {
                        const evs = await ctx.listEvents(rid);
                        for (; sent < evs.length; sent++) res.write(`data: ${JSON.stringify(evs[sent])}\n\n`);
                        if (evs.some((e) => e.type === 'run.finished' || e.type === 'run.error')) { clearInterval(tick); res.end(); }
                    }, 1000);
                    req.on('close', () => clearInterval(tick));
                    return;
                }
                return send(res, 200, { events: await ctx.listEvents(rid) });
            }
            if (m === 'GET' && sub === 'runs' && seg[4]) { const r = (await ctx.listRuns()).find((x) => x.id === seg[4]); return r ? send(res, 200, r) : send(res, 404, { error: 'run not found' }); }
        }
        return send(res, 404, { error: `no route: ${m} ${p}` });
    } catch (e: any) {
        return send(res, 500, { error: e?.message || String(e) });
    }
});

const PORT = Number(process.env.PORT) || 8787;
(async () => {
    store = await makeStore();
    deps = {
        store, secrets, meter: new CreditsMeter(new InMemoryMeter(), ledger), sandbox: new MockSandboxProvider(),
        github: { mintRepoToken: async () => 'local-mode-no-token' },
        engine: new LocalAidlcEngine(),
    };
    server.listen(PORT, () => console.log(`aidlc-platform HTTP API on http://localhost:${PORT}  (POST /v1/tenants, /healthz)`));
})();
