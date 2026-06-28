import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.SEPAY_API_KEY;
  if (apiKey && req.headers["authorization"] !== `Apikey ${apiKey}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { transferType, transferAmount, content } = req.body;

  if (transferType !== "in") {
    return res.status(200).json({ success: true, message: "Ignored outgoing transfer" });
  }

  const match = (content || "").match(/NN\d{8}/);
  if (!match) {
    return res.status(200).json({ success: false, message: "No order code found", content });
  }

  const orderCode = match[0];

  const { data: order, error: fetchErr } = await supabase
    .from("orders")
    .select("id, total, status, customer_phone, customer_name, customer_address, voucher_percent")
    .eq("order_code", orderCode)
    .maybeSingle();

  if (fetchErr) {
    return res.status(200).json({ success: false, message: "DB error", error: fetchErr.message, orderCode });
  }

  if (!order) {
    return res.status(200).json({ success: false, message: "Order not found", orderCode });
  }

  if (order.status !== "pending") {
    return res.status(200).json({ success: true, message: "Order already processed" });
  }

  if (transferAmount < order.total) {
    return res.status(200).json({ success: false, message: "Amount mismatch" });
  }

  const { error: updateErr } = await supabase
    .from("orders")
    .update({ status: "paid" })
    .eq("id", order.id);

  if (updateErr) {
    return res.status(500).json({ success: false, message: updateErr.message });
  }

  // Đảm bảo có hồ sơ khách (cho khách vãng lai chưa đăng nhập).
  // Điểm KHÔNG cộng ở đây — tính động từ bảng orders qua hàm customer_stats,
  // nên đúng với mọi cách đánh dấu paid (webhook, admin chốt tay, app).
  if (order.customer_phone) {
    try {
      const { data: cust } = await supabase
        .from("customers")
        .select("phone")
        .eq("phone", order.customer_phone)
        .maybeSingle();
      if (!cust) {
        await supabase.from("customers").insert({
          phone: order.customer_phone,
          name: order.customer_name || null,
          address: order.customer_address || null,
        });
      }
    } catch (e) {
      // không chặn việc đánh dấu paid nếu tạo hồ sơ lỗi
    }
  }

  return res.status(200).json({ success: true, message: `Order ${orderCode} marked as paid` });
}
