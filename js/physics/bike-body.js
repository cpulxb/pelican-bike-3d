/**
 * bike-body.js —— 自行车 + 鹈鹕的刚体与「双轮射线悬挂」
 *
 * 刚体：34 kg（车 16 kg + 鹈鹕与行囊 18 kg 的游戏化取值），转动全部锁死 ——
 *   自行车靠骑手保持平衡，真实的侧倾平衡交给视觉层（main.js 按速度与打把算出侧倾角），
 *   刚体只负责「平动」：动量、坡道、腾空、碰撞、水中的浮力与阻力都是真的。
 *   朝向（yaw）由转向模型每个子步写入刚体：yawRate = steer · turnRate · f(speed)。
 *
 * 碰撞体：车架（横躺的胶囊）+ 骑手（球）+ 两颗车轮球。
 *   车轮球只和岩石 / 石块相撞（与地形、跳台的接触由悬挂射线负责），
 *   所以碾到小石子会被顶一下、撞上大石头会被拦住，石块按动量交换被踢开。
 *
 * 每个车轮的悬挂：
 *   地面 = max(解析地形高度 terrainHeight，跳台射线命中) —— 与可见地形逐点一致
 *   F_簧 = k·(L_rest − d) − c·(v·n)，沿地面法线 n 施加（于是坡道的下滑分力是自然产生的）
 *   k 按「静止时下沉 5 cm」反推：k = m·g_eff / (2·0.05)，阻尼比 ζ ≈ 0.5
 * 轮胎：纵向 = 踏板驱动（功率曲线）/ 刹车 / 滚动阻力，横向 = 消除侧滑所需的力；
 *   两者都被 μ·N 截断（μ 取决于路面材质与涉水深度）—— 过弯太快就会侧滑。
 */
import { BIKE } from '../objects/bike.js';
import { terrainHeight, terrainNormal, WATER_LEVEL } from '../util/noise.js';
import { waveHeight, waveVelocity } from './waves.js';
import { GROUP, groups, GRAVITY, RHO_WATER, MATERIALS, terrainMaterial } from './world.js';

const ALL = 0xffff;

/** 「物理真实度」两档 */
export const REALISM = {
  real:   { label: '真实', gravityScale: 1.0, gripAssist: 1.35, waterDrag: 1.0, crashDv: 4.2, jumpHeight: 0.42, airDrag: 1.0 },
  arcade: { label: '街机', gravityScale: 1.9, gripAssist: 1.9,  waterDrag: 0.45, crashDv: 6.0, jumpHeight: 0.75, airDrag: 0.8 },
};

export class BikeBody {
  constructor(R, pw) {
    this.R = R;
    this.pw = pw;
    this.world = pw.world;
    this.mass = 34;
    this.wheelR = BIKE.wheelRadius;
    this.halfBase = BIKE.wheelbase / 2;
    this.travel = 0.28;            // 悬挂行程（车轮中心到挂点）
    this.sag0 = 0.05;              // 静止下沉量
    this.mountH = this.wheelR + this.travel;
    this.restLen = this.mountH + this.sag0;
    this.mode = REALISM.arcade;

    const bd = R.RigidBodyDesc.dynamic().setTranslation(0, 10, 0).lockRotations()
      .setCanSleep(false).setCcdEnabled(true).setLinearDamping(0).setAngularDamping(0);
    this.body = this.world.createRigidBody(bd);
    const ev = R.ActiveEvents.CONTACT_FORCE_EVENTS;
    const mk = (desc, mass, grp) => {
      desc.setMass(mass).setFriction(0.45).setRestitution(0.1)
        .setCollisionGroups(grp).setActiveEvents(ev).setContactForceEventThreshold(240);
      const c = this.world.createCollider(desc, this.body);
      pw._register(c, 'bike', MATERIALS.rock);
      return c;
    };
    const bikeG = groups(GROUP.BIKE, GROUP.TERRAIN | GROUP.STATIC | GROUP.RAMP | GROUP.DYN);
    const wheelG = groups(GROUP.WHEEL, GROUP.STATIC | GROUP.DYN);
    const s = Math.SQRT1_2;
    this.chassis = mk(R.ColliderDesc.capsule(0.42, 0.27).setTranslation(0, 0.78, 0).setRotation({ x: s, y: 0, z: 0, w: s }), 22, bikeG);
    this.rider = mk(R.ColliderDesc.ball(0.3).setTranslation(0, 1.35, -0.1), 8, bikeG);
    this.wheelF = mk(R.ColliderDesc.ball(this.wheelR).setTranslation(0, this.wheelR, this.halfBase), 2, wheelG);
    this.wheelB = mk(R.ColliderDesc.ball(this.wheelR).setTranslation(0, this.wheelR, -this.halfBase), 2, wheelG);

    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.rampGroups = groups(ALL, GROUP.RAMP);

    // 状态（全部预分配）
    this.pos = { x: 0, y: 0, z: 0 };
    this.prev = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.contacts = 0;
    this.wheel = [
      { z: this.halfBase, hit: false, d: 0, gy: 0, n: { x: 0, y: 1, z: 0 }, load: 0, mat: MATERIALS.sand },
      { z: -this.halfBase, hit: false, d: 0, gy: 0, n: { x: 0, y: 1, z: 0 }, load: 0, mat: MATERIALS.sand },
    ];
    this.groundN = { x: 0, y: 1, z: 0 };
    this.vFwd = 0;
    this.vLat = 0;
    this.slip = 0;
    this.depth = 0;               // 水深（水面 − 车底）
    this.wading = 0;
    this.surface = MATERIALS.sand;
    this.impact = 0;              // 这个子步里收到的碰撞冲量 Δv（m/s）
    this.impactKind = '';
    this.impactHard = 0;          // 「硬」障碍（岩石 / 灯塔 / 大石块）的 Δv
    this.deepTimer = 0;
    this._q = { x: 0, y: 0, z: 0, w: 1 };
    this._f = { x: 0, y: 0, z: 0 };
    this._wv = { x: 0, y: 0, z: 0 };
    this._zero = { x: 0, y: 0, z: 0 };

    pw.onContactForce = (other, impulse) => {
      const dv = impulse / this.mass;
      this.impact += dv;
      const heavy = other.kind === 'rock' || other.kind === 'lighthouse' || other.kind === 'nest' || other.kind === 'palm' || other.kind === 'ramp'
        || (other.rec && other.rec.mass > this.mass * 0.6);
      if (heavy) this.impactHard += dv;
      if (!this.impactKind || heavy) this.impactKind = other.kind;
    };
  }

  setMode(key) {
    this.mode = REALISM[key] || REALISM.arcade;
    this.body.setGravityScale(this.mode.gravityScale, true);
  }

  reset(x, z, yaw) {
    const y = terrainHeight(x, z) + 0.02;
    this.body.setTranslation({ x, y, z }, true);
    this.body.setLinvel(this._zero, true);
    this.setYaw(yaw);
    this.pos.x = this.prev.x = x; this.pos.y = this.prev.y = y; this.pos.z = this.prev.z = z;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.deepTimer = 0;
  }

  setYaw(yaw) {
    this._yaw = yaw;
    this._q.y = Math.sin(yaw / 2); this._q.w = Math.cos(yaw / 2);
    this.body.setRotation(this._q, true);
  }

  /** 地面高度（解析地形 vs 跳台射线，取高者），结果写进 wheel */
  _probe(w, x, mountY, z, rampsOn) {
    let gy = terrainHeight(x, z);
    let fromRamp = false;
    if (rampsOn) {
      const ray = this.ray;
      ray.origin.x = x; ray.origin.y = mountY; ray.origin.z = z;
      const hit = this.world.castRayAndGetNormal(ray, this.restLen + 0.4, true, undefined, this.rampGroups);
      if (hit && mountY - hit.timeOfImpact > gy) {
        gy = mountY - hit.timeOfImpact;
        w.n.x = hit.normal.x; w.n.y = hit.normal.y; w.n.z = hit.normal.z;
        fromRamp = true;
      }
    }
    if (!fromRamp) terrainNormal(x, z, 0.35, w.n);
    w.gy = gy;
    w.d = mountY - gy;
    w.hit = w.d < this.restLen;
    w.mat = fromRamp ? MATERIALS.wood : terrainMaterial(x, z, gy, w.n.y);
  }

  /**
   * 一个子步的施力。c = { yaw, throttle, brake, accel, brakeAccel, maxSpeed, load, jumpV, rampsOn, t, airborne }
   */
  preStep(h, c) {
    const b = this.body;
    const M = this.mass;
    const mode = this.mode;
    const gEff = GRAVITY * mode.gravityScale;
    const p = b.translation(), v = b.linvel();
    this.setYaw(c.yaw);
    b.resetForces(false);

    const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);

    // ---- 悬挂 ----
    const k = M * gEff / (2 * this.sag0);
    const damp = 0.5 * 2 * Math.sqrt(k * M / 2);
    const mountY = p.y + this.mountH;
    let N = 0, nx = 0, ny = 0, nz = 0;
    this.contacts = 0;
    for (let i = 0; i < 2; i++) {
      const w = this.wheel[i];
      this._probe(w, p.x + fx * w.z, mountY, p.z + fz * w.z, c.rampsOn);
      w.load = 0;
      if (!w.hit) continue;
      const x = this.restLen - w.d;
      const vn = v.x * w.n.x + v.y * w.n.y + v.z * w.n.z;
      let F = k * x - damp * vn;
      const bottom = x - (this.travel + this.sag0);
      if (bottom > 0) F += k * 10 * bottom;         // 触底缓冲
      F = Math.max(0, Math.min(F, M * gEff * 12));
      w.load = F;
      N += F;
      nx += w.n.x * F; ny += w.n.y * F; nz += w.n.z * F;
      this.contacts++;
    }
    const f = this._f;
    f.x = nx; f.y = ny; f.z = nz;      // 法向力合力（沿各自地面法线）

    // ---- 水：深度、浮力、阻力 ----
    const wy = waveHeight(p.x, p.z, c.t);
    const depth = wy - p.y;
    this.depth = depth;
    this.wading = Math.min(1, Math.max(0, (depth + 0.1) / 0.45));
    if (depth > 0) {
      waveVelocity(p.x, p.z, c.t, this._wv);
      const sub = Math.min(1, depth / 1.2);                     // 车 + 鸟的竖直尺度约 1.2 m
      f.y += RHO_WATER * GRAVITY * 0.026 * sub;                // 等效排水体积 0.026 m³（鸟和轮胎是空心的）
      const ux = v.x - this._wv.x, uy = v.y - this._wv.y, uz = v.z - this._wv.z;
      const u = Math.hypot(ux, uy, uz);
      let kd = 0.5 * RHO_WATER * 0.5 * Math.pow(sub, 1.5) * u * mode.waterDrag + 60 * sub;
      kd = Math.min(kd, M / h * 0.9);
      f.x -= kd * ux; f.y -= kd * uy; f.z -= kd * uz;
    }

    // ---- 轮胎 ----
    if (N > 0) {
      const inv = 1 / Math.hypot(nx, ny, nz);
      const gx = nx * inv, gyN = ny * inv, gz = nz * inv;
      this.groundN.x = gx; this.groundN.y = gyN; this.groundN.z = gz;
      // 切向前进方向 t：车头水平方向投影到地面平面
      let tx = fx - gx * (fx * gx + fz * gz), ty = -gyN * (fx * gx + fz * gz), tz = fz - gz * (fx * gx + fz * gz);
      let il = 1 / (Math.hypot(tx, ty, tz) || 1);
      tx *= il; ty *= il; tz *= il;
      // 横向 l = n × t
      const lx = gyN * tz - gz * ty, ly = gz * tx - gx * tz, lz = gx * ty - gyN * tx;
      const vT = v.x * tx + v.y * ty + v.z * tz;
      const vL = v.x * lx + v.y * ly + v.z * lz;
      this.vLat = vL;

      // 路面：两轮载荷加权
      const w0 = this.wheel[0], w1 = this.wheel[1];
      const mat = w0.load >= w1.load ? w0.mat : w1.mat;
      this.surface = mat;
      const wetLoss = 1 - 0.55 * Math.min(1, Math.max(0, depth) / 0.6);
      const mu = mat.grip * mode.gripAssist * wetLoss;
      const Fmax = mu * N;

      // 横向：一个子步内消除侧滑速度所需的力（侧坡的下滑分量也由它顶住），被 μN 截断 —— 超出就侧滑
      let FL = -M * vL / h * 0.9;
      FL = Math.max(-Fmax, Math.min(Fmax, FL));
      this.slip = Math.abs(FL) >= Fmax * 0.999 ? Math.min(1, Math.abs(vL) / 3) : 0;

      // 纵向：踩踏（功率曲线：越快越难再加速）− 滚阻 − 刹车（刹停后还能驻坡）
      const spdK = Math.max(0, 1 - (Math.max(0, vT) / c.maxSpeed) ** 2);
      let Fd = c.throttle * M * c.accel * spdK * (1 - c.load * 0.12) * (1 - this.wading * 0.45);
      const rr = mat.crr * N * (1 + this.wading * 1.5);
      const stopF = M * Math.abs(vT) / h;
      let Fr = -Math.sign(vT) * Math.min(rr, stopF);
      let Fb = 0;
      if (c.brake > 0) {
        const cap = Math.min(c.brake * M * c.brakeAccel, Fmax);
        // 需要的力：把 vT 刹到 0，并抵消重力沿坡分量（M·g·t_y）
        const need = -M * vT / h + M * gEff * ty;
        Fb = Math.max(-cap, Math.min(cap, need));
        Fr = 0;
      }
      let FT = Fd + Fr + Fb;
      const capT = Math.sqrt(Math.max(0, Fmax * Fmax - FL * FL)) + Math.abs(Fr);
      FT = Math.max(-capT, Math.min(capT, FT));
      f.x += tx * FT + lx * FL;
      f.y += ty * FT + ly * FL;
      f.z += tz * FT + lz * FL;
      this.vFwd = vT;
    } else {
      this.groundN.x = 0; this.groundN.y = 1; this.groundN.z = 0;
      this.vFwd = v.x * fx + v.z * fz;
      this.slip = 0;
    }

    // ---- 空气阻力 ½ρ·CdA·|v|·v，CdA ≈ 0.55 m²（直立骑姿 + 一只张着翅膀的鹈鹕）----
    const sp = Math.hypot(v.x, v.y, v.z);
    const ka = 0.5 * 1.2 * 0.55 * sp * mode.airDrag;
    f.x -= ka * v.x; f.y -= ka * v.y; f.z -= ka * v.z;

    // ---- 喉囊里的鱼：额外重量 ----
    f.y -= c.load * 0.3 * M * gEff;

    // ---- 深水：离岸流把车推回浅滩；软边界 ----
    const th = terrainHeight(p.x, p.z);
    if (th < WATER_LEVEL - 0.9) {
      const n = terrainNormal(p.x, p.z, 1.5, this._nTmp || (this._nTmp = { x: 0, y: 1, z: 0 }));
      let ux = -n.x, uz = -n.z;
      const ul = Math.hypot(ux, uz);
      if (ul < 0.05) { ux = -p.x; uz = -p.z; }
      const il2 = 1 / (Math.hypot(ux, uz) || 1);
      const s = Math.min(1.6, (WATER_LEVEL - 0.9 - th) / 1.2);
      f.x += ux * il2 * M * 5.5 * s;
      f.z += uz * il2 * M * 5.5 * s;
      this.deepTimer += h;
    } else {
      this.deepTimer = Math.max(0, this.deepTimer - h * 2);
    }
    const r = Math.hypot(p.x, p.z);
    if (r > c.worldRadius) {
      const s = (r - c.worldRadius) / 20;
      f.x -= p.x / r * M * 4 * s;
      f.z -= p.z / r * M * 4 * s;
    }

    b.addForce(f, true);

    // ---- 起跳：一个向上的冲量 ----
    if (c.jumpV > 0) {
      f.x = 0; f.y = M * c.jumpV; f.z = 0;
      b.applyImpulse(f, true);
    }
    this.impact = 0;
    this.impactHard = 0;
    this.impactKind = '';
  }

  /** 子步之后：读回位姿与速度 */
  postStep() {
    const t = this.body.translation(), v = this.body.linvel();
    this.prev.x = this.pos.x; this.prev.y = this.pos.y; this.prev.z = this.pos.z;
    this.pos.x = t.x; this.pos.y = t.y; this.pos.z = t.z;
    this.vel.x = v.x; this.vel.y = v.y; this.vel.z = v.z;
  }

  /** 按比例削减速度（落地摔车）*/
  scaleVelocity(k) {
    const v = this.body.linvel();
    this._f.x = v.x * k; this._f.y = v.y; this._f.z = v.z * k;
    this.body.setLinvel(this._f, true);
  }

  /** 车底离地高度（地形 / 跳台中较高者） */
  heightAboveGround() {
    const w0 = this.wheel[0], w1 = this.wheel[1];
    return Math.min(w0.d, w1.d) - this.mountH;
  }
}
