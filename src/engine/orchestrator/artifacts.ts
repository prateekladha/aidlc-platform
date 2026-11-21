// Run-artifact store (screenshots, diffs, logs the agent produces). The GCS-backed implementation was removed
// with the GCP coupling; the platform will back this with its S3-compatible object store (OCI Object Storage /
// Cloudflare R2) behind these same two functions. Until then artifacts are disabled — putArtifact returns null
// and artifactsEnabled() is false, which the Playwright/diagnostics ports already handle gracefully.
export async function putArtifact(
    _workItemId: string,
    _name: string,
    _buf: Buffer,
    _contentType: string,
): Promise<{ ref: string; url: string } | null> {
    return null;
}

export const artifactsEnabled = (): boolean => false;
