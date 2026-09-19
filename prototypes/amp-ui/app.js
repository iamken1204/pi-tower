const icons = {
  tower: '<path d="M8 21h8M9 17h6M10 13h4M11 7h2l3 14H8l3-14ZM7 8a7 7 0 0 1 0-5M17 8a7 7 0 0 0 0-5M4 10a11 11 0 0 1 0-9M20 10a11 11 0 0 0 0-9"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  compose: '<path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M10 14l1-4L18 3l3 3-7 7-4 1Z"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  folder: '<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3V7Z"/>',
  diamond: '<path d="m12 2 10 8-10 12L2 10 12 2Z"/><path d="m2 10 10 5 10-5M12 15V22M7 6l5 2 5-2"/>',
  monitor: '<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  archive: '<path d="M4 8h16v13H4V8ZM3 3h18v5H3V3ZM9 12h6"/>',
  threads: '<rect x="4" y="3" width="14" height="16" rx="2"/><path d="M8 7h6M8 11h6M8 15h4M18 7h3v15H7v-3"/>',
  "panel-left": '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  "panel-right": '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  more: '<circle cx="5" cy="12" r=".8"/><circle cx="12" cy="12" r=".8"/><circle cx="19" cy="12" r=".8"/>',
  edit: '<path d="m5 15 11-11 4 4L9 19l-6 2 2-6ZM14 6l4 4"/>',
  link: '<path d="m10 13 4-4M8 15l-2 2a3.5 3.5 0 0 1-5-5l5-5a3.5 3.5 0 0 1 5 0M13 9l2-2a3.5 3.5 0 0 1 5 5l-5 5a3.5 3.5 0 0 1-5 0"/>',
  "cloud-check": '<path d="M7 17H6a4 4 0 0 1-1-7 6 6 0 0 1 11-4 5 5 0 0 1 3 10M10 16l3 3 6-7"/>',
  "arrow-up": '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  "arrow-right": '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M18 8v2a5 5 0 0 1-5 5H6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  "check-circle": '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  terminal: '<path d="m5 7 5 5-5 5M13 17h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  moon: '<path d="M20 15A9 9 0 0 1 9 3a9 9 0 1 0 11 12Z"/>',
};
const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.diamond}</svg>`;
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
function fillIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((element) => { element.innerHTML = icon(element.dataset.icon); });
}

const runners = {
  "macbook-pro": { platform: "macOS", arch: "arm64", host: "Kettans-MacBook-Pro.local", projects: { "pi-tower": "/Users/kettan/career/raft-computer/pi-tower", iscrm: "/Users/kettan/career/iscrm" } },
  "iscoollab-pc": { platform: "Windows", arch: "amd64", host: "ISCOOLLAB-PC", projects: { robotiive: "C:\\workspace\\robotiive" } },
  "build-linux": { platform: "Linux", arch: "amd64", host: "build-linux.local", projects: { trackaholic: "/home/kettan/trackaholic", "pi-tower": "/home/kettan/pi-tower" } },
};
const collaborationTasks = [
  { title: "Windows 建置驗證", runner: "iscoollab-pc", thread: "build-windows", time: "14:32", summary: "三個執行檔已產出，Go 版本與 DLL 相依性檢查完成。", outcome: "已收到回報" },
  { title: "協作 API 回歸測試", runner: "build-linux", thread: "phase-zero", time: "14:34", summary: "委派、回報與重新連線測試通過，沒有發現既有行為退化。", outcome: "已收到回報" },
];
const threads = [
  { id: "collaboration", title: "Runner collaboration", project: "pi-tower", runner: "macbook-pro", state: "idle", time: "14:35", revision: 42, tasks: collaborationTasks },
  { id: "delegation", title: "委派設計借鑑", project: "pi-tower", runner: "macbook-pro", state: "idle", time: "13:48", revision: 28, tasks: [] },
  { id: "phase-zero", title: "Phase 0 compatibility", project: "pi-tower", runner: "build-linux", state: "idle", time: "14:34", revision: 16, tasks: [] },
  { id: "session-count", title: "Runner session 計數", project: "pi-tower", runner: "macbook-pro", state: "running", time: "14:38", revision: 9, tasks: [] },
  { id: "build-windows", title: "Windows 建置驗證", project: "robotiive", runner: "iscoollab-pc", state: "idle", time: "14:32", revision: 35, tasks: [] },
  { id: "docs", title: "文件更新檢視", project: "robotiive", runner: "iscoollab-pc", state: "idle", time: "11:20", revision: 12, tasks: [] },
  { id: "license", title: "Product license management", project: "iscrm", runner: "macbook-pro", state: "idle", time: "10:42", revision: 21, tasks: [] },
  { id: "api", title: "Backend build API mismatch", project: "trackaholic", runner: "build-linux", state: "idle", time: "09:16", revision: 7, tasks: [] },
  { id: "reconnect", title: "Runner 重新連線處理", project: "pi-tower", runner: "macbook-pro", state: "sleeping", time: "昨天", revision: 18, tasks: [] },
  { id: "migration", title: "SQLite migration notes", project: "pi-tower", runner: "build-linux", state: "sleeping", time: "昨天", revision: 6, tasks: [] },
];
const drafts = new Map();
const additions = new Map();
let currentId = threads.some((thread) => thread.id === location.hash.slice(1)) ? location.hash.slice(1) : "collaboration";
let activeView = "threads";
let dialogMode = "new";
let toastTimer;
const currentThread = () => threads.find((thread) => thread.id === currentId);

function userMessage(content, time = "14:28") {
  return `<article class="user-message"><div class="message-meta"><strong>你</strong><time>${time}</time></div><p>${content}</p></article>`;
}
function tool(name, description, output) {
  return `<details class="tool-call"><summary><span>${icon("terminal")}</span><span class="tool-name">${name}</span><span class="tool-detail">${description}</span><span data-icon="chevron"></span></summary><pre>${escapeHTML(output)}</pre></details>`;
}
function finish(time, duration) {
  return `<div class="message-finish">${icon("check-circle")}<span>${time} 完成</span><span class="finish-rule"></span><span>${duration}</span><button class="icon-button" data-copy-answer aria-label="複製回覆" title="複製回覆">${icon("copy")}</button></div>`;
}
const assistantLabel = `<div class="assistant-label">${icon("tower")}<span>pi</span></div>`;
function conversationContent(thread) {
  if (thread.fresh && additions.has(thread.id)) return "";
  if (thread.fresh) return `<div class="empty-thread"><span>${icon("tower")}</span><h2>接下來，做點什麼？</h2><p>在 <strong>${escapeHTML(thread.runner)}</strong> 的 ${escapeHTML(thread.project)} 工作目錄開始。</p><button class="prompt-suggestion" data-fill="先看看這個專案的結構，說明主要模組的用途。">${icon("arrow-right")}先熟悉這個專案</button><button class="prompt-suggestion" data-fill="檢查目前的變更，找出可能的錯誤或行為退化。">${icon("arrow-right")}檢查目前的程式碼變更</button></div>`;
  const date = `<div class="date-divider">${thread.state === "sleeping" ? "昨天" : "今天"}，9 月 ${thread.state === "sleeping" ? "18" : "19"} 日</div>`;
  if (thread.id === "collaboration") return date + userMessage("請把 Windows 建置交給 iscoollab-pc，協作 API 測試交給 build-linux。你留在這裡確認回報流程，最後整理結果。") + `<article class="assistant-message">${assistantLabel}<p>我會把兩項驗證分別交給對應的 Runner，並在這裡檢查委派紀錄、回報和接收狀態。</p>${tool("thread_list", "找到 3 個可用的 Runner", "macbook-pro   pi-tower      idle\niscoollab-pc  robotiive     idle\nbuild-linux  pi-tower      idle")}${tool("thread_delegate", "送出 2 項任務", "Windows build verification → iscoollab-pc\nCollaboration API tests    → build-linux\nBoth tasks accepted.\nSource thread continues independently.")}<div class="delegation-note">${icon("branch")}<span>已委派給</span><span class="runner-tag">iscoollab-pc</span><span class="runner-tag">build-linux</span></div><p>兩個 Runner 已接下任務。委派會保留來源對話，完成的回報也會送回這裡；各自的工作目錄與執行過程互不影響。</p><aside class="report"><div class="report-header">${icon("check-circle")}<strong>iscoollab-pc</strong><span>傳回執行結果</span><span class="report-status">14:32 · 已收到</span></div><p>Windows 建置完成，三個執行檔已產出。Go 版本與 DLL 相依性檢查通過，建置回傳碼為 0。</p><button class="report-link" data-thread="build-windows">查看 Runner 的對話 ${icon("arrow-right")}</button></aside><h2 class="result-heading">兩項驗證都完成了。</h2><p>建置與測試結果如下，兩份回報都已回到這段對話。</p><table class="result-table"><thead><tr><th>任務</th><th>Runner</th><th>結果</th></tr></thead><tbody><tr><td>Windows 正式版建置</td><td><code>iscoollab-pc</code></td><td><span class="result-check">${icon("check")}通過</span></td></tr><tr><td>協作 API 回歸測試</td><td><code>build-linux</code></td><td><span class="result-check">${icon("check")}通過</span></td></tr><tr><td>回報接收與同步</td><td><code>macbook-pro</code></td><td><span class="result-check">${icon("check")}已確認</span></td></tr></tbody></table><p>這次涵蓋建置、API 測試和回報流程。Windows 程式的執行階段功能測試還沒進行，可以接著交給原本的 Runner。</p>${finish("14:35", "耗時 6 分 42 秒")}</article>`;
  if (thread.id === "build-windows") return date + userMessage("執行 build-aio-prod.cmd，確認產出的執行檔與相依 DLL。", "14:29") + `<article class="assistant-message">${assistantLabel}<p>建置已完成，回傳碼為 <code>0</code>。三個執行檔都已產出到 <code>Dist\\</code>。</p>${tool("shell", "cmd.exe /d /c build-aio-prod.cmd", "Building robotiive_be.exe... OK\nBuilding robotether.exe... OK\nBuilding rtctl.exe... OK\nBUILD_SCRIPT_EXIT_CODE=0")}<h2 class="result-heading">產出檢查</h2><table class="result-table"><thead><tr><th>執行檔</th><th>大小</th><th>Go 版本</th></tr></thead><tbody><tr><td><code>robotiive_be.exe</code></td><td>115.1 MiB</td><td>1.26.1</td></tr><tr><td><code>robotether.exe</code></td><td>16.8 MiB</td><td>1.26.0</td></tr><tr><td><code>rtctl.exe</code></td><td>12.5 MiB</td><td>1.26.0</td></tr></tbody></table><p>三者皆為 Windows amd64。直接匯入的 DLL 都能在產出目錄或 Windows 系統目錄找到。</p><aside class="report"><div class="report-header">${icon("check-circle")}<strong>回報已送達</strong></div><p>結果已送回 macbook-pro 的 Runner collaboration 對話。</p><button class="report-link" data-thread="collaboration">返回來源對話 ${icon("arrow-right")}</button></aside>${finish("14:32", "耗時 3 分 18 秒")}</article>`;
  if (thread.id === "session-count") return date + userMessage("Runner 的 session 數量好像沒有跟著結束更新，幫我檢查一下。", "14:37") + `<article class="assistant-message">${assistantLabel}<p>我會先確認 session 結束時的清理流程，再對照 Runner 列表使用的計數來源。</p>${tool("read", "runner.mjs、managed-runner.mjs", "Reading runner lifecycle handlers...\nChecking session removal and state notifications...")}${tool("search", "sessions.size · close · publishState", "runner.mjs           session close handler\nmanaged-runner.mjs   runtime state publisher\ntower.mjs            runner state aggregation")}<p>正在比對連線中斷和正常結束的兩條流程。這個對話的示範狀態是「執行中」，可以在下方試用追加訊息、調整任務或停止。</p><div class="message-finish">${icon("clock")}<span>${thread.state === "running" ? "正在檢查 session 生命週期…" : "示範任務已停止"}</span></div></article>`;
  const examples = {
    "delegation": ["看看 Runner 之間的委派可以怎麼設計，保留來源對話的上下文。", "委派應該記下來源與目標對話。Runner 接下任務後，來源對話可以繼續工作，等完成回報再接著處理。", "回報流程", "任務完成和回報收到是兩個不同的狀態。介面會分別顯示，避免把「已送出」誤認成「對方已收到」。"],
    "phase-zero": ["執行協作 API 的回歸測試，特別注意重新連線後的回報。", "協作 API 的回歸測試已通過。委派、回報接收與重新連線後的查詢結果都符合預期。", "驗證範圍", "測試使用隔離的工作目錄和示範 provider，沒有呼叫付費模型。驗證結果已回報給來源對話。"],
    "docs": ["檢查 README 的建置說明和目前的腳本是否一致。", "README 的產出清單與建置腳本一致。已確認指令、輸出目錄和 Go 版本的說明。", "文件檢查", "建置使用根目錄的 build-aio-prod.cmd。MSYS2 和 Windows PATH 的 Go 版本不同，文件已分別註明。"],
    "license": ["先整理產品授權管理的現有流程，列出待釐清的地方。", "已整理授權建立、續期與到期檢查的流程。授權驗證會在服務啟動時執行，也會在使用相關功能時再次確認。", "待確認的行為", "離線時的寬限期需要產品決策；介面應明確顯示授權到期日，以及需要重新連線驗證的時間。"],
    "api": ["Backend build 的 API 型別對不上，幫我找出原因。", "呼叫端仍使用舊版回傳欄位，與目前 API 的型別定義不同。已將欄位對應更新並確認建置結果。", "變更結果", "呼叫端改讀取新的結果欄位。API 回傳內容保持不變，建置與型別檢查皆通過。"],
    "reconnect": ["記錄 Runner 斷線後重新連線的處理方式。", "Runner 會保留本機工作進度，連線恢復後再上傳紀錄。瀏覽器關閉也不會讓本機任務停止。", "對話已休眠", "這是原生終端機建立的對話。若要繼續，請回到原本的工作目錄，從終端機恢復。"],
    "migration": ["整理 SQLite 遷移的操作筆記。", "啟動時會套用資料庫遷移，保留既有的對話、檢查點與命令紀錄。", "備份筆記", "一致的備份需要先停止 Tower。還原時也需要保留原本 Runner 的資料與工作目錄。"],
  };
  const [prompt, answer, heading, detail] = examples[thread.id];
  return date + userMessage(prompt, thread.time) + `<article class="assistant-message">${assistantLabel}<p>${answer}</p>${tool("read", "已檢查相關程式碼與執行紀錄", "Sample preview output.\nRelated files and execution records reviewed.")}<h2 class="result-heading">${heading}</h2><p>${detail}</p>${finish(thread.time, "執行紀錄已儲存")}</article>`;
}

function threadButton(thread) {
  return `<button class="thread-link ${thread.id === currentId && activeView === "threads" ? "active" : ""}" data-thread="${thread.id}" ${thread.id === currentId && activeView === "threads" ? 'aria-current="page"' : ""}><span>${icon(thread.state === "sleeping" ? "moon" : "diamond")}</span><span class="thread-name">${escapeHTML(thread.title)}</span>${thread.state === "running" ? '<span class="status-dot running" title="執行中"></span>' : ""}</button>`;
}
function renderSidebar() {
  const query = $("search").value.trim().toLowerCase();
  const visible = threads.filter((thread) => thread.state !== "sleeping" && `${thread.title} ${thread.project} ${thread.runner}`.toLowerCase().includes(query));
  $("thread-nav").innerHTML = [...new Set(visible.map((thread) => thread.project))].map((project) => {
    const group = visible.filter((thread) => thread.project === project);
    return `<div class="project-group"><div class="project-heading">${icon("folder")}<span class="project-name">${escapeHTML(project)}</span><span class="group-line"></span><span class="group-count">${group.length}</span></div>${group.map(threadButton).join("")}</div>`;
  }).join("") || '<p class="no-results">沒有符合的對話。<br>試試對話名稱、專案或 Runner。</p>';
  $("inactive-threads").innerHTML = threads.filter((thread) => thread.state === "sleeping" && `${thread.title} ${thread.project}`.toLowerCase().includes(query)).map(threadButton).join("");
}
function renderInspector(thread) {
  const runner = runners[thread.runner];
  const tasks = thread.tasks;
  $("task-count").textContent = tasks.length;
  $("panel-context").innerHTML = `<h2 class="section-label">執行環境</h2><div class="runner-identity"><span class="runner-glyph">${icon("monitor")}</span><div><strong>${thread.runner}</strong><p><span class="status-dot"></span>已連線 <span>·</span> ${runner.platform} ${runner.arch}</p></div></div><dl class="context-list"><dt>主機</dt><dd class="mono">${runner.host}</dd><dt>執行方式</dt><dd>${thread.fresh ? "背景 Runner" : "原生終端機"}</dd><dt>對話狀態</dt><dd class="${thread.state === "idle" ? "text-green" : ""}">${thread.state === "running" ? "執行中" : thread.state === "sleeping" ? "已休眠" : "等待指令"}</dd></dl><section class="inspector-section"><h2 class="section-label">工作目錄</h2><div class="path-label">${icon("folder")}${escapeHTML(thread.project)}</div><p class="workspace-path">${escapeHTML(runner.projects[thread.project])}</p></section><section class="inspector-section"><h2 class="section-label">對話紀錄</h2><dl class="context-list thread-info"><dt>最後更新</dt><dd>${thread.time}</dd><dt>檢查點</dt><dd class="mono">revision ${thread.revision}</dd><dt>雲端同步</dt><dd class="text-green">已同步</dd></dl></section><section class="inspector-section"><h2 class="section-label">協作任務${tasks.length ? ` · ${tasks.length}` : ""}</h2>${tasks.length ? tasks.map((task) => `<div class="mini-task">${icon("check-circle")}<div><div class="mini-task-name">${task.title}</div><div class="mini-task-meta">${task.runner} · ${task.outcome}</div></div></div>`).join("") + `<button class="text-button" data-open-tasks>查看協作紀錄 ${icon("arrow-right")}</button>` : '<p class="inspector-note">這段對話還沒有委派任務。</p>'}</section><section class="inspector-section"><p class="inspector-note">每段對話固定在原本的主機與目錄執行。關閉頁面後，Runner 仍會繼續工作。</p></section>`;
  $("panel-tasks").innerHTML = `<div class="tasks-heading"><h2>協作紀錄</h2><span>${tasks.length ? `${tasks.length} / ${tasks.length} 已完成` : "尚無任務"}</span></div>${tasks.length ? tasks.map((task) => `<article class="task-detail"><h3>${task.title}</h3><span class="task-runner">${task.runner}</span><p>${task.summary}</p><div class="task-receipt">${icon("check-circle")}${task.time} · ${task.outcome}</div><button class="report-link" data-thread="${task.thread}">查看對話 ${icon("arrow-right")}</button></article>`).join("") : '<p class="inspector-note">交給其他 Runner 的任務，會在這裡顯示執行進度與回報。</p>'}<section class="inspector-section"><h2 class="section-label">回報流程</h2><p class="inspector-note">Runner 完成工作後送出回報。來源對話收到結果，才會顯示「已收到回報」。</p></section>`;
}
function updateComposer() {
  const thread = currentThread();
  const sleeping = thread.state === "sleeping";
  const running = thread.state === "running";
  $("prompt").disabled = sleeping;
  $("prompt").placeholder = sleeping ? "請從原本的終端機恢復這段對話" : running ? "追加訊息，或調整目前的任務…" : "繼續這段對話…";
  $("send").disabled = sleeping || !$("prompt").value.trim();
  $("steer").hidden = !running;
  $("stop").hidden = !running;
  $("composer-dot").className = `status-dot${running ? " running" : sleeping ? " offline" : ""}`;
  $("composer-runner").textContent = thread.runner;
  $("composer-project").textContent = thread.project;
  $("composer-hint").textContent = sleeping ? "回到原本目錄，使用 pi-runner -c 繼續。" : running ? "追加的訊息會排在目前任務之後。" : "每段對話，都在原本的工作環境繼續。";
}
function selectThread(id, updateHash = true) {
  const thread = threads.find((item) => item.id === id);
  if (!thread) return;
  drafts.set(currentId, $("prompt").value);
  currentId = id;
  activeView = "threads";
  $("header-title").textContent = thread.title;
  document.title = `${thread.title} · pi tower`;
  $("header-state").innerHTML = `<span class="status-dot ${thread.state === "running" ? "running" : thread.state === "sleeping" ? "offline" : ""}"></span>${thread.state === "running" ? "執行中" : thread.state === "sleeping" ? "已休眠" : thread.fresh ? "等待指令" : "已完成"}`;
  $("header-state").hidden = false;
  $("thread-menu-button").hidden = false;
  $("runners-view").hidden = true;
  $("conversation-scroll").hidden = false;
  $("composer-area").hidden = false;
  $("conversation").innerHTML = conversationContent(thread) + (additions.get(id) || "");
  $("prompt").value = drafts.get(id) || "";
  $("prompt").style.height = "";
  $("threads-tab").classList.add("active");
  $("threads-tab").setAttribute("aria-pressed", "true");
  $("runners-tab").classList.remove("active");
  $("runners-tab").setAttribute("aria-pressed", "false");
  renderSidebar();
  renderInspector(thread);
  updateComposer();
  fillIcons();
  closeDrawers();
  closeThreadMenu();
  $("conversation-scroll").scrollTop = 0;
  if (updateHash) location.hash = id;
}
function selectTab(name, focus = false) {
  document.querySelectorAll("[data-tab]").forEach((tab) => {
    const selected = tab.dataset.tab === name;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", selected);
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
  $("panel-context").hidden = name !== "context";
  $("panel-tasks").hidden = name !== "tasks";
}
function showRunners() {
  activeView = "runners";
  $("header-title").textContent = "Runners";
  document.title = "Runners · pi tower";
  $("header-state").hidden = true;
  $("thread-menu-button").hidden = true;
  $("conversation-scroll").hidden = true;
  $("composer-area").hidden = true;
  $("runners-view").hidden = false;
  $("threads-tab").classList.remove("active");
  $("threads-tab").setAttribute("aria-pressed", "false");
  $("runners-tab").classList.add("active");
  $("runners-tab").setAttribute("aria-pressed", "true");
  $("runners-view").innerHTML = `<div class="runners-inner"><h2>你的工作環境，都在這裡。</h2><p class="runners-intro">3 個 Runner 已連線。選擇對話，即可回到對應主機繼續工作。<br>以下為靜態示範狀態。</p>${Object.entries(runners).map(([name, runner]) => `<article class="runner-row"><div class="runner-row-head"><span class="runner-glyph">${icon("monitor")}</span><div><h3>${name}</h3><p>${runner.platform} ${runner.arch} · ${runner.host}</p></div><span class="runner-online"><span class="status-dot"></span>已連線</span></div><div class="runner-thread-list">${threads.filter((thread) => thread.runner === name && thread.state !== "sleeping").map((thread) => `<button data-thread="${thread.id}">${icon("diamond")}${escapeHTML(thread.title)}${icon("arrow-right")}</button>`).join("")}</div></article>`).join("")}</div>`;
  renderSidebar();
  closeThreadMenu();
  closeDrawers();
}
function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 3500);
}
function closeThreadMenu() {
  $("thread-menu").hidden = true;
  $("thread-menu-button").setAttribute("aria-expanded", "false");
}
function syncDrawerButtons() {
  const sidebarVisible = innerWidth <= 700 ? $("app").classList.contains("sidebar-open") : !$("app").classList.contains("sidebar-hidden");
  const inspectorVisible = innerWidth < 1200 ? $("app").classList.contains("inspector-open") : !$("app").classList.contains("inspector-hidden");
  $("sidebar-toggle").setAttribute("aria-expanded", sidebarVisible);
  $("sidebar-toggle").setAttribute("aria-label", sidebarVisible ? "收合對話導覽" : "開啟對話導覽");
  $("inspector-toggle").setAttribute("aria-expanded", inspectorVisible);
  $("inspector-toggle").setAttribute("aria-label", inspectorVisible ? "收合詳細資訊" : "開啟詳細資訊");
}
function closeDrawers() {
  $("app").classList.remove("sidebar-open", "inspector-open");
  $("drawer-backdrop").hidden = true;
  $("sidebar").inert = false;
  $("main-panel").inert = false;
  $("inspector").inert = false;
  syncDrawerButtons();
}
function openDrawer(name) {
  closeDrawers();
  $("app").classList.add(`${name}-open`);
  $("drawer-backdrop").hidden = false;
  $("main-panel").inert = true;
  $(name === "sidebar" ? "inspector" : "sidebar").inert = true;
  $(name === "sidebar" ? "sidebar-close" : "inspector-close").focus();
  syncDrawerButtons();
}
function openSearch() {
  $("search-wrap").hidden = false;
  $("app").classList.remove("sidebar-hidden");
  if (innerWidth <= 700) openDrawer("sidebar");
  $("search").focus();
  syncDrawerButtons();
}
function projectOptions() {
  const projects = runners[$("new-runner").value].projects;
  $("new-project").innerHTML = Object.entries(projects).map(([name, path]) => `<option value="${escapeHTML(name)}">${escapeHTML(path)}</option>`).join("");
}
function openThreadDialog(mode) {
  dialogMode = mode;
  closeThreadMenu();
  closeDrawers();
  $("dialog-title").textContent = mode === "new" ? "開始一段對話" : "重新命名對話";
  $("dialog-description").textContent = mode === "new" ? "選擇 Runner 和工作目錄，接著交代任務。" : "取一個方便回頭找到的名字。";
  $("new-thread-fields").hidden = mode !== "new";
  $("new-title").value = mode === "new" ? "" : currentThread().title;
  $("thread-dialog").querySelector(".dialog-note").textContent = mode === "new" ? "靜態預覽：這次操作只會新增本頁的示範對話。" : "靜態預覽：名稱只會保留在本頁。";
  $("dialog-submit").innerHTML = `${mode === "new" ? "建立對話" : "儲存名稱"}${icon("arrow-right")}`;
  $("new-runner").value = currentThread().runner;
  projectOptions();
  $("thread-dialog").showModal();
  $("new-title").focus();
}
function submitMessage(steering = false) {
  const text = $("prompt").value.trim();
  if (!text || currentThread().state === "sleeping") return;
  const time = new Date().toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
  const action = steering ? "調整任務" : currentThread().state === "running" ? "追加訊息" : "傳送訊息";
  const content = userMessage(escapeHTML(text).replace(/\n/g, "<br>"), time) + `<p class="preview-response">${action}的預覽已加入對話。正式串接後，訊息會送往 <strong>${currentThread().runner}</strong>。本頁不會執行任務。</p>`;
  additions.set(currentId, (additions.get(currentId) || "") + content);
  $("conversation").querySelector(".empty-thread")?.remove();
  $("conversation").insertAdjacentHTML("beforeend", content);
  $("prompt").value = "";
  $("prompt").style.height = "";
  drafts.set(currentId, "");
  updateComposer();
  $("conversation-scroll").scrollTop = $("conversation-scroll").scrollHeight;
  $("prompt").focus();
  toast(`${action}預覽已加入，未連線到 Runner`);
}
async function copyText(value, confirmation) {
  try {
    await navigator.clipboard.writeText(value);
    toast(confirmation);
  } catch {
    toast("瀏覽器未允許複製，請選取文字後手動複製。");
  }
}

document.addEventListener("click", (event) => {
  const thread = event.target.closest("[data-thread]");
  if (thread) selectThread(thread.dataset.thread);
  const suggestion = event.target.closest("[data-fill]");
  if (suggestion) { $("prompt").value = suggestion.dataset.fill; updateComposer(); $("prompt").focus(); }
  if (event.target.closest("[data-open-tasks]")) selectTab("tasks", true);
  if (event.target.closest("[data-copy-answer]")) copyText(event.target.closest(".assistant-message").innerText, "回覆已複製");
  if (!event.target.closest("#thread-menu, #thread-menu-button")) closeThreadMenu();
});
$("sidebar-toggle").onclick = () => {
  if (innerWidth <= 700) openDrawer("sidebar");
  else { $("app").classList.toggle("sidebar-hidden"); syncDrawerButtons(); }
};
$("inspector-toggle").onclick = () => {
  if (innerWidth < 1200) openDrawer("inspector");
  else { $("app").classList.toggle("inspector-hidden"); syncDrawerButtons(); }
};
$("sidebar-close").onclick = () => { closeDrawers(); $("sidebar-toggle").focus(); };
$("inspector-close").onclick = () => { closeDrawers(); $("inspector-toggle").focus(); };
$("drawer-backdrop").onclick = () => { const button = $("app").classList.contains("sidebar-open") ? "sidebar-toggle" : "inspector-toggle"; closeDrawers(); $(button).focus(); };
$("search-toggle").onclick = openSearch;
$("search").oninput = renderSidebar;
$("inactive-toggle").onclick = () => {
  $("inactive-threads").hidden = !$("inactive-threads").hidden;
  $("inactive-toggle").setAttribute("aria-expanded", !$("inactive-threads").hidden);
};
$("threads-tab").onclick = () => selectThread(currentId);
$("runners-tab").onclick = showRunners;
$("new-thread").onclick = () => openThreadDialog("new");
$("rename-thread").onclick = () => openThreadDialog("rename");
$("copy-thread").onclick = () => { copyText(location.href.split("#")[0] + "#" + currentId, "預覽連結已複製"); closeThreadMenu(); };
$("thread-menu-button").onclick = () => { $("thread-menu").hidden = !$("thread-menu").hidden; $("thread-menu-button").setAttribute("aria-expanded", !$("thread-menu").hidden); };
$("dialog-close").onclick = () => $("thread-dialog").close();
$("new-runner").onchange = projectOptions;
$("thread-form").onsubmit = (event) => {
  event.preventDefault();
  const title = $("new-title").value.trim();
  if (!title) { $("new-title").focus(); return; }
  if (dialogMode === "rename") currentThread().title = title;
  else {
    const id = `preview-${Date.now()}`;
    threads.unshift({ id, title, runner: $("new-runner").value, project: $("new-project").value, state: "idle", time: "剛剛", revision: 0, tasks: [], fresh: true });
    $("thread-dialog").close();
    selectThread(id);
    $("prompt").focus();
    return;
  }
  $("thread-dialog").close();
  selectThread(currentId);
  toast("對話名稱已更新");
};
document.querySelectorAll("[data-tab]").forEach((tab) => {
  tab.onclick = () => selectTab(tab.dataset.tab);
  tab.onkeydown = (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      selectTab(event.key === "Home" ? "context" : event.key === "End" ? "tasks" : tab.dataset.tab === "tasks" ? "context" : "tasks", true);
    }
  };
});
$("prompt").oninput = () => { updateComposer(); $("prompt").style.height = "auto"; $("prompt").style.height = `${Math.min($("prompt").scrollHeight, 150)}px`; };
$("prompt").onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submitMessage(); }
};
$("composer").onsubmit = (event) => { event.preventDefault(); submitMessage(); };
$("steer").onclick = () => { if (!$("prompt").value.trim()) { $("prompt").focus(); toast("先輸入要調整的任務內容"); } else submitMessage(true); };
$("stop").onclick = () => { currentThread().state = "idle"; selectThread(currentId); toast("示範任務已停止"); };
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !$("thread-dialog").open) { event.preventDefault(); openSearch(); }
  if (event.key === "Escape" && !$("thread-dialog").open) {
    const drawer = $("app").classList.contains("sidebar-open") ? "sidebar-toggle" : $("app").classList.contains("inspector-open") ? "inspector-toggle" : null;
    closeDrawers(); closeThreadMenu();
    if (!$("search-wrap").hidden) { $("search").value = ""; $("search-wrap").hidden = true; renderSidebar(); }
    if (drawer) $(drawer).focus();
    else if (document.activeElement === $("search")) $("search-toggle").focus();
  }
  if (event.key === "Tab" && !$("drawer-backdrop").hidden && !$("thread-dialog").open) {
    const drawer = $($("app").classList.contains("sidebar-open") ? "sidebar" : "inspector");
    const focusable = [...drawer.querySelectorAll('button, a, input, [tabindex="0"]')].filter((element) => element.getClientRects().length && !element.disabled);
    if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus(); }
  }
});
window.addEventListener("hashchange", () => { if (location.hash.slice(1) !== currentId || activeView !== "threads") selectThread(location.hash.slice(1), false); });
let viewportWidth = innerWidth;
window.addEventListener("resize", () => {
  if (innerWidth !== viewportWidth) closeDrawers();
  viewportWidth = innerWidth;
});
fillIcons();
selectThread(currentId, false);
