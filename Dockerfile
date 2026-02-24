# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────
# Stage 1: builder — install deps & bundle app
# ─────────────────────────────────────────────
FROM oven/bun:1 AS builder

WORKDIR /app

# Install dependencies first (layer-cache friendly)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source and compile
COPY . .

# Bun can run TypeScript natively, but we build a standalone JS bundle
# so the runner stage does not need the full bun compiler overhead.
RUN bun build src/index.ts \
      --outdir dist \
      --target bun \
      --sourcemap=external

# ─────────────────────────────────────────────
# Stage 2: runner — minimal production image
# ─────────────────────────────────────────────
FROM oven/bun:1-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Create a persistent data directory for SQLite
RUN mkdir -p /data && chown bun:bun /data

# Copy only what is needed at runtime
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Optional: copy MCP server config example (runtime reference only)
COPY --from=builder /app/mcp-servers.example.json ./mcp-servers.example.json

# Run as the least-privileged built-in user
USER bun

# Socket Mode bot — no inbound HTTP port needed
CMD ["bun", "run", "dist/index.js"]
