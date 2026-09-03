# Shared build for both services. They differ only in which one they start, so a
# single image keeps the build cache warm and guarantees they run identical code.
#
# Build from the repository root:
#   docker build -t easycal .

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- dependencies -----------------------------------------------------------
# Copied separately from sources so a code change does not re-resolve the graph.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/event-parser/package.json packages/event-parser/
COPY db/package.json db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
# apps/web is built and deployed separately (Cloudflare), so it is excluded here.
RUN pnpm install --frozen-lockfile --filter '!@easycal/web...' --filter '!@easycal/web'

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/event-parser packages/event-parser
COPY db db
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY tsconfig.build.json ./
# One `tsc -b` over the solution file. TypeScript's project-reference graph decides
# the order, which pnpm's filtered runs did not do reliably here — it started
# @easycal/db before @easycal/contracts had emitted dist/, and every type error
# cascaded from that single unresolved import.
RUN pnpm exec tsc -b tsconfig.build.json

# Drop devDependencies. This is why the test harness is not reachable from
# @easycal/db's entry point: embedded-postgres is not installed here.
# CI=true keeps prune from prompting for confirmation.
RUN CI=true pnpm prune --prod

# ---- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/db ./db
COPY --from=build /app/apps ./apps

# node:22-alpine ships a non-root `node` user.
USER node

# Overridden per service in infra/docker-compose.yml.
CMD ["node", "apps/api/dist/index.js"]
