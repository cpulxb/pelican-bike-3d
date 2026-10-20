/**
 * waves.js —— 海浪的「唯一真相」
 *
 * 海面着色器（WATER_VERT）的 Gerstner 位移和物理里的水面高度必须是同一个函数，
 * 否则木头会漂在看不见的水面上、石头会在浪尖下面「干着」。
 * 所以波参数只写在这里一份：
 *   · GLSL 端：waveGLSL() 把下面的参数展开成常量，拼进着色器源码；
 *   · CPU 端：waveHeight() / waveVelocity() 用完全相同的公式。
 *
 * Gerstner 波会把水面上的点在水平方向上也挪动，所以「(x, z) 处的水面高度」
 * 不是直接代入就行 —— 要先找到「位移后恰好落在 (x, z) 的那个原始点 p0」：
 *   p0 + D_xz(p0) = q  →  不动点迭代 p0 ← q − D_xz(p0)
 * 四组波的陡度之和 ≈ 0.38 < 1，迭代是压缩映射，3 次就收敛到毫米级。
 *
 * 时间轴：着色器的 uTime = clock.elapsed（暂停时不走），物理用同一个时钟。
 */

import { WATER_LEVEL } from '../util/noise.js';
export { WATER_LEVEL };
const G = 9.81;
const TAU = Math.PI * 2;

function norm2(x, z) { const l = Math.hypot(x, z) || 1; return [x / l, z / l]; }

/** 四组波：方向、陡度（Gerstner Q·k·A）、波长（米）、相速倍率 */
export const WAVES = {
  scale: 1.0,
  list: [
    { dir: norm2(1.0, 0.22),   steepness: 0.14, wavelength: 22.0, speed: 1.00 },
    { dir: norm2(0.62, -0.78), steepness: 0.11, wavelength: 12.5, speed: 1.18 },
    { dir: norm2(-0.28, 0.96), steepness: 0.08, wavelength: 6.4,  speed: 1.42 },
    { dir: norm2(0.88, 0.47),  steepness: 0.05, wavelength: 3.1,  speed: 1.75 },
  ],
};

// 预计算 k、c、振幅
const W = WAVES.list.map((w) => {
  const k = TAU / w.wavelength;
  return { dx: w.dir[0], dz: w.dir[1], k, w: k * Math.sqrt(G / k) * w.speed, q: w.steepness, a: w.steepness / k };
});

/** 最大波高（所有波振幅之和）：物理用它做「肯定在水面以上」的快速剔除 */
export const WAVE_MAX_AMP = W.reduce((s, w) => s + w.a, 0) * WAVES.scale;

/** 着色器源码片段：在 main() 里展开成 4 行 gerstner(...) 调用 */
export function waveGLSL() {
  const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(+v.toFixed(6)));
  return WAVES.list.map((w) =>
    `disp += gerstner(p, vec2(${f(w.dir[0])}, ${f(w.dir[1])}), ${f(w.steepness)} * s, ${f(w.wavelength)}, ${f(w.speed)}, uTime, tangent, binormal);`
  ).join('\n    ');
}

// ---- CPU 端 ----
let _p0x = 0, _p0z = 0;

/** 解出位移后落在 (x, z) 的原始点，结果写进 _p0x / _p0z */
function solveOrigin(x, z, t, s) {
  let px = x, pz = z;
  for (let it = 0; it < 3; it++) {
    let ox = 0, oz = 0;
    for (let i = 0; i < W.length; i++) {
      const w = W[i];
      const ph = w.k * (w.dx * px + w.dz * pz) - w.w * t;
      const c = Math.cos(ph) * w.a * s;
      ox += w.dx * c; oz += w.dz * c;
    }
    px = x - ox; pz = z - oz;
  }
  _p0x = px; _p0z = pz;
}

/** (x, z) 处、时刻 t 的水面高度（世界坐标） */
export function waveHeight(x, z, t) {
  const s = WAVES.scale;
  solveOrigin(x, z, t, s);
  let y = 0;
  for (let i = 0; i < W.length; i++) {
    const w = W[i];
    y += Math.sin(w.k * (w.dx * _p0x + w.dz * _p0z) - w.w * t) * w.a * s;
  }
  return WATER_LEVEL + y;
}

/**
 * 水质点的轨道速度（m/s），写进 out。浮体的拖曳力按「相对水流」计算，
 * 所以木头会随浪前后摇荡，而不是钉在原地上下动。
 */
export function waveVelocity(x, z, t, out) {
  const s = WAVES.scale;
  solveOrigin(x, z, t, s);
  let vx = 0, vy = 0, vz = 0;
  for (let i = 0; i < W.length; i++) {
    const w = W[i];
    const ph = w.k * (w.dx * _p0x + w.dz * _p0z) - w.w * t;
    // d/dt [a·cos φ] = a·ω·sin φ；d/dt [a·sin φ] = −a·ω·cos φ
    const h = Math.sin(ph) * w.a * w.w * s;
    vx += w.dx * h; vz += w.dz * h;
    vy -= Math.cos(ph) * w.a * w.w * s;
  }
  out.x = vx; out.y = vy; out.z = vz;
  return out;
}
