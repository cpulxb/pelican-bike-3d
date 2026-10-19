/**
 * audio.js —— 程序化音效（Web Audio）
 *
 * 场景里同样没有音频文件：链条声、风声、车铃、海鸥叫
 * 全部用振荡器与噪声在运行时合成。
 *
 * 这样做的好处不只是「零资源」——合成音可以**连续跟随游戏状态**：
 * 车速快，风声的滤波截止频率就高、链条的咔哒就密；
 * 这是循环播放的采样音做不到的。
 *
 * 浏览器要求音频必须由用户手势启动，所以 AudioContext 在首次交互时才创建。
 */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this.master = null;
    this.nodes = {};
    this._lastTick = 0;
    this._lastGull = 0;
    this._nextGull = 8;      // 下一声海鸥的间隔（预先掷好，不能每帧重掷）
    this.volume = 0.8;
  }

  /** 主音量（0..1），与开关独立 */
  get _masterLevel() { return this.enabled ? 0.55 * (this.volume ?? 1) / 0.8 : 0; }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.ready) this.master.gain.setTargetAtTime(this._masterLevel, this.ctx.currentTime, 0.15);
  }

  /** 浏览器可能把 AudioContext 挂起（自动播放策略 / 切后台），任何用户手势都尝试恢复 */
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  /** 必须在用户手势里调用 */
  init() {
    if (this.ctx) { this.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }

    this.ctx = new AC();
    const ctx = this.ctx;

    // ---- 主输出：总线 → 轻压缩 → 目的地 ----
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 22;
    comp.ratio.value = 3.2;
    comp.attack.value = 0.006;
    comp.release.value = 0.22;
    comp.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = 0.0;      // 淡入
    master.connect(comp);
    this.master = master;
    this.comp = comp;

    /* ============ 1. 风声：粉噪声 → 带通，中心频率随速度上升 ============ */
    const noiseBuf = this._makeNoiseBuffer(4.0);
    const wind = ctx.createBufferSource();
    wind.buffer = noiseBuf;
    wind.loop = true;

    const windBP = ctx.createBiquadFilter();
    windBP.type = 'bandpass';
    windBP.frequency.value = 380;
    windBP.Q.value = 0.85;

    const windHP = ctx.createBiquadFilter();
    windHP.type = 'highpass';
    windHP.frequency.value = 160;

    const windGain = ctx.createGain();
    windGain.gain.value = 0.0;

    wind.connect(windBP).connect(windHP).connect(windGain).connect(master);
    wind.start();

    // 第二层：高频「咻」声，只在高速时出现
    const wind2 = ctx.createBufferSource();
    wind2.buffer = noiseBuf;
    wind2.loop = true;
    wind2.playbackRate.value = 1.6;
    const wind2BP = ctx.createBiquadFilter();
    wind2BP.type = 'bandpass';
    wind2BP.frequency.value = 1800;
    wind2BP.Q.value = 1.4;
    const wind2Gain = ctx.createGain();
    wind2Gain.gain.value = 0;
    wind2.connect(wind2BP).connect(wind2Gain).connect(master);
    wind2.start();

    this.nodes.wind = { bp: windBP, gain: windGain };
    this.nodes.wind2 = { bp: wind2BP, gain: wind2Gain };

    /* ============ 2. 轮胎滚沙：噪声 → 低通，音量随速度 ============ */
    const roll = ctx.createBufferSource();
    roll.buffer = noiseBuf;
    roll.loop = true;
    roll.playbackRate.value = 0.85;
    const rollLP = ctx.createBiquadFilter();
    rollLP.type = 'lowpass';
    rollLP.frequency.value = 420;
    const rollGain = ctx.createGain();
    rollGain.gain.value = 0;
    roll.connect(rollLP).connect(rollGain).connect(master);
    roll.start();
    this.nodes.roll = { lp: rollLP, gain: rollGain };

    /* ============ 3. 链条咔哒：短促的脉冲序列，由 update 触发 ============ */
    const chainGain = ctx.createGain();
    chainGain.gain.value = 0.5;
    chainGain.connect(master);
    this.nodes.chain = { gain: chainGain };

    /* ============ 4. 海浪：慢速调制的噪声 ============ */
    const surf = ctx.createBufferSource();
    surf.buffer = noiseBuf;
    surf.loop = true;
    surf.playbackRate.value = 0.45;
    const surfLP = ctx.createBiquadFilter();
    surfLP.type = 'lowpass';
    surfLP.frequency.value = 700;
    const surfLFO = ctx.createOscillator();
    surfLFO.frequency.value = 0.11;
    const surfLFOgain = ctx.createGain();
    surfLFOgain.gain.value = 0.55;
    const surfGain = ctx.createGain();
    surfGain.gain.value = 0.055;
    surfLFO.connect(surfLFOgain).connect(surfGain.gain);
    surf.connect(surfLP).connect(surfGain).connect(master);
    surf.start();
    surfLFO.start();
    this.nodes.surf = { gain: surfGain, lfo: surfLFO };

    /* ============ 5. 海鸥叫：两个带调制的锯齿波 ============ */
    const gullBus = ctx.createGain();
    gullBus.gain.value = 0.5;
    gullBus.connect(master);
    this.nodes.gullBus = gullBus;

    this.ready = true;

    // 淡入，避免开局「啪」的一声
    master.gain.setTargetAtTime(this._masterLevel, ctx.currentTime, 0.6);
    this.resume();
  }

  _makeNoiseBuffer(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // 粉噪声：用 Voss-McCartney 式的近似（白噪声 + 一阶积分）
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.0990460;
      b1 = 0.96300 * b1 + white * 0.2965164;
      b2 = 0.57000 * b2 + white * 1.0526913;
      d[i] = (b0 + b1 + b2 + white * 0.1848) * 0.22;
    }
    return buf;
  }

  /* ================================================================ *
   * 车铃
   * ================================================================ */
  ringBell() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // 车铃是两个略微失谐的金属音 + 快速衰减
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 2480 + i * 340;

      const osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.value = osc.frequency.value * 2.76;   // 非谐泛音，才像金属

      const g = ctx.createGain();
      const g2 = ctx.createGain();
      const amp = 0.14 / (i + 1);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75 + i * 0.12);
      g2.gain.setValueAtTime(0, t);
      g2.gain.linearRampToValueAtTime(amp * 0.4, t + 0.003);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);

      osc.connect(g).connect(this.master);
      osc2.connect(g2).connect(this.master);
      osc.start(t + i * 0.055);
      osc.stop(t + 1.2);
      osc2.start(t + i * 0.055);
      osc2.stop(t + 1.2);
    }
  }

  /* ================================================================ *
   * 海鸥
   * ================================================================ */
  gullCry() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const base = 720 + Math.random() * 260;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';

    const formant = ctx.createBiquadFilter();
    formant.type = 'bandpass';
    formant.frequency.value = base * 1.9;
    formant.Q.value = 3.4;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);

    // 两声「嘎—嘎」，第二声更低
    const cry = (start, dur, f0, f1, amp) => {
      osc.frequency.setValueAtTime(f0, start);
      osc.frequency.exponentialRampToValueAtTime(f1, start + dur);
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(amp, start + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    };
    cry(t, 0.34, base, base * 0.62, 0.10);
    cry(t + 0.42, 0.30, base * 0.86, base * 0.52, 0.075);

    osc.connect(formant).connect(g).connect(this.nodes.gullBus);
    osc.start(t);
    osc.stop(t + 0.85);
  }

  /* ================================================================ *
   * 链条咔哒（由控制器按踏频触发）
   * ================================================================ */
  chainTick(strength = 1) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 1400 + Math.random() * 900;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 6;

    const g = ctx.createGain();
    const amp = 0.05 * strength;
    g.gain.setValueAtTime(amp, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);

    osc.connect(bp).connect(g).connect(this.nodes.chain.gain);
    osc.start(t);
    osc.stop(t + 0.05);
  }

  /** 刹车摩擦 */
  brakeSqueal(intensity) {
    if (!this.ready || !this.enabled || intensity < 0.25) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 1900 + Math.random() * 700;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3200;
    bp.Q.value = 8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(0.02 * intensity, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(bp).connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  /* ================================================================ *
   * 每帧：让所有连续音跟随状态
   * ================================================================ */
  update(dt, s) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const smooth = 0.12;

    const speed = s.speed ?? 0;        // m/s
    const cadence = s.cadence ?? 0;    // rpm
    const norm = Math.min(1, speed / 16);

    if (!this.enabled) {
      this.nodes.wind.gain.gain.setTargetAtTime(0, t, smooth);
      this.nodes.wind2.gain.gain.setTargetAtTime(0, t, smooth);
      this.nodes.roll.gain.gain.setTargetAtTime(0, t, smooth);
      return;
    }

    // 风声：中心频率与音量都随速度上升
    this.nodes.wind.bp.frequency.setTargetAtTime(320 + norm * 620, t, smooth);
    this.nodes.wind.gain.gain.setTargetAtTime(0.035 + norm * 0.20, t, smooth);
    this.nodes.wind2.bp.frequency.setTargetAtTime(1500 + norm * 3200, t, smooth);
    this.nodes.wind2.gain.gain.setTargetAtTime(Math.max(0, norm - 0.35) * 0.16, t, smooth);

    // 轮胎滚沙
    this.nodes.roll.lp.frequency.setTargetAtTime(300 + norm * 1500, t, smooth);
    this.nodes.roll.gain.gain.setTargetAtTime(norm * 0.13, t, smooth);

    // 链条：按踏频触发咔哒声
    if (cadence > 4) {
      const interval = 60 / (cadence * 2.2);   // 每圈两次（左右各一次）
      this._lastTick += dt;
      if (this._lastTick >= interval) {
        this._lastTick = 0;
        this.chainTick(0.5 + norm * 0.6);
      }
    } else {
      this._lastTick = 0;
    }

    // 海鸥：随机间隔
    // 原来写成 `> 6 + Math.random() * 12`：每帧重掷随机数，实际间隔几乎总是 ~6 秒。
    this._lastGull += dt;
    if (this._lastGull > this._nextGull) {
      this._lastGull = 0;
      this._nextGull = 6 + Math.random() * 12;
      this.gullCry();
    }
  }

  setEnabled(on) {
    this.enabled = on;
    if (!this.ready) return;
    this.master.gain.setTargetAtTime(this._masterLevel, this.ctx.currentTime, 0.35);
  }

  toggle() {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  /** 拍照时的快门声 */
  shutter() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.06), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      // 指数衰减的白噪声 = 快门
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 6);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2800;
    bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.value = 0.32;
    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
  }

  /* ================================================================ *
   * 游戏音效（全部合成）
   * ================================================================ */

  /** 一个带包络的音符：type 波形，f 频率，dur 时长，amp 音量，at 延迟 */
  _note(f, dur = 0.3, amp = 0.08, type = 'sine', at = 0, glide = 0) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(20, f * glide), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** 噪声爆发（水花 / 落地 / 风） */
  _noise(dur, freq, q, amp, at = 0, type = 'bandpass', sweep = 0) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    if (!this._noiseBuf) this._noiseBuf = this._makeNoiseBuffer(1.5);
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweep) f.frequency.exponentialRampToValueAtTime(freq * sweep, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  /** 接到鱼：五声音阶的拨弦，鱼越多音越高 */
  catchFish(n = 1) {
    const scale = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];
    const f = scale[Math.min(scale.length - 1, Math.max(0, n - 1))];
    this._note(f, 0.28, 0.09, 'triangle');
    this._note(f * 2, 0.18, 0.035, 'sine', 0.01);
    this._note(f * 1.5, 0.22, 0.05, 'triangle', 0.07);
    this._noise(0.12, 900, 0.8, 0.05);
  }

  /** 送达：大三和弦琶音 */
  deliver(n = 1) {
    const base = 392;
    [1, 1.26, 1.5, 2, 2.52].slice(0, 2 + Math.min(3, n)).forEach((r, i) => this._note(base * r, 0.5, 0.07, 'triangle', i * 0.07));
    this._note(base * 4, 0.6, 0.025, 'sine', 0.3);
  }

  splash(s = 1) { this._noise(0.35, 1400, 0.7, 0.05 * s, 0, 'bandpass', 0.35); }

  checkpoint(i = 0) { this._note(880, 0.16, 0.07, 'square', 0, 1.0); this._note(1318.5, 0.25, 0.06, 'triangle', 0.08); }
  lap() { [660, 880, 1100].forEach((f, i) => this._note(f, 0.3, 0.07, 'triangle', i * 0.1)); }
  fanfare() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => this._note(f, i === 5 ? 0.9 : 0.22, 0.07, 'triangle', i * 0.12)); }
  beep(kind = 0, amp = 1) { this._note(kind ? 1046.5 : 659.25, kind ? 0.5 : 0.18, 0.08 * amp, 'square'); }
  trick(combo = 1) { const f = 600 * Math.pow(1.06, Math.min(12, combo)); this._note(f, 0.2, 0.06, 'triangle'); this._note(f * 1.5, 0.3, 0.05, 'triangle', 0.06); }
  cash() { [784, 988, 1175, 1568].forEach((f, i) => this._note(f, 0.18, 0.05, 'square', i * 0.05)); }
  crash() { this._noise(0.5, 300, 0.6, 0.18, 0, 'lowpass', 0.3); this._note(110, 0.4, 0.12, 'sine', 0, 0.5); this._noise(0.25, 2400, 3, 0.04, 0.05); }
  whoosh(s = 1) { this._noise(0.55, 500, 1.2, 0.06 * s, 0, 'bandpass', 3); }
  firefly() { this._note(1760, 0.25, 0.035, 'sine'); this._note(2637, 0.3, 0.025, 'sine', 0.05); }
  mission() { [784, 1046.5, 1318.5, 1568].forEach((f, i) => this._note(f, 0.35, 0.06, 'sine', i * 0.08)); }
  denied() { this._note(220, 0.18, 0.07, 'square', 0, 0.8); this._note(196, 0.22, 0.06, 'square', 0.1, 0.8); }
  uiClick() { this._note(1200, 0.05, 0.03, 'square'); }
}
