# Cloud Threads v1 handoff spec

狀態：功能已在 main，驗收尚未完成；未涵蓋的項目列在[實作與驗證紀錄](progress.md)文末。以下保留 2026-09-14 交接時的原文，文中「尚未實作」「只有規格」描述的是當時。第 3、15 節的檔案路徑與行號以 commit `21b378e` 為準，原始碼現在在 `src/`。第 6、8、9、10 節與 A10、A19 的操作權流程已由下一節的修訂取代。

## 2026-09-15 使用者確認的互動模式修訂

本節取代下文與其衝突的 browser-first、單一 driver、操作權交接與完整 editor dialog 要求；其餘持久化、驗證、去重、legacy 相容性及不修改 pi 核心的限制仍適用。這是新目標，不代表目前程式已完成。

- 以本機互動式 pi runner 為核心。本機啟動的同一個 thread 可從原生 TUI 與網頁直接傳送訊息，兩端看到相同對話與執行結果，不另外啟動第二個 session 或 writer。
- 不提供 Get control、Release control、Take over 或相同功能的前置流程。多個輸入端不代表多個 writer；系統負責命令排序、去重及過期訊息防護。
- 執行中仍可輸入；預設排入 follow-up 佇列，另支援 steering 與停止。不能僅移除按鈕而保留「忙碌時禁止輸入」的行為。
- Runner 的實際存活與連線決定網頁能否執行。沒有 orb、跨主機接手或替代 runtime；runner 不可用時，網頁顯示不可執行且不受理新工作留待日後執行。已送出但結果不明的命令不自動重播。
- 關閉網頁不影響本機 pi；Tower 斷線時，本機仍可輸入與執行，恢復連線後補同步。這不承諾主機休眠、程序退出後工作仍在執行。
- Extension 的 select／confirm／input 須能在任一端回答，第一個有效回答後關閉另一端的提示，拒絕過期回答。
- 不支援 extension `ctx.ui.editor()` 的跨端同步與網頁回答。本機功能保留，網頁只提示須在本機完成。這不限制一般聊天輸入框。

## 1. 交付目標

在不修改 pi 核心的前提下，讓使用者透過 pi-tower 瀏覽持久化的 thread 清單、閱讀雲端歷史，並從另一台裝置繼續同一個遠端工作。

工作始終在原本的 runner 與工作目錄執行。使用者換的是操作裝置，不搬移 repo 或執行環境。

本文件是交給實作者的功能與行為契約。使用者已確認上述產品範圍；以下資料模型、協定與實作分期是建議採用的工程決策。需要改變使用者可見行為時，先更新規格並取得確認。

- 程式碼基準：`main`，commit `21b378e`，pi-tower `0.3.0`。
- API 調查基準：本機 pi `0.85.1`。最低支援版本必須由相容性測試確認，不可只依文件宣告。
- 儲存決策：v1 的 Tower 持久資料全部放在單一 SQLite 資料庫；S3-compatible snapshot storage 延後，不列入本版實作。
- 本次交付只有規格，不包含功能實作。

### 使用者完成路徑

1. 在筆電瀏覽器登入 Tower，選取 runner，建立 thread 並送出問題。
2. 看見串流回答、工具執行狀態與同步狀態。
3. 關閉頁面，runner 繼續工作。
4. 用桌機或手機登入同一個 Tower，從清單開啟該 thread，閱讀已保存的前文。
5. 取得操作權後繼續提問，pi 保留同一個對話脈絡，工具仍在原 runner 執行。
6. 即使 pi 程序因閒置而關閉，或 runner 程序重新啟動，也能從保存的紀錄繼續。

## 2. 範圍與非目標

### v1 必須交付

- 桌機與手機瀏覽器可用的 thread 清單、歷史檢視與聊天介面。
- 建立、重新命名、封存與取消封存 thread；以標題搜尋，依 runner 篩選。
- Tower 持久保存 thread 目錄與對話快照。Runner 離線時仍可閱讀最後同步的歷史。
- 固定 runner 上的本機持久化、程序重啟還原、斷線重連與同步補傳。
- 同一 thread 可有多個唯讀檢視者，但只有一個操作裝置。
- 操作權交接、重複命令辨識，以及未能確認命令是否執行時的明確提示。
- 保留既有 `runner_list`、`runner_task`、`pi-task` 與 raw RPC relay 的既有使用方式。
- 文件化部署、備份、復原步驟與資料耐久性界線。

### v1 不做

- 將本機互動式 pi 的所有 sessions 自動上傳；既有 `runner_task` 呼叫者的本機對話也不會自動合併。
- 在另一台 runner 執行同一 thread、runner 自動容錯移轉、repo／未提交修改／憑證同步。
- 多人帳號、團隊 ACL、公開分享連結、即時共同編輯或多寫入者合併。
- 瀏覽器版 `/tree`、fork／clone 操作、任意 pi slash command、完整 TUI 擴充元件重現。
- 圖片上傳、任意檔案下載、終端機畫面、推播通知、全文檢索。
- 自動重播在 crash 前可能已經執行的 prompt 或工具呼叫。
- 硬刪除 thread 或刪除對話 entries。允許清除被新版完整涵蓋的舊快照，不要求永久保存每個快照版本；v1 的「封存」只影響清單，不刪資料。
- 任意回溯對話版本。雲端還原只用於本機 session 檔案遺失後的復原，不提供退回舊 revision 的操作。
- S3／Garage 整合、獨立快照檔案後端，以及可插拔的多儲存後端框架。

不支援將主機 A 的 runner 資料目錄複製到主機 B 後繼續使用，即使 A 已停止也不支援。複製目錄不是 thread 搬移或 runner 災難復原方式；原主機上的重啟與本機 session 遺失還原仍依第 7 節處理。

瀏覽器是第一個完整操作介面。新的 TUI thread picker 與 managed-thread CLI 可以後續新增，不列入 v1 完成條件。

## 3. 現有程式與限制

| 位置 | 已有行為 | 實作時的影響 |
| --- | --- | --- |
| `tower.mjs:57–110` | 記憶體中的 runner/session 清單 | 不能拿 live connection map 當持久 thread 目錄 |
| `runner.mjs:55–84` | session 名稱對應 `pi --mode rpc` 子程序 | 缺少 thread ID、pi session ID、檔案路徑的持久對應 |
| `tower.mjs:257–274` | detached session 閒置後關閉程序 | managed thread 必須保存後才能休眠，不得刪除 thread |
| `tower.mjs:324–333` | 沒有 client 時丟棄轉送輸出 | 新功能不能靠瀏覽器在線才能同步 |
| `lib.mjs:25–60` | attach、prompt、取最後回答、detach | 既有 helper 沒有歷史回放、重連或命令去重 |
| `ui.html` | runner/session 狀態檢視器 | 需要新增歷史與聊天介面，保留原有操作功能 |
| `tower.mjs:88–92,215–229` | UI cookie 與 Bearer WS 驗證分開 | 瀏覽器不能直接用現有 `/attach` 完成 cookie 驗證 |
| `compose.yml` | Tower 與 tunnel，無資料 volume | 雲端保存必須新增持久 volume 與備份說明 |

既有同名 session 接續只保證仍存活的子程序脈絡。省略 `--no-session` 雖可讓 pi 在 runner 留下紀錄，仍不等於自動重啟還原。

## 4. 架構與資料所有權

```text
Browser A / Browser B / Mobile
          │ HTTPS + authenticated WebSocket
          ▼
Tower
  ├─ SQLite: thread catalog + command receipts
  ├─ SQLite BLOBs: immutable conversation snapshots
  ├─ browser read/drive ownership
  └─ runner routing
          │ outbound runner connection + sync upload
          ▼
Fixed runner
  ├─ managed-thread registry + command journal + sync outbox
  ├─ one pi RPC child per awake thread
  └─ persistent pi sessions + existing working directory
```

保留既有 raw relay。另加版本化的 managed-thread 協定，由 runner wrapper 代理 pi 的公開 RPC；Tower 不解析或改寫 legacy pipe 的 pi 訊息。

### 名詞

- **Thread**：持久的對話身分。關閉頁面、關閉 pi 程序、Tower 重啟都不會刪除它。
- **Runtime**：目前為 thread 執行的 pi 子程序。可以建立、休眠與重建。
- **Snapshot**：可重建對話的完整快照，包含 header、所有 entries 與 active leaf；不只是畫面文字。
- **Run**：一次 prompt 所啟動的工作，直到 pi 完全 settled 或被標記中斷。Run 可跨瀏覽器連線存活。
- **Drive ownership**：某個瀏覽器連線對 thread 的操作權，不是 runner 對 thread 的資料所有權。

### 固定決策

1. 每個 thread 綁定一個持久的 runner instance 與一個工作目錄。v1 使用該 runner 啟動時的 cwd；瀏覽器不能任意指定伺服器路徑。
2. Runner 是執行狀態與 session entries 的唯一寫入者。Tower 保存雲端副本，擁有 thread 標題、封存狀態及瀏覽器操作權。
3. Thread 使用不透明 UUID，不以標題、legacy session 名稱或絕對路徑當作身分。
4. 同一 runner ID 的不同 instance 不得同時註冊。Instance ID 保存在 runner 資料目錄，程序重啟時不變；每次啟動另外產生 boot ID。同一 instance 可同時有多條連線（多個終端機），每個 thread 同時只由一條連線 host。
5. Tower 重連時可重建連線表，但不得因此建立第二份 runtime。Headless wrapper 啟動時鎖定整個資料目錄，避免兩個 wrapper 共用資料啟動重複 child；終端機只鎖定自己 host 的 thread。
6. v1 採單一 Tower 程序與持久磁碟。橫向擴充及多 Tower 主動寫入不在範圍內。

### 儲存選擇

Tower 的 thread 目錄、命令收據、快照索引及完整快照內容全部放在單一 SQLite 資料庫。快照序列化為 UTF-8 JSON bytes，以不可變 BLOB 保存；v1 不另外保存權威快照檔案，也不接入 S3。

「全部使用 SQLite」只限 Tower 的持久應用資料。Runner 保留 pi 原生 JSONL，不把正在使用的 session 改存 SQLite；runner registry／journal 仍須在本機持久保存身分、session 路徑、命令狀態與待同步版本，格式由實作者決定。連線、browser ownership 與可重建的 live runtime 狀態仍可放在記憶體，重啟後依原有契約失效或對帳。

SQLite driver 由第 0 階段選定，必須在套件宣告的 Node 版本與 Docker 映像中通過安裝及重啟測試。若採 native dependency，要驗證 npm 發布與容器建置；不可默默提高 Node 最低版本。資料庫使用本機持久 volume，啟用 WAL、`synchronous=FULL`，並設定有上限的 busy timeout；不得因鎖定逾時而跳過交易或提前回覆成功。

快照 BLOB、revision/hash 索引及 thread 最新快照指標必須在同一筆交易內提交，cloud ack 只在 commit 成功後發出。程序 crash 或磁碟寫入失敗時，讀取者只能看到完整舊版本或完整新版本，不能看到缺少內容的最新指標。網路接收、序列化、hash 計算與驗證放在交易外，避免長時間持有寫入鎖；revision/hash 衝突檢查仍須在交易內完成。

### 備份、容量與後續擴充

備份使用所選 driver 的 SQLite backup API、`VACUUM INTO`，或先正常關閉所有資料庫連線再複製。不得在資料庫運作時只複製主 `.sqlite` 檔案而忽略 WAL 中已提交的資料。整個資料目錄（含 WAL 等工作檔案）位於持久 volume；還原時停止 Tower，以一致備份復原，驗證資料庫完整性與快照 hash 後再啟動。

完整快照會重複包含較早的 entries。Tower 允許清除被已提交新版完整涵蓋的舊快照 BLOB，但不得刪除對話 entries。清除前須驗證同一 thread/session 的新版保留舊版全部 entries 的內容、順序與 parent 關係，包含其他分支、compaction 與未知 entry；不能只比較 revision 或 entry 數量。新版保存自己的 active leaf，不要求永久保留舊版的 leaf 選擇。新版未成功提交前不得清除舊版，且始終保留最新完整快照。清除 BLOB 不刪除命令收據，並保留 revision/hash 去重紀錄；已清除版本的同 hash 重傳不重建 BLOB，不同 hash 仍須拒絕。

v1 必須提供可設定的快照總量配額、磁碟剩餘空間警戒與使用量資訊，並文件化舊快照清除時機。清除後仍不足以容納新快照時，明確拒絕新的快照及新工作，保留既有 entries 並依第 11 節呈現錯誤。容量評估同時列出 BLOB 總量、資料庫主檔及 WAL 大小，並預留新舊快照交替、交易、WAL checkpoint 與備份所需空間。刪除 BLOB 不代表 SQLite 主檔立即縮小，文件須區分可重用頁面與磁碟可用空間。單份快照超限不能靠清除舊版本解決，須調高上限並確認資源足夠後才能繼續，不得截斷 entries。WAL checkpoint 要有明確策略，避免長時間讀取讓 WAL 持續膨脹。

快照讀寫集中在一個模組，thread 清單只查 metadata，不載入 BLOB；HTTP／WebSocket API 不暴露 SQL row ID、BLOB 欄位或檔案路徑。保留獨立的 schema version、revision 與 hash，讓後續可以遷移快照內容。現在不實作多後端介面、S3 設定或雙寫。未來改用 S3 時，另訂上傳、指標提交及遷移契約，不能假定跨 SQLite／S3 仍有同一筆交易。

「雲端」指部署 Tower 的主機及其持久 volume，不要求特定雲端產品，也不把 Cloudflare Tunnel 當成儲存服務。

## 5. 最小資料模型

以下是邏輯欄位，不要求照表拆成獨立 SQL tables。

### Thread

| 欄位 | 用途 |
| --- | --- |
| `threadId` | 全域 UUID |
| `runnerId`, `runnerInstanceId` | 路由名稱與固定執行者身分 |
| `workspaceId`, `cwd` | runner 配發的工作目錄識別與其絕對路徑；瀏覽器看得到路徑，建立 thread 時只能從 runner 已知的目錄挑選，不能自行輸入 |
| `title`, `archivedAt` | Tower 管理的顯示資訊 |
| `createdAt`, `updatedAt` | 建立時間與最後活動時間；heartbeat 不更新排序 |
| `piSessionId` | 第一次 runtime 建立後記錄，之後還原必須一致 |
| `latestSnapshotRevision` | Tower 已提交的最新快照版本，可為空 |
| `metadataVersion` | 標題／封存更新的樂觀鎖版本 |

Runner registry 額外保存 `threadId → sessionFile, effectiveCwd, piSessionId, localRevision`。路徑由 runner 產生並限制在自己的資料目錄，不採用瀏覽器傳入的路徑。

### Snapshot

- `schemaVersion`、`threadId`、`piVersion`、session format version。
- 由 runner 持久遞增的 `revision`，以及內容 `sha256`。
- 原始 session `header`、完整 append-order `entries`、`leafId`。
- `capturedAt`、對應的 `runId`（若有）、是否為 settled checkpoint。
- 包含 pi 原本的 message、tool result、compaction、custom entry 與其他 entry 類型；不要用自行簡化的 chat schema 取代。
- Tower 保存上述完整 envelope 的 BLOB 與 byte length；`sha256` 對確定的序列化 bytes 計算，hash 本身放在外層索引，避免自我引用。相同版本重傳必須沿用原 bytes。
- `(threadId, revision)` 設唯一約束；相同版本重傳不得新增重複 BLOB。供清單、排序及版本查詢的 metadata 有獨立索引。

`revision` 是同步順序；timestamp 不能用來判定新舊。相同 revision/hash 的重傳是冪等操作，相同 revision 不同 hash 必須拒絕。較舊版本不能覆蓋最新指標。

### Command 與 Run

- `commandId`：瀏覽器產生的 UUID，整個 thread 內唯一；重連查詢沿用同一個 ID。
- `runId`：prompt 的執行識別，可直接採用該 prompt 的 command ID。
- 記錄 thread、命令類型、payload hash、ownership epoch、runner boot ID 與狀態。
- 同一 command ID 搭配不同 payload 必須拒絕。
- Run 結果分成 `settled`、`aborted`、`interrupted`；是否回答成功另依 pi 結果呈現，不能把 settled 一律顯示為成功。

## 6. 狀態與正常流程

不要把連線、執行與同步塞進單一 status 欄位。

| 面向 | 狀態 |
| --- | --- |
| Runner 連線 | `online`、`offline` |
| Thread runtime | `sleeping`、`starting`、`idle`、`running`、`waiting_input`、`interrupted`、`error` |
| 同步 | `pending`、`synced`、`error` |
| 瀏覽器操作權 | `viewer`、`driver` |

### 建立與第一次送出

1. 使用者選取支援 managed threads 的 online runner，送出帶有 idempotency key 的建立請求。
2. Tower 持久保存 thread，再要求固定 runner 準備 registry。建立請求重送不得產生第二個 thread。
3. Runner 使用獨立且持久的 session 路徑啟動 `pi --mode rpc`，驗證 cwd、pi 能力與 session ID。
4. 瀏覽器取得操作權，送出帶有 command ID 的 prompt。
5. Tower 與 runner 依第 8 節保存命令收據，再交給 pi。
6. Pi 事件轉送給所有檢視者。Runner 獨立保存與同步歷史，不依賴瀏覽器連線。
7. `agent_settled` 後取得權威 entries 與 leaf，保存並上傳快照。Tower 提交後才顯示「已同步」。

Thread 剛建立、尚未收到 assistant 回應時，pi 可能還沒有建立磁碟 session 檔案。空白 thread 與已受理的 prompt 仍須有持久身分及收據；恢復時不能假定 session 檔案必定存在。

### 閱讀與接續

1. 開啟頁面先讀取 Tower 保存的歷史，runner 離線也適用。
2. 建立 WebSocket 訂閱，與 runner 對帳後取得較新的 checkpoint／runtime state。
3. 使用者取得操作權。若 runtime 已休眠，runner 以原本 cwd 與 session 紀錄重建。
4. 驗證還原的 pi session ID、entries 與 active leaf，再允許新 prompt。
5. Runtime 若仍在工作，顯示目前進度；v1 不排隊新 prompt，只提供停止及必要的 extension dialog 回覆。

### 閒置、封存與停止

- 瀏覽器 detach 不送出 abort，不關閉 runtime。
- Managed thread 的 TTL 只適用於無 driver 且 runtime idle 的情況。正在執行工具、等待 extension 回覆或壓縮時，即使很久沒有輸出也不能只靠 TTL 終止。
- TTL 到期時，runner 完成本機 checkpoint 並記錄待同步版本後可結束 child；雲端斷線不必永久阻止休眠。
- 「停止」要求 pi abort，等待 settled／idle；它不表示 shell 外部副作用已復原。
- Runner 收到正常關閉訊號時，先停止受理命令，在有上限的寬限時間內要求正在工作的 pi 停止並保存 checkpoint，再結束程序。超時或強制終止的 run 留下中斷標記，重啟時走 interrupted／unknown 對帳，不能回報正常完成。
- 「封存」只更改清單。Running 或 waiting_input 的 thread 拒絕封存，要求先停止或等待完成。封存後禁止新 prompt，取消封存即可再操作。
- Legacy UI 的 close session 保留原意；managed thread 使用「休眠」或「停止」字樣，不能共用會讓使用者誤認刪除對話的按鈕。

## 7. 歷史同步與還原契約

### 可使用的 pi 公開介面

實作優先保留 RPC 子程序架構：

- `get_state`：確認 session ID、session 檔案與 runtime 狀態。
- `get_entries`／`get_entries {since}`：完整 entries 及 `leafId`，含壓縮前歷史和其他分支。
- `switch_session` 或啟動時 `--session`：載入本機 session。
- `agent_settled`：完整 run 收束訊號；不要把較早的 `agent_end` 當作一定結束。

`get_messages` 是目前 context 的投影，不是完整備份。JSONL export 的行為可能只有 active branch，也不能直接當 full-tree snapshot。

### Checkpoint 規則

- 每個 run settled 後都必須保存完整 checkpoint；正常休眠與關閉前也必須保存。
- Running 時在完整 message／tool result 可讀取後合併擷取 checkpoint，健康連線下目標為 5 秒內保存新完成的 entries。Token delta 只供即時畫面，不要求逐 token 持久化。
- 事件 callback 的執行順序必須實測。有些 pi `message_end` callback 早於 entry 寫入；需要排程稍後讀取或在 settled 再對帳，不能假定 callback 當下的檔案已完整。
- 每次同步帶完整 snapshot；v1 不實作雲端 entry merge。可用 RPC cursor 降低 runner 本機讀取成本，但雲端保存物件仍須能獨立還原。
- Runner 斷線時保留最新完整待同步快照，重連補傳；可以合併尚未上傳的中間快照，不能刪除命令收據或唯一的完整 session 紀錄。
- Cloud ack 必須在包含快照 BLOB、索引及最新指標的 SQLite 交易提交後發出。UI 同時顯示「工作完成」與「尚未同步」，不能把兩件事混在一起。

### Active leaf 與完整性

Pi 的磁碟 JSONL 不一定單獨持久保存純分支切換後的 active leaf。Snapshot 必須另存 `leafId`，還原後也必須驗證。

V1 不開放 tree navigation／fork／clone，但不能因此丟棄已有分支或未知 entry。第 0 階段要驗證選定 pi 版本在本功能允許的操作下能否精確還原；若 RPC 不足，可使用公開 extension checkpoint API 或 SDK 的 session restore 能力。不准修改 pi 核心、不准靠 monkey patch 私有方法，也不准忽略 leaf 差異繼續提問。需要調整 runner 架構時，先記錄技術決策。

下載快照時驗證 schema、hash、thread/session 身分、entry ID 唯一性、parent 引用與 leaf 存在性。損毀、缺少必要 entry 或不支援的格式要報錯，不能因 pi parser 可略過壞行就當作還原成功。

### Crash 與磁碟故障的保證

| 情境 | v1 保證 |
| --- | --- |
| 關閉／刷新瀏覽器 | 工作繼續；從 Tower checkpoint 加 live state 補回畫面 |
| Tower 程序重啟，volume 保留 | 清單及已提交歷史保留；runner 重新註冊、對帳並補傳 |
| Runner wrapper／pi 重啟，磁碟保留 | 還原最後可驗證的本機 entries；未結束 run 標成 interrupted，不自動重送 |
| Tower 暫時離線 | 已啟動的工作可在 runner 繼續；新遠端命令停用；恢復後補傳 |
| Runner 離線 | 可讀最後雲端快照；不能接續或假裝建立成功 |
| Runner session 檔案遺失但 registry／workspace 保留 | 顯示最新已提交且通過驗證的雲端版本，經使用者確認後還原；揭露可能遺失未同步進度，不提供舊版本選擇 |
| Runner 全部資料或 workspace 遺失 | 雲端歷史仍可讀；自動重新綁定及災難搬移不在 v1 範圍 |
| Tower volume 遺失 | 需要部署者備份復原；不宣稱單一 volume 可抵抗磁碟毀損 |

本機版本與雲端版本不一致時，先用持久 revision/hash 對帳。雲端落後就補傳；本機缺失才走明確還原流程。未知的版本分歧要停用寫入並提示，不採 timestamp 覆蓋，也不覆寫仍在執行的 session 檔案。

雲端還原只限本機 session 檔案遺失、registry／workspace 保留且 child 不存在的情況。最新已提交快照驗證失敗時報錯，不自動退回舊版。確認畫面須說明只復原對話，不回復工作目錄、檔案或工具的外部副作用。使用者確認的 revision 若在執行還原前已非最新，拒絕該次請求並要求重新確認，不悄悄改用另一版本。

## 8. 操作權與命令去重

### 多裝置交接

- 所有已驗證裝置可訂閱同一 thread，預設唯讀。
- Driver ownership 綁定 WebSocket 連線並帶遞增 epoch；prompt、abort、dialog response 都要驗證。
- 主動釋放或連線確認中斷後即可重新取得。網路半斷線使用 heartbeat 偵測；v1 不以瀏覽器失焦判定離線。
- 另一台裝置可按「接手操作」並確認。Tower 先撤銷舊 epoch，runner 確認新的 epoch 後才回覆接手成功；舊連線之後的命令必須拒絕。
- 接手不 abort 既有 run，也不重新送出 prompt；新 driver 可以觀看、停止或回答 pending dialog。
- Tower 重啟使所有 browser ownership 失效。Runner 對帳完畢前拒絕新的 managed commands。
- 同名不同 instance 的 runner 不能沿用舊 thread。Tower 拒絕可偵測的重複註冊，但不宣稱能排除跨主機複製目錄後、在隔離網路中執行的另一份 runner；跨主機複製後繼續使用不在支援範圍。已啟動的工作在 Tower 離線時仍可繼續。同一主機的程序重啟仍須確認舊 child 已退出，無法確認時不得啟動第二個 writer。

### 受理與執行分開

命令至少區分 `received`、`dispatching`、`accepted`、`rejected`、`settled`、`unknown`。

1. Tower 先持久保存 command ID 與 payload，再回傳 `received`。
2. Runner 先持久保存去重紀錄，在發送 pi RPC 前記錄 `dispatching`。
3. Pi 明確回覆 prompt accepted 後，runner 保存並回傳 `accepted`。
4. 在 run settled 且本機 checkpoint 保存後，記錄 terminal 結果；雲端同步另有 ack。
5. 重複 command ID 回傳既有狀態，不能再次觸發 pi。

Tower 與 runner 在任何一步中斷時，要重新查詢並對帳。同一 command 在 Tower 顯示 received、但 runner 已經接受的情況，不能建立新的 run。

Runner 若在「已送入 pi、尚未保存回覆」之間 crash，無法一般性地證明是否已執行。此時標記 `unknown`，讓使用者閱讀已保存的紀錄，再決定是否用新的 command ID 重試。**不宣稱工具副作用 exactly-once，也不自動重播 unknown command。**

Browser 顯示 received 不代表 pi 已接受；未確認的 prompt 顯示待確認狀態，不能偽裝成權威 session entry。重新連線先查舊 command ID，禁止用新 ID 自動重送。

## 9. API 與協定邊界

以下是建議固定的 v1 外部介面。內部 envelope 可依模組設計調整，但要有協定版本、request ID、thread ID 與結構驗證。

### Browser HTTP

所有 `/api/threads` 路由都使用已驗證的 UI session；既有受支援的 Bearer client 也可呼叫。

| 路由 | 用途 |
| --- | --- |
| `GET /api/threads?runner=&q=&archived=&cursor=&limit=` | 穩定分頁；依最後活動時間、thread ID 排序 |
| `POST /api/threads` | `runnerId`、可選 title、建立用 idempotency key；runner 必須 online 且有能力 |
| `GET /api/threads/:id` | metadata、runtime／sync 狀態、最後已提交版本 |
| `PATCH /api/threads/:id` | title／archived 與預期 metadata version；衝突回 409 |
| `GET /api/threads/:id/history?revision=&cursor=&limit=` | 固定快照版本的分頁歷史，回傳 revision 與 leaf；不要在分頁中混用新版本 |
| `GET /api/threads/:id/commands/:commandId` | 查詢受理及執行狀態 |
| `POST /api/threads/:id/restore` | 本機 session 檔案遺失且 child 不存在時，確認後在原 runner 還原最新已提交且通過驗證的快照；`expectedRevision` 只作確認版本的前置條件，不提供任意選版，版本已變更回 409 |

History 回傳完整 entry envelope 或可對應到原始 entry 的顯示投影。原始快照保存在伺服器；大型 tool output 可折疊／分段顯示，不能為了 UI 截斷而破壞還原資料。

History 的 revision 用於固定分頁版本，不是回溯操作。請求的版本已清除時回傳 410 與穩定錯誤碼 `snapshot_expired`，並附最新 revision；瀏覽器捨棄該次分頁結果，從最新版本重新載入，不拼接不同版本的頁面。

### Browser WebSocket

新增 `WS /api/threads/:id/stream`，利用既有 `/api` cookie 範圍。不要直接將 `/attach` 改成接受所有 cookie。

Client commands：

- `subscribe`：last known snapshot revision；不取得操作權。
- `acquire`／`release`／`takeover`：操作權管理。
- `prompt`：command ID、ownership epoch、文字。
- `abort`：command ID、ownership epoch、target run ID。
- `extension_ui_response`：command ID、epoch、pending dialog ID、回覆值。

Server events：

- `state`、`ownership_changed`、`command_status`。
- `pi_event`：可顯示的 live event，帶 boot/run 身分與連線內 sequence。
- `checkpoint_available`：權威 snapshot revision。
- `resync_required`：斷線／sequence 缺口，重新載入 snapshot 與 runtime state。
- `error`：穩定 error code，加上可供人閱讀的訊息。

Live token events 不承諾斷線重播。重新連線以 checkpoint 修正畫面，暫時顯示「回答生成中，部分即時內容尚未保存」即可；不能把缺少 delta 的回答當作完成。慢速 viewer 要有 bounded buffer，超過上限中斷訂閱並要求 resync，不能拖住 runner 或無限佔用記憶體。

### Runner managed protocol

新增 capability negotiation，例如 `managedThreadsV1`、pi version 與 thread instance inventory。舊 runner 未宣告能力時，只保留 legacy 操作。

Managed 協定至少涵蓋：prepare/open thread、查詢／送出命令、runtime state、checkpoint ready/upload/ack、同步對帳、graceful sleep、restore、ownership epoch 更新。大快照使用有上限且可重試的 authenticated HTTP upload/download；不塞進原本 pure relay frame。

既有控制頻道可以新增版本化 envelope，也可以獨立路由。兩者都必須測試與 legacy runner 共存。Managed thread 不得經由 legacy `/attach` 繞過 ownership、去重及 checkpoint；應使用獨立 namespace 與拒絕檢查。

## 10. 瀏覽器介面

### Thread 清單

每列顯示標題、runner、最後活動時間、runtime state、是否有未同步進度。Runner 離線不隱藏 thread；封存清單可切換。清單排序不因 heartbeat 跳動。

空白 title 可由第一則 prompt 截取，不另外呼叫 LLM 產生名稱。重新命名由 Tower 管理，避免因 session-wide metadata append 改變對話位置。

### 對話頁

- 頁面提供可分享給自己裝置的穩定 thread URL，但沒有登入仍不能讀取內容。
- 顯示 user／assistant 文字、工具名稱、執行狀態及可展開的結果。Markdown 禁止原始 HTML 執行。
- 清楚分開 runner offline、runtime sleeping、正在工作、等待使用者、同步中與同步失敗。
- 唯讀裝置顯示「取得操作權」；有其他 driver 時改為「接手操作」。
- 開啟歷史不自動取得操作權或啟動 pi；送出 prompt 才按需啟動 runtime。
- 工作期間停用新 prompt，保留停止與 dialog 回覆。未取得 ownership 時，所有執行控制都停用。
- 過往 legacy session 不偽裝成 managed thread；可在現有 runner 狀態頁繼續呈現。

### Extension UI

支援 RPC 的 `select`、`confirm`、`input`、`editor` 基本對話框，以及 notify/status 的文字呈現。Pending dialog 必須由 runner 記住並在裝置接手後重新呈現；過期或舊 dialog ID 的回覆必須拒絕。

Pi 程序 crash 後不重建舊的 blocking dialog，而是把 run 標成 interrupted。任意 `ctx.ui.custom()`、自訂 footer／TUI widget 不在範圍內；文件列出相容限制。Managed chat 不接受任意 slash command，以免繞過 thread 身分或觸發無法顯示的控制流程。

## 11. 安全與資源限制

延用單一 shared token 的信任模型：持有 token 就能讀取所有 managed threads、操作所有 runner。UI 的操作權只防止裝置互撞，不是多人權限隔離。

- 生產部署要求 HTTPS/WSS；不得將 token 放進 URL、瀏覽器 localStorage、HTML 或應用程式記錄。
- Cookie 保持 HttpOnly、SameSite 與 HTTPS 下的 Secure；新增 logout／cookie 清除流程。
- Browser WS 在 upgrade 時驗證 session cookie 與允許的 Origin。Cookie-auth HTTP mutation 使用 CSRF 防護，不單靠 CORS；明確拒絕跨來源寫入。
- Browser managed commands 採 allowlist，不開放任意 raw RPC／任意本機路徑。API 每次存取都驗證身分與 thread 綁定。
- Snapshot 是可影響後續 agent context 的敏感資料。檢查格式、來源與大小，不因下載內容而執行程式或自動信任新的 project extension。
- Tool output、prompt 與圖片資料可能含秘密。預設不記錄全文到 server log；不自動上傳 provider auth 檔案。說明快照本身可能含使用者或工具洩漏的秘密，無法保證自動去識別。
- 快照在磁碟上不宣稱端到端加密；部署者須設定 volume 存取權限、加密與備份保護。
- Prompt、WS frame、snapshot、每 runner 的 awake threads、upload concurrency、slow-client buffer 都要有明確可設定上限。初始建議：prompt 256 KiB、單份 snapshot 64 MiB、每 runner 4 個 awake managed threads。
- 超限必須回傳可辨識錯誤。Snapshot 超限或磁碟滿時保留本機紀錄，顯示同步失敗，不截斷資料後宣稱同步成功；在容量恢復前阻止新的 prompt，仍允許停止與閱讀。

## 12. 相容性與部署

### Legacy 保持原樣

- 原有 `/runners`、`/attach`、`/runner-session` 的 wire contract 不變。
- `pi-task --session <name>` 與 `runner_task` 仍使用 legacy live-session 語意；不悄悄變成雲端同步，也不改 `--fresh` 的意義。
- Legacy runner 的 `--no-session` 繼續可用。Managed mode 必須明確啟用，且拒絕會破壞持久身分的 `--no-session`、共用 `--session`、`--continue` 等衝突參數。
- 不自動匯入或重新命名既有 legacy sessions；日後若需要，另寫遷移規格。

### 新設定

建議新增：

- Tower `--data-dir`／`PI_TOWER_DATA_DIR`。
- Runner `--managed-threads`，以及 `--data-dir`／`PI_RUNNER_DATA_DIR`。
- Managed awake 上限、單份 snapshot 大小上限、快照總量配額及磁碟剩餘空間警戒；CLI help 與 README 列出預設值。

Tower 啟動時建立並檢查資料目錄權限與 schema version。Migration 採明確版本；不支援降版時要拒絕啟動，不能用舊 schema 繼續寫入。

`compose.yml` 新增持久 volume。同步更新 `.env.example`、Docker 建置內容，以及 `package.json.files`，讓新增 runtime modules 與 web assets 確實包含在 npm 套件中。

### 對帳與觀測

Log 記錄 thread ID、command ID、run ID、runner instance/boot ID、revision 及錯誤類別，不記錄 token 與 prompt 全文。至少能分辨啟動失敗、還原失敗、同步積壓、拒絕的舊 epoch、unknown command 與磁碟問題。

啟動及重連時以 inventory 對帳 live runtime、本機紀錄、未確認命令和雲端 revision。尚未完成對帳的 thread 不可接受新 prompt。

## 13. 實作分期與交接要求

### 第 0 階段：確認 pi 相容性

先用獨立測試確認：

- 能取得 full entries、leaf、session ID；包含 compaction 與 custom entry。
- 原 cwd 重啟可保留 session ID 與對話；空白 session 的持久化行為。
- settled 的事件順序、message 寫入時機、extension dialog 接手。
- 分支存在時快照不漏資料，允許操作下的 active leaf 能精確還原。
- RPC framing 使用 LF，Unicode 分隔字元不拆 frame，多位元 UTF-8 被切成不同 chunk 時不毀損文字。

產出相容性測試及簡短技術決策，確定最低 pi 版本、SQLite driver、checkpoint/leaf 還原方法。若必須用私有 API 或改核心才通過，停止並回報，不擅自放寬驗收。

### 第 1 階段：持久 thread 與 runner 還原

實作資料模型、managed namespace、instance identity、固定 cwd、持久 session registry、按需啟動與 graceful sleep。先以程式化 client 驗證同一 session ID 經 runner 重啟後仍可恢復。

### 第 2 階段：雲端快照與命令可靠性

加入獨立同步、outbox、SQLite BLOB 快照與原子提交、revision/hash、命令 journal、crash uncertainty 與 startup reconciliation。這個階段完成後，即使沒有任何瀏覽器在線，run settled 後也會同步。

### 第 3 階段：瀏覽器與操作權

完成 thread 清單、歷史、串流、登入／登出、driver 接手、dialog、resync 與同步狀態。不要只做漂亮清單就把接續標成完成。

### 第 4 階段：故障注入與部署交付

完成第 14 節測試、相容性回歸、容器 volume、備份還原演練與 npm package 驗證。

建議將 storage、managed thread lifecycle、protocol validation、browser client 分成有明確責任的模組；檔名由實作者決定，不要求一個功能拆一個檔案。既有 relay 測試必須保持獨立，方便辨識回歸。

每個階段交接時回報改動檔案、執行過的測試與結果、未驗證項目及規格差異。Commit 遵循 repository 的 Conventional Commits 規則。

## 14. 驗收測試

### 自動測試

| ID | 測試 | 通過條件 |
| --- | --- | --- |
| A01 | 建立後送出多輪，換瀏覽器連線 | 同一 thread/session ID；前文完整；下一個 prompt 只執行一次 |
| A02 | Browser 關閉時 runner 繼續產生回答 | 完成後無 client 也能同步；重開可讀取結果 |
| A03 | Idle TTL 關閉 child，再接續 | Thread 保留；按需重建；原 cwd、session ID、entries 與 leaf 一致 |
| A04 | 工具長時間沒有 stdout | Running child 不因 idle TTL 被殺掉 |
| A05 | Tower 重啟且保留 volume | 離線歷史仍在；runner 對帳後接續，沒有第二個 child |
| A06 | Runner／pi 在 settled 後重啟 | 原 thread 還原，不建立空白同名對話 |
| A07 | Runner 在執行中 crash | 標示 interrupted／unknown；不自動重播 prompt 或工具 |
| A08 | Tower 離線時 run 完成，再恢復 | 最新 checkpoint 補傳；UI 從 pending 轉成 synced |
| A09 | 重傳 snapshot、亂序 snapshot、相同 revision 不同 hash | 冪等／拒絕行為正確；新版本不被舊版本覆蓋 |
| A10 | 同時兩台裝置取得／接手操作 | 只有一個 epoch 可執行；舊 epoch、舊 dialog 回覆被拒絕 |
| A11 | 在各命令保存／發送邊界斷線或 crash | 同 ID 不重複執行；不確定區間明確 unknown |
| A12 | 建立請求、prompt 使用相同 ID 但不同 payload | 拒絕衝突，既有 thread/run 不變 |
| A13 | 歷史含 compaction、分支、custom entry、大型 tool output | 快照完整；分頁不混版；還原不漏 entries 或 leaf |
| A14 | 損毀 JSONL、壞 parent/leaf、hash 不符、format 不支援 | 阻止還原及新 prompt；不默默丟行 |
| A15 | 刪除本機 session 檔案，保留 registry/workspace；嘗試舊 revision、確認後版本變更及本機檔案仍在時還原 | 只允許確認後還原最新已提交且通過驗證的版本；拒絕任意回溯、過期確認及覆寫本機檔案；最新快照損毀時不退回舊版；工作目錄與工具副作用不變 |
| A16 | Runner ID 重複、instance 不符、資料目錄同時開兩次 | 不啟動第二個 thread writer，不沿用錯誤 workspace |
| A17 | Cookie／WS Origin／CSRF／無登入讀取／path traversal | 未授權讀寫與跨來源操作被拒絕 |
| A18 | Snapshot 超限、磁碟滿、slow viewer | 有上限、有錯誤；不假報 synced、不無限 buffer、不毀損快照 |
| A19 | Pending extension dialog 時換裝置／重啟 pi | 接手能回答；重啟後舊 dialog 失效且 run 中斷 |
| A20 | 空白 thread、尚無 pi 檔案時 crash | Thread 身分不遺失；未確認 prompt 不自動重送 |
| A21 | Unicode 分隔符與跨 chunk UTF-8 | RPC 記錄數與文字內容正確 |
| A22 | 封存／取消封存、metadata 衝突、搜尋分頁 | 行為符合規格；heartbeat 不干擾排序 |
| A23 | Legacy regression 與新舊 runner 共存 | 現有 verify scripts 全部通過；legacy 不被自動上傳 |
| A24 | npm pack、Docker 重建、volume 備份還原 | 新模組都有打包；重建後已同步 thread 可讀可接續 |
| A25 | 快照交易在插入 BLOB、更新指標、commit 前後 crash；commit 成功但 ack 遺失；清除舊 BLOB 前後 crash 及重傳 | 重啟後只能讀到完整舊版或新版；已 ack 的 entries 不遺失；最新快照不被清除；已清除版本同 hash 重傳不重建 BLOB、不同 hash 仍拒絕；不出現懸空指標 |
| A26 | 多版本 BLOB 累積與清除、分頁中版本過期、同時讀寫、接近單份上限及總量配額；新版缺少舊分支或改寫 entry | 只清除被新版完整涵蓋的舊 BLOB；entries 與收據保留，缺少分支或改寫 entry 時拒絕清除；過期分頁回 410 並從最新版本重載；清單不讀 BLOB；量測 DB／WAL 大小及查詢延遲；鎖定等待有上限，清除後仍超限時明確拒絕且既有歷史可讀 |
| A27 | WAL 有已提交資料時製作一致備份，在全新資料目錄復原 | 完整性檢查通過；備份時間點的 metadata、收據、快照 hash／leaf 一致，thread 可閱讀並在原 runner 接續 |

測試優先使用 fake pi/runner 注入時序及 crash，不依賴真實 LLM 費用。另用真實支援版本的 `pi --mode rpc` 驗證 session ID、持久化、RPC schema 與還原。既有 `test/verify-chain.mjs` 的 no-LLM 測試可以延伸，但不足以單獨證明對話續接。

新增測試納入 `bun run verify`，或由 `verify` 呼叫明確的 managed-thread 測試腳本。單元測試綠燈不能取代跨程序及瀏覽器測試。

### 人工 smoke test

以兩個獨立瀏覽器 session，其中一個採手機窄螢幕：

1. A 建立 thread，讓 agent 在 runner 寫入可驗證的測試檔案；A 關閉頁面。
2. B 開啟 thread，讀到完成的回答及工具結果，接續提問並確認操作仍在原 runner。
3. A 重開頁面，兩台裝置交接操作；舊 driver 無法送出命令。
4. 重啟 Tower、runner，各接續一輪；確認前文與檔案仍在。
5. 讓 runner 離線，B 仍可閱讀已同步歷史，但不能送出新 prompt。

### 完成定義

A01 至 A27 與人工 smoke test 有可重現證據，已知限制寫進 README；pi 核心未修改，legacy 功能未退化，部署資料可備份還原。尚未通過的項目要列為未完成，不能以「通常能接續」替代。

## 15. 實作者閱讀順序

1. 本文件與 `AGENTS.md`。
2. `runner.mjs`、`tower.mjs`、`lib.mjs`、`extension.ts`、`ui.html`。
3. `test/verify-chain.mjs`、`test/verify-tower.mjs`、`test/verify-extension.mjs`、`test/verify-package.mjs`。
4. 所選 pi 版本的 `docs/rpc.md`、`docs/session-format.md`；若採 extension／SDK，再完整閱讀 `docs/extensions.md`、`docs/sdk.md` 及相關範例。
5. 以套件實際匯出的型別與執行測試核對文件。調查時發現部分文件範例與已安裝版本不一致，不能直接複製欄位名或假定 export 保留完整樹。

### 保留、改變、避免與風險

- 保留：pi 核心、legacy pure relay、runner 主動向外連線、每 thread 的執行隔離。
- 改變：新增持久 thread 身分、runner 還原、Tower 儲存與瀏覽器操作介面。
- 避免：兩個 writer 共用 session、外部覆寫 active JSONL、把 token stream 當備份、自動重播未知命令。
- 主要風險：pi 版本與 leaf 還原差異、命令 crash window、秘密進入歷史、缺少 volume 備份、將網路重連誤認成程序還原。
