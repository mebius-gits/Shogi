import { legalMoves, fromSFEN, toUSI } from "../rules/engine.js";
// The rules engine stays the authority on legality: root moves come from
// legalMoves() and the answer is always one of them. Below the root the search
// runs on a private mailbox board with incremental make/unmake, Zobrist
// hashing and a transposition table, which is what lets it look deep enough
// for the stronger levels.

// Piece kinds: 1 P, 2 L, 3 N, 4 S, 5 G, 6 B, 7 R, 8 K, 9-12 promoted P/L/N/S,
// 13 horse, 14 dragon. Sente pieces are stored positive, Gote negative.
const KIND = { P: 1, L: 2, N: 3, S: 4, G: 5, B: 6, R: 7, K: 8 };
const LETTER = ["", "P", "L", "N", "S", "G", "B", "R", "K"];
const BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 6, 7];
const PROMOTE = [0, 9, 10, 11, 12, 0, 13, 14, 0, 0, 0, 0, 0, 0, 0];
// Piece values from Koji Tanigawa's table (pawn = 1, scaled by 100):
// P1 L3 N4 S5 G6 B8 R10, tokin 7, promoted L/N/S 6, horse 10, dragon 12.
// The king has no material value; checkmate is scored by the search.
const VALUE = [
  0, 100, 300, 400, 500, 600, 800, 1000, 0, 700, 600, 600, 600, 1000, 1200,
];
// A piece in hand is worth 5% more for the freedom to drop it anywhere.
const HAND_VALUE = VALUE.slice(0, 8).map((v) => Math.round(v * 1.05));
// Per rank advanced, per file towards the centre.
const ADVANCE = [0, 6, 2, 3, 3, 1, 0, 0, 0, 4, 4, 4, 4, 2, 2];
const CENTER = [0, 2, 4, 6, 8, 6, 4, 2, 0];
// Golds and silvers next to their own king (half at distance two).
const GUARD = [0, 0, 0, 0, 24, 30, 0, 0, 0, 20, 20, 20, 20, 0, 0];
// Attack units near the enemy king (doubled when adjacent) and in hand; the
// king's danger grows with the square of the units aimed at it.
const PRESSURE = [0, 2, 2, 4, 4, 4, 4, 4, 0, 6, 6, 6, 6, 8, 10];
const HAND_PRESSURE = [0, 1, 2, 2, 4, 4, 4, 6];
const DANGER = Array.from({ length: 61 }, (_, u) =>
  Math.min(1400, (u * u * 5) >> 3),
);

// 13 × 11 mailbox: two wall ranks above and below (for knight jumps) and one
// wall file on each side, so move generation never needs a bounds check.
const WALL = 100;
const SQ = new Int16Array(81);
const ROW = new Int8Array(143).fill(-1);
const COL = new Int8Array(143).fill(-1);
for (let i = 0; i < 81; i++) {
  const r = Math.floor(i / 9),
    c = i % 9,
    s = (r + 2) * 11 + c + 1;
  SQ[i] = s;
  ROW[s] = r;
  COL[s] = c;
}
// Directions seen from Sente (row 0 is the far side): N NE E SE S SW W NW,
// then the two knight jumps. Gote uses the same list negated.
const DIRS = [-11, -10, 1, 12, 11, 10, -1, -12, -23, -21];
const bits = (...list) => list.reduce((mask, i) => mask | (1 << i), 0);
const GOLD = bits(0, 1, 2, 4, 6, 7),
  SILVER = bits(0, 1, 3, 5, 7),
  KING = bits(0, 1, 2, 3, 4, 5, 6, 7),
  DIAG = bits(1, 3, 5, 7),
  ORTH = bits(0, 2, 4, 6);
const STEP = [
  0,
  bits(0),
  0,
  bits(8, 9),
  SILVER,
  GOLD,
  0,
  0,
  KING,
  GOLD,
  GOLD,
  GOLD,
  GOLD,
  ORTH,
  DIAG,
];
const SLIDE = [0, 0, bits(0), 0, 0, 0, DIAG, ORTH, 0, 0, 0, 0, 0, DIAG, ORTH];
const vectors = (masks, sign) =>
  masks.map((mask) =>
    DIRS.filter((_, i) => mask & (1 << i)).map((d) => d * sign),
  );
const STEPS = [vectors(STEP, 1), vectors(STEP, -1)];
const SLIDES = [vectors(SLIDE, 1), vectors(SLIDE, -1)];

let seed = 2463534242 | 0;
const random32 = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed;
};
// Two 32-bit halves: the low half picks the table slot, the high half verifies.
const Z_PIECE = Int32Array.from({ length: 29 * 143 * 2 }, random32);
const Z_HAND = Int32Array.from({ length: 16 * 19 * 2 }, random32);
const Z_TURN = Int32Array.from({ length: 2 }, random32);

const MAX_PLY = 96;
const board = new Int8Array(143);
const hand = new Int8Array(16); // side * 8 + base kind
const pawnFiles = new Int8Array(18); // unpromoted pawns per side and file
const kingSq = [0, 0];
let turn = 0,
  hashLo = 0,
  hashHi = 0,
  sp = 0;
const hashStack = new Int32Array(512);
const capStack = new Int8Array(256);

function togglePiece(piece, s) {
  const i = ((piece + 14) * 143 + s) * 2;
  hashLo ^= Z_PIECE[i];
  hashHi ^= Z_PIECE[i + 1];
}
function toggleHand(slot) {
  const i = (slot * 19 + hand[slot]) * 2;
  hashLo ^= Z_HAND[i];
  hashHi ^= Z_HAND[i + 1];
}
function load(p) {
  board.fill(WALL);
  hand.fill(0);
  pawnFiles.fill(0);
  kingSq[0] = kingSq[1] = 0;
  hashLo = hashHi = sp = top = 0;
  turn = p.turn;
  for (let i = 0; i < 81; i++) {
    const a = p.board[i],
      s = SQ[i];
    board[s] = 0;
    if (!a) continue;
    const k = a.promoted ? PROMOTE[KIND[a.type]] : KIND[a.type];
    board[s] = a.side ? -k : k;
    togglePiece(board[s], s);
    if (k === 8) kingSq[a.side] = s;
    if (k === 1) pawnFiles[a.side * 9 + COL[s]]++;
  }
  for (const side of [0, 1])
    for (let b = 1; b < 8; b++) {
      hand[side * 8 + b] = p.hands[side][LETTER[b]] || 0;
      toggleHand(side * 8 + b);
    }
  if (turn) {
    hashLo ^= Z_TURN[0];
    hashHi ^= Z_TURN[1];
  }
}

// Moves are ints: to | from << 8 | promote << 16 | dropped kind << 17.
function make(m) {
  const to = m & 255,
    drop = m >>> 17,
    side = turn,
    sign = side ? -1 : 1;
  hashStack[sp * 2] = hashLo;
  hashStack[sp * 2 + 1] = hashHi;
  let cap = 0;
  if (drop) {
    const slot = side * 8 + drop;
    toggleHand(slot);
    hand[slot]--;
    toggleHand(slot);
    board[to] = sign * drop;
    togglePiece(board[to], to);
    if (drop === 1) pawnFiles[side * 9 + COL[to]]++;
  } else {
    const from = (m >> 8) & 255,
      piece = board[from],
      kind = piece * sign;
    cap = board[to];
    if (cap) {
      const taken = -cap * sign,
        slot = side * 8 + BASE[taken];
      togglePiece(cap, to);
      toggleHand(slot);
      hand[slot]++;
      toggleHand(slot);
      if (taken === 1) pawnFiles[(side ^ 1) * 9 + COL[to]]--;
    }
    togglePiece(piece, from);
    board[from] = 0;
    board[to] = m & 65536 ? sign * PROMOTE[kind] : piece;
    togglePiece(board[to], to);
    if (kind === 8) kingSq[side] = to;
    else if (kind === 1 && m & 65536) pawnFiles[side * 9 + COL[from]]--;
  }
  capStack[sp++] = cap;
  turn = side ^ 1;
  hashLo ^= Z_TURN[0];
  hashHi ^= Z_TURN[1];
}
function unmake(m) {
  const to = m & 255,
    drop = m >>> 17;
  turn ^= 1;
  sp--;
  const side = turn,
    sign = side ? -1 : 1,
    cap = capStack[sp];
  hashLo = hashStack[sp * 2];
  hashHi = hashStack[sp * 2 + 1];
  if (drop) {
    board[to] = 0;
    hand[side * 8 + drop]++;
    if (drop === 1) pawnFiles[side * 9 + COL[to]]--;
    return;
  }
  const from = (m >> 8) & 255,
    moved = board[to] * sign,
    kind = m & 65536 ? BASE[moved] : moved;
  board[from] = sign * kind;
  board[to] = cap;
  if (kind === 8) kingSq[side] = from;
  else if (kind === 1 && m & 65536) pawnFiles[side * 9 + COL[from]]++;
  if (cap) {
    const taken = -cap * sign;
    hand[side * 8 + BASE[taken]]--;
    if (taken === 1) pawnFiles[(side ^ 1) * 9 + COL[to]]++;
  }
}
function nullMake() {
  hashStack[sp * 2] = hashLo;
  hashStack[sp * 2 + 1] = hashHi;
  capStack[sp++] = 0;
  turn ^= 1;
  hashLo ^= Z_TURN[0];
  hashHi ^= Z_TURN[1];
}
function nullUnmake() {
  turn ^= 1;
  sp--;
  hashLo = hashStack[sp * 2];
  hashHi = hashStack[sp * 2 + 1];
}
// Looks outward from the square for a piece of `by` that reaches it.
function attacked(sq, by) {
  const sign = by ? -1 : 1;
  for (let i = 0; i < 10; i++) {
    const v = DIRS[i] * sign;
    let f = sq - v,
      k = board[f] * sign;
    if (k > 0 && k < 15 && STEP[k] & (1 << i)) return true;
    if (i < 8) {
      while (board[f] === 0) f -= v;
      k = board[f] * sign;
      if (k > 0 && k < 15 && SLIDE[k] & (1 << i)) return true;
    }
  }
  return false;
}
const leftInCheck = () => attacked(kingSq[turn ^ 1], turn);

const moves = new Int32Array(1 << 17);
const scores = new Int32Array(1 << 17);
const keys = new Float64Array(1 << 17);
const spareMoves = new Int32Array(1024);
const spareScores = new Int32Array(1024);
const held = new Int8Array(8);
let top = 0;
function addBoardMove(n, from, to, k, side, all) {
  const m = to | (from << 8),
    rank = side ? 8 - ROW[to] : ROW[to];
  if (PROMOTE[k] && (rank <= 2 || (side ? 8 - ROW[from] : ROW[from]) <= 2)) {
    moves[n++] = m | 65536;
    // Declining to promote a pawn, bishop or rook is never better.
    if (!all && (k === 1 || k === 6 || k === 7)) return n;
  }
  if (!((k === 1 || k === 2) && rank === 0) && !(k === 3 && rank <= 1))
    moves[n++] = m;
  return n;
}
// Appends pseudo-legal moves for the side to move at `top`; returns the end.
function generate(capturesOnly, all = false) {
  const side = turn,
    sign = side ? -1 : 1,
    steps = STEPS[side],
    slides = SLIDES[side];
  let n = top;
  for (let i = 0; i < 81; i++) {
    const from = SQ[i],
      k = board[from] * sign;
    if (k <= 0 || k > 14) continue;
    for (const v of steps[k]) {
      const to = from + v,
        q = board[to];
      if (q === WALL || q * sign > 0 || (capturesOnly && !q)) continue;
      n = addBoardMove(n, from, to, k, side, all);
    }
    for (const v of slides[k])
      for (let to = from + v; ; to += v) {
        const q = board[to];
        if (q === WALL || q * sign > 0) break;
        if (q || !capturesOnly) n = addBoardMove(n, from, to, k, side, all);
        if (q) break;
      }
  }
  if (capturesOnly) return n;
  let count = 0;
  for (let b = 1; b < 8; b++) if (hand[side * 8 + b]) held[count++] = b;
  if (!count) return n;
  for (let i = 0; i < 81; i++) {
    const to = SQ[i];
    if (board[to]) continue;
    const rank = side ? 8 - ROW[to] : ROW[to];
    for (let j = 0; j < count; j++) {
      const b = held[j];
      if (b <= 2 && rank === 0) continue;
      if (b === 3 && rank <= 1) continue;
      if (b === 1 && pawnFiles[side * 9 + COL[to]]) continue;
      moves[n++] = to | (b << 17);
    }
  }
  return n;
}
function hasLegalMove() {
  const start = top,
    end = generate(false);
  top = end;
  let found = false;
  for (let i = start; i < end && !found; i++) {
    make(moves[i]);
    found = !leftInCheck();
    unmake(moves[i]);
  }
  top = start;
  return found;
}

function evaluate() {
  const r0 = ROW[kingSq[0]],
    c0 = COL[kingSq[0]],
    r1 = ROW[kingSq[1]],
    c1 = COL[kingSq[1]];
  // onSente / onGote: attack units aimed at that side's king.
  let score = 0,
    onSente = 0,
    onGote = 0;
  for (let i = 0; i < 81; i++) {
    const s = SQ[i],
      p = board[s];
    if (p === 0) continue;
    const r = ROW[s],
      c = COL[s];
    if (p > 0) {
      if (p === 8) {
        score -= (8 - r) * 9;
        continue;
      }
      score += VALUE[p] + (8 - r) * ADVANCE[p] + CENTER[c];
      const own = Math.max(Math.abs(r - r0), Math.abs(c - c0)),
        enemy = Math.max(Math.abs(r - r1), Math.abs(c - c1));
      if (own <= 2) score += own === 1 ? GUARD[p] : GUARD[p] >> 1;
      if (enemy <= 2) onGote += enemy === 1 ? PRESSURE[p] * 2 : PRESSURE[p];
    } else {
      const k = -p;
      if (k === 8) {
        score += r * 9;
        continue;
      }
      score -= VALUE[k] + r * ADVANCE[k] + CENTER[c];
      const own = Math.max(Math.abs(r - r1), Math.abs(c - c1)),
        enemy = Math.max(Math.abs(r - r0), Math.abs(c - c0));
      if (own <= 2) score -= own === 1 ? GUARD[k] : GUARD[k] >> 1;
      if (enemy <= 2) onSente += enemy === 1 ? PRESSURE[k] * 2 : PRESSURE[k];
    }
  }
  for (let b = 1; b < 8; b++) {
    score += (hand[b] - hand[8 + b]) * HAND_VALUE[b];
    onGote += hand[b] * HAND_PRESSURE[b];
    onSente += hand[8 + b] * HAND_PRESSURE[b];
  }
  score += DANGER[Math.min(onGote, 60)] - DANGER[Math.min(onSente, 60)];
  return turn ? -score : score;
}

const MATE = 100000,
  MATE_BOUND = MATE - 1000,
  INF = 1e9;
const EXACT = 0,
  LOWER = 1,
  UPPER = 2;
const TT_SIZE = 1 << 20,
  TT_MASK = TT_SIZE - 1;
const ttKey = new Int32Array(TT_SIZE);
const ttMove = new Int32Array(TT_SIZE);
const ttScore = new Int32Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE);
const ttFlag = new Int8Array(TT_SIZE);
const killers = new Int32Array((MAX_PLY + 1) * 2);
const history = new Int32Array(2 * 15 * 143);
// Quiet moves beyond this count are skipped at shallow depth (index = depth).
const LATE_MOVES = [0, 10, 18, 30];
const seen = new Map(); // earlier game positions: low hash -> high hash
const TIMEOUT = {};
let nodes = 0,
  until = 0,
  stoppable = false,
  plain = false;

function tick() {
  if ((++nodes & 1023) === 0 && stoppable && performance.now() > until)
    throw TIMEOUT;
}
// A position already on the search path or earlier in the game is a draw.
function repeated() {
  for (let i = sp - 4; i >= 0; i -= 2)
    if (hashStack[i * 2] === hashLo && hashStack[i * 2 + 1] === hashHi)
      return true;
  return seen.get(hashLo) === hashHi;
}
function historyIndex(m) {
  const drop = m >>> 17,
    kind = drop || board[(m >> 8) & 255] * (turn ? -1 : 1);
  return (turn * 15 + kind) * 143 + (m & 255);
}
function scoreMove(m, ply, best) {
  if (m === best) return 1 << 30;
  const to = m & 255,
    sign = turn ? -1 : 1;
  if (!(m >>> 17)) {
    const k = board[(m >> 8) & 255] * sign,
      taken = -board[to] * sign;
    if (taken > 0)
      return (
        (1 << 28) + (VALUE[taken] + HAND_VALUE[BASE[taken]]) * 8 - VALUE[k]
      );
    if (m & 65536) return (1 << 27) + VALUE[PROMOTE[k]] - VALUE[k];
  }
  if (m === killers[ply * 2]) return (1 << 26) + 1;
  if (m === killers[ply * 2 + 1]) return 1 << 26;
  return history[historyIndex(m)];
}
function pickBest(i, end) {
  let b = i;
  for (let j = i + 1; j < end; j++) if (scores[j] > scores[b]) b = j;
  if (b === i) return;
  const m = moves[i],
    s = scores[i];
  moves[i] = moves[b];
  scores[i] = scores[b];
  moves[b] = m;
  scores[b] = s;
}
function sortMoves(start, end) {
  const n = end - start;
  for (let i = 0; i < n; i++)
    keys[start + i] = (2147483648 - scores[start + i]) * 1024 + i;
  keys.subarray(start, end).sort();
  for (let i = 0; i < n; i++) {
    const j = start + (keys[start + i] % 1024);
    spareMoves[i] = moves[j];
    spareScores[i] = scores[j];
  }
  moves.set(spareMoves.subarray(0, n), start);
  scores.set(spareScores.subarray(0, n), start);
}
// No legal move loses, except after a checking pawn drop: that drop was an
// illegal uchifuzume, so it scores as a loss for the side that played it.
const noMoves = (checked, prev, ply) =>
  checked && prev >>> 17 === 1 ? MATE - ply : ply - MATE;
function qsearch(alpha, beta, ply) {
  tick();
  const stand = evaluate();
  if (stand >= beta || ply >= MAX_PLY) return stand;
  if (stand > alpha) alpha = stand;
  const start = top,
    end = generate(true),
    sign = turn ? -1 : 1;
  top = end;
  for (let i = start; i < end; i++) scores[i] = scoreMove(moves[i], ply, 0);
  let best = stand;
  for (let i = start; i < end; i++) {
    pickBest(i, end);
    const m = moves[i],
      k = board[(m >> 8) & 255] * sign,
      taken = -board[m & 255] * sign,
      gain =
        VALUE[taken] +
        HAND_VALUE[BASE[taken]] +
        (m & 65536 ? VALUE[PROMOTE[k]] - VALUE[k] : 0);
    if (stand + gain + 200 <= alpha) continue;
    make(m);
    if (leftInCheck()) {
      unmake(m);
      continue;
    }
    const score = -qsearch(-beta, -alpha, ply + 1);
    unmake(m);
    if (score > best) {
      best = score;
      if (score > alpha) {
        alpha = score;
        if (score >= beta) break;
      }
    }
  }
  top = start;
  return best;
}
function search(depth, alpha, beta, ply, prev, allowNull) {
  tick();
  if (repeated()) return 0;
  const checked = attacked(kingSq[turn], turn ^ 1);
  if (plain) {
    if (depth <= 0)
      return checked && !hasLegalMove()
        ? noMoves(checked, prev, ply)
        : evaluate();
  } else {
    if (checked) depth++;
    if (depth <= 0) return qsearch(alpha, beta, ply);
  }
  if (ply >= MAX_PLY) return evaluate();
  const pvNode = beta - alpha > 1,
    slot = hashLo & TT_MASK;
  let best = 0;
  if (ttKey[slot] === hashHi) {
    best = ttMove[slot];
    if (!pvNode && ttDepth[slot] >= depth) {
      let s = ttScore[slot];
      if (s >= MATE_BOUND) s -= ply;
      else if (s <= -MATE_BOUND) s += ply;
      const flag = ttFlag[slot];
      if (flag === EXACT || (flag === LOWER ? s >= beta : s <= alpha))
        return s;
    }
  }
  let staticEval = 0;
  if (!pvNode && !checked) {
    staticEval = evaluate();
    if (allowNull && depth >= 3 && staticEval >= beta) {
      nullMake();
      const s = -search(
        depth - (depth >= 7 ? 4 : 3),
        -beta,
        -beta + 1,
        ply + 1,
        0,
        false,
      );
      nullUnmake();
      if (s >= beta) return s >= MATE_BOUND ? beta : s;
    }
  }
  const futile =
    !pvNode &&
    !checked &&
    depth <= 2 &&
    staticEval + (depth === 1 ? 250 : 500) <= alpha;
  const start = top,
    end = generate(false);
  top = end;
  for (let i = start; i < end; i++) scores[i] = scoreMove(moves[i], ply, best);
  const floor = alpha;
  let bestScore = -INF,
    legal = 0;
  best = 0;
  for (let i = start; i < end; i++) {
    if (i < start + 4) pickBest(i, end);
    else if (i === start + 4) sortMoves(i, end);
    const m = moves[i],
      quiet = !(m & 65536) && !board[m & 255],
      slotH = quiet ? historyIndex(m) : 0;
    make(m);
    if (leftInCheck()) {
      unmake(m);
      continue;
    }
    legal++;
    const gives = quiet && attacked(kingSq[turn], turn ^ 1);
    if (quiet && !gives && !checked && !pvNode && legal > 1) {
      if (futile || (depth <= 3 && legal > LATE_MOVES[depth])) {
        unmake(m);
        continue;
      }
    }
    let score;
    if (legal === 1) score = -search(depth - 1, -beta, -alpha, ply + 1, m, true);
    else {
      let r = 0;
      if (depth >= 3 && quiet && !gives && !checked && legal > 3)
        r = Math.max(
          0,
          1 + (legal > 12 ? 1 : 0) + (depth >= 8 ? 1 : 0) - (pvNode ? 1 : 0),
        );
      score = -search(depth - 1 - r, -alpha - 1, -alpha, ply + 1, m, true);
      if (r && score > alpha)
        score = -search(depth - 1, -alpha - 1, -alpha, ply + 1, m, true);
      if (score > alpha && score < beta)
        score = -search(depth - 1, -beta, -alpha, ply + 1, m, true);
    }
    unmake(m);
    if (score > bestScore) {
      bestScore = score;
      best = m;
      if (score > alpha) {
        alpha = score;
        if (score >= beta) {
          if (quiet) {
            if (killers[ply * 2] !== m) {
              killers[ply * 2 + 1] = killers[ply * 2];
              killers[ply * 2] = m;
            }
            if ((history[slotH] += depth * depth) > 1 << 20)
              for (let j = 0; j < history.length; j++) history[j] >>= 1;
          }
          break;
        }
      }
    }
  }
  top = start;
  if (!legal) return noMoves(checked, prev, ply);
  ttKey[slot] = hashHi;
  ttMove[slot] = best;
  ttDepth[slot] = depth;
  ttFlag[slot] =
    bestScore >= beta ? LOWER : bestScore > floor ? EXACT : UPPER;
  ttScore[slot] =
    bestScore >= MATE_BOUND
      ? bestScore + ply
      : bestScore <= -MATE_BOUND
        ? bestScore - ply
        : bestScore;
  return bestScore;
}

const internal = (m) =>
  m.drop
    ? SQ[m.to] | (KIND[m.drop] << 17)
    : SQ[m.to] | (SQ[m.from] << 8) | (m.promote ? 65536 : 0);
// depth: iteration limit; timeMs: soft time budget; quiesce: false plays the
// plain beginner search (no capture search or check extension); history:
// SFENs of earlier game positions, so repeating one counts as a draw.
export function chooseMove(
  position,
  { depth = 2, timeMs = 900, quiesce = true, history: past = [] } = {},
) {
  const roots = legalMoves(position);
  if (!roots.length) return { move: null };
  ttKey.fill(0);
  ttDepth.fill(0);
  killers.fill(0);
  history.fill(0);
  seen.clear();
  for (const sfen of past) {
    load(fromSFEN(sfen));
    seen.set(hashLo, hashHi);
  }
  load(position);
  plain = !quiesce;
  stoppable = false;
  nodes = 0;
  const started = performance.now();
  until = started + timeMs;
  const list = roots.map(internal),
    value = list.map((m) => scoreMove(m, 0, 0)),
    order = list.map((_, i) => i).sort((a, b) => value[b] - value[a]);
  let best = order[0],
    bestScore = -INF,
    completed = 0;
  for (let d = 1; d <= depth; d++) {
    try {
      let alpha = -INF;
      for (let n = 0; n < order.length; n++) {
        const i = order[n],
          m = list[i];
        make(m);
        let s;
        if (n === 0) s = -search(d - 1, -INF, -alpha, 1, m, true);
        else {
          s = -search(d - 1, -alpha - 1, -alpha, 1, m, true);
          if (s > alpha) s = -search(d - 1, -INF, -alpha, 1, m, true);
        }
        unmake(m);
        value[i] = s;
        // A move that beats the previous best is exact, so it stands even
        // if this iteration runs out of time.
        if (s > alpha) {
          alpha = s;
          best = i;
          bestScore = s;
        }
      }
      completed = d;
      stoppable = true;
    } catch (e) {
      if (e !== TIMEOUT) throw e;
      break;
    }
    order.sort((a, b) =>
      a === best ? -1 : b === best ? 1 : value[b] - value[a],
    );
    if (
      bestScore >= MATE_BOUND ||
      performance.now() - started > timeMs * 0.6
    )
      break;
  }
  return { move: roots[best], score: bestScore, depth: completed, nodes };
}
// For tests: the legal moves as the search generates them, in USI.
export function searchMoves(position) {
  load(position);
  const end = generate(false, true),
    out = [];
  top = end;
  for (let i = 0; i < end; i++) {
    const m = moves[i];
    make(m);
    const ok =
      !leftInCheck() &&
      !(m >>> 17 === 1 && attacked(kingSq[turn], turn ^ 1) && !hasLegalMove());
    unmake(m);
    if (!ok) continue;
    const index = (s) => ROW[s] * 9 + COL[s];
    out.push(
      toUSI(
        m >>> 17
          ? { drop: LETTER[m >>> 17], to: index(m & 255) }
          : {
              from: index((m >> 8) & 255),
              to: index(m & 255),
              promote: !!(m & 65536),
            },
      ),
    );
  }
  top = 0;
  return out;
}
