// Instruction adherence (constitution §10 "migrate behaviour, do not drop it" — applied to the agent itself).
// The failure mode this closes: a stage produces a plausible, high-scoring output that quietly ignores one of
// the human's instructions. A holistic quality score cannot catch that; a per-requirement coverage check can.
//
//   extractRequirements  — decompose the request + PRD + EVERY human message into an enumerated checklist.
//   mergeRequirements    — fold a fresh extraction into the ledger, preserving ids + human-approved deferrals.
//   verifyCoverage       — a SEPARATE fail-closed call mapping each requirement → met/partial/missing/deferred.
//
// A stage may NOT pass while a must-have requirement is missing/partial unless a human has explicitly deferred
// it. The agent can never defer on its own — that is the exact thing we are guarding against.
import type { Model } from '../types';
import type { WorkItem, Requirement, RequirementSource, CoverageItem, CoverageReport, CoverageStatus, Stage } from './types';

function parseJsonLoose<T = any>(text: string): T | null {
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : text;
    const s = body.indexOf('{'), a = body.indexOf('['), st = (a >= 0 && (a < s || s < 0)) ? a : s;
    const e = body.lastIndexOf('}'), b = body.lastIndexOf(']'), en = Math.max(e, b);
    if (st < 0 || en <= st) return null;
    try { return JSON.parse(body.slice(st, en + 1)) as T; } catch { return null; }
}

function norm(s: string): string {
    return String(s).toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

// Build the raw text blobs the extractor reasons over — each tagged with its source so new human messages
// become visibly new requirements.
function sources(wi: WorkItem): Array<{ source: RequirementSource; text: string }> {
    const out: Array<{ source: RequirementSource; text: string }> = [];
    if (wi.origin?.rawRequest) out.push({ source: 'request', text: wi.origin.rawRequest });
    if (wi.prd) {
        const parts = [wi.prd.problem, ...(wi.prd.acceptanceCriteria || [])].filter(Boolean);
        if (parts.length) out.push({ source: 'prd', text: parts.join('\n') });
    }
    for (const c of (wi.conversation || [])) if (c.role === 'user' && c.text) out.push({ source: 'conversation', text: c.text });
    for (const r of (wi.questions || [])) {
        const answered = (r.answers || []).map((a, i) => a ? `${r.questions[i]} → ${a}` : '').filter(Boolean);
        if (answered.length) out.push({ source: 'clarification', text: answered.join('\n') });
    }
    return out;
}

// Decompose the human's intent into ATOMIC, independently-checkable requirements. Low thinking — this is
// extraction, not judgement. IDs are assigned by the caller (mergeRequirements) so they stay stable.
export async function extractRequirements(model: Model, wi: WorkItem, now: string): Promise<Omit<Requirement, 'id'>[]> {
    const blob = sources(wi).map((s) => `[${s.source}]\n${s.text}`).join('\n\n');
    if (!blob.trim()) return [];
    const system = [
        'You convert a software request into an ENUMERATED checklist of ATOMIC requirements — each a single,',
        'independently-verifiable instruction in the human\'s intent. Split compound asks ("do X and Y") into',
        'separate items. Capture EVERY explicit instruction, including ones in later [conversation] messages',
        '(those often CORRECT or ADD to earlier ones — keep both unless clearly superseded, and prefer the later).',
        'Mark mustHave=false ONLY for genuinely optional/nice-to-have asks; default mustHave=true.',
        'Do NOT invent requirements the human did not state. Do NOT merge distinct asks. Be exhaustive but precise.',
        'Reply with ONLY JSON: {"requirements":[{"text":string,"source":"request"|"prd"|"conversation"|"clarification","mustHave":boolean}]}',
    ].join(' ');
    try {
        const turn = await model.generate({ system, messages: [{ role: 'user', text: `Request + context:\n${blob.slice(0, 24000)}`, ts: now }], tools: [], thinking: 'low' });
        const p = parseJsonLoose<{ requirements: any[] }>(turn.text || '');
        const list = Array.isArray(p?.requirements) ? p!.requirements : [];
        return list
            .filter((r) => r && typeof r.text === 'string' && r.text.trim())
            .map((r) => ({
                text: String(r.text).trim(),
                source: (['request', 'prd', 'conversation', 'clarification'].includes(r.source) ? r.source : 'request') as RequirementSource,
                mustHave: r.mustHave !== false,
                at: now,
            }));
    } catch {
        return [];
    }
}

// Fold a fresh extraction into the existing ledger: keep ids + deferrals for requirements whose text matches
// an existing one (so a human-approved deferral is never lost), assign new ids to genuinely new ones.
export function mergeRequirements(existing: Requirement[] | undefined, fresh: Omit<Requirement, 'id'>[]): Requirement[] {
    const prior = existing || [];
    const byText = new Map(prior.map((r) => [norm(r.text), r]));
    let maxN = prior.reduce((m, r) => Math.max(m, Number((r.id || '').replace(/\D/g, '')) || 0), 0);
    const merged: Requirement[] = [];
    const seen = new Set<string>();
    for (const f of fresh) {
        const key = norm(f.text);
        if (seen.has(key)) continue;
        seen.add(key);
        const hit = byText.get(key);
        if (hit) merged.push({ ...hit, mustHave: f.mustHave, source: hit.source }); // keep id/at/deferral
        else merged.push({ ...f, id: `R${++maxN}` });
    }
    // Preserve any prior requirement the fresh pass dropped (don't silently lose an instruction) unless it was
    // explicitly superseded — we keep it; coverage will still check it.
    for (const p of prior) if (!seen.has(norm(p.text))) merged.push(p);
    return merged;
}

// Fail-closed coverage: map each requirement to met/partial/missing/deferred given the stage's output (+ diff
// for build stages). A separate call — nothing grades its own work. Unparseable → everything missing (closed).
export async function verifyCoverage(
    model: Model,
    requirements: Requirement[],
    opts: { stage: Stage; artifact: unknown; context: string; diff?: string },
): Promise<CoverageItem[]> {
    const active = requirements.filter((r) => !r.deferral); // deferred ones are not re-judged here
    if (!active.length) return [];
    const list = active.map((r) => `${r.id} [${r.mustHave ? 'must' : 'nice'}]: ${r.text}`).join('\n');
    const system = [
        `You are a FAIL-CLOSED instruction-adherence verifier for the ${opts.stage.toUpperCase()} stage.`,
        'You did NOT produce this output. For EACH listed requirement, decide strictly from the evidence whether',
        'the stage output (and diff, if given) ACTUALLY addresses it: "met" (fully, with evidence), "partial"',
        '(started/implied but incomplete), or "missing" (not addressed). Do NOT give credit for intentions,',
        'TODOs, or vague mentions. If you cannot find concrete evidence, it is "missing". Quote the evidence',
        '(a file, an acceptance criterion, a diff hunk) or say what is absent.',
        'Reply with ONLY JSON: {"items":[{"reqId":string,"status":"met"|"partial"|"missing","evidence":string}]}',
    ].join(' ');
    const user = [
        `Requirements:\n${list}`,
        `\nContext the stage worked from:\n${opts.context}`,
        `\nStage output:\n${JSON.stringify(opts.artifact, null, 2).slice(0, 16000)}`,
        opts.diff ? `\nDiff:\n${opts.diff.slice(0, 40000)}` : '',
    ].join('\n');
    // LOW thinking (not medium): this is structured classification, and a thinking model at higher effort
    // spends its output budget on thoughts and returns an EMPTY/unparseable verdict → everything wrongly
    // "missing" (fail-closed). Low thinking preserves the JSON output; we also retry once if it still slips.
    const genItems = async (strict: boolean): Promise<any[] | null> => {
        const sys = strict ? `${system} Output ONLY the JSON object — start with { and end with }, no prose, no thinking aloud.` : system;
        const turn = await model.generate({ system: sys, messages: [{ role: 'user', text: user, ts: new Date().toISOString() }], tools: [], thinking: 'low' });
        const p = parseJsonLoose<{ items: any[] }>(turn.text || '');
        return Array.isArray(p?.items) ? p!.items : null;
    };
    try {
        let items = await genItems(false);
        if (!items) items = await genItems(true); // retry once — a one-shot critic sometimes returns empty/prose
        if (!items) return active.map((r) => ({ reqId: r.id, status: 'missing' as CoverageStatus, evidence: 'Coverage verifier produced no parseable verdict after a retry — failing closed.' }));
        const byId = new Map(items.map((i) => [String(i.reqId), i]));
        return active.map((r) => {
            const hit = byId.get(r.id);
            const status: CoverageStatus = hit && ['met', 'partial', 'missing'].includes(hit.status) ? hit.status : 'missing';
            return { reqId: r.id, status, evidence: String(hit?.evidence || 'not assessed — failing closed') };
        });
    } catch (e: any) {
        return active.map((r) => ({ reqId: r.id, status: 'missing' as CoverageStatus, evidence: `Coverage verifier call failed (${e?.message || e}) — failing closed.` }));
    }
}

// Roll coverage items + the ledger (deferrals) into a report. A must-have that is missing/partial and NOT an
// approved deferral is "unmet" and blocks the stage.
export function buildCoverageReport(stage: Stage, requirements: Requirement[], items: CoverageItem[], revision: number): CoverageReport {
    const byId = new Map(items.map((i) => [i.reqId, i]));
    const full: CoverageItem[] = requirements.map((r) => {
        if (r.deferral) return { reqId: r.id, status: 'deferred' as CoverageStatus, evidence: `Deferred by ${r.deferral.approvedBy}: ${r.deferral.reason}` };
        return byId.get(r.id) || { reqId: r.id, status: 'missing' as CoverageStatus, evidence: 'not assessed' };
    });
    const unmet = requirements
        .filter((r) => r.mustHave && !r.deferral)
        .filter((r) => { const s = byId.get(r.id)?.status; return s === 'missing' || s === 'partial' || !s; })
        .map((r) => r.id);
    return { stage, pass: unmet.length === 0, items: full, unmet, at: new Date().toISOString(), revision };
}
