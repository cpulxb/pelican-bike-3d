/**
 * environment.js —— 世界构建
 *
 * 场景里没有一张图片、没有一个外部模型，全部由代码生成：
 *   · 天空      解析式大气散射 + 平面云场（单张球体，一次 draw call）
 *   · 地形      分块 + 三档 LOD，顶点高度来自 CPU 噪声函数
 *   · 海洋      两层：近处 Gerstner 波网格 + 远处平坦「海天板」
 *   · 植被      实例化草叶 / 棕榈 / 岩石 / 浮木，共 4 个 draw call
 *   · 云与鸟群  实例化软粒子与扑翼剪影
 *
 * 关键设计：所有材质共享同一个 `this.u` uniform 对象。
 * 这样每帧只要改一次太阳方向，天空、地形、海面、草、云、鸟会同步变化，
 * 黄昏过渡才可能是连续的。
 */

import * as THREE from 'three';
import {
  terrainHeight, terrainNormal, terrainSlope, SPAWN, WATER_LEVEL, mulberry32, fbm2, ridged2, hash2,
} from '../util/noise.js';
import {
  tubeFromCurve, curveFrom, noiseDeform, mergeGeometries, TRS, transformed, featherBlade,
} from '../util/geometry.js';
import * as S from '../gfx/shaders.js';

/* ------------------------------------------------------------------ *
 * 世界常量
 * ------------------------------------------------------------------ */

const WORLD = {
  chunkSize: 256,
  chunkCount: 4,          // 4×4 = 1024×1024 单位的核心地形
  chunkSeg: 96,           // 每块 96×96 网格（约 2.7m 一个格子）
  heightMapRes: 512,
  // 高度场贴图要覆盖整个岛（含外圈浅滩），否则水面着色器查不到岸边水深，
  // 整条海岸线就会丢掉白沫与浅水透色。
  heightMapSize: 1500,
  waterRings: 130,        // 径向环数（决定近景细节）
  waterSectors: 96,       // 周向分段（决定远处海平线的圆滑度）
  waterExtent: 8000,      // 海面最外圈半径
  grassCount: 105000,
  grassRadius: 175,
  cloudCount: 130,
  birdCount: 130,
  rockCount: 120,
  palmCount: 34,
  shellCount: 260,
};

/* ------------------------------------------------------------------ *
 * 环境主体
 * ------------------------------------------------------------------ */

export class Environment {
  constructor(renderer, scene, quality = 'high') {
    this.renderer = renderer;
    this.scene = scene;
    this.quality = quality;
    this.group = new THREE.Group();
    this.group.name = 'Environment';
    scene.add(this.group);

    this.disposables = [];

    /* ---------- 共享 uniform ----------
     * 整个世界的「光照状态」都放在这里，材质直接引用同一批对象。 */
    this.u = {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.35, 0.22, 0.91).normalize() },
      uSunColor: { value: new THREE.Color(1.0, 0.72, 0.42) },
      uSkyTop: { value: new THREE.Color(0.16, 0.34, 0.56) },
      uSkyHorizon: { value: new THREE.Color(0.95, 0.55, 0.32) },
      uNadir: { value: new THREE.Color(0.03, 0.07, 0.10) },
      uFogColor: { value: new THREE.Color(0.72, 0.50, 0.40) },
      uFogDensity: { value: 0.00105 },
      uFogHeightFalloff: { value: 0.020 },
      uExposure: { value: 1.15 },
      uWaterLevel: { value: WATER_LEVEL },
      uWindDir: { value: new THREE.Vector3(0.82, 0, 0.57).normalize() },
      uWindStrength: { value: 0.45 },
      uPlayerPos: { value: new THREE.Vector3() },
      uCloudCover: { value: 0.46 },
      uCloudSharp: { value: 0.16 },
      uStars: { value: 0.0 },
      uQuality: { value: quality === 'low' ? 0 : quality === 'medium' ? 1 : 2 },
      // 车头灯：自研地形着色器不吃 three 的 SpotLight，这里给它一束同参数的「假」聚光
      uHeadPos: { value: new THREE.Vector3() },
      uHeadDir: { value: new THREE.Vector3(0, -0.2, 1) },
      uHeadI: { value: 0 },
    };
    /** 额外的风力（游戏里的阵风），叠加在随车速变化的基础风上 */
    this.windBoost = 0;

    this.terrainMaterial = null;
    this.chunks = [];

    /* ---------- 组装 ---------- */
    this._bakeHeightMap();
    this._buildSky();
    this._buildTerrain();
    this._buildWater();
    this._buildGrass();
    this._buildScatter();   // 岩石 / 棕榈 / 浮木 / 贝壳
    this._buildClouds();
    this._buildFlock();
  }

  /* ================================================================ *
   * 高度场烘焙：把 CPU 噪声写进一张浮点贴图，供海面着色器查询水深
   * ================================================================ */
  _bakeHeightMap() {
    const N = WORLD.heightMapRes;
    const size = WORLD.heightMapSize;
    const data = new Float32Array(N * N);
    const half = size * 0.5;

    for (let j = 0; j < N; j++) {
      const z = (j / (N - 1)) * size - half;
      for (let i = 0; i < N; i++) {
        const x = (i / (N - 1)) * size - half;
        data[j * N + i] = terrainHeight(x, z);
      }
    }

    const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.FloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.heightMap = tex;
    this.disposables.push(tex);
    this.heightMapOrigin = new THREE.Vector2(0, 0);
    this.heightMapSize = size;
  }

  /* ================================================================ *
   * 天空
   * ================================================================ */
  _buildSky() {
    const geo = new THREE.SphereGeometry(1, 48, 28);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: this.u.uSunDir,
        uZenith: this.u.uSkyTop,
        uHorizon: this.u.uSkyHorizon,
        uNadir: this.u.uNadir,
        uSunColor: this.u.uSunColor,
        uTime: this.u.uTime,
        uCloudCover: this.u.uCloudCover,
        uCloudSharp: this.u.uCloudSharp,
        uStars: this.u.uStars,
        uExposure: this.u.uExposure,
      },
      vertexShader: S.SKY_VERT,
      fragmentShader: S.SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000;
    mesh.scale.setScalar(1);
    this.sky = mesh;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
  }

  /* ================================================================ *
   * 地形：分块 + LOD
   * ================================================================ */
  _buildTerrain() {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: this.u.uSunDir,
        uSunColor: this.u.uSunColor,
        uSkyTop: this.u.uSkyTop,
        uSkyHorizon: this.u.uSkyHorizon,
        uNadir: this.u.uNadir,
        uFogColor: this.u.uFogColor,
        uFogDensity: this.u.uFogDensity,
        uFogHeightFalloff: this.u.uFogHeightFalloff,
        uExposure: this.u.uExposure,
        uWaterLevel: this.u.uWaterLevel,
        uTime: this.u.uTime,
        uDetailScale: { value: 1.0 },
        uChunkFade: { value: 1.0 },
        uHeadPos: this.u.uHeadPos,
        uHeadDir: this.u.uHeadDir,
        uHeadI: this.u.uHeadI,
      },
      vertexShader: S.TERRAIN_VERT,
      fragmentShader: S.TERRAIN_FRAG,
      transparent: true,
    });
    this.terrainMaterial = mat;
    this.disposables.push(mat);

    const { chunkSize, chunkCount, chunkSeg } = WORLD;
    const origin = -(chunkCount * chunkSize) / 2;

    for (let cz = 0; cz < chunkCount; cz++) {
      for (let cx = 0; cx < chunkCount; cx++) {
        const chunk = this._makeChunk(
          origin + cx * chunkSize,
          origin + cz * chunkSize,
          chunkSize, chunkSeg
        );
        chunk.lod = -1;
        this.chunks.push(chunk);
        this.group.add(chunk.mesh);
      }
    }

    // 远景裙板：一圈粗糙的大地形，接住海平线，避免看到世界边缘
    this._buildSkirt();
  }

  /**
   * 生成一个地形块。
   *
   * 顶点高度取自 terrainHeight；法线由相邻顶点的有限差分算出
   * （比逐点调用 4 次噪声快一个数量级，精度对视觉完全够用）。
   * 三档 LOD 用不同的索引缓冲实现，切换时只换 index 属性。
   */
  _makeChunk(ox, oz, size, seg) {
    const n = seg + 1;
    const vCount = n * n;
    const pos = new Float32Array(vCount * 3);
    const nrm = new Float32Array(vCount * 3);
    const uv = new Float32Array(vCount * 2);

    const step = size / seg;

    // 1) 高度
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        const x = ox + i * step;
        const z = oz + j * step;
        pos[idx * 3 + 0] = x;
        pos[idx * 3 + 1] = terrainHeight(x, z);
        pos[idx * 3 + 2] = z;
        uv[idx * 2 + 0] = x;
        uv[idx * 2 + 1] = z;
      }
    }

    // 2) 法线（网格差分，边界处夹取到相邻行）
    const hAt = (i, j) => {
      const ii = Math.min(n - 1, Math.max(0, i));
      const jj = Math.min(n - 1, Math.max(0, j));
      return pos[(jj * n + ii) * 3 + 1];
    };
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        const dx = hAt(i + 1, j) - hAt(i - 1, j);
        const dz = hAt(i, j + 1) - hAt(i, j - 1);
        const sx = 2 * step, sz = 2 * step;
        let nx = -dx * sz, ny = sx * sz, nz = -dz * sx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nrm[idx * 3 + 0] = nx / len;
        nrm[idx * 3 + 1] = ny / len;
        nrm[idx * 3 + 2] = nz / len;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

    // 3) 三档 LOD 索引
    const lods = [];
    for (const stride of [1, 2, 4]) {
      const idx = [];
      for (let j = 0; j < seg; j += stride) {
        for (let i = 0; i < seg; i += stride) {
          const a = j * n + i;
          const b = a + stride;
          const c = a + n * stride;
          const d = c + stride;
          idx.push(a, c, b, b, c, d);
        }
      }
      lods.push(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    }

    geo.setIndex(lods[0]);
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(ox + size / 2, 0, oz + size / 2),
      size * 0.78
    );

    const mat = this.terrainMaterial.clone();
    mat.uniforms = Object.assign({}, this.terrainMaterial.uniforms, {
      uDetailScale: { value: 1.0 },
      uChunkFade: { value: 1.0 },
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    return { mesh, geo, mat, lods, lod: -1, cx: ox + size / 2, cz: oz + size / 2 };
  }

  /** 远景裙板：把世界延伸到雾的尽头 */
  _buildSkirt() {
    const size = 5000;
    const seg = 64;
    const n = seg + 1;
    const half = WORLD.chunkSize * WORLD.chunkCount / 2;
    const pos = new Float32Array(n * n * 3);
    const nrm = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        // 只在核心区外圈生成，内部被高精度地形盖住也无所谓（略低一点）
        const x = -size / 2 + (i / seg) * size;
        const z = -size / 2 + (j / seg) * size;
        const insideCore = Math.abs(x) < half && Math.abs(z) < half;
        const h = insideCore ? -60 : terrainHeight(x, z);
        pos[idx * 3 + 0] = x;
        pos[idx * 3 + 1] = h;
        pos[idx * 3 + 2] = z;
        nrm[idx * 3 + 0] = 0; nrm[idx * 3 + 1] = 1; nrm[idx * 3 + 2] = 0;
        uv[idx * 2 + 0] = x; uv[idx * 2 + 1] = z;
      }
    }
    const idx = [];
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));

    const mat = this.terrainMaterial.clone();
    mat.uniforms = Object.assign({}, this.terrainMaterial.uniforms, {
      uDetailScale: { value: 0.18 },
      uChunkFade: { value: 1.0 },
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -5;
    this.skirt = mesh;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
  }

  /* ================================================================ *
   * 海面
   * ================================================================ */
  _buildWater() {
    const mkMat = (waveScale) => new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.u.uTime,
        uWaveScale: { value: waveScale },
        uWaveDir0: { value: new THREE.Vector2(1.0, 0.22).normalize() },
        uWaveDir1: { value: new THREE.Vector2(0.62, -0.78).normalize() },
        uWaveDir2: { value: new THREE.Vector2(-0.28, 0.96).normalize() },
        uWaveDir3: { value: new THREE.Vector2(0.88, 0.47).normalize() },
        uSunDir: this.u.uSunDir,
        uSunColor: this.u.uSunColor,
        uSkyTop: this.u.uSkyTop,
        uSkyHorizon: this.u.uSkyHorizon,
        uNadir: this.u.uNadir,
        uFogColor: this.u.uFogColor,
        uFogDensity: this.u.uFogDensity,
        uFogHeightFalloff: this.u.uFogHeightFalloff,
        uExposure: this.u.uExposure,
        uWaterLevel: this.u.uWaterLevel,
        uDeepColorMix: { value: 1.0 },
        uClarity: { value: 1.0 },
        uHeightMap: { value: this.heightMap },
        uMapOrigin: { value: this.heightMapOrigin },
        uMapSize: { value: this.heightMapSize },
      },
      vertexShader: S.WATER_VERT,
      fragmentShader: S.WATER_FRAG,
      transparent: true,
      depthWrite: true,
    });

    // 一整块「径向指数网格」的海面。
    //
    // 早先用的是两块平面拼的：近处一张细网格、远处一张巨大的平板。
    // 问题是两块面的波高不同（一张有位移、一张没有），交界处会出现
    // 一条横贯画面的硬边 —— 从岸边望向大海时特别明显。
    //
    // 换成单张极坐标网格后，环形半径按 r = A·(e^(k·t) − 1) 增长：
    // 相邻环的间距恒定按 16% 递增，于是圆心附近只有十几厘米的格子，
    // 8 公里外是几百米的格子，一张网格同时满足近景细节与远景范围。
    // 既没有接缝，顶点数还从 9 万降到了 1.25 万。
    const geo = makeRadialOceanGeometry(WORLD.waterRings, WORLD.waterSectors, WORLD.waterExtent);
    this.waterMat = mkMat(1.0);
    const water = new THREE.Mesh(geo, this.waterMat);
    water.position.y = WATER_LEVEL;
    water.renderOrder = 1;
    water.frustumCulled = false;
    this.water = water;
    this.group.add(water);

    this.disposables.push(geo, this.waterMat);
  }

  /* ================================================================ *
   * 草：实例化 + 风场 + 玩家踩踏
   * ================================================================ */
  _buildGrass() {
    // 只保留 4 个 float 属性：偏移 / 相位 / 高度 / 颜色。
    // 原先还传了 aTilt，但一个 vec3 属性在多数驱动上会各占一个 vec4 槽位，
    // 顶点属性槽位是稀缺资源，能省则省 —— 倒伏方向改由 aPhase 在着色器里推出来。
    const count = this.quality === 'low' ? Math.floor(WORLD.grassCount * 0.35)
      : this.quality === 'medium' ? Math.floor(WORLD.grassCount * 0.7)
        : WORLD.grassCount;

    const geo = new THREE.InstancedBufferGeometry();
    const blade = makeBladeGeometry(3);
    geo.index = blade.index;
    geo.attributes.position = blade.attributes.position;
    geo.attributes.normal = blade.attributes.normal;
    geo.attributes.uv = blade.attributes.uv;

    const rnd = mulberry32(7788);
    const aOffset = new Float32Array(count * 3);
    const aPhase = new Float32Array(count);
    const aHeight = new Float32Array(count);
    const aTint = new Float32Array(count * 3);

    const R = WORLD.grassRadius;
    let placed = 0, guard = 0;
    while (placed < count && guard < count * 30) {
      guard++;
      // 在圆盘内均匀采样（sqrt 保证面积均匀，否则中心会过密）
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * R;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;

      const h = terrainHeight(x, z);
      const slope = terrainSlope(x, z);
      // 水边、陡坡、以及噪声给出的「裸沙斑块」上不长草
      if (h < WATER_LEVEL + 0.55 || slope > 0.30) continue;
      const patch = fbm2(x * 0.055 + 31, z * 0.055 - 12, 4) * 0.5 + 0.5
        + fbm2(x * 0.22, z * 0.22, 3) * 0.14;
      if (patch < 0.55) continue;
      // 离出生点太近的地方留白，免得第一眼就是一片草
      if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < 6) continue;

      const i3 = placed * 3;
      aOffset[i3] = x; aOffset[i3 + 1] = h; aOffset[i3 + 2] = z;
      aPhase[placed] = rnd();
      aHeight[placed] = 0.26 + rnd() * 0.55;
      // 色相在黄绿→橄榄→枯黄之间分布，避免整齐划一
      const v = rnd();
      aTint[i3] = 0.24 + v * 0.30;
      aTint[i3 + 1] = 0.30 + v * 0.24;
      aTint[i3 + 2] = 0.10 + v * 0.12;
      placed++;
    }

    geo.instanceCount = placed;
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(aOffset, 3));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(aPhase, 1));
    geo.setAttribute('aHeight', new THREE.InstancedBufferAttribute(aHeight, 1));
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(aTint, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), R + 4);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.u.uTime,
        uWindDir: this.u.uWindDir,
        uWindStrength: this.u.uWindStrength,
        uPlayerPos: this.u.uPlayerPos,
        uSway: { value: 0.42 },
        uSunDir: this.u.uSunDir,
        uSunColor: this.u.uSunColor,
        uSkyTop: this.u.uSkyTop,
        uSkyHorizon: this.u.uSkyHorizon,
        uNadir: this.u.uNadir,
        uFogColor: this.u.uFogColor,
        uFogDensity: this.u.uFogDensity,
        uFogHeightFalloff: this.u.uFogHeightFalloff,
        uExposure: this.u.uExposure,
        uAlphaCutoff: { value: 0.08 },
      },
      vertexShader: S.GRASS_VERT,
      fragmentShader: S.GRASS_FRAG,
      transparent: true,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = true;
    this.grass = mesh;
    this.grassCount = placed;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
  }

  /* ================================================================ *
   * 散布物：岩石 / 棕榈 / 浮木 / 贝壳
   * ================================================================ */
  _buildScatter() {
    const rnd = mulberry32(31337);
    const R = WORLD.grassRadius + 40;

    // ---- 岩石：低模球体 + 噪声位移，再做三种不同尺寸 ----
    const rockGeoBase = new THREE.IcosahedronGeometry(1, 2);
    noiseDeform(rockGeoBase, 0.24, 3.1, 1.7);
    const rockGeo2 = new THREE.IcosahedronGeometry(1, 1);
    noiseDeform(rockGeo2, 0.3, 2.2, 4.1);

    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x8a8073, roughness: 0.88, metalness: 0.0, flatShading: true,
    });
    const rockMatDark = new THREE.MeshStandardMaterial({
      color: 0x6d6459, roughness: 0.92, metalness: 0.0, flatShading: true,
    });
    this.disposables.push(rockMat, rockMatDark);

    const rockA = new THREE.InstancedMesh(rockGeoBase, rockMat, WORLD.rockCount);
    const rockB = new THREE.InstancedMesh(rockGeo2, rockMatDark, Math.floor(WORLD.rockCount * 0.6));
    rockA.castShadow = rockB.castShadow = true;
    rockA.receiveShadow = rockB.receiveShadow = true;

    const m = new THREE.Matrix4();
    let ra = 0, rb = 0;
    for (let i = 0; i < WORLD.rockCount * 4 && (ra < rockA.count || rb < rockB.count); i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * R;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = terrainHeight(x, z);
      if (h < WATER_LEVEL - 0.6) continue;
      // 幂次 3.2 让绝大多数石头都偏小，只有极少数是大块 ——
      // 均匀分布的话，草地上会插满尺寸雷同的石头，很假。
      const s = 0.28 + Math.pow(rnd(), 3.2) * 1.9;
      const useB = rnd() < 0.4;
      const target = useB ? rockB : rockA;
      const idx = useB ? rb : ra;
      if (idx >= target.count) continue;
      m.compose(
        new THREE.Vector3(x, h + s * 0.28, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 1.2 - 0.6, rnd() * 6.28, rnd() * 1.2 - 0.6)),
        new THREE.Vector3(s * (0.8 + rnd() * 0.6), s * (0.55 + rnd() * 0.5), s * (0.8 + rnd() * 0.6))
      );
      target.setMatrixAt(idx, m);
      useB ? rb++ : ra++;
    }
    // 未用满的实例缩到 0，避免出现停在原点的石头
    for (let i = ra; i < rockA.count; i++) rockA.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
    for (let i = rb; i < rockB.count; i++) rockB.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
    rockA.instanceMatrix.needsUpdate = true;
    rockB.instanceMatrix.needsUpdate = true;
    this.group.add(rockA, rockB);
    this.disposables.push(rockGeoBase, rockGeo2);

    // ---- 棕榈树：树干（曲线扫掠）+ 叶片（扁平管体）----
    const palm = this._makePalm(rnd);
    const palmInstances = new THREE.InstancedMesh(palm.geometry, palm.material, WORLD.palmCount);
    palmInstances.castShadow = true;
    let pc = 0;
    for (let i = 0; i < WORLD.palmCount * 6 && pc < WORLD.palmCount; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 40 + Math.sqrt(rnd()) * (R - 60);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = terrainHeight(x, z);
      if (h < WATER_LEVEL + 0.5) continue;
      const s = 0.75 + rnd() * 0.7;
      m.compose(
        new THREE.Vector3(x, h, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rnd() * 6.28, (rnd() - 0.5) * 0.22)),
        new THREE.Vector3(s, s * (0.85 + rnd() * 0.4), s)
      );
      palmInstances.setMatrixAt(pc++, m);
    }
    for (let i = pc; i < palmInstances.count; i++) palmInstances.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
    palmInstances.instanceMatrix.needsUpdate = true;
    this.group.add(palmInstances);
    this.disposables.push(palm.geometry, palm.material);

    // ---- 贝壳：贴地的扁圆锥，只做点缀 ----
    const shellGeo = new THREE.ConeGeometry(0.14, 0.07, 7, 1, false);
    const shellMat = new THREE.MeshStandardMaterial({ color: 0xe8dcc4, roughness: 0.55, metalness: 0.05 });
    const shells = new THREE.InstancedMesh(shellGeo, shellMat, WORLD.shellCount);
    let sc = 0;
    for (let i = 0; i < WORLD.shellCount * 8 && sc < WORLD.shellCount; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * R;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = terrainHeight(x, z);
      if (h < WATER_LEVEL + 0.05 || h > WATER_LEVEL + 2.4) continue;
      m.compose(
        new THREE.Vector3(x, h + 0.02, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 0.3, rnd() * 6.28, rnd() * 0.3)),
        new THREE.Vector3(0.7 + rnd() * 0.9, 0.7 + rnd() * 0.7, 0.7 + rnd() * 0.9)
      );
      shells.setMatrixAt(sc++, m);
    }
    for (let i = sc; i < shells.count; i++) shells.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
    shells.instanceMatrix.needsUpdate = true;
    this.group.add(shells);
    this.disposables.push(shellGeo, shellMat);
  }

  /** 单棵棕榈：弯曲树干 + 12 片下垂叶片 + 椰果 */
  _makePalm(rnd) {
    const parts = [];

    // 树干：从根部向外弯，模拟向光/向海倾斜
    const trunkPts = [];
    const lean = 0.9 + rnd() * 0.6;
    const bend = 0.6 + rnd() * 0.8;
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      trunkPts.push([
        Math.sin(t * 0.7) * bend * 0.6,
        t * 6.2,
        t * t * lean * 0.5,
      ]);
    }
    const trunkCurve = curveFrom(trunkPts);
    const trunkGeo = tubeFromCurve(trunkCurve, (t) => 0.22 * (1 - t * 0.62) + 0.015, {
      segments: 26, radial: 8, capStart: true, capEnd: false,
    });
    parts.push(trunkGeo);

    // 叶冠位置：树干顶端
    const tip = trunkCurve.getPointAt(1);

    const leafMatrices = [];
    const leafCount = 13;
    for (let i = 0; i < leafCount; i++) {
      const yaw = (i / leafCount) * Math.PI * 2 + rnd() * 0.3;
      const pitch = 0.10 + rnd() * 0.45;         // 越大越垂
      const len = 2.4 + rnd() * 1.4;
      // 整片叶子以树干顶端为基点生长
      leafMatrices.push(transformed(
        makeFrond(yaw, pitch, len, rnd),
        TRS(tip.x, tip.y + 0.05, tip.z)
      ));
    }

    // 椰果
    const nutGeo = new THREE.SphereGeometry(0.13, 8, 6);
    for (let i = 0; i < 4; i++) {
      const a = rnd() * 6.28;
      leafMatrices.push(transformed(nutGeo, TRS(
        tip.x + Math.cos(a) * 0.22, tip.y - 0.18 - rnd() * 0.15, tip.z + Math.sin(a) * 0.22,
        0, 0, 0, 1, 1.2, 1
      )));
    }
    nutGeo.dispose();

    const merged = mergeGeometries([...parts, ...leafMatrices]);
    parts.forEach((g) => g.dispose());
    leafMatrices.forEach((g) => g.dispose());

    const mat = new THREE.MeshStandardMaterial({
      color: 0x5d7a3a, roughness: 0.82, metalness: 0.0, flatShading: false,
      vertexColors: false,
    });

    return { geometry: merged, material: mat };
  }

  /* ================================================================ *
   * 云朵
   * ================================================================ */
  _buildClouds() {
    const count = WORLD.cloudCount;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.attributes.position = base.attributes.position;
    geo.attributes.uv = base.attributes.uv;

    const rnd = mulberry32(4242);
    const seeds = new Float32Array(count);
    const scales = new Float32Array(count);
    const pos = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 60 + Math.pow(rnd(), 0.6) * 620;
      pos[i * 3 + 0] = Math.cos(a) * r;
      pos[i * 3 + 1] = 55 + rnd() * 130;
      pos[i * 3 + 2] = Math.sin(a) * r;
      seeds[i] = rnd();
      scales[i] = 55 + rnd() * 150;
    }

    geo.setAttribute('position', new THREE.InstancedBufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    geo.setAttribute('aScale', new THREE.InstancedBufferAttribute(scales, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 100, 0), 2400);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.u.uTime,
        uWindDir: this.u.uWindDir,
        uDrift: { value: 0.9 },
        uSunDir: this.u.uSunDir,
        uSunColor: this.u.uSunColor,
        uSkyTop: this.u.uSkyTop,
        uSkyHorizon: this.u.uSkyHorizon,
        uExposure: this.u.uExposure,
        uOpacity: { value: 0.85 },
      },
      vertexShader: S.CLOUD_VERT,
      fragmentShader: S.CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.clouds = mesh;
    this.group.add(mesh);
    this.disposables.push(base, geo, mat);
  }

  /* ================================================================ *
   * 鸟群
   * ================================================================ */
  _buildFlock() {
    const count = WORLD.birdCount;
    const birdGeo = makeBirdGeometry();
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = birdGeo.index;
    geo.attributes.position = birdGeo.attributes.position;
    geo.attributes.normal = birdGeo.attributes.normal;

    const rnd = mulberry32(9091);
    const phase = new Float32Array(count);
    const speed = new Float32Array(count);
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 40 + rnd() * 260;
      pos[i * 3 + 0] = Math.cos(a) * r;
      pos[i * 3 + 1] = 22 + rnd() * 46;
      pos[i * 3 + 2] = Math.sin(a) * r;
      phase[i] = rnd() * 6.28;
      speed[i] = 5.5 + rnd() * 3.5;
    }
    // 注意：实例偏移不能叫 'position' —— 那会覆盖掉上面的鸟身顶点，
    // 每只鸟的所有顶点都落在同一点上，三角形全部退化，鸟群整片消失。
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(pos, 3));
    geo.setAttribute('aFlapPhase', new THREE.InstancedBufferAttribute(phase, 1));
    geo.setAttribute('aFlapSpeed', new THREE.InstancedBufferAttribute(speed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 40, 0), 400);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.u.uTime,
        uSunDir: this.u.uSunDir,
        uSunColor: this.u.uSunColor,
        uSkyTop: this.u.uSkyTop,
        uSkyHorizon: this.u.uSkyHorizon,
        uFogColor: this.u.uFogColor,
        uFogDensity: this.u.uFogDensity,
        uFogHeightFalloff: this.u.uFogHeightFalloff,
        uExposure: this.u.uExposure,
        uBodyColor: { value: new THREE.Color(0.92, 0.90, 0.86) },
      },
      vertexShader: S.FLOCK_VERT,
      fragmentShader: S.FLOCK_FRAG,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    this.flock = mesh;
    this.flockRoot = new THREE.Group();
    this.flockRoot.add(mesh);
    this.group.add(this.flockRoot);
    this.disposables.push(birdGeo, geo, mat);
  }

  /* ================================================================ *
   * 查询接口
   * ================================================================ */

  /** 世界任意点的地面高度 */
  heightAt(x, z) { return terrainHeight(x, z); }

  /** 地面法线 */
  normalAt(x, z, out) { return terrainNormal(x, z, 0.4, out); }

  /** 水面高度 */
  get waterLevel() { return WATER_LEVEL; }

  /* ================================================================ *
   * 每帧更新
   * ================================================================ */
  update(dt, elapsed, camera, playerPos, speed) {
    const u = this.u;
    u.uTime.value = elapsed;
    u.uPlayerPos.value.copy(playerPos);

    // 风随骑行速度增强（迎面风）
    u.uWindStrength.value = 0.38 + Math.min(1, speed / 22) * 0.85 + this.windBoost;

    // 天空球永远包住相机
    this.sky.position.copy(camera.position);

    // 海面直接跟着相机走。
    // 因为网格是极坐标的、且波浪相位在世界空间里计算，
    // 相机移动不会让波形「游动」—— 这是把相位写成 worldPos 而不是 uv 的好处。
    this.water.position.x = camera.position.x;
    this.water.position.z = camera.position.z;

    // 云与鸟群整体缓慢漂移，并跟随相机水平位置
    this.clouds.position.x = camera.position.x * 0.65;
    this.clouds.position.z = camera.position.z * 0.65;
    this.flockRoot.position.set(
      Math.sin(elapsed * 0.045) * 40,
      Math.sin(elapsed * 0.11) * 6,
      Math.cos(elapsed * 0.037) * 40
    );
    this.flockRoot.rotation.y = elapsed * 0.035;

    // 地形 LOD：按到相机的距离选择索引档位
    this._updateLOD(camera.position);
  }

  _updateLOD(camPos) {
    const maxLod = 2;
    for (const c of this.chunks) {
      const d = Math.hypot(camPos.x - c.cx, camPos.z - c.cz);
      let lod;
      if (this.quality === 'low') lod = d < 220 ? 1 : 2;
      else lod = d < 260 ? 0 : d < 620 ? 1 : 2;
      lod = Math.min(lod, maxLod);
      if (lod !== c.lod) {
        c.geo.setIndex(c.lods[lod]);
        c.lod = lod;
      }
      // 远处地形淡出，避免与雾产生生硬的边界
      const fade = THREE.MathUtils.clamp(1 - (d - 900) / 500, 0.0, 1.0);
      c.mat.uniforms.uChunkFade.value = fade;
      c.mesh.visible = fade > 0.001;
    }
  }

  /** 由 Sky 模块写入的光照状态 */
  applyLighting(state) {
    const u = this.u;
    u.uSunDir.value.copy(state.sunDir);
    u.uSunColor.value.copy(state.sunColor);
    u.uSkyTop.value.copy(state.skyTop);
    u.uSkyHorizon.value.copy(state.skyHorizon);
    u.uNadir.value.copy(state.nadir);
    u.uFogColor.value.copy(state.fogColor);
    u.uFogDensity.value = state.fogDensity;
    u.uFogHeightFalloff.value = state.fogHeightFalloff;
    u.uExposure.value = state.exposure;
    u.uStars.value = state.stars;
  }

  dispose() {
    for (const d of this.disposables) d.dispose?.();
    for (const c of this.chunks) { c.geo.dispose(); c.mat.dispose(); }
    this.scene.remove(this.group);
  }
}

/* ================================================================== *
 * 局部几何工厂
 * ================================================================== */

/**
 * 径向指数网格：用极坐标铺一张「近密远疏」的海面。
 *
 * 半径序列 r_i = A·(e^(k·i/N) − 1)，A 由最外圈半径反推。
 * 相邻环间距 = r_i · (e^k − 1)，也就是「间距正比于当前半径」——
 * 这正是人眼需要的：屏幕上的格子大小大致恒定。
 *
 * uv 直接存**世界坐标**（x, z），这样波浪相位不受网格缩放影响；
 * 顶点着色器里的 Gerstner 位移也就在世界空间里一致，
 * 相机移动时海面不会「漂移」。
 */
function makeRadialOceanGeometry(rings, sectors, extent) {
  const pos = new Float32Array((rings + 1) * (sectors + 1) * 3);
  const uv = new Float32Array((rings + 1) * (sectors + 1) * 2);
  const idx = [];

  const k = Math.log(extent / 0.35 + 1);   // 内圈半径 0.35m → 外圈 extent

  let p = 0;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const r = 0.35 * (Math.exp(k * t) - 1);
    for (let j = 0; j <= sectors; j++) {
      const a = (j / sectors) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      pos[p * 3 + 0] = x;
      pos[p * 3 + 1] = 0;
      pos[p * 3 + 2] = z;
      uv[p * 2 + 0] = x;
      uv[p * 2 + 1] = z;
      p++;
    }
  }

  // 三角形绕序必须让面法线朝上（+Y），否则整片海会被背面剔除 ——
  // 表现为「水面完全看不见，只看到海底的地形」。
  // 验算：v1 = 外环−内环 = 径向(cosθ,0,sinθ)，v2 = 同环下一点−本点 = 切向(−sinθ,0,cosθ)，
  // 则 v1 × v2 = (0,−1,0) 朝下。所以索引要写成 (a, a+1, b) 把绕序反过来。
  const stride = sectors + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < sectors; j++) {
      const a = i * stride + j;
      const b = a + stride;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  geo.computeBoundingSphere();
  return geo;
}

/** 草叶：沿 +Y 收尖的窄条，uv.y 表示「根部→叶尖」 */
function makeBladeGeometry(quads = 3) {
  const rows = quads + 1;
  const pos = [], nrm = [], uv = [], idx = [];
  for (let i = 0; i < rows; i++) {
    const t = i / quads;
    // 宽度：根部最宽，向上收窄，末端接近尖
    const w = 0.5 * (1 - t * t * 0.86) * 0.055;
    // 侧面轮廓轻微前弯，正反面都有光
    const zc = t * t * 0.05;
    pos.push(-w, t, zc, w, t, zc);
    nrm.push(0, 0.35, 0.94, 0, 0.35, 0.94);
    uv.push(0, t, 1, t);
  }
  for (let i = 0; i < quads; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

/**
 * 一片棕榈叶（羽状复叶）。
 *
 * 早先的版本把整片叶子做成一根「扁平管」—— 于是每片叶子都是一条
 * 又长又宽的带子，远看像插了一排绿棍子，完全不像棕榈。
 *
 * 真实的棕榈叶是**羽状**的：一根细叶轴，两侧密排几十片小叶。
 * 这里就按这个结构生成：叶轴用细管，小叶用显式的扁平羽片
 * （featherBlade，与鹈鹕的羽毛共用同一个生成器 —— 叶和羽本来就是同一种几何）。
 * 小叶沿叶轴由内向外逐渐变短、逐渐下垂，这就是棕榈叶轮廓的来源。
 *
 * @param {number} yaw   叶片在水平面上的方位角
 * @param {number} pitch 整片叶子的俯仰（负值向下垂）
 * @param {number} len   叶轴长度
 */
function makeFrond(yaw, pitch, len, rnd) {
  const geos = [];
  const cy = Math.cos(yaw), sy = Math.sin(yaw);

  // ---- 叶轴：从叶柄到叶尖，先扬后垂 ----
  const axisPts = [];
  const N = 10;
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    // 叶轴先微扬、后下垂 —— 但整条叶轴是**以树干顶端为原点**的。
    // 早先的版本把叶轴的 y 从 0 算起，结果 6 米高的树干顶着一圈
    // 趴在地面上的叶子，远看像一丛灌木而不是棕榈。
    const droop = Math.pow(t, 1.8) * 1.25 * (0.5 + Math.abs(pitch));  // 越靠叶尖垂得越狠
    const lift = Math.sin(t * Math.PI * 0.55) * 0.55;
    axisPts.push(new THREE.Vector3(
      cy * len * t,
      lift - droop,
      sy * len * t
    ));
  }
  const axisCurve = curveFrom(axisPts);
  const axisGeo = tubeFromCurve(axisCurve, (t) => 0.035 * (1 - t * 0.72) + 0.006, {
    segments: 24, radial: 6, capStart: true, capEnd: true,
  });
  geos.push(axisGeo);

  // ---- 小叶：沿叶轴两侧密排 ----
  const pairs = 22;
  const _p = new THREE.Vector3();
  const _tan = new THREE.Vector3();
  const _side = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _up = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < pairs; i++) {
    const t = (i + 0.5) / pairs;
    axisCurve.getPointAt(t, _p);
    axisCurve.getTangentAt(t, _tan);
    // 侧向 = 切线 × 世界 up（再归一化），得到水平方向的「左右」
    _side.crossVectors(_tan, _up).normalize();
    if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);

    // 小叶长度：根部短、中段最长、叶尖再收短 —— 棕榈叶的典型轮廓
    const leafLen = len * 0.30 * Math.sin(Math.pow(t, 0.75) * Math.PI * 0.92) + len * 0.05;
    const leafW = leafLen * 0.20;
    // 小叶自身的下垂角：越靠叶尖越向下
    const droopAng = -0.30 - t * 0.85;

    for (const s of [1, -1]) {
      const blade = featherBlade(leafLen, leafW, leafLen * 0.22, 5);
      // 朝向：让羽片的 +Z 指向「侧向 + 下垂」
      const dir = _side.clone().multiplyScalar(s)
        .addScaledVector(_tan, 0.42)
        .addScaledVector(_up, droopAng)
        .normalize();
      // 羽片面（+Y）大致朝上
      const faceUp = _up.clone().addScaledVector(dir, -_up.dot(dir)).normalize();
      const bx = new THREE.Vector3().crossVectors(dir, faceUp).normalize();
      const basis = new THREE.Matrix4().makeBasis(bx, faceUp, dir);
      _q.setFromRotationMatrix(basis);
      _m.compose(_p, _q, new THREE.Vector3(1, 1, 1));
      geos.push(transformed(blade, _m));
      blade.dispose();
    }
  }

  // 合并成一片叶子的几何（减少实例内部的绘制开销）
  const merged = mergeGeometries(geos);
  geos.forEach((g) => g.dispose());
  return merged;
}

/** 鸟：细长身体 + 两片带分段的翅膀，翼展方向为 ±X */
function makeBirdGeometry() {
  const geos = [];

  // 身体：拉长的低模球
  const body = new THREE.SphereGeometry(0.075, 7, 5);
  body.scale(0.75, 0.7, 2.6);
  geos.push(body);

  // 翅膀：从身体向 ±X 展开，翼面沿 X 分成 4 段以承载扑翼波动
  for (const sgn of [1, -1]) {
    const segs = 4;
    const pos = [], nrm = [], uv = [], idx = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const span = t;
      const chord = 0.30 * (1 - t * 0.72) + 0.04;   // 翼弦由宽到窄
      const sweep = -t * 0.16;                      // 后掠
      const y = Math.sin(t * 1.9) * 0.05;           // 静息上反角
      // 前后缘两点
      pos.push(sgn * span, y, sweep - chord * 0.5);
      pos.push(sgn * span, y, sweep + chord * 0.5);
      nrm.push(0, 1, 0, 0, 1, 0);
      uv.push(t, 0, t, 1);
    }
    for (let i = 0; i < segs; i++) {
      const a = i * 2;
      if (sgn > 0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const w = new THREE.BufferGeometry();
    w.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    w.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    w.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    w.setIndex(idx);
    geos.push(w);
  }

  // 尾羽
  const tail = new THREE.PlaneGeometry(0.16, 0.24);
  tail.rotateX(-Math.PI / 2);
  tail.translate(0, 0.005, 0.22);
  geos.push(tail);

  const merged = mergeGeometries(geos);
  geos.forEach((g) => g.dispose());
  return merged;
}

export { WORLD, SPAWN };
