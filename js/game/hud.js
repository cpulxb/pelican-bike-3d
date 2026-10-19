/**
 * hud.js —— 游戏界面：主菜单 / 模式选择 / 暂停 / 结算 / 相册 / 设置 + 局内 HUD
 *
 * 所有界面都是同一个 #menu 容器里按「屏」换内容；按钮用 data-action 委托给 Game。
 * 局内 HUD 的文字每 0.1 秒刷新一次（DOM 写入比 WebGL 还贵，没必要每帧写）。
 */
import { MISSIONS } from './photo.js';
import { records, settings } from './storage.js';

const $ = (id) => document.getElementById(id);

export function fmtTime(s, withMs = true) {
  if (s == null || !isFinite(s)) return '—';
  const neg = s < 0; s = Math.abs(s);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  const str = withMs ? `${m}:${sec.toFixed(2).padStart(5, '0')}` : `${m}:${String(Math.floor(sec)).padStart(2, '0')}`;
  return neg ? `-${str}` : str;
}
const fmtDelta = (d) => (d == null ? '' : `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICONS = {
  fish: '<svg viewBox="0 0 48 48"><path d="M6 24c6-9 18-12 28-6l8-6v24l-8-6C24 36 12 33 6 24z"/><circle cx="14" cy="22" r="2" class="eye"/></svg>',
  race: '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="15" fill="none" stroke-width="4"/><circle cx="24" cy="24" r="6"/></svg>',
  stunt: '<svg viewBox="0 0 48 48"><path d="M4 40h22l14-16v16z"/><path d="M28 14a8 8 0 1 1 10 8" fill="none" stroke-width="3"/></svg>',
  free: '<svg viewBox="0 0 48 48"><path d="M24 6l5 13h13l-10.5 8 4 13L24 32l-11.5 8 4-13L6 19h13z"/></svg>',
  sight: '<svg viewBox="0 0 48 48"><circle cx="24" cy="30" r="9"/><path d="M4 30h6M38 30h6M24 10v6M10 16l4 4M38 16l-4 4" fill="none" stroke-width="3"/></svg>',
};

/**
 * 界面插画（gpt-image-2.5，assets/ui/）的绝对地址。
 * 必须是绝对地址：写在 CSS 自定义属性里的相对 url() 会按「使用它的样式表」解析，
 * 也就是 css/ 目录，而不是页面目录。图没加载到时卡片只是少一张插画。
 */
const uiAsset = (name) => new URL(`assets/ui/${name}`, document.baseURI).href;

export const MODES = {
  fish: { name: '捕鱼 · 喉囊', desc: '3 分钟。接住跃出水面的发光鱼，送回鸟巢或灯塔。一次送得越多越值钱，但喉囊满了海鸥就会来抢。', icon: 'fish', duration: 180, record: 'fish', unit: '分' },
  race: { name: '检查点计时赛', desc: '环岛 10 个光环 × 3 圈。分段对比最佳圈，最佳圈会变成幽灵车陪你跑。', icon: 'race', record: 'race', lower: true, unit: '' },
  stunt: { name: '特技连击', desc: '2 分 30 秒。飞跃跳台，空中转体、俯仰、摇铃。落地干净才算分，连击越长倍率越高。', icon: 'stunt', duration: 150, record: 'stunt', unit: '分' },
  free: { name: '自由探索', desc: '不计时。鱼、跳台、萤火虫、海鸥、拍照任务全部开启，想骑多久骑多久。', icon: 'free', record: null, unit: '' },
};

export class GameUI {
  constructor(game) {
    this.game = game;
    this.menu = $('menu');
    this.body = $('menu-body');
    this.screen = null;
    this._stack = [];
    this._acc = 0;
    this.el = {
      mode: $('g-mode'), score: $('g-score'), best: $('g-best'), timer: $('g-timer'), sub: $('g-sub'), delta: $('g-delta'),
      compass: $('g-compass'), compassLabel: $('g-compass-label'), slots: $('g-pouch-slots'), pouch: $('g-pouch'),
      combo: $('g-combo'), comboMult: $('g-combo-mult'), comboBar: $('g-combo-bar'), comboBank: $('g-combo-bank'),
      wind: $('g-wind'), windArrow: $('g-wind-arrow'), missions: $('g-missions'),
      banner: $('g-banner'), bannerBig: $('g-banner-big'), bannerSmall: $('g-banner-small'), trick: $('g-trick'), pops: $('g-pops'),
      map: $('g-minimap'),
    };
    this.mapCtx = this.el.map.getContext('2d');
    this._buildMapBase();
    this._pouchCount = -1;
    this._lastScore = -1;
    this._missionKey = '';

    this.body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b || b.disabled) return;
      this.game.audio?.uiClick?.();
      this.game.menuAction(b.dataset.action, b.dataset.arg);
    });
    this.body.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.setting) this.game.setSetting(t.dataset.setting, t.type === 'checkbox' ? t.checked : t.type === 'range' ? Number(t.value) : t.value);
    });
  }

  /* ================================================================ *
   * 屏幕
   * ================================================================ */
  show(name, data = {}, push = false) {
    if (push && this.screen) this._stack.push([this.screen, this._data]);
    else if (!push) this._stack.length = 0;
    this.screen = name;
    this._data = data;
    const html = this[`_screen_${name}`](data);
    this.body.innerHTML = html;
    this.body.dataset.screen = name;
    this.menu.classList.add('open');
    document.body.classList.add('menu-open');
    // 动画重播
    this.body.classList.remove('enter');
    void this.body.offsetWidth;
    this.body.classList.add('enter');
    const first = this.body.querySelector('[data-autofocus]') || this.body.querySelector('button');
    if (first && !matchMedia('(pointer: coarse)').matches) first.focus({ preventScroll: true });
  }

  back() {
    const prev = this._stack.pop();
    if (prev) { this.show(prev[0], prev[1], false); this._stack.length = 0; return true; }
    return false;
  }

  hide() {
    this.menu.classList.remove('open');
    document.body.classList.remove('menu-open');
    this.screen = null;
    this._stack.length = 0;
  }

  get compact() { return window.innerWidth < 720; }

  get isOpen() { return this.menu.classList.contains('open'); }

  _screen_main() {
    const p = this.game.photos.progress;
    return `
      <div class="hero">
        <div class="hero__rule"></div>
        <h1 class="hero__title">鹈 鹕 骑 行</h1>
        <p class="hero__en">A Pelican on a Bicycle</p>
      </div>
      <nav class="mainnav">
        <button class="bigbtn" data-action="sightseeing" data-autofocus>
          <span class="bigbtn__ico">${ICONS.sight}</span>
          <span class="bigbtn__txt"><b>观光模式</b><small>自动环岛，安静地看一场黄昏</small></span>
        </button>
        <button class="bigbtn bigbtn--hot" data-action="modes">
          <span class="bigbtn__ico">${ICONS.fish}</span>
          <span class="bigbtn__txt"><b>游戏模式</b><small>捕鱼 · 计时赛 · 特技 · 拍照任务</small></span>
        </button>
        <div class="mainnav__row">
          <button class="pill" data-action="album">相册 <i>${this.game.photos.album.length}</i></button>
          <button class="pill" data-action="missions">任务 <i>${p.done}/${p.total}</i></button>
          <button class="pill" data-action="settings">设置</button>
          <button class="pill" data-action="help">操作</button>
        </div>
      </nav>
      <p class="menu__foot">程序化建模与音效 · 表面贴图与插画由 gpt-image-2.5 绘制</p>`;
  }

  _screen_modes() {
    const tod = settings.timeOfDay;
    const cards = Object.entries(MODES).map(([id, m]) => {
      let rec = '';
      if (id === 'race') {
        const bl = this.game.trial.bestLap;
        const bt = records.get('race');
        rec = `最佳圈 ${fmtTime(bl)}${bt ? ` · 总成绩 ${fmtTime(bt)}` : ''}`;
      } else if (m.record) {
        const r = records.get(m.record);
        rec = r != null ? `最高 ${r} 分` : '还没有记录';
      } else rec = '无计时';
      return `
        <button class="mode" data-action="start" data-arg="${id}">
          <span class="mode__art" style="--art: url(${uiAsset(`mode-${id}.webp`)})" aria-hidden="true"></span>
          <span class="mode__ico">${ICONS[m.icon]}</span>
          <span class="mode__name">${m.name}</span>
          <span class="mode__desc">${m.desc}</span>
          <span class="mode__rec">${rec}</span>
        </button>`;
    }).join('');
    return `
      <h2 class="menu__h">选择玩法</h2>
      <div class="modes">${cards}</div>
      <div class="chips" role="radiogroup" aria-label="时段">
        <span class="chips__label">时段</span>
        ${[['dusk', '黄昏'], ['night', '夜晚'], ['cycle', '昼夜循环']].map(([v, l]) =>
          `<button class="chip ${tod === v ? 'on' : ''}" data-action="tod" data-arg="${v}">${l}</button>`).join('')}
      </div>
      <div class="menu__actions"><button class="ghost-btn" data-action="back">返回</button></div>`;
  }

  _screen_pause() {
    const g = this.game;
    const sight = g.mode === 'sightseeing';
    return `
      <h2 class="menu__h">已暂停</h2>
      <p class="menu__sub">${sight ? '观光模式' : MODES[g.mode]?.name || ''}</p>
      <nav class="stack">
        <button class="btn btn--primary" data-action="resume" data-autofocus>继续</button>
        ${sight ? '' : '<button class="btn" data-action="restart">重新开始</button>'}
        <button class="btn" data-action="album">相册</button>
        <button class="btn" data-action="missions">拍照任务</button>
        <button class="btn" data-action="settings">设置</button>
        <button class="btn btn--quiet" data-action="quit">返回主菜单</button>
      </nav>`;
  }

  _screen_results(d) {
    const rows = d.rows.map(([k, v, cls]) => `<div class="res__row ${cls || ''}"><span>${k}</span><b>${v}</b></div>`).join('');
    return `
      <div class="res">
        <div class="res__kicker">${esc(d.kicker)}</div>
        <h2 class="res__title">${esc(d.title)}</h2>
        <div class="res__big">${d.big}</div>
        ${d.record ? '<div class="res__badge">新纪录！</div>' : ''}
        <div class="res__rows">${rows}</div>
        <nav class="stack stack--row">
          <button class="btn btn--primary" data-action="restart" data-autofocus>再来一局</button>
          <button class="btn" data-action="modes">换个玩法</button>
          <button class="btn btn--quiet" data-action="quit">主菜单</button>
        </nav>
      </div>`;
  }

  _screen_missions() {
    const done = this.game.photos.done;
    const list = MISSIONS.map((m) => `
      <li class="mis ${done.has(m.id) ? 'done' : ''}">
        <span class="mis__badge" style="--art: url(${uiAsset(`badge-${m.id}.webp`)})" aria-hidden="true"><i>${done.has(m.id) ? '✓' : ''}</i></span>
        <span class="mis__txt"><b>${m.title}</b><small>${m.desc}</small></span>
        <span class="mis__reward">+${m.reward}</span>
      </li>`).join('');
    return `
      <h2 class="menu__h">拍照任务</h2>
      <p class="menu__sub">游戏中按 <kbd>P</kbd> 拍照，满足条件即完成。完成的照片会自动收进相册。</p>
      <ul class="mislist">${list}</ul>
      <div class="menu__actions"><button class="ghost-btn" data-action="back" data-autofocus>返回</button></div>`;
  }

  _screen_album() {
    const al = this.game.photos.album;
    const grid = al.length
      ? al.map((p) => `
        <figure class="ph" data-action="photo" data-arg="${p.id}" tabindex="0">
          <img src="${p.img}" alt="${esc(p.title || '照片')}" loading="lazy" />
          <figcaption><b>${esc(p.title || '随手拍')}</b><small>${esc(p.clock || '')} · ${new Date(p.at).toLocaleDateString('zh-CN')}</small></figcaption>
        </figure>`).join('')
      : '<p class="empty">相册还是空的。骑车时按 <kbd>P</kbd> 拍下第一张吧。</p>';
    return `
      <h2 class="menu__h">相册 <small>${al.length} / 24</small></h2>
      <div class="album">${grid}</div>
      <div class="menu__actions"><button class="ghost-btn" data-action="back" data-autofocus>返回</button></div>`;
  }

  _screen_photo(d) {
    const p = this.game.photos.album.find((x) => x.id === d.id);
    if (!p) return this._screen_album();
    return `
      <figure class="lightbox"><img src="${p.img}" alt="${esc(p.title || '照片')}" /><figcaption><b>${esc(p.title || '随手拍')}</b><small>${esc(p.clock || '')} · ${new Date(p.at).toLocaleString('zh-CN')}</small></figcaption></figure>
      <nav class="stack stack--row">
        <button class="btn" data-action="download" data-arg="${p.id}">下载</button>
        <button class="btn btn--danger" data-action="delphoto" data-arg="${p.id}">删除</button>
        <button class="btn btn--quiet" data-action="back" data-autofocus>返回</button>
      </nav>`;
  }

  _screen_settings() {
    const q = this.game.ctx.state.quality;
    const sel = (v, cur) => (v === cur ? 'selected' : '');
    return `
      <h2 class="menu__h">设置</h2>
      <div class="form">
        <label class="field"><span>音量</span><input type="range" min="0" max="1" step="0.05" value="${settings.volume}" data-setting="volume" /></label>
        <label class="field"><span>阵风（会让车头轻微偏转）</span><input type="checkbox" ${settings.wind ? 'checked' : ''} data-setting="wind" /></label>
        <label class="field"><span>画面震动</span><input type="checkbox" ${settings.shake ? 'checked' : ''} data-setting="shake" /></label>
        <label class="field"><span>物理真实度${this.game.ctx.physicsReady ? '' : '（物理引擎未加载）'}</span>
          <select data-setting="physics" ${this.game.ctx.physicsReady ? '' : 'disabled'}><option value="real" ${sel('real', settings.physics)}>真实（重力 9.81、真实抓地与水阻）</option><option value="arcade" ${sel('arcade', settings.physics)}>街机（更重的落地、更稳的抓地）</option></select></label>
        <label class="field"><span>触屏按键</span>
          <select data-setting="touch"><option value="auto" ${sel('auto', settings.touch)}>自动</option><option value="on" ${sel('on', settings.touch)}>始终显示</option><option value="off" ${sel('off', settings.touch)}>隐藏</option></select></label>
        <label class="field"><span>画质</span>
          <select data-setting="quality"><option value="low" ${sel('low', q)}>低</option><option value="medium" ${sel('medium', q)}>中</option><option value="high" ${sel('high', q)}>高</option></select></label>
      </div>
      <div class="menu__actions">
        <button class="ghost-btn ghost-btn--danger" data-action="wipe">清除存档</button>
        <button class="ghost-btn" data-action="back" data-autofocus>返回</button>
      </div>`;
  }

  _screen_help() {
    const rows = [
      ['W / ↑', '加速（空中：压低车头）'], ['S / ↓', '刹车（空中：抬起车头）'], ['A D / ← →', '转向（空中：转体）'],
      ['Space', '起跳'], ['B', '摇车铃（驱赶海鸥 / 空中加分）'], ['P', '拍照（完成任务、存进相册）'],
      ['R', '回到起点 / 上一个检查点'], ['1–4', '切换镜头'], ['Esc', '暂停 / 返回'], ['M', '声音开关'], ['H', '隐藏界面'],
      ['F3', '显示碰撞体线框（调试）'],
    ].map(([k, v]) => `<div class="help__row"><kbd>${k}</kbd><span>${v}</span></div>`).join('');
    return `
      <h2 class="menu__h">操作</h2>
      <div class="help">${rows}</div>
      <p class="menu__sub">手机：左侧摇杆转向与加速，右侧按键起跳 / 摇铃 / 拍照 / 刹车。拖动画面可以环视。</p>
      <p class="menu__sub">物理：石头、浮木和你都有真实的质量与动量 —— 小石子会被踢飞，大礁石会让你摔车；水越深越难骑、越容易打滑。设置里可切「真实 / 街机」。</p>
      <div class="menu__actions"><button class="ghost-btn" data-action="back" data-autofocus>返回</button></div>`;
  }

  /* ================================================================ *
   * 局内 HUD
   * ================================================================ */
  setMode(mode) {
    const cl = document.body.classList;
    cl.remove('is-menu', 'is-sight', 'is-game', 'mode-fish', 'mode-race', 'mode-stunt', 'mode-free');
    if (!mode) cl.add('is-menu');
    else if (mode === 'sightseeing') cl.add('is-sight');
    else cl.add('is-game', `mode-${mode}`);
    if (mode && MODES[mode]) this.el.mode.textContent = MODES[mode].name;
    this._pouchCount = -1;
    this._lastScore = -1;
    this._missionKey = '';
    this.el.delta.textContent = '';
    this.el.trick.classList.remove('show');
    this.el.pops.textContent = '';
  }

  /** 每帧调用；文字类刷新节流到 10Hz */
  update(dt, s) {
    this._acc += dt;
    if (this._acc < 0.1) return;
    this._acc = 0;
    const el = this.el;

    if (s.score !== this._lastScore) {
      el.score.textContent = s.score.toLocaleString('zh-CN');
      if (this._lastScore >= 0 && s.score > this._lastScore) { el.score.classList.remove('bump'); void el.score.offsetWidth; el.score.classList.add('bump'); }
      this._lastScore = s.score;
    }
    el.best.textContent = s.bestLabel;
    el.timer.textContent = s.timer;
    el.timer.classList.toggle('warn', !!s.timerWarn);
    el.sub.textContent = s.sub || '';

    // 罗盘：相对朝向 → 旋转。目标在车手左侧（+X 侧）时 rel>0，屏幕上要往左转（逆时针）
    if (s.compass) {
      el.compass.style.display = '';
      el.compass.style.setProperty('--rot', `${(-s.compass.rel * 180 / Math.PI).toFixed(1)}deg`);
      el.compassLabel.textContent = `${s.compass.label} · ${Math.round(s.compass.dist)}m`;
      el.compass.dataset.kind = s.compass.kind;
    } else el.compass.style.display = 'none';

    // 喉囊
    if (s.pouch != null && s.pouch !== this._pouchCount) {
      const cap = s.pouchCap;
      let html = '';
      for (let i = 0; i < cap; i++) html += `<i class="${i < s.pouch ? 'full' : ''}"></i>`;
      el.slots.innerHTML = html;
      el.pouch.classList.toggle('max', s.pouch >= cap);
      if (this._pouchCount >= 0) { el.pouch.classList.remove('bump'); void el.pouch.offsetWidth; el.pouch.classList.add('bump'); }
      this._pouchCount = s.pouch;
    }

    // 连击
    if (s.combo) {
      el.combo.classList.toggle('live', s.combo.n > 0);
      el.comboMult.textContent = `×${s.combo.mult.toFixed(1)}`;
      el.comboBar.style.transform = `scaleX(${s.combo.t.toFixed(3)})`;
      el.comboBank.textContent = s.combo.bank > 0 ? `+${s.combo.bank}` : '';
    }

    // 阵风
    el.wind.classList.toggle('show', s.wind > 0.15);
    if (s.wind > 0.15) el.windArrow.style.transform = `rotate(${(-s.windRel * 180 / Math.PI - 90).toFixed(0)}deg)`;

    // 任务卡
    const key = s.missions.map((m) => m.id).join(',');
    if (key !== this._missionKey) {
      this._missionKey = key;
      el.missions.innerHTML = s.missions.map((m) => `<div class="mcard"><span class="mcard__cam" style="--art: url(${uiAsset(`badge-${m.id}.webp`)})" aria-hidden="true"></span><span><b>${m.title}</b><small>${m.desc}</small></span></div>`).join('');
    }

    this._drawMap(s.map);
  }

  /** @param {string} [badge] 拍照任务 id：横幅上方显示该任务的徽章 */
  banner(big, small = '', ms = 1400, cls = '', badge = '') {
    const b = this.el.banner;
    this.el.bannerBig.textContent = big;
    this.el.bannerSmall.textContent = small;
    if (badge) b.style.setProperty('--art', `url(${uiAsset(`badge-${badge}.webp`)})`);
    b.className = `banner show ${cls}${badge ? ' has-badge' : ''}`;
    clearTimeout(this._bt);
    if (ms > 0) this._bt = setTimeout(() => b.classList.remove('show'), ms);
  }

  trick(text, cls = '', ms = 1300) {
    const t = this.el.trick;
    t.textContent = text;
    t.className = `trick show ${cls}`;
    clearTimeout(this._tt);
    this._tt = setTimeout(() => t.classList.remove('show'), ms);
  }

  /** 在屏幕坐标 (x,y) 处飘一个数字 */
  pop(text, x, y, cls = '') {
    const d = document.createElement('div');
    d.className = `pop ${cls}`;
    d.textContent = text;
    d.style.left = `${x}px`;
    d.style.top = `${y}px`;
    this.el.pops.appendChild(d);
    setTimeout(() => d.remove(), 1300);
    // 防止极端情况下堆积
    while (this.el.pops.childElementCount > 12) this.el.pops.firstElementChild.remove();
  }

  /* ================================================================ *
   * 小地图（北朝上；屏幕右 = 世界 -X，与骑手视角一致）
   * ================================================================ */
  _buildMapBase() {
    const L = this.game.layout;
    const S = 200, R = 96, scale = R / 270;
    this.mapScale = scale;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d');
    x.save();
    x.beginPath(); x.arc(S / 2, S / 2, R + 2, 0, Math.PI * 2); x.clip();
    const sea = x.createRadialGradient(S / 2, S / 2, 20, S / 2, S / 2, R);
    sea.addColorStop(0, 'rgba(23, 80, 92, 0.85)');
    sea.addColorStop(1, 'rgba(6, 22, 29, 0.85)');
    x.fillStyle = sea; x.fillRect(0, 0, S, S);
    x.beginPath();
    for (let i = 0; i <= L.shore.N; i++) {
      const a = (i / L.shore.N) * Math.PI * 2;
      const r = L.shore.r[i % L.shore.N] * scale;
      const px = S / 2 - Math.sin(a) * r, py = S / 2 - Math.cos(a) * r;
      i ? x.lineTo(px, py) : x.moveTo(px, py);
    }
    x.closePath();
    const land = x.createRadialGradient(S / 2, S / 2, 10, S / 2, S / 2, R * 0.9);
    land.addColorStop(0, 'rgba(214, 178, 122, 0.95)');
    land.addColorStop(1, 'rgba(176, 138, 92, 0.95)');
    x.fillStyle = land; x.fill();
    x.strokeStyle = 'rgba(242, 228, 205, 0.55)'; x.lineWidth = 1.2; x.stroke();
    x.restore();
    this.mapBase = c;
  }

  _w2m(wx, wz) { return [100 - wx * this.mapScale, 100 - wz * this.mapScale]; }

  _drawMap(m) {
    if (!m) return;
    const x = this.mapCtx;
    x.clearRect(0, 0, 200, 200);
    x.drawImage(this.mapBase, 0, 0);
    const t = performance.now() * 0.001;
    const dot = (wx, wz, r, color, ring) => {
      const [px, py] = this._w2m(wx, wz);
      x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fillStyle = color; x.fill();
      if (ring) { x.lineWidth = 1.5; x.strokeStyle = ring; x.stroke(); }
    };
    if (m.rings) {
      m.rings.forEach((r, i) => {
        const next = i === m.nextRing;
        dot(r.x, r.z, next ? 4.2 : 2.2, next ? '#ffd27a' : 'rgba(255,210,122,0.45)', next ? 'rgba(255,255,255,0.8)' : null);
      });
    }
    if (m.ramps) m.ramps.forEach((r) => dot(r.cx, r.cz, 2.2, 'rgba(120, 72, 40, 0.95)', 'rgba(242,228,205,0.6)'));
    if (m.zones) m.zones.forEach((z) => dot(z.x, z.z, z.kind === 'lighthouse' ? 4 : 3.2, z.kind === 'lighthouse' ? '#ffc46b' : '#7ff0e0', m.carrying ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.4)'));
    if (m.spots) m.spots.forEach((s) => { if (s.active) dot(s.x, s.z, 2.5 + Math.sin(t * 6) * 0.8, 'rgba(160, 250, 255, 0.95)'); });
    if (m.ghost) dot(m.ghost.x, m.ghost.z, 3, 'rgba(127, 240, 255, 0.7)');
    // 玩家箭头
    const [px, py] = this._w2m(m.player.x, m.player.z);
    const dx = -Math.sin(m.yaw), dy = -Math.cos(m.yaw);
    x.save();
    x.translate(px, py);
    x.rotate(Math.atan2(dx, -dy));
    x.beginPath(); x.moveTo(0, -7); x.lineTo(5, 5); x.lineTo(0, 2.5); x.lineTo(-5, 5); x.closePath();
    x.fillStyle = '#fff4e2'; x.fill();
    x.lineWidth = 1.5; x.strokeStyle = '#ff8c42'; x.stroke();
    x.restore();
  }
}
