/**
 * TicketMonitor — Console Intercept Mode (sem login)
 *
 * Abre um browser headless, navega direto para a página do evento
 * e intercepta o console.log do fcard-maps-ac.js que é emitido a cada ~30s.
 *
 * Quando a mensagem "Stadium - Done reading available tickets"
 * NÃO contiver "maximum booking null":
 *   1. Loga em tempo real no terminal
 *   2. Envia alerta no Telegram
 *   3. Aciona automaticamente o bot de compra (insere comando "start" no local-data.json)
 *
 * Uso: npx tsx src/bot/monitor.ts [eventId]
 * Exemplo: npx tsx src/bot/monitor.ts 37145
 */

import { config } from "dotenv";
import { resolve } from "path";
import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import axios from "axios";
import { localDb } from "../lib/local-db";

config({ path: resolve(process.cwd(), ".env") });

chromium.use(stealth());

// ─── Configuração ─────────────────────────────────────────────────────────────

const EVENT_ID = process.argv[2] ?? "37145";
const BASE_URL = "https://www.futebolcard.com";
const EVENT_URL = `${BASE_URL}/buy/sector?event=${EVENT_ID}`;

// Sinaliza ausência de ingressos
const EMPTY_SIGNATURE = "maximum booking null";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
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

function log(level: Level, msg: string) {
  const ts = new Date().toLocaleTimeString("pt-BR");
  console.log(`${C[level]}[${ts}] [${level.padEnd(7)}] ${ICONS[level]} ${msg}${R}`);
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(message: string): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    log("WARN", "Telegram não configurado.");
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
    });
    log("SUCCESS", "📱 Alerta enviado ao Telegram!");
  } catch (err: any) {
    log("ERROR", `Falha ao enviar Telegram: ${err.message}`);
  }
}

// ─── Aciona bot de compra ─────────────────────────────────────────────────────

async function triggerBuyBot(eventId: string): Promise<void> {
  log("BOT", "Acionando bot de compra...");
  try {
    const db = await localDb.read();

    // Verifica se o evento existe no banco
    const ev = db.events.find((e) => e.id === eventId);
    if (!ev) {
      log("WARN", `Evento ${eventId} não encontrado no local-data.json. Bot não acionado.`);
      log("WARN", "Certifique-se de ter cadastrado este evento no painel antes de monitorar.");
      return;
    }

    // Verifica se já há um comando start pendente (não processado)
    const alreadyPending = db.bot_commands.some(
      (c) => c.event_id === eventId && c.command === "start" && !c.processed_at
    );
    if (alreadyPending) {
      log("BOT", "Bot já possui comando start pendente. Nenhuma ação necessária.");
      return;
    }

    // Atualiza status do evento para "monitorando"
    const evIdx = db.events.findIndex((e) => e.id === eventId);
    if (evIdx !== -1) {
      db.events[evIdx].status = "monitorando";
    }

    // Insere o comando start
    db.bot_commands.push({
      id: crypto.randomUUID(),
      event_id: eventId,
      user_id: ev.user_id,
      command: "start",
      created_at: new Date().toISOString(),
      processed_at: null,
    });

    await localDb.write(db);
    log("SUCCESS", `🤖 Comando START enviado para o bot! Evento: ${ev.name ?? eventId}`);
    log("BOT", "O worker.ts processará este comando em até 3 segundos.");
  } catch (err: any) {
    log("ERROR", `Erro ao acionar bot: ${err.message}`);
  }
}

// ─── Monitor principal ────────────────────────────────────────────────────────

async function startMonitor() {
  log("INFO", `Iniciando browser (headless, stealth)...`);

  const userDataDir = resolve(process.cwd(), `chrome-monitor-${EVENT_ID}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await context.newPage();

  let alertSent = false;
  let botTriggered = false;
  let msgCount = 0;

  // ── Intercepta o console.log do site antes do carregamento ───────────────
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

    console.log   = function (...args: any[]) { relay(...args); return origLog.apply(this, args); };
    console.info  = function (...args: any[]) { relay(...args); return origInfo.apply(this, args); };
    console.debug = function (...args: any[]) { relay(...args); return origDebug.apply(this, args); };
    console.warn  = function (...args: any[]) { relay(...args); return origWarn.apply(this, args); };
  });

  // Função exposta: recebe mensagem do browser e age no Node.js
  await page.exposeFunction("__monitorRelay", async (text: string) => {
    msgCount++;
    const isAvailable = !text.toLowerCase().includes(EMPTY_SIGNATURE.toLowerCase());

    log("RAW", `[Console #${msgCount}] ${text}`);

    if (isAvailable) {
      log("ALERT", `🎟️  INGRESSO DISPONÍVEL! Resposta diferente do padrão vazio.`);

      if (!alertSent) {
        alertSent = true;

        // 1. Envia alerta Telegram
        const telegramMsg =
          `🚨 <b>INGRESSO DISPONÍVEL!</b>\n\n` +
          `🎟️ Evento: <code>${EVENT_ID}</code>\n` +
          `🔗 <a href="${EVENT_URL}">Ir para o evento</a>\n\n` +
          `📋 Mensagem do site:\n<code>${text.slice(0, 600)}</code>\n\n` +
          `🤖 Bot de compra acionado automaticamente!\n` +
          `⏰ ${new Date().toLocaleString("pt-BR")}`;

        await sendTelegram(telegramMsg);

        // 2. Aciona bot de compra automaticamente
        if (!botTriggered) {
          botTriggered = true;
          await triggerBuyBot(EVENT_ID);
        }
      }
    } else {
      log("INFO", `Sem ingressos (padrão vazio confirmado).`);

      // Reseta flags quando esgota novamente (para reacionar se voltar)
      if (alertSent) {
        alertSent = false;
        botTriggered = false;
        log("INFO", "Flags resetadas — monitorando novamente para próxima abertura de lote.");
      }
    }
  });

  // ── Fallback: intercepta a resposta de rede do endpoint de tickets ────────
  // O fcard-maps-ac.js chama /buy/get-available-tickets a cada 30s.
  // A resposta contém o texto "Stadium - Done reading available tickets".
  // Isso garante captura mesmo que o hook de console.log do init script
  // não pegue (ex: scripts carregados antes do hook).
  page.on("response", async (res) => {
    const url = res.url();
    if (!url.includes("get-available-tickets")) return;
    try {
      const body = await res.text().catch(() => "");
      if (!body.includes("Stadium") && !body.includes("reading available tickets")) return;
      const isAvailable = !body.toLowerCase().includes(EMPTY_SIGNATURE.toLowerCase());
      msgCount++;
      log("RAW", `[Network #${msgCount}] ${body.slice(0, 200)}`);
      if (isAvailable && !alertSent) {
        alertSent = true;
        const telegramMsg =
          `🚨 <b>INGRESSO DISPONÍVEL!</b>\n\n` +
          `🎟️ Evento: <code>${EVENT_ID}</code>\n` +
          `🔗 <a href="${EVENT_URL}">Ir para o evento</a>\n\n` +
          `📋 Resposta da API:\n<code>${body.slice(0, 600)}</code>\n\n` +
          `🤖 Bot de compra acionado automaticamente!\n` +
          `⏰ ${new Date().toLocaleString("pt-BR")}`;
        await sendTelegram(telegramMsg);
        if (!botTriggered) {
          botTriggered = true;
          await triggerBuyBot(EVENT_ID);
        }
      } else if (!isAvailable && alertSent) {
        alertSent = false;
        botTriggered = false;
        log("INFO", "Flags resetadas — monitorando novamente.");
      } else if (!isAvailable) {
        log("INFO", "Sem ingressos (confirmado via rede).");
      }
    } catch {}
  });

  // ── Navega direto para o evento (sem login) ──────────────────────────────
  log("INFO", `Navegando para: ${EVENT_URL}`);
  await page.goto(EVENT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2_000);

  log("SUCCESS", "🎯 Monitor ativo! Aguardando respostas da API e console logs...");
  log("INFO",    `O site consulta /buy/get-available-tickets a cada ~30s.`);
  log("INFO",    `Alerta disparado quando NÃO contiver: "${EMPTY_SIGNATURE}"`);
  log("INFO",    "Pressione Ctrl+C para encerrar.\n");

  // ── Heartbeat ────────────────────────────────────────────────────────────
  let tick = 0;
  setInterval(() => {
    tick++;
    log("INFO", `Heartbeat #${tick} — monitor ativo | Msgs: ${msgCount} | Alerta: ${alertSent ? "🔴 ATIVO" : "🟢 aguardando"}`);
  }, 60_000);

  // Mantém processo vivo
  await new Promise(() => {});
}

// ─── Entrada ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("\x1b[35m══════════════════════════════════════════════════════\x1b[0m");
  console.log("\x1b[35m🎟️  TicketMonitor — Console Intercept (sem login)\x1b[0m");
  console.log(`\x1b[36m   Evento  : ${EVENT_ID}\x1b[0m`);
  console.log(`\x1b[36m   URL     : ${EVENT_URL}\x1b[0m`);
  console.log(`\x1b[36m   Telegram: ${TELEGRAM_TOKEN ? "✅ configurado" : "❌ não configurado"}\x1b[0m`);
  console.log(`\x1b[36m   Auto-bot: ✅ acionado ao detectar ingresso\x1b[0m`);
  console.log("\x1b[35m══════════════════════════════════════════════════════\x1b[0m\n");

  await startMonitor();
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
