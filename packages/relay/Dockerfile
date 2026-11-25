# Relay image. The relay has no runtime dependencies: Node runs the TypeScript
# source directly, so there is no install or build step.
FROM node:24-slim
WORKDIR /relay
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production
# RELAY_VERIFICATION_KEY (the PEM public key) and PORT come from the host.
# Mount persistent storage at /data.
CMD ["node", "src/cli.ts", "serve", "--database", "/data/relay.sqlite", "--host", "0.0.0.0"]
