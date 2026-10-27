# One image for every engine process: the API (default command), the worker
# and the development webhook sink (see docker-compose.yml). TypeScript runs
# as is through Node's type stripping: there is no build step.
#
#   docker build -f apps/api/Dockerfile -t follow-up-engine .
#   docker run -p 3000:3000 -e DATABASE_URL=... -e WEBHOOK_URL=... -e WEBHOOK_SECRET=... follow-up-engine
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/fhir/package.json packages/fhir/
COPY packages/adapter-memory/package.json packages/adapter-memory/
COPY packages/adapter-postgres/package.json packages/adapter-postgres/
COPY packages/llm/package.json packages/llm/
COPY packages/testkit/package.json packages/testkit/
COPY packages/runtime/package.json packages/runtime/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
# The API, the worker and what they need at run time; testkit stays for the
# demo seed (synthetic data only).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts \
      --filter "@follow-up-engine/api..." --filter "@follow-up-engine/worker..." \
      --filter "@follow-up-engine/testkit..."

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app /app
COPY config ./config
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY docs/integration.md ./docs/integration.md
USER node
EXPOSE 3000
ENV PORT=3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "--no-warnings=ExperimentalWarning", "apps/api/src/main.ts"]
