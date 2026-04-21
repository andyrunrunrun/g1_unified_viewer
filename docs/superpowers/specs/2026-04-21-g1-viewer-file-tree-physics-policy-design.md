# G1 Viewer 文件树、物理开关与 Mock Policy 设计

日期：2026-04-21

## 背景

当前 `g1_unified_viewer` 已经切到“MuJoCo 原生窗口 + 网页控制面板”的双界面结构，但还有三个明显缺口：

1. 动作加载区仍然基于平铺列表，不适合包含几万条动作的大目录。
2. 当前没有显式的“物理仿真开启/关闭”模式切换，无法区分纯数据回放和策略驱动跟踪。
3. `mock_g1_policy` 仍然是一个过于简单的占位实现，没有体现“机器人自身状态 + 参考目标 -> 目标位置输出”的统一策略接口思路。

本设计只覆盖上述三项改造，不扩展到真实策略仓库接入、复杂控制器整合或多机器人支持。

## 目标

- 将左侧动作加载区改成适合大规模目录的懒加载文件树。
- 在 session、API、网页控制面板和 MuJoCo runtime 中引入显式的 `Physics OFF / ON` 两种运行模式。
- 将 `mock_g1_policy` 改成符合后续统一策略接口方向的最小可用策略：
  - observation: 机器人自身状态 + 参考动作目标
  - action: 关节目标位置
- 保持仓库运行时自包含，不依赖外部策略仓库。
- 保持 MuJoCo 原生窗口为主可视化窗口，网页仍只承担控制和状态展示。

## 非目标

- 不在本轮引入真实训练策略或外部权重依赖。
- 不在本轮支持任意层级的策略参数编辑 UI。
- 不在本轮实现高级控制器调参、MPC、接触约束可视化等复杂能力。
- 不把网页升级成主渲染界面。

## 用户体验设计

### 总体布局

控制面板采用偏工程工具的 `A` 结构：

- 顶部：紧凑工具栏
- 左侧：懒加载文件树
- 中间：播放与动作主控制区
- 右侧：策略与检查器区
- 底部：日志 / observation / action 摘要区

视觉风格遵循“高实用性，低装饰性”原则：

- 低饱和中性色
- 更紧凑的信息密度
- 弱化渐变、玻璃态和大圆角卡片感
- 更接近 IDE / 运维面板 / 标注工具的视觉取向

### 顶部工具栏

工具栏放高频操作：

- 数据根路径输入
- 扫描根目录
- 播放 / 暂停 / 停止
- `Physics OFF / ON`
- 导出裁剪
- 启动策略 / 停止策略

顶部工具栏只放动作频率最高的命令，不放大段说明文字。

### 左侧文件树

文件树替代当前平铺扫描列表，设计为真实目录树：

- 目录节点支持展开 / 折叠
- 只在用户点击展开目录时请求下一层内容
- 叶子节点为可加载动作
- 当前已加载动作高亮

文件树节点类型：

- `directory`
- `motion`

对于 `sonic`，可将一个符合格式的动作目录作为 `motion` 叶子节点。
对于 `twist2`，动作文件本身作为 `motion` 叶子节点。

### 中间主控制区

中间区域展示当前动作和播放控制：

- 当前动作名
- 当前格式
- 当前帧 / 总帧数
- FPS
- timeline
- trim 起点 / 终点
- MuJoCo viewer 连接状态
- 当前运行模式（Physics OFF / ON）

网页不显示 MuJoCo 主图像，只显示“当前 viewer 已连接”和状态摘要。

### 右侧策略 / 检查器区

右侧用于展示和控制策略：

- 可用策略列表
- 当前活动策略
- 当前策略的 observation / action 规格摘要
- 当前 session 摘要
- 相机状态
- 最近一次 policy reset / step / error 状态

### 底部日志与摘要区

底部单独保留高信息密度的文本区：

- 最近操作日志
- 最近一次 observation 摘要
- 最近一次 action 摘要
- 最近错误

这样不会把中间主控制区挤满调试信息，同时为后续接入更多策略预留位置。

## 运行模式设计

### Physics OFF

`Physics OFF` 是默认模式，表示纯数据浏览：

- 当前参考动作帧直接映射到机器人状态
- 不进行物理 step
- 不依赖活动策略
- 适合检查数据、拖时间轴、裁剪导出

此模式下，viewer 中机器人姿态等于参考动作当前帧的 canonical state。

### Physics ON

`Physics ON` 表示策略跟踪参考动作：

- 当前参考动作帧作为目标
- policy 使用“机器人当前真实状态 + 参考动作目标”构造 observation
- policy 输出关节目标位置
- MuJoCo 进行 step
- 机器人通过控制跟踪，而不是直接瞬移到参考姿态

此模式下，viewer 中看到的是仿真出来的机器人状态，而不是直接写入的参考帧。

### 模式切换规则

- 默认 `Physics OFF`
- 切到 `Physics ON` 时：
  - 若无活动策略，则优先自动启动 `mock_g1_policy`
  - 重置仿真状态到当前参考帧附近
  - 重置 policy runner
  - 清空上一次 action 缓存
- 切回 `Physics OFF` 时：
  - 停止物理 step
  - 立即恢复参考帧直接回放
- 在 `Physics ON` 下执行以下操作时，都需要统一 reset：
  - 切动作
  - seek
  - 切 trim 边界导致当前帧重定位
  - 手动重置播放

## Mock Policy 设计

### Observation

`mock_g1_policy` 的 observation 由两部分组成：

1. `robot_state`
2. `reference_target`

`robot_state` 包含：

- `root_position`
- `root_rotation_wxyz`
- `joint_positions`
- `joint_velocities`

`reference_target` 包含：

- `target_root_position`
- `target_root_rotation_wxyz`
- `target_joint_positions`
- `target_joint_velocities`

同时补充两个轻量字段：

- `frame_index`
- `dt`

这里将 root 目标放入 observation，但不作为 action 输出，因为浮动基不应作为直接控制量。

### Action

action 统一定义为：

- `mode = joint_position_target`
- `values = actuated_joint_targets`

输出只包含一组与 G1 可控关节数量一致的目标位置，不直接输出 root target，不直接修改 `qpos`。

### 第一版 Mock 行为

第一版 mock policy 行为保持简单：

- 默认直接返回参考动作的 `target_joint_positions`
- 可在 runner 内加极轻量的平滑或限幅

这样虽然不是“真实策略”，但接口已经与后续真实策略一致。

## 后端架构设计

### SessionController 新状态

`SessionController` 新增以下显式状态：

- `physics_enabled: bool`
- `reference_state: CanonicalRobotState | None`
- `simulated_state: CanonicalRobotState | None`
- `last_observation_summary: dict`
- `last_action_summary: dict`
- `last_log_messages: list[str]`

已有的 `view_mode` 不再承担“物理开关”语义，物理模式由独立字段控制。

### 统一状态流

1. 文件树叶子节点加载动作
2. session 更新当前 reference sequence
3. viewer runtime 每 tick 读取 session 当前模式
4. 若 `Physics OFF`
   - 返回当前 reference frame
5. 若 `Physics ON`
   - 组装 observation
   - 调用 policy step
   - 将 action 映射成仿真控制输入
   - 执行 `mj_step`
   - 返回当前模拟状态

seek、切动作、切模式都通过统一 reset 路径，保证：

- reference 状态
- simulator 状态
- policy 内部状态
- 日志和摘要状态

同步更新，不串状态。

## MuJoCo Runtime 设计

### Physics OFF Runtime 行为

- 继续沿用现有“直接把 canonical state 写入 `qpos/qvel`”的方式
- 不调用 `mj_step`

### Physics ON Runtime 行为

- 从 session 取当前 reference target
- 从当前 `MjData` 读取机器人真实状态
- 构造 observation
- 调用 policy runner 获取 `joint_position_target`
- 将 target 映射到 MuJoCo 控制输入
- 调用 `mj_step`
- 将最新真实状态回写 session

### 控制输入映射

第一版采用简单 position servo / PD 思路：

- target = policy 输出 joint positions
- `data.ctrl` 写入对应 target
- MJCF 或 runtime 使用简单的 position actuator 语义

本轮不引入复杂控制器调参界面。

## API 设计

### 保留接口

继续保留：

- `/api/load_clip`
- `/api/playback/*`
- `/api/trim_export`
- `/api/policies/*`

### 新增接口

新增文件树浏览接口：

- `POST /api/browser/list`

请求：

- `path`

响应节点字段：

- `path`
- `name`
- `node_type`
- `format`
- `has_children`

新增物理模式切换接口：

- `POST /api/physics/toggle`

请求：

- `enabled`

响应：

- 更新后的 session summary

新增的 `/api/session` 响应中也需要包含：

- `physics_enabled`
- `last_observation_summary`
- `last_action_summary`
- `last_log_messages`

## 前端实现设计

### 文件树前端

前端不再一次性渲染全部扫描项，而是维护一个树节点缓存：

- 已展开目录缓存 children
- 未展开目录只显示折叠标记
- 点击目录时请求 `/api/browser/list`
- 点击动作叶子节点时调用 `/api/load_clip`

### 顶部工具栏

顶部工具栏替代当前分散按钮布局，放所有高频命令。

其中 `Physics OFF / ON` 使用高辨识度但不花哨的 toggle button。

### 底部日志区

底部新增紧凑文本面板，显示：

- 最近日志
- 最近 observation 摘要
- 最近 action 摘要

避免把右侧检查器塞得过满。

## 测试设计

### 单元 / 接口测试

新增或扩展测试覆盖：

- 文件树目录列出是否正确
- `physics_enabled` 切换是否进入对应模式
- `Physics ON` 下 seek 是否触发 reset
- `mock_policy` observation 是否包含 `robot_state + reference_target`
- `mock_policy` 输出是否为 `joint_position_target`

### Smoke Test

至少验证：

- 大目录展开时前端不会一次性卡死
- `Physics OFF` 下时间轴拖动正常
- `Physics ON` 下启动 mock policy 后能持续跟踪参考动作
- 切动作不会保留上一段动作的 policy 内部状态

## 风险与约束

### MuJoCo 控制输入语义

当前仓库已有“直接写状态”路径，但 `Physics ON` 下需要确认 G1 模型上使用哪种控制输入最稳妥。如果现有 MJCF actuator 定义不足，可能需要补最小控制映射。

### 大目录文件树性能

文件树必须坚持懒加载，不能退回“扫描整个根目录后一次性返回全部动作”的老路，否则大目录下前端性能会明显退化。

### 状态一致性

`Physics ON` 与 seek / clip switch / policy reset 的状态一致性是本轮实现最容易出错的点，必须让所有入口收敛到统一 reset 流程。

## 实现顺序建议

1. 扩展模型和 session，先加 `physics_enabled`、日志和 observation/action 摘要字段
2. 新增文件树 API 和前端文件树
3. 改造 mock policy 的 observation / action 协议
4. 在 runtime 中补 `Physics ON` 的仿真 step 路径
5. 补测试和 smoke 验证
