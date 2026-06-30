import { supabase } from "../supabase.js";

export const PRESENCE_CHANNEL_NAME = "nomnom-presence";

// Tham gia kênh Presence dùng chung giữa storefront và admin — mỗi bên tự "track"
// dưới 1 key riêng (khách: conversation_id, shop: "shop"), bên kia chỉ cần đọc
// presenceState() để biết key nào đang online ngay lúc này (không tốn DB).
export function joinPresence(key, onSync) {
  const channel = supabase.channel(PRESENCE_CHANNEL_NAME, {
    config: { presence: { key } },
  });
  channel
    .on("presence", { event: "sync" }, () => onSync(channel.presenceState()))
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ online_at: new Date().toISOString() });
        onSync(channel.presenceState());
      }
    });
  return channel;
}

// Ghi nhẹ "lần cuối hoạt động" — chỉ dùng để hiện "offline X phút trước" khi
// presence không còn thấy online (ví dụ đóng hẳn tab/trình duyệt).
export async function upsertHeartbeat(id) {
  try {
    await supabase.from("presence_heartbeats").upsert({ id, last_seen: new Date().toISOString() });
  } catch (e) {
    // không chặn trải nghiệm nếu bảng presence_heartbeats chưa sẵn sàng
  }
}

export function startHeartbeatLoop(getId, intervalMs = 25000) {
  upsertHeartbeat(getId());
  return setInterval(() => upsertHeartbeat(getId()), intervalMs);
}

export async function fetchLastSeen(id) {
  const { data } = await supabase.from("presence_heartbeats").select("last_seen").eq("id", id).maybeSingle();
  return data?.last_seen || null;
}

export async function fetchAllLastSeen() {
  const { data } = await supabase.from("presence_heartbeats").select("*");
  return new Map((data || []).map((row) => [row.id, row.last_seen]));
}
