import mqtt from "../../vendor/mqtt.esm.js";

export const DEFAULT_BROKER = "wss://broker.emqx.io:8084/mqtt";
const ROOT = "sakurama-shogi/v1";
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
export const makeRoomCode = () =>
  Array.from(random(5), (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
export const cleanRoomCode = (text) =>
  [...String(text).toUpperCase()]
    .filter((c) => CODE_CHARS.includes(c))
    .join("")
    .slice(0, 5);
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// Lobby handshake: the host keeps a retained room/<code>/info message; the
// guest reads it, sends "join", and the host answers with "start" addressed to
// that guest. Every later message goes through room/<code>/msg.
export class OnlineRoom {
  constructor(url = DEFAULT_BROKER) {
    this.url = url;
    this.id =
      "sks-" +
      Array.from(random(6), (b) => b.toString(16).padStart(2, "0")).join("");
    this.handlers = {};
    this.client = null;
    this.status = "idle";
    this.reset();
  }
  reset() {
    this.code = null;
    this.role = null;
    this.peer = null;
    this.game = 0;
    this.options = null;
    this.waiter = null;
  }
  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
    return this;
  }
  emit(type, detail) {
    for (const fn of this.handlers[type] || []) fn(detail);
  }
  topic(...parts) {
    return [ROOT, ...parts].join("/");
  }
  setStatus(status) {
    this.status = status;
    this.emit("status", status);
  }
  connect() {
    if (this.client) return this.ready;
    this.setStatus("connecting");
    const client = mqtt.connect(this.url, {
      clientId: this.id,
      protocolVersion: 5,
      clean: true,
      keepalive: 15,
      reconnectPeriod: 2500,
      connectTimeout: 8000,
      will: {
        topic: this.topic("presence", this.id),
        payload: "offline",
        qos: 1,
        retain: false,
      },
    });
    this.client = client;
    let connected = false;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 10000);
      client.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.ready.catch(() => this.setStatus("error"));
    client.on("connect", () => {
      client.publish(this.topic("presence", this.id), "online", { qos: 1 });
      this.setStatus("online");
      if (connected) this.emit("reconnected");
      connected = true;
    });
    client.on("reconnect", () => this.setStatus("connecting"));
    client.on("offline", () => this.setStatus(connected ? "offline" : "error"));
    client.on("error", () => {
      if (!connected) this.setStatus("error");
    });
    client.on("message", (topic, payload) =>
      this.receive(topic, new TextDecoder().decode(payload)),
    );
    return this.ready;
  }
  close() {
    const client = this.client;
    if (client && this.role === "host" && !this.peer && this.code)
      client.publish(this.topic("room", this.code, "info"), "", {
        qos: 1,
        retain: true,
      });
    this.client = null;
    this.reset();
    this.setStatus("idle");
    client?.end(false);
  }
  async create({ time, side, player }) {
    await this.connect();
    this.reset();
    this.role = "host";
    this.code = makeRoomCode();
    this.options = { time, side, player };
    await this.client.subscribeAsync(this.topic("room", this.code, "msg"), {
      qos: 1,
    });
    await this.client.publishAsync(
      this.topic("room", this.code, "info"),
      JSON.stringify({ v: 1, host: this.id, time, side }),
      { qos: 1, retain: true, properties: { messageExpiryInterval: 900 } },
    );
    return this.code;
  }
  async cancel() {
    if (this.role === "host" && !this.peer && this.code && this.client)
      await this.clearInfo();
    if (this.code && this.client)
      this.client.unsubscribe([
        this.topic("room", this.code, "msg"),
        this.topic("room", this.code, "info"),
      ]);
    this.reset();
  }
  clearInfo() {
    return this.client.publishAsync(this.topic("room", this.code, "info"), "", {
      qos: 1,
      retain: true,
    });
  }
  async join(code, player) {
    await this.connect();
    this.reset();
    this.role = "guest";
    this.code = code;
    const info = await new Promise((resolve) => {
      this.waiter = { info: resolve };
      setTimeout(() => resolve(null), 6000);
      this.client.subscribe(this.topic("room", code, "info"), { qos: 1 });
    });
    if (!info?.host) {
      this.reset();
      throw new Error("not-found");
    }
    await this.client.subscribeAsync(this.topic("room", code, "msg"), {
      qos: 1,
    });
    return new Promise((resolve, reject) => {
      const fail = (reason) => {
        this.reset();
        reject(new Error(reason));
      };
      const timer = setTimeout(() => fail("no-response"), 9000);
      this.waiter = {
        start: (detail) => {
          clearTimeout(timer);
          resolve(detail);
        },
        full: () => {
          clearTimeout(timer);
          fail("full");
        },
      };
      this.send("join", { player });
    });
  }
  restart() {
    if (this.role !== "host" || !this.peer) return;
    this.game++;
    this.options.hostSide = 1 - this.options.hostSide;
    this.sendStart();
  }
  sendStart() {
    const { hostSide, time, player } = this.options;
    this.send("start", {
      to: this.peer.id,
      hostSide,
      time,
      host: player,
      guest: this.peer.player,
    });
    this.emit("start", {
      code: this.code,
      game: this.game,
      mySide: hostSide,
      time,
      opponent: this.peer.player,
    });
  }
  send(t, data = {}) {
    if (!this.client || !this.code) return;
    this.client.publish(
      this.topic("room", this.code, "msg"),
      JSON.stringify({ v: 1, t, from: this.id, g: this.game, ...data }),
      { qos: 1 },
    );
  }
  receive(topic, text) {
    if (this.peer && topic === this.topic("presence", this.peer.id)) {
      this.emit("peer", text === "online");
      return;
    }
    if (!this.code) return;
    if (topic === this.topic("room", this.code, "info")) {
      this.waiter?.info?.(text ? parse(text) : null);
      return;
    }
    const msg = parse(text);
    if (!msg || msg.v !== 1 || msg.from === this.id) return;
    if (msg.t === "join" && this.role === "host" && !this.peer) {
      this.peer = { id: msg.from, player: msg.player };
      this.game = 1;
      const side = this.options.side;
      this.options.hostSide =
        side === "random" ? random(1)[0] & 1 : Number(side) === 1 ? 1 : 0;
      this.clearInfo();
      this.client.subscribe(this.topic("presence", this.peer.id), { qos: 1 });
      this.sendStart();
      return;
    }
    if (msg.t === "start" && this.role === "guest") {
      if (msg.to !== this.id) {
        if (!this.peer) this.waiter?.full?.();
        return;
      }
      if (!this.peer) {
        this.peer = { id: msg.from, player: msg.host };
        this.client.subscribe(this.topic("presence", this.peer.id), {
          qos: 1,
        });
      }
      this.game = msg.g;
      const detail = {
        code: this.code,
        game: msg.g,
        mySide: msg.hostSide === 1 ? 0 : 1,
        time: msg.time,
        opponent: msg.host,
      };
      if (this.waiter?.start) {
        this.waiter.start(detail);
        this.waiter = null;
      }
      this.emit("start", detail);
      return;
    }
    if (!this.peer || msg.from !== this.peer.id) return;
    this.emit("message", msg);
  }
}
