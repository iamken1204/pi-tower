FROM node:22.22.0-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# Native SQLite falls back to a local build when no matching prebuild is available.
RUN apk add --no-cache --virtual .build-deps python3 make g++
RUN npm ci --omit=dev --omit=peer
RUN apk del .build-deps
COPY src/tower.mjs src/lib.mjs ./src/
COPY src/managed/tower.mjs src/managed/storage.mjs src/managed/snapshots.mjs src/managed/journal.mjs src/managed/collaboration-store.mjs ./src/managed/
COPY src/ui ./src/ui
RUN mkdir /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 9000
CMD ["node", "src/tower.mjs"]
