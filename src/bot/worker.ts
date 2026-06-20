/**
 * TicketBot Worker — Local Mode
 *
 * Reads commands from local-data.json and dispatches the Playwright bot.
 * Uses persistent browser strategy: bot stays on the event page and
 * intercepts the site's own 30-second availability polling cycle.
 */

import { config } from "dotenv";
import { resolve } from "path";
import { runBotPersistent, runTestLogin } from "./playwright";
import { decryptText } from "../lib/crypto.server";
import { localDb } from "../lib/local-db";
import type { LogLevel, EventRecord } from "../lib/local-db";

config({ path: resolve(process.cwd(), ".env") });

// ─── Active bot instances ─────────────────────────────────────────────────────
// Each running event gets a StopSignal. Setting stop=true cleanly terminates
// the persistent browser loop at the next update cycle check.
const activeLoops = new Map<string, { stop: boolean }>();

// ─── Logging ─────────────────────────────────────────────────────────────────

async function pushLog(eventId: string, level: LogLevel, message: string) {
  const ts = new Date().toLocaleTimeString("pt-BR");
  console.log(`[${ts}] [${level.toUpperCase().padEnd(7)}] ${eventId.slice(0, 8)}… ${message}`);
  await localDb.appendLog(eventId, level, message);
}

// ─── Resolve account credentials for an event ────────────────────────────────

async function resolveCredentials(ev: EventRecord): Promise<{ email: string; senha: string }> {
  const conf = ev.config as any;
  const db = await localDb.read();

  let email: string = conf?.email ?? "";
  let senhaEnc: string = conf?.senha_enc ?? "";

  // If account_id is set, fetch the account's encrypted password from the DB
  if (conf?.account_id) {
    const account = db.accounts.find((a) => a.id === conf.account_id);
    if (account) {
      email = account.email;
      senhaEnc = account.senha_enc;
    }
  }

  const senha = await decryptText(senhaEnc).catch(() => "");
  return { email, senha };
}

// ─── Bot loop for a single event ─────────────────────────────────────────────

async function runEventLoop(eventId: string) {
  const stopSignal = activeLoops.get(eventId);
  if (!stopSignal) return;

  // Limpa os logs antigos ao iniciar uma nova execução
  await localDb.clearEventLogs(eventId);

  await pushLog(eventId, "info", "🤖 Bot iniciado. Preparando sessão...");

  try {
    const db = await localDb.read();
    const ev = db.events.find((e) => e.id === eventId);

    if (!ev) {
      await pushLog(eventId, "error", "Evento não encontrado no banco de dados.");
      return;
    }

    const conf = ev.config as any;

    let accountsToRun = [];
    if (conf.account_id === "ALL") {
      if (db.accounts && db.accounts.length > 0) {
        accountsToRun = db.accounts;
      }
    } else if (conf.account_id) {
      const acc = db.accounts.find((a) => a.id === conf.account_id);
      if (acc) accountsToRun = [acc];
    } else {
      accountsToRun = [{ email: conf.email, senha_enc: conf.senha_enc }];
    }

    await pushLog(eventId, "info", `🚀 Iniciando fila: ${accountsToRun.length} conta(s) detectada(s)...`);

    while (!stopSignal.stop) {
      for (let i = 0; i < accountsToRun.length; i++) {
        if (stopSignal.stop) {
          await pushLog(eventId, "warn", "⏹ Loop de contas interrompido pelo usuário.");
          break;
        }

        const acc = accountsToRun[i];
        const senha = await decryptText(acc.senha_enc).catch(() => "");
        
        if (!acc.email || !senha) {
          await pushLog(eventId, "error", `⚠️ Credenciais inválidas para a conta ${acc.email || 'desconhecida'}. Pulando...`);
          continue;
        }

        await pushLog(eventId, "info", `==================================================`);
        await pushLog(eventId, "info", `[CONTA ${i + 1}/${accountsToRun.length}] Iniciando automação para ${acc.email}...`);

        try {
          const success = await runBotPersistent(
            {
              id: ev.id,
              login_url: ev.login_url,
              url: ev.url,
              config: {
                ...conf,
                email: acc.email,
                senha_enc: acc.senha_enc,
                headless: conf?.headless !== false,
              },
            },
            senha,
            (level, msg) => pushLog(eventId, level, msg),
            stopSignal,
          );

          if (success) {
            await pushLog(eventId, "success", `✅ Fim do processamento para ${acc.email}. Ingresso garantido!`);
          } else {
            await pushLog(eventId, "warn", `⚠️ Fim do processing para ${acc.email}. Nenhum ingresso adicionado.`);
          }
        } catch (err: any) {
          await pushLog(eventId, "error", `❌ Erro na conta ${acc.email}: ${err.message}. Pulando para a próxima...`);
        }
      }

      if (stopSignal.stop) break;

      if (!conf.loop_continuo) {
        break;
      }

      await pushLog(eventId, "info", "🔄 Ciclo concluído. 'Loop Contínuo' ativado, recomeçando a fila de contas em 5 segundos...");
      await new Promise(r => setTimeout(r, 5000));
    }

    // Finalizou todas as contas
    const freshDb = await localDb.read();
    const idx = freshDb.events.findIndex((e) => e.id === eventId);
    if (idx !== -1) {
      freshDb.events[idx].status = "concluido";
      await localDb.write(freshDb);
    }
    await pushLog(eventId, "success", "🏁 Todas as contas foram processadas com sucesso!");

  } catch (err: any) {
    await pushLog(eventId, "error", `Erro fatal no bot: ${err.message}`);
  } finally {
    activeLoops.delete(eventId);
  }
}

// ─── Command processor ────────────────────────────────────────────────────────

async function processCommands() {
  const db = await localDb.read();

  const pending = db.bot_commands
    .filter((c) => !c.processed_at)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(0, 10);

  if (pending.length === 0) return;

  for (const cmd of pending) {
    // Mark as processed immediately to avoid double-processing
    const freshDb = await localDb.read();
    const cmdIdx = freshDb.bot_commands.findIndex((c) => c.id === cmd.id);
    if (cmdIdx !== -1) {
      freshDb.bot_commands[cmdIdx].processed_at = new Date().toISOString();
      await localDb.write(freshDb);
    }

    console.log(`\n📥 Comando: [${cmd.command.toUpperCase()}] → evento ${cmd.event_id.slice(0, 8)}…`);

    if (cmd.command === "start") {
      if (activeLoops.has(cmd.event_id)) {
        console.log("   ↳ Bot já ativo para este evento.");
        continue;
      }
      const stopSignal = { stop: false };
      activeLoops.set(cmd.event_id, stopSignal);
      runEventLoop(cmd.event_id).catch((err) =>
        console.error(`[ERRO] Loop do bot: ${err.message}`),
      );
    }

    if (cmd.command === "stop") {
      const stopSignal = activeLoops.get(cmd.event_id);
      if (stopSignal) {
        stopSignal.stop = true;
        await pushLog(cmd.event_id, "warn", "⏹ Bot parado pelo usuário.");
      } else {
        console.log("   ↳ Nenhum loop ativo para este evento.");
      }
    }

    if (cmd.command === "test_login") {
      const freshDb = await localDb.read();
      const ev = freshDb.events.find((e) => e.id === cmd.event_id);
      if (!ev) {
        await pushLog(cmd.event_id, "error", "Evento não encontrado.");
        continue;
      }

      const { email, senha } = await resolveCredentials(ev);

      runTestLogin(
        {
          id: ev.id,
          login_url: ev.login_url,
          url: ev.url,
          config: { email, headless: (ev.config as any)?.headless },
        },
        senha,
        (level, msg) => pushLog(cmd.event_id, level, msg),
      ).catch((err) => pushLog(cmd.event_id, "error", `Erro no teste: ${err.message}`));
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log("🚀 TicketBot Worker iniciado (Modo Local — Interceptação de Ciclo)");
console.log("   Estratégia: browser persistente + intercepção do fcard-maps-ac.js");
console.log("   Aguardando comandos...\n");

setInterval(async () => {
  try {
    await processCommands();
  } catch (err: any) {
    console.error("[ERRO] Loop de comandos:", err.message);
  }
}, 3000);
