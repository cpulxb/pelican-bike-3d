/**
 * shaders.js —— 全部自研 GLSL 着色器
 *
 * 天空、海面、沙地、草地、云、鸟群、羽毛的着色都由下面的代码在 GPU 上算出来。
 * 地形 / 海面 / 羽毛另有一层可选的「细节贴图」（gpt-image-2.5 生成，见 js/gfx/textures.js）：
 * 贴图只提供颗粒、纹路与法线，色调仍由这里的调色板决定；贴图缺失时自动回退到纯程序化分支。
 *
 * 组织方式：
 *   GLSL_COMMON  —— 噪声 / 雾 / 色调映射等公共函数，被其它着色器拼接引用
 *   各 *Vert/*Frag —— 成对着色器
 *
 * 设计要点：
 *   · 雾不是 three 内置的 scene.fog，而是自研的「指数高度雾 + 朝阳散射」，
 *     这样雾的颜色会随视线与太阳夹角变化，黄昏才有空气感。
 *   · 海面用 4 组 Gerstner 波（而非正弦波）—— 波峰尖锐、波谷平缓，
 *     这是真实海面的不对称特征。
 *   · 地形高度在 CPU 端烘焙成一张 half-float 贴图，海面着色器据此计算
 *     水深、岸边白沫与浅水透色，无需把噪声函数在 GLSL 里重写一遍。
 */

/* ================================================================== *
 * 公共 GLSL 片段
 * ================================================================== */

export const GLSL_COMMON = /* glsl */`
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  // ---- 哈希与值噪声（比 simplex 短，且足够水面的需求） ----
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);              // smoothstep 插值 → C1 连续
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * 2.0 - 1.0;
  }

  float fbm(vec2 p, int oct) {
    float s = 0.0, a = 0.5, n = 0.0;
    for (int i = 0; i < 8; i++) {
      if (i >= oct) break;
      s += a * vnoise(p);
      n += a;
      a *= 0.5;
      p = p * 2.03 + vec2(17.3, 9.1);
    }
    return s / max(n, 1e-4);
  }

  // 脊状噪声：云与浪尖的「棱」感
  float ridged(vec2 p, int oct) {
    float s = 0.0, a = 0.5, n = 0.0;
    for (int i = 0; i < 8; i++) {
      if (i >= oct) break;
      s += a * (1.0 - abs(vnoise(p)));
      n += a;
      a *= 0.5;
      p = p * 2.11 - vec2(5.2, 3.7);
    }
    return s / max(n, 1e-4);
  }

  // ---- 指数高度雾 + 朝阳前向散射 ----
  // 近地面雾浓、高空稀薄，视线越贴近地面越朦胧；看向太阳时雾偏暖。
  // 用解析积分代替逐点采样，雾的浓度才会随相机高度平滑变化。
  vec3 applyFog(vec3 color, vec3 worldPos, vec3 camPos, vec3 sunDir,
                vec3 fogColor, float density, float heightFalloff) {
    vec3 delta = worldPos - camPos;
    float dist = length(delta);
    vec3 dir = delta / max(dist, 1e-4);

    // 沿视线对 exp(-h/H) 做近似积分，得到与高度相关的不透明度
    float avgH = 0.5 * (camPos.y + worldPos.y);
    float heightAtten = exp(-max(avgH, 0.0) * heightFalloff);
    float f = 1.0 - exp(-dist * density * heightAtten);

    // 前向散射：视线与太阳越同向，雾越亮越暖
    float sunAlign = pow(max(dot(dir, sunDir), 0.0), 6.0);
    vec3 tint = mix(fogColor, fogColor * 1.5 + vec3(0.35, 0.18, 0.02), sunAlign * 0.85);

    return mix(color, tint, clamp(f, 0.0, 1.0));
  }

  // 说明：本文件中所有「由内向外衰减」的软边都写成
  //   1.0 - smoothstep(a, b, x)
  // 而不是 smoothstep(b, a, x)。GLSL 规范里 edge0 >= edge1 属于未定义行为，
  // 虽然多数驱动会按公式算出反向斜坡，但不该依赖它。

  /**
   * 天空颜色的方向性模型 —— 整个场景的「环境光」都由它给出。
   *
   * 关键在于地平线颜色**必须随方位变化**：
   * 黄昏时太阳那一侧的地平线是暖橙的，而背对太阳的一侧是冷蓝紫的。
   * 早期版本只给了一个 uSkyHorizon，于是整个地平线环都是暖橙色 ——
   * 背对太阳看时，天是脏橘、海是土褐，整幅画糊成一片单色。
   * 这是「黄昏看起来像沙尘暴」最典型的原因。
   *
   * @param dir      视线方向（单位向量）
   * @param sunDir   太阳方向
   * @param zenith   天顶色
   * @param horizon  朝阳侧的地平线色
   */
  vec3 skyColor(vec3 dir, vec3 sunDir, vec3 zenith, vec3 horizon) {
    float up = clamp(dir.y, -1.0, 1.0);
    float grad = pow(clamp(up, 0.0, 1.0), 0.42);

    // 背光侧的地平线：把朝阳色往天顶色拉回一大半，得到冷调的天空
    vec3 horizonCool = mix(zenith, horizon, 0.26);
    // 向阳程度：cosSun > 0 表示朝太阳看
    float cosSun = dot(dir, sunDir);
    float sunSide = smoothstep(-0.35, 0.90, cosSun);
    vec3 horizonCol = mix(horizonCool, horizon, sunSide);

    return mix(horizonCol, zenith, grad);
  }

  // ---- 输出线性 HDR 颜色 ----
  // 色调映射（ACES）与 sRGB 编码统一交给后处理链末端的 OutputPass，
  // 这样自研着色器与场景里的 MeshStandardMaterial 会经过完全相同的曝光与映射，
  // 不会出现「鸟和石头颜色不是一个世界」的割裂。
  vec4 outputColor(vec3 linearColor, float alpha) {
    return vec4(linearColor, alpha);
  }
`;

/* ================================================================== *
 * 天空：解析式大气 + 体积云
 * ================================================================== */

export const SKY_VERT = /* glsl */`
  varying vec3 vWorldDir;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    // 天空球始终跟随相机，只保留方向信息
    vWorldDir = normalize(wp.xyz - cameraPosition);
    vec4 mv = viewMatrix * wp;
    gl_Position = projectionMatrix * mv;
    gl_Position.z = gl_Position.w;      // 强制贴在最远处
  }
`;

export const SKY_FRAG = /* glsl */`
  precision highp float;

  uniform vec3  uSunDir;
  uniform vec3  uZenith;
  uniform vec3  uHorizon;
  uniform vec3  uSunColor;
  uniform float uTime;
  uniform float uCloudCover;
  uniform float uCloudSharp;
  uniform float uExposure;
  uniform float uStars;
  uniform vec3  uNadir;

  varying vec3 vWorldDir;

  ${GLSL_COMMON}

  // 从视线方向求「射线与云层的交点」，在平面上做二维云场 —— 便宜的体积感
  vec2 cloudPlaneUv(vec3 dir, float height) {
    float t = height / max(dir.y, 0.035);
    return dir.xz * t;
  }

  float cloudField(vec2 uv, float t) {
    // 两层不同速度的云：高层慢、低层快，产生视差
    vec2 drift = vec2(uTime * 0.0045, uTime * 0.0021);
    float base = fbm(uv * 0.0016 + drift, 5) * 0.5 + 0.5;
    float detail = ridged(uv * 0.006 - drift * 2.0, 4);
    float d = base - detail * 0.22;
    float cover = 1.0 - uCloudCover;
    return smoothstep(cover, cover + uCloudSharp, d);
  }

  void main() {
    vec3 dir = normalize(vWorldDir);

    // ---- 1. 大气梯度：天顶→地平线 ----
    // 直接复用 skyColor()，与海面反射、地形天光用的是同一个函数 ——
    // 三者必须严格一致，否则海平线上会出现一条「天空和水面对不上」的缝。
    vec3 col = skyColor(dir, uSunDir, uZenith, uHorizon);

    // 地平线以下：海面反射的暗青，让天空球与水面自然衔接
    float up = clamp(dir.y, -1.0, 1.0);
    if (up < 0.0) {
      col = mix(skyColor(vec3(dir.x, 0.0, dir.z), uSunDir, uZenith, uHorizon),
                uNadir, pow(-up, 0.55));
    }

    // ---- 2. 太阳：核心 + 大气光晕 + 前向散射 ----
    float cosSun = dot(dir, uSunDir);
    float disc = smoothstep(0.99965, 0.99992, cosSun);
    float glow = pow(max(cosSun, 0.0), 220.0) * 1.2;
    float halo = pow(max(cosSun, 0.0), 12.0) * 0.30;
    float broad = pow(max(cosSun, 0.0), 3.0) * 0.10;

    col += uSunColor * (glow + halo + broad);
    col += vec3(1.0, 0.94, 0.82) * disc * 24.0;

    // 太阳附近的暖色污染（黄昏的橙红扩散）
    float horizonProx = exp(-abs(up) * 3.4);
    col = mix(col, col * vec3(1.22, 0.86, 0.62) + vec3(0.10, 0.035, 0.0),
              horizonProx * pow(max(cosSun, 0.0), 2.0) * 0.9);

    // ---- 3. 云层 ----
    if (up > 0.0) {
      vec2 uv = cloudPlaneUv(dir, 140.0);
      float c = cloudField(uv, uTime);
      // 云的自阴影：采样云场梯度近似厚度
      float cUp = cloudField(cloudPlaneUv(normalize(dir + vec3(0.0, 0.09, 0.0)), 140.0), uTime);
      float thick = clamp((c - cUp) * 2.2 + 0.35, 0.0, 1.0);

      // 朝向太阳一侧被点亮，背光侧偏冷
      float lit = smoothstep(-0.2, 0.55, cosSun);
      vec3 cloudLit  = mix(vec3(1.02, 0.92, 0.80), vec3(1.35, 1.12, 0.88), lit);
      vec3 cloudDark = mix(vec3(0.24, 0.30, 0.40), vec3(0.52, 0.40, 0.36), lit);
      vec3 cloudCol = mix(cloudDark, cloudLit, thick);

      // 靠近地平线时云被大气吞没
      float fade = smoothstep(0.0, 0.30, up) * (1.0 - smoothstep(0.72, 1.0, up) * 0.55);
      col = mix(col, cloudCol, c * fade * 0.92);

      // 云隙里的丁达尔光柱：云薄的地方太阳光更亮
      col += uSunColor * (1.0 - c) * halo * 0.55 * fade;
    }

    // ---- 4. 星星：只在黄昏偏夜时可见，靠太阳高度自动淡入 ----
    if (uStars > 0.001 && up > 0.02) {
      vec2 sp = dir.xz / max(dir.y, 0.08) * 6.0;
      float s = hash21(floor(sp * 22.0));
      float tw = 0.5 + 0.5 * sin(uTime * 2.4 + s * 90.0);
      col += vec3(0.85, 0.92, 1.0) * step(0.9975, s) * tw * uStars * smoothstep(0.02, 0.35, up);
    }

    // ---- 5. 极淡的胶片式空气感 ----
    col += vec3(0.012, 0.016, 0.022) * (1.0 - abs(up));

    gl_FragColor = outputColor(col, 1.0);
  }
`;

/* ================================================================== *
 * 地形：沙地 / 岩石 / 草甸的程序化着色
 * ================================================================== */

export const TERRAIN_VERT = /* glsl */`
  uniform float uTime;
  uniform float uWindStrength;

  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  varying float vHeight;

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vHeight = wp.y;

    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const TERRAIN_FRAG = /* glsl */`
  precision highp float;

  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform vec3  uSkyTop;
  uniform vec3  uSkyHorizon;
  uniform vec3  uFogColor;
  uniform vec3  uNadir;
  uniform float uFogDensity;
  uniform float uFogHeightFalloff;
  uniform float uExposure;
  uniform float uWaterLevel;
  uniform float uTime;
  uniform float uDetailScale;
  uniform float uChunkFade;      // 分块生成的淡入（0→1）
  uniform vec3  uHeadPos;        // 车头灯位置 / 方向 / 强度
  uniform vec3  uHeadDir;
  uniform float uHeadI;

  // ---- 美术贴图（见 js/gfx/textures.js）----
  // uArt：0 = 纯程序化（贴图没加载到）；1 = 只有细节色；2 = 细节色 + 法线
  uniform float uArt;
  uniform vec4  uArtGain;        // 归一化细节贴图的还原倍数：沙 / 湿沙 / 草 / 岩
  uniform sampler2D uSandA;
  uniform sampler2D uSandN;
  uniform sampler2D uWetA;
  uniform sampler2D uWetN;
  uniform sampler2D uGrassA;
  uniform sampler2D uGrassN;
  uniform sampler2D uRockA;
  uniform sampler2D uRockN;
  uniform sampler2D uSeaNF;      // rg = 细浪法线，b = 白沫

  varying vec3 vWorldPos;
  varying vec3 vNormalW;
  varying float vHeight;

  ${GLSL_COMMON}

  // 程序化沙地细节：细密的风纹 + 粗颗粒
  float sandDetail(vec2 p) {
    float ripples = sin(p.x * 1.7 + fbm(p * 0.18, 3) * 6.0) * 0.5 + 0.5;
    float grain = fbm(p * 7.0, 3) * 0.5 + 0.5;
    return ripples * 0.35 + grain * 0.65;
  }

  // 草甸斑块：用噪声决定哪一片长草，边界用 fbm 打碎避免圆形
  float meadowMask(vec2 p, float slope, float h) {
    // 注意：变量不能叫 patch —— 那是 GLSL 的保留字（曲面细分用），
    // 在多数驱动上会直接报 "Illegal use of reserved word"。
    float blob = fbm(p * 0.055 + vec2(31.0, -12.0), 4) * 0.5 + 0.5;
    blob += fbm(p * 0.22, 3) * 0.14;
    float m = smoothstep(0.56, 0.74, blob);
    m *= smoothstep(0.06, 0.24, slope);                 // 陡坡不长草
    m *= smoothstep(uWaterLevel + 0.4, uWaterLevel + 1.6, h);  // 水边不长草
    return m;
  }

  /*
   * 反平铺：同一张贴图在「原尺度」与「旋转 37° + 缩小到 0.43 倍」两套坐标上各采一次，
   * 用一层很低频的噪声在两者之间混合。两套坐标的周期互质，
   * 于是在几十米的范围内看不出重复的格子。
   * 用 textureGrad 而不是 texture：调用点在非一致的分支里，隐式导数不可靠。
   */
  const mat2 ROT = mat2(0.8, -0.6, 0.6, 0.8);
  vec4 dualA(sampler2D t, vec2 uv, vec2 gx, vec2 gy, float m) {
    vec4 a = textureGrad(t, uv, gx, gy);
    if (m < 0.01) return a;
    vec2 uv2 = ROT * uv * 0.43 + vec2(0.37, 0.71);
    vec4 b = textureGrad(t, uv2, ROT * gx * 0.43, ROT * gy * 0.43);
    return mix(a, b, m);
  }
  // 法线版：第二套坐标转过一个角度，切线空间的梯度也要转回世界方向
  vec2 dualN(sampler2D t, vec2 uv, vec2 gx, vec2 gy, float m) {
    vec2 a = textureGrad(t, uv, gx, gy).rg * 2.0 - 1.0;
    if (m < 0.01) return a;
    vec2 uv2 = ROT * uv * 0.43 + vec2(0.37, 0.71);
    vec2 b = textureGrad(t, uv2, ROT * gx * 0.43, ROT * gy * 0.43).rg * 2.0 - 1.0;
    b = b * ROT;                     // = transpose(ROT) * b
    return mix(a, b, m);
  }

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec2 p = vWorldPos.xz * uDetailScale;

    float slope = 1.0 - clamp(N.y, 0.0, 1.0);
    float h = vHeight;
    bool art = uArt > 0.5;
    bool artN = uArt > 1.5;

    // 贴图坐标与导数（在任何分支之前求，保证 mip 选择正确）
    vec2 uvS = p / 4.2;                 // 沙 / 湿沙：一块 4.2m
    vec2 uvG = p / 2.6;                 // 草：一块 2.6m
    vec2 gxS = dFdx(uvS), gyS = dFdy(uvS);
    vec2 gxG = dFdx(uvG), gyG = dFdy(uvG);
    vec3 rp = vWorldPos * uDetailScale / 5.5;   // 岩石三平面投影：一块 5.5m
    vec3 rdx = dFdx(rp), rdy = dFdy(rp);
    float mixV = art ? smoothstep(-0.35, 0.35, vnoise(p * 0.031 + vec2(3.1, 7.7))) : 0.0;
    vec3 Np = vec3(0.0);                // 法线扰动（世界空间）的累加

    // ---------- 1. 基础色：从水下泥沙到干沙 ----------
    vec3 wetSand  = vec3(0.36, 0.30, 0.235);
    vec3 drySand  = vec3(0.74, 0.62, 0.44);
    vec3 duneSand = vec3(0.83, 0.71, 0.52);
    vec3 underSand = vec3(0.22, 0.26, 0.22);

    float sandMix = smoothstep(uWaterLevel - 0.15, uWaterLevel + 1.4, h);
    vec3 albedo = mix(wetSand, drySand, sandMix);
    albedo = mix(albedo, duneSand, smoothstep(2.2, 5.0, h));
    albedo = mix(albedo, underSand, smoothstep(uWaterLevel - 0.1, uWaterLevel - 1.8, h));
    float wetness = 1.0 - smoothstep(uWaterLevel + 0.15, uWaterLevel + 1.25, h);
    if (art) {
      // 细节色贴图只负责颗粒 / 风纹 / 贝壳碎屑，色调仍然由上面的调色板决定
      vec3 sd = dualA(uSandA, uvS, gxS, gyS, mixV).rgb * uArtGain.x;
      if (artN) {
        vec2 sn = dualN(uSandN, uvS, gxS, gyS, mixV);
        Np += vec3(sn.x, 0.0, sn.y) * 0.55 * (1.0 - wetness);
      }
      if (wetness > 0.01) {
        vec3 wd = textureGrad(uWetA, uvS * 1.15, gxS * 1.15, gyS * 1.15).rgb * uArtGain.y;
        sd = mix(sd, wd, wetness);
        if (artN) {
          vec2 wn = textureGrad(uWetN, uvS * 1.15, gxS * 1.15, gyS * 1.15).rg * 2.0 - 1.0;
          Np += vec3(wn.x, 0.0, wn.y) * 0.6 * wetness;
        }
      }
      albedo *= mix(vec3(1.0), sd, 0.72);
    } else {
      float d = sandDetail(p);
      albedo *= 0.86 + d * 0.30;
    }
    // 大尺度的色相扰动：让沙丘有冷暖交替，而不是一整片均匀的黄。
    // 这是「沙漠看起来假」最常见的原因 —— 单一色相铺满整个视野。
    float hueShift = fbm(p * 0.045 + vec2(-7.0, 13.0), 3);
    albedo = mix(albedo, albedo * vec3(0.94, 0.97, 1.08), clamp(hueShift * 0.5 + 0.5, 0.0, 1.0) * 0.55);
    albedo = mix(albedo, albedo * vec3(1.07, 0.99, 0.90), clamp(-hueShift * 0.5 + 0.5, 0.0, 1.0) * 0.40);

    // ---------- 2. 岩石：陡坡 + 脊状噪声 ----------
    float rockMask = smoothstep(0.30, 0.58, slope + (ridged(p * 1.6, 4) - 0.5) * 0.35);
    vec3 rock;
    if (art && rockMask > 0.01) {
      // 三平面投影：陡坡上不会被拉成长条
      vec3 bw = pow(abs(N), vec3(4.0));
      bw /= (bw.x + bw.y + bw.z);
      vec4 rx = textureGrad(uRockA, rp.zy, rdx.zy, rdy.zy);
      vec4 ry = textureGrad(uRockA, rp.xz, rdx.xz, rdy.xz);
      vec4 rz = textureGrad(uRockA, rp.xy, rdx.xy, rdy.xy);
      vec3 rd = (rx.rgb * bw.x + ry.rgb * bw.y + rz.rgb * bw.z) * uArtGain.w;
      rock = vec3(0.38, 0.35, 0.31) * rd;
      if (artN) {
        vec3 nx = textureGrad(uRockN, rp.zy, rdx.zy, rdy.zy).rgb;
        vec3 ny = textureGrad(uRockN, rp.xz, rdx.xz, rdy.xz).rgb;
        vec3 nz = textureGrad(uRockN, rp.xy, rdx.xy, rdy.xy).rgb;
        vec3 rpN = vec3(0.0, nx.y * 2.0 - 1.0, nx.x * 2.0 - 1.0) * bw.x
                 + vec3(ny.x * 2.0 - 1.0, 0.0, ny.y * 2.0 - 1.0) * bw.y
                 + vec3(nz.x * 2.0 - 1.0, nz.y * 2.0 - 1.0, 0.0) * bw.z;
        float rh = nx.b * bw.x + ny.b * bw.y + nz.b * bw.z;
        // 高度混合：岩石的凸起先「冒」出沙面，交界线沿着岩缝走，而不是一圈模糊的过渡
        rockMask = clamp(rockMask + (rh - 0.5) * 1.6 * rockMask * (1.0 - rockMask) * 2.0, 0.0, 1.0);
        Np = mix(Np, rpN * 1.1, rockMask);
      }
    } else {
      rock = mix(vec3(0.30, 0.28, 0.26), vec3(0.46, 0.42, 0.37), ridged(p * 3.0, 3));
    }
    albedo = mix(albedo, rock, rockMask * 0.92);

    // ---------- 3. 草甸 ----------
    float grass = meadowMask(p, slope, h) * (1.0 - rockMask);
    vec3 grassCol;
    if (art && grass > 0.01) {
      vec3 gd = dualA(uGrassA, uvG, gxG, gyG, mixV).rgb * uArtGain.z;
      grassCol = vec3(0.33, 0.375, 0.165) * mix(vec3(1.0), gd, 0.9);
      if (artN) {
        vec4 gn = textureGrad(uGrassN, uvG, gxG, gyG);
        grass = clamp(grass + (gn.b - 0.5) * 1.4 * grass * (1.0 - grass) * 2.0, 0.0, 1.0);
        vec2 gnn = gn.rg * 2.0 - 1.0;
        Np = mix(Np, vec3(gnn.x, 0.0, gnn.y) * 0.7, grass);
      }
    } else {
      grassCol = mix(vec3(0.26, 0.31, 0.14), vec3(0.40, 0.44, 0.19),
                     fbm(p * 2.4, 3) * 0.5 + 0.5);
    }
    albedo = mix(albedo, grassCol, grass * 0.88);

    // ---------- 4. 潮线：水边一圈深色湿痕 + 泡沫 ----------
    float shoreline = 1.0 - smoothstep(0.0, 0.42, abs(h - uWaterLevel));
    float tideLine = shoreline * (0.6 + 0.4 * sin(uTime * 0.7 + fbm(p * 0.5, 2) * 5.0));
    albedo = mix(albedo, albedo * 0.62, tideLine * 0.55);

    float foamBand = shoreline * (1.0 - smoothstep(0.0, 0.42, abs(h - uWaterLevel) - 0.06));
    float foamN;
    if (art && foamBand > 0.01) {
      foamN = texture2D(uSeaNF, vWorldPos.xz / 5.0 + vec2(uTime * 0.012, 0.0)).b;
      foamN = smoothstep(0.15, 0.85, foamN);
    } else {
      foamN = fbm(p * 3.2 + vec2(uTime * 0.06, 0.0), 3) * 0.5 + 0.5;
    }
    float foam = foamBand * foamN;
    albedo = mix(albedo, vec3(0.86, 0.88, 0.86), clamp(foam * 1.4, 0.0, 0.8));

    // 贴图法线：把累加的扰动加到几何法线上（沙面的风纹、岩缝、草叶的起伏）
    vec3 Nd = artN ? normalize(N + Np) : N;

    // ---------- 5. 光照：半兰伯特 + 天光 + 太阳 ----
    float ndl = dot(Nd, uSunDir);
    float wrap = clamp((ndl + 0.35) / 1.35, 0.0, 1.0);      // wrap lighting，沙面更柔和
    vec3 sun = uSunColor * wrap * 1.15;

    // 半球天光：朝上的部分接天顶色，朝下接地面反弹色。
    // 天光的颜色同样带方向性 —— 面朝太阳的坡面接收到的是暖光，
    // 背光坡面接收到的是冷调天光，于是起伏的沙丘自然分出冷暖。
    float hemi = Nd.y * 0.5 + 0.5;
    vec3 skyAbove = skyColor(vec3(Nd.x, 0.65, Nd.z), uSunDir, uSkyTop, uSkyHorizon);
    vec3 ambient = mix(uNadir * 0.55, skyAbove, hemi) * 0.55;

    // 沙地的次表面感：迎光低角度时略微透亮
    float sss = pow(clamp(1.0 - abs(ndl), 0.0, 1.0), 3.0) * 0.22;
    vec3 scatter = uSunColor * sss * sandMix;

    vec3 color = albedo * (sun + ambient) + albedo * scatter;

    // 细颗粒高光（干燥沙面）；湿沙更亮更锐（一层薄水膜）
    vec3 H = normalize(uSunDir + V);
    float spec = pow(max(dot(Nd, H), 0.0), 42.0) * 0.16 * (1.0 - grass) * sandMix;
    if (art) spec += pow(max(dot(Nd, H), 0.0), 160.0) * 0.55 * wetness * (1.0 - rockMask);
    color += uSunColor * spec;

    // ---------- 5b. 车头灯：软边聚光 + 距离衰减 ----------
    if (uHeadI > 0.001) {
      vec3 Lh = uHeadPos - vWorldPos;
      float dh = length(Lh);
      Lh /= max(dh, 1e-3);
      float cone = smoothstep(0.86, 0.97, dot(-Lh, uHeadDir));
      // 近处压一压（d²/(d²+6)），否则车轮底下会被照成一块过曝的白斑
      float att = uHeadI * (dh * dh / (dh * dh + 6.0)) / (1.0 + dh * dh * 0.03);
      color += albedo * vec3(1.0, 0.86, 0.62) * cone * att * max(dot(Nd, Lh), 0.0);
    }

    // ---------- 6. 雾 + 输出 ----------
    color = applyFog(color, vWorldPos, cameraPosition, uSunDir,
                     uFogColor, uFogDensity, uFogHeightFalloff);

    gl_FragColor = outputColor(color, uChunkFade);
  }
`;

/* ================================================================== *
 * 海面：Gerstner 波 + 菲涅尔 + 浅水透色
 * ================================================================== */

export const WATER_VERT = /* glsl */`
  precision highp float;

  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uWaveScale;
  uniform vec2  uWaveDir0;
  uniform vec2  uWaveDir1;
  uniform vec2  uWaveDir2;
  uniform vec2  uWaveDir3;

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec2 vUv;

  // Gerstner 波：水平位移让波峰变尖、波谷变宽
  // 返回位移量，并通过累加导数重建法线
  vec3 gerstner(vec2 pos, vec2 dir, float steepness, float wavelength, float speed,
                float time, inout vec3 tangent, inout vec3 binormal) {
    float k = TAU / wavelength;
    float c = sqrt(9.81 / k);                    // 深水波速
    vec2 d = normalize(dir);
    float f = k * (dot(d, pos) - c * speed * time);
    float a = steepness / k;

    tangent  += vec3(-d.x * d.x * steepness * sin(f), d.x * steepness * cos(f), -d.x * d.y * steepness * sin(f));
    binormal += vec3(-d.x * d.y * steepness * sin(f), d.y * steepness * cos(f), -d.y * d.y * steepness * sin(f));

    return vec3(d.x * a * cos(f), a * sin(f), d.y * a * cos(f));
  }

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec2 p = wp.xz;

    vec3 tangent  = vec3(1.0, 0.0, 0.0);
    vec3 binormal = vec3(0.0, 0.0, 1.0);

    vec3 disp = vec3(0.0);
    float s = uWaveScale;
    disp += gerstner(p, uWaveDir0, 0.14 * s, 22.0, 1.00, uTime, tangent, binormal);
    disp += gerstner(p, uWaveDir1, 0.11 * s, 12.5, 1.18, uTime, tangent, binormal);
    disp += gerstner(p, uWaveDir2, 0.08 * s,  6.4, 1.42, uTime, tangent, binormal);
    disp += gerstner(p, uWaveDir3, 0.05 * s,  3.1, 1.75, uTime, tangent, binormal);

    wp.xyz += disp;

    vWorldPos = wp.xyz;
    vNormal = normalize(cross(binormal, tangent));
    vUv = p;

    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const WATER_FRAG = /* glsl */`
  precision highp float;

  uniform vec3      uSunDir;
  uniform vec3      uSunColor;
  uniform vec3      uSkyTop;
  uniform vec3      uSkyHorizon;
  uniform vec3      uFogColor;
  uniform vec3      uNadir;
  uniform float     uFogDensity;
  uniform float     uFogHeightFalloff;
  uniform float     uExposure;
  uniform float     uTime;
  uniform float     uWaterLevel;
  uniform float     uDeepColorMix;
  uniform float     uClarity;
  uniform sampler2D uHeightMap;     // CPU 烘焙的岛屿高度场（half float）
  uniform vec2      uMapOrigin;     // 贴图覆盖的世界范围（中心）
  uniform float     uMapSize;       // 贴图覆盖的世界边长
  uniform float     uArt;           // 1 = 有细浪法线 / 白沫贴图
  uniform sampler2D uSeaNF;         // rg = 细浪法线，b = 白沫

  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying vec2 vUv;

  ${GLSL_COMMON}

  // 采样岛屿高度：把世界坐标映射到贴图 uv
  float sampleTerrainHeight(vec2 worldXZ) {
    vec2 uv = (worldXZ - uMapOrigin) / uMapSize + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return -30.0;
    return texture2D(uHeightMap, uv).r;
  }

  void main() {
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 N = normalize(vNormal);

    // ---------- 1. 细浪法线扰动（叠加两层不同尺度） ----------
    float t = uTime;
    vec3 ripple;
    if (uArt > 0.5) {
      // 两层朝不同方向漂移的细浪法线贴图（第二层转过 37°、尺度互质，避免看出平铺）
      vec2 ra = texture2D(uSeaNF, vUv / 7.5 + vec2(t * 0.011, t * 0.007)).rg * 2.0 - 1.0;
      vec2 uvb = mat2(0.8, -0.6, 0.6, 0.8) * vUv / 2.9 - vec2(t * 0.019, t * 0.023);
      vec2 rb = texture2D(uSeaNF, uvb).rg * 2.0 - 1.0;
      rb = rb * mat2(0.8, -0.6, 0.6, 0.8);
      ripple = vec3(ra.x + rb.x * 0.75, 0.0, ra.y + rb.y * 0.75) * 0.6;
    } else {
      vec2 q1 = vUv * 0.85 + vec2(t * 0.09, t * 0.05);
      vec2 q2 = vUv * 2.10 - vec2(t * 0.16, t * 0.11);
      float n1 = fbm(q1, 3);
      float n2 = fbm(q2, 2);
      ripple = vec3(
        (fbm(q1 + vec2(0.06, 0.0), 3) - n1) * 2.6 + (fbm(q2 + vec2(0.04, 0.0), 2) - n2) * 1.4,
        0.0,
        (fbm(q1 + vec2(0.0, 0.06), 3) - n1) * 2.6 + (fbm(q2 + vec2(0.0, 0.04), 2) - n2) * 1.4
      ) * 0.9;
    }
    N = normalize(N + ripple);

    // ---------- 2. 水深：决定颜色与透明度 ----------
    float bed = sampleTerrainHeight(vWorldPos.xz);
    float depth = max(0.0, uWaterLevel - bed);
    float shallow = smoothstep(0.0, 3.2, depth);

    // 浪尖在极浅处会「打碎」
    float crestBreak = smoothstep(0.0, 1.6, vWorldPos.y - uWaterLevel) *
                       (1.0 - smoothstep(0.35, 1.2, depth));
    N = normalize(mix(N, vec3(0.0, 1.0, 0.0), crestBreak * 0.65));

    // ---------- 3. 菲涅尔 ----------
    float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
    fres = clamp(0.02 + 0.98 * fres, 0.0, 1.0);

    // ---------- 4. 水体本色 ----------
    // 三层色：泻湖（极浅）→ 浅海（透绿松石）→ 深海（墨蓝）
    // 深海的蓝不是「调」出来的：它来自水对长波段的吸收系数 ——
    // 红光在 5m 水深处已衰减到 1/10，所以远海必然趋近纯蓝。
    //
    // 注意色值给得偏暗：海面的亮度主要应该来自**反射的天空**，
    // 水体本色只是底子。如果本色给亮，整片海会变成不透明的青绿色塑料板。
    vec3 deepCol    = vec3(0.0022, 0.026, 0.058);
    vec3 shallowCol = vec3(0.014, 0.105, 0.135);
    vec3 lagoonCol  = vec3(0.055, 0.290, 0.300);
    vec3 body = mix(lagoonCol, shallowCol, smoothstep(0.0, 1.6, depth));
    body = mix(body, deepCol, smoothstep(1.2, 6.0, depth) * uDeepColorMix);

    // 水下沙床的透色：只在很浅的地方露出，且随深度迅速消失
    // （真空中沙床的可见深度约 3~5m，这里用 3.0m 作为衰减尺度）
    float bedVisible = exp(-depth * 0.34);
    vec3 sandGlow = vec3(0.30, 0.26, 0.17) * bedVisible * 0.40;
    body += sandGlow * uClarity;

    // ---------- 5. 反射：以天空梯度近似（含太阳镜面高光） ----------
    vec3 R = reflect(-V, N);
    // 反射的是**方向性**的天空：朝阳侧反射暖橙、背光侧反射冷蓝。
    // 早先用固定色插值，于是无论朝哪看，远海都反射着同一片暖橙，
    // 背对太阳时整片海就是脏黄色。
    vec3 skyRefl = skyColor(R, uSunDir, uSkyTop, uSkyHorizon);
    // 太阳在起伏水面上的碎金
    float sunSpec = pow(max(dot(R, uSunDir), 0.0), 420.0) * 3.2;
    float sunGlint = pow(max(dot(R, uSunDir), 0.0), 40.0) * 0.16;
    skyRefl += uSunColor * (sunSpec + sunGlint);

    // 远处的水面几乎完全由反射决定（菲涅尔在掠射角趋近 1），
    // 这里再显式加一点偏置，保证海平线附近是天空色而不是水体色。
    fres = max(fres, smoothstep(0.02, 0.35, 1.0 - max(dot(N, V), 0.0)) * 0.55);

    vec3 color = mix(body, skyRefl, fres);

    // ---------- 6. 岸边白沫 ----------
    float shore = 1.0 - smoothstep(0.0, 0.85, depth);
    float foamNoise;
    if (uArt > 0.5) {
      // 白沫贴图的蕾丝状纹理：两层以不同速度漂移，叠出「在退去」的感觉
      float fa = texture2D(uSeaNF, vUv / 4.0 + vec2(t * 0.045, t * 0.026)).b;
      float fb = texture2D(uSeaNF, vUv / 9.0 - vec2(t * 0.018, t * 0.031)).b;
      foamNoise = clamp(fa * 0.62 + fb * 0.5, 0.0, 1.0);
    } else {
      foamNoise = fbm(vUv * 1.6 + vec2(t * 0.22, t * 0.13), 4) * 0.5 + 0.5;
    }
    float foam = shore * smoothstep(0.32, 0.86, foamNoise);
    foam += crestBreak * 0.85 * smoothstep(0.4, 0.9, foamNoise);
    foam = clamp(foam, 0.0, 1.0);

    vec3 foamCol = mix(vec3(0.72, 0.76, 0.74), vec3(0.96, 0.95, 0.90), foamNoise);
    color = mix(color, foamCol, foam * 0.92);

    // ---------- 7. 雾 + 输出 ----------
    color = applyFog(color, vWorldPos, cameraPosition, uSunDir,
                     uFogColor, uFogDensity, uFogHeightFalloff);

    // 透明度：只有极浅的岸带才透出沙地，超过 2.5m 就完全不透明。
    // 这一点很关键 —— 如果深海仍留 2% 透明度，远处海面会透出下方的沙丘轮廓，
    // 整片海看起来就像一层铺在泥地上的塑料膜。
    float alpha = mix(0.62, 1.0, smoothstep(0.0, 2.5, depth));
    alpha = mix(alpha, 1.0, foam);
    // 极浅处快速淡出，让水面与沙滩自然衔接
    alpha *= smoothstep(-0.05, 0.18, depth);

    gl_FragColor = outputColor(color, alpha);
  }
`;

/* ================================================================== *
 * 草：实例化 + 风场
 * ================================================================== */

export const GRASS_VERT = /* glsl */`
  precision highp float;

  attribute vec3  aOffset;
  attribute float aPhase;
  attribute float aHeight;
  attribute vec3  aTint;

  uniform float uTime;
  uniform vec3  uWindDir;
  uniform float uWindStrength;
  uniform vec3  uPlayerPos;
  uniform float uSway;

  varying vec3  vTint;
  varying float vHeightT;
  varying vec3  vWorldPos;
  varying float vBend;

  void main() {
    float t = uv.y;                       // 草叶根部=0，叶尖=1
    vHeightT = t;
    vTint = aTint;

    vec3 pos = position;
    pos.y *= aHeight;
    pos.xz *= mix(0.7, 1.25, aPhase);

    // 根部固定、叶尖摆动：bend 随高度平方增长
    float bend = t * t;
    vBend = bend;

    // 风：主风向的阵风 + 垂直方向的抖动，用位置做相位差形成「草浪」
    float wave = sin(dot(aOffset.xz, uWindDir.xz) * 0.22 - uTime * 1.9 + aPhase * 6.28);
    float gust = 0.55 + 0.45 * sin(uTime * 0.42 + dot(aOffset.xz, vec2(0.03, 0.02)));
    float amp = uSway * uWindStrength * gust * (0.35 + 0.65 * bend);

    pos.xz += uWindDir.xz * (wave * 0.5 + 0.5) * amp * 0.9;
    pos.x  += sin(uTime * 2.7 + aPhase * 9.0) * amp * 0.16 * bend;
    pos.z  += cos(uTime * 2.3 + aPhase * 7.0) * amp * 0.16 * bend;

    // 天然倒伏：由 aPhase 推出一个固定的随机方向，
    // 这样既省下一个顶点属性，倒伏看起来也依然是随机分布的。
    vec2 lean = vec2(cos(aPhase * 21.7), sin(aPhase * 21.7));
    pos.xz += lean * bend * 0.22 * (aPhase - 0.5);

    // 被玩家踩到时向两侧让开
    vec3 world = aOffset + pos;
    vec2 toPlayer = aOffset.xz - uPlayerPos.xz;
    float d = length(toPlayer);
    float push = (1.0 - smoothstep(0.15, 1.5, d)) * bend;
    world.xz += normalize(toPlayer + vec2(1e-4)) * push * 0.55;

    vWorldPos = world;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

export const GRASS_FRAG = /* glsl */`
  precision highp float;

  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform vec3  uSkyTop;
  uniform vec3  uSkyHorizon;
  uniform vec3  uNadir;
  uniform vec3  uFogColor;
  uniform float uFogDensity;
  uniform float uFogHeightFalloff;
  uniform float uExposure;
  uniform float uTime;
  uniform float uAlphaCutoff;

  varying vec3  vTint;
  varying float vHeightT;
  varying vec3  vWorldPos;
  varying float vBend;

  ${GLSL_COMMON}

  void main() {
    // 用两段线性渐变模拟草叶的背光透射
    float back = pow(vHeightT, 0.7);
    vec3 albedo = vTint * mix(0.55, 1.25, back);

    // 草叶几乎没有厚度，法线近似朝上，再加一点点朝向抖动
    vec3 N = normalize(vec3(0.0, 1.0, 0.0));

    float ndl = max(dot(N, uSunDir), 0.0);
    float hemi = 0.55 + 0.45 * N.y;
    vec3 ambient = mix(uNadir * 0.4, mix(uSkyHorizon, uSkyTop, 0.5), hemi) * 0.5;
    vec3 color = albedo * (uSunColor * ndl * 1.05 + ambient);

    // 叶尖透光：黄昏逆光时草尖发亮
    float translucency = pow(vHeightT, 1.6) * pow(max(dot(-uSunDir, vec3(0.0, 0.3, 0.0)) + 0.6, 0.0), 2.0);
    color += uSunColor * translucency * 0.42 * vTint.g;

    // 根部阴影自遮蔽
    color *= mix(0.42, 1.0, smoothstep(0.0, 0.45, vHeightT));

    color = applyFog(color, vWorldPos, cameraPosition, uSunDir,
                     uFogColor, uFogDensity, uFogHeightFalloff);

    // 叶尖 alpha 收窄，得到自然的草叶轮廓
    float a = smoothstep(uAlphaCutoff, 0.65, vHeightT * 0.4 + 0.6);
    if (a < 0.02) discard;
    gl_FragColor = outputColor(color, a);
  }
`;

/* ================================================================== *
 * 云朵：软粒子
 * ================================================================== */

export const CLOUD_VERT = /* glsl */`
  precision highp float;

  attribute float aSeed;
  attribute float aScale;

  uniform float uTime;
  uniform vec3  uWindDir;
  uniform float uDrift;

  varying vec2  vUv;
  varying float vSeed;
  varying vec3  vWorldPos;
  varying float vDepthFade;

  void main() {
    vUv = uv;
    vSeed = aSeed;

    vec3 center = position;
    center.y *= 0.42;
    center.xz *= aScale;
    center.y  *= aScale;

    // 缓慢漂移，绕世界循环，避免云跑光
    center.x += mod(uTime * uDrift * uWindDir.x + aSeed * 800.0, 1600.0) - 800.0;
    center.z += mod(uTime * uDrift * uWindDir.z + aSeed * 400.0, 1600.0) - 800.0;

    vec4 wp = modelMatrix * vec4(center, 1.0);
    vec4 mv = viewMatrix * wp;
    vWorldPos = wp.xyz;

    // 距离越远越透明，避免远处的云糊成一片
    float dist = -mv.z;
    vDepthFade = (1.0 - smoothstep(500.0, 1800.0, dist)) * smoothstep(6.0, 40.0, dist);

    gl_Position = projectionMatrix * mv;
  }
`;

export const CLOUD_FRAG = /* glsl */`
  precision highp float;

  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform vec3  uSkyTop;
  uniform vec3  uSkyHorizon;
  uniform float uTime;
  uniform float uExposure;
  uniform float uOpacity;

  varying vec2  vUv;
  varying float vSeed;
  varying vec3  vWorldPos;
  varying float vDepthFade;

  ${GLSL_COMMON}

  void main() {
    vec2 p = vUv - 0.5;
    float r = length(p);

    // 用噪声把圆形粒子边缘打碎，避免看出「一堆球」
    float n = fbm(vUv * 3.4 + vec2(vSeed * 37.0, uTime * 0.012), 4) * 0.5 + 0.5;
    float alpha = 1.0 - smoothstep(0.06, 0.5, r + (n - 0.5) * 0.34);
    alpha *= uOpacity * vDepthFade;
    if (alpha < 0.004) discard;

    // 体积感的近似：中心厚、边缘薄
    float thick = (1.0 - smoothstep(0.0, 0.5, r)) * (0.55 + n * 0.45);

    float lit = max(dot(normalize(vec3(p.x, 0.85, p.y)), uSunDir), 0.0);
    vec3 bright = mix(uSkyHorizon, vec3(1.0, 0.95, 0.86), 0.6) + uSunColor * 0.55 * lit;
    vec3 dark   = mix(vec3(0.26, 0.32, 0.42), uSkyTop * 0.8, 0.45);
    vec3 col = mix(dark, bright, thick);

    // 边缘的朝阳镶边
    float rim = smoothstep(0.30, 0.5, r) * (1.0 - smoothstep(0.40, 0.52, r));
    col += uSunColor * rim * max(dot(uSunDir, vec3(0.0, 1.0, 0.0)) + 0.3, 0.0) * 0.55;

    gl_FragColor = outputColor(col, alpha);
  }
`;

/* ================================================================== *
 * 鸟群：实例化 + 扑翼
 * ================================================================== */

export const FLOCK_VERT = /* glsl */`
  precision highp float;

  attribute vec3  aOffset;      // 每只鸟在鸟群里的位置
  attribute float aFlapPhase;
  attribute float aFlapSpeed;

  uniform float uTime;

  varying vec3  vNormal;
  varying float vWing;      // 0=身体，1=翼尖
  varying vec3  vWorldPos;

  void main() {
    // 翼展方向为局部 x，翼尖的 |x| 越大，摆动越晚也越大
    float span = abs(position.x);
    vWing = span;

    float phase = uTime * aFlapSpeed + aFlapPhase;
    // 翼尖相位滞后 → 翅膀呈波浪式扇动，而不是整片刚性翻折
    float lag = span * 0.9;
    float flap = sin(phase - lag);
    float amp = span * span * 1.35;

    vec3 pos = position;
    pos.y += flap * amp;
    // 上挥时翼面微微收拢，下压时展开，产生推进感
    pos.x *= 1.0 - abs(flap) * 0.10 * span;

    vec3 n = normal;
    float bend = flap * span * 1.5;
    n = normalize(n + vec3(0.0, bend * 0.55, 0.0));

    // 鸟身朝鸟群公转的切向摆正（flockRoot 绕 +Y 正向旋转，切向 = 极角 + 90°；
    // 模型翼尖后掠，机头朝 +Z）。
    float heading = atan(aOffset.x, aOffset.z) + 1.5707963;
    float ch = cos(heading), sh = sin(heading);
    pos.xz = mat2(ch, -sh, sh, ch) * pos.xz;
    n.xz = mat2(ch, -sh, sh, ch) * n.xz;

    vec4 wp = modelMatrix * vec4(pos + aOffset, 1.0);
    vWorldPos = wp.xyz;
    vNormal = normalize(mat3(modelMatrix) * n);

    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const FLOCK_FRAG = /* glsl */`
  precision highp float;

  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform vec3  uSkyTop;
  uniform vec3  uSkyHorizon;
  uniform vec3  uFogColor;
  uniform float uFogDensity;
  uniform float uFogHeightFalloff;
  uniform float uExposure;
  uniform vec3  uBodyColor;

  varying vec3  vNormal;
  varying float vWing;
  varying vec3  vWorldPos;

  ${GLSL_COMMON}

  void main() {
    vec3 N = normalize(vNormal);
    // 双面光照：翅膀翻过来也要有光
    if (!gl_FrontFacing) N = -N;

    float ndl = max(dot(N, uSunDir), 0.0);
    float hemi = N.y * 0.5 + 0.5;
    vec3 ambient = mix(uSkyHorizon * 0.5, uSkyTop, hemi) * 0.55;

    vec3 albedo = mix(uBodyColor * 0.75, uBodyColor, vWing);
    vec3 color = albedo * (uSunColor * ndl * 1.1 + ambient);

    // 翼尖透光：逆光时剪影边缘发亮，是远距离鸟群最抓眼的细节
    float rim = pow(1.0 - abs(dot(N, normalize(cameraPosition - vWorldPos))), 2.5);
    color += uSunColor * rim * vWing * 0.9;

    color = applyFog(color, vWorldPos, cameraPosition, uSunDir,
                     uFogColor, uFogDensity, uFogHeightFalloff);

    gl_FragColor = outputColor(color, 1.0);
  }
`;

/* ================================================================== *
 * 羽毛：实例化薄片 + 风场（鹈鹕身上的绒毛层）
 * ================================================================== */

/**
 * 羽毛顶点着色器 —— 实例化 + 风场。
 *
 * 每片羽毛携带一个 per-instance 的 mat4 `aMatrix`：它在世界空间里的完整变换。
 *
 * 为什么不用「骨骼下标 + uniform mat4 uBones[N]」？
 * 因为 three.js 的 ShaderMaterial 默认按 GLSL ES 1.00 编译，
 * 而 ES 1.00 只允许用 constant-index-expression 索引 uniform 数组 ——
 * 用 attribute 传进来的下标属于未定义行为，在部分驱动上会直接编译失败。
 * 这里改成每帧在 CPU 侧算好 `骨骼世界矩阵 × 羽毛局部矩阵`，
 * 1200 次 Matrix4 乘法（约几十微秒）换来完全的跨平台可靠性，很划算。
 */
export const FEATHER_VERT = /* glsl */`
  precision highp float;

  attribute mat4  aMatrix;
  attribute float aPhase;
  attribute float aFlutter;
  attribute float aTint;

  uniform float uTime;
  uniform vec3  uWindDir;
  uniform float uWindStrength;
  uniform float uSpeed;

  varying float vAlong;
  varying float vAcross;
  varying vec3  vNormalW;
  varying vec3  vWorldPos;
  varying float vFlutterAmt;
  varying float vTint;

  void main() {
    // uv.y：0=羽根，1=羽尖；uv.x：0=左缘，1=右缘
    float along = uv.y;
    vAlong = along;
    vAcross = uv.x;
    vTint = aTint;

    // 先在羽毛自身的局部空间里做风场变形
    vec3 pos = position;
    float k = along * along;

    // ---- 风场 ----
    // 关键：位移量必须用「米」来量。羽毛本身只有 7.5cm 长，
    // 如果直接把风速（m/s，量级 5~18）当成位移，羽毛会被吹出十几米 ——
    // 早期版本就是这么写的，结果整只鸟炸成一团放射状的尖刺。
    // 这里先把风速归一化成 0..2 的无量纲强度，再乘一个很小的位移系数。
    float liftAmt = (0.5 + 0.5 * uWindStrength + uSpeed * 0.05) * aFlutter;   // 约 0..2
    float disp = liftAmt * 0.012;                                              // 米
    vFlutterAmt = clamp(liftAmt * 0.35, 0.0, 1.0);                             // 供片元着色使用

    float wave = sin(uTime * (7.0 + aPhase * 4.0) + aPhase * 12.0);
    pos.z += (wave * 0.6 + 0.7) * disp * k;                 // 沿羽面法线掀动
    pos.y -= uSpeed * 0.00025 * k;                          // 高速时羽尖向后贴伏
    pos.x += sin(uTime * 9.0 + aPhase * 21.0) * disp * 0.7 * k;   // 侧向抖动

    vec4 worldPos = modelMatrix * aMatrix * vec4(pos, 1.0);

    vWorldPos = worldPos.xyz;
    // 法线只用旋转部分：aMatrix 由刚体变换构成，无缩放/切变
    vNormalW = normalize(mat3(modelMatrix) * mat3(aMatrix) * normal);

    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

export const FEATHER_FRAG = /* glsl */`
  precision highp float;

  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform vec3  uSkyTop;
  uniform vec3  uSkyHorizon;
  uniform vec3  uFogColor;
  uniform float uFogDensity;
  uniform float uFogHeightFalloff;
  uniform float uExposure;
  uniform vec3  uBaseColor;
  uniform float uFeatherArt;      // 1 = 有羽毛贴图（羽轴 + 羽枝 + 轮廓）
  uniform sampler2D uFeatherTex;

  varying float vAlong;
  varying float vAcross;
  varying vec3  vNormalW;
  varying vec3  vWorldPos;
  varying float vFlutterAmt;
  varying float vTint;

  ${GLSL_COMMON}

  void main() {
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 N = normalize(vNormalW);
    if (!gl_FrontFacing) N = -N;

    // 羽毛的「丝绒感」：边缘亮、中心暗 —— 用菲涅尔近似绒毛的侧向散射
    float fres = pow(1.0 - abs(dot(N, V)), 2.0);

    float ndl = max(dot(N, uSunDir), 0.0);
    float hemi = N.y * 0.5 + 0.5;
    vec3 ambient = mix(uSkyHorizon * 0.6, uSkyTop, hemi) * 0.7;

    // 羽尖比羽根略亮，色相也略有差异（真实羽毛的渐变）
    vec3 albedo = uBaseColor * vTint * mix(0.70, 1.16, vAlong);
    if (uFeatherArt > 0.5) {
      // 贴图给出真实的羽片轮廓（alpha 剪裁）与羽轴、羽枝的明暗；
      // 亮度除以贴图平均亮度（0.594），整只鸟的白度不因贴图而改变。
      // 横向收窄到贴图中间 78%：贴图里羽片边缘是渐细的羽枝，直接铺满会让羽片显得稀疏
      vec4 ft = texture2D(uFeatherTex, vec2(0.5 + (vAcross - 0.5) * 0.78, vAlong));
      if (ft.a < 0.3) discard;
      float l = dot(ft.rgb, vec3(0.2126, 0.7152, 0.0722)) / 0.594;
      albedo *= mix(1.0, clamp(l, 0.55, 1.35), 0.85);
    }
    vec3 color = albedo * (uSunColor * (ndl * 0.95 + 0.10) + ambient);

    // 边缘绒毛散射 + 被风吹起时的透光
    color += uSunColor * fres * 0.5 * albedo;
    color += uSunColor * vFlutterAmt * 0.5 * albedo;

    color = applyFog(color, vWorldPos, cameraPosition, uSunDir,
                     uFogColor, uFogDensity, uFogHeightFalloff);

    gl_FragColor = outputColor(color, 1.0);
  }
`;

/* ================================================================== *
 * 水面尾迹：骑行时在沙地/浅水上留下的动态涟漪
 * ================================================================== */

export const WAKE_VERT = /* glsl */`
  precision highp float;

  uniform float uTime;
  uniform float uFade;

  varying vec2 vUv;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const WAKE_FRAG = /* glsl */`
  precision highp float;

  uniform float uTime;
  uniform float uFade;
  uniform vec3  uColor;
  uniform float uExposure;
  uniform vec3  uSunDir;

  varying vec2 vUv;
  varying vec3 vWorldPos;

  ${GLSL_COMMON}

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;

    // 同心圆环向外扩散
    float ring = sin(r * 26.0 - uTime * 5.2) * 0.5 + 0.5;
    float falloff = 1.0 - smoothstep(0.0, 1.0, r);
    float alpha = ring * falloff * falloff * uFade * 0.42;

    if (alpha < 0.005) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;
