# 真实环境样例（t6）

本目录是 **2026-11-07 00:50–00:56 CST** 对共享昇腾环境做**只读采集**得到的真实输出，已做最小脱敏，供 t2（数据契约 / fixture）与 t4（解析器 / 演示数据）直接使用。

## 来源与边界

- 采集方式：`ascend-perf/scripts/npu-env.sh probe` + `ssh-ro` 只读命令（详见 `../real-env-report.md` §1）。
- 远端操作全部只读：**未**修改/新增/删除文件，**未**安装包，**未**启停容器或服务，**未**执行 `npu-smi set` / `systemctl` / `pkill` / `reboot` / `sudo`，**未**跑 benchmark，**未**写远端文件。
- 采集目标：`~/.config/ascend-perf/npu.env` 第一个目标（`root@<已脱敏>`）。凭据文件权限 600，**不在本目录**，也不得提交/外发。

## npu-smi 调用链（2026-11-07 01:00 CST 复核）

- `npu-smi info` → **exit 0**，枚举 NPU ID 0–7（8 卡），每卡 2 chip（Phy-ID 0–15，共 16 die）；末尾还有进程段（`No running processes found in NPU x`），**不能按行数统计卡数**。
- 裸 `npu-smi info -t usages` → **exit 215**（缺 `-i`，只打印 help；见 `npu-smi-usages-error.txt`）。
- `npu-smi info -t usages -i 0` … `-i 7` → **逐条 exit 0**（8/8）。
- `-i` 参数是 **card（NPU ID）**，不是 Phy-ID；每卡输出含 2 个 chip 块。
- 缺失值一律 `null`：chip1 的 `Power(W)` 为 `-` → `null`；卡级 power/temp 未提供 → `null`（不要填 0，也不要用 chip0 值代替）。

## 文件清单

| 文件 | 行数 | 内容 | 采集命令 |
|---|---:|---|---|
| `npu-smi-info.txt` | 73 | 8 卡 / 16 die 主表 + 进程表（全部 `No running processes`） | `npu-smi info` |
| `npu-smi-usages-all.txt` | 288 | `CARD 0`–`CARD 7`，每卡 2 个 chip 块 | `for i in 0..7; npu-smi info -t usages -i $i` |
| `npu-smi-usages-error.txt` | 30 | 缺 `-i` 的 help 文本 + `EXIT=215` | `npu-smi info -t usages` |
| `ascend-version.txt` | 36 | `version.cfg` + Python 3.9.9 + `pip show torch/torch_npu`（无 vllm） | `cat .../version.cfg`、`python3 -V`、`pip show` |
| `ps-vllm.txt` | 21 | 20 条 `<defunct>` 的 `[vllm]` / `[VLLM::Worker_PP]` | `ps -eo pid,ppid,etime,cmd \| grep vllm` |
| `ss-listen.txt` | 41 | 39 条 LISTEN（**无 8000**） | `ss -ltnp` |
| `docker-ps.txt` | 39 | 37 个运行中容器 | `docker ps --format table` |
| `system-resources.txt` | 25 | `free -h` + `df -h`（`/mnt/sdb` 99%、NFS 100%） | `nproc`、`free -h`、`df -h` |

规范化结构见 `../fixtures/npu-snapshot.sample.json`（**draft**，最终契约以 t2 为准）。

## 脱敏规则

- SSH 目标地址/端口、NFS 服务端 IP、密钥、token、环境变量值：**均已移除或替换**（NFS 写作 `192.168.0.x`）。
- 主机名保留：`liteserver-hps-805f-00004.novalocal`（内部定位用；外发前建议替换为 `<host-1>`）。
- 容器名 / 镜像仓库域名保留（便于定位工作负载；外发前建议再脱敏）。
- 数值、版本、PID、端口 **未改写**；与本目录中记录一致。

## 使用提示

1. 解析器请覆盖三种输入：`npu-smi info` 表格（每 chip 两行）、`usages` 卡片块、缺参错误（exit 215）。
2. 空值：`-` → `null`；`0 / 0` → `{used:0,total:0}`；`No running processes found in NPU x` → `[]`。
3. `HBM Usage Rate(%)` 是整数截断（4% 对应 4.4%–4.8%），百分比请用 `hbm_used_mb / hbm_total_mb` 计算。
4. 僵尸进程必须过滤，不能计入"运行中 vLLM"。
5. 这是**单次快照**，不是时间序列；不要把 `Ctrlcpu` 等瞬时值当作稳定值。
