/**
 * rapier-loader.js —— 加载 Rapier3D（WASM 物理引擎）
 *
 * 顺序：vendor/ 里的本地副本 → jsDelivr CDN → 放弃。
 * 用的是 @dimforge/rapier3d-compat：WASM 以 base64 内联在同一个 ES 模块里，
 * 不需要服务器给 .wasm 配 MIME，GitHub Pages / python http.server 都能直接跑。
 *
 * 任何一步失败都不抛错：返回 null，main.js 退回原来的手写骑行物理。
 * 调试开关：
 *   ?physics=off   强制不用物理引擎（测试回退路径）
 *   ?rapier=cdn    跳过本地副本，直接从 CDN 拉
 */

export const RAPIER_VERSION = '0.19.3';
const LOCAL = new URL('../../vendor/rapier/rapier.mjs', import.meta.url).href;
const CDN = `https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@${RAPIER_VERSION}/rapier.mjs`;

function withTimeout(p, ms, what) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} 超时（${ms}ms）`)), ms)),
  ]);
}

export async function loadRapier({ timeout = 10000 } = {}) {
  const q = new URLSearchParams(location.search);
  if (q.get('physics') === 'off') {
    console.warn('[physics] ?physics=off：使用手写骑行物理');
    return null;
  }
  const sources = q.get('rapier') === 'cdn' ? [CDN] : [LOCAL, CDN];
  for (const url of sources) {
    try {
      const mod = await withTimeout(import(/* @vite-ignore */ url), timeout, `加载 ${url}`);
      const R = mod.default || mod;
      // 0.19 起 init() 推荐传一个对象；compat 包的 WASM 是内联的，不需要任何参数
      await withTimeout(R.init({}), timeout, 'Rapier 初始化');
      console.info(`[physics] Rapier ${R.version?.() || RAPIER_VERSION} 已就绪（${url === LOCAL ? '本地' : 'CDN'}）`);
      return R;
    } catch (err) {
      console.warn(`[physics] Rapier 加载失败：${url}`, err?.message || err);
    }
  }
  console.warn('[physics] Rapier 不可用，退回手写骑行物理（石头 / 浮体 / 浮力关闭）');
  return null;
}
