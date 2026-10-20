/**
 * game.js —— 游戏模式的总控：状态机 + 计分 + 存档 + 各玩法模块的调度
 *
 *   menu ──► countdown ──► playing ──► results
 *              ▲  │           │  ▲
 *              │  └──► paused ◄┘  │
 *              └──────────────────┘ (重新开始)
 *
 * 观光模式（sightseeing）也是一个 mode：只是不开任何玩法模块，
 * 保持原来「自动骑行 + 遥测面板」的样子。
 *
 * 与 main.js 的接口刻意收得很窄：
 *   game.groundAt(x,z,h,n)   物理查询地面（跳台会改写高度与法线）
 *   game.update(dt)          物理之后、摆骨骼之前调用
 *   game.handleEvents(e)     先过一遍输入事件（暂停 / 拍照 / 车铃）
 *   game.onTakeoff() / game.onLand(info)   离地与落地回调
 *   game.onPhoto(canvas)     拍照（渲染完成之后同步调用）
 */
import * as THREE from 'three';
import { buildLayout } from './layout.js';
import { Particles } from './particles.js';
import { Landmarks } from './landmarks.js';
import { FishSystem } from './fish.js';
import { TimeTrial } from './checkpoints.js';
import { Stunts } from './stunts.js';
import { WorldEvents } from './events.js';
import { PhotoMissions } from './photo.js';
import { GameUI, MODES, fmtTime } from './hud.js';
import { records, settings, saveSettings, remove } from './storage.js';
import { SPAWN } from '../util/noise.js';
import { PELICAN } from '../objects/pelican.js';

const TOD = {
  dusk: { time: 0.735, day: 2400 },     // 黄昏：时间几乎停在黄金时刻
  night: { time: 0.885, day: 2400 },
  cycle: { time: 0.70, day: 300 },      // 一局里能看到日落到入夜
};
const DEFAULT_DAY = 420;

const _proj = new THREE.Vector3();

export class Game {
  constructor(ctx) {
    this.ctx = ctx;
    const { scene, audio, bike, env } = ctx;
    this.audio = audio;
    this.layout = buildLayout();
    this.particles = new Particles(scene);
    this.landmarks = new Landmarks(scene, this.layout);
    this.fish = new FishSystem(scene, this.layout, this.particles, audio);
    this.trial = new TimeTrial(scene, this.layout, this.particles, audio);
    this.stunts = new Stunts(scene, this.layout, this.particles, audio);
    this.events = new WorldEvents(scene, bike, env, this.particles, audio);
    this.photos = new PhotoMissions();
    this.ui = new GameUI(this);

    // 喙尖锚点：捕鱼判定 / 海鸥俯冲的目标
    this.beakAnchor = new THREE.Object3D();
    this.beakAnchor.position.set(0, -0.02, PELICAN.beakLen * 0.82);
    ctx.pelican.beakLower.add(this.beakAnchor);
    this.beakTip = new THREE.Vector3();

    this.mode = null;
    this.phase = 'menu';
    this.score = 0;
    this.timeLeft = 0;
    this.countdown = 0;
    this.stats = {};

    this.fish.onCatch = (f, p) => this._onCatch(p);
    this.fish.onFull = () => { this.ui.trick('喉囊满了！先去送鱼', 'warn', 1500); this.audio?.denied?.(); };

    this._map = {
      rings: this.layout.checkpoints, ramps: this.stunts.ramps, zones: this.landmarks.zones, spots: this.fish.spots,
      player: ctx.player.pos, yaw: 0, nextRing: -1, carrying: 0, ghost: null,
    };
    this._hud = { score: 0, bestLabel: '', timer: '', sub: '', missions: [], map: this._map, pouch: null, pouchCap: 5, combo: null, compass: null, wind: 0, windRel: 0 };
    this._compass = { rel: 0, dist: 0, label: '', kind: '' };
    this._combo = { n: 0, mult: 1, t: 0, bank: 0 };

    this.events.wind.enabled = settings.wind;
    this.applyTouchSetting();
    this.audio?.setVolume?.(settings.volume);
  }

  get gameplay() { return !!this.mode && this.mode !== 'sightseeing'; }
  /** 倒计时 / 结算 / 菜单时，玩家不能操控 */
  get inputLocked() { return this.phase === 'countdown' || this.phase === 'results' || this.phase === 'menu'; }

  /* ================================================================ *
   * 物理接口
   * ================================================================ */
  groundAt(x, z, h, n) { return this.stunts.groundAt(x, z, h, n); }

  collide(pos) { return this.landmarks.collide(pos); }

  /** 喉囊装载量 0..1（物理用它算「更重」） */
  get load() { return this.gameplay ? this.fish.fill : 0; }

  /** 阵风造成的转向偏置 */
  get windSteer() { return this.gameplay && this.phase === 'playing' ? this.events.wind.steer : 0; }

  /**
   * 撞车（物理引擎检测到超过阈值的碰撞冲量）：与「落地摔车」同一套反馈 ——
   * 提示、音效、绒羽、摔车统计，特技连击作废。观光模式只有绒羽和声音。
   */
  onCrash(reason = 'collide', what = '') {
    this.audio?.crash?.();
    const pp = this.ctx.player.pos;
    this.particles.burst({ x: pp.x, y: pp.y + 1.0, z: pp.z, count: 18, speed: 1.6, up: 1.6, spread: 1.0, color: [1, 0.96, 0.88], intensity: 0.9, size: 0.16, life: 1.6, gravity: 0.8, drag: 1.6, sprite: 3 });
    if (!this.gameplay || this.phase !== 'playing') return;
    this.stats.crashes = (this.stats.crashes || 0) + 1;
    const r = this.stunts.addTrick({ clean: false });
    const label = { rock: '撞上礁石！', stone: '撞飞了石头！', lighthouse: '撞上灯塔！', nest: '撞上鸟巢！', palm: '撞上椰树！', ramp: '撞上跳台！', floater: '撞上浮木！' }[what] || '撞车！';
    this.ui.trick(r?.lost ? `${label}连击 ${r.lost} 分作废` : label, 'bad', 1600);
  }

  onTakeoff() {
    if (this.gameplay) this.audio?.whoosh?.(0.6);
  }

  /**
   * 落地评判
   * @param {object} info { airTime, spin, flip, yawErr, pitchErr, lean, bell, height }
   * @returns {{crash:boolean}}
   */
  onLand(info) {
    if (!this.gameplay || this.phase !== 'playing') return { crash: false };
    const res = this.stunts.judge(info);
    if (res.small) return { crash: false };
    if (!res.clean) {
      const r = this.stunts.addTrick(res);
      if (res.crash) {
        this.ui.trick(r?.lost ? `摔车！连击 ${r.lost} 分作废` : '摔车！', 'bad', 1600);
        this.audio?.crash?.();
        this.stats.crashes = (this.stats.crashes || 0) + 1;
        // 摔车：一蓬绒羽（图集第 3 格；没有图集时就是几粒柔光）
        const pp = this.ctx.player.pos;
        this.particles.burst({ x: pp.x, y: pp.y + 1.0, z: pp.z, count: 18, speed: 1.6, up: 1.6, spread: 1.0, color: [1, 0.96, 0.88], intensity: 0.9, size: 0.16, life: 1.6, gravity: 0.8, drag: 1.6, sprite: 3 });
        return { crash: true };
      }
      this.ui.trick('落地不稳', 'warn');
      return { crash: false };
    }
    if (this.mode === 'race') {
      if (res.points > 0) this.ui.trick(res.name, 'good', 900);
      return { crash: false };
    }
    const r = this.stunts.addTrick(res);
    if (r) {
      this.ui.trick(`${res.name}  +${r.gained}${r.multiplier > 1 ? `  ×${r.multiplier.toFixed(1)}` : ''}`, res.perfect ? 'perfect' : 'good', 1500);
      this.audio?.trick?.(this.stunts.combo);
    }
    return { crash: false };
  }

  /* ================================================================ *
   * 状态切换
   * ================================================================ */
  openMenu() {
    this._teardownRun();
    this.mode = null;
    this.phase = 'menu';
    const { state, rig, sky } = this.ctx;
    state.gamePaused = false;
    this.ctx.setAutoRide(true);
    sky.dayLength = DEFAULT_DAY;
    rig.setMode('cinematic');
    this.ui.setMode(null);
    this.ui.show('main');
    this._showSystems(false);
    this.ctx.setMenuFraming?.(true);
  }

  startSightseeing() {
    this._teardownRun();
    this.mode = 'sightseeing';
    this.phase = 'playing';
    this.ctx.state.gamePaused = false;
    this.ctx.setAutoRide(true);
    this.ctx.sky.dayLength = DEFAULT_DAY;
    this.ctx.rig.setMode('chase');
    this.ui.hide();
    this.ui.setMode('sightseeing');
    this._showSystems(false);
    this.ctx.toast('观光模式 · 按 Esc 打开菜单');
  }

  start(mode) {
    if (!MODES[mode]) return;
    this._teardownRun();
    this.mode = mode;
    this.phase = 'countdown';
    this.countdown = 3.999;
    this._lastCount = 4;
    this.score = 0;
    this.stats = { caught: 0, delivered: 0, deliveries: 0, bestDelivery: 0, stolen: 0, fireflies: 0, missions: 0, crashes: 0, scared: 0 };
    this.timeLeft = MODES[mode].duration || 0;
    this.elapsed = 0;

    const { state, rig, sky } = this.ctx;
    state.gamePaused = false;
    this.ctx.setAutoRide(false);
    const tod = TOD[settings.timeOfDay] || TOD.dusk;
    sky.setTime(tod.time);
    sky.dayLength = tod.day;

    this._showSystems(true);
    this.fish.reset();
    this.stunts.reset();
    this.events.gulls.stop();
    this.fish.targetSpots = mode === 'fish' ? 5 : 3;
    this.fish.setVisible(mode === 'fish' || mode === 'free');
    this.trial.setVisible(mode === 'race');

    if (mode === 'race') {
      const s = this.layout.start;
      this.ctx.resetPlayer(s.x, s.z, s.yaw);
    } else {
      this.ctx.resetPlayer(SPAWN.x, SPAWN.z, -0.6);
    }
    rig.setMode('chase');
    this.ui.hide();
    this.ui.setMode(mode);
    this.ui.banner('3', MODES[mode].name, 0, 'count');
    this.audio?.beep?.(0);
  }

  restart() { if (this.gameplay) this.start(this.mode); else this.startSightseeing(); }

  pause() {
    if (this.phase === 'paused' || this.phase === 'menu' || this.phase === 'results') return;
    this._prevPhase = this.phase;
    this.phase = 'paused';
    this.ctx.state.gamePaused = true;
    this.ui.show('pause');
  }

  resume() {
    if (this.phase !== 'paused') return;
    this.phase = this._prevPhase || 'playing';
    this.ctx.state.gamePaused = false;
    this.ui.hide();
  }

  _teardownRun() {
    this.ctx.setMenuFraming?.(false);
    this.trial.stop();
    this.events.gulls.stop();
    this.ctx.pelican.setPouchFill?.(0);
    this.ctx.player.crash = 0;
  }

  _showSystems(on) {
    this.stunts.setEnabled(on);
    this.fish.setVisible(on && (this.mode === 'fish' || this.mode === 'free'));
    this.trial.setVisible(on && this.mode === 'race');
    this.events.fireflies.collectEnabled = on;
  }

  finish(kind = 'time') {
    if (this.phase === 'results') return;
    this.phase = 'results';
    const cash = this.stunts.cashOut();
    if (cash) this.score += cash;
    this.ctx.setAutoRide(true);
    this.events.gulls.stop();

    const m = MODES[this.mode];
    const s = this.stats;
    let d;
    if (this.mode === 'race') {
      const total = this.trial.time;
      const record = records.submit('race', Math.round(total * 100) / 100, true);
      const best = Math.min(...this.trial.lapTimes);
      d = {
        kicker: m.name, title: '完赛！', big: fmtTime(total), record,
        rows: [
          ...this.trial.lapTimes.map((t, i) => [`第 ${i + 1} 圈`, fmtTime(t), t === best ? 'hl' : '']),
          ['历史最佳圈', fmtTime(this.trial.bestLap)],
          ['摔车', `${s.crashes} 次`],
        ],
      };
    } else {
      const record = m.record ? records.submit(m.record, this.score) : false;
      const rows = [];
      if (this.mode === 'fish') {
        rows.push(['接到的鱼', `${s.caught} 条`], ['送达', `${s.delivered} 条 / ${s.deliveries} 趟`], ['单趟最多', `${s.bestDelivery} 条`], ['被海鸥叼走', `${s.stolen} 条`]);
      } else {
        rows.push(['完成特技', `${this.stunts.tricks} 个`], ['最长连击', `×${this.stunts.best}`], ['摔车', `${s.crashes} 次`]);
      }
      if (s.fireflies) rows.push(['萤火虫', `${s.fireflies} 只`]);
      if (s.missions) rows.push(['拍照任务', `${s.missions} 个`]);
      rows.push(['历史最高', `${records.get(m.record) ?? this.score} 分`]);
      d = { kicker: m.name, title: kind === 'time' ? '时间到！' : '结束', big: `${this.score.toLocaleString('zh-CN')}<small>分</small>`, record, rows };
    }
    this.audio?.fanfare?.();
    this.ui.banner(d.title, '', 1200, 'big');
    setTimeout(() => { if (this.phase === 'results') this.ui.show('results', d); }, 1100);
  }

  /* ================================================================ *
   * 菜单动作
   * ================================================================ */
  menuAction(a, arg) {
    const photos = this.photos;
    switch (a) {
      case 'sightseeing': this.startSightseeing(); break;
      case 'modes': this.ui.show('modes', {}, this.ui.screen === 'main'); break;
      case 'start': this.start(arg); break;
      case 'tod': settings.timeOfDay = arg; saveSettings(); this.ui.show('modes', {}, false); this.ui._stack = [['main', {}]]; break;
      case 'album': case 'missions': case 'settings': case 'help': this.ui.show(a, {}, true); break;
      case 'back': if (!this.ui.back()) this._escFallback(); break;
      case 'resume': this.resume(); break;
      case 'restart': this.ctx.state.gamePaused = false; this.restart(); break;
      case 'quit': this.openMenu(); break;
      case 'photo': this.ui.show('photo', { id: arg }, true); break;
      case 'download': {
        const p = photos.album.find((x) => x.id === arg);
        if (p) { const el = document.createElement('a'); el.href = p.img; el.download = `pelican-${p.id}.jpg`; el.click(); }
        break;
      }
      case 'delphoto': photos.removeFromAlbum(arg); this.ui.back(); this.ui.show('album', {}, false); this._fixStackAfterAlbum(); break;
      case 'wipe':
        if (window.confirm('清除所有存档（最高分、幽灵车、相册、任务进度）？')) {
          ['best.fish', 'best.race', 'best.stunt', 'ghost', 'album', 'missions'].forEach(remove);
          this.trial.best = null; this.trial.ghost.setRecording(null);
          photos.album = []; photos.done.clear();
          this.ctx.toast('存档已清除');
        }
        break;
      default: break;
    }
  }

  _fixStackAfterAlbum() {
    this.ui._stack = [[this.phase === 'paused' ? 'pause' : 'main', {}]];
  }

  _escFallback() {
    if (this.phase === 'paused') this.ui.show('pause');
    else if (this.phase === 'menu') this.ui.show('main');
    else if (this.phase === 'results') this.ui.hide();
    else this.ui.hide();
  }

  setSetting(k, v) {
    if (k === 'quality') { this.ctx.applyQuality(v, true); return; }
    settings[k] = v;
    saveSettings();
    if (k === 'volume') this.audio?.setVolume?.(v);
    if (k === 'wind') this.events.wind.enabled = v;
    if (k === 'touch') this.applyTouchSetting();
    if (k === 'physics') this.ctx.setPhysicsMode?.(v);
  }

  applyTouchSetting() {
    const coarse = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    const on = settings.touch === 'on' || (settings.touch === 'auto' && coarse);
    document.body.classList.toggle('touch-on', on);
  }

  /** Esc：菜单里 = 返回；局内 = 暂停 */
  handleEsc() {
    if (this.ui.isOpen) {
      if (this.ui.screen === 'pause') this.resume();
      else if (this.ui.screen === 'main' || this.ui.screen === 'results') { /* 主菜单 / 结算页不响应 */ }
      else if (!this.ui.back()) this._escFallback();
      return;
    }
    if (this.phase === 'playing' || this.phase === 'countdown') this.pause();
  }

  /* ================================================================ *
   * 输入事件（main.js 每帧先交给这里过滤）
   * ================================================================ */
  handleEvents(e) {
    if (e.pause) this.handleEsc();
    const blocked = this.ui.isOpen;
    if (blocked) {
      e.photo = false; e.bell = false; e.reset = false; e.camera = 0; e.jump = false;
      return e;
    }
    if (e.bell && this.gameplay && this.phase === 'playing') {
      const p = this.ctx.player;
      if (p.airborne) p.airBell = (p.airBell || 0) + 1;
      if (this.events.gulls.near(p)) {
        if (this.events.gulls.scare()) {
          this.score += 50;
          this.stats.scared++;
          this._popAtPlayer('+50 吓跑海鸥', 'good');
        }
      }
    }
    if (e.reset && this.gameplay) {
      e.reset = false;
      if (this.phase !== 'playing') return e;
      if (this.mode === 'race' && this.trial.state === 'running') {
        const prev = this.layout.checkpoints[(this.trial.next + this.layout.checkpoints.length - 1) % this.layout.checkpoints.length];
        const nx = this.layout.checkpoints[this.trial.next];
        const yaw = Math.atan2(nx.x - prev.x, nx.z - prev.z);
        this.ctx.resetPlayer(prev.x + Math.sin(yaw) * 5, prev.z + Math.cos(yaw) * 5, yaw);
        this.ctx.toast('回到上一个检查点');
      } else {
        this.ctx.resetPlayer(SPAWN.x, SPAWN.z, -0.6);
        this.ctx.toast('回到出生点');
      }
    }
    return e;
  }

  /* ================================================================ *
   * 拍照
   * ================================================================ */
  onPhoto(canvas) {
    const { camera, sky, player, env } = this.ctx;
    const done = this.photos.check({
      camera, skyTime: sky.time, night: this.events.night, landmarks: this.landmarks, env,
      fish: this.fish.enabled ? this.fish : null, fireflies: this.events.fireflies, gulls: this.events.gulls,
      ghost: this.mode === 'race' ? this.trial.ghost : null, player, mode: this.mode,
    });
    const img = this.photos.snapshot(canvas);
    const title = done.length ? done.map((m) => m.title).join(' · ') : '随手拍';
    this.photos.addToAlbum(img, { title, clock: sky.timeLabel, missions: done.map((m) => m.id) });
    if (done.length) {
      const reward = done.reduce((s, m) => s + m.reward, 0);
      if (this.gameplay && this.phase === 'playing') {
        this.score += reward;
        this.stats.missions += done.length;
      }
      this.ui.banner('任务完成', `${title}  +${reward}`, 2200, 'mission', done[0].id);
      this.audio?.mission?.();
    } else if (this.gameplay) {
      this.ctx.toast('已存入相册');
    }
    return done;
  }

  /* ================================================================ *
   * 每帧
   * ================================================================ */
  update(dt, frozen) {
    const { player, sky, camera, pelican } = this.ctx;
    pelican.beakLower.updateWorldMatrix(true, false);
    this.beakAnchor.getWorldPosition(this.beakTip);

    // 世界层（任何模式都跑）：车灯、萤火虫、灯塔光束
    if (!frozen) {
      this.particles.update(dt);
      const ev = this.events.update(dt, { stars: sky.state.stars, time: performance.now() * 0.001, player, gameplay: this.gameplay && this.phase === 'playing' });
      this.landmarks.update(dt, { night: this.events.night, playerPos: player.pos, carrying: this.fish.carrying, showZones: this.fish.enabled });
      if (this.gameplay && this.phase === 'playing') this._updatePlaying(dt, ev);
      else if (this.phase === 'countdown') this._updateCountdown(dt);
      const evr = this.trial.update(dt, player, this.phase === 'playing' && this.mode === 'race');
      if (evr) this._onRaceEvent(evr);
    }

    pelican.setPouchFill?.(this.gameplay ? this.fish.fill : 0, !this.gameplay);

    if (this.gameplay) this._updateHUD(dt);
  }

  _updateCountdown(dt) {
    this.countdown -= dt;
    const n = Math.ceil(this.countdown);
    if (n !== this._lastCount) {
      this._lastCount = n;
      if (n > 0) { this.ui.banner(String(n), MODES[this.mode].name, 0, 'count'); this.audio?.beep?.(0); }
    }
    if (this.countdown <= 0) {
      this.phase = 'playing';
      this.ui.banner('出发！', this.mode === 'race' ? '先穿过起点光环开始计圈' : this.mode === 'fish' ? '找到水面上发光的涟漪' : '', 1200, 'go');
      this.audio?.beep?.(1);
      if (this.mode === 'race') this.trial.start();
    }
  }

  _updatePlaying(dt, ev) {
    const { player } = this.ctx;
    this.elapsed += dt;

    // ---- 计时 ----
    if (MODES[this.mode].duration) {
      const before = this.timeLeft;
      this.timeLeft = Math.max(0, this.timeLeft - dt);
      if (before > 10 && this.timeLeft <= 10) this.ui.banner('最后 10 秒', '', 1200, 'warn');
      if (this.timeLeft <= 10 && Math.ceil(before) !== Math.ceil(this.timeLeft) && this.timeLeft > 0) this.audio?.beep?.(0, 0.4);
      if (this.timeLeft <= 0) { this.finish('time'); return; }
    }

    // ---- 捕鱼 ----
    if (this.fish.enabled) {
      this.fish.update(dt, { playerPos: player.pos, beakTip: this.beakTip, wading: player.wading, airborne: player.airborne, speed: player.speed });
      if (this.fish.carrying > 0) {
        for (const z of this.landmarks.zones) {
          if (Math.hypot(player.pos.x - z.x, player.pos.z - z.z) < z.radius + 0.6) { this._deliver(z); break; }
        }
      }
      // 海鸥：喉囊满了必来；装了三条以上有一定概率来
      const g = this.events.gulls;
      if (!g.active && g.cooldown <= 0 && (this.fish.full || (this.fish.carrying >= 3 && Math.random() < dt * 0.05))) {
        if (g.start(player)) this.ui.banner('海鸥来了！', '按 B 摇铃把它们吓跑', 2200, 'warn');
      }
      const stolen = g.update(dt, player, this.beakTip, this.fish.carrying);
      if (stolen) {
        this.fish.carrying = Math.max(0, this.fish.carrying - stolen);
        this.stats.stolen += stolen;
        this._popAtPlayer(`−${stolen} 鱼被叼走了`, 'bad');
        this.audio?.gullCry?.();
      }
    }

    // ---- 特技连击结算 ----
    const cash = this.stunts.update(dt, player.airborne);
    if (cash && this.mode !== 'race') {
      this.score += cash;
      this._popAtPlayer(`连击结算 +${cash}`, 'gold');
      this.audio?.cash?.();
    }

    // ---- 萤火虫 ----
    if (ev.collected.length) {
      for (const p of ev.collected) {
        this.score += 25;
        this.stats.fireflies++;
        this.particles.burst({ x: p.x, y: p.y, z: p.z, count: 16, speed: 1.5, up: 1.5, spread: 0.6, color: [0.75, 1, 0.35], intensity: 3, size: 0.12, life: 0.8, gravity: -0.5 });
      }
      this._popAtPlayer(`+${25 * ev.collected.length} 萤火虫`, 'green');
      this.audio?.firefly?.();
    }
    if (ev.gust) { this.ui.trick('阵风！', 'warn', 900); this.audio?.whoosh?.(1); }
  }

  _onRaceEvent(e) {
    const d = e.delta;
    const dTxt = d == null ? '' : `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}`;
    const el = this.ui.el.delta;
    if (d != null) { el.textContent = dTxt; el.className = `ghud__delta show ${d < 0 ? 'good' : 'bad'}`; clearTimeout(this._dt); this._dt = setTimeout(() => el.classList.remove('show'), 2400); }
    if (e.type === 'start') this.ui.banner('第 1 圈', '计时开始', 1100);
    else if (e.type === 'lap') this.ui.banner(e.isBest ? '最佳圈！' : `第 ${e.lap + 1} 圈`, `上一圈 ${fmtTime(e.lapTime)}${dTxt ? `（${dTxt}）` : ''}`, 1800, e.isBest ? 'gold' : '');
    else if (e.type === 'finish') this.finish('race');
  }

  _onCatch(p) {
    this.stats.caught++;
    this.ctx.pelican.snap?.();
    this.audio?.catchFish?.(this.fish.carrying);
    const s = this._toScreen(p.x, p.y, p.z);
    if (s) this.ui.pop(`+1 鱼  ${this.fish.carrying}/${this.fish.capacity}`, s.x, s.y, 'fish');
    if (this.fish.full) this.ui.trick('喉囊满了 · 去鸟巢或灯塔送鱼', 'warn', 1800);
  }

  _deliver(z) {
    const n = this.fish.carrying;
    if (n <= 0) return;
    const pts = Math.round(n * 100 * (1 + 0.3 * (n - 1)) * z.mult);
    this.score += pts;
    this.fish.carrying = 0;
    this.stats.delivered += n;
    this.stats.deliveries++;
    this.stats.bestDelivery = Math.max(this.stats.bestDelivery, n);
    const at = z.nestTop || { x: z.x, y: z.y + 2, z: z.z };
    this.particles.burst({ x: at.x, y: at.y, z: at.z, count: 70, speed: 5, up: 6, spread: 1.4, color: [1, 0.78, 0.4], intensity: 2.6, size: 0.18, sprite: 1, life: 1.3, gravity: 7 });
    this.particles.burst({ x: at.x, y: at.y, z: at.z, count: 40, speed: 4, up: 5, spread: 1.2, color: [0.5, 1, 0.9], intensity: 2.4, size: 0.15, life: 1.1, gravity: 7 });
    this.ui.banner(`+${pts}`, `${z.name} · 送达 ${n} 条${n > 1 ? `（×${(1 + 0.3 * (n - 1)).toFixed(1)}）` : ''}${z.mult > 1 ? ' · 灯塔加成 ×1.5' : ''}`, 1700, 'gold');
    this.audio?.deliver?.(n);
    this.ctx.pelican.snap?.();
  }

  _toScreen(x, y, z) {
    _proj.set(x, y, z).project(this.ctx.camera);
    if (_proj.z > 1) return null;
    return { x: (_proj.x * 0.5 + 0.5) * window.innerWidth, y: (-_proj.y * 0.5 + 0.5) * window.innerHeight };
  }

  _popAtPlayer(text, cls) {
    const p = this.ctx.player.pos;
    const s = this._toScreen(p.x, p.y + 2.2, p.z) || { x: window.innerWidth / 2, y: window.innerHeight * 0.4 };
    this.ui.pop(text, s.x, s.y, cls);
  }

  /* ================================================================ *
   * HUD 数据
   * ================================================================ */
  _updateHUD(dt) {
    // HUD 数据 10Hz 组装一次就够了（ui.update 本身也是 10Hz），避免每帧拼字符串
    this._hudAcc = (this._hudAcc || 0) + dt;
    if (this._hudAcc < 0.1) return;
    dt = this._hudAcc;
    this._hudAcc = 0;
    const h = this._hud;
    const { player } = this.ctx;
    const m = MODES[this.mode];
    h.score = this.score;
    if (this.mode === 'race') {
      h.timer = fmtTime(this.trial.state === 'idle' ? 0 : this.trial.lapStart < 0 ? this.trial.time : this.trial.lapTime);
      const lap = Math.min(this.trial.laps, this.trial.lap + 1);
      h.sub = this.trial.state === 'idle' ? '准备' : this.trial.lapStart < 0 ? '前往起点光环' : `第 ${lap}/${this.trial.laps} 圈 · 检查点 ${this.trial.next === 0 ? 10 : this.trial.next}/10 · 总 ${fmtTime(this.trial.time, false)}`;
      h.bestLabel = `最佳圈 ${fmtTime(this.trial.bestLap)}`;
      h.timerWarn = false;
    } else if (m.duration) {
      h.timer = fmtTime(this.phase === 'countdown' ? m.duration : this.timeLeft, false);
      h.timerWarn = this.timeLeft < 10.5 && this.phase === 'playing';
      h.sub = sub(this);
      const r = records.get(m.record);
      h.bestLabel = r != null ? `最高 ${r.toLocaleString('zh-CN')}` : '最高 —';
    } else {
      h.timer = fmtTime(this.elapsed || 0, false);
      h.timerWarn = false;
      h.sub = `${this.ctx.sky.timeLabel} · 任务 ${this.photos.progress.done}/${this.photos.progress.total}`;
      h.bestLabel = '';
    }
    h.pouch = this.fish.enabled ? this.fish.carrying : null;
    h.pouchCap = this.fish.capacity;

    const c = this._combo;
    c.n = this.stunts.combo; c.mult = this.stunts.multiplier; c.t = Math.max(0, this.stunts.comboTimer / this.stunts.comboWindow); c.bank = this.stunts.bank;
    h.combo = this.mode === 'race' ? null : c;

    h.compass = this._computeCompass(player);
    h.wind = this.events.wind.strength;
    h.windRel = this.events.wind.dir - player.yaw;
    h.missions = this.photos.active(this.ui.compact ? 1 : 2);

    const mp = this._map;
    mp.yaw = player.yaw;
    mp.carrying = this.fish.carrying;
    mp.nextRing = this.mode === 'race' && this.trial.state === 'running' ? this.trial.next : -1;
    mp.rings = this.mode === 'race' ? this.layout.checkpoints : null;
    mp.spots = this.fish.enabled ? this.fish.spots : null;
    mp.zones = this.fish.enabled ? this.landmarks.zones : null;
    mp.ghost = this.mode === 'race' && this.trial.ghost.mesh.visible ? this.trial.ghost.position : null;
    this.ui.update(dt, h);

    function sub(g) {
      if (g.mode === 'fish') return `喉囊 ${g.fish.carrying}/${g.fish.capacity} · 送达 ${g.stats.delivered} 条`;
      if (g.mode === 'stunt') return `特技 ${g.stunts.tricks} · 最长连击 ×${g.stunts.best}`;
      return '';
    }
  }

  _computeCompass(player) {
    let tx = null, tz = 0, label = '', kind = '';
    if (this.mode === 'race' && this.trial.state === 'running') {
      const t = this.trial.nextTarget();
      if (t) { tx = t.x; tz = t.z; label = this.trial.next === 0 ? '起点' : `检查点 ${this.trial.next}`; kind = 'ring'; }
    } else if (this.fish.enabled && this.fish.carrying > 0) {
      let bd = Infinity;
      for (const z of this.landmarks.zones) {
        const d = Math.hypot(z.x - player.pos.x, z.z - player.pos.z);
        if (d < bd) { bd = d; tx = z.x; tz = z.z; label = z.name; kind = z.kind; }
      }
    } else if (this.fish.enabled) {
      const s = this.fish.nearestSpot(player.pos.x, player.pos.z);
      if (s) { tx = s.x; tz = s.z; label = '鱼群'; kind = 'fish'; }
    } else if (this.mode === 'stunt' || this.mode === 'free') {
      const r = this.stunts.nearestRamp(player.pos.x, player.pos.z);
      if (r) { tx = r.x0; tz = r.z0; label = '跳台'; kind = 'ramp'; }
    }
    if (tx == null) return null;
    const c = this._compass;
    let rel = Math.atan2(tx - player.pos.x, tz - player.pos.z) - player.yaw;
    c.rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    c.dist = Math.hypot(tx - player.pos.x, tz - player.pos.z);
    c.label = label; c.kind = kind;
    return c;
  }

  dispose() {
    this.particles.dispose(); this.landmarks.dispose(); this.fish.dispose();
    this.trial.dispose(); this.stunts.dispose(); this.events.dispose();
    this.beakAnchor.removeFromParent();
  }
}
