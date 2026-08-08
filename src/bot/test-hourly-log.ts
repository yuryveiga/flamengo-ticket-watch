import { config } from "dotenv";
import { resolve } from "path";
import * as fs from "fs";
import { localDb } from "../lib/local-db";

config({ path: resolve(process.cwd(), ".env") });

async function testHourlyStats() {
  const db = await localDb.read();
  if (!db.events || db.events.length === 0) {
    console.log("❌ Nenhum evento cadastrado.");
    return;
  }

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

    const msg = totalTickets > 0
      ? `📊 [${now}] Relatório horário — «${ev.name ?? ev.id.slice(0, 8)}» — ${totalTickets} ingresso(s) garantido(s). ${accountLines}`
      : `📊 [${now}] Relatório horário — «${ev.name ?? ev.id.slice(0, 8)}» — 0 ingressos encontrados até agora.`;

    await localDb.appendLog(ev.id, "info", msg);
    console.log(`✅ [${ev.name ?? ev.id.slice(0, 8)}] → ${msg}`);
  }

  console.log("\n✅ Logs escritos no dashboard de cada evento.");
}

testHourlyStats().catch(console.error);
