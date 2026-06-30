import "./style.css";
import "./admin.css";
import { supabase } from "./supabase.js";

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

const ROUTES = {
  overview: "Tổng quan bán hàng",
  orders: "Đơn Hàng",
  customers: "Khách hàng",
  traffic: "Traffic",
};

const STATUS = {
  pending: { label: "Chờ thanh toán", tone: "amber" },
  paid: { label: "Đã thanh toán", tone: "green" },
  delivered: { label: "Đã giao", tone: "ash" },
  cancelled: { label: "Đã hủy", tone: "red" },
};

const formatCurrency = (value) =>
  new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));

const formatDateTime = (value) =>
  value
    ? new Intl.DateTimeFormat("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "2-digit",
      }).format(new Date(value))
    : "--";

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

async function loadBackoffice() {
  if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY) {
    console.error("❌ LỖI: Thiếu cấu hình VITE_SUPABASE_URL hoặc VITE_SUPABASE_ANON_KEY trên Vercel.");
    return;
  }

  try {
    const [{ data: orderData, error: orderError }, { data: customerData, error: customerError }] =
      await Promise.all([
        supabase.from("orders").select("*").order("created_at", { ascending: false }).limit(250),
        supabase.from("customers").select("*").order("created_at", { ascending: false }).limit(250),
      ]);
      
    console.log("=== DỮ LIỆU ĐƠN HÀNG LẤY TỪ SUPABASE ===");
    console.log("Mảng dữ liệu:", orderData);
    
    if (orderError) showToast(`Lỗi đơn hàng: ${orderError.message}`);
    if (customerError) showToast(`Lỗi khách hàng: ${customerError.message}`);

    orders = orderData || [];
    customers = customerData || [];
    await loadTraffic();
    renderAll();
  } catch (catchErr) {
    console.error("Lỗi kết nối:", catchErr);
  }
}

async function loadTraffic() {
  try {
    const { start, end } = todayRange();
    const { data, error = null } = await supabase
      .from("analytics_events")
      .select("*")
      .gte("created_at", start.toISOString())
      .lt("created_at", end.toISOString())
      .order("created_at", { ascending: false })
      .limit(1000);
    trafficReady = !error;
    trafficEvents = data || [];
  } catch (e) {
    trafficReady = false;
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
  const status = document.getElementById("orders-status-filter")?.value || "active";
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
    const items = Array.isArray(order.items) ? order.items.map(i => `${i.name} x${i.qty}`).join("; ") : "";
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
                  <span class="line-clamp-2 text-sm text-ink">${items.map((item) => `${item.name} x${item.qty}`).join(", ") || "--"}</span>
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

  const { error } = await supabase.from("orders").update({ status }).eq("id", id);
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

supabase.auth.onAuthStateChange(async (_event, session) => {
  setAuthView(session);
  if (session) {
    await loadBackoffice();
    navigate(window.location.hash.replace("#", "") || "overview");
  }
});

supabase.auth.getSession().then(({ data }) => {
  setAuthView(data.session);
  if (data.session) {
    loadBackoffice().then(() => navigate(window.location.hash.replace("#", "") || "overview"));
  }
});