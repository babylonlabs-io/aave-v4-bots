# ============================================
# Arbitrageur Client - Multi-stage Dockerfile
# ============================================

# Stage 1: Build dependencies
FROM node:22-alpine AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.13.2 --activate

WORKDIR /app

# Copy workspace configuration
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# Copy package.json files for all required packages
COPY packages/shared/package.json ./packages/shared/
COPY services/arbitrageur/client/package.json ./services/arbitrageur/client/

# Install dependencies (workspace-aware)
RUN pnpm install --frozen-lockfile --filter @services/arbitrageur-client...

# Copy source code
COPY packages/shared/ ./packages/shared/
COPY services/arbitrageur/client/ ./services/arbitrageur/client/

# ============================================
# Stage 2: Production runtime
# ============================================
FROM node:22-alpine AS runner

# Install pnpm for running tsx and wget for healthchecks
RUN apk add --no-cache wget && \
    corepack enable && corepack prepare pnpm@9.13.2 --activate

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 arbitrageur

WORKDIR /app

# Copy built application from builder
COPY --from=builder /app/pnpm-workspace.yaml ./
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
