// Playwright の薄いラッパ。HTML ではなく本文テキストだけを返す。
// LLM に HTML を渡さないという原則のため、ここで構造を落としておく。
import { chromium } from 'playwright';

const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 1_200;

export async function createFetcher() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  return {
    /** @param {string} url @returns {Promise<string>} */
    async fetchText(url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
      return page.evaluate(() => {
        document.querySelectorAll('script,style,noscript').forEach((e) => e.remove());
        return document.body.innerText.replace(/\n{3,}/g, '\n\n');
      });
    },
    async close() {
      await browser.close();
    },
  };
}
