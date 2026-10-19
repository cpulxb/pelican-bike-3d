/**
 * noise.js —— 程序化噪声工具箱
 *
 * 场景里的一切（地形起伏、岩石、羽毛扰动、天空云层）都靠这里生成，
 * 因此不依赖任何外部贴图或模型文件。
 *
 * 提供三层能力：
 *   1. 哈希与伪随机（确定性，保证每次刷新世界一致）
 *   2. Perlin 梯度噪声（2D/3D）
 *   3. fbm / ridged 分形叠加（地貌的经典构造方式）
 */

/* ------------------------------------------------------------------ *
 * 1. 哈希与伪随机
 * ------------------------------------------------------------------ */

/** mulberry32：32 位快速伪随机数发生器，返回 [0,1) */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 二维整数哈希 → [0,1)，用于「按格子确定内容」的无限世界 */
export function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* ------------------------------------------------------------------ *
 * 2. Perlin 梯度噪声
 * ------------------------------------------------------------------ */

// 经典 256 项置换表（由种子洗牌，保证不同种子得到不同地貌）
const P = new Uint8Array(512);
(function buildPermutation() {
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  const rnd = mulberry32(20261018);
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = base[i]; base[i] = base[j]; base[j] = t;
  }
  for (let i = 0; i < 512; i++) P[i] = base[i & 255];
})();

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

function grad3(hash, x, y, z) {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/** 3D Perlin 噪声，返回约 [-1,1] */
export function noise3(x, y, z) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
  const u = fade(x), v = fade(y), w = fade(z);

  const A = P[X] + Y, AA = P[A] + Z, AB = P[A + 1] + Z;
  const B = P[X + 1] + Y, BA = P[B] + Z, BB = P[B + 1] + Z;

  return lerp(
    lerp(
      lerp(grad3(P[AA], x, y, z),       grad3(P[BA], x - 1, y, z), u),
      lerp(grad3(P[AB], x, y - 1, z),   grad3(P[BB], x - 1, y - 1, z), u), v),
    lerp(
      lerp(grad3(P[AA + 1], x, y, z - 1),     grad3(P[BA + 1], x - 1, y, z - 1), u),
      lerp(grad3(P[AB + 1], x, y - 1, z - 1), grad3(P[BB + 1], x - 1, y - 1, z - 1), u), v),
    w);
}

/** 2D Perlin 噪声（z 固定为 0） */
export function noise2(x, y) { return noise3(x, y, 0.317); }

/* ------------------------------------------------------------------ *
 * 3. 分形叠加
 * ------------------------------------------------------------------ */

/**
 * fbm：多倍频叠加，得到自然的地貌细节。
 * @param {number} octaves 叠加层数（层数越多细节越碎）
 * @param {number} lacunarity 每层频率倍率
 * @param {number} gain 每层振幅衰减
 */
export function fbm2(x, y, octaves = 5, lacunarity = 2.03, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function fbm3(x, y, z, octaves = 4, lacunarity = 2.07, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** ridged 噪声：适合山脊、岩石裂纹 */
export function ridged2(x, y, octaves = 4) {
  let sum = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * (1 - Math.abs(noise2(x * freq, y * freq)));
    amp *= 0.5;
    freq *= 2.11;
  }
  return sum;
}

/* ------------------------------------------------------------------ *
 * 4. 世界地形高度函数（世界空间，单位：米）
 * ------------------------------------------------------------------ */

/**
 * 整个世界的「地面高度场」。JS 端与 GLSL 端使用同一套参数，
 * 保证车轮贴合地面的高度与视觉上的地面一致。
 *
 * 构造思路：一片缓丘沙地 + 被侵蚀出的潮汐水洼，整体贴近海平面。
 */
export const WATER_LEVEL = 0.0;
export const BEACH_BASE = 0.85;

/**
 * 岛屿轮廓：半径 190m 内是完整陆地，向外 320m 平滑沉入深海。
 *
 * 这几个数字是量出来的，不是拍的。地形参数最容易翻车的地方是
 * 「噪声的均值不为零」—— fbm2 用的是 Perlin 梯度噪声，均值确实接近 0，
 * 但多个八度叠加后振幅分布很宽，实测均值会明显偏向一侧。
 * 所以基准高度 BEACH_BASE 必须按实测分布来定：
 *   基准 0.85m 时，半径 100m 内的平均地面只有 +0.8m，一大半在海面以下；
 *   抬到 3.2m 后，内圈 100% 是陆地，外圈 260m 处才入水 —— 这才是岛。
 */
const ISLAND_INNER = 185;
const ISLAND_OUTER = 400;

export function islandFalloff(x, z) {
  const r = Math.hypot(x, z);
  const t = Math.min(1, Math.max(0, (r - ISLAND_INNER) / (ISLAND_OUTER - ISLAND_INNER)));
  // 剖面形状很关键，直接决定海岸线好不好看。
  // 用 t²·(3−2t)：t 很小时按 t² 增长 —— 岸边起步极缓（可以推车下水），
  // 中段迅速变陡（浅滩带很窄），到外圈再放平（海床）。
  //   岸外 35m  → −2m   还是能看见沙底的浅水
  //   岸外 75m  → −8m   已经是不透光的深绿
  //   岸外 115m → −17m  深海
  // 如果改成线性或前陡后缓，要么海滩变成悬崖，要么浅滩宽到像泥滩。
  return -(t * t * (3 - 2 * t)) * 30;
}

export function terrainHeight(x, z) {
  // 大尺度缓丘（岛的地势）
  const broad = fbm2(x * 0.0080, z * 0.0080, 4) * 6.4;
  // 中尺度沙丘
  const dune = fbm2(x * 0.028 + 11.3, z * 0.028 - 7.1, 4) * 2.6;
  // 小尺度沙纹
  const fine = fbm2(x * 0.27 - 3.7, z * 0.27 + 5.9, 2) * 0.11;
  // 潮汐水洼：把低处往下压，形成浅水
  const basin = Math.max(0, -fbm2(x * 0.016 - 30.5, z * 0.016 + 18.2, 3)) * 4.4;

  return 3.2 + broad + dune + fine - basin + islandFalloff(x, z);
}

/** 出生点：一处平坦沙地，保证开局脚下没有陡坡 */
export const SPAWN = { x: 24, z: -18 };

/** 地形法线（有限差分），供车轮倾斜与道具对齐使用 */
export function terrainNormal(x, z, eps = 0.35, out = { x: 0, y: 1, z: 0 }) {
  const hL = terrainHeight(x - eps, z), hR = terrainHeight(x + eps, z);
  const hD = terrainHeight(x, z - eps), hU = terrainHeight(x, z + eps);
  const nx = hL - hR, ny = 2 * eps, nz = hD - hU;
  const len = Math.hypot(nx, ny, nz) || 1;
  out.x = nx / len; out.y = ny / len; out.z = nz / len;
  return out;
}

/** 地形坡度（0=平地，1=垂直），用于决定能不能长草 */
export function terrainSlope(x, z) {
  const n = terrainNormal(x, z);
  return 1 - Math.max(0, n.y);
}
