import "dotenv/config";
import express from "express";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
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
  ownerIds: [],
  ownerKeyHashes: [],
  pendingDeletes: [],
  lastUpdateId: 0,
};

let db = await loadDb();
let polling = false;

function passwordHash(password) {
  return createHmac("sha256", pepper).update(String(password).trim()).digest("hex");
}

function ownerKeyHash(ownerKey) {
  return createHash("sha256").update(String(ownerKey).trim()).digest("hex");
}

function ownerKeyHashes() {
  const fromEnv = String(process.env.OWNER_KEY_HASHES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...fromEnv, ...(db.ownerKeyHashes || [])]);
}

function isOwnerKey(ownerKey) {
  const key = String(ownerKey || "").trim();
  return key.length >= 20 && ownerKeyHashes().has(ownerKeyHash(key));
}

function isOwnerUser(userId) {
  return (db.ownerIds || []).includes(String(userId));
}

function makePassword() {
  return randomBytes(18).toString("base64url");
}

function generatePasswords(count) {
  const safeCount = Math.max(1, Math.min(Number(count) || roomSize, 25));
  const created = [];

  for (let index = 0; index < safeCount; index += 1) {
    const password = makePassword();
    db.passwords[passwordHash(password)] = {
      createdAt: new Date().toISOString(),
      usedBy: null,
      usedAt: null,
    };
    created.push(password);
  }

  return created;
}

function unusedPasswordCount() {
  return Object.values(db.passwords || {}).filter((entry) => !entry.usedBy).length;
}

function resetRoom(count = roomSize) {
  db.passwords = {};
  db.users = {};
  return generatePasswords(count);
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
  const userId = String(message.from?.id || "");

  if (text?.startsWith("/owner")) {
    const ownerKey = text.replace(/^\/owner(?:@\w+)?\s*/i, "");
    await safeTelegram("deleteMessage", {
      chat_id: message.chat.id,
      message_id: message.message_id,
    });

    if (!isOwnerKey(ownerKey)) {
      await sendExpiringMessage(message.chat.id, "Owner key is not valid.");
      return;
    }

    db.ownerIds = [...new Set([...(db.ownerIds || []), userId])];
    await saveDb();
    await sendExpiringMessage(
      message.chat.id,
      "Owner mode enabled.\n\nCommands:\n/newroom - create a fresh room and 5 codes\n/newcodes 3 - add more member codes\n/room - show room status",
    );
    return;
  }

  if (isOwnerUser(userId) && text?.startsWith("/newroom")) {
    const count = Number(text.split(/\s+/)[1] || roomSize);
    const passwords = resetRoom(count);
    await saveDb();
    await sendExpiringMessage(
      message.chat.id,
      `Fresh room created. Give each person one code:\n\n${passwords.map((password, index) => `${index + 1}. ${password}`).join("\n")}`,
    );
    return;
  }

  if (isOwnerUser(userId) && text?.startsWith("/newcodes")) {
    const count = Number(text.split(/\s+/)[1] || 1);
    const passwords = generatePasswords(count);
    await saveDb();
    await sendExpiringMessage(
      message.chat.id,
      `New member code${passwords.length === 1 ? "" : "s"}:\n\n${passwords.map((password, index) => `${index + 1}. ${password}`).join("\n")}`,
    );
    return;
  }

  if (isOwnerUser(userId) && text === "/room") {
    await sendExpiringMessage(
      message.chat.id,
      `${activeUsers().length}/${roomSize} connected.\nUnused codes: ${unusedPasswordCount()}`,
    );
    return;
  }

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
app.use(express.urlencoded({ extended: false }));

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function dashboardPage(ownerKey, generated = []) {
  const users = activeUsers();
  const codeList = generated.length
    ? `<section class="result"><h2>New codes</h2><p>Copy these now. They are shown once.</p><pre>${escapeHtml(generated.map((password, index) => `${index + 1}. ${password}`).join("\n"))}</pre></section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Room Owner</title>
  <style>
    :root { font-family: Inter, system-ui, sans-serif; color: #17211f; background: #eef1eb; }
    body { margin: 0; padding: 24px; }
    main { width: min(920px, 100%); margin: 0 auto; }
    header, section { background: #fffdf8; border: 1px solid #d8ded6; border-radius: 8px; padding: 18px; margin-bottom: 14px; }
    h1, h2 { margin: 0 0 10px; letter-spacing: 0; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .stat { background: #f5f7f1; border-radius: 8px; padding: 12px; }
    .stat strong { display: block; font-size: 1.8rem; }
    form { display: flex; gap: 10px; flex-wrap: wrap; align-items: end; }
    label { display: grid; gap: 5px; font-weight: 700; }
    input { border: 1px solid #cbd3ca; border-radius: 8px; padding: 10px; font: inherit; }
    button { border: 0; border-radius: 8px; padding: 11px 14px; background: #137b63; color: white; font-weight: 800; cursor: pointer; }
    button.danger { background: #a53838; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #17211f; color: #f9fff8; padding: 14px; border-radius: 8px; }
    ul { padding-left: 20px; }
    @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } body { padding: 12px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Anonymous Room Owner</h1>
      <p>Use this page to create a fresh room or add member codes.</p>
    </header>
    <section class="grid">
      <div class="stat"><span>Connected</span><strong>${users.length}/${roomSize}</strong></div>
      <div class="stat"><span>Unused codes</span><strong>${unusedPasswordCount()}</strong></div>
      <div class="stat"><span>Owners</span><strong>${(db.ownerIds || []).length}</strong></div>
    </section>
    ${codeList}
    <section>
      <h2>Create Fresh Room</h2>
      <p>This clears joined members and old codes, then creates new codes.</p>
      <form method="post" action="/owner/new-room">
        <input type="hidden" name="ownerKey" value="${escapeHtml(ownerKey)}" />
        <label>Codes <input name="count" type="number" min="1" max="25" value="${roomSize}" /></label>
        <button class="danger" type="submit">Create fresh room</button>
      </form>
    </section>
    <section>
      <h2>Add New Member Codes</h2>
      <form method="post" action="/owner/new-codes">
        <input type="hidden" name="ownerKey" value="${escapeHtml(ownerKey)}" />
        <label>Codes <input name="count" type="number" min="1" max="25" value="1" /></label>
        <button type="submit">Create codes</button>
      </form>
    </section>
    <section>
      <h2>People</h2>
      ${
        users.length
          ? `<ul>${users.map((person) => `<li>${escapeHtml(person.alias)} joined ${escapeHtml(person.joinedAt)}</li>`).join("")}</ul>`
          : "<p>No one is connected yet.</p>"
      }
    </section>
  </main>
</body>
</html>`;
}

function ownerLoginPage() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Owner Login</title></head>
<body style="font-family: system-ui, sans-serif; padding: 24px; background: #eef1eb;">
  <main style="max-width: 520px; margin: 0 auto; background: #fffdf8; border: 1px solid #d8ded6; border-radius: 8px; padding: 18px;">
    <h1>Owner Login</h1>
    <form method="get" action="/owner">
      <label style="display: grid; gap: 6px;">Owner key
        <input name="key" type="password" autofocus style="padding: 10px; border: 1px solid #cbd3ca; border-radius: 8px;" />
      </label>
      <button style="margin-top: 12px; padding: 10px 14px; border: 0; border-radius: 8px; background: #137b63; color: white; font-weight: 800;">Open dashboard</button>
    </form>
  </main>
</body>
</html>`;
}

function requireOwnerKey(request, response) {
  const ownerKey = request.body?.ownerKey || request.query?.key;
  if (!isOwnerKey(ownerKey)) {
    response.status(401).type("html").send(ownerLoginPage());
    return "";
  }
  return ownerKey;
}

app.get("/", (_request, response) => {
  response.type("text").send("Telegram Anonymous Room bot is running.");
});

app.get("/owner", (request, response) => {
  const ownerKey = requireOwnerKey(request, response);
  if (!ownerKey) return;
  response.type("html").send(dashboardPage(ownerKey));
});

app.post("/owner/new-room", async (request, response) => {
  const ownerKey = requireOwnerKey(request, response);
  if (!ownerKey) return;
  const generated = resetRoom(request.body?.count);
  await saveDb();
  response.type("html").send(dashboardPage(ownerKey, generated));
});

app.post("/owner/new-codes", async (request, response) => {
  const ownerKey = requireOwnerKey(request, response);
  if (!ownerKey) return;
  const generated = generatePasswords(request.body?.count);
  await saveDb();
  response.type("html").send(dashboardPage(ownerKey, generated));
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
await pollOnce().catch((error) => console.error(error.message));
