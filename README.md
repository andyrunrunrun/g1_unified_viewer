# G1 Unified Viewer

面向 **Unitree G1** 的本地动作查看、浏览器 MuJoCo 仿真和策略可视化工作台。

当前主流程是：

- 后端 FastAPI 负责本地数据扫描、动作加载、裁剪导出、策略插件发现和静态资源服务。
- 前端 Vue + Vite 负责控制台 UI、动作播放、浏览器 MuJoCo viewer 和浏览器策略推理。
- MuJoCo 仿真在浏览器中通过 `mujoco-js` WASM 运行。
- ONNX 策略在浏览器中通过 `onnxruntime-web` 运行。

项目默认聚焦 G1 全身 motion tracking。关闭 Physics 时，viewer 直接播放动作；开启 Physics 时，动作会作为目标轨迹送给当前策略，由策略输出关节位置目标，再由浏览器 MuJoCo 进行 PD 控制和仿真。

## 当前能力

- 扫描本地动作目录，支持按文件夹懒加载浏览。
- 加载 `sonic` 和 `twist2` 动作数据。
- 播放、暂停、停止、跳帧、循环播放。
- 裁剪动作并导出为 `sonic`、`twist2`、`motion_tracking_npz` 或 `kimodo_csv` 格式。
- 浏览器 MuJoCo G1 viewer，可用鼠标旋转、缩放、拖拽施加外力。
- Physics ON 时支持：
  - 策略跟踪动作。
  - 暂停后持续给默认站姿目标。
  - Reset 回默认站姿。
  - 起步 2 秒插值过渡。
  - 可选目标平滑 `smooth_body` 风格 EMA。
- 策略插件系统：
  - `mock_passthrough`
  - `motion_tracking`
  - `twist2`
  - `sonic`
  - 后端子进程 mock 示例 `mock_g1_policy`

## 快速启动

建议开发时分别启动后端和前端。

1. 启动后端 API，默认使用 `8050`：

```bash
cd /home/huanghao/source/code/g1_unified_viewer
uv run uvicorn g1_viewer.api:app --host 127.0.0.1 --port 8050
```

2. 启动前端：

```bash
cd /home/huanghao/source/code/g1_unified_viewer/frontend
npm install
npm run dev
```

3. 打开：

```text
http://127.0.0.1:3000
```

Vite dev server 已将这些路径代理到后端 `8050`：

- `/api`
- `/policy-plugins`

如果只想通过后端服务前端，可以先构建：

```bash
cd /home/huanghao/source/code/g1_unified_viewer/frontend
npm install
npm run build
cd ..
uv run uvicorn g1_viewer.api:app --host 127.0.0.1 --port 8050
```

然后访问：

```text
http://127.0.0.1:8050
```

## 默认数据目录

前端默认扫描：

```text
/home/huanghao/source/datasets/gmr_retarget_x/AMASS_numpy123
```

也可以在 UI 的 Data 面板中输入任意本地目录，然后点击 Scan。目录浏览是懒加载的：只扫描当前文件夹，进入子文件夹后再扫描子文件夹。

## 支持动作格式

### sonic

典型输入是一个目录，至少包含：

- `joint_pos.csv`

常见可选文件：

- `joint_vel.csv`
- `body_pos.csv`
- `body_quat.csv`
- `fps.txt`
- `metadata.txt`
- `info.txt`

### twist2

支持这些扩展名：

- `.pkl`
- `.npz`
- `.npy`
- `.json`

导入器会自动识别常见字段，例如：

- `dof_pos`
- `joint_pos`
- `joint_positions`
- `root_pos`
- `root_rot`
- `local_body_pos`

### motion_tracking_npz

支持单文件 `.npz`。该格式用于 `/mnt/Datasets/huanghao_motion_tracking_npz/` 这类 motion tracking 数据，要求包含：

- `fps`
- `root_pos`
- `root_rot`
- `dof_pos`
- `local_body_pos`
- `joint_names`
- `body_names`

与 `twist2` 的核心轨迹字段相同，但命名元数据使用 `joint_names` 和 `body_names`；导出会保留同名 NPZ schema。

### kimodo_csv

支持单文件 `.csv`，每帧 36 列：

- `root_pos` 3 列
- `root_rot` 4 列，使用 `wxyz`
- G1 29 关节位置

导出 `kimodo_csv` 时会写回同样的 36 列 qpos CSV。

## 策略插件

所有策略相关文件放在：

```text
policy_plugins/
```

当前推荐两种浏览器策略接入方式：

- **ONNX 格式文件夹**：适合同一种训练框架导出的多个 `.onnx` 模型，例如 `twist2/`。
- **custom JS 策略**：适合 SONIC 这种 encoder/decoder、多模型、多输入输出拼接逻辑明显不同的策略。

添加新策略的详细步骤见：

- [policy_plugins/README.md](/home/huanghao/source/code/g1_unified_viewer/policy_plugins/README.md)

## 目录说明

- `main.py`
  - 兼容入口：启动 FastAPI 后端并打开原生 MuJoCo viewer runtime。
- `g1_viewer/api.py`
  - HTTP API、前端静态资源、`/policy-plugins` 静态挂载。
- `g1_viewer/session.py`
  - 会话状态、动作加载、播放状态、trim、physics 状态。
- `g1_viewer/importers.py`
  - `sonic` / `twist2` 动作导入。
- `g1_viewer/exporters.py`
  - 裁剪导出。
- `g1_viewer/policies.py`
  - 策略插件发现、`policy_format.json` 展开、动态 config 生成。
- `frontend/src/App.vue`
  - 主控制台 UI。
- `frontend/src/simulation/`
  - 浏览器 MuJoCo viewer、策略 runtime、tracking helper、观测构造。
- `frontend/public/examples/scenes/`
  - 暂存到 MuJoCo MEMFS 的 G1 MJCF 和 mesh 资源。
- `policy_plugins/`
  - 策略插件目录。

## 常用命令

运行前端测试：

```bash
cd frontend
npm test -- --test-reporter=spec
```

构建前端：

```bash
cd frontend
npm run build
```

检查 diff 空白问题：

```bash
git diff --check
```

启动时预加载动作：

```bash
uv run python main.py --port 8050 --path /abs/path/to/motion_or_dir
uv run python main.py --port 8050 --path /abs/path/to/motion.pkl --format twist2
uv run python main.py --port 8050 --path /abs/path/to/sonic_dir --format sonic
```

这些预加载参数属于 `main.py` 兼容入口；浏览器工作台的常规数据加载建议直接在 UI 的 Data 面板中完成。

可选参数：

```bash
uv run python main.py --port 8050 --loop
uv run python main.py --port 8050 --start-paused
uv run uvicorn g1_viewer.api:app --host 0.0.0.0 --port 8050
```

## 可选环境变量

- `G1_VIEWER_MJCF_PATH`
  - 覆盖默认 G1 MuJoCo 模型路径。
- `MUJOCO_GL`
  - 主要用于仍然需要原生/离屏 MuJoCo 渲染接口的场景。

示例：

```bash
G1_VIEWER_MJCF_PATH=/abs/path/to/model.xml uv run uvicorn g1_viewer.api:app --host 127.0.0.1 --port 8050
```
