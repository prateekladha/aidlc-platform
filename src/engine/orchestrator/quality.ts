// QUALITY is the metric — not "did the stage finish" but "is the output excellent". A great PRD cascades
// into a great UX → Dev → tests; a weak one poisons everything downstream. So every stage's output is
// scored by a SEPARATE critic (the constitution's "nothing grades itself") against an explicit, weighted
// rubric. Below the bar → the stage revises with the critic's feedback (bounded). The score + critique are
// recorded on the work item and shown to the human at the gate, so quality is visible, not assumed.
import type { Model, GenerateInput } from '../types';
import type { Stage } from './types';

export interface QualityCriterion { name: string; weight: number; description: string }
export interface StageRubric { bar: number; criteria: QualityCriterion[] }

export interface CriterionScore { name: string; score: number; feedback: string }
export interface QualityReport {
    stage: Stage;
    score: number;              // 0-100, weighted
    bar: number;
    pass: boolean;
    criteria: CriterionScore[];
    strengths: string;
    weaknesses: string;
    improvements: string[];     // concrete, actionable — fed back into a revision
    revision: number;           // which revision this report graded (0 = first attempt)
}

// Default quality bar; per-stage overridable. Money-path stages get a higher bar at call time.
const DEFAULT_BAR = Number(process.env.AIDLC_QUALITY_BAR) || 82;

// The rubrics — this is where "great" is defined for each stage. Weights sum to ~1.0.
export const STAGE_RUBRICS: Record<Stage, StageRubric> = {
    triage: {
        bar: DEFAULT_BAR,
        criteria: [
            { name: 'classification-correctness', weight: 0.5, description: 'kind/surface/complexity are right for the request — not over- or under-scoped (a CSS bug is not a "feature").' },
            { name: 'risk-flagged', weight: 0.3, description: 'Correctly flags money/security/migration risk — especially a code change that also needs a schema/column change (risk:migration).' },
            { name: 'reasoning', weight: 0.2, description: 'The rationale reasons from first principles (states why), not a label slapped on.' },
        ],
    },
    research: {
        bar: DEFAULT_BAR,
        criteria: [
            { name: 'approach-quality', weight: 0.4, description: 'Proposes genuinely distinct, viable approaches — not one option dressed up as three.' },
            { name: 'trade-off-honesty', weight: 0.35, description: 'Pros/cons are real and specific; the recommendation follows from them.' },
            { name: 'assumptions-stated', weight: 0.25, description: 'Assumptions are explicit (first-principles), so a flawed premise is catchable.' },
        ],
    },
    fix: {
        bar: DEFAULT_BAR,
        criteria: [
            { name: 'root-cause', weight: 0.35, description: 'Fixes the ROOT CAUSE, not the symptom; the rootCause explanation is credible.' },
            { name: 'minimal', weight: 0.25, description: 'Minimal, scoped change — no unrelated edits, no gold-plating.' },
            { name: 'regression-test', weight: 0.25, description: 'Adds a regression test that would have caught this bug.' },
            { name: 'safety', weight: 0.15, description: 'No forbidden-path edits; self-verified green.' },
        ],
    },
    prd: {
        bar: DEFAULT_BAR,
        criteria: [
            { name: 'problem-clarity', weight: 0.18, description: 'The problem is crisp, specific, and grounded in a real user/business need — not vague or restated from the request.' },
            { name: 'acceptance-criteria', weight: 0.25, description: 'Acceptance criteria are concrete, testable, measurable, and together fully cover "done". No hand-waving.' },
            { name: 'scope-discipline', weight: 0.15, description: 'Scope is right-sized; out-of-scope is explicit; no gold-plating and nothing essential dropped.' },
            { name: 'lineage-awareness', weight: 0.18, description: 'Builds on the feature\'s prior change history (if any); does not contradict or duplicate earlier decisions; the latest state wins.' },
            { name: 'risk-identification', weight: 0.14, description: 'Correctly identifies risk tier (money/capacity) and what must be safeguarded (characterization test, fail-closed verifier).' },
            { name: 'analytics-defined', weight: 0.1, description: 'A single clear success metric + the minimal tracking events to measure it are specified (to be built in Dev). No vanity events.' },
        ],
    },
    ux: {
        bar: DEFAULT_BAR,
        criteria: [
            { name: 'design-system-conformance', weight: 0.3, description: 'Reuses existing design tokens/components; does not invent off-system UI.' },
            { name: 'state-completeness', weight: 0.25, description: 'Covers all states: empty, loading, error, success, edge cases.' },
            { name: 'accessibility', weight: 0.15, description: 'Contrast, focus order, labels, touch targets considered.' },
            { name: 'consistency', weight: 0.15, description: 'Consistent with the rest of the product\'s patterns and voice.' },
            { name: 'spec-clarity', weight: 0.15, description: 'The spec is unambiguous enough for Dev to build without guessing.' },
        ],
    },
    dev: {
        bar: DEFAULT_BAR,
        criteria: [
            { name: 'correctness', weight: 0.28, description: 'Implements every acceptance criterion correctly; self-verified green.' },
            { name: 'convention-match', weight: 0.2, description: 'Reuses existing patterns/components/utilities; matches surrounding style; no reinvention.' },
            { name: 'minimal-scope', weight: 0.15, description: 'Changes are minimal and focused; no unrelated edits, no gold-plating.' },
            { name: 'test-coverage', weight: 0.17, description: 'Tests cover the change; for money/capacity paths a characterization test of CURRENT behaviour exists first.' },
            { name: 'safety', weight: 0.2, description: 'No forbidden-path violations; money logic behind a flag + verifier; no secrets/log leaks.' },
        ],
    },
    testing: {
        bar: DEFAULT_BAR,
        criteria: [
            { name: 'coverage', weight: 0.35, description: 'Tests exercise every acceptance criterion, not just a happy path.' },
            { name: 'fail-closed-rigor', weight: 0.3, description: 'Genuinely fails on any real regression; verdict is trustworthy, not rubber-stamped.' },
            { name: 'money-verifier', weight: 0.2, description: 'For money tier, the revenueShare==1.0 fail-closed verifier is present and enforced.' },
            { name: 'evidence-quality', weight: 0.15, description: 'Failures are reported with concrete, actionable detail Dev can act on.' },
        ],
    },
    deploy: {
        bar: DEFAULT_BAR,
        criteria: [
            { name: 'evidence-pack', weight: 0.5, description: 'The PR body is a complete evidence pack: problem, acceptance criteria, files, test verdict, risk notes.' },
            { name: 'reviewability', weight: 0.5, description: 'The change is scoped and described so a human can review it confidently.' },
        ],
    },
    analytics: {
        bar: DEFAULT_BAR,
        criteria: [
            { name: 'metric-measurability', weight: 0.5, description: 'The success metric is specific and actually measurable from the proposed events.' },
            { name: 'event-completeness', weight: 0.5, description: 'Events capture the full funnel needed to judge the feature.' },
        ],
    },
    gtm: {
        bar: DEFAULT_BAR,
        criteria: [
            { name: 'on-brand', weight: 0.5, description: 'Copy is on-brand (RÉVE voice), accurate, and not hypey.' },
            { name: 'channel-fit', weight: 0.5, description: 'Channels + plan fit how this audience is actually reached.' },
        ],
    },
    infra_plan: {
        bar: DEFAULT_BAR,
        criteria: [
            { name: 'blast-radius', weight: 0.3, description: 'Correctly identifies everything the change affects (data/users/money/services) — nothing missed.' },
            { name: 'rollback-plan', weight: 0.3, description: 'A concrete, credible rollback exists; a data change is proven reversible.' },
            { name: 'scope-correctness', weight: 0.25, description: 'The planned change is right-sized and the acceptance criteria are testable.' },
            { name: 'cost-awareness', weight: 0.15, description: 'Cost impact is assessed, not ignored.' },
        ],
    },
    infra_change: {
        bar: DEFAULT_BAR,
        criteria: [
            { name: 'forward+rollback', weight: 0.35, description: 'BOTH a forward script AND a matching rollback are written; the rollback truly reverts.' },
            { name: 'convention-match', weight: 0.25, description: 'Follows the repo\'s existing migration/infra patterns (env-prefixed collections, scripts/ layout).' },
            { name: 'backfill-correct', weight: 0.2, description: 'A data change backfills existing rows correctly, no data loss.' },
            { name: 'safety', weight: 0.2, description: 'No prod mutation here; no secrets committed; self-verified.' },
        ],
    },
    infra_verify: {
        bar: DEFAULT_BAR,
        criteria: [
            { name: 'security', weight: 0.4, description: 'CVEs + secret leaks actually checked; any finding is a red.' },
            { name: 'dry-run-rigor', weight: 0.35, description: 'The migration dry-run genuinely ran and is reversible; a rollback script is confirmed present.' },
            { name: 'fail-closed', weight: 0.25, description: 'Verdict is trustworthy — red on any doubt, not rubber-stamped.' },
        ],
    },
    infra_apply: {
        bar: DEFAULT_BAR,
        criteria: [
            { name: 'evidence-pack', weight: 0.6, description: 'The PR body is a complete evidence pack: plan, blast radius, rollback, dry-run + security results.' },
            { name: 'reviewability', weight: 0.4, description: 'A human can confidently approve the apply from the PR.' },
        ],
    },
};

// Fail-closed MIGRATION verifier (data-migration risk) — a SEPARATE call. Given the diff, confirms a
// reversible migration with a rollback + a dry-run, no data loss. Fails CLOSED on any doubt.
export async function verifyMigration(model: Model, diff: string): Promise<{ pass: boolean; findings: string[] }> {
    if (!diff || !diff.trim()) return { pass: false, findings: ['No diff to verify — cannot confirm the migration safeguards.'] };
    const system = [
        'You are a FAIL-CLOSED migration verifier. You are a DIFFERENT reviewer from whoever wrote the change.',
        'Judge ONLY from the diff. Confirm ALL of:',
        '1) BACKWARD-COMPATIBLE: a purely additive, nullable column/field is safe with NO backfill. A change that',
        '   ALTERS, populates, renames, re-types, or drops EXISTING data MUST backfill and follow expand→migrate→',
        '   contract (never a destructive change in one step).',
        '2) A matching ROLLBACK (down) that reverts the forward change.',
        '3) REVERSIBLE with NO data loss (a drop/rename/truncate without a safe, reversible path → fail).',
        '4) Follows the repo env-prefixed collection conventions (dev/prod isolated).',
        'Fail CLOSED: if the change touches existing data and backward-compatibility/backfill is missing or',
        'ambiguous, or a rollback is absent, or you are not sure from the diff → pass=false. A safe additive',
        'nullable column WITH a rollback should PASS.',
        'Reply with ONLY JSON: {"pass":boolean,"findings":[string]}',
    ].join('\n');
    const p = await robustJson<{ pass: boolean; findings: string[] }>(model, system, `Diff to verify:\n${diff.slice(0, 40000)}`, 'high');
    if (!p || typeof p.pass !== 'boolean') return { pass: false, findings: ['Verifier produced no parseable verdict after retry — failing closed.'] };
    return { pass: !!p.pass, findings: Array.isArray(p.findings) ? p.findings.map(String) : [] };
}

function parseJsonLoose<T = any>(text: string): T | null {
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : text;
    const s = body.indexOf('{'), e = body.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    try { return JSON.parse(body.slice(s, e + 1)) as T; } catch { return null; }
}

// Robust one-shot JSON from a critic/verifier. Tries at the requested thinking level, then RETRIES at 'low'
// (which preserves the output budget — a thinking model at higher effort can spend the whole budget on
// thoughts and return EMPTY text, which used to make these calls false-fail = fail-closed/score-0). The
// retry adds a strict "ONLY JSON" instruction. Returns parsed JSON or null only if BOTH attempts slip.
async function robustJson<T = any>(model: Model, system: string, user: string, thinking: 'low' | 'medium' | 'high'): Promise<T | null> {
    for (const [lvl, strict] of [[thinking, false], ['low', true]] as Array<['low' | 'medium' | 'high', boolean]>) {
        const sys = strict ? `${system}\nOutput ONLY the JSON object — start with { and end with }. No prose, no thinking aloud.` : system;
        const turn = await model.generate({ system: sys, messages: [{ role: 'user', text: user, ts: new Date().toISOString() }], tools: [], thinking: lvl }).catch(() => null);
        const p = turn ? parseJsonLoose<T>(turn.text || '') : null;
        if (p) return p;
    }
    return null;
}

function weightedScore(rubric: StageRubric, scores: CriterionScore[]): number {
    const byName = new Map(scores.map((s) => [s.name, s.score]));
    let total = 0, wsum = 0;
    for (const c of rubric.criteria) {
        const s = Number(byName.get(c.name));
        if (!Number.isNaN(s)) { total += s * c.weight; wsum += c.weight; }
    }
    return wsum ? Math.round(total / wsum) : 0;
}

export interface CritiqueInput {
    stage: Stage;
    artifact: any;              // the stage's structured output
    contextSummary: string;     // the PRD/design/lineage the stage worked from (for grounded judgement)
    moneyTier?: boolean;        // raises the bar + weights safety/verifier harder
    revision?: number;
}

// Score a stage's output against its rubric using a SEPARATE model call (no tools — pure judgement). The
// critic never produced the work, satisfying "nothing grades itself". Returns a structured QualityReport.
export async function critique(model: Model, input: CritiqueInput): Promise<QualityReport> {
    const rubric = STAGE_RUBRICS[input.stage];
    const bar = input.moneyTier ? Math.max(rubric.bar, 90) : rubric.bar;
    const rubricText = rubric.criteria.map((c) => `- ${c.name} (weight ${c.weight}): ${c.description}`).join('\n');
    const system = [
        `You are a SENIOR quality reviewer for the ${input.stage.toUpperCase()} stage of a software delivery pipeline.`,
        'You did NOT produce this output — your job is to judge it honestly and specifically against the rubric.',
        'Be demanding: a high score means genuinely excellent, production-grade work, not "acceptable". Penalise',
        'vagueness, gold-plating, missing edge cases, convention violations, and anything created just to tick a box.',
        input.moneyTier ? 'This is a MONEY-PATH change — hold safety, test-coverage, and the fail-closed verifier to the highest standard.' : '',
        'Rubric (score each 0-100):',
        rubricText,
        'Reply with ONLY this JSON:',
        '{"criteria":[{"name":string,"score":number,"feedback":string}],"strengths":string,"weaknesses":string,"improvements":[string]}',
        'Give every rubric criterion a score + specific, actionable feedback. "improvements" are the concrete',
        'changes that would raise the score — written so the stage can act on them directly.',
    ].filter(Boolean).join('\n');

    const ctxBlock = `Context the ${input.stage} stage worked from:\n${input.contextSummary}`;
    const userMsg = `Output to review (${input.stage} stage):\n${JSON.stringify(input.artifact, null, 2)}`;
    // Try at 'medium', then RETRY at 'low' if the thinking model returned empty/unparseable (which otherwise
    // yields a false score:0). Low thinking preserves the output budget for the structured grade.
    let parsed: any = null;
    for (const [lvl, strict] of [['medium', false], ['low', true]] as Array<['low' | 'medium' | 'high', boolean]>) {
        const sys = strict ? `${system}\nOutput ONLY the JSON object — no prose, no thinking aloud.` : system;
        const gen: GenerateInput = { system: sys, context: ctxBlock, messages: [{ role: 'user', text: userMsg, ts: new Date().toISOString() }], tools: [], thinking: lvl };
        const turn = await model.generate(gen).catch(() => null);
        parsed = turn ? parseJsonLoose(turn.text || '') : null;
        if (parsed && Array.isArray(parsed.criteria)) break;
    }

    if (!parsed || !Array.isArray(parsed.criteria)) {
        // Critic failed to produce a grade — fail OPEN to a low score so a human looks (never silently pass).
        return { stage: input.stage, score: 0, bar, pass: false, criteria: [], strengths: '', weaknesses: 'Quality critic produced no parseable grade.', improvements: ['Re-run the stage; the critic could not assess the output.'], revision: input.revision || 0 };
    }
    const criteria: CriterionScore[] = parsed.criteria.map((c: any) => ({ name: String(c.name), score: Math.max(0, Math.min(100, Number(c.score) || 0)), feedback: String(c.feedback || '') }));
    const score = weightedScore(rubric, criteria);
    return {
        stage: input.stage,
        score,
        bar,
        pass: score >= bar,
        criteria,
        strengths: String(parsed.strengths || ''),
        weaknesses: String(parsed.weaknesses || ''),
        improvements: Array.isArray(parsed.improvements) ? parsed.improvements.map(String) : [],
        revision: input.revision || 0,
    };
}

// Max quality-revision attempts per stage before we proceed with the best-so-far (and surface the score).
export const MAX_QUALITY_REVISIONS = Number(process.env.AIDLC_MAX_QUALITY_REVISIONS) || 2;

// Fail-closed money-path verifier (constitution §8). A SEPARATE call from the work — given the Dev diff,
// it checks the three non-negotiables for a money/capacity change and FAILS CLOSED (pass=false) on any
// doubt. A red result routes the item back to Dev. This is the hard gate behind "money through the gates".
export async function verifyMoneyPath(model: Model, diff: string): Promise<{ pass: boolean; findings: string[] }> {
    if (!diff || !diff.trim()) return { pass: false, findings: ['No diff to verify — cannot confirm the money-path safeguards.'] };
    const system = [
        'You are a FAIL-CLOSED money-path verifier for a payments/split change. You are a DIFFERENT reviewer',
        'from whoever wrote the code. Judge ONLY from the diff. Confirm ALL THREE non-negotiables:',
        '1) A CHARACTERIZATION TEST that pins the CURRENT split behaviour exists (so the change is proven',
        '   behaviour-preserving) — not just new tests for the new behaviour.',
        '2) A FAIL-CLOSED VERIFIER that asserts revenueShare across participants sums to EXACTLY 1.0 (payouts',
        '   must not silently drift) is present and actually enforced.',
        '3) The new split behaviour is behind a FLAG (the old path stays alive until evals pass).',
        'Fail CLOSED: if any item is missing, ambiguous, or you are not sure from the diff → pass=false.',
        'Reply with ONLY JSON: {"pass":boolean,"findings":[string]}  (findings = what is missing or why it passed).',
    ].join('\n');
    const p = await robustJson<{ pass: boolean; findings: string[] }>(model, system, `Diff to verify:\n${diff.slice(0, 40000)}`, 'high');
    if (!p || typeof p.pass !== 'boolean') return { pass: false, findings: ['Verifier produced no parseable verdict after retry — failing closed.'] };
    return { pass: !!p.pass, findings: Array.isArray(p.findings) ? p.findings.map(String) : [] };
}
