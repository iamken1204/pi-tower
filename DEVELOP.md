# Local Development

從 repo 根目錄執行。Bun >= 1.4.2；pi 需先設定模型與登入。

## 安裝

```sh
bun install
```

Runner 用的 pi 0.85.1 已在 devDependencies，不必另外全域安裝；要換成別的 pi 目錄時加 `--pi-package <目錄>`。舊的 relay 模式（`-- <pi args>`）用的也是同一份。

`--no-env-file` 讓 Bun 不要把目前目錄的 `.env` 讀進 Tower 或 Runner 的環境變數。

## 單一執行檔（選用）

```sh
bun run build:runner          # 產生 dist/pi-runner，內含 pi 0.85.1
dist/pi-runner --hq ws://127.0.0.1:9000 --id local-native --token local-dev
```

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
