#!/usr/bin/env node
/** 双语截图：对已种子的演示库拍 6 张（zh/en × 书架侧视/时间轴/阅读器），供落地页使用。
 *
 * 前置：scripts/demo-seed.mjs 已灌库；本地首次运行先 `npx playwright install chromium`。
 * 用法：node scripts/shoot-screens.mjs [baseURL=http://127.0.0.1:8901] [outDir=site/assets]
 * CI（pages.yml）与本地拍摄共用本脚本；产物不入库（.gitignore site/assets/）。 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:8901";
const OUT = process.argv[3] ?? "site/assets";
const VIEWPORT = { width: 1440, height: 900 };

/** 字体就绪即返回（截图前统一走一遍，避免 Noto CJK 晚到）。 */
const fontsReady = (page) => page.evaluate(() => document.fonts.ready.then(() => undefined));

async function shootLang(browser, lang) {
  const dir = lang === "en" ? join(OUT, "en") : OUT;
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  // 首帧前写好语言偏好：登录页/界面/服务端消息（Accept-Language 由前端带上）全程一致
  await context.addInitScript((l) => localStorage.setItem("zzlib:lang", l), lang);
  const page = await context.newPage();

  console.log(`[${lang}] 登录`);
  await page.goto(`${BASE}/login`);
  await page.locator('input[autocomplete="username"]').fill("admin");
  await page.locator('input[type="password"]').fill("zzlibrary");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.endsWith("/login"));

  console.log(`[${lang}] ① 书架侧视`);
  await page.goto(`${BASE}/shelves/1`); // 种子库首个一级分类「历史」
  const rack = page.getByRole("button", { name: /中国史/ });
  await rack.waitFor({ state: "visible" });
  await fontsReady(page);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(dir, "shelf.png") });

  console.log(`[${lang}] ② 时间轴长卷`);
  await rack.click();
  await fontsReady(page);
  await page.waitForTimeout(1800); // 书脊/封面贴图与长卷滚动就位
  await page.screenshot({ path: join(dir, "timeline.png") });

  console.log(`[${lang}] ③ 阅读器`);
  const zh = lang === "zh";
  const title = zh ? "论语" : "Meditations";
  await page.goto(`${BASE}/packages?q=${encodeURIComponent(title)}`);
  // 点封面开详情弹窗（点标题只是行内展开，文件列表在弹窗里；封面 img 无 alt，按 src 定位）
  const cover = page.locator('main img[src$="/cover"]');
  await cover.waitFor({ state: "visible" });
  await cover.click();
  const fileRow = page.getByText(zh ? "论语·学而.txt" : "Meditations · Excerpts.txt", { exact: true });
  await fileRow.waitFor({ state: "visible" });
  await fileRow.click();
  await page.getByText(zh ? "学而时习之" : "Look within").first().waitFor({ state: "visible" });
  await fontsReady(page);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(dir, "reader.png") });

  await context.close();
}

const browser = await chromium.launch();
try {
  await shootLang(browser, "zh");
  await shootLang(browser, "en");
  console.log(`完成：${OUT}/{,en/}{shelf,timeline,reader}.png 共 6 张`);
} finally {
  await browser.close();
}
