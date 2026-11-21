// E2B Sandbox provider (production impl #1) — managed Firecracker microVMs, one per run, dedicated kernel.
// STUBBED until the `e2b` SDK + E2B_API_KEY are wired (owner provisions the account — see PRE-PROVISIONING §2).
// The real create() does, inside a fresh E2B sandbox:
//   1) `git clone --depth 1 --branch <branch> https://x-access-token:<cloneToken>@github.com/<repo>` (scoped token)
//   2) set env from spec.secrets (JIT — never written to disk/image)
//   3) apply the egress allow-list (E2B firewall) + spec.timeoutMs
//   4) return a Sandbox whose exec/writeFile/readFile proxy the E2B SDK; destroy() kills the microVM.
// Keeping this as a typed stub means the rest of the platform compiles + runs on the mock today, and this is
// the ONLY file that gains the `e2b` dependency when we go live.

import type { Sandbox, SandboxProvider, SandboxSpec } from './provider';

export class E2BSandboxProvider implements SandboxProvider {
    constructor(private readonly apiKey = process.env.E2B_API_KEY) {}
    async create(_spec: SandboxSpec): Promise<Sandbox> {
        if (!this.apiKey) {
            throw new Error('E2B not configured: set E2B_API_KEY (see PRE-PROVISIONING §2). Use the mock provider for local/dev.');
        }
        // TODO(phase-1): import { Sandbox as E2B } from 'e2b'; const sbx = await E2B.create({ apiKey, timeoutMs });
        //   await sbx.commands.run(`git clone ... `); for (const [k,v] of Object.entries(_spec.secrets)) env; ...
        throw new Error('E2BSandboxProvider not yet implemented — wire the e2b SDK in phase 1.');
    }
}
