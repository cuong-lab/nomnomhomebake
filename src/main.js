import "./style.css";
import { supabase } from "./supabase.js";
import { formatCurrency, formatPrice, formatDateTimeLong, formatDateTime, escapeHtml } from "./shared/format.js";
import { ORDER_STATUS, updateOrderStatus, FULFILLMENT_STAGES, updateFulfillmentStage, computeFulfillmentLog, notifyCustomerStage } from "./shared/orderStatus.js";
import { compressImage } from "./shared/imageUtils.js";
import { state, DEFAULT_TIERS } from "./store.js";
import { initReviews, loadReviews } from "./storefront/reviews.js";
import { initHero, loadHeroSlides } from "./storefront/hero.js";
import { initChat, restartChatWatcher, startPresence, setChatAdminMode, openCustomerChat } from "./storefront/chat.js";
import { tierHeroHtml, activateLadders, voucherCardHtml, coVoucherHtml } from "./storefront/vouchers.js";
import { initAnalytics } from "./storefront/analytics.js";

const yearEl = document.querySelector("[data-year]");
if (yearEl) yearEl.textContent = new Date().getFullYear();

let cart = JSON.parse(localStorage.getItem("nomnom-cart") || "[]");
let appliedVoucherPercent = 0;   // tổng % của các voucher đang chọn ở checkout
let appliedDiscount = 0;         // số tiền giảm THỰC (đã chặn trần) ở checkout
let checkoutVouchers = [];       // pool voucher hiện ở checkout = kho khách + mã nhập tay
let selectedVoucherCodes = [];   // mã voucher đang chọn (tối đa maxVouchersPerOrder)

function saveCart() {
  localStorage.setItem("nomnom-cart", JSON.stringify(cart));
  updateCartCount();
  // localStorage + UI cập nhật tức thì; ghi DB thì debounce (xem schedulePushCart).
  if (state.currentCustomer) schedulePushCart(state.currentCustomer.phone);
}

function updateCartCount() {
  const total = cart.reduce((sum, item) => sum + item.qty, 0);
  document.getElementById("cart-count").textContent = `Giỏ hàng (${total})`;
  document.getElementById("cart-count-mobile").textContent = total;
  const miniCount = document.getElementById("mini-cart-count");
  if (miniCount) miniCount.textContent = `Giỏ hàng (${total})`;
  const fc = document.getElementById("floating-cart-count");
  if (fc) fc.textContent = total;
  const fb = document.getElementById("floating-cart");
  if (fb) {
    const show = window.scrollY > 200 && total > 0 && !state.isAdmin;
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
  const show = window.scrollY > 200 && cart.length > 0 && !state.isAdmin;
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
  document.body.classList.add("overflow-hidden"); // khoá cuộn trang nền khi mở giỏ
  renderCart();
}

function closeCart() {
  cartDrawer.classList.remove("cart-open");
  cartOverlay.classList.add("hidden");
  document.body.classList.remove("overflow-hidden");
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
  if (state.freeShipThreshold > 0) {
    fsBar.classList.remove("hidden");
    const fsText = document.getElementById("freeship-text");
    const fsFill = document.getElementById("freeship-fill");
    const truckSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="inline-block align-text-bottom"><path d="M5 18H3c-.6 0-1-.4-1-1V7c0-.6.4-1 1-1h10c.6 0 1 .4 1 1v11"/><path d="M14 9h4l4 4v4c0 .6-.4 1-1 1h-2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>`;
    const checkSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="inline-block align-text-bottom"><path d="M20 6 9 17l-5-5"/></svg>`;
    if (total >= state.freeShipThreshold) {
      fsText.innerHTML = `${checkSvg} Bạn được <b>miễn phí ship</b>!`;
      fsFill.style.width = "100%";
    } else {
      const remain = state.freeShipThreshold - total;
      fsText.innerHTML = `${truckSvg} Mua thêm <b>${formatPrice(remain)}</b> để được <b>miễn phí ship</b>`;
      fsFill.style.width = `${Math.round((total / state.freeShipThreshold) * 100)}%`;
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

const cartCustomer = document.getElementById("cart-customer");
const custError = document.getElementById("cust-error");

document.getElementById("cart-checkout-step").addEventListener("click", () => {
  flushPushCart(); // đảm bảo giỏ mới nhất đã lên tài khoản trước khi thanh toán
  // không cho chọn ngày trong quá khứ
  document.getElementById("cust-date").min = new Date().toISOString().split("T")[0];
  cartItems.classList.add("hidden");
  cartFooter.classList.add("hidden");
  cartCustomer.classList.remove("hidden");

  // Tự điền sẵn thông tin nếu khách đã đăng nhập
  if (state.currentCustomer) {
    const nameEl = document.getElementById("cust-name");
    const phoneEl = document.getElementById("cust-phone");
    const addrEl = document.getElementById("cust-address");
    if (!nameEl.value) nameEl.value = state.currentCustomer.name || "";
    if (!phoneEl.value) phoneEl.value = state.currentCustomer.phone || "";
    if (!addrEl.value) addrEl.value = state.currentCustomer.address || "";
  }

  setupVoucherUI();
});

function setupVoucherUI() {
  // Pool voucher ở checkout = kho của khách (nếu đã đăng nhập). Khách vãng lai vẫn
  // nhập được mã bạn bè cho ở ô "Áp mã". Reset lựa chọn mỗi lần vào bước thanh toán.
  checkoutVouchers = (state.myVouchers || []).map((v) => ({ ...v }));
  selectedVoucherCodes = [];
  document.getElementById("voucher-section").classList.remove("hidden");
  const hint = document.getElementById("voucher-max-hint");
  if (hint) hint.textContent = `(chọn tối đa ${state.maxVouchersPerOrder || 2})`;
  const msg = document.getElementById("voucher-code-msg");
  msg.textContent = "";
  msg.classList.add("hidden");
  document.getElementById("voucher-code-input").value = "";
  renderVoucherList();
}

function renderVoucherList() {
  const box = document.getElementById("voucher-list");
  const maxPer = state.maxVouchersPerOrder || 2;
  if (!checkoutVouchers.length) {
    box.innerHTML = `<p class="text-xs text-ash">Chưa có voucher nào. Nhập mã bạn bè cho ở trên, hoặc lên hạng / đủ đơn để nhận.</p>`;
    renderCheckoutSummary();
    return;
  }
  box.innerHTML = checkoutVouchers
    .map((v) =>
      coVoucherHtml(v, {
        on: selectedVoucherCodes.includes(v.code),
        disabled: !selectedVoucherCodes.includes(v.code) && selectedVoucherCodes.length >= maxPer,
      })
    )
    .join("");
  box.querySelectorAll(".co-v").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      if (el.classList.contains("disabled")) return;
      const code = el.dataset.code;
      const i = selectedVoucherCodes.indexOf(code);
      if (i >= 0) selectedVoucherCodes.splice(i, 1);
      else selectedVoucherCodes.push(code);
      renderVoucherList();
    })
  );
  renderCheckoutSummary();
}

// Nhập mã tay (mã bạn bè cho): tra DB, nếu active & còn hạn thì thêm vào pool + tự chọn.
async function applyVoucherCode() {
  const input = document.getElementById("voucher-code-input");
  const msg = document.getElementById("voucher-code-msg");
  const code = input.value.trim().toUpperCase();
  const show = (text, ok) => {
    msg.textContent = text;
    msg.classList.remove("hidden");
    msg.classList.toggle("text-green-700", ok);
    msg.classList.toggle("text-[#7a0c1f]", !ok);
  };
  if (!code) return;
  if (checkoutVouchers.some((v) => v.code === code)) { show("Mã này đã có trong danh sách rồi.", false); return; }
  const { data } = await supabase
    .from("vouchers")
    .select("code, percent, source, status, expires_at")
    .eq("code", code)
    .maybeSingle();
  if (!data || data.status !== "active" || (data.expires_at && new Date(data.expires_at) < new Date())) {
    show("Mã không tồn tại, đã dùng hoặc đã hết hạn.", false);
    return;
  }
  checkoutVouchers.push({ code: data.code, percent: data.percent, source: data.source, expires_at: data.expires_at });
  if (selectedVoucherCodes.length < (state.maxVouchersPerOrder || 2)) selectedVoucherCodes.push(data.code);
  input.value = "";
  renderVoucherList();
  show(`✓ Đã thêm ${data.code} (−${data.percent}%).`, true);
}

function renderCheckoutSummary() {
  const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  const pct = selectedVoucherCodes.reduce((s, code) => {
    const v = checkoutVouchers.find((x) => x.code === code);
    return s + (v ? v.percent : 0);
  }, 0);
  const rawDiscount = Math.round((subtotal * pct) / 100);
  const cap = state.maxDiscountAmount || 0;
  const discount = cap > 0 ? Math.min(rawDiscount, cap) : rawDiscount;
  appliedVoucherPercent = pct;
  appliedDiscount = discount;
  const total = subtotal - discount;

  const summary = document.getElementById("checkout-summary");
  summary.classList.remove("hidden");
  document.getElementById("sum-subtotal").textContent = formatPrice(subtotal);
  document.getElementById("sum-total").textContent = formatPrice(total);
  const dRow = document.getElementById("sum-discount-row");
  if (discount > 0) {
    dRow.classList.remove("hidden");
    dRow.classList.add("flex");
    document.getElementById("sum-discount-label").textContent = `Ưu đãi (${pct}%)`;
    document.getElementById("sum-discount").textContent = "-" + formatPrice(discount);
  } else {
    dRow.classList.add("hidden");
    dRow.classList.remove("flex");
  }

  const capNote = document.getElementById("voucher-cap-note");
  if (cap > 0 && rawDiscount > cap) {
    capNote.classList.remove("hidden");
    capNote.innerHTML = `⚠️ ${pct}% của ${formatPrice(subtotal)} = <b>${formatPrice(rawDiscount)}</b>, nhưng trần giảm là <b>${formatPrice(cap)}</b> → chỉ giảm <b>${formatPrice(cap)}</b>.`;
  } else {
    capNote.classList.add("hidden");
  }
  return total;
}

document.getElementById("voucher-code-apply").addEventListener("click", applyVoucherCode);
document.getElementById("voucher-code-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); applyVoucherCode(); }
});

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

  if (!state.bankSettings.bank_id || !state.bankSettings.bank_account) {
    alert("Chủ shop chưa thiết lập thanh toán. Vui lòng liên hệ qua Zalo.");
    return;
  }

  const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  const voucherPercent = appliedVoucherPercent || 0;       // tổng % các voucher đang chọn
  const total = subtotal - (appliedDiscount || 0);          // đã chặn trần giảm
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

  // Đặt hàng xong → tự đăng nhập theo SĐT vừa nhập (không còn "khách vãng lai"): nhờ đó
  // nút "Theo dõi đơn hàng" ở màn thành công + tab "Đơn của tôi" hiển thị đúng đơn này.
  if (!state.currentCustomer) {
    const { customer } = await signInCustomer(custPhone, custName, custAddress);
    if (customer) {
      restartChatWatcher();
      startPresence();
    }
  }

  // Đánh dấu voucher đã dùng (RPC nguyên tử, chống double-spend). Voucher rời kho khách.
  if (selectedVoucherCodes.length) {
    await supabase.rpc("redeem_vouchers", { p_codes: selectedVoucherCodes, p_order_code: orderCode });
    if (state.currentCustomer) refreshCustomerData();
  }

  pendingOrderActive = true;

  const qrUrl = `https://img.vietqr.io/image/${state.bankSettings.bank_id}-${state.bankSettings.bank_account}-compact.jpg?amount=${total}&addInfo=${encodeURIComponent(content)}`;

  document.getElementById("qr-image").src = qrUrl;
  document.getElementById("qr-bank-name").textContent = state.bankSettings.bank_id;
  document.getElementById("qr-account").textContent = state.bankSettings.bank_account;
  document.getElementById("qr-holder").textContent = state.bankSettings.bank_name || "";
  document.getElementById("qr-amount").textContent = formatPrice(total);
  document.getElementById("qr-content").textContent = content;

  const qrZaloHelp = document.getElementById("qr-zalo-help");
  if (state.bankSettings.zalo_url) {
    qrZaloHelp.href = state.bankSettings.zalo_url;
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
  const successCode = lastOrderCode;

  // Thẻ theo dõi đơn (hoá đơn đầy đủ): tải đơn vừa đặt rồi render vào màn thành công.
  const tlBox = document.getElementById("success-timeline");
  if (tlBox) {
    tlBox.innerHTML = "";
    supabase
      .from("orders")
      .select("*")
      .eq("order_code", successCode)
      .maybeSingle()
      .then(({ data }) => {
        if (data) tlBox.innerHTML = orderCardHtml(data);
      });
  }

  document.getElementById("cart-success").classList.remove("hidden");

  appliedVoucherPercent = 0;
  appliedDiscount = 0;
  selectedVoucherCodes = [];
  checkoutVouchers = [];
  // cập nhật lại điểm tích lũy + kho voucher sau khi webhook đã cộng (đợi 1.5s cho chắc)
  if (state.currentCustomer) setTimeout(refreshCustomerData, 1500);
}

document.getElementById("success-close").addEventListener("click", () => {
  closeCart();
});

// "Theo dõi đơn hàng" ở màn thành công → đóng giỏ, mở tài khoản (đã tự đăng nhập sau
// khi đặt) và nhảy thẳng tới tab "Đơn của tôi" để xem timeline tiến trình.
document.getElementById("success-track").addEventListener("click", () => {
  closeCart();
  openCustomerModal();
  switchCustomerTab("tracking");
});

// Nút "Nhắn tin" trên thẻ theo dõi đơn: tự GỬI luôn "bill" tóm tắt vào chat để cô chủ
// đọc ngay đơn nào (khỏi phải vào trang quản lý tìm), rồi mở khung chat.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-chat-order]");
  if (!btn) return;
  const code = btn.dataset.chatOrder;
  const order = customerOrdersCache.find((o) => o.order_code === code);
  closeCart();
  closeCustomerModal();
  if (order && state.currentCustomer) {
    await supabase.from("chat_messages").insert({
      conversation_id: state.currentCustomer.phone,
      customer_name: state.currentCustomer.name || "Khách",
      sender: "customer",
      message: buildOrderBillText(order),
    });
  }
  openCustomerChat();
});

// "Bill" dạng chữ để gửi vào chat (cô chủ thấy ngay đơn nào mà không cần mở quản lý).
function buildOrderBillText(o) {
  const items = Array.isArray(o.items) ? o.items : [];
  const st = ORDER_STATUS[o.status];
  const lines = items.map((i) => `• ${i.qty}× ${i.name}${i.note ? ` (${i.note})` : ""} — ${formatPrice((i.price || 0) * (i.qty || 0))}`);
  return [
    `🧾 Cần hỗ trợ đơn ${o.order_code}`,
    ...lines,
    `Tổng: ${formatPrice(o.total || 0)}`,
    o.customer_address ? `📍 ${o.customer_address}` : "",
    st ? `Trạng thái: ${st.label}` : "",
  ].filter(Boolean).join("\n");
}

// Lịch sử đơn: bấm 1 dòng để bung/thu bill đầy đủ (render 1 lần rồi giữ).
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-order-toggle]");
  if (!btn) return;
  const code = btn.dataset.orderToggle;
  const detail = btn.parentElement.querySelector(`[data-order-detail="${code}"]`);
  if (!detail) return;
  const chevron = btn.querySelector(".chevron");
  if (detail.classList.contains("hidden")) {
    if (!detail.dataset.rendered) {
      const order = customerOrdersCache.find((o) => o.order_code === code);
      if (order) detail.innerHTML = orderCardHtml(order, { actions: "chat" });
      detail.dataset.rendered = "1";
    }
    detail.classList.remove("hidden");
    chevron?.classList.add("rotate-180");
  } else {
    detail.classList.add("hidden");
    chevron?.classList.remove("rotate-180");
  }
});

document.getElementById("qr-back").addEventListener("click", async () => {
  await cancelPendingOrder();
  document.getElementById("cart-qr").classList.add("hidden");
  cartItems.classList.remove("hidden");
  cartFooter.classList.remove("hidden");
  renderCart();
});

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
  if (state.isAdmin) {
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
  state.isAdmin = !!session;
  adminLogoutBtn.classList.toggle("hidden", !state.isAdmin);
  setAdminNavLink(adminNavLink, state.isAdmin);
  setAdminNavLink(adminMobileNavLink, state.isAdmin);
  adminOrdersBtn.classList.toggle("hidden", !state.isAdmin);
  // Tải dữ liệu SONG SONG trước; CHỈ khi tất cả xong mới bật realtime (chat + đơn hàng).
  // Bật realtime lúc query đang chạy làm thư viện Supabase deadlock (~10s, nặng khi admin
  // reload). Đây là nơi khởi động realtime + tải dữ liệu DUY NHẤT lúc vào trang.
  Promise.allSettled([loadProducts(), loadHeroSlides(), loadContactSettings(), loadReviews()]).then(() => {
    setChatAdminMode(state.isAdmin);
    if (state.isAdmin) {
      startAdminOrdersRealtime();
    } else {
      stopAdminOrdersRealtime();
      closeOrdersDrawer();
      adminOrdersBadge.classList.add("hidden");
    }
  });
});

// ── Products ──

let allProducts = [];
let activeCategory = "all";
let activePriceSort = "default";

const categoryTabs = document.getElementById("category-tabs");
const priceFilter = document.getElementById("price-filter");

// Layout sản phẩm khác nhau theo thiết bị: desktop (≥640px) = grid 3 ô vuông cuộn ngang
// như cũ; mobile = list card nằm ngang xếp dọc. Render lại khi vượt ngưỡng 640px.
const mqProductDesktop = window.matchMedia("(min-width: 640px)");
mqProductDesktop.addEventListener("change", () => renderProducts());

// Icon túi mua hàng (dùng chung cho nút "Giỏ hàng" ở cả 2 layout).
const cartIconSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="transition-transform duration-300 group-hover/add:scale-110"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`;

// Icon (Lucide) cho nút TRƯỢT vào giỏ ở mobile: bánh (cookie) = núm kéo, túi = đích, chevrons = mũi hướng.
const cookieIconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01"/><path d="M16 15.5v.01"/><path d="M12 12v.01"/><path d="M11 17v.01"/><path d="M7 14v.01"/></svg>`;
const bagIconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`;
const chevIconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/></svg>`;

// HTML nút trượt cho 1 sản phẩm (mobile).
const slideCartHtml = (p) => `
  <div class="nn-slide" data-slide-cart="${p.id}">
    <div class="nn-slide__fill"></div>
    <div class="nn-slide__hint">${chevIconSvg}</div>
    <div class="nn-slide__target" role="button" aria-label="Thêm vào giỏ">${bagIconSvg}</div>
    <div class="nn-slide__knob">${cookieIconSvg}</div>
  </div>`;

// DESKTOP (≥640px): card DỌC, ảnh vuông trên, nút "Giỏ hàng" là thanh full-width dính đáy.
function renderProductCardGrid(p) {
  return `
    <article class="group relative flex w-full flex-col overflow-hidden rounded-2xl border border-earth/50 bg-cream/70 shadow-[0_3px_14px_-6px_rgba(10,10,10,0.18)] transition-all duration-300 hover:-translate-y-1 hover:border-earth hover:shadow-[0_16px_30px_-10px_rgba(10,10,10,0.28)]">
      <div data-detail="${p.id}" class="aspect-square overflow-hidden bg-earth/30 cursor-pointer relative">
        ${
          p.image_url
            ? `<img src="${p.image_url}" alt="${p.name}" loading="lazy" decoding="async" class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />`
            : `<div class="flex h-full items-center justify-center"><span class="font-serif text-lg italic text-ash">nomnom</span></div>`
        }
        ${p.badge === "bestseller" ? `<span class="absolute top-2 left-2 sm:top-3 sm:left-3 bg-[#f39c12] px-2 py-0.5 text-[10px] font-semibold text-white rounded-full sm:px-3 sm:text-[15px]">Bán chạy</span>` : ""}
        ${p.badge === "new" ? `<span class="absolute top-2 left-2 sm:top-3 sm:left-3 bg-[#34C759] px-2 py-0.5 text-[10px] font-semibold text-white rounded-full sm:px-3 sm:text-[15px]">Mới</span>` : ""}
        ${p.badge === "soldout" ? `<span class="absolute top-2 left-2 sm:top-3 sm:left-3 bg-ink px-2 py-0.5 text-[10px] font-semibold text-white rounded-full sm:px-3 sm:text-[15px]">Hết hàng</span>` : ""}
      </div>
      <div class="flex flex-col flex-1 px-3 pt-2 pb-2.5 sm:px-4 sm:pt-3 sm:pb-3">
        <h3 data-detail="${p.id}" class="font-serif text-xs sm:text-lg text-ink cursor-pointer hover:text-ash transition-colors line-clamp-2">${p.name}</h3>
        ${p.description ? `<p class="mt-0.5 sm:mt-1 text-[10px] sm:text-sm text-ash line-clamp-2">${p.description}</p>` : ""}
        <p class="mt-auto pt-1 sm:pt-2 text-[11px] sm:text-sm font-medium text-ink">
            ${p.sale_price
              ? `<span class="text-ash line-through">${formatPrice(p.price)}</span> <span class="text-red-600">${formatPrice(p.sale_price)}</span>`
              : formatPrice(p.price)
            }
        </p>
      </div>
      ${
        state.isAdmin
          ? `<div class="flex gap-2 px-3 pb-2 sm:px-4">
              <button data-edit="${p.id}" class="text-xs text-ash hover:text-ink transition-colors">Sửa</button>
              <button data-delete="${p.id}" class="text-xs text-red-500 hover:text-red-700 transition-colors">Xóa</button>
            </div>`
          : ""
      }
      ${p.badge === "soldout"
        ? `<div class="w-full bg-ash/80 py-2 sm:py-2.5 text-center text-[10px] sm:text-xs font-medium text-white">Hết hàng</div>`
        : `<button data-add-cart="${p.id}" aria-label="Thêm vào giỏ" class="group/add flex w-full items-center justify-center gap-1.5 bg-gradient-to-br from-[#232323] to-ink py-2.5 text-[11px] sm:text-sm font-semibold text-cream transition-all duration-200 hover:brightness-125 active:scale-[0.98]">
            ${cartIconSvg}<span>Giỏ hàng</span>
          </button>`
      }
    </article>`;
}

// MOBILE (<640px): card NẰM NGANG, ảnh vuông trái, thông tin phải, nút "Giỏ hàng" viên thuốc.
function renderProductCardList(p) {
  return `
    <article class="group relative flex overflow-hidden rounded-2xl border border-earth/50 bg-cream/70 shadow-[0_3px_14px_-6px_rgba(10,10,10,0.18)] transition-all duration-300 hover:border-earth hover:shadow-[0_12px_26px_-12px_rgba(10,10,10,0.28)]">
      <div data-detail="${p.id}" class="relative aspect-square w-[10.1rem] shrink-0 overflow-hidden bg-earth/30 cursor-pointer">
        ${
          p.image_url
            ? `<img src="${p.image_url}" alt="${p.name}" loading="lazy" decoding="async" class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />`
            : `<div class="flex h-full items-center justify-center"><span class="font-serif text-lg italic text-ash">nomnom</span></div>`
        }
        ${p.badge === "bestseller" ? `<span class="absolute top-2 left-2 bg-[#f39c12] px-2 py-0.5 text-[10px] font-semibold text-white rounded-full">Bán chạy</span>` : ""}
        ${p.badge === "new" ? `<span class="absolute top-2 left-2 bg-[#34C759] px-2 py-0.5 text-[10px] font-semibold text-white rounded-full">Mới</span>` : ""}
        ${p.badge === "soldout" ? `<span class="absolute top-2 left-2 bg-ink px-2 py-0.5 text-[10px] font-semibold text-white rounded-full">Hết hàng</span>` : ""}
      </div>
      <div class="flex min-w-0 flex-1 flex-col px-3 py-2.5">
        <h3 data-detail="${p.id}" class="font-serif text-[18px] text-ink cursor-pointer hover:text-ash transition-colors line-clamp-1">${p.name}</h3>
        ${p.description ? `<p class="mt-0.5 text-[11px] text-ash line-clamp-3">${p.description}</p>` : ""}
        <div class="mt-auto flex items-end justify-between gap-2 pt-2">
          <p class="flex flex-col leading-tight text-[12px] font-medium text-ink">
            ${p.sale_price
              ? `<span class="text-[10px] font-normal text-ash line-through">${formatPrice(p.price)}</span><span class="text-red-600">${formatPrice(p.sale_price)}</span>`
              : `<span>${formatPrice(p.price)}</span>`
            }
          </p>
          ${p.badge === "soldout"
            ? `<span class="shrink-0 text-[10px] text-ash">Hết hàng</span>`
            : slideCartHtml(p)
          }
        </div>
        ${
          state.isAdmin
            ? `<div class="mt-1.5 flex gap-3">
                <button data-edit="${p.id}" class="text-xs text-ash hover:text-ink transition-colors">Sửa</button>
                <button data-delete="${p.id}" class="text-xs text-red-500 hover:text-red-700 transition-colors">Xóa</button>
              </div>`
            : ""
        }
      </div>
    </article>`;
}

function renderProducts() {
  const container = document.getElementById("product-sections");
  const categories = [...new Set(allProducts.map((p) => p.category).filter(Boolean))];
  const uncategorized = allProducts.filter((p) => !p.category);

  if (!allProducts.length && !state.isAdmin) {
    container.innerHTML = `<p class="text-center text-sm text-ash py-12">Chưa có sản phẩm nào.</p>`;
    return;
  }

  const isDesktop = mqProductDesktop.matches;
  const renderCard = isDesktop ? renderProductCardGrid : renderProductCardList;

  const addBtn = !state.isAdmin
    ? ""
    : isDesktop
      ? `<button class="add-product-btn flex aspect-square w-full items-center justify-center rounded-2xl border-2 border-dashed border-earth text-ash hover:border-ink hover:text-ink hover:bg-cream/50 transition-colors cursor-pointer">
          <span class="text-center"><span class="block text-3xl leading-none">+</span><span class="mt-2 block text-sm">Thêm sản phẩm</span></span>
        </button>`
      : `<button class="add-product-btn flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-earth py-6 text-ash hover:border-ink hover:text-ink hover:bg-cream/50 transition-colors cursor-pointer">
          <span class="text-2xl leading-none">+</span><span class="text-sm">Thêm sản phẩm</span>
        </button>`;

  // DESKTOP: carousel 3 ô/hàng, cuộn ngang, có nút ‹ › khi >3.
  const cell = (inner) => `<div class="pcar-cell snap-start shrink-0 flex">${inner}</div>`;
  const carousel = (cellsHtml, showArrows) => {
    const trackId = `pcar-${Math.random().toString(36).slice(2, 8)}`;
    const arrowBtn = (dir) =>
      `<button data-car-${dir}="${trackId}" aria-label="${dir === "prev" ? "Xem trước" : "Xem tiếp"}"
        class="absolute ${dir === "prev" ? "left-0 -translate-x-1/2" : "right-0 translate-x-1/2"} top-1/2 z-10 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-earth bg-white text-ink shadow-md hover:bg-earth/20 active:scale-95 transition sm:flex">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="${dir === "prev" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"}"/></svg>
      </button>`;
    return `
      <div class="relative mt-6">
        ${showArrows ? arrowBtn("prev") : ""}
        <div id="${trackId}" class="pcar-track flex overflow-x-auto snap-x snap-mandatory scrollbar-hide scroll-smooth">
          ${cellsHtml}
        </div>
        ${showArrows ? arrowBtn("next") : ""}
      </div>`;
  };

  const section = (title, items) => {
    if (isDesktop) {
      const cells = items.map((p) => cell(renderCard(p))).join("") + (state.isAdmin ? cell(addBtn) : "");
      const total = items.length + (state.isAdmin ? 1 : 0);
      return `
        <div class="category-section">
          <h3 class="font-serif text-2xl text-ink md:text-3xl">${title}</h3>
          <hr class="mt-3 border-dashed border-earth" />
          ${carousel(cells, total > 3)}
        </div>`;
    }
    // MOBILE: list card ngang xếp dọc.
    const cards = items.map(renderCard).join("") + (state.isAdmin ? addBtn : "");
    return `
      <div class="category-section">
        <h3 class="font-serif text-2xl text-ink md:text-3xl">${title}</h3>
        <hr class="mt-3 border-dashed border-earth" />
        <div class="mx-auto mt-6 flex max-w-2xl flex-col gap-[0.525rem]">
          ${cards}
        </div>
      </div>`;
  };

  let html = "";
  categories.forEach((cat) => {
    html += section(cat, allProducts.filter((p) => p.category === cat));
  });

  if (uncategorized.length) {
    html += section("Khác", uncategorized);
  } else if (state.isAdmin && !categories.length) {
    html += isDesktop ? carousel(cell(addBtn), false) : `<div class="mx-auto mt-6 max-w-2xl">${addBtn}</div>`;
  }

  container.innerHTML = html;

  // Nút ‹ › cuộn ngang track 1 "trang" (desktop). Trên mobile không có → querySelector rỗng.
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
        // Nút có icon + <span> nhãn → chỉ đổi chữ trong span để không xoá icon.
        const label = btn.querySelector("span");
        if (label) {
          const prev = label.textContent;
          label.textContent = "Đã thêm ✓";
          setTimeout(() => { label.textContent = prev; }, 1000);
        }
      }
    })
  );

  container.querySelectorAll("[data-detail]").forEach((el) =>
    el.addEventListener("click", () => {
      const product = allProducts.find((p) => p.id === el.dataset.detail);
      if (product) openDetailModal(product);
    })
  );

  initSlideCarts(container);
}

// Gắn tương tác "trượt bánh vào giỏ" cho mọi nút .nn-slide trong container (chỉ có ở layout mobile).
// Kéo núm bánh sang phải qua ngưỡng → thêm vào giỏ; hoặc bấm thẳng icon giỏ → tự trượt vào.
// Dùng pointer-capture (không gắn listener toàn cục) nên render lại nhiều lần không rò rỉ.
function initSlideCarts(container) {
  const THRESH = 0.7, BOUNCE_STIFF = 0.12, BOUNCE_DAMP = 0.8, RETURN_DELAY = 260;

  container.querySelectorAll("[data-slide-cart]").forEach((slide) => {
    const knob = slide.querySelector(".nn-slide__knob");
    const fill = slide.querySelector(".nn-slide__fill");
    const hint = slide.querySelector(".nn-slide__hint");
    const target = slide.querySelector(".nn-slide__target");
    const product = allProducts.find((p) => p.id === slide.dataset.slideCart);
    if (!product) return;

    let dragging = false, startX = 0, x = 0, max = 0, lastPx = 0, vel = 0, locked = false, rafId = 0;
    const maxTravel = () => slide.clientWidth - knob.offsetWidth - 6;

    // vẽ vị trí núm: co giãn theo vận tốc (cao su) + teo dần về giỏ (ease-in, chạm mép = 0); giỏ phình đón bánh
    function paint(px, v) {
      x = px;
      const ratio = max ? Math.max(0, Math.min(1, px / max)) : 0;
      const ease = Math.pow(ratio, 3.5);
      const scale = Math.max(0, 1 - ease);
      const st = Math.min(0.42, Math.abs(v) * 0.045);
      knob.style.transform = `translateX(${px}px) scaleX(${scale * (1 + st)}) scaleY(${scale * (1 - st * 0.55)})`;
      target.style.transform = `scale(${1 + 0.2 * ease})`;
      fill.style.clipPath = `inset(0 ${100 - ratio * 100}% 0 0)`;
      hint.style.opacity = String(Math.max(0, 1 - ratio * 1.7));
      slide.classList.toggle("reached", ratio >= THRESH);
    }

    // lò xo bật về có nảy (dùng cho cả thả giữa chừng lẫn hồi sau khi vào giỏ)
    function spring(to, stiff, damp, onDone) {
      cancelAnimationFrame(rafId);
      let pos = x, v = 0;
      (function tick() {
        v = (v + (to - pos) * stiff) * damp;
        pos += v;
        paint(pos, v);
        if (Math.abs(v) < 0.25 && Math.abs(to - pos) < 0.25) { paint(to, 0); onDone && onDone(); }
        else rafId = requestAnimationFrame(tick);
      })();
    }

    // "đạn" bánh bay từ giỏ (đích) lên icon giỏ trên cùng
    function flyToCart() {
      const cartEl = ["floating-cart", "cart-btn"]
        .map((id) => document.getElementById(id))
        .find((el) => el && el.offsetParent !== null);
      if (!cartEl) return;
      const t = target.getBoundingClientRect();
      const cr = cartEl.getBoundingClientRect();
      const size = 20, cx = t.left + t.width / 2, cy = t.top + t.height / 2;
      const fly = document.createElement("div");
      fly.className = "nn-fly"; fly.innerHTML = cookieIconSvg;
      fly.style.left = `${cx - size / 2}px`; fly.style.top = `${cy - size / 2}px`;
      fly.style.width = `${size}px`; fly.style.height = `${size}px`;
      document.body.appendChild(fly);
      requestAnimationFrame(() => {
        fly.style.transform = `translate(${cr.left + cr.width / 2 - cx}px, ${cr.top + cr.height / 2 - cy}px) scale(.4)`;
        fly.style.opacity = "0";
      });
      setTimeout(() => fly.remove(), 600);
    }

    // "+1" bay lên phía trên miệng pill (gắn body → không bị overflow của pill cắt)
    function spawnPlus() {
      const t = target.getBoundingClientRect();
      const el = document.createElement("div");
      el.className = "nn-plus-fly"; el.textContent = "+1";
      el.style.left = `${t.left + t.width / 2}px`;
      el.style.top = `${t.top - 2}px`;
      document.body.appendChild(el);
      requestAnimationFrame(() => el.classList.add("go"));
      setTimeout(() => el.remove(), 950);
    }

    function succeed(stiff, damp) {
      locked = true;
      spring(max, stiff || 0.4, damp || 0.5, () => {   // bắn nốt vào giỏ (đúng timing dù kéo hay bấm)
        addToCart(product);
        flyToCart();
        spawnPlus();
        slide.classList.add("done");                   // ẩn núm trong lúc đạn bay
        setTimeout(() => {
          slide.classList.remove("done");
          spring(0, BOUNCE_STIFF, BOUNCE_DAMP, () => {  // nảy về đầu, sẵn sàng lần sau
            slide.classList.remove("reached");
            hint.style.opacity = "1"; locked = false;
          });
        }, RETURN_DELAY);
      });
    }

    // Bắt kéo trên CẢ thanh (không chỉ mỗi núm) → được trọn chiều cao pill + biên ngang
    // rộng quanh núm, nên ngón tay to đè lệch icon một chút vẫn nhận thao tác kéo.
    // Vùng icon giỏ ở cuối phải để dành cho thao tác BẤM (tự trượt), không bắt kéo ở đó.
    slide.addEventListener("pointerdown", (e) => {
      if (locked) return;
      max = maxTravel();
      const localX = e.clientX - slide.getBoundingClientRect().left;
      const knobEnd = 3 + x + knob.offsetWidth;        // mép phải hiện tại của núm
      const tol = knob.offsetWidth * 0.78;             // dung sai ~78% bề ngang núm (nới cho ngón tay to)
      if (localX > knobEnd + tol) return;              // chạm vào vùng icon giỏ → để click xử lý
      cancelAnimationFrame(rafId);
      dragging = true;
      startX = e.clientX - x; lastPx = x; vel = 0;     // không "nhảy" núm — kéo tiếp từ vị trí hiện tại
      slide.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    slide.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      let px = e.clientX - startX;
      if (px < 0) px *= 0.32;                          // lực cản 2 đầu (rubber band)
      else if (px > max) px = max + (px - max) * 0.32;
      vel = px - lastPx; lastPx = px;
      paint(px, vel);
      e.preventDefault();
    });
    const release = () => {
      if (!dragging) return;
      dragging = false;
      if (max && x / max >= THRESH) succeed();
      else spring(0, BOUNCE_STIFF, BOUNCE_DAMP);       // chưa đủ ngưỡng → bật về đầu
    };
    slide.addEventListener("pointerup", release);
    slide.addEventListener("pointercancel", release);

    // bấm thẳng icon giỏ → tự trượt vào (cùng timing như kéo)
    target.addEventListener("click", () => {
      if (locked || dragging) return;
      max = maxTravel();
      succeed();
    });
  });
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
    // Tên file là duy nhất (timestamp+random) → nội dung không bao giờ đổi, cache 1 năm
    // để trình duyệt/CDN không tải lại cùng ảnh, giảm mạnh cached egress của Supabase.
    .upload(fileName, file, { cacheControl: "31536000" });
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

// ── Hero Slideshow + Hero Slides Admin → đã tách sang src/storefront/hero.js (initHero / loadHeroSlides) ──

// ── Banner ngang đã gỡ khỏi trang (thay bằng hero full-bleed + marquee). Bảng `banners` ngưng dùng. ──

// ── Contact Buttons ──

const contactEditBtn = document.getElementById("btn-contact-edit");
const contactModal = document.getElementById("contact-modal");
const contactForm = document.getElementById("contact-form");
const contactError = document.getElementById("contact-error");

function updateLogo(data) {
  const headerLogo = document.getElementById("logo");
  const footerLogo = document.getElementById("footer-logo");
  const miniLogo = document.getElementById("mini-logo");
  const logoNames = document.querySelectorAll(".logo-name");

  if (data.logo_image_url) {
    headerLogo.innerHTML = `<img src="${data.logo_image_url}" alt="Logo" class="h-[50px] md:h-[60px] w-auto" />`;
    footerLogo.innerHTML = `<img src="${data.logo_image_url}" alt="Logo" class="h-8 w-auto" />`;
    if (miniLogo) miniLogo.innerHTML = `<img src="${data.logo_image_url}" alt="Logo" class="h-9 w-auto" />`;
  } else {
    headerLogo.textContent = data.logo_text || "nomnom";
    footerLogo.textContent = data.logo_text || "nomnom";
    if (miniLogo) miniLogo.textContent = data.logo_text || "nomnom";
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

// Tiêu đề hero — cô chủ tự quyết định bằng ký tự gõ tay (gõ ngay trên 1 dòng):
//   /      → XUỐNG DÒNG   (vd "Ngọt ngào / trong từng ...")
//   *chữ*  → tô CHỮ VÀNG italic (vd "từng *lát cắt.*")
// Khách xem: render đẹp theo dấu. Admin: hiện chữ THÔ (còn dấu / và *) để sửa/lưu đúng dấu.
function renderHeroTitle(raw) {
  return escapeHtml(raw)
    .replace(/\s*\/\s*/g, "<br>")
    .replace(/\*([^*]+)\*/g, '<span class="hero-accent">$1</span>')
    .replace(/\n/g, "<br>");
}

function updateHeroContent(data) {
  editableFields.forEach(({ id, col }) => {
    const el = document.getElementById(id);
    if (!data[col]) return;
    if (id === "hero-title" && !state.isAdmin) {
      el.innerHTML = renderHeroTitle(data[col]);
    } else {
      el.textContent = data[col];
    }
  });

  if (state.isAdmin) {
    editableFields.forEach(({ id, col }) => {
      const el = document.getElementById(id);
      el.setAttribute("contenteditable", "true");
      el.removeEventListener("focus", el._focusHandler);
      el.removeEventListener("blur", el._saveHandler);
      // Dirty-check: nhớ nội dung lúc focus, blur mà không sửa gì thì KHÔNG ghi DB.
      el._focusHandler = () => { el._initialText = el.textContent.trim(); };
      el._saveHandler = () => {
        const val = el.textContent.trim();
        if (val === el._initialText) return;
        saveField(col, val);
        el._initialText = val;
      };
      el.addEventListener("focus", el._focusHandler);
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

// Marquee dưới hero: khách xem thì chạy vô hạn; admin thì DỪNG + thành 1 dòng sửa trực tiếp
// (gõ các cụm cách nhau bằng ✦). Lưu vào cột site_settings.marquee_text.
const MARQUEE_DEFAULT = "Thủ công ✦ Mẻ nhỏ ✦ Tươi mỗi ngày ✦ Nguyên liệu thật ✦ Bơ thật ✦ Làm bằng tâm ✦";
function renderMarquee(text) {
  const el = document.getElementById("marquee");
  if (!el) return;
  const raw = (text && text.trim()) || MARQUEE_DEFAULT;

  if (state.isAdmin) {
    el.innerHTML = `<div id="marquee-edit" class="nn-marquee-edit" contenteditable="true" spellcheck="false" title="Gõ các cụm cách nhau bằng dấu ✦">${escapeHtml(raw)}</div>`;
    const edit = document.getElementById("marquee-edit");
    let marqueeInitial = edit.textContent.trim();
    edit.addEventListener("focus", () => { marqueeInitial = edit.textContent.trim(); });
    edit.addEventListener("blur", () => {
      const val = edit.textContent.trim();
      if (val === marqueeInitial) return; // không sửa gì → không ghi DB
      saveField("marquee_text", val);
      marqueeInitial = val;
    });
  } else {
    const group = `<span class="nn-marquee-group"><span class="nn-marquee-item">${escapeHtml(raw).replace(/✦/g, "<i>✦</i>")}</span></span>`;
    el.innerHTML = `<div class="nn-marquee-track">${group}${group.replace('class="nn-marquee-group"', 'class="nn-marquee-group" aria-hidden="true"')}</div>`;
  }
}

async function loadContactSettings() {
  const { data } = await supabase.from("site_settings").select("*").single();
  if (!data) return;
  renderMarquee(data.marquee_text);

  updateLogo(data);
  updateHeroContent(data);

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
  aboutImgEdit.classList.toggle("hidden", !state.isAdmin);

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
  customImgEdit.classList.toggle("hidden", !state.isAdmin);

  const zaloBtn = document.getElementById("btn-zalo");
  const messengerBtn = document.getElementById("btn-messenger");

  zaloBtn.href = data.zalo_url || "#";
  messengerBtn.href = data.messenger_url || "#";

  zaloBtn.classList.toggle("hidden", !data.zalo_url);
  messengerBtn.classList.toggle("hidden", !data.messenger_url);

  // Mobile: cùng link cho 2 mục trong floating hamburger (#fab-menu).
  const fabZalo = document.getElementById("fab-zalo");
  const fabMessenger = document.getElementById("fab-messenger");
  if (fabZalo) { fabZalo.href = data.zalo_url || "#"; fabZalo.classList.toggle("hidden", !data.zalo_url); }
  if (fabMessenger) { fabMessenger.href = data.messenger_url || "#"; fabMessenger.classList.toggle("hidden", !data.messenger_url); }

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
  state.freeShipThreshold = parseInt(data.free_ship_threshold) || 0;
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
    const show = !!url || state.isAdmin;
    el.classList.toggle("hidden", !show);
    el.classList.toggle("inline-flex", show);
    el.classList.toggle("opacity-40", !url); // mờ nếu chưa có link (gợi ý cho admin)
  });

  contactEditBtn.classList.toggle("hidden", !state.isAdmin);
  contactEditBtn.classList.toggle("flex", state.isAdmin);

  state.bankSettings = {
    bank_id: data.bank_id || "",
    bank_account: data.bank_account || "",
    bank_name: data.bank_name || "",
    zalo_url: data.zalo_url || "",
  };
  // Thông tin tiệm cho thẻ theo dõi đơn (địa chỉ "Từ" + nút Gọi điện) — tự lấy từ cài đặt.
  state.shopInfo = {
    phone: data.phone || "",
    address: data.address_text || "",
    zalo: data.zalo_url || "",
  };
  state.chatAutoReply = data.chat_auto_reply || "";
  state.trackingMessages = data.tracking_messages || null; // 4 mẫu tin báo mốc (cô chủ sửa ở admin)

  state.rewardConfig = {
    cycle: parseInt(data.reward_cycle_orders) || 10,
    percent: parseInt(data.reward_percent) || 20,
  };

  // Cấu hình hạng khách & voucher (tier_config jsonb + các cột int). Fallback = mặc định.
  const tc = Array.isArray(data.tier_config) ? data.tier_config
    : (typeof data.tier_config === "string" && data.tier_config ? JSON.parse(data.tier_config) : null);
  state.tierConfig = (tc && tc.length ? tc : DEFAULT_TIERS)
    .map((t) => ({ name: t.name, min_spend: Number(t.min_spend) || 0, monthly_count: Number(t.monthly_count) || 0, percent: Number(t.percent) || 0 }))
    .sort((a, b) => a.min_spend - b.min_spend);
  state.birthdayPercent = parseInt(data.birthday_voucher_percent) || 0;
  state.maxVouchersPerOrder = parseInt(data.max_vouchers_per_order) || 2;
  state.maxDiscountAmount = parseInt(data.max_discount_amount) || 0;

  updateLoyaltyHint();
  if (state.currentCustomer) refreshCustomerData();

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

document.getElementById("about-image-edit").addEventListener("click", () => {
  contactEditBtn.click();
});
document.getElementById("custom-image-edit").addEventListener("click", () => {
  contactEditBtn.click();
});

// (Cấu hình Hạng & Voucher đã chuyển sang trang quản trị admin.js — route Khách hàng.)

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

  if (logoFile) {
    const logoC = await compressImage(logoFile);
    const ext = logoC.name.split(".").pop();
    const fileName = `logo-${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("product-images")
      .upload(fileName, logoC, { cacheControl: "31536000" });

    if (uploadError) {
      contactError.textContent = "Lỗi upload logo: " + uploadError.message;
      contactError.classList.remove("hidden");
      return;
    }

    const { data: urlData } = supabase.storage.from("product-images").getPublicUrl(fileName);
    logo_image_url = urlData.publicUrl;
  }

  let about_image_url = undefined;
  const aboutFile = contactForm.elements.about_image.files[0];
  if (aboutFile) {
    const aboutC = await compressImage(aboutFile);
    const aName = `about-${Date.now()}.${aboutC.name.split(".").pop()}`;
    const { error: aErr } = await supabase.storage
      .from("product-images")
      .upload(aName, aboutC, { cacheControl: "31536000" });
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
      .upload(cName, customC, { cacheControl: "31536000" });
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

// ── Reviews → đã tách sang src/storefront/reviews.js (initReviews / loadReviews) ──

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

// ── Thẻ "hoá đơn" theo dõi đơn (khách xem ở tab Đơn của tôi + màn success) ──
// Icon SVG line hiện đại (không emoji). Xe máy shipper là SVG phẳng tô màu mận đô.
// CSS ở src/style.css (.nnv-*). Giờ xác nhận từng mốc lấy từ order.fulfillment_log.
const NNV_IC = {
  receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v18l2-1.2L10 21l2-1.2L14 21l2-1.2L18 21V3l-2 1.2L14 3l-2 1.2L10 3 8 4.2 6 3Z"/><path d="M9 8.5h6M9 12h6"/></svg>',
  chef: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 20h10"/><path d="M8.5 20v-4M15.5 20v-4"/><path d="M7 16a3.4 3.4 0 0 1-1-6.7A4 4 0 0 1 13.9 7 3.4 3.4 0 0 1 17 16H7Z"/></svg>',
  scooter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.5" cy="17" r="2.5"/><circle cx="17.5" cy="17" r="2.5"/><path d="M4 17h-.5A1.5 1.5 0 0 1 2 15.5V14a3 3 0 0 1 3-3h6l2.5-4H16"/><path d="M15 17H9"/><path d="M17.2 14.5 15.5 7H13"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  checkc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  xc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.4a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7A2 2 0 0 1 22 16.9Z"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
};
const NNV_RIDER =
  '<svg viewBox="0 0 44 30" xmlns="http://www.w3.org/2000/svg">' +
  '<circle cx="10" cy="23" r="5" fill="#3a1219"/><circle cx="10" cy="23" r="1.8" fill="#fff"/>' +
  '<circle cx="34" cy="23" r="5" fill="#3a1219"/><circle cx="34" cy="23" r="1.8" fill="#fff"/>' +
  '<path d="M10 23h13l4-8h4" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<rect x="3.5" y="7.5" width="9" height="9" rx="2" fill="currentColor"/>' +
  '<path d="M9 10.5c1-1.1 2.4-.2 0 1.3-2.4-1.5-1-2.4 0-1.3z" fill="#fff"/>' +
  '<circle cx="23" cy="7" r="3.4" fill="currentColor"/>' +
  '<path d="M20 12c3 .3 6 .3 8.5-1.6L26.5 16 19 16.6z" fill="currentColor"/></svg>';

const NNV_STEPS = [
  { short: "Đã nhận", icon: "receipt", sub: "nomnom đã nhận đơn của bạn, đang chuẩn bị nhé!" },
  { short: "Đang làm", icon: "chef", sub: "Bánh đang được làm — sắp ra lò rồi!" },
  { short: "Đang giao", icon: "scooter", sub: "Bánh đang trên đường giao tới bạn, chờ chút nhé!" },
  { short: "Hoàn thành", icon: "check", sub: "Đơn đã giao xong. Cảm ơn bạn, chúc ngon miệng!" },
];

// giờ HH:MM từ ISO (mốc cô chủ xác nhận)
function hhmm(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Thẻ hoá đơn đầy đủ: trạng thái + tiến trình (giờ dưới mốc) + Từ→Đến + món + tổng + Gọi/Nhắn tin.
// opts.actions: "full" (Gọi + Nhắn tin, mặc định) | "chat" (chỉ Nhắn tin) | "none".
function orderCardHtml(order, opts = {}) {
  const actionsMode = opts.actions || "full";
  const items = Array.isArray(order.items) ? order.items : [];
  const cancelled = order.status === "cancelled";
  const stage = Number(order.fulfillment_stage) || 0;
  const log = order.fulfillment_log || {};
  const paidLike = order.status === "paid" || order.status === "delivered";

  // Trạng thái lớn
  let stc, stIcon, stTitle, stSub;
  if (cancelled) { stc = "cancel"; stIcon = NNV_IC.xc; stTitle = "Đã hủy"; stSub = "Nếu cần hỗ trợ thêm, bạn nhắn shop giúp mình nhé."; }
  else if (stage >= 4) { stc = "done"; stIcon = NNV_IC.checkc; stTitle = "Hoàn thành"; stSub = NNV_STEPS[3].sub; }
  else if (stage <= 0) { stc = "idle"; stIcon = NNV_IC.clock; stTitle = "Chờ xử lý"; stSub = "nomnom đã nhận đơn, sẽ bắt đầu chuẩn bị sớm nhất nhé."; }
  else { stc = "run"; stIcon = NNV_IC[NNV_STEPS[stage - 1].icon]; stTitle = NNV_STEPS[stage - 1].short; stSub = NNV_STEPS[stage - 1].sub; }

  // Thanh tiến trình + giờ dưới mốc
  const fill = cancelled ? 0 : stage >= 4 ? 100 : stage <= 0 ? 0 : ((stage - 1) / 3) * 100;
  const nodes = NNV_STEPS.map((s, i) => {
    const n = i + 1;
    const reached = !cancelled && (stage >= 4 || n <= stage);
    const cls = cancelled ? "" : stage >= 4 ? "done" : n < stage ? "done" : n === stage ? "cur" : "";
    const t = hhmm(log[n]);
    const timeHtml = reached && t ? `<span class="nnv-time">${t}</span>` : `<span class="nnv-time na">– –</span>`;
    return `<div class="nnv-node ${cls}"><span class="nnv-dot">${NNV_IC[s.icon]}</span><span class="nnv-lbl">${s.short}</span>${timeHtml}</div>`;
  }).join("");
  const bar = cancelled
    ? `<div class="nnv-cancel-box">${NNV_IC.xc}Đơn đã huỷ, hẹn bạn lần sau nhé!</div>`
    : `<div class="nnv-bar" data-stage="${stage}" style="--fill:${fill}%">
        <div class="nnv-line"><div class="nnv-fill"></div></div>
        ${stage >= 3 ? `<div class="nnv-rider">${NNV_RIDER}</div>` : ""}
        <div class="nnv-nodes">${nodes}</div>
      </div>`;

  // Từ → Đến (tự lấy địa chỉ tiệm ở cài đặt)
  const shopAddr = state.shopInfo.address || "Đang cập nhật";
  const toName = order.customer_name ? escapeHtml(order.customer_name) : "";
  const toPhone = order.customer_phone ? escapeHtml(order.customer_phone) : "";
  const toSub = [toName, toPhone].filter(Boolean).join(" · ");
  const route = `
    <div class="nnv-route">
      <div class="nnv-rt"><span class="nnv-rt-dot from"></span><div><div class="nnv-rt-k">Từ</div><div class="nnv-rt-name">nomnom — tiệm bánh</div><div class="nnv-rt-sub">${escapeHtml(shopAddr)}</div></div></div>
      <div class="nnv-rt"><span class="nnv-rt-dot to"></span><div><div class="nnv-rt-k">Giao đến</div><div class="nnv-rt-name">${escapeHtml(order.customer_address || "—")}</div>${toSub ? `<div class="nnv-rt-sub">${toSub}</div>` : ""}</div></div>
    </div>`;

  // Món + tổng (Tạm tính → Giảm giá → Tổng; KHÔNG có phí ship)
  const subtotal = items.reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);
  const discount = Math.max(0, subtotal - (order.total || 0));
  const lis = items.map((i) =>
    `<div class="nnv-li"><span class="q">${i.qty}×</span><span class="nm">${escapeHtml(i.name || "")}${i.note ? `<small>${escapeHtml(i.note)}</small>` : ""}</span><span class="amt">${formatPrice((i.price || 0) * (i.qty || 0))}</span></div>`
  ).join("");
  const totals = `
    <div class="nnv-tot">
      <div class="nnv-tr"><span>Tạm tính</span><span>${formatPrice(subtotal)}</span></div>
      ${discount > 0 ? `<div class="nnv-tr disc"><span>Giảm giá${order.voucher_percent ? ` (voucher ${order.voucher_percent}%)` : ""}</span><span>−${formatPrice(discount)}</span></div>` : ""}
      <div class="nnv-tr grand"><span>Tổng cộng</span><span>${formatPrice(order.total || 0)}</span></div>
    </div>`;

  const payRow = `<div class="nnv-pay"><span>Thanh toán</span><b>Chuyển khoản ${paidLike ? `<span class="nnv-pill-paid">${NNV_IC.checkc}Đã thanh toán</span>` : ""}</b></div>`;
  const delivRow = order.delivery_time ? `<div class="nnv-pay"><span>Thời gian giao</span><b>${escapeHtml(order.delivery_time)}</b></div>` : "";

  // Gọi / Nhắn tin. Chỉ tab "Theo dõi đơn bánh" cần đủ 2 nút; Lịch sử chỉ cần Nhắn tin.
  const phone = state.shopInfo.phone;
  const chatBtn = `<button type="button" class="nnv-act chat" data-chat-order="${escapeHtml(order.order_code || "")}">${NNV_IC.chat}Nhắn tin</button>`;
  let actions = "";
  if (actionsMode === "full") {
    const callBtn = phone ? `<a class="nnv-act call" href="tel:${escapeHtml(phone)}">${NNV_IC.phone}Gọi điện</a>` : "";
    actions = `
      <p class="nnv-help-note">Shop phản hồi hơi lâu? Gọi hoặc nhắn ngay nhé:</p>
      <div class="nnv-actions" style="${callBtn ? "" : "grid-template-columns:1fr"}">${callBtn}${chatBtn}</div>`;
  } else if (actionsMode === "chat") {
    actions = `<div class="nnv-actions" style="grid-template-columns:1fr">${chatBtn}</div>`;
  }

  return `
    <div class="nnv" data-stage="${cancelled ? "x" : stage}">
      <div class="nnv-head">
        <div class="nnv-brand">nomnom<span>Tiệm bánh</span></div>
        <div class="nnv-meta"><div class="nnv-code">${escapeHtml(order.order_code || "—")}</div><div class="nnv-date">${formatDateTime(order.created_at)}</div></div>
      </div>
      <div class="nnv-body">
        <div class="nnv-st"><div class="nnv-st-ic ${stc}">${stIcon}</div><div><h3 class="${stc}">${stTitle}</h3><p>${stSub}</p></div></div>
        ${bar}
        <hr class="nnv-div"/>
        ${route}
        <hr class="nnv-div"/>
        <div class="nnv-sec-h">Chi tiết đơn hàng</div>
        ${lis}
        ${totals}
        ${payRow}
        ${delivRow}
        ${actions}
        ${cancelled ? "" : `<p class="nnv-thanks">Cảm ơn bạn đã đặt bánh tại nomnom ♥</p>`}
      </div>
    </div>`;
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
  if (!state.isAdmin) return;
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
      ${
        o.status === "cancelled"
          ? ""
          : `<div class="mt-3 flex flex-wrap items-center gap-1.5">
        <span class="text-[10px] font-semibold text-ash">Tiến trình giao</span>
        ${FULFILLMENT_STAGES.map((s) => {
          const cur = Number(o.fulfillment_stage) || 0;
          const done = cur >= s.stage;
          const isCur = cur === s.stage;
          const target = isCur ? s.stage - 1 : s.stage;
          const cls = isCur
            ? "bg-[#16783a] text-white border-[#16783a]"
            : done
              ? "bg-[#34C759]/15 text-[#16783a] border-[#34C759]/50"
              : "border-earth/60 text-ash hover:border-ink";
          return `<button data-order-stage="${o.id}:${target}" class="rounded border px-2 py-1 text-[10px] font-medium ${cls}">${s.stage}. ${s.label}</button>`;
        }).join("")}
      </div>`
      }
      <div class="mt-3 flex flex-wrap gap-2">
        <button data-order-print="${o.id}" class="border border-earth/60 px-3 py-2 text-xs font-medium text-ink hover:bg-earth/20">🖨 In đơn</button>
        ${o.status === "paid" ? `<button data-order-delivered="${o.id}" class="bg-ink px-3 py-2 text-xs font-medium text-white hover:opacity-90">Đã giao</button>` : ""}
        ${o.status === "paid" ? `<button data-order-cancel="${o.id}" class="border border-red-400 px-3 py-2 text-xs font-medium text-red-500 hover:bg-red-50">Huỷ đơn</button>` : ""}
      </div>
    </div>`;
    })
    .join("");

  ordersList.querySelectorAll("[data-order-stage]").forEach((b) =>
    b.addEventListener("click", () => {
      const [id, stageStr] = b.dataset.orderStage.split(":");
      setOrderFulfillment(id, Number(stageStr));
    })
  );
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

// Cập nhật mốc giao vận (fulfillment_stage) từ drawer đơn inline. Độc lập status thanh toán.
async function setOrderFulfillment(id, stage) {
  const order = adminOrdersCache.find((o) => o.id === id);
  const oldStage = Number(order?.fulfillment_stage) || 0;
  const log = computeFulfillmentLog(order, stage);
  const { error } = await updateFulfillmentStage(id, stage, log);
  if (error) {
    alert("Lỗi cập nhật tiến trình: " + error.message);
    return;
  }
  // Chỉ nhắn khách khi TIẾN tới mốc mới (không nhắn khi bấm lùi/sửa).
  if (order && stage > oldStage) notifyCustomerStage(order, stage, state.trackingMessages);
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

function openCustomerModal() {
  if (state.currentCustomer) {
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
  document.body.classList.add("overflow-hidden"); // khoá cuộn trang nền khi mở panel
}

function closeCustomerModal() {
  customerModal.classList.add("hidden");
  customerModal.classList.remove("flex");
  document.body.classList.remove("overflow-hidden");
  stopCustomerOrdersWatcher();
}

// ── Tab "Tổng quan" / "Đơn đã mua" trong tài khoản khách ──

document.querySelectorAll("[data-customer-tab]").forEach((btn) =>
  btn.addEventListener("click", () => switchCustomerTab(btn.dataset.customerTab))
);

const CUSTOMER_TAB_INDEX = { overview: 0, membership: 1, tracking: 2, orders: 3 };
function switchCustomerTab(tab) {
  document.querySelectorAll("[data-customer-tab]").forEach((btn) => {
    const on = btn.dataset.customerTab === tab;
    btn.classList.toggle("border-ink", on);
    btn.classList.toggle("text-ink", on);
    btn.classList.toggle("border-transparent", !on);
    btn.classList.toggle("text-ash", !on);
  });
  // Trượt cả khối tới slide tương ứng (không ẩn/hiện → cao cố định, không nhảy).
  const track = document.getElementById("customer-tab-track");
  if (track) track.dataset.index = CUSTOMER_TAB_INDEX[tab] ?? 0;
  activeCustomerTab = tab;
  if (tab === "tracking") {
    loadCustomerTracking(); // Theo dõi đơn bánh: thẻ đầy đủ (tiến trình + bill + Gọi/Nhắn tin)
    startCustomerOrdersWatcher(); // realtime: admin đổi mốc → tự cập nhật
  } else if (tab === "orders") {
    loadCustomerOrders(); // Lịch sử đơn hàng: tóm tắt, bấm mở ra bill đầy đủ
    startCustomerOrdersWatcher();
  } else {
    stopCustomerOrdersWatcher();
  }
  // Ladder animate khi tab hạng vừa hiện (lúc render nền track có thể chưa nhìn thấy)
  if (tab === "membership") activateLadders(document.getElementById("customer-tab-membership"));
}

// Realtime cho khách: subscribe khi mở tab Theo dõi/Lịch sử, tải lại đúng tab đang xem.
let customerOrdersChannel = null;
let activeCustomerTab = null;
let customerOrdersCache = []; // đơn của khách (để nút Nhắn tin dựng bill nhanh)

function reloadActiveCustomerTab() {
  if (activeCustomerTab === "tracking") loadCustomerTracking();
  else if (activeCustomerTab === "orders") loadCustomerOrders();
}
function startCustomerOrdersWatcher() {
  stopCustomerOrdersWatcher();
  if (!state.currentCustomer) return;
  const phone = state.currentCustomer.phone;
  customerOrdersChannel = supabase
    .channel(`cust-orders-${phone}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "orders", filter: `customer_phone=eq.${phone}` },
      () => reloadActiveCustomerTab()
    )
    .subscribe();
}
function stopCustomerOrdersWatcher() {
  if (customerOrdersChannel) {
    supabase.removeChannel(customerOrdersChannel);
    customerOrdersChannel = null;
  }
}

// Tải đơn của khách 1 lần, cập nhật cache dùng chung cho cả 2 tab + nút Nhắn tin.
async function fetchCustomerOrders() {
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("customer_phone", state.currentCustomer.phone)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return { error };
  customerOrdersCache = data || [];
  return { data: customerOrdersCache };
}

const skeletonHtml = `<div class="space-y-3"><div class="skeleton h-24 w-full rounded-lg"></div><div class="skeleton h-24 w-full rounded-lg"></div></div>`;

// ── Tab "Theo dõi đơn bánh": đơn ĐANG xử lý (chờ TT / đã TT, chưa giao/huỷ) — thẻ đầy đủ ──
async function loadCustomerTracking() {
  const box = document.getElementById("customer-tab-tracking");
  if (!state.currentCustomer || !box) return;
  box.innerHTML = skeletonHtml;
  const { data, error } = await fetchCustomerOrders();
  if (error) { box.innerHTML = `<p class="py-8 text-center text-sm text-red-600">Lỗi tải đơn: ${error.message}</p>`; return; }
  const ongoing = data.filter((o) => o.status === "pending" || o.status === "paid");
  if (!ongoing.length) {
    box.innerHTML = `<p class="py-8 text-center text-sm text-ash">Không có đơn nào đang giao. Xem các đơn cũ ở tab “Lịch sử đơn hàng” nhé!</p>`;
    return;
  }
  box.innerHTML = `<div class="space-y-4">${ongoing.map((o) => orderCardHtml(o, { actions: "full" })).join("")}</div>`;
}

// ── Tab "Lịch sử đơn hàng": tóm tắt gọn, bấm 1 đơn để mở ra bill đầy đủ ──
async function loadCustomerOrders() {
  const box = document.getElementById("customer-tab-orders");
  if (!state.currentCustomer || !box) return;
  box.innerHTML = skeletonHtml;
  const { data, error } = await fetchCustomerOrders();
  if (error) { box.innerHTML = `<p class="py-8 text-center text-sm text-red-600">Lỗi tải đơn hàng: ${error.message}</p>`; return; }
  if (!data.length) { box.innerHTML = `<p class="py-8 text-center text-sm text-ash">Bạn chưa có đơn hàng nào.</p>`; return; }
  box.innerHTML = `<div class="space-y-2">${data.map(orderSummaryHtml).join("")}</div>`;
}

// Dòng tóm tắt 1 đơn trong Lịch sử (bấm để bung/thu bill đầy đủ).
function orderSummaryHtml(o) {
  const items = Array.isArray(o.items) ? o.items : [];
  const st = orderStatusBadge(o.status);
  const count = items.reduce((s, i) => s + (i.qty || 0), 0);
  return `
    <div class="rounded-xl border border-earth/40 overflow-hidden">
      <button type="button" class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-earth/10" data-order-toggle="${escapeHtml(o.order_code || "")}">
        <span class="min-w-0">
          <span class="block font-medium text-ink">${escapeHtml(o.order_code || "--")}</span>
          <span class="block text-xs text-ash">${formatDateTimeLong(o.created_at)} · ${count} món · ${formatPrice(o.total || 0)}</span>
        </span>
        <span class="flex shrink-0 items-center gap-2">
          <span class="${st.cls} px-2 py-0.5 text-[10px] font-medium text-white rounded-full">${st.text}</span>
          <svg class="chevron h-4 w-4 text-ash transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </span>
      </button>
      <div class="order-detail hidden px-2 pb-2" data-order-detail="${escapeHtml(o.order_code || "")}"></div>
    </div>`;
}

function updateAccountLabel() {
  const label = document.getElementById("account-label");
  if (state.currentCustomer) {
    label.textContent = state.currentCustomer.name || "Tài khoản";
  } else {
    label.textContent = "Đăng nhập";
  }
  updateLoyaltyHint();
}

// Dải tích điểm ở hero: LUÔN hiện. Khách chưa đăng nhập → mời "Đăng nhập để tích điểm";
// khách đã đăng nhập → đổi thành "Tích điểm đổi quà" (bỏ nút đăng nhập), vẫn giữ thông tin voucher.
function updateLoyaltyHint() {
  const hint = document.getElementById("hero-loyalty-hint");
  if (!hint) return;
  hint.classList.remove("hidden");
  const loggedIn = !!state.currentCustomer;
  document.getElementById("hero-loyalty-lead-guest").classList.toggle("hidden", loggedIn);
  document.getElementById("hero-loyalty-lead-member").classList.toggle("hidden", !loggedIn);
  document.getElementById("hero-loyalty-cycle").textContent = state.rewardConfig.cycle;
  document.getElementById("hero-loyalty-percent").textContent = `${state.rewardConfig.percent}%`;

  // Dải sinh nhật: hiện cho mọi khách khi admin có bật voucher sinh nhật (% > 0). % lấy theo cấu hình.
  const bday = document.getElementById("hero-birthday-hint");
  if (bday) {
    const showBday = state.birthdayPercent > 0;
    bday.classList.toggle("hidden", !showBday);
    if (showBday) document.getElementById("hero-birthday-percent").textContent = `${state.birthdayPercent}%`;
  }
}

document.getElementById("hero-loyalty-login")?.addEventListener("click", openCustomerModal);

// ── Mobile: floating hamburger (dưới nút giỏ) gộp chat/zalo/messenger ──
// Bấm hamburger → nảy 1 cái rồi 3 mục float lên (CSS lo animation); nút giỏ bị đẩy lên nhường chỗ.
(function initFabMenu() {
  const menu = document.getElementById("fab-menu");
  if (!menu) return;
  const toggle = document.getElementById("fab-toggle");
  const cart = document.getElementById("floating-cart");
  const setOpen = (on) => {
    menu.classList.toggle("open", on);
    toggle.setAttribute("aria-expanded", String(on));
    cart?.classList.toggle("nn-cart-push", on);
  };
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(!menu.classList.contains("open"));
  });
  // Chọn xong 1 mục thì đóng menu; riêng "tin nhắn" mở khung chat (dùng lại handler của #chat-fab).
  document.getElementById("fab-chat")?.addEventListener("click", () => {
    setOpen(false);
    document.getElementById("chat-fab")?.click();
  });
  document.getElementById("fab-zalo")?.addEventListener("click", () => setOpen(false));
  document.getElementById("fab-messenger")?.addEventListener("click", () => setOpen(false));
  // Bấm ra ngoài → đóng.
  document.addEventListener("click", (e) => {
    if (menu.classList.contains("open") && !menu.contains(e.target)) setOpen(false);
  });
})();

// Scroll-spy: tự sáng mục nav đúng phần đang xem, và con trượt nền trượt mượt tới mục đó.
function initNavSpy() {
  // Theo đúng thứ tự XUẤT HIỆN trên trang (reviews nằm trước contact ở footer).
  const ids = ["products", "custom-order", "reviews", "contact"];
  const pills = [...document.querySelectorAll(".nn-nav-pill, .nn-mini-pill")];
  const links = [...document.querySelectorAll(".nn-nav-pill a, .nn-mini-pill a")];
  if (!links.length) return;

  // Tạo con trượt (indicator) trong mỗi pill nếu chưa có.
  pills.forEach((pill) => {
    if (!pill.querySelector(".nn-nav-ind")) {
      const ind = document.createElement("span");
      ind.className = "nn-nav-ind";
      ind.setAttribute("aria-hidden", "true");
      pill.prepend(ind);
    }
  });

  const moveIndicators = () => {
    pills.forEach((pill) => {
      const ind = pill.querySelector(".nn-nav-ind");
      const active = pill.querySelector("a.is-active");
      if (!ind) return;
      if (!active || !active.offsetWidth) { ind.style.opacity = "0"; return; }
      ind.style.opacity = "1";
      ind.style.width = `${active.offsetWidth}px`;
      ind.style.height = `${active.offsetHeight}px`;
      ind.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    });
    // Bật transition SAU lần đặt vị trí đầu để không bị trượt từ góc lúc mới tải.
    requestAnimationFrame(() => pills.forEach((p) => p.querySelector(".nn-nav-ind")?.classList.add("is-ready")));
  };

  const onScroll = () => {
    let current = ids[0];
    // Cuộn chạm (gần) đáy trang → sáng mục cuối (Liên hệ), vì contact nằm sát đáy nên
    // không thể kéo lên đủ mốc; nếu không, quét bình thường theo thứ tự trang.
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
      current = ids[ids.length - 1];
    } else {
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 140) current = id;
      }
    }
    links.forEach((a) => a.classList.toggle("is-active", a.getAttribute("href") === `#${current}`));
    moveIndicators();
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", moveIndicators, { passive: true });
  onScroll();
  window.addEventListener("load", moveIndicators);
  setTimeout(moveIndicators, 350);
}

// Thanh nav gọn: hiện khi cuộn qua hero (chỉ desktop ≥1024px). Nút gọi lại đúng hàm cũ.
function initMiniNav() {
  const miniNav = document.getElementById("mini-nav");
  const heroSection = document.querySelector("main > section");
  if (!miniNav || !heroSection) return;
  const desktop = window.matchMedia("(min-width:821px)");
  const onScroll = () => {
    const past = heroSection.getBoundingClientRect().bottom < 40;
    miniNav.classList.toggle("is-show", desktop.matches && past);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  desktop.addEventListener("change", onScroll);
  onScroll();

  document.getElementById("mini-account-btn")?.addEventListener("click", openCustomerModal);
  document.getElementById("mini-cart-btn")?.addEventListener("click", openCart);
  document.getElementById("mini-logo")?.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
}

function renderCustomerPanel() {
  const c = state.currentCustomer;
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

  // Đếm đơn tích luỹ (tab Tổng quan) — số đơn đã thanh toán trong kỳ, từ RPC customer_loyalty.
  const paidOrders = state.loyalty?.paid_orders || 0;
  const cycle = state.rewardConfig.cycle || 10;
  const intoCycle = paidOrders % cycle;
  document.getElementById("customer-points").textContent = paidOrders;
  document.getElementById("customer-progress").style.width = `${(intoCycle / cycle) * 100}%`;
  document.getElementById("customer-progress-text").textContent =
    `Còn ${cycle - intoCycle} đơn nữa để nhận ưu đãi giảm ${state.rewardConfig.percent}%`;

  // Hạng thành viên (khung sang trọng + ladder trượt theo tổng chi 6 tháng)
  const tierBox = document.getElementById("customer-tier");
  tierBox.innerHTML = tierHeroHtml(state.loyalty?.period_spend || 0, state.tierConfig);
  activateLadders(tierBox);

  renderCustomerVouchers();
  renderBirthdayField();

  document.getElementById("customer-edit-name").value = c.name || "";
  document.getElementById("customer-edit-address").value = c.address || "";
}

// Kho voucher active của khách (mỗi thẻ có nút Tặng).
function renderCustomerVouchers() {
  const box = document.getElementById("customer-vouchers");
  const empty = document.getElementById("customer-vouchers-empty");
  const list = state.myVouchers || [];
  if (!list.length) {
    box.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  box.innerHTML = list.map(voucherCardHtml).join("");
  box.querySelectorAll("[data-gift-code]").forEach((btn) =>
    btn.addEventListener("click", () => openGiftModal(btn.dataset.giftCode))
  );
}

// Ô ngày sinh: nhập nếu chưa có; read-only nếu đã set (trigger DB khoá không cho đổi).
function renderBirthdayField() {
  const area = document.getElementById("customer-birthday-area");
  const bday = state.currentCustomer?.birthday;
  if (bday) {
    const d = new Date(bday);
    const txt = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
    area.innerHTML = `<input type="text" value="${txt}" readonly class="border border-earth/60 bg-earth/20 px-3 py-2 text-sm text-ash" /> <span class="text-xs font-medium text-green-700">✓ Đã lưu &amp; khoá</span>`;
  } else {
    area.innerHTML = `<input id="customer-birthday-input" type="date" class="border border-earth/60 bg-white px-3 py-2 text-sm text-ink outline-none focus:border-ink" /> <button id="customer-birthday-save" type="button" class="bg-ink px-4 py-2 text-sm font-medium text-white hover:opacity-90">Lưu ngày sinh</button>`;
    document.getElementById("customer-birthday-save").addEventListener("click", saveBirthday);
  }
}

async function saveBirthday() {
  const input = document.getElementById("customer-birthday-input");
  if (!input || !input.value || !state.currentCustomer) return;
  const { data, error } = await supabase
    .from("customers")
    .update({ birthday: input.value })
    .eq("phone", state.currentCustomer.phone)
    .select()
    .maybeSingle();
  if (error) { alert("Lỗi lưu ngày sinh: " + error.message); return; }
  if (data) {
    state.currentCustomer.birthday = data.birthday;
    state.currentCustomer.birthday_set_at = data.birthday_set_at;
    localStorage.setItem("nomnom_customer", JSON.stringify(state.currentCustomer));
  }
  await issueAndLoadVouchers();   // cấp voucher sinh nhật ngay nếu đúng tháng sinh
  renderBirthdayField();
  renderCustomerVouchers();
}

// Cấp voucher (idempotent) + tải kho voucher active & thông tin hạng. Gọi on-login + khi mở tài khoản.
async function issueAndLoadVouchers() {
  if (!state.currentCustomer) return;
  const phone = state.currentCustomer.phone;
  await supabase.rpc("issue_vouchers", { p_phone: phone });
  const [{ data: vs }, { data: loy }] = await Promise.all([
    supabase
      .from("vouchers")
      .select("code, percent, source, expires_at, issued_at")
      .eq("customer_phone", phone)
      .eq("status", "active")
      .order("issued_at", { ascending: false }),
    supabase.rpc("customer_loyalty", { p_phone: phone }),
  ]);
  const now = Date.now();
  state.myVouchers = (vs || []).filter((v) => !v.expires_at || new Date(v.expires_at).getTime() > now);
  if (loy && loy.length) {
    state.loyalty = { paid_orders: loy[0].paid_orders || 0, period_spend: Number(loy[0].period_spend) || 0 };
  }
}

async function refreshCustomerData() {
  if (!state.currentCustomer) return;
  // hồ sơ (tên/địa chỉ/avatar/ngày sinh)
  const { data } = await supabase
    .from("customers")
    .select("*")
    .eq("phone", state.currentCustomer.phone)
    .maybeSingle();
  if (data) {
    const { cart: _ignoredCart, ...profile } = data;
    state.currentCustomer = { ...state.currentCustomer, ...profile };
  }
  await issueAndLoadVouchers();
  localStorage.setItem("nomnom_customer", JSON.stringify(state.currentCustomer));
  updateAccountLabel();
  if (!customerPanel.classList.contains("hidden")) renderCustomerPanel();
}

// ── Tặng voucher cho khách khác: đổi chủ nếu SĐT đã đăng ký / copy tay nếu chưa ──
let giftCode = null;
function openGiftModal(code) {
  giftCode = code;
  document.getElementById("gift-phone").value = "";
  document.getElementById("gift-result").innerHTML = "";
  document.getElementById("gift-go").style.display = "";
  const m = document.getElementById("gift-modal");
  m.classList.remove("hidden");
  m.classList.add("flex");
}
function closeGiftModal() {
  const m = document.getElementById("gift-modal");
  m.classList.add("hidden");
  m.classList.remove("flex");
}
document.getElementById("gift-cancel").addEventListener("click", closeGiftModal);
document.getElementById("gift-modal").addEventListener("click", (e) => { if (e.target.id === "gift-modal") closeGiftModal(); });
document.getElementById("gift-go").addEventListener("click", async () => {
  const phone = document.getElementById("gift-phone").value.trim();
  const res = document.getElementById("gift-result");
  if (!/^0\d{8,10}$/.test(phone)) { res.innerHTML = `<p class="mt-2 text-xs text-[#7a0c1f]">SĐT không hợp lệ.</p>`; return; }
  if (state.currentCustomer && phone === state.currentCustomer.phone) { res.innerHTML = `<p class="mt-2 text-xs text-[#7a0c1f]">Không thể tự tặng cho chính mình.</p>`; return; }
  const { data, error } = await supabase.rpc("gift_voucher", { p_code: giftCode, p_to_phone: phone });
  if (error) {
    if (/chưa có tài khoản/i.test(error.message)) {
      res.innerHTML = `
        <p class="mt-2 text-xs text-ash">SĐT này chưa có tài khoản nomnom. Copy mã dưới đây gửi cho bạn của bạn — mã vẫn ở kho tới khi được dùng.</p>
        <div class="mt-2 flex items-center gap-2 rounded-lg border border-dashed border-[#7a0c1f] bg-[#7a0c1f]/5 px-3 py-2">
          <span class="flex-1 font-mono text-sm font-bold tracking-wider">${giftCode}</span>
          <button type="button" id="gift-copy" class="border border-earth px-3 py-1.5 text-xs hover:border-ink">Copy</button>
        </div>`;
      document.getElementById("gift-copy").addEventListener("click", (e) => {
        navigator.clipboard?.writeText(giftCode);
        e.target.textContent = "Đã copy ✓";
      });
    } else {
      res.innerHTML = `<p class="mt-2 text-xs text-[#7a0c1f]">${error.message}</p>`;
    }
    document.getElementById("gift-go").style.display = "none";
    return;
  }
  res.innerHTML = `<p class="mt-2 text-xs text-green-700">✓ Đã chuyển mã ${giftCode} sang <b>${data}</b> (${phone}). Mã đã rời kho của bạn.</p>`;
  document.getElementById("gift-go").style.display = "none";
  await issueAndLoadVouchers();
  renderCustomerVouchers();
});

// ── Đồng bộ giỏ hàng theo tài khoản (đăng nhập lại / đổi thiết bị vẫn còn giỏ) ──

let pushCartTimer = null;
let pushCartPhone = null;

// Debounce ghi giỏ lên tài khoản: gộp nhiều lần đổi giỏ (bấm +/- liên tục) thành 1 UPDATE
// sau ~1s, thay vì bắn 1 UPDATE mỗi lần bấm.
function schedulePushCart(phone) {
  pushCartPhone = phone;
  clearTimeout(pushCartTimer);
  pushCartTimer = setTimeout(() => {
    pushCartTimer = null;
    pushCartToAccount(pushCartPhone);
  }, 1000);
}

// Ghi ngay lần chờ cuối (đóng tab / rời trang / trước khi thanh toán). Không có bước này,
// khách đóng tab trong vòng 1s sau khi đổi giỏ sẽ mất lần ghi đó khi mở ở thiết bị khác.
function flushPushCart() {
  if (!pushCartTimer) return;
  clearTimeout(pushCartTimer);
  pushCartTimer = null;
  if (pushCartPhone) pushCartToAccount(pushCartPhone);
}

window.addEventListener("pagehide", flushPushCart);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushPushCart();
});

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
    // Cả máy và tài khoản đều có hàng — gộp lại, không mất món của bên nào.
    // Món trùng: lấy MAX (không CỘNG) — nếu cộng thì mỗi lần reload/đăng nhập lại,
    // giỏ ở máy và giỏ đã lưu vốn giống nhau sẽ tự nhân đôi số lượng (6→12→24...).
    remoteCart.forEach((rItem) => {
      const local = cart.find((i) => i.id === rItem.id);
      if (local) local.qty = Math.max(local.qty, rItem.qty);
      else cart.push(rItem);
    });
  }

  saveCart(); // state.currentCustomer đã được gán trước khi gọi hàm này nên sẽ tự đẩy giỏ đã gộp lên tài khoản
}

document.getElementById("account-btn").addEventListener("click", openCustomerModal);
document.getElementById("customer-login-cancel").addEventListener("click", closeCustomerModal);
document.getElementById("customer-panel-close").addEventListener("click", closeCustomerModal);
customerModal.addEventListener("click", (e) => {
  if (e.target === customerModal) closeCustomerModal();
});

// Đăng nhập/đăng ký khách theo SĐT (upsert bảng customers) + gán state.currentCustomer.
// Dùng chung cho FORM đăng nhập và cho CHECKOUT (đặt hàng xong tự đăng nhập theo SĐT vừa nhập,
// nên không còn khái niệm "khách vãng lai"). Trả { customer } khi thành công, { error } khi lỗi.
async function signInCustomer(phone, name, address) {
  if (!/^[0-9]{8,12}$/.test(phone)) return { error: "Số điện thoại không hợp lệ." };

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
    if (error) return { error: error.message };
    customer = created;
  }

  state.currentCustomer = customer;
  localStorage.setItem("nomnom_customer", JSON.stringify(customer));
  updateAccountLabel();
  return { customer };
}

customerLoginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const phone = customerLoginForm.elements.phone.value.trim();
  const name = customerLoginForm.elements.name.value.trim();
  const address = customerLoginForm.elements.address.value.trim();

  const { customer, error } = await signInCustomer(phone, name, address);
  if (error) {
    customerLoginError.textContent = error === "Số điện thoại không hợp lệ." ? error : "Lỗi: " + error;
    customerLoginError.classList.remove("hidden");
    return;
  }

  customerLoginError.classList.add("hidden");
  customerLoginForm.reset();
  openCustomerModal();
  await syncCartWithAccount(customer);
  restartChatWatcher();
  startPresence();
});

document.getElementById("customer-save").addEventListener("click", async () => {
  if (!state.currentCustomer) return;
  const name = document.getElementById("customer-edit-name").value.trim();
  const address = document.getElementById("customer-edit-address").value.trim();
  const { data } = await supabase
    .from("customers")
    .update({ name: name || null, address: address || null })
    .eq("phone", state.currentCustomer.phone)
    .select()
    .maybeSingle();
  if (data) {
    // `points`/`vouchers_used` là cột legacy (=0, không còn dùng sau khi chuyển sang voucher-có-mã);
    // `cart` là dữ liệu giỏ. Loại khỏi row trước khi merge để không đè state hiển thị.
    const { points: _p, vouchers_used: _vu, cart: _ignoredCart, ...profile } = data;
    state.currentCustomer = { ...state.currentCustomer, ...profile };
    localStorage.setItem("nomnom_customer", JSON.stringify(state.currentCustomer));
    updateAccountLabel();
    renderCustomerPanel();
  }
});

document.getElementById("customer-logout").addEventListener("click", () => {
  state.currentCustomer = null;
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
  if (!state.currentCustomer || !file.type.startsWith("image/")) return;
  file = await compressImage(file, { maxDim: 400 }); // avatar nhỏ nên nén mạnh hơn
  const ext = file.name.split(".").pop();
  const name = `avatar-${state.currentCustomer.phone}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from("product-images")
    .upload(name, file, { upsert: true, cacheControl: "31536000" });
  if (error) {
    alert("Lỗi tải ảnh: " + error.message);
    return;
  }
  const { data: url } = supabase.storage.from("product-images").getPublicUrl(name);
  const { data } = await supabase
    .from("customers")
    .update({ avatar_url: url.publicUrl })
    .eq("phone", state.currentCustomer.phone)
    .select()
    .maybeSingle();
  if (data) {
    state.currentCustomer = { ...state.currentCustomer, ...data };
    localStorage.setItem("nomnom_customer", JSON.stringify(state.currentCustomer));
    renderCustomerPanel();
  }
}

// ── Chat (khách + bảng admin) + Presence → đã tách sang src/storefront/chat.js (initChat / restartChatWatcher / startPresence / setChatAdminMode) ──

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
if (state.currentCustomer) syncCartWithAccount(state.currentCustomer);
// Chỉ GẮN listener + dựng khung ở đây. Việc TẢI DỮ LIỆU (products/hero/settings/reviews)
// và bật realtime do handler onAuthStateChange lo (chạy 1 lần khi phiên vừa resolve), để
// tải đúng trạng thái admin/khách, không tải 2 lần và không deadlock Supabase.
initChat();
initHero();
initReviews();
initMiniNav();
initNavSpy();
initAnalytics(); // ghi page_view cho view Traffic của admin (không chặn, tự nuốt lỗi)
