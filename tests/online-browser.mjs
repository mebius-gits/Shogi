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
async function player(name) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
  });
  await context.addInitScript((name) => {
    localStorage.setItem(
      "sakurama-shogi-v2",
      JSON.stringify({
        prefs: { animation: false },
        profile: { name, avatar: "" },
        room: { time: "300:10", side: "0" },
      }),
    );
  }, name);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto("http://127.0.0.1:4174/#/online", {
    waitUntil: "networkidle",
  });
  await page.locator("#loading").waitFor({ state: "detached" });
  await expect(page.locator("#net-status")).toHaveAttribute(
    "data-state",
    "online",
    { timeout: 15000 },
  );
  return { page, context };
}
async function move(page, a, b) {
  await page.locator(`[data-square="${a}"]`).click();
  await page.locator(`[data-square="${b}"]`).click();
}
const net = { timeout: 15000 };
try {
  const host = await player("房主"),
    guest = await player("訪客");
  await host.page.locator('#create-form button[type="submit"]').click();
  const code = host.page.locator("#room-code-display");
  await expect(code).toHaveText(/^[A-Z2-9]{5}$/, net);
  await host.page.screenshot({ path: "preview/online-waiting.png" });
  await guest.page.locator("#room-code-input").fill(await code.textContent());
  await guest.page.locator('#join-form button[type="submit"]').click();
  for (const { page } of [host, guest]) {
    await expect(page.locator("#play-page")).toBeVisible(net);
    await expect(page.locator("#hint")).toBeHidden();
    await expect(page.locator("#undo")).toBeHidden();
    await expect(page.locator("#pause")).toBeHidden();
  }
  await expect(host.page.locator("#seat-top .name")).toHaveText("訪客");
  await expect(guest.page.locator("#seat-top .name")).toHaveText("房主");
  await expect(guest.page.locator("#seat-bottom .side-name")).toHaveText(
    "後手",
  );
  await expect(host.page.locator("#seat-bottom .clock")).toHaveText("05:00");

  await move(host.page, 56, 47);
  await expect(guest.page.locator("#side-moves button")).toHaveCount(1, net);
  await expect(guest.page.locator("#last-move")).toHaveText("▲7六歩");
  await move(guest.page, 20, 29);
  await expect(host.page.locator("#side-moves button")).toHaveCount(2, net);
  await host.page.screenshot({ path: "preview/online-host.png" });
  await guest.page.screenshot({ path: "preview/online-guest.png" });
  await move(host.page, 47, 38);
  await expect(guest.page.locator("#side-moves button")).toHaveCount(3, net);

  await guest.page.locator("#resign").click();
  await guest.page.locator("#confirm-yes").click();
  await expect(guest.page.locator("#result-title")).toHaveText("敗北");
  await expect(host.page.locator("#result-dialog")).toBeVisible(net);
  await expect(host.page.locator("#result-title")).toHaveText("勝利");

  await host.page.locator("#result-again").click();
  await expect(guest.page.locator("#result-again")).toHaveText(
    "接受再戰",
    net,
  );
  await guest.page.locator("#result-again").click();
  await expect(host.page.locator("#side-moves .empty-record")).toBeVisible(
    net,
  );
  await expect(host.page.locator("#seat-bottom .side-name")).toHaveText(
    "後手",
    net,
  );
  await expect(guest.page.locator("#seat-bottom .side-name")).toHaveText(
    "先手",
    net,
  );
  await move(guest.page, 56, 47);
  await expect(host.page.locator("#side-moves button")).toHaveCount(1, net);

  await host.page.locator(".brand").click();
  await expect(host.page.locator("#confirm-description")).toContainText(
    "投了",
  );
  await host.page.locator("#confirm-yes").click();
  await expect(host.page.locator("#home-page")).toBeVisible();
  await expect(guest.page.locator("#result-title")).toHaveText("勝利", net);
  await expect(guest.page.locator("#result-again")).toBeDisabled(net);

  const solo = await player("單人");
  await solo.page.locator("#room-code-input").fill("ZZZZ2");
  await solo.page.locator('#join-form button[type="submit"]').click();
  await expect(solo.page.locator("#join-error")).toHaveText(
    "找不到這個房間。",
    net,
  );
  for (const p of [host, guest, solo]) await p.context.close();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: MQTT room create/join, synced moves and clocks, no assists online, resign result on both sides, rematch with swapped sides, leaving counts as resign, missing room error.",
  );
} finally {
  await browser.close();
}
