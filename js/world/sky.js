/**
 * sky.js —— 时间与光照导演
 *
 * 这个模块是整场戏的「摄影指导」：它根据一天中的时刻算出太阳方位、
 * 天空三段渐变、雾的浓度与颜色、曝光与星星强度，
 * 然后一次性写入 Environment 的共享 uniform。
 *
 * 因为天空、地形、海面、草、云、鸟的着色器都读同一批 uniform，
 * 所以调一次 applyLighting，整个世界的光就同步了 —— 这是黄昏能平滑过渡的关键。
 *
 * 色板不是随意调的：每个关键时刻的 (天顶色, 地平线色, 太阳色, 雾色) 都取自
 * 真实大气散射的规律 —— 太阳越低，路径越长，蓝光散射殆尽，红橙占主导；
 * 天顶则始终比地平线更蓝更深。
 */

import * as THREE from 'three';

/**
 * 24 小时色板。t 为 0..1 的归一化时刻（0=午夜，0.5=正午）。
 * 只列出关键时刻，其余时刻在相邻两项之间插值。
 */
const KEYFRAMES = [
  { t: 0.00, name: '午夜', sun: 0x1a2740, sky: 0x060c18, hor: 0x0c1526, nad: 0x02040a, fog: 0x0a1220, fogD: 0.0017, exp: 0.85, stars: 1.0 },
  { t: 0.19, name: '黎明前', sun: 0x3a3a58, sky: 0x101a30, hor: 0x2a2a48, nad: 0x050810, fog: 0x1a1c30, fogD: 0.0016, exp: 0.9, stars: 0.85 },
  { t: 0.245, name: '蓝调时刻', sun: 0x6b5a86, sky: 0x1d3358, hor: 0x8a5f7a, nad: 0x0a1020, fog: 0x3d3352, fogD: 0.0015, exp: 0.98, stars: 0.35 },
  { t: 0.285, name: '日出', sun: 0xff8a4a, sky: 0x2f5a86, hor: 0xff9a5c, nad: 0x14202c, fog: 0xc47a58, fogD: 0.0014, exp: 1.05, stars: 0.08 },
  { t: 0.34, name: '清晨', sun: 0xffd0a0, sky: 0x3a7ab8, hor: 0xffc79a, nad: 0x1c2c38, fog: 0xa8a8b8, fogD: 0.0010, exp: 1.10, stars: 0.0 },
  { t: 0.50, name: '正午', sun: 0xfff4e2, sky: 0x2f7fd0, hor: 0x9fc4e8, nad: 0x2a3a44, fog: 0x9dbcd8, fogD: 0.0008, exp: 1.05, stars: 0.0 },
  { t: 0.66, name: '午后', sun: 0xffe0b0, sky: 0x2f76c0, hor: 0xc8b090, nad: 0x24323c, fog: 0xb0a898, fogD: 0.0009, exp: 1.08, stars: 0.0 },
  { t: 0.735, name: '黄金时刻', sun: 0xffb066, sky: 0x22568e, hor: 0xffc182, nad: 0x1a2630, fog: 0xd8a06a, fogD: 0.0011, exp: 1.15, stars: 0.0 },
  { t: 0.785, name: '落日', sun: 0xff7a38, sky: 0x1c3f6e, hor: 0xff7f42, nad: 0x101a24, fog: 0xc06848, fogD: 0.0013, exp: 1.18, stars: 0.02 },
  { t: 0.825, name: '暮色', sun: 0xc4553a, sky: 0x122a52, hor: 0xd05a48, nad: 0x0a121c, fog: 0x704858, fogD: 0.0014, exp: 1.05, stars: 0.25 },
  { t: 0.87, name: '蓝调', sun: 0x5a4a7a, sky: 0x0e1e3c, hor: 0x5a3f6a, nad: 0x050a14, fog: 0x35304e, fogD: 0.0015, exp: 0.95, stars: 0.7 },
  { t: 0.93, name: '入夜', sun: 0x2a3050, sky: 0x08101f, hor: 0x18203a, nad: 0x03060e, fog: 0x141c2e, fogD: 0.0016, exp: 0.88, stars: 0.95 },
  { t: 1.00, name: '午夜', sun: 0x1a2740, sky: 0x060c18, hor: 0x0c1526, nad: 0x02040a, fog: 0x0a1220, fogD: 0.0017, exp: 0.85, stars: 1.0 },
];

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

function lerpHex(a, b, k, out) {
  _c1.setHex(a, THREE.SRGBColorSpace);
  _c2.setHex(b, THREE.SRGBColorSpace);
  // 在「工作色彩空间」（线性）里插值，否则暗部过渡会发灰
  return out.copy(_c1).lerp(_c2, k);
}

export class SkyDirector {
  constructor(environment, opts = {}) {
    this.env = environment;
    this.time = opts.time ?? 0.775;        // 默认从「落日」开始，最有戏剧性
    this.autoAdvance = opts.autoAdvance ?? true;
    this.dayLength = opts.dayLength ?? 240; // 一天 = 240 秒真实时间
    this.paused = false;

    /** 供外部读取的当前光照状态（纯数据，无 three 依赖负担） */
    this.state = {
      sunDir: new THREE.Vector3(0.35, 0.22, 0.91).normalize(),
      sunColor: new THREE.Color(),
      skyTop: new THREE.Color(),
      skyHorizon: new THREE.Color(),
      nadir: new THREE.Color(),
      fogColor: new THREE.Color(),
      fogDensity: 0.002,
      fogHeightFalloff: 0.028,
      exposure: 1.15,
      stars: 0,
      keyName: '落日',
    };

    // 太阳绕世界转的轨道：略微倾斜，避免正午直射天顶
    this.orbitTilt = 0.22;
    this.orbitYaw = -0.55;

    this._updateState();
    this.env.applyLighting(this.state);
  }

  /** 把归一化时刻映射到关键帧并插值 */
  _updateState() {
    const t = ((this.time % 1) + 1) % 1;
    let i = 0;
    while (i < KEYFRAMES.length - 2 && KEYFRAMES[i + 1].t <= t) i++;
    const a = KEYFRAMES[i];
    const b = KEYFRAMES[i + 1];
    const span = Math.max(1e-5, b.t - a.t);
    // smoothstep 插值：让关键时刻之间的过渡不匀速，更像真实的日照变化
    const raw = (t - a.t) / span;
    const k = raw * raw * (3 - 2 * raw);

    const s = this.state;
    lerpHex(a.sun, b.sun, k, s.sunColor);
    lerpHex(a.sky, b.sky, k, s.skyTop);
    lerpHex(a.hor, b.hor, k, s.skyHorizon);
    lerpHex(a.nad, b.nad, k, s.nadir);
    lerpHex(a.fog, b.fog, k, s.fogColor);

    s.fogDensity = a.fogD + (b.fogD - a.fogD) * k;
    s.exposure = a.exp + (b.exp - a.exp) * k;
    s.stars = a.stars + (b.stars - a.stars) * k;
    s.keyName = k < 0.5 ? a.name : b.name;

    // ---- 太阳方位：t=0.25 升起、0.5 天顶、0.75 落下 ----
    const dayAngle = (t - 0.25) * Math.PI * 2;
    const elev = Math.sin(dayAngle);
    const azim = dayAngle;
    const cosE = Math.cos(Math.asin(THREE.MathUtils.clamp(elev, -1, 1)));

    // 基础方向（+Z 为日出方向，逆时针绕 Y 旋转）
    const dir = new THREE.Vector3(
      Math.sin(azim) * cosE,
      elev,
      Math.cos(azim) * cosE
    );
    // 轨道倾斜：太阳不垂直升降，略偏，让阴影更长更斜
    dir.applyAxisAngle(new THREE.Vector3(1, 0, 0), this.orbitTilt * 0.5);
    dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.orbitYaw);
    dir.normalize();
    s.sunDir.copy(dir);

    // 太阳低于地平线时，把它「抬」到地平线附近，让最后一缕余晖仍然可见
    if (s.sunDir.y < -0.02) {
      s.sunDir.y = Math.max(-0.06, s.sunDir.y);
      s.sunDir.normalize();
    }

    // 接近地平线时太阳变红、变暗（大气消光）
    const lowSun = 1 - THREE.MathUtils.clamp((s.sunDir.y + 0.05) / 0.55, 0, 1);
    s.sunColor.multiplyScalar(1 - lowSun * 0.25);
    // 指数高度雾的落差随昼夜微调，白天雾层更薄
    s.fogHeightFalloff = 0.016 + lowSun * 0.014;
  }

  /** 每帧推进时间 */
  update(dt) {
    if (this.autoAdvance && !this.paused) {
      this.time = (this.time + dt / this.dayLength) % 1;
    }
    this._updateState();
    this.env.applyLighting(this.state);
  }

  setTime(t) { this.time = ((t % 1) + 1) % 1; }

  get timeLabel() {
    const mins = Math.round(this.time * 1440);
    const h = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}

export { KEYFRAMES };
