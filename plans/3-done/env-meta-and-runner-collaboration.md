# 環境中繼資料與非同步 Thread 協作

狀態：已實作於 main（2026-09-16）。Tower 端以 connection／host 模型實作：runner 連線以 connection id 為 key，每個 thread 記錄承載它的連線，協作請求與事件只接受該連線。公開 API、測試範圍與限制見第 11 節；本機驗證不代表已部署或完成實體跨主機驗收。

本文延續 [Cloud Threads v1](../2-open/cloud-threads-v1/spec.md)，尤其是文件開頭的互動模式修訂；不沿用已被取代的操作權交接流程。

調查基準：2026-09-15 的本機 `main`，已含首頁 managed runner 顯示修正。現有套件宣告 Node ≥22.22.0、better-sqlite3 13.0.3；既有 pi 驗證版本為 0.85.1，不等於最低支援版本。本功能須另驗證所用公開 API。

## 1. 目標與完成路徑

同一 HQ 管轄的 runners 都能互相通訊與委派工作，不限相同專案、repo、cwd 或主機。這些環境資訊只用於搜尋與辨識目標，不是通訊或委派的權限條件。執行仍須符合第 2 節的連線與可受理條件；本版不提供跨 HQ 通訊。

例如，使用者在本機互動式 pi thread A 說：「請 HQ 裡負責文件專案的另一個 runner，根據這份 API 變更摘要更新使用說明。」A 可以向 Tower（HQ）查詢已連線的 thread 資訊，選定另一個專案的 thread B，送出委派後繼續工作。B 在自己的原有 runtime 與 cwd 執行，完成後把可識別的結果送回 A。本機與網頁均可看見相關訊息。尋找同一專案的 runner 也只是其中一種使用方式，不限制交付對象。

使用者已確認的需求：

- 自動收集 Thread ID、目前目錄名稱（Project）、PWD、HOSTNAME 與 Thread Name，並送至 HQ。
- Runner 可向 HQ 查詢正在執行的 threads 資訊，並與同一 HQ 管轄的其他 runners 互相通訊及委派工作，不受專案或環境是否相同限制。
- 委派是非同步的；來源 thread 不必等目標完成。多個 threads 可同時工作。

以下工具名稱、回報方式與資料模型是本規格採用的工程方案，不表示使用者曾逐項指定。

### 本版範圍

- Managed threads 的環境資訊收集、持久保存、連線狀態查詢與畫面顯示。
- 從已綁定的來源 thread，向另一個可接收工作的 managed thread 委派文字任務。
- 任務受理、排隊、執行、明確回報、結果查詢及來源端非同步通知。
- 命令與結果去重、斷線補同步、重啟後的不確定狀態處理。

### 不做

- Orb、建立替代 runtime、搬移 thread、複製 runner 目錄跨主機繼續使用。
- 離線目標的待執行工作信箱、自動重試執行、定時排程、工作流或遞迴代理管理器。
- 用專案名稱推導 Git 身分、同步 repo／檔案／憑證、跨 thread 檔案鎖或自動合併修改。
- 多租戶 ACL、公開發現服務、委派檔案附件或自動上傳整段來源對話。
- 改變既有 legacy relay、`runner_list`、`runner_task`、`pi-task` 的參數或等待回覆行為。

## 2. 身分、並行與可執行性

Runner 是承載 runtime 的程序／主機端；thread 是持久對話身分。一個 runner 可以有多個 threads。「找另一個 runner」最後必須解析成明確的 `targetThreadId`，不能只送到 runner ID 或名稱。

每個 thread 始終只有一個 runtime／writer。A→B 與 A→C 可以並行；兩個來源送到 B 時，沿用 B 的輸入排隊規則，不啟動第二個 writer。來源工具只等待有期限的受理回覆，不等待目標的 LLM 或工具執行結束。

- 目標閒置時，可立即開始；忙碌時，以 follow-up 排入既有佇列。
- 委派不使用 steering，不搶占目標目前工作。本機與網頁仍保有既有輸入、steering、停止能力。
- `canDelegate` 必須由實際 runner 連線、runtime／同步狀態、封存狀態與現有命令受理條件計算，不能只看最後一次 heartbeat。
- 「已連線 thread」包括忙碌及閒置但仍維持連線的 thread；清單須另外揭露是否可受理委派。
- 查詢結果不是執行許可。送出時重新檢查目標與綁定；離線或不可用就拒絕，不保留新工作等它上線。
- 使用現有 runner 支援的正常喚醒規則；不得為已退出的原生互動式 thread 偷開另一個 runtime。
- Tower 斷線不阻止本機工作，但此時無法查詢最新目標或受理新的遠端委派。

不同 threads 即使 cwd 相同也可以並行。這不保證檔案修改互不衝突；委派前呈現 cwd／hostname，工具說明須提醒同一工作目錄的修改可能衝突，不宣稱系統提供工作目錄隔離。

## 3. 環境資訊契約

每筆資訊綁定既有 `threadId`、`runnerId`、`runnerInstanceId`，不另造一套 thread 身分。

| 欄位 | 來源與語意 |
| --- | --- |
| `threadId` | 既有持久 thread ID；不是 pi session ID |
| `project` | 有效 cwd 的最後一段目錄名稱；根目錄使用根路徑作為顯示值 |
| `cwd` | Runtime 真正使用的絕對工作目錄，即既有 `effectiveCwd`；沿用 threads 表既有的 `cwd` 欄位（schema 4） |
| `hostname` | Runner 身分檔記錄、每次啟動比對系統 hostname 的主機名稱；threads 表新增 `hostname` 欄位（schema 5） |
| `threadName` | 使用者看到的 thread 名稱，對應既有 Tower `title` |

`PWD`、`HOSTNAME` 表達使用者需要的環境資訊，不代表盲信同名環境變數。若環境變數與實際 runtime 不符，以有效 cwd 與系統 hostname 為準。不得順便收集其他環境變數、憑證或目錄內容。

收集時機：runner 啟動並完成 thread 綁定、建立或切換 thread，以及重新連線。啟動當下尚無 thread 時，不捏造 Thread ID；完成綁定後再上報。`/new` 產生的新 thread 必須有自己的資料，舊 thread 不改綁。

名稱延用既有 `title`／`metadataVersion` 更新契約：新 thread 可用公開 pi session 名稱初始化，沒有名稱時沿用現有預設。後續本機或網頁改名須走有版本檢查的更新；背景環境上報不得覆蓋使用者改過的名稱。離線改名若與 Tower 版本衝突，顯示衝突，不用 heartbeat 最後寫入者勝出。

Tower 在 inventory 綁定 thread 時寫入 cwd 與 hostname，離線時仍可閱讀，以 `online` 標示是否為目前連線的資料；不另存觀察時間。只接受承載該 thread 的連線送來的更新，其他連線的事件一律視為綁定錯誤。

`project` 是顯示及搜尋提示，不是專案唯一識別碼。同名目錄、不同 hostname 或不同 cwd 都可能是不同 checkout；相同 hostname 也不是驗證過的主機身分。候選不唯一時，來源應列出差異請使用者指定，不可挑第一筆就執行。

## 4. 工具與查詢介面

新工具只安裝在可確認來源綁定的 managed pi runtime。Tower 從已驗證的 runner 通道及 runtime 綁定取得來源身分；模型不得透過參數冒充其他 `sourceThreadId`。

| 工具 | 輸入 | 返回內容 |
| --- | --- | --- |
| `thread_list` | 選填 `project`、`hostname`、`runnerId`、分頁游標 | 已連線 threads 的中繼資料、執行狀態、`canDelegate` 及不可受理原因 |
| `thread_delegate` | `targetThreadId`、文字 `prompt`、穩定的 `requestId` | `taskId`、受理狀態及查詢方式；不等待任務結果 |
| `thread_tasks` | 選填 `taskId`、`requestId`、狀態、分頁游標 | 本 thread 送出或收到的任務與已提交結果；`requestId` 僅查本 thread 送出的任務 |
| `thread_report` | `taskId`、`outcome: completed \| failed`、文字 `summary` | 已持久記錄的回報收據 |

查詢預設涵蓋同一 HQ 管轄的所有 runners，排除來源自己及已封存 thread；不得自動套用來源的 project、cwd、hostname 或 runnerId 作為篩選條件。只有呼叫者明確提供時才套用選填篩選。篩選比對規則與分頁須固定且有測試；`project`／`hostname` 採完整值比對，不用模糊比對決定路由。選定後一律用 thread ID 送出，受理時不得因來源與目標的專案或環境不同而拒絕。

同一來源的相同 `requestId` 與相同內容返回同一任務；相同 ID、不同目標或內容返回衝突。工具必須讓模型取得並重用該 ID，不得在傳輸重試時重新產生。拒絕向自己委派，避免把一般 follow-up 偽裝成協作。

受理等待上限為 10 秒，與任務執行時間無關。逾時表示結果可能不明：返回 `requestId` 及查詢指示，不宣稱未執行，也不另造 ID 重送。若連 task ID 都未收到，仍能以來源與 `requestId` 查詢。

新工具須限制字串大小、列表頁數與回覆大小，沿用現有訊息限制；不得以無限大小的環境值或任務文字繞過限制。精確限制在實作時與現有協定統一，寫入工具 schema 並測試邊界。

## 5. 受理、完成與結果歸屬

Tower 持久記錄任務身分與內容雜湊後，沿用 managed command 路徑送往固定目標。只有目標的持久收據確認後，才向來源表示已受理；僅寫入 Tower 不等於目標已開始執行。

任務狀態：

| 狀態 | 意義 |
| --- | --- |
| `dispatching` | Tower 已記錄，尚未確認目標受理 |
| `accepted` | 目標已受理，可能仍在 follow-up 佇列 |
| `running` | 目標開始處理該任務 |
| `completed`／`failed` | 目標明確提交成功／失敗摘要；是代理回報，不等於 Tower 獨立驗證工作成果 |
| `rejected` | 已確認未受理，例如目標離線或參數衝突 |
| `unknown` | 無法確認是否執行、是否完成，或執行已結束但缺少有效回報 |

目標收到的任務訊息附上 task ID、來源 thread ID／名稱及回報指示。目標代理使用 `thread_report` 回報；使用者不必手動報告或交接控制權。

回報只能由該任務的目標綁定提交，並驗證任務已進入執行。第一份持久回報固定結果；同內容重送返回原收據，不同內容返回衝突。晚到的有效回報可將 `unknown` 解析為完成／失敗，但不可推翻已提交的結果或已確認未受理的任務。

不能以全域 `agent_settled`、最後 assistant 文字或「目前所有 pending tasks」推測結果。一次一般回答不會自動完成其他任務。本機／網頁訊息、steering、其他委派交錯時，仍須使用明確 task ID。

尚無已提交結果的任務，若目標回合結束而未回報、被停止、`/new`、程序退出或接收回報失敗，保留已知證據並呈現 `unknown`，不可捏造成功摘要。尚未開始執行且可證明取消的工作則記為 `rejected`。已提交的結果不因停止或 ACK 遺失而退回 `unknown`。不自動重新執行任務；使用者若決定重試，須是新的明確委派。

## 6. 來源端非同步收件

每份已提交結果產生穩定的通知 ID，綁定原始 `sourceThreadId` 與 `taskId`。

- 來源忙碌：通知以可識別的 follow-up 等待，不 steering、不取消現有工具，不讓送出任務的工具持續掛著。
- 來源閒置且 runtime 可用：透過公開 pi extension／SDK 投遞結果訊息並觸發後續處理，讓來源能繼續原本工作；不要求使用者輪詢。
- 來源離線或已退出：Tower 保留已完成工作的結果，待原 thread 再次可用時投遞。這是結果補送，不是接受新的離線執行任務，也不喚醒替代 runtime。
- 來源執行 `/new`：結果仍屬於舊 thread，不得送入新對話。恢復原 thread 後才能補送。
- `thread_tasks` 隨時可查已持久結果；即時通知遺失不得讓任務結果跟著消失。

通知包含來源／目標、task ID、結果與原始委派關聯。本機與網頁顯示相同持久訊息；結果不是只存在工具狀態列的暫時提示。系統不把「已回報」說成目標已閒置，目標可能仍有其他工作。

投遞必須以通知 ID 去重。來源在 session 中保存可辨識的關聯記錄並持久化後才確認收件；crash 後先檢查既有記錄，不直接再觸發一次代理。若公開 API 無法確認插入／觸發是否完成，標記通知狀態不明並允許查詢，不以重試掩蓋風險。不可承諾 LLM 或工具副作用 exactly-once。

## 7. 持久資料、故障與信任邊界

所有 Tower 持久資料仍使用同一 SQLite。沿用 thread 的 `cwd` 欄位、增加 `hostname` 欄位，以及任務、結果與來源收件狀態；不新增資料庫服務。Runner 延用命令 journal 與補同步機制保存任務受理及待上報結果。

每筆任務至少保存 task ID、來源 thread ID、目標 thread ID／runner instance 綁定、request ID、內容雜湊、命令 ID、狀態與時間；結果保存摘要、結果雜湊及通知 ID。任務建立與去重索引須同一交易提交；結果與待通知紀錄亦須同一交易提交。

延用既有連線／runtime fencing。新功能不得以資料庫自增值或恢復後的舊 epoch 重新授權舊命令。Tower 或 runner 重啟、備份復原後，未確認的 dispatch 不自動重播；先依 task ID、命令收據及 runner journal 對帳，無證據就保持 `unknown`。重送已持久結果可以去重，與重新執行任務是兩件事。

不因快照清理而刪除任務去重紀錄、命令收據或結果關聯。資料庫遷移須保留既有 threads、entries、快照與 metadata version；新增欄位無資料時明確為未知，不假造環境。

認證沿用目前單一 Tower 的信任範圍，不新增未驗證的 metadata／委派端點。環境路徑與主機名稱可能敏感，只對現有授權範圍提供，文件須說明會上傳哪些值。名稱、路徑、任務文字與結果皆視為資料：畫面跳脫 HTML，不插值成 shell 指令，不把遠端摘要提升為 system 指示。

## 8. 畫面與既有行為

- Thread 清單／詳情顯示名稱、Project、hostname、cwd、連線狀態；完整 thread ID 可供識別。長路徑可截短呈現，但必須能檢視完整值。
- 對話可分辨「已委派」「目標排隊／執行中」「已回報」「狀態不明」，並連到原任務及目標 thread。
- 被委派的 thread B 回報給來源 thread A 時，B 的 Tower Web UI 必須顯示實際回報內容，並以獨立的協作訊息樣式及文字標籤「回覆給 runner A／thread 名稱」標明收件者。不能只顯示「已回報」、藏在工具 JSON 裡，或以一般回答使用者的 assistant 訊息呈現。內容過長可收合，但收件者與回報狀態必須保持可見，全文可展開閱讀。
- A 收到結果時，顯示「來自 runner B／thread 名稱的任務回報」及同一份回報內容。兩端都保留 task ID、發送／接收方向、runner ID 與 thread ID 的結構化關聯，可連回任務與對方 thread；名稱相同或改名後仍能辨認對象。
- 協作訊息不能只靠顏色區分，也不能從模型輸出的「回覆給某某」文字猜測收件者。Tower 依已驗證的任務／回報紀錄呈現；一般回答使用者的訊息不因相鄰位置而被標成協作回報。回報提交、待送達及已確認收件須分開顯示，不把「已提交」誤標為「對方已收到」。
- 回報內容與收件者標示是持久歷史的一部分，重新整理、斷線重連及離線閱讀時都保留，重送不產生第二份回報。使用 pi 公開 extension／SDK 與 Tower 的呈現能力，不修改 pi 核心；本機 TUI 可沿用公開擴充機制顯示內容，不要求重現 Web UI 的樣式。
- 不新增 Get control、Release control、等待全部子任務才能輸入的頁面，或自動建立新 runtime 的按鈕。
- 既有首頁 runner 數量、managed／legacy 合併顯示、原生 TUI 與網頁共同輸入、停止與 dialog 行為不得退步。

## 9. 實作順序與驗收

### A. 先驗證公開 API 的完整路徑

用隔離 HOME、資料目錄與測試 workspace，驗證公開 extension／SDK 能註冊新工具、可靠辨認任務執行結束、保存 task 關聯，並向原 thread 投遞可去重的結果 follow-up。須涵蓋閒置、忙碌、`/reload`、`/new` 與重新啟動。

Fake pi 用於協定與故障測試；真實 pi 使用無付費 LLM 的可控 provider 驗證工具及 session 行為，分開列出證據。若公開 API 不足，停止該方向並提出差距，不改核心、不用私有 API，也不以只靠輪詢替代自動收件後宣稱完成。

### B. 環境資訊與查詢

完成收集、schema 遷移、重新連線更新、工具查詢及畫面。以同名專案、不同 hostname／cwd、空白名稱與改名衝突測試；確認舊連線上報不會覆蓋新資料，離線資料不被誤判成可執行。

### C. 委派與明確回報

接上既有單 writer／輸入佇列與命令 journal，再加入任務記錄、report 工具及結果收件。不得以重寫 runtime 管理或 legacy helper 作為前提。

### 必須通過的情境

1. A 向 B 委派慢任務後，在 B 完成前，A 可接收本機／網頁新訊息並執行另一項工作。
2. A 向 B、C 委派，控制測試屏障證明兩個目標確實同時執行，而非只快速返回假的 accepted。
3. A、C 同時送到 B，B 按受理順序執行且始終只有一個 writer；本機／網頁 follow-up 仍能正常排隊。
4. B 的一般回答、其他任務回報與 steering 交錯，結果只回到正確 task；沒回報的任務不被判為完成。
5. 來源忙碌、閒置、離線、`/new` 後收到結果，各自符合第 6 節；同一結果重送不產生重複 session 訊息。
6. 受理 ACK 遺失、結果 ACK 遺失、相同 request ID 不同內容、回報內容衝突與跨 thread 偽造回報均有確定結果，不重新執行工作。
7. 查詢後目標斷線、同步失敗、被封存或 runtime 退出，送出時拒絕；已受理後斷線則保持可查的真實狀態，不偽裝成未執行。
8. 在 Tower 記錄前後、runner 受理前後、工具副作用之後、結果提交及來源收件確認前後 crash；重啟與舊備份復原不重播不明任務，不使過期連線重新有效。
9. 同名目錄不自動選錯 thread；HTML／shell 特殊字元及超大 metadata／prompt／summary 不突破呈現與訊息限制。
10. 執行既有完整回歸測試及新增測試，使用瀏覽器驗證 metadata、任務狀態、結果關聯與本機／網頁共同輸入，檢查實際截圖。
11. 同一 HQ 下，A、B 的 project、repo、cwd、hostname 全部不同，未指定篩選的查詢仍能互相找到；A→B 與 B→A 都能委派並收到正確結果。明確指定 project 篩選時才縮小查詢範圍；其他 HQ 的 runner 不出現在查詢中，也不能作為委派目標。
12. B 同時收到 A、C 的委派與使用者訊息，分別回報不同內容；桌機與手機 Web UI 能明確辨認每份回報的收件 runner／thread，使用者的一般回答不被誤標。兩端顯示相同回報內容，重新整理、離線閱讀、名稱變更與重送後仍保留正確方向和關聯；A 離線時，B 不得顯示「已確認收件」。

完成交付須列出實測 Node／pi 版本、fake 與真實 pi 證據、故障測試結果、遷移及手動測試指令。不能只測單一版本就宣稱最低版本已確認。

## 10. 實作定位

以下是調查入口，不要求每處都修改，也不新增通用協作框架：

- [`src/managed/runner.mjs`](../../src/managed/runner.mjs)：thread／runner 綁定、環境資料與命令路由。
- [`src/managed/tower.mjs`](../../src/managed/tower.mjs)：SQLite 目錄、metadata version、認證後查詢與持久命令收據。
- [`src/managed/journal.mjs`](../../src/managed/journal.mjs)：命令 ID／內容雜湊去重及重啟後 unknown 處理。
- [`src/managed/interactive.mjs`](../../src/managed/interactive.mjs)：原生 session 的公開 SDK 整合、輸入佇列與生命週期。
- [`src/extension.ts`](../../src/extension.ts)、[`src/lib.mjs`](../../src/lib.mjs)：現有 legacy 工具契約；`runTask` 等待 settled 再取最後回答，不適合作為新委派的結果關聯實作。
- [`src/ui/threads.html`](../../src/ui/threads.html)、[`src/ui/ui.html`](../../src/ui/ui.html)：thread 資訊、協作訊息及首頁相容性。
- [`test/`](../../test/)：沿用隔離測試方式，新增可控制排隊與故障時序的協作案例。

## 11. 實作與驗證紀錄

實作使用 pi 0.85.1 公開的 extension tools、session lifecycle、session 記錄、`prompt`、`sendCustomMessage` 與 `setSessionName`，沒有修改 pi 核心或存取私有成員。原生 TUI 與背景 RPC host 各自沿用既有 runtime，將委派及結果投遞放入同一個輸入佇列。任務結果只接受明確的 `thread_report`；回合結束、停止與程序中斷不會推導出成功結果。

### 測試如何對應驗收情境

| 證據 | 驗證內容 |
| --- | --- |
| `test/compat/verify-collaboration-api.mjs` | 第 9 節 A。真實 pi、可控 provider，驗證工具執行、task 記錄、閒置／忙碌自動收件、去重、reload、new、resume 與 session 重開。 |
| `test/verify-collaboration.mjs` | 三個真實 pi 程序，在不同 cwd 同時停於 B、C 的測試屏障；A 仍可處理輸入，C→B 排隊且執行順序固定。驗證不同 task 的明確摘要、普通回答維持 unknown、自動收件與空白名稱同步。 |
| `test/verify-native-collaboration.mjs` | 兩個真實原生 TUI。模型實際呼叫委派／回報工具，A 在 B 忙碌時繼續輸入；驗證 FIFO、兩端持久訊息、reload、本機改名、new 隔離，以及退出後重啟原 thread 補收結果。 |
| `test/verify-collaboration-protocol.mjs` | 真實 Tower 搭配 fake runner。驗證跨 project／cwd／hostname 雙向查詢與委派、精確篩選／分頁、來源綁定、衝突與偽造回報、通知 ACK 遺失、不可用／同步失敗／封存／離線拒絕、Tower 重啟、備份復原與 schema 3→5。 |
| `test/verify-collaboration-store.mjs`、`test/verify-collaboration-recovery.mjs` | 任務／回報交易、大小限制、不可變結果。以持久檔案與 SQLite 備份重建故障邊界：task 建立前的舊備份、report 提交前的舊備份、來源通知 intent 已寫入但無 session 記錄、session 記錄已寫入但 ACK 遺失、runner report outbox 重開，以及 ACK 不覆蓋較新的任務結束證據。另驗證離線改名衝突與明確解決。 |
| 既有 `verify-managed`、journal、snapshot crash、native 測試 | 沿用的命令 journal 在送出前後與受理／settled 邊界的 SIGKILL、snapshot 交易內六個 SIGKILL 邊界、舊 epoch 拒絕、原 cwd／單 writer、WebSocket 與原生 TUI 共同輸入、停止及 dialog。 |
| 瀏覽器與 `assets/collaboration-{desktop,mobile}.png` | 使用 `threads.html` 與 `test/compat/collaboration-browser-fixture.mjs` 的離線資料，在 728px 與 350px 兩種視窗寬度檢查三張協作卡片、收件方向、離線待送達與已確認收件的差異、普通回答獨立呈現、Host／Delegation 狀態格、HTML 以文字顯示及無水平溢出。2026-09-16 重拍，兩張截圖均已檢視；1200px 以上的七欄狀態格只有 CSS 審閱，沒有截圖。 |

跨主機的路由條件由 fake runner 提供不同 hostname 驗證；真實 pi 程序均在本機的隔離 workspace 執行。協作專用故障測試重建持久寫入邊界，沒有對每個協作指令位置逐一 SIGKILL，也沒有驗證付費 provider、實體多主機網路或已部署 HQ。這些限制不以「全部 crash 情境已通過」概括。

### 遷移、限制與重現指令

Tower 啟動時將同一個 SQLite 升到 schema 5，保留既有 catalog、metadata version、snapshots 與 commands，增加 `hostname` 欄位及 collaboration task／result／notification 資料表。升級前建立的 thread 在 runner 重新連線前沒有 hostname；部署前應備份 Tower 與 runner。本次只對隔離資料執行遷移。

工具 prompt／summary 各限 256 KiB UTF-8，可用既有 `PI_MANAGED_TEXT_BYTES` 調整；metadata／篩選值各限 4096 UTF-8 bytes，名稱限 200 字元。查詢預設 10 筆、最多 20 筆，依 UUID 排序，cursor 不包含自身。`thread_list` 只回傳 thread ID、名稱、runner、project、hostname、cwd、runtime 狀態與可受理資訊，不含佇列或對話內容。會上傳的環境值及共用 token 的可見範圍已寫入 README。

在安裝 pi 0.85.1 與 tmux 的本機執行：

```sh
npm run verify:collaboration
npm run verify:phase0
node test/compat/collaboration-browser-fixture.mjs
```

前兩項建立暫存 HOME、pi profile 與 workspace，不讀寫真實 session 或憑證；最後一項提供唯讀 UI 測試資料並印出本機 URL。實測 Node 版本為 22.22.0 與 26.8.2，pi 固定為 0.85.1，不宣稱支援更早的 pi 版本。

2026-09-16 在 Node 26.8.2、pi 0.85.1 的本機執行：`verify-collaboration-api`、`verify-collaboration-store`、`verify-collaboration-recovery`、`verify-collaboration-protocol`、`verify-collaboration` 全部通過；既有 `verify` 鏈中除 `verify:native` 外的每一項也通過。`verify-native-collaboration` 與 `verify-native` 需要 tmux，本機沒有安裝，這兩項當時沒有執行。沒有在 Node 22 上重跑。

2026-09-19 裝好 tmux 3.7c 後，在 Node 26.9.0、pi 0.85.1 的本機補跑 `node test/verify-native.mjs` 與 `node test/verify-native-collaboration.mjs`，兩項都通過。原生 TUI 的協作路徑至此有本機證據；Node 22 仍未重跑。

先前實作時曾重現 provider 非同步註冊後，可用模型快照尚未就緒而選到 `unknown`；host 在建立 session 前呼叫公開的 `modelRuntime.getAvailable()` 等待可用性查詢。這個修正已獨立成一個 commit 先進 main，也是 `verify-managed` 偶發逾時的原因。
