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
import { decryptText, encryptText } from "../lib/crypto.server";
import { localDb } from "../lib/local-db";
import type { LogLevel, EventRecord } from "../lib/local-db";

config({ path: resolve(process.cwd(), ".env") });

// ─── Limpeza de Cache ──────────────────────────────────────────────────────────
// O usuário solicitou que o cache do browser seja limpo sempre que o bot iniciar.
import * as fs from "fs";
try {
  const rootDir = process.cwd();
  const files = fs.readdirSync(rootDir);
  for (const file of files) {
    if (file.startsWith("chrome-bot-profile-")) {
      const fullPath = resolve(rootDir, file);
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
  }
  console.log("🧹 Cache do browser limpo com sucesso!");
} catch (err) {
  console.error("⚠️ Erro ao limpar cache do browser:", err);
}

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

  // Zera a contagem de ingressos garantidos para este evento
  try {
    const fs = require("fs");
    const path = require("path");
    const statsFile = path.resolve(process.cwd(), "tickets-stats.json");
    let stats: any = {};
    if (fs.existsSync(statsFile)) {
      stats = JSON.parse(fs.readFileSync(statsFile, "utf8"));
    }
    stats[eventId] = {};
    fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
  } catch (err) {}

  await pushLog(eventId, "info", "🤖 Bot iniciado. Preparando sessão...");

  try {
    const db = await localDb.read();
    const ev = db.events.find((e) => e.id === eventId);

    if (!ev) {
      await pushLog(eventId, "error", "Evento não encontrado no banco de dados.");
      return;
    }

    let rodada = 1;
    let running = true;

    await localDb.updateEventStats(eventId, { started_at: Date.now(), setAttempts: 0 });

    do {
      // ── HOT RELOAD CONFIG: lê o banco a cada rodada ──
      const dbFresh = await localDb.read();
      const evFresh = dbFresh.events.find((e) => e.id === eventId);
      if (!evFresh || evFresh.status !== "monitorando") {
        break; // Evento foi removido ou pausado
      }
      const conf = evFresh.config as any;

      let accountsToRun: any[] = [];
      if (conf.account_id === "ALL") {
        if (dbFresh.accounts && dbFresh.accounts.length > 0) {
          accountsToRun = dbFresh.accounts;
        }
      } else if (conf.account_id) {
        const acc = dbFresh.accounts.find((a) => a.id === conf.account_id);
        if (acc) accountsToRun = [acc];
      } else {
        accountsToRun = [{ email: conf.email, senha_enc: conf.senha_enc }];
      }

      if (conf.loop_continuo) {
        await pushLog(
          eventId,
          "info",
          `🚀 Iniciando rodada contínua #${rodada} para fila de ${accountsToRun.length} conta(s)...`,
        );
      } else {
        await pushLog(
          eventId,
          "info",
          `🚀 Iniciando fila: ${accountsToRun.length} conta(s) detectada(s)...`,
        );
      }

      // ── Melhoria 8: Janela de Horário ──────────────────────────────────────────
      if (conf.timer_start_time || conf.timer_end_time) {
        const now = new Date();
        const currentTotalMin = now.getHours() * 60 + now.getMinutes();

        let startMin = 0;
        if (conf.timer_start_time) {
          const [h, m] = conf.timer_start_time.split(":").map(Number);
          startMin = h * 60 + m;
        }

        let endMin = 24 * 60;
        if (conf.timer_end_time) {
          const [h, m] = conf.timer_end_time.split(":").map(Number);
          endMin = h * 60 + m;
        }

        let isWithinWindow = false;
        if (startMin <= endMin) {
          isWithinWindow = currentTotalMin >= startMin && currentTotalMin < endMin;
        } else {
          isWithinWindow = currentTotalMin >= startMin || currentTotalMin < endMin;
        }

        if (!isWithinWindow) {
          await pushLog(
            eventId,
            "info",
            `🕒 Fora da janela de horário configurada (${conf.timer_start_time || "00:00"} às ${conf.timer_end_time || "23:59"}). Dormindo por 1 min...`,
          );
          for (let w = 0; w < 60; w++) {
            if (stopSignal.stop) {
              running = false;
              break;
            }
            await new Promise((r) => setTimeout(r, 1000));
          }
          if (stopSignal.stop) break;
          continue; // Pula o processamento das contas nesta rodada
        }
      }

      // ── Melhoria 8: Duração Máxima (Absoluta) ──────────────────────────────────
      if (conf.timer_duration_minutes) {
        const freshDb = await localDb.readRaw();
        const evFresh = freshDb.events.find((e) => e.id === eventId);
        if (evFresh?.stats?.started_at) {
          const runningMs = Date.now() - evFresh.stats.started_at;
          if (runningMs > conf.timer_duration_minutes * 60000) {
            await pushLog(
              eventId,
              "warn",
              `⏳ Duração máxima atingida (${conf.timer_duration_minutes} min). Encerrando o evento permanentemente.`,
            );
            running = false;
            break;
          }
        }
      }

      for (let i = 0; i < accountsToRun.length; i++) {
        if (stopSignal.stop) {
          await pushLog(eventId, "warn", "⏹ Loop de contas interrompido pelo usuário.");
          break;
        }

        const acc = accountsToRun[i];
        const senha = await decryptText(acc.senha_enc).catch(() => "");

        if (!acc.email || !senha) {
          await pushLog(
            eventId,
            "error",
            `⚠️ Credenciais inválidas para a conta ${acc.email || "desconhecida"}. Pulando...`,
          );
          continue;
        }

        await pushLog(eventId, "info", `==================================================`);
        await pushLog(
          eventId,
          "info",
          `[CONTA ${i + 1}/${accountsToRun.length}] Iniciando automação para ${acc.email}...`,
        );

        let success = false;
        // O usuário pediu: "tente 3x (feito no playwright), feche, abra novamente e tente mais 3x"
        // E também: se der erro (timeout/crash), fechar o browser e tentar de novo no próximo ciclo.
        for (let cycle = 1; cycle <= 2; cycle++) {
          if (stopSignal.stop) break;

          if (cycle > 1) {
            await pushLog(
              eventId,
              "info",
              `🔄 Reabrindo browser para nova bateria de tentativas (${cycle}/2)...`,
            );
          }

          try {
            success = await runBotPersistent(
              {
                id: evFresh.id,
                login_url: evFresh.login_url,
                url: evFresh.url,
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

            if (success === true) break; // Conseguiu ingresso, não precisa do ciclo 2

            if (success === "out_of_window") {
              break;
            }

            // Tratamento de loop pause request
            if (success === "pause_requested") {
              const pauseMins = conf.timer_loop_pause_minutes || 15;
              await pushLog(
                eventId,
                "info",
                `☕ Pausa programada de ${pauseMins} min para descanso do bot...`,
              );
              for (let w = 0; w < pauseMins * 60; w++) {
                if (stopSignal.stop) break;
                await new Promise((r) => setTimeout(r, 1000));
              }
              // Após a pausa, tentamos de novo? Sim, reinicia o cycle
              cycle--;
              continue;
            }
          } catch (err: any) {
            if (cycle < 2) {
              await pushLog(
                eventId,
                "error",
                `❌ Erro na conta ${acc.email}: ${err.message}. Fechando e tentando novamente...`,
              );
            } else {
              await pushLog(
                eventId,
                "error",
                `❌ Erro na conta ${acc.email}: ${err.message}. Pulando para a próxima...`,
              );
            }
          }
        }

        if (success === "out_of_window") {
          break; // break accountsToRun loop to re-evaluate window at the top
        }

        if (success === true) {
          await pushLog(
            eventId,
            "success",
            `✅ Fim do processamento para ${acc.email}. Ingresso garantido!`,
          );
        } else {
          await pushLog(
            eventId,
            "warn",
            `⚠️ Fim do processamento para ${acc.email} após tentativas. Passando para a próxima...`,
          );
        }
      }

      if (stopSignal.stop) {
        break;
      }

      if (running && conf.loop_continuo && !stopSignal.stop) {
        rodada++;
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        running = false;
      }
    } while (running && !stopSignal.stop);

    // Finalizou todas as contas — atualiza status com segurança
    const freshDb = await localDb.read();
    if (freshDb.events && freshDb.events.length > 0) {
      const idx = freshDb.events.findIndex((e) => e.id === eventId);
      if (idx !== -1) {
        freshDb.events[idx].status = "pausado";
        await localDb.write(freshDb);
      }
    }
    await pushLog(eventId, "success", "🏁 Todas as contas foram processadas com sucesso!");

    // Imprime resumo final a partir de bot-stats.json
    try {
      const fs = require("fs");
      const path = require("path");
      const statsFile = path.resolve(process.cwd(), "tickets-stats.json");
      if (fs.existsSync(statsFile)) {
        const stats = JSON.parse(fs.readFileSync(statsFile, "utf8"));
        if (stats[eventId]) {
          await pushLog(eventId, "info", "--------------------------------------------------");
          await pushLog(eventId, "info", "📊 RESUMO FINAL DE INGRESSOS DESTE EVENTO POR CONTA:");
          for (const [acc, qtd] of Object.entries(stats[eventId])) {
            await pushLog(eventId, "success", `   👤 ${acc}: ${qtd} ingressos garantidos`);
          }
          await pushLog(eventId, "info", "--------------------------------------------------");
        }
      }
    } catch (err) {}
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

    console.log(
      `\n📥 Comando: [${cmd.command.toUpperCase()}] → evento ${cmd.event_id.slice(0, 8)}…`,
    );

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

    if (cmd.command === "test_all_logins") {
      const freshDb = await localDb.read();
      const userAccounts = freshDb.accounts.filter((a) => a.user_id === cmd.user_id);

      if (userAccounts.length === 0) {
        await pushLog("test-all-logins", "warn", "Nenhuma conta encontrada para testar.");
        continue;
      }

      // Rodar testes sequencialmente, sem await para não travar o loop de comandos?
      // Ou criar uma promise auto-executável
      (async () => {
        await pushLog(
          "test-all-logins",
          "info",
          "==================================================",
        );
        await pushLog(
          "test-all-logins",
          "info",
          `Iniciando teste em massa de ${userAccounts.length} contas...`,
        );

        for (let i = 0; i < userAccounts.length; i++) {
          const acc = userAccounts[i];
          const senha = await decryptText(acc.senha_enc).catch(() => "");

          await pushLog("test-all-logins", "info", `---`);
          await pushLog(
            "test-all-logins",
            "info",
            `[CONTA ${i + 1}/${userAccounts.length}] Testando ${acc.email}...`,
          );

          try {
            await runTestLogin(
              {
                id: "test-all-logins", // dummy event id
                login_url: "https://www.futebolcard.com/login",
                url: "https://www.futebolcard.com/information?event=37218", // dummy url
                config: { email: acc.email, headless: true },
              },
              senha,
              (level, msg) => pushLog("test-all-logins", level, msg),
            );
          } catch (err: any) {
            await pushLog(
              "test-all-logins",
              "error",
              `Erro no teste da conta ${acc.email}: ${err.message}`,
            );
          }
        }

        await pushLog(
          "test-all-logins",
          "success",
          "==================================================",
        );
        await pushLog(
          "test-all-logins",
          "success",
          "🏁 Teste em massa concluído para todas as contas!",
        );
      })();
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

let telegramLastUpdateId = 0;

async function sendTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const https = await import("https");
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" });
    await new Promise<void>((resolve, reject) => {
      const req = https.request(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          res.on("end", resolve);
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  } catch (err: any) {
    console.error("[TELEGRAM] Erro ao enviar mensagem:", err.message);
  }
}

// ─── Wizard de sessão por chat ────────────────────────────────────────────────
// Guarda em que etapa do wizard cada chat está.
type WizardStep =
  | "novo_url"
  | "novo_nome"
  | "novo_setor"
  | "novo_qtd"
  | "editar_menu"
  | "editar_setor"
  | "editar_qtd"
  | "editar_nome"
  | "conta_label"
  | "conta_email"
  | "conta_senha"
  | "editar_conta_pick"
  | "editar_conta_menu"
  | "editar_conta_label"
  | "editar_conta_email"
  | "editar_conta_senha"
  | "apagar_conta_pick"
  | "apagar_conta_confirm";

interface WizardSession {
  step: WizardStep;
  data: Record<string, any>;
}
const wizardSessions = new Map<string, WizardSession>();

async function processTelegramCommands() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const https = await import("https");
    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${telegramLastUpdateId + 1}&timeout=0`;
    const data = await new Promise<any>((res, rej) => {
      https
        .get(url, (r) => {
          let raw = "";
          r.on("data", (chunk) => (raw += chunk));
          r.on("end", () => {
            try {
              res(JSON.parse(raw));
            } catch {
              rej(new Error("JSON inválido"));
            }
          });
        })
        .on("error", rej);
    });

    if (!data.ok || !data.result?.length) return;

    for (const update of data.result) {
      telegramLastUpdateId = update.update_id;
      const msg = update.message || update.edited_message;
      if (!msg?.text) continue;
      // Segurança: só aceita do seu chat
      if (String(msg.chat.id) !== String(chatId)) continue;

      const rawText = msg.text.trim();
      const text = rawText.toLowerCase();
      console.log(`\n📱 [TELEGRAM] Comando recebido: "${rawText}"`);

      const db = await localDb.read();
      const eventos = db.events || [];
      const session = wizardSessions.get(chatId);

      // ── Cancelar qualquer wizard em andamento ─────────────────────────────
      if (text === "/cancelar" || text === "/cancel") {
        if (wizardSessions.has(chatId)) {
          wizardSessions.delete(chatId);
          await sendTelegram("❌ Operação cancelada.");
        } else {
          await sendTelegram("Nenhuma operação em andamento.");
        }
        continue;
      }

      // ── Se há sessão de wizard ativa, processar resposta ──────────────────
      if (session) {
        const { step, data: wdata } = session;

        // WIZARD: /novo
        if (step === "novo_url") {
          if (!rawText.startsWith("http")) {
            await sendTelegram(
              "❌ URL inválida. Precisa começar com http. Tente novamente ou /cancelar.",
            );
            continue;
          }
          wdata.url = rawText;
          wizardSessions.set(chatId, { step: "novo_nome", data: wdata });
          await sendTelegram(
            "📛 Qual o nome do evento? (ex: Fla x Bota)\n\nOu envie /pular para usar o nome automático.",
          );
        } else if (step === "novo_nome") {
          wdata.name = text === "/pular" ? null : rawText;
          wizardSessions.set(chatId, { step: "novo_setor", data: wdata });
          await sendTelegram(
            "🏟 Qual setor você quer? (ex: Sul, Leste Inferior)\n\nPode enviar vários separados por vírgula.",
          );
        } else if (step === "novo_setor") {
          wdata.setores = rawText
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean);
          wizardSessions.set(chatId, { step: "novo_qtd", data: wdata });
          await sendTelegram("🔢 Quantos ingressos? Envie 1, 2, 3 ou 4.");
        } else if (step === "novo_qtd") {
          const qtd = parseInt(rawText);
          if (isNaN(qtd) || qtd < 1 || qtd > 4) {
            await sendTelegram("❌ Quantidade inválida. Envie 1, 2, 3 ou 4.");
            continue;
          }
          wdata.quantidade = qtd;
          wizardSessions.delete(chatId);

          // Cria o evento
          const { randomUUID } = await import("crypto");
          const novoEvento = {
            id: randomUUID(),
            user_id: "local-user-id",
            login_url: "https://ingressos.flamengo.com.br/login",
            url: wdata.url,
            name: wdata.name,
            status: "pausado" as const,
            config: {
              account_id: "ALL",
              email: "TODAS",
              senha_enc: "",
              setores: wdata.setores,
              quantidade: qtd,
              intervalo: 30,
              aceitar_qualquer: false,
              headless: true,
              loop_continuo: true,
            },
            created_at: new Date().toISOString(),
            expires_at: null,
          };
          const freshDb = await localDb.read();
          freshDb.events.push(novoEvento as any);
          await localDb.write(freshDb);

          await sendTelegram(
            `✅ *Evento criado com sucesso!*\n\n` +
              `📛 Nome: *${novoEvento.name || "Sem nome"}*\n` +
              `🔗 URL: ${novoEvento.url}\n` +
              `🏟 Setor(es): *${wdata.setores.join(", ")}*\n` +
              `🔢 Quantidade: *${qtd}*\n\n` +
              `Envie /iniciar para começar a monitorar.`,
          );
        }

        // WIZARD: /editar
        else if (step === "editar_menu") {
          const ev = eventos[0];
          if (!ev) {
            wizardSessions.delete(chatId);
            continue;
          }

          if (rawText === "1") {
            wizardSessions.set(chatId, { step: "editar_setor", data: { eventId: ev.id } });
            await sendTelegram(
              `🏟 Setor atual: *${(ev.config as any)?.setores?.join(", ")}*\n\nDigite o novo setor (ou vários separados por vírgula):`,
            );
          } else if (rawText === "2") {
            wizardSessions.set(chatId, { step: "editar_qtd", data: { eventId: ev.id } });
            await sendTelegram(
              `🔢 Quantidade atual: *${(ev.config as any)?.quantidade}*\n\nDigite a nova quantidade (1-4):`,
            );
          } else if (rawText === "3") {
            wizardSessions.set(chatId, { step: "editar_nome", data: { eventId: ev.id } });
            await sendTelegram(`📛 Nome atual: *${ev.name || "Sem nome"}*\n\nDigite o novo nome:`);
          } else {
            await sendTelegram("❌ Opção inválida. Envie 1, 2 ou 3.\n\nOu /cancelar para sair.");
          }
        } else if (step === "editar_setor") {
          const novosSetores = rawText
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean);
          const freshDb = await localDb.read();
          const idx = freshDb.events.findIndex((e) => e.id === wdata.eventId);
          if (idx !== -1) {
            (freshDb.events[idx].config as any).setores = novosSetores;
            await localDb.write(freshDb);
          }
          wizardSessions.delete(chatId);
          await sendTelegram(`✅ Setor(es) atualizado(s) para: *${novosSetores.join(", ")}*`);
        } else if (step === "editar_qtd") {
          const qtd = parseInt(rawText);
          if (isNaN(qtd) || qtd < 1 || qtd > 4) {
            await sendTelegram("❌ Quantidade inválida. Envie 1, 2, 3 ou 4.");
            continue;
          }
          const freshDb = await localDb.read();
          const idx = freshDb.events.findIndex((e) => e.id === wdata.eventId);
          if (idx !== -1) {
            (freshDb.events[idx].config as any).quantidade = qtd;
            await localDb.write(freshDb);
          }
          wizardSessions.delete(chatId);
          await sendTelegram(`✅ Quantidade atualizada para: *${qtd}*`);
        } else if (step === "editar_nome") {
          const freshDb = await localDb.read();
          const idx = freshDb.events.findIndex((e) => e.id === wdata.eventId);
          if (idx !== -1) {
            freshDb.events[idx].name = rawText;
            await localDb.write(freshDb);
          }
          wizardSessions.delete(chatId);
          await sendTelegram(`✅ Nome atualizado para: *${rawText}*`);
        } else if (step === "conta_label") {
          wdata.label = rawText;
          wizardSessions.set(chatId, { step: "conta_email", data: wdata });
          await sendTelegram("📧 Qual o e-mail da conta?");
        } else if (step === "conta_email") {
          if (!rawText.includes("@")) {
            await sendTelegram("❌ E-mail inválido. Tente novamente ou /cancelar.");
            continue;
          }
          wdata.email = rawText;
          wizardSessions.set(chatId, { step: "conta_senha", data: wdata });
          await sendTelegram("🔒 Qual a senha?");
        } else if (step === "conta_senha") {
          wdata.senha = rawText;
          wizardSessions.delete(chatId);
          const { randomUUID } = await import("crypto");
          const senhaCrypt = await encryptText(wdata.senha);
          const novaConta = {
            id: randomUUID(),
            user_id: "local-user-id",
            label: wdata.label,
            email: wdata.email,
            senha_enc: senhaCrypt,
            created_at: new Date().toISOString(),
          };
          const freshDb = await localDb.read();
          freshDb.accounts.push(novaConta as any);
          await localDb.write(freshDb);
          await sendTelegram(
            `✅ *Conta criada!*\n\n🏷 Label: *${novaConta.label}*\n📧 E-mail: *${novaConta.email}*`,
          );
        } else if (step === "editar_conta_pick") {
          const idx = parseInt(rawText) - 1;
          const freshDb = await localDb.read();
          const contas = freshDb.accounts;
          if (isNaN(idx) || idx < 0 || idx >= contas.length) {
            await sendTelegram("❌ Número inválido. Tente novamente ou /cancelar.");
            continue;
          }
          const conta = contas[idx];
          wdata.contaId = conta.id;
          wizardSessions.set(chatId, { step: "editar_conta_menu", data: wdata });
          await sendTelegram(
            `✏️ *Editar conta: ${conta.label}*\n📧 ${conta.email}\n\n` +
              `O que deseja alterar?\n1 — Label\n2 — E-mail\n3 — Senha\n\n/cancelar para sair.`,
          );
        } else if (step === "editar_conta_menu") {
          if (rawText === "1") {
            wizardSessions.set(chatId, { step: "editar_conta_label", data: wdata });
            await sendTelegram("🏷 Novo label:");
          } else if (rawText === "2") {
            wizardSessions.set(chatId, { step: "editar_conta_email", data: wdata });
            await sendTelegram("📧 Novo e-mail:");
          } else if (rawText === "3") {
            wizardSessions.set(chatId, { step: "editar_conta_senha", data: wdata });
            await sendTelegram("🔒 Nova senha:");
          } else {
            await sendTelegram("❌ Opção inválida. Envie 1, 2 ou 3.");
          }
        } else if (step === "editar_conta_label") {
          const freshDb = await localDb.read();
          const idx = freshDb.accounts.findIndex((a) => a.id === wdata.contaId);
          if (idx !== -1) {
            freshDb.accounts[idx].label = rawText;
            await localDb.write(freshDb);
          }
          wizardSessions.delete(chatId);
          await sendTelegram(`✅ Label atualizado para: *${rawText}*`);
        } else if (step === "editar_conta_email") {
          if (!rawText.includes("@")) {
            await sendTelegram("❌ E-mail inválido.");
            continue;
          }
          const freshDb = await localDb.read();
          const idx = freshDb.accounts.findIndex((a) => a.id === wdata.contaId);
          if (idx !== -1) {
            freshDb.accounts[idx].email = rawText;
            await localDb.write(freshDb);
          }
          wizardSessions.delete(chatId);
          await sendTelegram(`✅ E-mail atualizado para: *${rawText}*`);
        } else if (step === "editar_conta_senha") {
          const senhaCrypt = await encryptText(rawText);
          const freshDb = await localDb.read();
          const idx = freshDb.accounts.findIndex((a) => a.id === wdata.contaId);
          if (idx !== -1) {
            freshDb.accounts[idx].senha_enc = senhaCrypt;
            await localDb.write(freshDb);
          }
          wizardSessions.delete(chatId);
          await sendTelegram("✅ Senha atualizada com sucesso!");
        } else if (step === "apagar_conta_pick") {
          const idx = parseInt(rawText) - 1;
          const freshDb = await localDb.read();
          const contas = freshDb.accounts;
          if (isNaN(idx) || idx < 0 || idx >= contas.length) {
            await sendTelegram("❌ Número inválido. Tente novamente ou /cancelar.");
            continue;
          }
          wdata.contaIdx = idx;
          wdata.contaLabel = contas[idx].label;
          wdata.contaEmail = contas[idx].email;
          wizardSessions.set(chatId, { step: "apagar_conta_confirm", data: wdata });
          await sendTelegram(
            `⚠️ Confirma apagar a conta *${wdata.contaLabel}* (${wdata.contaEmail})?\n\nEnvie *sim* para confirmar ou /cancelar.`,
          );
        } else if (step === "apagar_conta_confirm") {
          if (text === "sim") {
            const freshDb = await localDb.read();
            freshDb.accounts.splice(wdata.contaIdx, 1);
            await localDb.write(freshDb);
            wizardSessions.delete(chatId);
            await sendTelegram(`🗑 Conta *${wdata.contaLabel}* apagada.`);
          } else {
            await sendTelegram("❌ Não confirmado. Envie *sim* ou /cancelar.");
          }
        }

        continue; // não cai nos comandos abaixo enquanto estiver no wizard
      }

      // ── Comandos normais ──────────────────────────────────────────────────
      if (text === "/iniciar" || text === "/start" || text === "iniciar compra") {
        if (eventos.length === 0) {
          await sendTelegram("❌ Nenhum evento cadastrado.\n\nEnvie /novo para criar um.");
          continue;
        }
        const ev = eventos[0];
        if (activeLoops.has(ev.id)) {
          await sendTelegram(`⚠️ O bot já está rodando para *${ev.name || ev.id.slice(0, 8)}*!`);
          continue;
        }
        const freshDb = await localDb.read();
        const idx = freshDb.events.findIndex((e) => e.id === ev.id);
        if (idx !== -1) {
          freshDb.events[idx].status = "monitorando";
          await localDb.write(freshDb);
        }
        const stopSignal = { stop: false };
        activeLoops.set(ev.id, stopSignal);
        runEventLoop(ev.id).catch((err) => console.error(`[ERRO] Loop Telegram: ${err.message}`));
        await sendTelegram(
          `✅ *Bot iniciado!*\n\n⚽ Evento: *${ev.name || ev.id.slice(0, 8)}*\nAguardando ingressos disponíveis...`,
        );
      } else if (text === "/parar" || text === "/stop" || text === "parar compra") {
        if (activeLoops.size === 0) {
          await sendTelegram("⚠️ Nenhum bot está rodando no momento.");
          continue;
        }
        for (const [eventId, signal] of activeLoops) {
          signal.stop = true;
          const ev = eventos.find((e) => e.id === eventId);
          await pushLog(eventId, "warn", "⏹ Bot parado via Telegram.");
          const freshDb = await localDb.read();
          const idx = freshDb.events.findIndex((e) => e.id === eventId);
          if (idx !== -1) {
            freshDb.events[idx].status = "pausado";
            await localDb.write(freshDb);
          }
          await sendTelegram(`🛑 *Bot parado!*\n\n⚽ Evento: *${ev?.name || eventId.slice(0, 8)}*`);
        }
      } else if (text === "/status" || text === "status") {
        if (activeLoops.size === 0) {
          const ev = eventos[0];
          const info = ev
            ? `\n\n📋 Evento cadastrado: *${ev.name || ev.id.slice(0, 8)}*\n🏟 Setor: *${(ev.config as any)?.setores?.join(", ")}*\n🔢 Qtd: *${(ev.config as any)?.quantidade}*`
            : "";
          await sendTelegram(
            `💤 *Status:* Nenhum bot rodando.\n\nEnvie /iniciar para começar.${info}`,
          );
        } else {
          const linhas: string[] = [];
          for (const [eventId] of activeLoops) {
            const ev = eventos.find((e) => e.id === eventId);
            linhas.push(`▶️ *${ev?.name || eventId.slice(0, 8)}* — rodando`);
          }
          await sendTelegram(`🤖 *Status:*\n\n${linhas.join("\n")}`);
        }
      } else if (text === "/contas") {
        const freshDb = await localDb.read();
        const contas = freshDb.accounts;
        if (contas.length === 0) {
          await sendTelegram("👤 Nenhuma conta cadastrada.\n\nUse /nova_conta para adicionar.");
        } else {
          const linhas = contas.map((c, i) => `${i + 1}. *${c.label}* — ${c.email}`).join("\n");
          await sendTelegram(
            `👥 *Contas cadastradas (${contas.length}):*\n\n${linhas}\n\n/nova_conta · /editar_conta · /apagar_conta`,
          );
        }
      } else if (text === "/nova_conta") {
        wizardSessions.set(chatId, { step: "conta_label", data: {} });
        await sendTelegram(
          "➕ *Nova conta*\n\nPasso 1/3 — Qual o nome (label) desta conta?\n(ex: Conta Principal, João, etc)\n\n/cancelar para sair.",
        );
      } else if (text === "/editar_conta") {
        const freshDb = await localDb.read();
        const contas = freshDb.accounts;
        if (contas.length === 0) {
          await sendTelegram("❌ Nenhuma conta cadastrada. Use /nova_conta para adicionar.");
          continue;
        }
        const linhas = contas.map((c, i) => `${i + 1}. *${c.label}* — ${c.email}`).join("\n");
        wizardSessions.set(chatId, { step: "editar_conta_pick", data: {} });
        await sendTelegram(
          `✏️ *Qual conta deseja editar?*\n\n${linhas}\n\nEnvie o número ou /cancelar.`,
        );
      } else if (text === "/apagar_conta") {
        const freshDb = await localDb.read();
        const contas = freshDb.accounts;
        if (contas.length === 0) {
          await sendTelegram("❌ Nenhuma conta cadastrada.");
          continue;
        }
        const linhas = contas.map((c, i) => `${i + 1}. *${c.label}* — ${c.email}`).join("\n");
        wizardSessions.set(chatId, { step: "apagar_conta_pick", data: {} });
        await sendTelegram(
          `🗑 *Qual conta deseja apagar?*\n\n${linhas}\n\nEnvie o número ou /cancelar.`,
        );
      } else if (text === "/ajuda" || text === "/help") {
        await sendTelegram(
          `🎟 *Comandos disponíveis:*\n\n` +
            `▶️ /iniciar — Inicia a busca\n` +
            `⏹ /parar — Para a busca\n` +
            `📊 /status — Status do bot\n` +
            `➕ /novo — Criar novo evento\n` +
            `✏️ /editar — Editar evento\n` +
            `👥 /contas — Listar contas\n` +
            `➕ /nova_conta — Adicionar conta\n` +
            `✏️ /editar_conta — Editar conta\n` +
            `🗑 /apagar_conta — Apagar conta\n` +
            `❌ /cancelar — Cancela operação atual`,
        );
      }
    }
  } catch (err: any) {
    if (!err.message?.includes("ENOTFOUND") && !err.message?.includes("ETIMEDOUT")) {
      console.error("[TELEGRAM] Erro no polling:", err.message);
    }
  }
}

setInterval(async () => {
  try {
    await processCommands();
    await processTelegramCommands();
  } catch (err: any) {
    console.error("[ERRO] Loop de comandos:", err.message);
  }
}, 3000);

// ─── Relatório horário por evento ─────────────────────────────────────────────────────

async function logHourlyStats() {
  try {
    const db = await localDb.read();
    if (!db.events || db.events.length === 0) return;

    const statsFile = resolve(process.cwd(), "tickets-stats.json");
    let stats: Record<string, Record<string, number>> = {};
    try {
      if (fs.existsSync(statsFile)) {
        stats = JSON.parse(fs.readFileSync(statsFile, "utf8"));
      }
    } catch {}

    const now = new Date().toLocaleString("pt-BR");

    for (const ev of db.events) {
      const evStats = stats[ev.id] ?? {};
      const totalTickets = Object.values(evStats).reduce((sum, n) => sum + (n as number), 0);
      const accountLines = Object.entries(evStats)
        .map(([email, qty]) => `👤 ${email}: ${qty} ingresso(s)`)
        .join(" | ");

      const msg =
        totalTickets > 0
          ? `📊 [${now}] Relatório horário — «${ev.name ?? ev.id.slice(0, 8)}» — ${totalTickets} ingresso(s) garantido(s). ${accountLines}`
          : `📊 [${now}] Relatório horário — «${ev.name ?? ev.id.slice(0, 8)}» — 0 ingressos encontrados até agora.`;

      await pushLog(ev.id, "info", msg);
      console.log(`📊 [${ev.name ?? ev.id.slice(0, 8)}] ${msg}`);
    }
  } catch (err: any) {
    console.error("[ERRO] Relatório horário:", err.message);
  }
}

// Dispara imediatamente ao subir e depois a cada 30 minutos
logHourlyStats();
setInterval(logHourlyStats, 30 * 60 * 1000);
