// A deterministic model for tests + golden-trajectory evals. It returns a fixed
// sequence of turns, one per generate() call, regardless of input. This is how
// we exercise the WHOLE loop (broker, tools, decision log, pause/resume) with no
// LLM, no key, no spend and no flakiness — the same discipline the boilerplate
// used to test its substrate without a model.
import type { Model, ModelTurn, ToolCall } from '../types';

let seq = 0;
function callId(): string {
    seq += 1;
    return `call_${seq}`;
}

/** Convenience: a turn that asks for one tool. */
export function toolTurn(name: string, args: Record<string, unknown>): ModelTurn {
    const call: ToolCall = { id: callId(), name, args };
    return { toolCalls: [call] };
}

/** Convenience: a turn that replies with words (ends the loop). */
export function textTurn(text: string): ModelTurn {
    return { text };
}

export class ScriptedModel implements Model {
    readonly id = 'scripted';
    private i = 0;
    constructor(private readonly turns: ModelTurn[]) {}

    async generate(): Promise<ModelTurn> {
        if (this.i >= this.turns.length) {
            throw new Error(`ScriptedModel exhausted after ${this.turns.length} turn(s) — the loop asked for one more`);
        }
        return this.turns[this.i++];
    }

    remaining(): number {
        return this.turns.length - this.i;
    }
}
