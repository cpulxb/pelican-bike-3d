/**
 * geometry.js —— 程序化几何构造原语
 *
 * 这个场景没有任何 .glb/.obj 模型文件：鹈鹕的喙、棕榈的叶子、车架钢管、
 * 羽毛、尾迹……全部由下面这些函数实时生成。
 *
 * 核心是 tubeFromCurve：沿任意曲线扫掠出「半径可变、截面可椭圆」的管体。
 * three 自带的 TubeGeometry 半径恒定，无法表达羽毛的收尖与翅膀的扁平，
 * 所以这里自己实现一遍，并用它统一生成所有有机形体。
 */

import * as THREE from 'three';

/**
 * 沿曲线扫掠可变半径管体。
 *
 * @param {THREE.Curve} curve           中心曲线
 * @param {number|number[]|Function} radius 半径。数字=恒定；数组=控制点插值；
 *                                     函数 (t)=>r 或 (t)=>[rx,ry]（椭圆截面）
 * @param {object} [opts]
 * @param {number} [opts.segments=64]   沿曲线的分段
 * @param {number} [opts.radial=10]     截面分段
 * @param {number} [opts.twist=0]       沿曲线累积扭转（弧度）
 * @param {number} [opts.flat=0]        扁平度：>0 时沿副法线方向压扁，做出羽片感
 * @param {boolean} [opts.capStart=true]
 * @param {boolean} [opts.capEnd=true]
 * @param {THREE.Vector3} [opts.up]     截面朝向参考轴
 * @returns {THREE.BufferGeometry}
 */
export function tubeFromCurve(curve, radius, opts = {}) {
  const {
    segments = 64,
    radial = 10,
    twist = 0,
    flat = 0,
    capStart = true,
    capEnd = true,
    up = new THREE.Vector3(0, 1, 0),
  } = opts;

  const radiusAt = typeof radius === 'function'
    ? radius
    : Array.isArray(radius)
      ? (t) => sampleProfile(radius, t)
      : () => radius;

  // Frenet 标架给出截面所在的局部坐标系
  const frames = curve.computeFrenetFrames(segments, false);
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  const P = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  const v = new THREE.Vector3();

  // 先采样一圈中心点与半径，便于计算端盖法线
  const centers = [];
  const radii = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, P);
    centers.push(P.clone());
    const r = radiusAt(t);
    radii.push(Array.isArray(r) ? r : [r, r]);
  }

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    N.copy(frames.normals[i]);
    B.copy(frames.binormals[i]);
    const [rx0, ry0] = radii[i];
    // flat 越大，副法线方向越被压扁 → 得到扁平的羽片/叶片
    const rx = rx0 * (1 + flat);
    const ry = ry0 * (1 - flat * 0.75);
    const ang = twist * t;

    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2 + ang;
      const sin = Math.sin(a), cos = Math.cos(a);
      v.copy(centers[i])
        .addScaledVector(N, cos * rx)
        .addScaledVector(B, sin * ry);
      positions.push(v.x, v.y, v.z);

      // 椭圆截面法线需按 1/r 加权，否则高光会歪
      const nrm = new THREE.Vector3()
        .addScaledVector(N, cos / Math.max(rx, 1e-5))
        .addScaledVector(B, sin / Math.max(ry, 1e-5))
        .normalize();
      normals.push(nrm.x, nrm.y, nrm.z);
      uvs.push(j / radial, t);
    }
  }

  const stride = radial + 1;
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * stride + j;
      const b = a + stride;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  // 端盖：从中心点扇形收口，避免管口漏光
  if (capStart) {
    const c = centers[0];
    const base = positions.length / 3;
    positions.push(c.x, c.y, c.z);
    const d = new THREE.Vector3().subVectors(centers[0], centers[1]).normalize();
    normals.push(d.x, d.y, d.z);
    uvs.push(0.5, 0);
    for (let j = 0; j < radial; j++) indices.push(base, j + 1, j);
  }
  if (capEnd) {
    const last = centers.length - 1;
    const c = centers[last];
    const base = positions.length / 3;
    positions.push(c.x, c.y, c.z);
    const d = new THREE.Vector3().subVectors(centers[last], centers[last - 1]).normalize();
    normals.push(d.x, d.y, d.z);
    uvs.push(0.5, 1);
    const off = last * stride;
    for (let j = 0; j < radial; j++) indices.push(base, off + j, off + j + 1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.userData.curve = curve;
  return geo;
}

/** 在控制点数组上做 Catmull-Rom 式插值（用于半径轮廓） */
export function sampleProfile(values, t) {
  if (values.length === 1) return values[0];
  const p = t * (values.length - 1);
  const i = Math.min(values.length - 2, Math.floor(p));
  const f = p - i;
  const a = values[i], b = values[i + 1];
  const s = f * f * (3 - 2 * f); // smoothstep，比线性更像生物组织
  return a + (b - a) * s;
}

/** 由一串点创建 CatmullRom 曲线（常用简写） */
export function curveFrom(points, tension = 0.5) {
  return new THREE.CatmullRomCurve3(
    points.map((p) => (p.isVector3 ? p : new THREE.Vector3(p[0], p[1], p[2]))),
    false, 'catmullrom', tension
  );
}

/**
 * 用噪声在法线方向扰动顶点 —— 把规则球体变成有机的岩石/身体。
 * @param {number} amp 位移幅度
 * @param {number} freq 噪声频率
 */
export function noiseDeform(geo, amp = 0.1, freq = 2.5, seed = 0) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nrm, i);
    // 三个不同频率的噪声叠加，避免出现明显的「同一频率」感
    const d =
      Math.sin(v.x * freq + seed) * Math.cos(v.y * freq * 1.3 - seed) * Math.sin(v.z * freq * 0.7) * 0.6 +
      Math.sin(v.x * freq * 2.7 + v.z * freq * 1.9 + seed * 3) * 0.4;
    v.addScaledVector(n, d * amp);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * 羽毛片：一片**扁平**的羽片，沿 +Z 伸展、宽度沿 ±X、法线沿 ±Y。
 *
 * 为什么需要这个而不是继续用 tubeFromCurve：
 * 管体的扁平方向由曲线的 Frenet 标架决定，而标架会随曲线形状悄悄旋转 ——
 * 调参时经常出现「我明明压扁了，看上去还是根棍子」的情况。
 * 把羽片做成显式的三轴几何后，「哪条轴管长度、哪条管宽度、哪条管朝向」
 * 就完全可控了，朝向逻辑才可能一次写对。
 *
 * 宽度剖面用经典羽形：根部窄、中段最宽、羽尖收成尖。
 *
 * @param {number} length 羽片长度（沿 +Z）
 * @param {number} width  最大宽度（沿 X，两侧各占一半）
 * @param {number} bow    羽尖的弯曲量（沿 -Y，正值表示向后弯）
 */
export function featherBlade(length = 0.3, width = 0.06, bow = 0.05, segments = 7) {
  const profile = [0.14, 0.42, 0.66, 0.86, 0.92, 0.70, 0.34, 0.06];
  const cols = [-1, 0, 1];
  const pos = [], nrm = [], uv = [], idx = [];
  const rows = segments + 1;

  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    const z = t * length;
    const w = (width * 0.5) * profile[Math.min(profile.length - 1, Math.round(t * (profile.length - 1)))];
    // 羽尖整体下坠，做出「羽毛自然垂落」的弧度
    const y = -bow * t * t;
    // 中脊（c=1）微微抬起，让羽片不是一张纯平的纸
    for (let ci = 0; ci < 3; ci++) {
      const s = cols[ci];
      const ridge = ci === 1 ? w * 0.10 : 0;
      pos.push(s * w, y + ridge, z);
      // 法线沿 +Y 略向外张，侧光时才有羽片的立体感
      const n = new THREE.Vector3(s * 0.30, 1.0, 0.0).normalize();
      nrm.push(n.x, n.y, n.z);
      uv.push((s + 1) * 0.5, t);
    }
  }
  for (let i = 0; i < rows - 1; i++) {
    for (let ci = 0; ci < 2; ci++) {
      const a = i * 3 + ci;
      const b = a + 3;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

/**
 * 生成一条「飘带」几何：用于车把彩带、尾羽、水花。
 * 飘带沿 +Z 展开，宽度沿长度收窄，附带用于顶点动画的 uv。
 */
export function ribbonGeometry(length = 1, width = 0.08, segments = 24, taper = 0.15) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const w = width * (1 - t * (1 - taper)) * 0.5;
    const z = t * length;
    // 轻微的波浪形静息态，动起来更自然
    const y = Math.sin(t * Math.PI * 2) * 0.02;
    positions.push(-w, y, z, w, y, z);
    uvs.push(0, t, 1, t);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** 把多个几何体合并成一个（减少 draw call） */
export function mergeGeometries(geometries) {
  const merged = new THREE.BufferGeometry();
  let posCount = 0, idxCount = 0;
  for (const g of geometries) {
    posCount += g.attributes.position.count;
    idxCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const position = new Float32Array(posCount * 3);
  const normal = new Float32Array(posCount * 3);
  const uv = new Float32Array(posCount * 2);
  const index = new Uint32Array(idxCount);

  let vOff = 0, iOff = 0;
  for (const g of geometries) {
    const p = g.attributes.position;
    position.set(p.array.subarray(0, p.count * 3), vOff * 3);
    if (g.attributes.normal) normal.set(g.attributes.normal.array.subarray(0, p.count * 3), vOff * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array.subarray(0, p.count * 2), vOff * 2);
    const n = p.count;
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) index[iOff + i] = g.index.array[i] + vOff;
      iOff += g.index.count;
    } else {
      for (let i = 0; i < n; i++) index[iOff + i] = i + vOff;
      iOff += n;
    }
    vOff += n;
  }
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.setIndex(new THREE.BufferAttribute(index, 1));
  return merged;
}

/** 以矩阵变换几何体后返回（便于先摆位置再合并） */
export function transformed(geo, matrix) {
  const g = geo.clone();
  g.applyMatrix4(matrix);
  return g;
}

/** 常用的矩阵简写：位置 + 欧拉角 + 缩放 */
export function TRS(px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(px, py, pz),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz)
  );
}

/**
 * 两骨 IK：已知根点、目标点与两段骨长，求中间关节位置。
 * 鹈鹕踩踏板就靠它 —— 踏板做圆周运动，腿必须实时弯曲跟随。
 *
 * @param {THREE.Vector3} root   髋关节位置
 * @param {THREE.Vector3} target 脚掌目标位置
 * @param {number} l1 大腿长
 * @param {number} l2 小腿长
 * @param {THREE.Vector3} poleDir 膝盖朝向（决定腿往哪边弯）
 * @param {THREE.Vector3} out 输出：中间关节位置
 */
export function solveTwoBoneIK(root, target, l1, l2, poleDir, out = new THREE.Vector3()) {
  const toTarget = new THREE.Vector3().subVectors(target, root);
  let d = toTarget.length();
  const maxReach = (l1 + l2) * 0.999;
  const minReach = Math.abs(l1 - l2) * 1.001;
  d = Math.min(maxReach, Math.max(minReach, d));

  const dir = toTarget.clone().normalize();
  // 余弦定理求髋角
  const cosHip = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
  const hipAngle = Math.acos(Math.min(1, Math.max(-1, cosHip)));

  // 在 root→target 与 poleDir 张成的平面内旋转
  const axis = new THREE.Vector3().crossVectors(dir, poleDir);
  if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0).cross(dir);
  axis.normalize();

  out.copy(dir).applyAxisAngle(axis, hipAngle).multiplyScalar(l1).add(root);
  return out;
}
