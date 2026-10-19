/**
 * camera.js —— 摄影机机位
 *
 * 四种机位各自解决一个不同的观看需求：
 *   chase      第三人称跟随 —— 玩的时候用，能看清鹈鹕和车
 *   orbit      环绕 —— 看细节，鼠标拖拽可绕到任意角度
 *   pov        鹈鹕的第一人称 —— 用鸟的眼睛看世界
 *   cinematic  低角度电影机位 —— 拍海平线和逆光剪影
 *
 * 三种「手感」上的处理，是这个模块存在的意义：
 *   1. 跟随不是硬贴：位置用指数平滑追赶，速度越快跟得越紧、拉得越远。
 *   2. FOV 随速度微张：约 12% 的变化就足以制造出速度感，
 *      再多就会让人晕。
 *   3. 相机永远不与地面相交：每帧都对地形高度做一次下限夹取。
 */

import * as THREE from 'three';

export const CAMERA_MODES = ['chase', 'orbit', 'pov', 'cinematic'];

const _target = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _lookAt = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _headFwd = new THREE.Vector3();
const _headUp = new THREE.Vector3();
const _upTmp = new THREE.Vector3();

export class CameraRig {
  constructor(camera, env, opts = {}) {
    this.camera = camera;
    this.env = env;
    this.mode = 'chase';
    this.modeIndex = 0;

    this.baseFov = 55;
    this.camera.fov = this.baseFov;
    this.camera.near = 0.06;
    this.camera.far = 6000;
    this.camera.updateProjectionMatrix();

    // ---- chase ----
    this.chase = {
      distance: 4.4,
      height: 1.85,
      lookAhead: 5.0,
      smooth: 4.6,      // 位置平滑系数（越大越紧跟）
      yawSmooth: 3.2,
    };

    // ---- orbit ----
    this.orbit = {
      yaw: 0.6,
      pitch: 0.32,
      distance: 6.2,
      autoRotate: true,
      autoSpeed: 0.055,
      lastInput: 0,
      targetHeight: 0.95,
    };

    // ---- pov ----
    this.pov = { blend: 1, shake: 0.5 };

    // ---- cinematic ----
    this.cinematic = {
      side: 1,
      distance: 6.5,
      height: 0.55,
      t: 0,
      switchTimer: 0,
    };

    // 内部状态
    this._pos = new THREE.Vector3(0, 3, -6);
    this._look = new THREE.Vector3();
    this._smoothYaw = 0;
    this._shake = new THREE.Vector3();
    this._prevPlayerPos = new THREE.Vector3();
    this._firstFrame = true;
  }

  setMode(name) {
    if (!CAMERA_MODES.includes(name)) return;
    this.mode = name;
    this.modeIndex = CAMERA_MODES.indexOf(name);
    this._firstFrame = true;
  }

  cycle() {
    this.modeIndex = (this.modeIndex + 1) % CAMERA_MODES.length;
    this.mode = CAMERA_MODES[this.modeIndex];
    this._firstFrame = true;
    return this.mode;
  }

  /** 鼠标拖拽：只在 orbit 模式生效 */
  applyPointerDelta(dx, dy) {
    if (this.mode !== 'orbit') {
      // 其他模式下拖拽也顺手切到 orbit，符合直觉
      this.setMode('orbit');
    }
    this.orbit.yaw -= dx * 0.005;
    this.orbit.pitch = THREE.MathUtils.clamp(this.orbit.pitch - dy * 0.004, -0.35, 1.35);
    this.orbit.lastInput = 0;
  }

  /** 滚轮缩放 */
  applyZoom(delta) {
    const d = this.mode === 'orbit' ? this.orbit : this.chase;
    d.distance = THREE.MathUtils.clamp(d.distance + delta * 0.004, 2.2, 22);
  }

  /**
   * @param {number} dt
   * @param {object} ctx
   *   ctx.position    骑行者的世界坐标（地面接触点）
   *   ctx.yaw         行进方向
   *   ctx.speed       速度 m/s
   *   ctx.lean        侧倾
   *   ctx.pitch       俯仰
   *   ctx.bump        颠簸强度 0..1
   *   ctx.headWorld   鹈鹕头部的世界矩阵（POV 用）
   *   ctx.time        全局时间
   */
  update(dt, ctx) {
    const cam = this.camera;

    // 侧倾与颠簸带来的机身抖动（所有机位共用）
    const bump = ctx.bump ?? 0;
    const shakeAmp = bump * 0.055 * (0.4 + Math.min(1, (ctx.speed ?? 0) / 12));
    this._shake.set(
      Math.sin(ctx.time * 31.7) * shakeAmp,
      Math.sin(ctx.time * 27.3 + 1.1) * shakeAmp,
      Math.sin(ctx.time * 23.9 + 2.2) * shakeAmp * 0.6
    );

    switch (this.mode) {
      case 'orbit': this._updateOrbit(dt, ctx); break;
      case 'pov': this._updatePov(dt, ctx); break;
      case 'cinematic': this._updateCinematic(dt, ctx); break;
      case 'chase':
      default: this._updateChase(dt, ctx); break;
    }

    // 速度感：FOV 随速度微张（POV 里效果更明显）
    const speedNorm = Math.min(1, (ctx.speed ?? 0) / 16);
    const fovBoost = this.mode === 'pov' ? 6 : 6;
    const targetFov = this.baseFov + speedNorm * fovBoost;
    if (Math.abs(cam.fov - targetFov) > 0.01) {
      cam.fov += (targetFov - cam.fov) * Math.min(1, dt * 3.0);
      cam.updateProjectionMatrix();
    }

    // 任何机位都不允许穿地
    const groundY = this.env.heightAt(cam.position.x, cam.position.z) + 0.42;
    if (cam.position.y < groundY) {
      cam.position.y = groundY;
      // 水面以上也要保证
    }
    const waterY = this.env.waterLevel + 0.35;
    if (cam.position.y < waterY) cam.position.y = waterY;

    this._prevPlayerPos.copy(ctx.position);
    this._firstFrame = false;
  }

  /* ================================================================ *
   * 1. 第三人称跟随
   * ================================================================ */
  _updateChase(dt, ctx) {
    const c = this.chase;
    const speedNorm = Math.min(1, (ctx.speed ?? 0) / 16);

    // 速度越快，机位越靠后、越低 —— 类似赛车游戏
    const dist = c.distance + speedNorm * 1.9;
    const height = c.height - speedNorm * 0.28;

    // 机位朝向：平滑跟随行进方向，避免转向时画面猛甩
    let yawErr = ctx.yaw - this._smoothYaw;
    yawErr = Math.atan2(Math.sin(yawErr), Math.cos(yawErr));   // 归一化到 -π..π
    this._smoothYaw += yawErr * Math.min(1, dt * c.yawSmooth);

    // 机位随侧倾做轻微反向偏移，产生「跟拍」的贴身感
    // （lean > 0 = 倒向车手右侧，所以偏移量取正号才会把机位推到弯道外侧）
    const leanOffset = (ctx.lean ?? 0) * 0.8;

    _desired.set(
      ctx.position.x - Math.sin(this._smoothYaw) * dist + Math.cos(this._smoothYaw) * leanOffset,
      ctx.position.y + height,
      ctx.position.z - Math.cos(this._smoothYaw) * dist - Math.sin(this._smoothYaw) * leanOffset
    );

    if (this._firstFrame) {
      this._pos.copy(_desired);
    } else {
      // 位置用指数平滑：dt 无关的稳定收敛
      const k = 1 - Math.exp(-c.smooth * dt);
      this._pos.lerp(_desired, k);
    }

    // 抬头看向骑行者前方一点
    _lookAt.set(
      ctx.position.x + Math.sin(ctx.yaw) * c.lookAhead,
      ctx.position.y + 1.0,
      ctx.position.z + Math.cos(ctx.yaw) * c.lookAhead
    );

    this.camera.position.copy(this._pos).add(this._shake);
    this._look.lerp(_lookAt, this._firstFrame ? 1 : Math.min(1, dt * 6.0));
    this.camera.lookAt(this._look);
  }

  /* ================================================================ *
   * 2. 环绕
   * ================================================================ */
  _updateOrbit(dt, ctx) {
    const o = this.orbit;
    o.lastInput += dt;

    // 无操作一段时间后自动缓慢环绕
    if (o.autoRotate && o.lastInput > 2.5) {
      o.yaw += dt * o.autoSpeed;
    }

    const target = _target.set(
      ctx.position.x,
      ctx.position.y + o.targetHeight,
      ctx.position.z
    );

    const cp = Math.cos(o.pitch);
    _desired.set(
      target.x + Math.sin(o.yaw) * o.distance * cp,
      target.y + Math.sin(o.pitch) * o.distance + 0.4,
      target.z + Math.cos(o.yaw) * o.distance * cp
    );

    // 环绕机位也平滑，但比跟随更快，避免拖拽时「黏手」
    const k = this._firstFrame ? 1 : 1 - Math.exp(-7.5 * dt);
    this._pos.lerp(_desired, k);

    this.camera.position.copy(this._pos).add(this._shake);
    this._look.lerp(target, this._firstFrame ? 1 : Math.min(1, dt * 8.0));
    this.camera.lookAt(this._look);
  }

  /* ================================================================ *
   * 3. 鹈鹕视角
   * ================================================================ */
  _updatePov(dt, ctx) {
    if (!ctx.headWorld || !ctx.eyeWorld) { this._updateChase(dt, ctx); return; }

    // 机位取自眼睛，但要沿「头上方」抬起来，否则画面会被自己的喙塞满。
    //
    // 数字是量出来的：眼睛在头部局部 z≈0.078，而喙从 z≈0.072 一直伸到 0.526
    // —— 也就是说喙几乎是从眼球正前方长出去的。相机若停在眼睛附近，
    // 沿头部前轴 0.05m 处就已经是喙的根部，0.23m 以外整根喙顶到画面上缘之外，
    // 于是「鸟眼视角」看到的只有一根横在脸上的喙。
    //
    // 抬 0.15m 之后：喙根（距头部前轴 0.07m）在视轴下方 65°，早已出画；
    // 喙尖（0.448m）在视轴下方约 21°，落在 60° 视场下缘之内 ——
    // 于是画面底部只剩一截喙尖的剪影，「看得见喙、但不挡视线」。
    const headPos = _tmp.setFromMatrixPosition(ctx.headWorld);
    _headFwd.set(0, 0, 1).applyMatrix4(ctx.headWorld).sub(headPos).normalize();
    _headUp.set(0, 1, 0).applyMatrix4(ctx.headWorld).sub(headPos).normalize();

    _desired.setFromMatrixPosition(ctx.eyeWorld)
      .addScaledVector(_headUp, 0.15);

    // POV 相机必须「刚性附着」在眼睛上，不能做位置平滑。
    //
    // 指数平滑 k = 1 - exp(-λ·dt) 本质是一阶低通，对匀速运动的稳态滞后
    // 恰好是 v/λ。λ=14、鸟速 16m/s 时滞后 1.14m —— 相机早就退到脖子后面，
    // 画面里只剩后脑勺和一根从下往上戳的喙（这就是「鸟眼视角变成看后脑勺」
    // 的成因）。这里直接 copy，不做插值。
    //
    // 抖动不用担心：眼睛本身已经带着颈部的运动，`_shake` 也照常叠加。
    this.camera.position.copy(_desired);

    // 视线方向：沿头部前方，但俯角要限幅。
    //
    // 骑行时鹈鹕的头是低着的（实测俯角 25°~46°），照搬头部朝向的话，
    // 配合 60° 的 FOV，画面覆盖俯仰会低到 -75° —— 整屏都是脚下两米的地面，
    // 地平线跑到画面外，看起来就像「相机掉进沙子里了」。
    //
    // 这里只把 y 分量夹住再归一化 —— 等价于「绕横轴抬头」，
    // 头部的左右朝向（yaw）完全保留，所以转弯时视野照样跟着转。
    const MAX_SIN_PITCH = -0.09;             // sin(-5°)
    if (_headFwd.y < MAX_SIN_PITCH) {
      _headFwd.y = MAX_SIN_PITCH;
      _headFwd.normalize();
    }

    _lookAt.copy(this.camera.position).addScaledVector(_headFwd, 6);

    // 侧倾时相机跟着翻滚 —— 这是 POV 最有说服力的细节。
    //
    // 但只能跟一部分：机身 lean 在过弯时会到 0.2rad(11.5°)，若整个搬给相机，
    // 地平线就会歪掉 12° 以上（实测 12.5°），看久了会晕。
    // 取 0.45 的耦合系数，5° 左右的倾斜刚好够读出「我在压弯」。
    const up = _tmp.set(0, 1, 0);
    if (ctx.rootQuaternion) {
      _upTmp.set(0, 1, 0).applyQuaternion(ctx.rootQuaternion);
      up.lerp(_upTmp, 0.45).normalize();
    }

    this.camera.position.add(this._shake);
    this.camera.up.copy(up);
    this.camera.lookAt(_lookAt);
    this._look.copy(_lookAt);
  }

  /* ================================================================ *
   * 4. 电影机位
   * ================================================================ */
  _updateCinematic(dt, ctx) {
    const c = this.cinematic;
    c.t += dt;
    c.switchTimer += dt;

    // 每 12 秒换一次机位，形成「剪辑感」
    if (c.switchTimer > 12) {
      c.switchTimer = 0;
      c.side = -c.side;
      c.height = 0.35 + Math.random() * 1.5;
      c.distance = 5.0 + Math.random() * 5.0;
    }

    // 侧向跟拍，机位几乎贴地
    const sideYaw = ctx.yaw + Math.PI * 0.5 * c.side;
    _desired.set(
      ctx.position.x + Math.sin(sideYaw) * c.distance,
      ctx.position.y + c.height,
      ctx.position.z + Math.cos(sideYaw) * c.distance
    );
    // 缓慢的前后漂移，制造轨道车的运动感
    const drift = Math.sin(c.t * 0.22) * 1.4;
    _desired.x += Math.sin(ctx.yaw) * drift;
    _desired.z += Math.cos(ctx.yaw) * drift;

    const k = this._firstFrame ? 1 : 1 - Math.exp(-2.2 * dt);
    this._pos.lerp(_desired, k);

    this.camera.position.copy(this._pos).add(this._shake);

    // 看向鹈鹕的胸部高度
    _lookAt.set(ctx.position.x, ctx.position.y + 1.15, ctx.position.z);
    this._look.lerp(_lookAt, this._firstFrame ? 1 : Math.min(1, dt * 3.5));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this._look);
  }

  /** 供 HUD 显示的机位名称 */
  get modeLabel() {
    return {
      chase: '跟随', orbit: '环绕', pov: '鸟眼', cinematic: '电影',
    }[this.mode] || this.mode;
  }
}
