/**
 * photo.js —— 拍照任务 + 相册
 *
 * 按 P 拍照时，用「这一帧的相机」去检查每个未完成任务：
 *   1. 目标在视锥内（留一点边距，贴着画面边缘不算）
 *   2. 目标没被地形挡住（沿视线采样高度场）
 *   3. 附加条件：时刻（sky.time）、距离、数量、玩家状态……
 * 完成的照片缩成 320×180 的 JPEG 存进 localStorage 相册（有总量上限）。
 */
import * as THREE from 'three';
import { load, save } from './storage.js';
import { terrainHeight } from '../util/noise.js';

const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _ndc = new THREE.Vector3();
const _dir = new THREE.Vector3();

const ALBUM_MAX = 24;
const THUMB_W = 320, THUMB_H = 180;

export const MISSIONS = [
  { id: 'lighthouse_sunset', title: '日落灯塔', desc: '日落时分（约 18:00–20:00），把灯塔拍进画面', reward: 300 },
  { id: 'flock_overhead', title: '头顶的鸟群', desc: '抬头拍下飞过头顶的鸟群（至少 5 只）', reward: 250 },
  { id: 'fish_leap', title: '跃出水面', desc: '拍到一条正跃出水面的发光鱼', reward: 250 },
  { id: 'nest_chicks', title: '嗷嗷待哺', desc: '在 30 米内拍下鸟巢里的雏鸟', reward: 150 },
  { id: 'airborne', title: '腾空瞬间', desc: '人在空中时按下快门', reward: 200 },
  { id: 'fireflies', title: '萤火之夜', desc: '夜里拍到至少 4 只萤火虫', reward: 300 },
  { id: 'gulls', title: '海鸥来袭', desc: '拍到正在追你的海鸥', reward: 250 },
  { id: 'night_lighthouse', title: '守夜人', desc: '入夜后拍下亮着光束的灯塔', reward: 300 },
  { id: 'ghost', title: '与幽灵同框', desc: '计时赛中把幽灵车拍进画面', reward: 200 },
];

export class PhotoMissions {
  constructor() {
    this.done = new Set(load('missions', []));
    this.album = load('album', []);
    this.thumb = document.createElement('canvas');
    this.thumb.width = THUMB_W;
    this.thumb.height = THUMB_H;
    this.tctx = this.thumb.getContext('2d');
    this._tmp = [];
  }

  /** 当前展示的任务卡（最多 n 张未完成的） */
  active(n = 3) {
    const out = [];
    for (const m of MISSIONS) { if (!this.done.has(m.id)) out.push(m); if (out.length >= n) break; }
    return out;
  }

  get progress() { return { done: this.done.size, total: MISSIONS.length }; }

  /* ---------------- 可见性工具 ---------------- */
  _prepare(camera) {
    camera.updateMatrixWorld();
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    this.cam = camera;
  }

  /** 在画面内（NDC 留 margin 边距）且在相机前方、距离不超过 maxD */
  inView(x, y, z, margin = 0.92, maxD = 400) {
    _v.set(x, y, z);
    const d = _v.distanceTo(this.cam.position);
    if (d > maxD) return false;
    _ndc.copy(_v).project(this.cam);
    return _ndc.z < 1 && Math.abs(_ndc.x) < margin && Math.abs(_ndc.y) < margin;
  }

  /** 视线有没有被地形挡住 */
  clear(x, y, z) {
    const c = this.cam.position;
    const steps = 18;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const px = c.x + (x - c.x) * t, py = c.y + (y - c.y) * t, pz = c.z + (z - c.z) * t;
      if (terrainHeight(px, pz) > py + 0.25) return false;
    }
    return true;
  }

  visible(x, y, z, margin, maxD) { return this.inView(x, y, z, margin, maxD) && this.clear(x, y, z); }

  /**
   * 对当前帧检查所有未完成任务
   * @param {object} c { camera, skyTime, night, landmarks, env, fish, fireflies, gulls, ghost, player, mode }
   * @returns {Array} 本次完成的任务
   */
  check(c) {
    this._prepare(c.camera);
    const res = [];
    const lh = c.landmarks?.lighthouse;
    const t = c.skyTime;
    for (const m of MISSIONS) {
      if (this.done.has(m.id)) continue;
      let ok = false;
      switch (m.id) {
        case 'lighthouse_sunset':
          ok = lh && t > 0.75 && t < 0.835 && (this.visible(lh.top.x, lh.top.y - 2, lh.top.z, 0.95, 320) || this.visible(lh.base.x, lh.base.y + 5, lh.base.z, 0.95, 320));
          break;
        case 'night_lighthouse':
          ok = lh && c.night > 0.55 && this.visible(lh.top.x, lh.top.y, lh.top.z, 0.95, 420);
          break;
        case 'flock_overhead': {
          const flock = c.env?.flock;
          if (!flock) break;
          const off = flock.geometry.getAttribute('aOffset');
          if (!off) break;
          c.env.flockRoot.updateMatrixWorld();
          const mw = c.env.flockRoot.matrixWorld;
          c.camera.getWorldDirection(_dir);
          if (_dir.y < 0.12) break;    // 必须是抬头拍
          let n = 0;
          for (let i = 0; i < off.count && n < 5; i++) {
            _v.set(off.getX(i), off.getY(i), off.getZ(i)).applyMatrix4(mw);
            if (_v.y < c.camera.position.y + 8) continue;
            if (this.inView(_v.x, _v.y, _v.z, 0.98, 260)) n++;
          }
          ok = n >= 5;
          break;
        }
        case 'fish_leap': {
          const list = c.fish ? c.fish.visibleFish(this._tmp) : [];
          ok = list.some((p) => this.visible(p.x, p.y, p.z, 0.9, 45));
          break;
        }
        case 'nest_chicks':
          ok = c.landmarks?.zones.some((z) => z.nestTop && this.visible(z.nestTop.x, z.nestTop.y, z.nestTop.z, 0.85, 30));
          break;
        case 'airborne':
          ok = c.player.airborne && c.player.pos.y - terrainHeight(c.player.pos.x, c.player.pos.z) > 0.6;
          break;
        case 'fireflies': {
          if (!c.fireflies || c.night < 0.4) break;
          let n = 0;
          c.fireflies.forEachAlive((x, y, z) => { if (n < 4 && this.inView(x, y, z, 0.95, 40)) n++; });
          ok = n >= 4;
          break;
        }
        case 'gulls':
          ok = c.gulls && c.gulls.active && c.gulls.list.some((g) => g.state !== 'off' && g.state !== 'flee' && this.inView(g.pos.x, g.pos.y, g.pos.z, 0.95, 40));
          break;
        case 'ghost':
          ok = c.ghost && c.ghost.mesh.visible && this.visible(c.ghost.position.x, c.ghost.position.y + 1, c.ghost.position.z, 0.92, 60);
          break;
        default: break;
      }
      if (ok) { this.done.add(m.id); res.push(m); }
    }
    if (res.length) save('missions', [...this.done]);
    return res;
  }

  /** 从刚渲染完的画布截一张缩略图（必须在 render 之后同步调用） */
  snapshot(canvas) {
    const cw = canvas.width, ch = canvas.height;
    // 居中裁成 16:9
    const ar = THUMB_W / THUMB_H;
    let sw = cw, sh = cw / ar;
    if (sh > ch) { sh = ch; sw = ch * ar; }
    const sx = (cw - sw) / 2, sy = (ch - sh) / 2;
    try {
      this.tctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, THUMB_W, THUMB_H);
      return this.thumb.toDataURL('image/jpeg', 0.72);
    } catch {
      return null;
    }
  }

  /** 存进相册；超量或配额不足时丢弃最早的照片 */
  addToAlbum(img, meta) {
    if (!img) return false;
    this.album.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), img, ...meta, at: Date.now() });
    if (this.album.length > ALBUM_MAX) this.album.length = ALBUM_MAX;
    while (this.album.length && !save('album', this.album)) this.album.pop();
    return true;
  }

  removeFromAlbum(id) {
    this.album = this.album.filter((p) => p.id !== id);
    save('album', this.album);
  }

  resetMissions() { this.done.clear(); save('missions', []); }
}
