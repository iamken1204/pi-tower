# Local Development

從 repo 根目錄執行。Bun >= 1.4.2；pi 需先設定模型與登入。

## 安裝

```sh
bun install
npm install -g @earendil-works/pi-coding-agent@0.85.1
```

`--no-env-file` 讓 Bun 不要把目前目錄的 `.env` 讀進 Tower 或 Runner 的環境變數。

## Tower（終端機 1）

```sh
bun --no-env-file src/tower.mjs \
  --port 9000 \
  --token local-dev \
  --data-dir "$HOME/.pi-tower-dev/tower"
```

## Runner（終端機 2）

```sh
bun --no-env-file src/runner.mjs \
  --hq ws://127.0.0.1:9000 \
  --id local-native \
  --token local-dev \
  --data-dir "$HOME/.pi-tower-dev/runner-native"
```

## Runner（選用，支援瀏覽器新增對話）

另開終端機。

```sh
bun --no-env-file src/runner.mjs \
  --hq ws://127.0.0.1:9000 \
  --id local-web \
  --token local-dev \
  --data-dir "$HOME/.pi-tower-dev/runner-web" \
  --managed-threads
```

## UI

<http://127.0.0.1:9000/threads>，登入權杖 `local-dev`。
