// Testing-as-a-session (AIDLC-OBSERVABILITY.md §5) — the BrowserStack-grade half of Testing. Runs the
// PRD's journeys across viewports with Playwright (headed-equivalent, with video), capturing per step:
// screenshot, video, console logs, network (incl. failures) → GCS, and emitting browser.* / test.case
// events so the run page's Tests tab renders a watchable session. Playwright + its browser live in the
// worker image (Dockerfile.worker). Lazy-required so the backend build is green before the dep is added;
// absent dep / absent preview URL → the stage still has the tsc gate (ports.git GitTestingPort).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { putArtifact, artifactsEnabled } from './artifacts';

export interface Journey { name: string; path?: string; steps?: Array<{ click?: string; fill?: { selector: string; value: string } }> }
export type ViewportName = 'mobile' | 'tablet' | 'desktop';
const VIEWPORTS: Record<ViewportName, { width: number; height: number }> = {
    mobile: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1440, height: 900 },
};

export interface BrowserSessionOpts {
    workItemId: string;
    previewUrl: string;
    viewports: ViewportName[];
    journeys: Journey[];
    stage?: string;
    stageRunId?: string;
    /** Playwright storageState (cookies/localStorage of a logged-in TEST account) to verify behind-login
     *  flows. Provided by the human — a path or the JSON itself. Absent → auth-walled routes are reported
     *  BLOCKED (not passed), so Testing can honestly ask for a test account instead of faking green. */
    storageState?: string;
}
type Emit = (e: { type: string; level: 'debug' | 'info' | 'warn' | 'error'; actor: string; stage?: string; stageRunId?: string; payload?: any; artifactRefs?: string[] }) => void;

// `blocked` = a journey that could NOT be verified because it needs something we don't have (an auth wall,
// a redirect away from the target). It is NOT a pass and NOT a code failure — Testing must surface it (ask
// for a test account) rather than report green. `details` spells out each blocked journey + why.
export interface BrowserSessionReport { available: boolean; passed: number; failed: number; blocked: number; details: string }

// A route the app bounced us to that means "you must authenticate / are not where you asked to be".
const AUTH_WALL = /\/(login|log-in|signin|sign-in|auth|otp|verify|onboarding|get-started)(\/|\?|#|$)/i;
function isAuthWall(targetPath: string, finalUrl: string): boolean {
    try {
        const finalPath = new URL(finalUrl).pathname + new URL(finalUrl).search;
        // Only a BLOCK if we were bounced to an auth route we did NOT ask for (asking for /login is fine).
        return AUTH_WALL.test(finalPath) && !AUTH_WALL.test(targetPath || '/');
    } catch { return false; }
}

// Run the session. Never throws — a capture problem degrades to a recorded failure, not a crashed stage.
export async function runBrowserSession(opts: BrowserSessionOpts, emit: Emit): Promise<BrowserSessionReport> {
    let pw: any;
    try { /* eslint-disable-next-line @typescript-eslint/no-var-requires */ pw = require('playwright'); }
    catch { emit({ type: 'error', level: 'warn', actor: 'worker', stage: opts.stage, stageRunId: opts.stageRunId, payload: { message: 'playwright not installed — browser session skipped (tsc gate still ran)' } }); return { available: false, passed: 0, failed: 0, blocked: 0, details: 'playwright not installed' }; }
    if (!opts.previewUrl) { emit({ type: 'error', level: 'warn', actor: 'worker', stage: opts.stage, stageRunId: opts.stageRunId, payload: { message: 'no preview URL — browser session skipped' } }); return { available: false, passed: 0, failed: 0, blocked: 0, details: 'no preview URL' }; }

    const base = opts.previewUrl.replace(/\/$/, '');
    const common = { stage: opts.stage, stageRunId: opts.stageRunId, actor: 'worker' as const };
    const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-video-'));
    let passed = 0, failed = 0, blocked = 0; const notes: string[] = [];
    // A logged-in TEST account's storageState (if the human provided one) lets us verify behind-login flows.
    const storageState = resolveStorageState(opts.storageState);

    for (const vp of opts.viewports) {
        const browser = await pw.chromium.launch();
        const context = await browser.newContext({ viewport: VIEWPORTS[vp], recordVideo: { dir: videoDir, size: VIEWPORTS[vp] }, ...(storageState ? { storageState } : {}) });
        for (const j of opts.journeys) {
            const t0 = Date.now();
            const consoleLogs: any[] = []; const network: any[] = [];
            const page = await context.newPage();
            page.on('console', (m: any) => { try { consoleLogs.push({ type: m.type(), text: String(m.text()).slice(0, 300) }); } catch { /* */ } });
            page.on('requestfinished', async (r: any) => { try { const resp = await r.response(); network.push({ url: r.url(), method: r.method(), status: resp?.status() }); } catch { /* */ } });
            const url = base + (j.path || '/');
            let status: 'passed' | 'failed' | 'blocked' = 'failed';
            try {
                const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
                // AUTH WALL: if we were bounced to a login/verify route we did not ask for, this journey
                // could NOT be verified — it is BLOCKED, not passed. Capture evidence + stop (steps that
                // assume we're logged in would just error misleadingly).
                const walled = isAuthWall(j.path || '/', page.url());
                if (!walled) {
                    for (const s of j.steps || []) { if (s.click) await page.click(s.click, { timeout: 8000 }); if (s.fill) await page.fill(s.fill.selector, s.fill.value, { timeout: 8000 }); }
                }
                const shot: Buffer = await page.screenshot({ fullPage: true });
                const art = await putArtifact(opts.workItemId, `${vp}-${sane(j.name)}.png`, shot, 'image/png');
                emit({ ...common, type: 'browser.screenshot', level: 'info', payload: { viewport: vp, journey: j.name, url, finalUrl: page.url(), imageUrl: art?.url }, artifactRefs: art ? [art.ref] : [] });
                const errs = consoleLogs.filter((l) => l.type === 'error');
                emit({ ...common, type: 'browser.console', level: errs.length ? 'warn' : 'debug', payload: { viewport: vp, journey: j.name, errors: errs.length, logs: consoleLogs.slice(0, 40) } });
                const netFails = network.filter((n) => (n.status || 0) >= 400);
                emit({ ...common, type: 'browser.network', level: netFails.length ? 'warn' : 'debug', payload: { viewport: vp, journey: j.name, total: network.length, failures: netFails.length, sample: network.slice(0, 30) } });
                if (walled) {
                    status = 'blocked';
                    notes.push(`${vp}:${j.name} → BLOCKED: "${j.path || '/'}" redirected to an auth wall (${new URL(page.url()).pathname}); needs a logged-in test account to verify.`);
                } else if ((resp?.status() || 0) < 400 && errs.length === 0 && netFails.length === 0) {
                    status = 'passed';
                } else {
                    status = 'failed';
                    notes.push(`${vp}:${j.name} → ${resp?.status() || '?'}${errs.length ? `, ${errs.length} console error(s)` : ''}${netFails.length ? `, ${netFails.length} failed request(s)` : ''}`);
                }
            } catch (e: any) {
                status = 'failed';
                notes.push(`${vp}:${j.name} → ${e?.message || e}`);
            }
            emit({ ...common, type: 'test.case', level: status === 'passed' ? 'info' : 'warn', payload: { name: `${vp}:${j.name}`, status, durationMs: Date.now() - t0, url } });
            if (status === 'passed') passed++; else if (status === 'blocked') blocked++; else failed++;
            // Per-journey video (user chose video for Testing): close the page to finalize it, then upload.
            const video = page.video?.();
            await page.close();
            if (video && artifactsEnabled()) {
                try { const vpath = await video.path(); const vid = await putArtifact(opts.workItemId, `${vp}-${sane(j.name)}.webm`, fs.readFileSync(vpath), 'video/webm'); if (vid) emit({ ...common, type: 'browser.screenshot', level: 'debug', payload: { viewport: vp, journey: j.name, kind: 'video', videoUrl: vid.url }, artifactRefs: [vid.ref] }); } catch { /* video optional */ }
            }
        }
        await context.close();
        await browser.close();
    }

    // Lighthouse (desktop home) — best-effort, lazy. Needs chrome-launcher + lighthouse in the image.
    try {
        if (opts.viewports.includes('desktop')) await runLighthouse(opts, base, emit, common);
    } catch (e: any) { notes.push(`lighthouse: ${e?.message || e}`); }

    try { fs.rmSync(videoDir, { recursive: true, force: true }); } catch { /* */ }
    const summary = `${passed} passed / ${failed} failed / ${blocked} blocked across ${opts.viewports.join(', ')}`;
    return { available: true, passed, failed, blocked, details: notes.length ? `${summary} — ${notes.join(' | ')}` : summary };
}

// Accept a storageState as a file PATH or inline JSON string; return a Playwright-compatible value or
// undefined. Never throws (bad input just means "no auth" → behind-login routes report BLOCKED, not green).
function resolveStorageState(input?: string): any {
    const raw = input || process.env.AIDLC_TEST_STORAGE_STATE;
    if (!raw) return undefined;
    try {
        const s = String(raw).trim();
        if (s.startsWith('{')) return JSON.parse(s);   // inline JSON
        if (fs.existsSync(s)) return s;                // a path Playwright reads directly
        return undefined;
    } catch { return undefined; }
}

async function runLighthouse(opts: BrowserSessionOpts, base: string, emit: Emit, common: any): Promise<void> {
    let lighthouse: any, chromeLauncher: any;
    try { /* eslint-disable-next-line @typescript-eslint/no-var-requires */ lighthouse = require('lighthouse'); chromeLauncher = require('chrome-launcher'); }
    catch { return; /* lighthouse not installed — skip */ }
    const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-sandbox'] });
    try {
        const runnerResult = await (lighthouse.default || lighthouse)(base + (opts.journeys[0]?.path || '/'), { port: chrome.port, output: 'json', logLevel: 'error' });
        const cats = runnerResult?.lhr?.categories || {};
        const scores = { performance: Math.round((cats.performance?.score || 0) * 100), accessibility: Math.round((cats.accessibility?.score || 0) * 100), bestPractices: Math.round((cats['best-practices']?.score || 0) * 100), seo: Math.round((cats.seo?.score || 0) * 100) };
        const report = Buffer.from(runnerResult?.report || '{}');
        const art = await putArtifact(opts.workItemId, 'lighthouse.json', report, 'application/json');
        emit({ ...common, type: 'lighthouse.report', level: 'info', payload: { scores, reportUrl: art?.url }, artifactRefs: art ? [art.ref] : [] });
    } finally { await chrome.kill(); }
}

const sane = (s: string) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
