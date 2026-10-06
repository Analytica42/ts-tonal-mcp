# ts-tonal-mcp — streamable-HTTP MCP server for Tonal.
#
# Built LOCALLY on the deploy host and tagged a42/ts-tonal-mcp:latest; consumed by
# the `tonal-mcp` service in a42-flows/docker-compose.tonal.yml. Not pushed anywhere.
#
#   docker build -t a42/ts-tonal-mcp:latest .
#
# NO credentials are baked into this image. MCP_AUTH_TOKEN, TONAL_USERNAME and
# TONAL_PASSWORD are supplied at runtime only (compose `env_file`), and there is
# deliberately no ARG or ENV default for any of them.

# -----------------------------------------------------------------------------
# Stage 1: build — install the locked tree, compile to dist/, then reduce that
# SAME tree to production deps. One resolution, so what ships is exactly what
# was typechecked and compiled against.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# `npm ci` installs strictly from package-lock.json and fails loudly if the lock
# is absent or out of sync with package.json. Upstream gitignores the lockfile;
# ours is committed on the a42-deploy branch on purpose and MUST stay committed,
# or this build stops here rather than silently resolving a different tree.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Sources after the install so the dependency layer stays cached across
# source-only edits.
COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Drop devDependencies (typescript / tsx / @types / esbuild) IN PLACE. This is the
# already-resolved tree minus dev packages — NOT a second, independent `npm install`
# that could resolve differently from the one just compiled against.
RUN npm prune --omit=dev

# -----------------------------------------------------------------------------
# Stage 2: runtime — production node_modules + compiled dist/ only.
# No devDependencies, no .ts sources, no tests, and no npm at all.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production

# Image default only; src/server.ts falls back to 8080 on its own. The deployment
# overrides this (compose sets PORT=9428), so EXPOSE below tracks the image
# default rather than the deployed port — EXPOSE is metadata and need not match.
ENV PORT=8080

WORKDIR /app

# Run unprivileged. The `node` user (uid 1000) ships with the official image.
# WORKDIR creates /app root-owned, so hand it over BEFORE dropping privileges;
# every COPY below lands as `node`, so no `chown -R` over node_modules is needed.
RUN chown node:node /app
USER node

# package.json is needed AT RUNTIME, not merely to install: src/server.ts does
# `createRequire(import.meta.url)('../package.json')` and throws unless it finds a
# string `version`. Resolved from /app/dist/server.js that is /app/package.json —
# so this file must stay exactly one level above dist/.
COPY --chown=node:node package.json ./

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

EXPOSE 8080

# alpine ships no curl, and we deliberately do NOT install one: the node binary is
# already present and global fetch() has been available since Node 18, so this adds
# no package and no attack surface to a credential-bearing image.
# Exit semantics verified against the real pruned build: 0 when /health answers
# 2xx, 1 on non-2xx or connection refused. 127.0.0.1 rather than `localhost` on
# purpose — the server binds IPv4 0.0.0.0 only (src/server.ts), and `localhost`
# can resolve to ::1 first inside a container.
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# In http mode the server throws at startup if MCP_AUTH_TOKEN is unset — a missing
# secret fails loudly rather than serving the Tonal account unauthenticated.
CMD ["node", "dist/index.js"]
