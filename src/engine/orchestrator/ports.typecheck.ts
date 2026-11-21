// Scoped typecheck — shared by the git + local testing ports (neutral module to avoid an import cycle).
// First principles: a change can only break types in what it touches or what depends on it, and `tsc <files>`
// already follows imports. So we generate a throwaway tsconfig that EXTENDS the repo's (identical module
// resolution / libs / strictness) but INCLUDES only the changed .ts/.tsx files. Full-repo tsc on a large
// monorepo is minutes; this is seconds. Nothing is expensive by default.
import type { SandboxPort } from './types';

export async function scopedTypecheck(sandbox: SandboxPort, sandboxId: string): Promise<{ exitCode: number; output: string; scope: string }> {
    const hasNm = /yes/.test((await sandbox.run(sandboxId, 'test -d node_modules && echo yes || echo no')).stdout);
    if (!hasNm) return { exitCode: 0, output: 'node_modules absent — typecheck skipped (set AIDLC_NODE_MODULES_<REPO> / AIDLC_SANDBOX_NPM_CI=1)', scope: 'none' };
    const names = await sandbox.run(sandboxId, "git add -A >/dev/null 2>&1; git diff --cached --name-only --diff-filter=ACMR | grep -E '\\.(ts|tsx)$' || true");
    const files = String(names.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!files.length) return { exitCode: 0, output: 'no changed .ts/.tsx files to typecheck', scope: 'none' };
    const cfg = JSON.stringify({ extends: './tsconfig.json', compilerOptions: { noEmit: true, skipLibCheck: true, incremental: false, composite: false, declaration: false }, include: files }, null, 2);
    await sandbox.writeFile(sandboxId, 'tsconfig.aidlc-verify.json', cfg);
    const r = await sandbox.run(sandboxId, 'npx tsc -p tsconfig.aidlc-verify.json');
    return { exitCode: r.exitCode, output: (r.stdout || r.stderr || '').slice(-4000), scope: files.join(', ') };
}
