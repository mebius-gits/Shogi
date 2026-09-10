import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
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
const BASE = "http://127.0.0.1:4174/";
async function open(path = "", { clock = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript(() => {
    if (!localStorage.getItem("sakurama-shogi-v2"))
      localStorage.setItem(
        "sakurama-shogi-v2",
        JSON.stringify({ prefs: { animation: false } }),
      );
  });
  const page = await context.newPage();
  if (clock) await page.clock.install();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await page.locator("#loading").waitFor({ state: "detached" });
  return { page, context };
}
const fixture = (sfen) => open("?sfen=" + encodeURIComponent(sfen));
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
    await page.locator('#hand-bottom [data-piece="P"]').click();
    assert.equal(
      await page
        .locator('[data-square="13"]')
        .evaluate((e) => e.classList.contains("legal")),
      false,
    );
    await page.locator('[data-square="13"]').click();
    assert.equal(await page.locator("#side-moves button").count(), 0);
    await context.close();
  }
  {
    const { page, context } = await fixture(
      "3lkl3/3p1p3/4G4/9/9/9/9/9/8K b R 1",
    );
    await page.locator('#hand-bottom [data-piece="R"]').click();
    await page.locator('[data-square="13"]').click();
    await expect(page.locator("#result-dialog")).toBeVisible();
    await expect(page.locator("#result-detail")).toContainText("詰み");
    await page.screenshot({ path: "docs/preview/checkmate.png", fullPage: true });
    await context.close();
  }
  {
    const { page, context } = await open("#/local", { clock: true });
    await page.locator('input[name="local-time"][value="300:10"] + span').click();
    await page.locator('#local-form button[type="submit"]').click();
    await expect(page.locator("#seat-bottom .clock")).toHaveText("05:00");
    await page.clock.fastForward("05:11");
    await expect(page.locator("#result-dialog")).toBeVisible();
    await expect(page.locator("#result-detail")).toContainText("讀秒");
    await context.close();
  }
  {
    const { page, context } = await open("#/cpu");
    await page.locator('input[name="cpu-side"][value="1"] + span').click();
    await page.locator('#cpu-form button[type="submit"]').click();
    await expect(page.locator("#side-moves button")).toHaveCount(1, {
      timeout: 8000,
    });
    await expect(page.locator('[data-square="24"]')).toBeEnabled();
    await context.close();
  }
  {
    const { page, context } = await open("#/cpu");
    await page.locator('input[name="cpu-side"][value="1"] + span').click();
    await page.locator('input[name="cpu-level"][value="3"] + span').click();
    await page.locator('#cpu-form button[type="submit"]').click();
    await page.locator(".brand").click();
    await page.locator("#confirm-yes").click();
    await page.locator('#home-page [data-page-link="local"]').click();
    await page.locator('#local-form button[type="submit"]').click();
    await page.waitForTimeout(2200);
    assert.equal(await page.locator("#side-moves button").count(), 0);
    await context.close();
  }
  {
    const { page, context } = await open("#/cpu");
    await page.locator('input[name="cpu-side"][value="0"] + span').click();
    await page.locator('#cpu-form button[type="submit"]').click();
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
