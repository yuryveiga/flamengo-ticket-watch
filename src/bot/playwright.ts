import { type Page, type BrowserContext } from "playwright";
import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";

// Ativa o modo Stealth globalmente para contornar verificações de bot e reCAPTCHA
chromium.use(stealth());

import type { LogLevel } from "../lib/local-db";
import path from "path";
import fs from "fs";
import { sleep, toSectorUrl } from "../lib/utils";
import axios from "axios";
import { localDb } from "../lib/local-db";

// ─── Mapa de Nomes de Setores → IDs do FutebolCard ───────────────────────────
// IDs extraídos diretamente do HTML de /buy/sector?event=37145
// Atualizar conforme novos eventos surgem (data-sector no HTML)
const SECTOR_ID_MAP: Record<string, string> = {
  "norte nível 1 | e":  "8468571",
  "norte nível 2 | e":  "8468578",
  "norte nível 1 | f":  "8468591",
  "norte nível 2 | f":  "8468596",
  "sul nível 1 | c":    "8468689",
  "sul nível 2 | c":    "8468679",
  "leste superior":     "8468635",
  "leste inferior":     "8468626",
  "oeste inferior":     "8468650",
  "maracanã + | a":     "8468658",
};

// ─── Nota: Disponibilidade via API ───────────────────────────────────────────
// Não fazemos polling manual da API — o site já chama /buy/get-available-tickets
// a cada 30s. Interceptamos essa resposta via page.on('response') mais abaixo,
// o que é muito mais confiável: o request já possui cookies e CSRF token corretos.
// O JSON capturado é logado como [API INTERCEPTADA] para análise do formato real.


// ─── Alertas Telegram ────────────────────────────────────────────────────────
async function sendTelegramAlert(message: string, log: LogFn) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await axios.post(url, {
      chat_id: chatId,
      text: message,
      parse_mode: "Markdown"
    });
    await log("info", "📱 Alerta enviado para o Telegram com sucesso!");
  } catch (err: any) {
    await log("warn", `📱 Falha ao enviar alerta para o Telegram: ${err.message}`);
  }
}

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
    intervalo?: number;
    loop_continuo?: boolean;
    timer_loop_run_minutes?: number;
  };
}

// Declara a função exposta pelo Playwright no contexto do browser
declare global {
  interface Window {
    onFcardUpdate: () => Promise<void>;
  }
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

  // Verifica se já está logado (sessão persistente) ou se precisa logar
  const emailField = page.locator("input[type='email'], input[name='email'], input#Email, input[placeholder*='e-mail' i], input[placeholder*='cpf' i]").first();
  const logoutLink = page.locator("a[href*='logout'], a:has-text('Sair'), a:has-text('Logout')").first();

  try {
    await Promise.race([
      emailField.waitFor({ state: "visible", timeout: 10_000 }),
      logoutLink.waitFor({ state: "visible", timeout: 10_000 })
    ]);
  } catch (e: any) {
    await page.screenshot({ path: "error-login-page.png" });
    const html = await page.content();
    fs.writeFileSync("error-login.html", html);
    throw new Error(`Página de login não carregou corretamente (sem campo de email e sem botão de Sair). HTML salvo em error-login.html. Erro: ${e.message}`);
  }

  if (await logoutLink.isVisible()) {
    await log("success", `Sessão da conta ${email} já estava salva e logada! Pulando login...`);
    return;
  }

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
  eventId: string,
  log: LogFn,
  sectorDropTracker: Map<string, number>
): Promise<boolean> {
  for (const setor of setores) {
    await log("info", `Procurando setor: "${setor}"...`);

    // Busca especificamente no h4.match_sector-name, comparando de forma case-insensitive e ignorando espaços extras
    const sectorEl = page.locator("h4.match_sector-name").filter({
      hasText: new RegExp(setor.trim().replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&"), "i")
    }).first();

    const isVisible = await sectorEl.isVisible({ timeout: 1500 }).catch(() => false);

    // ── Melhoria 1: Verificar CSS antes de clicar ─────────────────────────────
    // Inspeciona o card pai do setor para classes que indicam indisponibilidade
    let isDisabledByCss = false;
    if (isVisible) {
      isDisabledByCss = await sectorEl.evaluate((el) => {
        const card = el.closest('[class]') ?? el.parentElement ?? el;
        const cls = (card.className ?? "").toLowerCase();
        const attrs = (card.getAttribute('data-available') ?? card.getAttribute('data-disabled') ?? "").toLowerCase();
        return cls.includes('disabled') || cls.includes('sold-out') || cls.includes('unavailable')
          || cls.includes('esgotado') || attrs === 'false' || attrs.includes('sold');
      }).catch(() => false);
    }

    if (!isVisible || isDisabledByCss) {
      if (!isVisible) {
        await log("warn", `"${setor}" não disponível.`);
      } else {
        await log("warn", `"${setor}" marcado como indisponível pelo CSS. Pulando sem clicar.`);
      }
      
      // Se estava registrado como disponível (-1), significa que alguém acabou de colocar no carrinho
      if (sectorDropTracker.get(setor) === -1) {
         sectorDropTracker.set(setor, Date.now());
         await log("warn", `[PREDADOR] O setor "${setor}" acabou de esgotar (alguém reservou). Agendando Overclock para a janela de 15 minutos...`);
      }
      continue;
    }

    // Se o setor está disponível, marcamos como -1
    sectorDropTracker.set(setor, -1);

    await log("info", `"${setor}" encontrado e disponível! Selecionando...`);
    await sectorEl.click().catch(() => {});
    await page.waitForTimeout(800);

    // Verifica se a conta já atingiu o limite ou tem ingresso no carrinho
    const isLimit = await page.locator("#alert-modal").isVisible({ timeout: 1000 }).catch(() => false);
    if (isLimit) {
      await log("warn", "⚠️ Modal de aviso detectado (provável limite atingido). Fechando modal para tentar continuar...");
      await page.keyboard.press("Escape").catch(() => {});
      await page.locator("#alert-modal button").last().click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(500);
    }

    // Adjust quantity
    try { await setQuantity(page, quantidade, log); } catch {}

    // Find buy/cart button
    const cartBtn = page.locator(
      "button:has-text('Adicionar ao carrinho'), button:has-text('Comprar'), button:has-text('Selecionar'), button:has-text('Continuar')"
    ).first();

    if (await cartBtn.isVisible({ timeout: 3000 })) {
      // ── Melhoria 3: Detectar CAPTCHA ANTES de clicar comprar ─────────────────
      const captchaVisibleBefore = await page.locator(".g-recaptcha, #g-recaptcha, div[data-sitekey], iframe[src*='recaptcha']").isVisible({ timeout: 500 }).catch(() => false);
      if (captchaVisibleBefore) {
        await log("warn", "⚠️ CAPTCHA detectado ANTES do clique. Resolvendo previamente...");
        await solveCaptcha(page, log);
        await page.waitForTimeout(1000);
      }

      await page.screenshot({ path: "debug-before-cart.png" });
      await cartBtn.click({ force: true, timeout: 15000 });
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
        await sendTelegramAlert(`🚨 *INGRESSO GARANTIDO!* 🚨\n\n🎟 **Setor:** ${setor}\n👤 **Conta:** ${email}\n⚽ **Evento:** ${eventId}`, log);
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
           await log("success", `🎟 INGRESSO NO CARRINHO! Setor: "${setor}" · ${quantidade}x (Conta: ${email})`);
           await sendTelegramAlert(`🚨 *INGRESSO GARANTIDO!* 🚨\n\n🎟 **Setor:** ${setor}\n👤 **Conta:** ${email}\n⚽ **Evento:** ${eventId}`, log);
           return true;
        } catch(e) {
           await log("warn", "Fallback também falhou em redirecionar.");
        }
      }
    } else {
      await page.screenshot({ path: `debug-buy-not-found-${setor.replace(/[^a-zA-Z0-9]/g, '-')}.png` });
      await log("warn", `Botão de compra não encontrado para "${setor}". Uma foto da tela foi salva na pasta raiz para investigarmos.`);
    }
  }

  // Fallback: any available button
  if (aceitarQualquer) {
    await log("info", "Tentando qualquer setor disponível...");
    
    // Setores que devem ser ignorados mesmo no modo "aceitar qualquer"
    const SETORES_BLOQUEADOS = ["oeste inferior", "maracanã +", "maracanã mais", "maracana +"];
    
    // Pega todos os setores renderizados
    const allSectors = page.locator("h4.match_sector-name");
    const count = await allSectors.count();
    
    for (let i = 0; i < count; i++) {
      const sec = allSectors.nth(i);
      if (await sec.isVisible({ timeout: 1000 })) {
        const sectorName = (await sec.textContent() ?? "").toLowerCase().trim();
        
        // Pula setores bloqueados
        if (SETORES_BLOQUEADOS.some((b) => sectorName.includes(b))) {
          await log("info", `Setor ignorado (bloqueado): "${await sec.textContent()}"`);
          continue;
        }
        
        await log("info", `Tentando setor genérico #${i + 1}: "${await sec.textContent()}"...`);
        await sec.click().catch(() => {});
        await page.waitForTimeout(800);
        
        // Verifica se abriu modal de erro de limite
        const isLimit = await page.locator("#alert-modal").isVisible({ timeout: 1000 }).catch(() => false);
        if (isLimit) {
          await page.keyboard.press("Escape").catch(() => {});
          await page.locator("#alert-modal button").last().click({ timeout: 1500 }).catch(() => {});
          continue; // tenta o próximo
        }
        
        try { await setQuantity(page, quantidade, log); } catch {}
        
        const cartBtn = page.locator("button:has-text('Adicionar ao carrinho'), button:has-text('Comprar'), button:has-text('Selecionar'), button:has-text('Continuar')").first();
        if (await cartBtn.isVisible({ timeout: 2000 })) {
          await cartBtn.click({ force: true, timeout: 15000 });
          await log("wait", "Botão de compra clicado. Aguardando...");
          
          await solveCaptcha(page, log);
          
          try {
            await page.waitForURL("**/shopping-cart**", { timeout: 20_000 });
            await log("success", `🎟 INGRESSO NO CARRINHO! (setor automático #${i + 1} · ${quantidade}x) (Conta: ${email})`);
            await sendTelegramAlert(`🚨 *INGRESSO GARANTIDO!* 🚨\n\n🎟 **Setor:** (Automático)\n👤 **Conta:** ${email}\n⚽ **Evento:** ${eventId}`, log);
            return true;
          } catch {
            await log("warn", "Fallback automático: clique realizado mas o carrinho não abriu. Tentando o próximo...");
          }
        }
      }
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
): Promise<boolean | "pause_requested"> {
  const { login_url, config } = eventData;
  // Normaliza para /buy/sector independente do que foi cadastrado
  const url         = toSectorUrl(eventData.url);
  const email       = config.email ?? "";
  const setores     = config.setores ?? [];
  const quantidade  = config.quantidade ?? 1;
  const aceitarQualquer = config.aceitar_qualquer ?? false;
  // Voltando para configuração padrão para rodar em segundo plano
  const headless    = config.headless !== false; 

  if (!email)           throw new Error("E-mail não configurado.");
  if (!decryptedSenha)  throw new Error("Senha não configurada.");

  // Lê os stats isolando por ID do evento (para zerar em novos eventos)
  const statsFile = path.join(process.cwd(), 'tickets-stats.json');
  let currentStats = 0;
  if (fs.existsSync(statsFile)) {
     try {
       const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
       if (stats[eventData.id] && typeof stats[eventData.id] === 'object') {
         currentStats = stats[eventData.id][email] || 0;
       }
     } catch {}
  }
  await log("info", `[INFO CONTA] ${email} — Ingressos históricos no evento atual: ${currentStats}`);
  await log("info", `Iniciando browser persistente (headless=${headless})...`);

  const safeEmail = email.replace(/[^a-zA-Z0-9]/g, '_');
  const userDataDir = path.join(process.cwd(), `chrome-bot-profile-${safeEmail}`);
  
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    channel: "chrome",
    viewport: { width: 1366, height: 768 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    args: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding"
    ]
  });

  // O PersistentContext já abre com uma aba vazia
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  // ── Tracking de Carrinhos Abandonados ──────────────────────────────────────
  const sectorDropTracker = new Map<string, number>();

  let resolveUpdate: ((data?: string[]) => void) | null = null;
  
  // Expor função para o browser chamar quando interceptar o log
  await page.exposeFunction("onFcardUpdate", async () => {
    if (resolveUpdate) {
      resolveUpdate();
      resolveUpdate = null;
    }
  });

  await page.exposeFunction("onAnomalousResponse", async () => {
    await log("warn", "⚠️ [ANOMALIA] A consulta do servidor não retornou 'maximum booking null'!");
    localDb.updateEventStats(eventData.id, { addAnomalous: 1 }).catch(() => {});
  });

  // Injetar script antes de tudo para hackear o console.log original do site
  await page.addInitScript(() => {
    const origLog = console.log;
    const origInfo = console.info;
    const origDebug = console.debug;
    
    function checkArgs(args: any[]) {
      const text = args.map(a => String(a)).join(" ");
      if (text.includes("reading available tickets")) {
        if (!text.includes("maximum booking null")) {
          // Detectamos a resposta anômala solicitada pelo usuário
          if ((window as any).onAnomalousResponse) {
             (window as any).onAnomalousResponse().catch(() => {});
          }
        }
        if ((window as any).onFcardUpdate) {
          (window as any).onFcardUpdate().catch(() => {});
        }
      }
    }
    
    console.log = function(...args) { checkArgs(args); return origLog.apply(this, args); };
    console.info = function(...args) { checkArgs(args); return origInfo.apply(this, args); };
    console.debug = function(...args) { checkArgs(args); return origDebug.apply(this, args); };
  });

  // ── Interceptação de Rede: Foca no endpoint exato de disponibilidade ────────
  page.on("response", async (res) => {
    const resUrl = res.url();
    
    // Prioridade máxima: a própria API de disponibilidade que o site usa a cada 30s
    if (resUrl.includes("get-available-tickets")) {
      try {
        const json = await res.json();
        const jsonStr = JSON.stringify(json);
        await log("api", `[API INTERCEPTADA] /get-available-tickets → ${jsonStr.substring(0, 300)}`);
        
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
  });

  // ── Melhoria 2: Interceptação via WebSocket ───────────────────────────────
  page.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => {
      // Qualquer frame de dados recebido via WS indica atualização do site
      if (frame.payload && frame.payload.length > 2) {
        if (resolveUpdate) {
          resolveUpdate();
          resolveUpdate = null;
        }
      }
    });
  });

  try {
    // Step 1: Login
    await doLogin(page, login_url, email, decryptedSenha, log);

    // Step 2: Navigate to event page
    await log("wait", `Navegando para URL do evento: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);

    await log("info", "🎯 Modo de interceptação ativo! Checando DOM imediatamente e aguardando atualizações...");

    let attemptCount = 0;
    // ── Melhoria 4: Rastrear última vez que a página respondeu corretamente ────
    let lastSuccessfulCheckAt = Date.now();
    const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos sem resposta = reconectar do zero

    // Step 3: Loop combinando polling e interceptação
    const runStartTime = Date.now();
    while (!stopSignal.stop) {
      attemptCount++;
      if (attemptCount % 5 === 0) {
        localDb.updateEventStats(eventData.id, { addAttempts: 5 }).catch(() => {});
      }

      // ── Guarda de Sessão: detecta redirecionamento para /login em todo ciclo ──
      const currentPageUrl = page.url();
      if (currentPageUrl.includes("/login") || currentPageUrl.includes("login?")) {
        await log("warn", `🔒 Sessão expirada detectada (URL: ${currentPageUrl}). Fazendo re-login automático...`);
        try {
          await doLogin(page, login_url, email, decryptedSenha, log);
          await log("info", "✅ Re-login concluído. Navegando de volta para o evento...");
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.waitForTimeout(2000);
          lastSuccessfulCheckAt = Date.now();
        } catch (loginErr: any) {
          await log("error", `❌ Falha no re-login: ${loginErr.message}. Tentando novamente no próximo ciclo...`);
          await page.waitForTimeout(5000);
          continue;
        }
      }

      await log("api", `🔄 Verificando disponibilidade (tentativa #${attemptCount})...`);

      // 1. Tenta comprar (DOM como confirmação final)
      const success = await tryAddToCart(page, setores, quantidade, aceitarQualquer, email, eventData.id, log, sectorDropTracker);
      
      if (success) {
        // Atualiza a contagem isolada por evento
        const statsFile = path.join(process.cwd(), 'tickets-stats.json');
        let stats: any = {};
        if (fs.existsSync(statsFile)) {
           try { stats = JSON.parse(fs.readFileSync(statsFile, 'utf8')); } catch {}
        }
        if (!stats[eventData.id]) stats[eventData.id] = {};
        stats[eventData.id][email] = (stats[eventData.id][email] || 0) + quantidade;
        fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));

        await log("info", "Fechando browser.");
        await context.close();
        
        await log("success", "✅ Bot finalizado com sucesso! Ingresso adicionado ao carrinho.");
        await log("info", "--------------------------------------------------");
        await log("info", "📊 RESUMO DE INGRESSOS DESTE EVENTO POR CONTA:");
        for (const [acc, qtd] of Object.entries(stats[eventData.id] || {})) {
           await log("success", `   👤 ${acc}: ${qtd} ingressos garantidos`);
        }
        await log("info", "--------------------------------------------------");

        return true;
      }

      // ── Melhoria 8: Checagem do Timer de Loop (Descanso) ───────────────
      if (config.timer_loop_run_minutes) {
        const runningMs = Date.now() - runStartTime;
        if (runningMs > config.timer_loop_run_minutes * 60000) {
          await log("warn", `⏰ Tempo de execução contínuo atingido (${config.timer_loop_run_minutes} min). Solicitando pausa de descanso...`);
          return "pause_requested";
        }
      }

      // ── Melhoria 2: Lógica de Intervalo Dinâmico (Overclock) ──────────
      let dynamicWaitTimeMs = (config.intervalo || 10) * 1000;
      let isOverclockActive = false;

      for (const [s, dropTime] of sectorDropTracker.entries()) {
        if (dropTime > 0) {
          const elapsed = Date.now() - dropTime;
          // Se estamos entre 14m50s e 15m10s (exemplo de janela preditiva)
          if (elapsed >= 14 * 60 * 1000 + 50 * 1000 && elapsed <= 15 * 60 * 1000 + 10 * 1000) {
            dynamicWaitTimeMs = 1000; // 1 segundo de intervalo (Overclock)
            isOverclockActive = true;
            break;
          }
          // Se já passou de 16 minutos, limpa do tracker pra não ficar pesando
          if (elapsed > 16 * 60 * 1000) {
            sectorDropTracker.delete(s);
          }
        }
      }

      if (isOverclockActive) {
        await log("api", `🔥 [OVERCLOCK ATIVADO] Polling super-agressivo (1s) para pegar carrinho caindo...`);
      } else {
        await log("wait", `Nenhum setor disponível. Aguardando ${dynamicWaitTimeMs / 1000}s ou atualização do site...`);
      }

      if (stopSignal.stop) break;

      // 2. Aguarda o intervalo da configuração OU o console log do site
      try {
        let timerId: NodeJS.Timeout;
        await new Promise<void>((resolve, reject) => {
          resolveUpdate = () => {
            clearTimeout(timerId);
            resolve();
          };
          
          timerId = setTimeout(() => {
            resolveUpdate = null;
            reject(new Error("INTERVAL_TICK"));
          }, dynamicWaitTimeMs);
        });
        
        // Se chegou aqui, a promessa foi resolvida pelo console log (onFcardUpdate)!
        await log("info", "⚡ Atualização detectada via console do site! Verificando imediatamente...");
        await page.waitForTimeout(500); // Aguarda o DOM renderizar
      } catch (err: any) {
        if (err.message === "INTERVAL_TICK") {
          // ── Melhoria 4: Timeout de sessão com reconexão total ────────────────
          const sinceLastCheck = Date.now() - lastSuccessfulCheckAt;
          if (sinceLastCheck > SESSION_TIMEOUT_MS) {
            await log("warn", `⏰ Sem resposta válida há ${Math.round(sinceLastCheck / 60000)}min. Reconectando do zero...`);
            try { await context.close(); } catch {}
            // Re-lança erro para o worker reiniciar o loop completo
            throw new Error("SESSION_TIMEOUT");
          }

          // A cada 3 tentativas sem sucesso, recarrega a página
          if (attemptCount % 3 === 0) {
            await log("info", `🔄 Recarregando página do evento (tentativa #${attemptCount})...`);
            try {
              await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
              await page.waitForTimeout(1500);
              // Verifica se foi parar na tela de login após o goto
              const urlAfterGoto = page.url();
              if (urlAfterGoto.includes("/login")) {
                await log("warn", "🔒 Após reload, caiu no /login. Fazendo re-login...");
                await doLogin(page, login_url, email, decryptedSenha, log);
                await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
                await page.waitForTimeout(2000);
              }
              lastSuccessfulCheckAt = Date.now();
            } catch {
              await log("warn", "Falha ao recarregar. Tentando continuar...");
            }
          }
        } else {
          throw err;
        }
      }

      // Atualiza o timer de sessão a cada ciclo bem-sucedido
      lastSuccessfulCheckAt = Date.now();
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
     try {
       const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
       if (stats[eventData.id] && typeof stats[eventData.id] === 'object') {
         currentStats = stats[eventData.id][(config as any)?.email] || 0;
       }
     } catch {}
  }
  await log("info", `[INFO CONTA] ${(config as any)?.email || 'Desconhecido'} — Ingressos históricos no evento atual: ${currentStats}`);
  await log("info", `Iniciando teste de login (headless=${headless})...`);
  
  // Usa uma pasta diferente para o teste, assim não dá conflito (crash) se o bot principal estiver rodando
  const safeEmail = ((config as any)?.email || "test").replace(/[^a-zA-Z0-9]/g, '_');
  const userDataDir = path.join(process.cwd(), `chrome-bot-profile-test-${safeEmail}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    channel: "chrome",
    viewport: { width: 1366, height: 768 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  });
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  try {
    await doLogin(page, login_url, config.email ?? "", decryptedSenha, log);
    await log("success", `Teste concluído com sucesso para: ${config.email}`);
  } finally {
    await context.close();
  }
}
