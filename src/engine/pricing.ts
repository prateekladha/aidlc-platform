// Single source of truth for LLM call cost. Tokens are the ground truth (persisted, immutable);
// cost is DERIVED here from a per-model rate table so changing a rate re-prices history consistently.
//
// Rates are USD per 1,000,000 tokens and are ENV-OVERRIDABLE — set the exact Gemini 3.8 Flash numbers
// for your account/region rather than trusting the placeholder defaults below. On Gemini:
//   • cached input tokens bill at a lower rate than fresh input tokens,
//   • "thinking" (thoughts) tokens bill at the OUTPUT rate.
// So: cost = (prompt-cached)*input + cached*cachedInput + (output+thinking)*output, all ÷ 1e6.

export interface TokenSplit {
    promptTokens?: number;   // total input tokens (INCLUDES the cached portion, per Gemini usageMetadata)
    cachedTokens?: number;   // the portion of prompt tokens served from cache (billed cheaper)
    outputTokens?: number;   // visible output (candidates)
    thinkingTokens?: number; // thoughts tokens (billed at the output rate)
}

export interface ModelRates {
    inputPerM: number;
    cachedInputPerM: number;
    outputPerM: number; // also applied to thinking tokens
}

function num(env: string | undefined, fallback: number): number {
    const n = Number(env);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Defaults are the REAL published Gemini 3.8 Flash rates (USD / 1M tokens), valid through 2026-12-31:
//   input $0.75 · cached input $0.075 · output $3.75 (output rate also applies to thinking tokens).
// NOTE: these DOUBLE on 2027-01-01 (input $1.50 · cached $0.15 · output $7.50) — override via the
// AGENT_PRICE_*_PER_M env vars then (or if your account/region differs). No env config needed today.
const DEFAULT_RATES: ModelRates = {
    inputPerM: num(process.env.AGENT_PRICE_INPUT_PER_M, 0.75),
    cachedInputPerM: num(process.env.AGENT_PRICE_CACHED_INPUT_PER_M, 0.075),
    outputPerM: num(process.env.AGENT_PRICE_OUTPUT_PER_M, 3.75),
};

// Per-model overrides could be added here if we ever run more than one model.
export function ratesFor(_model?: string): ModelRates {
    return DEFAULT_RATES;
}

// USD → INR for display convenience (set AGENT_USD_INR to your rate; 0/absent hides INR).
export function usdToInr(usd: number): number | null {
    const fx = Number(process.env.AGENT_USD_INR);
    return Number.isFinite(fx) && fx > 0 ? usd * fx : null;
}

export function costUsd(split: TokenSplit, model?: string): number {
    const r = ratesFor(model);
    const prompt = Math.max(0, split.promptTokens || 0);
    const cached = Math.min(Math.max(0, split.cachedTokens || 0), prompt);
    const freshInput = prompt - cached;
    const output = Math.max(0, split.outputTokens || 0);
    const thinking = Math.max(0, split.thinkingTokens || 0);
    return (
        (freshInput * r.inputPerM + cached * r.cachedInputPerM + (output + thinking) * r.outputPerM) / 1_000_000
    );
}

// Expose the rates in the ops payload so the console can show what it priced with.
export function ratesSnapshot(model?: string): ModelRates & { usdInr: number | null } {
    const r = ratesFor(model);
    return { ...r, usdInr: usdToInr(1) };
}
