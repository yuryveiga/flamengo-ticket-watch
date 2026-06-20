import { type Page, type BrowserContext } from "playwright";
import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";

// Ativa o modo Stealth globalmente para contornar verificações de bot e reCAPTCHA
chromium.use(stealth());

import type { LogLevel } from "../lib/local-db";
import path from "path";
import fs from "fs";
import axios from "axios";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LogFn = (level: LogLevel, msg: string) => Promise<void>;

export interface EventData {
  id: string;
  login_url: string;
  url: string;
  config: {
    email?: string;
    senha_enc?: string;
    setores?: string[];
    quantidade?: number;
    aceitar_qualquer?: boolean;
    headless?: boolean;
  };
}

export interface StopSignal {
  stop: boolean;
}

// ─── Login ────────────────────────────────────────────────────────────────────

async function doLogin(page: Page, loginUrl: string, email: string, senha: string, log: LogFn) {
  await log("wait", `Navegando para URL de login: ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Close cookie banner if present
  try {
    const cookieBtn = page.locator("button:has-text('Aceitar'), button:has-text('Concordar'), button:has-text('OK')").first();
    if (await cookieBtn.isVisible({ timeout: 2000 })) await cookieBtn.click();
  } catch {}

  // Fill credentials
  const emailField = page.locator("input[type='email'], input[name='email'], input#Email, input[placeholder*='e-mail' i], input[placeholder*='cpf' i]").first();
  await emailField.waitFor({ state: "visible", timeout: 10_000 }).catch(async (e) => {
    // Se falhar, salva a página para debug
    await page.screenshot({ path: "error-login-email.png" });
    const html = await page.content();
    require("fs").writeFileSync("error-login.html", html);
    throw new Error(`Campo de e-mail não encontrado. HTML salvo em error-login.html. Erro original: ${e.message}`);
  });
  await emailField.fill(email);
  await log("api", `E-mail preenchido: ${email}`);

  const pwField = page.locator("input[type='password'], input[name='password'], input[name='senha'], input#Password").first();
  await pwField.waitFor({ state: "visible", timeout: 5_000 });
  await pwField.fill(senha);
  await log("api", "Senha preenchida.");

  const submitBtn = page.locator("button[type='submit'], button:has-text('Entrar'), button:has-text('Login'), a:has-text('Entrar')").first();
  await submitBtn.click();
  await log("wait", "Aguardando resposta do login...");

  try {
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 });
  } catch {
    const errEl = page.locator("text=/senha incorreta|inválido|incorrect|invalid/i").first();
    if (await errEl.isVisible({ timeout: 2000 })) {
      throw new Error("Credenciais inválidas. Verifique e-mail e senha.");
    }
  }

  await log("success", "Login efetuado com sucesso!");
}

// ─── CapSolver Bypass ─────────────────────────────────────────────────────────

async function solveCaptcha(page: Page, log: LogFn): Promise<boolean> {
  const capsolverApiKey = process.env.CAPSOLVER_API_KEY;
  if (!capsolverApiKey) {
    await log("warn", "[CAPTCHA] Chave do CapSolver não configurada! Continuando sem solver...");
    return false;
  }

  try {
    // Procura o iframe do reCAPTCHA e extrai o parâmetro "k" (sitekey) do src
    const iframe = page.locator("iframe[src*='recaptcha/api2/bframe'], iframe[src*='recaptcha/api2/anchor']").first();
    if (!(await iframe.isVisible({ timeout: 2000 }).catch(() => false))) {
      return false; // Não há captcha
    }

    await log("warn", "🚨 [CAPTCHA] Desafio Google detectado! Iniciando solver invisível...");
    
    const src = await iframe.getAttribute("src");
    if (!src) return false;
    
    const urlParams = new URLSearchParams(src.split('?')[1]);
    const siteKey = urlParams.get("k");
    const pageUrl = page.url();

    if (!siteKey) {
      await log("error", "[CAPTCHA] Não foi possível extrair a SiteKey do desafio.");
      return false;
    }

    await log("api", `[CAPTCHA] SiteKey capturada: ${siteKey.substring(0, 8)}... Enviando à API.`);

    // 1. Cria a tarefa no CapSolver
    const createRes = await axios.post("https://api.capsolver.com/createTask", {
      clientKey: capsolverApiKey,
      task: {
        type: "ReCaptchaV2TaskProxyless",
        websiteURL: pageUrl,
        websiteKey: siteKey,
        isInvisible: true
      }
    });

    if (createRes.data.errorId !== 0) {
      await log("error", `[CAPTCHA] Erro na API: ${createRes.data.errorDescription}`);
      return false;
    }

    const taskId = createRes.data.taskId;
    await log("wait", `[CAPTCHA] Tarefa ${taskId} criada! Trabalhadores resolvendo imagens...`);

    // 2. Fica num loop perguntando pelo resultado a cada 3 segundos
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(3000);
      const resultRes = await axios.post("https://api.capsolver.com/getTaskResult", {
        clientKey: capsolverApiKey,
        taskId: taskId
      });

      const status = resultRes.data.status;
      if (status === "ready") {
        const token = resultRes.data.solution.gRecaptchaResponse;
        await log("success", "[CAPTCHA] 🔥 Resolvido com sucesso! Injetando token mágico na página...");
        
        // 3. Injeta a solução no DOM e tenta fechar o modal ou prosseguir
        await page.evaluate((tokenStr) => {
          // 1. Preenche o textarea principal do reCAPTCHA
          const textArea = document.getElementById("g-recaptcha-response") as HTMLTextAreaElement;
          if (textArea) {
            textArea.value = tokenStr;
            textArea.innerHTML = tokenStr;
          }
          
          // 2. Dispara a callback explícita se houver data-callback na div
          const captchaDiv = document.querySelector('.g-recaptcha, [data-sitekey]');
          let callbackName = null;
          if (captchaDiv) {
             callbackName = captchaDiv.getAttribute('data-callback');
             if (callbackName && typeof (window as any)[callbackName] === 'function') {
                (window as any)[callbackName](tokenStr);
             }
          }
          
          // 3. Dispara a callback do Google pelas configs internas se a primeira não funcionou
          if (typeof (window as any).___grecaptcha_cfg !== 'undefined' && (window as any).___grecaptcha_cfg.clients) {
            for (let key in (window as any).___grecaptcha_cfg.clients) {
               const client = (window as any).___grecaptcha_cfg.clients[key];
               for (let path in client) {
                 if (client[path] && typeof client[path].callback === 'function') {
                   // Evita chamar duas vezes se já chamamos a oficial acima
                   if (client[path].callback.name !== callbackName) {
                      client[path].callback(tokenStr);
                   }
                 }
               }
            }
          }
        }, token);
        
        // 4. Aguardamos um pouco para a callback (se existia) fazer efeito
        await page.waitForTimeout(2000);
        
        // 5. Fallback Agressivo: vamos tentar encontrar qualquer formulário na página que pareça de compra e forçar um submit
        await page.evaluate(() => {
           // Remove o iframe do puzzle caso tenha ficado preso na tela
           const iframe = document.querySelector('iframe[src*="bframe"]');
           if (iframe) {
              const parent = iframe.closest('div[style*="position: absolute"]');
              if (parent) parent.remove();
           }

           // Tenta submeter o form principal do carrinho
           const form = document.querySelector('form[action*="buy"], form[action*="cart"], form#form-comprar, form.form-comprar, form');
           if (form) {
              const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
              if (submitBtn) {
                 (submitBtn as HTMLElement).click();
              } else {
                 (form as HTMLFormElement).submit();
              }
           }
        });
        
        return true;
      } else if (status === "failed") {
         await log("error", "[CAPTCHA] O CapSolver falhou em resolver o desafio.");
         return false;
      }
    }
    
    await log("error", "[CAPTCHA] Timeout aguardando o CapSolver.");
    return false;
  } catch (error: any) {
    await log("error", `[CAPTCHA] Erro interno: ${error.message}`);
    return false;
  }
}

// ─── Attempt to add to cart ───────────────────────────────────────────────────

async function tryAddToCart(
  page: Page,
  setores: string[],
  quantidade: number,
  aceitarQualquer: boolean,
  email: string,
  log: LogFn,
): Promise<boolean> {
  for (const setor of setores) {
    await log("info", `Procurando setor: "${setor}"...`);

    // getByText com exact: false permite encontrar "Oeste Inferior ." quando procuramos "Oeste Inferior"
    const sectorEl = page.getByText(setor, { exact: false }).first();
    const isVisible = await sectorEl.isVisible({ timeout: 1500 }).catch(() => false);

    if (!isVisible) {
      await log("warn", `"${setor}" não disponível.`);
      continue;
    }

    await log("info", `"${setor}" encontrado! Selecionando...`);
    await sectorEl.click().catch(() => {});
    await page.waitForTimeout(800);

    // Verifica se a conta já atingiu o limite ou tem ingresso no carrinho
    const isLimit = await page.getByText("Você já tem ingressos selecionados", { exact: false }).isVisible({ timeout: 500 }).catch(() => false);
    if (isLimit) {
      throw new Error("Esta conta já possui ingressos no carrinho para este evento (limite atingido). Bot pausado.");
    }

    // Adjust quantity
    try { await setQuantity(page, quantidade, log); } catch {}

    // Find buy/cart button
    const cartBtn = page.locator(
      "button:has-text('Adicionar ao carrinho'), button:has-text('Comprar'), button:has-text('Selecionar'), button:has-text('Continuar')"
    ).first();

    if (await cartBtn.isVisible({ timeout: 3000 })) {
      await page.screenshot({ path: "debug-before-cart.png" });
      await cartBtn.click();
      await log("wait", "Botão de compra clicado. Aguardando o site registrar no carrinho...");
      
      // Verifica se o Google jogou CAPTCHA e tenta resolver com a API
      const captchaSolved = await solveCaptcha(page, log);
      
      if (captchaSolved) {
        await log("wait", "Token injetado. Tentando clicar em 'Comprar' novamente para prosseguir...");
        await page.waitForTimeout(1500);
        
        // Busca o botão comprar novamente do zero (para evitar "stale element" caso o DOM tenha mudado)
        const newCartBtn = page.locator("button:has-text('Adicionar ao carrinho'), button:has-text('Comprar'), button:has-text('Selecionar'), button:has-text('Continuar')").first();
        if (await newCartBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await log("info", "Botão Comprar visível! Clicando...");
          await newCartBtn.click({ force: true }).catch(() => {});
        } else {
          await log("warn", "Botão Comprar não está mais visível após o captcha.");
        }
      }
      
      await log("wait", "Aguardando redirecionamento para a página do carrinho...");
      try {
        // Aguarda ativamente o site carregar a página do carrinho (até 60s)
        await page.waitForURL("**/shopping-cart**", { timeout: 60000 });
        await page.screenshot({ path: "debug-after-cart-success.png" });
        await log("success", "✅ Redirecionado para o carrinho com sucesso!");
        await log("success", `🎟 INGRESSO NO CARRINHO! Setor: "${setor}" · ${quantidade}x (Conta: ${email})`);
        return true;
      } catch (err) {
        await page.screenshot({ path: "debug-after-cart-failed.png" });
        await log("warn", "Timeout esperando abrir a página do carrinho. Captcha pode ter falhado silenciosamente.");
        
        // Debug HTML (corrigido sem seletores Playwright no querySelector)
        const htmlDebug = await page.evaluate(() => {
           const btns = Array.from(document.querySelectorAll('button'));
           const btn = btns.find(b => b.innerText.toLowerCase().includes('comprar') || b.className.includes('btn-comprar'));
           const captcha = document.querySelector(".g-recaptcha, #g-recaptcha, div[data-sitekey]");
           return {
             btnHtml: btn ? btn.outerHTML : null,
             captchaHtml: captcha ? captcha.outerHTML : null
           };
        }).catch(() => ({ btnHtml: 'erro', captchaHtml: 'erro' }));
        
        await log("info", `[DEBUG HTML] Botão: ${htmlDebug.btnHtml?.substring(0, 100)} | Captcha: ${htmlDebug.captchaHtml?.substring(0, 100)}`);
        
        // Fallback: Vamos tentar um clique forçado via JS no botão de Comprar se ele ainda estiver lá
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const comprarBtn = btns.find(b => b.innerText.toLowerCase().includes('comprar') || b.innerText.toLowerCase().includes('carrinho'));
          if (comprarBtn) {
             (comprarBtn as HTMLElement).click();
          }
        }).catch(() => {});
        
        // Wait to see if the fallback click worked
        try {
           await page.waitForURL("**/shopping-cart**", { timeout: 15000 });
           await log("success", "✅ Fallback: Redirecionado para o carrinho com sucesso!");
           return true;
        } catch(e) {
           await log("warn", "Fallback também falhou em redirecionar.");
        }
      }
    }

    await log("warn", `Botão de compra não encontrado para "${setor}".`);
  }

  // Fallback: any available button
  if (aceitarQualquer) {
    await log("info", "Tentando qualquer setor disponível...");
    const anyBtn = page.locator("button:has-text('Comprar'), button:has-text('Adicionar')").first();
    if (await anyBtn.isVisible({ timeout: 2000 })) {
      await anyBtn.click();
      await page.waitForTimeout(1500);
      await log("success", `🎟 INGRESSO NO CARRINHO! (setor automático · ${quantidade}x) (Conta: ${email})`);
      return true;
    }
  }

  return false;
}

async function setQuantity(page: Page, quantidade: number, log: LogFn) {
  const select = page.locator("select").filter({ hasText: /\d/ }).first();
  if (await select.isVisible({ timeout: 800 }).catch(() => false)) {
    try {
      await select.selectOption({ value: String(quantidade) }, { timeout: 1000 });
      await log("api", `Quantidade: ${quantidade} (via select)`);
    } catch {
      await log("warn", `Não foi possível selecionar ${quantidade} no dropdown. O site pode ter limitado a quantidade.`);
    }
    return;
  }
  const plusBtn = page.locator("button:has-text('+')").first();
  if (await plusBtn.isVisible({ timeout: 800 }).catch(() => false)) {
    let cliques = 1;
    for (let i = 1; i < quantidade; i++) {
      try {
        await plusBtn.click({ timeout: 1000 });
        await page.waitForTimeout(200);
        cliques++;
      } catch {
        // Se der timeout, o botão + provavelmente está desabilitado (limite atingido)
        break;
      }
    }
    if (cliques < quantidade) {
      await log("warn", `Pedido de ${quantidade} ingressos, mas só conseguimos selecionar ${cliques}. Avançando mesmo assim!`);
    } else {
      await log("api", `Quantidade: ${quantidade} (via botão +)`);
    }
  }
}

// ─── CORE: Persistent bot with site-update interception ───────────────────────
/**
 * Stays on the event page and listens to the site's own 30s polling cycle.
 * When `fcard-maps-ac.js` fires "Done reading available tickets", we wait
 * 500ms and immediately attempt to add the ticket to cart.
 *
 * This is far more precise than an external timer — we're piggy-backing on
 * the site's own refresh, so we always act on fresh data.
 */
export async function runBotPersistent(
  eventData: EventData,
  decryptedSenha: string,
  log: LogFn,
  stopSignal: StopSignal,
): Promise<boolean> {
  const { login_url, url, config } = eventData;
  const email       = config.email ?? "";
  const setores     = config.setores ?? [];
  const quantidade  = config.quantidade ?? 1;
  const aceitarQualquer = config.aceitar_qualquer ?? false;
  // Voltando para configuração padrão para rodar em segundo plano
  const headless    = config.headless !== false; 

  if (!email)           throw new Error("E-mail não configurado.");
  if (!decryptedSenha)  throw new Error("Senha não configurada.");

  // Lê os stats logo no início para mostrar no painel em realtime
  const statsFile = path.join(process.cwd(), 'tickets-stats.json');
  let currentStats = 0;
  if (fs.existsSync(statsFile)) {
     const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
     currentStats = stats[email] || 0;
  }
  await log("info", `[INFO CONTA] ${email} — Ingressos históricos: ${currentStats}`);
  await log("info", `Iniciando browser persistente (headless=${headless})...`);

  const userDataDir = path.join(process.cwd(), "chrome-bot-profile");
  
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    channel: "chrome",
    viewport: { width: 1366, height: 768 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  });

  // O PersistentContext já abre com uma aba vazia
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  // Escuta os logs do console do próprio site de forma nativa no Playwright
  let resolveUpdate: (() => void) | null = null;
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("Done reading available tickets") || text.includes("reading available tickets")) {
      if (resolveUpdate) {
        resolveUpdate();
        resolveUpdate = null;
      }
    }
  });

  try {
    // Step 1: Login
    await doLogin(page, login_url, email, decryptedSenha, log);

    // Step 2: Navigate to event page
    await log("wait", `Navegando para URL do evento: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);

    await log("info", "🎯 Modo de interceptação ativo. Aguardando o site atualizar a disponibilidade...");
    await log("info", "   (O site faz isso a cada ~30s via console log do fcard-maps-ac.js)");

    let attemptCount = 0;

    // Step 3: Listen for the site's own update cycle
    while (!stopSignal.stop) {
      try {
        // Aguarda a promessa ser resolvida pelo evento 'console'
        await new Promise<void>((resolve, reject) => {
          resolveUpdate = resolve;
          // Timeout de 90s (como o site atualiza a cada 30s, 90s é margem de folga)
          setTimeout(() => reject(new Error("TIMEOUT_AGUARDANDO_SITE")), 90_000);
        });
      } catch (err: any) {
        if (stopSignal.stop) break;
        if (err.message === "TIMEOUT_AGUARDANDO_SITE") {
          await log("warn", "Timeout aguardando atualização do site. Recarregando página...");
          await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.waitForTimeout(3000);
          continue;
        }
        throw err;
      }

      if (stopSignal.stop) break;

      attemptCount++;
      await log("api", `🔄 Atualização do site detectada via console! (tentativa #${attemptCount}) — agindo em 500ms...`);

      // Aguarda 500ms para o site terminar de processar o mapa visualmente
      await page.waitForTimeout(500);

      const success = await tryAddToCart(page, setores, quantidade, aceitarQualquer, email, log);
      
      if (success) {
        // Atualiza a contagem global de ingressos por conta no final com sucesso garantido
        const statsFile = path.join(process.cwd(), 'tickets-stats.json');
        let stats: Record<string, number> = {};
        if (fs.existsSync(statsFile)) {
           stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
        }
        stats[email] = (stats[email] || 0) + quantidade;
        fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));

        await log("info", "Fechando browser.");
        await context.close();
        
        await log("success", "✅ Bot finalizado com sucesso! Ingresso adicionado ao carrinho.");
        await log("info", "--------------------------------------------------");
        await log("info", "📊 RESUMO GERAL DE INGRESSOS COMPRADOS POR CONTA:");
        for (const [acc, qtd] of Object.entries(stats)) {
           await log("success", `   👤 ${acc}: ${qtd} ingressos garantidos`);
        }
        await log("info", "--------------------------------------------------");

        return true;
      }

      await log("wait", `Nenhum setor disponível nesta rodada. Aguardando próxima atualização do site...`);
    }

    return false;
  } finally {
    await log("info", "Fechando browser.");
    await context.close();
  }
}

// ─── Test login only ──────────────────────────────────────────────────────────

export async function runTestLogin(eventData: EventData, decryptedSenha: string, log: LogFn) {
  const { login_url, config } = eventData;
  const headless = config.headless !== false;

  const statsFile = path.join(process.cwd(), 'tickets-stats.json');
  let currentStats = 0;
  if (fs.existsSync(statsFile)) {
     const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
     currentStats = stats[(config as any)?.email] || 0;
  }
  await log("info", `[INFO CONTA] ${(config as any)?.email || 'Desconhecido'} — Ingressos históricos: ${currentStats}`);
  await log("info", `Iniciando teste de login (headless=${headless})...`);
  
  // Usa uma pasta diferente para o teste, assim não dá conflito (crash) se o bot principal estiver rodando
  const userDataDir = path.join(process.cwd(), "chrome-bot-profile-test");
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    channel: "chrome",
    viewport: { width: 1366, height: 768 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
  });
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  try {
    await doLogin(page, login_url, config.email ?? "", decryptedSenha, log);
    await log("success", `Teste concluído com sucesso para: ${config.email}`);
  } finally {
    await context.close();
  }
}
