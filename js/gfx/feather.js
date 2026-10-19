/**
 * feather.js —— 羽毛蒙皮层
 *
 * 鹈鹕身上有上千片羽毛，逐片做成 Mesh 会让 draw call 爆炸。
 * 这里用「实例化」解决：整个鸟的羽毛 = 1 个 draw call。
 *
 * 数据流（每帧）：
 *   1. 对每根骨骼求一次 matrixWorld（16 次）
 *   2. 对每片羽毛算 world = 骨骼matrixWorld × 羽毛局部矩阵（约 1200 次 Matrix4 乘法）
 *   3. 把结果写进 aMatrix 这个 per-instance mat4 属性，一次上传
 *
 * 第 2 步是这里唯一的 CPU 热点，但 1200 次 4×4 乘法在 V8 里是几十微秒量级，
 * 相对于每帧 16ms 的预算可以忽略。
 *
 * 为什么不用「骨骼下标 + uniform mat4 uBones[N]」把乘法也交给 GPU？
 * 因为 three.js 的 ShaderMaterial 默认按 GLSL ES 1.00 编译，而 ES 1.00 规定
 * uniform 数组只能用常量下标索引；用 attribute 传下标属于未定义行为，
 * 在部分移动端驱动上会直接编译失败。CPU 侧多算一遍换取跨平台可靠性更划算。
 */

import * as THREE from 'three';
import * as S from './shaders.js';
import { ART, placeholderTexture } from './textures.js';

export class FeatherCoat {
  /**
   * @param {THREE.Object3D} root 鹈鹕的根节点（用于把局部矩阵转成相对 root 的空间）
   * @param {Array<{object: THREE.Object3D, kind: string, tint: number, seed: number}>} anchors
   * @param {object} sharedUniforms 环境共享 uniform
   * @param {string} quality
   */
  constructor(root, anchors, sharedUniforms, quality = 'high') {
    this.root = root;
    this.anchors = anchors;
    this.shared = sharedUniforms;

    // 预分配工作矩阵，避免每帧 GC
    this._boneWorld = new THREE.Matrix4();
    this._local = new THREE.Matrix4();
    this._out = new THREE.Matrix4();

    this.geometry = this._buildGeometry();
    this.material = this._buildMaterial();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;      // 羽毛自阴影收益低、代价高，关闭
    this.mesh.receiveShadow = false;
    this.mesh.name = 'FeatherCoat';
    this.mesh.renderOrder = 2;

    // 让 aMatrix 属性指向我们持有的缓冲区，便于逐帧原地更新
    this._matrixArray = this.geometry.attributes.aMatrix.array;
    this._matrixAttr = this.geometry.attributes.aMatrix;

    this.update(0);
  }

  /* ================================================================ *
   * 几何
   * ================================================================ */
  _buildGeometry() {
    const blade = makeFeatherBlade();

    const geo = new THREE.InstancedBufferGeometry();
    geo.index = blade.index;
    geo.attributes.position = blade.attributes.position;
    geo.attributes.normal = blade.attributes.normal;
    geo.attributes.uv = blade.attributes.uv;

    const n = this.anchors.length;
    const matrix = new Float32Array(n * 16);
    const phase = new Float32Array(n);
    const flutter = new Float32Array(n);
    const tint = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const a = this.anchors[i];
      phase[i] = a.seed;
      // 腹部绒羽贴伏、背部与翅膀的羽毛更容易被吹起
      flutter[i] = a.kind === 'down' ? 0.35 : a.kind === 'wing' ? 1.0 : 0.62;
      tint[i] = a.tint;
    }

    // itemSize=16：three 会把它拆成 4 个连续的 vec4 attribute location
    geo.setAttribute('aMatrix', new THREE.InstancedBufferAttribute(matrix, 16));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    geo.setAttribute('aFlutter', new THREE.InstancedBufferAttribute(flutter, 1));
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 1));
    geo.instanceCount = n;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 3.0);
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(-2, -2, -2), new THREE.Vector3(2, 3, 2)
    );
    return geo;
  }

  _buildMaterial() {
    const u = this.shared;
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: u.uTime,
        uSunDir: u.uSunDir,
        uSunColor: u.uSunColor,
        uSkyTop: u.uSkyTop,
        uSkyHorizon: u.uSkyHorizon,
        uFogColor: u.uFogColor,
        uFogDensity: u.uFogDensity,
        uFogHeightFalloff: u.uFogHeightFalloff,
        uWindDir: u.uWindDir,
        uWindStrength: u.uWindStrength,
        uSpeed: { value: 0 },
        uBaseColor: { value: new THREE.Color(0xf6f0e4) },
        uExposure: u.uExposure,
        uFeatherArt: { value: ART.get('feather') ? 1 : 0 },
        uFeatherTex: { value: ART.get('feather') || placeholderTexture() },
      },
      vertexShader: S.FEATHER_VERT,
      fragmentShader: S.FEATHER_FRAG,
      side: THREE.DoubleSide,
    });
  }

  /* ================================================================ *
   * 每帧更新：把「骨骼世界矩阵 × 羽毛局部矩阵」写进 aMatrix
   * ================================================================ */
  update(speed = 0) {
    this.material.uniforms.uSpeed.value = speed;

    const anchors = this.anchors;
    const arr = this._matrixArray;

    // 先整体刷新一次骨架的世界矩阵，再逐个读 obj.matrixWorld。
    //
    // 不能对每个锚点调用 obj.updateWorldMatrix(true, false) —— 那个方法的
    // 第一个参数是 updateParents，会从该节点一路向上走到场景根再折返，
    // 单次代价与骨骼链深度成正比。3094 个锚点各走一趟 = 三万余次
    // 矩阵乘法，实测占掉 2.1ms，是整个主循环里最贵的一段。
    // 这里改成「自顶向下刷一遍（O(n)）+ 逐个只读」，同样的结果，代价降到零头。
    this.root.updateMatrixWorld(true);

    // 顶点着色器里还会再乘一次 modelMatrix（也就是 root 的矩阵），
    // 所以这里必须先把变换换算回 root 的局部空间。
    const rootInverse = this._rootInverse || (this._rootInverse = new THREE.Matrix4());
    rootInverse.copy(this.root.matrixWorld).invert();

    for (let i = 0; i < anchors.length; i++) {
      // obj.matrixWorld 已经包含了「骨骼链 × 锚点自身」的全部变换，
      // 因此这里只能乘一次 —— 早期版本额外再乘了一次 obj.matrix，
      // 结果锚点的缩放被平方（1.6² ≈ 2.5 倍），整只鸟炸成一团尖刺。
      this._out.multiplyMatrices(rootInverse, anchors[i].object.matrixWorld);

      this._out.toArray(arr, i * 16);
    }

    this._matrixAttr.needsUpdate = true;
  }

  setVisible(v) { this.mesh.visible = v; }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ================================================================== *
 * 羽毛叶片的几何
 * ================================================================== */

/**
 * 一片羽毛：沿 +Y 生长、宽度沿 X、羽面法线沿 +Z。
 *
 * 中脊（羽轴）那一列顶点抬高一点，形成浅浅的「屋顶」剖面 ——
 * 这样羽毛会像真实羽毛那样在中间捕捉到一条高光，
 * 而不是一张平平的纸片。宽度剖面用「羽根细、中段最宽、羽尖收成点」
 * 的经典羽毛轮廓。
 */
function makeFeatherBlade(opts = {}) {
  const {
    length = 0.105,
    rows = 6,
    profile = [0.10, 0.42, 0.62, 0.72, 0.52, 0.12],  // 相对最大半宽的倍数
    // 半宽必须远小于长度，羽毛才是「片」而不是「叶」。
    // 0.030 时宽长比接近 1:3，看起来像棕榈叶；
    // 收到 0.019 后是 1:5.5，接近真实廓羽的比例。
    maxHalfWidth = 0.014,
    ridge = 0.18,                                     // 中脊抬升（相对半宽）
  } = opts;

  const pos = [], nrm = [], uv = [], idx = [];
  const cols = 3;   // 左缘 / 中脊 / 右缘

  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    const y = t * length;
    const w = maxHalfWidth * profile[Math.min(profile.length - 1, i)];
    // 羽尖轻微后弯，避免所有羽毛都是笔直的小棍
    const z = -t * t * length * 0.10;

    const lateral = [-1, 0, 1];
    for (let c = 0; c < cols; c++) {
      const s = lateral[c];
      const lift = (c === 1) ? w * ridge : 0;
      pos.push(s * w, y, z + lift);
      const n = new THREE.Vector3(s * 0.42, 0.12, 0.90).normalize();
      nrm.push(n.x, n.y, n.z);
      uv.push((s + 1) * 0.5, t);
    }
  }

  for (let i = 0; i < rows - 1; i++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = i * cols + c;
      const b = a + cols;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

export { makeFeatherBlade };
