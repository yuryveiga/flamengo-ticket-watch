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

  // Simula 12 verificações com a resposta real da API
  for (let msgCount = 1; msgCount <= 12; msgCount++) {
    const shouldLog = msgCount === 1 || msgCount % 10 === 0;
    
    // Simulando uma resposta da API (como se a mensagem mudasse num certo check)
    let responseText = "Stadium - Done reading available tickets - maximum booking null";
    
    if (msgCount === 10) {
      responseText = "Stadium - Done reading available tickets - OUTRA MENSAGEM AQUI (teste)";
    }

    console.log(`[Check #${msgCount}] -> Vai logar no painel? ${shouldLog ? "SIM" : "NÃO"}`);

    if (shouldLog) {
      const msg = `🔍 Monitor (a cada 5min): ${responseText.slice(0, 250).trim()}`;
      await localDb.appendLog(ev.id, "info", msg);
      console.log(`   ✅ Inserido no DB: ${msg}`);
    }
  }
  }

  console.log("\nVerifique o painel do evento para ver se os logs dos checks 1 e 10 apareceram.");
}

testDashLog().catch(console.error);
