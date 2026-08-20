# ============================================
# Arbitrageur - Multi-stage Dockerfile
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
COPY packages/engine/package.json ./packages/engine/
COPY packages/execution/package.json ./packages/execution/
COPY packages/logger/package.json ./packages/logger/
COPY packages/notifications/package.json ./packages/notifications/
COPY packages/observability/package.json ./packages/observability/
COPY packages/persistence/package.json ./packages/persistence/
COPY packages/risk/package.json ./packages/risk/
COPY packages/runtime/package.json ./packages/runtime/
COPY packages/secrets/package.json ./packages/secrets/
COPY packages/signer/package.json ./packages/signer/
COPY services/arbitrageur/package.json ./services/arbitrageur/

# Install production dependencies only (workspace-aware).
# --prod omits devDependencies (vitest and its vite/rollup/postcss toolchain),
# so build/test tooling never ships in the runtime image. The app runs via tsx,
# which is declared as a runtime dependency for this reason.
RUN pnpm install --frozen-lockfile --prod --filter @services/arbitrageur...

# Copy source code
COPY packages/abis/ ./packages/abis/
COPY packages/chain/ ./packages/chain/
COPY packages/config/ ./packages/config/
COPY packages/engine/ ./packages/engine/
COPY packages/execution/ ./packages/execution/
COPY packages/logger/ ./packages/logger/
COPY packages/notifications/ ./packages/notifications/
COPY packages/observability/ ./packages/observability/
COPY packages/persistence/ ./packages/persistence/
COPY packages/risk/ ./packages/risk/
COPY packages/runtime/ ./packages/runtime/
COPY packages/secrets/ ./packages/secrets/
COPY packages/signer/ ./packages/signer/
COPY services/arbitrageur/ ./services/arbitrageur/

# ============================================
# Stage 2: Production runtime
# ============================================
FROM node:22-alpine AS runner

# wget for the healthcheck. Remove the npm bundled in the base image: it is
# unused at runtime and ships known-vulnerable transitive deps (tar, etc.) that
# the image scanner flags. pnpm/corepack are intentionally NOT installed here —
# the app runs directly via tsx (see CMD), so no package manager ships in the
# runtime image.
RUN apk add --no-cache wget=~1.25 && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

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
COPY --from=builder /app/services/arbitrageur ./services/arbitrageur

# Set ownership
RUN chown -R arbitrageur:nodejs /app

USER arbitrageur

WORKDIR /app/services/arbitrageur

# Health check for metrics server
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:9091/health || exit 1

# Default command: start polling mode. Run directly via tsx (WORKDIR is the
# service dir, tsx is a runtime dependency) so no package manager is needed.
CMD ["node_modules/.bin/tsx", "src/index.ts"]
