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
    return res.status(200).json({ success: true, message: "No order code found" });
  }

  const orderCode = match[0];

  const { data: order, error: fetchErr } = await supabase
    .from("orders")
    .select("id, total, status")
    .eq("order_code", orderCode)
    .single();

  if (fetchErr || !order) {
    return res.status(200).json({ success: false, message: "Order not found" });
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

  return res.status(200).json({ success: true, message: `Order ${orderCode} marked as paid` });
}
