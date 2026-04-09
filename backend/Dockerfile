# Dockerfile for the Magic backend. Matches the Node version declared in
# package.json. Render currently builds/runs this without Docker — the image
# is provided for local reproduction, alternative hosts, and CI validation.
FROM node:22-alpine

# tini gives us a proper PID 1 so SIGTERM flows to node instead of being
# absorbed by the shell. Keeps graceful shutdowns honest.
RUN apk add --no-cache tini

WORKDIR /app

# Copy manifests first for better layer caching.
COPY package.json package-lock.json ./

# Skip the postinstall git-hooks script inside the image — there is no
# working tree here. CI=true makes install-git-hooks.js no-op.
ENV CI=true
RUN npm ci --omit=dev

# Copy source last so dep layers are reused on code-only changes.
COPY . .

# Bake the commit into the image so resolveGitCommit() doesn't need git.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=${GIT_COMMIT}

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Run as the built-in non-root user provided by the node image.
USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
