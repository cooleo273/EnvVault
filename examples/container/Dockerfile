# A container image that loads its configuration from EnvVault when it starts.
# The image contains no values and no credential: the platform provides the
# service credential at run time (a mounted secret file is best), and the
# values are fetched by the process itself.
FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --prod --frozen-lockfile
COPY . .
# No ARG or ENV with secrets here: both are stored in the image.
USER node
ENV ENVVAULT_ENVIRONMENT=production
# The credential comes from a secret mount, for example
#   docker run --mount type=bind,src=/etc/envvault/credential,dst=/run/secrets/envvault,ro \
#     -e ENVVAULT_API_URL=https://api.envvault.example.com \
#     -e ENVVAULT_SERVICE_CREDENTIAL_FILE=/run/secrets/envvault image
CMD ["node", "worker.mjs"]
