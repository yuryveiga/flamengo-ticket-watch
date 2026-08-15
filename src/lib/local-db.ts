import fs from "fs/promises";
import path from "path";

const DATA_FILE = path.join(process.cwd(), "local-data.json");

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventStatus = "monitorando" | "pausado" | "concluido" | "expirado";

export type EventConfig = {
  account_id: string;
  email: string;
  senha_enc: string;
  setores: string[];
  quantidade: 1 | 2 | 3;
  intervalo: number;
  aceitar_qualquer: boolean;
  headless: boolean;
  loop_continuo: boolean;
};

export type EventRecord = {
  id: string;
  user_id: string;
  login_url: string;
  url: string;
  name: string | null;
  status: EventStatus;
  config: Partial<EventConfig>;
  created_at: string;
  expires_at: string | null;
};

export type AccountRecord = {
  id: string;
  user_id: string;
  label: string;
  email: string;
  senha_enc: string;
  created_at: string;
};

export type BotCommandRecord = {
  id: string;
  event_id: string;
  user_id: string;
  command: "start" | "stop" | "test_login" | "test_all_logins";
  created_at: string;
  processed_at: string | null;
};

export type LogLevel = "info" | "wait" | "warn" | "error" | "success" | "api";

export type LogRecord = {
  id: string;
  event_id: string;
  level: LogLevel;
  message: string;
  ts: string;
};

export type LocalDbData = {
  events: EventRecord[];
  accounts: AccountRecord[];
  bot_commands: BotCommandRecord[];
  logs: LogRecord[];
};

// ─── Default ──────────────────────────────────────────────────────────────────

const defaultData: LocalDbData = {
  events: [],
  accounts: [],
  bot_commands: [],
  logs: [],
};

// ─── Core R/W ─────────────────────────────────────────────────────────────────

// ─── Mutex simples para evitar race condition em paralelo ────────────────────
let writeLock: Promise<void> = Promise.resolve();

// Leitura interna sem lock — apenas para uso dentro do chain do mutex
async function readDbRaw(): Promise<LocalDbData> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    if (!raw || !raw.trim()) return { ...defaultData };
    const parsed = JSON.parse(raw) as LocalDbData;
    if (!parsed.logs) parsed.logs = [];
    return parsed;
  } catch (error: any) {
    if (error.code === "ENOENT") {
      await fs.writeFile(DATA_FILE, JSON.stringify(defaultData, null, 2), "utf-8");
      return { ...defaultData };
    }
    console.error("[DB] Erro ao ler banco de dados:", error.message);
    throw error;
  }
}

// Escrita interna sem lock — apenas para uso dentro do chain do mutex
async function writeDbRaw(data: LocalDbData): Promise<void> {
  try { await fs.copyFile(DATA_FILE, DATA_FILE + ".bak"); } catch {}
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// Leitura pública — aguarda escritas pendentes antes de ler
async function readDb(): Promise<LocalDbData> {
  await writeLock;
  return readDbRaw();
}

// Escrita pública serializada pelo mutex
async function writeDb(data: LocalDbData): Promise<void> {
  const doWrite = () => writeDbRaw(data);
  writeLock = writeLock.then(doWrite, doWrite);
  await writeLock;
}

// ─── Log helpers ─────────────────────────────────────────────────────────────

const MAX_LOGS_PER_EVENT = 200;

async function appendLog(eventId: string, level: LogLevel, message: string): Promise<void> {
  // Operação atômica: o read-modify-write inteiro é encadeado no mutex,
  // evitando race condition quando múltiplas chamadas acontecem em paralelo.
  const doAppend = async () => {
    const db = await readDbRaw();
    const newLog: LogRecord = {
      id: crypto.randomUUID(),
      event_id: eventId,
      level,
      message,
      ts: new Date().toISOString(),
    };
    db.logs.push(newLog);
    // Cap logs per event to avoid unbounded growth
    const eventLogs = db.logs.filter((l) => l.event_id === eventId);
    if (eventLogs.length > MAX_LOGS_PER_EVENT) {
      const toRemove = eventLogs.length - MAX_LOGS_PER_EVENT;
      const oldIds = eventLogs.slice(0, toRemove).map((l) => l.id);
      db.logs = db.logs.filter((l) => !oldIds.includes(l.id));
    }
    await writeDbRaw(db);
  };
  writeLock = writeLock.then(doAppend, doAppend);
  await writeLock;
}

async function getEventLogs(eventId: string, limit = 100): Promise<LogRecord[]> {
  const db = await readDb();
  return db.logs
    .filter((l) => l.event_id === eventId)
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
    .slice(-limit);
}

async function clearEventLogs(eventId: string): Promise<void> {
  const db = await readDb();
  db.logs = db.logs.filter((l) => l.event_id !== eventId);
  await writeDb(db);
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const localDb = {
  read: readDb,
  write: writeDb,
  appendLog,
  getEventLogs,
  clearEventLogs,
};
