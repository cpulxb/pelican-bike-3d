/**
 * bike.js —— 自行车的程序化建模与运动学
 *
 * 整辆车由曲线扫掠 + 基本体组合而成，没有任何模型文件：
 *   · 车架管    CatmullRom 曲线 → tubeFromCurve，管径沿长度渐变
 *   · 车轮      轮圈（闭合管）+ 辐条 + 轮胎（圆环体）
 *   · 传动      牙盘 / 飞轮 / 链条（闭合曲线扫掠）/ 曲柄 / 踏板
 *   · 转向      前叉、车把、车铃挂在「转向组」下，绕头管轴线旋转
 *
 * 运动学对外暴露三件事，供鹈鹕绑定：
 *   1. 鞍座的世界位置      → 鹈鹕坐姿
 *   2. 车把两端的把手位置  → 翅膀搭上去
 *   3. 左右踏板的世界位置  → 脚掌 IK 目标
 *
 * 局部坐标约定：+Z 为前进方向，+Y 向上，原点在地面投影点。
 */

import * as THREE from 'three';
import { tubeFromCurve, curveFrom, mergeGeometries, TRS, transformed } from '../util/geometry.js';

export const BIKE = {
  wheelRadius: 0.345,
  tireWidth: 0.055,
  rearHub: new THREE.Vector3(0, 0.345, -0.545),
  frontHub: new THREE.Vector3(0, 0.345, 0.545),
  bottomBracket: new THREE.Vector3(0, 0.285, 0.015),
  seatTop: new THREE.Vector3(0, 0.895, -0.175),
  headTop: new THREE.Vector3(0, 0.985, 0.455),
  headBottom: new THREE.Vector3(0, 0.815, 0.525),
  crankLength: 0.165,
  chainringRadius: 0.105,
  cogRadius: 0.045,
  steerMax: 0.55,          // 最大转向角（弧度）
  wheelbase: 1.09,
};

const COL = {
  frame: 0x1d6b6b,          // 深青绿车架
  frameAccent: 0xd9a441,    // 金色装饰
  chrome: 0xc9cdd2,
  rubber: 0x191b1e,
  leather: 0x6b4526,
  bell: 0xd9a441,
  basket: 0xa9834e,
};

export class Bike {
  constructor(env) {
    this.env = env;
    this.root = new THREE.Group();
    this.root.name = 'Bike';

    this.materials = {};
    this.geometries = [];

    /** 运动状态（由 Controller 每帧写入） */
    this.state = {
      wheelAngle: 0,
      crankAngle: 0,
      steer: 0,
      lean: 0,           // 车身侧倾（压弯）
      pitch: 0,          // 上下坡俯仰
      speed: 0,
      bellRing: 0,
    };

    this._buildMaterials();
    this._buildFrame();
    this._buildWheels();
    this._buildDrivetrain();
    this._buildSteering();
    this._buildDetails();

    // 车身整体（不含前叉转向部分）随地形俯仰/侧倾
    this.bodyPivot = new THREE.Group();
    this.bodyPivot.name = 'BodyPivot';
    // 把已建好的内容搬进 pivot
    while (this.root.children.length) this.bodyPivot.add(this.root.children[0]);
    this.root.add(this.bodyPivot);

    // 临时向量，避免每帧分配
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
  }

  /* ================================================================ *
   * 材质
   * ================================================================ */
  _buildMaterials() {
    const M = this.materials;
    M.frame = new THREE.MeshStandardMaterial({ color: COL.frame, roughness: 0.24, metalness: 0.62 });
    M.accent = new THREE.MeshStandardMaterial({ color: COL.frameAccent, roughness: 0.22, metalness: 0.85 });
    M.chrome = new THREE.MeshStandardMaterial({ color: COL.chrome, roughness: 0.14, metalness: 0.96 });
    M.darkChrome = new THREE.MeshStandardMaterial({ color: 0x8b9096, roughness: 0.3, metalness: 0.9 });
    M.rubber = new THREE.MeshStandardMaterial({ color: COL.rubber, roughness: 0.92, metalness: 0.0 });
    M.leather = new THREE.MeshStandardMaterial({ color: COL.leather, roughness: 0.72, metalness: 0.03 });
    M.bell = new THREE.MeshStandardMaterial({ color: COL.bell, roughness: 0.18, metalness: 0.95 });
    M.basket = new THREE.MeshStandardMaterial({ color: COL.basket, roughness: 0.86, metalness: 0.0 });
    M.glass = new THREE.MeshPhysicalMaterial({
      color: 0xfff2d8, roughness: 0.06, metalness: 0.0,
      transmission: 0.85, thickness: 0.04, ior: 1.45,
    });
    M.lamp = new THREE.MeshStandardMaterial({
      color: 0xfff0c0, roughness: 0.2, metalness: 0.1,
      emissive: 0xffcc66, emissiveIntensity: 0.6,
    });
  }

  /* ================================================================ *
   * 车架
   * ================================================================ */
  _buildFrame() {
    const B = BIKE;
    const geos = [];

    /** 便捷：两点之间的直线管，带半径剖面 */
    const strut = (a, b, r0, r1 = r0, opts = {}) => {
      const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
      // 略微外凸，让管件有轻微弧度（比绝对笔直更耐看）
      const dir = new THREE.Vector3().subVectors(b, a).normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const side = new THREE.Vector3().crossVectors(dir, up).normalize();
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      const bow = opts.bow ?? 0.0;
      const ctrl = opts.bowAxis === 'side' ? side : up;
      const p1 = new THREE.Vector3().lerpVectors(a, mid, 0.5).addScaledVector(ctrl, bow);
      const p2 = new THREE.Vector3().lerpVectors(mid, b, 0.5).addScaledVector(ctrl, bow);
      const curve = curveFrom([a, p1, mid, p2, b]);
      const g = tubeFromCurve(curve, [r0, r0 * 1.03, r0 * 1.03, r0 * 0.98, r1], {
        segments: opts.segments ?? 26, radial: opts.radial ?? 12,
      });
      geos.push(g);
      return g;
    };

    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const bb = B.bottomBracket;
    const st = B.seatTop;
    const ht = B.headTop;
    const hb = B.headBottom;
    const rh = B.rearHub;
    const fh = B.frontHub;

    // ---- 主三角 ----
    strut(bb, st, 0.024, 0.019, { bow: 0.006 });                    // 座管
    strut(bb, hb, 0.028, 0.024, { bow: 0.008, bowAxis: 'side' });   // 下管
    strut(st, ht, 0.021, 0.019, { bow: 0.007 });                    // 上管
    strut(ht, hb, 0.026, 0.026, { segments: 12, radial: 14 });      // 头管

    // ---- 后三角（左右各一）----
    for (const sx of [-1, 1]) {
      const hub = V(sx * 0.052, rh.y, rh.z);
      strut(bb, hub, 0.014, 0.008, { bow: 0.012, bowAxis: 'side', segments: 20 });   // 后下叉
      strut(st, hub, 0.012, 0.007, { bow: 0.01, bowAxis: 'side', segments: 20 });    // 后上叉
    }

    // ---- 五通壳体 ----
    const bbShell = new THREE.CylinderGeometry(0.038, 0.038, 0.085, 16);
    bbShell.rotateZ(Math.PI / 2);
    geos.push(transformed(bbShell, TRS(bb.x, bb.y, bb.z)));
    bbShell.dispose();

    // ---- 座管 + 鞍座 ----
    const postTop = V(0, st.y + 0.15, st.z - 0.035);
    strut(st, postTop, 0.014, 0.013, { segments: 12, radial: 10 });
    geos.push(this._saddleGeometry(postTop));

    // ---- 装饰环（金色圈，点缀在管件交汇处）----
    const ringGeo = new THREE.TorusGeometry(0.03, 0.005, 6, 20);
    geos.push(transformed(ringGeo, TRS(bb.x, bb.y, bb.z, 0, 0, Math.PI / 2)));
    geos.push(transformed(ringGeo, TRS(ht.x, ht.y - 0.05, ht.z, Math.PI / 2 - 0.2, 0, 0)));

    this.frameMesh = new THREE.Mesh(mergeGeometries(geos), this.materials.frame);
    this.frameMesh.castShadow = true;
    this.frameMesh.receiveShadow = true;
    this.root.add(this.frameMesh);
    this.geometries.push(this.frameMesh.geometry, ringGeo);
    geos.forEach((g) => { if (g !== this.frameMesh.geometry) g.dispose(); });

    // 鞍座单独用皮革材质
    this.saddle = new THREE.Mesh(this._saddleGeometry(postTop), this.materials.leather);
    this.saddle.castShadow = true;
    this.root.add(this.saddle);
    this.geometries.push(this.saddle.geometry);

    this.saddleAnchor = new THREE.Object3D();
    this.saddleAnchor.position.set(postTop.x, postTop.y + 0.035, postTop.z);
    this.root.add(this.saddleAnchor);
  }

  /** 鞍座：坐垫主体 + 鼻头，用扁平管体做出皮革的弧度 */
  _saddleGeometry(postTop) {
    const pts = [
      new THREE.Vector3(0, 0, -0.12),
      new THREE.Vector3(0, 0.012, -0.05),
      new THREE.Vector3(0, 0.014, 0.02),
      new THREE.Vector3(0, 0.008, 0.09),
      new THREE.Vector3(0, -0.006, 0.155),
    ];
    const curve = curveFrom(pts, 0.4);
    const geo = tubeFromCurve(curve, [0.055, 0.082, 0.076, 0.045, 0.014], {
      segments: 26, radial: 12, flat: 0.62,
    });
    return transformed(geo, TRS(postTop.x, postTop.y + 0.02, postTop.z));
  }

  /* ================================================================ *
   * 车轮
   * ================================================================ */
  _buildWheels() {
    const B = BIKE;
    const R = B.wheelRadius;

    const makeWheel = () => {
      const g = new THREE.Group();

      // 建模坐标系：所有零件都按「轮面在 XY 平面、局部 +Z 是车轴」来建
      // —— 花鼓 rotateX(π/2)、辐条的左右偏摆 hubZ/rimZ、气门嘴的 z 偏移，
      // 全都是沿 +Z 排布的。
      //
      // 这一句把这套坐标系转进车身坐标系：绕 Y 轴 90° 之后，轮面落到
      // YZ 平面（前进-竖直平面），车轴指向左右 —— 这才是自行车轮该有的姿态。
      // 少了这一句，轮子会「面朝行驶方向」，从侧面看像贴在车上的一枚硬币，
      // 而 rotation.x 的自转也不是绕轴滚，是在翻跟头。
      //
      // 挡泥板（_buildSteering / _buildDetails）建在 (0, cos a·r, sin a·r)，
      // 也就是 YZ 平面 —— 它本来就是照着「正确的车轮」画的。
      g.rotation.y = Math.PI / 2;

      // 轮胎：外圈橡胶
      const tire = new THREE.TorusGeometry(R - B.tireWidth * 0.5, B.tireWidth * 0.5, 8, 44);
      const tireMesh = new THREE.Mesh(tire, this.materials.rubber);
      tireMesh.castShadow = true;
      g.add(tireMesh);

      // 胎面花纹：一圈细小的凸起，转动时肉眼可见
      const treadGeo = new THREE.BoxGeometry(0.012, 0.016, B.tireWidth * 1.05);
      const treads = [];
      const treadCount = 40;
      for (let i = 0; i < treadCount; i++) {
        const a = (i / treadCount) * Math.PI * 2;
        // 绕 Z 轴转到「轮面上角度 a 处」：局部 X 成为径向、Y 成为切向、
        // Z 仍是轴向 —— 胎块才会贴着胎面、长边顺着车轴。
        //
        // 这里原本写的是绕 X 轴转 -a：只有 a=0 那一块是对的，转到 90° 时
        // 胎块的长边（0.058）会指向径向外侧，整条轮胎就变成了一圈锯齿。
        const m = TRS(
          Math.cos(a) * (R - 0.004), Math.sin(a) * (R - 0.004), 0,
          0, 0, a
        );
        // 绕径向轴交替偏转，做出斜向人字胎纹
        m.multiply(new THREE.Matrix4().makeRotationX((i % 2 ? 1 : -1) * 0.5));
        treads.push(transformed(treadGeo, m));
      }
      treadGeo.dispose();
      const treadMesh = new THREE.Mesh(mergeGeometries(treads), this.materials.rubber);
      treads.forEach((t) => t.dispose());
      g.add(treadMesh);

      // 轮圈：闭合曲线扫掠成环
      const rimPts = [];
      const segs = 48;
      for (let i = 0; i < segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        rimPts.push(new THREE.Vector3(Math.cos(a) * (R - B.tireWidth), Math.sin(a) * (R - B.tireWidth), 0));
      }
      const rimCurve = new THREE.CatmullRomCurve3(rimPts, true, 'catmullrom', 0.5);
      const rim = tubeFromCurve(rimCurve, 0.019, { segments: 96, radial: 8, capStart: false, capEnd: false });
      g.add(new THREE.Mesh(rim, this.materials.chrome));

      // 辐条：细圆柱从花鼓拉到轮圈，左右交替偏摆
      const spokeGeo = new THREE.CylinderGeometry(0.0032, 0.0032, 1, 4);
      spokeGeo.translate(0, 0.5, 0);   // 以底端为原点，便于按长度拉伸
      const spokes = [];
      const spokeCount = 28;
      for (let i = 0; i < spokeCount; i++) {
        const a = (i / spokeCount) * Math.PI * 2;
        const side = i % 2 === 0 ? 1 : -1;
        const hubZ = side * 0.032;
        const rimZ = side * 0.006;
        const from = new THREE.Vector3(0, 0, hubZ);
        const to = new THREE.Vector3(Math.cos(a) * (R - B.tireWidth - 0.012), Math.sin(a) * (R - B.tireWidth - 0.012), rimZ);
        const dir = new THREE.Vector3().subVectors(to, from);
        const len = dir.length();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
        const m = new THREE.Matrix4().compose(from, q, new THREE.Vector3(1, len, 1));
        spokes.push(transformed(spokeGeo, m));
      }
      spokeGeo.dispose();
      const spokeMesh = new THREE.Mesh(mergeGeometries(spokes), this.materials.chrome);
      spokes.forEach((s) => s.dispose());
      g.add(spokeMesh);

      // 花鼓
      const hub = new THREE.CylinderGeometry(0.024, 0.024, 0.075, 14);
      hub.rotateX(Math.PI / 2);
      const hubMesh = new THREE.Mesh(hub, this.materials.darkChrome);
      g.add(hubMesh);
      g.userData.hubGeometry = hub;

      // 气门嘴：转动时能一眼看出轮子在转
      const valve = new THREE.Mesh(
        new THREE.CylinderGeometry(0.005, 0.005, 0.03, 6),
        this.materials.accent
      );
      valve.position.set(0, R - B.tireWidth - 0.02, 0.03);
      g.add(valve);

      return g;
    };

    this.rearWheel = makeWheel();
    this.rearWheel.position.copy(BIKE.rearHub);
    this.root.add(this.rearWheel);

    this.frontWheel = makeWheel();
    this.frontWheel.position.copy(BIKE.frontHub);
    // 前轮挂在转向组下（在 _buildSteering 中移动）
    this._frontWheelHolder = new THREE.Group();
    this._frontWheelHolder.add(this.frontWheel);
    this.frontWheel.position.set(0, 0, 0);
  }

  /* ================================================================ *
   * 传动系统
   * ================================================================ */
  _buildDrivetrain() {
    const B = BIKE;
    const bb = B.bottomBracket;

    this.crankGroup = new THREE.Group();
    this.crankGroup.position.copy(bb);
    this.root.add(this.crankGroup);

    // 牙盘：带齿的圆盘（用一圈小方块表示齿）
    const ring = new THREE.Mesh(
      new THREE.CylinderGeometry(B.chainringRadius, B.chainringRadius, 0.006, 40),
      this.materials.accent
    );
    ring.rotation.z = Math.PI / 2;
    this.crankGroup.add(ring);

    const teeth = [];
    const toothGeo = new THREE.BoxGeometry(0.006, 0.012, 0.008);
    const toothCount = 36;
    for (let i = 0; i < toothCount; i++) {
      const a = (i / toothCount) * Math.PI * 2;
      teeth.push(transformed(toothGeo, TRS(
        0, Math.cos(a) * (B.chainringRadius + 0.005), Math.sin(a) * (B.chainringRadius + 0.005),
        a, 0, 0
      )));
    }
    toothGeo.dispose();
    this.crankGroup.add(new THREE.Mesh(mergeGeometries(teeth), this.materials.chrome));
    teeth.forEach((t) => t.dispose());

    // 曲柄 + 踏板（左右各一，相位相差 180°）
    this.pedals = {};
    for (const side of ['L', 'R']) {
      const sgn = side === 'R' ? 1 : -1;
      const arm = new THREE.Group();
      arm.rotation.z = side === 'R' ? 0 : Math.PI;   // 左右相差半圈

      const armGeo = new THREE.BoxGeometry(0.012, B.crankLength, 0.026);
      armGeo.translate(0, B.crankLength * 0.5, 0);
      const armMesh = new THREE.Mesh(armGeo, this.materials.chrome);
      armMesh.castShadow = true;
      arm.add(armMesh);

      // 踏板轴 + 踏板面
      const spindle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.008, 0.008, 0.06, 8),
        this.materials.darkChrome
      );
      spindle.rotation.z = Math.PI / 2;
      spindle.position.set(sgn * 0.045, B.crankLength, 0);
      arm.add(spindle);

      const padGeo = new THREE.BoxGeometry(0.052, 0.014, 0.085);
      const pad = new THREE.Mesh(padGeo, this.materials.rubber);
      pad.position.set(sgn * 0.062, B.crankLength, 0);
      pad.castShadow = true;
      arm.add(pad);

      // 踏板锚点：鹈鹕脚掌 IK 的目标
      const anchor = new THREE.Object3D();
      anchor.position.set(sgn * 0.062, B.crankLength + 0.012, 0);
      arm.add(anchor);

      this.crankGroup.add(arm);
      this.pedals[side] = { arm, anchor };
    }

    // 飞轮（后轮轴上）
    const cog = new THREE.Mesh(
      new THREE.CylinderGeometry(B.cogRadius, B.cogRadius, 0.008, 24),
      this.materials.chrome
    );
    cog.rotation.z = Math.PI / 2;
    cog.position.copy(BIKE.rearHub);
    this.root.add(cog);

    // 链条：绕过牙盘与飞轮的闭合曲线
    const chainPts = [];
    const r1 = B.chainringRadius, r2 = B.cogRadius;
    const c1 = new THREE.Vector3(bb.x, bb.y, bb.z);
    const c2 = new THREE.Vector3(BIKE.rearHub.x, BIKE.rearHub.y, BIKE.rearHub.z);
    const axis = new THREE.Vector3().subVectors(c2, c1).normalize();
    const perp = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(1, 0, 0)).normalize();
    // 外切线方向（近似：两圆等距时切线与圆心连线平行）
    const tangent = new THREE.Vector3().crossVectors(axis, perp).normalize();
    const steps = 18;
    // 上半圈：从牙盘顶到飞轮顶
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = Math.PI * 0.5 - t * Math.PI * 0.98;
      const p = c1.clone().addScaledVector(perp, Math.sin(a) * r1).addScaledVector(tangent, Math.cos(a) * r1);
      chainPts.push(p);
    }
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      chainPts.push(new THREE.Vector3().lerpVectors(
        c1.clone().addScaledVector(tangent, r1).addScaledVector(perp, r1 * 0.2),
        c2.clone().addScaledVector(tangent, r2).addScaledVector(perp, r2 * 0.2), t
      ));
    }
    // 下半圈
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = -Math.PI * 0.5 - t * Math.PI * 0.98;
      const p = c2.clone().addScaledVector(perp, Math.sin(a) * r2).addScaledVector(tangent, Math.cos(a) * r2);
      chainPts.push(p);
    }
    const chainCurve = new THREE.CatmullRomCurve3(chainPts, true, 'catmullrom', 0.4);
    const chainGeo = tubeFromCurve(chainCurve, 0.0075, { segments: 120, radial: 5, capStart: false, capEnd: false });
    this.chain = new THREE.Mesh(chainGeo, this.materials.darkChrome);
    this.root.add(this.chain);
    this.geometries.push(chainGeo);

    // 链罩（半包式，遮住上半圈链条）
    const guardCurve = new THREE.CatmullRomCurve3([
      c1.clone().addScaledVector(perp, 0.0).addScaledVector(tangent, r1 + 0.03),
      c1.clone().addScaledVector(perp, r1 + 0.03),
      c1.clone().addScaledVector(perp, r1 + 0.03).addScaledVector(tangent, -(r1 + 0.03)),
    ]);
    const guard = tubeFromCurve(guardCurve, [0.008, 0.014, 0.008], { segments: 20, radial: 6, flat: 0.5 });
    this.root.add(new THREE.Mesh(guard, this.materials.frame));
    this.geometries.push(guard);
  }

  /* ================================================================ *
   * 转向组：前叉 + 前轮 + 车把 + 车铃
   * ================================================================ */
  _buildSteering() {
    const B = BIKE;
    const ht = B.headTop;
    const hb = B.headBottom;

    // 转向轴：与头管共线，枢轴放在头管顶端
    this.steerAxis = new THREE.Vector3().subVectors(hb, ht).normalize();
    this.steerGroup = new THREE.Group();
    this.steerGroup.position.copy(ht);
    this.root.add(this.steerGroup);

    // 便于在局部空间构建：把世界点转换到「以头管顶为原点」的坐标
    const local = (v) => new THREE.Vector3().subVectors(v, ht);

    // ---- 前叉：两根从叉肩到花鼓的弯管 ----
    const forkGeos = [];
    for (const sx of [-1, 1]) {
      const shoulder = new THREE.Vector3(sx * 0.03, 0.02, 0.03);
      const tip = local(B.frontHub).add(new THREE.Vector3(sx * 0.05, 0, 0));
      const curve = curveFrom([
        shoulder,
        new THREE.Vector3().lerpVectors(shoulder, tip, 0.4).add(new THREE.Vector3(sx * 0.012, 0.01, 0.02)),
        tip,
      ]);
      forkGeos.push(tubeFromCurve(curve, [0.017, 0.012, 0.009], { segments: 20, radial: 10 }));
    }
    // 叉肩
    const crown = new THREE.BoxGeometry(0.085, 0.05, 0.055);
    forkGeos.push(transformed(crown, TRS(0, 0.0, 0.02)));
    crown.dispose();
    this.forkMesh = new THREE.Mesh(mergeGeometries(forkGeos), this.materials.frame);
    this.forkMesh.castShadow = true;
    this.steerGroup.add(this.forkMesh);
    forkGeos.forEach((g) => g.dispose());

    // ---- 前轮 ----
    const fw = this._frontWheelHolder;
    fw.position.copy(local(B.frontHub));
    this.steerGroup.add(fw);
    this.frontWheel.position.set(0, 0, 0);

    // ---- 立管 + 车把 ----
    const stemTop = new THREE.Vector3(0, 0.135, 0.015);
    const stem = curveFrom([new THREE.Vector3(0, 0.02, 0.01), stemTop]);
    this.steerGroup.add(new THREE.Mesh(
      tubeFromCurve(stem, [0.018, 0.014], { segments: 8, radial: 10 }),
      this.materials.chrome
    ));

    // 车把：中段平直 + 两端向后弯曲（荷兰式通勤车把）
    const barPts = [];
    const halfSpan = 0.27;
    for (let i = 0; i <= 12; i++) {
      const t = (i / 12) * 2 - 1;             // -1 .. 1
      const x = t * halfSpan;
      const bend = Math.pow(Math.abs(t), 2.2);
      barPts.push(new THREE.Vector3(
        x,
        stemTop.y + bend * 0.055,
        stemTop.z - bend * 0.16
      ));
    }
    const barCurve = curveFrom(barPts);
    const barGeo = tubeFromCurve(barCurve, (t) => 0.014 + Math.sin(t * Math.PI) * 0.003, {
      segments: 36, radial: 10,
    });
    this.steerGroup.add(new THREE.Mesh(barGeo, this.materials.chrome));

    // 握把：两端深色橡胶套
    const grips = [];
    for (const sx of [-1, 1]) {
      const gripPts = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        gripPts.push(barCurve.getPoint(0.5 + sx * 0.5 * (0.72 + t * 0.28)));
      }
      const gc = curveFrom(gripPts);
      grips.push(tubeFromCurve(gc, 0.019, { segments: 12, radial: 10 }));
    }
    const gripMesh = new THREE.Mesh(mergeGeometries(grips), this.materials.rubber);
    gripMesh.castShadow = true;
    this.steerGroup.add(gripMesh);
    grips.forEach((g) => g.dispose());

    // 把手锚点：鹈鹕翅膀的落点
    this.gripAnchors = {
      L: new THREE.Object3D(),
      R: new THREE.Object3D(),
    };
    for (const sx of [-1, 1]) {
      const key = sx > 0 ? 'R' : 'L';
      const p = barCurve.getPoint(sx > 0 ? 0.93 : 0.07);
      this.gripAnchors[key].position.copy(p);
      this.steerGroup.add(this.gripAnchors[key]);
    }

    // ---- 车铃 ----
    this.bellGroup = new THREE.Group();
    this.bellGroup.position.set(-0.16, stemTop.y + 0.03, stemTop.z - 0.02);
    const dome = new THREE.SphereGeometry(0.032, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55);
    this.bellGroup.add(new THREE.Mesh(dome, this.materials.bell));
    dome.dispose();
    const bellBase = new THREE.CylinderGeometry(0.033, 0.036, 0.008, 16);
    this.bellGroup.add(new THREE.Mesh(bellBase, this.materials.darkChrome));
    bellBase.dispose();
    const striker = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), this.materials.chrome);
    striker.position.set(0.035, 0.012, 0);
    this.bellGroup.add(striker);
    this.bellStriker = striker;
    this.steerGroup.add(this.bellGroup);

    // ---- 车头灯 ----
    this.lampGroup = new THREE.Group();
    this.lampGroup.position.set(0, 0.06, 0.055);
    const housing = new THREE.CylinderGeometry(0.026, 0.03, 0.045, 14);
    housing.rotateX(Math.PI / 2);
    this.lampGroup.add(new THREE.Mesh(housing, this.materials.chrome));
    housing.dispose();
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.025, 14), this.materials.lamp);
    lens.position.z = 0.024;
    this.lampGroup.add(lens);
    lens.geometry.dispose();
    this.steerGroup.add(this.lampGroup);

    // ---- 前挡泥板 ----
    const fenderPts = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const a = Math.PI * (0.18 + t * 0.64);
      const r = B.wheelRadius + 0.035;
      fenderPts.push(new THREE.Vector3(
        0,
        Math.cos(a) * r,
        Math.sin(a) * r
      ).add(local(B.frontHub)));
    }
    const fenderCurve = curveFrom(fenderPts);
    const fender = tubeFromCurve(fenderCurve, [0.006, 0.03, 0.032, 0.03, 0.006], {
      segments: 22, radial: 6, flat: 0.85,
    });
    this.steerGroup.add(new THREE.Mesh(fender, this.materials.accent));
    this.geometries.push(fender);
  }

  /* ================================================================ *
   * 细节：后货架 + 藤篮 + 后挡泥板
   * ================================================================ */
  _buildDetails() {
    const B = BIKE;
    const st = B.seatTop;

    // 后货架
    const rackGeos = [];
    const rackY = B.rearHub.y + 0.30;
    const rackZ = -0.42;
    for (const sx of [-1, 1]) {
      const pts = [
        new THREE.Vector3(sx * 0.075, rackY, rackZ + 0.20),
        new THREE.Vector3(sx * 0.085, rackY, rackZ),
        new THREE.Vector3(sx * 0.075, rackY, rackZ - 0.20),
      ];
      rackGeos.push(tubeFromCurve(curveFrom(pts), 0.008, { segments: 14, radial: 6 }));
      // 支撑杆连到后轴
      rackGeos.push(tubeFromCurve(curveFrom([
        new THREE.Vector3(sx * 0.075, rackY - 0.01, rackZ - 0.16),
        new THREE.Vector3(sx * 0.06, B.rearHub.y, B.rearHub.z),
      ]), 0.006, { segments: 8, radial: 6 }));
    }
    // 横档
    for (let i = -2; i <= 2; i++) {
      const z = rackZ + i * 0.09;
      rackGeos.push(tubeFromCurve(curveFrom([
        new THREE.Vector3(-0.08, rackY, z), new THREE.Vector3(0.08, rackY, z),
      ]), 0.006, { segments: 4, radial: 6 }));
    }
    this.root.add(new THREE.Mesh(mergeGeometries(rackGeos), this.materials.chrome));
    rackGeos.forEach((g) => g.dispose());

    // 后挡泥板
    const fenderPts = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const a = Math.PI * (0.2 + t * 0.6);
      const r = B.wheelRadius + 0.035;
      fenderPts.push(new THREE.Vector3(0, Math.cos(a) * r, Math.sin(a) * r).add(B.rearHub));
    }
    const fender = tubeFromCurve(curveFrom(fenderPts), [0.006, 0.03, 0.032, 0.03, 0.006], {
      segments: 22, radial: 6, flat: 0.85,
    });
    this.root.add(new THREE.Mesh(fender, this.materials.accent));
    this.geometries.push(fender);

    // 藤篮：用一圈竖条 + 上下两个环，做出编织感
    const basket = new THREE.Group();
    basket.position.set(0, rackY + 0.14, rackZ - 0.06);
    const basketR = 0.16, basketH = 0.20;
    const strands = [];
    const strandCount = 16;
    for (let i = 0; i < strandCount; i++) {
      const a = (i / strandCount) * Math.PI * 2;
      const x = Math.cos(a) * basketR, z = Math.sin(a) * basketR;
      strands.push(tubeFromCurve(curveFrom([
        new THREE.Vector3(x * 0.86, -basketH * 0.5, z * 0.86),
        new THREE.Vector3(x, 0, z),
        new THREE.Vector3(x * 1.06, basketH * 0.5, z * 1.06),
      ]), 0.0055, { segments: 6, radial: 5 }));
    }
    for (const y of [-basketH * 0.5, 0, basketH * 0.5]) {
      const r = y > 0 ? basketR * 1.06 : y < 0 ? basketR * 0.86 : basketR;
      const ringPts = [];
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2;
        ringPts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
      }
      strands.push(tubeFromCurve(
        new THREE.CatmullRomCurve3(ringPts, true, 'catmullrom', 0.5),
        0.006, { segments: 40, radial: 5, capStart: false, capEnd: false }
      ));
    }
    const basketMesh = new THREE.Mesh(mergeGeometries(strands), this.materials.basket);
    basketMesh.castShadow = true;
    basket.add(basketMesh);
    strands.forEach((s) => s.dispose());
    this.root.add(basket);
    this.basket = basket;

    // 篮子里放几条鱼干（鹈鹕的干粮）
    const fishGeos = [];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.7;
      const body = new THREE.SphereGeometry(0.035, 8, 6);
      body.scale(1.5, 0.55, 0.75);
      fishGeos.push(transformed(body, TRS(
        Math.cos(a) * 0.07, 0.03 + i * 0.012, Math.sin(a) * 0.07,
        0, a, 0.2
      )));
      body.dispose();
      const tail = new THREE.ConeGeometry(0.026, 0.045, 5);
      tail.rotateZ(-Math.PI / 2);
      fishGeos.push(transformed(tail, TRS(
        Math.cos(a) * 0.07 + Math.cos(a) * 0.055, 0.03 + i * 0.012, Math.sin(a) * 0.07 + Math.sin(a) * 0.055,
        0, a, 0.2
      )));
      tail.dispose();
    }
    const fishMat = new THREE.MeshStandardMaterial({ color: 0x9fb4bd, roughness: 0.42, metalness: 0.35 });
    const fishMesh = new THREE.Mesh(mergeGeometries(fishGeos), fishMat);
    fishMesh.position.copy(basket.position);
    fishMesh.position.y += 0.02;
    this.root.add(fishMesh);
    fishGeos.forEach((g) => g.dispose());
  }

  /* ================================================================ *
   * 运动学更新
   * ================================================================ */

  /**
   * @param {number} dt
   * @param {object} s  { speed, steer, cadence, lean, pitch, bellRing }
   */
  update(dt, s) {
    const B = BIKE;
    this.state.speed = s.speed ?? 0;
    this.state.steer = THREE.MathUtils.clamp(s.steer ?? 0, -B.steerMax, B.steerMax);

    // 车轮角速度 = 线速度 / 半径（视觉上不必与踏频严格联动，
    // 但齿轮比让它看起来合理：脚踏一圈 ≈ 车轮 2.6 圈）
    const gearRatio = 2.6;
    this.state.wheelAngle += (this.state.speed / B.wheelRadius) * dt;
    this.state.crankAngle += (s.cadence ?? 0) * dt * Math.PI * 2 / 60;

    this.rearWheel.rotation.x = this.state.wheelAngle;
    this.frontWheel.rotation.x = this.state.wheelAngle;
    this.crankGroup.rotation.x = this.state.crankAngle;

    // 链条随踏频「抖动」，纯装饰但很有说服力
    if (this.chain) {
      this.chain.rotation.x = Math.sin(this.state.crankAngle * 2) * 0.004;
    }

    // 转向
    this._q.setFromAxisAngle(this.steerAxis, this.state.steer);
    this.steerGroup.quaternion.copy(this._q);

    // 车身侧倾（压弯）与俯仰（上下坡）
    this.bodyPivot.rotation.z = s.lean ?? 0;
    this.bodyPivot.rotation.x = s.pitch ?? 0;

    // 车铃：被拨动时抖一下
    if (this.bellStriker) {
      const ring = s.bellRing ?? 0;
      this.bellStriker.position.x = 0.035 + Math.sin(performance.now() * 0.06) * 0.006 * ring;
      this.bellStriker.position.y = 0.012 + Math.cos(performance.now() * 0.05) * 0.004 * ring;
    }
  }

  /**
   * 取某个踏板的世界坐标 —— 鹈鹕脚掌的 IK 目标。
   * 因为踏板挂在曲柄组下，直接让 three 更新一次世界矩阵最省事也最准确。
   */
  getPedalWorldPosition(side, out) {
    const p = this.pedals[side];
    p.anchor.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(p.anchor.matrixWorld);
  }

  /** 鞍座世界位置 */
  getSaddleWorldPosition(out) {
    this.saddleAnchor.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.saddleAnchor.matrixWorld);
  }

  /** 把手世界位置 */
  getGripWorldPosition(side, out) {
    const a = this.gripAnchors[side];
    a.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(a.matrixWorld);
  }

  /** 曲柄相位（弧度），用于同步腿部姿态 */
  get crankPhase() { return this.state.crankAngle; }

  setShadows(enabled) {
    this.root.traverse((o) => { if (o.isMesh) o.castShadow = enabled; });
  }

  dispose() {
    this.geometries.forEach((g) => g.dispose());
    Object.values(this.materials).forEach((m) => m.dispose());
  }
}
