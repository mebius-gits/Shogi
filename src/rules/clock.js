export class GameClock {
  constructor(mainSeconds = 0, byoyomiSeconds = 0, saved = null) {
    this.main = mainSeconds * 1000;
    this.byoyomi = byoyomiSeconds * 1000;
    this.remaining = saved?.remaining?.slice() || [this.main, this.main];
    this.period = saved?.period ?? this.byoyomi;
    this.used = saved?.used?.slice() || [0, 0];
  }
  get unlimited() {
    return this.main === 0 && this.byoyomi === 0;
  }
  charge(side, ms) {
    ms = Math.max(0, ms);
    this.used[side] += ms;
    if (this.unlimited) return false;
    const mainUsed = Math.min(this.remaining[side], ms);
    this.remaining[side] -= mainUsed;
    ms -= mainUsed;
    if (ms > 0) this.period = Math.max(0, this.period - ms);
    return this.remaining[side] <= 0 && this.period <= 0;
  }
  nextTurn() {
    this.period = this.byoyomi;
  }
  display(side, turn) {
    if (this.unlimited) return "∞";
    const value =
      this.remaining[side] > 0
        ? this.remaining[side]
        : side === turn
          ? this.period
          : this.byoyomi;
    const seconds = Math.ceil(value / 1000);
    return `${Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  }
  serialize() {
    return {
      remaining: this.remaining.slice(),
      period: this.period,
      used: this.used.slice(),
    };
  }
}
