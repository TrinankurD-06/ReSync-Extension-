# ReSync team server + dashboard in one image. The server serves the built dashboard on the same origin.
# Build: docker build -t resync-server .     Run with docker-compose.yml (adds MongoDB).

FROM node:24-alpine AS build
WORKDIR /app
# mongodb-memory-server (a test-only dependency) must not download MongoDB during the image build.
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json ./
# Every workspace's package.json (npm ci checks them against the lockfile); only three are installed.
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/cli/package.json packages/cli/
COPY packages/plugin/package.json packages/plugin/
COPY packages/extension/package.json packages/extension/
RUN npm ci -w @resync/shared -w @resync/server -w @resync/dashboard --no-audit --no-fund
COPY packages/shared packages/shared
COPY packages/dashboard packages/dashboard
# Blank = the dashboard calls the API on its own origin.
ENV VITE_RESYNC_SERVER_URL=
RUN npm run build -w @resync/dashboard

FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/cli/package.json packages/cli/
COPY packages/plugin/package.json packages/plugin/
COPY packages/extension/package.json packages/extension/
RUN npm ci --omit=dev -w @resync/shared -w @resync/server --no-audit --no-fund && npm cache clean --force
COPY packages/shared/src packages/shared/src
COPY packages/server/src packages/server/src
COPY --from=build /app/packages/dashboard/dist packages/dashboard/dist
ENV PORT=8787 SERVE_DASHBOARD=/app/packages/dashboard/dist
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8787/api/v1/health || exit 1
CMD ["node", "packages/server/src/index.js"]
