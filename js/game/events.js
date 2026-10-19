/**
 * events.js —— 世界事件：海鸥抢鱼 / 夜骑车灯与萤火虫 / 阵风
 *
 *   海鸥：喉囊满（或接近满）时，几只海鸥从远处飞来在头顶盘旋，
 *         然后轮流俯冲来叼鱼。按 B 摇铃能把它们全部吓跑。
 *   夜骑：太阳落下后车灯自动打开 —— 一盏真正的 SpotLight 照亮车与鸟，
 *         地形着色器里再叠一束同参数的「假」聚光（自研着色器不吃 three 的灯），
 *         外加一个淡淡的体积光锥。萤火虫在玩家周围的草地上浮游，可以收集。
 *   阵风：不定时从某个方向吹来，让车头轻微偏转，草也被压弯。
 */
import * as THREE from 'three';
import { mergeColored, trs } from './mesh.js';
import { terrainHeight, WATER_LEVEL } from '../util/noise.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const TAU = Math.PI * 2;

/* ================================================================== *
 * 海鸥
 * ================================================================== */
function makeGull() {
  const g = new THREE.Group();
  const body = mergeColored([
    [new THREE.SphereGeometry(0.16, 8, 6), 0xf4f1ea, trs(0, 0, 0, 0, 0, 0, 0.8, 0.75, 2.0)],
    [new THREE.SphereGeometry(0.1, 8, 6), 0xf4f1ea, trs(0, 0.07, 0.3)],
    [new THREE.ConeGeometry(0.03, 0.14, 5), 0xf2b134, trs(0, 0.05, 0.44, Math.PI / 2)],
    [new THREE.ConeGeometry(0.1, 0.22, 4), 0x9aa3a8, trs(0, 0, -0.36, -Math.PI / 2, 0, 0, 1, 1, 0.3)],
  ]);
  const wingGeo = mergeColored([
    [new THREE.BoxGeometry(0.7, 0.02, 0.24), (x) => (Math.abs(x) > 0.5 ? 0x2b2e31 : 0xc9ced2), trs(0.35, 0, 0)],
  ]);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, flatShading: true });
  const b = new THREE.Mesh(body, mat);
  const wl = new THREE.Group(), wr = new THREE.Group();
  const ml = new THREE.Mesh(wingGeo, mat), mr = new THREE.Mesh(wingGeo, mat);
  wl.add(ml); wr.add(mr); wr.scale.x = -1;
  wl.position.set(0.06, 0.04, 0.02); wr.position.set(-0.06, 0.04, 0.02);
  // 嘴里叼着的鱼（偷到才显示）
  const fish = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.75, 0.3).multiplyScalar(2) }));
  fish.scale.set(0.6, 0.6, 2);
  fish.position.set(0, 0.03, 0.5);
  fish.rotation.y = Math.PI / 2;
  fish.visible = false;
  g.add(b, wl, wr, fish);
  g.scale.setScalar(1.6);
  return { group: g, wl, wr, fish, geos: [body, wingGeo, fish.geometry], mats: [mat, fish.material] };
}

class Gulls {
  constructor(scene, audio) {
    this.audio = audio;
    this.list = [];
    this.group = new THREE.Group();
    scene.add(this.group);
    for (let i = 0; i < 4; i++) {
      const g = makeGull();
      g.group.visible = false;
      this.group.add(g.group);
      this.list.push({ ...g, state: 'off', t: 0, phase: i * 1.7, pos: new THREE.Vector3(), vel: new THREE.Vector3(), flap: Math.random() * 6 });
    }
    this.active = false;
    this.cooldown = 8;
    this._diveTimer = 0;
  }

  start(player) {
    if (this.active) return false;
    this.active = true;
    this._diveTimer = 2.6;
    const a0 = Math.random() * TAU;
    let n = 0;
    for (const g of this.list) {
      if (n >= 3) break;
      const a = a0 + n * 0.5;
      g.pos.set(player.pos.x + Math.sin(a) * 60, player.pos.y + 22 + n * 2, player.pos.z + Math.cos(a) * 60);
      g.state = 'approach';
      g.t = 0;
      g.fish.visible = false;
      g.group.visible = true;
      n++;
    }
    this.audio?.gullCry?.();
    return true;
  }

  scare() {
    let any = false;
    for (const g of this.list) {
      if (g.state === 'off' || g.state === 'flee') continue;
      g.state = 'flee'; g.t = 0; any = true;
    }
    if (any) this.audio?.gullCry?.();
    return any;
  }

  /** 头顶有没有海鸥（铃声驱赶的判定用） */
  near(player, r = 20) {
    return this.list.some((g) => (g.state === 'circle' || g.state === 'dive' || g.state === 'approach') && g.pos.distanceTo(player.pos) < r);
  }

  /**
   * @returns {number} 本帧被偷走的鱼数
   */
  update(dt, player, beakTip, carrying) {
    let stolen = 0;
    if (this.cooldown > 0) this.cooldown -= dt;
    if (!this.active) return 0;

    let alive = 0;
    this._diveTimer -= dt;
    for (const g of this.list) {
      if (g.state === 'off') continue;
      alive++;
      g.t += dt;
      g.flap += dt * (g.state === 'dive' ? 16 : 9);
      const flapA = Math.sin(g.flap) * (g.state === 'dive' ? 0.25 : 0.7);
      g.wl.rotation.z = flapA; g.wr.rotation.z = -flapA;

      // 目标点
      if (g.state === 'approach' || g.state === 'circle') {
        g.phase += dt * 1.1;
        _v.set(player.pos.x + Math.sin(g.phase) * 7, player.pos.y + 6.5 + Math.sin(g.phase * 2) * 0.8, player.pos.z + Math.cos(g.phase) * 7);
        if (g.state === 'approach' && g.pos.distanceTo(_v) < 6) g.state = 'circle';
        if (g.state === 'circle' && this._diveTimer <= 0 && carrying > 0) {
          g.state = 'dive'; g.t = 0;
          this._diveTimer = 3.2 + Math.random() * 1.5;
          this.audio?.gullCry?.();
        }
      } else if (g.state === 'dive') {
        _v.copy(beakTip);
        if (g.pos.distanceTo(beakTip) < 1.1) {
          if (carrying - stolen > 0) {
            stolen++;
            g.fish.visible = true;
          }
          g.state = 'flee'; g.t = 0;
        } else if (g.t > 4) { g.state = 'circle'; }
      } else if (g.state === 'flee') {
        _v.copy(g.pos).sub(player.pos).setY(0).normalize().multiplyScalar(80).add(g.pos);
        _v.y = g.pos.y + 30;
        if (g.t > 5) { g.state = 'off'; g.group.visible = false; continue; }
      }

      // 转向 + 移动：速度朝目标插值，看起来像在飞而不是瞬移
      const spd = g.state === 'dive' ? 19 : g.state === 'flee' ? 16 : 13 + player.speed * 0.6;
      _v2.copy(_v).sub(g.pos);
      const d = _v2.length();
      if (d > 1e-3) _v2.multiplyScalar(Math.min(spd, d * 3) / d);
      g.vel.lerp(_v2, Math.min(1, dt * (g.state === 'dive' ? 4 : 2.2)));
      g.pos.addScaledVector(g.vel, dt);
      const gh = Math.max(terrainHeight(g.pos.x, g.pos.z), WATER_LEVEL) + 0.8;
      if (g.pos.y < gh) g.pos.y = gh;
      g.group.position.copy(g.pos);
      if (g.vel.lengthSq() > 0.01) {
        _v2.copy(g.pos).add(g.vel);
        g.group.lookAt(_v2);
        g.group.rotateZ(-Math.sin(g.phase) * 0.35);
      }
    }
    if (alive === 0) { this.active = false; this.cooldown = 14; }
    return stolen;
  }

  stop() { for (const g of this.list) { g.state = 'off'; g.group.visible = false; } this.active = false; }

  dispose() {
    for (const g of this.list) { g.geos.forEach((x) => x.dispose()); g.mats.forEach((m) => m.dispose()); }
    this.group.removeFromParent();
  }
}

/* ================================================================== *
 * 萤火虫
 * ================================================================== */
const FF_VERT = /* glsl */`
  attribute float aPhase;
  attribute float aAlive;
  uniform float uTime;
  uniform float uNight;
  uniform float uPixelRatio;
  varying float vA;
  void main() {
    vec3 p = position;
    p.x += sin(uTime * 0.7 + aPhase * 3.1) * 0.6;
    p.y += sin(uTime * 1.1 + aPhase * 1.7) * 0.35;
    p.z += cos(uTime * 0.6 + aPhase * 2.3) * 0.6;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float blink = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * 2.3 + aPhase * 6.0), 3.0);
    vA = blink * uNight * aAlive;
    gl_PointSize = vA <= 0.001 ? 0.0 : clamp(uPixelRatio * 90.0 / max(0.5, -mv.z), 2.0, 40.0);
  }
`;
const FF_FRAG = /* glsl */`
  varying float vA;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float core = exp(-d * d * 40.0) + exp(-d * d * 7.0) * 0.35;
    gl_FragColor = vec4(vec3(0.75, 1.0, 0.35) * core * vA * 3.0, core * vA);
  }
`;

class Fireflies {
  constructor(scene, count = 56) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.alive = new Float32Array(count);
    this.respawn = new Float32Array(count);
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) phase[i] = Math.random() * 10;
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aAlive = new THREE.BufferAttribute(this.alive, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aAlive', this.aAlive);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uNight: { value: 0 }, uPixelRatio: { value: Math.min(2, window.devicePixelRatio || 1) } },
      vertexShader: FF_VERT, fragmentShader: FF_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.geo = geo;
    scene.add(this.points);
    this._placed = false;
    this.collectEnabled = false;
  }

  _place(i, px, pz) {
    for (let k = 0; k < 10; k++) {
      const a = Math.random() * TAU, r = 18 + Math.random() * 55;
      const x = px + Math.sin(a) * r, z = pz + Math.cos(a) * r;
      const h = terrainHeight(x, z);
      if (h < WATER_LEVEL + 0.4) continue;
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = h + 0.7 + Math.random() * 1.6; this.pos[i * 3 + 2] = z;
      this.alive[i] = 1;
      return;
    }
    this.alive[i] = 0;
    this.respawn[i] = 1;
  }

  /** @returns {Array<{x,y,z}>|null} 本帧收集到的萤火虫位置（复用数组） */
  update(dt, t, night, player, out) {
    this.mat.uniforms.uTime.value = t;
    this.mat.uniforms.uNight.value = night;
    this.points.visible = night > 0.02;
    out.length = 0;
    if (night < 0.02) return out;
    const px = player.pos.x, pz = player.pos.z;
    if (!this._placed) { for (let i = 0; i < this.count; i++) this._place(i, px, pz); this._placed = true; }
    let dirty = false;
    for (let i = 0; i < this.count; i++) {
      if (this.alive[i] < 1) {
        this.respawn[i] -= dt;
        if (this.respawn[i] <= 0) { this._place(i, px, pz); dirty = true; }
        continue;
      }
      const dx = this.pos[i * 3] - px, dz = this.pos[i * 3 + 2] - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > 95 * 95) { this._place(i, px, pz); dirty = true; continue; }
      if (this.collectEnabled && d2 < 2.6 * 2.6 && Math.abs(this.pos[i * 3 + 1] - (player.pos.y + 1.0)) < 2.0) {
        out.push({ x: this.pos[i * 3], y: this.pos[i * 3 + 1], z: this.pos[i * 3 + 2] });
        this.alive[i] = 0;
        this.respawn[i] = 4 + Math.random() * 4;
        dirty = true;
      }
    }
    if (dirty) { this.aPos.needsUpdate = true; this.aAlive.needsUpdate = true; }
    return out;
  }

  /** 拍照任务：画面里可见的萤火虫 */
  forEachAlive(fn) {
    for (let i = 0; i < this.count; i++) if (this.alive[i] >= 1) fn(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
  }

  dispose() { this.geo.dispose(); this.mat.dispose(); this.points.removeFromParent(); }
}

/* ================================================================== *
 * 车灯
 * ================================================================== */
class Headlight {
  constructor(scene, bike, env) {
    this.env = env;
    this.bike = bike;
    this.light = new THREE.SpotLight(0xffe2b0, 0, 42, 0.42, 0.55, 1.2);
    this.light.castShadow = false;
    this.light.position.set(0, 0, 0.03);
    this.target = new THREE.Object3D();
    this.target.position.set(0, -1.6, 8);
    bike.lampGroup.add(this.light);
    bike.lampGroup.add(this.target);
    this.light.target = this.target;

    // 体积光锥（很淡，夜里才看得见）
    const cone = new THREE.ConeGeometry(2.4, 12, 20, 1, true);
    cone.translate(0, -6, 0);
    cone.rotateX(-Math.PI / 2 - 0.12);
    this.coneGeo = cone;
    this.coneMat = new THREE.ShaderMaterial({
      uniforms: { uI: { value: 0 } },
      vertexShader: `varying vec3 vP; varying vec3 vN; varying vec3 vV;
        void main(){ vP = position; vec4 wp = modelMatrix*vec4(position,1.0); vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - wp.xyz); gl_Position = projectionMatrix*viewMatrix*wp; }`,
      fragmentShader: `uniform float uI; varying vec3 vP; varying vec3 vN; varying vec3 vV;
        void main(){ float along = clamp(length(vP) / 12.0, 0.0, 1.0); float f = (1.0 - along); f *= f;
          float edge = abs(dot(normalize(vN), normalize(vV)));
          gl_FragColor = vec4(vec3(1.0, 0.88, 0.62) * f * edge * uI * 0.22, 1.0); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.cone = new THREE.Mesh(cone, this.coneMat);
    this.cone.position.z = 0.03;
    this.cone.frustumCulled = false;
    bike.lampGroup.add(this.cone);
    this._wp = new THREE.Vector3();
    this._wd = new THREE.Vector3();
    this.level = 0;
  }

  update(dt, night) {
    const want = night > 0.25 ? 1 : 0;
    this.level += (want - this.level) * Math.min(1, dt * 3);
    const I = this.level;
    // 不切 visible：可见光源数量变化会让所有内置材质重编译着色器（白天 ↔ 夜晚各卡一下）
    this.light.intensity = I * 12;
    this.coneMat.uniforms.uI.value = I;
    this.cone.visible = I > 0.01;
    if (this.bike.materials?.lamp) this.bike.materials.lamp.emissiveIntensity = 0.6 + I * 5;

    // 给地形着色器的「假聚光」：位置与朝向取自真正的灯
    const u = this.env.u;
    if (u.uHeadI) {
      this.light.getWorldPosition(this._wp);
      this.target.getWorldPosition(this._wd);
      this._wd.sub(this._wp).normalize();
      u.uHeadPos.value.copy(this._wp);
      u.uHeadDir.value.copy(this._wd);
      u.uHeadI.value = I * 5.0;
    }
  }

  dispose() {
    this.coneGeo.dispose(); this.coneMat.dispose();
    this.light.removeFromParent(); this.cone.removeFromParent(); this.target.removeFromParent();
    this.light.dispose?.();
  }
}

/* ================================================================== *
 * 阵风
 * ================================================================== */
class Wind {
  constructor() {
    this.enabled = true;
    this.timer = 12 + Math.random() * 10;
    this.t = 0;
    this.dur = 0;
    this.dir = 0;           // 风吹向的方位（与 yaw 同约定）
    this.strength = 0;      // 0..1
    this.steer = 0;         // 对车把的影响（steer 约定：正 = 右）
  }
  update(dt, player) {
    if (!this.enabled) { this.strength = 0; this.steer = 0; return false; }
    let started = false;
    if (this.dur > 0) {
      this.t += dt;
      const k = this.t / this.dur;
      this.strength = Math.sin(Math.min(1, k) * Math.PI) * (0.75 + 0.25 * Math.sin(this.t * 7));
      if (k >= 1) { this.dur = 0; this.strength = 0; this.timer = 16 + Math.random() * 18; }
    } else {
      this.timer -= dt;
      if (this.timer <= 0) { this.dur = 3.2 + Math.random() * 1.8; this.t = 0; this.dir = Math.random() * TAU; started = true; }
    }
    // 侧风分量：风从左往右吹 → 车被推向右 → 等效于向右打把
    // 风向 dir 相对车头的夹角，sin(dir - yaw) > 0 表示风吹向车的左侧（+X 侧是左）
    const side = Math.sin(this.dir - player.yaw);
    this.steer = -side * this.strength * 0.22;
    return started;
  }
}

/* ================================================================== */
export class WorldEvents {
  constructor(scene, bike, env, particles, audio) {
    this.particles = particles;
    this.audio = audio;
    this.gulls = new Gulls(scene, audio);
    this.fireflies = new Fireflies(scene);
    this.headlight = new Headlight(scene, bike, env);
    this.wind = new Wind();
    this.night = 0;
    this._ff = [];
    this._dust = 0;
  }

  /**
   * 「夜色」0..1。不能用太阳高度：sky.js 会把落到地平线以下的太阳
   * 夹在 -0.06，留住余晖 —— 那样夜色永远到不了 1。
   * 星星强度是色板里专门调过的「天黑程度」，直接用它。
   */
  static nightFactor(stars) {
    return THREE.MathUtils.smoothstep(stars, 0.12, 0.7);
  }

  update(dt, c) {
    this.night = WorldEvents.nightFactor(c.stars);
    this.headlight.update(dt, this.night);
    const collected = this.fireflies.update(dt, c.time, c.gameplay ? this.night : this.night * 0.6, c.player, this._ff);

    let gust = false;
    if (c.gameplay) gust = this.wind.update(dt, c.player);
    else { this.wind.strength = 0; this.wind.steer = 0; }

    // 阵风时扬沙
    if (this.wind.strength > 0.2) {
      this._dust += dt * 30 * this.wind.strength;
      while (this._dust > 1) {
        this._dust -= 1;
        const a = Math.random() * TAU, r = 3 + Math.random() * 10;
        const x = c.player.pos.x + Math.sin(a) * r, z = c.player.pos.z + Math.cos(a) * r;
        const s = 7 * this.wind.strength;
        this.particles.burst({ x, y: c.player.pos.y + 0.2 + Math.random() * 1.2, z, count: 1, speed: 0.1, up: 0.3, spread: 0.1,
          vx: Math.sin(this.wind.dir) * s, vz: Math.cos(this.wind.dir) * s, color: [0.9, 0.75, 0.55], intensity: 0.5, size: 0.08, life: 1.1, gravity: 0.5, drag: 0.1 });
      }
    }
    return { collected, gust };
  }

  dispose() {
    this.gulls.dispose(); this.fireflies.dispose(); this.headlight.dispose();
  }
}
