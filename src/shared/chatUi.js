import { escapeHtml } from "./format.js";

const AVATAR_COLORS = ["#7a0c1f", "#0068ff", "#34C759", "#f39c12", "#8e44ad", "#16a085", "#e74c3c", "#2c3e50"];

export function avatarColor(name) {
  const str = name || "?";
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function avatarHtml(name, online) {
  const letter = (name || "?").charAt(0).toUpperCase();
  return `
    <span class="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white" style="background:${avatarColor(name)}">
      ${escapeHtml(letter)}
      <span class="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white ${online ? "bg-[#34C759]" : "bg-ash"}"></span>
    </span>
  `;
}

export function chatBubbleHtml(message, mine) {
  return `
    <div class="flex ${mine ? "justify-end" : "justify-start"}">
      <div class="chat-bubble ${mine ? "chat-bubble--mine bg-ink text-white" : "chat-bubble--them border border-earth/40 bg-white text-ink"} max-w-[75%] rounded-2xl px-3 py-2">
        <p class="whitespace-pre-wrap break-words text-sm">${escapeHtml(message.message)}</p>
      </div>
    </div>
  `;
}

// Skeleton giữ chỗ khi đang tải nội dung 1 hội thoại (xen kẽ trái/phải cho giống chat thật)
export function chatThreadSkeletonHtml() {
  const rows = [
    ["justify-start", "w-32"],
    ["justify-end", "w-40"],
    ["justify-start", "w-24"],
    ["justify-end", "w-28"],
  ];
  return rows
    .map(([side, w]) => `<div class="flex ${side}"><div class="skeleton h-8 ${w} rounded-2xl"></div></div>`)
    .join("");
}
