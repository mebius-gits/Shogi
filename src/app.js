import {
  Game,
  LABELS,
  NAMES,
  HAND_TYPES,
  fromSFEN,
  inCheck,
  declaration,
} from "./rules/engine.js";
import { GameClock } from "./rules/clock.js";
import { BoardScene } from "./scene/scene.js";
import { exportKIF } from "./rules/record.js";
import { OnlineRoom, DEFAULT_BROKER, cleanRoomCode } from "./online/net.js";

const $ = (s, root = document) => root.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const STORE_KEY = "sakurama-shogi-v2";
const CPU = { name: "花咲 小春", avatar: "koharu" };
const LEVELS = ["", "入門", "初級", "中級"];
const TIMES = { 0: [0, 0], "300:10": [300, 10], "600:30": [600, 30] };
const PEER_GRACE = 60000;

const cleanProfile = (p, fallback) => ({
  name:
    typeof p?.name === "string"
      ? p.name.trim().slice(0, 20) || fallback.name
      : fallback.name,
  avatar:
    p?.avatar === "koharu" ||
    (/^data:image\/(png|jpeg|webp);base64,/.test(p?.avatar || "") &&
      p.avatar.length < 120000)
      ? p.avatar
      : fallback.avatar,
});
const pick = (value, allowed, fallback) =>
  allowed.includes(value) ? value : fallback;

let store = {
  prefs: {
    theme: "spring",
    sound: true,
    shadows: true,
    animation: true,
    speed: 1850,
    legal: true,
  },
  profile: { name: "旅人", avatar: "" },
  broker: DEFAULT_BROKER,
  cpu: { level: "2", side: "0", time: "0" },
  local: { name: "對手", time: "0" },
  room: { time: "300:10", side: "random" },
  match: { time: "300:10" },
  online: { mode: "match" },
};
function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    const old = raw
      ? null
      : JSON.parse(localStorage.getItem("sakurama-shogi-v1") || "null");
    const data = raw || {
      prefs: old?.prefs,
      profile: old?.profiles?.[0],
    };
    const p = { ...store.prefs, ...data.prefs };
    store.prefs = {
      theme: pick(p.theme, ["spring", "sunset", "night"], "spring"),
      sound: p.sound !== false,
      shadows: p.shadows !== false,
      animation: p.animation !== false,
      speed: pick(p.speed, [1300, 1850, 2600], 1850),
      legal: p.legal !== false,
    };
    store.profile = cleanProfile(data.profile, store.profile);
    if (/^wss?:\/\/\S+$/.test(data.broker || "")) store.broker = data.broker;
    const times = Object.keys(TIMES);
    store.cpu = {
      level: pick(data.cpu?.level, ["1", "2", "3"], "2"),
      side: pick(data.cpu?.side, ["0", "1", "random"], "0"),
      time: pick(data.cpu?.time, times, "0"),
    };
    store.local = {
      name: cleanProfile({ name: data.local?.name }, { name: "對手" }).name,
      time: pick(data.local?.time, times, "0"),
    };
    store.room = {
      time: pick(data.room?.time, times, "300:10"),
      side: pick(data.room?.side, ["0", "1", "random"], "random"),
    };
    store.match = { time: pick(data.match?.time, times, "300:10") };
    store.online = {
      mode: pick(data.online?.mode, ["match", "friend"], "match"),
    };
    if (old) localStorage.removeItem("sakurama-shogi-v1");
  } catch (error) {
    console.warn("Could not read preferences:", error.message);
  }
}
function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    toast("無法儲存設定到瀏覽器。");
  }
}
loadStore();

let session = null,
  players = [store.profile, CPU],
  game = new Game(),
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
  toastTimer,
  resultShown = false,
  currentPage = "home";
let net = null,
  netStatus = "idle",
  peerLostAt = null,
  remoteFlagAt = null,
  rematch = { me: false, peer: false },
  peerLeft = false,
  pendingRemote = [];

function toast(text) {
  $("#toast").textContent = text;
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 3400);
}
const online = () => session?.mode === "online";
const offline = () => !!session && session.mode !== "online";
const gameActive = () => !!session && !game.result;
const flipped = () => !!session && session.mode !== "local" && session.mySide === 1;
const seatSide = (seat) => (seat === "bottom") === flipped() ? 1 : 0;

let board;
try {
  board = new BoardScene($("#board-canvas"), onSquare);
  $("#loading").remove();
} catch (error) {
  console.error(error);
  $("#loading").innerHTML =
    '<span class="loading-seal">将</span><p>這個瀏覽器無法顯示 3D 棋盤。請更新瀏覽器，或在瀏覽器設定中開啟「硬體加速」後重新整理。</p>';
  throw error;
}
$("#board-canvas").addEventListener("rendererror", (e) => toast(e.detail));
for (let i = 0; i < 14; i++) {
  const petal = document.createElement("i"),
    duration = 11 + Math.random() * 9;
  petal.style.cssText = `--x:${Math.random() * 100}%;--s:${8 + Math.random() * 7}px;--d:${duration}s;--delay:${-Math.random() * duration}s;--o:${0.55 + Math.random() * 0.35}`;
  $("#petals").append(petal);
}

function navigate(name, replace = false) {
  // Invite links (#/join/ABCDE) open the friend lobby with the code filled in.
  const invite = /^join\/([A-Za-z0-9]{5})$/.exec(name);
  if (invite) {
    pendingInvite = cleanRoomCode(invite[1]);
    name = "online";
    replace = true;
  }
  if (!document.getElementById(name + "-page")) name = "home";
  if (name === "play" && !session) name = "home";
  if (currentPage === "play" && name !== "play" && session) {
    if (location.hash !== "#/play") history.replaceState(null, "", "#/play");
    if (gameActive()) {
      confirmAction(
        "離開對局？",
        online() ? "離開將視為投了。" : "目前的對局將會結束。",
        () => {
          leaveGame();
          navigate(name);
        },
      );
      return;
    }
    leaveGame();
  }
  if (currentPage === "online" && name !== "online" && !session) closeNet();
  currentPage = name;
  for (const page of $$("[data-page]")) page.hidden = page.dataset.page !== name;
  if (location.hash !== "#/" + name)
    history[replace ? "replaceState" : "pushState"](null, "", "#/" + name);
  if (name === "online") enterLobby();
  if (name === "home" || name === "local") renderHome();
  render(false);
  requestAnimationFrame(() => board.resize());
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", () =>
  navigate(location.hash.slice(2), true),
);

function renderAvatar(el, p) {
  el.replaceChildren();
  if (p.avatar) {
    const image = document.createElement("img");
    image.src = p.avatar === "koharu" ? "assets/images/koharu.png" : p.avatar;
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
  return (
    !!session &&
    (session.mode === "local" || game.position.turn === session.mySide)
  );
}
function canPlay() {
  return (
    currentPage === "play" &&
    gameActive() &&
    !paused &&
    replayIndex === null &&
    !animating &&
    !aiThinking &&
    !hintThinking &&
    isHumanTurn()
  );
}

function startGame(options) {
  epoch++;
  stopJobs();
  board.cancel();
  session = options;
  players = options.players;
  game = new Game(options.sfen);
  clock = new GameClock(options.main, options.byoyomi);
  durations = [];
  clockHistory = [];
  turnUsedBase = [0, 0];
  selection = null;
  promotionMoves = null;
  paused = false;
  replayIndex = null;
  animating = false;
  resultShown = false;
  peerLostAt = null;
  remoteFlagAt = null;
  rematch = { me: false, peer: false };
  peerLeft = false;
  pendingRemote = [];
  for (const d of $$("dialog[open]"))
    if (d.id !== "settings-dialog") d.close();
  board.setFlipped(flipped());
  lastTick = Date.now();
  board.sync(game.position);
  navigate("play");
  render();
  scheduleAI();
}
function leaveGame() {
  stopJobs();
  board.cancel();
  if (online()) {
    if (!game.result) {
      game.resign(session.mySide);
      net?.send("resign");
    }
    net?.send("leave");
    closeNet();
  }
  session = null;
}
function startCpu() {
  const { level, side, time } = store.cpu;
  const mySide = side === "random" ? Math.round(Math.random()) : Number(side);
  const [main, byoyomi] = TIMES[time];
  startGame({
    mode: "ai",
    level: Number(level),
    mySide,
    main,
    byoyomi,
    players: mySide ? [CPU, store.profile] : [store.profile, CPU],
  });
}
function startLocal(sfen) {
  const [main, byoyomi] = TIMES[store.local.time];
  startGame({
    mode: "local",
    mySide: 0,
    main,
    byoyomi,
    sfen,
    players: [store.profile, { name: store.local.name, avatar: "" }],
  });
}
const radio = (name) => $(`input[name="${name}"]:checked`)?.value;
const setRadio = (name, value) => {
  const input = $(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
};
$("#cpu-form").onsubmit = (e) => {
  e.preventDefault();
  store.cpu = {
    level: radio("cpu-level"),
    side: radio("cpu-side"),
    time: radio("cpu-time"),
  };
  persist();
  startCpu();
};
$("#local-form").onsubmit = (e) => {
  e.preventDefault();
  store.local = {
    name: $("#local-name").value.trim().slice(0, 20) || "對手",
    time: radio("local-time"),
  };
  persist();
  startLocal();
};

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
    store.prefs.legal ? moves.map((m) => m.to) : [],
    selection?.from ?? null,
    last,
    king < 0 ? null : king,
  );
}
let cachedMoves = [];
function renderHands(p) {
  for (const seat of ["top", "bottom"]) {
    const side = seatSide(seat),
      holder = $("#hand-" + seat),
      rail = holder.closest(".capture-rail");
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
      button.disabled = !n || !canPlay() || side !== game.position.turn;
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
    $(".hand-label", rail).textContent = side ? "後手持駒" : "先手持駒";
    $(".hand-count", rail).textContent = count + " 枚";
  }
}
function renderMoveList(list) {
  list.replaceChildren();
  if (!game.history.length) {
    const li = document.createElement("li");
    li.className = "empty-record";
    li.innerHTML = "<span>—</span><p>尚無指手</p>";
    list.append(li);
    return;
  }
  const active = replayIndex === null ? game.history.length : replayIndex;
  game.history.forEach((h, i) => {
    const li = document.createElement("li"),
      b = document.createElement("button");
    b.dataset.ply = i + 1;
    b.disabled = !game.result;
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
  const current = list.querySelector(".current");
  if (replayIndex === null) list.scrollTop = list.scrollHeight;
  else if (current)
    list.scrollTop +=
      current.getBoundingClientRect().top -
      list.getBoundingClientRect().top -
      list.clientHeight / 2;
}
function renderRecord() {
  renderMoveList($("#side-moves"));
  const pos = replayIndex === null ? game.history.length : replayIndex;
  $("#replay-position").textContent = `${pos} / ${game.history.length}`;
  $("#replay-start").disabled = $("#replay-prev").disabled = pos === 0;
  $("#replay-next").disabled = $("#replay-end").disabled =
    pos === game.history.length;
  $("#review-toolbar").hidden = !game.result || !game.history.length;
  $("#replay-badge").hidden = replayIndex === null;
  $("#replay-badge span").textContent = `第 ${pos} 手`;
}
function status(title, detail, symbol = "☗") {
  $("#status-title").textContent = title;
  $("#status-detail").textContent = detail;
  $("#status-symbol").textContent = symbol;
}
function playerNote(side) {
  if (session?.mode === "ai" && side !== session.mySide)
    return "CPU · " + LEVELS[session.level];
  if (online()) return side === session.mySide ? "YOU" : "ONLINE";
  return "";
}
function playerState(side, p) {
  if (game.result) return "對局已結束";
  if (p.turn !== side) return "靜候下一手";
  if (online() && side !== session.mySide && peerLostAt) return "連線中斷";
  if (paused) return "稍作歇息";
  if (animating) return "正在落子";
  return inCheck(p) ? "王手，請應將" : "正在思考";
}
function renderSeats(p) {
  for (const seat of ["top", "bottom"]) {
    const el = $("#seat-" + seat),
      side = seatSide(seat),
      profile = players[side];
    $(".side-name", el).textContent = side ? "後手" : "先手";
    $(".side-en", el).textContent = side ? "GOTE" : "SENTE";
    $(".name", el).textContent = profile.name;
    renderAvatar($(".avatar", el), profile);
    $(".player-note", el).textContent = playerNote(side);
    $(".player-footer", el).textContent = playerState(side, p);
    el.classList.toggle("active", !game.result && p.turn === side);
  }
  renderClocks();
}
function renderClocks() {
  for (const seat of ["top", "bottom"]) {
    const el = $("#seat-" + seat),
      side = seatSide(seat);
    $(".clock", el).textContent = clock.display(side, game.position.turn);
    $(".clock-note", el).textContent = clock.unlimited
      ? ""
      : clock.remaining[side] > 0
        ? `讀秒 ${session?.byoyomi ?? 0} 秒`
        : "正在讀秒";
  }
}
function modeLabel() {
  if (!session) return "";
  if (session.mode === "ai") return "平手 · 電腦對戰";
  if (session.mode === "local") return "平手 · 同機雙人";
  return session.kind === "match"
    ? "連線對戰 · 隨機配對"
    : `連線對戰 · 房號 ${session.code}`;
}
function render(syncBoard = true) {
  if (!session) return;
  const p = currentPosition();
  if (syncBoard) board.sync(p, game.history.at(-1)?.move);
  cachedMoves = game.result || replayIndex !== null ? [] : game.moves();
  renderSeats(p);
  $("#game-type").textContent = modeLabel();
  $("#ply-count").textContent =
    `第 ${(replayIndex ?? game.history.length) + 1} 手`;
  const shown =
    replayIndex === null ? game.history.at(-1) : game.history[replayIndex - 1];
  $("#last-move").textContent = shown ? shown.text.replace(/\(.*\)/, "") : "—";
  $("#pause-overlay").hidden = !paused || replayIndex !== null || !!game.result;
  const waitingPeer =
    online() && gameActive() && !isHumanTurn() && !animating && !peerLostAt;
  $("#thinking").hidden = !aiThinking && !hintThinking && !waitingPeer;
  $(".board-status").classList.toggle("checked", inCheck(p) && !game.result);
  renderStatus(p);
  for (const b of board.buttons) b.disabled = !canPlay();
  renderHands(p);
  highlight();
  renderRecord();
  const assist = offline();
  $("#hint").hidden = $("#undo").hidden = $("#pause").hidden = !assist;
  $(".play-layout").classList.toggle("finished", !!game.result);
  $(".board-actions:not(.after-actions)").hidden = !!game.result;
  $(".after-actions").hidden = !game.result;
  $("#undo").disabled = !game.history.length || animating;
  $("#hint").disabled = !canPlay();
  $("#pause").disabled = !!game.result || animating;
  $("#pause span").textContent = paused ? "繼續" : "暫停";
  $("#resign").disabled = !gameActive() || animating;
  $("#declare").disabled = !gameActive() || animating || !isHumanTurn();
  renderAgain();
}
function renderStatus(p) {
  const sideWord = p.turn ? "後手" : "先手";
  if (game.result) status(resultTitle(), reasonText(game.result.reason), "終");
  else if (replayIndex !== null)
    status(`棋譜回顧 · 第 ${replayIndex} 手`, "", "譜");
  else if (online() && netStatus !== "online")
    status("連線中斷", "重新連線中…", "!");
  else if (online() && peerLostAt)
    status(
      "對手連線中斷",
      `${Math.max(0, Math.ceil((PEER_GRACE - (Date.now() - peerLostAt)) / 1000))} 秒後判定勝利`,
      "!",
    );
  else if (paused) status("棋局已暫停", "", "Ⅱ");
  else if (animating) status("落子中", "", "手");
  else if (aiThinking || (online() && !isHumanTurn()))
    status(`${players[p.turn].name}思考中`, "", "…");
  else if (hintThinking) status("尋找提示中", "", "✧");
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
      count ? `可走 ${count} 格` : "無法移動",
      LABELS[a.type],
    );
  } else if (inCheck(p)) status(`${sideWord}被王手！`, "請應將", "王");
  else
    status(
      `${sideWord} · ${players[p.turn].name}`,
      "",
      p.turn ? "☖" : "☗",
    );
}
function renderAgain() {
  const label = !online()
    ? "再來一局"
    : peerLeft
      ? "對手已離開"
      : rematch.me
        ? "等待對手…"
        : rematch.peer
          ? "接受再戰"
          : "再來一局";
  for (const id of ["#again", "#result-again"]) {
    const b = $(id),
      target = $("span", b) || b;
    target.textContent = label;
    b.disabled = online() && (peerLeft || rematch.me);
  }
}
function renderHome() {
  $("#home-name").textContent = store.profile.name;
  renderAvatar($("#home-avatar"), store.profile);
  $("#local-me").textContent = store.profile.name;
  renderAvatar($("#local-avatar"), store.profile);
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
  if (!offline() || (value && game.result)) return;
  tick();
  paused = value;
  lastTick = Date.now();
  if (value) stopJobs();
  render(false);
  if (!value) scheduleAI();
}
function requestSearch(kind) {
  if (kind === "hint" && !canPlay()) return;
  stopJobs();
  const id = ++job;
  if (kind === "ai") aiThinking = true;
  else hintThinking = true;
  render(false);
  worker = new Worker(new URL("./ai/ai-worker.js", import.meta.url), {
    type: "module",
  });
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
    toast("電腦無法載入，請重新整理後再試。");
  };
  worker.postMessage({
    id,
    position: game.position,
    options: {
      depth: kind === "hint" ? 3 : session.level,
      timeMs: kind === "hint" ? 1400 : [0, 200, 750, 1700][session.level],
    },
  });
}
function scheduleAI() {
  clearTimeout(aiTimer);
  if (
    session?.mode === "ai" &&
    game.position.turn !== session.mySide &&
    !game.result &&
    !paused &&
    !animating &&
    replayIndex === null
  )
    aiTimer = setTimeout(() => {
      if (!paused && !game.result && !animating && replayIndex === null) {
        if (declaration(game.position).eligible) {
          game.declare();
          finish();
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
          `${NAMES[piece.type]} → ${NAMES["+" + piece.type]}`;
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
async function executeMove(move, remote = null) {
  if (game.result || animating || paused || replayIndex !== null) return;
  tick();
  if (game.result) return;
  const before = game.position,
    side = before.turn,
    ply = game.history.length,
    token = epoch;
  const snapshot = { clock: clock.serialize(), base: turnUsedBase.slice() };
  try {
    game.play(move);
  } catch (error) {
    if (!remote) toast(error.message);
    return;
  }
  stopJobs();
  clockHistory.push(snapshot);
  durations.push(remote ? remote.spent : clock.used[side] - turnUsedBase[side]);
  turnUsedBase[side] = clock.used[side];
  clock.nextTurn();
  remoteFlagAt = null;
  if (online() && !remote)
    net?.send("move", {
      n: ply,
      move: {
        from: move.from,
        to: move.to,
        drop: move.drop,
        promote: move.promote,
      },
      spent: durations.at(-1),
      clock: { remaining: clock.remaining[side], used: clock.used[side] },
    });
  selection = null;
  promotionMoves = null;
  animating = true;
  lastTick = Date.now();
  render(false);
  const duration =
    !store.prefs.animation ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 1
      : store.prefs.speed;
  await board.animate(before, move, { duration, onLand: playSound });
  if (token !== epoch) return;
  animating = false;
  lastTick = Date.now();
  render();
  if (game.result) finish();
  else scheduleAI();
  const next = pendingRemote.shift();
  if (next) onlineMessage(next);
}
function tick() {
  const now = Date.now(),
    dt = Math.max(0, now - lastTick);
  lastTick = now;
  if (!gameActive() || paused || animating || replayIndex !== null) return;
  const side = game.position.turn;
  if (clock.charge(side, dt)) {
    if (online() && side !== session.mySide) {
      remoteFlagAt ??= now;
      if (now - remoteFlagAt < 15000) return renderClocks();
      game.result = { winner: session.mySide, reason: "timeout" };
    } else {
      game.result = { winner: 1 - side, reason: "timeout" };
      if (online()) net?.send("timeout");
    }
    stopJobs();
    if ($("#promote-dialog").open) $("#promote-dialog").close();
    promotionMoves = null;
    selection = null;
    finish();
  }
  renderClocks();
}
setInterval(() => {
  tick();
  if (online() && peerLostAt && gameActive()) {
    if (Date.now() - peerLostAt > PEER_GRACE) {
      game.result = { winner: session.mySide, reason: "disconnect" };
      finish();
    } else renderStatus(currentPosition());
  }
}, 200);
document.addEventListener("visibilitychange", () => {
  if (document.hidden && offline() && gameActive() && !paused) setPaused(true);
});
window.addEventListener("beforeunload", (e) => {
  if (gameActive() && game.history.length) e.preventDefault();
});
window.addEventListener("pagehide", () => {
  if (online() && gameActive()) net?.send("resign");
});

function finish() {
  stopJobs();
  render();
  showResult();
}
const reasonText = (reason) =>
  ({
    checkmate: "詰み：玉將已無法解除王手。",
    "no-legal-move": "已無合法指手。",
    resign: "一方投了。",
    timeout: "對局時間與讀秒已用盡。",
    repetition: "相同棋盤、持駒與手番出現四次。",
    "perpetual-check": "連續王手造成千日手，持續王手的一方判負。",
    declaration: "符合業餘 27 點制的入玉宣言條件。",
    "invalid-declaration": "入玉宣言條件不足，宣言方判負。",
    "move-limit": "已達 500 手且無王手，判持將棋。",
    disconnect: "對手連線中斷。",
  })[reason] || "對局已結束。";
function resultTitle() {
  const w = game.result?.winner;
  if (w === null) return "無勝負";
  if (session.mode === "local") return `${players[w].name}獲勝`;
  return w === session.mySide ? "勝利" : "敗北";
}
function showResult() {
  if (!game.result || resultShown) return;
  resultShown = true;
  const w = game.result.winner;
  $("#result-seal").textContent =
    w === null ? "和" : session.mode === "local" || w === session.mySide ? "勝" : "負";
  $("#result-seal").classList.toggle(
    "lose",
    w !== null && session.mode !== "local" && w !== session.mySide,
  );
  $("#result-title").textContent = resultTitle();
  $("#result-detail").textContent =
    `共 ${game.history.length} 手。${reasonText(game.result.reason)}`;
  renderAgain();
  $("#result-dialog").showModal();
}
function replay(index) {
  if (animating || !game.result) return;
  selection = null;
  replayIndex = Math.max(0, Math.min(game.history.length, index));
  if (replayIndex === game.history.length) replayIndex = null;
  render();
}
$("#replay-start").onclick = () => replay(0);
$("#replay-prev").onclick = () =>
  replay((replayIndex ?? game.history.length) - 1);
$("#replay-next").onclick = () =>
  replay((replayIndex ?? game.history.length) + 1);
$("#replay-end").onclick = () => replay(game.history.length);
$("#pause").onclick = () => setPaused(!paused);
$("#resume").onclick = () => setPaused(false);
$("#undo").onclick = () => {
  if (!offline() || animating || !game.history.length) return;
  tick();
  stopJobs();
  selection = null;
  do {
    const saved = clockHistory.pop();
    game.undo();
    durations.pop();
    if (saved) {
      clock = new GameClock(session.main, session.byoyomi, saved.clock);
      turnUsedBase = saved.base;
    }
  } while (
    session.mode === "ai" &&
    game.history.length &&
    game.position.turn !== session.mySide
  );
  resultShown = false;
  lastTick = Date.now();
  render();
  scheduleAI();
  toast("已悔棋。");
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
  const side = session.mode === "local" ? game.position.turn : session.mySide;
  confirmAction("要投了嗎？", `${players[side].name}將認輸並結束本局。`, () => {
    tick();
    if (game.result) return;
    game.resign(side);
    if (online()) net?.send("resign");
    finish();
  });
};
$("#declare").onclick = () => {
  const d = declaration(game.position);
  confirmAction(
    "確認入玉宣言",
    `敵陣棋子 ${d.count} 枚（需 10 枚），目前 ${d.points} 點（需 ${d.required} 點）。${d.eligible ? "目前符合宣言條件。" : "目前不符合全部條件，宣言將判負。"}`,
    () => {
      tick();
      if (game.result || !isHumanTurn()) return;
      const n = game.history.length;
      game.declare();
      if (online()) net?.send("declare", { n });
      finish();
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
function playAgain() {
  $("#result-dialog").close();
  if (!online()) return session.mode === "ai" ? startCpu() : startLocal();
  if (peerLeft || rematch.me) return;
  rematch.me = true;
  net.send("rematch");
  if (rematch.peer) net.restart();
  renderAgain();
}
$("#again").onclick = $("#result-again").onclick = playAgain;
$("#result-review").onclick = () => $("#result-dialog").close();
$("#go-home").onclick = $("#result-home").onclick = () => {
  $("#result-dialog").close();
  navigate("home");
};
$("#export-record").onclick = () => {
  const url = URL.createObjectURL(
      new Blob([exportKIF(game, players, durations)], {
        type: "text/plain;charset=utf-8",
      }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = `sakurama-${new Date().toISOString().slice(0, 10)}.kif`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};
$$("[data-page-link]").forEach(
  (b) => (b.onclick = () => navigate(b.dataset.pageLink)),
);
$(".brand").onclick = (e) => {
  e.preventDefault();
  navigate("home");
};

function publicProfile() {
  const p = store.profile;
  return { name: p.name, avatar: p.avatar.length < 60000 ? p.avatar : "" };
}
function createNet() {
  net = new OnlineRoom(store.broker);
  net.on("status", (value) => {
    netStatus = value;
    renderNet();
    if (online()) render(false);
  });
  net.on("start", onlineStart);
  net.on("message", onlineMessage);
  net.on("peer", (isOnline) => {
    if (!online()) return;
    if (isOnline) peerBack();
    else if (!game.result) {
      peerLostAt ??= Date.now();
      render(false);
    } else {
      peerLeft = true;
      renderAgain();
    }
  });
  net.on("reconnected", () => {
    if (online()) net.send("hello", { n: game.history.length });
  });
}
function closeNet() {
  net?.close();
  net = null;
  netStatus = "idle";
  renderNet();
}
let matchTimer = null,
  pendingInvite = null,
  onlineKind = "friend";
function setLobby(state) {
  $("#online-page").dataset.state = state;
  clearInterval(matchTimer);
  if (state !== "matching") return;
  const since = Date.now(),
    show = () => {
      const s = Math.floor((Date.now() - since) / 1000);
      $("#match-elapsed").textContent =
        `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
  show();
  matchTimer = setInterval(show, 1000);
}
const timeLabel = (name) =>
  $(`input[name="${name}"]:checked + span`).firstChild.textContent.trim();
function enterLobby() {
  if ($("#online-page").dataset.state !== "lobby") net?.cancel();
  setLobby("lobby");
  $("#join-error").textContent = "";
  $("#invite-note").hidden = !pendingInvite;
  if (pendingInvite) {
    showOnlineMode("friend");
    $("#room-code-input").value = pendingInvite;
    pendingInvite = null;
  } else showOnlineMode(store.online.mode);
  if (!net) createNet();
  net.connect().catch(() => {});
}
function showOnlineMode(mode, save = false) {
  for (const b of $$("[data-online-mode]"))
    b.setAttribute("aria-selected", b.dataset.onlineMode === mode);
  for (const panel of $$("[data-online-panel]"))
    panel.hidden = panel.dataset.onlinePanel !== mode;
  if (save) {
    store.online = { mode };
    persist();
  }
}
$$("[data-online-mode]").forEach((b) => {
  b.onclick = () => showOnlineMode(b.dataset.onlineMode, true);
  b.onkeydown = (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const other = $$("[data-online-mode]").find((x) => x !== b);
    other.focus();
    other.click();
  };
});
// Links to 127.0.0.1 or localhost only work on this computer, so only offer
// an invite link when the page is reachable by others.
const canInvite = () =>
  /^https?:$/.test(location.protocol) &&
  !/^(localhost|127(\.\d+){3}|\[::1\])$/.test(location.hostname);
function renderNet() {
  const el = $("#net-status");
  el.dataset.state = netStatus;
  $("#net-text").textContent =
    {
      idle: "尚未連線",
      connecting: "連線中…",
      online: "已連線",
      offline: "連線中斷，重新連線中…",
      error: "無法連線，請確認網路後重試",
    }[netStatus] || "";
  $("#net-retry").hidden = netStatus !== "error";
  $("#room-create").disabled =
    $("#room-join").disabled =
    $("#match-start").disabled =
      netStatus !== "online";
}
$("#net-retry").onclick = () => {
  closeNet();
  enterLobby();
};
$("#create-form").onsubmit = async (e) => {
  e.preventDefault();
  store.room = { time: radio("room-time"), side: radio("room-side") };
  persist();
  onlineKind = "friend";
  try {
    const code = await net.create({
      time: TIMES[store.room.time],
      side: store.room.side,
      player: publicProfile(),
    });
    $("#room-code-display").textContent = code;
    $("#room-share").hidden = !canInvite();
    $("#room-rule").textContent =
      `${timeLabel("room-time")} · ${{ 0: "我方先手", 1: "我方後手", random: "隨機先後" }[store.room.side]}`;
    setLobby("waiting");
  } catch (error) {
    if (error.message !== "cancelled") toast("建立房間失敗，請稍後再試。");
  }
};
$("#match-form").onsubmit = async (e) => {
  e.preventDefault();
  store.match = { time: radio("match-time") };
  persist();
  onlineKind = "match";
  $("#match-rule").textContent = `${timeLabel("match-time")} · 隨機先後`;
  setLobby("matching");
  const room = net;
  try {
    await room.match({ time: TIMES[store.match.time], player: publicProfile() });
  } catch {
    if (net !== room || $("#online-page").dataset.state !== "matching") return;
    setLobby("lobby");
    toast("配對失敗，請稍後再試。");
  }
};
$("#match-cancel").onclick = async () => {
  setLobby("lobby");
  await net?.cancel();
};
$("#room-code-input").oninput = (e) => {
  e.target.value = cleanRoomCode(e.target.value);
  $("#join-error").textContent = "";
};
$("#join-form").onsubmit = async (e) => {
  e.preventDefault();
  const code = cleanRoomCode($("#room-code-input").value);
  if (code.length !== 5) {
    $("#join-error").textContent = "請輸入 5 碼房號。";
    return;
  }
  onlineKind = "friend";
  setLobby("joining");
  try {
    await net.join(code, publicProfile());
  } catch (error) {
    setLobby("lobby");
    $("#join-error").textContent =
      {
        "not-found": "找不到這個房間。",
        full: "房間已經開始對局。",
        "no-response": "房主沒有回應。",
      }[error.message] || "加入失敗，請稍後再試。";
  }
};
$("#room-copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("#room-code-display").textContent);
    toast("已複製房號。");
  } catch {
    toast("無法複製，請手動記下房號。");
  }
};
$("#room-share").onclick = async () => {
  const url = `${location.origin}${location.pathname}#/join/${$("#room-code-display").textContent}`;
  try {
    if (navigator.share)
      await navigator.share({ title: "櫻間 Shogi", text: "來下一局將棋吧！", url });
    else {
      await navigator.clipboard.writeText(url);
      toast("已複製邀請連結。");
    }
  } catch (error) {
    if (error?.name !== "AbortError") toast("無法分享，請改傳房號。");
  }
};
$("#room-cancel").onclick = async () => {
  await net?.cancel();
  setLobby("lobby");
};
function onlineStart(detail) {
  const time = Array.isArray(detail.time) ? detail.time : [0, 0];
  const [main, byoyomi] = Object.values(TIMES).find(
    (t) => t[0] === time[0] && t[1] === time[1],
  ) || [0, 0];
  const opponent = cleanProfile(detail.opponent, { name: "對手", avatar: "" });
  const mySide = detail.mySide === 1 ? 1 : 0;
  startGame({
    mode: "online",
    mySide,
    main,
    byoyomi,
    code: detail.code,
    kind: onlineKind,
    players: mySide ? [opponent, store.profile] : [store.profile, opponent],
  });
  toast(detail.game > 1 ? "再戰開始！" : "對局開始！");
}
function peerBack() {
  if (!peerLostAt) return;
  peerLostAt = null;
  render(false);
  toast("對手已重新連線。");
}
const validMove = (m) =>
  m &&
  Number.isInteger(m.to) &&
  m.to >= 0 &&
  m.to < 81 &&
  (m.drop ? HAND_TYPES.includes(m.drop) : Number.isInteger(m.from));
function applyRemoteClock(side, data) {
  if (!data) return;
  const { remaining, used } = data;
  if (Number.isFinite(remaining) && remaining >= 0)
    clock.remaining[side] = remaining;
  if (Number.isFinite(used) && used >= 0) clock.used[side] = used;
}
function onlineMessage(msg) {
  if (!online()) return;
  peerBack();
  const opp = 1 - session.mySide;
  if (msg.t === "rematch") {
    rematch.peer = true;
    if (rematch.me) net.restart();
    else toast("對手想再來一局。");
    renderAgain();
    return;
  }
  if (msg.t === "leave") {
    peerLeft = true;
    renderAgain();
    if (game.result) toast("對手已離開房間。");
    return;
  }
  if (msg.g !== net.game) return;
  if (msg.t === "hello") {
    if (game.history.length > msg.n)
      net.send("sync", {
        n: msg.n,
        moves: game.history.slice(msg.n).map((h) => h.move),
        clock: clock.serialize(),
        result: game.result,
      });
    return;
  }
  if (msg.t === "sync") return applySync(msg);
  if (game.result) return;
  if (msg.t === "move") {
    if (!validMove(msg.move) || game.position.turn !== opp) return;
    if (msg.n > game.history.length) {
      net.send("hello", { n: game.history.length });
      return;
    }
    if (animating) {
      pendingRemote.push(msg);
      return;
    }
    if (msg.n !== game.history.length) return;
    tick();
    applyRemoteClock(opp, msg.clock);
    executeMove(msg.move, {
      spent: Number.isFinite(msg.spent) ? msg.spent : 0,
    });
  } else if (msg.t === "resign") {
    game.resign(opp);
    finish();
  } else if (msg.t === "timeout") {
    game.result = { winner: session.mySide, reason: "timeout" };
    finish();
  } else if (
    msg.t === "declare" &&
    msg.n === game.history.length &&
    game.position.turn === opp
  ) {
    game.declare();
    finish();
  }
}
function applySync(msg) {
  if (!Array.isArray(msg.moves) || !Number.isInteger(msg.n)) return;
  const skip = game.history.length - msg.n;
  if (skip < 0 || animating) return;
  let changed = false;
  for (const move of msg.moves.slice(skip)) {
    if (!validMove(move)) break;
    try {
      game.play(move);
      durations.push(0);
      changed = true;
    } catch {
      break;
    }
  }
  const opp = 1 - session.mySide;
  applyRemoteClock(opp, {
    remaining: msg.clock?.remaining?.[opp],
    used: msg.clock?.used?.[opp],
  });
  if (
    !game.result &&
    msg.result &&
    [0, 1, null].includes(msg.result.winner) &&
    ["resign", "timeout", "declaration", "invalid-declaration"].includes(
      msg.result.reason,
    )
  )
    game.result = msg.result;
  if (changed || game.result) {
    lastTick = Date.now();
    render();
    if (game.result) finish();
  }
}

$("#settings-open").onclick = () => openSettings();
$("#profile-edit").onclick = () => openSettings("profile");
let settingsPaused = false;
function openSettings(tab = "profile") {
  if (offline() && gameActive() && !paused) {
    setPaused(true);
    settingsPaused = true;
  }
  showTab(tab);
  loadProfileDraft();
  $("#broker-url").value = store.broker;
  $("#broker-error").textContent = "";
  $("#settings-dialog").showModal();
}
$("#settings-close").onclick = () => $("#settings-dialog").close();
$("#settings-dialog").addEventListener("close", () => {
  if (settingsPaused) {
    settingsPaused = false;
    setPaused(false);
  }
});
function showTab(tab) {
  for (const b of $$("[data-tab]"))
    b.setAttribute("aria-selected", b.dataset.tab === tab);
  for (const panel of $$("[data-panel]"))
    panel.hidden = panel.dataset.panel !== tab;
}
$$("[data-tab]").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
$("#animation-setting").onchange = (e) => {
  store.prefs.animation = e.target.checked;
  persist();
};
$("#speed-setting").onchange = (e) => {
  store.prefs.speed = Number(e.target.value);
  persist();
};
$("#legal-setting").onchange = (e) => {
  store.prefs.legal = e.target.checked;
  if (session) highlight();
  persist();
};
function applyPreferences() {
  const prefs = store.prefs;
  document.body.dataset.theme = prefs.theme;
  $('meta[name="theme-color"]').content = {
    spring: "#fbeff3",
    sunset: "#1b1210",
    night: "#090c17",
  }[prefs.theme];
  board.setTheme(prefs.theme);
  board.setShadows(prefs.shadows);
  $("#animation-setting").checked = prefs.animation;
  $("#speed-setting").value = prefs.speed;
  $("#legal-setting").checked = prefs.legal;
  $$(".themes [data-theme]").forEach((b) =>
    b.classList.toggle("selected", b.dataset.theme === prefs.theme),
  );
  $("#sound-toggle").textContent = prefs.sound ? "♫ 音效開" : "♫ 音效關";
  $("#sound-toggle").setAttribute("aria-pressed", prefs.sound);
  $("#shadow-toggle").textContent = prefs.shadows ? "◐ 陰影開" : "◐ 陰影關";
  $("#shadow-toggle").setAttribute("aria-pressed", prefs.shadows);
}
$$(".themes [data-theme]").forEach(
  (b) =>
    (b.onclick = () => {
      store.prefs.theme = b.dataset.theme;
      applyPreferences();
      persist();
    }),
);
$("#sound-toggle").onclick = () => {
  store.prefs.sound = !store.prefs.sound;
  applyPreferences();
  persist();
  if (store.prefs.sound) playSound();
};
$("#shadow-toggle").onclick = () => {
  store.prefs.shadows = !store.prefs.shadows;
  applyPreferences();
  persist();
};
let audio, komaBuffer, komaLoading;
function audioContext() {
  audio ??= new AudioContext();
  if (audio.state === "suspended") audio.resume();
  return audio;
}
function loadKoma() {
  komaLoading ??= fetch("assets/sounds/koma-strong.mp3")
    .then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.arrayBuffer();
    })
    .then((data) => audioContext().decodeAudioData(data))
    .then((buffer) => (komaBuffer = buffer))
    .catch(() => null);
  return komaLoading;
}
document.addEventListener(
  "pointerdown",
  () => {
    if (store.prefs.sound) loadKoma();
  },
  { once: true },
);
function playSound() {
  if (!store.prefs.sound) return;
  try {
    audioContext();
    if (komaBuffer) {
      const source = audio.createBufferSource();
      source.buffer = komaBuffer;
      source.playbackRate.value = 0.96 + Math.random() * 0.08;
      source.connect(audio.destination);
      source.start();
      return;
    }
    loadKoma();
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
let draftAvatar = "",
  uploadJob = 0;
function loadProfileDraft() {
  draftAvatar = store.profile.avatar;
  $("#profile-name").value = store.profile.name;
  $("#profile-error").textContent = "";
  $("#avatar-file").value = "";
  renderAvatar($("#profile-avatar"), store.profile);
}
const draftPreview = () =>
  renderAvatar($("#profile-avatar"), {
    name: $("#profile-name").value || "棋",
    avatar: draftAvatar,
  });
$("#profile-name").oninput = draftPreview;
$("#avatar-reset").onclick = () => {
  uploadJob++;
  draftAvatar = "";
  draftPreview();
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
      "請選擇 5 MB 以內的圖片。";
    return;
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (id !== uploadJob) return;
    const c = document.createElement("canvas");
    c.width = c.height = 160;
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
      160,
      160,
    );
    draftAvatar = c.toDataURL("image/webp", 0.82);
    draftPreview();
  } catch {
    $("#profile-error").textContent = "無法讀取這張圖片，請換一張再試。";
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
  store.profile = { name: name.slice(0, 20), avatar: draftAvatar };
  persist();
  if (offline()) players[session.mode === "ai" ? session.mySide : 0] = store.profile;
  renderHome();
  render(false);
  $("#settings-dialog").close();
  toast("玩家資料已儲存。");
};
$("#network-form").onsubmit = (e) => {
  e.preventDefault();
  const url = $("#broker-url").value.trim();
  if (!/^wss?:\/\/\S+$/.test(url)) {
    $("#broker-error").textContent = "網址格式不正確，請確認後再試。";
    return;
  }
  store.broker = url;
  persist();
  $("#broker-error").textContent = "";
  if (!online()) {
    closeNet();
    if (currentPage === "online") enterLobby();
  }
  $("#settings-dialog").close();
  toast(online() ? "新的伺服器會在下一局使用。" : "連線設定已儲存。");
};
$("#broker-reset").onclick = () => {
  $("#broker-url").value = DEFAULT_BROKER;
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
setRadio("cpu-level", store.cpu.level);
setRadio("cpu-side", store.cpu.side);
setRadio("cpu-time", store.cpu.time);
setRadio("local-time", store.local.time);
setRadio("room-time", store.room.time);
setRadio("room-side", store.room.side);
setRadio("match-time", store.match.time);
$("#local-name").value = store.local.name;
applyPreferences();
renderNet();
const startSfen = new URLSearchParams(location.search).get("sfen");
if (startSfen) {
  try {
    fromSFEN(startSfen);
    startLocal(startSfen);
  } catch {
    navigate("home", true);
  }
} else navigate(location.hash.slice(2) || "home", true);
