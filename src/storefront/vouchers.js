// ── Voucher & Hạng khách: hàm dựng UI (port 1:1 từ demo-voucher.html) ──
// Chỉ chứa hàm THUẦN dựng HTML + tính hạng; phần nạp dữ liệu / redeem / gift RPC
// nằm ở main.js (nơi giữ cart/state). Xem plan "Nâng cấp hệ thống VOUCHER/LOYALTY".

import { formatCurrency } from "../shared/format.js";

export const SRC_LABEL = { tier: "Hạng tháng", cycle: "Đủ đơn", birthday: "Sinh nhật", gift: "Được tặng", manual: "Nhập tay" };
const SRC_CLASS = { tier: "v-src-tier", cycle: "v-src-cycle", birthday: "v-src-birthday", gift: "v-src-gift", manual: "v-src-manual" };

// Icon riêng mỗi hạng: Đồng khiên · Bạc sao · Vàng vương miện · Kim cương gem
const IC_SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 2l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V5z"/></svg>';
const IC_STAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 2l2.4 7.4H22l-6 4.6 2.3 7.4-6.3-4.6L5.7 21l2.3-7.4-6-4.6h7.6z"/></svg>';
const IC_CROWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2.5 8l4.5 3.2L12 4l5 7.2L21.5 8l-1.8 10.5H4.3z"/><path d="M4.3 18.5h15.4"/></svg>';
const IC_GEM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M6 3h12l3.5 5.5L12 21 2.5 8.5z"/><path d="M2.5 8.5h19M8.5 3l-2.5 5.5L12 21M15.5 3l2.5 5.5L12 21"/></svg>';
const TIER_ICONS = [IC_SHIELD, IC_STAR, IC_CROWN, IC_GEM];
const TIER_THEME = ["th-dong", "th-bac", "th-vang", "th-kc"];
const TRACE_PER_SEG = 4;

// Xác định hạng hiện tại từ tổng chi + tier_config (đã sắp tăng dần theo min_spend).
export function computeTier(spend, tierConfig) {
  const tiers = (tierConfig || []).slice().sort((a, b) => a.min_spend - b.min_spend);
  if (!tiers.length) return null;
  let idx = 0;
  for (let i = 0; i < tiers.length; i++) if (spend >= tiers[i].min_spend) idx = i;
  const last = tiers.length - 1;
  const cur = tiers[idx];
  const next = idx < last ? tiers[idx + 1] : null;
  const frac = next ? Math.max(0, Math.min(1, (spend - cur.min_spend) / (next.min_spend - cur.min_spend))) : 1;
  return { tiers, idx, last, cur, next, frac };
}

function ladderHtml(tiers, curIdx, frac) {
  const last = tiers.length - 1;
  const markerPct = curIdx >= last ? 100 : (curIdx + frac) / last * 100;
  let nodes = "";
  for (let i = 0; i < tiers.length; i++) {
    const done = i <= curIdx;
    nodes += `<div class="tl-node ${done ? "done" : ""}" style="left:${(i / last * 100).toFixed(3)}%"><span class="dot"></span><span class="lbl">${tiers[i].name}</span></div>`;
  }
  let traces = "";
  for (let s = 0; s < last; s++) {
    for (let k = 0; k < TRACE_PER_SEG; k++) {
      const pos = s / last * 100 + (k + 1) / (TRACE_PER_SEG + 1) * (100 / last);
      const lit = pos <= markerPct + 0.01 ? 1 : 0;
      const delay = (pos / 100 * 0.9).toFixed(2);
      traces += `<span class="tl-trace" data-lit="${lit}" style="left:${pos.toFixed(3)}%;transition-delay:${delay}s"></span>`;
    }
  }
  return `<div class="tier-ladder"><div class="tl-track">
    <div class="tl-rail"></div>
    <div class="tl-fill" data-width="${markerPct.toFixed(2)}" style="width:0%"></div>
    ${traces}${nodes}
    <div class="tl-marker" data-left="${markerPct.toFixed(2)}" style="left:0%"></div>
  </div></div>`;
}

// Dựng khung hạng (medal + tên + quyền lợi + ladder + tiến trình). Trả "" nếu chưa có tier_config.
export function tierHeroHtml(spend, tierConfig) {
  const t = computeTier(spend, tierConfig);
  if (!t) return "";
  const { tiers, idx, cur, next } = t;
  const icon = TIER_ICONS[idx] || IC_STAR;
  const theme = TIER_THEME[idx] || "th-vang";
  const progLbl = next
    ? `Còn <b>${formatCurrency(next.min_spend - spend)}</b> nữa lên <b>${next.name}</b> (mốc ${formatCurrency(next.min_spend)}).`
    : `Bạn đang ở <b>hạng cao nhất</b> 👑 — cảm ơn bạn đã đồng hành!`;
  return `<div class="tier-hero ${theme}">
    <div class="tier-hero__main">
      <span class="tier-medal">${icon}</span>
      <div>
        <p class="tier-hero__eyebrow">Hạng thành viên</p>
        <h3 class="tier-hero__name">${cur.name}</h3>
        <p class="tier-hero__spend">Đã chi <b>${formatCurrency(spend)}</b> trong 6 tháng này</p>
      </div>
      <div class="tier-hero__perk">
        <span class="tier-hero__perk-num">${cur.monthly_count} × ${cur.percent}%</span>
        <span class="tier-hero__perk-lbl">voucher mỗi tháng</span>
      </div>
    </div>
    ${ladderHtml(tiers, idx, t.frac)}
    <div class="tier-progress">
      <div class="bar"><div class="bar-fill" data-width="${Math.round(t.frac * 100)}" style="width:0%"></div></div>
      <p class="lbl">${progLbl}</p>
    </div>
  </div>`;
}

// Kích hoạt animation trượt: đợi 2 frame cho trình duyệt nhận vị trí 0% rồi set về đích.
export function activateLadders(root = document) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.querySelectorAll(".tl-fill[data-width], .tier-progress .bar-fill[data-width]").forEach((el) => (el.style.width = el.dataset.width + "%"));
    root.querySelectorAll(".tl-marker[data-left]").forEach((el) => (el.style.left = el.dataset.left + "%"));
    root.querySelectorAll('.tl-trace[data-lit="1"]').forEach((el) => el.classList.add("lit"));
  }));
}

// HSD hiển thị trên thẻ voucher.
function expLabel(expires_at) {
  if (!expires_at) return "Không hết hạn";
  const d = new Date(expires_at);
  return `HSD ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Thẻ voucher trong KHO tài khoản (có nút Tặng).
export function voucherCardHtml(v) {
  return `<div class="vcard" data-code="${v.code}">
    <button class="v-gift" data-gift-code="${v.code}">Tặng ↗</button>
    <div class="pct">-${v.percent}%</div>
    <div class="code">${v.code}</div>
    <div class="meta"><span class="v-src ${SRC_CLASS[v.source] || ""}">${SRC_LABEL[v.source] || v.source}</span><span>${expLabel(v.expires_at)}</span></div>
  </div>`;
}

// Ô voucher ở CHECKOUT (chọn để áp).
export function coVoucherHtml(v, { on, disabled }) {
  return `<label class="co-v ${on ? "on" : ""} ${disabled ? "disabled" : ""}" data-code="${v.code}">
    <input type="checkbox" ${on ? "checked" : ""} ${disabled ? "disabled" : ""} class="pointer-events-none" />
    <span class="pct">-${v.percent}%</span>
    <span class="code">${v.code}</span>
    <span class="v-src ${SRC_CLASS[v.source] || ""}">${SRC_LABEL[v.source] || v.source}</span>
  </label>`;
}
