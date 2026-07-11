import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Chỉ xoá hội thoại của khách vãng lai (conversation_id dạng "guest-...") sau 30 ngày.
// Khách đã đăng nhập dùng conversation_id = số điện thoại nên không bao giờ bị xoá ở đây.
export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers["authorization"] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { error, count } = await supabase
    .from("chat_messages")
    .delete({ count: "exact" })
    .like("conversation_id", "guest-%")
    .lt("created_at", cutoff);

  if (error) {
    return res.status(500).json({ success: false, message: error.message });
  }

  return res.status(200).json({ success: true, deleted: count || 0 });
}
