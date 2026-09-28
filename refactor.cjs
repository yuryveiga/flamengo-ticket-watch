const fs = require("fs");
let code = fs.readFileSync("src/bot/playwright.ts", "utf8");

// 1. Change resolveUpdate type
code = code.replace(
  /let resolveUpdate: \(\(\) => void\) \| null = null;/g,
  "let resolveUpdate: ((data?: string[]) => void) | null = null;"
);

// 1.1 Fix onFcardUpdate
code = code.replace(
  /await page\.exposeFunction\("onFcardUpdate", \(\) => \{\n\s*if \(resolveUpdate\) \{\n\s*resolveUpdate\(\);\n\s*resolveUpdate = null;\n\s*\}\n\s*\}\);/g,
  "await page.exposeFunction(\"onFcardUpdate\", () => {\n    if (resolveUpdate) {\n      resolveUpdate();\n      resolveUpdate = null;\n    }\n  });"
);


// 2. Interceptor
const oldInterceptor = `  // -- Interceptação de Rede: Foca no endpoint exato de disponibilidade --------
  page.on("response", async (res) => {
    const resUrl = res.url();
    
    // Prioridade máxima: a própria API de disponibilidade que o site usa a cada 30s
    if (resUrl.includes("get-available-tickets")) {
      try {
        const json = await res.json();
        const jsonStr = JSON.stringify(json);
        await log("api", \`[API INTERCEPTADA] /get-available-tickets ? \${jsonStr.substring(0, 300)}\`);
        
        // Dispara atualização imediata para o loop principal processar
        if (resolveUpdate) {
          resolveUpdate();
          resolveUpdate = null;
        }
      } catch {
        // Resposta não-JSON, dispara update mesmo assim
        if (resolveUpdate) {
          resolveUpdate();
          resolveUpdate = null;
        }
      }
      return;
    }

    // Fallback: qualquer XHR/Fetch do FutebolCard (não-analytics)
    const type = res.request().resourceType();
    const urlLower = resUrl.toLowerCase();
    if ((type === "fetch" || type === "xhr") && urlLower.includes("futebolcard")
        && !urlLower.includes("google") && !urlLower.includes("analytics") && !urlLower.includes("facebook")) {
      if (resolveUpdate) {
        resolveUpdate();
        resolveUpdate = null;
      }
    }
  });`;

const newInterceptor = `  // -- Interceptação de Rede: Foca no endpoint exato de disponibilidade --------
  page.on("response", async (res) => {
    const resUrl = res.url();
    const type = res.request().resourceType();
    const status = res.status();
    
    // -- Sessão Proativa: detecta quedas na própria camada de rede --
    if (type === "fetch" || type === "xhr") {
      const contentType = res.headers()["content-type"] || "";
      if (status === 401 || status === 403 || (resUrl.includes("get-available-tickets") && contentType.includes("text/html"))) {
        await log("warn", \`[REDE] Sinal de sessão expirada detectado via rede (status \${status} ou HTML retornado).\`);
        if (resolveUpdate) {
          resolveUpdate(["SESSION_LOST"]);
          resolveUpdate = null;
        }
        return;
      }
    }

    // Prioridade máxima: a própria API de disponibilidade que o site usa a cada 30s
    if (resUrl.includes("get-available-tickets")) {
      try {
        const json = await res.json();
        const jsonStr = JSON.stringify(json);
        await log("api", \`[API INTERCEPTADA] /get-available-tickets ? \${jsonStr.substring(0, 300)}\`);
        
        // Parse do JSON para extrair os IDs disponíveis
        const availableIds: string[] = [];
        if (Array.isArray(json)) {
          for (const item of json) {
            if (typeof item === "string" || typeof item === "number") availableIds.push(String(item));
            else if (item?.id) availableIds.push(String(item.id));
            else if (item?.sector_id) availableIds.push(String(item.sector_id));
          }
        } else if (typeof json === "object" && json !== null) {
          for (const [key, val] of Object.entries(json)) {
            if (val === true || val === 1 || val === "available" || val === "1") availableIds.push(key);
            if (key === "sectors" && Array.isArray(val)) {
              for (const s of val as any[]) {
                if (s?.id && (s?.available === true || s?.available === 1 || (s?.qtd ?? 0) > 0 || (s?.quantity ?? 0) > 0)) {
                  availableIds.push(String(s.id));
                }
              }
            }
          }
        }
        
        // Dispara atualização imediata passando os IDs para o modo Sniper
        if (resolveUpdate) {
          resolveUpdate(availableIds);
          resolveUpdate = null;
        }
      } catch {
        // Resposta não-JSON, dispara update mesmo assim
        if (resolveUpdate) {
          resolveUpdate();
          resolveUpdate = null;
        }
      }
      return;
    }

    // Fallback: qualquer XHR/Fetch do FutebolCard (não-analytics)
    const urlLower = resUrl.toLowerCase();
    if ((type === "fetch" || type === "xhr") && urlLower.includes("futebolcard")
        && !urlLower.includes("google") && !urlLower.includes("analytics") && !urlLower.includes("facebook")) {
      if (resolveUpdate) {
        resolveUpdate();
        resolveUpdate = null;
      }
    }
  });`;

code = code.replace(oldInterceptor, newInterceptor);

// 3. WebSocket Interceptor update
const wsOld = `    ws.on("framereceived", (frame) => {
      // Qualquer frame de dados recebido via WS indica atualização do site
      if (frame.payload && frame.payload.length > 2) {
        if (resolveUpdate) {
          resolveUpdate();
          resolveUpdate = null;
        }
      }
    });`;
const wsNew = `    ws.on("framereceived", (frame) => {
      // Qualquer frame de dados recebido via WS indica atualização do site
      if (frame.payload && frame.payload.length > 2) {
        if (resolveUpdate) {
          resolveUpdate();
          resolveUpdate = null;
        }
      }
    });`;
// Not strictly needing replacement if we kept it `resolveUpdate()` (no args)


// 4. tryAddToCart -> finalizeCart
const tryAddToCartOldRegex = /\/\/ --- Attempt to add to cart -+[\s\S]*?(?=\/\/ --- Executa a lógica de fato)/;

const finalizeCartReplacement = `// --- Attempt to add to cart ---------------------------------------------------

async function finalizeCart(
  page: Page,
  quantidade: number,
  email: string,
  eventId: string,
  log: LogFn,
  setorNome: string
): Promise<boolean> {
  // Verifica se a conta já atingiu o limite ou tem ingresso no carrinho
  const isLimit = await page.locator("#alert-modal").isVisible({ timeout: 1000 }).catch(() => false);
  if (isLimit) {
    await log("warn", "?? Modal de aviso detectado (provável limite atingido). Fechando modal para tentar continuar...");
    await page.keyboard.press("Escape").catch(() => {});
    await page.locator("#alert-modal button").last().click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(500);
  }

  // Adjust quantity
  try { await setQuantity(page, quantidade, log); } catch {}

  // Find buy/cart button
  const cartBtn = page.locator(
    "button:has-text(\\"Adicionar ao carrinho\\"), button:has-text(\\"Comprar\\"), button:has-text(\\"Selecionar\\"), button:has-text(\\"Continuar\\")"
  ).first();

  if (await cartBtn.isVisible({ timeout: 3000 })) {
    // Detectar CAPTCHA ANTES de clicar comprar
    const captchaVisibleBefore = await page.locator(".g-recaptcha, #g-recaptcha, div[data-sitekey], iframe[src*=\\"recaptcha\\"]").isVisible({ timeout: 500 }).catch(() => false);
    if (captchaVisibleBefore) {
      await log("warn", "?? CAPTCHA detectado ANTES do clique. Resolvendo previamente...");
      await solveCaptcha(page, log);
      await page.waitForTimeout(1000);
    }

    await page.screenshot({ path: "debug-before-cart.png" });
    await cartBtn.click({ force: true, timeout: 15000 });
    await log("wait", "Botão de compra clicado. Aguardando o site registrar no carrinho...");
    
    // Verifica se o Google jogou CAPTCHA e tenta resolver com a API
    const captchaSolved = await solveCaptcha(page, log);
    
    if (captchaSolved) {
      await log("wait", "Token injetado. Tentando clicar em \\"Comprar\\" novamente para prosseguir...");
      await page.waitForTimeout(1500);
      
      const newCartBtn = page.locator("button:has-text(\\"Adicionar ao carrinho\\"), button:has-text(\\"Comprar\\"), button:has-text(\\"Selecionar\\"), button:has-text(\\"Continuar\\")").first();
      if (await newCartBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await log("info", "Botão Comprar visível! Clicando...");
        await newCartBtn.click({ force: true }).catch(() => {});
      } else {
        await log("warn", "Botão Comprar não está mais visível após o captcha.");
      }
    }
    
    await log("wait", "Aguardando redirecionamento para a página do carrinho...");
    try {
      await page.waitForURL("**/shopping-cart**", { timeout: 60000 });
      await page.screenshot({ path: "debug-after-cart-success.png" });
      await log("success", "? Redirecionado para o carrinho com sucesso!");
      await log("success", \`?? INGRESSO NO CARRINHO! Setor: "\${setorNome}" · \${quantidade}x (Conta: \${email})\`);
      await sendTelegramAlert(\`?? *INGRESSO GARANTIDO!* ??\\n\\n?? **Setor:** \${setorNome}\\n?? **Conta:** \${email}\\n? **Evento:** \${eventId}\`, log);
      return true;
    } catch (err) {
      await page.screenshot({ path: "debug-after-cart-failed.png" });
      await log("warn", "Timeout esperando abrir a página do carrinho. Captcha pode ter falhado silenciosamente.");
      
      const htmlDebug = await page.evaluate(() => {
         const btns = Array.from(document.querySelectorAll("button"));
         const btn = btns.find(b => b.innerText.toLowerCase().includes("comprar") || b.className.includes("btn-comprar"));
         const captcha = document.querySelector(".g-recaptcha, #g-recaptcha, div[data-sitekey]");
         return {
           btnHtml: btn ? btn.outerHTML : null,
           captchaHtml: captcha ? captcha.outerHTML : null
         };
      }).catch(() => ({ btnHtml: "erro", captchaHtml: "erro" }));
      
      await log("info", \`[DEBUG HTML] Botão: \${htmlDebug.btnHtml?.substring(0, 100)} | Captcha: \${htmlDebug.captchaHtml?.substring(0, 100)}\`);
      
      // Fallback click
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const comprarBtn = btns.find(b => b.innerText.toLowerCase().includes("comprar") || b.innerText.toLowerCase().includes("carrinho"));
        if (comprarBtn) {
           (comprarBtn as HTMLElement).click();
        }
      }).catch(() => {});
      
      try {
         await page.waitForURL("**/shopping-cart**", { timeout: 15000 });
         await log("success", "? Fallback: Redirecionado para o carrinho com sucesso!");
         await log("success", \`?? INGRESSO NO CARRINHO! Setor: "\${setorNome}" · \${quantidade}x (Conta: \${email})\`);
         await sendTelegramAlert(\`?? *INGRESSO GARANTIDO!* ??\\n\\n?? **Setor:** \${setorNome}\\n?? **Conta:** \${email}\\n? **Evento:** \${eventId}\`, log);
         return true;
      } catch(e) {
         await log("warn", "Fallback também falhou em redirecionar.");
      }
    }
  } else {
    await page.screenshot({ path: \`debug-buy-not-found-\${setorNome.replace(/[^a-zA-Z0-9]/g, "-")}.png\` });
    await log("warn", \`Botão de compra não encontrado para "\${setorNome}". Uma foto da tela foi salva na pasta raiz para investigarmos.\`);
  }
  return false;
}

async function tryAddToCart(
  page: Page,
  setores: string[],
  quantidade: number,
  aceitarQualquer: boolean,
  email: string,
  eventId: string,
  log: LogFn,
  sectorDropTracker: Map<string, number>,
  sniperIds: string[] = []
): Promise<boolean> {
  const SETORES_BLOQUEADOS = ["oeste inferior", "maracanã +", "maracanã mais", "maracana +"];
  
  // -- MODO SNIPER (Prioridade Máxima) --
  // Utiliza os IDs interceptados da rede para clicar diretamente sem varrer o DOM
  if (sniperIds.length > 0) {
    const idToName: Record<string, string> = {};
    for (const [name, id] of Object.entries(SECTOR_ID_MAP)) { idToName[id] = name; }
    
    for (const id of sniperIds) {
      if (id === "SESSION_LOST") continue; // Ignora o token de erro de sessão
      const nomeSector = idToName[id];
      if (!nomeSector) continue;
      
      if (SETORES_BLOQUEADOS.some((b) => nomeSector.toLowerCase().includes(b))) continue;
      const interessado = setores.length === 0 || aceitarQualquer || setores.some(s => nomeSector.toLowerCase().includes(s.toLowerCase()));
      
      if (interessado) {
        await log("info", \`[SNIPER] ?? Alvo confirmado pela rede: "\${nomeSector}" (ID \${id}). Atirando direto no DOM...\`);
        const sectorByDataAttr = page.locator(\`[data-sector="\${id}"]\`).first();
        if (await sectorByDataAttr.isVisible({ timeout: 1000 }).catch(() => false)) {
          await sectorByDataAttr.click().catch(() => {});
          await page.waitForTimeout(600);
          
          const comprou = await finalizeCart(page, quantidade, email, eventId, log, nomeSector);
          if (comprou) return true;
        } else {
          await log("warn", \`[SNIPER] ?? O setor ID \${id} não apareceu no DOM a tempo.\`);
        }
      }
    }
  }

  // -- MODO NORMAL (Scraping Visual do DOM) --
  for (const setor of setores) {
    await log("info", \`Procurando setor: "\${setor}"...\`);

    const sectorEl = page.locator("h4.match_sector-name").filter({
      hasText: new RegExp(setor.trim().replace(/[-[\\]{}()*+?.,\\\\^$|#\\s]/g, "\\\\$&"), "i")
    }).first();

    const isVisible = await sectorEl.isVisible({ timeout: 1500 }).catch(() => false);

    let isDisabledByCss = false;
    if (isVisible) {
      isDisabledByCss = await sectorEl.evaluate((el) => {
        const card = el.closest("[class]") ?? el.parentElement ?? el;
        const cls = (card.className ?? "").toLowerCase();
        const attrs = (card.getAttribute("data-available") ?? card.getAttribute("data-disabled") ?? "").toLowerCase();
        return cls.includes("disabled") || cls.includes("sold-out") || cls.includes("unavailable")
          || cls.includes("esgotado") || attrs === "false" || attrs.includes("sold");
      }).catch(() => false);
    }

    if (!isVisible || isDisabledByCss) {
      if (!isVisible) await log("warn", \`"\${setor}" não disponível.\`);
      else await log("warn", \`"\${setor}" marcado como indisponível pelo CSS. Pulando sem clicar.\`);
      
      if (sectorDropTracker.get(setor) === -1) {
         sectorDropTracker.set(setor, Date.now());
         await log("warn", \`[PREDADOR] O setor "\${setor}" acabou de esgotar (alguém reservou). Agendando Overclock...\`);
      }
      continue;
    }

    sectorDropTracker.set(setor, -1);
    await log("info", \`"\${setor}" encontrado e disponível! Selecionando...\`);
    await sectorEl.click().catch(() => {});
    await page.waitForTimeout(800);

    const comprou = await finalizeCart(page, quantidade, email, eventId, log, setor);
    if (comprou) return true;
  }

  // -- MODO GENÉRICO (Aceitar Qualquer) --
  if (aceitarQualquer) {
    await log("info", "Tentando qualquer setor disponível...");
    const allSectors = page.locator("h4.match_sector-name");
    const count = await allSectors.count();
    
    for (let i = 0; i < count; i++) {
      const sec = allSectors.nth(i);
      if (await sec.isVisible({ timeout: 1000 })) {
        const sectorName = (await sec.textContent() ?? "").toLowerCase().trim();
        
        if (SETORES_BLOQUEADOS.some((b) => sectorName.includes(b))) {
          await log("info", \`Setor ignorado (bloqueado): "\${await sec.textContent()}"\`);
          continue;
        }
        
        await log("info", \`Tentando setor genérico #\${i + 1}: "\${await sec.textContent()}"...\`);
        await sec.click().catch(() => {});
        await page.waitForTimeout(800);
        
        const comprou = await finalizeCart(page, quantidade, email, eventId, log, sectorName);
        if (comprou) return true;
      }
    }
  }

  return false;
}

`;

code = code.replace(tryAddToCartOldRegex, finalizeCartReplacement);

// 5. Update Loop State variables
const loopStartRegex = /    let attemptCount = 0;\n    \/\/ -- Melhoria 4: Rastrear última vez que a página respondeu corretamente ----\n    let lastSuccessfulCheckAt = Date.now\(\);\n    const SESSION_TIMEOUT_MS = 5 \* 60 \* 1000; \/\/ 5 minutos sem resposta = reconectar do zero\n\n    \/\/ Step 3: Loop combinando polling e interceptação\n    while \(!stopSignal.stop\) \{/g;
const loopStartReplacement = `    let attemptCount = 0;
    // -- Melhoria 4: Rastrear última vez que a página respondeu corretamente ----
    let lastSuccessfulCheckAt = Date.now();
    const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos sem resposta = reconectar do zero
    
    // Variável que segura os IDs interceptados pela rede até a próxima iteração
    let nextSniperIds: string[] = [];

    // Step 3: Loop combinando polling e interceptação
    while (!stopSignal.stop) {`;
code = code.replace(loopStartRegex, loopStartReplacement);

// 6. Update Session Guard
const sessionGuardRegex = /      \/\/ -- Guarda de Sessão: detecta redirecionamento para \/login em todo ciclo --\n      const currentPageUrl = page\.url\(\);\n      if \(currentPageUrl\.includes\("\/login"\) \|\| currentPageUrl\.includes\("login\?"\)\) \{/g;
const sessionGuardReplacement = `      // -- Guarda de Sessão: Proativa (rede) e Reativa (DOM) --
      const currentPageUrl = page.url();
      if (nextSniperIds.includes("SESSION_LOST") || currentPageUrl.includes("/login") || currentPageUrl.includes("login?")) {
        nextSniperIds = []; // limpa estado`;
code = code.replace(sessionGuardRegex, sessionGuardReplacement);

// 7. Update tryAddToCart call in loop
const tryAddToCartCallRegex = /      \/\/ 1\. Tenta comprar \(DOM como confirmação final\)\n      const success = await tryAddToCart\(page, setores, quantidade, aceitarQualquer, email, eventData\.id, log, sectorDropTracker\);/g;
const tryAddToCartCallReplacement = `      // 1. Tenta comprar — Passando as coordenadas do Sniper
      const currentSniperIds = [...nextSniperIds];
      nextSniperIds = []; // limpa para o próximo ciclo
      const success = await tryAddToCart(page, setores, quantidade, aceitarQualquer, email, eventData.id, log, sectorDropTracker, currentSniperIds);`;
code = code.replace(tryAddToCartCallRegex, tryAddToCartCallReplacement);

// 8. Update wait promise block
const waitBlockRegex = /      try \{\n        let timerId: NodeJS\.Timeout;\n        await new Promise<void>\(\(resolve, reject\) => \{\n          resolveUpdate = \(\) => \{\n            clearTimeout\(timerId\);\n            resolve\(\);\n          \};\n          \n          timerId = setTimeout\(\(\) => \{\n            resolveUpdate = null;\n            reject\(new Error\("INTERVAL_TICK"\)\);\n          \}, dynamicWaitTimeMs\);\n        \}\);\n        \n        \/\/ Se chegou aqui, a promessa foi resolvida pelo console log \(onFcardUpdate\)!\n        await log\("info", "? Atualização detectada via console do site! Verificando imediatamente\.\.\."\);\n        await page\.waitForTimeout\(500\); \/\/ Aguarda o DOM renderizar\n      \}/g;
const waitBlockReplacement = `      try {
        let timerId: NodeJS.Timeout;
        const apiData = await new Promise<string[] | undefined>((resolve, reject) => {
          resolveUpdate = (data?: string[]) => {
            clearTimeout(timerId);
            resolve(data);
          };
          
          timerId = setTimeout(() => {
            resolveUpdate = null;
            reject(new Error("INTERVAL_TICK"));
          }, dynamicWaitTimeMs);
        });
        
        if (apiData && apiData.length > 0) {
          nextSniperIds = apiData;
          if (apiData.includes("SESSION_LOST")) {
            await log("warn", "? Queda de sessão detectada na camada de rede!");
          } else {
            await log("info", \`? Atualização detectada via interceptação de rede! Alvos armados: [\${apiData.join(", ")}]\`);
          }
        } else {
          await log("info", "? Atualização detectada via DOM/WS (sem payload detalhado).");
        }
        await page.waitForTimeout(200); // Micro delay para o DOM refletir
      }`;
code = code.replace(waitBlockRegex, waitBlockReplacement);

fs.writeFileSync("src/bot/playwright.ts", code);
console.log("Refactoring complete");

