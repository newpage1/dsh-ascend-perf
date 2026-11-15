# SSH 目标模板（请勿在此文件填写真实主机或凭据）

> 本文件是**模板**，随插件分发，不得包含真实 IP、用户名、私钥路径以外的任何凭据。
> 真实的登录信息只允许保存在插件目录之外：`~/.config/ascend-perf/`（目录 700，文件 600）。

## 1. 需要准备的两个本地文件

### `~/.config/ascend-perf/npu.env`

```bash
NPU_SSH_TARGET='root@<host-or-ip>'
NPU_SSH_KEY="$HOME/.ssh/id_ed25519"
NPU_SSH_PORT='22'
```

多个目标可再追加 `NPU_SSH_TARGET_2`、`NPU_SSH_TARGET_3`…；`scripts/npu-env.sh` 默认读取第一个。

### `~/.config/ascend-perf/npu-ssh.md`（可选，人工速查）

```text
ssh -i ~/.ssh/id_ed25519 root@<host-or-ip>
```

## 2. 权限

```bash
chmod 700 ~/.config/ascend-perf
chmod 600 ~/.config/ascend-perf/npu.env ~/.config/ascend-perf/npu-ssh.md
```

## 3. 使用

```bash
# 仅检查本地配置是否存在（不连远端）
bash ascend-perf/scripts/npu-env.sh check

# 只读采集（需在获得共享环境授权后手动执行；插件本身不会自动运行）
bash ascend-perf/scripts/npu-env.sh probe
```

## 4. 安全边界

- 不要在 `ascend-perf/` 内新增含真实主机/IP/私钥的文件；本目录内容会随插件打包。
- `npu-env.sh` 只执行 `npu-smi info` / `npu-smi info -t usages -i N` 等只读命令，
  并带 `DENY_RE` 拦截 `sudo`、`rm`、`systemctl`、`pkill`、`docker run` 等修改性命令。
- 远端不落盘：probe 通过 heredoc 执行，不写远端文件。
