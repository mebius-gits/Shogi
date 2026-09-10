import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { Game } from "../engine.js";
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: [
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--enable-unsafe-swiftshader",
  ],
});
const errors = [];
async function fixture(sfen, extras = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const data = {
    game: new Game(sfen).serialize(),
    config: {
      mode: "local",
      humanSide: 0,
      level: 2,
      main: 0,
      byoyomi: 0,
      ...extras.config,
    },
    prefs: { animation: false },
    profiles: [
      { name: "旅人", avatar: "" },
      { name: "小春", avatar: "koharu" },
    ],
    ...extras,
  };
  if (extras.config)
    data.config = {
      mode: "local",
      humanSide: 0,
      level: 2,
      main: 0,
      byoyomi: 0,
      ...extras.config,
    };
  await context.addInitScript((data) => {
    localStorage.setItem("sakurama-shogi-v1", JSON.stringify(data));
  }, data);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:4174", { waitUntil: "networkidle" });
  await page.locator("#loading").waitFor({ state: "detached" });
  await page.locator("#resume").click();
  return { page, context };
}
try {
  {
    const { page, context } = await fixture("k8/4P4/9/9/9/9/9/9/8K b - 1");
    await page.locator('[data-square="13"]').click();
    await page.locator('[data-square="4"]').click();
    await expect(page.locator('[data-square="4"]')).toHaveAttribute(
      "aria-label",
      /と/,
    );
    assert.equal(await page.locator("#promote-dialog").isVisible(), false);
    await context.close();
  }
  {
    const { page, context } = await fixture("k8/4S4/9/9/9/9/9/9/8K b - 1");
    await page.locator('[data-square="13"]').click();
    await page.locator('[data-square="23"]').click();
    await expect(page.locator("#promote-dialog")).toBeVisible();
    await page.locator("#promote-no").click();
    await expect(page.locator('[data-square="23"]')).toHaveAttribute(
      "aria-label",
      /銀/,
    );
    await context.close();
  }
  {
    const { page, context } = await fixture(
      "3lkl3/3p1p3/4G4/9/9/9/9/9/8K b P 1",
    );
    await page.locator('#hand-0 [data-piece="P"]').click();
    assert.equal(
      await page
        .locator('[data-square="13"]')
        .evaluate((e) => e.classList.contains("legal")),
      false,
    );
    await page.locator('[data-square="13"]').click();
    assert.equal(await page.locator("#move-list button").count(), 0);
    await context.close();
  }
  {
    const { page, context } = await fixture(
      "3lkl3/3p1p3/4G4/9/9/9/9/9/8K b R 1",
    );
    await page.locator('#hand-0 [data-piece="R"]').click();
    await page.locator('[data-square="13"]').click();
    await expect(page.locator("#result-dialog")).toBeVisible();
    await expect(page.locator("#result-detail")).toContainText("詰み");
    await page.screenshot({ path: "preview/checkmate.png", fullPage: true });
    await context.close();
  }
  {
    const { page, context } = await fixture(undefined, {
      config: { main: 300, byoyomi: 10 },
      clock: { remaining: [1, 300000], period: 1, used: [0, 0] },
    });
    await expect(page.locator("#result-dialog")).toBeVisible();
    await expect(page.locator("#result-detail")).toContainText("讀秒");
    await context.close();
  }
  {
    const { page, context } = await fixture(undefined, {
      config: { mode: "ai", humanSide: 1 },
    });
    await expect(page.locator("#move-list button")).toHaveCount(1, {
      timeout: 8000,
    });
    await expect(page.locator('[data-square="24"]')).toBeEnabled();
    await context.close();
  }
  {
    const { page, context } = await fixture(undefined, {
      config: { mode: "ai", humanSide: 1, level: 3 },
    });
    await page.locator(".menu-open").click();
    await page.locator("#new-game").click();
    await page.locator("#new-mode").selectOption("local");
    await page.locator('#new-form button[type="submit"]').click();
    await page.waitForTimeout(2200);
    assert.equal(await page.locator("#move-list button").count(), 0);
    await context.close();
  }
  {
    const { page, context } = await fixture();
    await page.locator("#hint").click();
    await expect(page.locator("#status-title")).toHaveText("試試這一步", {
      timeout: 8000,
    });
    assert.ok((await page.locator(".square-input.legal").count()) > 0);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: mandatory/declined promotion, illegal pawn-drop mate, checkmate UI, timeout, human as Gote, stale AI cancellation, legal hint.",
  );
} finally {
  await browser.close();
}
