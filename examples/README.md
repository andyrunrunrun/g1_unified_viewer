# 示例说明

这个目录里的脚本现在主要是**兼容验证和调试样例**，不是主程序入口。

当前仓库的主使用方式已经变成：

- `MuJoCo 原生 viewer` 负责主可视化
- `网页控制面板` 负责切换动作、播放控制、裁剪导出和策略控制

真正启动主程序的命令仍然是：

```bash
uv run python main.py
```

## 这些示例现在分别是做什么的

### `scan_render_example.py`

作用：

- 扫描一个本地动作路径
- 自动识别 `sonic` 或 `TWIST2`
- 加载动作
- 用**离屏 MuJoCo 渲染**导出第一帧图片

它适合用来快速验证：

- importer 是否工作正常
- G1 的 MuJoCo 资产是否能被正确加载
- 离屏渲染链路是否正常

默认输出：

```text
examples/output/scan_render_frame0.png
```

### `api_roundtrip_example.py`

作用：

- 用 `FastAPI TestClient` 走一遍后端接口
- 验证扫描、加载、兼容渲染接口、裁剪导出、策略列表这条链路

它适合用来快速检查：

- 控制 API 是否还能正常响应
- 兼容接口是否仍然可用
- 导出逻辑有没有被改坏

默认输出：

```text
examples/output/api_roundtrip_frame0.png
```

### `policy_mock_example.py`

作用：

- 加载一个示例动作
- 启动 `mock_g1_policy`
- 构造 `SimulationSnapshot`
- 调一次策略 `step()`
- 关闭 runner

它适合用来验证：

- 策略 manifest 是否能被发现
- 子进程 runner 通信是否正常
- 统一策略接口是否还通

## 示例数据

### `sample_data/sonic_demo/`

一个最小化 `sonic` 样例目录，包含：

- `joint_pos.csv`
- `joint_vel.csv`
- `body_pos.csv`
- `body_quat.csv`
- `fps.txt`
- `metadata.txt`
- `info.txt`

### `sample_data/twist2_demo.pkl`

一个真实的 `TWIST2` 示例动作，来自你指定的：

```text
/home/huanghao/source/code/TWIST2/assets/example_motions/0807_yanjie_walk_001.pkl
```

现在已经复制进本仓库，可独立运行。

### `sample_data/twist2_demo.json`

一个更轻量的 `TWIST2 JSON` 示例，主要用于格式兼容性检查。

## 如何运行

在仓库根目录执行：

```bash
uv run python examples/scan_render_example.py
uv run python examples/api_roundtrip_example.py
uv run python examples/policy_mock_example.py
```

## 推荐怎么用

如果你想：

- 快速验证 importer 和 MuJoCo 资产
  - 先跑 `scan_render_example.py`
- 快速验证 API 和导出链路
  - 再跑 `api_roundtrip_example.py`
- 快速验证策略 runner 通信
  - 跑 `policy_mock_example.py`
- 真正交互式使用仓库
  - 运行 `uv run python main.py`

## 说明

这些示例脚本保留的目的，是为了方便做局部 smoke test。它们不代表主程序的最终交互方式。

主程序现在优先推荐：

- 用 MuJoCo 原生窗口看机器人动作
- 用网页控制面板切换数据和策略
