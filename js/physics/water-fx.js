/**
 * water-fx.js —— 水花与涟漪
 *
 * 水花：复用游戏的 GPU 粒子池（图集第 2 格「水花」），数量与初速按入水强度缩放。
 * 涟漪：一个 InstancedMesh（32 个扁平圆环，加色混合、不写深度），
 *       每帧把环放在当前浪面高度上（waves.js），半径随时间扩张、亮度衰减。
 * 声音：小的走 audio.splash，大的再叠一个低频的「扑通」。
 */
import * as THREE from 'three';
import { waveHeight } from './waves.js';

const RINGS = 32;
const _m = new THREE.Matrix4();
const _c = new THREE.Color();

export class WaterFX {
  constructor(scene, particles, audio, getListener) {
    this.particles = particles;
    this.audio = audio;
    this.getListener = getListener;     // () => {x,z}：声音按距离衰减
    const geo = new THREE.RingGeometry(0.82, 1.0, 40, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, RINGS);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < RINGS; i++) { this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0)); this.mesh.setColorAt(i, _c.setRGB(0, 0, 0)); }
    scene.add(this.mesh);
    this.ring = Array.from({ length: RINGS }, () => ({ x: 0, z: 0, t: 1, life: 1, r0: 0.3, r1: 2, s: 0 }));
    this._next = 0;
    this._lastSound = 0;
    this.time = 0;
    this.stats = { splashes: 0, rings: 0 };
  }

  _dist(x, z) {
    const l = this.getListener?.();
    return l ? Math.hypot(x - l.x, z - l.z) : 0;
  }

  /** 一次入水 / 撞水。strength ≈ 0..1.5 */
  splash(x, y, z, strength = 0.5, kind = '') {
    const s = Math.max(0.1, Math.min(1.5, strength));
    this.stats.splashes++;
    this.particles?.burst({
      x, y: y + 0.03, z, count: Math.round(10 + s * 34), speed: 1.2 + s * 2.6, up: 2.2 + s * 4.2, spread: 0.25 + s * 0.55,
      color: [0.82, 0.94, 1.0], intensity: 1.2 + s * 0.6, size: 0.12 + s * 0.14, life: 0.55 + s * 0.35, sprite: 2, gravity: 9.8,
    });
    this.addRing(x, z, s);
    if (s > 0.6) this.addRing(x, z, s * 0.6, 0.18);
    const d = this._dist(x, z);
    const now = performance.now();
    if (d < 60 && now - this._lastSound > 70) {
      this._lastSound = now;
      const k = (1 - d / 60);
      this.audio?.splash?.(Math.min(1.2, 0.35 + s * 0.7) * k);
      if (s > 0.55) this.audio?.plunge?.(Math.min(1, s) * k);
    }
  }

  /** 骑车涉水的持续水雾（每帧调用，按速度与深度给少量粒子） */
  spray(x, y, z, speed, depth, dt) {
    if (speed < 1.2 || depth <= 0.02) return;
    this._sprayAcc = (this._sprayAcc || 0) + dt * Math.min(40, speed * 6 * Math.min(1, depth * 4));
    while (this._sprayAcc > 1) {
      this._sprayAcc -= 1;
      this.particles?.burst({ x, y: y + 0.05, z, count: 2, speed: 0.6 + speed * 0.12, up: 1.2 + speed * 0.15, spread: 0.35,
        color: [0.8, 0.93, 1.0], intensity: 1.0, size: 0.07, life: 0.45, sprite: 2, gravity: 9.8 });
    }
    this._ringAcc = (this._ringAcc || 0) + dt;
    if (this._ringAcc > 0.22) { this._ringAcc = 0; this.addRing(x, z, Math.min(0.6, 0.15 + speed * 0.04)); }
  }

  addRing(x, z, s = 0.5, delay = 0) {
    const r = this.ring[this._next];
    this._next = (this._next + 1) % RINGS;
    r.x = x; r.z = z; r.t = -delay; r.life = 0.9 + s * 0.9; r.r0 = 0.2 + s * 0.2; r.r1 = 1.2 + s * 3.2; r.s = s;
    this.stats.rings++;
  }

  update(dt, t) {
    this.time = t;
    for (let i = 0; i < RINGS; i++) {
      const r = this.ring[i];
      if (r.t >= r.life) continue;
      r.t += dt;
      const u = Math.max(0, r.t / r.life);
      if (u >= 1 || r.t < 0) { this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0)); continue; }
      const rad = r.r0 + (r.r1 - r.r0) * (1 - (1 - u) * (1 - u));
      const y = waveHeight(r.x, r.z, t) + 0.04;
      _m.makeScale(rad, 1, rad).setPosition(r.x, y, r.z);
      this.mesh.setMatrixAt(i, _m);
      const a = (1 - u) * (1 - u) * Math.min(1, 0.4 + r.s);
      this.mesh.setColorAt(i, _c.setRGB(0.75 * a, 0.9 * a, 1.0 * a));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
