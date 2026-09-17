import * as THREE from "three";

const rigs = new WeakMap();
export const HAND_MOVE_MS = 2600;
const smooth = (t) => {
  t = THREE.MathUtils.clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
};
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// Rig layout in "palm space": the wrist is the origin, fingers point to -Z,
// the back of the hand faces +Y and the thumb is on -X (a right hand).
// A slender young woman's hand: narrow palm, long tapering fingers.
const FINGERS = [
  // name, knuckle, phalanx lengths, radius, spread
  ["Index", V(-0.205, 0.03, -0.84), [0.36, 0.24, 0.2], 0.06, 0.06],
  ["Middle", V(-0.05, 0.035, -0.875), [0.4, 0.27, 0.21], 0.062, 0.0],
  ["Ring", V(0.1, 0.025, -0.84), [0.37, 0.25, 0.2], 0.057, -0.07],
  ["Little", V(0.235, 0.0, -0.75), [0.29, 0.19, 0.17], 0.05, -0.2],
];
const METACARPAL_BASES = [
  V(-0.12, 0.02, -0.12),
  V(-0.04, 0.03, -0.1),
  V(0.05, 0.02, -0.12),
  V(0.13, 0.0, -0.14),
];
const THUMB = {
  base: V(-0.15, -0.06, -0.22),
  rotation: [-0.32, 0.78, 0.95], // pitch, yaw, roll (YXZ)
  lengths: [0.38, 0.28, 0.23],
  radii: [0.07, 0.066, 0.061],
};
// Fraction of the radius at each end of the three finger phalanges.
const FINGER_TAPER = [[1, 0.9], [0.88, 0.8], [0.78, 0.7]];
// Joint curl (radians) for each bone: [relaxed, pinching the piece].
// Pinching extends the index and middle fingers forward like tweezers while
// the ring and little fingers roll right into the palm. The hand only tilts
// gently, so any looser curl would point them down into the board.
const CURL = {
  Index: [[0.18, 0.28, 0.14], [0.34, 0.42, 0.18]],
  Middle: [[0.16, 0.28, 0.14], [0.2, 0.4, 0.2]],
  Ring: [[0.24, 0.34, 0.18], [1.1, 1.5, 0.8]],
  Little: [[0.26, 0.34, 0.18], [1.0, 1.4, 0.75]],
};
const THUMB_POSE = [
  // [x, y] per thumb bone, relaxed then pinching
  [[0.1, -0.05], [0.28, -0.2], [0.2, 0.0]],
  [[0.36, -0.3], [0.2, -0.08], [0.26, 0.0]],
];
const WRIST_FLEX = [-0.16, -0.3];
const FOREARM_PITCH = -0.12;
// Where the fingertips meet, relative to the piece origin (unscaled units):
// high enough that the index and middle fingertips rest on the top face.
const PINCH_TARGET = V(0, 0.205, 0.02);

// ---- signed distance field ----------------------------------------------
const tmp = new THREE.Vector3();
// Tapered capsule from a (radius r1) to b (radius r2), squashed vertically.
// Scaling by `flatten` keeps the field from changing faster than distance,
// which the narrow-band sampling and cell skipping rely on.
function segmentField(a, b, r1, r2, flatten = 1) {
  const { x: ax, y: ay, z: az } = a;
  const bax = b.x - ax,
    bay = b.y - ay,
    baz = b.z - az;
  const inv = 1 / (bax * bax + bay * bay + baz * baz),
    fy = 1 / flatten,
    dr = r2 - r1;
  return (p) => {
    const pax = p.x - ax,
      pay = p.y - ay,
      paz = p.z - az;
    let h = (pax * bax + pay * bay + paz * baz) * inv;
    h = h < 0 ? 0 : h > 1 ? 1 : h;
    const qx = pax - bax * h,
      qy = (pay - bay * h) * fy,
      qz = paz - baz * h;
    return (Math.sqrt(qx * qx + qy * qy + qz * qz) - (r1 + dr * h)) * flatten;
  };
}
function ellipsoid(p, c, r) {
  const x = (p.x - c.x) / r.x,
    y = (p.y - c.y) / r.y,
    z = (p.z - c.z) / r.z;
  const k0 = Math.sqrt(x * x + y * y + z * z);
  const k1 = Math.sqrt((x * x) / (r.x * r.x) + (y * y) / (r.y * r.y) + (z * z) / (r.z * r.z));
  return k1 < 1e-6 ? -Math.min(r.x, r.y, r.z) : (k0 * (k0 - 1)) / k1;
}
function roundBox(p, c, half, radius, yaw) {
  const dx = p.x - c.x,
    dz = p.z - c.z;
  const cs = Math.cos(yaw),
    sn = Math.sin(yaw);
  const x = Math.abs(dx * cs - dz * sn) - half.x,
    y = Math.abs(p.y - c.y) - half.y,
    z = Math.abs(dx * sn + dz * cs) - half.z;
  const ox = Math.max(x, 0),
    oy = Math.max(y, 0),
    oz = Math.max(z, 0);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(x, y, z), 0) - radius;
}
const smin = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};

// Components know which bone they follow; fingers are blended into the palm
// separately so neighbouring fingers never fuse together.
// Every component carries a bounding sphere so far-away parts are skipped:
// a smooth union with k only changes the result within k of the minimum.
const seg = (bone, a, b, r1, r2, flatten = 1) => ({
  bone,
  d: segmentField(a, b, r1, r2, flatten),
  center: a.clone().add(b).multiplyScalar(0.5),
  radius: a.distanceTo(b) / 2 + Math.max(r1, r2),
  scale: flatten,
});
const blob = (bone, c, r) => ({
  bone,
  d: (p) => ellipsoid(p, c, r),
  center: c,
  radius: Math.max(r.x, r.y, r.z),
  scale: 1,
});
const far = (c, p, limit) =>
  (c.center.distanceTo(p) - c.radius) * c.scale > limit;

function buildField(chains) {
  // Square to the arm and set toward the little finger, so the thumb-side
  // edge runs straight from the wrist to the index knuckle. (Angled, its
  // wrist corner jutted out and was left behind as a lump when the thumb
  // swung in to pinch.)
  const boxCenter = V(0.04, -0.03, -0.46),
    boxHalf = V(0.18, 0.03, 0.3);
  const palm = [
    {
      bone: "palm",
      d: (p) => roundBox(p, boxCenter, boxHalf, 0.08, 0),
      center: boxCenter,
      radius: boxHalf.length() + 0.08,
      scale: 1,
    },
    ...FINGERS.map(([, knuckle, , radius], i) =>
      seg("palm", METACARPAL_BASES[i], knuckle, 0.05, radius * 1.1),
    ),
    // The thenar pad sits on the palm side, inside the hand's outline.
    blob("palm", V(-0.12, -0.09, -0.36), V(0.09, 0.065, 0.2)),
    blob("palm", V(0.19, -0.07, -0.42), V(0.085, 0.065, 0.27)),
  ];
  const forearm = seg("forearm", V(0, 0, -0.02), V(0, 0.02, 0.62), 0.19, 0.205, 0.7);
  const groups = chains.map((chain) => {
    const parts = chain.segments.map((s) =>
      seg(s.bone, s.a, s.b, s.r1, s.r2, s.flatten),
    );
    const center = parts
      .reduce((sum, c) => sum.add(c.center), V(0, 0, 0))
      .divideScalar(parts.length);
    const radius = Math.max(
      ...parts.map((c) => c.center.distanceTo(center) + c.radius),
    );
    const scale = Math.min(...parts.map((c) => c.scale));
    return { parts, center, radius, scale, blend: chain.blend };
  });
  const palmField = (p) => {
    let d = palm[0].d(p);
    for (let i = 1; i < palm.length; i++)
      if (!far(palm[i], p, d + 0.1)) d = smin(d, palm[i].d(p), 0.09);
    return far(forearm, p, d + 0.14) ? d : smin(d, forearm.d(p), 0.13);
  };
  const field = (p) => {
    const base = palmField(p);
    let d = base;
    for (const group of groups) {
      if (far(group, p, base + group.blend)) continue;
      const parts = group.parts;
      let f = parts[0].d(p);
      for (let i = 1; i < parts.length; i++) f = smin(f, parts[i].d(p), 0.012);
      d = Math.min(d, smin(base, f, group.blend));
    }
    return d;
  };
  return { field, components: [forearm, ...palm, ...groups.flatMap((g) => g.parts)] };
}

// Naive surface nets: one vertex per sign-changing cell, one quad per
// sign-changing grid edge. Vertices are then projected onto the surface.
function polygonize(field, min, max, step) {
  const nx = Math.ceil((max.x - min.x) / step) + 1,
    ny = Math.ceil((max.y - min.y) / step) + 1,
    nz = Math.ceil((max.z - min.z) / step) + 1;
  const values = new Float32Array(nx * ny * nz);
  const at = (i, j, k) => i + nx * (j + ny * k);
  const p = new THREE.Vector3();
  // Narrow band: sample a coarse grid first and only evaluate fine points
  // that could be near the surface; far points just keep the coarse sign.
  const S = 4,
    cx = Math.ceil((nx - 1) / S) + 1,
    cy = Math.ceil((ny - 1) / S) + 1,
    cz = Math.ceil((nz - 1) / S) + 1;
  const coarse = new Float32Array(cx * cy * cz);
  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        p.set(min.x + i * S * step, min.y + j * S * step, min.z + k * S * step);
        coarse[i + cx * (j + cy * k)] = field(p);
      }
  const band = step * (S * 0.5 * Math.sqrt(3) * 1.25 + 1.5);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c =
          coarse[
            Math.round(i / S) + cx * (Math.round(j / S) + cy * Math.round(k / S))
          ];
        if (Math.abs(c) > band) {
          values[at(i, j, k)] = c;
          continue;
        }
        p.set(min.x + i * step, min.y + j * step, min.z + k * step);
        values[at(i, j, k)] = field(p);
      }
  const cellIndex = new Int32Array(nx * ny * nz).fill(-1);
  const positions = [];
  const corner = [],
    offset = [];
  for (let c = 0; c < 8; c++) {
    corner.push([c & 1, (c >> 1) & 1, (c >> 2) & 1]);
    offset.push((c & 1) + nx * (((c >> 1) & 1) + ny * ((c >> 2) & 1)));
  }
  const edges = [];
  for (let a = 0; a < 8; a++)
    for (const bit of [1, 2, 4]) if (!(a & bit)) edges.push([a, a | bit]);
  // No sign change is possible within a cell when a corner is this far out.
  const cellSkip = step * 2.2,
    edgeSkip = step * 1.3;
  const v = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const idx = at(i, j, k);
        if (Math.abs(values[idx]) > cellSkip) continue;
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          v[c] = values[idx + offset[c]];
          if (v[c] < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0,
          sy = 0,
          sz = 0,
          n = 0;
        for (const [a, b] of edges) {
          if (v[a] < 0 === v[b] < 0) continue;
          const t = v[a] / (v[a] - v[b]);
          const ca = corner[a],
            cb = corner[b];
          sx += ca[0] + (cb[0] - ca[0]) * t;
          sy += ca[1] + (cb[1] - ca[1]) * t;
          sz += ca[2] + (cb[2] - ca[2]) * t;
          n++;
        }
        cellIndex[idx] = positions.length / 3;
        positions.push(
          min.x + (i + sx / n) * step,
          min.y + (j + sy / n) * step,
          min.z + (k + sz / n) * step,
        );
      }
  const quads = [];
  const dx = 1,
    dy = nx,
    dz = nx * ny;
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const c = at(i, j, k);
        if (Math.abs(values[c]) > edgeSkip) continue;
        const inside = values[c] < 0;
        if (inside !== values[c + dx] < 0)
          quads.push(c - dy - dz, c - dz, c, c - dy);
        if (inside !== values[c + dy] < 0)
          quads.push(c - dx - dz, c - dz, c, c - dx);
        if (inside !== values[c + dz] < 0)
          quads.push(c - dx - dy, c - dy, c, c - dx);
      }
  // Tetrahedral gradient: four samples instead of six.
  const gradient = (q, out) => {
    const e = step * 0.25;
    const f = (x, y, z) => field(tmp.set(q.x + x * e, q.y + y * e, q.z + z * e));
    const a = f(1, -1, -1),
      b = f(-1, -1, 1),
      c = f(-1, 1, -1),
      d = f(1, 1, 1);
    return out.set(a - b - c + d, -a - b + c + d, -a + b - c + d).normalize();
  };
  const g = new THREE.Vector3();
  const normals = new Float32Array(positions.length);
  // One Newton step onto the surface; the gradient doubles as the normal.
  for (let n = 0; n < positions.length; n += 3) {
    p.fromArray(positions, n);
    gradient(p, g);
    p.addScaledVector(g, -field(p));
    p.toArray(positions, n);
    g.toArray(normals, n);
  }
  const indices = [];
  const pa = new THREE.Vector3(),
    pb = new THREE.Vector3(),
    pc = new THREE.Vector3(),
    face = new THREE.Vector3();
  for (let q = 0; q < quads.length; q += 4) {
    const a = cellIndex[quads[q]],
      b = cellIndex[quads[q + 1]],
      c = cellIndex[quads[q + 2]],
      d = cellIndex[quads[q + 3]];
    if (a < 0 || b < 0 || c < 0 || d < 0) continue;
    pa.fromArray(positions, a * 3);
    pc.fromArray(positions, c * 3);
    pb.fromArray(positions, b * 3);
    const splitAC =
      pa.distanceToSquared(pc) <
      pb.distanceToSquared(tmp.fromArray(positions, d * 3));
    const tris = splitAC ? [[a, b, c], [a, c, d]] : [[a, b, d], [b, c, d]];
    for (const [x, y, z] of tris) {
      pa.fromArray(positions, x * 3);
      pb.fromArray(positions, y * 3);
      pc.fromArray(positions, z * 3);
      face.subVectors(pb, pa).cross(tmp.subVectors(pc, pa));
      g.fromArray(normals, x * 3);
      if (face.dot(g) >= 0) indices.push(x, y, z);
      else indices.push(x, z, y);
    }
  }
  return { positions, normals, indices };
}

// ---- rig ------------------------------------------------------------------
function buildRig() {
  const forearm = new THREE.Bone();
  forearm.name = "Forearm";
  forearm.rotation.x = FOREARM_PITCH;
  const palm = new THREE.Bone();
  palm.name = "Palm";
  forearm.add(palm);
  const bones = { forearm, palm };
  const order = [forearm, palm];
  const joints = [];
  const chains = [];
  const nailSpots = [];
  FINGERS.forEach(([name, knuckle, lengths, radius, spread]) => {
    const anchor = new THREE.Group();
    anchor.name = `${name}Anchor`;
    anchor.position.copy(knuckle);
    anchor.rotation.y = spread;
    palm.add(anchor);
    let parent = anchor;
    const chain = { bones: [], lengths, radius };
    lengths.forEach((length, i) => {
      const bone = new THREE.Bone();
      bone.name = `${name}Joint${i}`;
      if (i) bone.position.z = -lengths[i - 1];
      parent.add(bone);
      parent = bone;
      chain.bones.push(bone);
      order.push(bone);
      joints.push({
        node: bone,
        open: [-CURL[name][0][i], 0],
        closed: [-CURL[name][1][i], 0],
      });
    });
    chains.push(chain);
    nailSpots.push(chain);
  });
  const thumbAnchor = new THREE.Group();
  thumbAnchor.name = "ThumbAnchor";
  thumbAnchor.position.copy(THUMB.base);
  thumbAnchor.rotation.order = "YXZ";
  thumbAnchor.rotation.set(...THUMB.rotation);
  palm.add(thumbAnchor);
  let parent = thumbAnchor;
  const thumb = { bones: [], lengths: THUMB.lengths, radius: THUMB.radii[0], thumb: true };
  THUMB.lengths.forEach((length, i) => {
    const bone = new THREE.Bone();
    bone.name = `ThumbJoint${i}`;
    if (i) bone.position.z = -THUMB.lengths[i - 1];
    parent.add(bone);
    parent = bone;
    thumb.bones.push(bone);
    order.push(bone);
    joints.push({
      node: bone,
      open: [-THUMB_POSE[0][i][0], THUMB_POSE[0][i][1]],
      closed: [-THUMB_POSE[1][i][0], THUMB_POSE[1][i][1]],
    });
  });
  chains.push(thumb);
  nailSpots.push(thumb);
  joints.push({ node: palm, open: [WRIST_FLEX[0], 0], closed: [WRIST_FLEX[1], 0] });
  return { bones, order, joints, chains, nailSpots };
}

// Radius at the start and end of phalanx i, how far along the bone its
// capsule reaches (the last one stops short so the round tip ends on time),
// and how much it is squashed vertically.
function phalanx(chain, i) {
  const length = chain.lengths[i];
  const r = chain.thumb ? THUMB.radii[i] : chain.radius;
  const [r1, r2] = chain.thumb
    ? [r, i === 2 ? r * 0.86 : THUMB.radii[i + 1]]
    : FINGER_TAPER[i].map((f) => f * r);
  const end = i === chain.bones.length - 1 ? length - r2 * 0.95 : length;
  return { r1, r2, end, flatten: chain.thumb ? 0.9 : 0.84 };
}

// Segment endpoints (with radii) for every phalanx, measured in the bind pose.
function chainSegments(chain, root) {
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const world = (obj, offset = V(0, 0, 0)) =>
    offset.applyMatrix4(obj.matrixWorld).applyMatrix4(toRoot);
  return chain.bones.map((bone, i) => {
    const { r1, r2, end, flatten } = phalanx(chain, i);
    return {
      bone: bone.name,
      a: world(bone),
      b: world(bone, V(0, 0, -end)),
      r1,
      r2,
      flatten,
    };
  });
}

let cachedGeometry = null;
function handGeometry(rig) {
  if (cachedGeometry) return cachedGeometry;
  rig.bones.forearm.updateMatrixWorld(true);
  // The thumb melts into the palm over a wider band, like the fleshy web at
  // its root; a narrow band there leaves a pinched neck.
  const chains = rig.chains.map((chain) => ({
    segments: chainSegments(chain, rig.bones.forearm),
    blend: chain.thumb ? 0.1 : 0.05,
  }));
  const { field, components } = buildField(chains);
  const bounds = new THREE.Box3(V(-0.5, -0.3, -1.0), V(0.5, 0.2, 0.62));
  for (const chain of chains)
    for (const s of chain.segments) bounds.expandByPoint(s.a).expandByPoint(s.b);
  bounds.expandByScalar(0.14);
  const surface = polygonize(field, bounds.min, bounds.max, 0.016);
  const boneIndex = new Map(rig.order.map((b, i) => [b.name, i]));
  boneIndex.set("palm", 1);
  boneIndex.set("forearm", 0);
  const count = surface.positions.length / 3;
  const skinIndex = new Uint16Array(count * 4),
    skinWeight = new Float32Array(count * 4),
    colors = new Float32Array(count * 3);
  const base = new THREE.Color("#f2c3ad"),
    blush = new THREE.Color("#ee9c98"),
    light = new THREE.Color("#fbdccd"),
    color = new THREE.Color();
  const joints = [],
    tips = [];
  for (const chain of chains)
    chain.segments.forEach((s, i) => {
      joints.push(s.a);
      if (i === chain.segments.length - 1) tips.push(s.b);
    });
  // Skin weights: each component pulls the vertex toward its bone, fading
  // out quickly with distance beyond the nearest component.
  const p = new THREE.Vector3();
  const componentBone = components.map((c) => boneIndex.get(c.bone));
  const distances = new Float32Array(components.length),
    byBone = new Float32Array(rig.order.length);
  for (let n = 0; n < count; n++) {
    p.fromArray(surface.positions, n * 3);
    let nearest = Infinity;
    for (let i = 0; i < components.length; i++) {
      const c = components[i];
      distances[i] = far(c, p, nearest + 0.21) ? Infinity : c.d(p);
      if (distances[i] < nearest) nearest = distances[i];
    }
    byBone.fill(0);
    for (let i = 0; i < components.length; i++)
      if (distances[i] - nearest < 0.21)
        byBone[componentBone[i]] += Math.exp(-(distances[i] - nearest) / 0.03);
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      let best = 0;
      for (let b = 1; b < byBone.length; b++) if (byBone[b] > byBone[best]) best = b;
      if (byBone[best] <= 0) break;
      skinIndex[n * 4 + k] = best;
      skinWeight[n * 4 + k] = byBone[best];
      sum += byBone[best];
      byBone[best] = 0;
    }
    for (let k = 0; k < 4; k++) skinWeight[n * 4 + k] /= sum;
    let pink = 0;
    for (const j of joints) pink += 0.4 * Math.exp(-p.distanceToSquared(j) / 0.0045);
    // Fingertip pads blush; the backs stay paler so the nails stand out.
    const tipBlush = surface.normals[n * 3 + 1] > 0.35 ? 0.3 : 0.75;
    for (const t of tips) pink += tipBlush * Math.exp(-p.distanceToSquared(t) / 0.012);
    color.copy(base).lerp(blush, Math.min(pink, 0.85));
    if (p.y < -0.06 && p.z > -0.95) color.lerp(light, 0.35);
    color.toArray(colors, n * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(surface.positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(surface.normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
  geometry.setIndex(surface.indices);
  cachedGeometry = geometry;
  return geometry;
}

function kimonoTexture(side) {
  const textile = document.createElement("canvas");
  textile.width = textile.height = 512;
  const ctx = textile.getContext("2d");
  ctx.fillStyle = side ? "#756f9a" : "#f0e2ce";
  ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = side ? "#d9bfd366" : "#b89c6655";
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 12; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 51 - 40, 0);
    ctx.bezierCurveTo(i * 51 + 80, 170, i * 51 - 120, 320, i * 51 + 40, 512);
    ctx.stroke();
  }
  for (let i = 0; i < 26; i++) {
    const x = (i * 137.23) % 512,
      y = (i * 91.67) % 512,
      r = 10 + (i % 4) * 3;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(i * 0.81);
    ctx.fillStyle = side
      ? i % 2
        ? "#cfb9ce"
        : "#eee0df"
      : i % 2
        ? "#b27483"
        : "#dac0b7";
    for (let k = 0; k < 5; k++) {
      ctx.rotate((Math.PI * 2) / 5);
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.7, r * 0.43, r * 0.74, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#c3a15d";
    ctx.beginPath();
    ctx.arc(0, 0, 2.5, 0, 7);
    ctx.fill();
    ctx.restore();
  }
  const map = new THREE.CanvasTexture(textile);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(2, 3);
  map.anisotropy = 4;
  return map;
}

// Per side: the rolled lining edge at the cuff (fuki), the lining seen inside
// the sleeve and the nagajuban sleeve that peeks out around the wrist.
const SLEEVE_TRIM = [
  { rim: "#c35c79", lining: "#d98799", juban: "#f6c9d3" },
  { rim: "#d3b06a", lining: "#5a5283", juban: "#f1d6e1" },
];

// Rings of around + 1 points (the seam repeats), each with a v texture
// coordinate, stitched into one strip of quads.
function loft(rings, around) {
  const vertices = [],
    uv = [],
    indices = [];
  rings.forEach(({ points, v }) =>
    points.forEach((p, k) => {
      vertices.push(p.x, p.y, p.z);
      uv.push(k / around, v);
    }),
  );
  for (let j = 0; j < rings.length - 1; j++)
    for (let k = 0; k < around; k++) {
      const a = j * (around + 1) + k,
        b = a + around + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// A furisode sleeve in forearm space (+Z runs up the arm). The wrist leaves
// through a wide, loose sleeve mouth (sode-guchi): the cloth rests on top of
// the arm and the rest of the opening sags open below it, showing the lining.
// Below the mouth the front is sewn shut and the tamoto hangs as a soft bag.
function addSleeve(parent, side) {
  const trim = SLEEVE_TRIM[side];
  const around = 48,
    sections = 30;
  const angles = Array.from({ length: around + 1 }, (_, k) => (k / around) * Math.PI * 2);
  // The front edge hangs plumb, so in the (downward-pitched) arm's frame its
  // bottom sits a little further forward than its top.
  const frontZ = (sin) => 0.22 + 0.05 * sin;
  // A drop shape around centre height cy: narrow on top, where the cloth
  // rests on the arm, and fuller below. `hang` pinches the lower half in, as
  // the two layers of a sleeve fall together.
  const drape = (a, cy, up, down, half, hang) => {
    const cos = Math.cos(a),
      sin = Math.sin(a);
    const narrow = sin > 0 ? 1 - 0.3 * sin : 1 - hang * sin * sin;
    return [cos * half * narrow, cy + sin * (sin > 0 ? up : down)];
  };
  const mouth = (a) => {
    const w = 1 + 0.02 * Math.sin(a * 5 + 1);
    const [x, y] = drape(a, -0.1, 0.3 * w, 0.62 * w, 0.34 * w, 0);
    return V(x, y, frontZ(Math.sin(a)));
  };
  const outline = (t, a) => {
    // The tamoto drops to full depth just behind the cuff (a rounded bottom
    // corner) instead of widening slowly like a cone.
    // At the cuff the sleeve is only a cloth's width outside the mouth.
    const half = 0.37 + Math.pow(t, 0.66) * 0.9,
      up = 0.33 + Math.pow(t, 0.75) * 0.43,
      down = 0.72 + 0.22 * (1 - Math.exp(-t * 18)) + t * 0.3,
      fold =
        Math.sin(a * 7 + t * 3) * 0.03 * Math.min(1, t * 5) +
        Math.sin(a * 4 + t * 6) * 0.035 * Math.min(1, t * 8);
    const [x, y] = drape(
      a,
      -0.1 + t * 0.55,
      up + fold,
      down + fold,
      half + fold,
      0.7 * Math.min(1, t * 6),
    );
    return V(x, y, frontZ(Math.sin(a)) + t * 7);
  };
  // Front panel from the mouth to the sleeve edge, then the sleeve itself
  // (rings bunch up near the cuff, where the shape changes fastest).
  const front = loft(
    [
      { points: angles.map(mouth), v: 0 },
      { points: angles.map((a) => outline(0, a)), v: 0.02 },
    ],
    around,
  );
  const body = loft(
    Array.from({ length: sections + 1 }, (_, j) => {
      const t = Math.pow(j / sections, 1.6);
      return { points: angles.map((a) => outline(t, a)), v: t };
    }),
    around,
  );
  const silk = new THREE.MeshStandardMaterial({
    color: "#ffffff",
    map: kimonoTexture(side),
    roughness: 0.85,
  });
  const lining = new THREE.MeshStandardMaterial({
    color: trim.lining,
    roughness: 0.9,
    side: THREE.BackSide,
  });
  for (const geometry of [front, body]) {
    const outer = new THREE.Mesh(geometry, silk);
    outer.name = "SakuraKimonoSleeve";
    outer.castShadow = outer.receiveShadow = true;
    parent.add(outer);
    parent.add(new THREE.Mesh(geometry, lining));
  }
  const satin = (color) =>
    new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.62,
      sheen: 0.6,
      sheenColor: new THREE.Color("#ffffff"),
      side: THREE.DoubleSide,
    });
  const rim = new THREE.Mesh(
    new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(angles.slice(0, -1).map(mouth), true),
      96,
      0.018,
      8,
      true,
    ),
    satin(trim.rim),
  );
  rim.name = "SleeveMouth";
  rim.castShadow = true;
  parent.add(rim);
  // The nagajuban sleeve: an inner layer, just as loose, whose edge shows a
  // little past the cuff.
  const jubanFront = 0.17;
  const jubanEdge = (a, z) => {
    const [x, y] = drape(a, -0.06, 0.24, 0.5, 0.29, 0);
    return V(x, y, z + 0.03 * Math.sin(a));
  };
  const juban = new THREE.Mesh(
    loft(
      [0, 0.3, 1].map((u) => ({
        points: angles.map((a) =>
          jubanEdge(a, jubanFront + u * 1.1).multiply(V(1 + 0.12 * u, 1 + 0.12 * u, 1)),
        ),
        v: u,
      })),
      around,
    ),
    satin(trim.juban),
  );
  juban.name = "Nagajuban";
  juban.castShadow = true;
  parent.add(juban);
  const jubanRim = new THREE.Mesh(
    new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(angles.slice(0, -1).map((a) => jubanEdge(a, jubanFront)), true),
      72,
      0.012,
      6,
      true,
    ),
    juban.material,
  );
  parent.add(jubanRim);
}

function addNails(rig) {
  const nail = new THREE.MeshPhysicalMaterial({
    color: "#f7c4cc",
    roughness: 0.28,
    clearcoat: 0.8,
    clearcoatRoughness: 0.2,
  });
  const shape = new THREE.SphereGeometry(1, 20, 12);
  // Almond nails lie on the back of the last phalanx and end before the
  // round fingertip curls away, so they never poke out of the skin.
  for (const chain of rig.nailSpots) {
    const i = chain.bones.length - 1;
    const bone = chain.bones[i];
    const { r1, r2, end, flatten } = phalanx(chain, i);
    const half = chain.lengths[i] * 0.28;
    const z = end + r2 * 0.55 - half;
    const r = r1 + (r2 - r1) * Math.min(z / end, 1);
    const m = new THREE.Mesh(shape, nail);
    m.name = bone.name.replace(/Joint\d$/, "Nail");
    m.position.set(0, r * flatten - r * 0.22, -z);
    m.scale.set(r * 0.7, r * 0.34, half);
    m.rotation.x = -0.06;
    m.castShadow = true;
    bone.add(m);
  }
}

// A standalone right hand in a kimono sleeve. The local origin is the point
// where the fingertips pinch a piece; +Z points to the wrist.
let skinMaterial = null;
// The skin mesh takes a moment to generate, so it is built when the browser
// is idle (or on first use) instead of while the page is loading.
function attachSkin(hand, rig) {
  const joints = rig.joints;
  const saved = joints.map((j) => j.node.rotation.clone());
  for (const j of joints) j.node.rotation.set(0, 0, 0);
  hand.updateMatrixWorld(true);
  skinMaterial ??= new THREE.MeshPhysicalMaterial({
    color: "#ffffff",
    vertexColors: true,
    roughness: 0.6,
    sheen: 0.4,
    sheenColor: new THREE.Color("#ffc4b0"),
    sheenRoughness: 0.55,
  });
  const mesh = new THREE.SkinnedMesh(handGeometry(rig), skinMaterial);
  mesh.name = "HandSkin";
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  rig.bones.forearm.add(mesh);
  hand.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(rig.order));
  joints.forEach((j, i) => j.node.rotation.copy(saved[i]));
}

// A standalone right hand in a kimono sleeve. The local origin is the point
// where the fingertips pinch a piece; +Z points to the wrist.
export function makeHand(side = 0) {
  const hand = new THREE.Group();
  hand.name = "ShogiHand";
  // Yaw first, so tilt and roll stay relative to the arm on either side.
  hand.rotation.order = "YXZ";
  const rig = buildRig();
  hand.add(rig.bones.forearm);
  addNails(rig);
  addSleeve(rig.bones.forearm, side);
  let skinned = false;
  const entry = {
    joints: rig.joints,
    ensure() {
      if (skinned) return;
      skinned = true;
      attachSkin(hand, rig);
    },
  };
  rigs.set(hand, entry);

  // Calibrate: move the arm so the pinching fingertips meet at the origin.
  pose(entry, 1);
  hand.updateMatrixWorld(true);
  const toHand = new THREE.Matrix4().copy(hand.matrixWorld).invert();
  const tip = (chain) =>
    V(0, 0, -chain.lengths.at(-1) * 0.8)
      .applyMatrix4(chain.bones.at(-1).matrixWorld)
      .applyMatrix4(toHand);
  const pinch = tip(rig.chains[0])
    .add(tip(rig.chains[1]))
    .add(tip(rig.chains[4]))
    .divideScalar(3);
  rig.bones.forearm.position.add(PINCH_TARGET.clone().sub(pinch));
  hand.scale.setScalar(1.4);
  pose(entry, 0);
  const idle = globalThis.requestIdleCallback ?? ((fn) => setTimeout(fn, 400));
  idle(() => entry.ensure());
  return hand;
}

// grip: -0.4 (fingers spread before taking a piece) … 0 (relaxed) … 1 (pinch).
export function poseHand(hand, grip) {
  const entry = rigs.get(hand);
  if (!entry) return;
  entry.ensure();
  pose(entry, grip);
}
function pose(entry, grip) {
  const g = THREE.MathUtils.clamp(grip, -0.4, 1);
  for (const joint of entry.joints)
    joint.node.rotation.set(
      THREE.MathUtils.lerp(joint.open[0], joint.closed[0], g),
      THREE.MathUtils.lerp(joint.open[1], joint.closed[1], g),
      0,
    );
}

export function makeHandClip(hand) {
  const tracks = [];
  for (const joint of rigs.get(hand)?.joints || []) {
    const values = [];
    for (const amount of [0, 0, 1, 1, 0]) {
      const e = new THREE.Euler(
        THREE.MathUtils.lerp(joint.open[0], joint.closed[0], amount),
        THREE.MathUtils.lerp(joint.open[1], joint.closed[1], amount),
        0,
      );
      const q = new THREE.Quaternion().setFromEuler(e);
      values.push(q.x, q.y, q.z, q.w);
    }
    tracks.push(
      new THREE.QuaternionKeyframeTrack(
        `${joint.node.name}.quaternion`,
        [0, 0.25, 0.65, 1.3, 1.8],
        values,
      ),
    );
  }
  return new THREE.AnimationClip("Grip_and_release", 1.8, tracks);
}

// The same piece transform drives the grip throughout the carry phase.
// This avoids hand/piece drift for long moves, captures and the opposing side.
export function updateHandMove(hand, move, t) {
  const side = move.side ? -1 : 1;
  const rest = new THREE.Vector3(
    move.from.x * 0.45 + side * 1.2,
    move.from.y + 2.8,
    side * 9.5,
  );
  const departure = new THREE.Vector3(
    move.to.x * 0.45 + side * 1.2,
    move.to.y + 2.8,
    side * 9.5,
  );
  const contact = new THREE.Vector3();
  let grip = 0,
    tilt = 0,
    roll = 0,
    phase;
  hand.visible = true;
  if (t < 0.24) {
    phase = "reach";
    const a = smooth(t / 0.24);
    contact.lerpVectors(rest, move.from, a);
    contact.y += Math.sin(a * Math.PI) * 0.5;
    grip = -0.12 * smooth((t - 0.1) / 0.14);
    move.object.position.copy(move.from);
  } else if (t < 0.36) {
    phase = "grip";
    contact.copy(move.from);
    grip = -0.12 + 1.12 * smooth((t - 0.24) / 0.12);
    move.object.position.copy(move.from);
  } else if (t < 0.72) {
    phase = "carry";
    const a = smooth((t - 0.36) / 0.36);
    move.object.position.lerpVectors(move.from, move.to, a);
    move.object.position.y += Math.sin(a * Math.PI) * 0.95;
    contact.copy(move.object.position);
    grip = 1;
    // Tilt around the fingertips so the piece never slips: raise the arm on
    // the way up, then snap the fingers down onto the square.
    tilt = -0.07 * Math.sin(a * Math.PI) - 0.1 * smooth((a - 0.72) / 0.28);
    roll = 0.06 * Math.sin(a * Math.PI);
  } else if (t < 0.82) {
    phase = "release";
    move.object.position.copy(move.to);
    const a = smooth((t - 0.72) / 0.1);
    contact.copy(move.to);
    contact.y += 0.06 * a;
    grip = 1 - 0.7 * a;
    tilt = -0.1 * (1 - a);
  } else {
    phase = "withdraw";
    const a = smooth((t - 0.82) / 0.18);
    move.object.position.copy(move.to);
    contact.lerpVectors(move.to, departure, a);
    contact.y += 0.06 * (1 - a) + Math.sin(a * Math.PI) * 0.45;
    grip = 0.3 * (1 - a);
  }
  hand.rotation.set(tilt, move.side ? Math.PI : 0, roll);
  hand.position.copy(contact);
  poseHand(hand, grip);
  if (t >= 1) {
    hand.visible = false;
    phase = "idle";
  }
  return phase;
}
