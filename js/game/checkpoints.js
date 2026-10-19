/**
 * checkpoints.js —— 检查点计时赛
 *
 * 环岛十个悬浮光环。下一个要穿的环是金色并缓缓旋转，再下一个是淡青色，
 * 其余几乎透明 —— 视线永远知道往哪骑。
 *
 * 计时用「飞行圈」：GO 之后先骑到起点环，穿过它才开始计第一圈，
 * 这样每一圈（包括第一圈）都可以公平地和最佳圈 / 幽灵车比较。
 */
import * as THREE from 'three';
import { glowMaterial } from './mesh.js';
import { GhostRider, GhostRecorder } from './ghost.js';
import { load, save } from './storage.js';

const RING_R = 3.3;
const _v = new THREE.Vector3();

export class TimeTrial {
  constructor(scene, layout, particles, audio) {
    this.layout = layout;
    this.particles = particles;
    this.audio = audio;
    this.group = new THREE.Group();
    this.group.name = 'Checkpoints';
    scene.add(this.group);
    this.laps = 3;

    const torus = new THREE.TorusGeometry(RING_R, 0.16, 8, 48);
    const inner = new THREE.TorusGeometry(RING_R - 0.35, 0.04, 4, 48);
    this.geos = [torus, inner];
    this.rings = layout.checkpoints.map((cp, i) => {
      const g = new THREE.Group();
      g.position.set(cp.x, cp.h + RING_R + 0.4, cp.z);
      g.rotation.y = cp.yaw;
      const mat = glowMaterial(i === 0 ? 0xfff2c4 : 0xffc46b, 2.4, 0.2);
      const mat2 = glowMaterial(0x7ff0e0, 2.0, 0.1);
      const outer = new THREE.Mesh(torus, mat);
      const inn = new THREE.Mesh(inner, mat2);
      g.add(outer, inn);
      // 起终点：两根柱子
      if (i === 0) {
        const postGeo = new THREE.CylinderGeometry(0.12, 0.16, RING_R * 2 + 0.6, 6);
        this.geos.push(postGeo);
        const postMat = new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.6 });
        for (const s of [-1, 1]) {
          const p = new THREE.Mesh(postGeo, postMat);
          p.position.set(s * (RING_R + 0.2), -0.2, 0);
          g.add(p);
        }
        this.postMat = postMat;
      }
      outer.renderOrder = inn.renderOrder = 4;
      this.group.add(g);
      return { group: g, mat, mat2, outer, inner: inn, cp, glow: 0 };
    });

    this.ghost = new GhostRider(scene);
    this.recorder = new GhostRecorder();
    this.best = load('ghost', null);      // { time, splits:[], samples:[] }
    if (this.best) this.ghost.setRecording(this.best.samples);

    this.state = 'idle';
    this.setVisible(false);
  }

  setVisible(v) {
    this.group.visible = v;
    if (!v) this.ghost.mesh.visible = false;
  }

  get bestLap() { return this.best ? this.best.time : null; }

  start() {
    this.state = 'running';
    this.next = 0;
    this.lap = 0;              // 已完成圈数
    this.lapStart = -1;        // 穿过起点环时刻（-1 = 还没开始计圈）
    this.time = 0;             // 总时间
    this.lapTimes = [];
    this.splits = [];
    this.lastDelta = null;
    this.finished = false;
    this.recorder.reset();
    this.setVisible(true);
  }

  stop() { this.state = 'idle'; }

  get lapTime() { return this.lapStart < 0 ? 0 : this.time - this.lapStart; }

  /** 下一个检查点位置（罗盘用） */
  nextTarget() { return this.rings[this.next]?.group.position; }

  /**
   * @returns {null | {type:'cp'|'lap'|'finish', ...}}
   */
  update(dt, player, running) {
    const t0 = performance.now() * 0.001;
    // 动画：下一个环旋转、发亮
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      const isNext = this.state === 'running' && i === this.next;
      const isAfter = this.state === 'running' && i === (this.next + 1) % this.rings.length;
      const want = isNext ? 1 : isAfter ? 0.45 : this.state === 'running' ? 0.12 : 0.3;
      r.glow += (want - r.glow) * Math.min(1, dt * 4);
      r.mat.opacity = r.glow;
      r.mat2.opacity = r.glow * 0.7;
      r.inner.rotation.z = t0 * (isNext ? 1.6 : 0.3);
      r.outer.scale.setScalar(isNext ? 1 + Math.sin(t0 * 4) * 0.035 : 1);
    }

    // 幽灵：与本圈同步回放
    this.ghost.update(dt, this.lapTime, this.state === 'running' && this.lapStart >= 0);

    if (this.state !== 'running' || !running) return null;
    this.time += dt;
    if (this.lapStart >= 0) this.recorder.tick(dt, player);

    const ring = this.rings[this.next];
    _v.copy(ring.group.position);
    const dx = player.pos.x - _v.x, dz = player.pos.z - _v.z;
    const dy = (player.pos.y + 1.0) - _v.y;
    if (Math.hypot(dx, dz) < RING_R + 0.9 && Math.abs(dy) < RING_R + 1.4) {
      return this._pass(player);
    }
    return null;
  }

  _pass(player) {
    const ring = this.rings[this.next];
    const p = ring.group.position;
    this.particles.burst({ x: p.x, y: p.y, z: p.z, count: 50, speed: 6, up: 2, spread: 1.5, color: [1, 0.8, 0.4], intensity: 2.6, size: 0.2, sprite: 1, life: 0.9, gravity: 2 });
    let ev;
    if (this.next === 0) {
      if (this.lapStart < 0) {
        // 第一次穿过起点：开始计圈
        this.lapStart = this.time;
        this.recorder.reset();
        this.audio?.checkpoint?.(0);
        ev = { type: 'start' };
      } else {
        const lt = this.time - this.lapStart;
        this.lapTimes.push(lt);
        const prevBest = this.best?.time ?? null;
        const isBest = prevBest == null || lt < prevBest;
        if (isBest) {
          this.best = { time: lt, splits: this.splits.slice(), samples: this.recorder.export() };
          if (!save('ghost', this.best)) {
            // 配额不足：退而求其次，只存成绩不存录像
            save('ghost', { time: lt, splits: this.best.splits, samples: [] });
          }
          this.ghost.setRecording(this.best.samples);
        }
        this.lap++;
        this.lastDelta = prevBest == null ? null : lt - prevBest;
        this.splits = [];
        if (this.lap >= this.laps) {
          this.state = 'done';
          this.finished = true;
          this.audio?.fanfare?.();
          return { type: 'finish', lapTime: lt, isBest, delta: this.lastDelta, total: this.time };
        }
        this.lapStart = this.time;
        this.recorder.reset();
        this.audio?.lap?.();
        ev = { type: 'lap', lapTime: lt, isBest, delta: this.lastDelta, lap: this.lap };
      }
    } else {
      const split = this.time - this.lapStart;
      this.splits[this.next] = split;
      const bs = this.best?.splits?.[this.next];
      this.lastDelta = bs != null ? split - bs : null;
      this.audio?.checkpoint?.(this.next);
      ev = { type: 'cp', index: this.next, split, delta: this.lastDelta };
    }
    this.next = (this.next + 1) % this.rings.length;
    return ev;
  }

  resetBest() { this.best = null; save('ghost', null); this.ghost.setRecording(null); }

  dispose() {
    this.geos.forEach((g) => g.dispose());
    this.rings.forEach((r) => { r.mat.dispose(); r.mat2.dispose(); });
    this.postMat?.dispose();
    this.ghost.dispose();
    this.group.removeFromParent();
  }
}
