# Teaching image. Not built or run where this was written (no Docker daemon was available),
# so treat it as a starting point and build it before relying on it.
FROM node:22-alpine
WORKDIR /app

# Dependencies first, so this layer is cached until package files change.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Type-checks and bundles the tutorial and the app into dist/, which the server serves in production.
RUN npm run build

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3102
EXPOSE 3102

# /healthz needs no token and reports whether the database answers.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:3102/healthz || exit 1

USER node
# In production the server needs DATABASE_URL, TOKEN_SECRET and PUBLIC_ORIGIN, and stops with a clear error without them.
CMD ["npm", "start"]
