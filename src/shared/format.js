export function formatCurrency(value) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

// Alias tường minh cho giá tiền — dùng ở storefront (giỏ hàng, sản phẩm, tài khoản).
export const formatPrice = formatCurrency;

// Bản đầy đủ có năm — dùng cho phiếu in bếp và lịch sử mua hàng (khác formatDateTime dùng chung).
export function formatDateTimeLong(value) {
  return value
    ? new Date(value).toLocaleString("vi-VN", {
        hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric",
      })
    : "--";
}

export function formatDateTime(value) {
  return value
    ? new Intl.DateTimeFormat("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "2-digit",
      }).format(new Date(value))
    : "--";
}

export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

export function timeAgo(value) {
  const diffMs = Date.now() - new Date(value).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "vừa mới offline";
  if (mins < 60) return `offline ${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `offline ${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  return `offline ${days} ngày trước`;
}
