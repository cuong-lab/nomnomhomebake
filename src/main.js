import "./style.css";
import { supabase } from "./supabase.js";
import { formatCurrency, formatDateTime, escapeHtml, timeAgo } from "./shared/format.js";
import { ORDER_STATUS, updateOrderStatus } from "./shared/orderStatus.js";
import { joinPresence, startHeartbeatLoop, fetchLastSeen, fetchAllLastSeen } from "./shared/presence.js";
import { avatarHtml, chatBubbleHtml, chatThreadSkeletonHtml } from "./shared/chatUi.js";
import { compressImage } from "./shared/imageUtils.js";

const yearEl = document.querySelector("[data-year]");
if (yearEl) yearEl.textContent = new Date().getFullYear();

let isAdmin = false;
let cart = JSON.parse(localStorage.getItem("nomnom-cart") || "[]");
let currentCustomer = JSON.parse(localStorage.getItem("nomnom_customer") || "null");
let rewardConfig = { cycle: 10, percent: 20 };
let appliedVoucherPercent = 0;
let freeShipThreshold = 0;

function saveCart() {
  localStorage.setItem("nomnom-cart", JSON.stringify(cart));
  updateCartCount();
  if (currentCustomer) pushCartToAccount(currentCustomer.phone);
}

function updateCartCount() {
  const total = cart.reduce((sum, item) => sum + item.qty, 0);
  document.getElementById("cart-count").textContent = `Giỏ hàng (${total})`;
  document.getElementById("cart-count-mobile").textContent = total;
  const fc = document.getElementById("floating-cart-count");
  if (fc) fc.textContent = total;
  const fb = document.getElementById("floating-cart");
  if (fb) {
    const show = window.scrollY > 200 && total > 0 && !isAdmin;
    fb.classList.toggle("hidden", !show);
    fb.classList.toggle("flex", show);
  }
}

function addToCart(product) {
  const existing = cart.find((item) => item.id === product.id);
  if (existing) {
    existing.qty++;
  } else {
    cart.push({
      id: product.id,
      name: product.name,
      price: product.sale_price || product.price,
      image_url: product.image_url,
      qty: 1,
      note: "",
    });
  }
  saveCart();
  shakeCart();
  showToast(`Đã thêm “${product.name}” vào giỏ`);
}

// Tự tính Mở/Đóng cửa từ chuỗi giờ mở cửa (lấy 2 mốc giờ đầu tiên)
function updateOpenStatus(hoursStr) {
  const el = document.getElementById("open-status");
  if (!el) return;
  const times = (hoursStr || "").match(/(\d{1,2})[:h](\d{2})/g);
  if (!times || times.length < 2) {
    el.classList.add("hidden");
    el.classList.remove("inline-flex");
    return;
  }
  const toMin = (t) => {
    const [h, m] = t.split(/[:h]/).map(Number);
    return h * 60 + m;
  };
  const open = toMin(times[0]);
  const close = toMin(times[1]);
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const isOpen = close > open ? cur >= open && cur < close : cur >= open || cur < close;

  el.classList.remove("hidden");
  el.classList.add("inline-flex");
  if (isOpen) {
    el.innerHTML = `<span class="h-1.5 w-1.5 rounded-full bg-[#34C759]"></span>Đang mở cửa`;
    el.className = "open-status inline-flex items-center gap-1.5 rounded-full bg-[#34C759]/15 px-2.5 py-1 text-[11px] font-medium text-[#1d8a3e]";
  } else {
    el.innerHTML = `<span class="h-1.5 w-1.5 rounded-full bg-ash"></span>Đã đóng cửa`;
    el.className = "open-status inline-flex items-center gap-1.5 rounded-full bg-ash/15 px-2.5 py-1 text-[11px] font-medium text-ash";
  }
}

let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1900);
}

// lắc nhẹ icon giỏ hàng ~1s mỗi khi thêm món
function shakeCart() {
  ["cart-btn", "floating-cart"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("cart-shake");
    void el.offsetWidth; // reset animation để lắc lại được nếu bấm liên tục
    el.classList.add("cart-shake");
    setTimeout(() => el.classList.remove("cart-shake"), 1000);
  });
}

// ── Cart Drawer ──

const cartDrawer = document.getElementById("cart-drawer");
const cartOverlay = document.getElementById("cart-overlay");
const cartItems = document.getElementById("cart-items");
const cartFooter = document.getElementById("cart-footer");
const cartTotal = document.getElementById("cart-total");
const cartCheckout = document.getElementById("cart-checkout");

document.getElementById("cart-btn").addEventListener("click", openCart);
document.getElementById("cart-close").addEventListener("click", closeCart);
cartOverlay.addEventListener("click", closeCart);

const floatingCart = document.getElementById("floating-cart");
floatingCart.addEventListener("click", openCart);
window.addEventListener("scroll", () => {
  const show = window.scrollY > 200 && cart.length > 0 && !isAdmin;
  floatingCart.classList.toggle("hidden", !show);
  floatingCart.classList.toggle("flex", show);
}, { passive: true });

function openCart() {
  cartDrawer.classList.add("cart-open");
  cartOverlay.classList.remove("hidden");
  document.getElementById("cart-qr").classList.add("hidden");
  document.getElementById("cart-success").classList.add("hidden");
  document.getElementById("cart-customer").classList.add("hidden");
  cartItems.classList.remove("hidden");
  renderCart();
}

function closeCart() {
  cartDrawer.classList.remove("cart-open");
  cartOverlay.classList.add("hidden");
  cancelPendingOrder();
}

function renderCart() {
  if (!cart.length) {
    cartItems.innerHTML = `<p class="text-center text-sm text-ash py-12">Giỏ hàng trống.</p>`;
    cartFooter.classList.add("hidden");
    return;
  }

  cartItems.innerHTML = cart
    .map(
      (item) => `
    <div class="flex gap-4 py-3 border-b border-earth/30">
      <div class="h-16 w-16 shrink-0 bg-earth/30 overflow-hidden">
        ${item.image_url ? `<img src="${item.image_url}" alt="${item.name}" class="h-full w-full object-cover" />` : ""}
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-ink truncate">${item.name}</p>
        <p class="text-sm text-ash">${formatPrice(item.price)}</p>
        <div class="mt-1 flex items-center gap-2">
          <button data-cart-minus="${item.id}" class="h-6 w-6 border border-earth/60 text-sm text-ink hover:bg-earth/20">−</button>
          <span class="text-sm text-ink">${item.qty}</span>
          <button data-cart-plus="${item.id}" class="h-6 w-6 border border-earth/60 text-sm text-ink hover:bg-earth/20">+</button>
          <button data-cart-remove="${item.id}" class="ml-auto text-xs text-red-500 hover:text-red-700">Xóa</button>
        </div>
        <input
          data-cart-note="${item.id}"
          type="text"
          value="${(item.note || "").replace(/"/g, "&quot;")}"
          placeholder="Ghi chú cho món này (VD: ít ngọt, không hạt...)"
          class="mt-2 w-full border border-earth/40 bg-white px-2 py-1.5 text-xs text-ink outline-none focus:border-ink"
        />
      </div>
    </div>
  `
    )
    .join("");

  const total = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  cartTotal.textContent = formatPrice(total);
  cartFooter.classList.remove("hidden");
  document.getElementById("cart-qr").classList.add("hidden");

  // Thanh tiến trình freeship
  const fsBar = document.getElementById("freeship-bar");
  if (freeShipThreshold > 0) {
    fsBar.classList.remove("hidden");
    const fsText = document.getElementById("freeship-text");
    const fsFill = document.getElementById("freeship-fill");
    const truckSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="inline-block align-text-bottom"><path d="M5 18H3c-.6 0-1-.4-1-1V7c0-.6.4-1 1-1h10c.6 0 1 .4 1 1v11"/><path d="M14 9h4l4 4v4c0 .6-.4 1-1 1h-2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>`;
    const checkSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="inline-block align-text-bottom"><path d="M20 6 9 17l-5-5"/></svg>`;
    if (total >= freeShipThreshold) {
      fsText.innerHTML = `${checkSvg} Bạn được <b>miễn phí ship</b>!`;
      fsFill.style.width = "100%";
    } else {
      const remain = freeShipThreshold - total;
      fsText.innerHTML = `${truckSvg} Mua thêm <b>${formatPrice(remain)}</b> để được <b>miễn phí ship</b>`;
      fsFill.style.width = `${Math.round((total / freeShipThreshold) * 100)}%`;
    }
  } else {
    fsBar.classList.add("hidden");
  }

  cartItems.querySelectorAll("[data-cart-minus]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const item = cart.find((i) => i.id === btn.dataset.cartMinus);
      if (item) { item.qty = Math.max(1, item.qty - 1); saveCart(); renderCart(); }
    })
  );

  cartItems.querySelectorAll("[data-cart-plus]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const item = cart.find((i) => i.id === btn.dataset.cartPlus);
      if (item) { item.qty++; saveCart(); renderCart(); }
    })
  );

  cartItems.querySelectorAll("[data-cart-remove]").forEach((btn) =>
    btn.addEventListener("click", () => {
      cart = cart.filter((i) => i.id !== btn.dataset.cartRemove);
      saveCart(); renderCart();
    })
  );

  cartItems.querySelectorAll("[data-cart-note]").forEach((input) =>
    input.addEventListener("change", () => {
      const item = cart.find((i) => i.id === input.dataset.cartNote);
      if (item) { item.note = input.value.trim(); saveCart(); }
    })
  );
}

let bankSettings = {};
let chatAutoReply = "";

const cartCustomer = document.getElementById("cart-customer");
const custError = document.getElementById("cust-error");

document.getElementById("cart-checkout-step").addEventListener("click", () => {
  // không cho chọn ngày trong quá khứ
  document.getElementById("cust-date").min = new Date().toISOString().split("T")[0];
  cartItems.classList.add("hidden");
  cartFooter.classList.add("hidden");
  cartCustomer.classList.remove("hidden");

  // Tự điền sẵn thông tin nếu khách đã đăng nhập
  if (currentCustomer) {
    const nameEl = document.getElementById("cust-name");
    const phoneEl = document.getElementById("cust-phone");
    const addrEl = document.getElementById("cust-address");
    if (!nameEl.value) nameEl.value = currentCustomer.name || "";
    if (!phoneEl.value) phoneEl.value = currentCustomer.phone || "";
    if (!addrEl.value) addrEl.value = currentCustomer.address || "";
  }

  setupVoucherUI();
});

function setupVoucherUI() {
  const row = document.getElementById("voucher-row");
  const check = document.getElementById("voucher-check");
  const vouchers = availableVouchers(currentCustomer);
  if (currentCustomer && vouchers > 0) {
    row.classList.remove("hidden");
    row.classList.add("flex");
    document.getElementById("voucher-label").textContent =
      `Dùng ưu đãi giảm ${rewardConfig.percent}% (bạn có ${vouchers})`;
    check.checked = false;
  } else {
    row.classList.add("hidden");
    row.classList.remove("flex");
    check.checked = false;
  }
  renderCheckoutSummary();
}

function renderCheckoutSummary() {
  const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  const check = document.getElementById("voucher-check");
  appliedVoucherPercent = check && check.checked ? rewardConfig.percent : 0;
  const discount = Math.round((subtotal * appliedVoucherPercent) / 100);
  const total = subtotal - discount;

  const summary = document.getElementById("checkout-summary");
  summary.classList.remove("hidden");
  document.getElementById("sum-subtotal").textContent = formatPrice(subtotal);
  document.getElementById("sum-total").textContent = formatPrice(total);
  const dRow = document.getElementById("sum-discount-row");
  if (discount > 0) {
    dRow.classList.remove("hidden");
    dRow.classList.add("flex");
    document.getElementById("sum-discount").textContent = "-" + formatPrice(discount);
  } else {
    dRow.classList.add("hidden");
    dRow.classList.remove("flex");
  }
  return total;
}

document.getElementById("voucher-check").addEventListener("change", renderCheckoutSummary);

function buildDeliveryTime() {
  const d = document.getElementById("cust-date").value; // YYYY-MM-DD
  const t = document.getElementById("cust-time").value; // HH:MM
  if (!d && !t) return "Giao sớm nhất";
  const parts = [];
  if (t) parts.push(t); // giờ đứng trước để app đọc đúng giờ giao
  if (d) {
    const [y, m, day] = d.split("-");
    parts.push(`${day}/${m}/${y}`);
  }
  return parts.join(" ");
}

document.getElementById("cust-back").addEventListener("click", () => {
  cartCustomer.classList.add("hidden");
  cartItems.classList.remove("hidden");
  cartFooter.classList.remove("hidden");
});

cartCheckout.addEventListener("click", async () => {
  const custName = document.getElementById("cust-name").value.trim();
  const custPhone = document.getElementById("cust-phone").value.trim();
  const custAddress = document.getElementById("cust-address").value.trim();
  const custNote = document.getElementById("cust-note").value.trim();

  if (!custName || !custPhone || !custAddress) {
    custError.textContent = "Vui lòng nhập đầy đủ họ tên, SĐT và địa chỉ.";
    custError.classList.remove("hidden");
    return;
  }
  custError.classList.add("hidden");

  if (!bankSettings.bank_id || !bankSettings.bank_account) {
    alert("Chủ shop chưa thiết lập thanh toán. Vui lòng liên hệ qua Zalo.");
    return;
  }

  const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  const voucherPercent = appliedVoucherPercent || 0;
  const total = subtotal - Math.round((subtotal * voucherPercent) / 100);
  const orderCode = "NN" + Date.now().toString().slice(-8);
  lastOrderCode = orderCode;
  const content = `${orderCode} nomnom`;

  const { error: orderErr } = await supabase.from("orders").insert({
    order_code: orderCode,
    items: cart.map((item) => ({ name: item.name, qty: item.qty, price: item.price, note: item.note || undefined })),
    total,
    status: "pending",
    customer_name: custName,
    customer_phone: custPhone,
    customer_address: custAddress,
    delivery_time: buildDeliveryTime(),
    note: custNote || null,
    voucher_percent: voucherPercent,
  });

  if (orderErr) {
    const ce = document.getElementById("cust-error");
    ce.textContent = "Lỗi tạo đơn: " + orderErr.message;
    ce.classList.remove("hidden");
    return;
  }

  pendingOrderActive = true;

  const qrUrl = `https://img.vietqr.io/image/${bankSettings.bank_id}-${bankSettings.bank_account}-compact.jpg?amount=${total}&addInfo=${encodeURIComponent(content)}`;

  document.getElementById("qr-image").src = qrUrl;
  document.getElementById("qr-bank-name").textContent = bankSettings.bank_id;
  document.getElementById("qr-account").textContent = bankSettings.bank_account;
  document.getElementById("qr-holder").textContent = bankSettings.bank_name || "";
  document.getElementById("qr-amount").textContent = formatPrice(total);
  document.getElementById("qr-content").textContent = content;

  const qrZaloHelp = document.getElementById("qr-zalo-help");
  if (bankSettings.zalo_url) {
    qrZaloHelp.href = bankSettings.zalo_url;
    qrZaloHelp.classList.remove("hidden");
  } else {
    qrZaloHelp.classList.add("hidden");
  }

  cartCustomer.classList.add("hidden");
  document.getElementById("cart-qr").classList.remove("hidden");

  startPaymentWatcher();
});

let lastOrderCode = "";
let pendingOrderActive = false;
let paymentChannel = null;

function startPaymentWatcher() {
  stopPaymentWatcher();
  const codeBeingWatched = lastOrderCode;
  paymentChannel = supabase
    .channel(`payment-${codeBeingWatched}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "orders", filter: `order_code=eq.${codeBeingWatched}` },
      (payload) => {
        if (payload.new.status === "paid") {
          stopPaymentWatcher();
          showPaymentSuccess();
        }
      }
    )
    .subscribe();
  document.addEventListener("visibilitychange", checkPaymentOnFocus);
}

function stopPaymentWatcher() {
  if (paymentChannel) {
    supabase.removeChannel(paymentChannel);
    paymentChannel = null;
  }
  document.removeEventListener("visibilitychange", checkPaymentOnFocus);
}

// Lưới an toàn: nếu khách chuyển sang app ngân hàng rồi quay lại tab, trình duyệt
// di động hay tạm dừng kết nối realtime ở nền — kiểm tra lại ngay khi tab active trở lại.
async function checkPaymentOnFocus() {
  if (document.visibilityState !== "visible" || !pendingOrderActive || !lastOrderCode) return;
  const { data } = await supabase.from("orders").select("status").eq("order_code", lastOrderCode).single();
  if (data && data.status === "paid") {
    stopPaymentWatcher();
    showPaymentSuccess();
  }
}

async function cancelPendingOrder() {
  if (!pendingOrderActive || !lastOrderCode) return;
  stopPaymentWatcher();
  const codeToCancel = lastOrderCode;
  pendingOrderActive = false;
  lastOrderCode = "";
  await supabase.from("orders").update({ status: "cancelled" }).eq("order_code", codeToCancel).eq("status", "pending");
}

function showPaymentSuccess() {
  pendingOrderActive = false;
  cart = [];
  saveCart();
  document.getElementById("cart-qr").classList.add("hidden");
  document.getElementById("success-order-code").textContent = lastOrderCode;

  const zaloUrl = bankSettings.zalo_url || "";
  const successZalo = document.getElementById("success-zalo");
  if (zaloUrl) {
    successZalo.href = zaloUrl;
    successZalo.classList.remove("hidden");
  } else {
    successZalo.classList.add("hidden");
  }

  document.getElementById("cart-success").classList.remove("hidden");

  appliedVoucherPercent = 0;
  // cập nhật lại điểm tích lũy sau khi webhook đã cộng (đợi 1.5s cho chắc)
  if (currentCustomer) setTimeout(refreshCustomerData, 1500);
}

document.getElementById("success-close").addEventListener("click", () => {
  closeCart();
});

document.getElementById("qr-back").addEventListener("click", async () => {
  await cancelPendingOrder();
  document.getElementById("cart-qr").classList.add("hidden");
  cartItems.classList.remove("hidden");
  cartFooter.classList.remove("hidden");
  renderCart();
});

const formatPrice = formatCurrency;

// Bản đầy đủ có năm — dùng cho phiếu in bếp và lịch sử mua hàng (khác formatDateTime dùng chung)
function formatDateTimeLong(value) {
  return value
    ? new Date(value).toLocaleString("vi-VN", {
        hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric",
      })
    : "--";
}

// ── Mobile Menu ──

const menuToggle = document.getElementById("menu-toggle");
const mobileMenu = document.getElementById("mobile-menu");

menuToggle.addEventListener("click", () => {
  mobileMenu.classList.toggle("hidden");
});

mobileMenu.querySelectorAll("a").forEach((link) =>
  link.addEventListener("click", () => mobileMenu.classList.add("hidden"))
);

// ── Auth (triple-tap logo) ──

const loginModal = document.getElementById("login-modal");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const logo = document.getElementById("logo");

let tapCount = 0;
let tapTimer = null;

logo.addEventListener("click", (e) => {
  e.preventDefault();
  // Đang là admin: bấm logo chỉ cuộn lên đầu trang, KHÔNG đăng xuất nữa
  // (giữ quyền admin khi vào lại storefront; muốn thoát thì dùng nút "Đăng xuất admin" ở footer).
  if (isAdmin) {
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  // Khách thường: bấm logo 3 lần liên tiếp để mở form đăng nhập admin (cửa vào ẩn).
  tapCount++;
  if (tapCount === 3) {
    tapCount = 0;
    clearTimeout(tapTimer);
    loginModal.classList.remove("hidden");
    loginModal.classList.add("flex");
    return;
  }
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => { tapCount = 0; }, 600);
});

document.getElementById("login-cancel").addEventListener("click", closeLogin);

loginModal.addEventListener("click", (e) => {
  if (e.target === loginModal) closeLogin();
});

function closeLogin() {
  loginModal.classList.add("hidden");
  loginModal.classList.remove("flex");
  loginForm.reset();
  loginError.classList.add("hidden");
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(loginForm);
  const { error } = await supabase.auth.signInWithPassword({
    email: form.get("email"),
    password: form.get("password"),
  });
  if (error) {
    loginError.textContent = "Email hoặc mật khẩu không đúng.";
    loginError.classList.remove("hidden");
    return;
  }
  closeLogin();
});

const adminLogoutBtn = document.getElementById("admin-logout-btn");
const adminNavLink = document.getElementById("admin-nav-link");
const adminMobileNavLink = document.getElementById("admin-mobile-nav-link");

adminLogoutBtn.addEventListener("click", () => {
  supabase.auth.signOut();
});

// Vị trí nav này đổi vai trò theo trạng thái đăng nhập: khách thường thấy "Đánh giá"
// (cuộn xuống #reviews), cô chủ đăng nhập admin thì thấy "Quản lý" (vào /admin.html).
function setAdminNavLink(link, admin) {
  if (!link) return;
  link.textContent = admin ? "Quản lý" : "Đánh giá";
  link.setAttribute("href", admin ? "/admin.html" : "#reviews");
}

supabase.auth.onAuthStateChange((_event, session) => {
  isAdmin = !!session;
  adminLogoutBtn.classList.toggle("hidden", !isAdmin);
  setAdminNavLink(adminNavLink, isAdmin);
  setAdminNavLink(adminMobileNavLink, isAdmin);
  adminOrdersBtn.classList.toggle("hidden", !isAdmin);
  if (isAdmin) {
    startAdminOrdersRealtime();
  } else {
    stopAdminOrdersRealtime();
    closeOrdersDrawer();
    adminOrdersBadge.classList.add("hidden");
  }
  setChatAdminMode(isAdmin);
  loadProducts();
  loadHeroSlides();
  loadBanners();
  loadContactSettings();
  loadReviews();
});

// ── Products ──

let allProducts = [];
let activeCategory = "all";
let activePriceSort = "default";

const categoryTabs = document.getElementById("category-tabs");
const priceFilter = document.getElementById("price-filter");

function renderProductCard(p) {
  return `
    <article class="group relative flex flex-col overflow-hidden rounded-2xl border border-earth/50 bg-cream/70 p-2 shadow-[0_3px_14px_-6px_rgba(10,10,10,0.18)] transition-all duration-300 hover:-translate-y-1 hover:border-earth hover:shadow-[0_16px_30px_-10px_rgba(10,10,10,0.28)] sm:p-3">
      <div data-detail="${p.id}" class="aspect-square overflow-hidden rounded-xl bg-earth/30 cursor-pointer relative">
        ${
          p.image_url
            ? `<img src="${p.image_url}" alt="${p.name}" loading="lazy" decoding="async" class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />`
            : `<div class="flex h-full items-center justify-center"><span class="font-serif text-lg italic text-ash">nomnom</span></div>`
        }
        ${p.badge === "bestseller" ? `<span class="absolute top-2 left-2 bg-[#f39c12] px-2 py-0.5 text-[10px] font-medium text-white rounded-full">Bán chạy</span>` : ""}
        ${p.badge === "new" ? `<span class="absolute top-2 left-2 bg-[#34C759] px-2 py-0.5 text-[10px] font-medium text-white rounded-full">Mới</span>` : ""}
        ${p.badge === "soldout" ? `<span class="absolute top-2 left-2 bg-ink px-2 py-0.5 text-[10px] font-medium text-white rounded-full">Hết hàng</span>` : ""}
      </div>
      <div class="mt-2 sm:mt-3 flex flex-col flex-1 px-1">
        <h3 data-detail="${p.id}" class="font-serif text-xs sm:text-lg text-ink cursor-pointer hover:text-ash transition-colors line-clamp-2">${p.name}</h3>
        ${p.description ? `<p class="mt-0.5 sm:mt-1 text-[10px] sm:text-sm text-ash line-clamp-2">${p.description}</p>` : ""}
        <div class="mt-auto pt-1 sm:pt-2">
          <p class="text-[11px] sm:text-sm font-medium text-ink">
              ${p.sale_price
                ? `<span class="text-ash line-through">${formatPrice(p.price)}</span> <span class="text-red-600">${formatPrice(p.sale_price)}</span>`
                : formatPrice(p.price)
              }
          </p>
          ${p.badge === "soldout"
            ? `<span class="mt-1 sm:mt-2 block text-[10px] sm:text-xs text-ash">Hết hàng</span>`
            : `<button data-add-cart="${p.id}" class="mt-1 sm:mt-2 w-full bg-ink py-1.5 sm:py-2 text-[10px] sm:text-xs font-medium text-white hover:opacity-90 active:scale-95 transition-all">+ Giỏ hàng</button>`
          }
        </div>
      </div>
      ${
        isAdmin
          ? `<div class="mt-3 flex gap-2">
              <button data-edit="${p.id}" class="text-xs text-ash hover:text-ink transition-colors">Sửa</button>
              <button data-delete="${p.id}" class="text-xs text-red-500 hover:text-red-700 transition-colors">Xóa</button>
            </div>`
          : ""
      }
    </article>`;
}

function renderProducts() {
  const container = document.getElementById("product-sections");
  const categories = [...new Set(allProducts.map((p) => p.category).filter(Boolean))];
  const uncategorized = allProducts.filter((p) => !p.category);

  if (!allProducts.length && !isAdmin) {
    container.innerHTML = `<p class="text-center text-sm text-ash py-12">Chưa có sản phẩm nào.</p>`;
    return;
  }

  const addBtn = isAdmin
    ? `<button class="add-product-btn flex aspect-square w-full items-center justify-center rounded-2xl border-2 border-dashed border-earth text-ash hover:border-ink hover:text-ink hover:bg-cream/50 transition-colors cursor-pointer">
        <span class="text-center"><span class="block text-3xl leading-none">+</span><span class="mt-2 block text-sm">Thêm sản phẩm</span></span>
      </button>`
    : "";

  // Mỗi ô (sản phẩm hoặc nút thêm) chiếm đúng 1/3 chiều ngang để luôn hiện 3 ô/hàng;
  // nhiều hơn 3 thì cuộn ngang, có nút ‹ › ở 2 bên.
  const cell = (inner) =>
    `<div class="snap-start shrink-0" style="width:calc((100% - 2rem)/3)">${inner}</div>`;

  const carousel = (cellsHtml, showArrows) => {
    const trackId = `pcar-${Math.random().toString(36).slice(2, 8)}`;
    const arrowBtn = (dir, sym) =>
      `<button data-car-${dir}="${trackId}" aria-label="${dir === "prev" ? "Xem trước" : "Xem tiếp"}"
        class="absolute ${dir === "prev" ? "left-0 -translate-x-1/2" : "right-0 translate-x-1/2"} top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-earth bg-white text-ink shadow-md hover:bg-earth/20 active:scale-95 transition">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="${dir === "prev" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"}"/></svg>
      </button>`;
    return `
      <div class="relative mt-6">
        ${showArrows ? arrowBtn("prev") : ""}
        <div id="${trackId}" class="pcar-track flex gap-4 overflow-x-auto snap-x snap-mandatory scrollbar-hide scroll-smooth">
          ${cellsHtml}
        </div>
        ${showArrows ? arrowBtn("next") : ""}
      </div>`;
  };

  const section = (title, items) => {
    const cells = items.map((p) => cell(renderProductCard(p))).join("") + (isAdmin ? cell(addBtn) : "");
    const total = items.length + (isAdmin ? 1 : 0);
    return `
      <div class="category-section">
        <h3 class="font-serif text-2xl text-ink md:text-3xl">${title}</h3>
        <hr class="mt-3 border-dashed border-earth" />
        ${carousel(cells, total > 3)}
      </div>`;
  };

  let html = "";
  categories.forEach((cat) => {
    html += section(cat, allProducts.filter((p) => p.category === cat));
  });

  if (uncategorized.length) {
    html += section("Khác", uncategorized);
  } else if (isAdmin && !categories.length) {
    html += carousel(cell(addBtn), false);
  }

  container.innerHTML = html;

  // Nút ‹ › cuộn ngang track 1 "trang" (đúng bằng bề rộng đang thấy = 3 ô)
  container.querySelectorAll("[data-car-prev]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const track = document.getElementById(btn.dataset.carPrev);
      if (track) track.scrollBy({ left: -track.clientWidth, behavior: "smooth" });
    })
  );
  container.querySelectorAll("[data-car-next]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const track = document.getElementById(btn.dataset.carNext);
      if (track) track.scrollBy({ left: track.clientWidth, behavior: "smooth" });
    })
  );

  container.querySelectorAll(".add-product-btn").forEach((btn) =>
    btn.addEventListener("click", () => openProductForm())
  );

  container.querySelectorAll("[data-edit]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const product = allProducts.find((p) => p.id === btn.dataset.edit);
      if (product) openProductForm(product);
    })
  );

  container.querySelectorAll("[data-delete]").forEach((btn) =>
    btn.addEventListener("click", () => deleteProduct(btn.dataset.delete))
  );

  container.querySelectorAll("[data-add-cart]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const product = allProducts.find((p) => p.id === btn.dataset.addCart);
      if (product) {
        addToCart(product);
        btn.textContent = "Đã thêm ✓";
        setTimeout(() => { btn.textContent = "+ Giỏ hàng"; }, 1000);
      }
    })
  );

  container.querySelectorAll("[data-detail]").forEach((el) =>
    el.addEventListener("click", () => {
      const product = allProducts.find((p) => p.id === el.dataset.detail);
      if (product) openDetailModal(product);
    })
  );
}

// ── Product Detail Modal (carousel tối đa 3 ảnh) ──

const detailModal = document.getElementById("detail-modal");
const detailTrack = document.getElementById("detail-track");
const detailDots = document.getElementById("detail-dots");
const detailPrev = document.getElementById("detail-prev");
const detailNext = document.getElementById("detail-next");
let detailImages = [];
let detailIndex = 0;

function goDetail(i) {
  detailIndex = ((i % detailImages.length) + detailImages.length) % detailImages.length;
  detailTrack.style.transform = `translateX(-${detailIndex * 100}%)`;
  detailDots.querySelectorAll("button").forEach((d, idx) => {
    d.classList.toggle("bg-ink", idx === detailIndex);
    d.classList.toggle("bg-ink/30", idx !== detailIndex);
  });
}

detailPrev.addEventListener("click", () => goDetail(detailIndex - 1));
detailNext.addEventListener("click", () => goDetail(detailIndex + 1));

// Swipe trên điện thoại
let detailTouchX = null;
detailTrack.addEventListener("touchstart", (e) => { detailTouchX = e.touches[0].clientX; }, { passive: true });
detailTrack.addEventListener("touchend", (e) => {
  if (detailTouchX === null || detailImages.length < 2) return;
  const dx = e.changedTouches[0].clientX - detailTouchX;
  if (dx > 40) goDetail(detailIndex - 1);
  else if (dx < -40) goDetail(detailIndex + 1);
  detailTouchX = null;
});

function openDetailModal(p) {
  detailImages = [p.image_url, p.image_url2, p.image_url3].filter(Boolean);

  if (!detailImages.length) {
    detailTrack.innerHTML = `<div class="flex h-full w-full shrink-0 items-center justify-center"><span class="font-serif text-lg italic text-ash">nomnom</span></div>`;
  } else {
    detailTrack.innerHTML = detailImages
      .map((src) => `<div class="h-full w-full shrink-0"><img src="${src}" alt="${p.name}" loading="lazy" decoding="async" class="h-full w-full object-cover" /></div>`)
      .join("");
  }

  const multi = detailImages.length > 1;
  detailPrev.classList.toggle("hidden", !multi);
  detailNext.classList.toggle("hidden", !multi);
  detailDots.innerHTML = multi
    ? detailImages
        .map((_, i) => `<button class="h-2 w-2 rounded-full ${i === 0 ? "bg-ink" : "bg-ink/30"} transition-colors" aria-label="Ảnh ${i + 1}"></button>`)
        .join("")
    : "";
  detailDots.querySelectorAll("button").forEach((d, i) => d.addEventListener("click", () => goDetail(i)));
  detailIndex = 0;
  detailTrack.style.transform = "translateX(0)";

  document.getElementById("detail-category").textContent = p.category || "";
  document.getElementById("detail-name").textContent = p.name;
  document.getElementById("detail-description").textContent = p.description || "Chưa có mô tả.";
  document.getElementById("detail-price").innerHTML = p.sale_price
    ? `<span class="text-ash line-through">${formatPrice(p.price)}</span> <span class="text-red-600">${formatPrice(p.sale_price)}</span>`
    : formatPrice(p.price);

  const addBtn = document.getElementById("detail-add-cart");
  addBtn.onclick = () => {
    addToCart(p);
    addBtn.textContent = "Đã thêm ✓";
    setTimeout(() => { addBtn.textContent = "+ Giỏ hàng"; }, 1000);
  };

  renderRelated(p);

  detailModal.classList.remove("hidden");
  detailModal.classList.add("flex");
}

// Gợi ý "Có thể bạn cũng thích" — ưu tiên cùng phân loại, bù bằng món khác
function renderRelated(p) {
  const wrap = document.getElementById("detail-related");
  const list = document.getElementById("detail-related-list");
  const others = allProducts.filter((x) => x.id !== p.id && x.badge !== "soldout");
  const sameCat = others.filter((x) => x.category && x.category === p.category);
  const rest = others.filter((x) => !sameCat.includes(x));
  const picks = [...sameCat, ...rest].slice(0, 3);

  if (!picks.length) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  list.innerHTML = picks
    .map(
      (x) => `
    <button data-related="${x.id}" class="group text-left">
      <div class="aspect-square overflow-hidden rounded-lg bg-earth/30">
        ${x.image_url ? `<img src="${x.image_url}" alt="${x.name}" loading="lazy" decoding="async" class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />` : `<div class="flex h-full items-center justify-center"><span class="font-serif text-sm italic text-ash">nomnom</span></div>`}
      </div>
      <p class="mt-1.5 line-clamp-1 text-xs font-medium text-ink">${x.name}</p>
      <p class="text-xs text-ash">${formatPrice(x.sale_price || x.price)}</p>
    </button>`
    )
    .join("");
  list.querySelectorAll("[data-related]").forEach((b) =>
    b.addEventListener("click", () => {
      const prod = allProducts.find((x) => x.id === b.dataset.related);
      if (prod) openDetailModal(prod);
    })
  );
}

document.getElementById("detail-close").addEventListener("click", () => {
  detailModal.classList.add("hidden");
  detailModal.classList.remove("flex");
});

detailModal.addEventListener("click", (e) => {
  if (e.target === detailModal) {
    detailModal.classList.add("hidden");
    detailModal.classList.remove("flex");
  }
});

async function loadProducts() {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Lỗi tải sản phẩm:", error.message);
    document.getElementById("product-sections").innerHTML =
      `<p class="text-center text-sm text-ash py-12">Không thể tải sản phẩm.</p>`;
    return;
  }

  allProducts = data;
  renderProducts();
  renderKeyProduct();
}

function renderKeyProduct() {
  const section = document.getElementById("key-product");
  const hr = document.getElementById("key-product-hr");
  const key = allProducts.find((p) => p.is_key);

  if (!key) {
    section.classList.add("hidden");
    hr.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  hr.classList.remove("hidden");

  const img = document.getElementById("key-product-img");
  img.src = key.key_image_url || key.image_url || "";
  img.alt = key.name;
  document.getElementById("key-product-name").textContent = key.name;
  document.getElementById("key-product-price").textContent = key.sale_price
    ? `${formatPrice(key.sale_price)} (giá gốc ${formatPrice(key.price)})`
    : formatPrice(key.price);

  const btn = document.getElementById("key-product-btn");
  if (key.badge === "soldout") {
    btn.textContent = "Tạm hết hàng";
    btn.disabled = true;
    btn.classList.add("opacity-60", "pointer-events-none");
  } else {
    btn.textContent = "Đặt bánh ngay";
    btn.disabled = false;
    btn.classList.remove("opacity-60", "pointer-events-none");
  }

  btn.onclick = () => {
    addToCart(key);
    openCart();
  };

  // đăng ký hiệu ứng reveal cho banner mới render
  section.querySelectorAll(".reveal").forEach((el) => revealObserver.observe(el));
}

// ── Product Form ──

const productModal = document.getElementById("product-modal");
const productForm = document.getElementById("product-form");
const productError = document.getElementById("product-error");

// Nguồn sự thật cho việc đang SỬA hay THÊM sản phẩm — dùng biến JS thay vì đọc ô ẩn
// trong form (ô ẩn từng giữ lại id sản phẩm cũ khiến "thêm mới" chạy nhầm sang "cập nhật"
// và ghi đè lên sản phẩm trước đó).
let editingProductId = null;

function openProductForm(product) {
  document.getElementById("product-form-title").textContent = product
    ? "Sửa sản phẩm"
    : "Thêm sản phẩm";
  productForm.reset();
  editingProductId = product ? product.id : null;
  if (product) {
    productForm.elements.id.value = product.id;
    productForm.elements.name.value = product.name;
    productForm.elements.description.value = product.description || "";
    productForm.elements.price.value = product.price;
    productForm.elements.sale_price.value = product.sale_price || "";
    productForm.elements.category.value = product.category || "";
    productForm.elements.badge.value = product.badge || "";
    productForm.elements.is_key.checked = !!product.is_key;
  }
  productError.classList.add("hidden");
  productModal.classList.remove("hidden");
  productModal.classList.add("flex");
}

function closeProductForm() {
  productModal.classList.add("hidden");
  productModal.classList.remove("flex");
  productForm.reset();
  editingProductId = null;
}

document.getElementById("product-cancel").addEventListener("click", closeProductForm);
productModal.addEventListener("click", (e) => {
  if (e.target === productModal) closeProductForm();
});

async function uploadProductImage(file, prefix) {
  file = await compressImage(file);
  const ext = file.name.split(".").pop();
  const fileName = `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from("product-images")
    .upload(fileName, file);
  if (uploadError) throw uploadError;
  const { data: urlData } = supabase.storage.from("product-images").getPublicUrl(fileName);
  return urlData.publicUrl;
}

productForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(productForm);
  const id = editingProductId; // dùng biến trạng thái, KHÔNG đọc ô ẩn (tránh ghi đè nhầm)

  const salePriceVal = form.get("sale_price");
  const isKey = form.get("is_key") === "on";
  const row = {
    name: form.get("name"),
    description: form.get("description") || null,
    price: parseInt(form.get("price")),
    sale_price: salePriceVal ? parseInt(salePriceVal) : null,
    category: form.get("category") || null,
    badge: form.get("badge") || null,
    is_key: isKey,
  };

  try {
    const f1 = productForm.elements.image.files[0];
    const f2 = productForm.elements.image2.files[0];
    const f3 = productForm.elements.image3.files[0];
    const fKey = productForm.elements.key_image.files[0];
    if (f1) row.image_url = await uploadProductImage(f1, "");
    if (f2) row.image_url2 = await uploadProductImage(f2, "p2-");
    if (f3) row.image_url3 = await uploadProductImage(f3, "p3-");
    if (fKey) row.key_image_url = await uploadProductImage(fKey, "key-");
  } catch (uploadError) {
    productError.textContent = "Lỗi upload ảnh: " + uploadError.message;
    productError.classList.remove("hidden");
    return;
  }

  // Chỉ 1 sản phẩm key: nếu đặt cái này làm key thì bỏ key tất cả cái khác trước
  if (isKey) {
    await supabase.from("products").update({ is_key: false }).eq("is_key", true);
  }

  let error;
  if (id) {
    ({ error } = await supabase.from("products").update(row).eq("id", id));
  } else {
    ({ error } = await supabase.from("products").insert(row));
  }

  if (error) {
    productError.textContent = "Lỗi lưu: " + error.message;
    productError.classList.remove("hidden");
    return;
  }

  closeProductForm();
  loadProducts();
});

// ── Delete ──

async function deleteProduct(id) {
  if (!confirm("Bạn chắc chắn muốn xóa sản phẩm này?")) return;
  const { error } = await supabase.from("products").delete().eq("id", id);
  if (error) {
    alert("Lỗi xóa: " + error.message);
    return;
  }
  loadProducts();
}

// ── Hero Slideshow ──

const heroSlides = document.getElementById("hero-slides");
const heroEditBtn = document.getElementById("hero-edit-btn");
const heroPrev = document.getElementById("hero-prev");
const heroNext = document.getElementById("hero-next");
const heroDots = document.getElementById("hero-dots");
const heroSlideshow = document.getElementById("hero-slideshow");
let currentSlide = 0;
let slideCount = 0;
let autoplayTimer = null;

function goToSlide(i) {
  currentSlide = ((i % slideCount) + slideCount) % slideCount;
  heroSlides.style.transform = `translateX(-${currentSlide * 100}%)`;
  heroDots.querySelectorAll("button").forEach((dot, idx) => {
    dot.classList.toggle("bg-ink", idx === currentSlide);
    dot.classList.toggle("bg-ink/30", idx !== currentSlide);
  });
}

function startAutoplay() {
  stopAutoplay();
  if (slideCount > 1) {
    autoplayTimer = setInterval(() => goToSlide(currentSlide + 1), 4000);
  }
}

function stopAutoplay() {
  if (autoplayTimer) clearInterval(autoplayTimer);
}

heroPrev.addEventListener("click", () => { goToSlide(currentSlide - 1); startAutoplay(); });
heroNext.addEventListener("click", () => { goToSlide(currentSlide + 1); startAutoplay(); });

async function loadHeroSlides() {
  const { data } = await supabase
    .from("hero_slides")
    .select("*")
    .order("sort_order", { ascending: true });

  const slides = data || [];
  slideCount = slides.length;

  heroEditBtn.classList.toggle("hidden", !isAdmin);

  if (!slides.length) {
    heroSlides.innerHTML = `<div class="flex h-full w-full shrink-0 items-center justify-center"><span class="font-serif text-xl italic text-ash">Ảnh sản phẩm</span></div>`;
    heroPrev.classList.add("hidden");
    heroNext.classList.add("hidden");
    heroDots.classList.add("hidden");
    stopAutoplay();
    return;
  }

  heroSlides.innerHTML = slides
    .map((s) => `<div class="h-full w-full shrink-0"><img src="${s.image_url}" alt="" class="h-full w-full object-cover transition-transform duration-500 hover:scale-[1.2]" /></div>`)
    .join("");

  if (slides.length > 1) {
    heroPrev.classList.remove("hidden");
    heroNext.classList.remove("hidden");
    heroDots.classList.remove("hidden");
    heroSlideshow.addEventListener("mouseenter", () => {
      heroPrev.style.opacity = "1";
      heroNext.style.opacity = "1";
    });
    heroSlideshow.addEventListener("mouseleave", () => {
      heroPrev.style.opacity = "0";
      heroNext.style.opacity = "0";
    });
    heroDots.innerHTML = slides
      .map((_, i) => `<button class="h-2 w-2 rounded-full ${i === 0 ? "bg-ink" : "bg-ink/30"} transition-colors" aria-label="Slide ${i + 1}"></button>`)
      .join("");
    heroDots.querySelectorAll("button").forEach((dot, i) =>
      dot.addEventListener("click", () => { goToSlide(i); startAutoplay(); })
    );
    startAutoplay();
  } else {
    heroPrev.classList.add("hidden");
    heroNext.classList.add("hidden");
    heroDots.classList.add("hidden");
  }

  currentSlide = 0;
  heroSlides.style.transform = "translateX(0)";
}

// ── Hero Slides Admin ──

const slidesModal = document.getElementById("slides-modal");
const slidesList = document.getElementById("slides-list");
const slideUpload = document.getElementById("slide-upload");

heroEditBtn.addEventListener("click", openSlidesModal);
document.getElementById("slides-close").addEventListener("click", closeSlidesModal);
slidesModal.addEventListener("click", (e) => { if (e.target === slidesModal) closeSlidesModal(); });

async function openSlidesModal() {
  slidesModal.classList.remove("hidden");
  slidesModal.classList.add("flex");
  await renderSlidesList();
}

function closeSlidesModal() {
  slidesModal.classList.add("hidden");
  slidesModal.classList.remove("flex");
}

async function renderSlidesList() {
  const { data } = await supabase.from("hero_slides").select("*").order("sort_order");
  const slides = data || [];

  if (!slides.length) {
    slidesList.innerHTML = `<p class="text-sm text-ash">Chưa có ảnh nào.</p>`;
    return;
  }

  slidesList.innerHTML = slides
    .map(
      (s) => `
    <div class="flex items-center gap-3 border border-earth/40 p-2">
      <img src="${s.image_url}" alt="" class="h-16 w-16 object-cover shrink-0" />
      <span class="text-sm text-ash flex-1 truncate">${s.image_url.split("/").pop()}</span>
      <button data-delete-slide="${s.id}" class="text-xs text-red-500 hover:text-red-700 shrink-0">Xóa</button>
    </div>
  `
    )
    .join("");

  slidesList.querySelectorAll("[data-delete-slide]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await supabase.from("hero_slides").delete().eq("id", btn.dataset.deleteSlide);
      await renderSlidesList();
      loadHeroSlides();
    })
  );
}

slideUpload.addEventListener("change", async () => {
  let file = slideUpload.files[0];
  if (!file) return;
  file = await compressImage(file);

  const ext = file.name.split(".").pop();
  const fileName = `hero-${Date.now()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from("product-images")
    .upload(fileName, file);

  if (uploadError) {
    alert("Lỗi upload: " + uploadError.message);
    return;
  }

  const { data: urlData } = supabase.storage.from("product-images").getPublicUrl(fileName);

  const { data: existing } = await supabase.from("hero_slides").select("sort_order").order("sort_order", { ascending: false }).limit(1);
  const nextOrder = existing?.length ? existing[0].sort_order + 1 : 0;

  await supabase.from("hero_slides").insert({ image_url: urlData.publicUrl, sort_order: nextOrder });

  slideUpload.value = "";
  await renderSlidesList();
  loadHeroSlides();
});

// ── Banner Slideshow ──

const bannerSlides = document.getElementById("banner-slides");
const bannerDots = document.getElementById("banner-dots");
const bannerEditBtn = document.getElementById("banner-edit-btn");
const bannerSection = document.getElementById("banner-section");
let bannerIndex = 0;
let bannerCount = 0;
let bannerTimer = null;

function goToBanner(i) {
  bannerIndex = ((i % bannerCount) + bannerCount) % bannerCount;
  bannerSlides.style.transform = `translateX(-${bannerIndex * 100}%)`;
  bannerDots.querySelectorAll("button").forEach((dot, idx) => {
    dot.classList.toggle("bg-ink", idx === bannerIndex);
    dot.classList.toggle("bg-ink/30", idx !== bannerIndex);
  });
}

function startBannerAutoplay() {
  if (bannerTimer) clearInterval(bannerTimer);
  if (bannerCount > 1) {
    bannerTimer = setInterval(() => goToBanner(bannerIndex + 1), 10000);
  }
}

async function loadBanners() {
  const { data, error } = await supabase
    .from("banners")
    .select("*")
    .order("sort_order", { ascending: true });

  if (error) {
    bannerSection.classList.add("hidden");
    return;
  }

  const slides = data || [];
  bannerCount = slides.length;

  bannerEditBtn.classList.toggle("hidden", !isAdmin);

  if (!slides.length) {
    if (isAdmin) {
      bannerSection.classList.remove("hidden");
      bannerSlides.innerHTML = `<div class="flex h-[120px] w-full shrink-0 items-center justify-center md:h-[200px]"><span class="text-sm italic text-ash">Chưa có banner</span></div>`;
    } else {
      bannerSection.classList.add("hidden");
    }
    if (bannerTimer) clearInterval(bannerTimer);
    return;
  }

  bannerSection.classList.remove("hidden");
  bannerSlides.innerHTML = slides
    .map((s) => `<div class="h-[120px] w-full shrink-0 md:h-[200px]"><img src="${s.image_url}" alt="" class="h-full w-full object-cover" /></div>`)
    .join("");

  if (slides.length > 1) {
    bannerDots.classList.remove("hidden");
    bannerDots.innerHTML = slides
      .map((_, i) => `<button class="h-2 w-2 rounded-full ${i === 0 ? "bg-ink" : "bg-ink/30"} transition-colors" aria-label="Banner ${i + 1}"></button>`)
      .join("");
    bannerDots.querySelectorAll("button").forEach((dot, i) =>
      dot.addEventListener("click", () => { goToBanner(i); startBannerAutoplay(); })
    );
    startBannerAutoplay();
  } else {
    bannerDots.classList.add("hidden");
  }

  bannerIndex = 0;
  bannerSlides.style.transform = "translateX(0)";
}

// ── Banner Admin ──

const bannerModal = document.getElementById("banner-modal");
const bannerList = document.getElementById("banner-list");
const bannerUpload = document.getElementById("banner-upload");

bannerEditBtn.addEventListener("click", () => {
  bannerModal.classList.remove("hidden");
  bannerModal.classList.add("flex");
  renderBannerList();
});

document.getElementById("banner-close").addEventListener("click", () => {
  bannerModal.classList.add("hidden");
  bannerModal.classList.remove("flex");
});

bannerModal.addEventListener("click", (e) => {
  if (e.target === bannerModal) {
    bannerModal.classList.add("hidden");
    bannerModal.classList.remove("flex");
  }
});

async function renderBannerList() {
  const { data } = await supabase.from("banners").select("*").order("sort_order");
  const items = data || [];

  if (!items.length) {
    bannerList.innerHTML = `<p class="text-sm text-ash">Chưa có banner nào.</p>`;
    return;
  }

  bannerList.innerHTML = items
    .map(
      (s) => `
    <div class="flex items-center gap-3 border border-earth/40 p-2">
      <img src="${s.image_url}" alt="" class="h-12 w-20 object-cover shrink-0" />
      <span class="text-sm text-ash flex-1 truncate">${s.image_url.split("/").pop()}</span>
      <button data-delete-banner="${s.id}" class="text-xs text-red-500 hover:text-red-700 shrink-0">Xóa</button>
    </div>
  `
    )
    .join("");

  bannerList.querySelectorAll("[data-delete-banner]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await supabase.from("banners").delete().eq("id", btn.dataset.deleteBanner);
      await renderBannerList();
      loadBanners();
    })
  );
}

bannerUpload.addEventListener("change", async () => {
  let file = bannerUpload.files[0];
  if (!file) return;
  file = await compressImage(file);

  const ext = file.name.split(".").pop();
  const fileName = `banner-${Date.now()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from("product-images")
    .upload(fileName, file);

  if (uploadError) {
    alert("Lỗi upload: " + uploadError.message);
    return;
  }

  const { data: urlData } = supabase.storage.from("product-images").getPublicUrl(fileName);

  const { data: existing } = await supabase.from("banners").select("sort_order").order("sort_order", { ascending: false }).limit(1);
  const nextOrder = existing?.length ? existing[0].sort_order + 1 : 0;

  await supabase.from("banners").insert({ image_url: urlData.publicUrl, sort_order: nextOrder });

  bannerUpload.value = "";
  await renderBannerList();
  loadBanners();
});

// ── Contact Buttons ──

const contactEditBtn = document.getElementById("btn-contact-edit");
const contactModal = document.getElementById("contact-modal");
const contactForm = document.getElementById("contact-form");
const contactError = document.getElementById("contact-error");

function updateLogo(data) {
  const headerLogo = document.getElementById("logo");
  const footerLogo = document.getElementById("footer-logo");
  const logoNames = document.querySelectorAll(".logo-name");

  if (data.logo_image_url) {
    headerLogo.innerHTML = `<img src="${data.logo_image_url}" alt="Logo" class="h-[50px] md:h-[60px] w-auto" />`;
    footerLogo.innerHTML = `<img src="${data.logo_image_url}" alt="Logo" class="h-8 w-auto" />`;
  } else {
    headerLogo.textContent = data.logo_text || "nomnom";
    footerLogo.textContent = data.logo_text || "nomnom";
  }

  const name = data.logo_text || "nomnom";
  logoNames.forEach((el) => { el.textContent = name; });
  document.title = `${name} — Bánh ngọt thủ công`;
}

const editableFields = [
  { id: "hero-subtitle", col: "hero_subtitle" },
  { id: "hero-title", col: "hero_title" },
  { id: "hero-description", col: "hero_description" },
  { id: "hero-cta", col: "hero_cta" },
  { id: "hero-about-cta", col: "hero_about_cta" },
  { id: "products-title", col: "products_title" },
  { id: "products-subtitle", col: "products_subtitle" },
  { id: "about-title", col: "about_title" },
  { id: "about-text", col: "about_text" },
  { id: "review-title", col: "review_title" },
  { id: "review-subtitle", col: "review_subtitle" },
  { id: "process-title", col: "process_title" },
  { id: "step1-title", col: "step1_title" },
  { id: "step1-desc", col: "step1_desc" },
  { id: "step2-title", col: "step2_title" },
  { id: "step2-desc", col: "step2_desc" },
  { id: "step3-title", col: "step3_title" },
  { id: "step3-desc", col: "step3_desc" },
  { id: "contact-title", col: "contact_title" },
  { id: "badge1-title", col: "badge1_title" },
  { id: "badge1-sub", col: "badge1_sub" },
  { id: "badge2-title", col: "badge2_title" },
  { id: "badge2-sub", col: "badge2_sub" },
  { id: "badge3-title", col: "badge3_title" },
  { id: "badge3-sub", col: "badge3_sub" },
  { id: "badge4-title", col: "badge4_title" },
  { id: "badge4-sub", col: "badge4_sub" },
  { id: "custom-title", col: "custom_title" },
  { id: "custom-text", col: "custom_text" },
];

function updateHeroContent(data) {
  editableFields.forEach(({ id, col }) => {
    const el = document.getElementById(id);
    if (data[col]) el.textContent = data[col];
  });

  if (isAdmin) {
    editableFields.forEach(({ id, col }) => {
      const el = document.getElementById(id);
      el.setAttribute("contenteditable", "true");
      el.removeEventListener("blur", el._saveHandler);
      el._saveHandler = () => saveField(col, el.textContent.trim());
      el.addEventListener("blur", el._saveHandler);
    });
  } else {
    editableFields.forEach(({ id }) => {
      document.getElementById(id).removeAttribute("contenteditable");
    });
  }
}

const saveToast = document.getElementById("save-toast");

async function saveField(column, value) {
  const { error } = await supabase
    .from("site_settings")
    .update({ [column]: value })
    .eq("id", 1);

  if (!error) {
    saveToast.classList.add("show");
    setTimeout(() => saveToast.classList.remove("show"), 1500);
  }
}

// Upload 1 file cho khung hero: ảnh thì nén, video thì giữ nguyên. Trả về { url, type }.
async function uploadHeroSide(file, prefix) {
  const isVideo = file.type.startsWith("video/");
  const toUpload = isVideo ? file : await compressImage(file);
  const ext = isVideo ? (file.name.split(".").pop() || "mp4") : toUpload.name.split(".").pop();
  const fileName = `${prefix}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from("product-images")
    .upload(fileName, toUpload, isVideo ? { contentType: file.type } : undefined);
  if (error) throw error;
  const { data } = supabase.storage.from("product-images").getPublicUrl(fileName);
  return { url: data.publicUrl, type: isVideo ? "video" : "image" };
}

// Điền 1 khung hero (trái/phải) bằng ảnh hoặc video tùy loại đã lưu.
function renderHeroSide(containerId, url, type) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!url) {
    el.innerHTML = "";
    el.classList.remove("hero-side-visible");
    return;
  }
  if (type === "video") {
    el.innerHTML = `<video class="h-full w-full object-cover" src="${url}" autoplay muted loop playsinline></video>`;
  } else {
    el.innerHTML = `<img class="h-full w-full object-cover" src="${url}" alt="" />`;
  }
  el.classList.add("hero-side-visible");
}

async function loadContactSettings() {
  const { data } = await supabase.from("site_settings").select("*").single();
  if (!data) return;

  updateLogo(data);
  updateHeroContent(data);

  // Hero 2 bên: mỗi bên có thể là ảnh HOẶC video. Ưu tiên cột mới (hero_left/right_url + type);
  // nếu chưa có thì lấy dữ liệu cũ (hero_video_url = trái/video, hero_side_image_url = phải/ảnh)
  // để không mất nội dung đã cài trước đây.
  const leftUrl = data.hero_left_url || data.hero_video_url || "";
  const leftType = data.hero_left_type || (data.hero_video_url ? "video" : "");
  const rightUrl = data.hero_right_url || data.hero_side_image_url || "";
  const rightType = data.hero_right_type || (data.hero_side_image_url ? "image" : "");
  renderHeroSide("hero-left", leftUrl, leftType);
  renderHeroSide("hero-right", rightUrl, rightType);
  document.getElementById("hero-left-edit").classList.toggle("hidden", !isAdmin);
  document.getElementById("hero-right-edit").classList.toggle("hidden", !isAdmin);

  const aboutImg = document.getElementById("about-image");
  const aboutPlaceholder = document.getElementById("about-image-placeholder");
  const aboutImgEdit = document.getElementById("about-image-edit");
  if (data.about_image_url) {
    aboutImg.src = data.about_image_url;
    aboutImg.style.display = "block";
    aboutPlaceholder.style.display = "none";
  } else {
    aboutImg.style.display = "none";
    aboutPlaceholder.style.display = "flex";
  }
  aboutImgEdit.classList.toggle("hidden", !isAdmin);

  const customImg = document.getElementById("custom-image");
  const customPlaceholder = document.getElementById("custom-image-placeholder");
  const customImgEdit = document.getElementById("custom-image-edit");
  if (data.custom_image_url) {
    customImg.src = data.custom_image_url;
    customImg.style.display = "block";
    customPlaceholder.style.display = "none";
  } else {
    customImg.style.display = "none";
    customPlaceholder.style.display = "flex";
  }
  customImgEdit.classList.toggle("hidden", !isAdmin);

  const zaloBtn = document.getElementById("btn-zalo");
  const messengerBtn = document.getElementById("btn-messenger");

  zaloBtn.href = data.zalo_url || "#";
  messengerBtn.href = data.messenger_url || "#";

  zaloBtn.classList.toggle("hidden", !data.zalo_url);
  messengerBtn.classList.toggle("hidden", !data.messenger_url);

  const footerPhone = document.getElementById("footer-phone");
  const footerAddress = document.getElementById("footer-address");
  if (data.phone) {
    footerPhone.innerHTML = `<a href="tel:${data.phone}" class="hover:text-ash transition-colors">${data.phone}</a>`;
  } else {
    footerPhone.textContent = "Đang cập nhật";
  }
  footerAddress.textContent = data.address_text || "Đang cập nhật";

  const footerHours = document.getElementById("footer-hours");
  footerHours.textContent = data.opening_hours || "8:00 – 20:00";

  // Trạng thái Mở/Đóng cửa (tự tính từ giờ mở cửa)
  updateOpenStatus(data.opening_hours);

  // Bản đồ Google Maps nhúng theo địa chỉ (không cần API key)
  const mapFrame = document.getElementById("footer-map");
  if (data.address_text) {
    mapFrame.src = `https://maps.google.com/maps?q=${encodeURIComponent(data.address_text)}&z=15&output=embed`;
  } else {
    mapFrame.removeAttribute("src");
  }

  // CTA "Bánh đặt riêng" → ưu tiên Zalo, fallback Messenger / điện thoại
  const customCta = document.getElementById("custom-cta");
  customCta.href = data.zalo_url || data.messenger_url || (data.phone ? `tel:${data.phone}` : "#");

  // Ngưỡng miễn phí ship (để giỏ hàng tính thanh freeship)
  freeShipThreshold = parseInt(data.free_ship_threshold) || 0;
  if (!cartFooter.classList.contains("hidden")) renderCart();

  const socials = [
    ["social-facebook", data.facebook_url],
    ["social-instagram", data.instagram_url],
    ["social-threads", data.threads_url],
  ];
  socials.forEach(([elId, url]) => {
    const el = document.getElementById(elId);
    el.href = url || "#";
    // khách chỉ thấy icon đã có link; admin luôn thấy cả 3 để điền
    const show = !!url || isAdmin;
    el.classList.toggle("hidden", !show);
    el.classList.toggle("inline-flex", show);
    el.classList.toggle("opacity-40", !url); // mờ nếu chưa có link (gợi ý cho admin)
  });

  contactEditBtn.classList.toggle("hidden", !isAdmin);
  contactEditBtn.classList.toggle("flex", isAdmin);

  bankSettings = {
    bank_id: data.bank_id || "",
    bank_account: data.bank_account || "",
    bank_name: data.bank_name || "",
    zalo_url: data.zalo_url || "",
  };
  chatAutoReply = data.chat_auto_reply || "";

  rewardConfig = {
    cycle: parseInt(data.reward_cycle_orders) || 10,
    percent: parseInt(data.reward_percent) || 20,
  };
  updateLoyaltyHint();
  if (currentCustomer) refreshCustomerData();

  const dFee = document.getElementById("delivery-fee");
  const dZones = document.getElementById("delivery-zones");
  const dTime = document.getElementById("delivery-time");
  const dInfo = document.getElementById("delivery-info");
  const hasDel = data.delivery_fee || data.delivery_zones || data.delivery_time;
  dInfo.classList.toggle("hidden", !hasDel);
  dFee.textContent = data.delivery_fee ? `Phí ship: ${data.delivery_fee}` : "";
  dZones.textContent = data.delivery_zones ? `Khu vực: ${data.delivery_zones}` : "";
  dTime.textContent = data.delivery_time ? `Thời gian: ${data.delivery_time}` : "";
}

document.getElementById("hero-left-edit").addEventListener("click", () => {
  contactEditBtn.click();
});
document.getElementById("hero-right-edit").addEventListener("click", () => {
  contactEditBtn.click();
});
document.getElementById("about-image-edit").addEventListener("click", () => {
  contactEditBtn.click();
});
document.getElementById("custom-image-edit").addEventListener("click", () => {
  contactEditBtn.click();
});

contactEditBtn.addEventListener("click", async () => {
  const { data } = await supabase.from("site_settings").select("*").single();
  if (data) {
    contactForm.elements.phone.value = data.phone || "";
    contactForm.elements.zalo_url.value = data.zalo_url || "";
    contactForm.elements.address_text.value = data.address_text || "";
    contactForm.elements.opening_hours.value = data.opening_hours || "";
    contactForm.elements.messenger_url.value = data.messenger_url || "";
    contactForm.elements.facebook_url.value = data.facebook_url || "";
    contactForm.elements.instagram_url.value = data.instagram_url || "";
    contactForm.elements.threads_url.value = data.threads_url || "";
    contactForm.elements.delivery_fee.value = data.delivery_fee || "";
    contactForm.elements.delivery_zones.value = data.delivery_zones || "";
    contactForm.elements.delivery_time.value = data.delivery_time || "";
    contactForm.elements.free_ship_threshold.value = data.free_ship_threshold || "";
    contactForm.elements.bank_id.value = data.bank_id || "";
    contactForm.elements.bank_account.value = data.bank_account || "";
    contactForm.elements.bank_name.value = data.bank_name || "";
    contactForm.elements.chat_auto_reply.value = data.chat_auto_reply || "";
    contactForm.elements.reward_cycle_orders.value = data.reward_cycle_orders || "";
    contactForm.elements.reward_percent.value = data.reward_percent || "";
    const preview = document.getElementById("current-logo-preview");
    const previewImg = document.getElementById("logo-preview-img");
    if (data.logo_image_url) {
      previewImg.src = data.logo_image_url;
      preview.classList.remove("hidden");
    } else {
      preview.classList.add("hidden");
    }
  }
  contactError.classList.add("hidden");
  contactModal.classList.remove("hidden");
  contactModal.classList.add("flex");
});

document.getElementById("contact-cancel").addEventListener("click", closeContactModal);
contactModal.addEventListener("click", (e) => { if (e.target === contactModal) closeContactModal(); });

function closeContactModal() {
  contactModal.classList.add("hidden");
  contactModal.classList.remove("flex");
}

contactForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(contactForm);
  const logoFile = contactForm.elements.logo_image.files[0];

  let logo_image_url = undefined;
  let heroLeft = null; // { url, type } bên trái
  let heroRight = null; // { url, type } bên phải

  if (logoFile) {
    const logoC = await compressImage(logoFile);
    const ext = logoC.name.split(".").pop();
    const fileName = `logo-${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("product-images")
      .upload(fileName, logoC);

    if (uploadError) {
      contactError.textContent = "Lỗi upload logo: " + uploadError.message;
      contactError.classList.remove("hidden");
      return;
    }

    const { data: urlData } = supabase.storage.from("product-images").getPublicUrl(fileName);
    logo_image_url = urlData.publicUrl;
  }

  try {
    const leftFile = contactForm.elements.hero_left.files[0];
    const rightFile = contactForm.elements.hero_right.files[0];
    if (leftFile) heroLeft = await uploadHeroSide(leftFile, "hero-left");
    if (rightFile) heroRight = await uploadHeroSide(rightFile, "hero-right");
  } catch (heroErr) {
    contactError.textContent = "Lỗi upload hero: " + heroErr.message;
    contactError.classList.remove("hidden");
    return;
  }

  let about_image_url = undefined;
  const aboutFile = contactForm.elements.about_image.files[0];
  if (aboutFile) {
    const aboutC = await compressImage(aboutFile);
    const aName = `about-${Date.now()}.${aboutC.name.split(".").pop()}`;
    const { error: aErr } = await supabase.storage
      .from("product-images")
      .upload(aName, aboutC);
    if (aErr) {
      contactError.textContent = "Lỗi upload ảnh About: " + aErr.message;
      contactError.classList.remove("hidden");
      return;
    }
    const { data: aUrl } = supabase.storage.from("product-images").getPublicUrl(aName);
    about_image_url = aUrl.publicUrl;
  }

  let custom_image_url = undefined;
  const customFile = contactForm.elements.custom_image.files[0];
  if (customFile) {
    const customC = await compressImage(customFile);
    const cName = `custom-${Date.now()}.${customC.name.split(".").pop()}`;
    const { error: cErr } = await supabase.storage
      .from("product-images")
      .upload(cName, customC);
    if (cErr) {
      contactError.textContent = "Lỗi upload ảnh Bánh đặt riêng: " + cErr.message;
      contactError.classList.remove("hidden");
      return;
    }
    const { data: cUrl } = supabase.storage.from("product-images").getPublicUrl(cName);
    custom_image_url = cUrl.publicUrl;
  }

  const row = {
    phone: form.get("phone") || null,
    zalo_url: form.get("zalo_url") || null,
    address_text: form.get("address_text") || null,
    opening_hours: form.get("opening_hours") || null,
    messenger_url: form.get("messenger_url") || null,
    facebook_url: form.get("facebook_url") || null,
    instagram_url: form.get("instagram_url") || null,
    threads_url: form.get("threads_url") || null,
    delivery_fee: form.get("delivery_fee") || null,
    delivery_zones: form.get("delivery_zones") || null,
    delivery_time: form.get("delivery_time") || null,
    free_ship_threshold: form.get("free_ship_threshold") ? parseInt(form.get("free_ship_threshold")) : null,
    bank_id: form.get("bank_id") || null,
    bank_account: form.get("bank_account") || null,
    bank_name: form.get("bank_name") || null,
    chat_auto_reply: form.get("chat_auto_reply") || null,
    reward_cycle_orders: form.get("reward_cycle_orders") ? parseInt(form.get("reward_cycle_orders")) : null,
    reward_percent: form.get("reward_percent") ? parseInt(form.get("reward_percent")) : null,
  };
  if (logo_image_url) row.logo_image_url = logo_image_url;
  if (heroLeft) {
    row.hero_left_url = heroLeft.url;
    row.hero_left_type = heroLeft.type;
  }
  if (heroRight) {
    row.hero_right_url = heroRight.url;
    row.hero_right_type = heroRight.type;
  }
  if (about_image_url) row.about_image_url = about_image_url;
  if (custom_image_url) row.custom_image_url = custom_image_url;

  const { error } = await supabase.from("site_settings").update(row).eq("id", 1);

  if (error) {
    contactError.textContent = "Lỗi lưu: " + error.message;
    contactError.classList.remove("hidden");
    return;
  }

  closeContactModal();
  loadContactSettings();
});

// ── Reviews ──

const reviewList = document.getElementById("review-list");
const reviewForm = document.getElementById("review-form");
const reviewError = document.getElementById("review-error");
const starPicker = document.getElementById("star-picker");
let selectedRating = 5;

starPicker.querySelectorAll("[data-star]").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedRating = parseInt(btn.dataset.star);
    reviewForm.elements.rating.value = selectedRating;
    starPicker.querySelectorAll("[data-star]").forEach((b, i) => {
      b.classList.toggle("text-[#f39c12]", i < selectedRating);
      b.classList.toggle("text-earth/50", i >= selectedRating);
    });
  });
});

function renderStars(n) {
  return "★".repeat(n) + "☆".repeat(5 - n);
}

// Điểm trung bình + số lượng để làm social proof ở hero và đầu mục Reviews.
function reviewSummary(reviews) {
  const rated = reviews.filter((r) => Number(r.rating) > 0);
  if (!rated.length) return { avg: 0, count: 0 };
  const avg = rated.reduce((sum, r) => sum + Number(r.rating), 0) / rated.length;
  return { avg, count: rated.length };
}

function renderReviewSummary(reviews) {
  const { avg, count } = reviewSummary(reviews);
  const heroBox = document.getElementById("hero-social-proof");
  const summaryBox = document.getElementById("review-summary");
  if (!count) {
    heroBox?.classList.add("hidden");
    heroBox?.classList.remove("inline-flex");
    summaryBox?.classList.add("hidden");
    summaryBox?.classList.remove("flex");
    return;
  }
  const avgText = avg.toFixed(1);
  const rounded = Math.round(avg);

  if (heroBox) {
    document.getElementById("hero-rating-value").textContent = avgText;
    document.getElementById("hero-rating-count").textContent = count;
    heroBox.classList.remove("hidden");
    heroBox.classList.add("inline-flex");
  }
  if (summaryBox) {
    document.getElementById("review-summary-avg").textContent = avgText;
    document.getElementById("review-summary-stars").textContent = renderStars(rounded);
    document.getElementById("review-summary-count").textContent = `${count} đánh giá`;
    summaryBox.classList.remove("hidden");
    summaryBox.classList.add("flex");
  }
}

function formatReviewDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return "Hôm nay";
  if (diffDays === 1) return "Hôm qua";
  if (diffDays < 7) return `${diffDays} ngày trước`;
  return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function renderReviews(reviews) {
  renderReviewSummary(reviews);
  if (!reviews.length) {
    reviewList.innerHTML = `<p class="text-sm text-ash">Chưa có đánh giá nào. Hãy là người đầu tiên!</p>`;
    return;
  }

  reviewList.innerHTML = reviews
    .map(
      (r) => `
    <div class="w-[280px] shrink-0 snap-start border border-earth/40 p-5 md:w-[320px] ${isAdmin ? "group relative" : ""}">
      ${r.image_url ? `<img src="${r.image_url}" alt="Ảnh đánh giá" loading="lazy" decoding="async" class="mb-4 h-40 w-full rounded object-cover" />` : ""}
      <div class="flex items-center gap-2">
        <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-earth/30 font-serif text-sm text-ink">
          ${r.name.charAt(0).toUpperCase()}
        </div>
        <div class="min-w-0">
          <span class="block text-sm font-medium text-ink leading-tight">${r.name}</span>
          ${r.created_at ? `<span class="block text-[11px] text-ash">${formatReviewDate(r.created_at)}</span>` : ""}
        </div>
      </div>
      <div class="mt-2 text-sm text-[#f39c12]">${renderStars(r.rating)}</div>
      <p class="mt-2 text-sm text-ash line-clamp-3">${r.comment}</p>
      ${isAdmin ? `<button data-delete-review="${r.id}" class="absolute top-2 right-2 text-xs text-red-500 hover:text-red-700 opacity-0 group-hover:opacity-100 transition-opacity">✕</button>` : ""}
    </div>
  `
    )
    .join("");

  if (isAdmin) {
    reviewList.querySelectorAll("[data-delete-review]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        await supabase.from("reviews").delete().eq("id", btn.dataset.deleteReview);
        loadReviews();
      })
    );
  }
}

async function loadReviews() {
  const { data } = await supabase
    .from("reviews")
    .select("*")
    .order("created_at", { ascending: false });

  renderReviews(data || []);
}

reviewForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(reviewForm);
  const imageFile = reviewForm.elements.image.files[0];

  let image_url = null;

  if (imageFile) {
    const reviewC = await compressImage(imageFile);
    const ext = reviewC.name.split(".").pop();
    const fileName = `review-${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("product-images")
      .upload(fileName, reviewC);

    if (uploadError) {
      reviewError.textContent = "Lỗi upload ảnh: " + uploadError.message;
      reviewError.classList.remove("hidden");
      return;
    }

    const { data: urlData } = supabase.storage.from("product-images").getPublicUrl(fileName);
    image_url = urlData.publicUrl;
  }

  const row = {
    name: form.get("name"),
    rating: parseInt(form.get("rating")),
    comment: form.get("comment"),
  };
  if (image_url) row.image_url = image_url;

  const { error } = await supabase.from("reviews").insert(row);

  if (error) {
    reviewError.textContent = "Lỗi gửi đánh giá: " + error.message;
    reviewError.classList.remove("hidden");
    return;
  }

  reviewError.classList.add("hidden");
  reviewForm.reset();
  selectedRating = 5;
  starPicker.querySelectorAll("[data-star]").forEach((b) => b.classList.replace("text-earth/50", "text-[#f39c12]"));
  loadReviews();
});

// ── Admin: Quản lý đơn hàng ──

const adminOrdersBtn = document.getElementById("admin-orders-btn");
const adminOrdersBadge = document.getElementById("admin-orders-badge");
const ordersDrawer = document.getElementById("orders-drawer");
const ordersOverlay = document.getElementById("orders-overlay");
const ordersList = document.getElementById("orders-list");
const ordersTabs = document.getElementById("orders-tabs");
let ordersFilter = "active";
let adminOrdersChannel = null;
let adminOrdersCache = [];

// Nhãn trạng thái đơn (ORDER_STATUS) dùng chung với admin.js — ở đây chỉ map
// "tone" sang class màu thật của trang storefront (khác hệ class với admin.css).
const STATUS_TONE_CLASS = {
  amber: "bg-[#f39c12]",
  green: "bg-[#34C759]",
  ash: "bg-ash",
  red: "bg-red-500",
};

function orderStatusBadge(status) {
  const st = ORDER_STATUS[status];
  return {
    text: st ? st.label : status || "--",
    cls: STATUS_TONE_CLASS[st?.tone] || "bg-ash",
  };
}

adminOrdersBtn.addEventListener("click", openOrdersDrawer);
document.getElementById("orders-close").addEventListener("click", closeOrdersDrawer);
ordersOverlay.addEventListener("click", closeOrdersDrawer);

ordersTabs.querySelectorAll("[data-otab]").forEach((btn) =>
  btn.addEventListener("click", () => {
    ordersFilter = btn.dataset.otab;
    ordersTabs.querySelectorAll("[data-otab]").forEach((b) => {
      const on = b.dataset.otab === ordersFilter;
      b.classList.toggle("bg-ink", on);
      b.classList.toggle("text-white", on);
      b.classList.toggle("border-ink", on);
      b.classList.toggle("text-ink", !on);
      b.classList.toggle("border-earth", !on);
    });
    renderAdminOrders();
  })
);

function openOrdersDrawer() {
  ordersDrawer.classList.remove("-translate-x-full");
  ordersOverlay.classList.remove("hidden");
  fetchAdminOrders();
}

function closeOrdersDrawer() {
  ordersDrawer.classList.add("-translate-x-full");
  ordersOverlay.classList.add("hidden");
}

async function fetchAdminOrders() {
  if (!isAdmin) return;
  // Chỉ lấy đơn ĐÃ THANH TOÁN trở đi — đơn 'pending' (chưa chuyển khoản)
  // không hiện cho cô chủ. Đơn pending vẫn nằm trong DB để webhook Sepay
  // match mã đơn và cập nhật thành 'paid' khi khách trả tiền.
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .neq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) return;

  adminOrdersCache = data || [];
  const active = adminOrdersCache.filter((o) => o.status === "paid").length;
  adminOrdersBadge.textContent = active;
  adminOrdersBadge.classList.toggle("hidden", active === 0);

  if (!ordersDrawer.classList.contains("-translate-x-full")) renderAdminOrders();
}

function renderAdminOrders() {
  let list = adminOrdersCache;
  if (ordersFilter === "active")
    list = list.filter((o) => o.status === "paid");
  else if (ordersFilter !== "all")
    list = list.filter((o) => o.status === ordersFilter);

  if (!list.length) {
    ordersList.innerHTML = `<p class="text-center text-sm text-ash py-12">Không có đơn nào.</p>`;
    return;
  }

  ordersList.innerHTML = list
    .map((o) => {
      const items = Array.isArray(o.items) ? o.items : [];
      const st = orderStatusBadge(o.status);
      const time = formatDateTime(o.created_at);
      return `
    <div class="border border-earth/40 p-4">
      <div class="flex items-center justify-between">
        <span class="font-medium text-ink">${o.order_code}</span>
        <span class="${st.cls} px-2 py-0.5 text-[10px] font-medium text-white">${st.text}</span>
      </div>
      <p class="mt-1 text-xs text-ash">${time}</p>
      <div class="mt-3 space-y-0.5 text-sm text-ink">
        ${items
          .map(
            (i) =>
              `<div class="flex justify-between"><span>${i.name} ×${i.qty}${i.note ? ` <span class="text-ash">(${i.note})</span>` : ""}</span><span class="text-ash">${formatPrice(i.price * i.qty)}</span></div>`
          )
          .join("")}
      </div>
      <div class="mt-2 flex justify-between border-t border-dashed border-earth pt-2 text-sm font-medium text-ink">
        <span>Tổng</span><span>${formatPrice(o.total)}</span>
      </div>
      <div class="mt-3 space-y-1.5 text-xs text-ash">
        <p class="flex items-start gap-1.5"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" class="mt-0.5 shrink-0"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><span>${o.customer_name || "—"}${o.customer_phone ? ` · <a href="tel:${o.customer_phone}" class="text-ink hover:underline">${o.customer_phone}</a>` : ""}</span></p>
        <p class="flex items-start gap-1.5"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" class="mt-0.5 shrink-0"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg><span>${o.customer_address || "—"}</span></p>
        <p class="flex items-start gap-1.5"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" class="mt-0.5 shrink-0"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span>${o.delivery_time || "Giao sớm nhất"}</span></p>
        ${o.note ? `<p class="flex items-start gap-1.5"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" class="mt-0.5 shrink-0"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg><span>${o.note}</span></p>` : ""}
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        <button data-order-print="${o.id}" class="border border-earth/60 px-3 py-2 text-xs font-medium text-ink hover:bg-earth/20">🖨 In đơn</button>
        ${o.status === "paid" ? `<button data-order-delivered="${o.id}" class="bg-ink px-3 py-2 text-xs font-medium text-white hover:opacity-90">Đã giao</button>` : ""}
        ${o.status === "paid" ? `<button data-order-cancel="${o.id}" class="border border-red-400 px-3 py-2 text-xs font-medium text-red-500 hover:bg-red-50">Huỷ đơn</button>` : ""}
      </div>
    </div>`;
    })
    .join("");

  ordersList.querySelectorAll("[data-order-delivered]").forEach((b) =>
    b.addEventListener("click", () => setOrderStatus(b.dataset.orderDelivered, "delivered"))
  );
  ordersList.querySelectorAll("[data-order-cancel]").forEach((b) =>
    b.addEventListener("click", () => {
      if (confirm("Huỷ đơn này?")) setOrderStatus(b.dataset.orderCancel, "cancelled");
    })
  );
  ordersList.querySelectorAll("[data-order-print]").forEach((b) =>
    b.addEventListener("click", () => {
      const order = adminOrdersCache.find((o) => o.id === b.dataset.orderPrint);
      if (order) printKitchenOrder(order);
    })
  );
}

function printKitchenOrder(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const time = formatDateTimeLong(order.created_at);
  const html = `
    <!doctype html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8" />
      <title>Đơn ${order.order_code}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 16px; color: #0a0a0a; max-width: 380px; }
        h1 { font-size: 18px; margin: 0 0 4px; }
        .muted { color: #6b6b6b; font-size: 12px; }
        table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
        td { padding: 4px 0; vertical-align: top; }
        .note { color: #6b6b6b; font-size: 12px; }
        .total-row td { border-top: 1px dashed #999; padding-top: 8px; font-weight: bold; }
        .section { margin-top: 14px; font-size: 13px; line-height: 1.6; }
        hr { border: none; border-top: 1px dashed #999; margin: 14px 0; }
      </style>
    </head>
    <body>
      <h1>nomnom — Đơn ${order.order_code}</h1>
      <p class="muted">${time}</p>
      <hr />
      <table>
        ${items
          .map(
            (i) => `
          <tr>
            <td>${i.name} × ${i.qty}${i.note ? `<div class="note">Ghi chú: ${i.note}</div>` : ""}</td>
            <td style="text-align:right">${formatPrice(i.price * i.qty)}</td>
          </tr>`
          )
          .join("")}
        <tr class="total-row"><td>Tổng</td><td style="text-align:right">${formatPrice(order.total)}</td></tr>
      </table>
      <hr />
      <div class="section">
        <p><b>Khách:</b> ${order.customer_name || "—"} ${order.customer_phone ? `· ${order.customer_phone}` : ""}</p>
        <p><b>Địa chỉ:</b> ${order.customer_address || "—"}</p>
        <p><b>Giao:</b> ${order.delivery_time || "Giao sớm nhất"}</p>
        ${order.note ? `<p><b>Ghi chú đơn:</b> ${order.note}</p>` : ""}
      </div>
    </body>
    </html>
  `;
  const win = window.open("", "_blank", "width=420,height=600");
  if (!win) {
    alert("Trình duyệt đang chặn cửa sổ in. Vui lòng cho phép pop-up rồi thử lại.");
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 250);
}

async function setOrderStatus(id, status) {
  const { error } = await updateOrderStatus(id, status);
  if (error) {
    alert("Lỗi cập nhật: " + error.message);
    return;
  }
  fetchAdminOrders();
}

function startAdminOrdersRealtime() {
  stopAdminOrdersRealtime();
  fetchAdminOrders();
  adminOrdersChannel = supabase
    .channel("storefront-orders-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, fetchAdminOrders)
    .subscribe();
}

function stopAdminOrdersRealtime() {
  if (adminOrdersChannel) {
    supabase.removeChannel(adminOrdersChannel);
    adminOrdersChannel = null;
  }
}

// ── Customer Account (đăng nhập bằng SĐT, tích điểm) ──

const customerModal = document.getElementById("customer-modal");
const customerLoginForm = document.getElementById("customer-login-form");
const customerPanel = document.getElementById("customer-panel");
const customerLoginError = document.getElementById("customer-login-error");

function availableVouchers(c) {
  if (!c) return 0;
  const earned = Math.floor((c.points || 0) / rewardConfig.cycle);
  return Math.max(0, earned - (c.vouchers_used || 0));
}

function openCustomerModal() {
  if (currentCustomer) {
    customerLoginForm.classList.add("hidden");
    customerPanel.classList.remove("hidden");
    renderCustomerPanel();
    refreshCustomerData(); // lấy điểm mới nhất khi mở
    switchCustomerTab("overview");
  } else {
    customerLoginForm.classList.remove("hidden");
    customerPanel.classList.add("hidden");
    customerLoginError.classList.add("hidden");
  }
  customerModal.classList.remove("hidden");
  customerModal.classList.add("flex");
}

function closeCustomerModal() {
  customerModal.classList.add("hidden");
  customerModal.classList.remove("flex");
}

// ── Tab "Tổng quan" / "Đơn đã mua" trong tài khoản khách ──

document.querySelectorAll("[data-customer-tab]").forEach((btn) =>
  btn.addEventListener("click", () => switchCustomerTab(btn.dataset.customerTab))
);

function switchCustomerTab(tab) {
  document.querySelectorAll("[data-customer-tab]").forEach((btn) => {
    const on = btn.dataset.customerTab === tab;
    btn.classList.toggle("border-ink", on);
    btn.classList.toggle("text-ink", on);
    btn.classList.toggle("border-transparent", !on);
    btn.classList.toggle("text-ash", !on);
  });
  document.getElementById("customer-tab-overview").classList.toggle("hidden", tab !== "overview");
  document.getElementById("customer-tab-orders").classList.toggle("hidden", tab !== "orders");
  if (tab === "orders") loadCustomerOrders();
}

async function loadCustomerOrders() {
  const box = document.getElementById("customer-tab-orders");
  if (!currentCustomer) return;
  box.innerHTML = `
    <div class="space-y-3">
      <div class="skeleton h-24 w-full rounded-lg"></div>
      <div class="skeleton h-24 w-full rounded-lg"></div>
      <div class="skeleton h-24 w-full rounded-lg"></div>
    </div>`;

  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("customer_phone", currentCustomer.phone)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    box.innerHTML = `<p class="py-8 text-center text-sm text-red-600">Lỗi tải đơn hàng: ${error.message}</p>`;
    return;
  }

  if (!data || !data.length) {
    box.innerHTML = `<p class="py-8 text-center text-sm text-ash">Bạn chưa có đơn hàng nào.</p>`;
    return;
  }

  box.innerHTML = data
    .map((o) => {
      const items = Array.isArray(o.items) ? o.items : [];
      const st = orderStatusBadge(o.status);
      const time = formatDateTimeLong(o.created_at);
      return `
        <div class="border border-earth/40 p-4">
          <div class="flex items-center justify-between">
            <span class="font-medium text-ink">${o.order_code}</span>
            <span class="${st.cls} px-2 py-0.5 text-[10px] font-medium text-white">${st.text}</span>
          </div>
          <p class="mt-1 text-xs text-ash">${time}</p>
          <div class="mt-3 space-y-0.5 text-sm text-ink">
            ${items
              .map(
                (i) =>
                  `<div class="flex justify-between"><span>${i.name} ×${i.qty}${i.note ? ` <span class="text-ash">(${i.note})</span>` : ""}</span><span class="text-ash">${formatPrice(i.price * i.qty)}</span></div>`
              )
              .join("")}
          </div>
          <div class="mt-2 flex justify-between border-t border-dashed border-earth pt-2 text-sm font-medium text-ink">
            <span>Tổng</span><span>${formatPrice(o.total)}</span>
          </div>
        </div>
      `;
    })
    .join("");
}

function updateAccountLabel() {
  const label = document.getElementById("account-label");
  if (currentCustomer) {
    label.textContent = currentCustomer.name || "Tài khoản";
  } else {
    label.textContent = "Đăng nhập";
  }
  updateLoyaltyHint();
}

// Ribbon ở hero mời khách chưa đăng nhập tham gia tích điểm. Ẩn khi đã đăng nhập
// hoặc khi khách tự đóng (nhớ qua localStorage để không phiền lại).
function updateLoyaltyHint() {
  const hint = document.getElementById("hero-loyalty-hint");
  if (!hint) return;
  const dismissed = localStorage.getItem("nomnom_hide_loyalty_hint") === "1";
  const show = !currentCustomer && !dismissed;
  hint.classList.toggle("hidden", !show);
  hint.classList.toggle("flex", show);
  if (show) {
    document.getElementById("hero-loyalty-cycle").textContent = rewardConfig.cycle;
    document.getElementById("hero-loyalty-percent").textContent = `${rewardConfig.percent}%`;
  }
}

document.getElementById("hero-loyalty-close")?.addEventListener("click", () => {
  localStorage.setItem("nomnom_hide_loyalty_hint", "1");
  updateLoyaltyHint();
});
document.getElementById("hero-loyalty-login")?.addEventListener("click", openCustomerModal);

function renderCustomerPanel() {
  const c = currentCustomer;
  const avImg = document.getElementById("customer-avatar-img");
  const avLetter = document.getElementById("customer-avatar-letter");
  if (c.avatar_url) {
    avImg.src = c.avatar_url;
    avImg.style.display = "block";
    avLetter.style.display = "none";
  } else {
    avImg.style.display = "none";
    avLetter.style.display = "block";
    avLetter.textContent = (c.name || c.phone || "?").charAt(0).toUpperCase();
  }
  document.getElementById("customer-name-display").textContent = c.name || "Khách nomnom";
  document.getElementById("customer-phone-display").textContent = c.phone;
  document.getElementById("customer-points").textContent = c.points || 0;

  const cycle = rewardConfig.cycle;
  const intoCycle = (c.points || 0) % cycle;
  const remain = cycle - intoCycle;
  document.getElementById("customer-progress").style.width = `${(intoCycle / cycle) * 100}%`;
  document.getElementById("customer-progress-text").textContent =
    `Còn ${remain} đơn nữa để nhận ưu đãi giảm ${rewardConfig.percent}%`;

  const vouchers = availableVouchers(c);
  const voucherBox = document.getElementById("customer-voucher");
  if (vouchers > 0) {
    voucherBox.classList.remove("hidden");
    document.getElementById("customer-voucher-text").textContent =
      `${vouchers} ưu đãi giảm ${rewardConfig.percent}% — tự áp dụng khi thanh toán.`;
  } else {
    voucherBox.classList.add("hidden");
  }

  document.getElementById("customer-edit-name").value = c.name || "";
  document.getElementById("customer-edit-address").value = c.address || "";
}

async function refreshCustomerData() {
  if (!currentCustomer) return;
  // hồ sơ (tên/địa chỉ/avatar)
  const { data } = await supabase
    .from("customers")
    .select("*")
    .eq("phone", currentCustomer.phone)
    .maybeSingle();
  if (data) currentCustomer = { ...currentCustomer, ...data };

  // điểm tính động từ đơn đã thanh toán/đã giao — đúng với MỌI cách thanh toán
  const { data: stats } = await supabase.rpc("customer_stats", {
    p_phone: currentCustomer.phone,
  });
  if (stats && stats.length) {
    currentCustomer.points = stats[0].points || 0;
    currentCustomer.vouchers_used = stats[0].vouchers_used || 0;
  }

  localStorage.setItem("nomnom_customer", JSON.stringify(currentCustomer));
  updateAccountLabel();
  if (!customerPanel.classList.contains("hidden")) renderCustomerPanel();
}

// ── Đồng bộ giỏ hàng theo tài khoản (đăng nhập lại / đổi thiết bị vẫn còn giỏ) ──

async function pushCartToAccount(phone) {
  await supabase.from("customers").update({ cart }).eq("phone", phone);
}

async function syncCartWithAccount(customer) {
  const { data } = await supabase.from("customers").select("cart").eq("phone", customer.phone).maybeSingle();
  const remoteCart = Array.isArray(data?.cart) ? data.cart : [];

  if (remoteCart.length && !cart.length) {
    // Máy này chưa có gì trong giỏ — lấy lại giỏ đã lưu từ tài khoản
    cart = remoteCart;
  } else if (cart.length && remoteCart.length) {
    // Cả máy và tài khoản đều có hàng — gộp lại, không mất món của bên nào
    remoteCart.forEach((rItem) => {
      const local = cart.find((i) => i.id === rItem.id);
      if (local) local.qty += rItem.qty;
      else cart.push(rItem);
    });
  }

  saveCart(); // currentCustomer đã được gán trước khi gọi hàm này nên sẽ tự đẩy giỏ đã gộp lên tài khoản
}

document.getElementById("account-btn").addEventListener("click", openCustomerModal);
document.getElementById("customer-login-cancel").addEventListener("click", closeCustomerModal);
document.getElementById("customer-panel-close").addEventListener("click", closeCustomerModal);
customerModal.addEventListener("click", (e) => {
  if (e.target === customerModal) closeCustomerModal();
});

customerLoginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const phone = customerLoginForm.elements.phone.value.trim();
  const name = customerLoginForm.elements.name.value.trim();
  const address = customerLoginForm.elements.address.value.trim();

  if (!/^[0-9]{8,12}$/.test(phone)) {
    customerLoginError.textContent = "Số điện thoại không hợp lệ.";
    customerLoginError.classList.remove("hidden");
    return;
  }

  const { data: existing } = await supabase
    .from("customers")
    .select("*")
    .eq("phone", phone)
    .maybeSingle();

  let customer;
  if (existing) {
    // cập nhật tên/địa chỉ nếu khách nhập mới
    const patch = {};
    if (name) patch.name = name;
    if (address) patch.address = address;
    if (Object.keys(patch).length) {
      const { data: upd } = await supabase
        .from("customers").update(patch).eq("phone", phone).select().maybeSingle();
      customer = upd || { ...existing, ...patch };
    } else {
      customer = existing;
    }
  } else {
    const { data: created, error } = await supabase
      .from("customers")
      .insert({ phone, name: name || null, address: address || null, points: 0, vouchers_used: 0 })
      .select()
      .maybeSingle();
    if (error) {
      customerLoginError.textContent = "Lỗi: " + error.message;
      customerLoginError.classList.remove("hidden");
      return;
    }
    customer = created;
  }

  currentCustomer = customer;
  localStorage.setItem("nomnom_customer", JSON.stringify(customer));
  updateAccountLabel();
  customerLoginForm.reset();
  openCustomerModal();
  await syncCartWithAccount(customer);
  restartChatWatcher();
  startPresence();
});

document.getElementById("customer-save").addEventListener("click", async () => {
  if (!currentCustomer) return;
  const name = document.getElementById("customer-edit-name").value.trim();
  const address = document.getElementById("customer-edit-address").value.trim();
  const { data } = await supabase
    .from("customers")
    .update({ name: name || null, address: address || null })
    .eq("phone", currentCustomer.phone)
    .select()
    .maybeSingle();
  if (data) {
    currentCustomer = data;
    localStorage.setItem("nomnom_customer", JSON.stringify(data));
    updateAccountLabel();
    renderCustomerPanel();
  }
});

document.getElementById("customer-logout").addEventListener("click", () => {
  currentCustomer = null;
  localStorage.removeItem("nomnom_customer");
  updateAccountLabel();
  closeCustomerModal();
  restartChatWatcher();
  startPresence();
});

// ── Ảnh đại diện: bấm chọn / kéo-thả để upload ──
const avatarBtn = document.getElementById("customer-avatar");
const avatarInput = document.getElementById("customer-avatar-input");

avatarBtn.addEventListener("click", () => avatarInput.click());
avatarInput.addEventListener("change", () => {
  if (avatarInput.files[0]) uploadAvatar(avatarInput.files[0]);
  avatarInput.value = "";
});
["dragenter", "dragover"].forEach((ev) =>
  avatarBtn.addEventListener(ev, (e) => {
    e.preventDefault();
    avatarBtn.classList.add("ring-2", "ring-ink");
  })
);
["dragleave", "drop"].forEach((ev) =>
  avatarBtn.addEventListener(ev, (e) => {
    e.preventDefault();
    avatarBtn.classList.remove("ring-2", "ring-ink");
  })
);
avatarBtn.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) uploadAvatar(f);
});

async function uploadAvatar(file) {
  if (!currentCustomer || !file.type.startsWith("image/")) return;
  file = await compressImage(file, { maxDim: 400 }); // avatar nhỏ nên nén mạnh hơn
  const ext = file.name.split(".").pop();
  const name = `avatar-${currentCustomer.phone}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from("product-images")
    .upload(name, file, { upsert: true });
  if (error) {
    alert("Lỗi tải ảnh: " + error.message);
    return;
  }
  const { data: url } = supabase.storage.from("product-images").getPublicUrl(name);
  const { data } = await supabase
    .from("customers")
    .update({ avatar_url: url.publicUrl })
    .eq("phone", currentCustomer.phone)
    .select()
    .maybeSingle();
  if (data) {
    currentCustomer = { ...currentCustomer, ...data };
    localStorage.setItem("nomnom_customer", JSON.stringify(currentCustomer));
    renderCustomerPanel();
  }
}

// ── Chat trực tiếp với shop ──

const chatFab = document.getElementById("chat-fab");
const chatPanel = document.getElementById("chat-panel");
const chatMessagesBox = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

let chatChannel = null;
let chatMessageCache = [];
let chatUnreadCount = 0;
let chatIdleTimer = null;
let chatTypingHideTimer = null;
let chatTypingSendThrottle = null;

function getChatConversationId() {
  if (currentCustomer) return currentCustomer.phone;
  let guestId = localStorage.getItem("nomnom_chat_guest_id");
  if (!guestId) {
    guestId = "guest-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("nomnom_chat_guest_id", guestId);
  }
  return guestId;
}

function getChatDisplayName() {
  return (currentCustomer && (currentCustomer.name || currentCustomer.phone)) || "Khách vãng lai";
}

function updateChatBadge() {
  const badge = document.getElementById("chat-fab-badge");
  if (!badge) return;
  badge.textContent = chatUnreadCount;
  badge.classList.toggle("hidden", chatUnreadCount === 0);
}

const CHAT_SHOP_AVATAR_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>`;

function renderChatMessages(messages) {
  if (!messages.length) {
    chatMessagesBox.innerHTML = `<p class="py-6 text-center text-xs text-ash">Nhắn gì đó cho nomnom nhé!</p>`;
  } else {
    chatMessagesBox.innerHTML = messages
      .map((m) => {
        const mine = m.sender === "customer";
        return `
          <div class="flex ${mine ? "justify-end" : "justify-start"}">
            <div class="max-w-[80%] rounded-2xl px-3 py-2 ${mine ? "bg-ink text-white" : "border border-earth/40 bg-white text-ink"}">
              <p class="whitespace-pre-wrap break-words text-sm">${escapeHtml(m.message)}</p>
            </div>
          </div>
        `;
      })
      .join("");
  }
  chatMessagesBox.insertAdjacentHTML("beforeend", `<div id="chat-status-row" class="mt-1"></div>`);
  chatMessagesBox.scrollTop = chatMessagesBox.scrollHeight;
  scheduleChatIdleTimestamp(messages[messages.length - 1]);
}

function setChatStatusRow(html) {
  const row = document.getElementById("chat-status-row");
  if (row) row.innerHTML = html;
  chatMessagesBox.scrollTop = chatMessagesBox.scrollHeight;
}

function scheduleChatIdleTimestamp(lastMessage) {
  clearTimeout(chatIdleTimer);
  setChatStatusRow("");
  if (!lastMessage) return;
  chatIdleTimer = setTimeout(() => {
    setChatStatusRow(`<p class="px-1 pt-1 text-center text-[10px] text-ash">${formatDateTime(lastMessage.created_at)}</p>`);
  }, 15000);
}

function showShopTypingIndicator() {
  clearTimeout(chatIdleTimer);
  clearTimeout(chatTypingHideTimer);
  setChatStatusRow(`
    <div class="flex items-end justify-start gap-2">
      <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-earth/40 text-ash">${CHAT_SHOP_AVATAR_SVG}</div>
      <div class="flex items-center gap-1 rounded-2xl border border-earth/40 bg-white px-3 py-2.5">
        <span class="chat-typing-dot"></span><span class="chat-typing-dot"></span><span class="chat-typing-dot"></span>
      </div>
    </div>
  `);
  chatTypingHideTimer = setTimeout(() => {
    scheduleChatIdleTimestamp(chatMessageCache[chatMessageCache.length - 1]);
  }, 3000);
}

async function loadChatHistory() {
  const conversationId = getChatConversationId();
  chatMessagesBox.innerHTML = `<div class="space-y-2 px-1">${chatThreadSkeletonHtml()}</div>`;
  const { data, error } = await supabase
    .from("chat_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) {
    chatMessagesBox.innerHTML = `<p class="py-6 text-center text-xs text-red-600">Lỗi tải tin nhắn: ${error.message}</p>`;
    return;
  }
  chatMessageCache = data || [];
  renderChatMessages(chatMessageCache);
}

function restartChatWatcher() {
  if (chatChannel) {
    supabase.removeChannel(chatChannel);
    chatChannel = null;
  }
  chatMessageCache = [];
  chatUnreadCount = 0;
  updateChatBadge();

  const conversationId = getChatConversationId();
  chatChannel = supabase
    .channel(`chat-${conversationId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "chat_messages", filter: `conversation_id=eq.${conversationId}` },
      (payload) => {
        chatMessageCache.push(payload.new);
        if (!chatPanel.classList.contains("hidden")) {
          renderChatMessages(chatMessageCache);
        } else if (payload.new.sender === "shop") {
          chatUnreadCount++;
          updateChatBadge();
        }
      }
    )
    .on("broadcast", { event: "typing" }, (payload) => {
      if (payload.payload?.sender === "shop" && !chatPanel.classList.contains("hidden")) {
        showShopTypingIndicator();
      }
    })
    .subscribe();

  if (!chatPanel.classList.contains("hidden")) loadChatHistory();
}

function openChat() {
  chatPanel.classList.remove("hidden");
  chatPanel.classList.add("flex");
  if (isAdmin) return; // dữ liệu bảng tin nhắn admin đã tự cập nhật realtime sẵn, không cần tải lại
  chatUnreadCount = 0;
  updateChatBadge();
  loadChatHistory();
}

function closeChat() {
  chatPanel.classList.add("hidden");
  chatPanel.classList.remove("flex");
}

chatFab.addEventListener("click", openChat);
document.getElementById("chat-close").addEventListener("click", closeChat);

chatInput.addEventListener("input", () => {
  if (!chatChannel || chatTypingSendThrottle) return;
  chatChannel.send({ type: "broadcast", event: "typing", payload: { sender: "customer" } });
  chatTypingSendThrottle = setTimeout(() => { chatTypingSendThrottle = null; }, 2000);
});

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";
  const isFirstMessage = chatMessageCache.length === 0;
  const conversationId = getChatConversationId();

  const { error } = await supabase.from("chat_messages").insert({
    conversation_id: conversationId,
    customer_name: getChatDisplayName(),
    sender: "customer",
    message: text,
  });
  if (error) {
    alert("Lỗi gửi tin nhắn: " + error.message);
    return;
  }

  // Tin nhắn lần đầu của khách trong hội thoại này — tự gửi câu trả lời đã cấu hình (nếu có)
  if (isFirstMessage && chatAutoReply) {
    await supabase.from("chat_messages").insert({
      conversation_id: conversationId,
      customer_name: "nomnom",
      sender: "shop",
      message: chatAutoReply,
    });
  }
});

// ── Trạng thái online/offline của shop (Supabase Realtime Presence — không tốn DB
// cho phần "đang online", chỉ ghi nhẹ heartbeat để biết "lần cuối hoạt động" khi
// shop đã offline) ──

let presenceChannel = null;
let presenceHeartbeatTimer = null;

async function updateShopStatusUI(state) {
  const statusEl = document.getElementById("chat-shop-status");
  if (!statusEl) return;
  const shopOnline = !!(state["shop"] && state["shop"].length);
  if (shopOnline) {
    statusEl.textContent = "● nomnom đang online";
    statusEl.className = "text-xs text-[#34C759]";
    return;
  }
  const lastSeen = await fetchLastSeen("shop");
  statusEl.textContent = lastSeen ? timeAgo(lastSeen) : "Chưa từng online";
  statusEl.className = "text-xs text-ash";
}

function startPresence() {
  if (presenceChannel) {
    supabase.removeChannel(presenceChannel);
    presenceChannel = null;
  }
  if (presenceHeartbeatTimer) clearInterval(presenceHeartbeatTimer);

  presenceChannel = joinPresence(getChatConversationId(), updateShopStatusUI);
  presenceHeartbeatTimer = startHeartbeatLoop(getChatConversationId);
}

startPresence();

// ── Bảng quản lý tin nhắn nổi (khi cô chủ đăng nhập admin trên trang chính) ──
// Cùng 1 khung chat nổi: khách thường thấy "Chat với nomnom" (1-1 với shop), cô chủ
// đăng nhập admin thì tự chuyển thành bảng kiểu Messenger — danh sách hội thoại bên
// trái, nội dung bên phải (mobile: list trước, bấm vào mới sang nội dung, có nút back).

const ADMIN_CHAT_CACHE_KEY = "nomnom_storefront_chat_cache";

let adminChatConversations = [];
let adminChatActiveId = null;
let adminChatOnlineIds = new Set();
let adminChatLastSeenMap = new Map();
let adminChatRealtimeChannel = null;
let adminChatPresenceChannel = null;
let adminChatPresenceHeartbeat = null;

const chatPanelTitleEl = document.getElementById("chat-panel-title");
const chatCustomerViewEl = document.getElementById("chat-customer-view");
const chatAdminViewEl = document.getElementById("chat-admin-view");
const chatAdminListPaneEl = document.getElementById("chat-admin-list-pane");
const chatAdminThreadPaneEl = document.getElementById("chat-admin-thread-pane");
const chatAdminConversationsEl = document.getElementById("chat-admin-conversations");
const chatAdminThreadTitleEl = document.getElementById("chat-admin-thread-title");
const chatAdminThreadSubtitleEl = document.getElementById("chat-admin-thread-subtitle");
const chatAdminThreadMessagesEl = document.getElementById("chat-admin-thread-messages");
const chatAdminReplyForm = document.getElementById("chat-admin-reply-form");
const chatAdminReplyInput = document.getElementById("chat-admin-reply-input");

function setChatAdminMode(adminMode) {
  if (adminMode) {
    chatPanelTitleEl.textContent = "Tin nhắn khách hàng";
    chatCustomerViewEl.classList.add("hidden");
    chatAdminViewEl.classList.remove("hidden");
    chatAdminViewEl.classList.add("flex");
    chatPanel.classList.remove("max-w-sm", "h-[70vh]", "max-h-[560px]");
    chatPanel.classList.add("max-w-2xl", "h-[78vh]", "max-h-[640px]");
    if (chatChannel) { supabase.removeChannel(chatChannel); chatChannel = null; }
    if (presenceChannel) { supabase.removeChannel(presenceChannel); presenceChannel = null; }
    if (presenceHeartbeatTimer) { clearInterval(presenceHeartbeatTimer); presenceHeartbeatTimer = null; }
    startAdminChatPanel();
  } else {
    chatPanelTitleEl.textContent = "Chat với nomnom";
    chatAdminViewEl.classList.add("hidden");
    chatAdminViewEl.classList.remove("flex");
    chatCustomerViewEl.classList.remove("hidden");
    chatPanel.classList.remove("max-w-2xl", "h-[78vh]", "max-h-[640px]");
    chatPanel.classList.add("max-w-sm", "h-[70vh]", "max-h-[560px]");
    stopAdminChatPanel();
    restartChatWatcher();
    startPresence();
  }
}

function hydrateAdminChatCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(ADMIN_CHAT_CACHE_KEY) || "null");
    if (cached && Array.isArray(cached.conversations)) {
      adminChatConversations = cached.conversations;
      return true;
    }
  } catch (e) {
    // cache hỏng thì bỏ qua, tải mới như bình thường
  }
  return false;
}

function saveAdminChatCache() {
  try {
    localStorage.setItem(ADMIN_CHAT_CACHE_KEY, JSON.stringify({ conversations: adminChatConversations }));
  } catch (e) {
    // hết dung lượng localStorage thì bỏ qua
  }
}

function updateAdminChatBadge() {
  const total = adminChatConversations.reduce((sum, c) => sum + c.unread, 0);
  const badge = document.getElementById("chat-fab-badge");
  if (!badge) return;
  badge.textContent = total;
  badge.classList.toggle("hidden", total === 0);
}

function adminChatOnlineStatusText(conversationId) {
  if (adminChatOnlineIds.has(conversationId)) return "Đang online";
  const lastSeen = adminChatLastSeenMap.get(conversationId);
  return lastSeen ? timeAgo(lastSeen) : "";
}

function renderAdminChatConversations() {
  if (!adminChatConversations.length) {
    chatAdminConversationsEl.innerHTML = `<p class="py-8 text-center text-xs text-ash">Chưa có tin nhắn nào.</p>`;
    return;
  }
  chatAdminConversationsEl.innerHTML = adminChatConversations
    .map((c) => {
      const online = adminChatOnlineIds.has(c.conversationId);
      const statusText = adminChatOnlineStatusText(c.conversationId);
      return `
      <button type="button" data-conversation="${c.conversationId}"
        class="flex w-full items-start gap-3 border-b border-earth/15 px-3 py-2.5 text-left transition-colors ${c.conversationId === adminChatActiveId ? "bg-earth/10" : "bg-white hover:bg-earth/5"}">
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

  chatAdminConversationsEl.querySelectorAll("[data-conversation]").forEach((btn) =>
    btn.addEventListener("click", () => openAdminChatThread(btn.dataset.conversation))
  );
}

async function loadAdminChatConversations() {
  const hasCache = hydrateAdminChatCache();
  if (hasCache) {
    renderAdminChatConversations();
    updateAdminChatBadge();
  }

  const { data, error } = await supabase
    .from("chat_messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) {
    if (!hasCache) chatAdminConversationsEl.innerHTML = `<p class="py-8 text-center text-xs text-red-600">Lỗi: ${escapeHtml(error.message)}</p>`;
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

  adminChatConversations = [...map.values()].sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
  saveAdminChatCache();
  updateAdminChatBadge();
  renderAdminChatConversations();

  adminChatLastSeenMap = await fetchAllLastSeen();
  renderAdminChatConversations();
}

function showAdminChatThreadPane() {
  chatAdminListPaneEl.classList.add("hidden");
  chatAdminListPaneEl.classList.remove("flex");
  chatAdminThreadPaneEl.classList.remove("hidden");
  chatAdminThreadPaneEl.classList.add("flex");
}

function showAdminChatListPane() {
  chatAdminThreadPaneEl.classList.add("hidden");
  chatAdminThreadPaneEl.classList.remove("flex");
  chatAdminListPaneEl.classList.remove("hidden");
  chatAdminListPaneEl.classList.add("flex");
}

document.getElementById("chat-admin-back").addEventListener("click", showAdminChatListPane);

async function openAdminChatThread(conversationId) {
  adminChatActiveId = conversationId;
  renderAdminChatConversations();
  showAdminChatThreadPane();

  const conv = adminChatConversations.find((c) => c.conversationId === conversationId);
  chatAdminThreadTitleEl.textContent = (conv && conv.customerName) || conversationId;
  const online = adminChatOnlineIds.has(conversationId);
  chatAdminThreadSubtitleEl.textContent = adminChatOnlineStatusText(conversationId) || "Khách chưa từng online";
  chatAdminThreadSubtitleEl.className = online ? "truncate text-xs font-medium text-[#34C759]" : "truncate text-xs text-ash";

  chatAdminThreadMessagesEl.innerHTML = `<div class="space-y-2">${chatThreadSkeletonHtml()}</div>`;
  chatAdminReplyForm.classList.remove("hidden");
  chatAdminReplyForm.classList.add("flex");

  const { data, error } = await supabase
    .from("chat_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(300);

  if (error) {
    chatAdminThreadMessagesEl.innerHTML = `<p class="py-6 text-center text-xs text-red-600">Lỗi: ${escapeHtml(error.message)}</p>`;
    return;
  }

  chatAdminThreadMessagesEl.innerHTML = data && data.length
    ? data.map((m) => chatBubbleHtml(m, m.sender === "shop")).join("")
    : `<p class="py-6 text-center text-xs text-ash">Chưa có tin nhắn.</p>`;
  chatAdminThreadMessagesEl.scrollTop = chatAdminThreadMessagesEl.scrollHeight;

  await supabase
    .from("chat_messages")
    .update({ read_by_admin: true })
    .eq("conversation_id", conversationId)
    .eq("sender", "customer")
    .eq("read_by_admin", false);

  if (conv) conv.unread = 0;
  saveAdminChatCache();
  updateAdminChatBadge();
  renderAdminChatConversations();
}

chatAdminReplyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!adminChatActiveId) return;
  const text = chatAdminReplyInput.value.trim();
  if (!text) return;
  chatAdminReplyInput.value = "";
  const { error } = await supabase.from("chat_messages").insert({
    conversation_id: adminChatActiveId,
    customer_name: "nomnom",
    sender: "shop",
    message: text,
  });
  if (error) alert("Lỗi gửi tin nhắn: " + error.message);
});

function handleAdminChatIncoming(message) {
  let conv = adminChatConversations.find((c) => c.conversationId === message.conversation_id);
  if (!conv) {
    conv = { conversationId: message.conversation_id, customerName: null, lastMessage: "", lastTime: message.created_at, unread: 0 };
    adminChatConversations.unshift(conv);
  }
  if (message.sender === "customer") conv.customerName = message.customer_name;
  conv.lastMessage = message.message;
  conv.lastTime = message.created_at;

  if (adminChatActiveId === message.conversation_id) {
    chatAdminThreadMessagesEl.insertAdjacentHTML("beforeend", chatBubbleHtml(message, message.sender === "shop"));
    chatAdminThreadMessagesEl.scrollTop = chatAdminThreadMessagesEl.scrollHeight;
    if (message.sender === "customer") {
      supabase.from("chat_messages").update({ read_by_admin: true }).eq("id", message.id).then(() => {});
    }
  } else if (message.sender === "customer") {
    conv.unread++;
  }

  adminChatConversations.sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
  saveAdminChatCache();
  updateAdminChatBadge();
  renderAdminChatConversations();
}

function startAdminChatPanel() {
  showAdminChatListPane();
  loadAdminChatConversations();

  adminChatRealtimeChannel = supabase
    .channel("storefront-admin-chat-changes")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (payload) => handleAdminChatIncoming(payload.new))
    .subscribe();

  adminChatPresenceChannel = joinPresence("shop", (state) => {
    adminChatOnlineIds = new Set(Object.keys(state).filter((key) => key !== "shop"));
    renderAdminChatConversations();
  });
  adminChatPresenceHeartbeat = startHeartbeatLoop(() => "shop");
}

function stopAdminChatPanel() {
  if (adminChatRealtimeChannel) { supabase.removeChannel(adminChatRealtimeChannel); adminChatRealtimeChannel = null; }
  if (adminChatPresenceChannel) { supabase.removeChannel(adminChatPresenceChannel); adminChatPresenceChannel = null; }
  if (adminChatPresenceHeartbeat) { clearInterval(adminChatPresenceHeartbeat); adminChatPresenceHeartbeat = null; }
  adminChatActiveId = null;
}

// ── Reveal on scroll (fade + slide) — lặp lại mỗi lần vào tầm nhìn ──

// reload luôn về đầu trang để hiệu ứng chạy lại từ đầu
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting && entry.intersectionRatio >= 0.15) {
        // Vào tầm nhìn (≥15%) → chạy animation
        entry.target.classList.add("in-view");
      } else if (!entry.isIntersecting && entry.boundingClientRect.top > 0) {
        // CHỈ reset khi phần tử đã ra hẳn phía DƯỚI viewport (do cuộn lên).
        // Khi nó trôi lên trên mép (top <= 0) thì GIỮ nguyên — tránh vòng lặp
        // transform đẩy phần tử nhỏ vào lại tầm nhìn gây nháy liên tục.
        entry.target.classList.remove("in-view");
      }
    });
  },
  { threshold: [0, 0.15] }
);

document.querySelectorAll(".reveal").forEach((el) => revealObserver.observe(el));

// ── Init ──

updateCartCount();
updateAccountLabel();
if (currentCustomer) syncCartWithAccount(currentCustomer);
restartChatWatcher();
loadProducts();
loadHeroSlides();
loadBanners();
loadContactSettings();
loadReviews();
