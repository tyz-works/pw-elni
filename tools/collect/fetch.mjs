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
    // リンクは innerText に現れないので別に取る。fetchText の戻りから
    // URL を正規表現で拾おうとすると構造上 0 件になる。
    /** @param {string} url @returns {Promise<string[]>} 絶対 URL の配列 */
    async fetchLinks(url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
      return page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href));
    },
    async close() {
      await browser.close();
    },
  };
}
