# AI-DLC Tracker. No npm dependencies, so there is no install step.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3100 \
    DATABASE_PATH=/app/data/tracker.db
COPY package.json server.mjs ./
COPY src ./src
COPY public ./public
COPY bin ./bin
# /app/data holds the SQLite database (and secret.key when TRACKER_SECRET_KEY is not set): mount a volume there.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
