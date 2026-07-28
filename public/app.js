const $ = (id) => document.getElementById(id);

const login = $("login");
const chat = $("chat");
const statusEl = $("status");
const tokenInput = $("tokenInput");
const loginBtn = $("loginBtn");
const logoutBtn = $("logoutBtn");
const historyBtn = $("historyBtn");
const newChatBtn = $("newChatBtn");
const closeHistoryBtn = $("closeHistoryBtn");
const historyPanel = $("historyPanel");
const conversationList = $("conversationList");
const messages = $("messages");
const promptInput = $("promptInput");
const sendBtn = $("sendBtn");
const abortBtn = $("abortBtn");
const imageBtn = $("imageBtn");
const docBtn = $("docBtn");
const imageInput = $("imageInput");
const docInput = $("docInput");
const attachmentsEl = $("attachments");

let token = localStorage.getItem("pi_mobile_token") || "";
let events;
let currentAssistant;
let attachments = [];
let conversations = [];
let activeConversationId = "";

function isNearBottom() {
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
}

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

function scrollToBottomIfNeeded(shouldScroll) {
  if (shouldScroll) scrollToBottom();
}

function setStatus(text) {
  statusEl.textContent = text;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return html;
}

function renderMarkdown(markdown) {
  const lines = String(markdown || "").split("\n");
  const out = [];
  let inCode = false;
  let code = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const line of lines) {
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      code.push(line);
      continue;
    }

    if (/^\s*$/.test(line)) {
      closeList();
      out.push("");
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const list = line.match(/^\s*[-*+]\s+(.+)$/);
    if (list) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${renderInlineMarkdown(list[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }

  closeList();
  if (inCode) out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  return out.join("\n");
}

function enhanceCodeBlocks(container) {
  for (const pre of container.querySelectorAll("pre")) {
    if (pre.classList.contains("code-enhanced")) continue;
    pre.classList.add("code-enhanced");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-code-btn";
    btn.textContent = "复制";
    btn.onclick = async () => {
      const code = pre.querySelector("code")?.textContent || pre.textContent || "";
      try {
        await navigator.clipboard.writeText(code);
        btn.textContent = "已复制";
        setTimeout(() => (btn.textContent = "复制"), 1200);
      } catch {
        btn.textContent = "复制失败";
        setTimeout(() => (btn.textContent = "复制"), 1200);
      }
    };
    pre.appendChild(btn);
  }
}

function addMessage(role, text = "") {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.dataset.raw = text;
  if (role === "assistant") {
    bubble.innerHTML = renderMarkdown(text);
    enhanceCodeBlocks(bubble);
  } else bubble.textContent = text;
  wrap.appendChild(bubble);
  const shouldScroll = isNearBottom();
  messages.appendChild(wrap);
  scrollToBottomIfNeeded(shouldScroll || role === "user");
  return bubble;
}

function addTool(title, payload) {
  const bubble = addMessage("tool", title);
  if (payload !== undefined) {
    const pre = document.createElement("pre");
    pre.textContent = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    bubble.appendChild(pre);
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read file failed"));
    reader.readAsDataURL(file);
  });
}

function fileToText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read file failed"));
    reader.readAsText(file);
  });
}

function renderAttachments() {
  attachmentsEl.textContent = "";
  for (const [index, item] of attachments.entries()) {
    const chip = document.createElement("span");
    chip.className = "attachment";
    chip.textContent = `${item.kind === "image" ? "图片" : "文档"}: ${item.name}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.onclick = () => {
      attachments.splice(index, 1);
      renderAttachments();
    };
    chip.appendChild(remove);
    attachmentsEl.appendChild(chip);
  }
}

async function addImageFiles(files) {
  for (const file of files) {
    const dataUrl = await fileToDataUrl(file);
    const [, meta = "", data = ""] = dataUrl.match(/^data:([^;]+);base64,(.*)$/) || [];
    if (!data) continue;
    attachments.push({ kind: "image", name: file.name, mimeType: meta || file.type || "image/png", data });
  }
  renderAttachments();
}

async function addDocFiles(files) {
  for (const file of files) {
    if (file.size > 512 * 1024) {
      addMessage("system", `文档太大，已跳过：${file.name}。当前限制 512KB。`);
      continue;
    }
    const text = await fileToText(file);
    attachments.push({ kind: "doc", name: file.name, text });
  }
  renderAttachments();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function renderConversations() {
  conversationList.textContent = "";
  for (const conv of conversations) {
    const item = document.createElement("div");
    item.className = `conversation-item ${conv.id === activeConversationId ? "active" : ""}`;

    const title = document.createElement("div");
    title.className = "conversation-title";
    const strong = document.createElement("strong");
    strong.textContent = conv.title || "新聊天";
    const small = document.createElement("small");
    small.textContent = new Date(conv.updatedAt || conv.createdAt || Date.now()).toLocaleString();
    title.append(strong, small);
    title.onclick = () => selectConversation(conv.id);

    const rename = document.createElement("button");
    rename.className = "ghost";
    rename.textContent = "重命名";
    rename.onclick = async () => {
      const next = prompt("新的会话名称", conv.title || "新聊天");
      if (!next) return;
      await api(`/api/conversations/${conv.id}`, { method: "PATCH", body: JSON.stringify({ title: next }) });
      await loadConversations();
    };

    const del = document.createElement("button");
    del.className = "ghost danger";
    del.textContent = "删除";
    del.onclick = async () => {
      if (!confirm(`删除会话「${conv.title || "新聊天"}」？`)) return;
      await api(`/api/conversations/${conv.id}`, { method: "DELETE" });
      await loadConversations();
      await loadHistory();
    };

    item.append(title, rename, del);
    conversationList.appendChild(item);
  }
}

async function loadConversations() {
  const data = await api("/api/conversations");
  conversations = data.conversations || [];
  activeConversationId = data.activeId || "";
  renderConversations();
}

async function selectConversation(id) {
  const data = await api(`/api/conversations/${id}/select`, { method: "POST", body: "{}" });
  conversations = (await api("/api/conversations")).conversations || [];
  activeConversationId = data.activeId || id;
  renderConversations();
  renderMessages(data.messages || []);
  historyPanel.classList.add("hidden");
  setStatus(`已切换到：${data.conversation?.title || "聊天"}`);
}

function renderMessages(items, isStreaming = false) {
  messages.textContent = "";
  currentAssistant = null;
  for (const item of items || []) {
    if (item.role === "user") {
      addMessage("user", item.text || "");
    } else if (item.role === "assistant") {
      currentAssistant = addMessage("assistant", item.text || "");
    } else if (item.role === "tool") {
      addTool(item.title || "工具调用", item.payload);
      currentAssistant = null;
    } else {
      addMessage("system", item.text || item.title || "");
      currentAssistant = null;
    }
  }
  if (!isStreaming) currentAssistant = null;
}

async function loadHistory(isStreaming = false) {
  const data = await api("/api/messages");
  activeConversationId = data.activeId || activeConversationId;
  renderMessages(data.messages || [], isStreaming);
  await loadConversations();
}

async function connect() {
  if (!token) return showLogin();
  try {
    const state = await api("/api/state");
    login.classList.add("hidden");
    chat.classList.remove("hidden");
    setStatus(`已连接 · cwd=${state.cwd} · ${state.model?.id || "model?"}`);
    await loadHistory(state.isStreaming);
    openEvents();
  } catch (err) {
    localStorage.removeItem("pi_mobile_token");
    token = "";
    showLogin();
    setStatus(`登录失败：${err.message}`);
  }
}

function showLogin() {
  login.classList.remove("hidden");
  chat.classList.add("hidden");
  setStatus("未连接");
  tokenInput.value = token;
}

function openEvents() {
  events?.close();
  events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);

  events.addEventListener("ready", (ev) => {
    const data = JSON.parse(ev.data);
    setStatus(`事件流已连接 · cwd=${data.cwd}`);
  });

  events.addEventListener("assistant_delta", (ev) => {
    const data = JSON.parse(ev.data);
    const shouldScroll = isNearBottom();
    if (!currentAssistant) currentAssistant = addMessage("assistant", "");
    currentAssistant.dataset.raw = (currentAssistant.dataset.raw || "") + data.text;
    currentAssistant.innerHTML = renderMarkdown(currentAssistant.dataset.raw);
    enhanceCodeBlocks(currentAssistant);
    scrollToBottomIfNeeded(shouldScroll);
  });

  events.addEventListener("tool_start", (ev) => {
    const data = JSON.parse(ev.data);
    currentAssistant = null;
    addTool(`工具开始：${data.tool}`, data.input);
  });

  events.addEventListener("tool_end", (ev) => {
    const data = JSON.parse(ev.data);
    addTool(`工具结束：${data.tool}`, data.error || data.result || "ok");
  });

  events.addEventListener("agent_end", () => {
    currentAssistant = null;
    setStatus("任务完成");
  });

  events.addEventListener("chat_switched", async (ev) => {
    const data = JSON.parse(ev.data);
    activeConversationId = data.activeId || activeConversationId;
    renderMessages(data.messages || []);
    await loadConversations();
    setStatus(`已切换到：${data.conversation?.title || "聊天"}`);
  });

  events.addEventListener("conversations_updated", (ev) => {
    const data = JSON.parse(ev.data);
    conversations = data.conversations || conversations;
    activeConversationId = data.activeId || activeConversationId;
    renderConversations();
  });

  events.addEventListener("queue_update", (ev) => {
    const data = JSON.parse(ev.data);
    setStatus(`队列：steer=${data.steering}, followUp=${data.followUp}`);
  });

  events.addEventListener("error", (ev) => {
    const data = JSON.parse(ev.data);
    currentAssistant = null;
    addMessage("system", `错误：${data.message}`);
    setStatus("错误");
  });

  events.onerror = () => {
    setStatus("事件流断开，正在重连...");
  };
}

async function sendPrompt() {
  let message = promptInput.value.trim();
  if (!message && attachments.length === 0) return;

  const images = attachments
    .filter((item) => item.kind === "image")
    .map((item) => ({ type: "image", data: item.data, mimeType: item.mimeType }));
  const docs = attachments.filter((item) => item.kind === "doc");

  if (docs.length) {
    const docText = docs
      .map((doc) => `\n\n---\n附件文档：${doc.name}\n\n\`\`\`\n${doc.text}\n\`\`\``)
      .join("");
    message = `${message || "请阅读我上传的文档并总结重点。"}${docText}`;
  }
  if (!message && images.length) message = "请分析我上传的图片。";

  const displayMessage = `${message.split("\n\n---\n附件文档：")[0]}${attachments.length ? `\n\n[已上传 ${attachments.length} 个附件]` : ""}`;
  promptInput.value = "";
  promptInput.style.height = "auto";
  const sendingAttachments = attachments;
  attachments = [];
  renderAttachments();
  currentAssistant = null;
  addMessage("user", displayMessage);
  setStatus("Pi 正在思考...");
  sendBtn.disabled = true;
  try {
    await api("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ message, displayMessage, images, streamingBehavior: "followUp" }),
    });
  } catch (err) {
    attachments = sendingAttachments.concat(attachments);
    renderAttachments();
    addMessage("system", `发送失败：${err.message}`);
  } finally {
    sendBtn.disabled = false;
    promptInput.focus();
  }
}

loginBtn.onclick = () => {
  token = tokenInput.value.trim();
  localStorage.setItem("pi_mobile_token", token);
  connect();
};

logoutBtn.onclick = () => {
  events?.close();
  localStorage.removeItem("pi_mobile_token");
  token = "";
  messages.textContent = "";
  showLogin();
};

sendBtn.onclick = sendPrompt;
historyBtn.onclick = async () => {
  try {
    await loadConversations();
    historyPanel.classList.toggle("hidden");
    setStatus("聊天会话已加载");
  } catch (err) {
    addMessage("system", `加载聊天会话失败：${err.message}`);
  }
};
closeHistoryBtn.onclick = () => historyPanel.classList.add("hidden");
newChatBtn.onclick = async () => {
  try {
    const data = await api("/api/new-chat", { method: "POST", body: "{}" });
    activeConversationId = data.activeId;
    messages.textContent = "";
    currentAssistant = null;
    await loadConversations();
    setStatus("新聊天已创建");
  } catch (err) {
    addMessage("system", `新建聊天失败：${err.message}`);
  }
};
imageBtn.onclick = () => imageInput.click();
docBtn.onclick = () => docInput.click();
imageInput.onchange = async () => {
  await addImageFiles(imageInput.files || []);
  imageInput.value = "";
};
docInput.onchange = async () => {
  await addDocFiles(docInput.files || []);
  docInput.value = "";
};
abortBtn.onclick = async () => {
  try {
    await api("/api/abort", { method: "POST", body: "{}" });
    addMessage("system", "已请求停止当前任务。 ");
  } catch (err) {
    addMessage("system", `停止失败：${err.message}`);
  }
};

promptInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    sendPrompt();
  }
});

promptInput.addEventListener("input", () => {
  promptInput.style.height = "auto";
  promptInput.style.height = `${promptInput.scrollHeight}px`;
});

connect();
