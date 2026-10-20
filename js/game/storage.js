/**
 * storage.js —— localStorage 的安全封装
 *
 * 隐私模式 / 配额已满 / 被禁用时 localStorage 会抛异常，
 * 存档失败绝不能把游戏带崩，所以所有读写都包在 try 里。
 */

const PREFIX = 'pelican-bike.';

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** @returns {boolean} 是否写入成功（配额不足时返回 false） */
export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
}

/** 各模式的最高分 / 最佳成绩 */
export const records = {
  get(mode) { return load(`best.${mode}`, null); },
  /** 分数越高越好（lowerIsBetter=true 时越低越好，用于计时） */
  submit(mode, value, lowerIsBetter = false) {
    const prev = this.get(mode);
    const better = prev == null || (lowerIsBetter ? value < prev : value > prev);
    if (better) save(`best.${mode}`, value);
    return better;
  },
};

/** 用户设置 */
const DEFAULT_SETTINGS = { wind: true, volume: 0.8, timeOfDay: 'dusk', touch: 'auto', shake: true, physics: 'arcade' };
export const settings = Object.assign({}, DEFAULT_SETTINGS, load('settings', {}));
export function saveSettings() { save('settings', settings); }
