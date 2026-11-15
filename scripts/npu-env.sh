#!/usr/bin/env bash
# ============================================================
# ascend-perf / 共享昇腾环境只读接入
#
# 用途：把登录 NPU 的方法集中在这里。默认不执行任何远程命令。
#
# 共享环境规则：
#   - 只读：npu-smi info、ps、ss、df、ls、cat、pip show、docker ps 等
#   - 禁止：修改/新增/删除文件、安装包、启动/停止容器或服务、
#           npu-smi set、systemctl、pkill、reboot、sudo 等
#
# 说明：本脚本不是强制沙箱；npu_ssh_ro 只是只读护栏，团队须遵守约定。
# ============================================================
set -euo pipefail

# ============================================================
# 1) 登录配置：改这里（也可用环境变量或独立 env 文件覆盖）
# ============================================================
# 不要把密码写进本文件，也不要把真实主机/IP/私钥路径写进 ascend-perf/ 目录：
# 本目录会随插件打包，登录信息只允许放在 ~/.config/ascend-perf/（目录 700、文件 600）。
# 目录内的 scripts/npu-ssh.template.md 只是不含真实地址的说明模板。
# 推荐 SSH key / ssh-agent。
NPU_SSH_TARGET="${NPU_SSH_TARGET:-}"          # 例：user@10.0.0.12 或 ~/.ssh/config 里的 alias
NPU_SSH_PORT="${NPU_SSH_PORT:-22}"
NPU_SSH_KEY="${NPU_SSH_KEY:-$HOME/.ssh/id_ed25519}"
NPU_SSH_JUMP="${NPU_SSH_JUMP:-}"              # 例：user@jump-host；没有就留空
NPU_SSH_OPTS="${NPU_SSH_OPTS:-}"              # 额外 ssh 参数，空格分隔
NPU_MODEL_DIR="${NPU_MODEL_DIR:-}"            # 可选：模型目录；probe 时只读 ls

# 可选：从独立文件加载登录信息（建议 chmod 600，且不要提交）
# 新版路径优先；如果之前已按 ascend-tune 建过，则自动兼容旧路径。
NPU_ENV_FILE="${NPU_ENV_FILE:-$HOME/.config/ascend-perf/npu.env}"
if [[ ! -f "$NPU_ENV_FILE" && -f "$HOME/.config/ascend-tune/npu.env" ]]; then
  NPU_ENV_FILE="$HOME/.config/ascend-tune/npu.env"
fi
if [[ -f "$NPU_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$NPU_ENV_FILE"
fi

# ============================================================
# 2) SSH 参数与只读护栏
# ============================================================
SSH_ARGS=(
  -p "$NPU_SSH_PORT"
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=3
  -o StrictHostKeyChecking=accept-new
)
if [[ -n "$NPU_SSH_KEY" && -f "$NPU_SSH_KEY" ]]; then
  SSH_ARGS+=(-i "$NPU_SSH_KEY")
fi
if [[ -n "$NPU_SSH_JUMP" ]]; then
  SSH_ARGS+=(-J "$NPU_SSH_JUMP")
fi
if [[ -n "$NPU_SSH_OPTS" ]]; then
  read -r -a _extra_opts <<< "$NPU_SSH_OPTS"
  SSH_ARGS+=("${_extra_opts[@]}")
fi

npu_ssh() {
  if [[ -z "$NPU_SSH_TARGET" ]]; then
    echo "错误：NPU_SSH_TARGET 未配置。请编辑本脚本顶部，或设置环境变量。" >&2
    return 2
  fi
  ssh "${SSH_ARGS[@]}" "$NPU_SSH_TARGET" "$@"
}

# 只读提醒：明显会改环境或启停服务的命令直接拒绝。
# 注意：这只是护栏，不是强制沙箱；不要用 bash -c 等方式绕过。
DENY_RE='(^|[;&|[:space:]])(sudo|su|rm|rmdir|mv|cp|mkdir|touch|chmod|chown|tee|dd|mount|umount|reboot|shutdown|systemctl|service|pkill|killall|kill|nohup|screen|tmux|vllm[[:space:]]+serve|python[0-9.]*[[:space:]]+-m[[:space:]]+vllm|docker[[:space:]]+(run|start|stop|restart|rm|exec|build|pull|create)|podman[[:space:]]+(run|start|stop|restart|rm|exec|build|pull|create)|npu-smi[[:space:]]+set|pip[0-9.]*[[:space:]]+install|apt(-get)?|yum|dnf|conda[[:space:]]+install)([[:space:]]|$)'

npu_ssh_ro() {
  local cmd="${1:-}"
  if [[ -z "$cmd" ]]; then
    echo "用法：$0 ssh-ro '<只读命令>'" >&2
    return 2
  fi
  if [[ "$cmd" =~ $DENY_RE ]]; then
    echo "拒绝：共享环境只读，命令看起来会修改环境或启停服务。" >&2
    echo "  $cmd" >&2
    return 3
  fi
  npu_ssh "$cmd"
}

# ============================================================
# 3) 只读采集脚本（在远端执行；不写任何远端文件）
# ============================================================
readonly PROBE_SCRIPT="$(cat <<'REMOTE'
set -u
echo "=== host ==="
hostname 2>/dev/null || true
uname -a 2>/dev/null || true
echo "=== npu-smi ==="
if command -v npu-smi >/dev/null 2>&1; then
  npu-smi info 2>&1 || true
else
  echo "npu-smi not found"
fi
echo "=== npu usages ==="
if command -v npu-smi >/dev/null 2>&1; then
  npu-smi info -t usages 2>&1 || true
fi
echo "=== ascend version ==="
for f in /usr/local/Ascend/ascend-toolkit/latest/version.cfg /usr/local/Ascend/ascend-toolkit/latest/version.info; do
  if [ -f "$f" ]; then
    echo "--- $f"
    cat "$f" 2>/dev/null || true
  fi
done
echo "=== python ==="
python3 -V 2>&1 || python -V 2>&1 || true
echo "=== packages ==="
python3 -m pip show torch torch_npu vllm vllm-ascend 2>/dev/null | grep -E '^(Name|Version|Location):' || true
echo "=== running vllm ==="
ps -eo pid,ppid,etime,cmd 2>/dev/null | grep -E 'vllm|VLLM' | grep -v grep | head -20 || true
echo "=== listening ==="
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | head -40 || true
echo "=== containers (read-only) ==="
if command -v docker >/dev/null 2>&1; then
  docker ps --format 'table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}' 2>/dev/null || true
else
  echo "docker not found"
fi
echo "=== cpu/mem/disk ==="
nproc 2>/dev/null || true
free -h 2>/dev/null || true
df -h 2>/dev/null | head -20 || true
echo "=== env (filtered) ==="
env 2>/dev/null | grep -E '^(ASCEND|CANN|VLLM|PYTORCH|HCCL|LD_LIBRARY_PATH)=' | grep -Ev '(TOKEN|KEY|SECRET|PASSWORD|PASSWD)' | sort || true
echo "=== model dir ==="
if [ -n "${NPU_MODEL_DIR:-}" ]; then
  ls -la "$NPU_MODEL_DIR" 2>/dev/null || true
else
  echo "NPU_MODEL_DIR not set"
fi
echo "=== end ==="
REMOTE
)"

probe() {
  local model_dir_q
  model_dir_q=$(printf '%q' "$NPU_MODEL_DIR")
  npu_ssh "NPU_MODEL_DIR=$model_dir_q bash -s" <<< "$PROBE_SCRIPT"
}

# ============================================================
# 4) 本地检查与使用入口
# ============================================================
check() {
  local ok=1
  if [[ -z "$NPU_SSH_TARGET" ]]; then
    echo "缺少 NPU_SSH_TARGET"
    ok=0
  else
    echo "target: $NPU_SSH_TARGET"
  fi
  if [[ -n "$NPU_SSH_KEY" ]]; then
    if [[ -f "$NPU_SSH_KEY" ]]; then
      echo "key: $NPU_SSH_KEY"
    else
      echo "警告：key 不存在：$NPU_SSH_KEY"
    fi
  fi
  if [[ -n "$NPU_SSH_JUMP" ]]; then
    echo "jump: $NPU_SSH_JUMP"
  fi
  echo "未连接远端；本命令只检查本地配置。"
  [[ "$ok" -eq 1 ]] || return 1
}

print_config() {
  echo "NPU_SSH_TARGET=$NPU_SSH_TARGET"
  echo "NPU_SSH_PORT=$NPU_SSH_PORT"
  echo "NPU_SSH_KEY=$NPU_SSH_KEY"
  echo "NPU_SSH_JUMP=$NPU_SSH_JUMP"
  echo "NPU_SSH_OPTS=$NPU_SSH_OPTS"
  echo "NPU_MODEL_DIR=$NPU_MODEL_DIR"
  echo "NPU_ENV_FILE=$NPU_ENV_FILE"
}

usage() {
  cat <<EOF
用法：$0 <command>

  check     仅检查本地配置，不连接远端
  print     打印当前配置（不显示密钥内容）
  probe     通过 SSH 执行只读采集（npu-smi/版本/ps/ss/df/模型目录）
  ssh-ro    执行一条只读命令：$0 ssh-ro 'ps -ef | grep vllm'

共享环境：禁止修改文件、安装包、启动/停止容器或服务、npu-smi set、pkill、reboot 等。
默认不执行任何远端命令；只有显式 probe / ssh-ro 才会连接。
EOF
}

main() {
  case "${1:-}" in
    check)
      check
      ;;
    print)
      print_config
      ;;
    probe)
      probe
      ;;
    ssh-ro)
      shift
      npu_ssh_ro "$*"
      ;;
    ""|-h|--help|help)
      usage
      ;;
    *)
      echo "未知命令：$1" >&2
      usage
      exit 2
      ;;
  esac
}

main "$@"
