const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth");

chromium.use(stealth());

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log("Navegando para o evento 39297...");
  await page.goto("https://www.futebolcard.com/buy/sector?event=39297", { waitUntil: "networkidle" });
  
  console.log("URL final:", page.url());
  
  await browser.close();
})();
