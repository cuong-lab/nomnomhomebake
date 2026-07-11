import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Cron hằng ngày: cấp voucher cho MỌI khách (idempotent) — chủ động cấp voucher hạng đầu
// tháng + voucher sinh nhật đúng ngày, không phụ thuộc khách có mở web hay không.
// issue_vouchers() dùng pg_advisory_xact_lock + kiểm tra period_key nên gọi lại KHÔNG tạo trùng.
// Tiệm nhỏ nên duyệt-tất-cả hằng ngày là đủ nhẹ.
export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers["authorization"] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { data: customers, error } = await supabase.from("customers").select("phone");
  if (error) {
    return res.status(500).json({ success: false, message: error.message });
  }

  let issued = 0;
  let failed = 0;
  for (const c of customers || []) {
    const { error: e } = await supabase.rpc("issue_vouchers", { p_phone: c.phone });
    if (e) failed++;
    else issued++;
  }

  return res.status(200).json({ success: true, issued, failed, total: customers?.length || 0 });
}
