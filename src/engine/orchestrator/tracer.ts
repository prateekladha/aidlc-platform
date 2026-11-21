// The Tracer — the single emit path for AIDLC observability. Assigns a monotonic per-work-item seq + a
// timestamp, then fans each event to (a) the live bus (SSE → run page) and (b) the durable store (replay).
// Within a work item the DAG is sequential — only one process emits at a time — so a local counter seeded
// from the store's current max is globally monotonic across the orchestrator↔worker handoff without a
// central counter per event. See AIDLC-OBSERVABILITY.md §2–§4.
import type { ObsEvent, EmitInput, EventSink, ObsEventStore } from './events';

export interface TracerSinks {
    store?: ObsEventStore;                 // durable (replay); absent in CLI/offline
    bus?: (e: ObsEvent) => void;           // live fan-out (SSE); absent when nobody is watching
}

export class Tracer implements EventSink {
    private seqCounter: number;
    constructor(private readonly workItemId: string, startSeq: number, private readonly sinks: TracerSinks) {
        this.seqCounter = startSeq;
    }

    emit(input: EmitInput): void {
        const seq = ++this.seqCounter;
        const e: ObsEvent = {
            id: `ev_${this.workItemId}_${seq}`,
            workItemId: input.workItemId || this.workItemId,
            stageRunId: input.stageRunId,
            stage: input.stage,
            seq,
            ts: new Date().toISOString(),
            type: input.type,
            level: input.level,
            actor: input.actor,
            payload: input.payload,
            artifactRefs: input.artifactRefs,
        };
        // Live first (snappy UI), then persist (best-effort — a store hiccup must never break a stage).
        try { this.sinks.bus?.(e); } catch { /* no subscribers / serialization */ }
        this.sinks.store?.append(e).catch(() => { /* best-effort durability */ });
    }
}

// Seed the seq from the store's current max so a resumed/handed-off work item keeps a monotonic stream.
export async function createTracer(workItemId: string, sinks: TracerSinks): Promise<Tracer> {
    const start = sinks.store ? await sinks.store.maxSeq(workItemId).catch(() => 0) : 0;
    return new Tracer(workItemId, start, sinks);
}
