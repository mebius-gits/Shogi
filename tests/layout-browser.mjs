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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto("http://127.0.0.1:4174", { waitUntil: "networkidle" });
  await page.locator("#loading").waitFor({ state: "detached" });
  await page.screenshot({
    path: "preview/redesign-desktop.png",
    fullPage: true,
  });
  await page.locator('[data-square="56"]').click();
  await expect(page.locator('[data-square="47"]')).toHaveClass(/legal/);
  await page.locator('[data-square="47"]').click();
  await expect(page.locator("#board-canvas")).toHaveAttribute(
    "data-phase",
    "carry",
  );
  await page.screenshot({ path: "preview/redesign-hand.png", fullPage: true });
  await expect(page.locator("#move-list button")).toHaveCount(2, {
    timeout: 15000,
  });
  await expect(page.locator('[data-square="54"]')).toBeEnabled({
    timeout: 10000,
  });
  await page.locator(".menu-open").click();
  await expect(page.locator("#menu-page")).toBeVisible();
  await expect(page.locator("#play-page")).toBeHidden();
  await page.screenshot({ path: "preview/redesign-menu.png", fullPage: true });
  await page.locator("#settings-open").click();
  await expect(page).toHaveURL(/#\/settings$/);
  await page.locator("#animation-setting").uncheck();
  await page.screenshot({
    path: "preview/redesign-settings.png",
    fullPage: true,
  });
  await page.goBack();
  await expect(page.locator("#menu-page")).toBeVisible();
  await page.locator("#new-game").click();
  await page.locator("#new-mode").selectOption("local");
  await page.locator('#new-form button[type="submit"]').click();
  async function move(a, b) {
    await page.locator(`[data-square="${a}"]`).click();
    await page.locator(`[data-square="${b}"]`).click();
  }
  for (const [a, b] of [
    [56, 47],
    [24, 33],
    [47, 38],
    [33, 42],
    [38, 29],
    [42, 51],
    [29, 20],
  ])
    await move(a, b);
  await page.locator("#promote-yes").click();
  await expect(page.locator("#hand-count-0")).toHaveText("1 枚");
  await move(18, 27);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  for (const side of [0, 1]) {
    const boxes = await page.locator(`#hand-${side} button`).evaluateAll((es) =>
      es.map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
      }),
    );
    assert.equal(boxes.length, 7);
    assert.ok(boxes.every((b) => Math.abs(b.y - boxes[0].y) < 1));
    assert.ok(boxes.every((b, i) => !i || b.x >= boxes[i - 1].right));
    const stage = await page.locator("#board-stage").boundingBox();
    const canvas = await page.locator("#board-canvas").boundingBox();
    assert.ok(
      boxes.every(
        (b) =>
          (side ? b.bottom <= canvas.y : b.y >= canvas.y + canvas.height) &&
          b.y >= stage.y &&
          b.bottom <= stage.y + stage.height &&
          b.x >= stage.x &&
          b.right <= stage.x + stage.width,
      ),
      "Held pieces stay at their own end: Gote above, Sente below, inside the scene",
    );
  }
  const stage = await page.locator("#board-stage").boundingBox();
  const leftAvatar = await page.locator("#avatar-1").boundingBox(),
    rightAvatar = await page.locator("#avatar-0").boundingBox();
  assert.ok(
    leftAvatar.x + leftAvatar.width <= stage.x &&
      rightAvatar.x >= stage.x + stage.width,
    "Avatars stay at the left and right of the board",
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: "preview/redesign-mobile.png",
    fullPage: true,
  });
  await page.locator('#hand-0 [data-piece="P"]').click();
  await expect(page.locator('[data-square="46"]')).not.toHaveClass(/legal/);
  await page.locator('[data-square="29"]').click();
  await expect(page.locator("#hand-count-0")).toHaveText("0 枚");
  await page.locator(".menu-open").click();
  await page.locator('#menu-page [data-page-link="players"]').click();
  await page.locator('[data-profile="0"]').click();
  await page.locator("#profile-name").fill("櫻花棋士");
  await page.locator("#avatar-file").setInputFiles("assets/koharu.png");
  await expect(page.locator("#profile-avatar img")).toHaveAttribute(
    "src",
    /^data:/,
  );
  await page.locator('#profile-form button[type="submit"]').click();
  await expect(page.locator("#preview-name-0")).toHaveText("櫻花棋士");
  await page.locator(".menu-open").click();
  await page.locator("#continue-game").click();
  await expect(page.locator("#name-0")).toHaveText("櫻花棋士");
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#loading").waitFor({ state: "detached" });
  await expect(page.locator("#name-0")).toHaveText("櫻花棋士");
  await expect(page.locator("#move-list button")).toHaveCount(9);
  await expect(page.locator("#avatar-0 img")).toHaveAttribute("src", /^data:/);
  await page.locator("#resume").click();
  await page.locator('.header-actions [data-page-link="record"]').click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-record").click();
  await (await downloadPromise).saveAs("preview/redesign.kif");
  await page.locator("#move-list button").first().click();
  await expect(page.locator("#replay-badge")).toBeVisible();
  await expect(page.locator('[data-square="54"]')).toBeDisabled();
  await page.locator("#return-live").click();
  await expect(page.locator("#pause-overlay")).toBeHidden();
  await page.locator("#undo").click();
  await expect(page.locator("#move-list button")).toHaveCount(8);
  await page.locator(".menu-open").click();
  await page.locator("#resign").click();
  await page.locator("#confirm-yes").click();
  await expect(page.locator("#result-dialog")).toBeVisible();
  await page.locator("#result-review").click();
  await page.locator(".menu-open").click();
  await page.locator("#new-game").click();
  await page.locator('#new-form button[type="submit"]').click();
  await page.locator(".menu-open").click();
  await page.locator("#settings-open").click();
  await page.locator('[data-theme="night"]').click();
  await page.locator("#shadow-toggle").click();
  await expect(page.locator("#shadow-toggle")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.locator("#shadow-toggle").click();
  await page.locator("#animation-setting").check();
  await page.locator(".menu-open").click();
  await page.locator("#continue-game").click();
  await expect(page.locator("body")).toHaveAttribute("data-theme", "night");
  await page.screenshot({ path: "preview/redesign-night.png", fullPage: true });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250); // Allow the previous square's hover fade to finish.
  const canvas = page.locator("#board-canvas canvas"),
    before = await canvas.screenshot({ path: "preview/camera-before.png" }),
    bounds = await canvas.boundingBox();
  await page.mouse.move(bounds.x + 4, bounds.y + 4);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 20, bounds.y + 15, { steps: 5 });
  await page.mouse.up();
  assert.ok(
    before.equals(
      await canvas.screenshot({ path: "preview/camera-after.png" }),
    ),
    "Dragging cannot move the fixed camera",
  );
  await move(56, 47);
  await expect(page.locator("#board-canvas")).toHaveAttribute(
    "data-phase",
    "idle",
  );
  await move(24, 33);
  await expect(page.locator("#board-canvas")).toHaveAttribute(
    "data-phase",
    "carry",
  );
  await page.screenshot({
    path: "preview/redesign-opponent-hand.png",
    fullPage: true,
  });
  await expect(page.locator("#board-canvas")).toHaveAttribute(
    "data-phase",
    "idle",
  );
  await page.setViewportSize({ width: 320, height: 720 });
  await page.waitForTimeout(150);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: desktop/mobile layout, horizontal capture rows inside scene, side avatars, both hand animations, promotion/drop, routes/back, profiles/save restoration, KIF, replay, undo, resign, themes/shadows and fixed camera.",
  );
} finally {
  await browser.close();
}
