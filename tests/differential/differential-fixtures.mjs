import { Game, legalMoves, toSFEN, toUSI } from "../../src/rules/engine.js";
import { writeFile } from "node:fs/promises";
let seed = 314159;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const fixtures = [];
for (let run = 0; run < 8; run++) {
  const game = new Game();
  for (let ply = 0; ply < 220 && !game.result; ply++) {
    const moves = legalMoves(game.position);
    if (!moves.length) break;
    fixtures.push({
      sfen: toSFEN(game.position),
      moves: moves.map(toUSI).sort(),
    });
    let candidates = moves.filter(
      (m) => game.position.board[m.to] || m.promote || m.drop,
    );
    if (!candidates.length || random() < 0.55) candidates = moves;
    game.play(candidates[Math.floor(random() * candidates.length)]);
  }
}
await writeFile("tests/differential/differential-fixtures.json", JSON.stringify(fixtures));
console.log(`Wrote ${fixtures.length} independently checkable positions.`);
