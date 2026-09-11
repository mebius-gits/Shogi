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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const AD_EXPIRY = 45;
const AD_REFRESH = 20000;

// Lobby handshake: the host keeps a retained room/<code>/info message; the
// guest reads it, sends "join", and the host answers with "start" addressed to
// that guest. Every later message goes through room/<code>/msg.
//
// Random matching reuses the same rooms: seekers advertise their room under a
// retained match/<time>/<code> message. A new seeker joins a random advert, or
// hosts one when none is left. Two hosts that see each other settle it by
// room code: the larger code gives up its room and joins the smaller one.
export class OnlineRoom {
  constructor(url = DEFAULT_BROKER) {
    this.url = url;
    this.id =
      "sks-" +
      Array.from(random(6), (b) => b.toString(16).padStart(2, "0")).join("");
    this.handlers = {};
    this.client = null;
    this.status = "idle";
    this.op = 0;
    this.lobby = null;
    this.reset();
  }
  reset() {
    this.op++;
    this.code = null;
    this.role = null;
    this.peer = null;
    this.game = 0;
    this.options = null;
    this.waiter = null;
    this.adTopic = null;
    clearInterval(this.adTimer);
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
    this.endLobby();
    if (client && this.role === "host" && !this.peer && this.code)
      this.clearInfo();
    this.client = null;
    this.reset();
    this.setStatus("idle");
    client?.end(false);
  }
  async create({ time, side, player }) {
    await this.connect();
    this.reset();
    const op = this.op,
      client = this.client,
      code = makeRoomCode();
    this.role = "host";
    this.code = code;
    this.options = { time, side, player };
    await client.subscribeAsync(this.topic("room", code, "msg"), { qos: 1 });
    await client.publishAsync(
      this.topic("room", code, "info"),
      JSON.stringify({ v: 1, host: this.id, time, side }),
      { qos: 1, retain: true, properties: { messageExpiryInterval: 900 } },
    );
    if (this.op !== op) {
      this.unsubscribeRoom(client, code);
      await this.clearInfo(code, null, client);
      throw new Error("cancelled");
    }
    return code;
  }
  async cancel() {
    this.endLobby();
    await this.leaveRoom();
  }
  async leaveRoom() {
    const { code, client, adTopic } = this,
      open = this.role === "host" && !this.peer;
    this.reset();
    if (!code || !client) return;
    this.unsubscribeRoom(client, code);
    if (open) await this.clearInfo(code, adTopic, client);
  }
  unsubscribeRoom(client, code) {
    client.unsubscribe([
      this.topic("room", code, "msg"),
      this.topic("room", code, "info"),
    ]);
  }
  clearInfo(code = this.code, adTopic = this.adTopic, client = this.client) {
    const topics = [this.topic("room", code, "info")];
    if (adTopic) topics.push(adTopic);
    return Promise.all(
      topics.map((topic) =>
        client
          .publishAsync(topic, "", { qos: 1, retain: true })
          .catch(() => {}),
      ),
    );
  }
  async join(code, player, { wait = 9000 } = {}) {
    await this.connect();
    this.reset();
    const op = this.op,
      client = this.client;
    this.role = "guest";
    this.code = code;
    const info = await new Promise((resolve) => {
      this.waiter = { info: resolve };
      setTimeout(() => resolve(null), 6000);
      client.subscribe(this.topic("room", code, "info"), { qos: 1 });
    });
    if (this.op !== op) throw new Error("cancelled");
    if (!info?.host) {
      this.reset();
      this.unsubscribeRoom(client, code);
      throw new Error("not-found");
    }
    await client.subscribeAsync(this.topic("room", code, "msg"), {
      qos: 1,
    });
    if (this.op !== op) throw new Error("cancelled");
    return new Promise((resolve, reject) => {
      const fail = (reason) => {
        if (this.op === op) {
          this.reset();
          this.unsubscribeRoom(client, code);
        }
        reject(new Error(reason));
      };
      const timer = setTimeout(
        () => fail(this.op === op ? "no-response" : "cancelled"),
        wait,
      );
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
  // Resolves once a game starts (the "start" event has fired) or the search is
  // cancelled; rejects only when the broker cannot be used.
  async match({ time, player }) {
    await this.connect();
    this.endLobby();
    await this.leaveRoom();
    const client = this.client,
      lobby = {
        base: this.topic("match", time.join("-")),
        ads: new Map(),
        tried: new Set(),
        wake: null,
      };
    this.lobby = lobby;
    const live = () => this.lobby === lobby && this.client === client;
    try {
      await client.subscribeAsync(lobby.base + "/+", { qos: 1 });
      await sleep(1200);
      while (live() && !this.peer) {
        const ad = this.pickAd(lobby);
        if (ad) {
          lobby.tried.add(ad.code);
          if (this.role === "host") await this.leaveRoom();
          if (!live()) break;
          try {
            await this.join(ad.code, player, { wait: 5000 });
            break;
          } catch {
            continue;
          }
        }
        if (this.role !== "host") {
          try {
            await this.create({ time, side: "random", player });
          } catch (error) {
            if (live()) throw error;
            break;
          }
          if (!live()) break;
          const topic = (this.adTopic = `${lobby.base}/${this.code}`),
            ad = JSON.stringify({ v: 1, host: this.id }),
            advertise = () =>
              client.publish(topic, ad, {
                qos: 1,
                retain: true,
                properties: { messageExpiryInterval: AD_EXPIRY },
              });
          advertise();
          this.adTimer = setInterval(advertise, AD_REFRESH);
          if (this.pickAd(lobby)) continue;
        }
        await new Promise((resolve) => (lobby.wake = resolve));
      }
    } finally {
      if (this.lobby === lobby) this.endLobby();
    }
  }
  pickAd(lobby) {
    const choices = [...lobby.ads.keys()].filter(
      (code) =>
        !lobby.tried.has(code) && (this.role !== "host" || code < this.code),
    );
    return choices.length
      ? { code: choices[random(1)[0] % choices.length] }
      : null;
  }
  endLobby() {
    const lobby = this.lobby;
    if (!lobby) return;
    this.lobby = null;
    this.client?.unsubscribe(lobby.base + "/+");
    this.wakeLobby(lobby);
  }
  wakeLobby(lobby = this.lobby) {
    const wake = lobby?.wake;
    if (lobby) lobby.wake = null;
    wake?.();
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
    const lobby = this.lobby;
    if (lobby && topic.startsWith(lobby.base + "/")) {
      const code = topic.slice(lobby.base.length + 1),
        ad = text ? parse(text) : null;
      if (
        ad?.v === 1 &&
        ad.host !== this.id &&
        code.length === 5 &&
        cleanRoomCode(code) === code
      ) {
        // A refreshed advert means its host is still waiting, so a failed
        // attempt on that room may be retried.
        lobby.ads.set(code, ad.host);
        lobby.tried.delete(code);
      } else lobby.ads.delete(code);
      this.wakeLobby(lobby);
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
      clearInterval(this.adTimer);
      this.clearInfo();
      this.wakeLobby();
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
