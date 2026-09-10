import * as THREE from "three";

const rigs = new WeakMap();
export const HAND_MOVE_MS = 2600;
const smooth = (t) => {
  t = THREE.MathUtils.clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
};

// A standalone right hand. Local origin is the grip point; +Z points to the wrist.
export function makeHand(side = 0) {
  const hand = new THREE.Group();
  hand.name = "ShogiHand";
  const skin = new THREE.MeshStandardMaterial({
    color: "#edbba5",
    roughness: 0.68,
  });
  const nails = new THREE.MeshStandardMaterial({
    color: "#f5d2c8",
    roughness: 0.34,
  });
  const cuff = new THREE.MeshStandardMaterial({
    color: "#f0e4d2",
    roughness: 0.9,
  });
  const trim = new THREE.MeshStandardMaterial({
    color: "#a7687c",
    roughness: 0.76,
  });
  function ellipsoid(parent, name, position, scale, material = skin) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), material);
    m.name = name;
    m.position.set(...position);
    m.scale.set(...scale);
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  const palmProfile = [
    [0.46, 0.32, 0.12],
    [0.58, 0.395, 0.155],
    [0.86, 0.4, 0.165],
    [1.13, 0.34, 0.145],
    [1.38, 0.24, 0.115],
    [1.67, 0.215, 0.115],
  ];
  const curve = new THREE.CatmullRomCurve3(
    palmProfile.map(([z, w, h]) => new THREE.Vector3(z, w, h)),
  );
  const rings = curve.getPoints(28).map((v) => [v.x, v.y, v.z]);
  const vertices = [],
    indices = [],
    radial = 24;
  rings.forEach(([z, width, thickness]) => {
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      vertices.push(Math.cos(a) * width, 0.76 + Math.sin(a) * thickness, z);
    }
  });
  for (let r = 0; r < rings.length - 1; r++)
    for (let k = 0; k < radial; k++) {
      const a = r * radial + k,
        b = r * radial + ((k + 1) % radial);
      indices.push(a, b, a + radial, b, b + radial, a + radial);
    }
  for (const [r, reverse] of [
    [0, true],
    [rings.length - 1, false],
  ]) {
    const center = vertices.length / 3;
    vertices.push(0, 0.76, rings[r][0]);
    for (let k = 0; k < radial; k++) {
      const a = r * radial + k,
        b = r * radial + ((k + 1) % radial);
      indices.push(...(reverse ? [center, b, a] : [center, a, b]));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3),
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const palm = new THREE.Mesh(geometry, skin);
  palm.name = "Palm";
  palm.castShadow = palm.receiveShadow = true;
  hand.add(palm);
  ellipsoid(hand, "ThumbWeb", [-0.265, 0.71, 0.88], [0.17, 0.12, 0.25]);
  function cuffRing(z, length, material, radius) {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius * 1.04, length, 32),
      material,
    );
    m.rotation.x = Math.PI / 2;
    m.scale.z = 0.67;
    m.position.set(0, 0.76, z);
    m.castShadow = true;
    hand.add(m);
  }
  cuffRing(1.69, 0.24, cuff, 0.265);
  cuffRing(1.57, 0.04, trim, 0.271);
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
  const textileMap = new THREE.CanvasTexture(textile);
  textileMap.colorSpace = THREE.SRGBColorSpace;
  textileMap.wrapS = textileMap.wrapT = THREE.RepeatWrapping;
  textileMap.repeat.set(2, 3);
  textileMap.anisotropy = 4;
  const silk = new THREE.MeshStandardMaterial({
    color: "#ffffff",
    map: textileMap,
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  const sleeveVertices = [],
    sleeveUV = [],
    sleeveIndices = [],
    sections = 28,
    around = 40;
  for (let j = 0; j <= sections; j++) {
    const t = j / sections,
      z = 1.73 + t * 7;
    const width = 0.29 + Math.pow(t, 0.66) * 1.2,
      depth = 0.19 + Math.pow(t, 0.75) * 0.72;
    for (let k = 0; k <= around; k++) {
      const angle = (k / around) * Math.PI * 2,
        fold = Math.sin(angle * 7 + t * 3) * 0.027 * Math.sin(Math.PI * t);
      sleeveVertices.push(
        Math.cos(angle) * (width + fold),
        0.76 + t * 1.4 + Math.sin(angle) * (depth + fold),
        z,
      );
      sleeveUV.push(k / around, t);
    }
  }
  for (let j = 0; j < sections; j++)
    for (let k = 0; k < around; k++) {
      const a = j * (around + 1) + k,
        b = a + around + 1;
      sleeveIndices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  const sleeveGeometry = new THREE.BufferGeometry();
  sleeveGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(sleeveVertices, 3),
  );
  sleeveGeometry.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(sleeveUV, 2),
  );
  sleeveGeometry.setIndex(sleeveIndices);
  sleeveGeometry.computeVertexNormals();
  const sleeve = new THREE.Mesh(sleeveGeometry, silk);
  sleeve.name = "SakuraKimonoSleeve";
  sleeve.castShadow = sleeve.receiveShadow = true;
  hand.add(sleeve);
  const joints = [];
  function finger(name, base, lengths, radius, spread, open, closed) {
    const anchor = new THREE.Group();
    anchor.name = `${name}Anchor`;
    anchor.position.set(...base);
    anchor.rotation.y = spread;
    hand.add(anchor);
    let parent = anchor;
    const bones = [];
    lengths.forEach((length, i) => {
      const joint = new THREE.Bone();
      joint.name = `${name}Joint${i}`;
      parent.add(joint);
      if (i) joint.position.z = -lengths[i - 1];
      const r = radius * (1 - i * 0.13);
      if (i === lengths.length - 1)
        ellipsoid(
          joint,
          `${name}Nail`,
          [0, r * 0.78, -length * 0.65],
          [r * 0.66, 0.008, length * 0.32],
          nails,
        );
      joints.push({ node: joint, open: open[i], closed: closed[i] });
      bones.push(joint);
      parent = joint;
    });
    const positions = [],
      indices = [],
      skinIndices = [],
      weights = [];
    const total = lengths.reduce((a, b) => a + b, 0),
      rings = 48,
      around = 24;
    const boundaries = lengths.map((_, i) =>
      lengths.slice(0, i).reduce((a, b) => a + b, 0),
    );
    for (let j = 0; j <= rings; j++) {
      const d = -0.08 + ((total + 0.08) * j) / rings;
      const t = Math.max(0, d / total);
      const tip = t > 0.86 ? Math.cos((((t - 0.86) / 0.14) * Math.PI) / 2) : 1;
      const r = radius * (1 - 0.27 * t) * tip;
      let a = 0,
        b = 0,
        blend = 0;
      for (let i = 1; i < bones.length; i++) {
        const v = boundaries[i],
          width = radius * 0.85;
        if (d >= v + width) {
          a = b = i;
          blend = 0;
        } else if (d > v - width) {
          a = i - 1;
          b = i;
          blend = smooth((d - v + width) / (width * 2));
          break;
        }
      }
      for (let k = 0; k <= around; k++) {
        const angle = (k / around) * Math.PI * 2;
        positions.push(Math.cos(angle) * r, Math.sin(angle) * r * 0.84, -d);
        skinIndices.push(a, b, 0, 0);
        weights.push(1 - blend, blend, 0, 0);
      }
    }
    for (let j = 0; j < rings; j++)
      for (let k = 0; k < around; k++) {
        const a = j * (around + 1) + k,
          b = a + around + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setAttribute(
      "skinIndex",
      new THREE.Uint16BufferAttribute(skinIndices, 4),
    );
    geometry.setAttribute(
      "skinWeight",
      new THREE.Float32BufferAttribute(weights, 4),
    );
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.SkinnedMesh(geometry, skin);
    mesh.name = name + "Skin";
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    anchor.add(mesh);
    hand.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton(bones));
    return anchor;
  }
  finger(
    "Index",
    [-0.22, 0.76, 0.5],
    [0.37, 0.26, 0.2],
    0.086,
    -0.035,
    [-0.18, -0.18, -0.1],
    [-0.55, -0.56, -0.12],
  );
  finger(
    "Middle",
    [-0.015, 0.76, 0.47],
    [0.4, 0.28, 0.2],
    0.091,
    0,
    [-0.13, -0.2, -0.1],
    [-0.52, -0.55, -0.1],
  );
  finger(
    "Ring",
    [0.19, 0.75, 0.56],
    [0.38, 0.27, 0.21],
    0.084,
    -0.09,
    [-0.32, -0.36, -0.12],
    [-0.44, -0.72, -0.45],
  );
  finger(
    "Little",
    [0.35, 0.73, 0.7],
    [0.29, 0.22, 0.18],
    0.07,
    -0.2,
    [-0.4, -0.46, -0.19],
    [-0.44, -0.74, -0.4],
  );
  const thumb = finger(
    "Thumb",
    [-0.355, 0.67, 0.72],
    [0.33, 0.28],
    0.11,
    0.6,
    [-0.4, -0.24],
    [-0.82, -0.4],
  );
  joints.push({ node: thumb, axis: "y", open: 0.6, closed: -0.08 });
  hand.scale.setScalar(1.4);
  rigs.set(hand, joints);
  poseHand(hand, 0);
  return hand;
}

export function poseHand(hand, grip) {
  for (const joint of rigs.get(hand) || [])
    joint.node.rotation[joint.axis || "x"] = THREE.MathUtils.lerp(
      joint.open,
      joint.closed,
      THREE.MathUtils.clamp(grip, 0, 1),
    );
}

export function makeHandClip(hand) {
  const tracks = [];
  for (const joint of rigs.get(hand) || []) {
    const values = [];
    for (const amount of [0, 0, 1, 1, 0]) {
      const e = joint.node.rotation.clone();
      e[joint.axis || "x"] = THREE.MathUtils.lerp(
        joint.open,
        joint.closed,
        amount,
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
    phase;
  hand.visible = true;
  hand.rotation.y = move.side ? Math.PI : 0;
  if (t < 0.24) {
    phase = "reach";
    const a = smooth(t / 0.24);
    contact.lerpVectors(rest, move.from, a);
    contact.y += Math.sin(a * Math.PI) * 0.5;
    move.object.position.copy(move.from);
  } else if (t < 0.36) {
    phase = "grip";
    contact.copy(move.from);
    grip = smooth((t - 0.24) / 0.12);
    move.object.position.copy(move.from);
  } else if (t < 0.72) {
    phase = "carry";
    const a = smooth((t - 0.36) / 0.36);
    move.object.position.lerpVectors(move.from, move.to, a);
    move.object.position.y += Math.sin(a * Math.PI) * 0.95;
    contact.copy(move.object.position);
    grip = 1;
  } else if (t < 0.82) {
    phase = "release";
    move.object.position.copy(move.to);
    contact.copy(move.to);
    grip = 1 - smooth((t - 0.72) / 0.1);
  } else {
    phase = "withdraw";
    const a = smooth((t - 0.82) / 0.18);
    move.object.position.copy(move.to);
    contact.lerpVectors(move.to, departure, a);
    contact.y += Math.sin(a * Math.PI) * 0.45;
  }
  hand.position.copy(contact);
  poseHand(hand, grip);
  if (t >= 1) {
    hand.visible = false;
    phase = "idle";
  }
  return phase;
}
