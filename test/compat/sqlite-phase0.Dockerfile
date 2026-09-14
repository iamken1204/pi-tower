FROM node:22.22.0-alpine
WORKDIR /probe
RUN apk add --no-cache python3 make g++
COPY sqlite-phase0-run.sh sqlite-phase0-probe.mjs sqlite-phase0-worker.mjs ./test/compat/
RUN NODE_BIN=/usr/local/bin/node NPM_CLI=/usr/local/lib/node_modules/npm/bin/npm-cli.js sh test/compat/sqlite-phase0-run.sh
CMD ["sh", "test/compat/sqlite-phase0-run.sh"]
