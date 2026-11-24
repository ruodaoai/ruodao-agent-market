(function () {
  "use strict";

  const HOST = window.ruodao || null;
  const TOKEN_KEY = "deviceToken";
  const SETTINGS_KEY = "settings";
  const TASKS_KEY = "orderTasks";
  const DEFAULT_WEB = "https://ruodao.com";

  const STATUS_META = {
    pending_accept: { label: "待接单", cls: "pill-pending" },
    in_progress: { label: "进行中", cls: "pill-in_progress" },
    revision: { label: "修改中", cls: "pill-revision" },
    delivered: { label: "待验收", cls: "pill-delivered" },
    completed: { label: "已完成", cls: "pill-completed" },
    cancelled: { label: "已取消", cls: "pill-cancelled" },
  };

  const TABS = [
    { id: "pending", label: "待接单" },
    { id: "in_progress", label: "进行中" },
    { id: "delivered", label: "待验收" },
    { id: "completed", label: "已完成" },
    { id: "chat", label: "群聊待回复" },
    { id: "all", label: "全部" },
    { id: "agents", label: "我的 Agent" },
  ];

  const PRODUCT_TYPES = [
    ["web", "Web 应用"],
    ["landing", "落地页"],
    ["content", "内容包"],
    ["document", "文档"],
    ["video", "视频"],
    ["image", "图片"],
    ["automation", "自动化"],
    ["other", "其他"],
  ];

  const state = {
    info: null,
    token: "",
    settings: { apiBaseUrl: "", webBaseUrl: DEFAULT_WEB, deviceName: "", modelId: "", workspace: "" },
    me: null,
    orders: [],
    orderTasks: {},
    activeTab: "pending",
    activeOrderId: "",
    detail: null,
    detailLoading: false,
    detailError: "",
    loadingOrders: false,
    loadError: "",
    task: null,
    busy: {},
    declineOpen: false,
    caseOpen: false,
    unpairArmed: false,
    models: [],
    toastTimer: null,
    chatRuns: [],
    chatLoading: false,
    chatError: "",
    chatActiveRunId: "",
    chatContext: null,
    chatContextLoading: false,
    chatRunning: null,
  };

  const $ = (selector) => document.querySelector(selector);

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function money(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "0.00";
    return number.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function date(value) {
    if (!value) return "—";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return String(value);
    return parsed.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function ago(value) {
    if (!value) return "";
    const parsed = new Date(value).getTime();
    if (!Number.isFinite(parsed)) return "";
    const diff = Date.now() - parsed;
    if (diff < 60_000) return "刚刚";
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + " 分钟前";
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + " 小时前";
    if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + " 天前";
    return date(value);
  }

  function statusMeta(status) {
    return STATUS_META[status] || { label: status || "未知", cls: "" };
  }

  function baseApi() {
    const configured = String(state.settings.apiBaseUrl || "").trim().replace(/\/+$/, "");
    if (configured) return configured;
    const fromHost = state.info && state.info.apiBaseUrl ? String(state.info.apiBaseUrl).replace(/\/+$/, "") : "";
    return fromHost || DEFAULT_WEB;
  }

  function baseWeb() {
    return String(state.settings.webBaseUrl || DEFAULT_WEB).replace(/\/+$/, "");
  }

  function lines(value) {
    return String(value == null ? "" : value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 50);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isAuthError(error) {
    const message = String((error && error.message) || error || "");
    return /配对|令牌|登录|401|403/i.test(message);
  }

  async function api(path, options) {
    if (!HOST || !HOST.network) throw new Error("请从若道桌面端打开接单台");
    const opts = options || {};
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (state.token) headers.authorization = "Bearer " + state.token;
    const response = await HOST.network.fetch(baseApi() + path, {
      method: opts.method || "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    let payload = null;
    try {
      payload = JSON.parse(response.body || "null");
    } catch {
      throw new Error("服务返回了无法解析的内容（HTTP " + response.status + "）");
    }
    if (!response.ok || !payload || payload.success === false) {
      const message = (payload && (payload.message || payload.errorCode)) || ("请求失败（HTTP " + response.status + "）");
      throw new Error(String(message));
    }
    return payload.data;
  }

  /* ── storage ─────────────────────────────────────────── */

  async function loadStorage() {
    if (!HOST || !HOST.storage) return;
    try {
      const data = await HOST.storage.get();
      state.token = typeof data.deviceToken === "string" ? data.deviceToken : "";
      if (data.settings && typeof data.settings === "object") {
        state.settings = Object.assign({}, state.settings, data.settings);
      }
      if (data.orderTasks && typeof data.orderTasks === "object") {
        state.orderTasks = Object.assign({}, data.orderTasks);
      }
    } catch {
      /* 宿主存储不可用时按未配对处理 */
    }
  }

  async function persistSettings() {
    if (!HOST || !HOST.storage) return;
    await HOST.storage.set({ [SETTINGS_KEY]: state.settings }).catch(() => undefined);
  }

  async function persistToken(token) {
    state.token = token;
    if (!HOST || !HOST.storage) return;
    if (token) await HOST.storage.set({ [TOKEN_KEY]: token }).catch(() => undefined);
    else await HOST.storage.remove(TOKEN_KEY).catch(() => undefined);
  }

  async function persistOrderTasks() {
    if (!HOST || !HOST.storage) return;
    await HOST.storage.set({ [TASKS_KEY]: state.orderTasks }).catch(() => undefined);
  }

  /* ── toast & common ──────────────────────────────────── */

  function toast(message, tone) {
    const element = $("#toast");
    if (!element) return;
    element.textContent = message;
    element.className = "toast" + (tone ? " is-" + tone : "");
    element.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { element.hidden = true; }, 3400);
  }

  function openExternal(url) {
    if (!HOST || !HOST.openExternal) {
      toast("当前桌面端不支持打开外部网页", "error");
      return;
    }
    HOST.openExternal(url).catch((error) => toast(error.message || "打开网页失败", "error"));
  }

  function findAgent(agentId) {
    const list = (state.me && state.me.agents) || [];
    return list.find((entry) => entry && entry.agent && entry.agent.id === agentId) || null;
  }

  function matchesTab(order) {
    switch (state.activeTab) {
      case "pending": return order.status === "pending_accept";
      case "in_progress": return order.status === "in_progress" || order.status === "revision";
      case "delivered": return order.status === "delivered";
      case "completed": return order.status === "completed";
      case "all": return true;
      default: return false;
    }
  }

  function busyAttr(name) {
    return state.busy[name] ? " disabled" : "";
  }

  /* ── data loading ────────────────────────────────────── */

  async function loadModels() {
    if (!HOST || !HOST.models) return;
    try {
      const listing = await HOST.models.list();
      const providers = Array.isArray(listing && listing.providers) ? listing.providers : [];
      const options = [];
      providers.forEach((provider) => {
        if (!provider || provider.enabled === false) return;
        const declared = Array.isArray(provider.models) && provider.models.length
          ? provider.models
          : (provider.model ? [provider.model] : []);
        declared.forEach((model) => {
          const id = typeof model === "string" ? model : model && model.id;
          if (!id) return;
          const meta = typeof model === "object" && model ? model : {};
          const outputs = Array.isArray(meta.outputTypes) ? meta.outputTypes : [];
          if (outputs.length && outputs.indexOf("text") < 0) return;
          const cloud = String(provider.provider || "").startsWith("ruodao-") || provider.modelOrigin === "platform-cloud";
          options.push({
            key: provider.provider + "::" + id,
            provider: provider.provider,
            providerName: provider.name || provider.provider,
            model: id,
            modelConfigId: provider.modelConfigId || "",
            label: (provider.name || provider.provider) + " · " + id,
            group: provider.modelGroup === "云端模型" || provider.modelGroup === "自定义模型"
              ? provider.modelGroup
              : (cloud ? "云端模型" : "自定义模型"),
            // 计费口径与推荐标记随宿主目录下发，模型选择器要按任务栏口径展示。
            billingMode: meta.billingMode || "",
            perCallQuota: meta.perCallQuota,
            modelRatio: meta.modelRatio,
            isRecommended: Boolean(meta.isRecommended),
          });
        });
      });
      state.models = options;
    } catch {
      state.models = [];
    }
  }

  function resolveModel() {
    const option = state.models.find((entry) => entry.key === state.settings.modelId);
    if (!option) return null;
    const payload = { provider: option.provider, model: option.model };
    if (option.modelConfigId) payload.modelConfigId = option.modelConfigId;
    return payload;
  }

  async function refreshAll(options) {
    if (!state.token) return;
    const opts = options || {};
    state.loadError = "";
    state.loadingOrders = true;
    renderOrders();
    try {
      state.me = await api("/api/agent-market/seller/me");
      const page = await api("/api/agent-market/seller/orders?status=all&page=1&size=48");
      state.orders = Array.isArray(page && page.items) ? page.items : [];
    } catch (error) {
      if (isAuthError(error)) {
        await clearPairing();
        toast("配对已失效，请在网页端重新生成配对码", "error");
        return;
      }
      state.loadError = error.message;
      if (!opts.silent) toast(error.message, "error");
    } finally {
      state.loadingOrders = false;
    }
    if (state.me) await heartbeatPresence();
    if (state.activeOrderId) await reloadDetail();
    await loadChatQueue();
    render();
  }

  async function loadChatQueue() {
    if (!state.token) {
      state.chatRuns = [];
      return;
    }
    try {
      const list = await api("/api/agent-market/chat/runs?status=queued&limit=30");
      state.chatRuns = Array.isArray(list) ? list : [];
      state.chatError = "";
    } catch (error) {
      state.chatError = error.message;
    }
  }

  async function refreshChatRuns() {
    state.chatLoading = !state.chatRuns.length;
    if (state.activeTab === "chat") renderChat();
    await loadChatQueue();
    state.chatLoading = false;
    if (!state.chatRunning) {
      renderChat();
      renderTabs();
    }
  }

  async function reloadDetail() {
    if (!state.activeOrderId) return;
    try {
      state.detail = await api("/api/agent-market/seller/orders/" + encodeURIComponent(state.activeOrderId));
      state.detailError = "";
    } catch (error) {
      state.detailError = error.message;
    }
  }

  async function clearPairing() {
    state.token = "";
    state.me = null;
    state.orders = [];
    state.activeOrderId = "";
    state.detail = null;
    state.task = null;
    state.activeTab = "pending";
    state.chatRuns = [];
    state.chatActiveRunId = "";
    state.chatContext = null;
    state.chatRunning = null;
    await persistToken("");
    render();
  }

  /* ── rendering ───────────────────────────────────────── */

  function render() {
    renderChrome();
    const paired = Boolean(state.token);
    $("#pairView").hidden = paired;
    $("#workView").hidden = !paired;
    if (!paired) renderPair();
    renderStats();
    renderTabs();
    renderOrders();
    renderDetail();
    renderAgents();
    renderChat();
    renderSettings();
  }

  function renderChrome() {
    const box = $("#topStatus");
    if (!box) return;
    if (!state.token) {
      box.innerHTML = '<span class="dot"></span><span>未配对 · 先在网页端生成配对码</span>';
      return;
    }
    if (!state.me) {
      box.innerHTML = '<span class="dot is-warn"></span><span>已配对 · 正在同步接单数据…</span>';
      return;
    }
    box.innerHTML =
      '<span class="dot is-live"></span><span>已配对 · ' + esc(state.me.userName || "卖家") +
      ' · 可结算余额 ¥' + esc(money(state.me.wallet && state.me.wallet.balance)) + "</span>";
  }

  function renderPair() {
    const hint = $("#pairServerHint");
    if (hint) hint.textContent = "服务：" + baseApi();
    const device = $("#pairDeviceInput");
    if (device && !device.value) device.value = state.settings.deviceName || "我的工作电脑";
  }

  function renderStats() {
    const box = $("#stats");
    if (!box) return;
    const me = state.me;
    const wallet = (me && me.wallet) || {};
    const rows = [
      { label: "待接单", value: me ? me.pendingOrders : "—", accent: false },
      { label: "进行中", value: me ? me.inProgressOrders : "—" },
      { label: "待验收", value: me ? me.deliveredOrders : "—" },
      { label: "已完成", value: me ? me.completedOrders : "—" },
      { label: "可结算余额", value: "¥" + money(wallet.balance), accent: true },
    ];
    box.innerHTML = rows.map((row) =>
      '<div class="stat' + (row.accent ? " is-accent" : "") + '"><span>' + esc(row.label) + "</span><strong>" + esc(row.value) + "</strong></div>"
    ).join("");
  }

  function tabCount(tabId) {
    const me = state.me;
    if (tabId === "agents") return me && Array.isArray(me.agents) ? me.agents.length : 0;
    if (tabId === "chat") return state.chatRuns.length;
    if (tabId === "all") return state.orders.length;
    if (!me) return 0;
    if (tabId === "pending") return me.pendingOrders || 0;
    if (tabId === "in_progress") return me.inProgressOrders || 0;
    if (tabId === "delivered") return me.deliveredOrders || 0;
    if (tabId === "completed") return me.completedOrders || 0;
    return 0;
  }

  function renderTabs() {
    const box = $("#tabs");
    if (!box) return;
    box.innerHTML = TABS.map((tab) => {
      const count = tabCount(tab.id);
      return '<button class="tab' + (state.activeTab === tab.id ? " is-active" : "") + '" type="button" data-action="tab" data-tab="' +
        esc(tab.id) + '">' + esc(tab.label) + '<span class="count">' + esc(count) + "</span></button>";
    }).join("");
    const layout = document.querySelector(".work-layout");
    const agents = $("#agentsView");
    const chat = $("#chatView");
    const agentsTab = state.activeTab === "agents";
    const chatTab = state.activeTab === "chat";
    if (layout) layout.hidden = agentsTab || chatTab;
    if (agents) agents.hidden = !agentsTab;
    if (chat) chat.hidden = !chatTab;
  }

  function emptyTextForTab() {
    switch (state.activeTab) {
      case "pending": return ["暂时没有新委托", "把 Agent 状态设为「接单中」，买家就能在广场下单。"];
      case "in_progress": return ["没有进行中的委托", "接单后会出现在这里，可以启动本机 Agent 执行。"];
      case "delivered": return ["没有待验收的交付", "提交交付后，买家有 72 小时验收，也可以主动催一下。"];
      case "completed": return ["还没有完成的委托", "买家验收通过后，款项会结算到余额。"];
      default: return ["还没有委托", "先去网页端完善 Agent 能力与服务包。"];
    }
  }

  function renderOrders() {
    const box = $("#orderList");
    if (!box) return;
    if (state.loadingOrders && !state.orders.length) {
      box.innerHTML = '<div class="skeleton">正在加载委托…</div>';
      return;
    }
    if (state.loadError) {
      box.innerHTML = '<div class="empty-list"><strong>加载失败</strong><p>' + esc(state.loadError) + "</p><p><button class=\"link-btn\" type=\"button\" data-action=\"refresh\">重试</button></p></div>";
      return;
    }
    const items = state.orders.filter(matchesTab);
    if (!items.length) {
      const empty = emptyTextForTab();
      box.innerHTML = '<div class="empty-list"><strong>' + esc(empty[0]) + "</strong><p>" + esc(empty[1]) + "</p></div>";
      return;
    }
    box.innerHTML = items.map((order) => {
      const meta = statusMeta(order.status);
      return '<button class="order-card' + (order.id === state.activeOrderId ? " is-active" : "") +
        '" type="button" data-action="open-order" data-id="' + esc(order.id) + '">' +
        '<span class="order-card-top"><span class="pill ' + esc(meta.cls) + '">' + esc(meta.label) + '</span><span class="order-date">' + esc(ago(order.createdAt)) + "</span></span>" +
        "<strong>" + esc(order.title) + "</strong>" +
        '<span class="order-card-meta">' + esc(order.agentName || "") + (order.serviceTitle ? " · " + esc(order.serviceTitle) : "") + "</span>" +
        '<span class="order-card-bottom"><span>买家 ' + esc(order.counterpartName || "—") + '</span><span><b>¥' + esc(money(order.price)) + "</b> · 到手 ¥" + esc(money(order.sellerAmount)) + "</span></span>" +
        "</button>";
    }).join("");
  }

  function renderDetail() {
    const pane = $("#detailPane");
    if (!pane) return;
    if (!state.activeOrderId) {
      pane.classList.remove("is-open");
      pane.innerHTML = '<div class="empty-detail"><span class="empty-mark">⌁</span><strong>选择一笔委托</strong><p>左侧点开订单，查看买家需求、启动 Agent 执行、提交交付或沉淀案例。</p></div>';
      return;
    }
    if (state.detailLoading) {
      pane.classList.add("is-open");
      pane.innerHTML = '<div class="detail"><div class="skeleton">正在读取委托详情…</div></div>';
      return;
    }
    if (state.detailError && !state.detail) {
      pane.classList.add("is-open");
      pane.innerHTML = '<div class="detail"><div class="detail-body"><div class="notice is-error">' + esc(state.detailError) +
        '</div><button class="btn btn-ghost" type="button" data-action="close-detail">返回</button></div></div>';
      return;
    }
    if (!state.detail) return;
    pane.classList.add("is-open");
    pane.innerHTML = detailHtml(state.detail);
    renderDecline();
    const stream = $("#taskStream");
    if (stream) stream.scrollTop = stream.scrollHeight;
  }

  function detailHtml(detail) {
    const order = detail.order;
    const meta = statusMeta(order.status);
    const agentDetail = findAgent(order.agentId);
    const agent = agentDetail ? agentDetail.agent : null;
    const runtime = agent && agent.runtimeLabel ? agent.runtimeLabel : "Codex · 本机桌面端";
    const latest = detail.latestDelivery;
    const isSellerActive = order.status === "in_progress" || order.status === "revision";

    const metaBoxes = [
      ["订单号", order.orderNo],
      ["服务包", order.serviceTitle || "定制委托"],
      [order.status === "completed" ? "完成时间" : "交付截止", order.status === "completed" ? date(order.completedAt) : date(order.deliverDeadline)],
    ].map(([label, value]) =>
      '<div class="meta-box"><span>' + esc(label) + "</span><strong>" + esc(value || "—") + "</strong></div>"
    ).join("");

    const attachments = Array.isArray(detail.attachments) && detail.attachments.length
      ? '<div class="attach-list">' + detail.attachments.map((item) => {
          const text = String(item || "");
          return /^https?:\/\//i.test(text)
            ? '<a href="' + esc(text) + '" target="_blank" rel="noreferrer">' + esc(text) + "</a>"
            : "<span>" + esc(text) + "</span>";
        }).join("") + "</div>"
      : "";

    const review = order.buyerRating
      ? '<div class="notice is-ok">买家评分 ' + esc(order.buyerRating) + " / 5" + (order.buyerReview ? " · " + esc(order.buyerReview) : "") + "</div>"
      : "";

    const notice = state.detailError
      ? '<div class="notice is-error">' + esc(state.detailError) + "</div>"
      : "";

    const taskBox = state.task && state.task.orderId === order.id ? taskBoxHtml(state.task) : "";
    const deliveryForm = isSellerActive ? deliveryFormHtml(latest) : "";
    const deliveries = deliveriesHtml(detail.deliveries);
    const caseForm = state.caseOpen && (order.status === "delivered" || order.status === "completed")
      ? caseFormHtml(order, latest)
      : "";
    const events = eventsHtml(detail.events);
    const actions = actionsHtml(detail);

    return '<article class="detail">' +
      '<header class="detail-head">' +
        '<div class="detail-head-row">' +
          "<div>" +
            '<span class="pill ' + esc(meta.cls) + '">' + esc(meta.label) + "</span>" +
            "<h2>" + esc(order.title) + "</h2>" +
            '<div class="detail-sub">' + esc(order.agentName || "") + (order.serviceTitle ? " · " + esc(order.serviceTitle) : "") +
              " · 买家 " + esc(order.counterpartName || "—") + " · " + esc(runtime) + "</div>" +
          "</div>" +
          '<div class="detail-money"><strong>¥' + esc(money(order.price)) + "</strong><small>到手 ¥" + esc(money(order.sellerAmount)) + "</small></div>" +
        "</div>" +
      "</header>" +
      '<div class="detail-body">' +
        '<div class="meta-grid">' + metaBoxes + "</div>" +
        '<section class="section"><div class="section-head"><h3>买家需求</h3><small>' + esc(ago(order.createdAt)) + "</small></div>" +
          '<div class="brief">' + esc(detail.brief || "买家没有填写额外说明。") + "</div>" + attachments +
        "</section>" +
        notice +
        review +
        taskBox +
        deliveries +
        deliveryForm +
        caseForm +
        events +
      "</div>" +
      actions +
      "</article>";
  }

  function actionsHtml(detail) {
    const order = detail.order;
    const buttons = [];
    if (order.status === "pending_accept") {
      buttons.push('<button class="btn btn-jade" type="button" data-action="accept-order"' + busyAttr("accept") + ">接单并开始</button>");
      buttons.push('<button class="btn btn-danger" type="button" data-action="toggle-decline">拒绝订单</button>');
    }
    if (order.status === "in_progress" || order.status === "revision") {
      buttons.push('<button class="btn btn-jade" type="button" data-action="run-agent"' + busyAttr("run") + ">启动我的 Agent</button>");
      if (state.task && state.task.taskId) {
        buttons.push('<button class="btn btn-ghost" type="button" data-action="open-task">打开任务窗口</button>');
      }
    }
    if (order.status === "delivered") {
      buttons.push('<span class="badge badge-jade">已交付，等待买家验收</span>');
    }
    if (order.status === "completed" || order.status === "delivered") {
      buttons.push('<button class="btn btn-ghost" type="button" data-action="toggle-case">' + (state.caseOpen ? "收起案例表单" : "发布为案例") + "</button>");
    }
    buttons.push('<span class="spacer"></span>');
    buttons.push('<button class="btn btn-ghost" type="button" data-action="open-order-web" data-id="' + esc(order.id) + '">打开网页订单</button>');
    buttons.push('<button class="btn btn-ghost" type="button" data-action="refresh">刷新</button>');
    return '<footer class="action-bar">' + buttons.join("") + "</footer>";
  }

  function taskBoxHtml(task) {
    const running = task.status === "running";
    const finished = task.status === "completed";
    const idle = task.status === "idle";
    const label = running
      ? "Agent 正在执行委托…"
      : finished
        ? "Agent 已完成，可以整理交付"
        : idle
          ? "已关联一次历史执行"
          : task.status === "failed"
            ? "执行中断"
            : "任务状态：" + task.status;
    const messages = Array.isArray(task.messages) ? task.messages : [];
    const stream = messages.length
      ? messages.map((message) => message.role === "system"
          ? '<div class="task-msg is-system">' + esc(message.text) + "</div>"
          : '<div class="task-msg">' + esc(message.text) + "</div>").join("")
      : '<div class="task-empty">' + (running ? "正在等待 Agent 的第一段输出…" : "还没有输出，点「继续监听」拉取任务消息。") + "</div>";
    const buttons = [];
    if (running) buttons.push('<button class="btn btn-ghost btn-sm" type="button" data-action="stop-task">停止执行</button>');
    if (idle) buttons.push('<button class="btn btn-jade btn-sm" type="button" data-action="resume-task">继续监听</button>');
    if (messages.length) buttons.push('<button class="btn btn-primary btn-sm" type="button" data-action="fill-delivery">用结果填充交付</button>');
    buttons.push('<button class="btn btn-ghost btn-sm" type="button" data-action="open-task">打开任务窗口</button>');
    return '<section class="task-box" id="taskBox">' +
      '<div class="task-head"><span class="dot' + (running ? " is-live" : "") + '"></span><span data-task-status>' + esc(label) + "</span>" +
        "<small>" + esc(task.taskId ? task.taskId.slice(0, 14) : "") + "</small></div>" +
      '<div class="task-stream" id="taskStream">' + stream + "</div>" +
      (task.error ? '<div class="notice is-error" style="margin:0 13px 10px">' + esc(task.error) + "</div>" : "") +
      '<div class="task-foot">' + buttons.join("") + "</div>" +
      "</section>";
  }

  function deliveriesHtml(deliveries) {
    if (!Array.isArray(deliveries) || !deliveries.length) return "";
    return '<section class="section"><div class="section-head"><h3>交付记录</h3><small>共 ' + deliveries.length + " 版</small></div>" +
      deliveries.map((delivery) => {
        const links = Array.isArray(delivery.links) && delivery.links.length
          ? '<div class="attach-list">' + delivery.links.map((link) => {
              const text = String(link || "");
              return /^https?:\/\//i.test(text)
                ? '<a href="' + esc(text) + '" target="_blank" rel="noreferrer">' + esc(text) + "</a>"
                : "<span>" + esc(text) + "</span>";
            }).join("") + "</div>"
          : "";
        const checklist = Array.isArray(delivery.checklist) && delivery.checklist.length
          ? '<ul class="checklist">' + delivery.checklist.map((item) => "<li>" + esc(item) + "</li>").join("") + "</ul>"
          : "";
        return '<div class="delivery"><div class="delivery-head"><span>第 ' + esc(delivery.version) + " 版交付</span><small>" + esc(date(delivery.createdAt)) + "</small></div>" +
          "<p>" + esc(delivery.summary) + "</p>" + links + checklist + "</div>";
      }).join("") + "</section>";
  }

  function deliveryFormHtml(latest) {
    return '<section class="section"><div class="section-head"><h3>提交交付</h3><small>买家验收通过后自动结算</small></div>' +
      '<form class="form-grid" data-form="delivery">' +
        '<label class="field"><span>交付说明</span><textarea class="tall" name="summary" placeholder="做了什么、怎么使用、有哪些已知限制…" required></textarea></label>' +
        '<label class="field"><span>交付物链接（每行一个）</span><textarea name="links" placeholder="https://… 或 deliverables/xxx.html"></textarea><small>网页、文件路径、网盘链接都可以，买家会在订单里直接看到。</small></label>' +
        '<label class="field"><span>验收检查项（每行一条）</span><textarea name="checklist" placeholder="页面在手机宽度下正常\n文案与品牌资料一致\n源码已打包"></textarea></label>' +
        '<div class="agent-actions">' +
          '<button class="btn btn-primary" type="submit"' + busyAttr("deliver") + ">提交交付</button>" +
          '<button class="btn btn-ghost" type="button" data-action="fill-delivery">用 Agent 结果填充</button>' +
          (latest ? '<span class="badge badge-jade">上一版：' + esc(date(latest.createdAt)) + "</span>" : "") +
        "</div>" +
      "</form></section>";
  }

  function caseFormHtml(order, latest) {
    const summary = latest && latest.summary ? latest.summary.slice(0, 600) : "";
    return '<section class="section"><div class="section-head"><h3>沉淀成作品案例</h3><small>案例会展示在 Agent 主页</small></div>' +
      '<form class="form-grid" data-form="case">' +
        '<div class="form-grid two">' +
          '<label class="field"><span>案例标题</span><input name="title" type="text" maxlength="120" value="' + esc(order.title) + '" required /></label>' +
          '<label class="field"><span>产品类型</span><select name="productType">' + PRODUCT_TYPES.map(([value, label]) =>
            '<option value="' + value + '"' + (value === "content" ? " selected" : "") + ">" + label + "</option>").join("") + "</select></label>" +
        "</div>" +
        '<label class="field"><span>案例摘要</span><textarea name="summary" placeholder="这个委托做了什么、效果如何">' + esc(summary) + "</textarea></label>" +
        '<div class="form-grid two">' +
          '<label class="field"><span>演示链接</span><input name="demoUrl" type="text" placeholder="https://…" /></label>' +
          '<label class="field"><span>标签（逗号分隔）</span><input name="tags" type="text" placeholder="品牌官网, 落地页, 响应式" /></label>' +
        "</div>" +
        '<label class="field"><span>案例亮点（每行一条）</span><textarea name="highlights" placeholder="3 天交付\n移动端首屏加载 1.2s"></textarea></label>' +
        '<div class="agent-actions"><button class="btn btn-primary" type="submit"' + busyAttr("case") + ">发布案例</button>" +
          '<button class="btn btn-ghost" type="button" data-action="toggle-case">取消</button></div>' +
      "</form></section>";
  }

  function eventsHtml(events) {
    const list = Array.isArray(events) ? events.slice(-30) : [];
    return '<section class="section"><div class="section-head"><h3>订单动态与沟通</h3><small>' + list.length + " 条</small></div>" +
      '<div class="timeline">' + (list.length
        ? list.map((event) => {
            const actor = event.actorRole === "seller" ? "is-seller" : event.actorRole === "buyer" ? "is-buyer" : "";
            const who = event.actorRole === "seller" ? "你" : event.actorRole === "buyer" ? "买家" : "系统";
            return '<div class="event ' + actor + '"><span class="event-dot"></span><div class="event-body"><strong>' + who + "</strong>" +
              esc(event.message) + "<span>" + esc(ago(event.createdAt)) + "</span></div></div>";
          }).join("")
        : '<div class="task-empty">还没有动态，接单后买卖双方的沟通都会记录在这里。</div>') +
      "</div>" +
      '<form class="chat-form" data-form="message"><input name="message" type="text" maxlength="2000" placeholder="回复买家，说明进度或需要补充的资料…" autocomplete="off" />' +
        '<button class="btn btn-ghost btn-sm" type="submit"' + busyAttr("message") + ">发送</button></form></section>";
  }

  function renderAgents() {
    const box = $("#agentsView");
    if (!box) return;
    const details = (state.me && state.me.agents) || [];
    if (!details.length) {
      box.innerHTML = '<div class="empty-list"><strong>还没有发布 Agent</strong><p>先在网页端创建 Agent、填写能力说明、服务包和案例，再回到桌面端接单。</p>' +
        '<p><button class="btn btn-primary btn-sm" type="button" data-action="open-web">去网页端创建 Agent</button></p></div>';
      return;
    }
    box.innerHTML = '<div class="agent-grid">' + details.map((entry) => {
      const agent = entry.agent;
      const live = agent.status === "live";
      const statusLabel = live ? "接单中" : agent.status === "paused" ? "已暂停" : agent.status === "offline" ? "已下线" : "草稿";
      const avatar = agent.avatarUrl
        ? '<span class="agent-avatar"><img src="' + esc(agent.avatarUrl) + '" alt="" /></span>'
        : '<span class="agent-avatar">' + esc(String(agent.name || "A").slice(0, 1)) + "</span>";
      return '<article class="agent-card">' +
        '<div class="agent-card-head">' + avatar + "<div><strong>" + esc(agent.name) + "</strong><small>" + esc(agent.tagline || "还没有一句话介绍") + "</small></div>" +
          '<span class="badge ' + (live ? "badge-jade" : "badge-amber") + '" style="margin-left:auto">' + esc(statusLabel) + "</span></div>" +
        "<p>" + esc(entry.description || "还没有能力说明，建议在网页端补充交付范围与不接的需求。") + "</p>" +
        '<div class="agent-metrics">' +
          '<span class="badge">服务 ' + esc((entry.services || []).length) + "</span>" +
          '<span class="badge">案例 ' + esc((entry.cases || []).length) + "</span>" +
          '<span class="badge">成交 ' + esc(agent.completedCount || 0) + "</span>" +
          '<span class="badge">评分 ' + esc(agent.ratingCount ? Number(agent.ratingAvg).toFixed(1) : "暂无") + "</span>" +
        "</div>" +
        (agent.samplePrompt ? '<div class="agent-prompt">' + esc(agent.samplePrompt) + "</div>" : "") +
        '<div class="agent-actions">' +
          '<button class="btn ' + (live ? "btn-ghost" : "btn-jade") + ' btn-sm" type="button" data-action="toggle-agent" data-id="' + esc(agent.id) + '" data-status="' + esc(agent.status) + '"' + busyAttr("agent-" + agent.id) + ">" + (live ? "暂停接单" : "开始接单") + "</button>" +
          '<button class="btn btn-ghost btn-sm" type="button" data-action="open-agent-web" data-key="' + esc(/^[a-z0-9-]+$/i.test(agent.slug || "") ? agent.slug : agent.id) + '">打开主页</button>' +
          (agent.samplePrompt ? '<button class="btn btn-ghost btn-sm" type="button" data-action="copy-prompt" data-id="' + esc(agent.id) + '">复制示例提示词</button>' : "") +
        "</div>" +
      "</article>";
    }).join("") + "</div>";
  }

  /**
   * 执行模型：与任务栏输入框的模型菜单同款（分组、供应商色点、计费口径都在组件里）。
   * 旧客户端没有注入 RuodaoModelPicker 时才退回原生 select。
   */
  function renderModelField(form) {
    const host = form.querySelector("#modelSelect");
    const hidden = form.querySelector("#modelIdValue");
    if (!host || !hidden) return;
    const value = state.settings.modelId || "";
    hidden.value = value;
    const models = state.models.map((option) => ({
      id: option.key,
      provider: option.provider,
      providerName: option.providerName || option.provider,
      model: option.model,
      modelConfigId: option.modelConfigId || "",
      group: option.group,
      billingMode: option.billingMode,
      perCallQuota: option.perCallQuota,
      modelRatio: option.modelRatio,
      isRecommended: option.isRecommended,
    }));
    if (window.RuodaoModelPicker && typeof window.RuodaoModelPicker.mount === "function") {
      window.RuodaoModelPicker.mount(host, {
        models,
        value,
        label: "执行模型",
        placeholder: "跟随桌面端默认模型",
        emptyText: "没有可用的文本模型",
        emptyHint: "还没有可用的文本模型。请先在若道「设置 → 模型管理」里配置一个。",
        width: 300,
        leadingOptions: [{ id: "", title: "跟随桌面端默认模型", desc: "用桌面端当前的默认模型" }],
        onChange: (id) => { state.settings.modelId = id || ""; hidden.value = state.settings.modelId; },
      });
      return;
    }
    host.innerHTML = "";
    const select = document.createElement("select");
    select.innerHTML = '<option value="">跟随桌面端默认模型</option>' + models.map((option) =>
      '<option value="' + esc(option.id) + '"' + (option.id === value ? " selected" : "") + ">"
        + esc((option.providerName || option.provider) + " · " + option.model) + "</option>").join("");
    select.addEventListener("change", () => {
      state.settings.modelId = select.value || "";
      hidden.value = state.settings.modelId;
    });
    host.appendChild(select);
  }

  function renderSettings() {
    const overlay = $("#settingsOverlay");
    if (!overlay || overlay.hidden) return;
    const form = overlay.querySelector('[data-form="settings"]');
    if (!form) return;
    form.elements.apiBaseUrl.value = state.settings.apiBaseUrl || "";
    form.elements.webBaseUrl.value = state.settings.webBaseUrl || DEFAULT_WEB;
    form.elements.deviceName.value = state.settings.deviceName || "";
    form.elements.workspace.value = state.settings.workspace || "";
    renderModelField(form);
    const device = $("#settingsDevice");
    if (device) {
      device.innerHTML = state.token
        ? "<span>已配对设备 <code>" + esc(state.token.slice(0, 12)) + "…</code>" +
          (state.me ? " · " + esc(state.me.userName || "") : "") + "</span>" +
          '<button class="btn btn-danger btn-sm" type="button" data-action="unpair">' + (state.unpairArmed ? "再次点击确认解除" : "解除配对") + "</button>"
        : "<span>当前未配对。</span>";
    }
  }

  /* ── pairing & settings actions ──────────────────────── */

  async function submitPair(form) {
    const data = new FormData(form);
    const code = String(data.get("code") || "").trim().toUpperCase();
    const deviceName = String(data.get("deviceName") || "").trim() || "我的桌面端";
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      toast("请输入网页端生成的 6 位配对码", "error");
      return;
    }
    state.busy.pair = true;
    const button = form.querySelector('button[type="submit"]');
    if (button) { button.disabled = true; button.textContent = "正在配对…"; }
    try {
      const result = await api("/api/agent-market/pair", { method: "POST", body: { code, deviceName } });
      await persistToken(result.token);
      state.settings.deviceName = deviceName;
      await persistSettings();
      state.me = null;
      toast("配对成功，开始同步接单数据", "ok");
      render();
      await refreshAll();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      state.busy.pair = false;
      if (button) { button.disabled = false; button.textContent = "连接这台电脑"; }
    }
  }

  function openSettings() {
    const overlay = $("#settingsOverlay");
    if (!overlay) return;
    state.unpairArmed = false;
    overlay.hidden = false;
    loadModels().then(renderSettings);
    renderSettings();
  }

  function closeSettings() {
    const overlay = $("#settingsOverlay");
    if (overlay) overlay.hidden = true;
    state.unpairArmed = false;
  }

  async function saveSettings(form) {
    const data = new FormData(form);
    state.settings.apiBaseUrl = String(data.get("apiBaseUrl") || "").trim();
    state.settings.webBaseUrl = String(data.get("webBaseUrl") || "").trim() || DEFAULT_WEB;
    state.settings.deviceName = String(data.get("deviceName") || "").trim();
    state.settings.modelId = String(data.get("modelId") || "");
    state.settings.workspace = String(data.get("workspace") || "").trim();
    await persistSettings();
    closeSettings();
    toast("设置已保存", "ok");
    if (state.token) await refreshAll({ silent: true });
    else render();
  }

  async function unpair() {
    if (!state.unpairArmed) {
      state.unpairArmed = true;
      renderSettings();
      return;
    }
    state.unpairArmed = false;
    await clearPairing();
    closeSettings();
    toast("已解除配对，桌面端不再拥有卖家权限", "ok");
  }

  /* ── order actions ───────────────────────────────────── */

  async function openOrder(orderId) {
    const switched = state.activeOrderId !== orderId;
    state.activeOrderId = orderId;
    state.detailError = "";
    if (switched) {
      state.declineOpen = false;
      state.caseOpen = false;
      const storedTask = state.orderTasks[orderId];
      state.task = storedTask
        ? { orderId, taskId: storedTask, status: "idle", messages: [], version: 0, error: "", startedAt: 0 }
        : null;
      state.detail = null;
      state.detailLoading = true;
    }
    renderOrders();
    renderDetail();
    await reloadDetail();
    state.detailLoading = false;
    renderDetail();
  }

  async function acceptOrder() {
    if (!state.detail || state.busy.accept) return;
    state.busy.accept = true;
    state.detailError = "";
    renderDetail();
    try {
      state.detail = await api("/api/agent-market/seller/orders/" + encodeURIComponent(state.detail.order.id) + "/accept", { method: "POST" });
      toast("已接单，可以启动 Agent 执行委托", "ok");
      await refreshStatsOnly();
    } catch (error) {
      state.detailError = error.message;
    } finally {
      state.busy.accept = false;
      renderDetail();
    }
  }

  async function submitDecline(form) {
    if (!state.detail) return;
    const reason = String(new FormData(form).get("reason") || "").trim();
    state.busy.decline = true;
    state.detailError = "";
    try {
      state.detail = await api("/api/agent-market/seller/orders/" + encodeURIComponent(state.detail.order.id) + "/decline", {
        method: "POST",
        body: { reason },
      });
      state.declineOpen = false;
      toast("已拒绝订单，买家将获得全额退款", "ok");
      await refreshAll({ silent: true });
    } catch (error) {
      state.detailError = error.message;
      toast(error.message, "error");
    } finally {
      state.busy.decline = false;
      renderDetail();
    }
  }

  async function refreshStatsOnly() {
    try {
      state.me = await api("/api/agent-market/seller/me");
      const page = await api("/api/agent-market/seller/orders?status=all&page=1&size=48");
      state.orders = Array.isArray(page && page.items) ? page.items : [];
    } catch {
      /* 下一次刷新会再同步 */
    }
  }

  function presenceAgentIds() {
    const agents = state.me && Array.isArray(state.me.agents) ? state.me.agents : [];
    return agents.map((entry) => (entry && entry.agent ? entry.agent.id : "")).filter(Boolean);
  }

  async function heartbeatPresence() {
    if (!state.token) return;
    const agentIds = presenceAgentIds();
    if (!agentIds.length) return;
    try {
      await api("/api/agent-market/presence/heartbeat", {
        method: "POST",
        body: {
          agentIds,
          busy: Boolean(state.me && Number(state.me.inProgressOrders) > 0),
          runtime: state.settings.modelId || "",
          deviceName: state.settings.deviceName || "",
        },
      });
    } catch {
      /* 心跳失败不打断接单台，下一次会重试 */
    }
  }

  async function submitDelivery(form) {
    if (!state.detail || state.busy.deliver) return;
    const data = new FormData(form);
    const summary = String(data.get("summary") || "").trim();
    const links = lines(data.get("links"));
    const checklist = lines(data.get("checklist"));
    if (!summary) {
      toast("请先填写交付说明", "error");
      return;
    }
    state.busy.deliver = true;
    state.detailError = "";
    renderDetail();
    let failed = false;
    try {
      state.detail = await api("/api/agent-market/seller/orders/" + encodeURIComponent(state.detail.order.id) + "/deliver", {
        method: "POST",
        body: { summary, links, checklist },
      });
      toast("交付已提交，等待买家验收", "ok");
      await refreshStatsOnly();
    } catch (error) {
      failed = true;
      state.detailError = error.message;
      toast(error.message, "error");
    } finally {
      state.busy.deliver = false;
      renderDetail();
      if (failed) {
        const formAfter = document.querySelector('[data-form="delivery"]');
        if (formAfter) {
          formAfter.querySelector('[name="summary"]').value = summary;
          formAfter.querySelector('[name="links"]').value = links.join("\n");
          formAfter.querySelector('[name="checklist"]').value = checklist.join("\n");
        }
      }
    }
  }

  async function submitCase(form) {
    if (!state.detail || state.busy.case) return;
    const data = new FormData(form);
    const payload = {
      title: String(data.get("title") || "").trim(),
      summary: String(data.get("summary") || "").trim(),
      demoUrl: String(data.get("demoUrl") || "").trim(),
      productType: String(data.get("productType") || "other"),
      tags: String(data.get("tags") || "").split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      highlights: lines(data.get("highlights")),
    };
    if (!payload.title) {
      toast("请填写案例标题", "error");
      return;
    }
    state.busy.case = true;
    try {
      const agentDetail = await api("/api/agent-market/seller/orders/" + encodeURIComponent(state.detail.order.id) + "/case", {
        method: "POST",
        body: payload,
      });
      if (state.me && Array.isArray(state.me.agents)) {
        const index = state.me.agents.findIndex((entry) => entry.agent.id === agentDetail.agent.id);
        if (index >= 0) state.me.agents[index] = agentDetail;
      }
      state.caseOpen = false;
      toast("案例已发布到 Agent 主页", "ok");
      renderAgents();
      renderDetail();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      state.busy.case = false;
      renderDetail();
    }
  }

  async function sendMessage(form) {
    if (!state.detail || state.busy.message) return;
    const input = form.querySelector('[name="message"]');
    const message = String(input.value || "").trim();
    if (!message) return;
    state.busy.message = true;
    try {
      state.detail = await api("/api/agent-market/seller/orders/" + encodeURIComponent(state.detail.order.id) + "/messages", {
        method: "POST",
        body: { message },
      });
      renderDetail();
      const next = document.querySelector('[data-form="message"] [name="message"]');
      if (next) next.focus();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      state.busy.message = false;
    }
  }

  async function toggleAgent(agentId, currentStatus) {
    const next = currentStatus === "live" ? "paused" : "live";
    state.busy["agent-" + agentId] = true;
    renderAgents();
    try {
      const detail = await api("/api/agent-market/seller/agents/" + encodeURIComponent(agentId) + "/status", {
        method: "PATCH",
        body: { status: next },
      });
      if (state.me && Array.isArray(state.me.agents)) {
        const index = state.me.agents.findIndex((entry) => entry.agent.id === agentId);
        if (index >= 0) state.me.agents[index] = detail;
      }
      toast(next === "live" ? "已开始接单" : "已暂停接单", "ok");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      state.busy["agent-" + agentId] = false;
      renderAgents();
    }
  }

  async function copyPrompt(agentId) {
    const detail = findAgent(agentId);
    const prompt = detail && detail.agent && detail.agent.samplePrompt;
    if (!prompt) return;
    if (!HOST || !HOST.clipboard) {
      toast("当前桌面端不支持剪贴板", "error");
      return;
    }
    try {
      await HOST.clipboard.writeText(prompt);
      toast("示例提示词已复制", "ok");
    } catch (error) {
      toast(error.message || "复制失败", "error");
    }
  }

  /* ── agent execution ─────────────────────────────────── */

  function buildPrompt(detail) {
    const agentDetail = findAgent(detail.order.agentId);
    const agent = agentDetail ? agentDetail.agent : null;
    const capabilities = agent && Array.isArray(agent.capabilities) ? agent.capabilities.join("、") : "";
    const linesOut = [
      "你正在若道 Agent 市场替卖家执行一笔真实委托。请直接开始，不要提问，不要等待确认。",
      "",
      "[你的对外身份]",
      agent ? "Agent 名称：" + agent.name : "",
      agent && agent.tagline ? "一句话介绍：" + agent.tagline : "",
      agentDetail && agentDetail.description ? "能力说明：" + agentDetail.description : "",
      capabilities ? "能力标签：" + capabilities : "",
      agent && agent.samplePrompt ? "卖家常用提示词：" + agent.samplePrompt : "",
      "",
      "[委托信息]",
      "订单：" + detail.order.orderNo,
      "标题：" + detail.order.title,
      "服务包：" + (detail.order.serviceTitle || "定制委托"),
      "预算：¥" + money(detail.order.price),
      detail.order.deliverDeadline ? "交付截止：" + date(detail.order.deliverDeadline) : "",
      "",
      "[买家需求]",
      detail.brief || "（买家没有填写额外说明）",
      Array.isArray(detail.attachments) && detail.attachments.length
        ? "\n附件与参考链接：\n" + detail.attachments.join("\n")
        : "",
      "",
      "[交付要求]",
      "1. 直接完成交付物本体；需要写文件时统一放在当前工作区的 deliverables/ 目录。",
      "2. 不要向买家提问；拿不准的地方按最合理解释完成，并在说明里标注假设。",
      "3. 最后用中文输出三部分：交付说明、交付物清单（文件路径或链接）、验收检查项（3-6 条）。",
      "4. 这份输出会被卖家直接整理成订单交付，请写清楚、可验收。",
    ];
    return linesOut.filter(Boolean).join("\n");
  }

  async function runAgent() {
    if (!state.detail || state.busy.run) return;
    const detail = state.detail;
    const supported = HOST && HOST.tasks && typeof HOST.tasks.create === "function";
    if (!supported) {
      toast("当前桌面端不支持 Codex 任务，请升级若道 Agent", "error");
      return;
    }
    state.busy.run = true;
    state.detailError = "";
    renderDetail();
    try {
      const model = resolveModel();
      const payload = {
        title: ("接单 · " + detail.order.title).slice(0, 60),
        agentMode: true,
      };
      if (model) Object.assign(payload, model);
      if (state.settings.workspace) payload.workspace = state.settings.workspace;
      const created = await HOST.tasks.create(payload);
      const taskId = String((created && (created.id || (created.task && created.task.id))) || "");
      if (!taskId) throw new Error("宿主没有返回 Codex 任务 ID");
      state.orderTasks[detail.order.id] = taskId;
      await persistOrderTasks();
      state.task = {
        orderId: detail.order.id,
        taskId,
        status: "running",
        messages: [],
        version: 0,
        error: "",
        startedAt: Date.now(),
      };
      renderDetail();
      await HOST.tasks.send(Object.assign({
        taskId,
        text: buildPrompt(detail),
      }, model || {}));
      pollTask(taskId);
    } catch (error) {
      state.detailError = error.message;
      toast(error.message, "error");
    } finally {
      state.busy.run = false;
      renderDetail();
    }
  }

  async function resumeTask() {
    if (!state.task || !state.task.taskId) return;
    state.task.status = "running";
    state.task.error = "";
    state.task.version = 0;
    state.task.messages = [];
    state.task.startedAt = 0;
    renderDetail();
    pollTask(state.task.taskId);
  }

  async function stopTask() {
    if (!state.task || !state.task.taskId || !HOST.tasks) return;
    try {
      await HOST.tasks.interrupt({ taskId: state.task.taskId });
      state.task.status = "failed";
      state.task.error = "已手动停止执行";
      toast("已停止 Agent 执行", "ok");
    } catch (error) {
      toast(error.message || "停止失败", "error");
    }
    renderDetail();
  }

  async function openTaskWindow() {
    const taskId = state.task && state.task.taskId;
    if (!taskId) return;
    if (!HOST.tasks || typeof HOST.tasks.open !== "function") {
      toast("当前桌面端不支持打开任务窗口", "error");
      return;
    }
    try {
      await HOST.tasks.open({ taskId });
    } catch (error) {
      toast(error.message || "打开任务失败", "error");
    }
  }

  function syncTaskMessages(taskSnapshot, task) {
    const known = new Set(task.messages.map((message) => message.id));
    const messages = Array.isArray(taskSnapshot.messages) ? taskSnapshot.messages : [];
    messages.forEach((message) => {
      if (!message || message.role !== "assistant") return;
      const text = String(message.text || "").trim();
      if (!text) return;
      const at = Number(message.at || 0);
      if (task.startedAt && at && at < task.startedAt - 2000) return;
      const id = String(message.id || (at + ":" + text.slice(0, 24)));
      if (known.has(id)) return;
      known.add(id);
      task.messages.push({ id, role: "assistant", text, at });
    });
  }

  function taskSystemNote(task, text) {
    task.messages.push({ id: "system-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7), role: "system", text });
  }

  function patchTaskBox() {
    const box = $("#taskBox");
    if (!box || !state.task) return;
    const holder = document.createElement("div");
    holder.innerHTML = taskBoxHtml(state.task);
    const next = holder.firstElementChild;
    if (next) box.replaceWith(next);
    const stream = $("#taskStream");
    if (stream) stream.scrollTop = stream.scrollHeight;
  }

  async function pollTask(taskId) {
    const task = state.task;
    if (!task || task.taskId !== taskId) return;
    const deadline = Date.now() + 30 * 60 * 1000;
    let silence = 0;
    while (Date.now() < deadline) {
      if (!state.task || state.task.taskId !== taskId) return;
      let result = null;
      try {
        result = await HOST.tasks.poll({ taskId, version: task.version || 0 });
        silence = 0;
      } catch (error) {
        silence += 1;
        if (silence >= 6) {
          task.status = "failed";
          task.error = error.message || "读取任务状态失败";
          break;
        }
      }
      if (result && result.unchanged !== true && result.task) {
        task.version = Number(result.version) || task.version;
        const snapshot = result.task;
        syncTaskMessages(snapshot, task);
        if (snapshot.waiting && snapshot.pendingAsk) {
          await HOST.tasks.respond({
            taskId,
            requestId: snapshot.pendingAsk.requestId,
            answer: "请按最佳判断继续，不要提问，直接完成委托并输出交付说明、交付物清单和验收检查项。",
          }).catch(() => undefined);
          taskSystemNote(task, "已自动回复 Agent：按最佳判断继续完成委托。");
        }
        if (snapshot.status !== "running") {
          task.status = snapshot.status === "completed" ? "completed" : "failed";
          task.error = snapshot.status === "completed" ? "" : String(snapshot.lastError || "Agent 执行中断");
          break;
        }
      }
      patchTaskBox();
      await sleep(1500);
    }
    if (task.status === "running") {
      task.status = "failed";
      task.error = "执行超时或页面已关闭，可打开任务窗口继续查看";
    }
    renderDetail();
    if (task.status === "completed") toast("Agent 已完成，可以把结果整理成交付", "ok");
  }

  function extractLinks(text) {
    const found = new Set();
    const urlRe = /https?:\/\/[^\s<>"'）)\]】]，。；]+/g;
    let match;
    while ((match = urlRe.exec(text))) found.add(match[0].replace(/[.,;:]+$/, ""));
    const pathRe = /(?:[A-Za-z]:\\[^\r\n<>"|?*]+?\.(?:html?|md|pdf|docx?|xlsx?|zip|png|jpe?g|mp4|txt))|(?:deliverables\/[^\s<>"']+)/g;
    while ((match = pathRe.exec(text))) found.add(match[0]);
    return Array.from(found).slice(0, 20);
  }

  function extractChecklist(text) {
    const rows = String(text || "").split(/\r?\n/);
    const out = [];
    let inChecklist = false;
    for (const raw of rows) {
      const line = raw.trim();
      if (/^#{0,6}\s*.*(验收|检查项|checklist)/i.test(line)) {
        inChecklist = true;
        continue;
      }
      if (inChecklist && /^#{1,6}\s/.test(line) && !/(验收|检查项|checklist)/i.test(line)) break;
      const match = line.match(/^(?:[-*•]|\d+[.、)])\s+(.{2,160})$/);
      if (match && (inChecklist || out.length < 6)) out.push(match[1].trim());
      if (out.length >= 30) break;
    }
    return out;
  }

  function fillDeliveryFromTask() {
    if (!state.task || !state.task.messages.length) {
      toast("还没有可用的 Agent 输出", "error");
      return;
    }
    const text = state.task.messages.filter((message) => message.role === "assistant").pop();
    if (!text) {
      toast("还没有可用的 Agent 输出", "error");
      return;
    }
    const form = document.querySelector('[data-form="delivery"]');
    if (!form) {
      toast("当前订单不在可交付状态", "error");
      return;
    }
    form.querySelector('[name="summary"]').value = text.text.slice(0, 19000);
    form.querySelector('[name="links"]').value = extractLinks(text.text).join("\n");
    form.querySelector('[name="checklist"]').value = extractChecklist(text.text).join("\n");
    form.scrollIntoView({ behavior: "smooth", block: "center" });
    toast("已用 Agent 结果填充交付，可继续修改", "ok");
  }

  /* ── group chat runs ─────────────────────────────────── */

  function chatRunPreview(run) {
    const text = String((run && run.inputText) || "").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 120) : "等待群聊上下文";
  }

  function chatRunCard(run) {
    return '<button class="chat-run-card' + (run.id === state.chatActiveRunId ? " is-active" : "") +
      '" type="button" data-action="open-chat-run" data-id="' + esc(run.id) + '">' +
      '<span class="chat-run-top"><span class="pill pill-pending">第 ' + esc(run.round || 1) + ' 轮</span><span class="order-date">' + esc(ago(run.createdAt)) + "</span></span>" +
      "<strong>" + esc(run.agentName || "Agent") + "</strong>" +
      '<span class="chat-run-preview">' + esc(chatRunPreview(run)) + "</span>" +
      "</button>";
  }

  function chatRunDetailHtml() {
    if (!state.chatActiveRunId) {
      return '<div class="empty-detail"><span class="empty-mark">⌁</span><strong>选择一条待回复运行</strong><p>右侧会显示群聊快照、触发上下文与领取按钮。领取后由本机 Agent 生成回复。</p></div>';
    }
    const context = state.chatContext;
    if (state.chatContextLoading || !context) {
      return '<div class="chat-detail"><div class="skeleton">正在读取群聊上下文…</div></div>';
    }
    const run = context.run || {};
    const messages = Array.isArray(context.messages) ? context.messages : [];
    const title = context.conversationTitle || "群聊";
    const modeLabel = { mention_only: "仅被 @ 时回复", round_robin: "轮流发言", moderated: "群主主持" }[context.conversationMode] || context.conversationMode || "";
    const list = messages.length
      ? messages.map((message) => {
          const agentSide = message.senderType === "agent";
          const who = message.senderName || (agentSide ? "Agent" : "成员");
          const body = message.body || (message.kind === "image" ? "[图片]" : message.kind === "file" ? "[文件]" : "");
          return '<div class="chat-context-msg' + (agentSide ? " is-agent" : "") + (message.mine ? " is-mine" : "") + '">' +
            '<span class="chat-context-who">' + esc(who) + "</span>" +
            '<div class="chat-context-body">' + esc(body) + "</div>" +
          "</div>";
        }).join("")
      : '<div class="task-empty">还没有可读取的历史消息。</div>';
    return '<article class="chat-detail">' +
      '<header class="chat-detail-head"><div>' +
        '<span class="kicker">GROUP CONTEXT</span>' +
        "<h2>" + esc(title) + "</h2>" +
        '<div class="detail-sub">' + esc(run.agentName || "Agent") + " · 第 " + esc(run.round || 1) + " 轮" + (modeLabel ? " · " + esc(modeLabel) : "") + "</div>" +
      "</div><span class=\"pill pill-pending\">待回复</span></header>" +
      '<div class="chat-context-list">' + list + "</div>" +
      '<footer class="chat-detail-foot">' +
        '<button class="btn btn-jade" type="button" data-action="run-chat-run" data-id="' + esc(run.id || state.chatActiveRunId) + '"' + busyAttr("chat-claim") + ">领取并回复</button>" +
        '<button class="btn btn-ghost" type="button" data-action="open-chat-web">在网页查看</button>' +
      "</footer>" +
    "</article>";
  }

  function renderChat() {
    const box = $("#chatView");
    if (!box) return;
    if (!state.token) {
      box.innerHTML = "";
      return;
    }
    if (state.chatRunning) {
      box.innerHTML = chatRunningHtml();
      renderChatStream();
      return;
    }
    const runs = state.chatRuns;
    box.innerHTML =
      '<div class="chat-layout">' +
        '<section class="chat-list-pane">' +
          '<div class="chat-head"><div><span class="kicker">GROUP INBOX</span><h2>群聊待回复</h2></div>' +
            '<button class="btn btn-ghost btn-sm" type="button" data-action="refresh-chat">刷新</button></div>' +
          '<p class="chat-hint">群成员 @ 你的 Agent 后，运行会排队到这里。领取后由本机 Agent 生成回复，文字会实时同步到网页、手机与 Windows。</p>' +
          (state.chatLoading && !runs.length ? '<div class="skeleton">正在同步群聊运行…</div>' : "") +
          (state.chatError ? '<div class="notice is-error">' + esc(state.chatError) + "</div>" : "") +
          '<div class="chat-run-list">' + (runs.length
            ? runs.map(chatRunCard).join("")
            : '<div class="empty-list"><strong>暂时没有待回复的群聊</strong><p>保持接单台在线，群成员 @ 你的 Agent 后会自动出现在这里。</p></div>') +
          "</div>" +
        "</section>" +
        '<aside class="chat-detail-pane">' + chatRunDetailHtml() + "</aside>" +
      "</div>";
  }

  function chatRunningHtml() {
    const running = state.chatRunning;
    return '<div class="chat-layout is-running">' +
      '<section class="chat-list-pane">' +
        '<div class="chat-head"><div><span class="kicker">RUNNING</span><h2>正在回复群聊</h2></div><span class="badge badge-jade">执行中</span></div>' +
        '<p class="chat-hint">' + esc(running.agentName || "Agent") + " 正在本机执行，输出会实时推送到群聊，完成后自动提交，无需手动复制。</p>" +
        '<div class="chat-run-meta">' +
          "<span>运行 <code>" + esc(String(running.runId || "").slice(0, 8)) + "</code></span>" +
          '<span data-chat-meta>已生成 ' + esc(String(running.text || "").length) + " 字</span>" +
        "</div>" +
        (running.error ? '<div class="notice is-error">' + esc(running.error) + "</div>" : "") +
        '<div class="chat-run-actions">' +
          (running.status === "running" ? '<button class="btn btn-danger btn-sm" type="button" data-action="stop-chat-run">停止执行</button>' : "") +
          '<button class="btn btn-ghost btn-sm" type="button" data-action="open-chat-task">打开任务窗口</button>' +
        "</div>" +
      "</section>" +
      '<aside class="chat-detail-pane"><article class="chat-detail">' +
        '<header class="chat-detail-head"><div><span class="kicker">LIVE OUTPUT</span><h2>' + esc(running.conversationTitle || "群聊回复") + "</h2>" +
          '<div class="detail-sub">' + esc(running.agentName || "Agent") + "</div></div></header>" +
        '<div class="chat-live-stream" id="chatStream"></div>' +
      "</article></aside>" +
    "</div>";
  }

  function renderChatStream() {
    const stream = $("#chatStream");
    if (!stream || !state.chatRunning) return;
    const text = state.chatRunning.text || "";
    stream.textContent = text || "正在等待 Agent 的第一段输出…";
    stream.classList.toggle("is-empty", !text);
    stream.scrollTop = stream.scrollHeight;
    const meta = document.querySelector("[data-chat-meta]");
    if (meta) meta.textContent = "已生成 " + text.length + " 字";
  }

  async function openChatRun(runId) {
    if (!runId || state.chatRunning) return;
    state.chatActiveRunId = runId;
    state.chatContext = null;
    state.chatContextLoading = true;
    renderChat();
    try {
      state.chatContext = await api("/api/agent-market/chat/runs/" + encodeURIComponent(runId) + "/context");
    } catch (error) {
      state.chatContext = null;
      toast(error.message, "error");
    } finally {
      state.chatContextLoading = false;
      renderChat();
    }
  }

  function isPublicPersonaPrompt(prompt) {
    return typeof prompt === "string" && prompt.startsWith("RUODAO_PUBLIC_PERSONA_V1\n");
  }

  function parsePublicTextResult(result) {
    // Do not display raw stdout/stderr or host/provider exceptions (may contain credentials).
    if (!result || result.exitCode !== 0 || result.signal) throw new Error("公共人设文本命令未成功完成");
    let parsed;
    try {
      if (typeof result.stdout !== "string" || result.stdout.length > 100000) throw new Error();
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("公共人设文本命令返回了无效结果");
    }
    if (parsed?.state !== "succeeded" || typeof parsed.text !== "string" || !parsed.text.trim() || parsed.text.length > 12000) {
      throw new Error("公共人设文本模型没有返回可用的最终文本");
    }
    return parsed.text.trim();
  }

  async function runPublicChatText(running, prompt) {
    const current = () => state.chatRunning === running && running.status === "running";
    // Separate lease heartbeat: command.run has no streaming/task poll events.
    let heartbeatPending = false;
    running.heartbeatTimer = setInterval(() => {
      if (!current()) {
        clearInterval(running.heartbeatTimer);
        return;
      }
      if (heartbeatPending) return;
      heartbeatPending = true;
      api("/api/agent-market/chat/runs/" + encodeURIComponent(running.runId) + "/heartbeat", { method: "POST" })
        .catch(() => undefined).finally(() => { heartbeatPending = false; });
    }, 30000);
    try {
      if (!HOST || typeof HOST.command?.run !== "function") throw new Error();
      const model = resolveModel();
      if (!model) throw new Error("请先选择文本模型");
      const result = await HOST.command.run("com.ruodao.agent-market.public-text", { prompt }, 300000, { llm: model });
      if (!current()) return; // Stopped, unpaired, or superseded: discard late output.
      running.text = parsePublicTextResult(result);
      running.status = "completed";
    } catch {
      if (!current()) return;
      running.status = "failed";
      running.error = "公共人设文本生成失败，请检查宿主命令与文本模型配置后重试";
    } finally {
      clearInterval(running.heartbeatTimer);
    }
    if (state.chatRunning === running) await finishChatRun(running);
  }

  async function startChatRun(runId) {
    if (!runId) return;
    if (state.chatRunning) {
      toast("已有群聊回复在执行，请先完成或停止", "error");
      return;
    }
    if (state.busy["chat-claim"]) return;
    const queued = state.chatRuns.find((item) => item.id === runId);
    state.busy["chat-claim"] = true;
    renderChat();
    let claimed = null;
    try {
      claimed = await api("/api/agent-market/chat/runs/" + encodeURIComponent(runId) + "/claim", { method: "POST" });
    } catch (error) {
      state.busy["chat-claim"] = false;
      toast(error.message, "error");
      await refreshChatRuns();
      return;
    }
    const prompt = String((claimed && claimed.inputText) || (queued && queued.inputText) || "");
    let running = null;
    try {
      // Route before touching HOST.tasks, including its capability check. A queued
      // public marker also fails closed if a stale/malformed claim drops it.
      if (isPublicPersonaPrompt(prompt) || isPublicPersonaPrompt(queued && queued.inputText)) {
        running = {
          runId,
          execution: "public-text",
          agentName: (claimed && claimed.agentName) || "Agent",
          conversationTitle: state.chatContext && state.chatContext.conversationTitle,
          text: "",
          status: "running",
          error: "",
          startedAt: Date.now(),
        };
        state.chatRunning = running;
        state.chatActiveRunId = "";
        state.chatContext = null;
        renderChat();
        void runPublicChatText(running, prompt);
        return;
      }
      if (!HOST || !HOST.tasks || typeof HOST.tasks.create !== "function") {
        throw new Error("当前桌面端不支持 Codex 任务，请升级若道 Agent");
      }
      const model = resolveModel();
      const payload = { title: ("群聊 · " + ((claimed && claimed.agentName) || "Agent")).slice(0, 60), agentMode: true };
      if (model) Object.assign(payload, model);
      if (state.settings.workspace) payload.workspace = state.settings.workspace;
      const created = await HOST.tasks.create(payload);
      const taskId = String((created && (created.id || (created.task && created.task.id))) || "");
      if (!taskId) throw new Error("宿主没有返回 Codex 任务 ID");
      running = {
        runId,
        taskId,
        agentName: (claimed && claimed.agentName) || "Agent",
        conversationTitle: state.chatContext && state.chatContext.conversationTitle,
        text: "",
        sentLength: 0,
        status: "running",
        error: "",
        version: 0,
        startedAt: Date.now(),
      };
      state.chatRunning = running;
      state.chatActiveRunId = "";
      state.chatContext = null;
      renderChat();
      await HOST.tasks.send(Object.assign({ taskId, text: prompt || "请根据群聊上下文直接回复群成员。" }, model || {}));
      pollChatRun(running);
    } catch (error) {
      if (running) {
        running.status = "failed";
        running.error = error.message;
        await finishChatRun(running);
      } else {
        await api("/api/agent-market/chat/runs/" + encodeURIComponent(runId) + "/fail", { method: "POST", body: { error: error.message } }).catch(() => undefined);
        toast(error.message, "error");
        await refreshChatRuns();
      }
    } finally {
      state.busy["chat-claim"] = false;
      renderChat();
    }
  }

  async function pollChatRun(running) {
    const deadline = Date.now() + 30 * 60 * 1000;
    let silence = 0;
    let lastHeartbeat = Date.now();
    while (Date.now() < deadline && state.chatRunning === running && running.status === "running") {
      let result = null;
      try {
        result = await HOST.tasks.poll({ taskId: running.taskId, version: running.version || 0 });
        silence = 0;
      } catch (error) {
        silence += 1;
        if (silence >= 6) {
          running.status = "failed";
          running.error = error.message || "读取任务状态失败";
          break;
        }
      }
      if (result && result.unchanged !== true && result.task) {
        running.version = Number(result.version) || running.version;
        const snapshot = result.task;
        const assistant = (Array.isArray(snapshot.messages) ? snapshot.messages : [])
          .filter((message) => message && message.role === "assistant" && String(message.text || "").trim())
          .map((message) => String(message.text).trim());
        const joined = assistant.join("\n\n");
        if (joined.length > running.text.length) {
          running.text = joined;
          await flushChatDelta(running);
        }
        if (snapshot.waiting && snapshot.pendingAsk) {
          await HOST.tasks.respond({
            taskId: running.taskId,
            requestId: snapshot.pendingAsk.requestId,
            answer: "请根据群聊上下文按最佳判断直接回复，不要反问群成员，也不要等待确认。",
          }).catch(() => undefined);
        }
        if (snapshot.status !== "running") {
          running.status = snapshot.status === "completed" ? "completed" : "failed";
          running.error = snapshot.status === "completed" ? "" : String(snapshot.lastError || "Agent 执行中断");
          break;
        }
      }
      if (Date.now() - lastHeartbeat > 45_000) {
        lastHeartbeat = Date.now();
        api("/api/agent-market/chat/runs/" + encodeURIComponent(running.runId) + "/heartbeat", { method: "POST" }).catch(() => undefined);
      }
      renderChatStream();
      await sleep(1500);
    }
    if (running.status === "running") {
      running.status = "failed";
      running.error = "执行超时，已停止";
    }
    await finishChatRun(running);
  }

  async function flushChatDelta(running) {
    while (running.sentLength < running.text.length) {
      const chunk = running.text.slice(running.sentLength, running.sentLength + 2000);
      running.sentLength += chunk.length;
      try {
        await api("/api/agent-market/chat/runs/" + encodeURIComponent(running.runId) + "/delta", { method: "POST", body: { text: chunk } });
      } catch {
        /* 流式增量失败不影响最终完整提交 */
      }
    }
    renderChatStream();
  }

  async function finishChatRun(running) {
    if (state.chatRunning !== running) return;
    const runId = running.runId;
    try {
      if (running.status === "completed") {
        const output = String(running.text || "").trim().slice(0, 12000);
        if (!output) throw new Error("Agent 没有返回可发送的内容");
        await api("/api/agent-market/chat/runs/" + encodeURIComponent(runId) + "/complete", { method: "POST", body: { output } });
        toast("已回复群聊：" + (running.agentName || "Agent"), "ok");
      } else {
        await api("/api/agent-market/chat/runs/" + encodeURIComponent(runId) + "/fail", {
          method: "POST",
          body: { error: running.error || "桌面端执行中断" },
        }).catch(() => undefined);
        toast(running.error || "Agent 执行中断", "error");
      }
    } catch (error) {
      toast(error.message, "error");
    } finally {
      state.chatRunning = null;
      if (state.activeTab === "chat") {
        state.chatActiveRunId = "";
        state.chatContext = null;
        renderChat();
      }
      await refreshChatRuns();
    }
  }

  async function stopChatRun() {
    const running = state.chatRunning;
    if (!running) return;
    if (running.execution === "public-text") {
      running.status = "failed";
      running.error = "已停止等待，本次模型请求可能仍在执行，后续结果不会发送到群聊";
      clearInterval(running.heartbeatTimer);
      renderChat();
      await finishChatRun(running);
      return;
    }
    try {
      await HOST.tasks.interrupt({ taskId: running.taskId });
    } catch {
      /* 即使中断失败也要按失败提交，避免运行一直占用租约 */
    }
    running.status = "failed";
    running.error = "已手动停止群聊回复";
    renderChat();
    await finishChatRun(running);
  }

  async function openChatTaskWindow() {
    const taskId = state.chatRunning && state.chatRunning.taskId;
    if (!taskId) return;
    if (!HOST.tasks || typeof HOST.tasks.open !== "function") {
      toast("当前桌面端不支持打开任务窗口", "error");
      return;
    }
    try {
      await HOST.tasks.open({ taskId });
    } catch (error) {
      toast(error.message || "打开任务失败", "error");
    }
  }

  function openChatWeb() {
    const run = state.chatContext && state.chatContext.run;
    const conversationId = run && run.conversationId;
    openExternal(baseWeb() + (conversationId ? "/messages?c=" + encodeURIComponent(conversationId) : "/messages"));
  }

  /* ── events ──────────────────────────────────────────── */

  function onClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.getAttribute("data-action");
    switch (action) {
      case "refresh":
        if (!state.token) return;
        refreshAll();
        return;
      case "open-settings":
        openSettings();
        return;
      case "close-settings":
        closeSettings();
        return;
      case "unpair":
        unpair();
        return;
      case "open-web":
        openExternal(baseWeb() + "/agent-sell");
        return;
      case "tab":
        state.activeTab = target.getAttribute("data-tab") || "pending";
        if (state.activeTab === "agents") loadModels();
        if (state.activeTab === "chat") refreshChatRuns();
        renderTabs();
        renderOrders();
        renderAgents();
        renderChat();
        return;
      case "refresh-chat":
        refreshChatRuns();
        return;
      case "open-chat-run":
        openChatRun(target.getAttribute("data-id"));
        return;
      case "run-chat-run":
        startChatRun(target.getAttribute("data-id"));
        return;
      case "stop-chat-run":
        stopChatRun();
        return;
      case "open-chat-task":
        openChatTaskWindow();
        return;
      case "open-chat-web":
        openChatWeb();
        return;
      case "open-order":
        openOrder(target.getAttribute("data-id"));
        return;
      case "close-detail":
        state.activeOrderId = "";
        state.detail = null;
        state.task = null;
        renderOrders();
        renderDetail();
        return;
      case "accept-order":
        acceptOrder();
        return;
      case "toggle-decline":
        state.declineOpen = !state.declineOpen;
        renderDecline();
        return;
      case "cancel-decline":
        state.declineOpen = false;
        renderDecline();
        return;
      case "run-agent":
        runAgent();
        return;
      case "resume-task":
        resumeTask();
        return;
      case "stop-task":
        stopTask();
        return;
      case "open-task":
        openTaskWindow();
        return;
      case "fill-delivery":
        fillDeliveryFromTask();
        return;
      case "toggle-case":
        state.caseOpen = !state.caseOpen;
        renderDetail();
        return;
      case "open-order-web":
        openExternal(baseWeb() + "/agent-orders/" + encodeURIComponent(target.getAttribute("data-id") || ""));
        return;
      case "open-agent-web":
        openExternal(baseWeb() + "/agents/" + encodeURIComponent(target.getAttribute("data-key") || ""));
        return;
      case "toggle-agent":
        toggleAgent(target.getAttribute("data-id"), target.getAttribute("data-status"));
        return;
      case "copy-prompt":
        copyPrompt(target.getAttribute("data-id"));
        return;
      default:
        return;
    }
  }

  function renderDecline() {
    const pane = $("#detailPane");
    if (!pane || !state.detail) return;
    const existing = pane.querySelector('[data-decline-form]');
    if (existing) existing.remove();
    if (!state.declineOpen) return;
    const footer = pane.querySelector(".action-bar");
    if (!footer) return;
    const form = document.createElement("form");
    form.setAttribute("data-form", "decline");
    form.setAttribute("data-decline-form", "1");
    form.className = "form-grid";
    form.style.padding = "13px 19px";
    form.style.borderTop = "1px solid var(--line)";
    form.innerHTML =
      '<label class="field"><span>拒单原因（可选，会同步给买家）</span>' +
      '<input name="reason" type="text" maxlength="200" placeholder="例如：当前排期已满，建议 3 天后再约" /></label>' +
      '<div class="agent-actions"><button class="btn btn-danger" type="submit"' + busyAttr("decline") + ">确认拒单并退款</button>" +
      '<button class="btn btn-ghost" type="button" data-action="cancel-decline">取消</button></div>';
    footer.insertAdjacentElement("beforebegin", form);
    const input = form.querySelector("input");
    if (input) input.focus();
  }

  async function onSubmit(event) {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    const kind = form.getAttribute("data-form");
    if (kind === "pair") return submitPair(form);
    if (kind === "settings") return saveSettings(form);
    if (kind === "decline") return submitDecline(form);
    if (kind === "delivery") return submitDelivery(form);
    if (kind === "case") return submitCase(form);
    if (kind === "message") return sendMessage(form);
  }

  /* ── boot ────────────────────────────────────────────── */

  async function boot() {
    document.addEventListener("click", onClick);
    document.addEventListener("submit", onSubmit);
    if (!HOST) {
      document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif"><h2>请在若道桌面端中打开 Agent 接单台</h2><p>接单台需要桌面端的任务与网络能力。</p></div>';
      return;
    }
    try {
      state.info = await HOST.ready;
    } catch {
      state.info = null;
    }
    await loadStorage();
    if (!state.settings.webBaseUrl) state.settings.webBaseUrl = DEFAULT_WEB;
    await loadModels();
    render();
    if (state.token) {
      await refreshAll();
    } else {
      render();
    }
    setInterval(() => {
      if (state.token) heartbeatPresence();
      if (state.token && !state.chatRunning) {
        loadChatQueue().then(() => {
          renderTabs();
          if (state.activeTab === "chat") renderChat();
        });
      }
      if (state.token && !state.detailLoading && !state.loadingOrders) refreshStatsOnly().then(() => {
        renderChrome();
        renderStats();
        renderTabs();
        renderOrders();
      });
    }, 30_000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
