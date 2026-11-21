// Sandbox — the per-run isolated compute seam (THE security boundary; §3.3). One isolated microVM per run.
// Impl #1 = E2B (managed Firecracker, e2b.ts); impl #2 later = self-hosted Firecracker/Kata on credits.
// mock.ts is the in-proc impl for tests. Swapping impls never touches run logic.

export interface SandboxSpec {
    tenantId: string;
    runId: string;
    repoFullName: string;        // owner/name — ONLY the tenant's whitelisted repo
    branch: string;
    cloneToken: string;          // short-lived GitHub installation token, scoped to THIS repo
    secrets: Record<string, string>; // JIT tenant secrets (model key etc.), injected as env, never persisted
    egressAllowlist: string[];   // hosts the run may reach; everything else blocked
    timeoutMs: number;           // hard wall-clock cap
}

export interface Sandbox {
    readonly ref: string;        // provider handle (e.g. e2b sandbox id)
    exec(cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    writeFile(path: string, content: string): Promise<void>;
    readFile(path: string): Promise<string>;
    destroy(): Promise<void>;    // tears down the microVM + everything in it (incl. the JIT secrets)
}

export interface SandboxProvider {
    /** Create an isolated microVM for one run: clone ONLY the whitelisted repo with the scoped token, inject
     *  JIT secrets as env, enforce the egress allow-list + timeout. Never shares a kernel/FS/net with another
     *  tenant's run. The caller MUST destroy() in a finally. */
    create(spec: SandboxSpec): Promise<Sandbox>;
}
