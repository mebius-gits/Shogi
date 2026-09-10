import {
  Game,
  LABELS,
  NAMES,
  HAND_TYPES,
  fromSFEN,
  toSFEN,
  legalMoves,
  inCheck,
  declaration,
  moveKey,
} from "./engine.js";
import { GameClock } from "./clock.js";
import { BoardScene } from "./scene.js";
import { exportKIF } from "./record.js";
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const SAVE_KEY = "sakurama-shogi-v1";
let currentPage = "play";
function navigate(name, replace = false) {
  if (!document.getElementById(name + "-page")) name = "play";
  if (name !== "play" && currentPage === "play") setPaused(true);
  currentPage = name;
  for (const page of $$("[data-page]"))
    page.hidden = page.dataset.page !== name;
  if (location.hash !== "#/" + name)
    history[replace ? "replaceState" : "pushState"](null, "", "#/" + name);
  render(false);
  requestAnimationFrame(() => board.resize());
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", () =>
  navigate(location.hash.slice(2), true),
);
const defaults = { mode: "ai", humanSide: 0, level: 2, main: 0, byoyomi: 0 };
let config = { ...defaults },
  prefs = {
    theme: "spring",
    sound: true,
    shadows: true,
    animation: true,
    speed: 1850,
    legal: true,
  };
let profiles = [
  { name: "旅人", avatar: "" },
  { name: "花咲 小春", avatar: "koharu" },
];
let game = new Game(),
  clock = new GameClock(),
  durations = [],
  clockHistory = [],
  turnUsedBase = [0, 0];
let paused = false,
  replayIndex = null,
  selection = null,
  promotionMoves = null,
  animating = false,
  aiThinking = false,
  hintThinking = false,
  worker = null,
  job = 0,
  aiTimer = null,
  epoch = 0,
  lastTick = Date.now(),
  lastSave = Date.now(),
  toastTimer,
  resultShown = false;
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 3400);
}
const cleanProfile = (p, fallback) => ({
  name:
    typeof p?.name === "string"
      ? p.name.trim().slice(0, 20) || fallback.name
      : fallback.name,
  avatar:
    p?.avatar === "koharu" ||
    /^data:image\/(png|jpeg|webp);base64,/.test(p?.avatar || "")
      ? p.avatar
      : fallback.avatar,
});
let restored = false;
try {
  const raw = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
  if (raw) {
    const loaded = Game.restore(raw.game);
    config = { ...defaults, ...raw.config };
    if (
      !["ai", "local"].includes(config.mode) ||
      ![0, 1].includes(config.humanSide) ||
      ![1, 2, 3].includes(config.level) ||
      ![0, 300, 600].includes(config.main) ||
      ![0, 10, 30].includes(config.byoyomi)
    )
      throw new Error("Invalid config");
    game = loaded;
    prefs = { ...prefs, ...raw.prefs };
    if (!["spring", "sunset", "night"].includes(prefs.theme))
      prefs.theme = "spring";
    if (![1300, 1850, 2600].includes(prefs.speed)) prefs.speed = 1850;
    profiles = profiles.map((p, i) => cleanProfile(raw.profiles?.[i], p));
    clock = new GameClock(config.main, config.byoyomi, raw.clock);
    if (
      ![...clock.remaining, ...clock.used, clock.period].every(
        (n) => Number.isFinite(n) && n >= 0,
      )
    )
      throw new Error("Invalid clock");
    durations = raw.durations || [];
    clockHistory = raw.clockHistory || [];
    turnUsedBase = raw.turnUsedBase || [0, 0];
    paused = !game.result;
    restored = true;
  }
} catch (error) {
  console.warn("Could not restore saved game:", error.message);
  game = new Game();
  config = { ...defaults };
  clock = new GameClock();
  durations = [];
  clockHistory = [];
  turnUsedBase = [0, 0];
}
function save() {
  try {
    localStorage.setItem(
      SAVE_KEY,
      JSON.stringify({
        game: game.serialize(),
        config,
        prefs,
        profiles,
        clock: clock.serialize(),
        durations,
        clockHistory,
        turnUsedBase,
      }),
    );
    $("#save-status").textContent = "本機自動存檔";
  } catch {
    $("#save-status").textContent = "存檔空間不足";
    toast("無法儲存到瀏覽器，請下載棋譜保留這局。");
  }
}
let board;
try {
  board = new BoardScene($("#board-canvas"), onSquare);
  $("#loading").remove();
} catch (error) {
  console.error(error);
  $("#loading").innerHTML =
    '<span class="loading-seal">将</span><p>無法啟用 WebGL，請開啟瀏覽器硬體加速後重新整理。</p>';
  throw error;
}
$("#board-canvas").addEventListener("rendererror", (e) => toast(e.detail));
function renderAvatar(el, p) {
  el.replaceChildren();
  if (p.avatar) {
    const image = document.createElement("img");
    image.src = p.avatar === "koharu" ? "assets/koharu.png" : p.avatar;
    image.alt = p.name + "的頭像";
    if (p.avatar === "koharu") image.className = "original";
    el.append(image);
  } else el.textContent = [...p.name][0] || "棋";
}
function currentPosition() {
  if (replayIndex === null) return game.position;
  return fromSFEN(
    replayIndex === 0 ? game.initial : game.history[replayIndex - 1].after,
  );
}
function isHumanTurn() {
  return config.mode === "local" || game.position.turn === config.humanSide;
}
function canPlay() {
  return (
    currentPage === "play" &&
    !game.result &&
    !paused &&
    replayIndex === null &&
    !animating &&
    !aiThinking &&
    !hintThinking &&
    isHumanTurn()
  );
}
let cachedMoves = [];
function highlight() {
  const p = currentPosition(),
    last =
      replayIndex === null
        ? game.history.at(-1)?.move
        : game.history[replayIndex - 1]?.move;
  const moves = selection
    ? cachedMoves.filter((m) =>
        selection.drop ? m.drop === selection.drop : m.from === selection.from,
      )
    : [];
  const king = inCheck(p)
    ? p.board.findIndex((a) => a?.type === "K" && a.side === p.turn)
    : null;
  board.highlight(
    prefs.legal ? moves.map((m) => m.to) : [],
    selection?.from ?? null,
    last,
    king < 0 ? null : king,
  );
}
function renderHands(p) {
  for (const side of [0, 1]) {
    const holder = $("#hand-" + side);
    holder.replaceChildren();
    let count = 0;
    for (const type of HAND_TYPES) {
      const n = p.hands[side][type] || 0;
      count += n;
      const button = document.createElement("button");
      button.className = "hand-piece";
      button.dataset.side = side;
      button.dataset.piece = type;
      button.setAttribute(
        "aria-label",
        `${side ? "後手" : "先手"}持駒 ${NAMES[type]} ${n} 枚`,
      );
      button.disabled =
        !n || !canPlay() || side !== game.position.turn || replayIndex !== null;
      const symbol = document.createElement("span");
      symbol.textContent = LABELS[type];
      button.append(symbol);
      if (n) {
        const amount = document.createElement("b");
        amount.textContent = n;
        button.append(amount);
      }
      if (selection?.drop === type && side === game.position.turn)
        button.classList.add("selected");
      button.addEventListener("click", () => {
        selection = selection?.drop === type ? null : { drop: type };
        render(false);
      });
      holder.append(button);
    }
    $("#hand-count-" + side).textContent = count + " 枚";
  }
}
function renderRecord() {
  const list = $("#move-list");
  list.replaceChildren();
  if (!game.history.length) {
    const li = document.createElement("li");
    li.className = "empty-record";
    li.innerHTML =
      "<span>—</span><p>每一步，都值得記住。<br><small>落下第一子，開始你的故事。</small></p>";
    list.append(li);
  } else {
    game.history.forEach((h, i) => {
      const li = document.createElement("li"),
        b = document.createElement("button");
      b.dataset.ply = i + 1;
      const active = replayIndex === null ? game.history.length : replayIndex;
      b.classList.toggle("current", i + 1 === active);
      for (const text of [
        i + 1,
        h.text.replace(/\(.*\)/, ""),
        `${Math.round((durations[i] || 0) / 1000)}s`,
      ]) {
        const span = document.createElement("span");
        span.textContent = text;
        b.append(span);
      }
      b.addEventListener("click", () => replay(i + 1));
      li.append(b);
      list.append(li);
    });
    if (replayIndex === null) list.scrollTop = list.scrollHeight;
  }
  const pos = replayIndex === null ? game.history.length : replayIndex;
  $("#replay-position").textContent = `${pos} / ${game.history.length}`;
  $("#replay-start").disabled = $("#replay-prev").disabled =
    !game.history.length || pos === 0;
  $("#replay-next").disabled = $("#replay-end").disabled =
    !game.history.length ||
    (pos === game.history.length && replayIndex === null);
  $("#return-live").hidden = replayIndex === null;
  $("#review-toolbar").hidden = replayIndex === null;
  $("#replay-badge").hidden = replayIndex === null;
  $("#replay-badge span").textContent = `第 ${pos} 手`;
}
function status(title, detail, symbol = "☗") {
  $("#status-title").textContent = title;
  $("#status-detail").textContent = detail;
  $("#status-symbol").textContent = symbol;
}
function render(syncBoard = true) {
  const p = currentPosition();
  if (syncBoard) board.sync(p, game.history.at(-1)?.move);
  cachedMoves = game.result || replayIndex !== null ? [] : game.moves();
  for (const side of [0, 1]) {
    const profile = profiles[side];
    $("#name-" + side).textContent = profile.name;
    renderAvatar($("#avatar-" + side), profile);
    $("#preview-name-" + side).textContent = profile.name;
    renderAvatar($("#preview-avatar-" + side), profile);
    $("#player-" + side).classList.toggle(
      "active",
      !game.result && p.turn === side,
    );
    $("#note-" + side).textContent =
      config.mode === "ai" && side !== config.humanSide
        ? ["", "入門電腦", "初級電腦", "中級電腦"][config.level]
        : "今天，也請多指教";
    $("#player-state-" + side).textContent = game.result
      ? "對局已結束"
      : p.turn === side
        ? paused
          ? "稍作歇息"
          : animating
            ? "正在落子"
            : inCheck(p)
              ? "王手，請應將"
              : "正在思考"
        : "靜候下一手";
  }
  $("#mode-caption").textContent =
    config.mode === "ai"
      ? `與${profiles[1 - config.humanSide].name}對弈`
      : "同機雙人對局";
  $("#game-type").textContent =
    "平手 · " + (config.mode === "ai" ? "人機對局" : "同機雙人");
  $("#difficulty-caption").textContent =
    (config.mode === "ai"
      ? ["", "入門電腦", "初級電腦", "中級電腦"][config.level]
      : "雙人對局") +
    " · " +
    (config.main ? `${config.main / 60} 分 + ${config.byoyomi} 秒` : "無限時") +
    " · 休閒對局";
  $("#ply-count").textContent =
    `第 ${(replayIndex ?? game.history.length) + 1} 手`;
  $("#pause-overlay").hidden = !paused || replayIndex !== null || !!game.result;
  $("#thinking").hidden = !aiThinking && !hintThinking;
  $(".board-status").classList.toggle("checked", inCheck(p) && !game.result);
  const sideWord = p.turn ? "後手" : "先手";
  if (game.result) status(resultTitle(), reasonText(game.result.reason), "終");
  else if (replayIndex !== null)
    status(`棋譜回顧 · 第 ${replayIndex} 手`, "按「返回對局」繼續下棋。", "譜");
  else if (paused) status("棋局已暫停", "按「繼續對局」回到棋盤。", "Ⅱ");
  else if (animating) status("指尖落子中", "棋子落定後，換另一方思考。", "手");
  else if (aiThinking)
    status(`${profiles[p.turn].name}正在思考`, "電腦正在尋找合法指手。", "…");
  else if (hintThinking)
    status("正在尋找提示", "稍候會在棋盤標示建議的一手。", "✧");
  else if (selection) {
    const a = selection.drop
      ? { type: selection.drop }
      : p.board[selection.from];
    const count = new Set(
      cachedMoves
        .filter((m) =>
          selection.drop
            ? m.drop === selection.drop
            : m.from === selection.from,
        )
        .map((m) => m.to),
    ).size;
    status(
      `已選取${NAMES[(a.promoted ? "+" : "") + a.type]}${selection.drop ? " · 打入" : ""}`,
      count
        ? `共有 ${count} 個合法位置，請選擇目的格。`
        : "這枚棋子目前沒有合法走法。",
      LABELS[a.type],
    );
  } else if (inCheck(p))
    status(
      `${sideWord}被王手！`,
      "請移動玉、取下攻擊者，或用棋子阻擋王手。",
      "王",
    );
  else
    status(
      `${sideWord} · ${profiles[p.turn].name}落子`,
      "點選棋子，再選擇綠色提示的格子。",
      p.turn ? "☖" : "☗",
    );
  for (const b of board.buttons) b.disabled = !canPlay();
  renderHands(p);
  highlight();
  renderRecord();
  renderClocks();
  $("#undo").disabled = !game.history.length || animating;
  $("#hint").disabled = !canPlay();
  $("#pause").disabled = !!game.result || animating || replayIndex !== null;
  $("#pause").querySelector("span").textContent = paused ? "繼續" : "暫停";
  $("#resign").disabled = !!game.result || animating || replayIndex !== null;
  $("#declare").disabled =
    !!game.result || animating || replayIndex !== null || !isHumanTurn();
  $("#new-game").disabled = animating;
}
function renderClocks() {
  for (const side of [0, 1]) {
    $("#clock-" + side).textContent = clock.display(side, game.position.turn);
    $("#clock-note-" + side).textContent = clock.unlimited
      ? "時間無限制"
      : clock.remaining[side] > 0
        ? `讀秒 ${config.byoyomi} 秒`
        : "正在讀秒";
  }
}
function stopJobs() {
  clearTimeout(aiTimer);
  aiTimer = null;
  job++;
  if (worker) {
    worker.terminate();
    worker = null;
  }
  aiThinking = hintThinking = false;
}
function setPaused(value) {
  tick();
  paused = value;
  lastTick = Date.now();
  if (value) stopJobs();
  render(false);
  save();
  if (!value) scheduleAI();
}
function requestSearch(kind) {
  if (kind === "hint" && !canPlay()) return;
  stopJobs();
  const id = ++job;
  if (kind === "ai") aiThinking = true;
  else hintThinking = true;
  render(false);
  worker = new Worker("./ai-worker.js", { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.id !== job) return;
    worker.terminate();
    worker = null;
    aiThinking = hintThinking = false;
    tick();
    if (data.error) {
      paused = true;
      render(false);
      toast("電腦思考中斷，按繼續可重試。");
      return;
    }
    if (paused || game.result || replayIndex !== null) return;
    if (!data.move) {
      render(false);
      return;
    }
    if (kind === "ai") executeMove(data.move);
    else {
      selection = data.move.drop
        ? { drop: data.move.drop }
        : { from: data.move.from };
      render(false);
      board.highlight(
        [data.move.to],
        data.move.from ?? null,
        game.history.at(-1)?.move,
      );
      status(
        "試試這一步",
        `${data.move.drop ? "打入" + NAMES[data.move.drop] : "選取框起的棋子"}，移至 ${9 - (data.move.to % 9)}${"一二三四五六七八九"[Math.floor(data.move.to / 9)]}。`,
        "✧",
      );
    }
  };
  worker.onerror = () => {
    if (id !== job) return;
    stopJobs();
    paused = true;
    render(false);
    toast("電腦無法載入，請重新整理或切換同機雙人模式。");
  };
  worker.postMessage({
    id,
    position: game.position,
    options: {
      depth: kind === "hint" ? 3 : config.level,
      timeMs: kind === "hint" ? 1400 : [0, 200, 750, 1700][config.level],
    },
  });
}
function scheduleAI() {
  clearTimeout(aiTimer);
  if (
    config.mode === "ai" &&
    game.position.turn !== config.humanSide &&
    !game.result &&
    !paused &&
    !animating &&
    replayIndex === null
  )
    aiTimer = setTimeout(() => {
      if (!paused && !game.result && !animating && replayIndex === null) {
        if (declaration(game.position).eligible) {
          game.declare();
          save();
          render();
          showResult();
        } else requestSearch("ai");
      }
    }, 300);
}
function onSquare(i) {
  if (!canPlay()) return;
  const p = game.position,
    a = p.board[i];
  if (selection) {
    const choices = cachedMoves.filter(
      (m) =>
        m.to === i &&
        (selection.drop
          ? m.drop === selection.drop
          : m.from === selection.from),
    );
    if (choices.length) {
      if (choices.length > 1) {
        promotionMoves = choices;
        const piece = p.board[choices[0].from];
        $("#normal-symbol").textContent = LABELS[piece.type];
        $("#promoted-symbol").textContent = LABELS["+" + piece.type];
        $("#promote-description").textContent =
          `${NAMES[piece.type]}可升變為${NAMES["+" + piece.type]}。升變後，走法會改變。`;
        $("#promote-dialog").showModal();
      } else executeMove(choices[0]);
      return;
    }
  }
  if (a?.side === p.turn) {
    selection = selection?.from === i ? null : { from: i };
    render(false);
  } else {
    toast(
      inCheck(p) ? "這一步無法解除王手。" : "這個位置不能走，請選擇提示格。",
    );
  }
}
async function executeMove(move) {
  if (game.result || animating || paused || replayIndex !== null) return;
  tick();
  if (game.result) return;
  const before = game.position,
    side = before.turn,
    token = epoch;
  const snapshot = { clock: clock.serialize(), base: turnUsedBase.slice() };
  let record;
  try {
    record = game.play(move);
  } catch (error) {
    toast(error.message);
    return;
  }
  stopJobs();
  clockHistory.push(snapshot);
  durations.push(clock.used[side] - turnUsedBase[side]);
  turnUsedBase[side] = clock.used[side];
  clock.nextTurn();
  selection = null;
  promotionMoves = null;
  animating = true;
  lastTick = Date.now();
  render(false);
  save();
  const duration =
    !prefs.animation || matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 1
      : prefs.speed;
  await board.animate(before, move, { duration, onLand: playSound });
  if (token !== epoch) return;
  animating = false;
  lastTick = Date.now();
  render();
  save();
  if (game.result) showResult();
  else scheduleAI();
}
function tick() {
  const now = Date.now(),
    dt = Math.max(0, now - lastTick);
  lastTick = now;
  if (!paused && !animating && replayIndex === null && !game.result) {
    if (clock.charge(game.position.turn, dt)) {
      game.result = { winner: 1 - game.position.turn, reason: "timeout" };
      stopJobs();
      if ($("#promote-dialog").open) $("#promote-dialog").close();
      promotionMoves = null;
      selection = null;
      render(false);
      save();
      showResult();
    }
  }
  renderClocks();
}
setInterval(() => {
  tick();
  if (Date.now() - lastSave > 5000) {
    lastSave = Date.now();
    save();
  }
}, 200);
window.addEventListener("pagehide", () => {
  tick();
  save();
});
const reasonText = (reason) =>
  ({
    checkmate: "詰み：玉將已無法解除王手。",
    "no-legal-move": "已無合法指手。",
    resign: "一方投了，感謝這一局的陪伴。",
    timeout: "對局時間與讀秒已用盡。",
    repetition: "相同棋盤、持駒與手番出現四次，可換先後手重賽。",
    "perpetual-check": "連續王手造成千日手，持續王手的一方判負。",
    declaration: "符合業餘 27 點制的入玉宣言條件。",
    "invalid-declaration": "入玉宣言條件不足，宣言方判負。",
    "move-limit": "已達 500 手且無王手，判持將棋，可換先後手重賽。",
  })[reason] || "對局已結束。";
function resultTitle() {
  return game.result?.winner === null
    ? "無勝負 · 指し直し"
    : `${profiles[game.result?.winner ?? 0].name}獲勝`;
}
function showResult() {
  if (!game.result || resultShown) return;
  resultShown = true;
  $("#result-seal").textContent = game.result.winner === null ? "和" : "勝";
  $("#result-title").textContent = resultTitle();
  $("#result-detail").textContent =
    `共 ${game.history.length} 手。${reasonText(game.result.reason)}`;
  $("#result-dialog").showModal();
}
function replay(index) {
  if (animating) return;
  tick();
  stopJobs();
  selection = null;
  replayIndex = Math.max(0, Math.min(game.history.length, index));
  navigate("play");
  render();
}
function returnLive() {
  replayIndex = null;
  selection = null;
  paused = false;
  lastTick = Date.now();
  render();
  scheduleAI();
}
$("#replay-start").onclick = () => replay(0);
$("#review-initial").onclick = () => replay(0);
$("#replay-prev").onclick = () =>
  replay((replayIndex ?? game.history.length) - 1);
$("#replay-next").onclick = () => {
  const next = (replayIndex ?? game.history.length) + 1;
  if (next >= game.history.length) returnLive();
  else replay(next);
};
$("#replay-end").onclick = $("#return-live").onclick = returnLive;
$("#pause").onclick = () => setPaused(!paused);
$("#resume").onclick = () => setPaused(false);
$("#undo").onclick = () => {
  if (animating || !game.history.length) return;
  tick();
  stopJobs();
  replayIndex = null;
  selection = null;
  do {
    const saved = clockHistory.pop();
    game.undo();
    durations.pop();
    if (saved) {
      clock = new GameClock(config.main, config.byoyomi, saved.clock);
      turnUsedBase = saved.base;
    }
  } while (
    config.mode === "ai" &&
    game.history.length &&
    game.position.turn !== config.humanSide
  );
  resultShown = false;
  lastTick = Date.now();
  render();
  save();
  scheduleAI();
  toast("已回到上一個可以思考的局面。");
};
$("#hint").onclick = () => requestSearch("hint");
function confirmAction(title, description, action) {
  $("#confirm-title").textContent = title;
  $("#confirm-description").textContent = description;
  $("#confirm-yes").onclick = () => {
    $("#confirm-dialog").close();
    action();
  };
  $("#confirm-no").onclick = () => $("#confirm-dialog").close();
  $("#confirm-dialog").showModal();
}
$("#resign").onclick = () => {
  const side = config.mode === "ai" ? config.humanSide : game.position.turn;
  confirmAction(
    "要投了嗎？",
    `${profiles[side].name}將認輸並結束本局。`,
    () => {
      tick();
      if (game.result) return;
      stopJobs();
      game.resign(side);
      save();
      render();
      showResult();
    },
  );
};
$("#declare").onclick = () => {
  const d = declaration(game.position);
  confirmAction(
    "確認入玉宣言",
    `敵陣棋子 ${d.count} 枚（需 10 枚），目前 ${d.points} 點（需 ${d.required} 點）。${d.eligible ? "目前符合宣言條件。" : "目前不符合全部條件，宣言將判負。"}`,
    () => {
      tick();
      if (game.result) return;
      game.declare();
      stopJobs();
      save();
      render();
      showResult();
    },
  );
};
for (const [value, id] of [
  [true, "promote-yes"],
  [false, "promote-no"],
])
  $("#" + id).onclick = () => {
    const move = promotionMoves?.find((m) => m.promote === value);
    $("#promote-dialog").close();
    promotionMoves = null;
    if (move) executeMove(move);
  };
$("#promote-cancel").onclick = () => {
  $("#promote-dialog").close();
  promotionMoves = null;
};
$("#promote-dialog").addEventListener("cancel", () => {
  promotionMoves = null;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
    selection = null;
    render(false);
  }
});
let pendingRematchSwap = false;
function openNew(swap = false) {
  if (animating) return;
  pendingRematchSwap = swap === true;
  setPaused(true);
  $("#new-mode").value = config.mode;
  $("#new-side").value = pendingRematchSwap
    ? 1 - config.humanSide
    : config.humanSide;
  $("#new-level").value = config.level;
  $("#new-time").value = config.main ? `${config.main}:${config.byoyomi}` : "0";
  updateModeFields();
  navigate("new");
}
function updateModeFields() {
  const isAI = $("#new-mode").value === "ai";
  $("#new-side").disabled = $("#new-level").disabled = !isAI;
}
$("#new-mode").onchange = updateModeFields;
$("#new-game").onclick = () => openNew();
$("#new-form").onsubmit = (e) => {
  e.preventDefault();
  const mode = $("#new-mode").value,
    humanSide = Number($("#new-side").value);
  if (
    (mode === "ai" && config.mode === "ai" && humanSide !== config.humanSide) ||
    (mode === "local" && pendingRematchSwap)
  )
    profiles.reverse();
  pendingRematchSwap = false;
  const [main = 0, byoyomi = 0] = $("#new-time").value.split(":").map(Number);
  config = {
    mode,
    humanSide,
    level: Number($("#new-level").value),
    main,
    byoyomi,
  };
  epoch++;
  stopJobs();
  board.cancel();
  game = new Game();
  clock = new GameClock(main, byoyomi);
  durations = [];
  clockHistory = [];
  turnUsedBase = [0, 0];
  selection = null;
  paused = false;
  replayIndex = null;
  animating = false;
  resultShown = false;
  lastTick = Date.now();
  navigate("play");
  render();
  save();
  scheduleAI();
};
$("#result-new").onclick = () => {
  $("#result-dialog").close();
  openNew(game.result?.winner === null);
};
$("#result-review").onclick = () => {
  $("#result-dialog").close();
  replay(game.history.length);
};
$$("[data-page-link]").forEach(
  (b) => (b.onclick = () => navigate(b.dataset.pageLink)),
);
$("#continue-game").onclick = () => {
  replayIndex = null;
  navigate("play");
  setPaused(false);
};
$("#settings-open").onclick = () => {
  navigate("settings");
};
$("#rules-open").onclick = () => {
  navigate("rules");
};
$("#animation-setting").checked = prefs.animation;
$("#speed-setting").value = prefs.speed;
$("#legal-setting").checked = prefs.legal;
$("#animation-setting").onchange = (e) => {
  prefs.animation = e.target.checked;
  save();
};
$("#speed-setting").onchange = (e) => {
  prefs.speed = Number(e.target.value);
  save();
};
$("#legal-setting").onchange = (e) => {
  prefs.legal = e.target.checked;
  highlight();
  save();
};
function applyPreferences() {
  document.body.dataset.theme = prefs.theme;
  board.setTheme(prefs.theme);
  board.setShadows(prefs.shadows);
  $$("[data-theme]").forEach((b) =>
    b.classList.toggle("selected", b.dataset.theme === prefs.theme),
  );
  $("#sound-toggle").textContent = prefs.sound ? "♫ 音效開" : "♫ 音效關";
  $("#sound-toggle").setAttribute("aria-pressed", prefs.sound);
  $("#shadow-toggle").textContent = prefs.shadows ? "◐ 陰影開" : "◐ 陰影關";
  $("#shadow-toggle").setAttribute("aria-pressed", prefs.shadows);
}
$$("[data-theme]").forEach(
  (b) =>
    (b.onclick = () => {
      prefs.theme = b.dataset.theme;
      applyPreferences();
      save();
    }),
);
$("#sound-toggle").onclick = () => {
  prefs.sound = !prefs.sound;
  applyPreferences();
  save();
  if (prefs.sound) playSound();
};
$("#shadow-toggle").onclick = () => {
  prefs.shadows = !prefs.shadows;
  applyPreferences();
  save();
};
let audio;
function playSound() {
  if (!prefs.sound) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") audio.resume();
    const osc = audio.createOscillator(),
      gain = audio.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(1000, audio.currentTime);
    osc.frequency.exponentialRampToValueAtTime(220, audio.currentTime + 0.07);
    gain.gain.setValueAtTime(0.12, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.12);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.14);
  } catch {}
}
let editingSide = 0,
  draftAvatar = "",
  uploadJob = 0;
$$("[data-profile]").forEach(
  (b) =>
    (b.onclick = () => {
      setPaused(true);
      editingSide = Number(b.dataset.profile);
      draftAvatar = profiles[editingSide].avatar;
      $("#profile-name").value = profiles[editingSide].name;
      $("#profile-error").textContent = "";
      $("#avatar-file").value = "";
      renderAvatar($("#profile-avatar"), profiles[editingSide]);
      navigate("profile");
    }),
);
$("#profile-name").oninput = () =>
  renderAvatar($("#profile-avatar"), {
    name: $("#profile-name").value || "棋",
    avatar: draftAvatar,
  });
$("#avatar-reset").onclick = () => {
  uploadJob++;
  draftAvatar =
    config.mode === "ai" && editingSide !== config.humanSide ? "koharu" : "";
  renderAvatar($("#profile-avatar"), {
    name: $("#profile-name").value || "棋",
    avatar: draftAvatar,
  });
};
$("#avatar-file").onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const id = ++uploadJob;
  $("#profile-error").textContent = "";
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size > 5 * 1024 * 1024
  ) {
    $("#profile-error").textContent =
      "請選擇 5 MB 以下的 PNG、JPG 或 WebP 圖片。";
    return;
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (id !== uploadJob) return;
    const c = document.createElement("canvas");
    c.width = c.height = 192;
    const ctx = c.getContext("2d"),
      size = Math.min(img.width, img.height);
    ctx.drawImage(
      img,
      (img.width - size) / 2,
      (img.height - size) / 2,
      size,
      size,
      0,
      0,
      192,
      192,
    );
    draftAvatar = c.toDataURL("image/webp", 0.88);
    renderAvatar($("#profile-avatar"), {
      name: $("#profile-name").value || "棋",
      avatar: draftAvatar,
    });
  } catch {
    $("#profile-error").textContent = "無法讀取這张圖片，請換一張再試。";
  } finally {
    URL.revokeObjectURL(url);
  }
};
$("#profile-form").onsubmit = (e) => {
  e.preventDefault();
  const name = $("#profile-name").value.trim();
  if (!name) {
    $("#profile-error").textContent = "請輸入顯示名稱。";
    return;
  }
  profiles[editingSide] = { name: name.slice(0, 20), avatar: draftAvatar };
  navigate("players");
  render(false);
  save();
  toast("頭像與名稱已儲存。");
};
$("#export-record").onclick = () => {
  const url = URL.createObjectURL(
      new Blob([exportKIF(game, profiles, durations)], {
        type: "text/plain;charset=utf-8",
      }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = `sakurama-${new Date().toISOString().slice(0, 10)}.kif`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};
const descriptions = {
  K: "周圍八方向一格，不能進入受攻擊格。",
  R: "沿直線任意格；成龍後加斜向一格。",
  B: "沿斜線任意格；成馬後加直向一格。",
  G: "前、斜前、左右、正後各一格。",
  S: "正前與四個斜方向各一格；成後同金。",
  N: "向前兩格再左右一格，可以跳子；成後同金。",
  L: "正前方任意格，不可跳子；成後同金。",
  P: "正前方一格；成と金後同金。",
};
for (const t of ["K", "R", "B", "G", "S", "N", "L", "P"]) {
  const d = document.createElement("div");
  d.className = "rule-piece";
  d.innerHTML = `<span>${LABELS[t]}</span><div><strong>${NAMES[t]}</strong><p>${descriptions[t]}</p></div>`;
  $("#rules-pieces").append(d);
}
applyPreferences();
render();
navigate(location.hash.slice(2) || "play", true);
if (restored) toast("已恢復棋局與玩家資料。");
if (game.result) showResult();
else scheduleAI();
