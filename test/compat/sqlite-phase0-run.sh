#!/bin/sh
set -eu

NODE_BIN=${NODE_BIN:-node}
NODE_VERSION=$($NODE_BIN --version)
FIXTURE=$(mktemp -d "${TMPDIR:-/tmp}/pi-tower-sqlite-fixture.XXXXXX")
trap 'rm -rf "$FIXTURE"' EXIT INT TERM
PATH=$(dirname "$NODE_BIN"):$PATH
export PATH

NODE_MAJOR=${NODE_VERSION#v}
NODE_MAJOR=${NODE_MAJOR%%.*}
if [ "$NODE_MAJOR" -lt 22 ]; then
	echo "expected Node >=22, got $NODE_VERSION" >&2
	exit 1
fi

printf '{"private":true}\n' > "$FIXTURE/package.json"
NPM_CLI=${NPM_CLI:-$(dirname "$(dirname "$NODE_BIN")")/lib/node_modules/npm/bin/npm-cli.js}
if [ ! -f "$NPM_CLI" ]; then
	NPM_CLI=$(command -v npm)
fi
"$NODE_BIN" "$NPM_CLI" pack better-sqlite3@13.0.3 --pack-destination "$FIXTURE" >/dev/null
"$NODE_BIN" "$NPM_CLI" install --prefix "$FIXTURE" --save-exact --ignore-scripts=false "$FIXTURE/better-sqlite3-13.0.3.tgz"
SQLITE_PROBE_FIXTURE="$FIXTURE" "$NODE_BIN" test/compat/sqlite-phase0-probe.mjs
