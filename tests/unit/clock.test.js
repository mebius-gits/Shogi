import test from "node:test";
import assert from "node:assert/strict";
import { GameClock } from "../../src/rules/clock.js";
test("Unlimited clock measures used time without flagging", () => {
  const c = new GameClock();
  assert.equal(c.charge(0, 1000000), false);
  assert.equal(c.display(0, 0), "∞");
  assert.equal(c.used[0], 1000000);
});
test("Main time spills into byoyomi; period resets each move", () => {
  const c = new GameClock(60, 10);
  assert.equal(c.charge(0, 65000), false);
  assert.equal(c.remaining[0], 0);
  assert.equal(c.period, 5000);
  assert.equal(c.display(0, 0), "00:05");
  c.nextTurn();
  assert.equal(c.period, 10000);
  assert.equal(c.charge(1, 2000), false);
  c.nextTurn();
  assert.equal(c.charge(0, 9999), false);
  assert.equal(c.charge(0, 1), true);
});
test("Clock snapshots restore independent values", () => {
  const c = new GameClock(300, 10);
  c.charge(0, 7000);
  const saved = c.serialize();
  const other = new GameClock(300, 10, saved);
  other.charge(0, 3000);
  assert.equal(c.remaining[0], 293000);
  assert.equal(other.remaining[0], 290000);
});
