/**
 * input.js —— 输入聚合
 *
 * 把键盘、鼠标、触摸、屏幕按钮统一成一份「意图」状态。
 * 控制器只读这份状态，不关心输入来自哪里 —— 于是桌面键盘、
 * 手机虚拟按钮、以及未来的游戏手柄可以共用同一套骑行逻辑。
 *
 * 转向用「累积量」而非「按下即转」：按键期间目标转角平滑增长，
 * 松开后回正，这样点按也能做出轻微的画龙，而不是非零即满。
 */

export class Input {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.enabled = true;

    /** 归一化的输入意图 */
    this.state = {
      throttle: 0,     // 0..1 踩踏力度
      brake: 0,        // 0..1 刹车
      steer: 0,        // -1..1 目标转向
      jump: false,
      sprint: false,
    };

    /** 一次性事件：被 consume 后清空 */
    this.events = {
      camera: 0,
      bell: false,
      photo: false,
      audio: false,
      gui: false,
      hideUI: false,
      reset: false,
    };

    this.keys = new Set();
    this._bindKeyboard();
    this._bindPointer();
    if (opts.buttons) this._bindButtons(opts.buttons);

    this.onFirstInteraction = opts.onFirstInteraction || (() => {});
    this._interacted = false;
  }

  _firstInteraction() {
    if (this._interacted) return;
    this._interacted = true;
    this.onFirstInteraction();
  }

  _bindKeyboard() {
    const down = (e) => {
      if (e.repeat) return;
      // 不要拦截浏览器快捷键
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const k = e.key.toLowerCase();
      this.keys.add(k);
      this._firstInteraction();

      switch (k) {
        case ' ': e.preventDefault(); this.events.jump = true; break;
        case '1': this.events.camera = 1; break;
        case '2': this.events.camera = 2; break;
        case '3': this.events.camera = 3; break;
        case '4': this.events.camera = 4; break;
        case 'b': this.events.bell = true; break;
        case 'p': this.events.photo = true; break;
        case 'm': this.events.audio = true; break;
        case 'h': this.events.hideUI = true; break;
        case 'r': this.events.reset = true; break;
        case 'g': this.events.gui = true; break;
        default: break;
      }
    };
    const up = (e) => {
      this.keys.delete(e.key.toLowerCase());
    };
    // 失焦时清空按键，否则切窗口回来会发现鸟一直在踩踏板
    const blur = () => this.keys.clear();

    window.addEventListener('keydown', down, { passive: false });
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    this._teardown = () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }

  _bindPointer() {
    const el = this.canvas;
    let dragging = false;
    let lastX = 0, lastY = 0;

    const onDown = (e) => {
      dragging = true;
      lastX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
      lastY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
      this._firstInteraction();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const x = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
      const y = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
      this.pointerDelta = this.pointerDelta || { x: 0, y: 0 };
      this.pointerDelta.x += x - lastX;
      this.pointerDelta.y += y - lastY;
      lastX = x; lastY = y;
    };
    const onUp = () => { dragging = false; };

    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    el.addEventListener('touchstart', onDown, { passive: true });
    this._teardownPointer = () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      el.removeEventListener('touchstart', onDown);
    };
  }

  /** 屏幕按钮：按住生效 */
  _bindButtons(buttons) {
    const held = new Map();
    const press = (act) => {
      held.set(act, true);
      this._firstInteraction();
      if (act === 'jump') this.events.jump = true;
      if (act === 'camera') this.events.camera = (this._camCycle = ((this._camCycle || 0) % 4) + 1);
      if (act === 'bell') this.events.bell = true;
      if (act === 'photo') this.events.photo = true;
      if (act === 'audio') this.events.audio = true;
      if (act === 'gui') this.events.gui = true;
      if (act === 'auto') this.toggleAuto?.();
    };
    const release = (act) => held.delete(act);

    buttons.forEach((btn) => {
      const act = btn.dataset.act;
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); press(act); });
      btn.addEventListener('pointerup', () => release(act));
      btn.addEventListener('pointerleave', () => release(act));
      btn.addEventListener('pointercancel', () => release(act));
    });
    this._heldButtons = held;
  }

  /** 每帧把原始输入折算成意图 */
  update(dt) {
    if (!this.enabled) {
      this.state.throttle = 0;
      this.state.brake = 0;
      this.state.steer = 0;
      this.state.jump = false;
      this.state.sprint = false;
      return this.state;
    }

    const k = this.keys;
    const held = this._heldButtons || new Map();

    // ---- 油门 / 刹车 ----
    const up = k.has('w') || k.has('arrowup') || held.has('throttle');
    const down = k.has('s') || k.has('arrowdown') || held.has('brake');
    const target = up ? 1 : 0;
    // 踩踏有惯性：从 0 到满力约需 0.35 秒，松脚后自然回落
    const rate = up ? 3.0 : 4.5;
    this.state.throttle += (target - this.state.throttle) * Math.min(1, dt * rate);
    this.state.brake += ((down ? 1 : 0) - this.state.brake) * Math.min(1, dt * 6.0);

    // ---- 转向：按键 → 目标值，松开回正 ----
    const left = k.has('a') || k.has('arrowleft') || held.has('left');
    const right = k.has('d') || k.has('arrowright') || held.has('right');
    let steerTarget = 0;
    if (left) steerTarget -= 1;
    if (right) steerTarget += 1;
    // 高速时转向更迟钝（速度越快，同样打把产生的侧向加速度越大）
    const agility = 1;
    this.state.steer += (steerTarget - this.state.steer) * Math.min(1, dt * 4.2 * agility);
    this.state.steer = Math.max(-1, Math.min(1, this.state.steer));

    this.state.jump = k.has(' ') || held.has('jump');
    this.state.sprint = k.has('shift');

    return this.state;
  }

  /** 取走并清空一次性事件 */
  consumeEvents() {
    const e = this.events;
    const out = { ...e };
    e.camera = 0;
    e.bell = false;
    e.photo = false;
    e.audio = false;
    e.gui = false;
    e.hideUI = false;
    e.reset = false;
    return out;
  }

  /** 取走并清空鼠标拖拽的累积位移 */
  consumePointerDelta() {
    const d = this.pointerDelta || { x: 0, y: 0 };
    this.pointerDelta = { x: 0, y: 0 };
    return d;
  }

  dispose() {
    this._teardown?.();
    this._teardownPointer?.();
  }
}
