import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const conversationsDir = path.join(dataDir, "conversations");
const indexPath = path.join(conversationsDir, "index.json");
const legacyChatLogPath = path.join(dataDir, "chat-log.json");
const modelsPath = "/root/.pi/agent/models.json";

const HOST = process.env.PI_MOBILE_HOST || "127.0.0.1";
const PORT = Number(process.env.PI_MOBILE_PORT || 8787);
const TOKEN = process.env.PI_MOBILE_TOKEN || "dev-token-change-me";
const CWD = process.env.PI_MOBILE_CWD || "/root";

const clients = new Set();
const conversations = [];
let activeConversationId;
let activeMessages = [];
let session;
let modelRuntime;
let sessionReady;
let sessionError;
let sessionUnsubscribe;
let currentAssistantEntry;
let persistIndexTimer;
let persistMessagesTimer;

function conversationFile(id) {
  return path.join(conversationsDir, `${id}.json`);
}

function now() {
  return new Date().toISOString();
}

function safeTitle(text) {
  const title = String(text || "").trim().replace(/\s+/g, " ").slice(0, 40);
  return title || "新聊天";
}

function activeConversation() {
  return conversations.find((c) => c.id === activeConversationId);
}

function conversationSummary(c) {
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    sessionId: c.sessionId,
    sessionFile: c.sessionFile,
    isActive: c.id === activeConversationId,
  };
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of clients) sendEvent(res, event, data);
}

function broadcastConversations() {
  broadcast("conversations_updated", {
    activeId: activeConversationId,
    conversations: conversations.map(conversationSummary),
  });
}

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`Failed to load ${file}:`, err);
    return fallback;
  }
}

function publicModel(model, configured = {}) {
  return {
    provider: model.provider,
    id: model.id,
    name: configured.name || model.name || model.id,
    reasoning: Boolean(configured.reasoning ?? model.reasoning),
    input: configured.input || model.input || ["text"],
    contextWindow: configured.contextWindow || model.contextWindow,
    maxTokens: configured.maxTokens || model.maxTokens,
    available: modelRuntime.hasConfiguredAuth(model.provider),
    isCurrent: session?.model?.provider === model.provider && session?.model?.id === model.id,
  };
}

async function getConfiguredModels() {
  const config = await loadJson(modelsPath, { providers: {} });
  const result = [];
  for (const [provider, providerConfig] of Object.entries(config.providers || {})) {
    for (const configured of providerConfig.models || []) {
      const model = modelRuntime.getModel(provider, configured.id);
      if (model) result.push(publicModel(model, configured));
    }
  }
  return result;
}

function persistIndexSoon() {
  clearTimeout(persistIndexTimer);
  persistIndexTimer = setTimeout(async () => {
    try {
      await fs.mkdir(conversationsDir, { recursive: true });
      await fs.writeFile(indexPath, JSON.stringify({ activeId: activeConversationId, conversations }, null, 2));
    } catch (err) {
      console.warn("Failed to persist conversation index:", err);
    }
  }, 100);
}

function persistMessagesSoon() {
  const id = activeConversationId;
  const snapshot = activeMessages.slice(-1000);
  clearTimeout(persistMessagesTimer);
  persistMessagesTimer = setTimeout(async () => {
    if (!id) return;
    try {
      await fs.mkdir(conversationsDir, { recursive: true });
      await fs.writeFile(conversationFile(id), JSON.stringify({ messages: snapshot }, null, 2));
    } catch (err) {
      console.warn("Failed to persist conversation messages:", err);
    }
  }, 100);
}

async function loadMessages(id) {
  const data = await loadJson(conversationFile(id), { messages: [] });
  return Array.isArray(data.messages) ? data.messages : [];
}

function appendChat(entry) {
  const meta = activeConversation();
  const full = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: now(),
    ...entry,
  };
  activeMessages.push(full);
  if (activeMessages.length > 1000) activeMessages.splice(0, activeMessages.length - 1000);
  if (meta) {
    meta.updatedAt = full.time;
    if (meta.title === "新聊天" && entry.role === "user") meta.title = safeTitle(entry.text);
  }
  persistMessagesSoon();
  persistIndexSoon();
  return full;
}

function rememberEvent(name, data) {
  if (name === "assistant_delta") {
    if (!currentAssistantEntry) currentAssistantEntry = appendChat({ role: "assistant", text: "" });
    currentAssistantEntry.text += data.text || "";
    activeConversation().updatedAt = now();
    persistMessagesSoon();
    persistIndexSoon();
    return;
  }
  if (name === "tool_start") {
    appendChat({ role: "tool", title: `工具开始：${data.tool}`, payload: data.input });
    return;
  }
  if (name === "tool_end") {
    appendChat({ role: "tool", title: `工具结束：${data.tool}`, payload: data.error || data.result || "ok" });
    return;
  }
  if (name === "agent_end") currentAssistantEntry = undefined;
}

function normalizeEvent(event) {
  if (event.type === "message_update") {
    const msg = event.assistantMessageEvent;
    if (msg?.type === "text_delta") return { name: "assistant_delta", data: { text: msg.delta } };
  }
  if (event.type === "tool_execution_start") {
    return { name: "tool_start", data: { tool: event.toolName, input: event.input, id: event.toolCallId } };
  }
  if (event.type === "tool_execution_end") {
    return { name: "tool_end", data: { tool: event.toolName, result: event.result, error: event.error, id: event.toolCallId } };
  }
  if (event.type === "agent_end") return { name: "agent_end", data: {} };
  if (event.type === "queue_update") {
    return { name: "queue_update", data: { steering: event.steering?.length || 0, followUp: event.followUp?.length || 0 } };
  }
  if (event.type === "error") return { name: "error", data: { message: event.message || String(event.error || "unknown error") } };
  return { name: "raw", data: event };
}

async function createConversationMeta(title = "新聊天") {
  const t = now();
  const meta = {
    id: randomUUID(),
    title: safeTitle(title),
    createdAt: t,
    updatedAt: t,
    sessionId: undefined,
    sessionFile: undefined,
  };
  conversations.unshift(meta);
  activeConversationId = meta.id;
  activeMessages = [];
  await fs.mkdir(conversationsDir, { recursive: true });
  await fs.writeFile(conversationFile(meta.id), JSON.stringify({ messages: [] }, null, 2));
  persistIndexSoon();
  return meta;
}

async function loadConversations() {
  await fs.mkdir(conversationsDir, { recursive: true });
  const data = await loadJson(indexPath, undefined);
  if (data && Array.isArray(data.conversations)) {
    conversations.push(...data.conversations);
    activeConversationId = data.activeId || conversations[0]?.id;
  } else {
    const legacy = await loadJson(legacyChatLogPath, undefined);
    const meta = await createConversationMeta("旧聊天记录");
    if (legacy && Array.isArray(legacy.messages) && legacy.messages.length) {
      activeMessages = legacy.messages;
      await fs.writeFile(conversationFile(meta.id), JSON.stringify({ messages: activeMessages }, null, 2));
    }
  }
  if (!conversations.length) await createConversationMeta("新聊天");
  if (!activeConversationId || !conversations.some((c) => c.id === activeConversationId)) {
    activeConversationId = conversations[0].id;
  }
}

async function bindSessionToConversation(id) {
  const meta = conversations.find((c) => c.id === id);
  if (!meta) throw new Error("conversation not found");

  try { await session?.abort?.(); } catch {}
  sessionUnsubscribe?.();
  session?.dispose?.();
  currentAssistantEntry = undefined;

  activeConversationId = id;
  activeMessages = await loadMessages(id);

  let manager = meta.sessionFile ? SessionManager.open(meta.sessionFile) : SessionManager.create(CWD);
  let created;
  try {
    created = await createAgentSession({ cwd: CWD, sessionManager: manager, modelRuntime });
  } catch (err) {
    console.warn(`Failed to open session file for conversation ${id}, creating a new session:`, err);
    meta.sessionFile = undefined;
    meta.sessionId = undefined;
    manager = SessionManager.create(CWD);
    created = await createAgentSession({ cwd: CWD, sessionManager: manager, modelRuntime });
  }
  session = created.session;
  meta.sessionId = session.sessionId;
  meta.sessionFile = session.sessionFile;
  meta.updatedAt = meta.updatedAt || now();
  persistIndexSoon();

  sessionUnsubscribe = session.subscribe((event) => {
    const normalized = normalizeEvent(event);
    if (normalized.name !== "raw") {
      rememberEvent(normalized.name, normalized.data);
      broadcast(normalized.name, { ...normalized.data, conversationId: activeConversationId });
    }
  });
  return session;
}

async function initApp() {
  modelRuntime = await ModelRuntime.create({ modelsPath });
  await loadConversations();
  await bindSessionToConversation(activeConversationId);
}

async function newConversation(title = "新聊天") {
  const meta = await createConversationMeta(title);
  await bindSessionToConversation(meta.id);
  broadcast("chat_switched", { activeId: activeConversationId, conversation: conversationSummary(meta), messages: [] });
  broadcastConversations();
  return meta;
}

async function selectConversation(id) {
  await bindSessionToConversation(id);
  const meta = activeConversation();
  broadcast("chat_switched", { activeId: activeConversationId, conversation: conversationSummary(meta), messages: activeMessages });
  broadcastConversations();
  return meta;
}

async function deleteConversation(id) {
  const idx = conversations.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error("conversation not found");
  const wasActive = id === activeConversationId;
  conversations.splice(idx, 1);
  try { await fs.unlink(conversationFile(id)); } catch {}
  if (!conversations.length) {
    const meta = await createConversationMeta("新聊天");
    await bindSessionToConversation(meta.id);
  } else if (wasActive) {
    await bindSessionToConversation(conversations[0].id);
  }
  persistIndexSoon();
  broadcast("chat_switched", { activeId: activeConversationId, conversation: conversationSummary(activeConversation()), messages: activeMessages });
  broadcastConversations();
}

sessionReady = initApp().catch((err) => {
  sessionError = err;
  console.error("Failed to initialize Pi session:", err);
});

function unauthorized(res) {
  res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

function getBearer(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return "";
}

function isAuthorized(req, url) {
  const token = getBearer(req) || url.searchParams.get("token") || "";
  return token === TOKEN;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const type = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function handleApi(req, res, url) {
  if (!isAuthorized(req, url)) return unauthorized(res);
  if (sessionError) return sendJson(res, { error: String(sessionError.message || sessionError) }, 500);
  await sessionReady;

  const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)(?:\/([^/]+))?$/);

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    clients.add(res);
    sendEvent(res, "ready", { cwd: CWD, sessionId: session.sessionId, activeId: activeConversationId });
    const heartbeat = setInterval(() => sendEvent(res, "heartbeat", { t: Date.now() }), 25000);
    req.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, {
      cwd: CWD,
      activeConversationId,
      conversation: conversationSummary(activeConversation()),
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      isStreaming: session.isStreaming,
      model: session.model ? { provider: session.model.provider, id: session.model.id, name: session.model.name } : null,
      thinkingLevel: session.thinkingLevel,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/models") {
    return sendJson(res, {
      current: session.model ? { provider: session.model.provider, id: session.model.id, name: session.model.name } : null,
      models: await getConfiguredModels(),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/model") {
    if (session.isStreaming) return sendJson(res, { error: "cannot switch model while agent is running" }, 409);
    const body = await readJson(req);
    const provider = String(body.provider || "");
    const id = String(body.id || "");
    const configuredModels = await getConfiguredModels();
    const allowed = configuredModels.some((item) => item.provider === provider && item.id === id);
    if (!allowed) return sendJson(res, { error: "model is not declared in models.json" }, 400);
    const model = modelRuntime.getModel(provider, id);
    if (!model) return sendJson(res, { error: "model not found" }, 404);
    await session.setModel(model);
    const selected = publicModel(model);
    broadcast("model_changed", selected);
    return sendJson(res, { ok: true, model: selected });
  }

  if (req.method === "GET" && url.pathname === "/api/conversations") {
    return sendJson(res, { activeId: activeConversationId, conversations: conversations.map(conversationSummary) });
  }

  if (req.method === "POST" && url.pathname === "/api/conversations") {
    const body = await readJson(req);
    const meta = await newConversation(body.title || "新聊天");
    return sendJson(res, { ok: true, activeId: activeConversationId, conversation: conversationSummary(meta) });
  }

  if (conversationMatch) {
    const [, id, action] = conversationMatch;
    const meta = conversations.find((c) => c.id === id);
    if (!meta) return sendJson(res, { error: "conversation not found" }, 404);

    if (req.method === "GET" && !action) {
      return sendJson(res, { conversation: conversationSummary(meta), messages: await loadMessages(id) });
    }
    if (req.method === "POST" && action === "select") {
      await selectConversation(id);
      return sendJson(res, { ok: true, activeId: activeConversationId, conversation: conversationSummary(activeConversation()), messages: activeMessages });
    }
    if (req.method === "PATCH" && !action) {
      const body = await readJson(req);
      meta.title = safeTitle(body.title);
      meta.updatedAt = now();
      persistIndexSoon();
      broadcastConversations();
      return sendJson(res, { ok: true, conversation: conversationSummary(meta) });
    }
    if (req.method === "DELETE" && !action) {
      await deleteConversation(id);
      return sendJson(res, { ok: true, activeId: activeConversationId });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/messages") {
    return sendJson(res, { activeId: activeConversationId, messages: activeMessages });
  }

  if (req.method === "POST" && url.pathname === "/api/prompt") {
    const body = await readJson(req);
    const message = String(body.message || "").trim();
    if (!message) return sendJson(res, { error: "message required" }, 400);

    const displayMessage = String(body.displayMessage || message).trim();
    const entry = appendChat({ role: "user", text: displayMessage });
    broadcast("user_message", { ...entry, conversationId: activeConversationId });
    broadcastConversations();

    sendJson(res, { ok: true, activeId: activeConversationId }, 202);

    currentAssistantEntry = undefined;
    const images = Array.isArray(body.images) ? body.images : [];
    const promptOptions = { streamingBehavior: body.streamingBehavior || "followUp" };
    if (images.length) promptOptions.images = images;
    session.prompt(message, promptOptions).catch((err) => broadcast("error", { message: String(err.message || err), conversationId: activeConversationId }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/new-chat") {
    const meta = await newConversation("新聊天");
    return sendJson(res, { ok: true, activeId: activeConversationId, sessionId: session.sessionId, conversation: conversationSummary(meta) });
  }

  if (req.method === "POST" && url.pathname === "/api/abort") {
    await session.abort();
    return sendJson(res, { ok: true });
  }

  return sendJson(res, { error: "not found" }, 404);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Pi Mobile listening on http://${HOST}:${PORT}`);
  console.log(`cwd=${CWD}`);
  if (TOKEN === "dev-token-change-me") console.warn("WARNING: using default PI_MOBILE_TOKEN. Set a strong token before exposing this service.");
});

async function shutdown() {
  sessionUnsubscribe?.();
  session?.dispose?.();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
