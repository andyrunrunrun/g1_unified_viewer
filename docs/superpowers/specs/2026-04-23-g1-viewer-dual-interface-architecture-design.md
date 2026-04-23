# G1 Viewer 双界面架构收敛设计

日期：2026-04-23

## 背景

当前 `g1_unified_viewer` 已经形成了一个可运行的双界面原型：

- MuJoCo 原生窗口负责 3D 可视化
- Web 控制面板负责扫描、加载、播放、导出和策略操作

这个方向已经和 `motiondata_lib` 的单桌面工具路线、以及 `RoboJuDo` 的部署 pipeline 路线拉开了差异。当前最关键的设计问题，不是“还能不能跑”，而是要不要继续保持 `HTTP API + native viewer` 的双界面结构。

本设计的结论是：

- 保留双界面
- 明确 `SessionController` 是唯一状态源
- 将 HTTP API 定义为控制和自动化入口，而不是第二套业务逻辑
- 将 native viewer 明确定义为渲染器和本地交互终端，而不是业务编排中心

这样可以在不推翻现有代码的前提下，继续推进文件树、`Physics OFF / ON`、策略 runner 和调试面板。

## 目标

- 保留 MuJoCo 原生 viewer 作为主渲染窗口
- 保留 HTTP API，作为网页控制面板和自动化测试的统一入口
- 收敛状态边界，避免网页和 native viewer 各自持有业务状态
- 为后续 `Physics ON`、policy 诊断信息和更复杂的浏览器面板提供稳定架构

## 非目标

- 不在本轮把网页替换成 Qt 或 PySide6 面板
- 不在本轮把 MuJoCo 原生 viewer 改造成复杂的桌面应用框架
- 不在本轮把 API 升级成外部公开服务或多用户服务端

## 选择结论

在三个备选方向中：

1. 保持 `HTTP API + native viewer`
2. 将控制面板半合并进 native 桌面应用
3. 完全合并成单一 native viewer

本轮选择方案 1。

推荐原因：

- 当前代码已经天然接近该结构，演进成本最低
- HTTP API 让控制面板、脚本、测试和未来调试工具复用同一入口
- native viewer 可以继续专注在 MuJoCo 交互，不需要承载复杂业务 UI 状态
- 后续 `Physics ON` 会引入更多运行时状态、重置逻辑和诊断摘要，保留 API 更利于观测和验证

不选择方案 3 的原因：

- 一旦完全合并到 native GUI，文件浏览、策略调试、日志、状态摘要和自动化测试都会重新耦合到桌面事件循环
- 当前项目已经不只是“本地动作浏览器”，而是在向“可视化 + 运行控制 + 策略接入底座”演化
- 该方向会降低脚本驱动和测试可达性

## 架构总览

### 单一状态源

`SessionController` 是唯一业务状态源。所有可变业务状态都必须先进入 controller，再由各个界面读取。

它负责：

- 当前浏览根路径和可加载条目
- 当前加载的动作和播放位置
- trim 区间
- `Physics OFF / ON`
- 当前活动策略和策略摘要
- viewer 连接状态与相机状态
- 最近错误、日志、observation/action 摘要

它不负责：

- MuJoCo 实际绘制
- HTML 结构和浏览器事件
- 具体 HTTP 协议细节

### Native Viewer 的角色

`NativeViewerRuntime` 是渲染器，不是业务主控。

它负责：

- 从 `SessionController` 拉取当前应显示的状态
- 把状态应用到 MuJoCo `qpos/qvel/ctrl`
- 处理少量高频本地快捷键
- 回传相机状态和 viewer 连接状态

它不负责：

- 文件扫描和浏览逻辑
- 导出逻辑
- 策略生命周期编排
- 持久保存独立会话状态

### HTTP API 的角色

HTTP API 是 controller 的远程控制面，不允许拥有独立业务状态。

它负责：

- 为网页控制面板提供命令入口
- 为测试提供稳定的可编程接口
- 为未来 CLI 或脚本驱动保留统一入口

它不负责：

- 自己维护播放状态副本
- 自己推导渲染状态
- 实现一套区别于 controller 的业务规则

## 数据流

### `Physics OFF`

1. 控制面板或 native 快捷键发出命令
2. 命令进入 `SessionController`
3. `SessionController` 更新 reference session 状态
4. `NativeViewerRuntime` 在每个 tick 读取 reference state
5. viewer 直接渲染 reference state
6. HTTP API 只读取同一个 session summary 返回给前端

### `Physics ON`

1. 控制面板通过 API 或快捷键切换到 `Physics ON`
2. `SessionController` 完成模式切换和统一 reset
3. `NativeViewerRuntime` 在每个 tick 同时读取 reference target 和 simulation state
4. runtime 构造 observation 并调用 policy runner
5. runtime 将 action 映射到 MuJoCo 控制输入并执行 step
6. runtime 将 observation/action 摘要和错误状态写回 controller
7. 网页只消费 controller 汇总后的摘要

关键约束：

- Web 面板从不直接控制 MuJoCo `MjData`
- policy runner 从不直接操作前端状态
- 所有 seek、切动作、trim、physics 切换都必须收敛到统一 reset 流程

## API 收口建议

当前 API 能工作，但过于动作碎片化。建议后续按会话资源收口，而不是继续增加大量零散 endpoint。

推荐分组：

- `GET /api/session`
- `POST /api/browser/list`
- `POST /api/session/load`
- `POST /api/session/playback`
- `POST /api/session/trim`
- `POST /api/session/physics`
- `GET /api/policies`
- `POST /api/policies/active`
- `POST /api/policies/step`

这样做的目的不是追求 REST 形式，而是让“谁拥有状态、谁处理命令”更加清晰。

具体原则：

- API handler 只做参数校验、controller 调用和错误转换
- 所有业务规则进入 `SessionController`
- 前端只理解 session summary 和少量命令响应

## UI 边界

### 保留网页控制面板

网页面板继续承担：

- 文件树浏览
- 加载动作
- 播放与 trim 控制
- policy 启停和调试操作
- 日志、camera、observation/action 摘要展示

保留网页的主要理由是迭代速度快、调试信息密度高、修改成本低。

### 保留 Native Viewer 作为主可视化窗口

Native viewer 继续承担：

- 3D 主渲染
- 鼠标相机操作
- 少量高频快捷键
- 运行时 overlay

overlay 应该保持精简，只展示高频运行信息，不承担详细调试面板职责。

## 错误处理

错误处理统一采用“runtime 采集，controller 汇总，UI 消费”的模式。

约束如下：

- runtime 错误写入 `SessionController.last_error`
- policy step 失败不应让 web 和 viewer 各自维护一份错误状态
- 浏览器只展示 session summary 中的错误和最近日志
- native viewer overlay 只显示压缩后的错误提示

这可以避免双界面出现信息不一致。

## 测试策略

保留双界面的一个直接收益，是测试分层天然清晰：

- `SessionController` 单元测试
- API 的 TestClient 测试
- viewer runtime 以最小 smoke 测试验证状态同步和错误回传

重点测试面：

- load / seek / trim / loop 的状态一致性
- `Physics OFF / ON` 切换后的 reset 语义
- policy start / stop / step 的状态落盘
- API 返回的 session summary 是否完整

不要求在本轮引入完整 GUI 自动化测试。

## 迁移原则

后续实现时，优先做“整理”和“收口”，而不是大改。

推荐顺序：

1. 扩展 `SessionSummary`，补足 physics 和诊断字段
2. 将浏览器文件树纳入 controller 和 API
3. 将 physics 模式切换收敛到 controller
4. 在 runtime 内实现 `Physics ON` 的闭环 step
5. 最后再整理 API endpoint 形态

这样可以保证每一步都兼容当前原型，不需要同时重写 web 和 native 两边。

## 决策总结

本仓库应继续坚持：

- 单状态源：`SessionController`
- 双界面：`HTTP API + native viewer`
- 明确分工：web 管控制和诊断，native 管渲染和高频交互

这不是过渡性妥协，而是当前项目目标下最稳定、最可测试、最容易继续推进的主架构。
