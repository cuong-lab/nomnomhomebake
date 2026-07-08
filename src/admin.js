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

async function loadBackoffice() {
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

  // Nếu chưa có gì để hiện (kể cả cache rỗng), báo cho cô chủ biết là đang tải.
  if (!orders.length) {
    const ordersTableEl = document.getElementById("orders-table");
    if (ordersTableEl) {
      ordersTableEl.innerHTML = `
        <div class="admin-empty">nomnom đang tải dữ liệu, đừng vội nhé, không nhanh hơn được đâu 🧁</div>
        <div class="mt-4 space-y-2">
          <div class="skeleton h-12 w-full rounded"></div>
          <div class="skeleton h-12 w-full rounded"></div>
          <div class="skeleton h-12 w-full rounded"></div>
          <div class="skeleton h-12 w-full rounded"></div>
        </div>`;
    }
  }

  const timeoutAfter = (ms) =>
    new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT sau ${ms / 1000}s`)), ms));

  try {
    const { start, end } = todayRange();
    const [
      { data: orderData, error: orderError },
      { data: customerData, error: customerError },
      { data: trafficData, error: trafficError },
    ] = await Promise.race([
      Promise.all([
        supabase.from("orders").select("*").order("created_at", { ascending: false }).limit(250),
        supabase.from("customers").select("*").order("created_at", { ascending: false }).limit(250),
        supabase
          .from("analytics_events")
          .select("*")
          .gte("created_at", start.toISOString())
          .lt("created_at", end.toISOString())
          .order("created_at", { ascending: false })
          .limit(1000),
      ]),
      timeoutAfter(10000),
    ]);

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
    trafficReady = !trafficError;
    trafficEvents = trafficData || [];
    saveCache();
    renderAll();
  } catch (catchErr) {
    console.error("Lỗi kết nối:", catchErr);
    showToast(catchErr?.message || "Lỗi kết nối tới Supabase");
  } finally {
    isLoadingBackoffice = false;
  }
}

function renderAll() {
  renderMetrics();
  renderOverview();
  renderOrders();
  renderCustomers();
  renderTraffic();
}

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
    <div class="flex items-center justify-between border border-earth/40 bg-white/50 px-4 py-3">
      <span class="text-sm text-ash">${label}</span>
      <span class="font-serif text-xl text-ink">${value}</span>
    </div>
  `;
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

function renderOrders() {
  const list = getFilteredOrders();
  const ordersTableEl = document.getElementById("orders-table");
  if (ordersTableEl) ordersTableEl.innerHTML = renderOrderTable(list);
}

document.getElementById("orders-search")?.addEventListener("input", renderOrders);
document.getElementById("orders-status-filter")?.addEventListener("change", renderOrders);
document.getElementById("orders-date-start")?.addEventListener("change", renderOrders);
document.getElementById("orders-date-end")?.addEventListener("change", renderOrders);

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
    <table class="admin-table">
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
          </tr>
        </thead>
        <tbody>
          ${list
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
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    `;
  }
}

document.getElementById("customers-search")?.addEventListener("input", renderCustomers);

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
        <table class="admin-table">
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
      loadBackoffice();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "customers" }, () => loadBackoffice())
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
  if (Notification.permission === "denied") {
    btn.textContent = "🔕 Trình duyệt đang chặn thông báo";
    btn.disabled = true;
  } else {
    btn.textContent = "🔔 Bật thông báo đơn mới";
    btn.disabled = false;
  }
}

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
        class="flex w-full items-start gap-3 border px-3 py-2.5 text-left transition-colors ${c.conversationId === activeConversationId ? "border-ink bg-earth/10" : "border-earth/40 bg-white hover:border-ink"}">
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