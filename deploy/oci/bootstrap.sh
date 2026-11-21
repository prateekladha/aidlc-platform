#!/usr/bin/env bash
# Run ON the VM. Builds + starts the stack; secrets-init pulls Vault secrets into RAM, then the app starts.
set -euo pipefail
sudo docker compose up -d --build
echo "AIDLC up on http://$(curl -s ifconfig.me):80  (secrets from OCI Vault, RAM-only)"
