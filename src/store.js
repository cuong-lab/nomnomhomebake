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
  rewardConfig: { cycle: 10, percent: 20 },
  freeShipThreshold: 0,
  chatAutoReply: "",
};
