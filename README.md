# 鹈鹕骑行 · Pelican on a Bicycle

一只鹈鹕骑着一辆通勤自行车环游海岛 —— 纯 WebGL / three.js 实时 3D 场景。

**场景里没有任何外部模型、贴图或音频文件**：地形、海面、天空、云、鸟群、
自行车、鹈鹕（含 3000 片羽毛）、链条声与车铃，全部由代码在运行时生成。

## 运行

ES Module + importmap 需要 HTTP 协议，直接双击 `index.html` 会因 CORS 失败。

```bash
cd pelican-bike-3d
python3 -m http.server 8931
# 打开 http://127.0.0.1:8931/index.html
```

three.js 已经放在 `vendor/` 里（本地引用），离线也能跑。

## 操作

| 键 | 作用 | 键 | 作用 |
|---|---|---|---|
| `W` `S` | 加速 / 刹车 | `1`–`4` | 切换机位 |
| `A` `D` | 左右转向 | `B` | 摇车铃 |
| `Space` | 起跳 | `P` | 拍照存档 |
| 拖拽 | 轨道视角 | `M` | 声音开关 |
| 滚轮 | 缩放 | `H` | 隐藏界面 |
| `R` | 重置到出生点 | `G` | 参数面板 |

默认「自动骑行」——按右下角的「自动」按钮可切到手动操控。

## 目录

```
index.html            页面骨架 + importmap
css/style.css         HUD / 标题卡 / 加载界面
js/main.js            装配与主循环（物理 → 骨骼 → IK → 渲染）
js/input.js           键盘 / 指针 / 屏幕按钮 → 统一「意图」
js/camera.js          四种机位：跟随 / 环绕 / 鸟眼 / 电影
js/audio.js           Web Audio 程序化音效（风声、链条、车铃、海鸥）
js/util/noise.js      哈希 / Perlin / fbm，以及世界地形高度场
js/util/geometry.js   曲线扫掠管体、羽片、两骨 IK 等几何原语
js/gfx/shaders.js     全部自研 GLSL（天空、地形、海面、草、云、鸟、羽毛）
js/gfx/feather.js     羽毛蒙皮层（实例化 mat4）
js/gfx/effects.js     后处理链（辉光 → 速度模糊 → 分级 → ACES 输出）
js/objects/bike.js    自行车的程序化建模与传动
js/objects/pelican.js 鹈鹕的建模、骨骼与 IK
js/world/environment.js  地形 / 海面 / 植被 / 云 / 鸟群
js/world/sky.js       时间与光照导演（13 个关键帧的昼夜色板）
```

## 几个实现上的关键点

- **统一的光照状态**：天空、地形、海面、草、云、鸟共用同一批 uniform，
  每帧只写一次太阳方向，整个世界同步变色。自研着色器输出线性 HDR，
  色调映射与 sRGB 编码统一交给后处理链末端的 `OutputPass`，
  于是自研材质与 `MeshStandardMaterial` 共享同一套曝光。
- **方向性天空**：地平线的颜色随方位变化 —— 朝阳侧暖橙、背光侧冷蓝紫。
  海面反射与地形天光都调用同一个 `skyColor()`，保证三者严格一致。
- **径向指数网格海面**：单张极坐标网格，环半径按指数增长，
  一张网格同时满足近景（十几厘米）与远景（数公里）的精度需求，
  且没有拼接缝。
- **羽毛**：3094 片羽毛 = 1 个 draw call。每帧把「骨骼世界矩阵 × 羽毛局部矩阵」
  算好写进 per-instance 的 mat4 属性。
- **IK**：鹈鹕的翅膀搭在车把、脚掌踩在踏板上，都由世界空间的两骨 IK 解算，
  所以车把怎么转、踏板怎么转，手脚都跟得住。
- **画质档位分两处**：`state.quality` 决定「一次性」的东西（草的数量、地形 LOD、
  阴影贴图尺寸），`effects.bloomBase` 决定「每帧重算」的辉光强度。
  两者必须分开 —— `Effects.render()` 每帧都会用 `bloomBase × 太阳高度系数`
  重写 `bloom.strength`，直接写 `strength` 会在下一帧被覆盖，降档等于没降。
- **转向的符号约定**：`player.steer > 0` 一律表示「车把向右打」（`input.js` 的
  D 键、`bike.js` 的转向组都是这个约定）。但模型是朝 +Z 建的，
  骑手面朝 +Z 时右手边是 **-X**，而 `yaw` 增大是朝 +X 转 ——
  所以「右打把」必须让 `yaw` **递减**（`main.js` 里是 `player.yaw -= …`）。
  写成 `+=` 就会出现「前轮明明朝右、整辆车却往左拐」。
  侧倾同理：`lean > 0` 是绕前进轴把车顶转到 -X（骑手右侧），
  所以右转要配正 `lean`。`autoSteer()` 里「绕圈方向」和「误差修正」两处
  也要跟着取 `radial - π/2` 与 `-diff`，否则鸟会贴着原点原地打转。
