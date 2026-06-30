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
