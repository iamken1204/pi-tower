# Cloud Threads 實作進度

依據 [v1 規格](specs/cloud-threads-v1.md) 與 [第 0 階段決策](cloud-threads-phase0.md)。2026-09-14 使用者授權：若沒有重大阻擋，接續完成第 2～4 階段；可自行整理及提交本機 commits，仍不得 push、部署或發布。

## 第 1 階段

Tower 以 `--data-dir` 啟用 SQLite thread 目錄。Runner 明確使用 `--managed-threads --data-dir`，保留獨立 legacy 通道。Managed child 使用 pi 0.85.1 公開 SDK 建立 runtime，再接上公開 `runRpcMode`；沒有私有 API 或核心修改。

每個 thread 預先建立 header-only JSONL，讓空白 thread 也有持久 session ID。Runner 的 `instance.json` 保存 instance ID、runner ID 與主機名；每次啟動另產生 boot ID。Thread record 保存固定 cwd 與由 runner 產生的路徑；換 cwd 啟動 wrapper 不會移動既有 thread。Checkpoint 保存完整 entries、hash 與獨立 leaf，還原前逐筆檢查 JSONL，不容許 pi 略過壞行後繼續。

資料目錄的 `writer.lock` 以獨占建立保護，**不自動偷取舊鎖**。只在正常關閉所有 managed child、收到關閉 checkpoint 且確認 child 退出後解鎖。SIGKILL、spawn 失敗或退出不明會保留鎖，後續 wrapper 拒絕啟動。這是暫時的保守安全界線，不是 supervisor 自動復原；不要依 PID 或鎖的年齡手動刪除。跨主機複製仍不支援。

第 1 階段程式化介面：

- Bearer `POST /api/threads`：`runnerId`、`idempotencyKey` UUID、可選 `title`。重複建立回傳同一 thread；相同 key 不同內容拒絕。
- Bearer `GET /api/threads`、`GET /api/threads/:id`：持久 metadata，不啟動 child。
- Bearer `WS /managed/client?thread=<UUID>`：`{version:1, requestId:<UUID>, operation, message?}`。允許 `state`、`entries`、`prompt`、`abort`、`release`、`sleep`；單一連線，禁止任意 raw RPC 與 slash command。
- Runner 使用獨立 `/managed/runner`，以版本、instance、boot、connection nonce 與 inventory 對帳。可偵測的重複註冊拒絕，不取代既有 managed runner。

此介面仍是開發中的階段成果；尚無持久 command receipts、雲端 snapshot 或瀏覽器 ownership，不能宣稱命令可靠性已完成。`requestId` 只作關聯，不是第 2 階段 command ID。

實測：`node test/verify-managed.mjs` 使用隔離 profile、workspace、SQLite 及真正 pi SDK/RPC，provider 回答固定，沒有 LLM 費用。通過空白身分、建立冪等、目錄與 runner 重啟、原 cwd、多分支與非尾端 leaf 接續、TTL 休眠、busy 無輸出時不休眠、缺檔／壞檔拒絕、legacy namespace 拒絕，以及同資料目錄雙 wrapper／SIGKILL 後拒絕第二個 writer。`npm run verify:phase0` 已納入新增測試；既有回歸通過。`npm pack --dry-run` 包含全部 managed 模組。

新增 managed 跨程序測試在 Node 22.22.0 與 26.8.2 均通過。

Dockerfile 已補齊 SQLite 與 runtime imports，但本階段尚未重建完整產品 image。第 0 階段已驗證相同 Alpine/driver 安裝，不能取代新版產品 image 驗證。後續仍須完成第 2～4 階段、容量／備份／故障注入與瀏覽器驗收。
