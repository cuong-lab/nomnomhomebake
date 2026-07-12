// ── Analytics: ghi 1 'page_view' vào analytics_events mỗi lần tải trang storefront ──
// Trước đây KHÔNG có đoạn nào ghi bảng này → admin đọc mãi vẫn ra 0 (traffic không nhích).
//
// Cách đếm (để đối chiếu với Vercel):
//  • visitor_id  — cố định theo trình duyệt (localStorage) → "khách duy nhất".
//  • session_id  — theo phiên/tab (sessionStorage), mất khi đóng tab → "phiên".
//  • mỗi lần tải trang = 1 dòng 'page_view' → "lượt xem trang".
// Lưu ý khác biệt với Vercel: Vercel gộp khách theo ngày (IP+UA, có lọc bot); cách này
// gộp theo visitor_id trong trình duyệt. Con số sẽ GẦN nhau chứ không khớp tuyệt đối
// (trình chặn quảng cáo / ẩn danh / xoá localStorage đều làm lệch — đó là chuyện bình thường).
import { supabase } from "../supabase.js";

const VISITOR_KEY = "nn_visitor_id";
const SESSION_KEY = "nn_session_id";

function newId() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Lấy id đã lưu, chưa có thì tạo mới. Storage bị chặn (chế độ riêng tư) → dùng id tạm.
function persistedId(storage, key) {
  try {
    let id = storage.getItem(key);
    if (!id) {
      id = newId();
      storage.setItem(key, id);
    }
    return id;
  } catch {
    return newId();
  }
}

export async function initAnalytics() {
  try {
    // KHÔNG đếm lượt của chính admin: chủ tiệm đăng nhập (Supabase Auth email/mật khẩu) để quản lý
    // storefront ngay trên trang index → nếu không loại thì mỗi lần vào quản lý đều bị tính 1 page_view.
    // Khách hàng đăng nhập bằng SĐT (KHÔNG tạo phiên Supabase Auth) nên không bị loại nhầm — chỉ admin
    // mới có session. getSession() đọc từ localStorage, không gọi mạng nên không làm chậm trang.
    const { data: { session } } = await supabase.auth.getSession();
    if (session) return;

    await supabase.from("analytics_events").insert({
      visitor_id: persistedId(localStorage, VISITOR_KEY),
      session_id: persistedId(sessionStorage, SESSION_KEY),
      event_name: "page_view",
      path: location.pathname + location.search,
    });
  } catch (err) {
    // Tracking hỏng KHÔNG được làm ảnh hưởng trải nghiệm mua hàng → nuốt lỗi (chỉ log khi dev).
    if (import.meta.env?.DEV) console.warn("[analytics] page_view lỗi:", err?.message || err);
  }
}
