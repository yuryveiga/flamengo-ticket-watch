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
    let isAvailable = !text.toLowerCase().includes(EMPTY_SIGNATURE.toLowerCase());
    
    // Fallback: se o log diz que não tem, vamos verificar no DOM para ter certeza
    // (Útil porque o site às vezes loga 'maximum booking null' mesmo com ingresso)
    if (!isAvailable) {
      const hasSectors = await page.evaluate(() => {
        const sectors = document.querySelectorAll("h4.match_sector-name, button.btn-comprar, .match_sector");
        return sectors.length > 0;
      }).catch(() => false);
      if (hasSectors) {
        isAvailable = true;
        text = text + " (Tickets detectados no DOM!)";
      }
    }

    log("RAW", label, `[Console #${msgCount}] ${text}`);
    // Loga no dashboard o raw console output para o usuário
    await dashLog(ev.id, "info", `🔍 Resposta do Servidor/Console: ${text.slice(0, 200)}`);

    await handleDetection(isAvailable, text, ev, fcardId, eventUrl, label);
  });

  // ── Fallback: interceptação de rede ─────────────────────────────────────
  page.on("response", async (res) => {
    const type = res.request().resourceType();
    if (type !== "fetch" && type !== "xhr") return;
    
    try {
      const url = res.url();
      const body = await res.text().catch(() => "");
      // Se a resposta for vazia ou for só HTML, ignorar
      if (!body || body.startsWith("<")) return;

      // Se parece resposta de checagem do BD para detecção
      if (body.includes("Stadium") || body.includes("reading available tickets") || body.includes("maximum booking null") || url.includes("status") || body.includes("available")) {
        let isAvailable = !body.toLowerCase().includes(EMPTY_SIGNATURE.toLowerCase()) && !body.toLowerCase().includes("maximum booking null");
        
        if (!isAvailable) {
          const hasSectors = await page.evaluate(() => {
            const sectors = document.querySelectorAll("h4.match_sector-name, button.btn-comprar, .match_sector");
            return sectors.length > 0;
          }).catch(() => false);
          if (hasSectors) {
            isAvailable = true;
          }
        }

        msgCount++;
        log("RAW", label, `[Network #${msgCount}] ${body.slice(0, 200)}`);
        
        // Passa para detecção
        await handleDetection(isAvailable, body, ev, fcardId, eventUrl, label);
      }
    } catch {}
  });

  // ── Lógica de detecção centralizada ─────────────────────────────────────
  let lastActivity = Date.now();

  const handleDetection = async (isAvailable: boolean, responseText: string, ev: any, fcardId: any, eventUrl: string, label: string) => {
    lastActivity = Date.now();
    
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
      
      // Log no dashboard a cada 2 checks (~1 minuto) para mostrar a resposta do servidor minuto a minuto
      if (msgCount === 1 || msgCount % 2 === 0) {
        await dashLog(ev.id, "info", `🔍 Resposta do BD/Servidor: ${responseText.slice(0, 250).trim()}`);
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

  // ── Polling Ativo (Minuto a Minuto) ──────────────────────────────────────
  const hbInterval = setInterval(async () => {
    try {
      const now = Date.now();
      const timeSinceLastActivity = now - lastActivity;
      
      // Se estamos há mais de 2 minutos sem resposta, fecha a aba e recomeça do zero
      if (timeSinceLastActivity > 120_000) {
        await dashLog(ev.id, "wait", `⏱️ Heartbeat: Sem contato há >2m. Fechando aba e recomeçando do zero...`);
        clearInterval(hbInterval);
        await page.close().catch(() => {});
        // Reinicia o monitoramento deste evento
        setTimeout(() => monitorEvent(ev, fcardId, context).catch(console.error), 2000);
        return;
      }

      await dashLog(ev.id, "wait", `⏱️ Heartbeat 1m: Consultando BD do site...`);
      await page.evaluate(() => {
        if (typeof (window as any).onFcardUpdate === "function") {
          (window as any).onFcardUpdate();
        } else {
          location.reload();
        }
      });
    } catch {}
  }, 60_000);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // IDs de eventos com aba já aberta — evita duplicatas
  const activeIds = new Set<string>();

  // Valida que existe ao menos 1 evento cadastrado na inicialização
  const dbInit = await localDb.read();
  if ((dbInit.events ?? []).length === 0) {
    console.error("❌ Nenhum evento cadastrado no local-data.json. Cadastre um evento no painel.");
    process.exit(1);
  }

  // Browser compartilhado — uma aba por evento
  const userDataDir = resolve(process.cwd(), "chrome-monitor-multi");
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  // ── Sincronização dinâmica ────────────────────────────────────────────────
  // Relê o local-data.json e abre nova aba para qualquer evento ainda não monitorado.
  async function syncEvents() {
    let db;
    try { db = await localDb.read(); } catch { return; }

    const novos = (db.events ?? [])
      .map((ev) => ({ ev, fcardId: extractFcardId(ev.url ?? "") }))
      .filter((x): x is { ev: EventRecord; fcardId: string } =>
        x.fcardId !== null && !activeIds.has(x.ev.id)
      );

    for (const { ev, fcardId } of novos) {
      activeIds.add(ev.id);
      const label = ev.name ?? fcardId;
      console.log(
        `\x1b[35m[${new Date().toLocaleTimeString("pt-BR")}] ➕ Novo evento detectado: ${label} (event=${fcardId})\x1b[0m`
      );
      monitorEvent(ev, fcardId, context).catch((err) => {
        console.error(`[Monitor] Erro em ${label}:`, err.message);
        activeIds.delete(ev.id); // permite tentar novamente no próximo ciclo
      });
    }
  }

  // Sync inicial
  await syncEvents();

  // Banner
  const dbNow = await localDb.read();
  console.log("\x1b[35m══════════════════════════════════════════════════════\x1b[0m");
  console.log("\x1b[35m🎟️  TicketMonitor — Multi-Evento (sem login)\x1b[0m");
  console.log(`\x1b[36m   Eventos  : ${activeIds.size} monitorado(s)\x1b[0m`);
  (dbNow.events ?? []).forEach((ev) => {
    const fcardId = extractFcardId(ev.url ?? "");
    if (fcardId) console.log(`\x1b[36m     • ${ev.name ?? fcardId} (event=${fcardId})\x1b[0m`);
  });
  console.log(`\x1b[36m   Telegram : ${TELEGRAM_TOKEN ? "✅ configurado" : "❌ não configurado"}\x1b[0m`);
  console.log(`\x1b[36m   Auto-bot : ✅ acionado ao detectar ingresso\x1b[0m`);
  console.log(`\x1b[36m   Hot-reload: ✅ detecta novos eventos a cada 30s\x1b[0m`);
  console.log("\x1b[35m══════════════════════════════════════════════════════\x1b[0m\n");

  // Sync periódico a cada 30s
  setInterval(syncEvents, 30_000);

  // Heartbeat
  let tick = 0;
  setInterval(() => {
    tick++;
    console.log(
      `\x1b[36m[${new Date().toLocaleTimeString("pt-BR")}] Heartbeat #${tick} — ${activeIds.size} evento(s) monitorado(s)\x1b[0m`
    );
  }, 60_000);

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
