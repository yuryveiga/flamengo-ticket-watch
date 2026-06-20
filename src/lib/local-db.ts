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
  command: "start" | "stop" | "test_login";
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

async function readDb(): Promise<LocalDbData> {
  try {
    const data = await fs.readFile(DATA_FILE, "utf-8");
    const parsed = JSON.parse(data) as LocalDbData;
    // Migrate old data that may not have logs field
    if (!parsed.logs) parsed.logs = [];
    return parsed;
  } catch (error: any) {
    if (error.code === "ENOENT") {
      await fs.writeFile(DATA_FILE, JSON.stringify(defaultData, null, 2), "utf-8");
      return { ...defaultData };
    }
    throw error;
  }
}

async function writeDb(data: LocalDbData): Promise<void> {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ─── Log helpers ─────────────────────────────────────────────────────────────

const MAX_LOGS_PER_EVENT = 200;

async function appendLog(eventId: string, level: LogLevel, message: string): Promise<void> {
  const db = await readDb();
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
  await writeDb(db);
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
