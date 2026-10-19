/**
 * world.js —— Rapier 物理世界：碰撞体、松散石块、浮体、浮力、固定步长
 *
 * 单位：米 / 千克 / 秒，重力 9.81（街机模式只给自行车加重力倍率，石头和浮体永远是真实重力）。
 *
 * 碰撞体一览：
 *   地形   heightfield，1 m 网格覆盖 640×640 m，高度直接取 terrainHeight()（与可见地形同一函数）
 *   岩石   环境里散布的每块石头 → 一个静态凸包（顶点 = 实例矩阵变换后的同一份几何）
 *   棕榈   树干根部的竖直圆柱
 *   灯塔 / 鸟巢   圆柱组合
 *   跳台   三角网格（直接取跳台网格的顶点），随特技模块开关启用 / 禁用
 *   松散石块   动态凸包，密度 2600 kg/m³，可被撞飞、翻滚、落水下沉，静止后休眠
 *   浮体   漂流木（560 kg/m³）、浮标（拴在海底的绳索关节上，配重压低重心）、木箱
 *
 * 碰撞分组（membership << 16 | filter）：
 *   TERRAIN / STATIC / RAMP 与一切相撞；DYN（石块、浮体）与一切相撞；
 *   BIKE（车架 + 骑手）不与 WHEEL 相撞；WHEEL（两颗车轮球）只与 STATIC / DYN 相撞 ——
 *   车轮与地面的接触由悬挂射线负责，车轮球只用来「踢到」石头。
 *
 * 浮力：每个刚体有若干采样点，每点分到一份体积 V_i 与竖直尺度 h_i，
 *   浸没比例 f = clamp((水面 − (y − h_i/2)) / h_i, 0, 1)，
 *   F_浮 = ρ_水 · g · V_i · f（作用在该点上 → 自然产生扶正 / 倾覆力矩），
 *   F_阻 = −(½ ρ C_d A_i |u| + c_lin) · u · f，u = 点速度 − 水质点轨道速度。
 *   水面高度来自 waves.js —— 与海面着色器同一组 Gerstner 波。
 */
import * as THREE from 'three';
import { terrainHeight, terrainNormal, mulberry32, WATER_LEVEL } from '../util/noise.js';
import { waveHeight, waveVelocity, WAVE_MAX_AMP } from './waves.js';
import { propMaterial } from '../game/mesh.js';
import { ART, ART_GAIN, addTriplanarDetail } from '../gfx/textures.js';

export const GRAVITY = 9.81;
export const RHO_WATER = 1025;
export const STEP = 1 / 60;
const MAX_SUBSTEPS = 4;

export const GROUP = { TERRAIN: 1, STATIC: 2, RAMP: 4, DYN: 8, BIKE: 16, WHEEL: 32 };
export const groups = (member, filter) => ((member & 0xffff) << 16) | (filter & 0xffff);
const ALL = 0xffff;

/** 材质：碰撞体的摩擦 / 恢复系数，以及车胎在该表面的抓地（μ）与滚动阻力系数（C_rr） */
export const MATERIALS = {
  rock:    { friction: 0.75, restitution: 0.25, grip: 0.80, crr: 0.015 },
  sand:    { friction: 0.60, restitution: 0.05, grip: 0.55, crr: 0.060 },
  wetsand: { friction: 0.50, restitution: 0.08, grip: 0.65, crr: 0.030 },
  grass:   { friction: 0.55, restitution: 0.10, grip: 0.60, crr: 0.045 },
  wood:    { friction: 0.60, restitution: 0.20, grip: 0.70, crr: 0.012 },
};
export const DENSITY = { stone: 2600, driftwood: 560, crate: 380, buoyFoam: 160 };

/** 按画质档限制动态刚体数量 */
const TIER = {
  low:    { stones: 36, logs: 3, buoys: 1, crates: 1 },
  medium: { stones: 80, logs: 5, buoys: 2, crates: 1 },
  high:   { stones: 140, logs: 7, buoys: 2, crates: 2 },
};

const HF_SIZE = 640;        // 高度场覆盖的世界边长（米）
const HF_N = 640;           // 每边格子数 → 1 m 分辨率

/** 地形表面材质（与地形着色器的分层规则一致的粗略版本） */
export function terrainMaterial(x, z, h, ny) {
  if (h < WATER_LEVEL + 0.35) return MATERIALS.wetsand;
  if (ny < 0.88) return MATERIALS.rock;
  if (h > WATER_LEVEL + 1.4 && Math.hypot(x, z) < 175 && ny > 0.95) return MATERIALS.grass;
  return MATERIALS.sand;
}

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _wv = { x: 0, y: 0, z: 0 };
const _f = { x: 0, y: 0, z: 0 };
const _p = { x: 0, y: 0, z: 0 };
const _n = { x: 0, y: 1, z: 0 };

export class PhysicsWorld {
  /**
   * @param {object} R  RAPIER 模块
   * @param {object} o  { scene, env, game, quality }
   */
  constructor(R, o) {
    const t0 = performance.now();
    this.R = R;
    this.scene = o.scene;
    this.env = o.env;
    this.game = o.game;
    this.quality = o.quality || 'high';
    this.tier = TIER[this.quality] || TIER.high;

    this.world = new R.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = STEP;
    this.events = new R.EventQueue(true);

    this.info = new Map();          // collider.handle → { kind, mat, rec? }
    this.dynamic = [];              // 动态刚体记录（石块 + 浮体）
    this.acc = 0;
    this.alpha = 0;
    this.time = 0;
    this.onContactForce = null;     // (bikeCollider?, other info, impulse) —— BikeBody 挂上来
    this.onSplash = null;           // (x, y, z, strength)
    this.onClack = null;            // (x, y, z, strength)

    this.stats = {
      engine: `Rapier ${R.version?.() || ''}`.trim(), bodies: 0, dynamic: 0, awake: 0, colliders: 0,
      stepMs: 0, substeps: 0, alpha: 0, heightfieldErr: 0, buildMs: 0, inWater: 0,
    };

    this.group = new THREE.Group();
    this.group.name = 'Physics';
    this.scene.add(this.group);

    this._buildTerrain();
    this._buildRocks();
    this._buildPalms();
    this._buildLandmarks();
    this._buildRamps();
    this._buildStones();
    this._buildFloaters();

    // 让石块先自己落稳（1.5 秒），开局看到的是「躺在沙里」而不是「正在掉」
    this._snapAll();
    for (let i = 0; i < 90; i++) { this._applyWater(STEP, i * STEP); this.world.step(this.events); this._readState(); }
    this.events.clear();
    this._snapAll();

    this.stats.buildMs = Math.round(performance.now() - t0);
    this._verifyHeightfield();
    this._countStats();
  }

  /* ================================================================ *
   * 构建
   * ================================================================ */
  _register(collider, kind, mat, rec = null) {
    this.info.set(collider.handle, { kind, mat, rec, collider });
    return collider;
  }

  _staticDesc(desc, mat, group = GROUP.STATIC) {
    return desc.setFriction(mat.friction).setRestitution(mat.restitution)
      .setCollisionGroups(groups(group, ALL));
  }

  _buildTerrain() {
    const R = this.R;
    const n = HF_N, half = HF_SIZE / 2, step = HF_SIZE / n;
    // Rapier 的高度场按列存储：heights[ix * (n+1) + iz]，ix 沿 X、iz 沿 Z（_verifyHeightfield 会抽样核对）
    const heights = new Float32Array((n + 1) * (n + 1));
    for (let ix = 0; ix <= n; ix++) {
      const x = -half + ix * step;
      for (let iz = 0; iz <= n; iz++) heights[ix * (n + 1) + iz] = terrainHeight(x, -half + iz * step);
    }
    this.hf = { heights, n, half, step };
    const desc = R.ColliderDesc.heightfield(n, n, heights, { x: HF_SIZE, y: 1, z: HF_SIZE });
    this.terrain = this._register(this.world.createCollider(this._staticDesc(desc, MATERIALS.sand, GROUP.TERRAIN)), 'terrain', MATERIALS.sand);
  }

  /** 抽样核对：高度场碰撞体与 terrainHeight 的偏差（射线 vs 解析值） */
  _verifyHeightfield() {
    const R = this.R;
    this.world.step(this.events);   // 让场景查询结构就绪
    this.events.clear();
    const rnd = mulberry32(99);
    const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    let maxErr = 0, sum = 0, cnt = 0;
    for (let i = 0; i < 300; i++) {
      const x = (rnd() - 0.5) * 420, z = (rnd() - 0.5) * 420;
      ray.origin.x = x; ray.origin.y = 60; ray.origin.z = z;
      const hit = this.world.castRay(ray, 200, true, undefined, groups(ALL, GROUP.TERRAIN));
      if (!hit) continue;
      const e = Math.abs((60 - hit.timeOfImpact) - terrainHeight(x, z));
      maxErr = Math.max(maxErr, e); sum += e; cnt++;
    }
    this.stats.heightfieldErr = +maxErr.toFixed(4);
    this.stats.heightfieldMeanErr = cnt ? +(sum / cnt).toFixed(4) : -1;
    this.stats.heightfieldSamples = cnt;
    if (cnt < 200 || maxErr > 0.08) console.warn(`[physics] 高度场与地形函数偏差偏大：max ${maxErr.toFixed(3)} m（${cnt} 个样本）`);
  }

  _buildRocks() {
    const sc = this.env.scatter;
    if (!sc) return;
    const R = this.R;
    const geoPts = sc.rockGeos.map((g) => g.attributes.position.array);
    for (const rk of sc.rocks) {
      _m4.fromArray(rk.m);
      const src = geoPts[rk.g];
      const cnt = src.length / 3;
      const pts = new Float32Array(src.length);
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < cnt; i++) {
        _v.set(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]).applyMatrix4(_m4);
        pts[i * 3] = _v.x; pts[i * 3 + 1] = _v.y; pts[i * 3 + 2] = _v.z;
        cx += _v.x; cy += _v.y; cz += _v.z;
      }
      cx /= cnt; cy /= cnt; cz /= cnt;
      for (let i = 0; i < cnt; i++) { pts[i * 3] -= cx; pts[i * 3 + 1] -= cy; pts[i * 3 + 2] -= cz; }
      let desc = R.ColliderDesc.convexHull(pts);
      if (!desc) desc = R.ColliderDesc.ball(rk.s * 0.7);
      desc.setTranslation(cx, cy, cz);
      this._register(this.world.createCollider(this._staticDesc(desc, MATERIALS.rock)), 'rock', MATERIALS.rock);
    }
  }

  _buildPalms() {
    const sc = this.env.scatter;
    if (!sc) return;
    for (const p of sc.palms) {
      const desc = this.R.ColliderDesc.cylinder(0.9 * p.s, 0.23 * p.s).setTranslation(p.x, p.y + 0.9 * p.s - 0.1, p.z);
      this._register(this.world.createCollider(this._staticDesc(desc, MATERIALS.wood)), 'palm', MATERIALS.wood);
    }
  }

  _buildLandmarks() {
    const R = this.R;
    const L = this.game.layout;
    const lh = L.lighthouse;
    const y0 = lh.h - 0.3;
    const add = (desc, kind, mat) => this._register(this.world.createCollider(this._staticDesc(desc, mat)), kind, mat);
    add(R.ColliderDesc.cylinder(0.6, 3.5).setTranslation(lh.x, y0 + 0.6, lh.z), 'lighthouse', MATERIALS.rock);
    add(R.ColliderDesc.cylinder(0.25, 2.9).setTranslation(lh.x, y0 + 1.35, lh.z), 'lighthouse', MATERIALS.rock);
    // 塔身是上细下粗的锥台：用凸包
    const pts = [];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      pts.push(Math.sin(a) * 2.1, -7, Math.cos(a) * 2.1, Math.sin(a) * 1.25, 7, Math.cos(a) * 1.25);
    }
    const tower = R.ColliderDesc.convexHull(new Float32Array(pts)) || R.ColliderDesc.cylinder(7, 1.7);
    add(tower.setTranslation(lh.x, y0 + 1.6 + 7, lh.z), 'lighthouse', MATERIALS.rock);
    for (const n of L.nests) {
      add(R.ColliderDesc.cylinder(0.8, 0.24).setTranslation(n.x, n.h + 0.8, n.z), 'nest', MATERIALS.wood);
      add(R.ColliderDesc.cylinder(0.22, 0.88).setTranslation(n.x, n.h + 1.78, n.z), 'nest', MATERIALS.wood);
    }
  }

  /** 跳台：直接拿跳台网格（世界变换后）建三角网格碰撞体 */
  _buildRamps() {
    const R = this.R;
    this.ramps = [];
    for (const r of this.game.stunts.ramps) {
      r.mesh.updateMatrixWorld(true);
      const pos = r.mesh.geometry.attributes.position;
      const verts = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(r.mesh.matrixWorld);
        verts[i * 3] = _v.x; verts[i * 3 + 1] = _v.y; verts[i * 3 + 2] = _v.z;
      }
      const idx = new Uint32Array(pos.count);
      for (let i = 0; i < idx.length; i++) idx[i] = i;
      const desc = this._staticDesc(R.ColliderDesc.trimesh(verts, idx), MATERIALS.wood, GROUP.RAMP);
      const c = this._register(this.world.createCollider(desc), 'ramp', MATERIALS.wood);
      c.setEnabled(false);
      this.ramps.push(c);
    }
    this._rampsOn = false;
  }

  setRampsEnabled(on) {
    if (on === this._rampsOn) return;
    this._rampsOn = on;
    for (const c of this.ramps) c.setEnabled(on);
  }

  /* ---------------- 松散石块 ---------------- */
  _buildStones() {
    const R = this.R;
    const N = this.tier.stones;
    const rnd = mulberry32(4242);

    // 几何：低模二十面体 + 确定性的径向扰动（每块石头再各自非均匀缩放）
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i);
      const k = 1 + 0.22 * Math.sin(_v.x * 3.1 + 1.3) * Math.cos(_v.y * 2.7 - 0.4) + 0.12 * Math.sin(_v.z * 5.3 + _v.x * 1.7);
      _v.multiplyScalar(k);
      p.setXYZ(i, _v.x, _v.y, _v.z);
    }
    geo.computeVertexNormals();
    this.stoneGeo = geo;
    const mat = new THREE.MeshStandardMaterial({ color: 0xa0968a, roughness: 0.9, metalness: 0, flatShading: true });
    addTriplanarDetail(mat, ART.get('rockA'), { scale: 1.6, strength: 0.9, gain: ART_GAIN.rock, key: 'stone-loose' });
    this.stoneMat = mat;
    const mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    this.stoneMesh = mesh;
    this.group.add(mesh);

    const spots = this._stoneSpots(N, rnd);
    const base = geo.attributes.position.array;
    const pts = new Float32Array(base.length);
    const col = new THREE.Color();
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      const r = s.r;
      const sx = r * (0.85 + rnd() * 0.35), sy = r * (0.55 + rnd() * 0.35), sz = r * (0.8 + rnd() * 0.4);
      for (let j = 0; j < base.length; j += 3) { pts[j] = base[j] * sx; pts[j + 1] = base[j + 1] * sy; pts[j + 2] = base[j + 2] * sz; }
      const desc = R.ColliderDesc.convexHull(pts) || R.ColliderDesc.ball(r * 0.7);
      desc.setDensity(DENSITY.stone).setFriction(MATERIALS.rock.friction).setRestitution(MATERIALS.rock.restitution)
        .setCollisionGroups(groups(GROUP.DYN, ALL))
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS);
      _q.setFromEuler(new THREE.Euler(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28));
      const h = terrainHeight(s.x, s.z);
      const bd = R.RigidBodyDesc.dynamic().setTranslation(s.x, h + sy + 0.05, s.z)
        .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
        .setLinearDamping(0.02).setAngularDamping(0.25).setCanSleep(true).setCcdEnabled(r < 0.12);
      const body = this.world.createRigidBody(bd);
      const c = this.world.createCollider(desc, body);
      const mass = body.mass();
      c.setContactForceEventThreshold(mass * 60);
      const vol = mass / DENSITY.stone;
      const rec = this._record(body, 'stone', {
        index: i, scale: new THREE.Vector3(sx, sy, sz), mass, vol,
        pts: [[0, 0, 0, vol, 2 * sy]], cdA: Math.pow(vol, 2 / 3) * 1.2, cd: 0.9, size: r,
      });
      this._register(c, 'stone', MATERIALS.rock, rec);
      const shade = 0.82 + rnd() * 0.3;
      mesh.setColorAt(i, col.setRGB(shade, shade * (0.97 + rnd() * 0.05), shade * (0.92 + rnd() * 0.08)));
    }
    mesh.count = spots.length;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** 石块放在哪：出生点前方一小片碎石滩、检查点之间的路边、近岸沙滩 */
  _stoneSpots(N, rnd) {
    const out = [];
    const L = this.game.layout;
    const onRamp = (x, z) => this.game.stunts.ramps.some((r) => Math.hypot(r.cx - x, r.cz - z) < r.L * 0.7 + 1.5);
    const ok = (x, z) => {
      const h = terrainHeight(x, z);
      return h > WATER_LEVEL + 0.08 && !onRamp(x, z) && terrainNormal(x, z).y > 0.9;
    };
    const push = (x, z, r) => { if (out.length < N && ok(x, z)) out.push({ x, z, r }); };
    // 1) 出生点正前方 9~17 m：一开局就能撞到
    const sx = 24, sz = -18, yaw = -0.6;
    const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    for (let i = 0; i < Math.min(12, Math.round(N * 0.12)); i++) {
      const d = 9 + rnd() * 8, l = (rnd() - 0.5) * 5;
      push(sx + fx * d + rx * l, sz + fz * d + rz * l, 0.07 + Math.pow(rnd(), 1.8) * 0.16);
    }
    // 2) 路边：每两个检查点之间撒一小撮
    const cps = L.checkpoints;
    for (let k = 0; k < cps.length && out.length < N * 0.55; k++) {
      const a = cps[k], b = cps[(k + 1) % cps.length];
      const t = 0.25 + rnd() * 0.5;
      const cx = a.x + (b.x - a.x) * t, cz = a.z + (b.z - a.z) * t;
      for (let j = 0; j < 5; j++) push(cx + (rnd() - 0.5) * 7, cz + (rnd() - 0.5) * 7, 0.06 + Math.pow(rnd(), 2.2) * 0.2);
    }
    // 3) 沙滩：岸线内侧 1~10 m
    for (let tries = 0; out.length < N && tries < N * 30; tries++) {
      const a = rnd() * Math.PI * 2;
      const sr = L.shore.at(a);
      const r = sr - 1 - rnd() * 9;
      push(Math.sin(a) * r, Math.cos(a) * r, 0.05 + Math.pow(rnd(), 2.4) * 0.22);
    }
    return out;
  }

  /* ---------------- 浮体 ---------------- */
  _buildFloaters() {
    const R = this.R;
    const L = this.game.layout;
    const rnd = mulberry32(777);
    const wood = propMaterial('wood');
    // 找近岸浅水点：从岸线往外，地形落到 [-2.6, -1.2] 的位置
    const findWater = (a) => {
      const sr = L.shore.at(a);
      for (let r = sr; r < sr + 60; r += 0.5) {
        const h = terrainHeight(Math.sin(a) * r, Math.cos(a) * r);
        if (h < WATER_LEVEL - 1.6) return { x: Math.sin(a) * r, z: Math.cos(a) * r, h };
      }
      return null;
    };
    // 摆放的极角：灯塔、各鸟巢方向，以及出生点所朝的海岸（开局最可能看到的地方）
    const angles = [L.lighthouse.a, ...L.nests.map((n) => Math.atan2(n.x, n.z)), Math.atan2(24, -18), L.checkpoints[0].a];

    const tier = this.tier;
    let k = 0;
    // ---- 漂流木 ----
    for (let i = 0; i < tier.logs; i++) {
      const sp = findWater(angles[i % angles.length] + (rnd() - 0.5) * 0.08);
      if (!sp) continue;
      const len = 1.6 + rnd() * 1.4, rad = 0.12 + rnd() * 0.08;
      const geo = new THREE.CylinderGeometry(rad * 0.9, rad, len, 9, 1);
      geo.rotateZ(Math.PI / 2);
      this._colorize(geo, 0x8b7355);
      const mesh = new THREE.Mesh(geo, wood);
      mesh.castShadow = true;
      this.group.add(mesh);
      const desc = R.ColliderDesc.cylinder(len / 2, rad).setRotation(this._qz90())
        .setDensity(DENSITY.driftwood).setFriction(MATERIALS.wood.friction).setRestitution(0.15)
        .setCollisionGroups(groups(GROUP.DYN, ALL));
      const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic()
        .setTranslation(sp.x + (rnd() - 0.5) * 3, WATER_LEVEL + 0.4, sp.z + (rnd() - 0.5) * 3)
        .setRotation(this._qy(rnd() * 6.28)).setCanSleep(true).setLinearDamping(0.05).setAngularDamping(0.2));
      const c = this.world.createCollider(desc, body);
      const vol = body.mass() / DENSITY.driftwood;
      const pts = [];
      for (let j = 0; j < 5; j++) pts.push([(j / 4 - 0.5) * len * 0.9, 0, 0, vol / 5, 2 * rad]);
      const rec = this._record(body, 'log', { mesh, mass: body.mass(), vol, pts, cdA: 2 * rad * len / 5, cd: 1.0, size: len });
      this._register(c, 'floater', MATERIALS.wood, rec);
      k++;
    }
    // ---- 浮标：泡沫浮体 + 底部配重（重心压低才能直立），用绳索拴在海底 ----
    for (let i = 0; i < tier.buoys; i++) {
      const sp = findWater(angles[(i * 2 + 1) % angles.length] + 0.04);
      if (!sp) continue;
      const rad = 0.36, hh = 0.55;
      const parts = new THREE.Group();
      const g1 = new THREE.CylinderGeometry(rad, rad * 0.9, hh * 2, 14); this._colorize(g1, 0xd8452e);
      const g2 = new THREE.CylinderGeometry(rad * 1.02, rad * 1.02, 0.22, 14); this._colorize(g2, 0xf2e4cd);
      const g3 = new THREE.ConeGeometry(rad * 0.6, 0.55, 10); this._colorize(g3, 0xd8452e);
      const m1 = new THREE.Mesh(g1, wood), m2 = new THREE.Mesh(g2, wood), m3 = new THREE.Mesh(g3, wood);
      m2.position.y = 0.12; m3.position.y = hh + 0.27;
      parts.add(m1, m2, m3);
      parts.traverse((o) => { o.castShadow = true; });
      this.group.add(parts);
      const foamMass = DENSITY.buoyFoam * Math.PI * rad * rad * hh * 2;
      const mass = foamMass + 38;   // 38 kg 配重
      const desc = R.ColliderDesc.cylinder(hh, rad)
        .setMassProperties(mass, { x: 0, y: -0.32, z: 0 }, { x: mass * 0.09, y: mass * 0.06, z: mass * 0.09 }, { x: 0, y: 0, z: 0, w: 1 })
        .setFriction(0.5).setRestitution(0.2).setCollisionGroups(groups(GROUP.DYN, ALL));
      const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic()
        .setTranslation(sp.x, WATER_LEVEL + 0.1, sp.z).setCanSleep(false).setLinearDamping(0.05).setAngularDamping(0.3));
      const c = this.world.createCollider(desc, body);
      const vol = Math.PI * rad * rad * hh * 2;
      const pts = [[0, -hh * 0.66, 0, vol / 3, hh * 2 / 3], [0, 0, 0, vol / 3, hh * 2 / 3], [0, hh * 0.66, 0, vol / 3, hh * 2 / 3]];
      const rec = this._record(body, 'buoy', { mesh: parts, mass, vol, pts, cdA: 2 * rad * hh * 2 / 3, cd: 0.9, size: hh * 2 });
      this._register(c, 'floater', MATERIALS.wood, rec);
      // 锚：海底一个固定刚体 + 绳索关节（长度 = 水深 + 余量）
      const anchor = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(sp.x, sp.h, sp.z));
      const rope = R.JointData.rope(WATER_LEVEL - sp.h + 0.9, { x: 0, y: 0, z: 0 }, { x: 0, y: -hh, z: 0 });
      this.world.createImpulseJoint(rope, anchor, body, true);
      k++;
    }
    // ---- 木箱 ----
    for (let i = 0; i < tier.crates; i++) {
      const sp = findWater(angles[(i + 3) % angles.length] - 0.05);
      if (!sp) continue;
      const s = 0.36;
      const geo = new THREE.BoxGeometry(s * 2, s * 2, s * 2);
      this._colorize(geo, 0xb08a5a);
      const mesh = new THREE.Mesh(geo, wood);
      mesh.castShadow = true;
      this.group.add(mesh);
      const desc = R.ColliderDesc.cuboid(s, s, s).setDensity(DENSITY.crate).setFriction(0.55).setRestitution(0.15)
        .setCollisionGroups(groups(GROUP.DYN, ALL));
      const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic()
        .setTranslation(sp.x + 2, WATER_LEVEL + 0.5, sp.z - 1).setRotation(this._qy(rnd() * 6.28)).setCanSleep(true));
      const c = this.world.createCollider(desc, body);
      const vol = 8 * s * s * s;
      const pts = [];
      for (const ax of [-1, 1]) for (const ay of [-1, 1]) for (const az of [-1, 1]) pts.push([ax * s / 2, ay * s / 2, az * s / 2, vol / 8, s]);
      const rec = this._record(body, 'crate', { mesh, mass: body.mass(), vol, pts, cdA: s * s, cd: 1.05, size: 2 * s });
      this._register(c, 'floater', MATERIALS.wood, rec);
      k++;
    }
  }

  _colorize(geo, hex) {
    const c = new THREE.Color(hex);
    const n = geo.attributes.position.count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  }
  _qz90() { _q.setFromAxisAngle(_v.set(0, 0, 1), Math.PI / 2); return { x: _q.x, y: _q.y, z: _q.z, w: _q.w }; }
  _qy(a) { return { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }; }

  /** 动态刚体记录：上一步 / 这一步的位姿用于渲染插值（预分配，零分配更新） */
  _record(body, kind, o) {
    const rec = Object.assign({
      body, kind, prev: new Float32Array(7), curr: new Float32Array(7),
      wet: false, written: false, sub: 0, damp: -1,
    }, o);
    this.dynamic.push(rec);
    return rec;
  }

  /* ================================================================ *
   * 运行
   * ================================================================ */

  /**
   * 固定步长推进。pre(h, t) 在每个子步之前调用（自行车施力），post(h, t) 在之后。
   * @param {number} dt      这一帧的真实时间
   * @param {number} elapsed 帧末的游戏时钟（clock.elapsed，与海面着色器的 uTime 一致）
   */
  update(dt, elapsed, pre, post) {
    const t0 = performance.now();
    this.acc += dt;
    let n = 0;
    while (this.acc >= STEP && n < MAX_SUBSTEPS) {
      const t = elapsed - this.acc + STEP;
      this.time = t;
      pre?.(STEP, t);
      this._applyWater(STEP, t);
      this.world.step(this.events);
      this._drainEvents();
      this._readState();
      post?.(STEP, t);
      this.acc -= STEP;
      n++;
    }
    if (this.acc >= STEP) this.acc %= STEP;   // 掉帧太多：丢弃积压，宁可慢动作也不要螺旋死亡
    this.alpha = this.acc / STEP;
    this.stats.substeps = n;
    this.stats.alpha = +this.alpha.toFixed(2);
    const ms = performance.now() - t0;
    this.stats.stepMs = +(this.stats.stepMs * 0.9 + ms * 0.1).toFixed(3);
    this._syncVisuals();
  }

  _drainEvents() {
    this.events.drainContactForceEvents((e) => {
      const a = this.info.get(e.collider1()), b = this.info.get(e.collider2());
      if (!a || !b) return;
      const mag = e.totalForceMagnitude() * STEP;   // 冲量（N·s）
      if (this.onContactForce && (a.kind === 'bike' || b.kind === 'bike')) {
        this.onContactForce(a.kind === 'bike' ? b : a, mag);
      } else if (this.onClack && (a.kind === 'stone' || b.kind === 'stone')) {
        const s = a.kind === 'stone' ? a : b;
        const p = s.rec.curr;
        this.onClack(p[0], p[1], p[2], Math.min(1, mag / (s.rec.mass * 1.5)));
      }
    });
  }

  /** 每个子步后读回位姿（只读醒着的刚体） */
  _readState() {
    for (let i = 0; i < this.dynamic.length; i++) {
      const r = this.dynamic[i];
      if (r.body.isSleeping()) continue;
      r.prev.set(r.curr);
      const t = r.body.translation(), q = r.body.rotation();
      const c = r.curr;
      c[0] = t.x; c[1] = t.y; c[2] = t.z; c[3] = q.x; c[4] = q.y; c[5] = q.z; c[6] = q.w;
      r.written = false;
      // 掉出世界（被撞进深海、滚出高度场）：放回原处附近的沙滩
      if (t.y < -45) this._rescue(r);
    }
  }

  _rescue(r) {
    const a = Math.atan2(r.curr[0], r.curr[2]);
    const rr = this.game.layout.shore.at(a) - 4;
    const x = Math.sin(a) * rr, z = Math.cos(a) * rr;
    r.body.setTranslation({ x, y: terrainHeight(x, z) + 1, z }, true);
    r.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    r.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  _snapAll() {
    for (const r of this.dynamic) {
      const t = r.body.translation(), q = r.body.rotation();
      r.curr[0] = t.x; r.curr[1] = t.y; r.curr[2] = t.z; r.curr[3] = q.x; r.curr[4] = q.y; r.curr[5] = q.z; r.curr[6] = q.w;
      r.prev.set(r.curr);
      r.written = false;
    }
    this._syncVisuals(true);
  }

  /**
   * 浮力 + 水阻（每个子步）。
   * 只处理「可能碰到水」的刚体：最高浪尖以上的直接跳过，彻底沉底且睡着的也跳过。
   */
  _applyWater(h, t) {
    const top = WATER_LEVEL + WAVE_MAX_AMP;
    let inWater = 0;
    for (let i = 0; i < this.dynamic.length; i++) {
      const r = this.dynamic[i];
      const b = r.body;
      const c = r.curr;
      const sleeping = b.isSleeping();
      if (c[1] - r.size > top) { if (r.wet) r.wet = false; if (r.damp !== 0) this._setDamp(r, 0); continue; }
      if (sleeping && c[1] + r.size < WATER_LEVEL - WAVE_MAX_AMP - 0.3) continue;
      // 石块睡在干沙上、浪也够不到它
      if (sleeping && r.kind === 'stone' && waveHeight(c[0], c[2], t) < c[1] - r.size) continue;

      b.resetForces(false);
      b.resetTorques(false);
      _q.set(c[3], c[4], c[5], c[6]);
      const lv = b.linvel(), av = b.angvel();
      const com = b.worldCom();
      let fsub = 0;
      for (let k = 0; k < r.pts.length; k++) {
        const pt = r.pts[k];
        _v.set(pt[0], pt[1], pt[2]).applyQuaternion(_q);
        const px = c[0] + _v.x, py = c[1] + _v.y, pz = c[2] + _v.z;
        const wy = waveHeight(px, pz, t);
        const ext = pt[4];
        const f = Math.min(1, Math.max(0, (wy - (py - ext / 2)) / ext));
        if (f <= 0) continue;
        fsub += f / r.pts.length;
        // 点速度 = v + ω × (p − com)
        const rx = px - com.x, ry = py - com.y, rz = pz - com.z;
        const vx = lv.x + av.y * rz - av.z * ry;
        const vy = lv.y + av.z * rx - av.x * rz;
        const vz = lv.z + av.x * ry - av.y * rx;
        waveVelocity(px, pz, t, _wv);
        const ux = vx - _wv.x, uy = vy - _wv.y, uz = vz - _wv.z;
        const u = Math.hypot(ux, uy, uz);
        const Vi = pt[3];
        // 阻力：二次项（形状阻力）+ 线性项（低速时的粘性 / 兴波阻尼）
        let kd = (0.5 * RHO_WATER * r.cd * r.cdA * u + RHO_WATER * Vi * 1.2) * f;
        // 显式积分的稳定性：一个子步内阻力不能把相对速度「反向」
        const mi = r.mass * (Vi / r.vol);
        kd = Math.min(kd, mi / h);
        _f.x = -kd * ux;
        _f.y = RHO_WATER * GRAVITY * Vi * f - kd * uy;
        _f.z = -kd * uz;
        _p.x = px; _p.y = py; _p.z = pz;
        b.addForceAtPoint(_f, _p, true);
      }
      if (fsub > 0) inWater++;
      this._setDamp(r, fsub);
      // 入水判定：中心从水面以上穿到以下，且在往下掉
      const wyC = waveHeight(c[0], c[2], t);
      const wetNow = c[1] < wyC;
      if (wetNow && !r.wet && lv.y < -1.0 && this.onSplash) {
        this.onSplash(c[0], wyC, c[2], Math.min(1.5, (-lv.y) * Math.sqrt(r.mass) / 25), r.kind);
      }
      r.wet = wetNow;
    }
    this.stats.inWater = inWater;
  }

  /** 附加阻尼：浸没越深，转动越「黏」（水对转动的阻力比对平动大得多） */
  _setDamp(r, fsub) {
    const q = Math.round(fsub * 10) / 10;
    if (q === r.damp) return;
    r.damp = q;
    r.body.setAngularDamping((r.kind === 'stone' ? 0.25 : 0.2) + q * 2.2);
    r.body.setLinearDamping((r.kind === 'stone' ? 0.02 : 0.05) + q * 0.15);
  }

  /** 把物理位姿插值后写进网格（每帧一次） */
  _syncVisuals(force = false) {
    const a = this.alpha;
    let dirty = false, awake = 0;
    for (let i = 0; i < this.dynamic.length; i++) {
      const r = this.dynamic[i];
      const sleeping = r.body.isSleeping();
      if (!sleeping) awake++;
      if (sleeping && r.written && !force) continue;
      if (sleeping) r.prev.set(r.curr);   // 睡着了：停在最后的位姿，不再插值
      const p = r.prev, c = r.curr;
      _v.set(p[0] + (c[0] - p[0]) * a, p[1] + (c[1] - p[1]) * a, p[2] + (c[2] - p[2]) * a);
      _q.set(p[3], p[4], p[5], p[6]).slerp(_qb.set(c[3], c[4], c[5], c[6]), a);
      if (r.kind === 'stone') {
        _m4.compose(_v, _q, r.scale);
        this.stoneMesh.setMatrixAt(r.index, _m4);
        dirty = true;
      } else {
        r.mesh.position.copy(_v);
        r.mesh.quaternion.copy(_q);
      }
      r.written = sleeping;
    }
    if (dirty) this.stoneMesh.instanceMatrix.needsUpdate = true;
    this.stats.awake = awake;
  }

  _countStats() {
    let bodies = 0, colliders = 0;
    this.world.bodies.forEach(() => bodies++);
    this.world.colliders.forEach(() => colliders++);
    this.stats.bodies = bodies;
    this.stats.colliders = colliders;
    this.stats.dynamic = this.dynamic.length;
    this.stats.stones = this.dynamic.filter((r) => r.kind === 'stone').length;
    this.stats.floaters = this.stats.dynamic - this.stats.stones;
  }

  /* ================================================================ *
   * 调试 / 测试辅助
   * ================================================================ */

  /** 在 (x, y, z) 放一块石头（复用最远的那块），返回记录 */
  dropStone(x, y, z, vx = 0, vy = 0, vz = 0) {
    let best = null, bd = -1;
    for (const r of this.dynamic) {
      if (r.kind !== 'stone') continue;
      const d = Math.hypot(r.curr[0] - x, r.curr[2] - z);
      if (d > bd) { bd = d; best = r; }
    }
    if (!best) return null;
    this._teleport(best, x, y, z, vx, vy, vz);
    return best;
  }

  dropFloater(kind, x, y, z) {
    const r = this.dynamic.find((d) => d.kind === kind);
    if (!r) return null;
    this._teleport(r, x, y, z, 0, 0, 0);
    return r;
  }

  _teleport(r, x, y, z, vx, vy, vz) {
    r.body.setTranslation({ x, y, z }, true);
    r.body.setLinvel({ x: vx, y: vy, z: vz }, true);
    r.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    const t = r.body.translation();
    r.curr[0] = t.x; r.curr[1] = t.y; r.curr[2] = t.z;
    r.prev.set(r.curr);
    r.wet = false;
    r.written = false;
  }

  bodyState(r) {
    const t = r.body.translation(), v = r.body.linvel();
    return { x: +t.x.toFixed(3), y: +t.y.toFixed(3), z: +t.z.toFixed(3), vx: +v.x.toFixed(2), vy: +v.y.toFixed(2), vz: +v.z.toFixed(2), sleeping: r.body.isSleeping(), water: +waveHeight(t.x, t.z, this.time).toFixed(3) };
  }

  /**
   * 前方障碍探测（自动骑行绕开岩石 / 树干 / 灯塔 / 大石块）：返回 -1..1 的转向偏置，
   * 正前方最近障碍的距离写进 this.avoidNear（自动骑行据此收油）。
   */
  avoidSteer(x, y, z, yaw) {
    const R = this.R;
    if (!this._probe) {
      this._probe = true;
      this._probeGroups = groups(ALL, GROUP.STATIC | GROUP.DYN);
      // 小石子不用躲（踢开就是了）：只躲静态物与比车还重的石块 / 浮体
      this._probePred = (c) => { const i = this.info.get(c.handle); return !!i && (!i.rec || i.rec.mass > 18); };
    }
    // 扫掠一个半径 0.45 m 的球（比射线稳：细树干、低矮石块都不会从两根射线之间漏过去）
    if (!this._probeShape) { this._probeShape = new R.Ball(0.45); this._probePos = { x: 0, y: 0, z: 0 }; this._probeVel = { x: 0, y: 0, z: 0 }; this._probeRot = { x: 0, y: 0, z: 0, w: 1 }; }
    let bias = 0;
    this.avoidNear = 99;
    const RANGE = 13;
    const pos = this._probePos, vel = this._probeVel;
    for (let k = 0; k < PROBES.length; k++) {
      const off = PROBES[k][0], w = PROBES[k][1];
      const a = yaw + off;
      pos.x = x + Math.sin(a) * 0.9; pos.y = y + 0.5; pos.z = z + Math.cos(a) * 0.9;
      vel.x = Math.sin(a); vel.y = 0; vel.z = Math.cos(a);
      const hit = this.world.castShape(pos, this._probeRot, vel, this._probeShape, 0, RANGE, false, undefined, this._probeGroups, undefined, undefined, this._probePred);
      if (!hit) continue;
      const toi = hit.time_of_impact ?? hit.timeOfImpact ?? RANGE;
      const k2 = (1 - toi / RANGE) * w;
      if (Math.abs(off) < 0.3) this.avoidNear = Math.min(this.avoidNear, toi);
      // yaw + off（off>0）在车手左边：左边有东西就往右打（steer>0）；右边 / 正前方有东西往左打
      bias += off > 0 ? k2 : off < 0 ? -k2 : (this._side || 1) * k2 * 1.5;
    }
    if (bias === 0) this._side = Math.sin(x * 0.37 + z * 0.21) > 0 ? 1 : -1;
    return Math.max(-1, Math.min(1, bias));
  }

  dispose() {
    this.group.removeFromParent();
    this.stoneGeo?.dispose();
    this.stoneMat?.dispose();
    this.world.free();
  }
}

const _qb = new THREE.Quaternion();
const PROBES = [[0, 1], [0.22, 0.85], [-0.22, 0.85], [0.5, 0.5], [-0.5, 0.5]];
