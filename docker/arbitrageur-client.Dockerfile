# ============================================
# Arbitrageur Client - Multi-stage Dockerfile
# ============================================

# Stage 1: Build dependencies
FROM node:22-alpine AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.13.2 --activate

WORKDIR /app

# Copy workspace configuration
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.json ./

# Copy package.json files for all required workspace packages
COPY packages/abis/package.json ./packages/abis/
COPY packages/chain/package.json ./packages/chain/
COPY packages/config/package.json ./packages/config/
COPY packages/observability/package.json ./packages/observability/
COPY services/arbitrageur/client/package.json ./services/arbitrageur/client/

# Install production dependencies only (workspace-aware).
# --prod omits devDependencies (vitest and its vite/rollup/postcss toolchain),
# so build/test tooling never ships in the runtime image. The app runs via tsx,
# which is declared as a runtime dependency for this reason.
RUN pnpm install --frozen-lockfile --prod --filter @services/arbitrageur-client...

# Copy source code
COPY packages/abis/ ./packages/abis/
COPY packages/chain/ ./packages/chain/
COPY packages/config/ ./packages/config/
COPY packages/observability/ ./packages/observability/
COPY services/arbitrageur/client/ ./services/arbitrageur/client/

# ============================================
# Stage 2: Production runtime
# ============================================
FROM node:22-alpine AS runner

# Install pnpm for running tsx and wget for healthchecks
RUN apk add --no-cache wget=~1.25 && \
    corepack enable && corepack prepare pnpm@9.13.2 --activate

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 arbitrageur

WORKDIR /app

ENV NODE_ENV=production

# Copy the production dependency tree and application from the builder
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/services/arbitrageur/client ./services/arbitrageur/client

# Set ownership
RUN chown -R arbitrageur:nodejs /app

USER arbitrageur

WORKDIR /app/services/arbitrageur/client

# Health check for metrics server
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:9091/health || exit 1

# Default command: start polling mode
CMD ["pnpm", "start"]
