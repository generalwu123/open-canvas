# Open Canvas - production image (Next.js standalone, Node runtime)
# Storage: file-backed JSON at /app/data/open-canvas-db.json
# Note: wrangler/workerd are intentionally NOT installed in the runtime stage so the
# app falls back to file persistence instead of the Cloudflare KV emulation.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN npm install -g pnpm@11.19.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN npm install -g pnpm@11.19.0
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
# Run as the image's built-in "node" user (uid/gid 1000) so the data volume stays
# writable on hosts that enforce uid-based project quotas.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "server.js"]
