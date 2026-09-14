# Cloud Threads 實作與驗證紀錄

第 1～3 階段的主要路徑已實作，第 4 階段仍待完整容器與驗收矩陣收尾；**尚不宣稱 v1 完成**。依據 [v1 規格](specs/cloud-threads-v1.md) 與 [第 0 階段決策](cloud-threads-phase0.md)。使用者已授權接續各階段及本機 commit，未授權 push、部署或發布。

## 持久化與還原契約

Managed mode 明確啟用，legacy relay 保留原有使用方式。實測 pi 0.85.1、Node 22.22.0／26.8.2、better-sqlite3 13.0.3；只測過這個 pi 版本，不把它稱為最低支援版本。Tower 使用單一 SQLite，schema version 3、WAL、FULL、1250 ms busy timeout。沒有 S3。

Runner 用公開 SDK 開啟 session，再套用 `branch(leafId)` 或 `resetLeaf()`，驗證 session ID、完整 entries 與原 cwd 後接上公開 `runRpcMode`。沒有修改 pi 核心或使用私有 API。Header-only JSONL 讓空白 thread 也有持久身分；整份 registry／JSONL／checkpoint 先寫進暫存目錄，再以 rename 一起發布。建立時 crash 留下的 `.prepare-*` 不會成為 runtime，也不阻止已發布的 thread 重啟。

每個 settled 與正常關閉都保存完整 checkpoint。`message_end` 後延遲 50 ms 合併擷取，避開 pi 尚未 append entry 的時序；同步 outbox 保存原始 bytes，重傳不重新序列化。雲端 ack 只在 BLOB、revision/hash、latest 指標與舊 BLOB 清除的同一筆交易提交後回覆。清除只移除完整涵蓋的舊 BLOB，entries、命令收據與 revision/hash 索引皆保留。

Wrapper 持有 `writer.sqlite` 獨占交易；每個 child 在讀 session 前持有自己的 `runtime.sqlite`，直到作業系統完成程序退出。重啟先取得 wrapper 鎖，再逐一確認舊 child 鎖可取得。未能確認就拒絕啟動，不能靠 PID 或時間猜測。舊版只有目錄標記、沒有 kernel-v1 標記的鎖仍拒絕自動接管。只支援本機檔案系統，不支援跨主機複製 runner 資料。

Crash 復原保留已驗證 checkpoint 與完整 append suffix；若沒有新增 entry，沿用獨立保存的 leaf。有新增 entry 時，驗證舊 entries 是完整前綴，再以最後 append 的 entry 作為復原 leaf。壞行、未完成尾行、錯誤 parent／leaf 或不同前綴一律拒絕，不丟棄資料。未完成命令標示 unknown／interrupted，不重播。

## Revision 與 ownership 不沿用舊操作權

Revision 採 `{generationId, counter}`。Runner 每次啟動取得隨機 generation；每次新快照先持久保存 bytes 與 counter，舊 outbox 仍用原本版本。跨 generation 以 predecessor revision/hash 串接，不比較 UUID 或 timestamp。Ownership 採 `{incarnation, connectionId, bootId, counter}`：Tower 重啟與 runner 重連都換發不從備份載入的隨機身分，先對帳收據與 inventory，再開放命令。這是 CSPRNG 的低碰撞機率保證，不是數學上的零碰撞。

Tower 還原較舊備份時，原 runner 下載並驗證雲端 head，確認本機完整涵蓋雲端與 pending entries，才以新 generation 補傳。本機資料不會被雲端覆寫；舊 outbox 另存 `reconciled-*.json` 作為證據。分歧就停用寫入。備份後才建立、雲端目錄已不存在的 thread 保留在 runner，停止同步並記錄 `thread_missing_from_catalog`，其他 thread 仍可對帳。需較新的 Tower 備份才能恢復那些目錄項目，不自動匯入。

雙方若都失去較新的收據，備份無法證明工具曾做過什麼。新的 generation／ownership 防止舊操作權再次生效，並不能復原遺失的資料或提供工具副作用 exactly-once。

## 可重現測試與證據

執行 `npm run verify:phase0`，它會在隔離 HOME、pi profile 與 workspace 執行完整 `verify`，不使用真實使用者憑證。`PI_COMPAT_PACKAGE` 可指定已安裝的 pi 套件。測試不同 Node 時，需在隔離 checkout 用該 Node 執行 `npm ci`，避免沿用另一個 Node ABI 的 native module。

最終原始碼已在 Node 22.22.0 與 26.8.2 各跑過完整隔離套件，全部通過；`npm pack --dry-run` 與 `git diff --check` 也通過。Node 22 使用獨立安裝的 native dependencies，沒有共用 Node 26 的 ABI。

| 測試 | 實際使用的元件與涵蓋範圍 |
| --- | --- |
| 四個 legacy verify scripts | Relay、extension、CLI 與套件載入；真實 pi 的 no-LLM chain 另有獨立檢查 |
| `test/compat/verify-pi.mjs` | 真實 pi CLI／SDK + faux provider：session ID、完整分支、compaction、custom entry、leaf、cwd、空白 session、事件順序、四種基本 dialog、UTF-8 framing |
| `test/verify-managed.mjs` | 真實 SDK／RPC + faux provider：多輪續接、TTL、無 viewer 同步、Tower 離線補傳、原 cwd 重啟、metadata、接手、缺檔還原、損毀最新快照拒絕、WS 超限、cookie／Origin／CSRF |
| 同上，命令故障測試 | 在 received 保存前後、dispatching、RPC send 前後、accepted、settled 共 7 個邊界 SIGKILL wrapper；重啟後以同 ID 查詢／重送，unknown 不重播，已持久 settled 保留 |
| 同上，child 故障測試 | SIGSTOP 真實 pi child 後 SIGKILL wrapper，重啟拒絕第二個 writer；child 真正退出後才恢復。Pending dialog 消失、舊回覆被拒絕，需明確新 prompt 才啟動 runtime |
| 同上，備份演練 | 活躍 WAL 使用 backup API；全新 Tower 目錄驗證 metadata／收據／hash／leaf，原 runner 補回備份後進度，舊 ownership 被拒絕，目錄孤兒不阻止其他 thread |
| `test/verify-prepare-crash.mjs` | Fake package、無 pi child：空白 thread 原子發布前後 SIGKILL；已發布身分不重新配發 |
| `test/verify-journal.mjs` | 真實檔案 journal：各持久狀態重啟、payload 衝突、舊 boot 不確定命令、UTF-8 文字大小邊界 |
| `test/verify-snapshots.mjs` | 真實 SQLite：分支前綴、錯誤 parent／leaf／format／UTF-8、重傳、版本過期、配額邊界、hash 損毀、backup API |
| `test/verify-snapshot-crash.mjs` | 真實 SQLite：6 個交易內 SIGKILL 點與 commit 後 ack 遺失；清除／重傳；用 max_page_count 觸發 SQLITE_FULL；跨程序寫入鎖；1 MiB payload 與 DB／WAL 量測 |
| `test/verify-managed-limits.mjs` | Fake HTTP／WS transport + 真實 SQLite：upload concurrency、磁碟警戒、大小上限、連線身分、slow viewer buffer、使用量欄位 |

這些測試沒有付費 LLM 呼叫。SQLite FULL 測試不是把主機磁碟塞滿；SIGKILL 測試不是斷電測試。1 MiB payload 提交加讀取曾量到 Node 26 約 4.7 ms、Node 22 約 8.2 ms，DB 20480 bytes、WAL 1071232 bytes；只代表當次本機量測，不是延遲承諾。

## 瀏覽器驗證

啟動 `node test/compat/browser-fixture.mjs`，使用它印出的 URL 與一次性 fixture token。兩個獨立瀏覽器 session 登入同一 thread，其中一個設為 390 × 844。送出 `smoke-write`，faux provider 會要求**真實 pi bash 工具**在隔離 cwd 寫出 `smoke.txt`；`smoke-check` 讀取同一個檔案與 cwd，`dialog` 產生 pending confirm。

已操作並檢查：建立與多輪輸入、手機／桌機接手、舊裝置停止與 dialog 控制停用、接手後回答原 dialog、Tower 重啟重連、runner 離線仍讀歷史且不能輸入、runner 重啟後再次讀到測試檔案。Fixture 的控制 URL 接受 POST `/restart-tower`、`/runner-offline`、`/runner-online`；結束時 POST `/stop` 清除隔離資料。不要把這些控制路由當成產品 API。

另以 `smoke-write-slow` 延遲工具執行 5 秒，確認畫面顯示 RUNNING 後關閉所有測試頁面。工具仍完成寫檔，重新登入後看得到結果，接著送出 `smoke-check` 讀到同一檔案。第一次未等命令接收就關頁的嘗試沒有執行，不列為通過；本測試證明已接收工作不依賴頁面存活，不承諾瀏覽器尚未送達的請求也會執行。

桌機與手機截圖均已用 view_media 檢查。修正過 composer 擋住 dialog 按鈕的問題，並實際點擊確認；工具結果改成可展開文字，保留原始快照內容。證據：`assets/cloud-threads-desktop.png`、`assets/cloud-threads-mobile-dialog.png`、`assets/cloud-threads-mobile-title.png`。

## 尚未完成的驗收

- A24 的完整 Docker image 重建、容器 volume 備份還原尚未執行。第 0 階段 Alpine driver probe 已通過，但不能替代產品 image。OrbStack 處於停止狀態；之前啟動會連帶啟動三個既有 VictoriaLogs 容器，未經確認不再啟動。
- A11 已涵蓋上述 7 個 runner 命令邊界；尚未逐一注入 Tower 每個 SQL／網路回覆邊界，以及兩份備份同時退回後的延遲 abort／dialog 訊息。
- A18／A26 已涵蓋可設定大小／配額邊界、SQLite FULL、鎖定及 fake slow viewer；尚未跑預設 64 MiB／1 GiB 規模、真實慢速網路及 runner fsync 的 ENOSPC／EIO 注入。
- A22 的 metadata／搜尋／封存已測；大量清單多頁翻動與同時更新的完整組合尚未測。
- 真實 provider 的重試／自動壓縮長流程、Windows／其他檔案系統與實體手機 Safari 尚未驗證。這些結果不能從 faux provider 或桌面窄視窗推論。

產品範圍沒有新的待確認事項；剩餘工作是驗證與依結果修正。部署、容量、停止後備份與最新快照還原限制見 [README](../README.md)。規格的完成定義照舊，不能因上述測試通過就把 A01～A27 全部標成完成。
