# Local Development

從 repo 根目錄執行。Node.js >= 22.22.0；pi 需先設定模型與登入。

## 安裝

```sh
npm ci
npm install -g @earendil-works/pi-coding-agent@0.85.1
```

## Tower（終端機 1）

```sh
node src/tower.mjs \
  --port 9000 \
  --token local-dev \
  --data-dir "$HOME/.pi-tower-dev/tower"
```

## Runner（終端機 2）

```sh
node src/runner.mjs \
  --hq ws://127.0.0.1:9000 \
  --id local-native \
  --token local-dev \
  --data-dir "$HOME/.pi-tower-dev/runner-native"
```

## Runner（選用，支援瀏覽器新增對話）

另開終端機。

```sh
node src/runner.mjs \
  --hq ws://127.0.0.1:9000 \
  --id local-web \
  --token local-dev \
  --data-dir "$HOME/.pi-tower-dev/runner-web" \
  --managed-threads
```

## UI

<http://127.0.0.1:9000/threads>，登入權杖 `local-dev`。
