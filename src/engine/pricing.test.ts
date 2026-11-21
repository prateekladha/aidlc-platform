// Characterisation test for LLM cost maths (pricing.ts). Pins the billing formula so a rate-table
// change can't silently alter what the ops cost console reports:
//   cost = (prompt-cached)*input + cached*cachedInput + (output+thinking)*output, all ÷ 1e6
// Cached tokens bill cheaper; thinking tokens bill at the OUTPUT rate; cached is clamped to prompt.
//
//   npx ts-node src/agent/pricing.test.ts
import assert from 'assert';

// Pin explicit rates BEFORE importing pricing (DEFAULT_RATES reads env at module load).
process.env.AGENT_PRICE_INPUT_PER_M = '1';       // $1 / 1M input
process.env.AGENT_PRICE_CACHED_INPUT_PER_M = '0.25'; // $0.25 / 1M cached input
process.env.AGENT_PRICE_OUTPUT_PER_M = '2';      // $2 / 1M output (and thinking)
process.env.AGENT_USD_INR = '83';

async function main() {
    const { costUsd, usdToInr, ratesSnapshot } = await import('./pricing');
    const approx = (a: number, b: number, msg: string) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

    // No cache, no thinking: 1000 input + 500 output → (1000*1 + 500*2)/1e6 = 0.002
    approx(costUsd({ promptTokens: 1000, outputTokens: 500 }), 0.002, 'basic');

    // Cache hit + thinking: prompt 1000 (800 cached) + 200 output + 100 thinking
    // → (200*1 + 800*0.25 + (200+100)*2)/1e6 = (200 + 200 + 600)/1e6 = 0.001
    approx(costUsd({ promptTokens: 1000, cachedTokens: 800, outputTokens: 200, thinkingTokens: 100 }), 0.001, 'cache+thinking');

    // Cached clamped to prompt (never negative fresh input): cached 2000 > prompt 1000
    // → fresh 0 → (0 + 1000*0.25 + 100*2)/1e6 = (250 + 200)/1e6 = 0.00045
    approx(costUsd({ promptTokens: 1000, cachedTokens: 2000, outputTokens: 100 }), 0.00045, 'cached-clamp');

    // Empty = free; negative guarded to 0.
    approx(costUsd({}), 0, 'empty');
    approx(costUsd({ promptTokens: -50, outputTokens: -10 }), 0, 'negative-guard');

    // Thinking is billed at the OUTPUT rate, not input.
    approx(costUsd({ thinkingTokens: 1000 }), 0.002, 'thinking-is-output-rate');

    // FX conversion.
    approx(usdToInr(0.002) ?? -1, 0.166, 'usd->inr');
    assert.strictEqual(ratesSnapshot().usdInr, 83, 'rates snapshot carries fx');

    console.log('pricing.test: all assertions passed ✓');
}

main().catch((e) => { console.error(e); process.exit(1); });
