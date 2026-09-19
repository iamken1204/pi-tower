FROM node:22.22.0-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# Native SQLite falls back to a local build when no matching prebuild is available.
RUN apk add --no-cache --virtual .build-deps python3 make g++
RUN npm ci --omit=dev --omit=peer
RUN apk del .build-deps
COPY tower.mjs lib.mjs managed-tower.mjs managed-storage.mjs managed-snapshots.mjs managed-journal.mjs ./
COPY ui.html threads.html ui.css ./
RUN mkdir /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 9000
CMD ["node", "tower.mjs"]
