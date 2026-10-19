/**
 * input.js —— 输入聚合
 *
 * 把键盘、鼠标、触摸、屏幕按钮统一成一份「意图」状态。
 * 控制器只读这份状态，不关心输入来自哪里 —— 于是桌面键盘、
 * 手机虚拟摇杆 / 按键可以共用同一套骑行逻辑。
 *
 * 转向用「累积量」而非「按下即转」：按键期间目标转角平滑增长，
 * 松开后回正，这样点按也能做出轻微的画龙，而不是非零即满。
 * 触屏摇杆是模拟量，直接给目标值（同样经过平滑）。
 */

const EVENT_KEYS = ['camera', 'bell', 'photo', 'audio', 'gui', 'hideUI', 'reset', 'jump', 'pause', 'debug'];

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
    this.events = { camera: 0, bell: false, photo: false, audio: false, gui: false, hideUI: false, reset: false, jump: false, pause: false, debug: false };
    this._out = { ...this.events };

    /** 触屏摇杆的模拟量 */
    this.analog = { active: false, x: 0, y: 0 };

    this.keys = new Set();
    this._teardowns = [];
    this.pointerDelta = { x: 0, y: 0 };
    this._delta = { x: 0, y: 0 };
    this._heldButtons = new Map();

    this.onFirstInteraction = opts.onFirstInteraction || (() => {});
    this.onAnyGesture = opts.onAnyGesture || (() => {});
    this._interacted = false;

    this._bindKeyboard();
    this._bindPointer();
    if (opts.buttons) this._bindButtons(opts.buttons);
    if (opts.touchRoot) this._bindTouch(opts.touchRoot);
  }

  _on(target, type, fn, opt) {
    target.addEventListener(type, fn, opt);
    this._teardowns.push(() => target.removeEventListener(type, fn, opt));
  }

  _firstInteraction() {
    this.onAnyGesture();
    if (this._interacted) return;
    this._interacted = true;
    this.onFirstInteraction();
  }

  _bindKeyboard() {
    const isTyping = (e) => {
      const t = e.target;
      return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    };
    const down = (e) => {
      // 不要拦截浏览器快捷键；也不要在调参面板 / 设置的输入框里打字时触发游戏按键
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e)) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') { this.events.pause = true; return; }
      // F3：碰撞体线框（拦下浏览器的「查找」）
      if (k === 'f3') { e.preventDefault(); if (!e.repeat) this.events.debug = true; return; }
      // 菜单按钮获得焦点时，空格 / 回车交给按钮本身
      const onButton = e.target && e.target.tagName === 'BUTTON';
      if (onButton && (k === ' ' || k === 'enter')) return;
      if (k === ' ' || k.startsWith('arrow')) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(k);
      this._firstInteraction();

      switch (k) {
        case ' ': this.events.jump = true; break;
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
    const up = (e) => { this.keys.delete(e.key.toLowerCase()); };
    // 失焦时清空按键，否则切窗口回来会发现鸟一直在踩踏板
    const blur = () => { this.keys.clear(); this._heldButtons.clear(); this._resetStick?.(); };

    this._on(window, 'keydown', down, { passive: false });
    this._on(window, 'keyup', up);
    this._on(window, 'blur', blur);
  }

  _bindPointer() {
    const el = this.canvas;
    // 用 pointerId 区分多指：只有「第一根手指 / 鼠标」能拖视角，
    // 双指缩放时不应该同时把视角转飞（原实现里两根手指都会累加位移）。
    let dragId = null;
    let lastX = 0, lastY = 0;
    let pointers = 0;

    const onDown = (e) => {
      pointers++;
      this._firstInteraction();
      if (dragId !== null || pointers > 1) { dragId = null; return; }
      dragId = e.pointerId;
      lastX = e.clientX; lastY = e.clientY;
    };
    const onMove = (e) => {
      if (e.pointerId !== dragId) return;
      this.pointerDelta.x += e.clientX - lastX;
      this.pointerDelta.y += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
    };
    const onUp = (e) => {
      pointers = Math.max(0, pointers - 1);
      if (e.pointerId === dragId) dragId = null;
    };

    this._on(el, 'pointerdown', onDown);
    this._on(window, 'pointermove', onMove);
    this._on(window, 'pointerup', onUp);
    this._on(window, 'pointercancel', onUp);
  }

  /** 屏幕按钮：按住生效 */
  _bindButtons(buttons) {
    const held = this._heldButtons;
    const press = (act) => {
      held.set(act, true);
      this._firstInteraction();
      if (act === 'jump') this.events.jump = true;
      if (act === 'camera') this.events.camera = (this._camCycle = ((this._camCycle || 0) % 4) + 1);
      if (act === 'bell') this.events.bell = true;
      if (act === 'photo') this.events.photo = true;
      if (act === 'audio') this.events.audio = true;
      if (act === 'gui') this.events.gui = true;
      if (act === 'pause') this.events.pause = true;
      if (act === 'auto') this.toggleAuto?.();
    };
    const release = (act) => held.delete(act);

    buttons.forEach((btn) => {
      const act = btn.dataset.act || btn.dataset.touch;
      this._on(btn, 'pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); btn.classList.add('down'); press(act); });
      const rel = () => { btn.classList.remove('down'); release(act); };
      this._on(btn, 'pointerup', rel);
      this._on(btn, 'pointerleave', rel);
      this._on(btn, 'pointercancel', rel);
      // 键盘 / 无障碍点击（菜单按钮获得焦点后按回车）
      this._on(btn, 'click', (e) => { if (e.detail === 0) { press(act); release(act); } });
      this._on(btn, 'contextmenu', (e) => e.preventDefault());
    });
  }

  /**
   * 触屏：左侧虚拟摇杆（横向 = 转向，向上推 = 踩踏，向下拉 = 刹车），
   * 右侧按键（跳 / 铃 / 拍 / 刹）。
   */
  _bindTouch(root) {
    const stick = root.querySelector('#stick');
    const knob = root.querySelector('#stick-knob');
    const btns = Array.from(root.querySelectorAll('[data-touch]'));
    this._bindButtons(btns);
    if (!stick) return;
    let id = null, cx = 0, cy = 0;
    const R = 46;
    const set = (x, y) => {
      const dx = x - cx, dy = y - cy;
      const len = Math.hypot(dx, dy);
      const k = len > R ? R / len : 1;
      const kx = dx * k, ky = dy * k;
      knob.style.transform = `translate(${kx}px, ${ky}px)`;
      this.analog.x = kx / R;
      this.analog.y = -ky / R;
    };
    this._resetStick = () => {
      id = null;
      this.analog.active = false; this.analog.x = 0; this.analog.y = 0;
      knob.style.transform = '';
      stick.classList.remove('live');
    };
    this._on(stick, 'pointerdown', (e) => {
      e.preventDefault();
      this._firstInteraction();
      id = e.pointerId;
      stick.setPointerCapture?.(id);
      const r = stick.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      this.analog.active = true;
      stick.classList.add('live');
      set(e.clientX, e.clientY);
    });
    this._on(stick, 'pointermove', (e) => { if (e.pointerId === id) set(e.clientX, e.clientY); });
    const end = (e) => { if (e.pointerId === id) this._resetStick(); };
    this._on(stick, 'pointerup', end);
    this._on(stick, 'pointercancel', end);
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
    const held = this._heldButtons;
    const a = this.analog;

    // ---- 油门 / 刹车 ----
    const up = k.has('w') || k.has('arrowup') || held.has('throttle');
    const down = k.has('s') || k.has('arrowdown') || held.has('brake');
    let target = up ? 1 : 0;
    let brakeT = down ? 1 : 0;
    if (a.active) {
      target = Math.max(target, Math.max(0, (a.y + 0.15) / 0.85));   // 摇杆几乎居中也给一点踩踏，方便单指操作
      brakeT = Math.max(brakeT, Math.max(0, (-a.y - 0.35) / 0.65));
    }
    // 踩踏有惯性：从 0 到满力约需 0.35 秒，松脚后自然回落
    const rate = target > this.state.throttle ? 3.0 : 4.5;
    this.state.throttle += (target - this.state.throttle) * Math.min(1, dt * rate);
    this.state.brake += (brakeT - this.state.brake) * Math.min(1, dt * 6.0);

    // ---- 转向：按键 → 目标值，松开回正 ----
    const left = k.has('a') || k.has('arrowleft') || held.has('left');
    const right = k.has('d') || k.has('arrowright') || held.has('right');
    let steerTarget = 0;
    if (left) steerTarget -= 1;
    if (right) steerTarget += 1;
    if (a.active && Math.abs(a.x) > 0.08) steerTarget = Math.max(-1, Math.min(1, steerTarget + a.x * 1.15));
    this.state.steer += (steerTarget - this.state.steer) * Math.min(1, dt * 4.2);
    this.state.steer = Math.max(-1, Math.min(1, this.state.steer));

    this.state.jump = k.has(' ') || held.has('jump');
    this.state.sprint = k.has('shift');
    // 空中俯仰：W 压头（-1）/ S 抬头（+1）
    this.state.pitch = (k.has('s') || k.has('arrowdown') ? 1 : 0) - (k.has('w') || k.has('arrowup') ? 1 : 0)
      + (a.active ? -a.y : 0);

    return this.state;
  }

  /** 取走并清空一次性事件（复用同一个输出对象，不产生垃圾） */
  consumeEvents() {
    const e = this.events, o = this._out;
    for (const key of EVENT_KEYS) {
      o[key] = e[key];
      e[key] = key === 'camera' ? 0 : false;
    }
    return o;
  }

  /** 取走并清空鼠标拖拽的累积位移 */
  consumePointerDelta() {
    this._delta.x = this.pointerDelta.x;
    this._delta.y = this.pointerDelta.y;
    this.pointerDelta.x = 0;
    this.pointerDelta.y = 0;
    return this._delta;
  }

  dispose() {
    this._teardowns.forEach((f) => f());
    this._teardowns.length = 0;
  }
}
