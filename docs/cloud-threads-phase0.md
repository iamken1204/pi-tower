# Cloud Threads v1 第 0 階段相容性紀錄

第 0 階段相容性調查完成，可依下列契約進入第 1 階段；本輪停在交付，不開始實作 managed runtime。pi 的公開介面已能保存完整樹並精確還原 leaf，SQLite 已通過 Alpine 安裝與跨程序持久化測試。跨主機複製 runner 目錄後繼續使用已確定不支援。同主機的 writer 排他保護仍是後續開放寫入的必要條件，不是現有功能。

本紀錄依據 [規格第 13 節](specs/cloud-threads-v1.md#13-實作分期與交接要求)，只補上測試結果與技術提案，不取代規格。初次測試交付未修改規格；後續依使用者確認，補上跨主機複製不支援的範圍。程式碼基準仍為 [21b378e](https://github.com/iamken1204/pi-tower/commit/21b378e2c3952a2999118ff7b6393ee99e44da2d)，pi-tower 0.3.0。沒有修改 pi 核心；legacy 僅修正本輪重現的 UTF-8 chunk 解碼錯誤，呼叫方式不變。

## 實測版本與重現方式

2026-09-14，macOS 26.5.1／arm64（以 `sw_vers` 實測，環境提示的 25.5.0 並非目前版本）：

| 組合 | 結果 |
| --- | --- |
| pi 0.85.1，Node 26.8.2 | 真實 CLI／SDK 相容性測試及四個既有 verify scripts 通過 |
| pi 0.85.1，Node 22.22.0 | 真實 CLI／SDK、crash probes 與四個既有 verify scripts 全部通過 |
| pi 0.85.1，Node 22.0.0 | CLI 在首次 `get_state` 前退出，未通過；沒有修改核心繞過 |
| better-sqlite3 13.0.3，Node 26.8.2 | 隔離安裝、交易、跨程序重啟、busy timeout、WAL 備份通過 |
| better-sqlite3 13.0.3，node:22.22.0-alpine | image build 與全新容器執行均通過；SQLite 3.53.4 |

只測過 pi 0.85.1，**未找出最低支援 pi 版本**；第 1 階段先以此精確版本為相容性基準。Node 22.22.0 是通過的測試版本，不是搜尋所得的最早可用版本。依使用者授權，`package.json.engines` 與 lockfile 的 Node 下限提高為 `>=22.22.0`，Docker 基底固定為 `node:22.22.0-alpine`。SQLite 選用精確版本 `better-sqlite3@13.0.3`，但尚未加入產品依賴。未逐版測試其餘 Node 版本，也未在 Alpine 執行真實 pi 或完整產品 image。

在 repository 根目錄執行：

```sh
# 複製必要檔案至暫存 workspace，以空白 HOME／pi profile 執行全部回歸與 pi/crash probes
npm run verify:phase0

# 單獨執行；各測試也會建立自己的隔離 workspace
node test/compat/verify-pi.mjs
node test/compat/verify-crash.mjs
```

測試預設從 `npm root -g` 尋找已安裝的 `@earendil-works/pi-coding-agent`；可用 `PI_COMPAT_PACKAGE=/absolute/package/path` 指定套件目錄。讀取套件公開 root entry，不使用未匯出的 session 方法。測試 extension 為避開 pi 的相容層別名，直接載入 pi-ai 的公開 root entry 檔案；需要 npm 安裝的完整套件，不能只給獨立 binary。

測試其他 Node 版本時，用官方 Node archive 的 `bin/node` 執行 `test/compat/verify-isolated.mjs`，並明確設定 `PI_COMPAT_PACKAGE`。子程序使用同一個 `process.execPath`；完整回歸也將該 binary 目錄放在 PATH 最前面。macOS arm64 的測試 archive 為 `https://nodejs.org/dist/v22.22.0/node-v22.22.0-darwin-arm64.tar.gz`。SQLite／Docker 指令見 [SQLite probe](cloud-threads-sqlite-probe.md)。SQLite 測試會下載套件，因此不在一般 `verify` 裡自動執行。

## 真實 pi 與 fake 的證據界線

`verify-pi.mjs` 執行真正的 pi CLI、session manager 與公開 SDK。LLM 由 pi 公開 `fauxProvider` 提供固定回答；compaction 由公開 `session_before_compact` hook 提供固定摘要。沒有付費請求，也沒有複製真實憑證。

測試確認：

- `get_entries` 保留壓縮前紀錄，`since` 使用 append-order cursor；extension 能取得原始 header。
- 自訂 entry 的巢狀資料、不同分支與 SDK 注入的大型 tool result，在 RPC 讀取及 session 重建後逐筆完全相同。大型結果屬測試 fixture，沒有實際呼叫該工具。
- 同一 session 經 CLI `--session` 重啟後保留 ID 與完整 entries，但非最後一筆的 active leaf 會變成最後 appended entry。
- 公開 SDK 在 `createAgentSession` 前呼叫 `branch(savedLeafId)`，可保留 header、ID、所有 entries 與 leaf。還原後實際送出 faux prompt，新增 message 的 parent 指向保存的 leaf；`executeBash("pwd")` 確認仍在原 cwd。
- 刪除測試 session、用完整 header／entries 重建 JSONL 後，SDK 也能接續。另測 `inMemory(..., fileEntries)` 與 `resetLeaf()`，不以 append 方法重建既有 ID。
- 空白 CLI session 有 ID，但沒有 JSONL；未保存 registry 的全新啟動會取得另一個 ID。不能只靠 session 檔案維持空白 thread 身分。
- Extension `message_end` callback 當下，該 message 尚未出現在 memory entries 或磁碟；`agent_settled` 時兩者一致。RPC 的 `agent_end` 早於 `agent_settled`。
- 真實 stdin 逐 byte 傳送中文字、emoji、U+2028／U+2029，CRLF 輸入保持完整；測試 reader 使用 streaming UTF-8 decoder、只以 LF 分隔。
- `select`、`confirm`、`input`、`editor` 的 pending ID 可由替代邏輯 client 回覆。Pi 忽略無效 ID，沒有 browser epoch 檢查。這只驗證接手所需的 RPC 能力，尚未實作兩個瀏覽器的 ownership／pending-dialog 保存與拒絕回覆。

`verify-crash.mjs` 使用真正的 Tower 與 runner。Fake pi 在 wrapper SIGKILL 後仍存活，明確重現現有 wrapper 缺乏 child 退出保證。真實 pi 0.85.1 在 idle 與 pending dialog 測試中，750 ms 後皆已退出。這不能推論正在執行的工具或脫離 process group 的後代也一定退出。[Crash probe](cloud-threads-crash-probe.md) 記錄 supervisor／reap／無法確認就拒絕啟動的提案。

同一個 fake 逐 byte 輸出時，原本 runner 會毀損 UTF-8。本輪已在 stdout 設定 streaming UTF-8 decoder，測試改為檢查中文字、emoji 與 Unicode 分隔字元逐字相等，且仍只有一個 LF frame。修正後在 Node 22.22.0、26.8.2 均通過完整隔離回歸。

## Checkpoint 與還原方法

採用公開 SDK 的 managed child host 是可行方向；legacy 繼續使用原本的 CLI／raw relay。公開 `get_entries` 沒有 header，也沒有設定 leaf 的命令，單靠原本 RPC 不足以涵蓋完整還原。`SessionManager.open()`、`branch()`、`resetLeaf()`、`createAgentSession()` 的組合已實測；接入公開 `runRpcMode` 的新 host 尚未實作或驗證。

完整快照保存原始 header、append-order entries 與獨立 leaf。正常 settled checkpoint 從權威記憶體取得資料；不能在 `message_end` callback 直接把磁碟內容當最新版。Running checkpoint 應排程稍後擷取並在 settled 再次對帳；5 秒目標及 retry／自動壓縮的時序尚待後續測試。

還原前先完成規格第 7 節的 hash、schema、身分與樹結構驗證，確認沒有舊 writer，再建立 session manager。套用 leaf 後必須重新比較 entries、ID、cwd 與 leaf，才開放 prompt。Pi parser 可略過壞行，因此 parser 成功不等於 snapshot 驗證成功。本輪只有合法 fixture 還原，沒有把完整 A14／A15 還原驗證器列為已完成。

## 重啟與備份復原後的版本提案

以下是供後續實作採用的具體工程方案與故障案例，尚未實作，也沒有把案例列為通過。沒有改寫規格第 5、8 節的既有資料欄位；實作 wire schema 時須將此複合身分納入 revision 與 epoch，不能仍只比較整數。若 Tower 與 runner 同時退回舊備份，備份內的整數 high-water mark 無法證明曾經配發過哪些更大值。只做 `max(local, cloud) + 1` 不足以防止重用；需要不會一起回復的外部錨點，或調整版本表示法。

建議將 snapshot revision 改為 `(generationId, counter)`。每次 runner 啟動產生新的隨機 generation ID，第一個 checkpoint 記錄前一個 generation 的已驗證 revision/hash；同一 generation 內的 counter 仍須持久遞增，先保存 bytes、hash 與 counter，再發送。舊 outbox 保留原本的 generation／counter／bytes，不重新編號。Tower 只接受完成 inventory 對帳的新 generation，依承接關係排序，不以 UUID 或 timestamp 判斷新舊。跨世代存在分歧或缺少去重紀錄時停用新工作，不自行合併。雙方備份都過期時只能承認備份時間點以後的資料可能遺失，不能假稱已恢復所有收據。

Ownership 建議使用 `(towerIncarnation, runnerBootId, connectionNonce, epoch)`。Tower 每次啟動都產生不從備份載入的隨機 incarnation；runner 重連另建立 connection nonce。對帳時先撤銷舊連線的 managed command 通道，再確認新 incarnation／nonce，最後才核發 driver epoch。Runner 每次驗證完整 tuple；只對同一 tuple 的 epoch 做遞增比較。離線已啟動的 run 照常工作，但不得接受舊連線的 prompt、abort 或 dialog response。UUID 使用 OS CSPRNG，屬可忽略碰撞機率的唯一性，不是數學上的永不重複保證。

需要加入的故障案例：

| 注入點 | 必須成立的結果 |
| --- | --- |
| 保存 snapshot counter 前／後 crash | 未提交 bytes 不發送；已提交 outbox 重送使用原 revision/hash |
| Tower commit 完成但 ack 遺失 | 重送沿用舊身分並取得同一收據，不再執行命令 |
| Runner registry 回復舊備份，Tower 較新 | 禁止用舊 counter 覆蓋最新資料，完成對帳或停用寫入 |
| Tower DB 回復舊備份，runner 較新 | incarnation 改變，所有舊操作權失效；runner 補傳可驗證的歷史與收據 |
| 雙方都回復舊備份，注入備份後的舊命令 | 新 generation 不重用舊 revision；舊 ownership tuple 一律拒絕；未知命令不自動重播 |
| 新對帳中延遲送達舊 epoch／舊 nonce 的 abort、dialog response | 不影響新 driver，也不回答新 dialog |
| Supervisor 或 wrapper crash、PID 被重用、舊 child 存活 | 無法取得可信退出證明就不啟動第二個 writer |

## 第 1 階段的必要契約與未驗證範圍

使用者已確認：不支援把主機 A 的 runner 資料目錄複製到主機 B 後繼續使用，不限於兩台同時啟動的情況。離線已啟動的工作仍可繼續；Tower 拒絕可偵測的重複註冊，不把這項偵測寫成跨主機全域互斥保證。此政策已寫入規格第 2、8 節，不再列為待確認事項。

沒有剩餘的產品範圍問題需要使用者先回答。第 1 階段可依上述複合版本與 ownership 方案設計；managed runtime 開放寫入前，必須實作並測試 fail-closed child 排除。無法證明舊 child 已退出時只能拒絕啟動，不能用時間到、PID 不存在或重新取得 wrapper lock 當成充分證明。這輪只交付方案與反例，不宣稱完成 supervisor。

真正 provider 的重試／自動壓縮、執行中工具的 crash、SDK host 接入 `runRpcMode`、完整 A01 至 A27、瀏覽器 smoke test、磁碟滿與電源故障均未驗證。規格要求的最低 pi 版本尚未搜尋；這是明列的版本調查限制，不將單一版本結果改稱最低版本。Docker 測試啟動 OrbStack 時自動帶起三個既有 VictoriaLogs 容器，沒有修改其設定；測試 image 已刪除，OrbStack 已恢復停止。本輪沒有 push、部署或發布套件。
