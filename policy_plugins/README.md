# Policy Plugins

Each folder can define either one explicit policy or one policy format.

Use `policy.json` when the folder contains exactly one explicit policy.
Use `policy_format.json` when the folder represents a training/export format
and every `.onnx` file in the folder should become a selectable policy.

Required browser policy fields:

- `policy_id`
- `display_name`
- `robot_type`
- `runtime`: `browser`
- `framework`: `mock` or `onnx`
- `config_path`: browser-served policy config path

For ONNX browser policies, keep the model next to the config and make
`onnx.path` relative to that config file, for example:

```text
policy_plugins/motion_tracking/
  policy_format.json
  tracking_policy_latest.json
  policy_latest.onnx
  another_trained_model.onnx
```

With `policy_format.json`, adding `another_trained_model.onnx` automatically
adds a new browser policy. Use `model_overrides` to customize one model's
`policy_id`, `display_name`, tags, or description.

Required Python subprocess policy fields:

- `policy_id`
- `display_name`
- `robot_type`
- `runtime`: `python_subprocess`
- `framework`: `python`
- `env_python`: `__CURRENT_PYTHON__` or a Python executable path
- `entrypoint`: Python runner path relative to the policy folder

Current policies:

- `mock_g1_policy`: backend subprocess mock runner.
- `mock_passthrough`: browser mock policy, target input equals output.
- `motion_tracking`: browser ONNX motion tracking policy.
- `twist2`: browser ONNX Twist2 policy format. Drop more `.onnx`
  checkpoints into this folder to make them selectable.
