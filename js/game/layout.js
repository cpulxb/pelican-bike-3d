/**
 * layout.js —— 游戏关卡布局（确定性、从地形推出来）
 *
 * 灯塔、鸟巢、检查点、跳台的位置都不是手填坐标，而是在加载时
 * 沿着同一个高度场搜索出来的：这样以后改地形参数，关卡会自动跟着改，
 * 不会出现「检查点泡在水里」「跳台嵌进沙丘」这种问题。
 *
 * 约定：极角 a 对应方向 (sin a, cos a)，与 main.js 里 yaw 的约定一致。
 */
import { terrainHeight, WATER_LEVEL, SPAWN } from '../util/noise.js';

const TAU = Math.PI * 2;
const dirX = (a) => Math.sin(a);
const dirZ = (a) => Math.cos(a);

/** 沿极角 a 从外向内找到第一块陆地的半径（岸线） */
export function shoreRadius(a, rMax = 330) {
  for (let r = rMax; r > 20; r -= 1) {
    if (terrainHeight(dirX(a) * r, dirZ(a) * r) > WATER_LEVEL) return r;
  }
  return 200;
}

/** 某点周围的起伏程度（越小越平） */
function roughness(x, z, rad = 3) {
  let mn = Infinity, mx = -Infinity;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const h = terrainHeight(x + i * rad, z + j * rad);
    if (h < mn) mn = h; if (h > mx) mx = h;
  }
  return { range: mx - mn, min: mn, max: mx };
}

/** 预先算好岸线（每 2° 一个样本），供小地图与鱼群刷新点使用 */
function buildShore() {
  const N = 180;
  const r = new Float32Array(N);
  for (let i = 0; i < N; i++) r[i] = shoreRadius((i / N) * TAU);
  return { N, r, at(a) { const t = (((a / TAU) % 1) + 1) % 1 * N; const i = Math.floor(t) % N; const f = t - Math.floor(t); return r[i] * (1 - f) + r[(i + 1) % N] * f; } };
}

/** 找一个陆地上的点：沿半径方向在 [r0-span, r0+span] 里找最平、且高于水面的位置 */
function findLand(a, r0, span = 40, minH = 0.9) {
  let best = null, bestScore = Infinity;
  for (let dr = 0; dr <= span; dr += 4) {
    for (const s of dr === 0 ? [1] : [1, -1]) {
      const r = r0 + dr * s;
      const x = dirX(a) * r, z = dirZ(a) * r;
      const h = terrainHeight(x, z);
      if (h < WATER_LEVEL + minH) continue;
      const rg = roughness(x, z, 3).range;
      const score = rg * 2 + dr * 0.04;
      if (score < bestScore) { bestScore = score; best = { x, z, h, r, a }; }
    }
    if (best && bestScore < 0.6) break;
  }
  return best || { x: dirX(a) * r0, z: dirZ(a) * r0, h: terrainHeight(dirX(a) * r0, dirZ(a) * r0), r: r0, a };
}

export function buildLayout() {
  const shore = buildShore();

  // ---- 灯塔：立在最突出的岬角上 ----
  let la = 0, lr = 0;
  for (let i = 0; i < shore.N; i++) if (shore.r[i] > lr) { lr = shore.r[i]; la = (i / shore.N) * TAU; }
  let lighthouse = null;
  for (let r = lr - 8; r > lr - 60; r -= 2) {
    const x = dirX(la) * r, z = dirZ(la) * r;
    const h = terrainHeight(x, z);
    if (h > 1.3 && roughness(x, z, 2.5).range < 1.2) { lighthouse = { x, z, h, a: la, r }; break; }
  }
  if (!lighthouse) lighthouse = findLand(la, lr - 20, 30, 1.0);

  // ---- 鸟巢：三个，与灯塔错开 120° ----
  const nests = [];
  for (let k = 1; k <= 3; k++) {
    const a = la + (k / 4) * TAU + 0.25;
    const p = findLand(a, k === 2 ? 70 : 118, 36, 1.2);
    nests.push({ ...p, id: k });
  }

  // ---- 检查点：环岛 10 个，逆时针（与自动骑行同向）----
  const checkpoints = [];
  const CP = 10;
  const startA = Math.atan2(SPAWN.x, SPAWN.z);
  for (let i = 0; i < CP; i++) {
    // 逆时针 = 极角递减（与 autoSteer 的 radial - π/2 一致）
    const a = startA + 0.35 - (i / CP) * TAU;
    const wob = Math.sin(i * 2.3) * 22;
    const p = findLand(a, 148 + wob, 36, 0.7);
    checkpoints.push({ x: p.x, z: p.z, h: p.h, a });
  }
  // 每个圈的朝向 = 指向下一个检查点
  for (let i = 0; i < CP; i++) {
    const p = checkpoints[i], q = checkpoints[(i + 1) % CP], o = checkpoints[(i + CP - 1) % CP];
    p.yaw = Math.atan2((q.x - o.x), (q.z - o.z));
  }

  // ---- 跳台：放在检查点之间的直道上，朝向与赛道一致 ----
  const ramps = [];
  for (let i = 0; i < CP && ramps.length < 6; i++) {
    if (i % 2 === 1) continue;
    const p = checkpoints[i], q = checkpoints[(i + 1) % CP];
    const yaw = Math.atan2(q.x - p.x, q.z - p.z);
    const mx = p.x + (q.x - p.x) * 0.45, mz = p.z + (q.z - p.z) * 0.45;
    const rg = roughness(mx, mz, 4);
    if (rg.min < WATER_LEVEL + 0.6 || rg.range > 2.2) continue;
    ramps.push({ x: mx, z: mz, yaw, len: 6.5, height: 1.75, width: 3.4 });
  }
  // 出生点前方再放一个，开局就能练
  {
    const yaw = -0.6;
    const x = SPAWN.x + Math.sin(yaw) * 26, z = SPAWN.z + Math.cos(yaw) * 26;
    ramps.push({ x, z, yaw, len: 6.0, height: 1.5, width: 3.6 });
  }

  // ---- 起跑点：第一个检查点前 18m ----
  const c0 = checkpoints[0];
  const start = {
    x: c0.x - Math.sin(c0.yaw) * 18,
    z: c0.z - Math.cos(c0.yaw) * 18,
    yaw: c0.yaw,
  };

  return { shore, lighthouse, nests, checkpoints, ramps, start };
}
