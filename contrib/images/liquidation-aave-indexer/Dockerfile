FROM node:22-alpine

# Set working directory
WORKDIR /home/liquidation-aave-indexer

# Install pnpm
RUN npm install -g pnpm

# Copy project files
COPY . .

# Install dependencies
RUN pnpm install --fetch-retries 5

# Change ownership to node user
RUN chown -R node:node /home/liquidation-aave-indexer

# Switch to non-root user
USER node

# Expose Ponder port (default 42069)
EXPOSE 42069

# Run the indexer
CMD ["sh", "-c", "pnpm run indexer"]
