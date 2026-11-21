// In-process mock Sandbox — for tests + local dev of the dispatch flow. Holds files in a Map and keeps the
// JIT secrets ONLY in memory, dropping them on destroy() (proving the never-persist contract). Not isolation.

import type { Sandbox, SandboxProvider, SandboxSpec } from './provider';

class MockSandbox implements Sandbox {
    readonly ref: string;
    private files = new Map<string, string>();
    private secrets: Record<string, string>;
    destroyed = false;
    constructor(readonly spec: SandboxSpec) {
        this.ref = `mock_${spec.runId}`;
        this.secrets = { ...spec.secrets };
    }
    async exec(cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        if (this.destroyed) throw new Error('sandbox destroyed');
        // Mock: echo the command; a scripted test can override by subclassing. Real impl runs in the microVM.
        return { exitCode: 0, stdout: `[mock exec] ${cmd}`, stderr: '' };
    }
    async writeFile(path: string, content: string): Promise<void> {
        if (this.destroyed) throw new Error('sandbox destroyed');
        this.files.set(path, content);
    }
    async readFile(path: string): Promise<string> {
        if (this.destroyed) throw new Error('sandbox destroyed');
        const f = this.files.get(path);
        if (f == null) throw new Error(`no such file: ${path}`);
        return f;
    }
    /** Test-only: assert a secret was injected (plaintext lives only here, in the run's memory). */
    hasSecret(name: string): boolean { return name in this.secrets; }
    async destroy(): Promise<void> {
        this.files.clear();
        this.secrets = {}; // JIT secrets dropped with the sandbox
        this.destroyed = true;
    }
}

export class MockSandboxProvider implements SandboxProvider {
    last?: MockSandbox;
    async create(spec: SandboxSpec): Promise<Sandbox> {
        this.last = new MockSandbox(spec);
        return this.last;
    }
}
