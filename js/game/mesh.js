/**
 * mesh.js —— 游戏道具用的小几何工具
 *
 * 道具（灯塔、鸟巢、跳台、海鸥……）全部用「顶点色」上色：
 * 一个物体合并成一个几何 + 一个材质 = 一个 draw call，而且不需要任何贴图。
 */
import * as THREE from 'three';

const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** 位置 + 欧拉角 + 缩放 → 矩阵（复用同一个对象，调用方立刻用掉） */
export function trs(px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _p.set(px, py, pz);
  _q.setFromEuler(_e.set(rx, ry, rz));
  _s.set(sx, sy, sz);
  return _m.compose(_p, _q, _s);
}

/**
 * 合并带颜色的几何。
 * @param {Array<[THREE.BufferGeometry, number|THREE.Color|Function, THREE.Matrix4?]>} parts
 *   第二项可以是函数 (x,y,z) => hex，用来做条纹之类的逐顶点颜色
 */
export function mergeColored(parts) {
  let vCount = 0, iCount = 0;
  const prepared = [];
  for (const [geo0, color, matrix] of parts) {
    let g = geo0.index ? geo0.toNonIndexed() : geo0.clone();
    if (matrix) g.applyMatrix4(matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    prepared.push([g, color]);
    vCount += g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  let off = 0;
  for (const [g, color] of prepared) {
    const p = g.attributes.position, n = g.attributes.normal;
    pos.set(p.array, off * 3);
    nrm.set(n.array, off * 3);
    for (let i = 0; i < p.count; i++) {
      if (typeof color === 'function') _c.setHex(color(p.getX(i), p.getY(i), p.getZ(i)));
      else if (color && color.isColor) _c.copy(color);
      else _c.setHex(color);
      col[(off + i) * 3] = _c.r; col[(off + i) * 3 + 1] = _c.g; col[(off + i) * 3 + 2] = _c.b;
    }
    off += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

/** 一个所有道具共用的顶点色材质 */
let _propMat = null;
export function propMaterial() {
  if (!_propMat) {
    _propMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.0, flatShading: true });
  }
  return _propMat;
}

/**
 * 发光材质：输出 >1 的 HDR 颜色，后处理里的辉光阈值（0.82）会把它点亮。
 * additive + 不写深度，叠在一起只会更亮，不会互相遮挡出黑边。
 */
export function glowMaterial(hex, intensity = 2.5, opacity = 1) {
  const m = new THREE.MeshBasicMaterial({
    color: new THREE.Color(hex).multiplyScalar(intensity),
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: true,
    fog: false,
  });
  return m;
}

/** 简易低模鱼（身体 + 尾鳍 + 背鳍），朝 +Z */
export function makeFishGeometry(scale = 1) {
  const body = new THREE.SphereGeometry(0.12 * scale, 8, 6);
  body.scale(0.55, 0.8, 1.6);
  const tail = new THREE.ConeGeometry(0.11 * scale, 0.16 * scale, 4);
  tail.rotateX(-Math.PI / 2);
  tail.scale(0.25, 1, 1);
  tail.translate(0, 0, -0.26 * scale);
  const fin = new THREE.ConeGeometry(0.05 * scale, 0.1 * scale, 3);
  fin.translate(0, 0.12 * scale, -0.02 * scale);
  const parts = [body, tail, fin].map((g) => (g.index ? g.toNonIndexed() : g));
  const n = parts.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) { pos.set(g.attributes.position.array, o); o += g.attributes.position.array.length; g.dispose(); }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.computeVertexNormals();
  return out;
}
