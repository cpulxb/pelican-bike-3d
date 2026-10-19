/**
 * textures.js —— 美术贴图的加载器
 *
 * 场景的几何、动画、光照仍然全部由代码生成；这里加载的只是「表面细节」：
 * 地形四层材质（干沙 / 湿沙 / 草甸 / 岩石）的细节色与法线、海面细浪法线 + 白沫、
 * 道具木纹 / 灯塔墙面、羽毛的羽枝纹理、粒子精灵。贴图由 gpt-image-2.5 生成，
 * 再离线做成无缝平铺并推导出法线（见 README「美术资源」）。
 *
 * 设计约束：
 *   · **贴图是增强，不是依赖**。任何一张加载失败（离线、404、解码失败、超时），
 *     对应的着色器分支就留在原来的程序化实现上，不报错、不阻塞启动。
 *   · 细节色贴图是「归一化」的：每张图已除以自身的平均色（线性空间），
 *     着色器里用 `调色板颜色 × 贴图 × gain` 得到最终颜色。于是贴图只带来
 *     颗粒、纹路与局部色相变化，整体色调仍由原来的黄昏调色板决定 ——
 *     远处 mipmap 平均后恰好回到调色板本色，与天空 / 雾的色彩关系保持不变。
 *   · 低画质档只加载颜色贴图，不加载法线（省带宽也省采样）。
 */
import * as THREE from 'three';

/**
 * gain：把归一化贴图还原成「平均值 = 1」所需的倍数（离线处理时算出，见 README）。
 * 改贴图时要同步改这里。
 */
export const ART_GAIN = {
  sand: 2.6587,
  wetsand: 3.6275,
  grass: 5.4337,
  rock: 3.8815,
  wood: 2.4294,
  plaster: 1.4295,
};

const T = 'assets/textures/';

/**
 * key → { url, srgb, repeat, normal(仅中高档加载), flipY }
 * 地形 / 海面贴图用 flipY=false：这样 uv 的 v 轴与世界 +Z 同向，法线贴图的 G 通道
 * 直接对应「沿 +Z 的坡度」，不需要在着色器里再翻符号。
 */
const LIST = {
  sandA: { url: T + 'sand_albedo.webp', srgb: true, repeat: true, flipY: false },
  sandN: { url: T + 'sand_normal.webp', srgb: false, repeat: true, flipY: false, normal: true },
  wetA: { url: T + 'wetsand_albedo.webp', srgb: true, repeat: true, flipY: false },
  wetN: { url: T + 'wetsand_normal.webp', srgb: false, repeat: true, flipY: false, normal: true },
  grassA: { url: T + 'grass_albedo.webp', srgb: true, repeat: true, flipY: false },
  grassN: { url: T + 'grass_normal.webp', srgb: false, repeat: true, flipY: false, normal: true },
  rockA: { url: T + 'rock_albedo.webp', srgb: true, repeat: true, flipY: false },
  rockN: { url: T + 'rock_normal.webp', srgb: false, repeat: true, flipY: false, normal: true },
  seaNF: { url: T + 'sea_normal_foam.webp', srgb: false, repeat: true, flipY: false },
  wood: { url: T + 'wood_detail.webp', srgb: true, repeat: true, flipY: false },
  plaster: { url: T + 'plaster_detail.webp', srgb: true, repeat: true, flipY: false },
  feather: { url: T + 'feather.webp', srgb: true, repeat: false, flipY: true },
  particles: { url: T + 'particles.webp', srgb: false, repeat: false, flipY: true },
};

/**
 * 全局注册表：加载完成后各模块在构造时读取。
 * 值为 null 表示「没有这张图，走程序化回退」。
 */
export const ART = {
  tex: Object.fromEntries(Object.keys(LIST).map((k) => [k, null])),
  /** 'full' | 'albedo'（低档）| 'off' */
  level: 'off',
  get(key) { return this.tex[key] || null; },
};

/** 1×1 占位贴图：sampler uniform 不能是 null（某些驱动会报未绑定警告） */
let _placeholder = null;
export function placeholderTexture() {
  if (!_placeholder) {
    _placeholder = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    _placeholder.needsUpdate = true;
  }
  return _placeholder;
}

function loadOne(loader, url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done(null), timeoutMs);
    loader.load(
      url,
      (tex) => { clearTimeout(timer); done(tex); },
      undefined,
      () => { clearTimeout(timer); done(null); },
    );
  });
}

/**
 * 并行加载全部贴图。永不 reject。
 * @param {THREE.WebGLRenderer} renderer
 * @param {'low'|'medium'|'high'} quality
 * @param {(fraction:number)=>void} [onProgress]
 */
export async function loadArt(renderer, quality = 'high', onProgress) {
  const loader = new THREE.TextureLoader();
  const low = quality === 'low';
  const maxAniso = renderer.capabilities.getMaxAnisotropy?.() || 1;
  const aniso = Math.min(low ? 2 : quality === 'medium' ? 4 : 8, maxAniso);

  const entries = Object.entries(LIST).filter(([, d]) => !(low && d.normal));
  let finished = 0;
  onProgress?.(0);

  await Promise.all(entries.map(async ([key, d]) => {
    const tex = await loadOne(loader, d.url, 20000);
    finished++;
    onProgress?.(finished / entries.length);
    if (!tex) { console.warn(`[art] 贴图未加载，回退程序化：${d.url}`); return; }
    tex.colorSpace = d.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = d.repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    tex.flipY = d.flipY;
    tex.anisotropy = aniso;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    // 提前上传到 GPU：避免第一次出现在画面里时卡一帧
    try { renderer.initTexture(tex); } catch (_) { /* 旧版 three 没有 initTexture，忽略 */ }
    ART.tex[key] = tex;
  }));

  const t = ART.tex;
  const terrainOk = t.sandA && t.wetA && t.grassA && t.rockA;
  const normalsOk = t.sandN && t.wetN && t.grassN && t.rockN;
  ART.level = !terrainOk ? 'off' : (normalsOk ? 'full' : 'albedo');
  return ART;
}

/**
 * 给内置材质（MeshStandardMaterial）挂一层三平面投影的「归一化细节色」。
 * 用物体空间坐标采样：合并 / 实例化的几何没有可靠的 uv，三平面投影也不怕圆柱、圆锥的拉伸。
 * 贴图乘上去之后物体的平均颜色不变（贴图已除以自身平均色，gain 负责还原）。
 * 贴图不存在时什么也不做，材质保持原样。
 *
 * @param {THREE.Material} material
 * @param {THREE.Texture|null} tex
 * @param {{scale:number, strength:number, gain:number, swapTop?:boolean, key:string}} o
 *   scale：每米多少个贴图周期；swapTop：顶面投影交换坐标（让木纹横过跳台）
 */
export function addTriplanarDetail(material, tex, o) {
  if (!tex) return material;
  const f = (x) => Number(x).toFixed(4);
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uDetail = { value: tex };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;\nvObjN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uDetail;\nvarying vec3 vObjPos;\nvarying vec3 vObjN;')
      .replace('#include <color_fragment>', `#include <color_fragment>
      {
        vec3 bw = pow(abs(normalize(vObjN)), vec3(4.0));
        bw /= (bw.x + bw.y + bw.z);
        vec3 q = vObjPos * ${f(o.scale)};
        vec3 dt = texture2D(uDetail, q.zy).rgb * bw.x
                + texture2D(uDetail, ${o.swapTop ? 'q.zx' : 'q.xz'}).rgb * bw.y
                + texture2D(uDetail, q.xy).rgb * bw.z;
        diffuseColor.rgb *= mix(vec3(1.0), dt * ${f(o.gain)}, ${f(o.strength)});
      }`);
  };
  material.customProgramCacheKey = () => `triplanar-detail-${o.key}`;
  return material;
}
