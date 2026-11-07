// NovaChat front-end controller.
// Owns the UI state (conversations, active chat, streaming reply, attachments),
// renders the sidebar and messages, and wires up every control.

import { icon, hydrateIcons, STAR_SVG } from "./icons.js";
import { ConversationStore, prefs } from "./store.js";
import { fetchConfig, streamChat, ApiError } from "./api.js";
import { renderMarkdown, enhanceContent, escapeHtml, copyText, flashCopied } from "./markdown.js";
import { Picker, isPickerOpen } from "./picker.js";

// ---------------------------------------------------------------- constants
const FALLBACK_CONFIG = {
  app_name: "NovaChat",
  version: "?",
  mode: "unknown",
  models: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5", tagline: "Most capable" }],
  default_model: "claude-opus-5-5",
  efforts: [
    { id: "low", label: "Fast" },
    { id: "medium", label: "Balanced" },
    { id: "high", label: "Deep" },
  ],
  default_effort: "medium",
  personas: [{ id: "assistant", name: "Nova", emoji: "✨", description: "Friendly all-round assistant" }],
  default_persona: "assistant",
  access_code_required: false,
  limits: { max_images_per_message: 4, max_image_bytes: 5 * 1024 * 1024, max_message_chars: 50000 },
};

const EFFORT_INFO = {
  low: { icon: "bolt", desc: "Quickest replies, light reasoning" },
  medium: { icon: "scale", desc: "Good balance of speed and depth" },
  high: { icon: "brain", desc: "Thinks longer on hard problems" },
};

const SUGGESTIONS = [
  {
    title: "Explain a concept",
    sub: "how neural networks learn, simply",
    prompt: "Explain how neural networks learn, in simple terms with a real-world analogy.",
  },
  {
    title: "Write some code",
    sub: "a Python script that renames photos",
    prompt:
      "Write a Python script that renames every .jpg file in a folder to include the date it was taken. Explain how it works.",
  },
  {
    title: "Plan something",
    sub: "a relaxed 3-day trip to Jaipur",
    prompt: "Plan a relaxed 3-day trip to Jaipur with must-see places, food to try and a rough budget.",
  },
  {
    title: "Polish my writing",
    sub: "make an email sound professional",
    prompt:
      "Rewrite this email so it sounds professional but friendly:\n\nhey, i cant make it to the meeting tmrw, can we move it to friday?",
  },
];

const MAX_IMAGE_DIM = 1568; // Claude's recommended max edge for images
const RENDER_INTERVAL_MS = 40;

// ---------------------------------------------------------------- state
const store = new ConversationStore();
const state = {
  config: FALLBACK_CONFIG,
  conversations: [],
  activeId: null,
  streaming: null, // { controller, convId, msgId }
  pendingImages: [],
  search: "",
  stickToBottom: true,
};
const views = new Map(); // message id -> DOM references for live updates
let pickers = {};

const $ = (id) => document.getElementById(id);
const els = {
  app: $("app"),
  sidebar: $("sidebar"),
  scrim: $("scrim"),
  chatList: $("chatList"),
  search: $("searchInput"),
  newChat: $("newChatBtn"),
  collapse: $("collapseBtn"),
  menu: $("menuBtn"),
  settingsBtn: $("settingsBtn"),
  modePill: $("modePill"),
  chatTitle: $("chatTitle"),
  demoBadge: $("demoBadge"),
  exportBtn: $("exportBtn"),
  themeBtn: $("themeBtn"),
  messages: $("messages"),
  inner: $("messagesInner"),
  scrollBottom: $("scrollBottomBtn"),
  composer: $("composer"),
  input: $("input"),
  attachments: $("attachments"),
  attachBtn: $("attachBtn"),
  fileInput: $("fileInput"),
  thinkingToggle: $("thinkingToggle"),
  sendBtn: $("sendBtn"),
  settingsDialog: $("settingsDialog"),
  themeSegmented: $("themeSegmented"),
  customInstructions: $("customInstructions"),
  ciCount: $("ciCount"),
  accessSetting: $("accessSetting"),
  accessCodeInput: $("accessCodeInput"),
  exportAll: $("exportAllBtn"),
  clearAll: $("clearAllBtn"),
  about: $("aboutInfo"),
  accessDialog: $("accessDialog"),
  accessForm: $("accessForm"),
  accessDialogInput: $("accessDialogInput"),
  lightbox: $("lightbox"),
  lightboxImg: $("lightboxImg"),
  toasts: $("toasts"),
};

// ---------------------------------------------------------------- helpers
const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
const isMobile = () => window.matchMedia("(max-width: 860px)").matches;
const isTouch = () => window.matchMedia("(pointer: coarse)").matches;
const activeConv = () => state.conversations.find((c) => c.id === state.activeId) || null;
const fmtNum = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function modelLabel(id) {
  if (id === "demo") return "Demo";
  const m = state.config.models.find((x) => x.id === id);
  return m ? m.label.replace(/^Claude\s+/, "") : id || "";
}

function makeTitle(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "Image chat";
  if (clean.length <= 48) return clean;
  const cut = clean.slice(0, 48);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : 48)}…`;
}

function toast(message, type = "info", ms = 3200) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  els.toasts.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slug(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "chat"
  );
}

let saveWarned = false;
async function saveConv(conv) {
  try {
    await store.put(conv);
  } catch {
    if (!saveWarned) {
      saveWarned = true;
      toast("Couldn't save this chat in the browser (storage may be full).", "error");
    }
  }
}

// ---------------------------------------------------------------- theme
const THEME_ORDER = ["system", "light", "dark"];
const THEME_ICON = { system: "monitor", light: "sun", dark: "moon" };

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
  els.themeBtn.innerHTML = icon(THEME_ICON[theme] || "monitor");
  els.themeBtn.title = `Theme: ${theme}`;
  els.themeSegmented.querySelectorAll("button").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.themeChoice === theme));
  });
}

function setTheme(theme) {
  prefs.set("theme", theme);
  applyTheme(theme);
}

// ---------------------------------------------------------------- sidebar
function groupLabel(ts) {
  const day = 86400000;
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (ts >= startOfToday) return "Today";
  if (ts >= startOfToday - day) return "Yesterday";
  if (ts >= startOfToday - 7 * day) return "Previous 7 days";
  if (ts >= startOfToday - 30 * day) return "Previous 30 days";
  return "Older";
}

function matchesSearch(conv, q) {
  if (!q) return true;
  if (conv.title.toLowerCase().includes(q)) return true;
  return conv.messages.some((m) => m.content && m.content.toLowerCase().includes(q));
}

function renderSidebar() {
  const q = state.search.trim().toLowerCase();
  const list = state.conversations.filter((c) => matchesSearch(c, q));
  els.chatList.innerHTML = "";

  if (!list.length) {
    els.chatList.innerHTML = `<div class="chat-empty">${q ? "No chats match your search." : "No chats yet. Say hello!"}</div>`;
    return;
  }

  let currentGroup = null;
  for (const conv of list) {
    const label = groupLabel(conv.updatedAt);
    if (label !== currentGroup) {
      currentGroup = label;
      const g = document.createElement("div");
      g.className = "chat-group-label";
      g.textContent = label;
      els.chatList.appendChild(g);
    }
    const item = document.createElement("div");
    item.className = `chat-item${conv.id === state.activeId ? " active" : ""}`;
    item.innerHTML = `
      <button class="chat-item-link" title="${escapeHtml(conv.title)}">${escapeHtml(conv.title)}</button>
      <div class="chat-item-actions">
        <button class="icon-btn" data-act="rename" title="Rename" aria-label="Rename chat">${icon("edit")}</button>
        <button class="icon-btn" data-act="delete" title="Delete" aria-label="Delete chat">${icon("trash")}</button>
      </div>`;
    item.querySelector(".chat-item-link").addEventListener("click", () => openConversation(conv.id));
    item.querySelector('[data-act="rename"]').addEventListener("click", () => startRename(item, conv));
    item.querySelector('[data-act="delete"]').addEventListener("click", () => deleteConversation(conv));
    els.chatList.appendChild(item);
  }
}

function startRename(item, conv) {
  const input = document.createElement("input");
  input.className = "chat-item-input";
  input.value = conv.title;
  input.maxLength = 120;
  const link = item.querySelector(".chat-item-link");
  link.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (save && value && value !== conv.title) {
      conv.title = value;
      await saveConv(conv);
    }
    renderSidebar();
    updateHeader();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

async function deleteConversation(conv) {
  if (!confirm(`Delete “${conv.title}”? This can't be undone.`)) return;
  if (state.streaming?.convId === conv.id) state.streaming.controller.abort();
  await store.delete(conv.id);
  state.conversations = state.conversations.filter((c) => c.id !== conv.id);
  if (state.activeId === conv.id) newChat();
  else renderSidebar();
}

function closeMobileSidebar() {
  els.app.classList.remove("sidebar-open");
}

function toggleSidebar() {
  if (isMobile()) {
    els.app.classList.toggle("sidebar-open");
  } else {
    const collapsed = !els.app.classList.contains("sidebar-collapsed");
    els.app.classList.toggle("sidebar-collapsed", collapsed);
    prefs.set("sidebarCollapsed", collapsed);
  }
}

// ---------------------------------------------------------------- conversations
function sortConversations() {
  state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
}

function openConversation(id) {
  state.activeId = id;
  prefs.set("lastConversationId", id);
  closeMobileSidebar();
  renderSidebar();
  renderMessages();
  updateHeader();
  state.stickToBottom = true;
  scrollToBottom();
  if (!isTouch()) els.input.focus();
}

function newChat() {
  state.activeId = null;
  prefs.set("lastConversationId", null);
  closeMobileSidebar();
  renderSidebar();
  renderMessages();
  updateHeader();
  els.input.focus();
}

function createConversation() {
  const conv = {
    id: uid(),
    title: "New chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  state.conversations.unshift(conv);
  state.activeId = conv.id;
  prefs.set("lastConversationId", conv.id);
  return conv;
}

function updateHeader() {
  const conv = activeConv();
  els.chatTitle.textContent = conv ? conv.title : "";
  document.title = conv ? `${conv.title} · NovaChat` : "NovaChat";
  els.exportBtn.disabled = !conv || !conv.messages.length;
}

// ---------------------------------------------------------------- rendering
function renderEmpty() {
  const persona = state.config.personas.find((p) => p.id === pickers.persona?.value) || state.config.personas[0];
  els.inner.innerHTML = `
    <div class="empty">
      <div class="empty-logo">${STAR_SVG}</div>
      <h1>How can I help you today?</h1>
      <p>Chatting with <strong>${escapeHtml(persona?.name || "Nova")}</strong> on ${escapeHtml(
        modelLabel(pickers.model?.value) || "Claude",
      )}</p>
      <div class="suggestions">
        ${SUGGESTIONS.map(
          (s, i) => `
          <button class="suggestion" data-i="${i}">
            <span class="suggestion-title">${escapeHtml(s.title)}</span>
            <span class="suggestion-sub">${escapeHtml(s.sub)}</span>
          </button>`,
        ).join("")}
      </div>
    </div>`;
  els.inner.querySelectorAll(".suggestion").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.input.value = SUGGESTIONS[Number(btn.dataset.i)].prompt;
      autoGrow();
      updateSendState();
      send();
    });
  });
}

function renderMessages() {
  views.clear();
  const conv = activeConv();
  if (!conv || !conv.messages.length) {
    renderEmpty();
    return;
  }
  els.inner.innerHTML = "";
  const frag = document.createDocumentFragment();
  conv.messages.forEach((msg, i) => {
    frag.appendChild(buildMessageEl(conv, msg, i === conv.messages.length - 1));
  });
  els.inner.appendChild(frag);
}

function buildMessageEl(conv, msg, isLast) {
  const el = document.createElement("div");
  el.className = `msg msg-${msg.role}${isLast ? " is-last" : ""}`;
  el.dataset.id = msg.id;
  if (msg.role === "user") {
    buildUserMessage(el, conv, msg);
  } else {
    buildAssistantMessage(el, conv, msg, isLast);
  }
  return el;
}

function buildUserMessage(el, conv, msg) {
  const images = (msg.images || [])
    .map((img) => `<img src="data:${img.media_type};base64,${img.data}" alt="Attached image" loading="lazy">`)
    .join("");
  el.innerHTML = `
    <div class="msg-main">
      ${images ? `<div class="msg-images">${images}</div>` : ""}
      ${msg.content ? `<div class="bubble">${escapeHtml(msg.content)}</div>` : ""}
      <div class="msg-actions">
        ${msg.content ? `<button class="icon-btn" data-act="copy" title="Copy" aria-label="Copy message">${icon("copy")}</button>` : ""}
        <button class="icon-btn" data-act="edit" title="Edit" aria-label="Edit message">${icon("edit")}</button>
      </div>
    </div>`;
  el.querySelectorAll(".msg-images img").forEach((img) => img.addEventListener("click", () => openLightbox(img.src)));
  el.querySelector('[data-act="copy"]')?.addEventListener("click", async (e) => {
    if (await copyText(msg.content)) flashCopied(e.currentTarget);
  });
  el.querySelector('[data-act="edit"]').addEventListener("click", () => startEdit(el, conv, msg));
}

function buildAssistantMessage(el, conv, msg, isLast) {
  el.innerHTML = `
    <div class="avatar">${STAR_SVG}</div>
    <div class="msg-main">
      <div class="msg-header">
        <span class="msg-name">Nova</span>
        <span class="msg-model"></span>
      </div>
      <details class="thinking" hidden>
        <summary>${icon("brain")}<span class="thinking-label">Thinking…</span>${icon("chevronDown", "chev")}</summary>
        <div class="thinking-body md"></div>
      </details>
      <div class="msg-body md"></div>
      <div class="msg-notice" hidden></div>
      <div class="msg-error" hidden></div>
      <div class="msg-footer">
        <div class="msg-actions">
          <button class="icon-btn" data-act="copy" title="Copy" aria-label="Copy reply">${icon("copy")}</button>
          ${isLast ? `<button class="icon-btn" data-act="regen" title="Regenerate" aria-label="Regenerate reply">${icon("refresh")}</button>` : ""}
        </div>
        <span class="msg-meta"></span>
      </div>
    </div>`;

  const view = {
    root: el,
    model: el.querySelector(".msg-model"),
    thinking: el.querySelector(".thinking"),
    thinkingLabel: el.querySelector(".thinking-label"),
    thinkingBody: el.querySelector(".thinking-body"),
    body: el.querySelector(".msg-body"),
    notice: el.querySelector(".msg-notice"),
    error: el.querySelector(".msg-error"),
    footer: el.querySelector(".msg-footer"),
    meta: el.querySelector(".msg-meta"),
    lastRender: 0,
    frame: 0,
  };
  views.set(msg.id, view);

  el.querySelector('[data-act="copy"]').addEventListener("click", async (e) => {
    if (await copyText(msg.content || "")) flashCopied(e.currentTarget);
  });
  el.querySelector('[data-act="regen"]')?.addEventListener("click", () => regenerate(conv));

  paintAssistant(msg, view);
}

function appendCursor(container) {
  const cursor = document.createElement("span");
  cursor.className = "cursor";
  let target = container;
  // Put the cursor inside the deepest last text block so it trails the words.
  for (;;) {
    const last = target.lastElementChild;
    if (!last || !/^(P|LI|UL|OL|H[1-6]|BLOCKQUOTE|TD|TR|TBODY|TABLE|DIV)$/.test(last.tagName)) break;
    if (last.classList.contains("code-block") || last.classList.contains("table-wrap")) break;
    target = last;
  }
  target.appendChild(cursor);
}

function paintAssistant(msg, view) {
  const streaming = msg.status === "streaming";
  const meta = msg.meta || {};

  view.model.textContent = modelLabel(meta.model);

  // Thinking summary panel
  if (msg.thinking) {
    view.thinking.hidden = false;
    const live = streaming && !msg.content;
    view.thinking.classList.toggle("live", live);
    if (live) {
      view.thinkingLabel.textContent = "Thinking…";
    } else if (meta.thinkingMs) {
      view.thinkingLabel.textContent = `Thought for ${Math.max(1, Math.round(meta.thinkingMs / 1000))}s`;
    } else {
      view.thinkingLabel.textContent = "Thought process";
    }
    view.thinkingBody.innerHTML = renderMarkdown(msg.thinking);
  } else {
    view.thinking.hidden = true;
  }

  // Reply body
  if (msg.content) {
    view.body.innerHTML = renderMarkdown(msg.content);
    enhanceContent(view.body, { highlight: !streaming });
    if (streaming) appendCursor(view.body);
  } else if (streaming && !msg.thinking) {
    view.body.innerHTML = '<div class="typing" aria-label="Nova is typing"><span></span><span></span><span></span></div>';
  } else {
    view.body.innerHTML = "";
  }

  // Notices (fallback, truncation, refusal, stopped)
  const notices = [];
  if (meta.fallback?.to) notices.push(`Switched to ${modelLabel(meta.fallback.to)} to finish this reply.`);
  if (meta.stopReason === "max_tokens") notices.push("The reply reached the length limit and was cut off.");
  if (meta.stopReason === "refusal") notices.push("Claude declined to continue with this request.");
  if (meta.stopped && !streaming) notices.push("You stopped this reply.");
  view.notice.hidden = !notices.length;
  view.notice.textContent = notices.join(" ");

  // Error box with retry
  if (msg.error && !streaming) {
    view.error.hidden = false;
    view.error.innerHTML = `<span>${escapeHtml(msg.error)}</span>`;
    const retry = document.createElement("button");
    retry.className = "btn";
    retry.innerHTML = `${icon("refresh")}Retry`;
    retry.addEventListener("click", () => {
      const conv = state.conversations.find((c) => c.messages.includes(msg));
      if (conv) regenerate(conv);
    });
    view.error.appendChild(retry);
  } else {
    view.error.hidden = true;
  }

  // Footer: actions + stats
  view.footer.hidden = streaming;
  const parts = [];
  if (meta.usage?.output_tokens) parts.push(`${fmtNum(meta.usage.output_tokens)} tokens`);
  if (meta.durationMs) parts.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
  view.meta.textContent = parts.join(" · ");
}

function scheduleRender(msg) {
  const view = views.get(msg.id);
  if (!view || view.frame) return;
  const wait = Math.max(0, RENDER_INTERVAL_MS - (performance.now() - view.lastRender));
  view.frame = setTimeout(() => {
    requestAnimationFrame(() => {
      view.frame = 0;
      view.lastRender = performance.now();
      paintAssistant(msg, view);
      if (state.stickToBottom) scrollToBottom();
    });
  }, wait);
}

// ---------------------------------------------------------------- scrolling
function distanceFromBottom() {
  const m = els.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight;
}

function scrollToBottom(smooth = false) {
  els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

els.messages.addEventListener("scroll", () => {
  const near = distanceFromBottom() < 80;
  state.stickToBottom = near;
  els.scrollBottom.hidden = near;
});

// ---------------------------------------------------------------- sending
function historyFor(conv, uptoMsgId) {
  const out = [];
  for (const m of conv.messages) {
    if (m.id === uptoMsgId) break;
    if (m.role === "assistant" && !m.content) continue; // errored / empty replies
    out.push({ role: m.role, content: m.content || "", images: m.images || [] });
  }
  return out;
}

async function send() {
  const text = els.input.value.trim();
  if (state.streaming) {
    toast("Please wait for the current reply, or stop it first.");
    return;
  }
  if (!text && !state.pendingImages.length) return;
  if (text.length > state.config.limits.max_message_chars) {
    toast(`Messages can be up to ${state.config.limits.max_message_chars.toLocaleString()} characters.`, "error");
    return;
  }

  let conv = activeConv();
  if (!conv) conv = createConversation();

  conv.messages.push({
    id: uid(),
    role: "user",
    content: text,
    images: state.pendingImages.map(({ media_type, data }) => ({ media_type, data })),
    createdAt: Date.now(),
  });
  if (conv.messages.length === 1) conv.title = makeTitle(text);

  els.input.value = "";
  state.pendingImages = [];
  renderAttachments();
  autoGrow();
  await generate(conv);
}

async function generate(conv) {
  const assistant = {
    id: uid(),
    role: "assistant",
    content: "",
    thinking: "",
    status: "streaming",
    createdAt: Date.now(),
    meta: { model: pickers.model.value },
  };
  conv.messages.push(assistant);
  conv.updatedAt = Date.now();
  sortConversations();
  await saveConv(conv);

  const controller = new AbortController();
  state.streaming = { controller, convId: conv.id, msgId: assistant.id };
  state.stickToBottom = true;
  updateSendState();
  renderSidebar();
  updateHeader();
  if (state.activeId === conv.id) {
    renderMessages();
    scrollToBottom();
  }

  const payload = {
    messages: historyFor(conv, assistant.id),
    model: pickers.model.value,
    effort: pickers.effort.value,
    persona: pickers.persona.value,
    custom_instructions: prefs.get("customInstructions") || "",
    show_thinking: prefs.get("showThinking") !== false,
  };
  const started = performance.now();

  try {
    await streamChat(payload, {
      signal: controller.signal,
      accessCode: prefs.get("accessCode"),
      onEvent: (type, data) => {
        switch (type) {
          case "start":
            assistant.meta.model = data.model;
            break;
          case "thinking":
            if (!assistant.meta.thinkingStart) assistant.meta.thinkingStart = performance.now();
            assistant.thinking += data.text;
            break;
          case "delta":
            if (assistant.meta.thinkingStart && !assistant.meta.thinkingMs) {
              assistant.meta.thinkingMs = performance.now() - assistant.meta.thinkingStart;
            }
            assistant.content += data.text;
            break;
          case "notice":
            if (data.kind === "fallback") assistant.meta.fallback = data;
            break;
          case "done":
            Object.assign(assistant.meta, {
              model: data.model,
              usage: data.usage,
              stopReason: data.stop_reason,
              durationMs: data.duration_ms,
            });
            break;
          case "error":
            assistant.error = data.message || "Something went wrong.";
            break;
          default:
            break;
        }
        scheduleRender(assistant);
      },
    });
  } catch (err) {
    if (err.name === "AbortError") {
      assistant.meta.stopped = true;
    } else if (err instanceof ApiError && err.status === 401) {
      assistant.error = err.message;
      prefs.set("accessCode", "");
      openAccessDialog();
    } else if (err instanceof ApiError && err.status === 413) {
      assistant.error = "This chat is too large to send (probably too many images). Start a new chat.";
    } else {
      assistant.error = err.message || "Network error - check your connection and retry.";
    }
  } finally {
    if (assistant.meta.thinkingStart && !assistant.meta.thinkingMs) {
      assistant.meta.thinkingMs = performance.now() - assistant.meta.thinkingStart;
    }
    delete assistant.meta.thinkingStart;
    if (!assistant.meta.durationMs) assistant.meta.durationMs = Math.round(performance.now() - started);
    if (!assistant.content && !assistant.error && !assistant.meta.stopped) {
      assistant.error = "No reply was received. Please retry.";
    }
    assistant.status = "done";
    state.streaming = null;
    conv.updatedAt = Date.now();
    await saveConv(conv);
    updateSendState();
    if (state.activeId === conv.id) {
      renderMessages();
      if (state.stickToBottom) scrollToBottom();
    }
  }
}

function stopStreaming() {
  state.streaming?.controller.abort();
}

async function regenerate(conv) {
  if (state.streaming) return;
  const last = conv.messages[conv.messages.length - 1];
  if (last?.role === "assistant") conv.messages.pop();
  if (!conv.messages.length) return;
  await generate(conv);
}

function startEdit(el, conv, msg) {
  if (state.streaming) {
    toast("Wait for the current reply to finish before editing.");
    return;
  }
  const main = el.querySelector(".msg-main");
  const original = main.innerHTML;
  main.innerHTML = `
    <div class="edit-box">
      <textarea aria-label="Edit message"></textarea>
      <div class="edit-actions">
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn btn-primary" data-act="save">Save &amp; send</button>
      </div>
    </div>`;
  const ta = main.querySelector("textarea");
  ta.value = msg.content;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  main.querySelector('[data-act="cancel"]').addEventListener("click", () => {
    main.innerHTML = original;
    renderMessages();
  });
  main.querySelector('[data-act="save"]').addEventListener("click", async () => {
    const value = ta.value.trim();
    if (!value && !(msg.images || []).length) return;
    msg.content = value;
    const idx = conv.messages.indexOf(msg);
    conv.messages.splice(idx + 1); // drop everything after the edited message
    if (idx === 0) conv.title = makeTitle(value);
    await generate(conv);
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isTouch()) {
      e.preventDefault();
      main.querySelector('[data-act="save"]').click();
    }
    if (e.key === "Escape") main.querySelector('[data-act="cancel"]').click();
  });
}

// ---------------------------------------------------------------- composer
function autoGrow() {
  const ta = els.input;
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
}

function updateSendState() {
  const streaming = Boolean(state.streaming);
  const hasContent = els.input.value.trim().length > 0 || state.pendingImages.length > 0;
  els.sendBtn.classList.toggle("stop", streaming);
  els.sendBtn.innerHTML = icon(streaming ? "stop" : "send");
  els.sendBtn.setAttribute("aria-label", streaming ? "Stop generating" : "Send message");
  els.sendBtn.title = streaming ? "Stop (Esc)" : "Send (Enter)";
  els.sendBtn.disabled = !streaming && !hasContent;
}

function fileToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function prepareImage(file) {
  const allowed = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    bitmap = null;
  }
  const maxEdge = bitmap ? Math.max(bitmap.width, bitmap.height) : 0;
  const smallEnough = file.size <= Math.min(state.config.limits.max_image_bytes, 3.75 * 1024 * 1024);

  if (allowed.includes(file.type) && smallEnough && (!bitmap || maxEdge <= MAX_IMAGE_DIM)) {
    return { media_type: file.type, data: await fileToBase64(file) };
  }
  if (!bitmap) throw new Error("Unsupported image");

  // Downscale / re-encode large images as JPEG to keep requests small.
  const scale = Math.min(1, MAX_IMAGE_DIM / maxEdge);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
  if (!blob) throw new Error("Could not process image");
  return { media_type: "image/jpeg", data: await fileToBase64(blob) };
}

async function addFiles(fileList) {
  const max = state.config.limits.max_images_per_message;
  for (const file of fileList) {
    if (!file.type.startsWith("image/")) {
      toast("Only image files can be attached.", "error");
      continue;
    }
    if (state.pendingImages.length >= max) {
      toast(`You can attach up to ${max} images per message.`, "error");
      break;
    }
    try {
      state.pendingImages.push({ id: uid(), ...(await prepareImage(file)) });
    } catch {
      toast(`Couldn't read “${file.name}”.`, "error");
    }
  }
  renderAttachments();
  updateSendState();
}

function renderAttachments() {
  els.attachments.hidden = !state.pendingImages.length;
  els.attachments.innerHTML = "";
  for (const img of state.pendingImages) {
    const item = document.createElement("div");
    item.className = "attachment";
    item.innerHTML = `
      <img src="data:${img.media_type};base64,${img.data}" alt="Attachment preview">
      <button type="button" class="attachment-remove" aria-label="Remove image">${icon("x")}</button>`;
    item.querySelector("button").addEventListener("click", () => {
      state.pendingImages = state.pendingImages.filter((p) => p.id !== img.id);
      renderAttachments();
      updateSendState();
    });
    els.attachments.appendChild(item);
  }
}

function openLightbox(src) {
  els.lightboxImg.src = src;
  els.lightbox.showModal();
}

// ---------------------------------------------------------------- settings
function openSettings() {
  els.customInstructions.value = prefs.get("customInstructions") || "";
  els.ciCount.textContent = `${els.customInstructions.value.length} / 4000`;
  els.accessSetting.hidden = !state.config.access_code_required;
  els.accessCodeInput.value = prefs.get("accessCode") || "";
  const modeText =
    state.config.mode === "demo"
      ? "Demo mode (no API key on the server)"
      : state.config.mode === "claude"
        ? "Connected to Claude"
        : "Server unreachable";
  els.about.innerHTML = `<strong>${escapeHtml(state.config.app_name)}</strong> v${escapeHtml(
    state.config.version,
  )} · ${escapeHtml(modeText)} · ${store.persistent ? "Chats saved in this browser" : "Chats kept for this session only"}`;
  els.settingsDialog.showModal();
}

function openAccessDialog() {
  if (els.accessDialog.open) return;
  els.accessDialogInput.value = "";
  els.accessDialog.showModal();
}

function exportMarkdown(conv) {
  const lines = [`# ${conv.title}`, "", `_Exported from NovaChat on ${new Date().toLocaleString()}_`, ""];
  for (const m of conv.messages) {
    if (m.role === "user") {
      lines.push("### 🧑 You", "");
      if (m.images?.length) lines.push(`_(${m.images.length} image${m.images.length > 1 ? "s" : ""} attached)_`, "");
      lines.push(m.content || "", "");
    } else {
      lines.push(`### ✨ Nova${m.meta?.model ? ` (${modelLabel(m.meta.model)})` : ""}`, "");
      lines.push(m.content || (m.error ? `_Error: ${m.error}_` : ""), "");
    }
  }
  download(`${slug(conv.title)}.md`, lines.join("\n"), "text/markdown");
}

// ---------------------------------------------------------------- pickers
function setupPickers() {
  const cfg = state.config;
  const pick = (saved, list, fallback) => (list.some((x) => x.id === saved) ? saved : fallback);

  pickers.model = new Picker($("modelPicker"), {
    items: cfg.models.map((m) => ({ id: m.id, label: m.label, description: m.tagline, iconHtml: icon("sparkles") })),
    value: pick(prefs.get("model"), cfg.models, cfg.default_model),
    renderButton: (item) => `<span>${escapeHtml(item.label)}</span>`,
    onChange: (id) => {
      prefs.set("model", id);
      if (!activeConv()) renderEmpty();
    },
  });

  pickers.persona = new Picker($("personaPicker"), {
    items: cfg.personas.map((p) => ({
      id: p.id,
      label: p.name,
      description: p.description,
      iconHtml: `<span aria-hidden="true">${escapeHtml(p.emoji)}</span>`,
    })),
    value: pick(prefs.get("persona"), cfg.personas, cfg.default_persona),
    renderButton: (item) => `${item.iconHtml}<span>${escapeHtml(item.label)}</span>`,
    onChange: (id) => {
      prefs.set("persona", id);
      if (!activeConv()) renderEmpty();
    },
  });

  pickers.effort = new Picker($("effortPicker"), {
    items: cfg.efforts.map((e) => ({
      id: e.id,
      label: e.label,
      description: EFFORT_INFO[e.id]?.desc || "",
      iconHtml: icon(EFFORT_INFO[e.id]?.icon || "bolt"),
    })),
    value: pick(prefs.get("effort"), cfg.efforts, cfg.default_effort),
    renderButton: (item) => `${item.iconHtml}<span>${escapeHtml(item.label)}</span>`,
    onChange: (id) => prefs.set("effort", id),
  });
}

function applyModeUi() {
  const mode = state.config.mode;
  els.demoBadge.hidden = mode !== "demo";
  els.modePill.hidden = false;
  els.modePill.className = `mode-pill${mode === "demo" ? " demo" : ""}`;
  els.modePill.innerHTML =
    mode === "demo"
      ? '<span class="dot"></span><span>Demo mode - add an API key</span>'
      : mode === "claude"
        ? '<span class="dot"></span><span>Connected to Claude</span>'
        : '<span class="dot"></span><span>Offline</span>';
}

// ---------------------------------------------------------------- events
function bindEvents() {
  els.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.streaming) stopStreaming();
    else send();
  });

  els.input.addEventListener("input", () => {
    autoGrow();
    updateSendState();
  });

  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isTouch()) {
      e.preventDefault();
      if (!state.streaming) send();
    }
  });

  els.input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  // drag & drop images onto the composer
  let dragDepth = 0;
  els.composer.addEventListener("dragenter", (e) => {
    if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
    e.preventDefault();
    dragDepth += 1;
    els.composer.classList.add("dragging");
  });
  els.composer.addEventListener("dragover", (e) => e.preventDefault());
  els.composer.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.composer.classList.remove("dragging");
  });
  els.composer.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.composer.classList.remove("dragging");
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  els.attachBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    addFiles(els.fileInput.files);
    els.fileInput.value = "";
  });

  els.thinkingToggle.addEventListener("click", () => {
    const next = prefs.get("showThinking") === false;
    prefs.set("showThinking", next);
    els.thinkingToggle.setAttribute("aria-pressed", String(next));
    toast(next ? "Thinking summaries on" : "Thinking summaries off");
  });

  els.newChat.addEventListener("click", newChat);
  $("newChatTopBtn").addEventListener("click", newChat);
  els.collapse.addEventListener("click", toggleSidebar);
  els.menu.addEventListener("click", toggleSidebar);
  els.scrim.addEventListener("click", closeMobileSidebar);
  els.search.addEventListener("input", () => {
    state.search = els.search.value;
    renderSidebar();
  });

  els.scrollBottom.addEventListener("click", () => {
    state.stickToBottom = true;
    scrollToBottom(true);
  });

  els.themeBtn.addEventListener("click", () => {
    const current = prefs.get("theme") || "system";
    const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
    setTheme(next);
    toast(`Theme: ${next[0].toUpperCase()}${next.slice(1)}`);
  });

  els.exportBtn.addEventListener("click", () => {
    const conv = activeConv();
    if (conv?.messages.length) exportMarkdown(conv);
  });

  // settings dialog
  els.settingsBtn.addEventListener("click", openSettings);
  els.themeSegmented.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-theme-choice]");
    if (btn) setTheme(btn.dataset.themeChoice);
  });
  els.customInstructions.addEventListener("input", () => {
    prefs.set("customInstructions", els.customInstructions.value);
    els.ciCount.textContent = `${els.customInstructions.value.length} / 4000`;
  });
  els.accessCodeInput.addEventListener("input", () => prefs.set("accessCode", els.accessCodeInput.value.trim()));
  els.exportAll.addEventListener("click", () => {
    const data = JSON.stringify({ exportedAt: new Date().toISOString(), conversations: state.conversations }, null, 2);
    download(`novachat-export-${new Date().toISOString().slice(0, 10)}.json`, data, "application/json");
  });
  els.clearAll.addEventListener("click", async () => {
    if (!state.conversations.length) return;
    if (!confirm("Delete ALL chats stored in this browser? This can't be undone.")) return;
    stopStreaming();
    await store.clear();
    state.conversations = [];
    els.settingsDialog.close();
    newChat();
    toast("All chats deleted");
  });

  // access dialog
  els.accessForm.addEventListener("submit", () => {
    const code = els.accessDialogInput.value.trim();
    if (code) {
      prefs.set("accessCode", code);
      toast("Access code saved - you can send your message now.");
    }
  });

  els.lightbox.addEventListener("click", () => els.lightbox.close());

  // global shortcuts
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape" && state.streaming && !isPickerOpen() && !document.querySelector("dialog[open]")) {
      stopStreaming();
    } else if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      newChat();
    } else if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      els.input.focus();
    }
  });
}

// ---------------------------------------------------------------- init
async function init() {
  hydrateIcons();
  applyTheme(prefs.get("theme") || "system");
  if (prefs.get("sidebarCollapsed") && !isMobile()) els.app.classList.add("sidebar-collapsed");
  els.thinkingToggle.setAttribute("aria-pressed", String(prefs.get("showThinking") !== false));

  const [, config] = await Promise.all([
    store.init(),
    fetchConfig().catch((err) => {
      console.error(err);
      toast("Couldn't reach the NovaChat server. Is it running?", "error", 6000);
      return null;
    }),
  ]);
  if (config) state.config = config;

  setupPickers();
  applyModeUi();
  bindEvents();

  state.conversations = await store.list();
  // A reply that was streaming when the page closed is marked as interrupted.
  for (const conv of state.conversations) {
    for (const m of conv.messages) {
      if (m.status === "streaming") {
        m.status = "done";
        m.meta = { ...(m.meta || {}), stopped: true };
      }
    }
  }
  sortConversations();

  const last = prefs.get("lastConversationId");
  if (last && state.conversations.some((c) => c.id === last)) openConversation(last);
  else newChat();

  updateSendState();
  if (state.config.access_code_required && !prefs.get("accessCode")) openAccessDialog();
}

init();
