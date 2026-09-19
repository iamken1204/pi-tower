FROM oven/bun:1.4.2-alpine
WORKDIR /app
# Tower needs nothing beyond Bun itself: SQLite and WebSockets are built in.
COPY src/tower.mjs src/lib.mjs ./src/
COPY src/managed/tower.mjs src/managed/sqlite.mjs src/managed/storage.mjs src/managed/snapshots.mjs src/managed/journal.mjs src/managed/collaboration-store.mjs ./src/managed/
COPY src/ui ./src/ui
RUN mkdir /data && chown bun:bun /data
VOLUME ["/data"]
USER bun
EXPOSE 9000
# No .env autoloading: compose passes the environment explicitly.
CMD ["bun", "--no-env-file", "src/tower.mjs"]
