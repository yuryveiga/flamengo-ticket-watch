/**
 * TicketMonitor — Multi-Event Console Intercept (sem login)
 *
 * Lê automaticamente todos os eventos cadastrados no local-data.json,
 * abre uma aba por evento e monitora cada um em paralelo.
 *
 * Quando detecta ingresso disponível:
 *   1. Loga no terminal em tempo real
 *   2. Loga no dashboard do painel (localDb)
 *   3. Envia alerta no Telegram
 *   4. Aciona automaticamente o bot de compra
 *
 * Uso: npx tsx src/bot/monitor.ts
 */

import { config } from "dotenv";
import { resolve } from "path";
import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import axios from "axios";
import { localDb } from "../lib/local-db";
import type { EventRecord } from "../lib/local-db";

config({ path: resolve(process.cwd(), ".env") });

chromium.use(stealth());

// ─── Constantes ───────────────────────────────────────────────────────────────

const BASE_URL        = "https://www.futebolcard.com";
const EMPTY_SIGNATURE = "maximum booking null";
const TELEGRAM_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─── Logging colorido ─────────────────────────────────────────────────────────

type Level = "INFO" | "WARN" | "SUCCESS" | "ERROR" | "ALERT" | "RAW" | "BOT";

const C: Record<Level, string> = {
  INFO:    "\x1b[36m",
  WARN:    "\x1b[33m",
  SUCCESS: "\x1b[32m",
  ERROR:   "\x1b[31m",
  ALERT:   "\x1b[35m",
  RAW:     "\x1b[90m",
  BOT:     "\x1b[94m",
};
const R = "\x1b[0m";
const ICONS: Record<Level, string> = {
  INFO:    "ℹ️ ",
  WARN:    "⚠️ ",
  SUCCESS: "✅",
  ERROR:   "❌",
  ALERT:   "🚨",
  RAW:     "📋",
  BOT:     "🤖",
};

function log(level: Level, eventLabel: string, msg: string) {
  const ts = new Date().toLocaleTimeString("pt-BR");
  const label = eventLabel ? `[${eventLabel}] ` : "";
  console.log(`${C[level]}[${ts}] [${level.padEnd(7)}] ${ICONS[level]} ${label}${msg}${R}`);
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(message: string): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
    });
  } catch {}
}

// ─── Dashboard log ────────────────────────────────────────────────────────────

async function dashLog(
  eventUuid: string,
  level: "info" | "warn" | "success" | "error" | "api",
  msg: string
) {
  try { await localDb.appendLog(eventUuid, level, msg); } catch {}
}

// ─── Extrai o ID numérico da FutebolCard a partir da URL do evento ────────────

function extractFcardId(url: string): string | null {
  const m = url.match(/event=(\d+)/);
  return m ? m[1] : null;
}

// ─── Aciona bot de compra ─────────────────────────────────────────────────────

async function triggerBuyBot(ev: EventRecord, label: string): Promise<void> {
  log("BOT", label, "Acionando bot de compra...");
  try {
    const db = await localDb.read();

    const alreadyPending = db.bot_commands.some(
      (c) => c.event_id === ev.id && c.command === "start" && !c.processed_at
    );
    if (alreadyPending) {
      log("BOT", label, "Comando start já pendente. Nenhuma ação necessária.");
      return;
    }

    const evIdx = db.events.findIndex((e) => e.id === ev.id);
    if (evIdx !== -1) db.events[evIdx].status = "monitorando";

    db.bot_commands.push({
      id: crypto.randomUUID(),
      event_id: ev.id,
      user_id: ev.user_id,
      command: "start",
      created_at: new Date().toISOString(),
      processed_at: null,
    });

    await localDb.write(db);
    log("SUCCESS", label, "🤖 Comando START enviado ao bot de compra!");
  } catch (err: any) {
    log("ERROR", label, `Erro ao acionar bot: ${err.message}`);
  }
}

// ─── Monitor de um evento (uma aba) ──────────────────────────────────────────

async function monitorEvent(
  ev: EventRecord,
  fcardId: string,
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>
) {
  const eventUrl = `${BASE_URL}/buy/sector?event=${fcardId}`;
  const label    = ev.name ?? fcardId;

  let alertSent    = false;
  let botTriggered = false;
  let msgCount     = 0;

  const page = await context.newPage();

  // ── Hook de console.log ──────────────────────────────────────────────────
  await page.addInitScript(() => {
    const origLog   = console.log;
    const origInfo  = console.info;
    const origDebug = console.debug;
    const origWarn  = console.warn;

    function relay(...args: any[]) {
      const text = args.map((a) => String(a)).join(" ");
      if (
        text.includes("reading available tickets") ||
        text.includes("Stadium") ||
        text.includes("available ticket")
      ) {
        (window as any).__monitorRelay(text).catch(() => {});
      }
    }

    console.log   = function (...a: any[]) { relay(...a); return origLog.apply(this, a); };
    console.info  = function (...a: any[]) { relay(...a); return origInfo.apply(this, a); };
    console.debug = function (...a: any[]) { relay(...a); return origDebug.apply(this, a); };
    console.warn  = function (...a: any[]) { relay(...a); return origWarn.apply(this, a); };
  });

  // ── Relay do browser → Node.js ───────────────────────────────────────────
  await page.exposeFunction("__monitorRelay", async (text: string) => {
    msgCount++;
    const isAvailable = !text.toLowerCase().includes(EMPTY_SIGNATURE.toLowerCase());
    log("RAW", label, `[Console #${msgCount}] ${text}`);
    await handleDetection(isAvailable, text, ev, fcardId, eventUrl, label);
  });

  // ── Fallback: interceptação de rede ─────────────────────────────────────
  page.on("response", async (res) => {
    if (!res.url().includes("get-available-tickets")) return;
    try {
      const body = await res.text().catch(() => "");
      if (!body.includes("Stadium") && !body.includes("reading available tickets")) return;
      const isAvailable = !body.toLowerCase().includes(EMPTY_SIGNATURE.toLowerCase());
      msgCount++;
      log("RAW", label, `[Network #${msgCount}] ${body.slice(0, 200)}`);
      await handleDetection(isAvailable, body, ev, fcardId, eventUrl, label);
    } catch {}
  });

  // ── Lógica de detecção centralizada ─────────────────────────────────────
  async function handleDetection(
    isAvailable: boolean,
    responseText: string,
    ev: EventRecord,
    fcardId: string,
    eventUrl: string,
    label: string
  ) {
    if (isAvailable) {
      log("ALERT", label, "🎟️  INGRESSO DISPONÍVEL!");
      await dashLog(ev.id, "success", `🚨 INGRESSO DISPONÍVEL! Monitor detectou: ${responseText.slice(0, 200)}`);

      if (!alertSent) {
        alertSent = true;

        const telegramMsg =
          `🚨 <b>INGRESSO DISPONÍVEL!</b>\n\n` +
          `🎟️ Evento: <b>${label}</b> (<code>${fcardId}</code>)\n` +
          `🔗 <a href="${eventUrl}">Ir para o evento</a>\n\n` +
          `📋 Resposta:\n<code>${responseText.slice(0, 500)}</code>\n\n` +
          `🤖 Bot de compra acionado automaticamente!\n` +
          `⏰ ${new Date().toLocaleString("pt-BR")}`;

        await sendTelegram(telegramMsg);
        await dashLog(ev.id, "info", "📱 Alerta enviado ao Telegram.");
        log("SUCCESS", label, "📱 Alerta enviado ao Telegram!");

        if (!botTriggered) {
          botTriggered = true;
          await triggerBuyBot(ev, label);
          await dashLog(ev.id, "info", "🤖 Comando START enviado ao bot de compra pelo monitor.");
        }
      }
    } else {
      log("INFO", label, `Sem ingressos (check #${msgCount}).`);
      
      // Log no dashboard a cada 10 checks (~5 minutos, considerando consultas a cada 30s)
      if (msgCount === 1 || msgCount % 10 === 0) {
        await dashLog(ev.id, "info", `🔍 Monitor (a cada 5min): ${responseText.slice(0, 250).trim()}`);
      }

      if (alertSent) {
        alertSent    = false;
        botTriggered = false;
        log("INFO", label, "Flags resetadas — monitorando novamente.");
      }
    }
  }

  // ── Navega para o evento ─────────────────────────────────────────────────
  log("INFO", label, `Navegando para: ${eventUrl}`);
  await page.goto(eventUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2_000);

  log("SUCCESS", label, "🎯 Monitor ativo! Aguardando atualizações a cada ~30s...");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Lê todos os eventos do banco
  const db = await localDb.read();
  const events = db.events ?? [];

  if (events.length === 0) {
    console.error("❌ Nenhum evento cadastrado no local-data.json. Cadastre um evento no painel.");
    process.exit(1);
  }

  // Filtra eventos com URL válida
  const validEvents = events
    .map((ev) => ({ ev, fcardId: extractFcardId(ev.url ?? "") }))
    .filter((x): x is { ev: EventRecord; fcardId: string } => x.fcardId !== null);

  if (validEvents.length === 0) {
    console.error("❌ Nenhum evento com URL válida encontrado.");
    process.exit(1);
  }

  console.log("\x1b[35m══════════════════════════════════════════════════════\x1b[0m");
  console.log("\x1b[35m🎟️  TicketMonitor — Multi-Evento (sem login)\x1b[0m");
  console.log(`\x1b[36m   Eventos  : ${validEvents.length} encontrado(s)\x1b[0m`);
  validEvents.forEach(({ ev, fcardId }) =>
    console.log(`\x1b[36m     • ${ev.name ?? fcardId} (event=${fcardId})\x1b[0m`)
  );
  console.log(`\x1b[36m   Telegram : ${TELEGRAM_TOKEN ? "✅ configurado" : "❌ não configurado"}\x1b[0m`);
  console.log(`\x1b[36m   Auto-bot : ✅ acionado ao detectar ingresso\x1b[0m`);
  console.log("\x1b[35m══════════════════════════════════════════════════════\x1b[0m\n");

  // Abre um único browser com uma aba por evento
  const userDataDir = resolve(process.cwd(), "chrome-monitor-multi");
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  // Inicia o monitor de cada evento em paralelo
  await Promise.all(
    validEvents.map(({ ev, fcardId }) => monitorEvent(ev, fcardId, context))
  );

  // Heartbeat global
  let tick = 0;
  setInterval(() => {
    tick++;
    console.log(
      `\x1b[36m[${new Date().toLocaleTimeString("pt-BR")}] Heartbeat #${tick} — ${validEvents.length} evento(s) monitorado(s)\x1b[0m`
    );
  }, 60_000);

  // Mantém processo vivo
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
