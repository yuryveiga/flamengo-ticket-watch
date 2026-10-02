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

  const proxyPorts = ["10000", "10001", "10002"];
  const selectedPort = proxyPorts[Math.floor(Math.random() * proxyPorts.length)];

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
    proxy: {
      server: `http://res.proxy-seller.com:${selectedPort}`,
      username: "0fbefbccf822a48b",
      password: "wMjzJEVFCPYyI9iL"
    }
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
    // Procura por qualquer indício de reCAPTCHA na página (iframe, classe, sitekey ou textarea)
    const recaptchaLocator = page.locator("iframe[src*='recaptcha'], .g-recaptcha, [data-sitekey], #g-recaptcha-response").first();
    const hasRecaptcha = await recaptchaLocator.waitFor({ state: "attached", timeout: 2500 }).then(() => true).catch(() => false);

    if (!hasRecaptcha) {
      return false; // Não há recaptcha detectado na tela
    }

    // Checa se o bframe está visível
    const bframe = page.locator("iframe[src*='recaptcha/api2/bframe']").first();
    const isBframe = await bframe.isVisible({ timeout: 1000 }).catch(() => false);

    // Extrai siteKey do bframe ou de qualquer iframe recaptcha ou do DOM
    let siteKey: string | null = null;
    let isInvisible = true;

    if (isBframe) {
      const src = await bframe.getAttribute("src").catch(() => null);
      if (src) {
        const urlParams = new URLSearchParams(src.split('?')[1]);
        siteKey = urlParams.get("k");
      }
    }

    if (!siteKey) {
      const iframes = await page.locator("iframe[src*='recaptcha']").all();
      for (const ifr of iframes) {
        const src = await ifr.getAttribute("src").catch(() => null);
        if (src && src.includes("k=")) {
          const urlParams = new URLSearchParams(src.split('?')[1]);
          const k = urlParams.get("k");
          if (k) {
            siteKey = k;
            isInvisible = src.includes("size=invisible") || !src.includes("size=");
            break;
          }
        }
      }
    }

    if (!siteKey) {
      siteKey = await page.evaluate(() => {
        const el = document.querySelector('[data-sitekey]');
        if (el) return el.getAttribute('data-sitekey');
        if (typeof (window as any).___grecaptcha_cfg !== 'undefined' && (window as any).___grecaptcha_cfg.clients) {
          for (const key in (window as any).___grecaptcha_cfg.clients) {
            const client = (window as any).___grecaptcha_cfg.clients[key];
            if (client?.sitekey) return client.sitekey;
          }
        }
        return null;
      }).catch(() => null);
    }

    if (!siteKey) {
      return false;
    }

    await log("warn", `🚨 [CAPTCHA] Desafio Google detectado! SiteKey: ${siteKey.substring(0, 10)}... Solicitando CapSolver...`);

    const pageUrl = page.url();
    await log("api", `[CAPTCHA] SiteKey: ${siteKey.substring(0, 10)}... Criando tarefa no CapSolver...`);

    const startSolve = Date.now();
    const createRes = await axios.post("https://api.capsolver.com/createTask", {
      clientKey: capsolverApiKey,
      task: {
        type: "ReCaptchaV2TaskProxyless",
        websiteURL: pageUrl,
        websiteKey: siteKey,
        isInvisible,
        pageAction: "buy",
        userAgent: await page.evaluate(() => navigator.userAgent)
      }
    }, { timeout: 7000 });

    if (createRes.data.errorId !== 0) {
      await log("error", `[CAPTCHA] Erro ao criar tarefa CapSolver: ${createRes.data.errorDescription}`);
      return false;
    }

    const taskId = createRes.data.taskId;
    await log("wait", `[CAPTCHA] Tarefa ${taskId} em processamento no CapSolver...`);

    // Primeira consulta após 1s (tempo mínimo do CapSolver)
    await page.waitForTimeout(1000);

    // Polling acelerado a cada 800ms (máxima agilidade)
    for (let i = 0; i < 35; i++) {
      const resultRes = await axios.post("https://api.capsolver.com/getTaskResult", {
        clientKey: capsolverApiKey,
        taskId: taskId
      }, { timeout: 4000 }).catch(() => null);

      if (resultRes && resultRes.data) {
        const status = resultRes.data.status;
        if (status === "ready") {
          const token = resultRes.data.solution?.gRecaptchaResponse;
          const totalSec = ((Date.now() - startSolve) / 1000).toFixed(1);
          await log("success", `[CAPTCHA] 🔥 Resolvido em ${totalSec}s! Injetando token e submetendo instantaneamente...`);

          // Injeta token, aciona callbacks e submete em uma única execução atômica (0ms de delay)
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
                try { (window as any)[callbackName](tokenStr); } catch {}
              }
            }

            if (typeof (window as any).___grecaptcha_cfg !== 'undefined' && (window as any).___grecaptcha_cfg.clients) {
              for (const key in (window as any).___grecaptcha_cfg.clients) {
                const client = (window as any).___grecaptcha_cfg.clients[key];
                for (const path in client) {
                  if (client[path] && typeof client[path].callback === 'function') {
                    if (client[path].callback.name !== callbackName) {
                      try { client[path].callback(tokenStr); } catch {}
                    }
                  }
                }
              }
            }

            // Remove o bframe para desbloquear a tela
            const iframe = document.querySelector('iframe[src*="bframe"]');
            if (iframe) {
              const parent = iframe.closest('div[style*="position: absolute"]');
              if (parent) parent.remove();
            }

          }, token);

          return true;
        } else if (status === "failed") {
          await log("error", `[CAPTCHA] Falha no CapSolver: ${resultRes.data.errorDescription || "Erro desconhecido"}`);
          return false;
        }
      }

      await page.waitForTimeout(800);
    }

    await log("error", "[CAPTCHA] Timeout ao aguardar resposta do CapSolver.");
    return false;
  } catch (error: any) {
    await log("error", `[CAPTCHA] Erro na resolução: ${error.message}`);
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
  const config = eventData.config || {};
  const email = config.email;
  const loginType = config.login_type || "normal";
  const login_url = eventData.login_url;
  const url = toSectorUrl(eventData.url);
  const setores = config.setores || [];
  const quantidade = config.quantidade || 1;
  const headless = config.headless !== false;

  await log("info", `🚀 Iniciando bot para ${email} (${loginType === "fla_id" ? "🔴 FLA ID" : "Conta Normal"})`);

  const { context, page, videoDir } = await setupBrowser(email, headless);

  // Salva o vídeo SOMENTE quando ingresso for garantido no carrinho; descarta e deleta nos demais casos
  const saveVideo = async (label: string) => {
    try {
      const videoPath = await page.video()?.path();
      await context.close().catch(() => {}); // finaliza a gravação
      if (!videoPath || !fs.existsSync(videoPath)) return;
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
      if (fs.existsSync(videoDir)) {
        const files = fs.readdirSync(videoDir);
        for (const f of files) {
          try {
            fs.unlinkSync(path.join(videoDir, f));
          } catch {}
        }
      }
    } catch {}
  };

  // Limpa vídeos temporários anteriores para não consumir espaço em disco
  discardVideos();

  let ticketFoundSector = ""; // preenchido assim que encontrar setor disponível
  let purchaseSuccess = false;

  try {
    // 1. FAÇA LOGIN
    await log("wait", "1. Navegando para a URL de login...");
    await page.goto(login_url, { waitUntil: "domcontentloaded", timeout: 60000 });

    try {
      const cookieBtn = page.locator("button:has-text('Aceitar'), button:has-text('Concordar'), button:has-text('Concordo'), button:has-text('De acordo'), button:has-text('OK')").first();
      if (await cookieBtn.isVisible({ timeout: 2000 })) {
        await cookieBtn.click({ force: true });
        await page.waitForTimeout(500);
      }
    } catch {}

    const logoutLink = page.locator("a:has-text('Sair'), a:has-text('Logout')").first();
    
    if (await logoutLink.isVisible().catch(() => false)) {
      await log("success", "Sessão já estava ativa (botão 'Sair' visível).");
    } else {
      if (loginType === "fla_id") {
        await log("api", "🔴 Modo FLA ID: Clicando em 'Entrar com Fla-ID'...");
        
        await page.waitForTimeout(1000);

        const flaSelectors = [
          "a.fla-id-btn",
          "a[href*='/login/fla-id']",
          "a[href*='fla-id']",
          ".fla-id-btn",
          "a:has-text('Entrar com')",
          "button:has-text('Entrar com')",
          "[aria-label='Entrar']",
        ];

        let clickedFla = false;
        for (const sel of flaSelectors) {
          try {
            const el = page.locator(sel).first();
            await el.waitFor({ state: "visible", timeout: 3000 });
            await el.scrollIntoViewIfNeeded().catch(() => {});
            await el.click({ force: true });
            await log("info", `✅ Botão Fla-ID (${sel}) clicado com sucesso!`);
            clickedFla = true;
            await page.waitForTimeout(2500);
            break;
          } catch {
            // tenta o próximo seletor
          }
        }

        if (!clickedFla) {
          await log("warn", "⚠️ Botão não respondeu ao clique, navegando diretamente para a URL do Fla-ID...");
          await page.goto("https://ingressos.flamengo.com.br/login/fla-id", { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForTimeout(2000);
        }
      }

      await log("api", `Preenchendo credenciais (${loginType === "fla_id" ? "FLA ID" : "Conta Normal"})...`);
      const emailField = page.locator("input[type='email'], input[name='login'], input[name='email'], input#Email, input[placeholder*='e-mail' i], input[placeholder*='cpf' i], input[name='username'], input[placeholder*='usuário' i], input[type='text']:visible").first();
      
      try {
        await emailField.waitFor({ state: "visible", timeout: 30000 });
      } catch (e) {
        await page.screenshot({ path: "erro-timeout-login.png" });
        throw new Error("Timeout ao aguardar formulário de login (proxy pode estar lento ou bloqueado no Cloudflare). Veja erro-timeout-login.png.");
      }
      
      await emailField.click();
      await page.waitForTimeout(500);
      await emailField.fill(""); // limpa o campo
      await emailField.pressSequentially(email, { delay: 80 }); // digita como humano
      
      const pwField = page.locator("input[type='password'], input[name='pass'], input[name='password'], input[name='senha'], input#Password, input[type='password']:visible").first();
      await pwField.waitFor({ state: "visible", timeout: 10000 });
      await pwField.click();
      await page.waitForTimeout(500);
      await pwField.fill("");
      await pwField.pressSequentially(decryptedSenha, { delay: 80 });
      
      await page.waitForTimeout(1000); // aguarda JS processar
      const submitBtn = page.locator("button[type='submit'], button:has-text('Entrar'), button:has-text('Login'), button:has-text('Acessar'), input[type='submit']").first();
      await submitBtn.click({ force: true, delay: 150 });
      
      if (loginType === "fla_id") {
        await log("wait", "Aguardando autenticação FLA ID concluir e redirecionar...");
        try {
          await page.waitForURL((url) => !url.href.includes("flaid") && !url.pathname.endsWith("/login"), { timeout: 20000 });
        } catch {
          const errEl = page.locator("text=/incorretos|inválid|Tente novamente/i").first();
          if (await errEl.isVisible({ timeout: 2000 }).catch(() => false)) {
            await page.screenshot({ path: "erro-senha-flaid.png" });
            throw new Error("Credenciais inválidas no FLA ID. Verifique usuário e senha no painel.");
          }
          await log("warn", "URL não mudou após 20s no FLA ID. Verificando captcha...");
          const captchaSolved = await solveCaptcha(page, log);
          if (captchaSolved) {
            await page.waitForURL((url) => !url.href.includes("flaid") && !url.pathname.endsWith("/login"), { timeout: 15000 }).catch(() => {});
          }
        }
      } else {
        await log("wait", "Aguardando login terminar (verificando mudança de URL)...");
        
        // ── Trata modal de "Termos de Coleta de Dados" que pode aparecer durante o login convencional ──
        const acceptTermsIfVisible = async () => {
          try {
            const termsCheckbox = page.locator("input[type='checkbox']").filter({ hasText: "" }).first();
            const termsLabel = page.locator("label:has-text('Li e aceito'), a:has-text('Li e aceito'), span:has-text('Li e aceito')").first();
            
            if (await termsLabel.isVisible({ timeout: 3000 })) {
              await log("info", "📋 Modal de termos detectado! Aceitando termos de coleta de dados...");
              try {
                await termsCheckbox.click({ timeout: 3000 });
              } catch {
                await termsLabel.click({ timeout: 3000 });
              }
              await page.waitForTimeout(1000);
              const confirmBtn = page.locator("button:has-text('Confirmar'), button:has-text('Continuar'), button:has-text('Prosseguir'), button[type='submit']").first();
              if (await confirmBtn.isVisible({ timeout: 2000 })) {
                await confirmBtn.click();
              }
              await log("success", "✅ Termos aceitos com sucesso!");
            }
          } catch { /* modal não apareceu, tudo bem */ }
        };

        try {
          await Promise.race([
            page.waitForURL((url) => !url.href.includes("login"), { timeout: 15000 }),
            (async () => {
              await page.waitForTimeout(2000);
              await acceptTermsIfVisible();
              await page.waitForURL((url) => !url.href.includes("login"), { timeout: 13000 });
            })(),
          ]);
        } catch {
          await acceptTermsIfVisible();
          await page.waitForTimeout(1000);
          
          if (page.url().includes("login")) {
            const errEl = page.locator("text=/incorretos|inválid|Tente novamente/i").first();
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
      }
      
      // Checagem final de segurança para garantir que saiu do login
      const stillInLogin = loginType === "fla_id"
        ? page.url().includes("flaid") || (page.url().includes("login") && !page.url().includes("buy") && !page.url().includes("event"))
        : page.url().includes("login");

      if (stillInLogin) {
         await page.screenshot({ path: "falha-silenciosa-login.png" });
         throw new Error("Falha no login: O site não aceitou a entrada ou bloqueou a requisição silenciosamente.");
      }
      
      await page.waitForTimeout(2000);
      await page.screenshot({ path: "debug-apos-login.png" });
      await log("success", `Login efetuado com sucesso (${loginType === "fla_id" ? "FLA ID" : "Conta Normal"})!`);
    }

    // ── Loop de tentativa ──
    const loopStartTimeMs = Date.now();
    const runMinutes = config.timer_loop_run_minutes;
    
    while (!stopSignal.stop) {
      if (runMinutes && runMinutes > 0) {
        if (Date.now() - loopStartTimeMs >= runMinutes * 60000) {
           await log("warn", `⏱️ Tempo de execução atingido (${runMinutes} min). Fechando navegador para descanso...`);
           try { await context.close(); } catch {}
           return "pause_requested";
        }
      }

      // 2. VÁ ATÉ A URL DO EVENTO
      await log("wait", `2. Navegando para o evento: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3000);
      
      await page.screenshot({ path: "debug-apos-evento.png" });

      if (page.url().includes("/login")) {
         await log("warn", `Redirecionado para o login. (URL atual: ${page.url()}) Refazendo autenticação...`);
         await page.goto(login_url);
         if (loginType === "fla_id") {
           await page.waitForTimeout(1500);
           const flaSelectors = ["a.fla-id-btn", "a[href*='/login/fla-id']", "a[href*='fla-id']", "a:has-text('Entrar com')"];
           for (const sel of flaSelectors) {
             try {
               const el = page.locator(sel).first();
               await el.waitFor({ state: "visible", timeout: 2000 });
               await el.click({ force: true });
               await page.waitForTimeout(2000);
               break;
             } catch {}
           }
         }
         const btn = page.locator("button[type='submit'], button:has-text('Entrar'), button:has-text('Login'), button:has-text('Acessar')").first();
         if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
             await page.locator("input[type='email'], input[name='email'], input#Email, input[placeholder*='e-mail' i], input[placeholder*='cpf' i], input[name='username'], input[placeholder*='usuário' i], input[type='text']:visible").first().fill(email);
             await page.locator("input[type='password'], input[name='password'], input[name='senha'], input#Password, input[type='password']:visible").first().fill(decryptedSenha);
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
        if (await buyBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await page.screenshot({ path: "ingresso-02-antes-comprar.png" });
          await buyBtn.click({ force: true });
        }

        // 6. AGUARDAR E RESOLVER CAPTCHA PÓS-CLIQUE
        await log("wait", "6. Aguardando e resolvendo captcha após Comprar...");
        await page.waitForTimeout(1000);

        // Sempre executa solveCaptcha para capturar o desafio ativo ou token
        const captchaResolvido = await solveCaptcha(page, log);

        // Detectar modal de erro
        const alertModal = page.locator("#alert-modal, .modal").filter({ hasText: /validar sua ação/i });
        if (await alertModal.isVisible({ timeout: 3000 }).catch(() => false)) {
          const cancelBtn = alertModal.locator("button:has-text('Cancelar')").first();
          if (await cancelBtn.isVisible()) await cancelBtn.click();
          await log("warn", "⚠️ Modal de erro de segurança detectado. Recarregando e tentando novamente...");
          ticketFoundSector = "";
          await page.waitForTimeout(1000);
          continue; // continua o loop
        }

        // Aguarda redirect para o carrinho
        const cartTimeout = captchaResolvido ? 20000 : 15000;
        await page.waitForURL("**/shopping-cart**", { timeout: cartTimeout }).catch(() => {});

        if (page.url().includes("shopping-cart")) {
          await page.screenshot({ path: "ingresso-03-carrinho-sucesso.png" });
          await log("success", `✅ SUCESSO! Ingressos no carrinho! Setor: "${foundSectorStr}" · ${quantidade}x (Conta: ${email})`);
          await sendTelegramAlert(`🚨 *INGRESSO GARANTIDO!* 🚨\n\n🎟 **Setor:** ${foundSectorStr}\n🔢 **Quantidade:** ${quantidade}\n👤 **Conta:** ${email}\n⚽ **Evento:** ${eventData.id}`, log);
          await page.waitForTimeout(3000);
          purchaseSuccess = true;
          break; // Sucesso garantido: finaliza com vitória
        }

        // Se não foi para o carrinho, os ingressos desse setor foram reservados por outro torcedor
        ticketFoundSector = ""; // Reseta flag para não salvar vídeo falso
        await log("warn", `⚠️ Setor "${foundSectorStr}" não foi para o carrinho (reservado por outro torcedor ou esgotado). Continuando busca imediatamente...`);
        await page.screenshot({ path: "erro-carrinho-pos-captcha.png" });
        await page.waitForTimeout(1000);
        // NÃO dá break: o browser continua logado e tenta os próximos setores na próxima volta do loop!
      } else {
        const waitTime = config.intervalo || 3;
        
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
    if (purchaseSuccess && ticketFoundSector) {
      const videoLabel = ticketFoundSector.replace(/\s+/g, "-");
      await saveVideo(videoLabel);
    } else {
      // Se não comprou / não foi para o carrinho, descarta e deleta a gravação
      try {
        const videoPath = await page.video()?.path();
        await context.close().catch(() => {});
        if (videoPath && fs.existsSync(videoPath)) {
          try { fs.unlinkSync(videoPath); } catch {}
        }
      } catch {}
      discardVideos();
    }
  }

  return purchaseSuccess;
}

export async function runTestLogin() {}
