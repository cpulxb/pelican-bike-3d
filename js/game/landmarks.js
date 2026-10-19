/**
 * landmarks.js —— 灯塔与鸟巢（送鱼点）
 *
 * 灯塔：红白条纹塔身 + 环廊 + 灯室，灯室里一盏旋转的光束，
 *       入夜后光束才明显 —— 是整个岛上最好认的地标，也是拍照任务的主角。
 * 鸟巢：树枝圈 + 三只雏鸟。玩家带着鱼靠近时，雏鸟会伸长脖子张嘴要吃的。
 *
 * 送达区域是地面上的一圈光环，喉囊里有鱼时才亮起，并竖起一根光柱
 * 让玩家从远处也能找到方向。
 */
import * as THREE from 'three';
import { mergeColored, trs, propMaterial, glowMaterial } from './mesh.js';
import { terrainHeight } from '../util/noise.js';

const STRIPE_RED = 0xb8392e;
const STRIPE_WHITE = 0xf0e8da;

export class Landmarks {
  constructor(scene, layout) {
    this.group = new THREE.Group();
    this.group.name = 'Landmarks';
    scene.add(this.group);
    this.disposables = [];
    this.zones = [];           // 送达区域 { x, z, y, radius, mult, name, ring, pillar, kind, chicks? }
    this._t = 0;

    this._buildLighthouse(layout.lighthouse);
    layout.nests.forEach((n, i) => this._buildNest(n, i));
  }

  /* ---------------- 灯塔 ---------------- */
  _buildLighthouse(p) {
    const g = new THREE.Group();
    g.position.set(p.x, p.h - 0.3, p.z);
    this.group.add(g);

    const towerH = 14;
    const parts = [];
    // 石基
    parts.push([new THREE.CylinderGeometry(3.2, 3.6, 1.2, 10), 0x6d6458, trs(0, 0.6, 0)]);
    parts.push([new THREE.CylinderGeometry(2.6, 3.0, 0.5, 10), 0x847a6c, trs(0, 1.35, 0)]);
    // 塔身：按高度画红白条纹
    const tower = new THREE.CylinderGeometry(1.25, 2.1, towerH, 14, 14, true);
    parts.push([tower, (x, y) => (Math.floor((y + towerH / 2) / 2.33) % 2 === 0 ? STRIPE_WHITE : STRIPE_RED), trs(0, 1.6 + towerH / 2, 0)]);
    // 环廊
    const topY = 1.6 + towerH;
    parts.push([new THREE.CylinderGeometry(2.0, 1.6, 0.35, 16), 0x2a2e33, trs(0, topY + 0.15, 0)]);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      parts.push([new THREE.CylinderGeometry(0.04, 0.04, 0.9, 4), 0x2a2e33, trs(Math.sin(a) * 1.9, topY + 0.75, Math.cos(a) * 1.9)]);
    }
    parts.push([new THREE.TorusGeometry(1.9, 0.05, 4, 24), 0x2a2e33, trs(0, topY + 1.2, 0, Math.PI / 2)]);
    // 灯室框架 + 屋顶
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      parts.push([new THREE.BoxGeometry(0.1, 1.7, 0.1), 0x23272b, trs(Math.sin(a) * 1.1, topY + 1.2, Math.cos(a) * 1.1)]);
    }
    parts.push([new THREE.ConeGeometry(1.5, 1.4, 12), STRIPE_RED, trs(0, topY + 2.75, 0)]);
    parts.push([new THREE.SphereGeometry(0.22, 8, 6), 0x2a2e33, trs(0, topY + 3.55, 0)]);
    // 门
    parts.push([new THREE.BoxGeometry(0.9, 1.7, 0.3), 0x3d2a1e, trs(0, 2.4, 2.0, -0.06)]);

    const geo = mergeColored(parts);
    const mesh = new THREE.Mesh(geo, propMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
    this.disposables.push(geo);

    // 灯：一个发光核心 + 两道相反方向的光束锥
    const lampMat = glowMaterial(0xffd27a, 3.2);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 8), lampMat);
    lamp.position.y = topY + 1.15;
    g.add(lamp);
    const beamGeo = new THREE.ConeGeometry(2.6, 60, 18, 1, true);
    beamGeo.translate(0, -30, 0);
    beamGeo.rotateZ(Math.PI / 2);   // 锥尖在原点，朝 +X 张开
    const beamMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(1.0, 0.82, 0.5) }, uStrength: { value: 0 } },
      vertexShader: `varying float vX; void main(){ vX = position.x; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
      fragmentShader: `uniform vec3 uColor; uniform float uStrength; varying float vX;
        void main(){ float f = exp(-abs(vX) * 0.055); gl_FragColor = vec4(uColor * uStrength * f, f * uStrength); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const beams = new THREE.Group();
    beams.position.y = topY + 1.15;
    const b1 = new THREE.Mesh(beamGeo, beamMat);
    const b2 = new THREE.Mesh(beamGeo, beamMat);
    b2.rotation.y = Math.PI;
    beams.add(b1, b2);
    g.add(beams);
    this.disposables.push(lamp.geometry, lampMat, beamGeo, beamMat);

    this.lighthouse = {
      group: g, beams, beamMat, lampMat,
      top: new THREE.Vector3(p.x, p.h - 0.3 + topY + 1.2, p.z),
      base: new THREE.Vector3(p.x, p.h, p.z),
      radius: 3.4,
    };

    // 送达区域在灯塔门前
    const zx = p.x + Math.sin(Math.atan2(-p.x, -p.z)) * 6.5;
    const zz = p.z + Math.cos(Math.atan2(-p.x, -p.z)) * 6.5;
    this._addZone(zx, zz, 4.2, 1.5, '灯塔', 'lighthouse');
  }

  /* ---------------- 鸟巢 ---------------- */
  _buildNest(p, idx) {
    const g = new THREE.Group();
    g.position.set(p.x, p.h, p.z);
    this.group.add(g);

    const parts = [];
    // 一根木桩撑起巢
    parts.push([new THREE.CylinderGeometry(0.18, 0.26, 1.6, 6), 0x5a4330, trs(0, 0.8, 0)]);
    parts.push([new THREE.CylinderGeometry(0.75, 0.25, 0.35, 8), 0x4a3524, trs(0, 1.65, 0)]);
    // 树枝圈：很多根细棍交错
    let seed = 1337 + idx * 97;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 44; i++) {
      const a = (i / 44) * Math.PI * 2 + rnd() * 0.3;
      const r = 0.82 + rnd() * 0.12;
      const len = 0.7 + rnd() * 0.5;
      parts.push([
        new THREE.CylinderGeometry(0.025, 0.03, len, 3),
        rnd() > 0.5 ? 0x6e5236 : 0x8a6a45,
        trs(Math.sin(a) * r, 1.82 + (rnd() - 0.5) * 0.15, Math.cos(a) * r, Math.PI / 2 + (rnd() - 0.5) * 0.5, a + Math.PI / 2 + (rnd() - 0.5) * 0.6, 0),
      ]);
    }
    const geo = mergeColored(parts);
    const mesh = new THREE.Mesh(geo, propMaterial());
    mesh.castShadow = true;
    g.add(mesh);
    this.disposables.push(geo);

    // 雏鸟：每只一个小 Group（身体 + 头 + 喙），靠近时伸脖子张嘴
    const chicks = [];
    const chickMat = new THREE.MeshStandardMaterial({ color: 0xe9e2d4, roughness: 0.95 });
    const beakMat = new THREE.MeshStandardMaterial({ color: 0xf0a040, roughness: 0.6 });
    this.disposables.push(chickMat, beakMat);
    const bodyGeo = new THREE.SphereGeometry(0.2, 10, 8);
    const headGeo = new THREE.SphereGeometry(0.12, 10, 8);
    const beakGeo = new THREE.ConeGeometry(0.05, 0.22, 6);
    beakGeo.rotateX(Math.PI / 2);
    beakGeo.translate(0, 0, 0.16);
    this.disposables.push(bodyGeo, headGeo, beakGeo);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + idx;
      const c = new THREE.Group();
      c.position.set(Math.sin(a) * 0.32, 1.88, Math.cos(a) * 0.32);
      const body = new THREE.Mesh(bodyGeo, chickMat);
      body.scale.set(1, 0.9, 1.1);
      const neck = new THREE.Group();
      neck.position.y = 0.12;
      const head = new THREE.Mesh(headGeo, chickMat);
      head.position.y = 0.12;
      const beakU = new THREE.Mesh(beakGeo, beakMat);
      beakU.position.set(0, 0.13, 0.04);
      const beakL = new THREE.Mesh(beakGeo, beakMat);
      beakL.position.set(0, 0.1, 0.04);
      beakL.scale.set(0.8, 0.6, 0.85);
      neck.add(head, beakU, beakL);
      c.add(body, neck);
      c.rotation.y = a;
      g.add(c);
      chicks.push({ group: c, neck, beakU, beakL, phase: Math.random() * 6 });
    }

    const zone = this._addZone(p.x, p.z, 3.6, 1.0, `鸟巢 ${['甲', '乙', '丙'][idx] || idx + 1}`, 'nest');
    zone.chicks = chicks;
    zone.nestTop = new THREE.Vector3(p.x, p.h + 2.0, p.z);
  }

  _addZone(x, z, radius, mult, name, kind) {
    const y = terrainHeight(x, z);
    const ringGeo = new THREE.RingGeometry(radius - 0.35, radius, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = glowMaterial(kind === 'lighthouse' ? 0xffc46b : 0x7ff0e0, 2.2, 0.0);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(x, y + 0.12, z);
    ring.renderOrder = 4;
    this.group.add(ring);

    const pillarGeo = new THREE.CylinderGeometry(radius * 0.18, radius * 0.5, 40, 16, 1, true);
    pillarGeo.translate(0, 20, 0);
    const pillarMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(kind === 'lighthouse' ? 0xffc46b : 0x7ff0e0) }, uStrength: { value: 0 } },
      vertexShader: `varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
      fragmentShader: `uniform vec3 uColor; uniform float uStrength; varying float vY;
        void main(){ float f = (1.0 - vY / 40.0); f = f*f; gl_FragColor = vec4(uColor * uStrength * f * 1.6, f * uStrength); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.set(x, y, z);
    pillar.renderOrder = 4;
    this.group.add(pillar);
    this.disposables.push(ringGeo, ringMat, pillarGeo, pillarMat);

    const zone = { x, z, y, radius, mult, name, kind, ring, ringMat, pillar, pillarMat, active: 0 };
    this.zones.push(zone);
    return zone;
  }

  /**
   * @param {number} dt
   * @param {object} s { time, night(0..1), playerPos, carrying(int), showZones }
   */
  update(dt, s) {
    this._t += dt;
    const L = this.lighthouse;
    L.beams.rotation.y += dt * 0.55;
    const night = s.night ?? 0;
    L.beamMat.uniforms.uStrength.value = 0.04 + night * 0.38;
    L.lampMat.color.setRGB(1.0, 0.82, 0.48).multiplyScalar(1.2 + night * 3.0);

    for (const z of this.zones) {
      const want = s.showZones && s.carrying > 0 ? 1 : 0;
      z.active += (want - z.active) * Math.min(1, dt * 3);
      const pulse = 0.75 + 0.25 * Math.sin(this._t * 3.2 + z.x);
      z.ringMat.opacity = z.active * pulse;
      z.ring.visible = z.active > 0.01;
      z.pillarMat.uniforms.uStrength.value = z.active * (0.18 + 0.1 * pulse);
      z.pillar.visible = z.active > 0.01;
      z.ring.scale.setScalar(1 + 0.04 * Math.sin(this._t * 3.2));

      if (z.chicks) {
        const dx = s.playerPos.x - z.x, dz = s.playerPos.z - z.z;
        const near = Math.hypot(dx, dz) < 22 && s.carrying > 0 ? 1 : 0;
        for (const c of z.chicks) {
          c.phase += dt * (near ? 9 : 2);
          const beg = near ? (0.5 + 0.5 * Math.sin(c.phase)) : 0;
          c.neck.position.y = 0.12 + beg * 0.12;
          c.neck.rotation.x = -0.3 - beg * 0.5;
          c.beakL.rotation.x = beg * 0.5;
          c.group.position.y = 1.88 + Math.abs(Math.sin(c.phase * 0.5)) * 0.03;
        }
      }
    }
  }

  /** 与灯塔的简单圆形碰撞：把点推到塔外 */
  collide(pos) {
    const L = this.lighthouse.base;
    const dx = pos.x - L.x, dz = pos.z - L.z;
    const d = Math.hypot(dx, dz);
    const r = this.lighthouse.radius + 0.6;
    if (d < r && d > 1e-4) {
      pos.x = L.x + (dx / d) * r;
      pos.z = L.z + (dz / d) * r;
      return true;
    }
    return false;
  }

  setVisibleZones(v) { for (const z of this.zones) { z.ring.visible = v; z.pillar.visible = v; } }

  dispose() {
    for (const d of this.disposables) d.dispose?.();
    this.group.removeFromParent();
  }
}
