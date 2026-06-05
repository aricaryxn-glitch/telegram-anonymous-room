import "dotenv/config";
import express from "express";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const dbPath = path.join(dataDir, "db.json");

const token = process.env.TELEGRAM_BOT_TOKEN;
const pepper = process.env.PASSWORD_PEPPER;
const roomSize = Number(process.env.ROOM_SIZE || 5);
const ttlMs = Number(process.env.MESSAGE_TTL_MS || 60 * 60 * 1000);
const port = Number(process.env.PORT || 3000);
const api = token ? `https://api.telegram.org/bot${token}` : "";
const aliases = ["Moss", "Echo", "Nova", "Slate", "Rune", "Vale", "Orion", "Kite"];

if (!token || token.includes("put_your_botfather_token_here")) {
  throw new Error("Set TELEGRAM_BOT_TOKEN in .env or hosting environment variables.");
}

if (!pepper || pepper.length < 24) {
  throw new Error("Set PASSWORD_PEPPER to a long random secret, at least 24 characters.");
}

const starterDb = {
  passwords: {},
  users: {},
  pendingDeletes: [],
  lastUpdateId: 0,
};

let db = await loadDb();
let polling = false;

function passwordHash(password) {
  return createHmac("sha256", pepper).update(String(password).trim()).digest("hex");
}

async function loadDb() {
  await mkdir(dataDir, { recursive: true });
  try {
    return { ...starterDb, ...JSON.parse(await readFile(dbPath, "utf8")) };
  } catch {
    await saveDb(starterDb);
    return structuredClone(starterDb);
  }
}

async function saveDb(nextDb = db) {
  await mkdir(dataDir, { recursive: true });
  const tmpPath = `${dbPath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(nextDb, null, 2)}\n`);
  await rename(tmpPath, dbPath);
}

async function telegram(method, payload = {}) {
  const response = await fetch(`${api}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(`${method} failed: ${body.description || response.statusText}`);
  }
  return body.result;
}

async function safeTelegram(method, payload = {}) {
  try {
    return await telegram(method, payload);
  } catch (error) {
    console.warn(error.message);
    return null;
  }
}

function activeUsers() {
  return Object.values(db.users).filter((user) => user.active);
}

function userForMessage(message) {
  return db.users[String(message.from?.id)];
}

function nextAlias() {
  const used = new Set(activeUsers().map((user) => user.alias));
  return aliases.find((alias) => !used.has(alias)) || `Anon ${activeUsers().length + 1}`;
}

function trackDelete(chatId, messageId, deleteAt = Date.now() + ttlMs) {
  if (!chatId || !messageId) return;
  db.pendingDeletes.push({ chatId, messageId, deleteAt });
}

async function sendExpiringMessage(chatId, text, options = {}) {
  const sent = await safeTelegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    protect_content: true,
    ...options,
  });
  if (sent?.message_id) trackDelete(chatId, sent.message_id);
  return sent;
}

async function deleteLaterNowDue() {
  const now = Date.now();
  const due = [];
  const later = [];

  for (const item of db.pendingDeletes) {
    if (item.deleteAt <= now) due.push(item);
    else later.push(item);
  }

  if (!due.length) return;

  db.pendingDeletes = later;
  await saveDb();

  for (const item of due) {
    await safeTelegram("deleteMessage", {
      chat_id: item.chatId,
      message_id: item.messageId,
    });
  }
}

async function registerPassword(message, password) {
  const hash = passwordHash(password);
  const entry = db.passwords[hash];
  const userId = String(message.from.id);

  await safeTelegram("deleteMessage", {
    chat_id: message.chat.id,
    message_id: message.message_id,
  });

  if (!entry) {
    await sendExpiringMessage(message.chat.id, "That password is not valid. Ask the room owner for your own code.");
    return;
  }

  if (entry.usedBy && entry.usedBy !== userId) {
    await sendExpiringMessage(message.chat.id, "That password has already been used.");
    return;
  }

  const existing = db.users[userId];
  if (!existing && activeUsers().length >= roomSize) {
    await sendExpiringMessage(message.chat.id, "This room is already full.");
    return;
  }

  const alias = existing?.alias || nextAlias();
  db.passwords[hash] = {
    ...entry,
    usedBy: userId,
    usedAt: new Date().toISOString(),
  };
  db.users[userId] = {
    id: userId,
    chatId: message.chat.id,
    alias,
    active: true,
    joinedAt: existing?.joinedAt || new Date().toISOString(),
  };
  await saveDb();

  await sendExpiringMessage(message.chat.id, `You are in as ${alias}. Send any message here and it will relay anonymously.`);
  await broadcastSystem(`${alias} joined. ${activeUsers().length}/${roomSize} connected.`, userId);
}

async function broadcastSystem(text, exceptUserId = "") {
  for (const user of activeUsers()) {
    if (user.id === exceptUserId) continue;
    await sendExpiringMessage(user.chatId, text);
  }
}

async function relayMessage(message, sender) {
  const recipients = activeUsers().filter((user) => user.id !== sender.id);

  trackDelete(message.chat.id, message.message_id);

  if (!recipients.length) {
    await sendExpiringMessage(sender.chatId, "You are connected. Waiting for the others to join.");
    await saveDb();
    return;
  }

  for (const recipient of recipients) {
    if (message.text) {
      await sendExpiringMessage(recipient.chatId, `${sender.alias}: ${message.text}`);
      continue;
    }

    if (message.caption) {
      const copied = await safeTelegram("copyMessage", {
        chat_id: recipient.chatId,
        from_chat_id: message.chat.id,
        message_id: message.message_id,
        caption: `${sender.alias}: ${message.caption}`,
        protect_content: true,
      });
      if (copied?.message_id) trackDelete(recipient.chatId, copied.message_id);
      continue;
    }

    await sendExpiringMessage(recipient.chatId, `${sender.alias} sent a message:`);
    const copied = await safeTelegram("copyMessage", {
      chat_id: recipient.chatId,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
      protect_content: true,
    });
    if (copied?.message_id) trackDelete(recipient.chatId, copied.message_id);
  }

  await saveDb();
}

async function handleMessage(message) {
  if (message.chat.type !== "private") {
    await sendExpiringMessage(message.chat.id, "Please use this bot in private chat.");
    return;
  }

  const text = message.text?.trim();
  const user = userForMessage(message);

  if (text === "/start") {
    await sendExpiringMessage(
      message.chat.id,
      "Send your unique room password. I will delete the password message immediately after checking it.",
    );
    return;
  }

  if (text === "/who") {
    await sendExpiringMessage(message.chat.id, `${activeUsers().length}/${roomSize} connected.`);
    return;
  }

  if (text === "/leave") {
    if (user) {
      db.users[user.id].active = false;
      await saveDb();
      await sendExpiringMessage(message.chat.id, "You left the room.");
      await broadcastSystem(`${user.alias} left. ${activeUsers().length}/${roomSize} connected.`, user.id);
    }
    return;
  }

  if (!user?.active) {
    if (!text) {
      await sendExpiringMessage(message.chat.id, "Send /start first, then send your unique password.");
      return;
    }
    await registerPassword(message, text);
    return;
  }

  await relayMessage(message, user);
}

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const updates = await telegram("getUpdates", {
      offset: db.lastUpdateId ? db.lastUpdateId + 1 : undefined,
      timeout: 25,
      allowed_updates: ["message"],
    });

    for (const update of updates) {
      db.lastUpdateId = update.update_id;
      if (update.message) await handleMessage(update.message);
      await saveDb();
    }
  } finally {
    polling = false;
  }
}

const app = express();
app.get("/", (_request, response) => {
  response.type("text").send("Telegram Anonymous Room bot is running.");
});
app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    connected: activeUsers().length,
    capacity: roomSize,
    pendingDeletes: db.pendingDeletes.length,
  });
});

app.listen(port, () => {
  console.log(`Health server running on port ${port}`);
});

setInterval(() => {
  pollOnce().catch((error) => console.error(error.message));
}, 1500);

setInterval(() => {
  deleteLaterNowDue().catch((error) => console.error(error.message));
}, 30_000);

await safeTelegram("deleteWebhook", { drop_pending_updates: false });
console.log("Telegram bot polling started.");
await pollOnce();
