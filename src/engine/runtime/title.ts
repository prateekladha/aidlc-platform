// Auto-name a conversation from its opening context. A tiny model call summarises
// the first user message into a short title; a heuristic fallback (first few words)
// is used when the model is unavailable, so titling never blocks or fails a turn.
import type { Model, Msg } from '../types';

/** Instant, model-free title from the first user message — used to name the conversation synchronously
 *  so the turn never blocks on a model call. A nicer model title upgrades it in the background. */
export function quickTitle(messages: Msg[]): string {
    const firstUser = messages.find((m) => m.role === 'user' && m.text)?.text ?? '';
    return heuristicTitle(firstUser);
}

function heuristicTitle(text: string): string {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return 'New conversation';
    const words = clean.split(' ').slice(0, 6).join(' ');
    return words.length > 48 ? words.slice(0, 48) + '…' : words;
}

export async function titleFor(model: Model, messages: Msg[], userId?: string): Promise<string> {
    const firstUser = messages.find((m) => m.role === 'user' && m.text)?.text ?? '';
    if (!firstUser) return 'New conversation';
    try {
        const turn = await model.generate({
            system: 'You write a 3-6 word title for a host\'s chat with their events copilot. Reply with ONLY the title, no quotes, no punctuation at the end.',
            messages: [{ role: 'user', text: `First message: "${firstUser}". Title:` }],
            tools: [],
            thinking: 'low', // trivial summarisation — no reasoning needed; keeps output tokens + latency down
            // Titling runs in the background, OUTSIDE a turn's context (no runId); tag the phase + host so
            // the ops console still attributes its cost. (This is a one-off, not part of any turn.)
            trace: { phase: 'title', userId },
        });
        const t = String(turn.text || '').replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 60) return t;
    } catch {
        /* fall through to heuristic */
    }
    return heuristicTitle(firstUser);
}
