// ── Chat trực tiếp với shop (khung chat nổi) ──
// Cùng 1 khung: khách thường thấy chat 1-1 với shop; cô chủ đăng nhập admin thì tự
// chuyển thành bảng kiểu Messenger (danh sách hội thoại + nội dung).
// Export:
//   - initChat():          gắn sự kiện + khởi động watcher/presence lần đầu (Init gọi).
//   - restartChatWatcher(): mở lại kênh realtime cho hội thoại hiện tại (đổi tài khoản).
//   - startPresence():      cập nhật trạng thái online của shop cho khung khách.
//   - setChatAdminMode():   bật/tắt chế độ bảng tin nhắn admin (auth handler gọi).

import { supabase } from "../supabase.js";
import { escapeHtml, formatDateTime, timeAgo } from "../shared/format.js";
import { avatarHtml, chatBubbleHtml, chatThreadSkeletonHtml } from "../shared/chatUi.js";
import { joinPresence, startHeartbeatLoop, fetchLastSeen, fetchAllLastSeen } from "../shared/presence.js";
import { state } from "../store.js";

const chatFab = document.getElementById("chat-fab");
const chatPanel = document.getElementById("chat-panel");
const chatMessagesBox = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

let chatChannel = null;
let chatMessageCache = [];
let chatUnreadCount = 0;
let chatIdleTimer = null;
let chatTypingHideTimer = null;
let chatTypingSendThrottle = null;

function getChatConversationId() {
  if (state.currentCustomer) return state.currentCustomer.phone;
  let guestId = localStorage.getItem("nomnom_chat_guest_id");
  if (!guestId) {
    guestId = "guest-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("nomnom_chat_guest_id", guestId);
  }
  return guestId;
}

function getChatDisplayName() {
  return (state.currentCustomer && (state.currentCustomer.name || state.currentCustomer.phone)) || "Khách vãng lai";
}

function updateChatBadge() {
  // Cập nhật cả badge trên chat-fab (desktop) lẫn trên hamburger #fab-toggle (mobile).
  ["chat-fab-badge", "fab-toggle-badge"].forEach((id) => {
    const badge = document.getElementById(id);
    if (!badge) return;
    badge.textContent = chatUnreadCount;
    badge.classList.toggle("hidden", chatUnreadCount === 0);
  });
}

const CHAT_SHOP_AVATAR_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>`;

function renderChatMessages(messages) {
  if (!messages.length) {
    chatMessagesBox.innerHTML = `<p class="py-6 text-center text-xs text-ash">Nhắn gì đó cho nomnom nhé!</p>`;
  } else {
    chatMessagesBox.innerHTML = messages
      .map((m) => {
        const mine = m.sender === "customer";
        return `
          <div class="flex ${mine ? "justify-end" : "justify-start"}">
            <div class="max-w-[80%] rounded-2xl px-3 py-2 ${mine ? "bg-ink text-white" : "border border-earth/40 bg-white text-ink"}">
              <p class="whitespace-pre-wrap break-words text-sm">${escapeHtml(m.message)}</p>
            </div>
          </div>
        `;
      })
      .join("");
  }
  chatMessagesBox.insertAdjacentHTML("beforeend", `<div id="chat-status-row" class="mt-1"></div>`);
  chatMessagesBox.scrollTop = chatMessagesBox.scrollHeight;
  scheduleChatIdleTimestamp(messages[messages.length - 1]);
}

function setChatStatusRow(html) {
  const row = document.getElementById("chat-status-row");
  if (row) row.innerHTML = html;
  chatMessagesBox.scrollTop = chatMessagesBox.scrollHeight;
}

function scheduleChatIdleTimestamp(lastMessage) {
  clearTimeout(chatIdleTimer);
  setChatStatusRow("");
  if (!lastMessage) return;
  chatIdleTimer = setTimeout(() => {
    setChatStatusRow(`<p class="px-1 pt-1 text-center text-[10px] text-ash">${formatDateTime(lastMessage.created_at)}</p>`);
  }, 15000);
}

function showShopTypingIndicator() {
  clearTimeout(chatIdleTimer);
  clearTimeout(chatTypingHideTimer);
  setChatStatusRow(`
    <div class="flex items-end justify-start gap-2">
      <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-earth/40 text-ash">${CHAT_SHOP_AVATAR_SVG}</div>
      <div class="flex items-center gap-1 rounded-2xl border border-earth/40 bg-white px-3 py-2.5">
        <span class="chat-typing-dot"></span><span class="chat-typing-dot"></span><span class="chat-typing-dot"></span>
      </div>
    </div>
  `);
  chatTypingHideTimer = setTimeout(() => {
    scheduleChatIdleTimestamp(chatMessageCache[chatMessageCache.length - 1]);
  }, 3000);
}

async function loadChatHistory() {
  const conversationId = getChatConversationId();
  chatMessagesBox.innerHTML = `<div class="space-y-2 px-1">${chatThreadSkeletonHtml()}</div>`;
  const { data, error } = await supabase
    .from("chat_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) {
    chatMessagesBox.innerHTML = `<p class="py-6 text-center text-xs text-red-600">Lỗi tải tin nhắn: ${error.message}</p>`;
    return;
  }
  chatMessageCache = data || [];
  renderChatMessages(chatMessageCache);
}

export function restartChatWatcher() {
  if (chatChannel) {
    supabase.removeChannel(chatChannel);
    chatChannel = null;
  }
  chatMessageCache = [];
  chatUnreadCount = 0;
  updateChatBadge();

  const conversationId = getChatConversationId();
  chatChannel = supabase
    .channel(`chat-${conversationId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "chat_messages", filter: `conversation_id=eq.${conversationId}` },
      (payload) => {
        chatMessageCache.push(payload.new);
        if (!chatPanel.classList.contains("hidden")) {
          renderChatMessages(chatMessageCache);
        } else if (payload.new.sender === "shop") {
          chatUnreadCount++;
          updateChatBadge();
        }
      }
    )
    .on("broadcast", { event: "typing" }, (payload) => {
      if (payload.payload?.sender === "shop" && !chatPanel.classList.contains("hidden")) {
        showShopTypingIndicator();
      }
    })
    .subscribe();

  if (!chatPanel.classList.contains("hidden")) loadChatHistory();
}

function openChat() {
  chatPanel.classList.remove("hidden");
  chatPanel.classList.add("flex");
  if (state.isAdmin) return; // dữ liệu bảng tin nhắn admin đã tự cập nhật realtime sẵn, không cần tải lại
  chatUnreadCount = 0;
  updateChatBadge();
  loadChatHistory();
}

function closeChat() {
  chatPanel.classList.add("hidden");
  chatPanel.classList.remove("flex");
}

// ── Trạng thái online/offline của shop (Supabase Realtime Presence — không tốn DB
// cho phần "đang online", chỉ ghi nhẹ heartbeat để biết "lần cuối hoạt động" khi
// shop đã offline) ──

let presenceChannel = null;
let presenceHeartbeatTimer = null;

async function updateShopStatusUI(presenceState) {
  const statusEl = document.getElementById("chat-shop-status");
  if (!statusEl) return;
  const shopOnline = !!(presenceState["shop"] && presenceState["shop"].length);
  if (shopOnline) {
    statusEl.textContent = "● nomnom đang online";
    statusEl.className = "text-xs text-[#34C759]";
    return;
  }
  const lastSeen = await fetchLastSeen("shop");
  statusEl.textContent = lastSeen ? timeAgo(lastSeen) : "Chưa từng online";
  statusEl.className = "text-xs text-ash";
}

export function startPresence() {
  if (presenceChannel) {
    supabase.removeChannel(presenceChannel);
    presenceChannel = null;
  }
  if (presenceHeartbeatTimer) clearInterval(presenceHeartbeatTimer);

  presenceChannel = joinPresence(getChatConversationId(), updateShopStatusUI);
  presenceHeartbeatTimer = startHeartbeatLoop(getChatConversationId);
}

// ── Bảng quản lý tin nhắn nổi (khi cô chủ đăng nhập admin trên trang chính) ──

const ADMIN_CHAT_CACHE_KEY = "nomnom_storefront_chat_cache";

let adminChatConversations = [];
let adminChatActiveId = null;
let adminChatOnlineIds = new Set();
let adminChatLastSeenMap = new Map();
let adminChatRealtimeChannel = null;
let adminChatPresenceChannel = null;
let adminChatPresenceHeartbeat = null;

const chatPanelTitleEl = document.getElementById("chat-panel-title");
const chatCustomerViewEl = document.getElementById("chat-customer-view");
const chatAdminViewEl = document.getElementById("chat-admin-view");
const chatAdminListPaneEl = document.getElementById("chat-admin-list-pane");
const chatAdminThreadPaneEl = document.getElementById("chat-admin-thread-pane");
const chatAdminConversationsEl = document.getElementById("chat-admin-conversations");
const chatAdminThreadTitleEl = document.getElementById("chat-admin-thread-title");
const chatAdminThreadSubtitleEl = document.getElementById("chat-admin-thread-subtitle");
const chatAdminThreadMessagesEl = document.getElementById("chat-admin-thread-messages");
const chatAdminReplyForm = document.getElementById("chat-admin-reply-form");
const chatAdminReplyInput = document.getElementById("chat-admin-reply-input");

export function setChatAdminMode(adminMode) {
  if (adminMode) {
    chatPanelTitleEl.textContent = "Tin nhắn khách hàng";
    chatCustomerViewEl.classList.add("hidden");
    chatAdminViewEl.classList.remove("hidden");
    chatAdminViewEl.classList.add("flex");
    chatPanel.classList.remove("max-w-sm", "h-[70vh]", "max-h-[560px]");
    chatPanel.classList.add("max-w-2xl", "h-[78vh]", "max-h-[640px]");
    if (chatChannel) { supabase.removeChannel(chatChannel); chatChannel = null; }
    if (presenceChannel) { supabase.removeChannel(presenceChannel); presenceChannel = null; }
    if (presenceHeartbeatTimer) { clearInterval(presenceHeartbeatTimer); presenceHeartbeatTimer = null; }
    startAdminChatPanel();
  } else {
    chatPanelTitleEl.textContent = "Chat với nomnom";
    chatAdminViewEl.classList.add("hidden");
    chatAdminViewEl.classList.remove("flex");
    chatCustomerViewEl.classList.remove("hidden");
    chatPanel.classList.remove("max-w-2xl", "h-[78vh]", "max-h-[640px]");
    chatPanel.classList.add("max-w-sm", "h-[70vh]", "max-h-[560px]");
    stopAdminChatPanel();
    restartChatWatcher();
    startPresence();
  }
}

function hydrateAdminChatCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(ADMIN_CHAT_CACHE_KEY) || "null");
    if (cached && Array.isArray(cached.conversations)) {
      adminChatConversations = cached.conversations;
      return true;
    }
  } catch (e) {
    // cache hỏng thì bỏ qua, tải mới như bình thường
  }
  return false;
}

function saveAdminChatCache() {
  try {
    localStorage.setItem(ADMIN_CHAT_CACHE_KEY, JSON.stringify({ conversations: adminChatConversations }));
  } catch (e) {
    // hết dung lượng localStorage thì bỏ qua
  }
}

function updateAdminChatBadge() {
  const total = adminChatConversations.reduce((sum, c) => sum + c.unread, 0);
  const badge = document.getElementById("chat-fab-badge");
  if (!badge) return;
  badge.textContent = total;
  badge.classList.toggle("hidden", total === 0);
}

function adminChatOnlineStatusText(conversationId) {
  if (adminChatOnlineIds.has(conversationId)) return "Đang online";
  const lastSeen = adminChatLastSeenMap.get(conversationId);
  return lastSeen ? timeAgo(lastSeen) : "";
}

function renderAdminChatConversations() {
  if (!adminChatConversations.length) {
    chatAdminConversationsEl.innerHTML = `<p class="py-8 text-center text-xs text-ash">Chưa có tin nhắn nào.</p>`;
    return;
  }
  chatAdminConversationsEl.innerHTML = adminChatConversations
    .map((c) => {
      const online = adminChatOnlineIds.has(c.conversationId);
      const statusText = adminChatOnlineStatusText(c.conversationId);
      return `
      <button type="button" data-conversation="${c.conversationId}"
        class="flex w-full items-start gap-3 border-b border-earth/15 px-3 py-2.5 text-left transition-colors ${c.conversationId === adminChatActiveId ? "bg-earth/10" : "bg-white hover:bg-earth/5"}">
        ${avatarHtml(c.customerName || c.conversationId, online)}
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-2">
            <span class="truncate text-sm font-semibold text-ink">${escapeHtml(c.customerName || c.conversationId)}</span>
            ${c.unread > 0 ? `<span class="shrink-0 rounded-full bg-[#7a0c1f] px-1.5 py-0.5 text-[10px] font-medium text-white">${c.unread}</span>` : ""}
          </div>
          <p class="mt-1 truncate text-xs text-ash">${escapeHtml(c.lastMessage || "")}</p>
          <p class="mt-0.5 text-[10px] ${online ? "font-medium text-[#34C759]" : "text-ash/70"}">${statusText || formatDateTime(c.lastTime)}</p>
        </div>
      </button>
    `;
    })
    .join("");

  chatAdminConversationsEl.querySelectorAll("[data-conversation]").forEach((btn) =>
    btn.addEventListener("click", () => openAdminChatThread(btn.dataset.conversation))
  );
}

async function loadAdminChatConversations() {
  const hasCache = hydrateAdminChatCache();
  if (hasCache) {
    renderAdminChatConversations();
    updateAdminChatBadge();
  }

  const { data, error } = await supabase
    .from("chat_messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) {
    if (!hasCache) chatAdminConversationsEl.innerHTML = `<p class="py-8 text-center text-xs text-red-600">Lỗi: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const map = new Map();
  (data || []).forEach((m) => {
    let conv = map.get(m.conversation_id);
    if (!conv) {
      conv = {
        conversationId: m.conversation_id,
        customerName: m.sender === "customer" ? m.customer_name : null,
        lastMessage: m.message,
        lastTime: m.created_at,
        unread: 0,
      };
      map.set(m.conversation_id, conv);
    } else if (!conv.customerName && m.sender === "customer") {
      conv.customerName = m.customer_name;
    }
    if (m.sender === "customer" && !m.read_by_admin) conv.unread++;
  });

  adminChatConversations = [...map.values()].sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
  saveAdminChatCache();
  updateAdminChatBadge();
  renderAdminChatConversations();

  adminChatLastSeenMap = await fetchAllLastSeen();
  renderAdminChatConversations();
}

function showAdminChatThreadPane() {
  chatAdminListPaneEl.classList.add("hidden");
  chatAdminListPaneEl.classList.remove("flex");
  chatAdminThreadPaneEl.classList.remove("hidden");
  chatAdminThreadPaneEl.classList.add("flex");
}

function showAdminChatListPane() {
  chatAdminThreadPaneEl.classList.add("hidden");
  chatAdminThreadPaneEl.classList.remove("flex");
  chatAdminListPaneEl.classList.remove("hidden");
  chatAdminListPaneEl.classList.add("flex");
}

async function openAdminChatThread(conversationId) {
  adminChatActiveId = conversationId;
  renderAdminChatConversations();
  showAdminChatThreadPane();

  const conv = adminChatConversations.find((c) => c.conversationId === conversationId);
  chatAdminThreadTitleEl.textContent = (conv && conv.customerName) || conversationId;
  const online = adminChatOnlineIds.has(conversationId);
  chatAdminThreadSubtitleEl.textContent = adminChatOnlineStatusText(conversationId) || "Khách chưa từng online";
  chatAdminThreadSubtitleEl.className = online ? "truncate text-xs font-medium text-[#34C759]" : "truncate text-xs text-ash";

  chatAdminThreadMessagesEl.innerHTML = `<div class="space-y-2">${chatThreadSkeletonHtml()}</div>`;
  chatAdminReplyForm.classList.remove("hidden");
  chatAdminReplyForm.classList.add("flex");

  const { data, error } = await supabase
    .from("chat_messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(300);

  if (error) {
    chatAdminThreadMessagesEl.innerHTML = `<p class="py-6 text-center text-xs text-red-600">Lỗi: ${escapeHtml(error.message)}</p>`;
    return;
  }

  chatAdminThreadMessagesEl.innerHTML = data && data.length
    ? data.map((m) => chatBubbleHtml(m, m.sender === "shop")).join("")
    : `<p class="py-6 text-center text-xs text-ash">Chưa có tin nhắn.</p>`;
  chatAdminThreadMessagesEl.scrollTop = chatAdminThreadMessagesEl.scrollHeight;

  await supabase
    .from("chat_messages")
    .update({ read_by_admin: true })
    .eq("conversation_id", conversationId)
    .eq("sender", "customer")
    .eq("read_by_admin", false);

  if (conv) conv.unread = 0;
  saveAdminChatCache();
  updateAdminChatBadge();
  renderAdminChatConversations();
}

function handleAdminChatIncoming(message) {
  let conv = adminChatConversations.find((c) => c.conversationId === message.conversation_id);
  if (!conv) {
    conv = { conversationId: message.conversation_id, customerName: null, lastMessage: "", lastTime: message.created_at, unread: 0 };
    adminChatConversations.unshift(conv);
  }
  if (message.sender === "customer") conv.customerName = message.customer_name;
  conv.lastMessage = message.message;
  conv.lastTime = message.created_at;

  if (adminChatActiveId === message.conversation_id) {
    chatAdminThreadMessagesEl.insertAdjacentHTML("beforeend", chatBubbleHtml(message, message.sender === "shop"));
    chatAdminThreadMessagesEl.scrollTop = chatAdminThreadMessagesEl.scrollHeight;
    if (message.sender === "customer") {
      supabase.from("chat_messages").update({ read_by_admin: true }).eq("id", message.id).then(() => {});
    }
  } else if (message.sender === "customer") {
    conv.unread++;
  }

  adminChatConversations.sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
  saveAdminChatCache();
  updateAdminChatBadge();
  renderAdminChatConversations();
}

function startAdminChatPanel() {
  // Có thể bị gọi lại (onAuthStateChange fire nhiều lần) → dọn channel cũ trước.
  // Nếu không, supabase.channel() trả lại channel cùng tên đã subscribe() và .on()
  // sẽ ném "cannot add postgres_changes callbacks ... after subscribe()".
  if (adminChatRealtimeChannel) { supabase.removeChannel(adminChatRealtimeChannel); adminChatRealtimeChannel = null; }
  if (adminChatPresenceChannel) { supabase.removeChannel(adminChatPresenceChannel); adminChatPresenceChannel = null; }
  if (adminChatPresenceHeartbeat) { clearInterval(adminChatPresenceHeartbeat); adminChatPresenceHeartbeat = null; }

  showAdminChatListPane();
  loadAdminChatConversations();

  adminChatRealtimeChannel = supabase
    .channel("storefront-admin-chat-changes")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (payload) => handleAdminChatIncoming(payload.new))
    .subscribe();

  adminChatPresenceChannel = joinPresence("shop", (presenceState) => {
    adminChatOnlineIds = new Set(Object.keys(presenceState).filter((key) => key !== "shop"));
    renderAdminChatConversations();
  });
  adminChatPresenceHeartbeat = startHeartbeatLoop(() => "shop");
}

function stopAdminChatPanel() {
  if (adminChatRealtimeChannel) { supabase.removeChannel(adminChatRealtimeChannel); adminChatRealtimeChannel = null; }
  if (adminChatPresenceChannel) { supabase.removeChannel(adminChatPresenceChannel); adminChatPresenceChannel = null; }
  if (adminChatPresenceHeartbeat) { clearInterval(adminChatPresenceHeartbeat); adminChatPresenceHeartbeat = null; }
  adminChatActiveId = null;
}

export function initChat() {
  chatFab.addEventListener("click", openChat);
  document.getElementById("chat-close").addEventListener("click", closeChat);

  chatInput.addEventListener("input", () => {
    if (!chatChannel || chatTypingSendThrottle) return;
    chatChannel.send({ type: "broadcast", event: "typing", payload: { sender: "customer" } });
    chatTypingSendThrottle = setTimeout(() => { chatTypingSendThrottle = null; }, 2000);
  });

  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = "";
    const isFirstMessage = chatMessageCache.length === 0;
    const conversationId = getChatConversationId();

    const { error } = await supabase.from("chat_messages").insert({
      conversation_id: conversationId,
      customer_name: getChatDisplayName(),
      sender: "customer",
      message: text,
    });
    if (error) {
      alert("Lỗi gửi tin nhắn: " + error.message);
      return;
    }

    // Tin nhắn lần đầu của khách trong hội thoại này — tự gửi câu trả lời đã cấu hình (nếu có)
    if (isFirstMessage && state.chatAutoReply) {
      await supabase.from("chat_messages").insert({
        conversation_id: conversationId,
        customer_name: "nomnom",
        sender: "shop",
        message: state.chatAutoReply,
      });
    }
  });

  document.getElementById("chat-admin-back").addEventListener("click", showAdminChatListPane);

  chatAdminReplyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!adminChatActiveId) return;
    const text = chatAdminReplyInput.value.trim();
    if (!text) return;
    chatAdminReplyInput.value = "";
    const { error } = await supabase.from("chat_messages").insert({
      conversation_id: adminChatActiveId,
      customer_name: "nomnom",
      sender: "shop",
      message: text,
    });
    if (error) alert("Lỗi gửi tin nhắn: " + error.message);
  });

  // KHÔNG bật realtime ở đây: handler auth (onAuthStateChange) sẽ gọi setChatAdminMode()
  // để bật chat/presence SAU khi các truy vấn tải xong — tránh deadlock Supabase lúc init.
}
