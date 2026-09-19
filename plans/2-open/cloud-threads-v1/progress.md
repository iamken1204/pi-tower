# Cloud Threads 實作與驗證紀錄

已實作本機原生 pi TUI 與網頁共用 thread，並完成下列回歸、容器與瀏覽器驗證。依據 [v1 規格開頭的互動模式修訂](spec.md) 與 [第 0 階段決策](phase0.md)。未 push、部署或發布；未測範圍列在文末，不把實測環境外的行為算成通過。

## 本機互動式 pi：交付方式與實測

`pi-runner --hq <tower>`（互動模式與 `~/.pi-tower` 資料目錄皆為預設）在終端執行公開 SDK 的 `InteractiveMode`。本機 thread 自動出現在 Tower，所有已登入的瀏覽器直接送訊息，不必取得或釋放操作權。忙碌時預設排入 follow-up，也能 steering 或停止；TUI 狀態列與網頁顯示佇列。恢復既有 thread 比照原生 pi：在同一目錄下 `-c` 接最新、`-r` 挑選，或 `--thread <UUID>` 指名；原生 thread 不會因網頁送訊息而自動啟動另一個 runtime。多個終端可共用同一 runner ID 與 `~/.pi-tower`，每個 thread 同時只由一個終端 host。

單一程序持有 session writer。公開 `session.prompt` 外層在 pi 非同步 preflight 前保留執行位置，本機與遠端輸入共用順序；停止會清除佇列，已取消或結果不明的命令不從歷史文字猜成 settled，也不重播。成功回傳並保存 checkpoint 才更新收據。`select`／`confirm`／`input` 用公開 UI context 與 AbortSignal 讓第一個有效答案關閉另一個提示；editor 保留本機介面，網頁只能顯示提示。

`/reload` 重新安裝 UI bridge，`/new` 註冊新 thread 並停用舊 thread 的網頁輸入。Tower 僅在本次 inventory 確認包含該 thread 時，讓 runner 清除首次註冊意圖。已註冊 thread 若不在較舊 Tower 備份中，仍保留本機資料並停止同步，不重建可能遺失的標題／封存狀態。

`bun run test/compat/verify-interactive.mjs` 使用獨立 tmux server、隔離 HOME／pi profile／workspace 與 faux provider，在真實 pi 0.85.1、Node 26.8.2 通過：終端先輸入、公開 SDK 遠端輸入顯示在同一原生 TUI、執行中遠端 follow-up 確實進入佇列、遠端回答 confirm 後本機 dialog 關閉且可繼續輸入，以及遠端 transport 關閉後本機仍收到新回答。沒有付費 LLM 呼叫或私有 API。

上述 probe 另保留作為 SDK 相容性證據。產品測試為 `bun run verify:native`，已在 Node 22.22.0／26.8.2、真實 pi 0.85.1 通過：本機與兩個 WebSocket client 共用 session、preflight 期間排隊、steering、停止清除佇列、三種跨端 dialog、拒絕第二次回答、editor 拒絕遠端回答、Tower 離線期間本機繼續、舊 epoch 失效、`/reload`、`/new`，以及 SIGKILL 後從不同啟動目錄還原同一 entries／leaf，再於原 cwd 續接。測試使用隔離 HOME／profile／workspace 與 faux provider，不讀取真實憑證或呼叫付費模型。

`--managed-threads` 的背景 RPC 路徑保留，沒有原生 TUI，忙碌時不收新 prompt；網頁依 runtime capability 停用送出。這條相容路徑不提供本機互動體驗；要在本機互動就用 `pi-runner` 的預設模式，`--interactive` 仍可明確指定。

Native 測試也驗證未啟動模型回合的 custom entry 會同步，以及切回較早的 assistant leaf 後，crash 重啟仍保留後面的完整分支。Tree、compaction 與 session info 事件立即保存；沒有事件的 extension append 每 5 秒檢查一次 checkpoint hash，內容未變就不重寫檔案。

## 持久化與還原契約

Managed mode 明確啟用，legacy relay 保留原有使用方式。實測 pi 0.85.1、Bun 1.4.2 與其內建的 `bun:sqlite`（2026-09-19 前為 Node 22.22.0／26.8.2 與 better-sqlite3 13.0.3，見[改用 Bun](#2026-09-19-改用-bun)）；只測過這個 pi 版本，不把它稱為最低支援版本。Tower 使用單一 SQLite，schema version 5、WAL、FULL、1250 ms busy timeout。沒有 S3。

Runner 用公開 SDK 開啟 session，再套用 `branch(leafId)` 或 `resetLeaf()`，驗證 session ID、完整 entries 與原 cwd 後接上公開 `runRpcMode`。沒有修改 pi 核心或使用私有 API。Header-only JSONL 讓空白 thread 也有持久身分；整份 registry／JSONL／checkpoint 先寫進暫存目錄，再以 rename 一起發布。建立時 crash 留下的 `.prepare-*` 不會成為 runtime，也不阻止已發布的 thread 重啟。

每個 settled 與正常關閉都保存完整 checkpoint。`message_end` 後延遲 50 ms 合併擷取，避開 pi 尚未 append entry 的時序；同步 outbox 保存原始 bytes，重傳不重新序列化。雲端 ack 只在 BLOB、revision/hash、latest 指標與舊 BLOB 清除的同一筆交易提交後回覆。清除只移除完整涵蓋的舊 BLOB，entries、命令收據與 revision/hash 索引皆保留。

Wrapper 持有 `writer.sqlite` 獨占交易；每個 child 在讀 session 前持有自己的 `runtime.sqlite`，直到作業系統完成程序退出。重啟先取得 wrapper 鎖，再逐一確認舊 child 鎖可取得。未能確認就拒絕啟動，不能靠 PID 或時間猜測。舊版只有目錄標記、沒有 kernel-v1 標記的鎖仍拒絕自動接管。只支援本機檔案系統，不支援跨主機複製 runner 資料。

Crash 復原保留已驗證 checkpoint 與完整 append suffix；若沒有新增 entry，沿用獨立保存的 leaf。有新增 entry 時，驗證舊 entries 是完整前綴，再以最後 append 的 entry 作為復原 leaf。壞行、未完成尾行、錯誤 parent／leaf 或不同前綴一律拒絕，不丟棄資料。未完成命令標示 unknown／interrupted，不重播。

## Revision 與連線 epoch 不沿用舊授權

Revision 採 `{generationId, counter}`。Runner 每次啟動取得隨機 generation；每次新快照先持久保存 bytes 與 counter，舊 outbox 仍用原本版本。跨 generation 以 predecessor revision/hash 串接，不比較 UUID 或 timestamp。連線 epoch 採 `{incarnation, connectionId, bootId, counter}`，同一 thread 的瀏覽器共用 epoch，不再代表某個裝置持有操作權。Tower 重啟與 runner 重連都換發不從備份載入的隨機身分，先對帳收據與 inventory，再開放命令。Runner 確認的 epoch 必須完整相符。這是 CSPRNG 的低碰撞機率保證，不是數學上的零碰撞。

Tower 還原較舊備份時，原 runner 下載並驗證雲端 head，確認本機完整涵蓋雲端與 pending entries，才以新 generation 補傳。本機資料不會被雲端覆寫；舊 outbox 另存 `reconciled-*.json` 作為證據。分歧就停用寫入。備份後才建立、雲端目錄已不存在的 thread 保留在 runner，停止同步並記錄 `thread_missing_from_catalog`，其他 thread 仍可對帳。需較新的 Tower 備份才能恢復那些目錄項目，不自動匯入。

雙方若都失去較新的收據，備份無法證明工具曾做過什麼。新的 generation／ownership 防止舊操作權再次生效，並不能復原遺失的資料或提供工具副作用 exactly-once。

## 可重現測試與證據

執行 `bun run verify:phase0`，它會在隔離 HOME、pi profile 與 workspace 執行完整 `verify`，不使用真實使用者憑證。`PI_COMPAT_PACKAGE` 可指定已安裝的 pi 套件。改用 Bun 後沒有 native module，不必再為不同執行環境各自安裝依賴。

改用 Bun 之前，最終原始碼已在 Node 22.22.0 與 26.8.2 各跑過完整隔離套件，全部通過；`npm pack --dry-run` 與 `git diff --check` 也通過。Node 22 使用獨立安裝的 native dependencies，沒有共用 Node 26 的 ABI。

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

本機互動模式使用 `PI_NATIVE_PREVIEW=1 bun run verify:native`。已在真實瀏覽器登入 fixture，送出 confirm prompt、等待時再送 follow-up、從網頁回答確認，檢查本機 TUI 顯示排隊訊息與後續回答。桌機 1280 px 與手機 390 px 的截圖已用 view_media 檢查，沒有操作權按鈕，dialog、佇列與 composer 不互相遮蔽。證據：`assets/cloud-threads-native-desktop.png`、`assets/cloud-threads-native-mobile.png`。關閉瀏覽器後，以 fixture 印出的 stop URL 清除測試程序與資料。

下列為背景 RPC 路徑先前的 smoke test 紀錄；其中的手動接手操作已由自動共享 epoch 取代。

啟動 `bun run test/compat/browser-fixture.mjs`，使用它印出的 URL 與一次性 fixture token。兩個獨立瀏覽器 session 登入同一 thread，其中一個設為 390 × 844。送出 `smoke-write`，faux provider 會要求**真實 pi bash 工具**在隔離 cwd 寫出 `smoke.txt`；`smoke-check` 讀取同一個檔案與 cwd，`dialog` 產生 pending confirm。

已操作並檢查：建立與多輪輸入、手機／桌機接手、舊裝置停止與 dialog 控制停用、接手後回答原 dialog、Tower 重啟重連、runner 離線仍讀歷史且不能輸入、runner 重啟後再次讀到測試檔案。Fixture 的控制 URL 接受 POST `/restart-tower`、`/runner-offline`、`/runner-online`；結束時 POST `/stop` 清除隔離資料。不要把這些控制路由當成產品 API。

另以 `smoke-write-slow` 延遲工具執行 5 秒，確認畫面顯示 RUNNING 後關閉所有測試頁面。工具仍完成寫檔，重新登入後看得到結果，接著送出 `smoke-check` 讀到同一檔案。第一次未等命令接收就關頁的嘗試沒有執行，不列為通過；本測試證明已接收工作不依賴頁面存活，不承諾瀏覽器尚未送達的請求也會執行。

桌機與手機截圖均已用 view_media 檢查。修正過 composer 擋住 dialog 按鈕的問題，並實際點擊確認；工具結果改成可展開文字，保留原始快照內容。證據：`assets/cloud-threads-desktop.png`、`assets/cloud-threads-mobile-dialog.png`、`assets/cloud-threads-mobile-title.png`。

## 容器驗證

使用者允許啟動 OrbStack 後，`bun run test/verify-docker.mjs` 通過。測試建置實際 Dockerfile，使用 UID 1000 與獨立 named volumes；基底原為 Node 22.22.0 Alpine，2026-09-19 改為 `oven/bun:1.4.2-alpine` 後重跑通過；主機端為 pi 0.85.1 公開 SDK／RPC 加 faux provider，沒有付費模型呼叫。

真實 pi bash 在隔離 workspace 寫檔並同步後，正常停止 Tower，封存整個 `/data`，還原到全新 volume。以非 root 驗證 SQLite integrity、snapshot hash／leaf、標題與 settled 收據一致；重建並替換容器後，原 runner 重新連線，同 ID 命令保留 settled、新命令讀回同 cwd 的檔案，舊 entries 完整保留。這補上 A24 的產品 image 與 volume 還原證據，不代表 Cloudflare Tunnel 或遠端部署已驗證。

測試自行清除專用容器、image、volumes 與隔離目錄，不自動啟動 Docker engine，也不加入預設回歸套件。OrbStack 與隨其啟動的三個既有 VictoriaLogs 容器保持運作，沒有修改其設定或資料。

## 2026-09-19 改用 Bun

Tower 與 runner 改由 Bun 1.4.2 執行。`better-sqlite3` 換成內建的 `bun:sqlite`，`ws` 換成 Bun 內建的實作，runtime dependencies 清空，Docker image 不再安裝任何套件。pi 0.85.1 列入 devDependencies，runner 預設使用這一份，不再以 `npm root -g` 尋找全域安裝；`--pi-package` 仍可指定別的目錄。`bun run build:runner` 把 runner 連同 pi 編成單一執行檔，pi 的 theme、template 與隨附 skill 直接從執行檔內讀取，每個 thread 的 pi host 由執行檔以隱藏子命令重新進入自己。

本機 macOS arm64、Bun 1.4.2、pi 0.85.1 的結果：`bun run verify`、`bun run verify:ui`、`bun run test/verify-docker.mjs` 全部通過；`verify:native` 與 `verify-managed` 另以 `PI_RUNNER_BIN=dist/pi-runner` 對編譯後的執行檔重跑通過，其中 `verify-managed` 注入故障的 runner 仍從原始碼執行。執行檔複製到空目錄、清空環境變數、PATH 上沒有 node／npm／pi 時可以啟動；交叉編譯的 `bun-linux-x64` 版在乾淨的 Debian 容器內通過內建 pi 的版本檢查並取得 writer lock。`bun run verify:phase0` 只剩一項失敗：隔離目錄沒有 `.git`，`verify-native-collaboration` 卻對 repo 根目錄執行 `git fetch`；這項失敗在改用 Bun 之前就存在。

Bun 與 Node 的行為差異，以及對應的處理：

- `bun:sqlite` 的連線物件被垃圾回收時會關閉資料庫，而 Bun 的轉譯器會刪除 `void guard` 這類只為保留參照而寫的敘述，writer lock 因此可能在持有者仍執行時釋放。`lock.mjs` 改為自行持有每個鎖的連線，直到 `close()`；強制垃圾回收後鎖仍互斥。
- 連線上還有未 finalize 的 statement 時，`close()` 會延後，鎖也跟著留著，同一程序無法重新上鎖。一次性的 statement 改為用完立即 finalize。
- Bun 的 `ws` 接受 `maxPayload` 卻不執行。瀏覽器 WebSocket 的 512 KiB 上限改在 upgrade handler 檢查，超過仍以 1009 關閉，該 frame 不會送進任何 route。Runner 一側原本的 64 MiB 上限由 Bun 自身的 16 MiB 取代，超過時連線以 1006 中斷。
- `terminate()` 會在返回前同步觸發 `close`。Tower 改為先登記新連線再終止舊連線，shutdown 先清空連線表再逐一終止。
- Bun 會把啟動目錄的 `.env` 載入環境變數，pi 的子程序也會繼承。編譯後的執行檔、Docker、shebang 與原始碼模式啟動的 pi host 都已關閉這項行為；直接執行 `bun src/runner.mjs` 時要自行加上 `--no-env-file`。
- `syncBuiltinESMExports` 在 Bun 下不會更新已具名匯入的函式，runner 的故障注入改用 `bun:test` 的 `mock.module`。`bun:sqlite` 沒有 SQL 自訂函式，snapshot crash 測試改為包住 store 自己的 statement，在同樣 6 個交易邊界送出 SIGKILL。

編譯後的執行檔沒有打包 pi 的圖片縮放 WebAssembly 模組與 clipboard native addon；`--` 之後帶 pi 參數的 relay 模式仍啟動 PATH 上的 `pi`。

## 驗證範圍與限制

- A11 已涵蓋上述 7 個 runner 命令邊界；尚未逐一注入 Tower 每個 SQL／網路回覆邊界，以及兩份備份同時退回後的延遲 abort／dialog 訊息。
- A18／A26 已涵蓋可設定大小／配額邊界、SQLite FULL、鎖定及 fake slow viewer；尚未跑預設 64 MiB／1 GiB 規模、真實慢速網路及 runner fsync 的 ENOSPC／EIO 注入。
- A22 的 metadata／搜尋／封存已測；另以真實 SQLite 與 fake transport 驗證 23 筆同時間戳記、7 筆一頁的搜尋／runner 篩選，完整走完分頁，不重複、不遺漏並排除封存項目。尚未窮舉翻頁期間所有 metadata 更新組合。
- 真實 provider 的重試／自動壓縮長流程、Windows／其他檔案系統與實體手機 Safari 尚未驗證。這些結果不能從 faux provider 或桌面窄視窗推論。

產品範圍沒有新的待確認事項。部署、容量、停止後備份與最新快照還原限制見 [README](../../../README.md)。本機互動模式已可手動驗證；以上壓力測試與故障注入尚未涵蓋的組合不算驗收通過，不宣稱所有環境與故障時序皆已驗證。
