import { Page } from "playwright";
import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import fs from "fs";
import path from "path";
import axios from "axios";
import { toSectorUrl } from "../lib/utils";
import { EventRecord } from "../lib/local-db";

chromium.use(stealth());

export type LogFn = (type: "info" | "warn" | "error" | "success" | "wait" | "api", msg: string) => Promise<void>;

async function setupBrowser(email: string, headless: boolean) {
  const safeEmail = email.replace(/[^a-zA-Z0-9]/g, "_");
  const userDataDir = path.join(process.cwd(), `chrome-bot-profile-${safeEmail}`);
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  const videoDir = path.join(process.cwd(), "videos-tmp");
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: videoDir, size: { width: 1920, height: 1080 } },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-infobars",
      "--window-position=0,0",
      "--ignore-certificate-errors",
    ],
  });

  let page = context.pages()[0];
  if (!page) page = await context.newPage();
  
  await context.clearCookies({ domain: "ingressos.flamengo.com.br" });
  
  return { context, page, videoDir };
}

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

async function solveCaptcha(page: Page, log: LogFn): Promise<boolean> {
  const capsolverApiKey = process.env.CAPSOLVER_API_KEY;
  if (!capsolverApiKey) {
    await log("warn", "[CAPTCHA] Chave do CapSolver não configurada! Ignorando solver...");
    return false;
  }

  try {
    const iframe = page.locator("iframe[src*='recaptcha/api2/bframe'], iframe[src*='recaptcha/api2/anchor']").first();
    if (!(await iframe.isVisible({ timeout: 2000 }).catch(() => false))) {
      return false; // Não há captcha na tela
    }

    await log("warn", "🚨 [CAPTCHA] Desafio Google detectado! Iniciando solver invisível...");
    
    const src = await iframe.getAttribute("src");
    if (!src) return false;
    
    const urlParams = new URLSearchParams(src.split('?')[1]);
    const siteKey = urlParams.get("k");
    const pageUrl = page.url();

    if (!siteKey) {
      await log("error", "[CAPTCHA] Não extraiu SiteKey.");
      return false;
    }

    await log("api", `[CAPTCHA] SiteKey: ${siteKey.substring(0, 8)}... Enviando tarefa.`);

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
      await log("error", `[CAPTCHA] Erro API: ${createRes.data.errorDescription}`);
      return false;
    }

    const taskId = createRes.data.taskId;
    await log("wait", `[CAPTCHA] Tarefa ${taskId} criada! Resolvendo...`);

    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(3000);
      const resultRes = await axios.post("https://api.capsolver.com/getTaskResult", {
        clientKey: capsolverApiKey,
        taskId: taskId
      });

      const status = resultRes.data.status;
      if (status === "ready") {
        const token = resultRes.data.solution.gRecaptchaResponse;
        await log("success", "[CAPTCHA] 🔥 Resolvido! Injetando token...");
        
        await page.evaluate((tokenStr) => {
          const textArea = document.getElementById("g-recaptcha-response") as HTMLTextAreaElement;
          if (textArea) {
            textArea.value = tokenStr;
            textArea.innerHTML = tokenStr;
          }
          
          const captchaDiv = document.querySelector('.g-recaptcha, [data-sitekey]');
          let callbackName = null;
          if (captchaDiv) {
             callbackName = captchaDiv.getAttribute('data-callback');
             if (callbackName && typeof (window as any)[callbackName] === 'function') {
                (window as any)[callbackName](tokenStr);
             }
          }
          
          if (typeof (window as any).___grecaptcha_cfg !== 'undefined' && (window as any).___grecaptcha_cfg.clients) {
            for (let key in (window as any).___grecaptcha_cfg.clients) {
               const client = (window as any).___grecaptcha_cfg.clients[key];
               for (let path in client) {
                 if (client[path] && typeof client[path].callback === 'function') {
                   if (client[path].callback.name !== callbackName) {
                      client[path].callback(tokenStr);
                   }
                 }
               }
            }
          }
        }, token);
        
        await page.waitForTimeout(2000);
        
        await page.evaluate(() => {
           const iframe = document.querySelector('iframe[src*="bframe"]');
           if (iframe) {
              const parent = iframe.closest('div[style*="position: absolute"]');
              if (parent) parent.remove();
           }

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
         await log("error", "[CAPTCHA] Falha no CapSolver.");
         return false;
      }
    }
    
    await log("error", "[CAPTCHA] Timeout no CapSolver.");
    return false;
  } catch (error: any) {
    await log("error", `[CAPTCHA] Erro: ${error.message}`);
    return false;
  }
}

async function setQuantity(page: Page, desiredQtd: number, log: LogFn) {
  const selectLocator = page.locator("select").first();
  if (await selectLocator.isVisible({ timeout: 2000 }).catch(()=>false)) {
    await selectLocator.selectOption(desiredQtd.toString());
    await log("info", `Quantidade ajustada para ${desiredQtd} via <select>`);
    return;
  }
  
  const increaseBtn = page.locator("button.add, button:has-text('+'), .plus").first();
  if (await increaseBtn.isVisible({ timeout: 2000 }).catch(()=>false)) {
    const currentQtdEl = page.locator(".quantity, input[type='number']").first();
    let current = 1;
    if (await currentQtdEl.isVisible().catch(()=>false)) {
      const val = await currentQtdEl.inputValue().catch(() => null) || await currentQtdEl.innerText().catch(() => "1");
      current = parseInt(val, 10) || 1;
    }
    
    while (current < desiredQtd) {
      await increaseBtn.click();
      await page.waitForTimeout(300);
      current++;
    }
    await log("info", `Quantidade ajustada para ${desiredQtd} via botão de +`);
  }
}

export async function runBotPersistent(
  eventData: EventRecord,
  decryptedSenha: string,
  log: LogFn,
  stopSignal: { stop: boolean }
) {
  const config = eventData.config;
  const email = config.email;
  const login_url = eventData.login_url;
  const url = toSectorUrl(eventData.url);
  const setores = config.setores || [];
  const quantidade = config.quantidade || 1;
  const headless = config.headless !== false;

  await log("info", `🚀 Iniciando bot SIMPLIFICADO para ${email}`);

  const { context, page, videoDir } = await setupBrowser(email, headless);

  // Salva o vídeo quando ingresso for encontrado; descarta nos demais casos
  const saveVideo = async (label: string) => {
    try {
      const videoPath = await page.video()?.path();
      if (!videoPath) return;
      await context.close(); // finaliza a gravação
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = path.join(process.cwd(), `ingresso-video-${label}-${timestamp}.webm`);
      fs.renameSync(videoPath, dest);
      await log("success", `🎥 Vídeo salvo: ${path.basename(dest)}`);
    } catch (e: any) {
      await log("warn", `🎥 Não foi possível salvar o vídeo: ${e.message}`);
    }
  };

  const discardVideos = () => {
    try {
      const files = fs.readdirSync(videoDir);
      for (const f of files) fs.unlinkSync(path.join(videoDir, f));
    } catch {}
  };

  let ticketFoundSector = ""; // preenchido assim que encontrar setor disponível

  try {
    // 1. FAÇA LOGIN
    await log("wait", "1. Navegando para a URL de login...");
    await page.goto(login_url, { waitUntil: "domcontentloaded", timeout: 60000 });

    try {
      const cookieBtn = page.locator("button:has-text('Aceitar'), button:has-text('Concordar'), button:has-text('OK')").first();
      if (await cookieBtn.isVisible({ timeout: 2000 })) await cookieBtn.click();
    } catch {}

    const logoutLink = page.locator("a:has-text('Sair'), a:has-text('Logout')").first();
    
    if (await logoutLink.isVisible().catch(() => false)) {
      await log("success", "Sessão já estava ativa (botão 'Sair' visível).");
    } else {
      await log("api", "Preenchendo credenciais...");
      const emailField = page.locator("input[type='email'], input[name='email'], input#Email, input[placeholder*='e-mail' i], input[placeholder*='cpf' i]").first();
      await emailField.waitFor({ state: "visible", timeout: 10000 });
      await emailField.fill(email);
      
      const pwField = page.locator("input[type='password'], input[name='password'], input[name='senha'], input#Password").first();
      await pwField.fill(decryptedSenha);
      
      const submitBtn = page.locator("button[type='submit'], button:has-text('Entrar'), button:has-text('Login')").first();
      await submitBtn.click();
      
      await log("wait", "Aguardando login terminar (verificando mudança de URL)...");
      
      // ── Trata modal de "Termos de Coleta de Dados" que pode aparecer durante o login ──
      const acceptTermsIfVisible = async () => {
        try {
          const termsCheckbox = page.locator("input[type='checkbox']").filter({ hasText: "" }).first();
          const termsLabel = page.locator("label:has-text('Li e aceito'), a:has-text('Li e aceito'), span:has-text('Li e aceito')").first();
          
          if (await termsLabel.isVisible({ timeout: 3000 })) {
            await log("info", "📋 Modal de termos detectado! Aceitando termos de coleta de dados...");
            // Tenta clicar no checkbox primeiro, depois na label como fallback
            try {
              await termsCheckbox.click({ timeout: 3000 });
            } catch {
              await termsLabel.click({ timeout: 3000 });
            }
            await page.waitForTimeout(1000);
            // Clica em qualquer botão de confirmação que apareça após aceitar
            const confirmBtn = page.locator("button:has-text('Confirmar'), button:has-text('Continuar'), button:has-text('Prosseguir'), button[type='submit']").first();
            if (await confirmBtn.isVisible({ timeout: 2000 })) {
              await confirmBtn.click();
            }
            await log("success", "✅ Termos aceitos com sucesso!");
          }
        } catch { /* modal não apareceu, tudo bem */ }
      };

      try {
        // Aguarda URL mudar, mas verifica modal a cada 2s enquanto espera
        await Promise.race([
          page.waitForURL((url) => !url.href.includes("login"), { timeout: 15000 }),
          (async () => {
            await page.waitForTimeout(2000);
            await acceptTermsIfVisible();
            await page.waitForURL((url) => !url.href.includes("login"), { timeout: 13000 });
          })(),
        ]);
      } catch {
        // Se ainda não saiu do login, tenta aceitar termos e depois captcha
        await acceptTermsIfVisible();
        await page.waitForTimeout(1000);
        
        if (page.url().includes("login")) {
          // Verifica se deu erro de senha antes de assumir captcha
          const errEl = page.locator("text=/incorretos|Tente novamente/i").first();
          if (await errEl.isVisible({ timeout: 2000 })) {
            await page.screenshot({ path: "erro-senha.png" });
            throw new Error("Credenciais inválidas. Verifique e-mail e senha no painel.");
          }

          await log("warn", "URL não mudou após 15s. Verificando captcha de login...");
          const captchaSolved = await solveCaptcha(page, log);
          if (captchaSolved) {
            await acceptTermsIfVisible();
            await page.waitForURL((url) => !url.href.includes("login"), { timeout: 15000 }).catch(() => {});
          }
        }
      }
      
      // Checagem final de segurança para garantir que saiu do login
      if (page.url().includes("login")) {
         throw new Error("Falha no login: O site não aceitou a entrada ou bloqueou a requisição silenciosamente.");
      }
      
      await page.waitForTimeout(3000);
      await page.screenshot({ path: "debug-apos-login.png" });
      await log("success", "Login efetuado com sucesso (ou bypass)!");
    }

    // ── Loop de tentativa ──
    while (!stopSignal.stop) {
      // 2. VÁ ATÉ A URL DO EVENTO
      await log("wait", `2. Navegando para o evento: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3000);
      
      await page.screenshot({ path: "debug-apos-evento.png" });

      if (page.url().includes("/login")) {
         await log("warn", `Redirecionado para o login. (URL atual: ${page.url()}) Refazendo autenticação...`);
         await page.goto(login_url);
         const btn = page.locator("button[type='submit']").first();
         if (await btn.isVisible()) {
             await page.locator("input[type='email'], input[name='email'], input#Email, input[placeholder*='e-mail' i], input[placeholder*='cpf' i]").first().fill(email);
             await page.locator("input[type='password'], input[name='password'], input[name='senha'], input#Password").first().fill(decryptedSenha);
             await btn.click();
             try {
                await page.waitForURL((url) => !url.href.includes("login"), { timeout: 15000 });
             } catch {
                const solved = await solveCaptcha(page, log);
                if (solved) {
                   await page.waitForURL((url) => !url.href.includes("login"), { timeout: 15000 }).catch(() => {});
                }
             }
             await page.waitForTimeout(3000);
         }
         continue;
      }

      // 3. PROCURE PELO SETOR
      await log("info", "3. Procurando setores...");
      await page.waitForSelector("h4.match_sector-name", { timeout: 10000 }).catch(() => {});
      
      let foundSector = false;
      let foundSectorStr = "";

      for (const setor of setores) {
        await log("info", `Verificando: "${setor}"`);
        const sectorEl = page.locator("h4.match_sector-name").filter({ hasText: new RegExp(setor.trim(), "i") }).first();
        
        if (await sectorEl.isVisible().catch(() => false)) {
          const isSold = await sectorEl.evaluate((el) => {
            const card = el.closest('a.match_sector') || el.closest('[class]');
            return (card?.className || "").toLowerCase().includes('sold');
          }).catch(() => false);

          if (!isSold) {
            await log("success", `Setor "${setor}" DISPONÍVEL! Clicando...`);
            await page.screenshot({ path: `ingresso-01-setor-encontrado-${setor.replace(/\s+/g,'-')}.png` });
            await sectorEl.click();
            foundSector = true;
            foundSectorStr = setor;
            ticketFoundSector = setor; // marca que encontrou — vídeo será salvo
            await page.waitForTimeout(1000);
            break;
          } else {
            await log("warn", `"${setor}" aparece esgotado (sold).`);
          }
        } else {
          await log("warn", `"${setor}" não existe na página.`);
        }
      }

      if (foundSector) {
        const modalBtn = page.locator("#alert-modal button").last();
        if (await modalBtn.isVisible().catch(()=>false)) await modalBtn.click();

        // 4. AJUSTE A QUANTIDADE
        await log("info", "4. Ajustando a quantidade...");
        await setQuantity(page, quantidade, log);

        // 5. CLIQUE EM COMPRAR
        await log("info", "5. Clicando em Comprar...");
        const buyBtn = page.locator("button:has-text('Adicionar ao carrinho'), button:has-text('Comprar')").first();
        if (await buyBtn.isVisible({ timeout: 3000 }).catch(()=>false)) {
           
           // ANTES DE CLICAR, CHECAR CAPTCHA COMO NO ORIGINAL
           const captchaVisibleBefore = await page.locator(".g-recaptcha, #g-recaptcha, div[data-sitekey], iframe[src*='recaptcha']").isVisible({ timeout: 500 }).catch(() => false);
           if (captchaVisibleBefore) {
             await log("warn", "⚠️ CAPTCHA detectado ANTES do clique. Resolvendo previamente...");
             await solveCaptcha(page, log);
             await page.waitForTimeout(1000);
           }
           
           await page.screenshot({ path: `ingresso-02-antes-comprar.png` });
           await buyBtn.click({ force: true });
        }

        // 6. RESOLVER CAPTCHA IMEDIATAMENTE E ENTÃO AGUARDAR CARRINHO
        await log("wait", "6. Resolvendo captcha imediatamente após Comprar...");
        
        // Aguarda brevemente para o site processar o clique e exibir o captcha
        await page.waitForTimeout(1000);
        
        // Resolve captcha direto — sem esperar pelo carrinho primeiro
        const captchaResolvido = await solveCaptcha(page, log);
        
        if (captchaResolvido) {
          // Captcha resolvido → agora aguarda o redirect para o carrinho
          await page.waitForURL("**/shopping-cart**", { timeout: 20000 }).catch(() => {});
        } else {
          // Sem captcha visível → aguarda redirect normal
          await page.waitForURL("**/shopping-cart**", { timeout: 15000 }).catch(() => {});
        }

        if (page.url().includes("shopping-cart")) {
          await page.screenshot({ path: `ingresso-03-carrinho-sucesso.png` });
          await log("success", `✅ SUCESSO! Ingressos no carrinho! Setor: "${foundSectorStr}" · ${quantidade}x (Conta: ${email})`);
          await sendTelegramAlert(`🚨 *INGRESSO GARANTIDO!* 🚨\n\n🎟 **Setor:** ${foundSectorStr}\n🔢 **Quantidade:** ${quantidade}\n👤 **Conta:** ${email}\n⚽ **Evento:** ${eventData.id}`, log);
          await page.waitForTimeout(3000);
          break;
        }

        await log("error", "Não redirecionou para o carrinho após captcha (ingressos podem ter esgotado).");
        await page.screenshot({ path: "erro-carrinho-pos-captcha.png" });
        break;
      } else {
        const waitTime = config.intervalo || 10;
        
        if (!config.loop_continuo) {
           await log("warn", "Loop contínuo desativado. Encerrando busca nesta conta.");
           break;
        }
        
        await log("wait", `Nenhum setor disponível. Tentando novamente em ${waitTime}s...`);
        await page.waitForTimeout(waitTime * 1000);
      }
    }

  } catch (error: any) {
    await log("error", `Erro: ${error.message}`);
  } finally {
    const videoLabel = ticketFoundSector
      ? ticketFoundSector.replace(/\s+/g, "-")
      : `sessao-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    await saveVideo(videoLabel);
  }
}

export async function runTestLogin() {}
