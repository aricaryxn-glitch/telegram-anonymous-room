import "dotenv/config";
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const dbPath = path.join(dataDir, "db.json");
const count = Number(process.argv[2] || process.env.ROOM_SIZE || 5);
const pepper = process.env.PASSWORD_PEPPER;

if (!pepper || pepper.length < 24) {
  throw new Error("Set PASSWORD_PEPPER in .env before generating passwords.");
}

function passwordHash(password) {
  return createHmac("sha256", pepper).update(password).digest("hex");
}

function makePassword() {
  return randomBytes(18).toString("base64url");
}

async function loadDb() {
  await mkdir(dataDir, { recursive: true });
  try {
    return JSON.parse(await readFile(dbPath, "utf8"));
  } catch {
    return {
      passwords: {},
      users: {},
      pendingDeletes: [],
      lastUpdateId: 0,
    };
  }
}

async function saveDb(db) {
  const tmpPath = `${dbPath}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(db, null, 2)}\n`);
  await rename(tmpPath, dbPath);
}

const db = await loadDb();
const passwords = [];

for (let index = 0; index < count; index += 1) {
  const password = makePassword();
  db.passwords[passwordHash(password)] = {
    createdAt: new Date().toISOString(),
    usedBy: null,
    usedAt: null,
  };
  passwords.push(password);
}

await saveDb(db);

console.log("Give each person exactly one password. They are shown once here:");
for (const [index, password] of passwords.entries()) {
  console.log(`${index + 1}. ${password}`);
}
