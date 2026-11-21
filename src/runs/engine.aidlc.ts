// The AIDLC engine adapter — plugs the vendored Supervisor into the platform's `Engine` seam (dispatch.ts).
// This is the port that makes "the agent" run inside the multi-tenant platform: it resolves the tenant's
// model (provider + id from config, key from JIT secrets) and the target repo (from the work item), builds
// the Supervisor on in-memory run stores + the GIT ports (clone → edit → test → open PR, directly — no
// microVM; per-run isolation is a later swap behind the Sandbox seam), drives it submit()→advance(), maps the
// engine's event stream onto the platform's emit(), and returns the run outcome + REAL token cost.
//
// Keyless note: the real engine needs a real LLM, so a run without a model key throws a clear error. Wiring
// (this file compiling + dispatch flowing through it) is verified by tsc + the dispatch test's mock engine.

import type { Engine, EngineRunInput, EngineRunOutput } from './dispatch';
import type { RunState } from '../types';
import type { Model } from '../engine/types';
import { Supervisor, type AidlcEvent } from '../engine/orchestrator/orchestrator';
import { LocalDispatcher } from '../engine/orchestrator/dispatcher';
import { InMemoryWorkItemStore } from '../engine/orchestrator/workItemStore.memory';
import { InMemoryDecisionLog } from '../engine/stores';
import { makeGitAidlcPorts } from '../engine/orchestrator/ports.git';
import type { AidlcServicePorts } from '../engine/orchestrator/types';
import { ClaudeModel } from '../engine/model/claude';
import { OpenAICompatModel, OPENAI_COMPAT_PROVIDERS } from '../engine/model/openai-compat';

/** Build a Model from the tenant's resolved config (provider + model id) + the JIT key. One OpenAI-compatible
 *  adapter covers DeepSeek/Qwen/GLM/Kimi/Sarvam/OpenRouter/Together/Groq; 'anthropic' uses the Claude adapter. */
function buildModel(provider: string, modelId: string, baseURL: string | undefined, apiKey: string): Model {
    if (provider === 'anthropic' || provider === 'claude') return new ClaudeModel({ apiKey, model: modelId });
    const known = OPENAI_COMPAT_PROVIDERS[provider];
    const url = baseURL || known?.baseURL;
    if (!url) throw new Error(`AIDLC engine: unknown model provider '${provider}' and no modelBaseURL set`);
    return new OpenAICompatModel({ baseURL: url, apiKey, model: modelId, providerLabel: known?.label || provider });
}

/** Wrap a Model so every call's token usage accumulates — this is the REAL per-run cost the meter records. */
function withTokenCounter(m: Model, add: (n: number) => void): Model {
    const wrapped: Model = {
        id: m.id,
        generate: async (input) => { const t = await m.generate(input); add(t.usage?.totalTokens || 0); return t; },
    };
    if (m.generateStream) {
        wrapped.generateStream = async (input, onToken) => { const t = await m.generateStream!(input, onToken); add(t.usage?.totalTokens || 0); return t; };
    }
    return wrapped;
}

export class AidlcEngine implements Engine {
    async run(input: EngineRunInput): Promise<EngineRunOutput> {
        const { ctx, run, config, emit, secrets } = input;

        // 1) Resolve the work item + target repo from the tenant's data (never caller-supplied).
        const wi = await ctx.getWorkItem(run.workItemId);
        if (!wi) throw new Error(`AIDLC engine: work item not found: ${run.workItemId}`);
        const repo = await ctx.getRepo(wi.repoId);
        if (!repo) throw new Error(`AIDLC engine: repo not found: ${wi.repoId}`);

        // 2) GitHub App creds for clone/push/PR — the vendored git ports read these from env. We bridge the
        //    tenant's JIT secret bundle onto them for the duration of the run (process-local; the platform runs
        //    one run per worker in production).
        if (secrets.GITHUB_APP_ID) process.env.AIDLC_GITHUB_APP_ID = secrets.GITHUB_APP_ID;
        if (secrets.GITHUB_INSTALL_ID) process.env.AIDLC_GITHUB_INSTALL_ID = secrets.GITHUB_INSTALL_ID;
        if (secrets.GITHUB_APP_KEY) process.env.AIDLC_GITHUB_APP_KEY = secrets.GITHUB_APP_KEY;

        // 3) Model (main + critic) from config + JIT key.
        const apiKey = secrets.MODEL_API_KEY || secrets.ANTHROPIC_API_KEY || '';
        if (!apiKey) throw new Error('AIDLC engine: no model API key in tenant secrets (set MODEL_API_KEY)');
        const provider = config.modelProvider || 'anthropic';
        let costTokens = 0;
        const add = (n: number) => { costTokens += n; };
        const model = withTokenCounter(buildModel(provider, config.model, config.modelBaseURL, apiKey), add);
        const criticModel = withTokenCounter(buildModel(provider, config.criticModel || config.model, config.modelBaseURL, apiKey), add);

        // 4) In-memory run stores + GIT ports (clone the target repo, edit, test, open a PR — directly on host).
        const store = new InMemoryWorkItemStore();
        const log = new InMemoryDecisionLog();
        const portsFactory = (repoFullName: string): AidlcServicePorts => makeGitAidlcPorts(store, repoFullName).ports;

        // 5) Map the engine's event stream onto the platform's run event log.
        const onEvent = (e: AidlcEvent): void => { void emit(e.type, e as unknown as Record<string, unknown>); };

        const sup = new Supervisor({
            store, portsFactory, dispatcher: new LocalDispatcher(), log, model, criticModel,
            targetRepo: repo.fullName, baseBranch: repo.defaultBranch,
            config: { autoApproveStages: [], maxConcurrentWorkItems: config.maxConcurrentRuns }, // hold at every human gate
            onEvent,
            sinks: { bus: (e) => { void emit(`obs.${e.type}`, e as unknown as Record<string, unknown>); } },
            qualityOn: true,
        });

        // 6) Submit + drive the pipeline (stops at the first human gate / awaiting-input by design).
        const created = await sup.submit({ requester: wi.createdBy || 'platform', channel: 'api', rawRequest: wi.rawRequest }, wi.title || wi.rawRequest.slice(0, 60), repo.fullName);
        const done = await sup.advance(created.id);
        const gate = await sup.openGate(done.id);

        // 7) Map the engine's work-item status onto the platform RunState.
        const st = String((done as any)?.status?.state || '');
        const prUrl: string | undefined = (done as any)?.deploy?.prUrl;
        let state: RunState;
        if (st === 'awaiting_input') state = 'awaiting_input';
        else if (gate) state = 'awaiting_gate';
        else if (st === 'error' || st === 'failed') state = 'failed';
        else if (prUrl || st === 'done' || st === 'complete' || st === 'passed') state = 'passed';
        else state = 'running';

        return { state, costTokens, prUrl, stage: String((done as any)?.status?.stage || '') };
    }
}
