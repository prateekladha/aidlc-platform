"""One-shot OCI Vault -> tmpfs secrets bootstrap for AIDLC (instance principal; no stored creds).
Mirrors the dt-selfcare/rockstar-radar practice. Config (NON-secret, in deploy/oci/.env):
  OCI_REGION, SECRETS_COMPARTMENT_OCID, SECRETS_VAULT_OCID
Writes $SECRETS_DIR/app.env (`export NAME='value'`, sourced by the app). If ORACLE_WALLET_B64 is
present it is a base64 wallet zip -> unpacked into $SECRETS_DIR/wallet/ and ORACLE_WALLET_DIR exported,
so node-oracledb (thin, mTLS) connects with no wallet on disk/git. Secret VALUES live only in Vault + RAM."""
from __future__ import annotations
import base64, io, os, sys, zipfile
SECRETS_DIR = os.environ.get('SECRETS_DIR', '/secrets')

def _fetch_all():
    import oci
    signer = oci.auth.signers.InstancePrincipalsSecurityTokenSigner()
    cfg = {'region': os.environ['OCI_REGION']} if os.environ.get('OCI_REGION') else {}
    vaults = oci.vault.VaultsClient(cfg, signer=signer)
    secrets = oci.secrets.SecretsClient(cfg, signer=signer)
    listed = oci.pagination.list_call_get_all_results(
        vaults.list_secrets, os.environ['SECRETS_COMPARTMENT_OCID'], vault_id=os.environ['SECRETS_VAULT_OCID']).data
    out = {}
    for s in listed:
        if getattr(s, 'lifecycle_state', None) != 'ACTIVE':
            continue
        c = secrets.get_secret_bundle(s.id).data.secret_bundle_content.content
        out[s.secret_name] = base64.b64decode(c).decode('utf-8')
    return out

def main() -> int:
    os.makedirs(SECRETS_DIR, exist_ok=True)
    try:
        found = _fetch_all()
    except Exception as e:
        print(f'[secrets-init] FAILED to read OCI Vault: {type(e).__name__}: {e}', file=sys.stderr)
        return 1
    if not found:
        print('[secrets-init] no ACTIVE secrets found', file=sys.stderr)
        return 1
    if 'ORACLE_WALLET_PEM' in found:
        wdir = os.path.join(SECRETS_DIR, 'wallet')
        os.makedirs(wdir, exist_ok=True)
        with open(os.path.join(wdir, 'ewallet.pem'), 'w', encoding='utf-8') as wf:
            wf.write(found.pop('ORACLE_WALLET_PEM'))
        found['ORACLE_WALLET_DIR'] = wdir
    lines = [f"export {k}='" + v.replace("'", "'\"'\"'") + "'" for k, v in found.items()]
    with open(os.path.join(SECRETS_DIR, 'app.env'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    print(f'[secrets-init] loaded {len(found)} value(s) into {SECRETS_DIR} (tmpfs): ' + ', '.join(sorted(found)))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
