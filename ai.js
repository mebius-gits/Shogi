import {
  legalMoves,
  applyUnchecked,
  inCheck,
  row,
  col,
  moveKey,
  declaration,
} from "./engine.js";
// Piece values from Koji Tanigawa's table (pawn = 1, scaled by 100):
// P1 L3 N4 S5 G6 B8 R10, tokin 7, promoted L/N/S 6, horse 10, dragon 12.
// The king has no material value; checkmate is scored by the search.
const VALUES = {
  P: 100,
  L: 300,
  N: 400,
  S: 500,
  G: 600,
  B: 800,
  R: 1000,
  K: 0,
};
const PROMOTED = { P: 700, L: 600, N: 600, S: 600, B: 1000, R: 1200 };
export function evaluate(p) {
  let score = 0;
  for (let i = 0; i < 81; i++) {
    const a = p.board[i];
    if (!a) continue;
    let value = a.promoted ? PROMOTED[a.type] : VALUES[a.type];
    const progress = a.side ? row(i) : 8 - row(i);
    if (a.type !== "K")
      value +=
        progress * (a.type === "P" ? 7 : 3) + (4 - Math.abs(col(i) - 4)) * 2;
    else value -= progress * 9;
    score += (a.side === p.turn ? 1 : -1) * value;
  }
  for (const side of [0, 1])
    for (const [t, n] of Object.entries(p.hands[side]))
      score += (side === p.turn ? 1 : -1) * VALUES[t] * n * 1.05;
  return score;
}
function order(p, m) {
  const capture = p.board[m.to];
  return (
    (capture
      ? (capture.promoted ? PROMOTED[capture.type] : VALUES[capture.type]) +
        VALUES[capture.type]
      : 0) +
    (m.promote ? 170 : 0) +
    (m.drop ? -15 : 0)
  );
}
export function chooseMove(position, { depth = 2, timeMs = 900 } = {}) {
  const roots = legalMoves(position);
  if (!roots.length) return { move: null };
  const until = performance.now() + timeMs;
  let nodes = 0,
    completed = 0,
    best = roots[0],
    bestScore = -Infinity;
  const timeout = {};
  function search(p, d, alpha, beta, ply) {
    if ((++nodes & 63) === 0 && performance.now() > until) throw timeout;
    const moves = legalMoves(p);
    if (!moves.length) return -100000 + ply;
    if (d <= 0) return evaluate(p);
    moves.sort((a, b) => order(p, b) - order(p, a));
    let value = -Infinity;
    for (const m of moves) {
      const score = -search(
        applyUnchecked(p, m),
        d - 1,
        -beta,
        -alpha,
        ply + 1,
      );
      value = Math.max(value, score);
      alpha = Math.max(alpha, score);
      if (alpha >= beta) break;
    }
    return value;
  }
  for (let d = 1; d <= depth; d++) {
    try {
      let chosen = best,
        value = -Infinity;
      roots.sort(
        (a, b) =>
          (moveKey(b) === moveKey(best) ? 100000 : order(position, b)) -
          (moveKey(a) === moveKey(best) ? 100000 : order(position, a)),
      );
      for (const m of roots) {
        if (performance.now() > until && d > 1) throw timeout;
        const score = -search(
          applyUnchecked(position, m),
          d - 1,
          -Infinity,
          Infinity,
          1,
        );
        if (score > value) {
          value = score;
          chosen = m;
        }
      }
      best = chosen;
      bestScore = value;
      completed = d;
    } catch (e) {
      if (e !== timeout) throw e;
      break;
    }
  }
  return { move: best, score: bestScore, depth: completed, nodes };
}
