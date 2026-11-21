// Session + decision-log stores. Interfaces + in-memory implementations (used by
// tests and safe for Phase 1) + a file-backed decision log for simple
// persistence. An Arango-backed adapter (env-prefixed collections
// prod_agent_sessions / prod_agent_decisions) is the production target — TODO,
// kept out of the overnight build so tests never write to prod.
import fs from 'node:fs';
import type { Decision, DecisionLog, Msg } from './types';

// ── Sessions ────────────────────────────────────────────────────────────────
export interface PendingProposal {
    runId: string;
    callId: string;
    tool: string;
    args: Record<string, unknown>;
    note: string;
}

export interface Session {
    id: string;
    userId: string;
    messages: Msg[];
    pending?: PendingProposal | null;
    createdAt: string;
    updatedAt: string;
    /** Auto-generated short name for the conversation (from its context). */
    title?: string | null;
    /** Host pinned this conversation to the top of their history. */
    pinned?: boolean;
    /** Soft-deleted — hidden from history, never hard-deleted. */
    deleted?: boolean;
    /** Timestamp of the most recent message — drives "sort by latest". */
    lastMessageAt?: string;
}

export interface SessionStore {
    get(id: string): Promise<Session | null>;
    create(userId: string, id?: string): Promise<Session>;
    save(s: Session): Promise<void>;
}

// One row in a host's conversation history (list view — no message bodies).
export interface ConversationMeta {
    id: string;
    title: string;
    pinned: boolean;
    createdAt: string;
    lastMessageAt: string;
    messageCount: number;
}

// Richer store for the history UI: list / search / pin / rename / soft-delete, on top
// of the base SessionStore. The Arango adapter implements this; the in-memory store too.
export interface ConversationStore extends SessionStore {
    listByUser(userId: string, opts?: { search?: string; limit?: number; offset?: number }): Promise<ConversationMeta[]>;
    setPinned(userId: string, id: string, pinned: boolean): Promise<void>;
    rename(userId: string, id: string, title: string): Promise<void>;
    softDelete(userId: string, id: string): Promise<void>;
}

function titleText(s: string): string {
    return String(s || '').toLowerCase();
}

export class InMemorySessionStore implements ConversationStore {
    private sessions = new Map<string, Session>();
    private seq = 0;

    async get(id: string): Promise<Session | null> {
        const s = this.sessions.get(id);
        return s ? { ...s, messages: [...s.messages] } : null;
    }

    async create(userId: string, id?: string): Promise<Session> {
        this.seq += 1;
        const now = new Date().toISOString();
        const s: Session = { id: id ?? `sess_${this.seq}`, userId, messages: [], pending: null, createdAt: now, updatedAt: now, title: null, pinned: false, deleted: false, lastMessageAt: now };
        this.sessions.set(s.id, s);
        return { ...s };
    }

    async save(s: Session): Promise<void> {
        const now = new Date().toISOString();
        const last = [...s.messages].reverse().find((m) => m.ts)?.ts ?? s.lastMessageAt ?? now;
        this.sessions.set(s.id, { ...s, messages: [...s.messages], updatedAt: now, lastMessageAt: last });
    }

    async listByUser(userId: string, opts?: { search?: string; limit?: number; offset?: number }): Promise<ConversationMeta[]> {
        const q = titleText(opts?.search ?? '');
        const rows = [...this.sessions.values()]
            .filter((s) => s.userId === userId && !s.deleted && s.messages.some((m) => m.role === 'user'))
            .filter((s) => !q || titleText(s.title ?? '').includes(q) || s.messages.some((m) => titleText(m.text ?? '').includes(q)))
            .sort((a, b) => {
                if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
                return (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt);
            });
        const off = opts?.offset ?? 0;
        const lim = opts?.limit ?? 30;
        return rows.slice(off, off + lim).map((s) => ({
            id: s.id, title: s.title || 'New conversation', pinned: !!s.pinned,
            createdAt: s.createdAt, lastMessageAt: s.lastMessageAt ?? s.updatedAt,
            messageCount: s.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length,
        }));
    }

    async setPinned(userId: string, id: string, pinned: boolean): Promise<void> {
        const s = this.sessions.get(id);
        if (s && s.userId === userId) s.pinned = pinned;
    }

    async rename(userId: string, id: string, title: string): Promise<void> {
        const s = this.sessions.get(id);
        if (s && s.userId === userId) s.title = title;
    }

    async softDelete(userId: string, id: string): Promise<void> {
        const s = this.sessions.get(id);
        if (s && s.userId === userId) s.deleted = true;
    }
}

// ── Decision log ──────────────────────────────────────────────────────────────
export class InMemoryDecisionLog implements DecisionLog {
    private entries: Decision[] = [];
    async append(d: Decision): Promise<void> {
        this.entries.push(d);
    }
    async all(): Promise<Decision[]> {
        return [...this.entries];
    }
}

export class FileDecisionLog implements DecisionLog {
    constructor(private readonly path: string) {}
    async append(d: Decision): Promise<void> {
        await fs.promises.appendFile(this.path, JSON.stringify(d) + '\n', 'utf8');
    }
    async all(): Promise<Decision[]> {
        if (!fs.existsSync(this.path)) return [];
        const raw = await fs.promises.readFile(this.path, 'utf8');
        return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Decision);
    }
}
