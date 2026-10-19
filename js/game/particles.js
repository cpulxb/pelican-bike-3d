/**
 * particles.js —— 通用粒子池
 *
 * 一个 THREE.Points + 自研着色器，固定容量的环形缓冲。
 * 水花、捕鱼的金光、送达的彩屑、萤火虫拾取的光点都走这一个 draw call。
 *
 * 不用贴图：圆形软边在片元着色器里用 gl_PointCoord 算出来。
 * 每帧只在 CPU 上积分「活着」的粒子，不分配任何对象。
 */
import * as THREE from 'three';

const VERT = /* glsl */`
  attribute vec4 aColor;     // rgb + 强度
  attribute float aSize;
  attribute float aLife;     // 1 → 0
  varying vec4 vColor;
  varying float vLife;
  uniform float uPixelRatio;
  void main() {
    vColor = aColor;
    vLife = aLife;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float s = aSize * (0.35 + 0.65 * aLife);
    gl_PointSize = aLife <= 0.0 ? 0.0 : clamp(s * uPixelRatio * 300.0 / max(0.1, -mv.z), 0.0, 96.0);
  }
`;
const FRAG = /* glsl */`
  varying vec4 vColor;
  varying float vLife;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.0, d);
    float a = core * core * vLife;
    gl_FragColor = vec4(vColor.rgb * vColor.a * a, a);
  }
`;

export class Particles {
  constructor(scene, capacity = 1200) {
    this.cap = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 4);
    this.size = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.decay = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.head = 0;
    this.alive = 0;

    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aLife = new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aColor', this.aCol);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aLife', this.aLife);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: Math.min(2, window.devicePixelRatio || 1) } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.geometry = geo;
    scene.add(this.points);
  }

  /**
   * 发射一簇粒子
   * @param {object} o { x,y,z, count, speed, up, spread, color:[r,g,b], intensity, size, life, gravity, drag }
   */
  burst(o) {
    const n = o.count ?? 20;
    const sp = o.speed ?? 3;
    const up = o.up ?? 2;
    const spread = o.spread ?? 1;
    const c = o.color ?? [1, 0.8, 0.4];
    const inten = o.intensity ?? 2.5;
    for (let k = 0; k < n; k++) {
      const i = this.head;
      this.head = (this.head + 1) % this.cap;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spread;
      this.pos[i * 3] = o.x + Math.cos(a) * r * 0.25;
      this.pos[i * 3 + 1] = o.y;
      this.pos[i * 3 + 2] = o.z + Math.sin(a) * r * 0.25;
      const s = sp * (0.4 + Math.random() * 0.6);
      this.vel[i * 3] = Math.cos(a) * s * r + (o.vx ?? 0);
      this.vel[i * 3 + 1] = up * (0.5 + Math.random() * 0.8);
      this.vel[i * 3 + 2] = Math.sin(a) * s * r + (o.vz ?? 0);
      const jitter = 0.85 + Math.random() * 0.3;
      this.col[i * 4] = c[0] * jitter;
      this.col[i * 4 + 1] = c[1] * jitter;
      this.col[i * 4 + 2] = c[2] * jitter;
      this.col[i * 4 + 3] = inten;
      this.size[i] = (o.size ?? 0.18) * (0.6 + Math.random() * 0.8);
      this.life[i] = 1;
      this.decay[i] = 1 / ((o.life ?? 0.9) * (0.7 + Math.random() * 0.6));
      this.grav[i] = o.gravity ?? 9;
      this.drag[i] = o.drag ?? 0.6;
    }
    this._dirty = true;
  }

  update(dt) {
    let any = false;
    const P = this.pos, V = this.vel;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      const l = this.life[i] - this.decay[i] * dt;
      this.life[i] = l > 0 ? l : 0;
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      V[i * 3] *= dr; V[i * 3 + 2] *= dr;
      V[i * 3 + 1] = V[i * 3 + 1] * dr - this.grav[i] * dt;
      P[i * 3] += V[i * 3] * dt;
      P[i * 3 + 1] += V[i * 3 + 1] * dt;
      P[i * 3 + 2] += V[i * 3 + 2] * dt;
    }
    if (any || this._dirty) {
      this.aPos.needsUpdate = true;
      this.aLife.needsUpdate = true;
      if (this._dirty) { this.aCol.needsUpdate = true; this.aSize.needsUpdate = true; }
      this._dirty = false;
    }
  }

  clear() { this.life.fill(0); this._dirty = true; this.aLife.needsUpdate = true; }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.points.removeFromParent();
  }
}
