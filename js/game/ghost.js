/**
 * ghost.js —— 幽灵车：最佳圈的半透明回放
 *
 * 不克隆真正的鹈鹕（3000 片羽毛 + IK 太贵），而是用十几个基本体
 * 拼一个「剪影」：两个轮子、车架、身体、长脖子、头和大嘴。
 * 材质是菲涅尔边缘光：正对镜头的面几乎透明，轮廓发亮 —— 一眼就是「幽灵」。
 *
 * 录制：每 0.1 秒采样一次 [x, y, z, yaw, lean, airPitch]，
 * 存档时四舍五入到厘米 / 千分之一弧度，一圈约 600 个样本、十几 KB。
 */
import * as THREE from 'three';
import { mergeColored, trs } from './mesh.js';
import { terrainNormal } from '../util/noise.js';

export const GHOST_RATE = 10;      // 采样频率 Hz
const STRIDE = 6;

const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _ql = new THREE.Quaternion();
const _n = { x: 0, y: 1, z: 0 };

export class GhostRider {
  constructor(scene) {
    const parts = [];
    const wheel = (z) => parts.push([new THREE.TorusGeometry(0.33, 0.035, 6, 24), 0xffffff, trs(0, 0.345, z, 0, Math.PI / 2, 0)]);
    wheel(0.54); wheel(-0.55);
    const bar = (x1, y1, z1, x2, y2, z2, r = 0.022) => {
      const len = Math.hypot(x2 - x1, y2 - y1, z2 - z1);
      const g = new THREE.CylinderGeometry(r, r, len, 5);
      const rx = Math.atan2(Math.hypot(x2 - x1, z2 - z1), y2 - y1);
      const ry = Math.atan2(x2 - x1, z2 - z1);
      parts.push([g, 0xffffff, trs((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2, rx, ry, 0)]);
    };
    bar(0, 0.345, -0.55, 0, 0.36, 0.0);   // 链撑
    bar(0, 0.36, 0.0, 0, 0.82, -0.12);    // 立管
    bar(0, 0.36, 0.0, 0, 0.82, 0.42);     // 下管
    bar(0, 0.82, -0.12, 0, 0.82, 0.42);   // 上管
    bar(0, 0.82, 0.42, 0, 0.345, 0.54);   // 前叉
    bar(0, 0.345, -0.55, 0, 0.82, -0.12); // 后上叉
    bar(-0.25, 1.0, 0.45, 0.25, 1.0, 0.45, 0.02); // 车把
    bar(0, 0.82, 0.42, 0, 1.0, 0.45);
    // 鹈鹕
    const body = new THREE.SphereGeometry(0.3, 12, 10);
    parts.push([body, 0xffffff, trs(0, 1.2, -0.05, 0.4, 0, 0, 0.85, 0.95, 1.25)]);
    bar(0, 1.38, 0.12, 0, 1.75, 0.18, 0.06);
    parts.push([new THREE.SphereGeometry(0.11, 10, 8), 0xffffff, trs(0, 1.8, 0.2)]);
    const beak = new THREE.ConeGeometry(0.055, 0.5, 6);
    parts.push([beak, 0xffffff, trs(0, 1.74, 0.46, Math.PI / 2 + 0.35, 0, 0)]);
    parts.push([new THREE.SphereGeometry(0.08, 8, 6), 0xffffff, trs(0, 1.63, 0.38, 0, 0, 0, 0.8, 0.9, 2.0)]);
    bar(0.12, 1.15, 0.05, 0.22, 1.0, 0.42, 0.04);   // 翅膀搭车把
    bar(-0.12, 1.15, 0.05, -0.22, 1.0, 0.42, 0.04);
    bar(0.1, 1.0, -0.05, 0.1, 0.45, 0.12, 0.035);    // 腿
    bar(-0.1, 1.0, -0.05, -0.1, 0.45, -0.1, 0.035);

    this.geometry = mergeColored(parts);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0.45, 0.95, 1.0) }, uOpacity: { value: 0.0 } },
      vertexShader: /* glsl */`
        varying vec3 vN; varying vec3 vV;
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vV = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uOpacity;
        varying vec3 vN; varying vec3 vV;
        void main(){
          float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
          rim = pow(rim, 1.6);
          float a = (0.34 + rim * 0.66) * uOpacity;
          gl_FragColor = vec4(uColor * (0.9 + rim * 2.6), a);
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    this.samples = null;   // Float32Array
    this.count = 0;
    this.position = this.mesh.position;
    this._opacity = 0;
  }

  /** 载入一条录像（数组或 Float32Array） */
  setRecording(arr) {
    if (!arr || arr.length < STRIDE * 2) { this.samples = null; this.count = 0; return; }
    this.samples = arr instanceof Float32Array ? arr : Float32Array.from(arr);
    this.count = Math.floor(this.samples.length / STRIDE);
  }

  get duration() { return this.count / GHOST_RATE; }

  /** 在 t 秒处摆好幽灵；t 超出录像则淡出 */
  update(dt, t, active) {
    const want = active && this.samples && t >= 0 && t < this.duration ? 1 : 0;
    this._opacity += (want - this._opacity) * Math.min(1, dt * 4);
    this.material.uniforms.uOpacity.value = this._opacity;
    this.mesh.visible = this._opacity > 0.02 && !!this.samples;
    if (!this.mesh.visible) return;

    const f = THREE.MathUtils.clamp(t * GHOST_RATE, 0, this.count - 1.001);
    const i = Math.floor(f), k = f - i;
    const S = this.samples, a = i * STRIDE, b = (i + 1) * STRIDE;
    const lerp = (o) => S[a + o] + (S[b + o] - S[a + o]) * k;
    let dy = S[b + 3] - S[a + 3];
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const x = lerp(0), y = lerp(1), z = lerp(2);
    const yaw = S[a + 3] + dy * k, lean = lerp(4), ap = lerp(5);

    terrainNormal(x, z, 0.4, _n);
    _up.set(_n.x, _n.y, _n.z);
    _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    _fwd.addScaledVector(_up, -_fwd.dot(_up)).normalize();
    _right.crossVectors(_up, _fwd).normalize();
    _m.makeBasis(_right, _up, _fwd);
    _q.setFromRotationMatrix(_m);
    _ql.setFromAxisAngle(_fwd, lean);
    _q.premultiply(_ql);
    if (ap) { _ql.setFromAxisAngle(_right, -ap); _q.premultiply(_ql); }
    this.mesh.position.set(x, y, z);
    this.mesh.quaternion.copy(_q);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}

/** 录制器：预分配一块足够长的缓冲（10 分钟），避免录制中途扩容 */
export class GhostRecorder {
  constructor(maxSeconds = 600) {
    this.buf = new Float32Array(maxSeconds * GHOST_RATE * STRIDE);
    this.n = 0;
    this._acc = 0;
  }
  reset() { this.n = 0; this._acc = 1 / GHOST_RATE; }
  /** 每帧调用；按固定频率采样 */
  tick(dt, p) {
    this._acc += dt;
    while (this._acc >= 1 / GHOST_RATE) {
      this._acc -= 1 / GHOST_RATE;
      if ((this.n + 1) * STRIDE > this.buf.length) return;
      const o = this.n * STRIDE;
      this.buf[o] = p.pos.x; this.buf[o + 1] = p.pos.y; this.buf[o + 2] = p.pos.z;
      this.buf[o + 3] = p.yaw; this.buf[o + 4] = p.lean; this.buf[o + 5] = p.airPitch || 0;
      this.n++;
    }
  }
  /** 导出为紧凑的普通数组（存 localStorage） */
  export() {
    const out = new Array(this.n * STRIDE);
    for (let i = 0; i < out.length; i++) {
      const v = this.buf[i];
      out[i] = (i % STRIDE) < 3 ? Math.round(v * 100) / 100 : Math.round(v * 1000) / 1000;
    }
    return out;
  }
}
