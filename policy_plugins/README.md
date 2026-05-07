# Policy Plugins

`policy_plugins/` 是 G1 Unified Viewer 的策略插件目录。后端会扫描这个目录，前端通过 `/api/policy-plugins` 获取可选策略；插件目录里的模型和 JS 文件会通过 `/policy-plugins/...` 静态服务给浏览器。

当前推荐策略都在浏览器运行：

- ONNX 模型：`framework: "onnx"`，由 `onnxruntime-web` 推理。
- 自定义 JS 策略：`framework: "custom_js"`，适合多模型、多输入输出拼接逻辑。
- Mock 策略：`framework: "mock"`，用于关闭 Physics 时直接播放目标动作。

## 目录规则

一个子目录代表一个策略插件或一种策略格式：

```text
policy_plugins/
  mock_passthrough/
    policy.json
  motion_tracking/
    policy_format.json
    tracking_policy_latest.json
    policy_latest.onnx
  twist2/
    policy_format.json
    tracking_policy_latest.json
    *.onnx
    Twist2StudentFutureObs.js
  sonic/
    policy.json
    sonic_policy.json
    SonicPolicy.js
    model_encoder.onnx
    model_decoder.onnx
    planner_sonic.onnx
```

使用哪种 manifest：

- `policy.json`
  - 一个文件夹就是一个明确策略。
  - 适合 mock 或 custom JS 策略。
- `policy_format.json`
  - 一个文件夹代表一种训练/导出格式。
  - 文件夹里的每个 `.onnx` 都会自动展开成一个可选择策略。
  - 适合 `twist2` 这种同格式下不断新增 checkpoint 的场景。

## 添加一个 ONNX 格式策略

如果你的新模型和已有格式的输入输出完全一致，只需要把 `.onnx` 放进对应格式文件夹。

例如给 `twist2` 增加一个模型：

```text
policy_plugins/twist2/
  policy_format.json
  tracking_policy_latest.json
  twist2_1017_25k.onnx
  my_new_twist2_model.onnx
```

刷新页面后，UI 会在 `twist2` 文件夹下显示 `my_new_twist2_model`。后端会为它动态生成：

- `policy_id`: 默认是 `{policy_id_prefix}_{onnx文件名}`
- `config_path`: `/api/policy-plugins/{policy_id}/config`
- `onnx.path`: `/policy-plugins/{格式文件夹}/{onnx文件名}`

如果想给某个模型指定更友好的名字，在 `policy_format.json` 里加 `model_overrides`：

```json
{
  "format_id": "twist2",
  "display_name": "Twist2",
  "robot_type": "g1",
  "runtime": "browser",
  "framework": "onnx",
  "control_mode": "joint_position_target",
  "config_template": "tracking_policy_latest.json",
  "policy_id_prefix": "twist2",
  "model_overrides": {
    "my_new_twist2_model.onnx": {
      "policy_id": "twist2_my_new_model",
      "display_name": "Twist2 / My New Model",
      "display_name_i18n": {
        "zh": "Twist2 / 新模型",
        "en": "Twist2 / My New Model"
      }
    }
  }
}
```

## 新增一种 ONNX 策略格式

当新策略的 observation、action、PD 参数、关节顺序或历史缓存逻辑和现有格式不同，应新建一个格式文件夹。

示例：

```text
policy_plugins/my_format/
  policy_format.json
  tracking_policy_latest.json
  my_policy_001.onnx
  MyFormatObs.js        # 可选，仅当需要格式专用 observation 逻辑
```

最小 `policy_format.json`：

```json
{
  "format_id": "my_format",
  "display_name": "My Format",
  "display_name_i18n": {
    "zh": "我的格式",
    "en": "My Format"
  },
  "robot_type": "g1",
  "runtime": "browser",
  "framework": "onnx",
  "control_mode": "joint_position_target",
  "config_template": "tracking_policy_latest.json",
  "policy_id_prefix": "my_format",
  "tags": ["onnx", "browser", "tracking"],
  "description": "Browser ONNX policy for my training format.",
  "description_i18n": {
    "zh": "浏览器 ONNX 我的训练格式策略。",
    "en": "Browser ONNX policy for my training format."
  }
}
```

`tracking_policy_latest.json` 至少需要描述：

- `policy_joint_names`
- `default_joint_pos`
- `reset_joint_pos`
- `stiffness`
- `damping`
- `torque_limits`
- `control_dt`
- `onnx.path`
- observation 相关配置

对于 `policy_format.json` 目录，`onnx.path` 会在后端动态覆盖为当前选中的 `.onnx`，所以模板里可以写任意占位值或指向默认模型。

如果新格式需要专用 observation 构造，建议：

1. 把格式专用 JS 放在该插件目录下，例如 `policy_plugins/my_format/MyFormatObs.js`。
2. 在共享 runtime 中只保留最小分发逻辑。
3. 不要把格式细节写进 `frontend/src/simulation/observationHelpers.js` 或其他通用路径；通用路径只负责最小分发和调用。

当前 `twist2` 就是这种结构：格式专用逻辑放在 `policy_plugins/twist2/Twist2StudentFutureObs.js`。

## 添加 custom JS 策略

如果策略不是单 ONNX 输入输出，例如 SONIC 这种 encoder + decoder + planner，多模型组合，推荐使用 `custom_js`。

目录示例：

```text
policy_plugins/my_custom_policy/
  policy.json
  MyCustomPolicy.js
  my_policy_config.json
  encoder.onnx
  decoder.onnx
```

`policy.json` 示例：

```json
{
  "policy_id": "my_custom_policy",
  "display_name": "My Custom Policy",
  "display_name_i18n": {
    "zh": "我的自定义策略",
    "en": "My Custom Policy"
  },
  "robot_type": "g1",
  "runtime": "browser",
  "framework": "custom_js",
  "format_id": "my_custom_policy",
  "module_path": "./MyCustomPolicy.js",
  "config_path": "/policy-plugins/my_custom_policy/my_policy_config.json",
  "control_mode": "joint_position_target",
  "tags": ["browser", "onnx", "tracking"],
  "description": "Custom browser policy.",
  "description_i18n": {
    "zh": "浏览器自定义策略。",
    "en": "Custom browser policy."
  }
}
```

`MyCustomPolicy.js` 必须导出：

```js
export async function createBrowserPolicy(manifest, host) {
  return new MyCustomPolicy(manifest, host);
}
```

返回对象需要实现这些方法：

- `load()`
  - 加载 config、ONNX session、默认参数。
- `reset(state = null)`
  - 重置历史缓存、上一次动作、heading state 等。
- `step(input)`
  - 输入当前 MuJoCo 状态和 reference，输出关节目标。
- `defaultStance()`
  - 返回默认站姿目标，暂停和 reset 会持续使用它。
- `setMotionClip(name, frameCache)`
  - 注册当前动作 clip。
- `requestMotion(name, statePayload, options = {})`
  - 切换 tracking 目标。`options.startFrame` 和 `options.transitionSteps` 用于起步过渡。

`step()` 返回格式：

```js
{
  mode: 'joint_position_target',
  joint_names: ['left_hip_pitch_joint'],
  joint_positions: [0.0],
  kp: [40],
  kd: [1],
  torque_limits: [100],
  root_translation: [0, 0, 0.78],
  root_rotation_wxyz: [1, 0, 0, 0],
  control_dt: 0.02,
  physics_options: {
    timestep: 0.001
  }
}
```

`host` 会提供常用工具：

- `host.ort`
  - `onnxruntime-web`
- `host.loadPolicyConfig(configPath)`
- `host.resolveStaticAssetPath(configPath, assetPath)`
- `host.makeDefaultStanceTarget(...)`
- `host.referenceToPolicyState(...)`
- `host.math`
  - quaternion、rot6d、yaw 等工具函数。

参考实现：

- `policy_plugins/sonic/SonicPolicy.js`

## 添加 mock 策略

浏览器 mock 策略只需要 `policy.json`：

```json
{
  "policy_id": "mock_passthrough",
  "display_name": "Mock Passthrough",
  "robot_type": "g1",
  "runtime": "browser",
  "framework": "mock",
  "control_mode": "joint_position_target",
  "config_path": "/examples/checkpoints/g1/tracking_policy_latest.json"
}
```

`mock_passthrough` 的语义是 target input 等于 output。Physics OFF 时只能使用 mock；Physics ON 时 mock 可作为调试策略。

## 后端 Python 子进程策略

仓库仍保留 `python_subprocess` manifest 支持，主要用于调试和兼容旧接口。新策略默认不推荐走这条路径，因为当前 UI 和仿真主链路以浏览器策略为主。

必需字段：

- `policy_id`
- `display_name`
- `robot_type`
- `runtime`: `python_subprocess`
- `framework`: `python`
- `env_python`: `__CURRENT_PYTHON__` 或 Python 可执行文件路径
- `entrypoint`: 相对当前策略文件夹的 runner 路径

参考：

- `policy_plugins/mock_g1_policy/`

## 字段速查

通用字段：

- `policy_id`
  - 全局唯一 ID。
- `display_name`
  - UI 默认显示名。
- `display_name_i18n`
  - `{ "zh": "...", "en": "..." }`。
- `robot_type`
  - 当前应为 `g1`。
- `runtime`
  - `browser` 或 `python_subprocess`。
- `framework`
  - `mock`、`onnx`、`custom_js`、`python`。
- `format_id`
  - 策略格式分组 ID，UI 会按它形成文件夹。
- `control_mode`
  - 当前主链路使用 `joint_position_target`。
- `tags`
  - UI 和调试用标签。
- `description` / `description_i18n`
  - UI 描述。

ONNX 格式字段：

- `config_template`
  - 当前格式的 config 模板文件名。
- `policy_id_prefix`
  - 自动生成 policy id 的前缀。
- `model_overrides`
  - 针对某个 `.onnx` 覆盖显示名、ID、标签、描述。

custom JS 字段：

- `module_path`
  - 相对当前插件目录的 ES module 路径，例如 `./SonicPolicy.js`。
- `config_path`
  - 浏览器可访问的 config URL，例如 `/policy-plugins/sonic/sonic_policy.json`。

## 修改后如何验证

新增或修改插件后，建议运行：

```bash
cd /home/huanghao/source/code/g1_unified_viewer/frontend
npm test -- --test-reporter=spec
npm run build
cd ..
git diff --check
```

手动检查：

1. 启动后端 `uv run python main.py --port 8050`。
2. 启动前端 `cd frontend && npm run dev`。
3. 打开 `http://127.0.0.1:3000`。
4. 在右侧 Policy 面板确认策略出现在正确文件夹下。
5. 开启 Physics，选择策略，Reset stance，再 Play 一个动作。
