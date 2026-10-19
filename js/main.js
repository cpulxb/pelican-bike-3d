/**
 * main.js —— 装配与主循环
 *
 * 这个文件把前面所有模块接在一起，并负责三件事：
 *   1. 骑行物理：油门/刹车/转向/离地，全部在世界空间里算
 *   2. 场景图装配：把自行车的鞍座、把手、踏板坐标喂给鹈鹕的 IK
 *   3. HUD / 调参面板 / 拍照 / 自适应画质
 *
 * 每帧的执行顺序是有讲究的，不能随意调换：
 *   物理 → 摆好自行车 → 更新自行车骨骼 → 取鞍座/把手/踏板世界坐标
 *        → 摆好鹈鹕 → 更新鹈鹕骨骼（IK 依赖上一步的坐标）
 *        → 更新羽毛蒙皮（依赖上一步的骨骼矩阵）→ 渲染
 * 任何一步提前，都会让鸟的手脚慢一帧、在高速时明显「脱把」。
 */

import * as THREE from 'three';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

import { Environment } from './world/environment.js';
import { SkyDirector } from './world/sky.js';
import { Bike, BIKE } from './objects/bike.js';
import { Pelican } from './objects/pelican.js';
import { FeatherCoat } from './gfx/feather.js';
import { Effects } from './gfx/effects.js';
import { CameraRig } from './camera.js';
import { Input } from './input.js';
import { AudioEngine } from './audio.js';
import { terrainNormal, SPAWN, WATER_LEVEL } from './util/noise.js';

/* ================================================================== *
 * 全局状态
 * ================================================================== */

const $ = (id) => document.getElementById(id);

const state = {
  quality: 'high',
  autoRide: true,
  time: 0.735,            // 从「黄金时刻」开始：光线最饱满，第一眼就能看清主角
  paused: false,
  bare: false,
  ready: false,
};

/** 骑行者状态 */
const player = {
  pos: new THREE.Vector3(SPAWN.x, 0, SPAWN.z),
  yaw: -0.6,
  speed: 0,
  steer: 0,
  lean: 0,
  pitch: 0,
  cadence: 0,
  bump: 0,
  distance: 0,
  vy: 0,
  airborne: false,
  wading: 0,
  _prevHeight: 0,
  _bumpSmooth: 0,
};

const perf = { fps: 60, _acc: 0, _frames: 0, _qualityCooldown: 0, throttled: false };
const speedHistory = new Float32Array(96);
let speedHistoryIdx = 0;

/**
 * 主循环用的时钟与帧间状态。
 * 必须在 main() 里任何「用到它们」的语句之前就绪 —— 这些是模块级 let/const，
 * 存在暂时性死区（TDZ），提前访问会直接抛 ReferenceError。
 */
const clock = {
  last: 0,
  elapsed: 0,
  start() { this.last = performance.now(); },
};
let dtCache = 1 / 60;
let bellRing = 0;

/* ================================================================== *
 * 引导
 * ================================================================== */

const boot = {
  el: null, bar: null, text: null,
  set(p, msg) {
    if (this.bar) this.bar.style.width = `${Math.round(p * 100)}%`;
    if (this.text && msg) this.text.textContent = msg;
  },
  done() {
    if (!this.el) return;
    this.el.classList.add('gone');
    setTimeout(() => { this.el.style.display = 'none'; }, 1000);
  },
};

function toast(msg, ms = 1800) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

/** 让出一帧，让加载界面的进度条能真正画出来 */
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

/* ================================================================== *
 * 主入口
 * ================================================================== */

async function main() {
  boot.el = $('loader');
  boot.bar = $('loader-bar');
  boot.text = $('loader-text');

  const canvas = $('scene');

  /* ---------------- 1. 渲染器 ---------------- */
  boot.set(0.04, '正在唤醒 GPU…');
  await nextFrame();

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
  } catch (err) {
    boot.set(1, '你的浏览器/设备不支持 WebGL2，无法运行此场景');
    console.error(err);
    return;
  }

  if (!renderer.capabilities.isWebGL2) {
    console.warn('未检测到 WebGL2，画质与部分特性将受限');
    state.quality = 'medium';
  }

  // 初始按设备粗略估一个画质档位
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const dpr = Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2);
  if (isMobile) state.quality = 'medium';

  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // 色调映射与输出色彩空间全部交给后处理链的 OutputPass 处理，
  // 这样自研着色器与内置材质走完全相同的映射路径。
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = false;

  /* ---------------- 2. 场景与相机 ---------------- */
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.06, 6000);

  /* ---------------- 3. 世界 ---------------- */
  boot.set(0.14, '正在隆起海岛的沙丘…');
  await nextFrame();

  const env = new Environment(renderer, scene, state.quality);

  boot.set(0.34, '正在点亮黄昏的天空…');
  await nextFrame();

  const sky = new SkyDirector(env, { time: state.time, autoAdvance: true, dayLength: 420 });
  env.applyLighting(sky.state);

  /* ---------------- 4. 光源（供 MeshStandardMaterial 使用）---------------- */
  // 自研着色器读共享 uniform，内置材质读这三盏灯 —— 两者必须由同一份状态驱动。
  const sunLight = new THREE.DirectionalLight(0xffffff, 3.0);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(
    state.quality === 'low' ? 1024 : 2048,
    state.quality === 'low' ? 1024 : 2048
  );
  sunLight.shadow.camera.near = 0.5;
  sunLight.shadow.camera.far = 90;
  const SH = 14;
  sunLight.shadow.camera.left = -SH;
  sunLight.shadow.camera.right = SH;
  sunLight.shadow.camera.top = SH;
  sunLight.shadow.camera.bottom = -SH;
  sunLight.shadow.bias = -0.0009;
  sunLight.shadow.normalBias = 0.022;
  scene.add(sunLight);
  scene.add(sunLight.target);

  const hemiLight = new THREE.HemisphereLight(0x9fc4e8, 0x2a3a44, 0.55);
  scene.add(hemiLight);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.35);
  scene.add(fillLight);

  /* ---------------- 4b. 环境反射（IBL）----------------
   *
   * 这一步不是锦上添花，而是必需的：
   * MeshStandardMaterial 的金属度一旦超过 ~0.5，漫反射项就被完全抑制，
   * 表面颜色几乎全部来自环境反射。如果场景里没有 environment，
   * 车架的金属漆、镀铬件、喙上的金属高光会一律渲染成死黑 ——
   * 这不是「暗」，而是物理上「没有东西可反射」。
   *
   * 做法是把天空球单独渲染进一张 PMREM 贴图：
   * 于是镀铬件会真的反射出黄昏的天空与太阳，而且随着时刻推移自动变色。
   */
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileCubemapShader?.();

  const envScene = new THREE.Scene();
  const skyProxy = new THREE.Mesh(env.sky.geometry, env.sky.material);
  envScene.add(skyProxy);

  let envRT = null;
  let envBakeTimer = 0;

  function bakeEnvironment() {
    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();
    renderer.autoClear = true;          // PMREM 内部依赖自动清屏
    try {
      const next = pmrem.fromScene(envScene, 0, 1, 2000);
      if (envRT) envRT.dispose();
      envRT = next;
      scene.environment = envRT.texture;
      scene.environmentIntensity = 0.85;
    } catch (err) {
      console.warn('环境贴图烘焙失败，金属材质会偏暗：', err);
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  bakeEnvironment();

  /* ---------------- 5. 自行车 ---------------- */
  boot.set(0.5, '正在组装自行车…');
  await nextFrame();

  const bike = new Bike(env);
  scene.add(bike.root);

  /* ---------------- 6. 鹈鹕 ---------------- */
  boot.set(0.62, '正在给鹈鹕梳理羽毛…');
  await nextFrame();

  const pelican = new Pelican(env, { quality: state.quality });
  scene.add(pelican.root);

  boot.set(0.78, '正在铺上 1200 片羽毛…');
  await nextFrame();

  const feathers = new FeatherCoat(pelican.root, pelican.featherAnchors, env.u, state.quality);
  pelican.root.add(feathers.mesh);

  /* ---------------- 7. 后处理 ---------------- */
  boot.set(0.86, '正在调校镜头与胶片…');
  await nextFrame();

  const effects = new Effects(renderer, scene, camera, env, state.quality);

  /* ---------------- 8. 相机 / 输入 / 音频 ---------------- */
  const rig = new CameraRig(camera, env);
  const audio = new AudioEngine();

  const input = new Input(canvas, {
    buttons: Array.from(document.querySelectorAll('.controls button')),
    onFirstInteraction: () => audio.init(),
  });

  // 让屏幕按钮能切换「自动骑行」
  input.toggleAuto = () => {
    state.autoRide = !state.autoRide;
    const btn = document.querySelector('.controls button[data-act="auto"]');
    if (btn) btn.classList.toggle('on', state.autoRide);
    toast(state.autoRide ? '自动骑行' : '手动操控');
  };

  /* ---------------- 9. 调参面板 ---------------- */
  const gui = buildGUI();

  /* ---------------- 10. 初始摆位 ---------------- */
  player.pos.y = env.heightAt(player.pos.x, player.pos.z);
  player._prevHeight = player.pos.y;

  /* ---------------- 11. 事件 ---------------- */
  bindWindowEvents();

  /* ---------------- 12. 起跑 ---------------- */
  boot.set(1, '出发！');
  await nextFrame();
  setTimeout(() => boot.done(), 260);

  state.ready = true;
  clock.start();
  requestAnimationFrame(tick);

  /* ================================================================ *
   * 窗口事件
   * ================================================================ */
  function bindWindowEvents() {
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const w = window.innerWidth, h = window.innerHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
        effects.setSize(w, h);
      }, 120);
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      rig.applyZoom(e.deltaY);
    }, { passive: false });

    // 页面隐藏时暂停时间推进，回来不会「瞬移」到另一个时段
    document.addEventListener('visibilitychange', () => {
      state.paused = document.hidden;
    });

    // 触屏：双指缩放
    let pinchDist = 0;
    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        const d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        if (pinchDist) rig.applyZoom((pinchDist - d) * 3.2);
        pinchDist = d;
      }
    }, { passive: true });
    canvas.addEventListener('touchend', () => { pinchDist = 0; });
  }

  /* ================================================================ *
   * 调参面板
   * ================================================================ */
  function buildGUI() {
    const g = new GUI({ title: '鹈鹕骑行 · 参数', width: 268 });
    g.domElement.style.display = 'none';   // 默认收起，按 G 或点按钮展开

    // ---- 时间 ----
    const fTime = g.addFolder('时间与光照');
    const timeCtl = {
      时刻: state.time,
      自动推进: true,
      一天时长秒: 300,
      云雾量: env.u.uCloudCover.value,
      风: env.u.uWindStrength.value,
      曝光: 1.0,
    };
    fTime.add(timeCtl, '时刻', 0, 1, 0.001)
      .onChange((v) => { sky.setTime(v); sky._updateState(); env.applyLighting(sky.state); })
      .listen();
    fTime.add(timeCtl, '自动推进').onChange((v) => { sky.autoAdvance = v; });
    fTime.add(timeCtl, '一天时长秒', 30, 1200, 10).onChange((v) => { sky.dayLength = v; });
    fTime.add(timeCtl, '云雾量', 0, 0.95, 0.01).onChange((v) => { env.u.uCloudCover.value = v; });
    fTime.add(timeCtl, '风', 0, 1.5, 0.01).onChange((v) => { env.u.uWindStrength.value = v; });
    fTime.add(timeCtl, '曝光', 0.4, 2.0, 0.01).onChange((v) => { sky.state.exposure = v; });

    // ---- 相机 ----
    const fCam = g.addFolder('摄影机');
    const camCtl = {
      机位: rig.mode,
      视场角: 55,
      平滑: rig.chase.smooth,
    };
    fCam.add(camCtl, '机位', ['chase', 'orbit', 'pov', 'cinematic'])
      .onChange((v) => rig.setMode(v));
    fCam.add(camCtl, '视场角', 30, 95, 1).onChange((v) => {
      rig.baseFov = v; camera.fov = v; camera.updateProjectionMatrix();
    });
    fCam.add(camCtl, '平滑', 1, 12, 0.1).onChange((v) => { rig.chase.smooth = v; });

    // ---- 画质 ----
    const fQ = g.addFolder('画质');
    const qCtl = {
      画质档: state.quality,
      羽毛: true,
      草: true,
      辉光强度: effects.bloom.strength,
      颗粒: effects.grade.uniforms.uGrain.value,
      暗角: 1.0,
      色差: 1.0,
    };
    fQ.add(qCtl, '画质档', ['low', 'medium', 'high']).onChange((v) => {
      state.quality = v;
      env.quality = v;
      applyQuality(v);      // 与自适应降档走同一条路径，像素比/后处理一起生效
      perf._qualityCooldown = 12;   // 手动选过之后，12 秒内别再被自动改回去
      toast(`画质：${v}`);
    });
    fQ.add(qCtl, '羽毛').onChange((v) => feathers.setVisible(v));
    fQ.add(qCtl, '草').onChange((v) => { env.grass.visible = v; });
    fQ.add(qCtl, '辉光强度', 0, 1.5, 0.01).onChange((v) => { effects._bloomOverride = v; });
    fQ.add(qCtl, '颗粒', 0, 0.12, 0.001).onChange((v) => { effects.grade.uniforms.uGrain.value = v; });
    fQ.add(qCtl, '暗角', 0, 1.6, 0.01).onChange((v) => { effects.grade.uniforms.uVignette.value = v; });
    fQ.add(qCtl, '色差', 0, 2.5, 0.01).onChange((v) => { effects.grade.uniforms.uAberration.value = v; });

    // ---- 骑行 ----
    const fR = g.addFolder('骑行手感');
    const rCtl = {
      自动骑行: state.autoRide,
      最大速度: 17,
      加速度: 6.2,
      刹车力: 12,
      重力: 20,
    };
    fR.add(rCtl, '自动骑行').onChange((v) => {
      state.autoRide = v;
      const btn = document.querySelector('.controls button[data-act="auto"]');
      if (btn) btn.classList.toggle('on', v);
    });
    fR.add(rCtl, '最大速度', 6, 30, 0.5).onChange((v) => { PHYS.maxSpeed = v; });
    fR.add(rCtl, '加速度', 2, 16, 0.1).onChange((v) => { PHYS.accel = v; });
    fR.add(rCtl, '刹车力', 4, 30, 0.5).onChange((v) => { PHYS.brake = v; });
    fR.add(rCtl, '重力', 8, 40, 0.5).onChange((v) => { PHYS.gravity = v; });

    // ---- 统计 ----
    const fS = g.addFolder('统计').close();
    fS.add(perf, 'fps').listen().disable();

    return { gui: g, timeCtl, camCtl };
  }

  /* ================================================================ *
   * 骑行物理参数
   * ================================================================ */
  const PHYS = {
    maxSpeed: 17,          // m/s ≈ 61 km/h
    accel: 8.5,
    brake: 12,
    drag: 0.026,           // 空气阻力系数
    rollResist: 0.85,      // 滚动阻力（沙地偏大，但不能大到起步拖沓）
    turnRate: 1.35,        // rad/s @ 全打把
    gravity: 20,
    jumpSpeed: 5.6,
    worldRadius: 226,      // 软边界（岸线在 r≈225，再往外就是海）
  };

  /* ================================================================ *
   * 物理
   * ================================================================ */
  const _n = { x: 0, y: 1, z: 0 };
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _saddleW = new THREE.Vector3();
  const _gripL = new THREE.Vector3();
  const _gripR = new THREE.Vector3();
  const _pedalL = new THREE.Vector3();
  const _pedalR = new THREE.Vector3();
  const _headWorld = new THREE.Matrix4();
const _eyeWorld = new THREE.Matrix4();

  const rigQuat = new THREE.Quaternion();
  const leanQuat = new THREE.Quaternion();

  function stepPhysics(dt) {
    const st = input.state;

    // ---- 油门 ----
    // 自动骑行时：把油门交给一个缓慢起伏的「巡航」曲线，偶尔冲刺
    let throttle = st.throttle;
    if (state.autoRide) {
      const t = state.time * 0;   // 用真实时间，不用时刻
      const cruise = 0.74 + 0.22 * Math.sin(clock.elapsed * 0.21)
        + 0.10 * Math.sin(clock.elapsed * 0.57 + 1.3);
      throttle = THREE.MathUtils.clamp(cruise, 0, 1);
      // 接近边界或水面时收油
      const r = Math.hypot(player.pos.x, player.pos.z);
      if (r > PHYS.worldRadius * 0.82) throttle *= 0.3;
    }

    // 涉水时明显减速
    player.wading = THREE.MathUtils.clamp(
      (WATER_LEVEL + 0.25 - player.pos.y) / 0.5, 0, 1
    );

    // ---- 纵向动力学 ----
    const drive = throttle * PHYS.accel * (1 - player.wading * 0.72);
    const brakeF = st.brake * PHYS.brake;
    const drag = PHYS.drag * player.speed * player.speed;
    const roll = PHYS.rollResist * (1 + player.wading * 3.2) * Math.sign(player.speed);

    player.speed += (drive - brakeF - drag - roll) * dt;
    player.speed = Math.max(0, Math.min(PHYS.maxSpeed, player.speed));

    // 上坡时自然减速（重力沿坡面的分量）
    const slopeAlong = -_n.x * Math.sin(player.yaw) - _n.z * Math.cos(player.yaw);
    player.speed -= Math.max(0, slopeAlong) * 5.5 * dt;
    player.speed = Math.max(0, player.speed);

    // ---- 转向 ----
    // 静止时打把不转弯；速度越高，同样的把量产生的转弯半径越大
    const steerInput = state.autoRide ? autoSteer() : st.steer;
    player.steer += (steerInput - player.steer) * Math.min(1, dt * 5.0);

    const speedFactor = THREE.MathUtils.clamp(player.speed / 4.5, 0, 1)
      * THREE.MathUtils.clamp(1 - player.speed / (PHYS.maxSpeed * 2.4), 0.35, 1);

    // 符号约定：player.steer > 0 表示「车把向右打」——
    // 与 bike.js 的转向组、input.js 的 D 键保持同一套（那里也是 +1 = 右）。
    //
    // 车身朝向 yaw 增大 = 朝 +X，而模型局部 -X 才是车手的右侧
    // （右手系里 right = forward × up，forward=+Z、up=+Y 代入得 right=-X）。
    // 所以「向右打把」必须让 yaw 递减 —— 这里写成 += 的话，
    // 前轮明明朝右、整辆车却往左拐，就是「轮胎转向没问题但移动方向不对」的成因。
    player.yaw -= player.steer * PHYS.turnRate * speedFactor * dt;

    // ---- 侧倾：向弯内倾，倾角与「向心加速度」成正比 ----
    // lean > 0 = 车顶倒向 -X = 倒向车手右侧（实测 d(up.x)/d(lean) ≈ -1）。
    // 右转（steer > 0）要向右倒，所以这里是正号；写成负号会变成「向外倾」。
    const targetLean = player.steer * speedFactor * 0.42;
    player.lean += (targetLean - player.lean) * Math.min(1, dt * 3.6);

    // ---- 位移 ----
    const vx = Math.sin(player.yaw) * player.speed;
    const vz = Math.cos(player.yaw) * player.speed;
    player.pos.x += vx * dt;
    player.pos.z += vz * dt;
    player.distance += player.speed * dt;

    // ---- 软边界：越界后逐渐被拉回 ----
    const r = Math.hypot(player.pos.x, player.pos.z);
    if (r > PHYS.worldRadius) {
      const over = (r - PHYS.worldRadius) / 60;
      player.yaw -= Math.sign(Math.sin(player.yaw) * player.pos.x / r + Math.cos(player.yaw) * player.pos.z / r)
        * 0.0;   // 保留转向，靠下面的速度衰减拉回
      player.speed *= Math.max(0, 1 - over * 0.9 * dt);
    }

    // ---- 地面高度与法线 ----
    const gh = env.heightAt(player.pos.x, player.pos.z);
    env.normalAt(player.pos.x, player.pos.z, _n);

    // ---- 垂直运动（跳跃 / 贴合地面）----
    if (player.airborne) {
      player.vy -= PHYS.gravity * dt;
      player.pos.y += player.vy * dt;
      if (player.pos.y <= gh) {
        player.pos.y = gh;
        // 落地：速度越快、下落越急，颠簸越强
        const impact = Math.min(1, Math.abs(player.vy) / 8);
        player._bumpSmooth = Math.min(1, player._bumpSmooth + impact * 0.85);
        player.vy = 0;
        player.airborne = false;
      }
    } else {
      // 贴合地面：用平滑跟随，让上下坡有悬挂感而不是硬贴
      const k = 1 - Math.exp(-16 * dt);
      const newY = player.pos.y + (gh - player.pos.y) * k;
      // 地面升高带来的垂直速度（用于颠簸与起跳判定）
      player.vy = (newY - player.pos.y) / Math.max(dt, 1e-4);
      player.pos.y = newY;

      if (st.jump && player.speed > 2.2) {
        player.airborne = true;
        player.vy = PHYS.jumpSpeed + player.speed * 0.12;
        audio.ringBell();
      }
    }

    // ---- 颠簸强度：地面高度变化率 + 涉水 ----
    const dh = Math.abs(player.pos.y - player._prevHeight) / Math.max(dt, 1e-4);
    player._prevHeight = player.pos.y;
    const rough = THREE.MathUtils.clamp(dh / 3.2, 0, 1)
      + player.wading * 0.45
      + Math.abs(_n.x) + Math.abs(_n.z) > 0.5 ? 0.1 : 0;
    // 平滑，避免单帧尖峰让相机乱抖
    player._bumpSmooth += (rough - player._bumpSmooth) * Math.min(1, dt * 8.0);
    player.bump = THREE.MathUtils.clamp(player._bumpSmooth, 0, 1);

    // ---- 俯仰：沿行进方向的地面坡度 ----
    const targetPitch = Math.asin(THREE.MathUtils.clamp(
      _n.x * Math.sin(player.yaw) + _n.z * Math.cos(player.yaw), -0.6, 0.6
    ));
    player.pitch += (targetPitch - player.pitch) * Math.min(1, dt * 6.0);

    // ---- 踏频 ----
    // 有速度就踩；无速度时怠速缓慢空转，看起来还在准备发力
    const gearRatio = 2.6;
    const wheelRpm = (player.speed / (2 * Math.PI * BIKE.wheelRadius)) * 60;
    player.cadence = player.speed > 0.4 ? wheelRpm / gearRatio : 0;
    player.cadence += Math.sin(clock.elapsed * 1.7) * 1.5;   // 呼吸式的微小起伏

    // ---- 方位角（用于 HUD）----
    player.heading = (player.yaw * 180 / Math.PI + 360) % 360;
  }

  /** 自动骑行的转向：沿海岸线绕圈，偶尔走直线 */
  function autoSteer() {
    const r = Math.hypot(player.pos.x, player.pos.z);
    // 目标是维持在一个半径范围内巡航
    const wantR = 150 + Math.sin(clock.elapsed * 0.07) * 45;
    const err = r - wantR;

    // 把「半径误差」转成朝向修正：径向方向与当前朝向的夹角。
    //
    // 注意这里必须是「朝向 - 径向」，即 radial - π/2，而不是 + π/2。
    // yaw 的约定是 (sin yaw, cos yaw) 为前进方向，所以 yaw 增大 = 朝 +X 转；
    // 而 2D 极角 atan2(x, z) 增大 = 同样朝 +X 转，两者同向。
    // 要让 r 变大，前进方向必须往「径向」那一侧偏 —— 也就是 yaw 朝 radial 靠，
    // 于是取 radial - π/2（逆时针绕行、每圈半径可控）。
    // 写成 + π/2 时，前进方向指向切向的另一侧，半径误差的修正就整体反号：
    // r 偏小反而继续内收、r 偏大反而外扩，鸟于是贴着原点打转，永远出不去。
    const radial = Math.atan2(player.pos.x, player.pos.z);
    let desired = radial - Math.PI * 0.5;
    desired += THREE.MathUtils.clamp(-err * 0.012, -0.55, 0.55);

    // 避开深水：如果前方是水，就往回拐
    const ahead = 6;
    const fx = player.pos.x + Math.sin(player.yaw) * ahead;
    const fz = player.pos.z + Math.cos(player.yaw) * ahead;
    if (env.heightAt(fx, fz) < WATER_LEVEL + 0.15) {
      desired += 0.85;   // 强行转向
    }

    let diff = desired - player.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    // 取负号：这里算出来的 diff 是「yaw 还差多少」，而 steer 的约定是
    // 「正 = 向右打把 = yaw 减小」。diff 为正表示还要往 yaw 增大的方向转，
    // 对应的是向左打把（steer 为负），所以要把符号翻过来。
    return THREE.MathUtils.clamp(-diff * 1.6, -1, 1);
  }

  /* ================================================================ *
   * 场景图装配
   * ================================================================ */
  function placeRig() {
    // ---- 构造「贴合地面」的朝向 ----
    _up.set(_n.x, _n.y, _n.z).normalize();
    _fwd.set(Math.sin(player.yaw), 0, Math.cos(player.yaw));
    // 把前进方向投影到与 up 垂直的平面上
    _fwd.addScaledVector(_up, -_fwd.dot(_up));
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();
    _right.crossVectors(_up, _fwd).normalize();

    // 注意：three 的基向量顺序是 (x, y, z)，这里 x=right, y=up, z=forward
    _m.makeBasis(_right, _up, _fwd);
    rigQuat.setFromRotationMatrix(_m);

    // 叠加动态侧倾：绕前进轴旋转
    leanQuat.setFromAxisAngle(_fwd, player.lean);
    rigQuat.premultiply(leanQuat);

    // ---- 自行车 ----
    bike.root.position.copy(player.pos);
    bike.root.quaternion.copy(rigQuat);
    bike.root.updateMatrixWorld(true);

    bike.update(dtCache, {
      speed: player.speed,
      cadence: player.cadence,
      steer: player.steer * BIKE.steerMax,
      lean: 0,       // 侧倾已经在 rigQuat 里了
      pitch: 0,
      bellRing: bellRing,
    });
    bike.root.updateMatrixWorld(true);

    // ---- 取锚点世界坐标 ----
    bike.getSaddleWorldPosition(_saddleW);
    bike.getGripWorldPosition('L', _gripL);
    bike.getGripWorldPosition('R', _gripR);
    bike.getPedalWorldPosition('L', _pedalL);
    bike.getPedalWorldPosition('R', _pedalR);

    // ---- 鹈鹕：与自行车共用同一套朝向 ----
    pelican.root.position.copy(_saddleW);
    pelican.root.quaternion.copy(rigQuat);
  }

  /* ================================================================ *
   * 主循环
   * ================================================================ */
  function tick(now) {
    requestAnimationFrame(tick);

    // ---- 时间步长 ----
    // dt 必须夹上限，否则从后台切回来时一帧 5 秒，物理会直接飞出世界。
    // 但夹取会掩盖「这一帧其实是被浏览器限流的」这一事实，
    // 所以额外记一个 throttled 标志，供帧率统计与自适应画质使用。
    const raw = (now - clock.last) / 1000;
    clock.last = now;
    perf.throttled = raw > 0.25;
    const dt = Math.min(0.05, Math.max(0.0001, raw));
    dtCache = dt;
    if (!state.paused) clock.elapsed += dt;

    // ---- 输入 ----
    const events = input.consumeEvents();
    const pDelta = input.consumePointerDelta();
    if (pDelta.x || pDelta.y) rig.applyPointerDelta(pDelta.x, pDelta.y);
    input.update(dt);

    // ---- 事件处理 ----
    handleEvents(events);

    // ---- 物理 ----
    if (!state.paused) stepPhysics(dt);
    bellRing = Math.max(0, bellRing - dt * 2.2);

    // ---- 场景图 ----
    placeRig();

    // ---- 鹈鹕骨骼（IK 需要把手/踏板的世界坐标）----
    if (!state.paused) {
      pelican.update(dt, {
        time: clock.elapsed,
        speed: player.speed,
        cadence: player.cadence,
        crankPhase: bike.crankPhase,
        gripL: _gripL,
        gripR: _gripR,
        pedalL: _pedalL,
        pedalR: _pedalR,
        bump: player.bump,
      });
    }

    // ---- 羽毛蒙皮（依赖上一步的骨骼矩阵）----
    feathers.update(player.speed);

    // ---- 世界动画 ----
    if (!state.paused) sky.update(dt);
    env.update(dt, clock.elapsed, camera, player.pos, player.speed);

    // ---- 环境贴图重烘焙：每 8 秒一次 ----
    // 天空颜色一直在随时刻变化，镀铬件反射的天空也应该跟着变。
    // 每帧重烘焙代价太大（一次 PMREM 要渲染 6 个立方体面），
    // 8 秒的粒度对肉眼完全够用 —— 黄昏时天空的显著变化大约就是这个尺度。
    envBakeTimer += dt;
    if (envBakeTimer > 8) {
      envBakeTimer = 0;
      bakeEnvironment();
    }

    // ---- 光源同步 ----
    syncLights();

    // ---- 相机 ----
    pelican.head.updateWorldMatrix(true, false);
    _headWorld.copy(pelican.head.matrixWorld);
    pelican.getEyeWorld(_eyeWorld);

    rig.update(dt, {
      position: player.pos,
      yaw: player.yaw,
      speed: player.speed,
      lean: player.lean,
      pitch: player.pitch,
      bump: player.bump,
      headWorld: _headWorld,
      eyeWorld: _eyeWorld,
      rootQuaternion: rigQuat,
      time: clock.elapsed,
    });

    // ---- 音频 ----
    audio.update(dt, { speed: player.speed, cadence: player.cadence });

    // ---- HUD ----
    updateHUD(dt);

    // ---- 自适应画质 ----
    adaptQuality(dt);

    // ---- 渲染 ----
    effects.render(dt, {
      speed: player.speed,
      exposure: sky.state.exposure,
      fade: 0,
      time: clock.elapsed,
    });
  }

  /* ================================================================ *
   * 事件
   * ================================================================ */
  function handleEvents(e) {
    if (e.camera) {
      if (e.camera === 1) rig.setMode('chase');
      else if (e.camera === 2) rig.setMode('orbit');
      else if (e.camera === 3) rig.setMode('pov');
      else rig.setMode('cinematic');
      toast(`机位：${rig.modeLabel}`);
    }
    if (e.bell) {
      bellRing = 1;
      audio.ringBell();
    }
    if (e.audio) {
      const on = audio.toggle();
      const btn = document.querySelector('.controls button[data-act="audio"]');
      if (btn) btn.classList.toggle('on', on);
      toast(on ? '声音已开' : '声音已关');
    }
    if (e.gui) {
      const el = gui.gui.domElement;
      const show = el.style.display === 'none';
      el.style.display = show ? '' : 'none';
      toast(show ? '参数面板已展开（G 收起）' : '参数面板已收起');
    }
    if (e.hideUI) {
      state.bare = !state.bare;
      document.body.classList.toggle('bare', state.bare);
    }
    if (e.reset) {
      player.pos.set(SPAWN.x, env.heightAt(SPAWN.x, SPAWN.z), SPAWN.z);
      player.yaw = -0.6;
      player.speed = 0;
      player.distance = 0;
      rig.setMode('chase');
      toast('已重置到出生点');
    }
    if (e.photo) {
      capturePhoto();
    }
  }

  /* ================================================================ *
   * 光源同步
   * ================================================================ */
  function syncLights() {
    const s = sky.state;

    sunLight.position.copy(player.pos).addScaledVector(s.sunDir, 45);
    sunLight.target.position.copy(player.pos);
    sunLight.target.updateMatrixWorld();

    sunLight.color.copy(s.sunColor);
    // 太阳落到地平线以下时，把直射光压到很弱，只留一点点补光
    const above = THREE.MathUtils.clamp(s.sunDir.y / 0.25, 0, 1);
    sunLight.intensity = 3.4 * (0.12 + above * 0.88);
    sunLight.castShadow = above > 0.06;

    hemiLight.color.copy(s.skyTop);
    hemiLight.groundColor.copy(s.nadir);
    hemiLight.intensity = 0.30 + above * 0.45;

    // 逆光补光：从太阳反方向补一点，避免背光面死黑
    fillLight.position.copy(player.pos).addScaledVector(s.sunDir, -30).setY(player.pos.y + 12);
    fillLight.color.copy(s.skyHorizon);
    fillLight.intensity = 0.22 + (1 - above) * 0.30;
  }

  /* ================================================================ *
   * HUD
   * ================================================================ */
  const hud = {
    speed: $('t-speed'), cadence: $('t-cadence'), odo: $('t-odo'),
    heading: $('t-heading'), alt: $('t-alt'), clock: $('t-clock'),
    fps: $('t-fps'), tris: $('t-tris'),
  };
  const spark = $('sparkline');
  const sparkCtx = spark ? spark.getContext('2d') : null;
  let hudAcc = 0;

  function updateHUD(dt) {
    // 帧率统计。
    //
    // 注意这里必须用 perf.throttled 而不是 dt：tick() 里的 dt 已经被
    // 夹到 0.05 上限（防止切回标签页时物理爆炸），所以后台限流产生的
    // 1 秒长帧在 dt 上看起来和正常帧一模一样，会把帧率恒定报成 20。
    // 判断依据只能是未经夹取的原始帧间隔。
    if (!perf.throttled) {
      perf._acc += dt;
      perf._frames++;
      if (perf._acc >= 0.5) {
        perf.fps = Math.round(perf._frames / perf._acc);
        perf._acc = 0;
        perf._frames = 0;
      }
    }

    hudAcc += dt;
    if (hudAcc < 0.1) return;
    hudAcc = 0;

    const kmh = player.speed * 3.6;
    if (hud.speed) hud.speed.textContent = kmh.toFixed(1);
    if (hud.cadence) hud.cadence.textContent = Math.round(Math.max(0, player.cadence));
    if (hud.odo) hud.odo.textContent = (player.distance / 1000).toFixed(3);
    if (hud.heading) hud.heading.textContent = String(Math.round(player.heading)).padStart(3, '0');
    if (hud.alt) hud.alt.textContent = (player.pos.y - WATER_LEVEL).toFixed(1);
    if (hud.clock) hud.clock.textContent = sky.timeLabel;
    // 被限流时不要显示上一次统计出来的数字 —— 那个数字已经过期了，
    // 显示出来只会让人以为「场景只有 53fps」。用 — 表示「这一帧不算数」。
    if (hud.fps) hud.fps.textContent = perf.throttled ? '—' : perf.fps;
    if (hud.tris) hud.tris.textContent = Math.round(renderer.info.render.triangles / 1000);

    // 速度曲线
    speedHistory[speedHistoryIdx] = player.speed;
    speedHistoryIdx = (speedHistoryIdx + 1) % speedHistory.length;
    drawSparkline();
  }

  function drawSparkline() {
    if (!sparkCtx) return;
    const w = spark.width, h = spark.height;
    sparkCtx.clearRect(0, 0, w, h);

    const maxV = PHYS.maxSpeed;
    const n = speedHistory.length;

    // 填充区域
    sparkCtx.beginPath();
    sparkCtx.moveTo(0, h);
    for (let i = 0; i < n; i++) {
      const v = speedHistory[(speedHistoryIdx + i) % n];
      const x = (i / (n - 1)) * w;
      const y = h - (v / maxV) * h * 0.92 - 1;
      sparkCtx.lineTo(x, y);
    }
    sparkCtx.lineTo(w, h);
    sparkCtx.closePath();

    const grad = sparkCtx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255, 179, 71, 0.30)');
    grad.addColorStop(1, 'rgba(255, 179, 71, 0.02)');
    sparkCtx.fillStyle = grad;
    sparkCtx.fill();

    // 折线
    sparkCtx.beginPath();
    for (let i = 0; i < n; i++) {
      const v = speedHistory[(speedHistoryIdx + i) % n];
      const x = (i / (n - 1)) * w;
      const y = h - (v / maxV) * h * 0.92 - 1;
      i === 0 ? sparkCtx.moveTo(x, y) : sparkCtx.lineTo(x, y);
    }
    sparkCtx.strokeStyle = 'rgba(255, 179, 71, 0.85)';
    sparkCtx.lineWidth = 1.4;
    sparkCtx.stroke();
  }

  /* ================================================================ *
   * 自适应画质
   * ================================================================ */
  function adaptQuality(dt) {
    perf._qualityCooldown -= dt;
    if (perf._qualityCooldown > 0 || !state.ready) return;

    // 页面不可见时不做画质决策：后台标签页的 rAF 会被限流到 1Hz，
    // 那不代表设备性能不足。
    if (document.hidden || perf.throttled) return;

    // 降档的门槛要保守：截图、录屏、系统瞬时负载都会让帧率短暂掉下去，
    // 如果一掉就降画质，用户会觉得画面「莫名其妙变糊」。
    // 所以要求连续低于 30fps 才降，且降档后有 12 秒的冷却期。
    if (perf.fps < 30 && state.quality !== 'low') {
      perf._qualityCooldown = 12;
      const next = state.quality === 'high' ? 'medium' : 'low';
      state.quality = next;
      env.quality = next;
      applyQuality(next);
      toast(`性能吃紧，画质自动降到 ${next}`);
    } else if (perf.fps > 56 && state.quality === 'low') {
      perf._qualityCooldown = 18;
      state.quality = 'medium';
      env.quality = 'medium';
      applyQuality('medium');
      toast('性能充裕，画质自动升到 medium');
    }
  }

  function applyQuality(q) {
    // 像素比是最大的一根杠杆：从 2x 降到 1.25x，像素数直接少 60%。
    const pr = q === 'low' ? Math.min(1, dpr) : q === 'medium' ? Math.min(1.35, dpr) : dpr;
    renderer.setPixelRatio(pr);
    effects.composer.setPixelRatio(pr);
    effects.setSize(window.innerWidth, window.innerHeight);

    if (q === 'low') {
      effects.speedBlur.enabled = false;
      effects.grade.uniforms.uGrain.value = 0.02;
      sunLight.shadow.mapSize.set(1024, 1024);
      if (sunLight.shadow.map) { sunLight.shadow.map.dispose(); sunLight.shadow.map = null; }
      // 注意：这里不关羽毛。
      // 羽毛是鹈鹕唯一的表面细节，关掉之后它就从「一只鸟」退化成
      // 一颗光溜溜的白蛋 —— 省下的那点性能远不值得。
    } else {
      effects.speedBlur.enabled = true;
      effects.grade.uniforms.uGrain.value = 0.035;
    }

    // 辉光强度必须写 bloomBase 而不是 bloom.strength ——
    // render() 每帧都用 bloomBase × bloomBoost 重算一次 strength，
    // 直接写 strength 会在下一帧被覆盖掉，降档等于没降。
    effects.bloomBase = q === 'low' ? 0.0 : q === 'medium' ? 0.42 : 0.58;
  }

  /* ================================================================ *
   * 拍照
   * ================================================================ */
  function capturePhoto() {
    audio.shutter();

    // 白闪
    const flash = document.createElement('div');
    flash.style.cssText = `
      position:fixed;inset:0;background:#fff;z-index:60;pointer-events:none;
      opacity:0.85;transition:opacity .42s cubic-bezier(.22,1,.36,1);`;
    document.body.appendChild(flash);
    requestAnimationFrame(() => { flash.style.opacity = '0'; });
    setTimeout(() => flash.remove(), 500);

    // 必须等这一帧渲染完，toDataURL 才能拿到内容。
    // preserveDrawingBuffer 为 false 时，缓冲区在合成后即被清空，
    // 所以这里用「渲染 → 立即读取」的同步顺序。
    effects.render(0.0001, {
      speed: player.speed,
      exposure: sky.state.exposure,
      fade: 0,
      time: clock.elapsed,
    });

    try {
      const url = renderer.domElement.toDataURL('image/png');
      const a = document.createElement('a');
      const t = sky.timeLabel.replace(':', '');
      a.href = url;
      a.download = `pelican-bike-${t}-${Math.round(player.speed * 3.6)}kmh.png`;
      a.click();
      toast('已保存到下载目录');
    } catch (err) {
      console.error(err);
      toast('截图失败（浏览器限制）');
    }
  }

  // 暴露到全局，方便在控制台里调参与调试
  window.__pelican = {
    THREE, scene, camera, renderer, env, sky, bike, pelican, feathers, effects, rig, player, input, audio,
    state, gui, perf, applyQuality, PHYS,
  };
}

/* ================================================================== *
 * 启动
 * ================================================================== */

main().catch((err) => {
  console.error(err);
  const text = document.getElementById('loader-text');
  if (text) text.textContent = `启动失败：${err.message}`;
});
