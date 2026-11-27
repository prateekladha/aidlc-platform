// The tool registry. The ONLY module that imports concrete tools, and invokeTool is the ONLY path to running
// one. Enforcement: a secret token is minted here and handed out exactly once via armBroker(). The broker
// takes it at load; anything else that tries to arm throws. So even if a module imported this file, it could
// not obtain the token and could not run a tool — the loop reaches effects only through the broker.
//
// STANDALONE PLATFORM: this registry now exposes ONLY the AIDLC dev-agent tools. The Reve Host Copilot tools
// (events/payouts/insights/guests/invites/broadcast/knowledge/memory) were product-specific and are not part
// of the product; they have been removed with the rest of that coupling.
import type { Tool, ToolContext, ToolResult, ToolDeclaration } from '../types';
import { AIDLC_TOOLS } from './aidlc/contracts';

const TOOLS: Record<string, Tool> = {};

// AIDLC stage tools are the only tools in the standalone platform; they share this registry + broker.
for (const t of AIDLC_TOOLS) TOOLS[t.name] = t;

const TOKEN: symbol = Symbol('agent-broker-token');
let armed = false;

const invocations = { live: 0, dryRun: 0 };
export function invocationStats(): { live: number; dryRun: number } {
    return { ...invocations };
}
export function resetInvocationStats(): void {
    invocations.live = 0;
    invocations.dryRun = 0;
}

/** Called once, by the broker, to obtain the capability to invoke tools. */
export function armBroker(): symbol {
    if (armed) throw new Error('Broker already armed — the tool-invocation token is single-use.');
    armed = true;
    return TOKEN;
}

export function describeTool(name: string): Tool | undefined {
    return TOOLS[name];
}

export function listTools(): string[] {
    return Object.keys(TOOLS);
}

/** The model's function declarations — only the tools this agent is allowed. */
export function toolDeclarations(names: string[]): ToolDeclaration[] {
    return names
        .map((n) => TOOLS[n])
        .filter((t): t is Tool => !!t)
        .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

export async function invokeTool(token: symbol, name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (token !== TOKEN) {
        throw new Error(`Refused: tool "${name}" invoked without the broker token. Tools run only through the broker.`);
    }
    const tool = TOOLS[name];
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    if (ctx.mode === 'live') invocations.live += 1;
    else invocations.dryRun += 1;
    // A tool that throws must become a RECOVERABLE error the agent sees ("errors are instructions, not stack
    // traces"), never an exception that kills the whole stage. Return ok:false with the message as output.
    try {
        return await tool.run(args, ctx);
    } catch (e: any) {
        return { ok: false, output: { error: e?.message || String(e) } };
    }
}
