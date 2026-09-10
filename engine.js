// Pure rules engine. Board indices: row * 9 + column, columns are 9..1.
// Sente is 0 (towards row 0), Gote is 1. Captured pieces revert to base type.
export const TYPES = ["P", "L", "N", "S", "G", "B", "R", "K"];
export const HAND_TYPES = ["R", "B", "G", "S", "N", "L", "P"];
export const LABELS = {
  P: "歩",
  L: "香",
  N: "桂",
  S: "銀",
  G: "金",
  B: "角",
  R: "飛",
  K: "玉",
  "+P": "と",
  "+L": "杏",
  "+N": "圭",
  "+S": "全",
  "+B": "馬",
  "+R": "龍",
};
export const NAMES = {
  P: "步兵",
  L: "香車",
  N: "桂馬",
  S: "銀將",
  G: "金將",
  B: "角行",
  R: "飛車",
  K: "玉將",
  "+P": "と金",
  "+L": "成香",
  "+N": "成桂",
  "+S": "成銀",
  "+B": "龍馬",
  "+R": "龍王",
};
export const INITIAL_SFEN =
  "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
const GOLD = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
];
const KING = [...GOLD, [-1, 1], [1, 1]];
const DIAG = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ],
  ORTH = [
    [0, -1],
    [-1, 0],
    [1, 0],
    [0, 1],
  ];
export const row = (i) => Math.floor(i / 9),
  col = (i) => i % 9;
export const inZone = (side, r) => (side === 0 ? r <= 2 : r >= 6);
export const deadRank = (type, side, r) =>
  type === "P" || type === "L"
    ? r === (side ? 8 : 0)
    : type === "N" && (side ? r >= 7 : r <= 1);
export const emptyHands = () => [
  Object.fromEntries(HAND_TYPES.map((t) => [t, 0])),
  Object.fromEntries(HAND_TYPES.map((t) => [t, 0])),
];
export function fromSFEN(sfen = INITIAL_SFEN) {
  const [layout, turn, handText, plyText] = sfen.trim().split(/\s+/);
  const board = [];
  let promoted = false;
  if (!layout || !["b", "w"].includes(turn) || !handText)
    throw new Error("Invalid SFEN");
  const rows = layout.split("/");
  if (rows.length !== 9) throw new Error("Invalid board rows");
  for (const line of rows) {
    let count = 0;
    for (const ch of line) {
      if (/[1-9]/.test(ch)) {
        if (promoted) throw new Error("Invalid promotion");
        for (let i = 0; i < Number(ch); i++) {
          board.push(null);
          count++;
        }
      } else if (ch === "+") {
        if (promoted) throw new Error("Invalid promotion");
        promoted = true;
      } else {
        const type = ch.toUpperCase();
        if (!TYPES.includes(type) || (promoted && ["G", "K"].includes(type)))
          throw new Error("Invalid piece");
        board.push({ type, side: ch === type ? 0 : 1, promoted });
        count++;
        promoted = false;
      }
    }
    if (count !== 9 || promoted) throw new Error("Invalid rank");
  }
  const hands = emptyHands();
  if (handText !== "-") {
    let n = "";
    for (const ch of handText) {
      if (/[0-9]/.test(ch)) {
        n += ch;
        continue;
      }
      const type = ch.toUpperCase();
      if (!HAND_TYPES.includes(type)) throw new Error("Invalid hand");
      const count = Number(n || 1);
      if (count < 1 || count > 18) throw new Error("Invalid count");
      hands[ch === type ? 0 : 1][type] += count;
      n = "";
    }
    if (n) throw new Error("Invalid hand");
  }
  const ply = Number(plyText || 1);
  if (!Number.isInteger(ply) || ply < 1) throw new Error("Invalid ply");
  return { board, hands, turn: turn === "b" ? 0 : 1, ply };
}
export function toSFEN(p) {
  const rows = [];
  for (let r = 0; r < 9; r++) {
    let line = "",
      n = 0;
    for (let c = 0; c < 9; c++) {
      const a = p.board[r * 9 + c];
      if (!a) {
        n++;
        continue;
      }
      if (n) {
        line += n;
        n = 0;
      }
      line +=
        (a.promoted ? "+" : "") + (a.side ? a.type.toLowerCase() : a.type);
    }
    if (n) line += n;
    rows.push(line);
  }
  let h = "";
  for (const side of [0, 1])
    for (const type of HAND_TYPES) {
      const n = p.hands[side][type] || 0;
      if (n) h += (n > 1 ? n : "") + (side ? type.toLowerCase() : type);
    }
  return `${rows.join("/")} ${p.turn ? "w" : "b"} ${h || "-"} ${p.ply}`;
}
export const positionKey = (p) => toSFEN(p).split(" ").slice(0, 3).join(" ");
export function destinations(p, from, attack = false) {
  const a = p.board[from];
  if (!a) return [];
  let steps = [],
    slides = [];
  const sign = a.side ? -1 : 1;
  if (a.promoted && ["P", "L", "N", "S"].includes(a.type)) steps = GOLD;
  else
    switch (a.type) {
      case "P":
        steps = [[0, -1]];
        break;
      case "L":
        slides = [[0, -1]];
        break;
      case "N":
        steps = [
          [-1, -2],
          [1, -2],
        ];
        break;
      case "S":
        steps = [...DIAG, [0, -1]];
        break;
      case "G":
        steps = GOLD;
        break;
      case "K":
        steps = KING;
        break;
      case "B":
        slides = DIAG;
        if (a.promoted) steps = ORTH;
        break;
      case "R":
        slides = ORTH;
        if (a.promoted) steps = DIAG;
        break;
    }
  const out = [];
  for (const [directions, isSlide] of [
    [steps, false],
    [slides, true],
  ])
    for (const [dx, dy] of directions) {
      let x = col(from) + dx * sign,
        y = row(from) + dy * sign;
      while (x >= 0 && x < 9 && y >= 0 && y < 9) {
        const to = y * 9 + x,
          target = p.board[to];
        if (attack || !target || target.side !== a.side) out.push(to);
        if (target || !isSlide) break;
        x += dx * sign;
        y += dy * sign;
      }
    }
  return out;
}
export function isAttacked(p, square, bySide) {
  for (let i = 0; i < 81; i++) {
    const a = p.board[i];
    if (a && a.side === bySide && destinations(p, i, true).includes(square))
      return true;
  }
  return false;
}
export function inCheck(p, side = p.turn) {
  const king = p.board.findIndex((a) => a?.side === side && a.type === "K");
  return king < 0 || isAttacked(p, king, 1 - side);
}
export function applyUnchecked(p, m) {
  const next = {
    board: p.board.slice(),
    hands: p.hands.map((h) => ({ ...h })),
    turn: 1 - p.turn,
    ply: p.ply + 1,
  };
  if (m.drop) {
    next.hands[p.turn][m.drop]--;
    next.board[m.to] = { type: m.drop, side: p.turn, promoted: false };
  } else {
    const a = p.board[m.from],
      captured = p.board[m.to];
    next.board[m.from] = null;
    next.board[m.to] = { ...a, promoted: a.promoted || !!m.promote };
    if (captured && captured.type !== "K") next.hands[p.turn][captured.type]++;
  }
  return next;
}
function* pseudoMoves(p, includeDrops = true) {
  for (let from = 0; from < 81; from++) {
    const a = p.board[from];
    if (!a || a.side !== p.turn) continue;
    for (const to of destinations(p, from)) {
      if (p.board[to]?.type === "K") continue;
      const can =
        !a.promoted &&
        !["K", "G"].includes(a.type) &&
        (inZone(a.side, row(from)) || inZone(a.side, row(to)));
      if (can) yield { from, to, promote: true };
      if (a.promoted || !deadRank(a.type, a.side, row(to)))
        yield { from, to, promote: false };
    }
  }
  if (!includeDrops) return;
  for (const type of HAND_TYPES) {
    if (!p.hands[p.turn][type]) continue;
    for (let to = 0; to < 81; to++) {
      if (p.board[to] || deadRank(type, p.turn, row(to))) continue;
      if (
        type === "P" &&
        p.board.some(
          (a, i) =>
            a?.side === p.turn &&
            a.type === "P" &&
            !a.promoted &&
            col(i) === col(to),
        )
      )
        continue;
      yield { drop: type, to, promote: false };
    }
  }
}
export function legalMoves(
  p,
  { first = false, includeDrops = true, skipPawnMate = false } = {},
) {
  const out = [];
  for (const m of pseudoMoves(p, includeDrops)) {
    const next = applyUnchecked(p, m);
    if (inCheck(next, p.turn)) continue;
    // A directly checking dropped pawn cannot be blocked: only board moves can evade it.
    // Testing those responses avoids recursion while still enforcing uchifuzume exactly.
    if (!skipPawnMate && m.drop === "P") {
      const king = next.board.findIndex(
        (a) => a?.side === next.turn && a.type === "K",
      );
      const attack = m.to + (p.turn ? 9 : -9);
      if (
        king === attack &&
        !legalMoves(next, {
          first: true,
          includeDrops: false,
          skipPawnMate: true,
        }).length
      )
        continue;
    }
    out.push(m);
    if (first) break;
  }
  return out;
}
export const moveKey = (m) =>
  `${m.drop || m.from}:${m.to}:${m.promote ? 1 : 0}`;
export function toUSI(m) {
  const sq = (i) => `${9 - col(i)}${String.fromCharCode(97 + row(i))}`;
  return m.drop
    ? `${m.drop}*${sq(m.to)}`
    : `${sq(m.from)}${sq(m.to)}${m.promote ? "+" : ""}`;
}
export function notation(p, m) {
  const a = m.drop ? { type: m.drop } : p.board[m.from];
  const symbol = LABELS[(a.promoted ? "+" : "") + a.type];
  return `${p.turn ? "△" : "▲"}${9 - col(m.to)}${"一二三四五六七八九"[row(m.to)]}${symbol}${m.drop ? "打" : m.promote ? "成" : !a.promoted && !["K", "G"].includes(a.type) && (inZone(p.turn, row(m.from)) || inZone(p.turn, row(m.to))) ? "不成" : ""}${m.drop ? "" : `(${9 - col(m.from)}${row(m.from) + 1})`}`;
}
export function repetitionResult(timeline) {
  const last = timeline.at(-1),
    indices = [];
  timeline.forEach((e, i) => {
    if (e.key === last.key) indices.push(i);
  });
  if (indices.length < 4) return null;
  const start = indices.at(-4);
  const interval = timeline.slice(start + 1);
  for (const side of [0, 1]) {
    const moves = interval.filter((e) => e.mover === side);
    if (moves.length && moves.every((e) => e.check))
      return { winner: 1 - side, reason: "perpetual-check" };
  }
  return { winner: null, reason: "repetition" };
}
// Explicit amateur 27-point declaration variant, documented in the in-game rules.
export function declaration(p, side = p.turn) {
  const king = p.board.findIndex((a) => a?.side === side && a.type === "K");
  let count = 0,
    points = 0;
  for (let i = 0; i < 81; i++) {
    const a = p.board[i];
    if (a?.side === side && a.type !== "K" && inZone(side, row(i))) {
      count++;
      points += ["R", "B"].includes(a.type) ? 5 : 1;
    }
  }
  for (const t of HAND_TYPES)
    points += (p.hands[side][t] || 0) * (["R", "B"].includes(t) ? 5 : 1);
  return {
    eligible:
      side === p.turn &&
      king >= 0 &&
      inZone(side, row(king)) &&
      !inCheck(p, side) &&
      count >= 10 &&
      points >= (side ? 27 : 28),
    count,
    points,
    required: side ? 27 : 28,
  };
}
export class Game {
  constructor(sfen = INITIAL_SFEN) {
    this.initial = sfen;
    this.position = fromSFEN(sfen);
    this.history = [];
    this.timeline = [
      { key: positionKey(this.position), mover: null, check: false },
    ];
    this.result = null;
  }
  moves() {
    return this.result ? [] : legalMoves(this.position);
  }
  play(request) {
    if (this.result) throw new Error("對局已結束");
    const move = this.moves().find((m) => moveKey(m) === moveKey(request));
    if (!move) throw new Error("這一步不符合將棋規則");
    const before = this.position;
    const text = notation(before, move);
    this.position = applyUnchecked(before, move);
    const checked = inCheck(this.position);
    this.history.push({
      move,
      text,
      before: toSFEN(before),
      after: toSFEN(this.position),
    });
    this.timeline.push({
      key: positionKey(this.position),
      mover: before.turn,
      check: checked,
    });
    if (!legalMoves(this.position, { first: true }).length)
      this.result = {
        winner: before.turn,
        reason: checked ? "checkmate" : "no-legal-move",
      };
    else this.result = repetitionResult(this.timeline);
    if (!this.result && this.history.length >= 500 && !checked)
      this.result = { winner: null, reason: "move-limit" };
    return this.history.at(-1);
  }
  undo() {
    const last = this.history.pop();
    if (!last) return false;
    this.position = fromSFEN(last.before);
    this.timeline.pop();
    this.result = null;
    return true;
  }
  resign(side = this.position.turn) {
    if (!this.result) this.result = { winner: 1 - side, reason: "resign" };
  }
  declare() {
    if (this.result) return;
    const d = declaration(this.position);
    this.result = {
      winner: d.eligible ? this.position.turn : 1 - this.position.turn,
      reason: d.eligible ? "declaration" : "invalid-declaration",
    };
  }
  serialize() {
    return {
      version: 1,
      initial: this.initial,
      moves: this.history.map((h) => h.move),
      result: this.result,
    };
  }
  static restore(data) {
    if (
      !data ||
      data.version !== 1 ||
      !Array.isArray(data.moves) ||
      data.moves.length > 600
    )
      throw new Error("Invalid saved game");
    const game = new Game(data.initial);
    for (const m of data.moves) game.play(m);
    if (
      data.result &&
      [0, 1, null].includes(data.result.winner) &&
      ["resign", "timeout", "declaration", "invalid-declaration"].includes(
        data.result.reason,
      )
    )
      game.result = data.result;
    return game;
  }
}
