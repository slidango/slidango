FROM node:22-bookworm-slim AS pnpm
# Pinned so corepack does not have to look up a version online.
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate

FROM pnpm AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

# Slidev runtime for decks without an uploaded template; separate from the workspace.
FROM pnpm AS runtime
WORKDIR /runtime
COPY apps/server/runtime/package.json apps/server/runtime/pnpm-lock.yaml ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm install --ignore-workspace --frozen-lockfile --prod

FROM deps AS build
COPY . .
# chmod: host file modes leak into the build context, and the app runs as `node`.
RUN pnpm --filter @slidango/web build \
 && pnpm --filter @slidango/server --prod deploy --legacy /out \
 && cp -r apps/server/src apps/server/drizzle apps/server/tsconfig.json /out/ \
 && cp -r apps/web/dist /out/web \
 && chmod -R a+rX /out

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data WEB_DIST=/app/web \
    SLIDEV_RUNTIME=/app/runtime COREPACK_HOME=/opt/corepack
WORKDIR /app
# git: deck versions. pnpm: template installs. (PDF/PPTX export runs in the browser, in Slidev's preview.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@10.34.9 --activate && chmod -R a+rX /opt/corepack
COPY --from=runtime /runtime /app/runtime
# Read-only for the app: decks get their own node_modules (links into this
# runtime), where Vite and Slidev keep their per-deck caches.
RUN chmod -R a+rX /app/runtime
COPY --from=build /out /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/main.ts"]
