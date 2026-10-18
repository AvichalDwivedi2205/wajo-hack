FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --cache /tmp/npm-cache
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:24.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --cache /tmp/npm-cache && rm -rf /tmp/npm-cache
COPY --from=build /app/dist ./dist
COPY src ./src
COPY scripts/diagnostics.ts ./scripts/diagnostics.ts
RUN mkdir -p /app/.fo-fix && chown node:node /app/.fo-fix && chmod 700 /app/.fo-fix
USER node
# Listener and exact trusted proxy addresses are explicit runtime configuration.
# Default remains loopback; remote.env.example selects a private 0.0.0.0 upstream.
# PORT is accepted from the host; never expose upstream to untrusted traffic.
# No ports are published and no credentials are supplied by this image.
CMD ["node", "--use-env-proxy", "--import", "tsx", "src/server/main.ts", "--remote"]
