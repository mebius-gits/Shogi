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
await page.addInitScript(() => {
  const start = AudioBufferSourceNode.prototype.start;
  window.komaPlays = 0;
  AudioBufferSourceNode.prototype.start = function (...args) {
    if (this.buffer?.duration > 0) window.komaPlays++;
    return start.apply(this, args);
  };
});
const noHorizontalScroll = () =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function move(a, b) {
  await page.locator(`[data-square="${a}"]`).click();
  await page.locator(`[data-square="${b}"]`).click();
}
async function toHome() {
  await page.locator(".brand").click();
  if (await page.locator("#confirm-dialog").isVisible())
    await page.locator("#confirm-yes").click();
  await expect(page.locator("#home-page")).toBeVisible();
}
try {
  await page.goto("http://127.0.0.1:4174", { waitUntil: "networkidle" });
  await page.locator("#loading").waitFor({ state: "detached" });
  await expect(page.locator("#home-page")).toBeVisible();
  await expect(page).toHaveURL(/#\/home$/);
  assert.equal(await page.locator(".header [data-page-link]").count(), 0);
  await page.screenshot({ path: "docs/preview/redesign-home.png" });

  await page.locator('#home-page [data-page-link="cpu"]').click();
  await expect(page).toHaveURL(/#\/cpu$/);
  await page.screenshot({ path: "docs/preview/redesign-cpu.png" });
  await page.locator('#cpu-form button[type="submit"]').click();
  await expect(page.locator("#play-page")).toBeVisible();
  await expect(page.locator("#pause")).toBeVisible();
  await page.screenshot({ path: "docs/preview/redesign-desktop.png" });
  await move(56, 47);
  await expect(page.locator("#board-canvas")).toHaveAttribute(
    "data-phase",
    "carry",
  );
  await page.screenshot({ path: "docs/preview/redesign-hand.png" });
  await expect(page.locator("#side-moves button")).toHaveCount(2, {
    timeout: 15000,
  });
  await page.waitForFunction(() => window.komaPlays >= 1, null, {
    timeout: 10000,
  });
  await expect(page.locator("#side-moves button").first()).toBeDisabled();
  await expect(page.locator('[data-square="54"]')).toBeEnabled({
    timeout: 10000,
  });

  await page.locator(".brand").click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-no").click();
  await expect(page.locator("#play-page")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await page.locator("#confirm-no").click();
  await expect(page).toHaveURL(/#\/play$/);

  await page.locator("#settings-open").click();
  await expect(page.locator("#pause-overlay")).toBeVisible();
  await page.locator('[data-tab="room"]').click();
  await page.locator("#animation-setting").uncheck();
  await page.screenshot({ path: "docs/preview/redesign-settings.png" });
  await page.locator("#settings-close").click();
  await expect(page.locator("#pause-overlay")).toBeHidden();
  await toHome();

  await page.locator('#home-page [data-page-link="local"]').click();
  await page.locator("#local-name").fill("棋友");
  await page.locator('#local-form button[type="submit"]').click();
  await expect(page.locator("#seat-top .name")).toHaveText("棋友");
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
  await expect(page.locator(".rail-bottom .hand-count")).toHaveText("1 枚");
  await move(18, 27);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  for (const seat of ["top", "bottom"]) {
    const boxes = await page
      .locator(`#hand-${seat} button`)
      .evaluateAll((es) =>
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
          (seat === "top"
            ? b.bottom <= canvas.y
            : b.y >= canvas.y + canvas.height) &&
          b.y >= stage.y &&
          b.bottom <= stage.y + stage.height &&
          b.x >= stage.x &&
          b.right <= stage.x + stage.width,
      ),
      "Held pieces stay at their own end of the scene",
    );
  }
  const stage = await page.locator("#board-stage").boundingBox();
  const topAvatar = await page.locator("#seat-top .avatar").boundingBox(),
    bottomAvatar = await page.locator("#seat-bottom .avatar").boundingBox();
  assert.ok(
    topAvatar.x + topAvatar.width <= stage.x &&
      bottomAvatar.x >= stage.x + stage.width,
    "Avatars stay at the left and right of the board",
  );
  assert.ok(await noHorizontalScroll());
  await page.screenshot({ path: "docs/preview/redesign-mobile.png", fullPage: true });
  await page.locator('#hand-bottom [data-piece="P"]').click();
  await expect(page.locator('[data-square="46"]')).not.toHaveClass(/legal/);
  await page.locator('[data-square="29"]').click();
  await expect(page.locator(".rail-bottom .hand-count")).toHaveText("0 枚");
  await expect(page.locator("#side-moves button")).toHaveCount(9);
  await page.locator("#undo").click();
  await expect(page.locator("#side-moves button")).toHaveCount(8);
  await page.locator("#resign").click();
  await page.locator("#confirm-yes").click();
  await expect(page.locator("#result-dialog")).toBeVisible();
  await expect(page.locator("#result-title")).toContainText("獲勝");
  await page.locator("#result-review").click();
  await expect(page.locator(".after-actions")).toBeVisible();
  await page.locator("#side-moves button").first().click();
  await expect(page.locator("#replay-badge")).toBeVisible();
  await expect(page.locator('[data-square="54"]')).toBeDisabled();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-record").click();
  await (await downloadPromise).saveAs("docs/preview/redesign.kif");
  await page.locator("#replay-end").click();
  await expect(page.locator("#replay-badge")).toBeHidden();
  await page.locator("#go-home").click();
  await expect(page.locator("#home-page")).toBeVisible();
  assert.ok(await noHorizontalScroll());
  await page.screenshot({
    path: "docs/preview/redesign-home-mobile.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#profile-edit").click();
  await page.locator("#profile-name").fill("櫻花棋士");
  await page.locator("#avatar-file").setInputFiles("assets/images/koharu.png");
  await expect(page.locator("#profile-avatar img")).toHaveAttribute(
    "src",
    /^data:/,
  );
  await page.locator('#profile-form button[type="submit"]').click();
  await expect(page.locator("#settings-dialog")).toBeHidden();
  await expect(page.locator("#home-name")).toHaveText("櫻花棋士");
  await page.locator("#settings-open").click();
  await page.locator('[data-tab="room"]').click();
  await page.locator('[data-theme="night"]').click();
  await page.locator("#shadow-toggle").click();
  await expect(page.locator("#shadow-toggle")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.locator("#shadow-toggle").click();
  await page.locator("#settings-close").click();
  await expect(page.locator("#home-name")).toHaveText("櫻花棋士");
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#loading").waitFor({ state: "detached" });
  await expect(page.locator("#home-page")).toBeVisible();
  await expect(page.locator("#home-name")).toHaveText("櫻花棋士");
  await expect(page.locator("#home-avatar img")).toHaveAttribute(
    "src",
    /^data:/,
  );
  await expect(page.locator("body")).toHaveAttribute("data-theme", "night");

  await page.locator('#home-page [data-page-link="cpu"]').click();
  await page.locator('input[name="cpu-side"][value="1"] + span').click();
  await page.locator('#cpu-form button[type="submit"]').click();
  await expect(page.locator("#seat-bottom .name")).toHaveText("櫻花棋士");
  await expect(page.locator("#seat-bottom .side-name")).toHaveText("後手");
  await expect(page.locator("#side-moves button")).toHaveCount(1, {
    timeout: 15000,
  });
  const corner = await page.locator('[data-square="0"]').boundingBox(),
    canvasBox = await page.locator("#board-canvas").boundingBox();
  assert.ok(
    corner.y > canvasBox.y + canvasBox.height / 2 &&
      corner.x > canvasBox.x + canvasBox.width / 2,
    "Playing Gote turns the board toward the player",
  );
  await expect(page.locator("#board-canvas")).toHaveAttribute(
    "data-phase",
    "idle",
    { timeout: 10000 },
  );
  await page.screenshot({ path: "docs/preview/redesign-night.png" });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  const canvas = page.locator("#board-canvas canvas"),
    before = await canvas.screenshot({ path: "docs/preview/camera-before.png" }),
    bounds = await canvas.boundingBox();
  await page.mouse.move(bounds.x + 4, bounds.y + 4);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 20, bounds.y + 15, { steps: 5 });
  await page.mouse.up();
  const after = await canvas.screenshot({ path: "docs/preview/camera-after.png" });
  const changed = await page.evaluate(
    async (sources) => {
      const images = await Promise.all(
        sources.map(
          (src) =>
            new Promise((resolve) => {
              const image = new Image();
              image.onload = () => resolve(image);
              image.src = src;
            }),
        ),
      );
      const { width, height } = images[0];
      const ctx = new OffscreenCanvas(width, height).getContext("2d");
      const pixels = images.map((image) => {
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, width, height).data;
      });
      let count = 0;
      for (let i = 0; i < pixels[0].length; i += 4)
        if (
          Math.abs(pixels[0][i] - pixels[1][i]) +
            Math.abs(pixels[0][i + 1] - pixels[1][i + 1]) +
            Math.abs(pixels[0][i + 2] - pixels[1][i + 2]) >
          30
        )
          count++;
      return count / (width * height);
    },
    [before, after].map((b) => "data:image/png;base64," + b.toString("base64")),
  );
  assert.ok(changed < 0.001, "Dragging cannot move the fixed camera");
  await page.locator("#settings-open").click();
  await page.locator('[data-tab="room"]').click();
  await page.locator("#animation-setting").check();
  await page.locator("#settings-close").click();
  await move(24, 33);
  await expect(page.locator("#board-canvas")).toHaveAttribute(
    "data-phase",
    "carry",
  );
  await page.screenshot({ path: "docs/preview/redesign-opponent-hand.png" });
  await expect(page.locator("#board-canvas")).toHaveAttribute(
    "data-phase",
    "idle",
    { timeout: 10000 },
  );
  await page.setViewportSize({ width: 320, height: 720 });
  await page.waitForTimeout(150);
  assert.ok(await noHorizontalScroll());
  assert.deepEqual(errors, []);
  console.log(
    "PASS: home/setup flow, no header record link, leave guard, settings sheet pauses offline play, local promotion/drop/undo/resign, post-game review and KIF, mobile layout, profile/theme persistence, Gote board flip and fixed camera.",
  );
} finally {
  await browser.close();
}
