/**
 * stunts.js —— 特技连击：跳台 + 空中动作 + 落地评判 + 连击槽
 *
 * 跳台是「改写地面高度」实现的：physics 每帧问 groundAt(x,z)，
 * 落在跳台范围内就返回跳台表面高度与法线。到了台唇，地面突然消失，
 * main.js 里通用的「离地判定」就会把车抛出去 —— 跳台没有任何特殊代码路径。
 *
 * 空中：A/D 转体（yaw），W/S 压头 / 抬头（俯仰），B 摇铃加分。
 * 落地：车头朝向与飞行方向夹角、俯仰、侧倾都要在容差内，否则摔车。
 */
import * as THREE from 'three';
import { mergeColored, trs, propMaterial } from './mesh.js';
import { terrainHeight } from '../util/noise.js';

const TAU = Math.PI * 2;
const profile = (t) => Math.pow(t, 1.6);
const profileD = (t) => 1.6 * Math.pow(Math.max(t, 1e-4), 0.6);

export class Stunts {
  constructor(scene, layout, particles, audio) {
    this.particles = particles;
    this.audio = audio;
    this.group = new THREE.Group();
    this.group.name = 'Ramps';
    scene.add(this.group);
    this.ramps = [];
    this.geos = [];
    for (const r of layout.ramps) this._buildRamp(r);
    this.enabled = false;
    this.group.visible = false;

    this.score = 0;
    this.combo = 0;
    this.comboTimer = 0;      // 连击槽剩余时间
    this.comboWindow = 5.5;
    this.bank = 0;            // 当前连击累积、尚未结算的分数
    this.best = 0;
    this.tricks = 0;
  }

  _buildRamp(r) {
    const L = r.len, H = r.height, W = r.width;
    const sy = Math.sin(r.yaw), cy = Math.cos(r.yaw);
    const x0 = r.x - sy * L / 2, z0 = r.z - cy * L / 2;
    const base = terrainHeight(x0, z0) - 0.04;

    // 表面：沿 u 方向 14 段的曲面，木板条纹用顶点色区分
    const seg = 14;
    const pos = [];
    // 绕序取反：上面写的四边形按「从外面看是顺时针」列点，这里翻成逆时针（正面朝外）
    const quad = (a, b, c, d) => { pos.push(...a, ...c, ...b, ...a, ...d, ...c); };
    const P = (u, v, y) => [v, y, u];
    for (let i = 0; i < seg; i++) {
      const t0 = i / seg, t1 = (i + 1) / seg;
      const u0 = t0 * L, u1 = t1 * L, y0 = profile(t0) * H, y1 = profile(t1) * H;
      quad(P(u0, -W / 2, y0), P(u0, W / 2, y0), P(u1, W / 2, y1), P(u1, -W / 2, y1));
      // 两侧板：一直延伸到地下，挡住缝隙
      quad(P(u0, W / 2, y0), P(u0, W / 2, -0.6), P(u1, W / 2, -0.6), P(u1, W / 2, y1));
      quad(P(u1, -W / 2, y1), P(u1, -W / 2, -0.6), P(u0, -W / 2, -0.6), P(u0, -W / 2, y0));
    }
    // 背板
    quad(P(L, -W / 2, H), P(L, W / 2, H), P(L, W / 2, -0.6), P(L, -W / 2, -0.6));
    const top = new THREE.BufferGeometry();
    top.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    top.computeVertexNormals();

    const parts = [[top, (x, y, z) => {
      if (Math.abs(x) > W / 2 - 0.01) return 0x9a7650;               // 侧板
      const plank = Math.floor(z / 0.42) % 2;
      return plank ? 0xe6c79c : 0xd4b084;   // 浅色木板：在黄昏暖光下不至于发暗发红
    }]];
    // 台唇的警示条 + 两根撑木
    parts.push([new THREE.BoxGeometry(W + 0.05, 0.08, 0.2), (x) => (Math.floor((x + 3) / 0.4) % 2 ? 0xf2e4cd : 0xd8452e), trs(0, H + 0.02, L - 0.1)]);
    for (const s of [-1, 1]) {
      parts.push([new THREE.BoxGeometry(0.14, H + 0.6, 0.14), 0x7a5a3c, trs(s * (W / 2 - 0.2), (H - 0.6) / 2, L - 0.3)]);
    }
    const geo = mergeColored(parts);
    this.geos.push(geo);
    const mesh = new THREE.Mesh(geo, propMaterial());
    mesh.position.set(x0, base, z0);
    mesh.rotation.y = r.yaw;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.ramps.push({ x0, z0, sy, cy, L, H, W, base, cx: r.x, cz: r.z, yaw: r.yaw, mesh });
  }

  setEnabled(v) { this.enabled = v; this.group.visible = v; }

  /**
   * 地面高度修正（物理每帧调用，零分配）
   * @param {number} h 原地形高度
   * @param {{x,y,z}} n 地面法线（会被就地改写）
   */
  groundAt(x, z, h, n) {
    if (!this.enabled) return h;
    for (let i = 0; i < this.ramps.length; i++) {
      const r = this.ramps[i];
      const dx = x - r.x0, dz = z - r.z0;
      const u = dx * r.sy + dz * r.cy;
      if (u < 0 || u > r.L) continue;
      const v = dx * r.cy - dz * r.sy;
      if (Math.abs(v) > r.W / 2) continue;
      const t = u / r.L;
      const s = r.base + profile(t) * r.H;
      if (s > h) {
        h = s;
        const slope = profileD(t) * r.H / r.L;
        const nx = -slope * r.sy, nz = -slope * r.cy;
        const len = Math.hypot(nx, 1, nz);
        n.x = nx / len; n.y = 1 / len; n.z = nz / len;
      }
    }
    return h;
  }

  reset() {
    this.score = 0; this.combo = 0; this.comboTimer = 0; this.bank = 0; this.best = 0; this.tricks = 0;
  }

  get multiplier() { return Math.min(5, 1 + Math.max(0, this.combo - 1) * 0.5); }

  /** 评判一次落地。返回 { clean, crash, points, name } */
  judge(info) {
    const halves = Math.round(Math.abs(info.spin) / Math.PI);
    const flips = Math.floor(Math.abs(info.flip) / (TAU * 0.85));
    const yawErr = Math.abs(info.yawErr);
    const pitchErr = Math.abs(info.pitchErr);
    const small = info.airTime < 0.35 && halves === 0;
    const clean = yawErr < 0.62 && pitchErr < 0.55 && Math.abs(info.lean) < 0.42;

    const names = [];
    if (flips) names.push(info.flip > 0 ? `后空翻 ×${flips}` : `前空翻 ×${flips}`);
    if (halves) names.push(`转体 ${halves * 180}°`);
    if (info.bell) names.push(info.bell > 1 ? `空中铃 ×${info.bell}` : '空中铃');
    if (!names.length) names.push(info.airTime > 1.0 ? '大腾空' : '腾空');

    let pts = Math.round(info.airTime * 140 + halves * 160 + flips * 450 + Math.min(2, info.bell) * 120 + Math.max(0, info.height - 1) * 30);
    if (small) return { clean: true, crash: false, points: 0, name: '', small: true };
    if (!clean) {
      return { clean: false, crash: info.airTime > 0.3 || halves > 0, points: 0, name: names.join(' + ') };
    }
    const perfect = yawErr < 0.18 && pitchErr < 0.2;
    if (perfect) { pts = Math.round(pts * 1.25); names.push('完美落地'); }
    return { clean: true, crash: false, points: pts, name: names.join(' + '), perfect };
  }

  /** 把一次特技计入连击 */
  addTrick(res) {
    if (!res.clean) {
      const lost = this.bank;
      this.combo = 0; this.comboTimer = 0; this.bank = 0;
      return { lost };
    }
    if (res.small || res.points <= 0) return null;
    this.combo++;
    this.tricks++;
    this.comboTimer = this.comboWindow;
    const gained = Math.round(res.points * this.multiplier);
    this.bank += gained;
    return { gained, multiplier: this.multiplier };
  }

  /** 每帧：连击槽衰减，归零时把累积分数结算进总分 */
  update(dt, airborne) {
    if (this.comboTimer > 0 && !airborne) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) return this.cashOut();
    }
    return 0;
  }

  cashOut() {
    const v = this.bank;
    this.score += v;
    this.best = Math.max(this.best, this.combo);
    this.bank = 0; this.combo = 0; this.comboTimer = 0;
    return v;
  }

  /** 最近的跳台（罗盘用） */
  nearestRamp(px, pz) {
    let best = null, bd = Infinity;
    for (const r of this.ramps) {
      const d = Math.hypot(r.x0 - px, r.z0 - pz);
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }

  dispose() {
    this.geos.forEach((g) => g.dispose());
    this.group.removeFromParent();
  }
}
