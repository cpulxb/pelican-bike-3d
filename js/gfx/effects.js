/**
 * effects.js —— 后处理链
 *
 * 渲染管线：
 *   RenderPass          →  场景渲染进 HDR 缓冲（半浮点）
 *   UnrealBloomPass     →  辉光：落日、水面碎金、车灯、羽毛边缘
 *   GradePass（自研）   →  暗角 + 色差 + 饱和/对比分级 + 胶片颗粒
 *   OutputPass          →  ACES 色调映射 + sRGB 编码
 *
 * 顺序不能乱，原因是色彩空间：
 *   整个场景的自研着色器都输出**线性 HDR** 颜色（含 >1 的过曝值），
 *   色调映射必须放在最后一步，否则辉光会作用在已被压缩的颜色上，
 *   结果是「灰蒙蒙的光晕」而不是「亮起来的光」。
 *   这也是为什么场景里既没有 THREE.ToneMapping 也没有 sRGB 输出 ——
 *   它们全部由 OutputPass 统一负责，自研材质与 MeshStandardMaterial
 *   于是共享同一套曝光与映射，不会出现色调割裂。
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ------------------------------------------------------------------ *
 * 分级 / 暗角 / 色差 / 颗粒
 * ------------------------------------------------------------------ */

const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 1.0 },
    uAberration: { value: 1.0 },
    uSaturation: { value: 1.06 },
    uContrast: { value: 1.03 },
    uGrain: { value: 0.035 },
    uLift: { value: new THREE.Vector3(0.004, 0.006, 0.010) },
    uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
    uFlareStrength: { value: 0.35 },
    uFade: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uAberration;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uGrain;
    uniform vec3  uLift;
    uniform vec2  uSunScreen;
    uniform float uFlareStrength;
    uniform float uFade;

    varying vec2 vUv;

    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p + 19.19);
      return fract(p.x * p.y);
    }

    void main() {
      vec2 uv = vUv;
      vec2 center = uv - 0.5;
      float r = length(center);

      // ---- 1. 色差：越靠边缘越明显，模拟镜头 ---
      // 径向色差比简单的水平偏移更像真实镜头（边缘畸变导致）。
      vec2 dir = center * (0.0022 * uAberration * (0.35 + r * 2.2));
      vec3 col;
      col.r = texture2D(tDiffuse, uv + dir).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - dir).b;

      // ---- 2. 暗角 ----
      float vig = smoothstep(1.05, 0.28, r * 1.42);
      col *= mix(1.0, vig, uVignette * 0.82);

      // ---- 3. 太阳处的镜头光晕（屏幕空间，成本极低）----
      vec2 toSun = uv - uSunScreen;
      float sunDist = length(toSun);
      float halo = smoothstep(0.62, 0.0, sunDist) * 0.14;
      // 拉长的横向光条
      float streak = smoothstep(0.30, 0.0, abs(toSun.y) * 3.4)
                   * smoothstep(0.85, 0.0, abs(toSun.x)) * 0.075;
      // 过曝的太阳核心会「漏」到整个画面
      vec3 sunTint = vec3(1.0, 0.78, 0.50);
      col += sunTint * (halo + streak) * uFlareStrength;

      // ---- 4. 分级：对比 + 饱和 + 冷调阴影 ----
      col = (col - 0.5) * uContrast + 0.5;
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);
      // 阴影抬一点蓝紫（电影胶片的做法），暗部不会死黑
      col += uLift * (1.0 - smoothstep(0.0, 0.35, luma));

      // ---- 5. 胶片颗粒：随亮度变化，暗部颗粒更明显 ----
      float grain = hash(uv * vec2(1920.0, 1080.0) + fract(uTime) * 137.0) - 0.5;
      col += grain * uGrain * (0.35 + (1.0 - luma) * 0.85);

      // ---- 6. 淡入淡出 ----
      col *= (1.0 - uFade);

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

/* ------------------------------------------------------------------ *
 * 径向速度模糊（只在高速时启用，叠加在画面边缘）
 * ------------------------------------------------------------------ */

const SpeedBlurShader = {
  name: 'SpeedBlurShader',
  uniforms: {
    tDiffuse: { value: null },
    uStrength: { value: 0.0 },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
  },
  vertexShader: GradeShader.vertexShader,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uStrength;
    uniform vec2  uCenter;
    varying vec2 vUv;

    void main() {
      vec2 dir = vUv - uCenter;
      float r = length(dir);

      // 只模糊边缘：画面中心保持锐利，否则会看不清主角
      float edge = smoothstep(0.22, 0.72, r) * uStrength;
      if (edge < 0.002) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }

      // 6 个采样点沿径向排布，比均匀模糊更省、方向感更强
      vec3 acc = vec3(0.0);
      float total = 0.0;
      for (int i = 0; i < 6; i++) {
        float t = float(i) / 5.0;
        float w = 1.0 - t * 0.55;
        acc += texture2D(tDiffuse, vUv - dir * edge * t * 0.16).rgb * w;
        total += w;
      }
      gl_FragColor = vec4(acc / total, 1.0);
    }
  `,
};

/* ================================================================== *
 * 渲染器封装
 * ================================================================== */

/** 各画质档的基准辉光强度（0 表示关闭） */
const BLOOM_BASE = { low: 0.0, medium: 0.42, high: 0.58 };

export class Effects {
  constructor(renderer, scene, camera, env, quality = 'high') {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.env = env;
    this.quality = quality;   // 仅用于构造期的档位判断

    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();

    // HDR 缓冲：辉光需要 >1 的颜色才能「亮起来」
    const rtType = quality === 'low' ? THREE.UnsignedByteType : THREE.HalfFloatType;
    const rt = new THREE.WebGLRenderTarget(
      Math.floor(size.x * pr), Math.floor(size.y * pr),
      {
        type: rtType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        stencilBuffer: false,
      }
    );

    this.composer = new EffectComposer(renderer, rt);
    this.composer.setPixelRatio(pr);

    // 1) 场景
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // 2) 辉光
    // bloomBase 是「本档位应有的辉光强度」，与随时间波动的 bloomBoost 分开存：
    // render() 每帧都要用 bloomBase × bloomBoost 重算 bloom.strength，
    // 如果降档时只写 bloom.strength，下一帧就会被 render() 覆盖回去。
    this.bloomBase = BLOOM_BASE[quality] ?? 0.58;
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      this.bloomBase,  // strength
      0.62,            // radius
      0.82             // threshold —— 只有高光（太阳、水面碎金、车灯）才发光
    );
    this.composer.addPass(this.bloom);

    // 3) 径向速度模糊
    this.speedBlur = new ShaderPass(SpeedBlurShader);
    this.speedBlur.enabled = quality !== 'low';
    this.composer.addPass(this.speedBlur);

    // 4) 分级
    this.grade = new ShaderPass(GradeShader);
    this.grade.uniforms.uGrain.value = quality === 'low' ? 0.02 : 0.035;
    this.composer.addPass(this.grade);

    // 5) 色调映射 + sRGB
    this.output = new OutputPass();
    this.composer.addPass(this.output);

    // 把自研着色器里的曝光统一交给 three 的色调映射曝光参数
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    this._sunNDC = new THREE.Vector3();
    /** 色差的用户设定值（调参面板写这里；render() 只在它基础上随速度衰减） */
    this.aberrationBase = 1.0;
    this._size = size;
  }

  setSize(width, height) {
    this._size.set(width, height);
    // composer.setSize 会按像素比把所有 pass（包括辉光）一起改尺寸。
    // 原来这里又单独 bloom.setSize(width, height)：用的是 CSS 像素，
    // 在 2x 屏上把辉光缓冲重新缩回了一半分辨率，与其它 pass 不一致。
    this.composer.setSize(width, height);
  }

  /** 太阳在屏幕上的位置 —— 用来做镜头光晕与辉光对齐 */
  _projectSun() {
    const dir = this.env.u.uSunDir.value;
    // 取相机前方一个很远的点
    this._sunNDC.copy(dir).multiplyScalar(3000).add(this.camera.position);
    this._sunNDC.project(this.camera);
    const x = this._sunNDC.x * 0.5 + 0.5;
    const y = this._sunNDC.y * 0.5 + 0.5;
    // 太阳在背后时把光晕推到画面外
    const behind = this._sunNDC.z > 1 ? 1 : 0;
    this.grade.uniforms.uSunScreen.value.set(
      behind ? -1 : x,
      behind ? -1 : y
    );
    // 太阳越靠画面中心，光晕越强
    const centerDist = Math.hypot(x - 0.5, y - 0.5);
    const vis = behind ? 0 : 1 - THREE.MathUtils.clamp(centerDist * 1.9, 0, 1);
    this.grade.uniforms.uFlareStrength.value = vis * 0.5;
  }

  /**
   * @param {number} dt
   * @param {object} s { speed, exposure, fade, time }
   */
  render(dt, s) {
    const speed = s.speed ?? 0;
    const speedNorm = THREE.MathUtils.clamp(speed / 18, 0, 1);

    // 曝光跟随光照导演（黄昏时自动提高曝光，夜里压暗）
    this.renderer.toneMappingExposure = s.exposure ?? 1.0;

    // 速度模糊：只在速度超过 6 m/s 后才开始出现
    this.speedBlur.uniforms.uStrength.value =
      this.speedBlur.enabled ? Math.max(0, speedNorm - 0.34) * 1.35 : 0;

    // 辉光随太阳高度变化：日落时最强。
    // 基准值取 bloomBase（由画质档决定），所以这里每帧重算不会把降档抹掉。
    const sunY = this.env.u.uSunDir.value.y;
    const bloomBoost = 1 + THREE.MathUtils.clamp(1 - Math.abs(sunY) * 2.4, 0, 1) * 0.55;
    this.bloom.strength = this.bloomBase * bloomBoost;
    // 强度为 0 时整条辉光链（5 级 mip 模糊）都可以跳过 —— 低画质省下的大头
    this.bloom.enabled = this.bloomBase > 0.001;

    this.grade.uniforms.uTime.value = s.time ?? 0;
    this.grade.uniforms.uFade.value = s.fade ?? 0;
    // 高速时降低色差，避免晕
    this.grade.uniforms.uAberration.value = this.aberrationBase * (1.0 - speedNorm * 0.45);

    this._projectSun();
    this.composer.render(dt);
  }

  dispose() {
    this.composer.dispose?.();
  }
}

export { GradeShader, SpeedBlurShader };
