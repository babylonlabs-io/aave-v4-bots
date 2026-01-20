FROM node:22-alpine

# Set working directory
WORKDIR /home/liquidation-aave-client

# Install pnpm
RUN npm install -g pnpm

# Copy project files and install dependencies
COPY . .
RUN pnpm install --fetch-retries 5

# Change ownership to node user
RUN chown -R node:node /home/liquidation-aave-client

# Switch to non-root user
USER node

# Run the liquidate
CMD ["sh", "-c", "pnpm run liquidate"]
