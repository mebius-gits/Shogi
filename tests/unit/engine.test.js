import test from "node:test";
import assert from "node:assert/strict";
import {
  Game,
  fromSFEN,
  toSFEN,
  INITIAL_SFEN,
  legalMoves,
  applyUnchecked,
  destinations,
  inCheck,
  emptyHands,
  repetitionResult,
  declaration,
  toUSI,
} from "../../src/rules/engine.js";
import { chooseMove } from "../../src/ai/ai.js";
const piece = (type, side = 0, promoted = false) => ({ type, side, promoted });
const position = (items = [], turn = 0) => {
  const p = { board: Array(81).fill(null), hands: emptyHands(), turn, ply: 1 };
  p.board[0] = piece("K", 1);
  p.board[80] = piece("K");
  for (const [i, t, s = 0, pr = false] of items) p.board[i] = piece(t, s, pr);
  return p;
};
const has = (p, from, to, promote = false) =>
  legalMoves(p).some(
    (m) => m.from === from && m.to === to && m.promote === promote,
  );
test("Initial setup, serialization, legal move counts and perft", () => {
  const p = fromSFEN();
  assert.equal(toSFEN(p), INITIAL_SFEN);
  assert.equal(p.board.filter(Boolean).length, 40);
  assert.equal(legalMoves(p).length, 30);
  const perft = (p, d) =>
    d
      ? legalMoves(p).reduce(
          (n, m) => n + perft(applyUnchecked(p, m), d - 1),
          0,
        )
      : 1;
  assert.equal(perft(p, 2), 900);
  assert.equal(perft(p, 3), 25470);
});
test("All eight piece movements and both orientations", () => {
  const expected = {
    P: [31],
    L: [31, 22, 13, 4],
    N: [21, 23],
    S: [30, 31, 32, 48, 50],
    G: [30, 31, 32, 39, 41, 49],
    K: [30, 31, 32, 39, 41, 48, 49, 50],
  };
  for (const [type, squares] of Object.entries(expected)) {
    for (const side of [0, 1]) {
      const p = position([[40, type, side]]);
      assert.deepEqual(
        destinations(p, 40).sort((a, b) => a - b),
        (side ? squares.map((i) => 80 - i) : squares).sort((a, b) => a - b),
        type + side,
      );
    }
  }
  const r = position([[40, "R"]]),
    b = position([[40, "B"]]);
  assert.equal(destinations(r, 40).length, 16);
  assert.equal(destinations(b, 40).length, 15);
});
test("Blockers stop sliders, knights jump, own pieces cannot be captured", () => {
  const p = position([
    [40, "R"],
    [31, "P"],
    [42, "P", 1],
  ]);
  assert.ok(!destinations(p, 40).includes(31));
  assert.ok(!destinations(p, 40).includes(22));
  assert.ok(destinations(p, 40).includes(42));
  assert.ok(!destinations(p, 40).includes(43));
  p.board[40] = piece("N");
  assert.ok(destinations(p, 40).includes(21));
});
test("Promotion entering, within and leaving zone; mandatory dead-rank promotion", () => {
  let p = position([[31, "P"]]);
  assert.ok(has(p, 31, 22, true));
  assert.ok(has(p, 31, 22, false));
  p = position([[13, "S"]]);
  assert.ok(has(p, 13, 23, true));
  assert.ok(has(p, 13, 23, false));
  p = position([[13, "P"]]);
  assert.ok(has(p, 13, 4, true));
  assert.ok(!has(p, 13, 4, false));
  p = position([[22, "N"]]);
  assert.ok(has(p, 22, 3, true));
  assert.ok(!has(p, 22, 3, false));
  p = position([[40, "P"]]);
  assert.ok(!has(p, 40, 31, true));
});
test("All six promoted pieces move correctly and never demote on board", () => {
  for (const type of ["P", "L", "N", "S"]) {
    const p = position([[40, type, 0, true]]);
    assert.deepEqual(
      destinations(p, 40).sort(),
      destinations(position([[40, "G"]]), 40).sort(),
    );
  }
  assert.equal(destinations(position([[40, "R", 0, true]]), 40).length, 20);
  assert.equal(destinations(position([[40, "B", 0, true]]), 40).length, 19);
});
test("Capture returns base piece to capturer hand and changes turn", () => {
  const p = position([
    [40, "R"],
    [31, "S", 1, true],
  ]);
  const n = applyUnchecked(p, { from: 40, to: 31, promote: false });
  assert.equal(n.hands[0].S, 1);
  assert.equal(n.turn, 1);
  assert.equal(n.board[31].type, "R");
  assert.equal(p.hands[0].S, 0);
});
test("Drop inventory, occupied squares, nifu, dead ranks, and no promoted drops", () => {
  const p = position([[40, "P"]]);
  p.hands[0].P = 1;
  p.hands[0].N = 1;
  p.hands[0].L = 1;
  const moves = legalMoves(p);
  assert.ok(!moves.some((m) => m.drop === "P" && m.to % 9 === 4));
  assert.ok(!moves.some((m) => m.drop === "P" && m.to < 9));
  assert.ok(!moves.some((m) => m.drop === "N" && m.to < 18));
  assert.ok(!moves.some((m) => m.drop === "L" && m.to < 9));
  assert.ok(!moves.some((m) => m.drop && m.to === 40));
  assert.ok(!moves.some((m) => m.drop && m.promote));
  p.board[40].promoted = true;
  assert.ok(legalMoves(p).some((m) => m.drop === "P" && m.to === 49));
  const m = legalMoves(p).find((m) => m.drop === "P");
  const n = applyUnchecked(p, m);
  assert.equal(n.hands[0].P, 0);
  assert.equal(n.board[m.to].promoted, false);
});
test("Pawn-drop mate prohibited, checking pawn drops with escape permitted", () => {
  const p = position([
    [4, "K", 1],
    [3, "L", 1],
    [5, "L", 1],
    [12, "P", 1],
    [14, "P", 1],
    [22, "G"],
  ]);
  p.board[0] = null;
  p.hands[0].P = 1;
  assert.ok(!legalMoves(p).some((m) => m.drop === "P" && m.to === 13));
  p.board[5] = null;
  assert.ok(legalMoves(p).some((m) => m.drop === "P" && m.to === 13));
});
test("Pinned piece cannot expose own king; king cannot move into check or capture king", () => {
  const p = position([
    [76, "K"],
    [67, "G"],
    [4, "R", 1],
  ]);
  p.board[80] = null;
  assert.ok(!has(p, 67, 66));
  assert.ok(has(p, 67, 58));
  p.board[67] = null;
  assert.ok(inCheck(p));
  assert.ok(!has(p, 76, 67));
  assert.ok(legalMoves(p).every((m) => !inCheck(applyUnchecked(p, m), 0)));
  const q = position([[9, "R"]]);
  assert.ok(!legalMoves(q).some((m) => m.to === 0));
});
test("Drop can block a check", () => {
  const p = position([
    [76, "K"],
    [4, "R", 1],
  ]);
  p.board[80] = null;
  p.hands[0].G = 1;
  assert.ok(legalMoves(p).some((m) => m.drop === "G" && m.to === 40));
  assert.ok(!legalMoves(p).some((m) => m.drop === "G" && m.to === 41));
});
test("Fourfold repetition includes side and hands; perpetual checker loses", () => {
  const g = new Game("k8/9/9/9/9/9/9/9/8K b - 1");
  for (let k = 0; k < 3; k++)
    for (const [from, to] of [
      [80, 79],
      [0, 1],
      [79, 80],
      [1, 0],
    ])
      g.play({ from, to, promote: false });
  assert.deepEqual(g.result, { winner: null, reason: "repetition" });
  const t = [{ key: "A" }];
  for (let i = 0; i < 3; i++)
    t.push(
      { key: "B", mover: 0, check: true },
      { key: "A", mover: 1, check: false },
    );
  assert.deepEqual(repetitionResult(t), {
    winner: 1,
    reason: "perpetual-check",
  });
  t[1].check = false;
  assert.equal(repetitionResult(t).winner, null);
});
test("Checkmate ends game and prohibits further moves", () => {
  const g = new Game("3lkl3/3p1p3/4G4/9/9/9/9/9/8K b R 1");
  g.play({ drop: "R", to: 13, promote: false });
  assert.equal(g.result?.reason, "checkmate");
  assert.equal(g.result.winner, 0);
  assert.equal(g.moves().length, 0);
  assert.throws(() => g.play({ drop: "R", to: 14 }));
});
test("Undo, validated restore, resignation, and illegal-move rejection", () => {
  const g = new Game();
  assert.throws(() => g.play({ from: 54, to: 36 }));
  assert.equal(g.history.length, 0);
  g.play({ from: 56, to: 47, promote: false });
  const saved = g.serialize();
  assert.equal(toSFEN(Game.restore(saved).position), toSFEN(g.position));
  assert.ok(g.undo());
  assert.equal(toSFEN(g.position), INITIAL_SFEN);
  g.resign(0);
  assert.equal(g.result.winner, 1);
  assert.throws(() => Game.restore({ ...saved, moves: [{ from: 0, to: 80 }] }));
});
test("27-point entering-king declaration requires king, ten pieces, points and no check", () => {
  const p = position();
  p.board[80] = null;
  p.board[4] = piece("K");
  p.board[0] = null;
  p.board[76] = piece("K", 1);
  for (const i of [9, 10, 11, 12, 13, 14, 15, 16, 17, 18])
    p.board[i] = piece("P");
  p.hands[0].R = 2;
  p.hands[0].B = 2;
  assert.equal(declaration(p).eligible, true);
  p.hands[0].B = 0;
  assert.equal(declaration(p).eligible, false);
  p.hands[0].B = 2;
  p.board[18] = null;
  assert.equal(declaration(p).eligible, false);
});
test("Computer returns a legal move and sees a one-move mate", () => {
  const p = fromSFEN("3lkl3/3p1p3/4G4/9/9/9/9/9/8K b R 1");
  const answer = chooseMove(p, { depth: 2, timeMs: 500 });
  assert.ok(legalMoves(p).some((m) => toUSI(m) === toUSI(answer.move)));
  const next = applyUnchecked(p, answer.move);
  assert.ok(inCheck(next));
  assert.equal(legalMoves(next).length, 0);
});
