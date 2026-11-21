# AIDLC platform app image (Node + tsx). Secrets come from the tmpfs /secrets at runtime, never baked in.
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci || npm install
COPY . .
ENV SECRETS_DIR=/secrets PORT=8787
ENTRYPOINT ["sh", "deploy/oci/entrypoint.sh"]
