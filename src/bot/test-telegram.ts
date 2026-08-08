import axios from "axios";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), ".env") });

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

const msg =
  `🚨 <b>[TESTE] INGRESSO DISPONÍVEL!</b>\n\n` +
  `🎟️ Evento: <code>37145</code>\n` +
  `🔗 <a href="https://www.futebolcard.com/buy/sector?event=37145">Ir para o evento</a>\n\n` +
  `📋 Resposta da API:\n` +
  `<code>Stadium - Done reading available tickets - 2 tickets available - Norte Inferior</code>\n\n` +
  `🤖 Bot de compra acionado automaticamente!\n` +
  `⏰ SIMULAÇÃO — ${new Date().toLocaleString("pt-BR")}`;

console.log("Enviando mensagem de teste...");
console.log("Token:", token ? token.slice(0, 10) + "..." : "NÃO ENCONTRADO");
console.log("Chat ID:", chatId);

axios
  .post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: msg,
    parse_mode: "HTML",
  })
  .then((r) => console.log("✅ Mensagem enviada com sucesso!", r.data))
  .catch((e) => console.error("❌ Erro:", e.response?.data ?? e.message));
