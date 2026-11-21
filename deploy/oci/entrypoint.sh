#!/bin/sh
# Source the Vault secrets written to tmpfs by secrets-init, then start the server. No secret on disk/git.
set -e
if [ -f /secrets/app.env ]; then . /secrets/app.env; else echo "WARN: /secrets/app.env missing"; fi
exec npx tsx src/http/server.ts
