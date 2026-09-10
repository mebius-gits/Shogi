export function exportKIF(game, profiles, durations = []) {
  const lines = [
    "#KIF version=2.0 encoding=UTF-8",
    "手合割：平手",
    `先手：${profiles[0].name}`,
    `後手：${profiles[1].name}`,
    "手数----指手---------消費時間--",
  ];
  const totals = [0, 0];
  game.history.forEach((h, i) => {
    const seconds = Math.floor((durations[i] || 0) / 1000),
      side = i % 2;
    totals[side] += seconds;
    const time = (n) =>
      `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
    const notation = h.text
      .slice(1)
      .replace(/^[1-9]/, (n) => "０１２３４５６７８９"[Number(n)]);
    lines.push(
      `${i + 1} ${notation} ( ${time(seconds)}/${Math.floor(totals[side] / 3600)}:${String(Math.floor(totals[side] / 60) % 60).padStart(2, "0")}:${String(totals[side] % 60).padStart(2, "0")} )`,
    );
  });
  if (game.result) {
    const words = {
      resign: "投了",
      timeout: "切れ負け",
      checkmate: "詰み",
      repetition: "千日手",
      "perpetual-check": "反則負け",
      declaration: "入玉勝ち",
      "invalid-declaration": "反則負け",
      "move-limit": "持将棋",
      disconnect: "中断",
    };
    lines.push(
      `${game.history.length + 1} ${words[game.result.reason] || "詰み"}`,
    );
    lines.push(
      game.result.winner === null
        ? "まで無勝負"
        : `まで${game.history.length}手で${game.result.winner ? "後手" : "先手"}の勝ち`,
    );
  }
  return "\ufeff" + lines.join("\n");
}
