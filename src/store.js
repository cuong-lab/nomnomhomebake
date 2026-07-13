// Trạng thái dùng chung giữa các module của trang khách (storefront).
//
// Vì nhiều module cùng đọc/ghi (isAdmin, cart, currentCustomer...), state phải nằm
// 1 chỗ dưới dạng object mutable — KHÔNG dùng `export let` vì binding của ES module
// không cho gán lại xuyên file. Mỗi nơi đọc `state.isAdmin`, mỗi nơi ghi `state.isAdmin = ...`.
//
// File này được mở rộng dần theo từng pha tách module (xem plan). Hiện giữ:
//   - isAdmin:          cô chủ đã đăng nhập admin trên storefront hay chưa (bật UI quản lý inline).
//   - currentCustomer:  khách đang đăng nhập (SĐT) — dùng cho giỏ hàng, tích điểm, chat.
//   - bankSettings:     thông tin ngân hàng để tạo QR (do contact/settings nạp).
//   - rewardConfig:     cấu hình tích điểm { cycle, percent } (do settings nạp).
//   - freeShipThreshold: ngưỡng miễn phí ship (do settings nạp).
//   - chatAutoReply:     câu trả lời tự động khi khách nhắn lần đầu (do settings nạp).
export const state = {
  isAdmin: false,
  currentCustomer: JSON.parse(localStorage.getItem("nomnom_customer") || "null"),
  bankSettings: {},
  shopInfo: { phone: "", address: "", zalo: "" }, // SĐT/địa chỉ tiệm (nạp từ site_settings) — dùng cho thẻ theo dõi đơn
  trackingMessages: null, // 4 mẫu tin báo mốc do cô chủ sửa (site_settings.tracking_messages); null = dùng mặc định
  rewardConfig: { cycle: 10, percent: 20 },
  freeShipThreshold: 0,
  chatAutoReply: "",
  // ── Voucher & hạng khách (nạp từ site_settings + RPC) ──
  tierConfig: [],            // [{name,min_spend,monthly_count,percent}] — 4 hạng, admin sửa
  birthdayPercent: 0,        // % voucher sinh nhật
  maxVouchersPerOrder: 2,    // số voucher tối đa mỗi đơn
  maxDiscountAmount: 0,      // trần giảm theo tiền/đơn (0 = không giới hạn)
  myVouchers: [],            // kho voucher active của khách đang đăng nhập
  loyalty: { paid_orders: 0, period_spend: 0 }, // số đơn + tổng chi 6 tháng (RPC customer_loyalty)
};

// Mặc định 4 hạng khi site_settings chưa có tier_config (admin sửa được).
export const DEFAULT_TIERS = [
  { name: "Đồng", min_spend: 0, monthly_count: 3, percent: 5 },
  { name: "Bạc", min_spend: 500000, monthly_count: 5, percent: 10 },
  { name: "Vàng", min_spend: 1200000, monthly_count: 5, percent: 15 },
  { name: "Kim cương", min_spend: 2500000, monthly_count: 5, percent: 20 },
];
