import "./style.css";
import "./admin.css";
import { supabase } from "./supabase.js";
import { formatCurrency, formatDateTime, escapeHtml, timeAgo } from "./shared/format.js";
import { ORDER_STATUS, updateOrderStatus } from "./shared/orderStatus.js";
import { joinPresence, startHeartbeatLoop, fetchAllLastSeen } from "./shared/presence.js";
import { avatarHtml, chatBubbleHtml, chatThreadSkeletonHtml } from "./shared/chatUi.js";

const app = document.getElementById("admin-app");
const login = document.getElementById("admin-login");
const loginForm = document.getElementById("admin-login-form");
const loginError = document.getElementById("admin-login-error");
const sidebar = document.getElementById("admin-sidebar");
const sidebarOverlay = document.getElementById("admin-sidebar-overlay");
const pageTitle = document.getElementById("admin-page-title");
const toast = document.getElementById("admin-toast");

let orders = [];
let customers = [];
let siteSettings = null;
let trafficEvents = [];
let trafficReady = false;
let activeRoute = "overview";
let realtimeChannel = null;
let chatRealtimeChannel = null;
let chatConversations = []; // [{ conversationId, customerName, lastMessage, lastTime, unread }]
let activeConversationId = null;
let adminPresenceChannel = null;
let adminPresenceHeartbeatTimer = null;
let onlineConversationIds = new Set();
let lastSeenMap = new Map();

const ROUTES = {
  overview: "Tổng quan bán hàng",
  orders: "Đơn Hàng",
  customers: "Khách hàng",
  traffic: "Traffic",
  messages: "Tin nhắn",
};

const STATUS = ORDER_STATUS;

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 1800);
}

function setAuthView(session) {
  const isAuthed = !!session;
  if (login) {
    login.classList.toggle("hidden", isAuthed);
    login.classList.toggle("flex", !isAuthed);
  }
  if (app) {
    app.classList.toggle("hidden", !isAuthed);
  }
  if (!isAuthed) return;
  
  const email = session.user?.email || "Admin";
  const emailEl = document.getElementById("admin-email");
  const avatarEl = document.getElementById("admin-avatar");
  
  if (emailEl) emailEl.textContent = email;
  if (avatarEl) avatarEl.textContent = email.charAt(0).toUpperCase();
}

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (loginError) loginError.classList.add("hidden");
    const form = new FormData(loginForm);
    const { error } = await supabase.auth.signInWithPassword({
      email: form.get("email"),
      password: form.get("password"),
    });

    if (error) {
      if (loginError) {
        loginError.textContent = "Email hoặc mật khẩu không đúng.";
        loginError.classList.remove("hidden");
      }
      return;
    }
    loginForm.reset();
  });
}

// Đăng xuất tận gốc, xóa bộ nhớ máy rồi ép chuyển trang về frontend khách hàng
document.getElementById("admin-signout")?.addEventListener("click", () => {
  showToast("Đang đăng xuất...");
  try {
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith("sb-") || key.includes("auth-token")) {
        localStorage.removeItem(key);
      }
    });
    localStorage.removeItem(CACHE_KEY); // xoá cache đơn/khách để máy chung không lộ dữ liệu cũ
    sessionStorage.clear();
    supabase.auth.signOut().catch(() => {});
  } catch (e) {
    console.error(e);
  }
  window.setTimeout(() => {
    window.location.href = "/";
  }, 400);
});

document.getElementById("admin-refresh")?.addEventListener("click", () => loadBackoffice());

document.getElementById("admin-menu-toggle")?.addEventListener("click", () => {
  if (sidebar) sidebar.classList.remove("-translate-x-full");
  if (sidebarOverlay) sidebarOverlay.classList.remove("hidden");
});

sidebarOverlay?.addEventListener("click", () => {
  if (sidebar) sidebar.classList.add("-translate-x-full");
  if (sidebarOverlay) sidebarOverlay.classList.add("hidden");
});

document.querySelectorAll("[data-route], [data-route-link]").forEach((item) => {
  item.addEventListener("click", () => {
    const route = item.dataset.route || item.dataset.routeLink;
    navigate(route);
  });
});

function navigate(route) {
  if (!ROUTES[route]) route = "overview";
  activeRoute = route;
  window.history.replaceState(null, "", `#${route}`);
  if (pageTitle) pageTitle.textContent = ROUTES[route];
  
  document.querySelectorAll(".admin-view").forEach((view) => {
    view.classList.toggle("hidden", view.id !== `view-${route}`);
  });
  document.querySelectorAll("[data-route]").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.route === route);
  });

  if (sidebar) sidebar.classList.add("-translate-x-full");
  if (sidebarOverlay) sidebarOverlay.classList.add("hidden");
  renderActiveView();
}

const CACHE_KEY = "nomnom_admin_cache";

// Hiện ngay dữ liệu của lần xem gần nhất (lưu trong máy) để khỏi phải chờ mạng.
// Sau đó loadBackoffice() vẫn tải bản mới ở nền rồi tự cập nhật đè lên.
function hydrateFromCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (cached && Array.isArray(cached.orders)) {
      orders = cached.orders;
      customers = cached.customers || [];
      chatConversations = cached.chatConversations || [];
      return true;
    }
  } catch (e) {
    // cache hỏng thì bỏ qua, tải mới như bình thường
  }
  return false;
}

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ orders, customers, chatConversations }));
  } catch (e) {
    // hết dung lượng localStorage thì bỏ qua, không ảnh hưởng chức năng
  }
}

let isLoadingBackoffice = false;

// ── Thanh tiến trình "power bar" (kiểu trickle) ──
// KHÔNG thể đoán trước mạng nhanh/chậm để canh thanh đầy đúng lúc data về. Cách chuẩn
// (NProgress / GitHub / YouTube): thanh tiến nhanh lúc đầu rồi CHẬM DẦN tới ~90%, và chỉ
// SNAP 100% đúng khoảnh khắc dữ liệu thật sự về (finishProgress gọi trong finally bên dưới).
const progressBar = document.getElementById("admin-progress");
let progressTimer = null;
let progressVal = 0;
function setProgress(v) {
  progressVal = v;
  progressBar?.style.setProperty("--admin-progress", v + "%");
}
function startProgress() {
  if (!progressBar) return;
  clearInterval(progressTimer);
  progressBar.classList.add("is-active");
  setProgress(8);
  progressTimer = setInterval(() => {
    const step = Math.max(0.4, (90 - progressVal) * 0.09); // càng gần 90% càng bò chậm
    setProgress(Math.min(90, progressVal + step));
  }, 220);
}
function finishProgress() {
  if (!progressBar) return;
  clearInterval(progressTimer);
  setProgress(100);
  setTimeout(() => {
    progressBar.classList.remove("is-active");
    setTimeout(() => setProgress(0), 380);
  }, 300);
}

// Khung xám nhấp nháy (skeleton) giữ chỗ khi bảng chưa có dữ liệu → tránh "trang chết / trống trơn"
function skeletonRows(n = 6) {
  return `<div class="mt-2 space-y-2">${Array.from({ length: n })
    .map(() => `<div class="skeleton h-11 w-full rounded-lg"></div>`)
    .join("")}</div>`;
}
function showLoadingSkeletons() {
  ["orders-table", "customers-table"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = skeletonRows(6);
  });
  const traffic = document.getElementById("traffic-state");
  if (traffic) traffic.innerHTML = skeletonRows(4);
}

async function loadBackoffice({ skipTraffic = false } = {}) {
  // Khoá chống gọi chồng: nếu đang có 1 lần loadBackoffice() chạy dở thì bỏ qua lần
  // gọi mới — gọi Supabase chồng lên nhau ngay lúc phiên đăng nhập đang xử lý từng
  // gây treo (deadlock) bên trong thư viện Supabase, bất kể nguyên nhân gọi chồng là gì
  // (auth tự bắn lại, realtime kích hoạt khi đang tải, bấm Làm mới nhiều lần...).
  if (isLoadingBackoffice) return;
  isLoadingBackoffice = true;

  if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY) {
    console.error("❌ LỖI: Thiếu cấu hình VITE_SUPABASE_URL hoặc VITE_SUPABASE_ANON_KEY trên Vercel.");
    isLoadingBackoffice = false;
    return;
  }

  startProgress(); // thanh tiến trình chạy suốt lúc gọi Supabase

  // Chưa có gì để hiện (kể cả cache rỗng) → khung skeleton giữ chỗ ở các bảng, tránh "trang chết".
  if (!orders.length) showLoadingSkeletons();

  // Lưới an toàn chống treo: thư viện Supabase thỉnh thoảng deadlock khi bắn nhiều
  // truy vấn cùng lúc lúc phiên đăng nhập vừa mở (xem CLAUDE.md). Để 30s cho rộng —
  // tải bình thường luôn xong trước đó nên người dùng gần như không bao giờ thấy nó.
  // Huỷ hẳn các truy vấn Supabase nếu quá thời gian, thay vì để chúng chạy mồ côi ở nền.
  const controller = new AbortController();
  let timeoutHandle;
  const timeoutAfter = (ms) =>
    new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new Error("Kết nối tới Supabase quá lâu — bấm Làm mới để thử lại."));
      }, ms);
    });

  try {
    const { start, end } = todayRange();
    // skipTraffic=true (do realtime đơn/khách gọi): KHÔNG kéo lại 1000 dòng analytics_events
    // mỗi lần có đơn thay đổi. Traffic chỉ tải ở lần mount đầu + khi bấm Làm mới.
    const queries = [
      supabase.from("orders").select("*").order("created_at", { ascending: false }).limit(250).abortSignal(controller.signal),
      supabase.from("customers").select("*").order("created_at", { ascending: false }).limit(250).abortSignal(controller.signal),
    ];
    if (!skipTraffic) {
      queries.push(
        supabase
          .from("analytics_events")
          .select("*")
          .gte("created_at", start.toISOString())
          .lt("created_at", end.toISOString())
          .order("created_at", { ascending: false })
          .limit(1000)
          .abortSignal(controller.signal)
      );
    }
    queries.push(supabase.from("site_settings").select("*").single().abortSignal(controller.signal));

    const results = await Promise.race([Promise.all(queries), timeoutAfter(30000)]);
    const { data: orderData, error: orderError } = results[0];
    const { data: customerData, error: customerError } = results[1];
    const { data: trafficData, error: trafficError } = skipTraffic ? {} : results[2];
    const { data: settingsData } = skipTraffic ? results[2] : results[3];

    if (orderError) showToast(`Lỗi đơn hàng: ${orderError.message}`);
    if (customerError) showToast(`Lỗi khách hàng: ${customerError.message}`);

    // Nếu đọc bảng orders bị lỗi (thường là RLS chặn quyền), hiện rõ ngay trong khung
    // đơn hàng thay vì để "Chưa có đơn phù hợp" gây hiểu nhầm là không có đơn nào.
    if (orderError) {
      const ordersTableEl = document.getElementById("orders-table");
      if (ordersTableEl) {
        ordersTableEl.innerHTML = `<div class="admin-empty" style="color:#b91c1c">Lỗi đọc đơn hàng: ${escapeHtml(orderError.message)}<br><span style="font-size:12px">Thường do RLS của bảng orders chưa cho phép đọc. Kiểm tra policy SELECT trên Supabase.</span></div>`;
      }
      return; // giữ nguyên dữ liệu cache cũ (nếu có), không ghi đè bằng mảng rỗng
    }

    orders = orderData || [];
    customers = customerData || [];
    if (settingsData) siteSettings = settingsData;
    if (!skipTraffic) {
      trafficReady = !trafficError;
      trafficEvents = trafficData || [];
    }
    saveCache();
    renderAll();
  } catch (catchErr) {
    console.error("Lỗi kết nối:", catchErr);
    // Chỉ báo khi thật sự chưa có gì để hiện — nếu đã có dữ liệu (cache/lần tải trước)
    // thì im lặng, tránh toast gây hiểu lầm dù màn hình vẫn đang hiển thị bình thường.
    if (!orders.length) showToast(catchErr?.message || "Lỗi kết nối tới Supabase");
  } finally {
    clearTimeout(timeoutHandle); // tránh timeout bắn muộn gọi abort() thừa sau khi đã xong
    isLoadingBackoffice = false;
    finishProgress(); // dữ liệu đã về (hoặc lỗi) → thanh đầy 100% rồi mờ đi
  }
}

function renderAll() {
  renderMetrics();
  renderOverview();
  renderOrders();
  renderCustomers();
  renderTierConfig();
  renderVoucherSender();
  renderTraffic();
}

// ── Cấu hình Hạng khách & Voucher (site_settings.tier_config + các cột int) ──
const DEFAULT_TIERS = [
  { name: "Đồng", min_spend: 0, monthly_count: 3, percent: 5 },
  { name: "Bạc", min_spend: 500000, monthly_count: 5, percent: 10 },
  { name: "Vàng", min_spend: 1200000, monthly_count: 5, percent: 15 },
  { name: "Kim cương", min_spend: 2500000, monthly_count: 5, percent: 20 },
];

function currentTiers() {
  const tc = siteSettings?.tier_config;
  const arr = Array.isArray(tc) ? tc : typeof tc === "string" && tc ? JSON.parse(tc) : null;
  return (arr && arr.length ? arr : DEFAULT_TIERS).slice().sort((a, b) => a.min_spend - b.min_spend);
}

// ── Ô số kiểu pill (nút −/+) + định dạng phân cách nghìn cho tiền ──
const ICON_MINUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 12h14"/></svg>`;
const ICON_PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`;

function formatIntSep(n) {
  const v = String(n ?? "").replace(/\D/g, "");
  return v.replace(/\B(?=(\d{3})+(?!\d))/g, "."); // 1200000 → 1.200.000
}
function readNum(el) {
  return parseInt(String(el?.value ?? "").replace(/\D/g, ""), 10) || 0;
}
// Ô pill có nút −/+ (dùng cho các trường số đứng riêng, đủ rộng)
function stepperHtml({ id = "", value = 0, min = null, max = null, step = 1, money = false, extra = "" }) {
  const display = value === "" || value == null ? "" : money ? formatIntSep(value) : String(value);
  const attrs = [
    id && `id="${id}"`,
    min != null && `data-min="${min}"`,
    max != null && `data-max="${max}"`,
    `data-step="${step}"`,
    money && `data-money="1"`,
    extra,
  ].filter(Boolean).join(" ");
  return `<div class="admin-num">
    <button type="button" class="admin-num-btn" data-num-step="-1" tabindex="-1" aria-label="Giảm">${ICON_MINUS}</button>
    <input type="text" inputmode="numeric" class="admin-num-input" value="${display}" ${attrs} />
    <button type="button" class="admin-num-btn" data-num-step="1" tabindex="-1" aria-label="Tăng">${ICON_PLUS}</button>
  </div>`;
}

// Gõ vào ô có data-money → tự chèn dấu chấm phân cách nghìn (giữ con trỏ gần cuối)
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.tagName !== "INPUT" || !el.dataset?.money) return;
  const fromEnd = el.value.length - (el.selectionStart ?? el.value.length);
  el.value = formatIntSep(el.value);
  const pos = Math.max(0, el.value.length - fromEnd);
  try { el.setSelectionRange(pos, pos); } catch {}
});
// Bấm nút −/+ của ô pill
document.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-num-step]");
  if (!btn) return;
  const input = btn.closest(".admin-num")?.querySelector(".admin-num-input");
  if (!input) return;
  const step = Number(input.dataset.step) || 1;
  let val = readNum(input) + Number(btn.dataset.numStep) * step;
  const min = input.dataset.min != null ? Number(input.dataset.min) : null;
  const max = input.dataset.max != null ? Number(input.dataset.max) : null;
  if (min != null && val < min) val = min;
  if (max != null && val > max) val = max;
  input.value = input.dataset.money ? formatIntSep(val) : String(val);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

function renderTierConfig() {
  const box = document.getElementById("tier-config-rows");
  if (!box) return;
  // Ô trong lưới hạng dùng input pill gọn (không nút −/+ vì 4 cột hẹp); ô tiền có phân cách nghìn.
  box.innerHTML = currentTiers()
    .map(
      (t, i) => `
      <div class="grid grid-cols-[1.1fr_1fr_0.8fr_0.8fr] items-center gap-2">
        <span class="text-sm font-semibold text-ink">${t.name}</span>
        <input data-tier="${i}" data-field="min_spend" data-money="1" type="text" inputmode="numeric" value="${formatIntSep(t.min_spend)}" class="admin-input admin-input-pill w-full" />
        <input data-tier="${i}" data-field="monthly_count" type="text" inputmode="numeric" value="${t.monthly_count}" class="admin-input admin-input-pill w-full" />
        <input data-tier="${i}" data-field="percent" type="text" inputmode="numeric" value="${t.percent}" class="admin-input admin-input-pill w-full" />
      </div>`
    )
    .join("");
  const bp = document.getElementById("cfg-birthday-percent");
  const mv = document.getElementById("cfg-max-vouchers");
  const md = document.getElementById("cfg-max-discount");
  if (bp) bp.value = siteSettings?.birthday_voucher_percent ?? 25;
  if (mv) mv.value = siteSettings?.max_vouchers_per_order ?? 2;
  if (md) md.value = formatIntSep(siteSettings?.max_discount_amount ?? 0);
}

async function saveTierConfig() {
  const box = document.getElementById("tier-config-rows");
  if (!box) return;
  const tier_config = currentTiers().map((t, i) => ({
    name: t.name,
    min_spend: readNum(box.querySelector(`[data-tier="${i}"][data-field="min_spend"]`)),
    monthly_count: readNum(box.querySelector(`[data-tier="${i}"][data-field="monthly_count"]`)),
    percent: readNum(box.querySelector(`[data-tier="${i}"][data-field="percent"]`)),
  }));
  const row = {
    tier_config,
    birthday_voucher_percent: readNum(document.getElementById("cfg-birthday-percent")),
    max_vouchers_per_order: readNum(document.getElementById("cfg-max-vouchers")) || 2,
    max_discount_amount: readNum(document.getElementById("cfg-max-discount")),
  };
  const msg = document.getElementById("tier-config-msg");
  const { error } = await supabase.from("site_settings").update(row).eq("id", 1);
  if (error) {
    if (msg) msg.textContent = "Lỗi: " + error.message;
    showToast("Lỗi lưu cấu hình: " + error.message);
    return;
  }
  siteSettings = { ...(siteSettings || {}), ...row };
  if (msg) { msg.textContent = "✓ Đã lưu"; setTimeout(() => (msg.textContent = ""), 2500); }
  showToast("Đã lưu cấu hình hạng & voucher");
}

document.getElementById("tier-config-save")?.addEventListener("click", saveTierConfig);

function renderActiveView() {
  if (activeRoute === "overview") renderOverview();
  if (activeRoute === "orders") renderOrders();
  if (activeRoute === "customers") renderCustomers();
  if (activeRoute === "traffic") renderTraffic();
  if (activeRoute === "messages") renderConversations();
}

function paidLike(order) {
  return order.status === "paid" || order.status === "delivered";
}

function ordersToday() {
  const { start, end } = todayRange();
  return orders.filter((order) => {
    const created = new Date(order.created_at);
    return created >= start && created < end;
  });
}

function trafficStats() {
  const visitors = new Set(trafficEvents.map((event) => event.visitor_id).filter(Boolean));
  const sessions = new Set(trafficEvents.map((event) => event.session_id).filter(Boolean));
  return {
    uniqueVisitors: visitors.size,
    sessions: sessions.size,
    pageViews: trafficEvents.filter((event) => (event.event_name || "page_view") === "page_view").length,
  };
}

function renderMetrics() {
  const todayOrders = ordersToday();
  const paidToday = todayOrders.filter(paidLike);
  const activeOrders = orders.filter((order) => order.status === "paid" || order.status === "pending");
  const revenueToday = paidToday.reduce((sum, order) => sum + Number(order.total || 0), 0);
  const navBadge = document.getElementById("nav-orders-count");

  const revenueTodayEl = document.getElementById("metric-revenue-today");
  const activeOrdersEl = document.getElementById("metric-active-orders");
  const customersEl = document.getElementById("metric-customers");
  const customersNoteEl = document.getElementById("metric-customers-note");

  if (revenueTodayEl) revenueTodayEl.textContent = formatCurrency(revenueToday);

  // So sánh doanh thu hôm nay với hôm qua (▲/▼) — tính từ orders đã tải, không cần bảng mới.
  const deltaEl = document.getElementById("metric-revenue-delta");
  if (deltaEl) {
    const { start: todayStart } = todayRange();
    const yStart = new Date(todayStart);
    yStart.setDate(yStart.getDate() - 1);
    const revenueYesterday = orders
      .filter(paidLike)
      .filter((o) => {
        const c = new Date(o.created_at);
        return c >= yStart && c < todayStart;
      })
      .reduce((sum, o) => sum + Number(o.total || 0), 0);

    if (revenueYesterday === 0) {
      deltaEl.className = "admin-stat-delta is-flat";
      deltaEl.textContent = revenueToday > 0 ? "Hôm qua chưa có doanh thu" : "";
    } else {
      const pct = Math.round(((revenueToday - revenueYesterday) / revenueYesterday) * 100);
      const up = pct >= 0;
      deltaEl.className = `admin-stat-delta ${up ? "is-up" : "is-down"}`;
      deltaEl.textContent = `${up ? "▲" : "▼"} ${Math.abs(pct)}% so với hôm qua`;
    }
  }

  if (activeOrdersEl) activeOrdersEl.textContent = activeOrders.length;
  if (customersEl) customersEl.textContent = customers.length;
  if (customersNoteEl) customersNoteEl.textContent = `${new Set(orders.map((order) => order.customer_phone).filter(Boolean)).size} số điện thoại có đơn`;

  if (navBadge) {
    navBadge.textContent = activeOrders.length;
    navBadge.classList.toggle("hidden", activeOrders.length === 0);
  }

  const visitorsTodayEl = document.getElementById("metric-visitors-today");
  const trafficNoteEl = document.getElementById("metric-traffic-note");

  if (trafficReady) {
    const stats = trafficStats();
    if (visitorsTodayEl) visitorsTodayEl.textContent = stats.uniqueVisitors;
    if (trafficNoteEl) trafficNoteEl.textContent = `${stats.pageViews} page views`;
  } else {
    if (visitorsTodayEl) visitorsTodayEl.textContent = "--";
    if (trafficNoteEl) trafficNoteEl.textContent = "Chưa bật tracking";
  }
}

function renderOverview() {
  const active = orders.filter((order) => order.status === "paid" || order.status === "pending").slice(0, 6);
  const overviewOrdersEl = document.getElementById("overview-orders");
  if (overviewOrdersEl) overviewOrdersEl.innerHTML = renderOrderTable(active, { compact: true });

  renderRevenueChart();
  renderTopSellers();

  const today = ordersToday();
  const stats = trafficReady ? trafficStats() : null;
  const paidCount = today.filter(paidLike).length;
  const conversion =
    stats && stats.uniqueVisitors > 0 ? `${Math.round((paidCount / stats.uniqueVisitors) * 100)}%` : "--";
  
  const overviewPulseEl = document.getElementById("overview-pulse");
  if (overviewPulseEl) {
    overviewPulseEl.innerHTML = `
      ${renderPulseRow("Đơn mới hôm nay", today.length)}
      ${renderPulseRow("Đơn đã thanh toán", paidCount)}
      ${renderPulseRow("Khách truy cập", stats ? stats.uniqueVisitors : "Chưa có bảng")}
      ${renderPulseRow("Tỷ lệ chuyển đổi", conversion)}
    `;
  }
}

function renderPulseRow(label, value) {
  return `
    <div class="admin-pulse-row">
      <span class="text-sm text-ash">${label}</span>
      <span class="font-serif text-xl text-ink">${value}</span>
    </div>
  `;
}

// ── Biểu đồ Tổng quan (vẽ bằng SVG, dữ liệu từ mảng orders đã tải — không cần bảng/SQL mới) ──

const CHART_ACCENT = "#7a0c1f";
const WEEKDAY_VI = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

// Rút gọn tiền cho nhãn nhỏ trên cột: 1.200.000 → "1.2tr", 45.000 → "45k"
function compactCurrency(value) {
  const v = Number(value || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}tr`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
  return String(v);
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Doanh thu (đơn paid/delivered) gộp theo từng ngày trong `days` ngày gần nhất.
function revenueLastDays(days) {
  const buckets = [];
  const base = startOfDay(new Date());
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    buckets.push({ date: d, revenue: 0 });
  }
  orders.filter(paidLike).forEach((order) => {
    const c = startOfDay(order.created_at).getTime();
    const bucket = buckets.find((b) => b.date.getTime() === c);
    if (bucket) bucket.revenue += Number(order.total || 0);
  });
  return buckets;
}

function renderRevenueChart() {
  const el = document.getElementById("overview-revenue-chart");
  const totalEl = document.getElementById("overview-revenue-total");
  if (!el) return;

  const data = revenueLastDays(7);
  const total = data.reduce((sum, d) => sum + d.revenue, 0);
  if (totalEl) totalEl.textContent = formatCurrency(total);

  if (total <= 0) {
    el.innerHTML = `<div class="admin-empty">Chưa có doanh thu trong 7 ngày qua.</div>`;
    return;
  }

  const max = Math.max(...data.map((d) => d.revenue), 1);
  const W = 700, H = 220, padX = 10, padTop = 26, padBottom = 26;
  const plotH = H - padTop - padBottom;
  const slot = (W - padX * 2) / data.length;
  const barW = Math.min(46, slot * 0.6);
  const todayTime = startOfDay(new Date()).getTime();

  const bars = data
    .map((d, i) => {
      const h = Math.max(2, (d.revenue / max) * plotH);
      const x = padX + slot * i + (slot - barW) / 2;
      const y = padTop + (plotH - h);
      const cx = x + barW / 2;
      const isToday = d.date.getTime() === todayTime;
      const isPeak = d.revenue === max;
      const dd = String(d.date.getDate()).padStart(2, "0");
      const mm = String(d.date.getMonth() + 1).padStart(2, "0");
      const label = WEEKDAY_VI[d.date.getDay()];
      const showValue = d.revenue > 0 && (isToday || isPeak);
      const tip = `${label} ${dd}/${mm} · ${formatCurrency(d.revenue)}`;
      return `
        <g class="ov-bar" data-tip="${escapeHtml(tip)}" data-cx="${cx.toFixed(1)}" data-top="${y.toFixed(1)}" style="opacity:${isToday ? 1 : 0.78}">
          <rect x="${(padX + slot * i).toFixed(1)}" y="${padTop}" width="${slot.toFixed(1)}" height="${plotH}" fill="transparent"></rect>
          <rect class="ov-bar-fill" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${CHART_ACCENT}"></rect>
          ${showValue ? `<text x="${cx.toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="600" class="ov-bar-value">${compactCurrency(d.revenue)}</text>` : ""}
          <text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="12" font-weight="${isToday ? 700 : 400}" class="ov-bar-day${isToday ? " is-today" : ""}">${label}</text>
        </g>`;
    })
    .join("");

  el.innerHTML = `
    <div class="ov-chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Biểu đồ doanh thu 7 ngày qua">
        <line x1="${padX}" y1="${(padTop + plotH + 0.5).toFixed(1)}" x2="${W - padX}" y2="${(padTop + plotH + 0.5).toFixed(1)}" stroke="#D4C5B9" stroke-width="1"></line>
        ${bars}
      </svg>
      <div class="ov-tooltip" hidden></div>
    </div>`;

  // Tooltip tùy biến bám theo cột (thay cho <title> mặc định chậm & xấu).
  const wrap = el.querySelector(".ov-chart-wrap");
  const tip = el.querySelector(".ov-tooltip");
  wrap.querySelectorAll(".ov-bar").forEach((g) => {
    const showTip = () => {
      tip.textContent = g.dataset.tip;
      tip.hidden = false;
      tip.style.left = `${(parseFloat(g.dataset.cx) / W) * 100}%`;
      tip.style.top = `${(parseFloat(g.dataset.top) / H) * 100}%`;
    };
    g.addEventListener("mouseenter", showTip);
    g.addEventListener("mouseleave", () => { tip.hidden = true; });
  });
}

// Top món bán chạy trong `days` ngày gần nhất — gộp từ order.items của đơn paid/delivered.
function topSellersLastDays(days, limit) {
  const cutoff = startOfDay(new Date());
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const map = new Map();
  orders.filter(paidLike).forEach((order) => {
    if (new Date(order.created_at) < cutoff) return;
    (Array.isArray(order.items) ? order.items : []).forEach((item) => {
      const name = item.name || "—";
      const prev = map.get(name) || { qty: 0, revenue: 0 };
      prev.qty += Number(item.qty || 0);
      prev.revenue += Number(item.qty || 0) * Number(item.price || 0);
      map.set(name, prev);
    });
  });
  return [...map.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, limit);
}

function renderTopSellers() {
  const el = document.getElementById("overview-top-sellers");
  if (!el) return;

  const list = topSellersLastDays(7, 5);
  if (!list.length) {
    el.innerHTML = `<div class="admin-empty">Chưa có món nào bán ra trong 7 ngày.</div>`;
    return;
  }

  const maxQty = Math.max(...list.map((s) => s.qty), 1);
  el.innerHTML = list
    .map(
      (s, i) => `
      <div class="ov-seller" title="${escapeHtml(s.name)} · ×${s.qty} · ${formatCurrency(s.revenue)}">
        <div class="flex items-baseline justify-between gap-3">
          <span class="truncate text-sm font-medium text-ink">${i + 1}. ${escapeHtml(s.name)}</span>
          <span class="shrink-0 text-sm font-semibold text-ink">×${s.qty}</span>
        </div>
        <div class="mt-1.5 flex items-center gap-2">
          <div class="h-2 flex-1 overflow-hidden rounded-full bg-earth/25">
            <div class="ov-seller-fill h-full rounded-full" style="width:${Math.max(6, (s.qty / maxQty) * 100)}%;background:${CHART_ACCENT}"></div>
          </div>
          <span class="shrink-0 text-xs text-ash">${formatCurrency(s.revenue)}</span>
        </div>
      </div>`
    )
    .join("");
}

function getFilteredOrders() {
  const search = document.getElementById("orders-search")?.value.trim().toLowerCase() || "";
  const status = document.getElementById("orders-status-filter")?.value || "all";
  const dateStart = document.getElementById("orders-date-start")?.value;
  const dateEnd = document.getElementById("orders-date-end")?.value;

  let list = [...orders];

  if (status === "active") list = list.filter((order) => order.status === "paid" || order.status === "pending");
  else if (status !== "all") list = list.filter((order) => order.status === status);

  if (search) {
    list = list.filter((order) =>
      [order.order_code, order.customer_name, order.customer_phone, order.customer_address]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search))
    );
  }

  if (dateStart) {
    const start = new Date(dateStart);
    start.setHours(0, 0, 0, 0);
    list = list.filter((order) => new Date(order.created_at) >= start);
  }
  
  if (dateEnd) {
    const end = new Date(dateEnd);
    end.setHours(23, 59, 59, 999);
    list = list.filter((order) => new Date(order.created_at) <= end);
  }

  return list;
}

let ordersPage = 1;

function renderOrders() {
  const list = getFilteredOrders();
  const ordersTableEl = document.getElementById("orders-table");
  if (!ordersTableEl) return;

  // Phân trang: 8 dòng/trang
  const PAGE_SIZE = 8;
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (ordersPage > totalPages) ordersPage = totalPages;
  if (ordersPage < 1) ordersPage = 1;
  const pageStart = (ordersPage - 1) * PAGE_SIZE;
  const pageList = list.slice(pageStart, pageStart + PAGE_SIZE);

  ordersTableEl.innerHTML = renderOrderTable(pageList) + pagerHtml(ordersPage, totalPages, "data-order-page");
  ordersTableEl.querySelectorAll("[data-order-page]").forEach((btn) =>
    btn.addEventListener("click", () => {
      ordersPage = Number(btn.dataset.orderPage);
      renderOrders();
    })
  );
}

// Đổi bộ lọc (tìm kiếm / trạng thái / ngày) → luôn về trang 1
const resetOrdersPageAndRender = () => {
  ordersPage = 1;
  renderOrders();
};
document.getElementById("orders-search")?.addEventListener("input", resetOrdersPageAndRender);
document.getElementById("orders-status-filter")?.addEventListener("change", resetOrdersPageAndRender);
document.getElementById("orders-date-start")?.addEventListener("change", resetOrdersPageAndRender);
document.getElementById("orders-date-end")?.addEventListener("change", resetOrdersPageAndRender);

document.getElementById("orders-export")?.addEventListener("click", () => {
  const list = getFilteredOrders();
  if (!list.length) {
    showToast("Không có dữ liệu để xuất");
    return;
  }

  const headers = ["Mã đơn", "Ngày tạo", "Khách hàng", "SĐT", "Địa chỉ", "Món bánh", "Giờ giao", "Tổng tiền", "Trạng thái"];
  const rows = list.map(order => {
    const items = Array.isArray(order.items) ? order.items.map(i => `${i.name} x${i.qty}${i.note ? ` (${i.note})` : ""}`).join("; ") : "";
    const statusLabel = STATUS[order.status] ? STATUS[order.status].label : order.status;
    
    return [
      order.order_code || "",
      order.created_at ? formatDateTime(order.created_at) : "",
      order.customer_name || "",
      order.customer_phone || "",
      order.customer_address ? String(order.customer_address).replace(/"/g, '""') : "",
      items,
      order.delivery_time || "Giao Sớm Nhất",
      order.total || 0,
      statusLabel
    ].map(v => `"${v}"`).join(",");
  });

  const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `DonHang_nomnom_${new Date().toISOString().slice(0,10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
});

function renderOrderTable(list, options = {}) {
  if (!list.length) {
    return `<div class="admin-empty">Chưa có đơn phù hợp.</div>`;
  }

  return `
    <table class="admin-table${options.compact ? "" : " admin-table--fixed"}">
      ${options.compact ? "" : `<colgroup>
        <col style="width:8rem" />
        <col style="width:9rem" />
        <col style="width:14rem" />
        <col style="width:12rem" />
        <col style="width:6rem" />
        <col style="width:7rem" />
        <col style="width:13rem" />
      </colgroup>`}
      <thead>
        <tr>
          <th>Đơn</th>
          <th>Khách</th>
          <th>Món bánh</th>
          <th>Giao hàng</th>
          <th>Tổng</th>
          <th>Trạng thái</th>
          ${options.compact ? "" : "<th></th>"}
        </tr>
      </thead>
      <tbody>
        ${list
          .map((order) => {
            const status = STATUS[order.status] || { label: order.status || "--", tone: "ash" };
            const items = Array.isArray(order.items) ? order.items : [];
            return `
              <tr>
                <td>
                  <span class="font-semibold text-ink">${order.order_code || "--"}</span>
                  <span class="mt-1 block text-xs text-ash">${formatDateTime(order.created_at)}</span>
                </td>
                <td>
                  <span class="font-medium text-ink">${order.customer_name || "--"}</span>
                  <span class="mt-1 block text-xs text-ash">${order.customer_phone || ""}</span>
                </td>
                <td>
                  <span class="line-clamp-2 text-sm text-ink">${items.map((item) => `${item.name} x${item.qty}${item.note ? ` (${item.note})` : ""}`).join(", ") || "--"}</span>
                </td>
                <td>
                  <span class="text-sm text-ink">${order.delivery_time || "Giao Sớm Nhất"}</span>
                  <span class="mt-1 block max-w-[14rem] truncate text-xs text-ash">${order.customer_address || ""}</span>
                </td>
                <td class="font-semibold text-ink">${formatCurrency(order.total)}</td>
                <td><span class="admin-status admin-status-${status.tone}">${status.label}</span></td>
                ${
                  options.compact
                    ? ""
                    : `<td>
                        <div class="flex justify-end gap-2">
                          ${order.status === "pending" ? `<button class="admin-row-button" data-order-status="${order.id}:paid">Xác nhận tiền về</button>` : ""}
                          ${order.status === "pending" ? `<button class="admin-row-button is-danger" data-order-status="${order.id}:cancelled">Hủy</button>` : ""}
                          ${order.status === "paid" ? `<button class="admin-row-button" data-order-status="${order.id}:delivered">Đã giao</button>` : ""}
                          ${order.status === "paid" ? `<button class="admin-row-button is-danger" data-order-status="${order.id}:cancelled">Hủy</button>` : ""}
                        </div>
                      </td>`
                }
              </tr>
            `;
          })
          .join("")}
      </tbody>
    </table>
  `;
}

document.getElementById("orders-table")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-order-status]");
  if (!button) return;
  const [id, status] = button.dataset.orderStatus.split(":");
  if (status === "cancelled" && !window.confirm("Hủy đơn này?")) return;

  const { error } = await updateOrderStatus(id, status);
  if (error) {
    showToast(`Lỗi cập nhật: ${error.message}`);
    return;
  }

  showToast("Đã cập nhật trạng thái đơn");
  await loadBackoffice();
});

function customerStatsByPhone() {
  const map = new Map();
  orders.filter(paidLike).forEach((order) => {
    if (!order.customer_phone) return;
    const prev = map.get(order.customer_phone) || { orders: 0, spend: 0, lastOrder: null };
    prev.orders += 1;
    prev.spend += Number(order.total || 0);
    if (!prev.lastOrder || new Date(order.created_at) > new Date(prev.lastOrder)) {
      prev.lastOrder = order.created_at;
    }
    map.set(order.customer_phone, prev);
  });
  return map;
}

let customersPage = 1;

// Thanh phân trang dùng chung: trang đầu/cuối + cửa sổ quanh trang hiện tại, chèn "…" khi cách quãng.
// pageAttr = tên data-attribute gắn số trang (vd "data-cust-page", "data-order-page").
function pagerHtml(current, total, pageAttr) {
  if (total <= 1) return "";
  const item = (p, label, opts = {}) =>
    `<button type="button" class="admin-pager-btn${opts.active ? " is-active" : ""}"${opts.disabled ? " disabled" : ` ${pageAttr}="${p}"`}>${label}</button>`;
  const nums = new Set([1, total, current]);
  for (let i = current - 1; i <= current + 1; i++) if (i >= 1 && i <= total) nums.add(i);
  const sorted = [...nums].sort((a, b) => a - b);
  let html = item(current - 1, "‹", { disabled: current === 1 });
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) html += `<span class="admin-pager-gap">…</span>`;
    html += item(p, String(p), { active: p === current });
    prev = p;
  }
  html += item(current + 1, "›", { disabled: current === total });
  return `<div class="admin-pager">${html}</div>`;
}

function renderCustomers() {
  const search = document.getElementById("customers-search")?.value.trim().toLowerCase() || "";
  const stats = customerStatsByPhone();
  let list = customers.map((customer) => ({
    ...customer,
    sales: stats.get(customer.phone) || { orders: 0, spend: 0, lastOrder: null },
  }));
  if (search) {
    list = list.filter((customer) =>
      [customer.name, customer.phone, customer.address]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search))
    );
  }

  const customersTableEl = document.getElementById("customers-table");
  if (!list.length) {
    if (customersTableEl) customersTableEl.innerHTML = `<div class="admin-empty">Chưa có khách hàng phù hợp.</div>`;
    return;
  }

  // Phân trang: 8 dòng/trang
  const PAGE_SIZE = 8;
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (customersPage > totalPages) customersPage = totalPages;
  if (customersPage < 1) customersPage = 1;
  const pageStart = (customersPage - 1) * PAGE_SIZE;
  const pageList = list.slice(pageStart, pageStart + PAGE_SIZE);

  if (customersTableEl) {
    customersTableEl.innerHTML = `
      <table class="admin-table">
        <thead>
          <tr>
            <th>Khách</th>
            <th>Số điện thoại</th>
            <th>Địa chỉ</th>
            <th>Số đơn</th>
            <th>Tổng chi tiêu</th>
            <th>Lần cuối</th>
            <th>Voucher</th>
          </tr>
        </thead>
        <tbody>
          ${pageList
            .map(
              (customer) => `
                <tr>
                  <td>
                    <span class="font-semibold text-ink">${customer.name || "Khách nomnom"}</span>
                    <span class="mt-1 block text-xs text-ash">Voucher đã dùng: ${customer.vouchers_used || 0}</span>
                  </td>
                  <td>${customer.phone || "--"}</td>
                  <td><span class="line-clamp-2">${customer.address || "--"}</span></td>
                  <td class="font-semibold text-ink">${customer.sales.orders}</td>
                  <td class="font-semibold text-ink">${formatCurrency(customer.sales.spend)}</td>
                  <td>${customer.sales.lastOrder ? formatDateTime(customer.sales.lastOrder) : "--"}</td>
                  <td>${customer.phone ? `<button type="button" class="admin-gift-btn" data-gift-voucher="${customer.phone}" data-gift-name="${(customer.name || "").replace(/"/g, "&quot;")}">Tặng ↗</button>` : "--"}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
      ${pagerHtml(customersPage, totalPages, "data-cust-page")}
    `;
    customersTableEl.querySelectorAll("[data-gift-voucher]").forEach((btn) =>
      btn.addEventListener("click", () => selectCustomerForVoucher(btn.dataset.giftVoucher))
    );
    customersTableEl.querySelectorAll("[data-cust-page]").forEach((btn) =>
      btn.addEventListener("click", () => {
        customersPage = Number(btn.dataset.custPage);
        renderCustomers();
      })
    );
  }
}

document.getElementById("customers-search")?.addEventListener("input", () => {
  customersPage = 1;
  renderCustomers();
});

// ── Tạo & gửi voucher cho khách (panel "Tạo & gửi voucher" trong route Khách hàng) ──
// Mỗi khách nhận 1 mã riêng (schema khoá code duy nhất + dùng 1 lần). Gửi tất cả hoặc chọn lẻ.
let gvSelected = new Set();     // SĐT khách được chọn ở chế độ "chọn khách"
let gvPendingConfirm = false;   // xác nhận 2 bước (tránh hộp thoại native)
let gvPage = 1;                 // trang hiện tại của danh sách khách
let gvInitialized = false;      // đã mặc-định-chọn-tất-cả lần đầu chưa

function gvResetConfirm() {
  gvPendingConfirm = false;
}

function renderVoucherSender() {
  const withPhone = customers.filter((c) => c.phone);
  const allCount = document.getElementById("gv-all-count");
  if (allCount) allCount.textContent = withPhone.length;
  // Mặc định CHỌN TẤT CẢ khách (lần đầu có dữ liệu) → cô chủ chỉ việc bỏ tích khách không gửi
  if (!gvInitialized && withPhone.length > 0) {
    gvSelected = new Set(withPhone.map((c) => c.phone));
    gvInitialized = true;
  }
  renderVoucherList();
}

function renderVoucherList() {
  const box = document.getElementById("gv-list");
  if (!box) return;
  const q = (document.getElementById("gv-search")?.value || "").trim().toLowerCase();
  const list = customers
    .filter((c) => c.phone)
    .filter((c) => !q || [c.name, c.phone].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)));

  // Phân trang danh sách khách: 6/trang
  const PAGE_SIZE = 6;
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (gvPage > totalPages) gvPage = totalPages;
  if (gvPage < 1) gvPage = 1;
  const pageList = list.slice((gvPage - 1) * PAGE_SIZE, gvPage * PAGE_SIZE);

  box.innerHTML =
    pageList
      .map(
        (c) => `<label class="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-earth/10">
        <input type="checkbox" value="${c.phone}" ${gvSelected.has(c.phone) ? "checked" : ""} class="accent-[#7a0c1f]" />
        <span class="font-medium text-ink">${c.name || "Khách nomnom"}</span>
        <span class="text-xs text-ash">${c.phone}</span>
      </label>`
      )
      .join("") || `<p class="px-2 py-1 text-sm text-ash">Không tìm thấy khách.</p>`;

  const pagerEl = document.getElementById("gv-pager");
  if (pagerEl) {
    pagerEl.innerHTML = pagerHtml(gvPage, totalPages, "data-gv-page");
    pagerEl.querySelectorAll("[data-gv-page]").forEach((btn) =>
      btn.addEventListener("click", () => {
        gvPage = Number(btn.dataset.gvPage);
        renderVoucherList();
      })
    );
  }
  box.querySelectorAll('input[type="checkbox"]').forEach((cb) =>
    cb.addEventListener("change", () => {
      if (cb.checked) gvSelected.add(cb.value);
      else gvSelected.delete(cb.value);
      gvResetConfirm();
      updateGvSelectedCount();
    })
  );
  updateGvSelectedCount();
}

function updateGvSelectedCount() {
  const el = document.getElementById("gv-selected-count");
  if (el) el.textContent = gvSelected.size;
  // Đồng bộ ô "Chọn tất cả": tick khi chọn hết, gạch ngang (indeterminate) khi chọn 1 phần
  const total = customers.filter((c) => c.phone).length;
  const selectAll = document.getElementById("gv-select-all");
  if (selectAll) {
    selectAll.checked = total > 0 && gvSelected.size >= total;
    selectAll.indeterminate = gvSelected.size > 0 && gvSelected.size < total;
  }
}

// Nút "Tặng ↗" ở bảng khách → chuyển panel sang "chọn khách", tick khách đó, kéo lên panel.
function selectCustomerForVoucher(phone) {
  // "Tặng ↗" từ bảng khách → chỉ gửi cho đúng khách này: bỏ chọn tất cả, chỉ chọn khách đó.
  gvInitialized = true;
  gvSelected = new Set([phone]);
  const search = document.getElementById("gv-search");
  if (search) search.value = "";
  gvPage = 1;
  gvResetConfirm();
  renderVoucherList();
  const pct = document.getElementById("gv-percent");
  pct?.scrollIntoView({ behavior: "smooth", block: "center" });
  pct?.focus();
}

async function sendVouchers() {
  const msg = document.getElementById("gv-msg");
  const setMsg = (t, err) => { if (msg) { msg.textContent = t; msg.style.color = err ? "#b91c1c" : ""; } };
  const percent = readNum(document.getElementById("gv-percent"));
  const daysRaw = String(document.getElementById("gv-days").value || "").replace(/\D/g, "");
  const days = daysRaw ? parseInt(daysRaw, 10) : null;
  if (!percent || percent < 1 || percent > 100) { setMsg("Nhập mức giảm 1–100%.", true); return; }

  const phones = [...gvSelected];
  if (!phones.length) { setMsg("Chưa chọn khách nào để gửi (tích ít nhất 1 khách).", true); return; }

  // Xác nhận 2 bước inline (không dùng confirm() native)
  if (!gvPendingConfirm) {
    gvPendingConfirm = true;
    setMsg(`Sẽ tạo voucher −${percent}% cho ${phones.length} khách. Bấm "Tạo & gửi" lần nữa để xác nhận.`, false);
    return;
  }
  gvPendingConfirm = false;

  const { data, error } = await supabase.rpc("admin_create_vouchers_bulk", { p_phones: phones, p_percent: percent, p_days: days });
  if (error) { setMsg("Lỗi: " + error.message, true); showToast("Lỗi tạo voucher: " + error.message); return; }
  const n = data ?? phones.length;
  setMsg(`✓ Đã gửi ${n} voucher −${percent}%.`, false);
  showToast(`Đã gửi voucher −${percent}% cho ${n} khách.`);
  gvSelected.clear();
  document.getElementById("gv-percent").value = "";
  document.getElementById("gv-days").value = "";
  renderVoucherList();
}

document.getElementById("gv-select-all")?.addEventListener("change", (e) => {
  gvInitialized = true;
  gvResetConfirm();
  gvSelected = e.target.checked
    ? new Set(customers.filter((c) => c.phone).map((c) => c.phone))
    : new Set();
  renderVoucherList();
});
document.getElementById("gv-search")?.addEventListener("input", () => {
  gvPage = 1;
  renderVoucherList();
});
document.getElementById("gv-percent")?.addEventListener("input", gvResetConfirm);
document.getElementById("gv-days")?.addEventListener("input", gvResetConfirm);
document.getElementById("gv-send")?.addEventListener("click", sendVouchers);

function renderTraffic() {
  const state = document.getElementById("traffic-state");
  const trafficUniqueEl = document.getElementById("traffic-unique");
  const trafficPageviewsEl = document.getElementById("traffic-pageviews");
  const trafficConversionEl = document.getElementById("traffic-conversion");

  if (!trafficReady) {
    if (trafficUniqueEl) trafficUniqueEl.textContent = "--";
    if (trafficPageviewsEl) trafficPageviewsEl.textContent = "--";
    if (trafficConversionEl) trafficConversionEl.textContent = "--";
    if (state) {
      state.innerHTML = `
        <div class="admin-empty text-left">
          <p class="font-semibold text-ink">Chưa có bảng analytics_events hoặc chưa cấp quyền đọc.</p>
          <p class="mt-2 text-sm leading-relaxed text-ash">
            Khi bật tracking, storefront sẽ ghi page_view vào Supabase với visitor_id, session_id, path và created_at.
            Admin shell này đã sẵn sàng để đọc và tính unique visitors, page views and conversion hôm nay.
          </p>
        </div>
      `;
    }
    return;
  }

  const stats = trafficStats();
  const paidToday = ordersToday().filter(paidLike).length;
  const conversion =
    stats.uniqueVisitors > 0 ? `${Math.round((paidToday / stats.uniqueVisitors) * 100)}%` : "0%";

  if (trafficUniqueEl) trafficUniqueEl.textContent = stats.uniqueVisitors;
  if (trafficPageviewsEl) trafficPageviewsEl.textContent = stats.pageViews;
  if (trafficConversionEl) trafficConversionEl.textContent = conversion;

  const topPaths = trafficEvents.reduce((acc, event) => {
    const path = event.path || "/";
    acc.set(path, (acc.get(path) || 0) + 1);
    return acc;
  }, new Map());

  if (state) {
    state.innerHTML = `
      <div class="overflow-x-auto">
        <table class="admin-table" style="min-width:0">
          <thead>
            <tr><th>Đường dẫn</th><th>Lượt xem</th></tr>
          </thead>
          <tbody>
            ${[...topPaths.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([path, count]) => `<tr><td>${path}</td><td class="font-semibold text-ink">${count}</td></tr>`)
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }
}

function startRealtime() {
  stopRealtime();
  realtimeChannel = supabase
    .channel("admin-orders-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, (payload) => {
      if (payload.eventType === "INSERT") notifyNewOrder(payload.new);
      loadBackoffice({ skipTraffic: true });
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "customers" }, () => loadBackoffice({ skipTraffic: true }))
    .subscribe();

  // Kênh riêng cho tin nhắn — tách khỏi kênh đơn hàng để realtime của chat ổn định,
  // không phụ thuộc vào việc gộp nhiều bảng trong cùng 1 kênh.
  chatRealtimeChannel = supabase
    .channel("admin-chat-changes")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (payload) => handleIncomingChat(payload.new))
    .subscribe();

  loadConversations();
  startPresence();
}

// ── Trạng thái online/offline của khách (Supabase Realtime Presence) — shop tự
// track dưới key "shop", mọi key khác trong kênh chính là conversation_id của
// khách đang mở web. Không cần bảng riêng cho phần "đang online".

function startPresence() {
  stopPresence();
  adminPresenceChannel = joinPresence("shop", (state) => {
    onlineConversationIds = new Set(Object.keys(state).filter((key) => key !== "shop"));
    if (activeRoute !== "messages") return;
    renderConversations();
    const subtitleEl = document.getElementById("chat-thread-subtitle");
    if (subtitleEl && activeConversationId) {
      const online = onlineConversationIds.has(activeConversationId);
      subtitleEl.textContent = onlineStatusText(activeConversationId) || "Khách chưa từng online";
      subtitleEl.className = online ? "text-sm font-medium text-[#34C759]" : "admin-panel-subtitle";
    }
  });
  adminPresenceHeartbeatTimer = startHeartbeatLoop(() => "shop");
}

function stopPresence() {
  if (adminPresenceChannel) {
    supabase.removeChannel(adminPresenceChannel);
    adminPresenceChannel = null;
  }
  if (adminPresenceHeartbeatTimer) {
    clearInterval(adminPresenceHeartbeatTimer);
    adminPresenceHeartbeatTimer = null;
  }
}

// ── Thông báo trình duyệt khi có đơn mới (cần tab admin còn mở) ──
// Bản nhẹ tạm thời dùng Notification API trực tiếp, chưa cần Service Worker/VAPID.
// Khi nào deploy thành app thật (cài lên iOS) thì nâng cấp lên Web Push để nhận được
// cả khi đóng hẳn trình duyệt.

function updateNotifyButton() {
  const btn = document.getElementById("admin-enable-notify");
  if (!btn) return;
  if (!("Notification" in window) || Notification.permission === "granted") {
    btn.classList.add("hidden");
    return;
  }
  btn.classList.remove("hidden");
  const bellIcon = `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>`;
  const bellOffIcon = `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/></svg>`;
  if (Notification.permission === "denied") {
    btn.innerHTML = `${bellOffIcon}<span class="hidden sm:inline">Trình duyệt đang chặn thông báo</span>`;
    btn.disabled = true;
  } else {
    btn.innerHTML = `${bellIcon}<span class="hidden sm:inline">Bật thông báo đơn mới</span>`;
    btn.disabled = false;
  }
}

// ── Theme switcher 3 nấc (Morning/Noon/Dark) — cross-fade qua View Transitions ──
(() => {
  const tt = document.getElementById("admin-theme-toggle");
  if (!tt) return;
  const THEMES = ["morning", "noon", "dark"];
  const apply = (theme) => {
    document.body.setAttribute("data-theme", THEMES.includes(theme) ? theme : "morning");
  };
  apply(localStorage.getItem("nn-admin-theme") || "morning");
  tt.querySelectorAll("[data-set-theme]").forEach((seg) => {
    seg.addEventListener("click", () => {
      const theme = seg.getAttribute("data-set-theme");
      const commit = () => {
        apply(theme);
        localStorage.setItem("nn-admin-theme", theme);
      };
      if (document.startViewTransition) document.startViewTransition(commit);
      else commit();
    });
  });
})();

document.getElementById("admin-enable-notify")?.addEventListener("click", () => {
  if (!("Notification" in window)) return;
  Notification.requestPermission().then(updateNotifyButton);
});

function notifyNewOrder(order) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification("🛎️ Đơn hàng mới — nomnom", {
      body: `${order.order_code} · ${formatCurrency(order.total)}`,
      tag: order.order_code,
    });
    n.onclick = () => {
      window.focus();
      navigate("orders");
      n.close();
    };
  } catch (e) {
    // một số trình duyệt di động không hỗ trợ new Notification() ngoài Service Worker — bỏ qua
  }
}

function stopRealtime() {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  if (chatRealtimeChannel) {
    supabase.removeChannel(chatRealtimeChannel);
    chatRealtimeChannel = null;
  }
  stopPresence();
}

// ── Tin nhắn (chat trực tiếp với khách) ──

const CHAT_CUSTOMER_AVATAR_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>`;

let threadChannel = null;
let threadIdleTimer = null;
let threadTypingHideTimer = null;
let threadTypingSendThrottle = null;

function updateMessagesBadge() {
  const total = chatConversations.reduce((sum, c) => sum + c.unread, 0);
  const badge = document.getElementById("nav-messages-count");
  if (!badge) return;
  badge.textContent = total;
  badge.classList.toggle("hidden", total === 0);
}

async function loadConversations() {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) {
    // Trước đây nuốt lỗi im lặng nên Tin nhắn cứ trống mà không rõ lý do.
    showToast(`Lỗi tải tin nhắn: ${error.message}`);
    const box = document.getElementById("chat-conversations");
    if (box) box.innerHTML = `<div class="admin-empty">Lỗi tải tin nhắn: ${escapeHtml(error.message)}</div>`;
    return;
  }

  const map = new Map();
  (data || []).forEach((m) => {
    let conv = map.get(m.conversation_id);
    if (!conv) {
      conv = {
        conversationId: m.conversation_id,
        customerName: m.sender === "customer" ? m.customer_name : null,
        lastMessage: m.message,
        lastTime: m.created_at,
        unread: 0,
      };
      map.set(m.conversation_id, conv);
    } else if (!conv.customerName && m.sender === "customer") {
      conv.customerName = m.customer_name;
    }
    if (m.sender === "customer" && !m.read_by_admin) conv.unread++;
  });

  chatConversations = [...map.values()].sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
  saveCache();
  updateMessagesBadge();
  if (activeRoute === "messages") renderConversations();

  lastSeenMap = await fetchAllLastSeen();
  if (activeRoute === "messages") renderConversations();
}

function onlineStatusText(conversationId) {
  if (onlineConversationIds.has(conversationId)) return "Đang online";
  const lastSeen = lastSeenMap.get(conversationId);
  return lastSeen ? timeAgo(lastSeen) : "";
}

function renderConversations() {
  const box = document.getElementById("chat-conversations");
  if (!box) return;
  if (!chatConversations.length) {
    box.innerHTML = `<div class="admin-empty">Chưa có tin nhắn nào.</div>`;
    return;
  }
  box.innerHTML = chatConversations
    .map((c) => {
      const online = onlineConversationIds.has(c.conversationId);
      const statusText = onlineStatusText(c.conversationId);
      return `
      <button type="button" data-conversation="${c.conversationId}"
        class="admin-conv-item flex w-full items-start gap-3 px-3 py-2.5 text-left${c.conversationId === activeConversationId ? " is-active" : ""}">
        ${avatarHtml(c.customerName || c.conversationId, online)}
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-2">
            <span class="truncate text-sm font-semibold text-ink">${escapeHtml(c.customerName || c.conversationId)}</span>
            ${c.unread > 0 ? `<span class="shrink-0 rounded-full bg-[#7a0c1f] px-1.5 py-0.5 text-[10px] font-medium text-white">${c.unread}</span>` : ""}
          </div>
          <p class="mt-1 truncate text-xs text-ash">${escapeHtml(c.lastMessage || "")}</p>
          <p class="mt-0.5 text-[10px] ${online ? "font-medium text-[#34C759]" : "text-ash/70"}">${statusText || formatDateTime(c.lastTime)}</p>
        </div>
      </button>
    `;
    })
    .join("");

  box.querySelectorAll("[data-conversation]").forEach((btn) =>
    btn.addEventListener("click", () => openThread(btn.dataset.conversation))
  );
}

async function openThread(conversationId) {
  activeConversationId = conversationId;
  renderConversations();

  const titleEl = document.getElementById("chat-thread-title");
  const subtitleEl = document.getElementById("chat-thread-subtitle");
  const conv = chatConversations.find((c) => c.conversationId === conversationId);
  if (titleEl) titleEl.textContent = (conv && conv.customerName) || conversationId;
  if (subtitleEl) {
    const online = onlineConversationIds.has(conversationId);
    subtitleEl.textContent = onlineStatusText(conversationId) || "Khách chưa từng online";
    subtitleEl.className = online ? "text-sm font-medium text-[#34C759]" : "admin-panel-subtitle";
  }

  const threadBox = document.getElementById("chat-thread-messages");
  threadBox.innerHTML = `<div class="space-y-2">${chatThreadSkeletonHtml()}</div>`;
  document.getElementById("chat-reply-form").classList.remove("hidden");
  document.getElementById("chat-reply-form").classList.add("flex");

  startThreadTypingChannel(conversationId);

  const { data, error } = await supabase
    .from("chat_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(300);

  if (error) {
    threadBox.innerHTML = `<p class="py-6 text-center text-xs text-red-600">Lỗi: ${error.message}</p>`;
    return;
  }

  renderThread(data || []);

  // Đánh dấu đã đọc các tin chưa đọc của khách trong hội thoại này
  await supabase
    .from("chat_messages")
    .update({ read_by_admin: true })
    .eq("conversation_id", conversationId)
    .eq("sender", "customer")
    .eq("read_by_admin", false);

  if (conv) conv.unread = 0;
  updateMessagesBadge();
  renderConversations();
}

// Kênh riêng cho từng hội thoại, chỉ dùng để gửi/nhận tín hiệu "đang gõ" (broadcast,
// không lưu DB) — kênh chung admin-orders-changes chỉ nhận tin nhắn đã lưu, không đủ
// cho việc này vì broadcast cần cả 2 bên cùng đăng ký đúng tên kênh "chat-<id>".
function startThreadTypingChannel(conversationId) {
  if (threadChannel) {
    supabase.removeChannel(threadChannel);
    threadChannel = null;
  }
  threadChannel = supabase
    .channel(`chat-${conversationId}`)
    .on("broadcast", { event: "typing" }, (payload) => {
      if (payload.payload?.sender === "customer" && activeConversationId === conversationId) {
        showCustomerTypingIndicator();
      }
    })
    .subscribe();
}

function setThreadStatusRow(html) {
  const row = document.getElementById("chat-thread-status-row");
  if (row) row.innerHTML = html;
  const threadBox = document.getElementById("chat-thread-messages");
  if (threadBox) threadBox.scrollTop = threadBox.scrollHeight;
}

function scheduleThreadIdleTimestamp(lastMessage) {
  clearTimeout(threadIdleTimer);
  setThreadStatusRow("");
  if (!lastMessage) return;
  threadIdleTimer = setTimeout(() => {
    setThreadStatusRow(`<p class="px-1 pt-1 text-center text-[10px] text-ash">${formatDateTime(lastMessage.created_at)}</p>`);
  }, 15000);
}

function showCustomerTypingIndicator() {
  clearTimeout(threadIdleTimer);
  clearTimeout(threadTypingHideTimer);
  setThreadStatusRow(`
    <div class="flex items-end justify-start gap-2">
      <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-earth/40 text-ash">${CHAT_CUSTOMER_AVATAR_SVG}</div>
      <div class="flex items-center gap-1 rounded-2xl border border-earth/40 bg-white px-3 py-2.5">
        <span class="chat-typing-dot"></span><span class="chat-typing-dot"></span><span class="chat-typing-dot"></span>
      </div>
    </div>
  `);
  threadTypingHideTimer = setTimeout(() => {
    const threadMessages = document.getElementById("chat-thread-messages");
    scheduleThreadIdleTimestamp(threadMessages?._lastMessage);
  }, 3000);
}

function renderThread(messages) {
  const threadBox = document.getElementById("chat-thread-messages");
  if (!messages.length) {
    threadBox.innerHTML = `<p class="py-6 text-center text-xs text-ash">Chưa có tin nhắn.</p>`;
  } else {
    threadBox.innerHTML = messages.map((m) => chatBubbleHtml(m, m.sender === "shop")).join("");
  }
  threadBox.insertAdjacentHTML("beforeend", `<div id="chat-thread-status-row" class="mt-1"></div>`);
  threadBox._lastMessage = messages[messages.length - 1];
  threadBox.scrollTop = threadBox.scrollHeight;
  scheduleThreadIdleTimestamp(threadBox._lastMessage);
}

function appendThreadMessage(message) {
  const threadBox = document.getElementById("chat-thread-messages");
  if (!threadBox) return;
  const statusRow = document.getElementById("chat-thread-status-row");
  if (statusRow) statusRow.remove();
  threadBox.insertAdjacentHTML("beforeend", chatBubbleHtml(message, message.sender === "shop"));
  threadBox.insertAdjacentHTML("beforeend", `<div id="chat-thread-status-row" class="mt-1"></div>`);
  threadBox._lastMessage = message;
  threadBox.scrollTop = threadBox.scrollHeight;
  scheduleThreadIdleTimestamp(message);
}

document.getElementById("chat-reply-input")?.addEventListener("input", () => {
  if (!threadChannel || threadTypingSendThrottle) return;
  threadChannel.send({ type: "broadcast", event: "typing", payload: { sender: "shop" } });
  threadTypingSendThrottle = setTimeout(() => { threadTypingSendThrottle = null; }, 2000);
});

document.getElementById("chat-reply-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeConversationId) return;
  const input = document.getElementById("chat-reply-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  const { error } = await supabase.from("chat_messages").insert({
    conversation_id: activeConversationId,
    customer_name: "nomnom",
    sender: "shop",
    message: text,
  });
  if (error) showToast(`Lỗi gửi tin nhắn: ${error.message}`);
});

function handleIncomingChat(message) {
  let conv = chatConversations.find((c) => c.conversationId === message.conversation_id);
  if (!conv) {
    conv = { conversationId: message.conversation_id, customerName: null, lastMessage: "", lastTime: message.created_at, unread: 0 };
    chatConversations.unshift(conv);
  }
  if (message.sender === "customer") conv.customerName = message.customer_name;
  conv.lastMessage = message.message;
  conv.lastTime = message.created_at;

  if (activeConversationId === message.conversation_id) {
    appendThreadMessage(message);
    if (message.sender === "customer") {
      supabase.from("chat_messages").update({ read_by_admin: true }).eq("id", message.id).then(() => {});
    }
  } else if (message.sender === "customer") {
    conv.unread++;
  }

  chatConversations.sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
  updateMessagesBadge();
  if (activeRoute === "messages") renderConversations();
}

// Chỉ đăng ký 1 listener duy nhất — onAuthStateChange tự bắn ngay 1 lần với phiên
// hiện tại lúc khởi tạo (INITIAL_SESSION) nên không cần gọi thêm getSession() riêng.
// Gọi cả 2 cùng lúc từng khiến loadBackoffice() chạy chồng 2 lần ngay khi vừa load
// trang, gây treo (deadlock) bên trong thư viện Supabase khi giải quyết phiên đăng nhập.
supabase.auth.onAuthStateChange(async (_event, session) => {
  setAuthView(session);
  if (session) {
    // Hiện ngay dữ liệu cũ trong máy (nếu có) để không phải nhìn màn hình chờ.
    // QUAN TRỌNG: phải đợi loadBackoffice() xong HẲN rồi mới gọi startRealtime()
    // (nó tự gọi thêm loadConversations() + mở 2 kênh realtime) — gọi chồng nhiều
    // lệnh Supabase cùng lúc ngay lúc vừa đăng nhập từng gây treo (deadlock).
    const hasCache = hydrateFromCache();
    navigate(window.location.hash.replace("#", "") || "overview");
    if (hasCache) {
      renderAll();
      updateMessagesBadge();
    }
    await loadBackoffice();
    startRealtime();
    updateNotifyButton();
  } else {
    stopRealtime();
  }
});