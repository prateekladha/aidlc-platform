// Replay eval. Re-decides every logged call under the CURRENT agent config and
// reports which verdicts would change today — the regression harness for policy.
// It is config-only (grants, tiers, arg schemas, conditions), so it is fully
// deterministic and runs NO tools and touches NO world state. An `approved`
// EXECUTE in the log represents a PROPOSE policy verdict (a human promoted it).
import type { AgentConfig, Decision, DecisionKind } from '../types';
import { configVerdict } from '../broker';

export interface ReplayDiff {
    tool: string;
    resourceId: string | null;
    before: DecisionKind;
    after: DecisionKind;
    reason: string;
}

export interface ReplayReport {
    total: number;
    same: number;
    changed: ReplayDiff[];
    newlyDenied: ReplayDiff[];
}

function loggedPolicyVerdict(d: Decision): DecisionKind {
    return d.approved ? 'PROPOSE' : d.decision;
}

export function runReplay(baseline: Decision[], agent: AgentConfig): ReplayReport {
    const changed: ReplayDiff[] = [];
    // De-dup the approve/propose pair for the same call so one logical decision
    // isn't double-counted (a PROPOSE then its approved EXECUTE share tool+args+ts-ish).
    const seen = new Set<string>();
    let total = 0;

    for (const d of baseline) {
        const before = loggedPolicyVerdict(d);
        // Replay regresses CONFIG over ALLOWED actions. A logged DENY may be an
        // authorize/world-state denial (ownership, payout gate) that config-only
        // replay can't reproduce — excluding DENYs avoids those false positives.
        if (before === 'DENY') continue;

        const key = `${d.runId}:${d.tool}:${JSON.stringify(d.args)}:${before}`;
        if (seen.has(key)) continue;
        seen.add(key);
        total += 1;
        const v = configVerdict({ allowedTools: agent.tools, grants: agent.grants, tool: d.tool, args: d.args ?? {} });
        const after = v.decision;
        if (after !== before) {
            changed.push({ tool: d.tool, resourceId: d.resourceId, before, after, reason: v.reason });
        }
    }

    return {
        total,
        same: total - changed.length,
        changed,
        newlyDenied: changed.filter((c) => c.after === 'DENY' && c.before !== 'DENY'),
    };
}
