FROM node:22-bookworm-slim

ARG CODEX_CLI_VERSION=0.145.0
ENV CODEX_CLI_VERSION=${CODEX_CLI_VERSION}

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global "@openai/codex@${CODEX_CLI_VERSION}" \
    && npm cache clean --force

WORKDIR /app
COPY --chown=node:node package.json gateway.js run-codex.js ./

USER node
ENTRYPOINT ["node"]
CMD ["gateway.js"]
