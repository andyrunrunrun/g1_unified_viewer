# G1 Unified Viewer

这是一个面向 **Unitree G1** 的本地动作与策略可视化仓库，当前主形态是：

- 一个 **MuJoCo 原生交互窗口**
  - 负责真正的 3D 可视化
  - 可以直接用鼠标拖动、旋转、缩放视角
- 一个 **网页控制面板**
  - 负责扫描数据、切换动作、播放控制、裁剪导出和策略切换

这个仓库的运行时目标是**自包含**：

- 不依赖 `RoboJuDo`
- 不依赖 `TWIST2`
- 不依赖 `GR00T-WholeBodyControl`
- G1 的 MuJoCo 资产已经内置在 `assets/g1/`

## 架构边界

- `SessionController`
  - 单一状态源，统一持有浏览树、动作加载、播放、trim、physics、policy、viewer 摘要和诊断信息
- `HTTP API + native viewer`
  - `HTTP API` 负责控制、自动化和网页面板入口
  - `native viewer` 负责 MuJoCo 渲染、本地高频快捷键和 physics runtime

当前控制面板已经优先使用 grouped session endpoint：

- `/api/session/load`
- `/api/session/playback`
- `/api/session/trim`
- `/api/session/physics`
- `/api/policies/active`
- `/api/policies/step`

旧的 `/api/load_clip`、`/api/playback/*`、`/api/policies/start|stop|mock_step` 仍然保留为兼容别名，但都会收敛到同一套 controller 逻辑。

## Physics OFF / ON

- `Physics OFF`
  - native viewer 直接回放 reference state
  - 网页面板只消费 `SessionController` 汇总后的 session summary
- `Physics ON`
  - runtime 从 `SessionController` 读取 reference target 和 reset 信号
  - policy runner 读取 `robot_state + reference_target`
  - MuJoCo step 和 observation/action 摘要回写到 `SessionController`

## 当前能力

目前已经支持：

- 扫描和加载 `sonic` 风格动作目录
- 扫描和加载 `TWIST2` 风格动作文件
- 将两类数据统一映射到 G1 的内部状态表示
- 在 MuJoCo 原生窗口中播放动作
- 通过网页控制面板进行：
  - 播放 / 暂停 / 停止
  - 拖动时间轴和跳帧
  - 设置裁剪起止帧
  - 导出裁剪结果回原格式
  - 启动 / 停止统一策略 runner
- 保留统一策略接口，便于后续继续接入更多全身控制策略

## 启动方式

在仓库根目录执行：

```bash
cd /home/huanghao/source/code/g1_unified_viewer
uv run python main.py
```

默认会：

- 启动网页控制面板：`http://127.0.0.1:8000`
- 同时打开 MuJoCo 原生窗口

注意：

- MuJoCo 原生窗口需要可用的桌面图形环境
- 如果当前 shell 没有 `DISPLAY`，原生窗口无法启动
- 这种情况下可以先用 `examples/` 里的离屏示例检查 importer / API / policy 接口

如果端口冲突，可以显式指定端口：

```bash
uv run python main.py --port 8001
```

也可以指定 host：

```bash
uv run python main.py --host 0.0.0.0 --port 8001
```

## 预加载动作

可以在启动时直接传入一个动作路径：

```bash
uv run python main.py --path /abs/path/to/sonic_dir
uv run python main.py --path /abs/path/to/twist2_motion.pkl
```

如果你已经知道格式，也可以显式指定：

```bash
uv run python main.py --path /abs/path/to/motion.pkl --format twist2
```

启动时还支持：

```bash
uv run python main.py --path /abs/path/to/motion.pkl --loop
uv run python main.py --path /abs/path/to/motion.pkl --start-paused
```

## 控制面板职责

网页控制面板不再承担主渲染，而是只做控制和状态展示，主要包括：

- 输入路径并扫描本地动作
- 点击某条动作并加载
- 控制播放状态和时间轴
- 设置 trim 起止并导出
- 查看当前 viewer 相机状态
- 启动、停止、单步测试策略 runner

## MuJoCo 原生快捷键

在 MuJoCo 原生窗口中可直接使用：

- `Space`
  - 播放 / 暂停
- `Left` / `Right`
  - 前后单帧跳转
- `R`
  - 回到第 0 帧
- `[` / `]`
  - 把当前帧设为裁剪起点 / 终点
- `N` / `P`
  - 切换下一条 / 上一条动作
- `L`
  - 切换循环播放

## 支持的数据格式

### 1. sonic

典型输入是一个目录，至少包含：

- `joint_pos.csv`

常见还会包含：

- `joint_vel.csv`
- `body_pos.csv`
- `body_quat.csv`
- `fps.txt`
- `metadata.txt`
- `info.txt`

### 2. TWIST2

当前支持这些扩展名：

- `.pkl`
- `.npz`
- `.npy`
- `.json`

会自动尝试识别常见字段，例如：

- `dof_pos`
- `joint_pos`
- `joint_positions`
- `root_pos`
- `root_rot`
- `local_body_pos`

## 导出

裁剪导出会尽量回写到原始格式：

- `sonic` 输入会导出为 `sonic` 风格目录
- `TWIST2` 输入会导出为 `.pkl` / `.npz` / `.json` 中与源文件一致的格式

默认导出目录在：

```text
exports/
```

## 策略接口

当前仓库已经有一个统一策略 runner 接口：

- manifest 放在 `policy_manifests/`
- runner 通过子进程方式启动
- 主仓库和策略 runner 通过统一消息协议通信

当前内置了一个：

- `mock_g1_policy`

它主要用于验证：

- 主仓库环境和策略进程解耦
- 统一 observation / action 接口可行
- 后续可以继续扩展到真实策略

## 示例脚本

`examples/` 目录里保留了一些兼容 / 调试用途的最小脚本：

```bash
uv run python examples/scan_render_example.py
uv run python examples/api_roundtrip_example.py
uv run python examples/policy_mock_example.py
```

这些脚本主要用于：

- 验证 importer 是否正常
- 验证旧的离屏渲染接口仍可用
- 验证策略 runner 接口

更详细说明见：

- [`examples/README.md`](/home/huanghao/source/code/g1_unified_viewer/examples/README.md)

## 可选环境变量

- `G1_VIEWER_MJCF_PATH`
  - 覆盖默认 G1 MuJoCo 模型路径
- `MUJOCO_GL`
  - 仅在你继续使用离屏渲染接口时通常才需要关心

例如：

```bash
G1_VIEWER_MJCF_PATH=/abs/path/to/model.xml uv run python main.py
```

## 目录说明

- `main.py`
  - 启动网页控制面板 + MuJoCo 原生窗口
- `g1_viewer/session.py`
  - 统一会话状态、播放状态、trim 状态和策略状态
- `g1_viewer/viewer_runtime.py`
  - MuJoCo 原生 viewer 主循环
- `g1_viewer/api.py`
  - 控制面板 API
- `g1_viewer/importers.py`
  - `sonic` / `TWIST2` 导入器
- `g1_viewer/exporters.py`
  - 裁剪导出逻辑
- `g1_viewer/policies.py`
  - 策略 manifest 和 runner 管理
- `g1_viewer/static/index.html`
  - 网页控制面板

## 后续扩展方向

当前仓库已经按“统一策略接口”这个方向在设计：

- 数据集播放和策略播放共用一套 session
- 不同策略环境可以继续通过独立 Python 环境 + 子进程 runner 解耦
- 后续可以像 RoboJuDo 那样继续扩展自定义 observation / action 接口

但现在这个版本仍然优先聚焦于：

- 统一动作可视化
- MuJoCo 原生交互
- 轻量可控的策略接入底座
