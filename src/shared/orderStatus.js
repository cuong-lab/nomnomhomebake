import { supabase } from "../supabase.js";

export const ORDER_STATUS = {
  pending: { label: "Chờ thanh toán", tone: "amber" },
  paid: { label: "Đã thanh toán", tone: "green" },
  delivered: { label: "Đã giao", tone: "ash" },
  cancelled: { label: "Đã hủy", tone: "red" },
};

export function updateOrderStatus(id, status) {
  return supabase.from("orders").update({ status }).eq("id", id);
}

// ── Mốc giao vận THỦ CÔNG (fulfillment_stage) ──
// Độc lập hoàn toàn với `status` thanh toán ở trên (không đụng doanh thu). Admin tick
// theo thứ tự; stage 0 = chưa xử lý. Khách xem timeline động dựa trên các mốc này.
export const FULFILLMENT_STAGES = [
  { stage: 1, label: "Đã nhận đơn", icon: "check" },
  { stage: 2, label: "Đang làm", icon: "bake" },
  { stage: 3, label: "Đang giao", icon: "bike" },
  { stage: 4, label: "Hoàn thành", icon: "done" },
];

export function updateFulfillmentStage(id, stage, log) {
  const patch = { fulfillment_stage: stage };
  if (log !== undefined) patch.fulfillment_log = log; // { "1": ISO, "2": ISO, ... } — giờ cô chủ xác nhận từng mốc
  return supabase.from("orders").update(patch).eq("id", id);
}

// Tính lại nhật ký giờ khi admin đổi mốc: tiến tới N → đóng dấu giờ cho N (nếu chưa có);
// lùi về M → xoá các mốc > M (coi như sửa/hoàn tác). Trả về object log mới.
export function computeFulfillmentLog(order, newStage) {
  const log = { ...(order?.fulfillment_log || {}) };
  if (newStage <= 0) return {};
  Object.keys(log).forEach((k) => { if (Number(k) > newStage) delete log[k]; });
  if (!log[newStage]) log[newStage] = new Date().toISOString();
  return log;
}

// Tin nhắn tự động báo khách mỗi khi admin TIẾN tới một mốc mới. Đẩy thẳng vào khung chat
// của khách (conversation_id = SĐT khách) như một tin "shop" — khách đang online sẽ thấy
// pop ngay, offline thì tin vẫn nằm đó chờ họ mở. Fire-and-forget (không chặn luồng admin).
// Nội dung do cô chủ sửa được (site_settings.tracking_messages); dùng {ma} để chèn mã đơn.
export const DEFAULT_STAGE_MESSAGES = {
  1: "🧾 nomnom đã nhận đơn {ma} của bạn rồi, đang chuẩn bị nha!",
  2: "👩‍🍳 Đơn {ma} đang được làm — bánh sắp ra lò rồi!",
  3: "🛵 Đơn {ma} đang trên đường giao tới bạn, chờ chút nhé!",
  4: "✅ Đơn {ma} đã hoàn thành. Cảm ơn bạn nhiều, hẹn gặp lại! 🧁",
};

// QUAN TRỌNG: phải là async + await insert bên trong. Query của supabase-js v2 là "lazy" —
// chỉ thực sự gửi lên server khi được await/.then(). Trước đây gọi fire-and-forget (không await)
// nên insert KHÔNG BAO GIỜ chạy → khách không nhận được tin báo mốc. Await nội bộ đảm bảo nó chạy.
export async function notifyCustomerStage(order, stage, templates) {
  const phone = order?.customer_phone;
  const tpl = (templates && templates[stage]) || DEFAULT_STAGE_MESSAGES[stage];
  if (!phone || !tpl) return; // mốc 0 / lùi về 0 → không nhắn
  const message = tpl.replaceAll("{ma}", order.order_code || "của bạn");
  const { error } = await supabase.from("chat_messages").insert({
    conversation_id: phone,
    customer_name: "nomnom",
    sender: "shop",
    message,
  });
  if (error) console.warn("notifyCustomerStage lỗi gửi tin:", error.message);
}
