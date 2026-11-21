# Deploy AIDLC to OCI (Always-Free A1 VM · secrets in OCI Vault)

Same practice as the dt-selfcare/rockstar-radar deploy: the app runs on an Always-Free **Ampere A1** VM;
**secret values live in OCI Vault**, pulled via the VM's own identity (instance principal) into a **RAM-only
(tmpfs)** volume on each boot. The DB is the **OCI Autonomous Database** (`aidlc-adb`, Oracle 23ai). The `.env`
on the VM holds only non-secret OCIDs.

## Already provisioned (by the platform operator, via OCI CLI)
- **ADB**: `aidlc-adb` (Oracle 23ai, Always-Free) — the data layer.
- **Vault**: `aidlc-vault` + `aidlc-kek`, loaded with the app secrets:
  `MASTER_KEK`, `AIDLC_OPENAI_COMPAT_*` (DeepSeek), `RAZORPAY_KEY_ID/SECRET`,
  `ORACLE_USER/PASSWORD/CONNECT_STRING/WALLET_PASSWORD`, and `ORACLE_WALLET_PEM` (the ADB mTLS cert).

## 1. Create the VM (once)
Compute → Instances → Create: **Ubuntu 22.04**, shape **VM.Standard.A1.Flex**, public IP, your SSH key.
Note the public IP and the VM **OCID**.

## 2. Grant the VM read access to the Vault
- **Dynamic Group**: `ALL {instance.id = '<VM-OCID>'}`
- **Policy** (in the compartment holding the Vault):
  `Allow dynamic-group <dg> to read secret-bundles in compartment dt-selfcare`

## 3. Open port 80 (Subnet → Security List → Ingress): `0.0.0.0/0` TCP 80.

## 4. Deploy (on the VM)
```bash
git clone https://github.com/prateekladha/aidlc-platform.git ~/aidlc && cd ~/aidlc/deploy/oci
cp .env.example .env && nano .env        # set OCI_REGION + the two Vault/compartment OCIDs (no secrets)
bash bootstrap.sh                        # secrets-init pulls Vault → tmpfs, then the app starts on :80
```
Open `http://<VM-IP>/` — the Signal onboarding UI, persisting to the Oracle ADB, secrets from Vault (RAM only).

## Why this is safe (unchanged from dt-telekom)
Secret **values** never touch the VM disk or git — only Vault, fetched into tmpfs at boot. The VM authenticates
to Vault as itself (instance principal); no keys are stored anywhere. `.env` holds only OCIDs.
