/**
 * pelican.js —— 鹈鹕的建模与骨骼绑定
 *
 * 这是整个场景的主角，也是几何构造最复杂的部分。全部由代码生成：
 *
 *   躯干    噪声位移的椭球 + 胸腹分层
 *   颈部    6 段骨链构成的 S 形曲颈（可每帧扭动）
 *   头      球体 + 冠羽 + 眼睛（含瞬膜）
 *   喙      上颌（带钩）+ 下颌 + 喉囊 —— 鹈鹕的招牌特征
 *   翅膀    上臂/前臂/掌骨三段骨链，兼作「手臂」搭在车把上
 *            前臂挂次级飞羽、掌骨挂初级飞羽，展开时是翅膀、收拢时像披风
 *   腿      大腿/小腿/跗跖/蹼足，用两骨 IK 精确踩在踏板上
 *   羽毛    由 FeatherCoat 以实例化方式铺设，锚点挂在本文件的骨骼上
 *
 * 骨骼朝向约定：所有肢体骨沿 -Y 建模，
 * 于是「让 A 指向 B」只需 setFromUnitVectors((0,-1,0), dir)。
 *
 * 局部坐标原点 = 鞍座接触点（控制器把 root 放到鞍座世界坐标即可）。
 */

import * as THREE from 'three';
import {
  tubeFromCurve, curveFrom, noiseDeform, mergeGeometries, TRS, transformed, solveTwoBoneIK,
  featherBlade,
} from '../util/geometry.js';
import { fbm2 } from '../util/noise.js';

/* ------------------------------------------------------------------ *
 * 尺寸常量（单位：米，与自行车同一比例尺）
 * ------------------------------------------------------------------ */
const P = {
  torsoLen: 0.68,
  torsoHeight: 0.40,
  torsoWidth: 0.34,
  neckSegments: 6,
  neckLen: 0.48,
  headRadius: 0.115,
  beakLen: 0.44,
  beakBase: 0.075,
  upperArm: 0.295,
  foreArm: 0.315,
  handLen: 0.10,
  // 腿长不是随便定的：鞍座在离地 1.08m，最低踏板在 0.12m，
  // 髋到踏板最近处约 0.99m。三段腿总长取 0.98m，
  // 于是踏板踩到最底时腿几乎伸直、转到最高时膝弯约 60° ——
  // 这正是真实骑行的腿部姿态，IK 会自动把中间姿态补出来。
  thigh: 0.40,
  shank: 0.45,
  tarsus: 0.13,
  hipSpread: 0.078,
  shoulderSpread: 0.155,
  bodyLift: 0.105,
};

const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * 让骨骼沿「世界方向 dir」指向。
 *
 * 所有肢体骨都沿局部 -Y 建模（长轴朝下），所以只要把 -Y 转到 dir 即可。
 * 但 quaternion 是相对父节点的，因此必须先用父节点的世界旋转把 dir 变换到父空间，
 * 否则一旦躯干/车身发生俯仰侧倾，四肢就会脱离把手和踏板。
 *
 * 这也是为什么 IK 解算全部在世界空间完成、只在最后一步换算到父空间：
 * 世界空间里「把手在哪」是唯一确定的，不需要在层层嵌套的局部空间里反复推导。
 */
const _wq = new THREE.Quaternion();
const _wd = new THREE.Vector3();
const _wm = new THREE.Matrix4();
function aimWorld(bone, dirWorld) {
  bone.parent.updateWorldMatrix(true, false);
  // 从父节点世界矩阵中取出旋转（去掉平移与缩放）
  _wm.copy(bone.parent.matrixWorld);
  _wm.decompose(_wpos, _wq, _wscale);
  _wd.copy(dirWorld).applyQuaternion(_wq.invert());
  if (_wd.lengthSq() < 1e-10) return;
  _wd.normalize();
  bone.quaternion.setFromUnitVectors(DOWN, _wd);
}

const _wpos = new THREE.Vector3();
const _wscale = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _ay = new THREE.Vector3();
const _az = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _qw = new THREE.Quaternion();

/**
 * 指定骨骼在**世界空间**中的完整朝向（而不仅仅是长轴方向）。
 *
 * 骨骼的局部 +Y 会对齐到 yWorld，局部 +Z 会尽量对齐 zHintWorld。
 * 这在需要控制「扭转」的场合是必需的 —— 比如脚掌要平贴踏板、
 * 手掌要环住车把，光把长轴指对是不够的，还得管住绕轴的旋转。
 *
 * 做法：在世界空间用三个正交轴拼出目标旋转矩阵，
 * 再左乘父节点世界旋转的逆，转回局部空间。
 */
function orientWorld(bone, yWorld, zHintWorld) {
  bone.parent.updateWorldMatrix(true, false);
  _wm.copy(bone.parent.matrixWorld);
  _wm.decompose(_wpos, _wq, _wscale);

  _ay.copy(yWorld).normalize();
  // 把提示轴投影到与 yWorld 垂直的平面上，得到正交的 z
  _az.copy(zHintWorld).addScaledVector(_ay, -_az.dot(_ay));
  if (_az.lengthSq() < 1e-8) {
    _az.set(0, 0, 1).addScaledVector(_ay, -_ay.z);
    if (_az.lengthSq() < 1e-8) _az.set(1, 0, 0).addScaledVector(_ay, -_ay.x);
  }
  _az.normalize();
  _ax.crossVectors(_ay, _az).normalize();

  _basis.makeBasis(_ax, _ay, _az);
  _qw.setFromRotationMatrix(_basis);

  // q_local = q_parent⁻¹ · q_world
  bone.quaternion.copy(_wq.invert().multiply(_qw));
}

/* ================================================================== *
 * 鹈鹕
 * ================================================================== */

export class Pelican {
  constructor(env, opts = {}) {
    this.env = env;
    this.root = new THREE.Group();
    this.root.name = 'Pelican';

    this.geometries = [];
    this.materials = {};
    this.bones = {};
    this.featherAnchors = [];   // 供 FeatherCoat 使用的锚点
    this._m4 = new THREE.Matrix4();

    this.quality = opts.quality ?? 'high';

    this._buildMaterials();
    this._buildTorso();
    this._buildNeck();
    this._buildHead();
    this._buildWings();
    this._buildLegs();
    this._buildTail();
    this._buildCap();

    /** 动画状态：由 update() 平滑推进，避免任何突变 */
    this.anim = {
      breath: 0,
      neckSway: 0,
      headBob: 0,
      blink: 0,
      blinkTimer: 2.4,
      pouchJiggle: 0,
      pouchFill: 0,        // 喉囊装载量（平滑后的 0..1）
      pouchTarget: 0,
      snap: 0,             // 「啪」地合嘴：接到鱼 / 送鱼时触发
      wingFlutter: 0,
      tailSway: 0,
      footL: new THREE.Vector3(),
      footR: new THREE.Vector3(),
    };

    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._q1 = new THREE.Quaternion();

    // IK 与朝向解算的临时量（预分配，避免每帧产生垃圾回收压力）
    this._rootQ = new THREE.Quaternion();
    this._fwd = new THREE.Vector3(0, 0, 1);
    this._up = new THREE.Vector3(0, 1, 0);
    this._side = new THREE.Vector3(1, 0, 0);
    this._shoulderW = new THREE.Vector3();
    this._hipW = new THREE.Vector3();
    this._ankle = new THREE.Vector3();
    this._elbow = new THREE.Vector3();
    this._knee = new THREE.Vector3();
    this._pole = new THREE.Vector3();
    this._d1 = new THREE.Vector3();
    this._d2 = new THREE.Vector3();
    this._d3 = new THREE.Vector3();

    this._buildFeatherAnchors();
  }

  /* ================================================================ *
   * 材质
   * ================================================================ */
  _buildMaterials() {
    const M = this.materials;
    // 鹈鹕的经典配色：白羽 + 橙黄喉囊 + 深色飞羽
    M.body = new THREE.MeshStandardMaterial({
      color: 0xf2ece0, roughness: 0.78, metalness: 0.0,
      side: THREE.DoubleSide,
    });
    M.bodyShade = new THREE.MeshStandardMaterial({
      color: 0xdcd3c4, roughness: 0.82, metalness: 0.0,
    });
    M.wingDark = new THREE.MeshStandardMaterial({
      color: 0x7a766d, roughness: 0.74, metalness: 0.04, side: THREE.DoubleSide,
    });
    M.wingTip = new THREE.MeshStandardMaterial({
      color: 0x565049, roughness: 0.68, metalness: 0.06, side: THREE.DoubleSide,
    });
    M.beakUpper = new THREE.MeshStandardMaterial({
      color: 0xe8b465, roughness: 0.42, metalness: 0.06, side: THREE.DoubleSide,
    });
    M.beakLower = new THREE.MeshStandardMaterial({
      color: 0xd99a4a, roughness: 0.46, metalness: 0.05, side: THREE.DoubleSide,
    });
    M.pouch = new THREE.MeshStandardMaterial({
      color: 0xf0a24e, roughness: 0.58, metalness: 0.0,
      side: THREE.DoubleSide, transparent: false,
    });
    M.eyeWhite = new THREE.MeshStandardMaterial({ color: 0xf6f2e8, roughness: 0.28 });
    M.eyeIris = new THREE.MeshStandardMaterial({ color: 0x2b2a26, roughness: 0.14, metalness: 0.2 });
    M.eyeShine = new THREE.MeshBasicMaterial({ color: 0xffffff });
    M.foot = new THREE.MeshStandardMaterial({ color: 0xe09a4e, roughness: 0.6, metalness: 0.02 });
    M.legSkin = new THREE.MeshStandardMaterial({ color: 0xd98f45, roughness: 0.62, metalness: 0.02 });
    M.cap = new THREE.MeshStandardMaterial({ color: 0x2b4a5e, roughness: 0.82, metalness: 0.02 });
    M.capBand = new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.3, metalness: 0.7 });
  }

  /* ================================================================ *
   * 躯干
   * ================================================================ */
  _buildTorso() {
    this.body = new THREE.Group();
    this.body.name = 'Body';
    // 躯干中心相对鞍座接触点的高度：坐骨压在鞍座上，腹部微微下垂
    this.body.position.set(0, P.bodyLift, 0.01);
    this.root.add(this.body);
    this.bones.body = this.body;

    // ---- 主体：椭球 + 噪声位移 ----
    const torso = new THREE.IcosahedronGeometry(1, 4);
    noiseDeform(torso, 0.055, 2.6, 3.3);
    torso.scale(P.torsoWidth * 0.5, P.torsoHeight * 0.5, P.torsoLen * 0.5);

    // 把后半段收窄、前半段加宽 —— 形成「胸宽臀窄」的鸟体轮廓
    const pos = torso.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const tz = THREE.MathUtils.clamp(v.z / (P.torsoLen * 0.5), -1, 1); // -1 尾 1 头
      const taper = 0.72 + 0.28 * Math.pow((tz + 1) * 0.5, 0.7);
      v.x *= taper;
      // 胸骨下缘稍微下垂，做出「坐姿肚子」的垂坠感
      if (v.y < 0) v.y *= 0.86 + 0.14 * Math.max(0, tz);
      // 背部隆起
      if (v.y > 0) v.y *= 1.0 + 0.06 * (1 - Math.abs(tz));
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    torso.computeVertexNormals();

    const torsoMesh = new THREE.Mesh(torso, this.materials.body);
    torsoMesh.castShadow = true;
    torsoMesh.receiveShadow = true;
    this.body.add(torsoMesh);
    this.geometries.push(torso);

    // ---- 腹部浅色分区：一个略小的内嵌椭球，制造两段式羽色 ----
    const belly = new THREE.IcosahedronGeometry(1, 3);
    noiseDeform(belly, 0.03, 3.4, 7.7);
    belly.scale(P.torsoWidth * 0.44, P.torsoHeight * 0.42, P.torsoLen * 0.46);
    const bp = belly.attributes.position;
    for (let i = 0; i < bp.count; i++) {
      v.fromBufferAttribute(bp, i);
      v.y -= 0.02;
      bp.setXYZ(i, v.x, v.y, v.z);
    }
    belly.computeVertexNormals();
    const bellyMesh = new THREE.Mesh(belly, this.materials.bodyShade);
    bellyMesh.castShadow = true;
    this.body.add(bellyMesh);
    this.geometries.push(belly);

    // ---- 肩部隆起：让翅膀的接点不显得突兀 ----
    for (const sx of [-1, 1]) {
      const sh = new THREE.SphereGeometry(0.085, 12, 10);
      sh.scale(0.85, 0.72, 1.25);
      const m = new THREE.Mesh(sh, this.materials.body);
      m.position.set(sx * P.shoulderSpread * 0.92, 0.045, 0.07);
      m.castShadow = true;
      this.body.add(m);
      this.geometries.push(sh);
    }
  }

  /* ================================================================ *
   * 颈部：骨链
   * ================================================================ */
  _buildNeck() {
    this.neckRoot = new THREE.Group();
    // 颈根在躯干前上方
    this.neckRoot.position.set(0, 0.075, P.torsoLen * 0.38);
    this.body.add(this.neckRoot);
    this.bones.neckRoot = this.neckRoot;

    const segs = [];
    let parent = this.neckRoot;
    const segLen = P.neckLen / P.neckSegments;

    for (let i = 0; i < P.neckSegments; i++) {
      const g = new THREE.Group();
      g.position.set(0, i === 0 ? 0 : segLen, 0);   // 沿 +Y 串接（颈根向上）
      parent.add(g);
      segs.push(g);

      // 半径：颈根粗、中段细、靠近头略粗
      const t = i / (P.neckSegments - 1);
      const r0 = 0.058 * (1 - t * 0.34) + 0.008;
      const r1 = 0.058 * (1 - (i + 1) / P.neckSegments * 0.34) + 0.008;

      // 每段用一根锥形管 + 一个关节球遮住接缝
      const segGeo = new THREE.CylinderGeometry(r1, r0, segLen * 1.06, 12, 1, true);
      segGeo.translate(0, segLen * 0.5, 0);
      const mesh = new THREE.Mesh(segGeo, this.materials.body);
      mesh.castShadow = true;
      g.add(mesh);
      this.geometries.push(segGeo);

      const jointGeo = new THREE.SphereGeometry(r1, 10, 8);
      const joint = new THREE.Mesh(jointGeo, this.materials.body);
      joint.position.y = segLen;
      g.add(joint);
      this.geometries.push(jointGeo);

      parent = g;
    }
    this.neckSegs = segs;
    this.neckTip = parent;   // 头挂在最后一节上
    this.bones.neckTip = parent;

    /**
     * 颈部的静息姿态。
     *
     * 骨骼链沿 +Y 串接，rotation.x 为正表示「向前倒」。
     * 鹈鹕的经典轮廓是：颈从肩部斜向前上方伸出，到头部附近转平，
     * 于是喙大致水平、略微下倾。
     *
     * 所以静息角不是均匀的 —— 下段前倾大、上段迅速减小，
     * 累加起来约 0.61 rad（35°）的整体前倾，头部再由下面的
     * headPitchBase 反向补偿，把喙拉回水平。
     */
    this.neckRest = [];
    for (let i = 0; i < P.neckSegments; i++) {
      const t = i / (P.neckSegments - 1);
      // 前倾量：底部大、向上快速衰减，形成一条向前伸出的弧
      this.neckRest.push((1 - t) * (1 - t) * 0.30 + (1 - t) * 0.09);
    }
    // 头部反向补偿：把上面累加出的前倾拉回来，让喙接近水平
    this.headPitchBase = -0.62;
  }

  /* ================================================================ *
   * 头 + 喙 + 喉囊
   * ================================================================ */
  _buildHead() {
    this.head = new THREE.Group();
    this.head.position.set(0, P.neckLen / P.neckSegments, 0);
    this.neckTip.add(this.head);
    this.bones.head = this.head;

    // ---- 头颅：略扁的椭球，后脑略大 ----
    const skull = new THREE.IcosahedronGeometry(1, 3);
    noiseDeform(skull, 0.02, 4.2, 11.1);
    skull.scale(P.headRadius, P.headRadius * 0.92, P.headRadius * 1.18);
    const sp = skull.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < sp.count; i++) {
      v.fromBufferAttribute(sp, i);
      if (v.z < 0) { v.x *= 1.06; v.y *= 1.04; }   // 后脑鼓一点
      sp.setXYZ(i, v.x, v.y, v.z);
    }
    skull.computeVertexNormals();
    const skullMesh = new THREE.Mesh(skull, this.materials.body);
    skullMesh.castShadow = true;
    this.head.add(skullMesh);
    this.geometries.push(skull);

    // ---- 冠羽：后脑一小撮翘起的羽毛 ----
    const crest = [];
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      const a = (t - 0.5) * 0.9;
      const len = 0.055 + Math.sin(t * Math.PI) * 0.045;
      const c = curveFrom([
        new THREE.Vector3(0, 0.03, -0.06),
        new THREE.Vector3(Math.sin(a) * 0.02, 0.03 + len * 0.5, -0.075 - len * 0.35),
        new THREE.Vector3(Math.sin(a) * 0.045, 0.02 + len * 0.95, -0.09 - len * 0.72),
      ]);
      crest.push(tubeFromCurve(c, [0.012, 0.007, 0.002], { segments: 10, radial: 6, flat: 0.6 }));
    }
    const crestMesh = new THREE.Mesh(mergeGeometries(crest), this.materials.bodyShade);
    crestMesh.castShadow = true;
    this.head.add(crestMesh);
    crest.forEach((g) => g.dispose());

    // ---- 眼睛（含瞬膜眨动）----
    this.eyes = [];
    for (const sx of [-1, 1]) {
      const eye = new THREE.Group();
      // 眼睛必须落在颅骨椭球**表面**上。
      // 颅骨缩放是 (0.115, 0.106, 0.136)，解椭球方程
      // (x/a)²+(y/b)²+(z/c)²=1 得 z≈0.078 —— 取 0.052 的话眼球会整个埋进颅内。
      eye.position.set(sx * 0.086, 0.030, 0.078);
      this.head.add(eye);

      const white = new THREE.Mesh(new THREE.SphereGeometry(0.024, 12, 10), this.materials.eyeWhite);
      white.scale.set(0.9, 0.9, 0.75);
      eye.add(white);
      this.geometries.push(white.geometry);

      const iris = new THREE.Mesh(new THREE.SphereGeometry(0.017, 12, 10), this.materials.eyeIris);
      iris.position.set(sx * 0.006, 0, 0.008);
      eye.add(iris);
      this.geometries.push(iris.geometry);

      const shine = new THREE.Mesh(new THREE.SphereGeometry(0.005, 6, 5), this.materials.eyeShine);
      shine.position.set(sx * 0.010, 0.007, 0.016);
      eye.add(shine);
      this.geometries.push(shine.geometry);

      // 瞬膜：一片从下往上盖的薄球壳，眨眼时旋转出来
      const lidGeo = new THREE.SphereGeometry(0.0262, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55);
      const lid = new THREE.Mesh(lidGeo, this.materials.body);
      lid.rotation.x = Math.PI;
      lid.position.z = 0.001;
      eye.add(lid);
      this.geometries.push(lidGeo);

      this.eyes.push({ group: eye, lid });
    }

    // ---- 上颌：长而直的锥体，尖端下钩 ----
    this.beakUpper = new THREE.Group();
    this.beakUpper.position.set(0, 0.004, 0.085);
    this.head.add(this.beakUpper);
    this.bones.beakUpper = this.beakUpper;

    const upperPts = [];
    const n = 8;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      upperPts.push(new THREE.Vector3(
        0,
        // 先微微上拱，末端下钩 —— 鹈鹕喙最传神的细节
        Math.sin(t * Math.PI * 0.75) * 0.018 - Math.pow(Math.max(0, t - 0.72) / 0.28, 2.2) * 0.045,
        t * P.beakLen
      ));
    }
    const upperCurve = curveFrom(upperPts, 0.4);
    const upperGeo = tubeFromCurve(upperCurve, (t) => P.beakBase * (1 - t * 0.86) + 0.004, {
      segments: 40, radial: 14, flat: 0.34,
    });
    const upperMesh = new THREE.Mesh(upperGeo, this.materials.beakUpper);
    upperMesh.castShadow = true;
    this.beakUpper.add(upperMesh);
    this.geometries.push(upperGeo);

    // 上颌的鼻孔与喙脊
    const ridgePts = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      ridgePts.push(new THREE.Vector3(0, 0.008 + Math.sin(t * Math.PI * 0.75) * 0.018, t * P.beakLen * 0.98));
    }
    const ridge = tubeFromCurve(curveFrom(ridgePts), [0.012, 0.010, 0.008, 0.006, 0.005, 0.004, 0.003, 0.002, 0.0015], {
      segments: 20, radial: 6,
    });
    const ridgeMesh = new THREE.Mesh(ridge, this.materials.beakLower);
    this.beakUpper.add(ridgeMesh);
    this.geometries.push(ridge);

    // ---- 下颌：可开合 ----
    this.beakLower = new THREE.Group();
    this.beakLower.position.set(0, -0.014, 0.082);
    this.head.add(this.beakLower);
    this.bones.beakLower = this.beakLower;

    const lowerPts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      lowerPts.push(new THREE.Vector3(
        0,
        -Math.sin(t * Math.PI * 0.6) * 0.008 - t * t * 0.012,
        t * P.beakLen * 0.985
      ));
    }
    const lowerCurve = curveFrom(lowerPts, 0.4);
    const lowerGeo = tubeFromCurve(lowerCurve, (t) => P.beakBase * 0.82 * (1 - t * 0.82) + 0.004, {
      segments: 34, radial: 12, flat: 0.42,
    });
    const lowerMesh = new THREE.Mesh(lowerGeo, this.materials.beakLower);
    lowerMesh.castShadow = true;
    this.beakLower.add(lowerMesh);
    this.geometries.push(lowerGeo);

    // ---- 喉囊：鹈鹕最标志性的器官 ----
    // 做成一段「下坠的扁管」，沿下颌方向延伸并在中段鼓出。
    // 独立成一个 Group，方便按呼吸/颠簸做轻微形变。
    this.pouch = new THREE.Group();
    this.beakLower.add(this.pouch);

    const pouchPts = [];
    const pn = 10;
    for (let i = 0; i <= pn; i++) {
      const t = i / pn;
      // 下坠量：中段最深（像装了半袋鱼），两端收口
      const sag = Math.sin(t * Math.PI) * 0.085;
      pouchPts.push(new THREE.Vector3(
        0,
        -sag - t * t * 0.010,
        t * P.beakLen * 0.93
      ));
    }
    const pouchCurve = curveFrom(pouchPts, 0.5);
    const pouchGeo = tubeFromCurve(pouchCurve, (t) => {
      // 宽度剖面：根部窄、中段最宽、尖端收成尖
      const w = Math.sin(Math.pow(t, 0.85) * Math.PI);
      return [P.beakBase * 0.72 * (0.35 + w * 0.9), P.beakBase * 0.55 * (0.3 + w * 0.75)];
    }, {
      segments: 36, radial: 16, flat: -0.25,
    });
    const pouchMesh = new THREE.Mesh(pouchGeo, this.materials.pouch);
    pouchMesh.castShadow = true;
    this.pouch.add(pouchMesh);
    this.geometries.push(pouchGeo);
    this.pouchBasePositions = pouchGeo.attributes.position.array.slice();

    // 喉囊里的「收获」：几条隐约可见的鱼影，给一个微妙的内部轮廓
    const fishGeos = [];
    for (let i = 0; i < 3; i++) {
      const f = new THREE.SphereGeometry(0.028, 7, 5);
      f.scale(1.4, 0.6, 2.1);
      fishGeos.push(transformed(f, TRS(
        (i - 1) * 0.016, -0.028 - i * 0.008, P.beakLen * (0.34 + i * 0.12),
        -0.25, (i - 1) * 0.4, 0
      )));
      f.dispose();
    }
    const fishMat = new THREE.MeshStandardMaterial({ color: 0xc9903f, roughness: 0.5 });
    const pouchFish = new THREE.Mesh(mergeGeometries(fishGeos), fishMat);
    this.pouch.add(pouchFish);
    this.pouchFish = pouchFish;
    this.materials.pouchFish = fishMat;           // 纳入 dispose 清单
    this.geometries.push(pouchFish.geometry);
    fishGeos.forEach((g) => g.dispose());
  }

  /* ================================================================ *
   * 翅膀（兼作手臂）
   * ================================================================ */
  _buildWings() {
    this.wings = {};
    for (const sx of [-1, 1]) {
      const side = sx > 0 ? 'R' : 'L';
      const shoulder = new THREE.Group();
      shoulder.position.set(sx * P.shoulderSpread, 0.045, 0.075);
      this.body.add(shoulder);

      // 上臂（肩 → 肘），沿 -Y 建模
      const upper = new THREE.Group();
      shoulder.add(upper);

      // 前臂（肘 → 腕）
      const fore = new THREE.Group();
      fore.position.set(0, -P.upperArm, 0);
      upper.add(fore);

      // 掌骨（腕 → 指尖）
      const hand = new THREE.Group();
      hand.position.set(0, -P.foreArm, 0);
      fore.add(hand);

      // ---- 骨上的肌肉：上臂粗、前臂细 ----
      const boneGeos = [];
      const upperGeo = new THREE.CylinderGeometry(0.052, 0.062, P.upperArm * 1.05, 12);
      upperGeo.translate(0, -P.upperArm * 0.5, 0);
      boneGeos.push(upperGeo);
      const foreGeo = new THREE.CylinderGeometry(0.036, 0.05, P.foreArm * 1.05, 12);
      foreGeo.translate(0, -P.foreArm * 0.5, 0);
      boneGeos.push(foreGeo);
      // 腕关节球
      const wristGeo = new THREE.SphereGeometry(0.038, 10, 8);
      boneGeos.push(transformed(wristGeo, TRS(0, -P.foreArm, 0)));

      const fleshMesh = new THREE.Mesh(mergeGeometries(boneGeos), this.materials.body);
      fleshMesh.castShadow = true;
      upper.add(fleshMesh);
      boneGeos.forEach((g) => g.dispose());

      // ---- 次级飞羽：挂在前臂上，向后下方展开 ----
      const secondaries = [];
      const secCount = 12;
      for (let i = 0; i < secCount; i++) {
        const t = i / (secCount - 1);
        // 沿前臂分布，越靠腕越长
        const y = -t * P.foreArm * 0.92;
        const len = 0.10 + t * 0.09;
        const blade = featherBlade(len, 0.028, 0.012 + t * 0.015, 6);
        const m = TRS(
          sx * (0.010 + t * 0.014),
          y,
          -0.03 - t * 0.02,
          0,
          sx * (0.06 + t * 0.10),
          sx * 0.05
        );
        secondaries.push(transformed(blade, m));
        blade.dispose();
      }
      const secMesh = new THREE.Mesh(mergeGeometries(secondaries), this.materials.wingDark);
      secMesh.castShadow = true;
      secMesh.receiveShadow = true;
      fore.add(secMesh);
      secondaries.forEach((g) => g.dispose());

      /**
       * ---- 初级飞羽：挂在掌骨上，是整只鸟最长的羽毛 ----
       *
       * 两个容易踩的坑：
       *  · 长度：12 根 0.3~0.56m 的羽毛如果几乎共面，会糊成一块深色板子，
       *    而不是「一排羽毛」。收到 0.16~0.34m 后，轮廓才读得出羽片。
       *  · 扇形展开：每根羽毛的后掠角必须递增，羽尖才会像扇子一样散开。
       *    角度全一样的话，无论多少根都只会叠成一条线。
       */
      const primaries = [];
      const primCount = 11;
      for (let i = 0; i < primCount; i++) {
        const t = i / (primCount - 1);
        const len = 0.11 + Math.sin(t * Math.PI * 0.7) * 0.10;
        // 羽片沿 +Z 伸展、宽度沿 X。相邻羽片沿 Y 错开一点点，
        // 形成「一层压一层」的叠瓦效果，而不是全部糊在同一平面上。
        const blade = featherBlade(len, 0.030, 0.015 + t * 0.02, 6);
        const m = TRS(
          sx * (0.010 + t * 0.014),
          -0.02 - t * 0.048,
          -0.02,
          -0.05 - t * 0.04,        // 轻微下倾
          sx * (0.03 + t * 0.06),  // 沿羽轴的小扭转，让羽尖略散
          sx * 0.04
        );
        primaries.push(transformed(blade, m));
        blade.dispose();
      }
      // 初级飞羽挂在一个独立的分组上。
      // 不能直接放在 hand 下：hand 的朝向要服务于「掌心环住车把」，
      // 而飞羽的朝向要服务于「像披风一样向后收拢」，两者是矛盾的。
      // 拆成两个节点后，各自可以被独立地摆到正确姿态。
      const primGroup = new THREE.Group();
      hand.add(primGroup);
      const primMesh = new THREE.Mesh(mergeGeometries(primaries), this.materials.wingTip);
      primMesh.castShadow = true;
      primGroup.add(primMesh);
      primaries.forEach((g) => g.dispose());

      // ---- 掌部：抓住车把的「手」 ----
      const palmGeo = new THREE.SphereGeometry(0.046, 12, 10);
      palmGeo.scale(1.0, 0.85, 1.25);
      const palm = new THREE.Mesh(palmGeo, this.materials.body);
      palm.position.y = -P.handLen * 0.4;
      palm.castShadow = true;
      hand.add(palm);
      this.geometries.push(palmGeo);

      // 抓握的「手指」：三根短小的趾状结构，环住车把
      const fingers = [];
      for (let i = 0; i < 3; i++) {
        const a = (i - 1) * 0.75;
        const c = curveFrom([
          new THREE.Vector3(0, -P.handLen * 0.55, 0),
          new THREE.Vector3(Math.sin(a) * 0.028, -P.handLen * 0.8, 0.022),
          new THREE.Vector3(Math.sin(a) * 0.038, -P.handLen * 0.9, 0.048),
        ]);
        fingers.push(tubeFromCurve(c, [0.016, 0.013, 0.009], { segments: 10, radial: 7 }));
      }
      const fingerMesh = new THREE.Mesh(mergeGeometries(fingers), this.materials.legSkin);
      hand.add(fingerMesh);
      fingers.forEach((g) => g.dispose());

      this.wings[side] = { shoulder, upper, fore, hand, primGroup, sx };
    }
  }

  /* ================================================================ *
   * 腿：大腿 / 小腿 / 跗跖 / 蹼足
   * ================================================================ */
  _buildLegs() {
    this.legs = {};
    for (const sx of [-1, 1]) {
      const side = sx > 0 ? 'R' : 'L';

      // 髋（在躯干后下方）
      const hip = new THREE.Group();
      hip.position.set(sx * P.hipSpread, -0.075, -0.10);
      this.body.add(hip);

      // 大腿
      const thigh = new THREE.Group();
      hip.add(thigh);
      const thighGeo = new THREE.CylinderGeometry(0.048, 0.055, P.thigh * 1.08, 12);
      thighGeo.translate(0, -P.thigh * 0.5, 0);
      const thighMesh = new THREE.Mesh(thighGeo, this.materials.body);
      thighMesh.castShadow = true;
      thigh.add(thighMesh);
      this.geometries.push(thighGeo);

      // 膝盖球
      const knee = new THREE.SphereGeometry(0.046, 10, 8);
      const kneeMesh = new THREE.Mesh(knee, this.materials.legSkin);
      kneeMesh.position.y = -P.thigh;
      thigh.add(kneeMesh);
      this.geometries.push(knee);

      // 小腿（裸露的橙黄色皮肤）
      const shank = new THREE.Group();
      shank.position.y = -P.thigh;
      thigh.add(shank);
      const shankGeo = new THREE.CylinderGeometry(0.032, 0.042, P.shank * 1.06, 10);
      shankGeo.translate(0, -P.shank * 0.5, 0);
      const shankMesh = new THREE.Mesh(shankGeo, this.materials.legSkin);
      shankMesh.castShadow = true;
      shank.add(shankMesh);
      this.geometries.push(shankGeo);

      // 踝
      const ankle = new THREE.SphereGeometry(0.032, 10, 8);
      const ankleMesh = new THREE.Mesh(ankle, this.materials.legSkin);
      ankleMesh.position.y = -P.shank;
      shank.add(ankleMesh);
      this.geometries.push(ankle);

      // 跗跖（脚踝到脚掌的细杆）
      const tarsus = new THREE.Group();
      tarsus.position.y = -P.shank;
      shank.add(tarsus);
      const tarsusGeo = new THREE.CylinderGeometry(0.024, 0.028, P.tarsus, 9);
      tarsusGeo.translate(0, -P.tarsus * 0.5, 0);
      const tarsusMesh = new THREE.Mesh(tarsusGeo, this.materials.legSkin);
      tarsus.add(tarsusMesh);
      this.geometries.push(tarsusGeo);

      // 蹼足：三趾 + 蹼，踩在踏板上
      const foot = new THREE.Group();
      foot.position.y = -P.tarsus;
      tarsus.add(foot);

      const footGeos = [];
      const toeDirs = [-0.62, 0, 0.62];
      for (const a of toeDirs) {
        const c = curveFrom([
          new THREE.Vector3(0, 0, 0.005),
          new THREE.Vector3(Math.sin(a) * 0.03, -0.006, 0.045),
          new THREE.Vector3(Math.sin(a) * 0.055, -0.010, 0.085),
        ]);
        footGeos.push(tubeFromCurve(c, [0.020, 0.015, 0.010], { segments: 10, radial: 7 }));
      }
      // 蹼：三趾之间的薄膜，用扁平的三角面片
      for (let i = 0; i < 2; i++) {
        const a0 = toeDirs[i], a1 = toeDirs[i + 1];
        const webPts = [];
        const wSeg = 5;
        for (let k = 0; k <= wSeg; k++) {
          const t = k / wSeg;
          const ax = Math.sin(a0) * 0.055 * t, az = 0.085 * t;
          const bx = Math.sin(a1) * 0.055 * t, bz = 0.085 * t;
          webPts.push(new THREE.Vector3(ax, -0.011 * t, az));
          webPts.push(new THREE.Vector3(bx, -0.011 * t, bz));
        }
        const wpos = [], wuv = [], widx = [];
        for (let k = 0; k <= wSeg; k++) {
          const t = k / wSeg;
          wpos.push(webPts[k * 2].x, webPts[k * 2].y, webPts[k * 2].z);
          wpos.push(webPts[k * 2 + 1].x, webPts[k * 2 + 1].y, webPts[k * 2 + 1].z);
          wuv.push(0, t, 1, t);
        }
        for (let k = 0; k < wSeg; k++) {
          const p = k * 2;
          widx.push(p, p + 2, p + 1, p + 1, p + 2, p + 3);
        }
        const wg = new THREE.BufferGeometry();
        wg.setAttribute('position', new THREE.Float32BufferAttribute(wpos, 3));
        wg.setAttribute('uv', new THREE.Float32BufferAttribute(wuv, 2));
        wg.setIndex(widx);
        wg.computeVertexNormals();
        footGeos.push(wg);
      }
      const footMesh = new THREE.Mesh(mergeGeometries(footGeos), this.materials.foot);
      footMesh.castShadow = true;
      foot.add(footMesh);
      footGeos.forEach((g) => g.dispose());

      this.legs[side] = { hip, thigh, shank, tarsus, foot, sx };
    }
  }

  /* ================================================================ *
   * 尾羽
   * ================================================================ */
  _buildTail() {
    this.tail = new THREE.Group();
    this.tail.position.set(0, -0.02, -P.torsoLen * 0.42);
    this.body.add(this.tail);

    const feathers = [];
    for (let i = 0; i < 9; i++) {
      const t = (i / 8) * 2 - 1;
      const len = 0.24 + (1 - Math.abs(t)) * 0.10;
      const c = curveFrom([
        new THREE.Vector3(0, 0, -0.01),
        new THREE.Vector3(t * 0.035, -0.02 - Math.abs(t) * 0.015, -len * 0.5),
        new THREE.Vector3(t * 0.07, -0.05 - Math.abs(t) * 0.03, -len),
      ]);
      feathers.push(tubeFromCurve(c, [0.026, 0.020, 0.010, 0.003], {
        segments: 14, radial: 6, flat: 0.85,
      }));
    }
    const tailMesh = new THREE.Mesh(mergeGeometries(feathers), this.materials.bodyShade);
    tailMesh.castShadow = true;
    this.tail.add(tailMesh);
    feathers.forEach((g) => g.dispose());
  }

  /* ================================================================ *
   * 小船长帽（一点点角色性格）
   * ================================================================ */
  _buildCap() {
    const cap = new THREE.Group();
    cap.position.set(0, P.headRadius * 0.72, -0.02);
    cap.rotation.x = -0.18;
    this.head.add(cap);
    this.cap = cap;

    const crown = new THREE.SphereGeometry(0.072, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55);
    crown.scale(1.0, 0.72, 1.05);
    const crownMesh = new THREE.Mesh(crown, this.materials.cap);
    crownMesh.castShadow = true;
    cap.add(crownMesh);
    this.geometries.push(crown);

    const band = new THREE.TorusGeometry(0.0705, 0.0075, 6, 24);
    band.rotateX(Math.PI / 2);
    const bandMesh = new THREE.Mesh(band, this.materials.capBand);
    bandMesh.position.y = 0.006;
    cap.add(bandMesh);
    this.geometries.push(band);

    // 帽檐
    const brimGeo = new THREE.CylinderGeometry(0.095, 0.095, 0.006, 20, 1, false, -Math.PI * 0.42, Math.PI * 0.84);
    brimGeo.scale(1.0, 1.0, 1.25);
    const brim = new THREE.Mesh(brimGeo, this.materials.cap);
    brim.position.set(0, -0.004, 0.028);
    brim.rotation.x = 0.22;
    cap.add(brim);
    this.geometries.push(brimGeo);

    // 帽徽
    const badge = new THREE.CircleGeometry(0.014, 12);
    const badgeMesh = new THREE.Mesh(badge, this.materials.capBand);
    badgeMesh.position.set(0, 0.028, 0.070);
    badgeMesh.rotation.x = -0.25;
    cap.add(badgeMesh);
    this.geometries.push(badge);
  }

  /* ================================================================ *
   * 羽毛锚点：把实例化羽毛挂到骨骼上
   * ================================================================ */
  _buildFeatherAnchors() {
    const rnd = mulberryLocal(9182);

    /**
     * 在骨骼上挂一个羽毛锚点。
     *
     * 朝向是这里唯一需要动脑子的地方。羽毛的几何约定是
     * 「沿 +Y 生长、羽面法线沿 +Z」。如果直接把 +Y 对齐表面外法线，
     * 每片羽毛都会垂直于皮肤立着，整只鸟会变成一只海胆 ——
     * 这是最初版本的错误。
     *
     * 真实的廓羽是**贴伏**的：羽根在皮肤上，羽尖沿体表向后倒，
     * 像屋瓦一样层层叠压。所以生长方向取
     *     生长 = normalize(体表切向（向后） + 0.45 × 外法线)
     * 让羽毛贴着体表、只微微翘起；同时把羽面法线对齐外法线，
     * 于是羽面与皮肤平行，看起来才像「一层羽毛」而不是「一堆针」。
     *
     * @param {THREE.Vector3} grow  生长方向（骨骼局部空间）
     * @param {THREE.Vector3} face  羽面法线（骨骼局部空间）
     */
    const _up = new THREE.Vector3(0, 1, 0);
    const _grow = new THREE.Vector3();
    const _face = new THREE.Vector3();
    const _x = new THREE.Vector3();
    const _basis = new THREE.Matrix4();

    const push = (bone, local, scale, kind, tint, grow = null, face = null) => {
      const o = new THREE.Object3D();
      o.position.copy(local);
      if (grow && grow.lengthSq() > 1e-8) {
        _grow.copy(grow).normalize();
        _face.copy(face || grow);
        // 把羽面法线投影到与生长方向垂直的平面上，得到正交基
        _face.addScaledVector(_grow, -_face.dot(_grow));
        if (_face.lengthSq() < 1e-8) _face.set(0, 0, 1).addScaledVector(_grow, -_grow.z);
        _face.normalize();
        _x.crossVectors(_grow, _face).normalize();
        // 绕生长轴随机自转 —— 这是「同一处羽毛不整齐划一」的来源
        const spin = (rnd() - 0.5) * 0.85;
        const cs = Math.cos(spin), sn = Math.sin(spin);
        const fx = _face.x * cs + _x.x * sn, fy = _face.y * cs + _x.y * sn, fz = _face.z * cs + _x.z * sn;
        _x.set(_face.x * -sn + _x.x * cs, _face.y * -sn + _x.y * cs, _face.z * -sn + _x.z * cs);
        _face.set(fx, fy, fz);
        _basis.makeBasis(_x, _grow, _face);
        o.quaternion.setFromRotationMatrix(_basis);
      } else {
        o.quaternion.setFromUnitVectors(_up, _up);
        o.rotateY(rnd() * Math.PI * 2);
        o.rotateX((rnd() - 0.5) * 0.5);
      }
      o.scale.setScalar(scale);
      bone.add(o);
      this.featherAnchors.push({ object: o, kind, tint, seed: rnd() });
    };

    const n = this.quality === 'low' ? 0.4 : this.quality === 'medium' ? 0.72 : 1.0;
    // 密度倍数：羽毛是这只鸟唯一「有质感」的部分，值得多花一点预算
    const D = this.quality === 'low' ? 0.45 : this.quality === 'medium' ? 0.75 : 1.0;

    // ---- 躯干绒羽：在椭球表面按面积均匀撒点 ----
    const bodyCount = Math.floor(1900 * D);
    for (let i = 0; i < bodyCount; i++) {
      // 球面均匀采样（Fibonacci 球）
      const k = i + 0.5;
      const phi = Math.acos(1 - 2 * k / bodyCount);
      const theta = Math.PI * (1 + Math.sqrt(5)) * k;
      const dir = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta)
      );
      // 贴到椭球表面（略外扩，避免与躯干几何 z-fighting）
      const local = new THREE.Vector3(
        dir.x * P.torsoWidth * 0.5 * 1.05,
        dir.y * P.torsoHeight * 0.5 * 1.05,
        dir.z * P.torsoLen * 0.5 * 1.05
      );
      // 椭球表面法线：对 (x/a, y/b, z/c) 归一化
      const surfNormal = new THREE.Vector3(
        dir.x / (P.torsoWidth * 0.5),
        dir.y / (P.torsoHeight * 0.5),
        dir.z / (P.torsoLen * 0.5)
      ).normalize();
      // 生长方向 = 向后倒（-Z）+ 少量外翘，做出「屋瓦叠压」的贴伏感
      const grow = new THREE.Vector3(0, 0, -1)
        .addScaledVector(surfNormal, 0.45)
        .normalize();
      // 背部羽毛更密更长，胸腹更短 —— 符合鸟类解剖
      const back = THREE.MathUtils.clamp(dir.y, 0, 1);
      const scale = (0.62 + back * 0.72) * (0.8 + rnd() * 0.42);
      const tint = 0.66 + rnd() * 0.46;
      push(this.body, local, scale, back > 0.25 ? 'body' : 'down', tint, grow, surfNormal);
    }

    // ---- 颈部绒羽：沿骨链分布 ----
    for (let i = 0; i < this.neckSegs.length; i++) {
      const seg = this.neckSegs[i];
      const t = i / (this.neckSegs.length - 1);
      const segLen = P.neckLen / P.neckSegments;
      const count = Math.floor(34 * D);
      for (let j = 0; j < count; j++) {
        const a = rnd() * Math.PI * 2;
        const r = 0.055 * (1 - t * 0.3) + 0.004;
        const local = new THREE.Vector3(
          Math.cos(a) * r, segLen * rnd(), Math.sin(a) * r
        );
        const nrm = new THREE.Vector3(Math.cos(a), 0.1, Math.sin(a)).normalize();
        // 颈羽沿颈部向下贴伏（颈部骨骼的 +Y 指向头部，所以「向下」是 -Y）
        const grow = new THREE.Vector3(0, -1, 0).addScaledVector(nrm, 0.5).normalize();
        push(seg, local, (0.52 + rnd() * 0.36), 'down', 0.78 + rnd() * 0.22, grow, nrm);
      }
    }

    // ---- 头顶与后脑的短羽 ----
    for (let i = 0; i < Math.floor(60 * D); i++) {
      const a = rnd() * Math.PI * 2;
      const r = P.headRadius * 0.92;
      const local = new THREE.Vector3(
        Math.cos(a) * r * 0.9,
        P.headRadius * 0.45 + rnd() * 0.02,
        -P.headRadius * 0.7 + Math.sin(a) * r * 0.4
      );
      const nrm = new THREE.Vector3(0.2, 1.0, -0.5).normalize();
      const grow = new THREE.Vector3(0, -0.2, -1).addScaledVector(nrm, 0.5).normalize();
      push(this.head, local, 0.48 + rnd() * 0.32, 'down', 0.7 + rnd() * 0.3, grow, nrm);
    }

    // ---- 翅膀覆羽：沿上臂/前臂分布，形成「披风」的层次 ----
    for (const side of ['L', 'R']) {
      const w = this.wings[side];
      const count = Math.floor(240 * D);
      for (let i = 0; i < count; i++) {
        const along = rnd();
        const a = rnd() * Math.PI * 2;
        const r = 0.055 - along * 0.018;
        const local = new THREE.Vector3(
          Math.cos(a) * r,
          -along * P.upperArm * 0.96,
          Math.sin(a) * r
        );
        // 外侧（远离身体）羽毛更长，形成厚度
        const outward = Math.abs(Math.cos(a)) * 0.5 + 0.5;
        const nrm = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).normalize();
        // 翼羽沿翅膀向后倒伏（翅膀骨骼的 +Y 指向肩部，所以「向后」是 +Y 方向）
        const grow = new THREE.Vector3(0, 1, 0).addScaledVector(nrm, 0.55).normalize();
        push(w.upper, local, (0.62 + outward * 0.80) * (0.8 + rnd() * 0.45), 'wing',
          0.62 + rnd() * 0.3, grow, nrm);
      }
      const fcount = Math.floor(190 * D);
      for (let i = 0; i < fcount; i++) {
        const along = rnd();
        const a = rnd() * Math.PI * 2;
        const r = 0.042 - along * 0.012;
        const local = new THREE.Vector3(
          Math.cos(a) * r,
          -along * P.foreArm * 0.96,
          Math.sin(a) * r
        );
        const nrm = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).normalize();
        const grow = new THREE.Vector3(0, 1, 0).addScaledVector(nrm, 0.5).normalize();
        push(w.fore, local, 0.52 + rnd() * 0.42, 'wing',
          0.55 + rnd() * 0.32, grow, nrm);
      }
    }

    // ---- 尾羽根部：沿尾羽方向（-Z）生长 ----
    for (let i = 0; i < Math.floor(70 * D); i++) {
      const t = (rnd() * 2 - 1);
      const nrm = new THREE.Vector3(0, 0.6, 0.5).normalize();
      const grow = new THREE.Vector3(0, 0, -1).addScaledVector(nrm, 0.4).normalize();
      push(this.tail, new THREE.Vector3(t * 0.05, rnd() * 0.02, -rnd() * 0.05),
        0.58 + rnd() * 0.4, 'down', 0.66 + rnd() * 0.3, grow, nrm);
    }
  }

  /* ================================================================ *
   * 每帧更新
   * ================================================================ */

  /**
   * @param {number} dt
   * @param {object} p
   *   p.time        全局时间
   *   p.speed       骑行速度 (m/s)
   *   p.cadence     踏频 (rpm)
   *   p.crankPhase  曲柄相位 (rad)
   *   p.lean        车身侧倾
   *   p.gripL/gripR 把手世界坐标（Vector3）
   *   p.pedalL/pedalR 踏板世界坐标（Vector3）
   *   p.bump        颠簸强度 0..1
   *   p.wind        风强 0..1
   */
  update(dt, p) {
    const t = p.time ?? 0;
    const speed = p.speed ?? 0;
    const A = this.anim;

    // IK 全在世界空间解算，先取一次自身的朝向轴
    this._updateWorldAxes();

    /* ---------- 1. 呼吸与颠簸 ---------- */
    A.breath += dt * (1.15 + speed * 0.045);
    A.pouchJiggle += dt * (2.2 + speed * 0.4);
    const bump = p.bump ?? 0;

    // 躯干：呼吸起伏 + 路面颠簸 + 高速时的前倾
    const breathY = Math.sin(A.breath * 2.0) * 0.008;
    const breathS = 1 + Math.sin(A.breath * 2.0) * 0.012;
    const leanForward = THREE.MathUtils.clamp(speed / 16, 0, 1) * 0.16;
    const bumpY = Math.sin(t * 17.3) * bump * 0.012 + Math.sin(t * 26.1) * bump * 0.006;

    this.body.position.y = P.bodyLift + breathY + bumpY;
    this.body.position.z = 0.01 - leanForward * 0.06;
    this.body.rotation.x = leanForward * 0.55 + Math.sin(t * 19.0) * bump * 0.02;
    this.body.rotation.z = Math.sin(t * 6.3) * 0.012 * (1 + speed * 0.05);
    this.body.scale.set(breathS, 2 - breathS, breathS);

    /* ---------- 2. 颈部：S 形随速度拉直，并做惯性摆动 ---------- */
    // 速度越快，身体越前倾、颈部越前伸（鸟类奔跑时的典型姿态）
    const neckStretch = THREE.MathUtils.clamp(speed / 14, 0, 1);
    A.neckSway += dt * (0.9 + speed * 0.06);

    for (let i = 0; i < this.neckSegs.length; i++) {
      const seg = this.neckSegs[i];
      const tN = i / (this.neckSegs.length - 1);
      // 静息 S 曲线 + 速度带来的前伸 + 低频摆动
      // 速度越快，颈部越向前伸直（鸟类加速时的典型姿态）
      const stretch = this.neckRest[i] * (1 - neckStretch * 0.35);
      const sway = Math.sin(A.neckSway * 1.3 - tN * 1.6) * (0.045 + neckStretch * 0.05);
      const bumpTwist = Math.sin(t * 14.0 - tN * 2.2) * bump * 0.035;
      seg.rotation.x = stretch + sway + bumpTwist;
      seg.rotation.z = Math.sin(A.neckSway * 0.8 - tN * 2.0) * 0.03;
      seg.rotation.y = Math.sin(A.neckSway * 0.55 - tN * 1.2) * 0.05;
    }

    /* ---------- 3. 头部：稳定器效应（眼睛尽量保持水平）---------- */
    // 真实鸟类头部非常稳定，这里反相抵消颈部的摆动
    const headStab = -Math.sin(A.neckSway * 1.3 - 1.6) * (0.05 + neckStretch * 0.04);
    A.headBob = headStab;
    this.head.rotation.x = this.headPitchBase + headStab
      + neckStretch * 0.12                       // 高速时抬头看路
      + Math.sin(t * 9.0) * bump * 0.03;
    this.head.rotation.y = Math.sin(A.neckSway * 0.42) * 0.09;
    this.head.rotation.z = Math.sin(A.neckSway * 0.63) * 0.05;

    /* ---------- 4. 喙与喉囊 ---------- */
    // 高速时喙微微张开喘气，喉囊随之晃动
    const gape = THREE.MathUtils.clamp(speed / 12, 0, 1) * 0.09
      + Math.max(0, Math.sin(t * 0.7)) * 0.03 * (1 - neckStretch * 0.6);
    // 合嘴动画：先张大（0→0.35 rad），再猛地合上
    A.snap = Math.max(0, A.snap - dt * 3.2);
    const snapOpen = A.snap > 0.5 ? (1 - A.snap) * 2 : A.snap * 2;
    this.beakLower.rotation.x = gape + snapOpen * 0.38;

    // 喉囊鼓起：鱼越多越往下坠、越宽。用 Group 缩放实现，不碰几何。
    // 弹簧式逼近 —— 接到鱼时会「咕咚」一下过冲再回落，看得出分量。
    const k = 60, damp = 9;
    A.pouchVel = (A.pouchVel || 0) + ((A.pouchTarget - A.pouchFill) * k - (A.pouchVel || 0) * damp) * Math.min(dt, 0.05);
    A.pouchFill += A.pouchVel * Math.min(dt, 0.05);
    const f = Math.max(0, A.pouchFill);
    this.pouch.scale.set(1 + f * 0.75, 1 + f * 1.55, 1 + f * 0.06);
    this.pouch.position.y = -f * 0.012;
    if (this.pouchFish) {
      this.pouchFish.visible = f > 0.05 || (A.pouchTarget === 0 && A.idleFish !== false);
      this.pouchFish.scale.setScalar(0.8 + f * 0.5);
    }

    // 喉囊抖动：用正弦驱动几何的顶点位移 —— 每帧只改 y 分量，代价很低
    this._jigglePouch(A.pouchJiggle, speed, bump);

    /* ---------- 5. 眨眼 ---------- */
    A.blinkTimer -= dt;
    if (A.blinkTimer <= 0) {
      A.blinkTimer = 1.6 + Math.random() * 3.4;
      A.blink = 1;
    }
    A.blink = Math.max(0, A.blink - dt * 5.5);
    // 用 easeOut 让闭合快、张开慢
    const blinkEase = A.blink * A.blink * (3 - 2 * A.blink);
    for (const e of this.eyes) {
      e.lid.rotation.x = Math.PI - blinkEase * Math.PI * 0.92;
    }

    /* ---------- 6. 翅膀：IK 抓住车把 ---------- */
    this._poseArms(p, t, speed, bump);

    /* ---------- 7. 腿：IK 踩踏板 ---------- */
    this._poseLegs(p, t, speed, bump);

    /* ---------- 8. 尾羽：随风摆动 ---------- */
    A.tailSway += dt * (1.4 + speed * 0.12);
    this.tail.rotation.x = -0.12 - Math.sin(A.tailSway * 1.1) * 0.06 - speed * 0.004;
    this.tail.rotation.y = Math.sin(A.tailSway * 0.9) * 0.09;
    this.tail.rotation.z = Math.sin(A.tailSway * 1.35) * 0.05;
  }

  /** 喉囊的顶点抖动：只修改 y，避免每帧重建法线（视觉上够用） */
  _jigglePouch(time, speed, bump) {
    const geo = this.pouch.children[0]?.geometry;
    if (!geo || !this.pouchBasePositions) return;
    const pos = geo.attributes.position;
    const base = this.pouchBasePositions;
    const amp = 0.006 + speed * 0.0012 + bump * 0.008;
    const freq = 3.1 + speed * 0.12;

    for (let i = 0; i < pos.count; i++) {
      const bx = base[i * 3], by = base[i * 3 + 1], bz = base[i * 3 + 2];
      // 越靠喉囊底部抖动越明显
      const depth = THREE.MathUtils.clamp(-by / 0.09, 0, 1);
      const w = Math.sin(time * freq + bz * 9.0 + bx * 12.0) * amp * (0.25 + depth);
      pos.setY(i, by + w);
    }
    pos.needsUpdate = true;
    geo.computeBoundingSphere();
  }

  /** 每帧取一次鹈鹕自身的世界朝向轴，供 IK 的极向量与脚掌朝向使用 */
  _updateWorldAxes() {
    this.root.updateWorldMatrix(true, false);
    this.root.matrixWorld.decompose(_wpos, this._rootQ, _wscale);
    this._fwd.set(0, 0, 1).applyQuaternion(this._rootQ);
    this._up.set(0, 1, 0).applyQuaternion(this._rootQ);
    this._side.set(1, 0, 0).applyQuaternion(this._rootQ);
  }

  /**
   * 手臂 IK：肩 → 肘 → 腕，腕落在车把上。
   *
   * 全流程在世界空间完成：世界空间里「把手在哪」是唯一确定的，
   * 不必在层层嵌套的局部坐标系之间反复推导，也不会因为车身俯仰/侧倾而失效。
   */
  _poseArms(p, time, speed, bump) {
    const fwd = this._fwd, up = this._up, side = this._side;

    for (const s of ['L', 'R']) {
      const target = s === 'L' ? p.gripL : p.gripR;
      if (!target) continue;
      const w = this.wings[s];

      // 肩膀的世界坐标
      w.shoulder.updateWorldMatrix(true, false);
      const shoulderW = this._shoulderW.setFromMatrixPosition(w.shoulder.matrixWorld);

      // 掌部要够到把手，所以第二段骨长按「前臂 + 掌长」估
      const reach2 = P.foreArm + P.handLen * 0.85;

      // 肘部朝外下方后侧弯 —— 骑车人的典型姿态
      const pole = this._pole
        .copy(side).multiplyScalar(w.sx * 0.9)
        .addScaledVector(fwd, -0.55)
        .addScaledVector(up, -0.30)
        .normalize();

      const elbow = solveTwoBoneIK(shoulderW, target, P.upperArm, reach2, pole, this._elbow);

      aimWorld(w.upper, this._d1.subVectors(elbow, shoulderW));
      aimWorld(w.fore, this._d2.subVectors(target, elbow));

      // 手掌环住车把。
      //
      // 注意这里的取反：orientWorld 设定的是骨骼的**局部 +Y**，
      // 而所有肢体骨都沿局部 -Y 建模（掌心和手指都在 -Y 方向）。
      // 所以要让手掌「伸向车把」，必须把 +Y 指向肘部、也就是 -(目标-肘)。
      // 忘了取反的话，手会朝后翻转 180°，翅膀上的初级飞羽会整片垂到车架下面。
      orientWorld(w.hand, this._d3.subVectors(elbow, target), up);

      // 高速时翅膀微微张开（滑翔本能），让披风飘起来
      const flare = THREE.MathUtils.clamp(speed / 18, 0, 1);
      w.upper.rotateZ(-w.sx * (0.10 + flare * 0.16));
      w.fore.rotateZ(w.sx * 0.06);
      // 颠簸时手腕略松
      w.hand.rotateX(Math.sin(time * 12.0 + (s === 'L' ? 0 : 1.7)) * bump * 0.06);

      // 初级飞羽：向后收拢成披风。
      //
      // 这里的轴向判断不能想当然 —— 初级飞羽的几何是沿**局部 +Z**
      // 伸展（长度 0.16~0.34m），沿 -Y 只走 0.08m 用于错开叠放，
      // 所以主导轴是 Z 而不是 Y。
      // 收拢的翅膀，飞羽应该从掌部向**后**拖到尾羽方向，
      // 因此局部 +Z 要指向骑行方向的反向。
      // 局部 +Y 负责「一排羽毛如何叠放」，指向斜上方最自然。
      // 速度越快，飞羽越向后下方张开，制造「疾风中的披风」感。
      // 收拢的翅膀从侧面看是什么样？—— 一捆长羽从腕部沿体侧**向后**平铺，
      // 层层向外叠放，末端拖到尾羽附近。不是竖着的梳子，也不是展开的扇面。
      //
      // 所以两个轴分别是：
      //   羽尖方向（局部 +Z）= 向后 + 略微下压
      //   叠放方向（局部 +Y）= 向外（左右各自朝身体外侧）
      // 这样侧视时看到的是「一捆向后拖的长羽」，正是折叠翼的样子。
      const fan = 0.10 + flare * 0.30;
      const growAxis = this._d1.copy(side).multiplyScalar(w.sx)
        .addScaledVector(up, -0.18)
        .normalize();
      const sweepAxis = this._d2.copy(fwd).multiplyScalar(-1)
        .addScaledVector(up, -0.12 - fan * 0.30)
        .normalize();
      orientWorld(w.primGroup, growAxis, sweepAxis);
    }
  }

  /**
   * 腿部 IK：髋 → 膝 → 踝 → 跗跖 → 蹼足，脚掌落在踏板上。
   *
   * 用「两段 IK + 一段定长跗跖」还原鸟类后肢的折线结构：
   * 膝盖朝前、踝关节朝后，形成标志性的「反关节」轮廓。
   * 如果只用一根直线连到踏板，看起来就会像根木棍。
   */
  _poseLegs(p, t, speed, bump) {
    const fwd = this._fwd, up = this._up, side = this._side;
    const phase = p.crankPhase ?? 0;

    for (const s of ['L', 'R']) {
      const pedal = s === 'L' ? p.pedalL : p.pedalR;
      if (!pedal) continue;
      const leg = this.legs[s];

      leg.hip.updateWorldMatrix(true, false);
      const hipW = this._hipW.setFromMatrixPosition(leg.hip.matrixWorld);

      // 踝关节：位于踏板的后上方，与踏板相距恰好一个跗跖长度
      const ankle = this._ankle
        .copy(pedal)
        .addScaledVector(fwd, -0.35 * P.tarsus)
        .addScaledVector(up, 0.55 * P.tarsus);

      // 第一段 IK：髋 → 膝 → 踝
      const pole = this._pole
        .copy(fwd)
        .addScaledVector(side, leg.sx * 0.42)
        .addScaledVector(up, 0.10)
        .normalize();
      const knee = solveTwoBoneIK(hipW, ankle, P.thigh, P.shank, pole, this._knee);

      aimWorld(leg.thigh, this._d1.subVectors(knee, hipW));
      aimWorld(leg.shank, this._d2.subVectors(ankle, knee));
      // 第二段：跗跖从踝指向踏板（此时跗跖的起点已被上一句带到踝的位置）
      aimWorld(leg.tarsus, this._d3.subVectors(pedal, ankle));

      // 蹼足平贴踏板。
      // 与手掌同理：脚趾长在骨骼的 -Y 方向，所以要把 +Y 朝上、脚趾自然朝下，
      // 而脚掌的「前方」由 +Z 给出 —— 于是脚背贴踏板、趾尖朝前。
      orientWorld(leg.foot, up, fwd);
      // 随踏频做一点踩踏的俯仰，像是在发力
      const push = Math.sin(phase + (s === 'L' ? 0 : Math.PI));
      leg.foot.rotateX(-push * 0.16);
      // 颠簸时脚踝略紧
      leg.tarsus.rotateZ(Math.sin(t * 12.0 + (s === 'L' ? 0 : 2.1)) * bump * 0.05);
    }
  }

  /**
   * 取眼睛的世界矩阵（供 POV 机位使用）。
   *
   * 不要用「头骨矩阵 + 一个偏移」去估眼睛位置 —— 头部骨骼的局部轴
   * 会被颈部那一串旋转带偏，偏移量在局部空间里是对的，
   * 到了世界空间就跑到脸颊外面去了。
   * 直接读眼睛节点的 matrixWorld 才是可靠的。
   */
  getEyeWorld(out) {
    const eye = this.eyes[1] || this.eyes[0];
    eye.group.updateWorldMatrix(true, false);
    return out.copy(eye.group.matrixWorld);
  }

  /** 喉囊装载量 0..1（由游戏逻辑每帧设置） */
  setPouchFill(f, idleFish = true) {
    this.anim.pouchTarget = THREE.MathUtils.clamp(f, 0, 1);
    this.anim.idleFish = idleFish;   // 观光模式保留原来喉囊里隐约的鱼影；游戏里空囊就是空的
  }

  /** 合嘴一下（接到鱼 / 送鱼） */
  snap() { this.anim.snap = 1; }

  /** 把鹈鹕放在鞍座上（世界坐标） */
  placeAt(worldPos, yaw, pitch, roll) {
    this.root.position.copy(worldPos);
    this.root.rotation.set(pitch ?? 0, yaw ?? 0, roll ?? 0, 'YXZ');
  }

  setShadows(enabled) {
    this.root.traverse((o) => { if (o.isMesh) o.castShadow = enabled; });
  }

  dispose() {
    this.geometries.forEach((g) => g.dispose());
    Object.values(this.materials).forEach((m) => m.dispose());
  }
}

/* 局部随机数（避免污染全局种子） */
function mulberryLocal(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { P as PELICAN };
