# syntax=docker/dockerfile:1.7
#
# EnvVault API image. Build from the repository root:
#   docker build -f infrastructure/deployment/docker/api.Dockerfile -t envvault-api .
# Keys, recovery keys and .env files are excluded by .dockerignore and are
# mounted at run time; nothing secret is baked into a layer.
# Pin the base images by digest in your registry before using in production.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@envvault/api...
# A self contained copy of the API with production dependencies only.
RUN pnpm --filter @envvault/api deploy --prod --legacy /out

# One off release step: applies reviewed migrations, never on API start.
FROM build AS migrate
WORKDIR /repo/packages/database
USER node
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=4000
RUN addgroup -S -g 10001 envvault && adduser -S -u 10001 -G envvault -H envvault
WORKDIR /app
# Owned by root and read only for the service user: the process cannot modify its own code.
COPY --from=build --chown=root:root /out ./
USER 10001:10001
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:4000/api/v1/health >/dev/null || exit 1
CMD ["node", "dist/main.js"]
