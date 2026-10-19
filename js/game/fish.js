/**
 * fish.js —— 捕鱼 · 喉囊（核心循环）
 *
 * 近岸浅水里随机出现「鱼群点」：水面上一圈发光的涟漪，
 * 鱼会一条接一条地跃出水面（抛物线 + 沿速度方向翻身）。
 * 玩家骑车穿过 / 跳起来用喙去接，接到就进喉囊。
 *
 *   - 涉水时判定半径更大（喙贴着水面），但涉水本身会减速 —— 快与慢的取舍
 *   - 空中判定半径也更大，鼓励「冲浪跳」
 *   - 喉囊满了再碰到鱼会弹开，并提示去送鱼
 *
 * 渲染：所有跃起的鱼 = 1 个 InstancedMesh；所有涟漪 = 1 个 InstancedMesh。
 */
import * as THREE from 'three';
import { makeFishGeometry } from './mesh.js';
import { terrainHeight, WATER_LEVEL } from '../util/noise.js';

const MAX_SPOTS = 7;
const MAX_FISH = 18;
const TAU = Math.PI * 2;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _c = new THREE.Color();

export class FishSystem {
  constructor(scene, layout, particles, audio) {
    this.layout = layout;
    this.particles = particles;
    this.audio = audio;
    this.group = new THREE.Group();
    this.group.name = 'Fish';
    scene.add(this.group);

    this.capacity = 5;
    this.carrying = 0;
    this.targetSpots = 4;
    this.enabled = false;
    this.onCatch = null;        // (fish) => void
    this.onFull = null;

    // ---- 鱼 ----
    this.fishGeo = makeFishGeometry(1.25);
    this.fishMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.78, 0.38).multiplyScalar(2.4), fog: false });
    this.fishMesh = new THREE.InstancedMesh(this.fishGeo, this.fishMat, MAX_FISH);
    this.fishMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.fishMesh.frustumCulled = false;
    this.fishMesh.count = MAX_FISH;
    this.group.add(this.fishMesh);
    this.fish = [];
    for (let i = 0; i < MAX_FISH; i++) {
      this.fish.push({ active: false, t: 0, dur: 1, x: 0, z: 0, dx: 0, dz: 0, h: 2, y: 0, vy: 0, spot: -1, hue: 0, pos: new THREE.Vector3() });
      this.fishMesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
    }
    // 每条鱼略不同的颜色（金 / 青 / 粉）
    for (let i = 0; i < MAX_FISH; i++) {
      const k = i % 3;
      _c.setRGB(...(k === 0 ? [1.0, 0.75, 0.32] : k === 1 ? [0.45, 1.0, 0.92] : [1.0, 0.55, 0.62])).multiplyScalar(2.6);
      this.fishMesh.setColorAt(i, _c);
    }
    this.fishMat.color.setRGB(1, 1, 1);

    // ---- 鱼群点：水面涟漪光圈 ----
    const ringGeo = new THREE.RingGeometry(0.92, 1.08, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.ringGeo = ringGeo;
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    this.ringMesh = new THREE.InstancedMesh(ringGeo, this.ringMat, MAX_SPOTS * 2);
    this.ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ringMesh.frustumCulled = false;
    this.ringMesh.renderOrder = 4;
    this.group.add(this.ringMesh);
    for (let i = 0; i < MAX_SPOTS * 2; i++) {
      this.ringMesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
      this.ringMesh.setColorAt(i, _c.setRGB(0, 0, 0));
    }
    this.spots = [];
    for (let i = 0; i < MAX_SPOTS; i++) {
      this.spots.push({ active: false, x: 0, z: 0, ttl: 0, age: 0, next: 0, leaps: 0, fade: 0 });
    }
    this._spawnTimer = 0;
    this._t = 0;
    this._px = 0; this._pz = 0;
    this._tip = new THREE.Vector3();
    this.setVisible(false);
  }

  reset() {
    this.carrying = 0;
    for (const f of this.fish) f.active = false;
    for (const s of this.spots) { s.active = false; s.fade = 0; }
    this._spawnTimer = 0;
  }

  setVisible(v) {
    this.group.visible = v;
    this.enabled = v;
  }

  get fill() { return this.carrying / this.capacity; }
  get full() { return this.carrying >= this.capacity; }

  /** 在玩家附近的岸边找一处浅水 */
  _spawnSpot(px, pz, near = true) {
    const slot = this.spots.find((s) => !s.active);
    if (!slot) return;
    const pa = Math.atan2(px, pz);
    for (let tries = 0; tries < 14; tries++) {
      const a = near ? pa + (Math.random() - 0.5) * 1.6 : Math.random() * TAU;
      const sr = this.layout.shore.at(a);
      const r = sr + 3 + Math.random() * 12;
      const x = Math.sin(a) * r, z = Math.cos(a) * r;
      const h = terrainHeight(x, z);
      if (h > WATER_LEVEL - 0.12 || h < WATER_LEVEL - 0.95) continue;
      // 别和别的点挤在一起，也别刷在玩家脸上
      if (Math.hypot(x - px, z - pz) < 14) continue;
      if (this.spots.some((s) => s.active && Math.hypot(s.x - x, s.z - z) < 18)) continue;
      Object.assign(slot, { active: true, x, z, ttl: 26 + Math.random() * 10, age: 0, next: 0.6, leaps: 0, fade: 0 });
      return slot;
    }
    return null;
  }

  _leap(spot, si) {
    const f = this.fish.find((o) => !o.active);
    if (!f) return;
    const a = Math.random() * TAU;
    f.active = true;
    f.spot = si;
    f.t = 0;
    f.dur = 1.05 + Math.random() * 0.35;
    f.h = 1.5 + Math.random() * 1.1;
    f.x = spot.x + (Math.random() - 0.5) * 1.6;
    f.z = spot.z + (Math.random() - 0.5) * 1.6;
    const travel = 2.0 + Math.random() * 1.6;
    f.dx = Math.sin(a) * travel;
    f.dz = Math.cos(a) * travel;
    f.yaw = a;
    this.particles.burst({ x: f.x, y: WATER_LEVEL + 0.05, z: f.z, count: 14, speed: 2.2, up: 3.2, spread: 0.8, color: [0.7, 0.9, 1.0], intensity: 1.4, size: 0.12, life: 0.7, sprite: 2, gravity: 9 });
    // 水花声随距离衰减：远处的鱼群不该在耳边扑通
    const d = Math.hypot(f.x - this._px, f.z - this._pz);
    if (d < 70) this.audio?.splash?.(0.6 * (1 - d / 70));
  }

  /**
   * @param {number} dt
   * @param {object} c { playerPos, beakTip:Vector3, wading, airborne, speed }
   */
  update(dt, c) {
    if (!this.enabled) return;
    this._t += dt;
    const px = c.playerPos.x, pz = c.playerPos.z;
    this._px = px; this._pz = pz;

    // ---- 维持鱼群点数量 ----
    const activeSpots = this.spots.reduce((n, s) => n + (s.active ? 1 : 0), 0);
    this._spawnTimer -= dt;
    if (activeSpots < this.targetSpots && this._spawnTimer <= 0) {
      this._spawnSpot(px, pz, Math.random() < 0.75);
      this._spawnTimer = 1.2;
    }

    // ---- 鱼群点 ----
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i];
      if (!s.active) {
        if (s.fade > 0) s.fade = Math.max(0, s.fade - dt * 2);
      } else {
        s.age += dt;
        s.fade = Math.min(1, s.fade + dt * 1.5);
        s.next -= dt;
        if (s.next <= 0 && s.age < s.ttl - 1.5) {
          this._leap(s, i);
          s.leaps++;
          s.next = 1.1 + Math.random() * 1.6;
        }
        if (s.age > s.ttl) s.active = false;
      }
      // 两个错相的涟漪环
      for (let k = 0; k < 2; k++) {
        const ph = (this._t * 0.6 + k * 0.5 + i * 0.13) % 1;
        const sc = 0.6 + ph * 2.6;
        const vis = s.fade * (1 - ph) * (1 - ph);
        _m.makeScale(sc, 1, sc).setPosition(s.x, WATER_LEVEL + 0.06, s.z);
        this.ringMesh.setMatrixAt(i * 2 + k, s.fade > 0 ? _m : _m.makeScale(0, 0, 0));
        this.ringMesh.setColorAt(i * 2 + k, _c.setRGB(0.45 * vis * 1.3, 0.9 * vis * 1.3, 1.0 * vis * 1.3));
      }
    }
    this.ringMesh.instanceMatrix.needsUpdate = true;
    if (this.ringMesh.instanceColor) this.ringMesh.instanceColor.needsUpdate = true;

    // ---- 跃起的鱼 ----
    const tip = c.beakTip;
    const catchR = 1.25 + (c.wading > 0.2 ? 0.75 : 0) + (c.airborne ? 0.5 : 0);
    for (let i = 0; i < this.fish.length; i++) {
      const f = this.fish[i];
      if (!f.active) { this.fishMesh.setMatrixAt(i, _m.makeScale(0, 0, 0)); continue; }
      f.t += dt;
      const u = f.t / f.dur;
      if (u >= 1) {
        f.active = false;
        this.particles.burst({ x: f.x + f.dx, y: WATER_LEVEL + 0.05, z: f.z + f.dz, count: 10, speed: 1.6, up: 2.4, spread: 0.6, color: [0.7, 0.9, 1.0], intensity: 1.2, size: 0.1, sprite: 2, life: 0.6 });
        this.fishMesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
        continue;
      }
      // 抛物线：y = 4h·u(1-u)，从水下 0.3m 起跳
      const y = WATER_LEVEL - 0.3 + (4 * f.h * u * (1 - u)) + 0.3 * Math.sin(u * Math.PI);
      const x = f.x + f.dx * u, z = f.z + f.dz * u;
      f.pos.set(x, y, z);
      const vy = 4 * f.h * (1 - 2 * u) / f.dur;
      const vh = Math.hypot(f.dx, f.dz) / f.dur;
      const pitch = -Math.atan2(vy, vh);
      _e.set(pitch, f.yaw, Math.sin(this._t * 14 + i) * 0.25);
      _q.setFromEuler(_e);
      _s.setScalar(1);
      _m.compose(f.pos, _q, _s);
      this.fishMesh.setMatrixAt(i, _m);

      // 拖尾火花
      if (Math.random() < dt * 22) {
        const k = i % 3;
        this.particles.burst({ x, y, z, count: 1, speed: 0.2, up: 0.2, spread: 0.2, color: k === 0 ? [1, 0.75, 0.3] : k === 1 ? [0.4, 1, 0.9] : [1, 0.5, 0.6], sprite: 1, intensity: 2.2, size: 0.12, life: 0.5, gravity: 1 });
      }

      // ---- 捕获判定 ----
      if (y > WATER_LEVEL - 0.15 && tip) {
        const d = _p.set(x, y, z).distanceTo(tip);
        // 身体也能「撞」到鱼（车头高度），但判定小一些
        const db = Math.hypot(x - px, z - pz) + Math.max(0, Math.abs(y - (c.playerPos.y + 1.1)) - 0.8);
        if (d < catchR || db < catchR * 0.7) {
          if (this.full) {
            if (!f.bounced) {
              f.bounced = true;
              this.onFull?.();
            }
          } else {
            f.active = false;
            this.carrying++;
            this.fishMesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
            const k = i % 3;
            this.particles.burst({ x, y, z, count: 34, speed: 4, up: 3.5, spread: 1, color: k === 0 ? [1, 0.75, 0.3] : k === 1 ? [0.4, 1, 0.9] : [1, 0.5, 0.6], sprite: 1, intensity: 3, size: 0.16, life: 0.8, gravity: 6 });
            this.onCatch?.(f, { x, y, z });
          }
        }
      }
    }
    this.fishMesh.instanceMatrix.needsUpdate = true;
  }

  /** 拍照任务：返回当前露出水面的鱼（复用数组） */
  visibleFish(out) {
    out.length = 0;
    for (const f of this.fish) if (f.active && f.pos.y > WATER_LEVEL + 0.2) out.push(f.pos);
    return out;
  }

  /** 离玩家最近的鱼群点（罗盘 / 小地图用） */
  nearestSpot(px, pz) {
    let best = null, bd = Infinity;
    for (const s of this.spots) {
      if (!s.active) continue;
      const d = Math.hypot(s.x - px, s.z - pz);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  dispose() {
    this.fishGeo.dispose(); this.fishMat.dispose();
    this.ringGeo.dispose(); this.ringMat.dispose();
    this.fishMesh.dispose(); this.ringMesh.dispose();
    this.group.removeFromParent();
  }
}
