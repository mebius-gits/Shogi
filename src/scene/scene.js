import * as THREE from "three";
import { makeHand, updateHandMove } from "./hand.js";
import { LABELS, col, row } from "../rules/engine.js";
export const XSTEP = 0.95,
  ZSTEP = 1.06,
  TOP = 0.76;
const textureCache = new Map();
const material = (color, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.78, ...extra });
function texture(key, draw, size = 1024) {
  if (textureCache.has(key)) return textureCache.get(key);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  draw(canvas.getContext("2d"), size);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  textureCache.set(key, t);
  return t;
}
function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}
export const squarePosition = (i) =>
  new THREE.Vector3((col(i) - 4) * XSTEP, TOP + 0.036, (row(i) - 4) * ZSTEP);
function boardTexture() {
  return texture(
    "board",
    (ctx, s) => {
      ctx.fillStyle = "#cfa365";
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 320; i++) {
        const x = (i * 83.931) % s;
        ctx.lineWidth = (i % 2) * 0.35 + 0.4;
        ctx.strokeStyle = i % 3 ? "#75482409" : "#ffe2a514";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.bezierCurveTo(x + 11, s * 0.35, x - 13, s * 0.75, x + 4, s);
        ctx.stroke();
      }
      const px = ((9.2 - XSTEP * 9) / 18.4) * s,
        pz = ((10.18 - ZSTEP * 9) / 20.36) * s;
      ctx.strokeStyle = "#46351f";
      ctx.lineWidth = 3.2;
      for (let i = 0; i <= 9; i++) {
        ctx.beginPath();
        ctx.moveTo(px + ((i * XSTEP) / 9.2) * s, pz);
        ctx.lineTo(px + ((i * XSTEP) / 9.2) * s, s - pz);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(px, pz + ((i * ZSTEP) / 10.18) * s);
        ctx.lineTo(s - px, pz + ((i * ZSTEP) / 10.18) * s);
        ctx.stroke();
      }
      for (const c of [3, 6])
        for (const r of [3, 6]) {
          ctx.beginPath();
          ctx.arc(
            px + ((c * XSTEP) / 9.2) * s,
            pz + ((r * ZSTEP) / 10.18) * s,
            4,
            0,
            7,
          );
          ctx.fillStyle = "#443327";
          ctx.fill();
        }
      ctx.font = `${s * 0.019}px Georgia,serif`;
      ctx.fillStyle = "#4c3a2c";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let i = 0; i < 9; i++) {
        ctx.fillText(9 - i, px + (((i + 0.5) * XSTEP) / 9.2) * s, pz * 0.44);
        ctx.fillText(
          "一二三四五六七八九"[i],
          s - px * 0.45,
          pz + (((i + 0.5) * ZSTEP) / 10.18) * s,
        );
      }
    },
    1536,
  );
}
const shape = new THREE.Shape();
shape.moveTo(-0.335, -0.42);
shape.lineTo(0.335, -0.42);
shape.lineTo(0.29, 0.28);
shape.lineTo(0, 0.45);
shape.lineTo(-0.29, 0.28);
shape.closePath();
const pieceGeometry = new THREE.ExtrudeGeometry(shape, {
  depth: 0.09,
  bevelEnabled: true,
  bevelSegments: 2,
  steps: 1,
  bevelSize: 0.018,
  bevelThickness: 0.015,
});
pieceGeometry.rotateX(-Math.PI / 2);
const faceGeometry = new THREE.PlaneGeometry(0.63, 0.8);
const pieceMat = [material("#ecd2a0"), material("#af7e45")];
const faceMaterials = new Map();
function pieceObject(a) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(pieceGeometry, pieceMat);
  body.castShadow = body.receiveShadow = true;
  g.add(body);
  const key = (a.promoted ? "+" : "") + a.type + (a.type === "K" ? a.side : "");
  if (!faceMaterials.has(key)) {
    const t = texture(
      "glyph" + key,
      (ctx, s) => {
        ctx.clearRect(0, 0, s, s);
        ctx.fillStyle = a.promoted ? "#a62f2b" : "#302a22";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `bold ${s * 0.72}px "Yu Mincho","MS Mincho","PMingLiU",serif`;
        ctx.fillText(
          a.type === "K"
            ? a.side
              ? "王"
              : "玉"
            : LABELS[(a.promoted ? "+" : "") + a.type],
          s * 0.5,
          s * 0.52,
        );
      },
      256,
    );
    faceMaterials.set(
      key,
      new THREE.MeshBasicMaterial({
        map: t,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );
  }
  const face = new THREE.Mesh(faceGeometry, faceMaterials.get(key));
  face.rotation.x = -Math.PI / 2;
  face.position.set(0, 0.11, -0.01);
  g.add(face);
  g.rotation.y = a.side ? Math.PI : 0;
  if (a.type === "P") g.scale.setScalar(0.89);
  else if (a.type === "K") g.scale.setScalar(1.05);
  g.userData.piece = { ...a };
  return g;
}

export class BoardScene {
  constructor(container, onSquare) {
    this.container = container;
    this.onSquare = onSquare;
    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    container.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    this.camera.position.set(0, 20, 7.8);
    this.camera.lookAt(0, 0.4, 0);
    this.ambient = new THREE.HemisphereLight("#fff4e1", "#817457", 2.0);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight("#ffe6bf", 2.65);
    this.sun.position.set(-6, 14, -5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, {
      left: -13,
      right: 13,
      top: 14,
      bottom: -14,
      near: 0.5,
      far: 45,
    });
    this.sun.shadow.normalBias = 0.025;
    this.sun.shadow.bias = -0.0001;
    this.sun.shadow.radius = 4;
    this.scene.add(this.sun);
    const tatami = texture(
      "tatami",
      (ctx, s) => {
        ctx.fillStyle = "#98a082";
        ctx.fillRect(0, 0, s, s);
        for (let y = 0; y < s; y += 5) {
          ctx.fillStyle = y % 10 ? "#58644929" : "#e2dec638";
          ctx.fillRect(0, y, s, 2);
        }
        for (let x = 0; x < s; x += 17) {
          ctx.fillStyle = "#66715412";
          ctx.fillRect(x, 0, 1, s);
        }
      },
      512,
    );
    tatami.wrapS = tatami.wrapT = THREE.RepeatWrapping;
    tatami.repeat.set(4, 4);
    this.floor = box(
      22,
      0.12,
      26,
      material("#ffffff", { map: tatami }),
      0,
      -0.18,
    );
    this.scene.add(this.floor);
    for (const x of [-7, 7])
      this.scene.add(box(0.14, 0.015, 26, material("#5e6b56"), x, -0.105));
    this.scene.add(box(9.2, 0.68, 10.18, material("#9e6e3e"), 0, 0.36));
    this.scene.add(box(9.26, 0.045, 10.24, material("#d9b779"), 0, 0.7));
    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(9.2, 10.18),
      material("#ffffff", { map: boardTexture() }),
    );
    surface.rotation.x = -Math.PI / 2;
    surface.position.y = TOP;
    surface.receiveShadow = true;
    this.scene.add(surface);
    this.pieces = new THREE.Group();
    this.scene.add(this.pieces);
    this.markers = new THREE.Group();
    this.scene.add(this.markers);
    this.objects = new Map();
    this.hands = [makeHand(0), makeHand(1)];
    for (const hand of this.hands) {
      hand.visible = false;
      this.scene.add(hand);
    }
    this.animation = null;
    this.flipped = false;
    this.enabled = true;
    this.shadow = true;
    this.ray = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -TOP);
    this.hit = new THREE.Vector3();
    this.overlay = document.createElement("div");
    this.overlay.className = "board-input";
    this.overlay.setAttribute("role", "group");
    this.overlay.setAttribute("aria-label", "9×9 將棋棋盤");
    container.append(this.overlay);
    this.buttons = [];
    for (let i = 0; i < 81; i++) {
      const b = document.createElement("button");
      b.className = "square-input";
      b.dataset.square = i;
      b.addEventListener("click", () => this.onSquare(i));
      b.addEventListener("keydown", (e) => {
        const delta = {
          ArrowLeft: -1,
          ArrowRight: 1,
          ArrowUp: -9,
          ArrowDown: 9,
        }[e.key];
        if (delta) {
          e.preventDefault();
          const step = this.flipped ? -delta : delta;
          this.buttons[Math.max(0, Math.min(80, i + step))].focus();
        }
      });
      this.overlay.append(b);
      this.buttons.push(b);
    }
    this.renderer.domElement.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      container.dispatchEvent(
        new CustomEvent("rendererror", {
          detail: "棋盤畫面出錯，請重新整理頁面。",
        }),
      );
    });
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }
  resize() {
    const w = this.container.clientWidth,
      h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const target = new THREE.Vector3(0, 0.4, 0);
    const direction = new THREE.Vector3(
      0,
      19.6,
      this.flipped ? -7.8 : 7.8,
    ).normalize();
    let distance = 23;
    for (let n = 0; n < 6; n++) {
      this.camera.position.copy(target).addScaledVector(direction, distance);
      this.camera.lookAt(target);
      this.camera.updateMatrixWorld();
      let fit = 0;
      for (const x of [-4.6, 4.6])
        for (const z of [-5.09, 5.09]) {
          const corner = new THREE.Vector3(x, TOP, z).project(this.camera);
          fit = Math.max(
            fit,
            Math.abs(corner.x) / 0.91,
            Math.abs(corner.y) / 0.9,
          );
        }
      if (n < 5) distance *= fit;
    }
    for (let i = 0; i < 81; i++) {
      const p = squarePosition(i);
      const corners = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([x, z]) => {
        const v = p
          .clone()
          .add(new THREE.Vector3((x * XSTEP) / 2, 0, (z * ZSTEP) / 2))
          .project(this.camera);
        return { x: ((v.x + 1) * w) / 2, y: ((1 - v.y) * h) / 2 };
      });
      const left = Math.min(...corners.map((v) => v.x)),
        top = Math.min(...corners.map((v) => v.y));
      const width = Math.max(...corners.map((v) => v.x)) - left,
        height = Math.max(...corners.map((v) => v.y)) - top;
      const btn = this.buttons[i];
      Object.assign(btn.style, {
        left: left + "px",
        top: top + "px",
        width: width + "px",
        height: height + "px",
        clipPath: `polygon(${corners.map((v) => `${((v.x - left) / width) * 100}% ${((v.y - top) / height) * 100}%`).join(",")})`,
      });
    }
  }
  sync(p, last = null) {
    this.cancel();
    this.pieces.clear();
    this.objects.clear();
    p.board.forEach((a, i) => {
      if (a) {
        const obj = pieceObject(a);
        obj.position.copy(squarePosition(i));
        this.pieces.add(obj);
        this.objects.set(i, obj);
      }
      this.buttons[i].setAttribute(
        "aria-label",
        `${9 - col(i)}${"一二三四五六七八九"[row(i)]} ${a ? (a.side ? "後手 " : "先手 ") + LABELS[(a.promoted ? "+" : "") + a.type] : "空格"}`,
      );
    });
    this.highlight([], null, last);
  }
  highlight(legal = [], selected = null, last = null, checked = null) {
    for (const m of this.markers.children) {
      m.geometry.dispose();
      m.material.dispose();
    }
    this.markers.clear();
    for (const b of this.buttons) {
      b.classList.remove("legal", "selected", "last", "check");
      b.setAttribute("aria-pressed", "false");
    }
    const mark = (i, color, opacity, dot = false) => {
      if (i == null) return;
      const m = new THREE.Mesh(
        dot
          ? new THREE.CircleGeometry(0.105, 32)
          : new THREE.PlaneGeometry(XSTEP * 0.97, ZSTEP * 0.97),
        new THREE.MeshBasicMaterial({
          color,
          opacity,
          transparent: true,
          depthWrite: false,
        }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.copy(squarePosition(i));
      m.position.y = TOP + 0.005;
      this.markers.add(m);
    };
    if (last) {
      mark(last.to, "#cf9143", 0.32);
      this.buttons[last.to].classList.add("last");
      if (last.from != null) mark(last.from, "#cf9143", 0.14);
    }
    if (checked != null) {
      mark(checked, "#ba493e", 0.5);
      this.buttons[checked].classList.add("check");
    }
    if (selected != null) {
      mark(selected, "#7bafa1", 0.52);
      this.buttons[selected].classList.add("selected");
      this.buttons[selected].setAttribute("aria-pressed", "true");
    }
    for (const i of new Set(legal)) {
      mark(
        i,
        "#356852",
        this.objects.has(i) ? 0.28 : 0.65,
        !this.objects.has(i),
      );
      this.buttons[i].classList.add("legal");
    }
  }
  setTheme(theme) {
    const colors = {
      spring: ["#fff0f5", "#fffaf6", 1.34],
      sunset: ["#edcbba", "#ffbe87", 1.05],
      night: ["#c5cbe5", "#c3d0ff", 0.83],
    }[theme] || ["#fff4e1", "#ffe6bf", 1.12];
    this.ambient.color.set(colors[0]);
    this.sun.color.set(colors[1]);
    this.renderer.toneMappingExposure = colors[2];
  }
  setFlipped(flipped) {
    this.flipped = flipped;
    this.resize();
  }
  setShadows(on) {
    this.shadow = on;
    this.renderer.shadowMap.enabled = on;
    this.scene.traverse((o) => {
      if (o.material) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          m.needsUpdate = true;
      }
    });
  }
  cancel() {
    if (this.animation) {
      const a = this.animation;
      this.animation = null;
      for (const h of this.hands) h.visible = false;
      a.resolve(false);
    }
  }
  animate(before, move, { duration = 1850, onLand = () => {} } = {}) {
    this.cancel();
    const a = move.drop
      ? { type: move.drop, side: before.turn, promoted: false }
      : before.board[move.from];
    let object = this.objects.get(move.from);
    if (move.drop) {
      object = pieceObject(a);
      this.pieces.add(object);
    }
    const captured = this.objects.get(move.to);
    if (captured && captured !== object) this.pieces.remove(captured);
    const from = move.drop
      ? new THREE.Vector3(
          before.turn ? -2.3 : 2.3,
          TOP + 0.036,
          before.turn ? -6.2 : 6.2,
        )
      : squarePosition(move.from);
    const to = squarePosition(move.to);
    object.position.copy(from);
    return new Promise((resolve) => {
      this.animation = {
        object,
        from,
        to,
        side: before.turn,
        start: performance.now(),
        duration,
        resolve,
        onLand,
        landed: false,
      };
    });
  }
  frame(now) {
    requestAnimationFrame(this.frame);
    if (this.animation) {
      const a = this.animation,
        t = Math.min(1, (now - a.start) / Math.max(1, a.duration));
      const phase = updateHandMove(this.hands[a.side], a, t);
      this.container.dataset.phase = phase;
      if (t >= 0.72 && !a.landed) {
        a.landed = true;
        a.onLand();
      }
      if (t >= 1) {
        this.animation = null;
        a.resolve(true);
      }
    }
    if (!document.hidden && this.container.clientWidth > 0)
      this.renderer.render(this.scene, this.camera);
  }
}
