# llm-cli: vendor CLI subscriptions behind an internal OpenAI-compatible endpoint
# (docs/llm-providers.md). The CLIs are installed from npm at build time as separate tools under
# their vendors' terms (docs/LICENSES.md; Claude Code is proprietary): build this image yourself
# and push it only to a private registry. Logins are mounted at run time, never baked in.
FROM node:22-trixie-slim
ARG CLAUDE_CODE_VERSION=2.1.319
ARG CODEX_VERSION=0.167.0
ARG GEMINI_CLI_VERSION=0.67.0
RUN npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
  && npm cache clean --force
WORKDIR /app
COPY services/llm-cli/src src
COPY infra/llm-cli/config.json /etc/llm-cli/config.json
ENV NODE_ENV=production PORT=8080 DISABLE_AUTOUPDATER=1
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/main.ts"]
