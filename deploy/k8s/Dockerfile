# AIDLC image for Kubernetes (OKE). Slim: prod deps only (--omit=dev drops typescript, @types, pg-mem),
# npm cache cleaned, no build context cruft (.dockerignore). The app runs via tsx (a prod dep); env comes
# from the External-Secrets-synced Secret (envFrom) and the Oracle wallet is a mounted secret file
# (ORACLE_WALLET_DIR=/wallet). git is needed for the engine's clone/push.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
# runs as uid 1000 (Deployment securityContext); /work is a writable emptyDir for clones/sandboxes.
CMD ["npx", "tsx", "src/http/server.ts"]
