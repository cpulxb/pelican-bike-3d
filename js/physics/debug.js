/**
 * debug.js —— 碰撞体线框（F3 开关）
 *
 * Rapier 自带 debugRender()，但整张 640×640 的高度场会吐出上百万条线段，
 * 所以分三层画：
 *   静态碰撞体（岩石凸包、灯塔、鸟巢、跳台、树干）开启时生成一次；
 *   动态刚体（石块、浮体、自行车）每帧重画；
 *   地形只画玩家周围 ±16 m 的一小块 —— 直接读高度场碰撞体自己的高度数组，
 *   与可见地形重合就说明对齐无误。另画两根悬挂射线（绿 = 着地，红 = 悬空）。
 */
import * as THREE from 'three';

const PATCH = 16;

export class PhysicsDebug {
  constructor(scene, pw, bike) {
    this.pw = pw;
    this.bike = bike;
    this.enabled = false;
    const mk = (color, opacity = 1) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
      const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: true, toneMapped: false });
      const l = new THREE.LineSegments(g, m);
      l.frustumCulled = false;
      l.visible = false;
      l.renderOrder = 10;
      scene.add(l);
      return l;
    };
    this.staticLines = mk(0xffd34d, 0.9);
    this.dynLines = mk(0x4dffd2, 1);
    this.terrainLines = mk(0xff6bd5, 0.55);
    this.rayLines = mk(0x66ff66, 1);
    // 地形补丁与射线是固定大小的缓冲：预分配，每帧原地改写
    const cells = PATCH * 2;
    this._tBuf = new Float32Array((cells + 1) * cells * 2 * 2 * 3);
    this.terrainLines.geometry.setAttribute('position', new THREE.BufferAttribute(this._tBuf, 3).setUsage(THREE.DynamicDrawUsage));
    this._rBuf = new Float32Array(4 * 3);
    this.rayLines.geometry.setAttribute('position', new THREE.BufferAttribute(this._rBuf, 3).setUsage(THREE.DynamicDrawUsage));
  }

  setEnabled(on) {
    this.enabled = on;
    for (const l of [this.staticLines, this.dynLines, this.terrainLines, this.rayLines]) l.visible = on;
    if (on) this._buildStatic();
  }

  _set(line, verts) {
    line.geometry.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    line.geometry.setDrawRange(0, verts.length / 3);
  }

  _buildStatic() {
    const terrain = this.pw.terrain;
    const buf = this.pw.world.debugRender(undefined, (c) => {
      if (c.handle === terrain.handle) return false;
      const b = c.parent();
      return !b || b.isFixed();
    });
    this._set(this.staticLines, buf.vertices.slice());
  }

  update(center) {
    if (!this.enabled) return;
    const buf = this.pw.world.debugRender(undefined, (c) => { const b = c.parent(); return !!b && !b.isFixed(); });
    this._set(this.dynLines, buf.vertices.slice());

    // ---- 地形补丁：高度场的真实数据 ----
    const { heights, n, half, step } = this.pw.hf;
    const ci = Math.round((center.x + half) / step), cj = Math.round((center.z + half) / step);
    const H = (i, j) => heights[Math.max(0, Math.min(n, i)) * (n + 1) + Math.max(0, Math.min(n, j))] + 0.02;
    const X = (i) => -half + i * step;
    let o = 0;
    const T = this._tBuf;
    for (let a = -PATCH; a <= PATCH; a++) {
      for (let b = -PATCH; b < PATCH; b++) {
        // 沿 z 的线
        const i = ci + a, j = cj + b;
        T[o++] = X(i); T[o++] = H(i, j); T[o++] = X(j);
        T[o++] = X(i); T[o++] = H(i, j + 1); T[o++] = X(j + 1);
        // 沿 x 的线
        const i2 = ci + b, j2 = cj + a;
        T[o++] = X(i2); T[o++] = H(i2, j2); T[o++] = X(j2);
        T[o++] = X(i2 + 1); T[o++] = H(i2 + 1, j2); T[o++] = X(j2);
      }
    }
    this.terrainLines.geometry.attributes.position.needsUpdate = true;

    // ---- 悬挂射线 ----
    const bk = this.bike;
    const R = this._rBuf;
    const yaw = bk._yaw || 0;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    let k = 0, anyHit = false;
    for (const w of bk.wheel) {
      const x = bk.pos.x + fx * w.z, z = bk.pos.z + fz * w.z, top = bk.pos.y + bk.mountH;
      R[k++] = x; R[k++] = top; R[k++] = z;
      R[k++] = x; R[k++] = w.gy; R[k++] = z;
      anyHit = anyHit || w.hit;
    }
    this.rayLines.material.color.setHex(anyHit ? 0x66ff66 : 0xff5555);
    this.rayLines.geometry.attributes.position.needsUpdate = true;
  }
}
