const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth");

chromium.use(stealth());

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  page.on("console", msg => {
    console.log(`[CONSOLE] ${msg.type()}: ${msg.text()}`);
  });

  page.on("response", async res => {
    const url = res.url();
    if (url.includes("futebolcard") && (url.includes("api") || url.includes("ticket") || url.includes("sector") || url.includes("get"))) {
      console.log(`[NETWORK] ${res.status()} ${url}`);
      try {
        const body = await res.text();
        console.log(`[BODY] ${url} -> ${body.slice(0, 150)}...`);
      } catch (e) {}
    }
  });

  console.log("Navegando para o evento 39297...");
  await page.goto("https://www.futebolcard.com/buy/sector?event=39297", { waitUntil: "networkidle" });
  
  await page.waitForTimeout(5000);
  await browser.close();
})();
