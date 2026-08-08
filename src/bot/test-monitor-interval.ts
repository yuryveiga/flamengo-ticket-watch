import { config } from "dotenv";
import { resolve } from "path";
import { localDb } from "../lib/local-db";

config({ path: resolve(process.cwd(), ".env") });

async function testDashLog() {
  const db = await localDb.read();

  if (!db.events || db.events.length === 0) {
    console.log("Sem eventos para testar.");
    return;
  }

  for (const ev of db.events) {
    console.log(`\nTestando logs para o evento: ${ev.name}`);

  // Simula 12 verificações
  for (let msgCount = 1; msgCount <= 12; msgCount++) {
    const shouldLog = msgCount === 1 || msgCount % 10 === 0;
    console.log(`[Check #${msgCount}] -> Vai logar no painel? ${shouldLog ? "SIM" : "NÃO"}`);

    if (shouldLog) {
      const msg = `🔍 Monitor (a cada 5min): sem ingressos disponíveis (check #${msgCount}).`;
      await localDb.appendLog(ev.id, "info", msg);
      console.log(`   ✅ Inserido no DB: ${msg}`);
    }
  }
  }

  console.log("\nVerifique o painel do evento para ver se os logs dos checks 1 e 10 apareceram.");
}

testDashLog().catch(console.error);
