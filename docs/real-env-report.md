# 昇腾共享环境只读采集报告（t6）

> - **状态**：已完成（只读采集，无远端写入）
> - **采集时间**：2026-11-07 00:50–00:56 CST（本地时钟）
> - **执行**：开发者（AgentTeams 任务 t6，attempt 3）
> - **目标**：`~/.config/ascend-perf/npu.env` 中的第一个 SSH 目标（`root@<已脱敏>`，端口 `<已脱敏>`）
> - **授权**：captain 于 2026-11-07 00:53 转达用户纠正后的授权——"允许 SSH 连接与只读读取环境；禁止修改、新增、启动/停止容器或服务、跑 benchmark/压测、写远端。只执行 `ascend-perf/scripts/npu-env.sh probe` 的只读命令（npu-smi info / info -t usages、版本查询、ps、ss、df/free、ls/cat、pip show、docker ps）"。
> - **读者**：t2（数据契约 / fixture）、t4（实现 / 演示数据）、t5（只读安全审查）、t7（二期方案）。

**结论先行**：采集通道可用。目标环境是 **8 × Ascend910、16 个 die（每卡 2 chip）** 的共享 aarch64 主机，npu-smi 26.1.1、CANN 8.1.RC2、torch 2.8.0 + torch_npu 2.8.0.post4、Python 3.9.9；当前为**空闲态**（AICore/NPU 利用率 0%、每 die HBM 约 4%、45–49°C、chip0 功率 160–188W）。宿主侧**没有活跃的 vLLM 服务**（`ps` 中 20 条 `<defunct>` 僵尸、`ss` 无 8000 端口），负载都在 **37 个运行中容器**里，镜像以 `vllm-ascend`（v0.18.0rc1-a3 至 v0.30.0rc2-a5）为主。磁盘 `/mnt/sdb` 已用 99%（剩 114G），NFS 挂载点 100%。

本次采集的原始输出已整理为 `ascend-perf/docs/samples/` 下 8 个数据样例（另有 `README.md` 说明来源与脱敏规则），并据此生成一份**建议的规范化快照** `ascend-perf/docs/fixtures/npu-snapshot.sample.json`（供 t2 定稿契约、t4 做解析与无 NPU 演示）。

---

## 0. 摘要（TL;DR）

1. **平台**：`Ascend910` × 8 卡，每卡 2 chip（Phy-ID 0–15），全部 `Health=OK`；`npu-smi` 26.1.1（board Software Version 26.1.1、Firmware 9.0.0.9.220、Compatibility OK）；Product Name / Model / Serial 均为 `NA`。
2. **软件栈**：CANN `8.1.RC2`（version.cfg 中 8 类组件 running/upgrade/installed 全为 `[7.7.0.3.220:8.1.RC2]`）；Python 3.9.9；torch 2.8.0、torch_npu 2.8.0.post4；**宿主未安装 vllm / vllm-ascend**（`pip show` 无输出）。
3. **当前负载**：AICore Usage Rate 全 0%、NPU Utilization 全 0%；每 die HBM Usage Rate 4%（info 表显示 2882–3164 / 65536 MB）；温度 45–49°C；chip0 功率 160.2–188.3W，chip1 功率显示 `-`。
4. **运行态**：宿主 `ps` 只有 20 条 defunct 的 vLLM 残留进程；`ss` 无 8000/其他 vLLM 端口；`docker ps` 有 **37 个运行中容器**，其中 `vllm-ascend` 系列镜像分布在 **7 个 tag** 上（v0.18.0rc1-a3、v0.23.0-a3、v0.27.1rc1-a3、v0.30.0-a3、v0.30.0rc1-a3、v0.30.0rc2-a3、v0.30.0rc2-a5），另有 k8s（kindest-node）、mooncake、xllm、headlamp 等。
5. **模型目录**：`/mnt/sdb/models` 共 44 个条目（其中 **35 个模型目录**，其余为 venv/`kernel_meta`/`log` 等）；`root:root 755`，个别目录 750/700；`/mnt/sdb/datasets` 为空；`NPU_MODEL_DIR` 未设置。
6. **资源**：CPU 192 核；内存 2.0Ti（used 370Gi、available 1.5Ti、Swap 0）；`/` 491G 60%、`/mnt/sdb` 9.7T **99%**（114G 可用）、`/dev/shm` 1006G 4%、NFS 挂载点 **100%**。
7. **环境变量**：probe 的 env 过滤结果为空（非交互 SSH 不加载 profile）；因此 `ASCEND_HOME_PATH`、`LD_LIBRARY_PATH`、`VLLM_*` 等**未采集**，报告中不做推断（见 §2.7）。
8. **解析要点**：正确调用链是**先 `npu-smi info`（exit 0）枚举 8 个 NPU ID，再逐卡 `npu-smi info -t usages -i N`（N=NPU ID，8/8 exit 0）**；裸 `npu-smi info -t usages` 会打印 help 并返回 **exit 215**。`npu-smi info` 为"每 chip 两行"的固定宽度表格（第二行重复 NPU 号、Name/Health/Power 留空或 `-`）；**8 卡 = 16 chip，卡数按 NPU ID 去重、chip 数按 Phy-ID 去重，不可按行数统计**；`HBM Usage Rate(%)` 是整数截断（3131/65536=4.78% 显示 4%）；缺失的功率/温度一律 `null`，不填 0。
9. **可用性结论**：可直接用真实快照做无 NPU 演示数据；但"容器内 vLLM 版本 / 端点 / KV cache 配置 / benchmark"必须等后续授权（`docker inspect/exec`、日志、压测），当前一律标记为未知。

---

## 1. 连接与执行记录

### 1.1 执行方式

- 凭据来自 `~/.config/ascend-perf/npu.env`（权限 600）与 `~/.config/ascend-perf/npu-ssh.md`（权限 600，已移出插件目录），**未写入本报告、未进入样本文件、未外发**。
- 采集通过 `ascend-perf/scripts/npu-env.sh`（`probe` / `ssh-ro` 子命令）执行；脚本内置 `DENY_RE` 拦截 `sudo/rm/mv/chmod/systemctl/pkill/docker run` 等写类命令，`probe` 以 heredoc 传入远端 `bash -s`，**不写远端文件**。

### 1.2 命令与结果

| # | 命令（远端，只读） | 结果 |
|---|---|---|
| 1 | `bash ascend-perf/scripts/npu-env.sh probe` | exit 0；273 行 / 24707 B 输出，保存于 `/tmp/npu-probe/raw.txt`（本地临时目录，未入库） |
| 2 | `hostname; uname -a` | 成功 |
| 3 | `npu-smi info` | **exit 0**；主表 8 个 NPU ID（0–7）× 2 chip = 16 die；末尾进程段 8 行 |
| 4 | `npu-smi info -t usages`（无 `-i`） | **exit 215** + usage 帮助文本（作为错误样例保留） |
| 5 | `for i in 0 1 2 3 4 5 6 7; do npu-smi info -t usages -i $i; done` | 逐条 **exit 0**（2026-11-07 01:00 复核：8/8 成功，共 16 个 chip 块） |
| 6 | `npu-smi info -t board -i 0` | 成功（版本查询：Software/Firmware/Board ID/PCIe） |
| 7 | `cat /usr/local/Ascend/ascend-toolkit/latest/version.cfg` | 成功（CANN 版本） |
| 8 | `python3 -V`；`python3 -m pip show torch torch_npu vllm vllm-ascend` | Python 3.9.9；torch / torch_npu 有；vllm / vllm-ascend 无输出（未安装） |
| 9 | `ps -eo pid,ppid,etime,cmd \| grep vllm` | 20 条 `<defunct>` |
| 10 | `ss -ltnp` | 成功（39 条 LISTEN） |
| 11 | `docker ps --format table` | 成功（37 个运行中容器） |
| 12 | `nproc; free -h; df -h` | 成功 |
| 13 | `env`（过滤 ASCEND/CANN/VLLM/NPU） | 空 |
| 14 | `ls -l /dev/davinci* /dev/davinci_manager /dev/devmm_svm /dev/hisi_hdc` | 成功 |
| 15 | `ls -la /mnt/sdb`；`ls -la /mnt/sdb/models`；`ls -la /mnt/sdb/datasets` | 成功 |
| 16 | `ls -la /root`；`ls -la /home` | 成功（仅一级列表） |

**usages 调用链（实际 argv 与退出码，2026-11-07 01:00 CST 复核）**：

```bash
npu-smi info                    # exit 0 → 枚举 NPU ID 0–7（8 卡），每卡 2 chip
npu-smi info -t usages          # exit 215（缺 -i；输出 help，不能当数据）
npu-smi info -t usages -i 0     # exit 0
npu-smi info -t usages -i 1     # exit 0
# … 依次到 7 …
npu-smi info -t usages -i 7     # exit 0
```

> 要点：`-i` 的参数是 **card（NPU ID，0–7）**，不是 Phy-ID；每个 card 的 usages 输出内含 `Chip Count = 2` 的两个 chip 块。因此**必须先 `npu-smi info` 枚举 card，再逐卡调用 `-t usages -i N`**；不能直接裸调 `-t usages`（exit 215）。

### 1.3 连接层输出（stderr）

每次 SSH 仅出现 OpenSSH 的提示，**不是采集失败**：

```
** WARNING: connection is not using a post-quantum key exchange algorithm.
** This session may be vulnerable to "store now, decrypt later" attacks.
** The server may need to be upgraded. See https://openssh.com/pq.html
```

### 1.4 SSH 失败 / 无权限情况

- 本次 **未发生** SSH 失败或权限拒绝；未出现 `Permission denied`、`Connection timed out`、`Host key verification failed`。
- 唯一的非零退出是**预期错误**：`npu-smi info -t usages` 缺少 `-i` → exit 215（详见 §3.3）。
- 若未来失败，应按同样格式记录：完整命令、exit code、stderr 原文、已尝试的只读命令清单；**不得猜测环境状态、不得尝试提权或绕过**。

---

## 2. 事实表

### 2.1 平台与版本

| 项目 | 值 | 来源 |
|---|---|---|
| 主机名 | `liteserver-hps-805f-00004.novalocal` | `hostname` |
| 内核 / 架构 | `5.10.0-182.0.0.95.r2220_157.hce2.aarch64` / `aarch64` | `uname -a` |
| NPU 型号 | `Ascend910`（`npu-smi info` 的 Name 列） | `npu-smi info` |
| 卡数 / die 数 | 8 卡 / 16 chip（每卡 2 chip，Phy-ID 0–15）；**卡数按 NPU ID 去重、chip 数按 Phy-ID 去重，不可按输出行数计数** | `npu-smi info` |
| 健康状态 | 16/16 `OK` | `npu-smi info` |
| npu-smi | `26.1.1` | `npu-smi info` 首行 |
| Board Software Version | `26.1.1` | `npu-smi info -t board -i 0` |
| Firmware Version | `9.0.0.9.220` | `npu-smi info -t board -i 0` |
| Compatibility | `OK` | `npu-smi info -t board -i 0` |
| Product Name / Model / Serial | `NA` / `NA` / `NA`（共享/虚拟化环境常见） | `npu-smi info -t board -i 0` |
| Board / Main Board / PCB / BOM | `0x71` / `0x18` / `B` / `2` | `npu-smi info -t board -i 0` |
| PCI Vendor / Device | `0x19E5` / `0xD803`；Subsystem `0x19E5` / `0x3001` | `npu-smi info -t board -i 0` |
| CANN | `8.1.RC2`（build `7.7.0.3.220`；8 类组件 running/upgrade/installed 全一致） | `cat .../version.cfg` |
| Python | `3.9.9` | `python3 -V` |
| torch | `2.8.0`（`/usr/local/lib64/python3.9/site-packages`） | `pip show` |
| torch_npu | `2.8.0.post4`（同上路径） | `pip show` |
| vLLM / vLLM-Ascend | **宿主未安装**（`pip show` 无输出） | `pip show` |
| CPU / 内存 | 192 核；2.0Ti（used 370Gi / free 97Gi / available 1.5Ti / Swap 0） | `nproc`、`free -h` |

> 补充线索（**不作为结论**）：`/root` 下存在 `Atlas-A3-hdk-npu-firmware_9.0.0.9.220.run`，容器镜像 tag 多带 `a3`，与 A3 平台一致；但 `npu-smi info -t board` 的 Product/Model 为 `NA`，因此报告不把"具体整机型号"写成事实。

### 2.2 NPU 拓扑与实时状态（`npu-smi info`，8 卡 16 die）

| NPU | Chip | Phy-ID | Bus-Id | Health | Power(W) | Temp(°C) | AICore(%) | Memory(MB) | HBM(MB) | Hugepages |
|---:|---:|---:|---|---|---:|---:|---:|---|---|---|
| 0 | 0 | 0 | 0000:9D:00.0 | OK | 165.5 | 49 | 0 | 0 / 0 | 3131 / 65536 | 0 / 0 |
| 0 | 1 | 1 | 0000:9F:00.0 | OK | - | 47 | 0 | 0 / 0 | 2892 / 65536 | 0 / 0 |
| 1 | 0 | 2 | 0000:99:00.0 | OK | 163.9 | 47 | 0 | 0 / 0 | 3123 / 65536 | 0 / 0 |
| 1 | 1 | 3 | 0000:9B:00.0 | OK | - | 48 | 0 | 0 / 0 | 2891 / 65536 | 0 / 0 |
| 2 | 0 | 4 | 0000:95:00.0 | OK | 160.2 | 48 | 0 | 0 / 0 | 3124 / 65536 | 0 / 0 |
| 2 | 1 | 5 | 0000:97:00.0 | OK | - | 46 | 0 | 0 / 0 | 2892 / 65536 | 0 / 0 |
| 3 | 0 | 6 | 0000:91:00.0 | OK | 163.7 | 47 | 0 | 0 / 0 | 3140 / 65536 | 0 / 0 |
| 3 | 1 | 7 | 0000:93:00.0 | OK | - | 47 | 0 | 0 / 0 | 2882 / 65536 | 0 / 0 |
| 4 | 0 | 8 | 0000:8D:00.0 | OK | 188.3 | 48 | 0 | 0 / 0 | 3164 / 65536 | 0 / 0 |
| 4 | 1 | 9 | 0000:8F:00.0 | OK | - | 46 | 0 | 0 / 0 | 2882 / 65536 | 0 / 0 |
| 5 | 0 | 10 | 0000:89:00.0 | OK | 171.3 | 48 | 0 | 0 / 0 | 3124 / 65536 | 0 / 0 |
| 5 | 1 | 11 | 0000:8B:00.0 | OK | - | 48 | 0 | 0 / 0 | 2892 / 65536 | 0 / 0 |
| 6 | 0 | 12 | 0000:85:00.0 | OK | 165.0 | 48 | 0 | 0 / 0 | 3123 / 65536 | 0 / 0 |
| 6 | 1 | 13 | 0000:87:00.0 | OK | - | 48 | 0 | 0 / 0 | 2893 / 65536 | 0 / 0 |
| 7 | 0 | 14 | 0000:81:00.0 | OK | 164.8 | 45 | 0 | 0 / 0 | 3126 / 65536 | 0 / 0 |
| 7 | 1 | 15 | 0000:83:00.0 | OK | - | 46 | 0 | 0 / 0 | 2893 / 65536 | 0 / 0 |

要点：
- **每卡两个 chip**，每个 chip 独立一行 `Phy-ID/Bus-Id`；chip1 行的 `Power(W)` 为 `-`，`Temp` 与 chip0 不同（如 49 vs 47）。
- `Memory(MB)`（DDR）全部 `0 / 0`，显存只有 HBM：`65536 MB`/die，16 die 合计 **1 TiB**。
- 已用 HBM 合计约 **48.2 GB（≈4.6%）**：chip0 合计 25055 MB、chip1 合计 23117 MB。
- chip0 功率合计约 **1342.7W**（8 卡）；chip1 功率缺失，**不能**用 8×2 估算总功率。
- 进程表：8 个 NPU 全部为 `No running processes found in NPU x`（见 §2.4 与 §6.2 的"HBM 占用但无进程"待解释项）。

### 2.3 每卡 usages（`npu-smi info -t usages -i N`）

| Card | Chip | HBM Capacity(MB) | HBM Usage Rate(%) | Aicore | Aivector | Aicpu | Ctrlcpu | DDR/HBM BW | NPU Util | Aicube |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 0 / 1 | 65536 / 65536 | 4 / 4 | 0 / 0 | 0 / 0 | 0 / 0 | 7 / 7 | 0 / 0 | 0 / 0 | 0 / 0 |
| 1 | 0 / 1 | 65536 / 65536 | 4 / 4 | 0 / 0 | 0 / 0 | 0 / 0 | 3 / 4 | 0 / 0 | 0 / 0 | 0 / 0 |
| 2 | 0 / 1 | 65536 / 65536 | 4 / 4 | 0 / 0 | 0 / 0 | 0 / 0 | 6 / 3 | 0 / 0 | 0 / 0 | 0 / 0 |
| 3 | 0 / 1 | 65536 / 65536 | 4 / 4 | 0 / 0 | 0 / 0 | 0 / 0 | 3 / 1 | 0 / 0 | 0 / 0 | 0 / 0 |
| 4 | 0 / 1 | 65536 / 65536 | 4 / 4 | 0 / 0 | 0 / 0 | 0 / 0 | 6 / 7 | 0 / 0 | 0 / 0 | 0 / 0 |
| 5 | 0 / 1 | 65536 / 65536 | 4 / 4 | 0 / 0 | 0 / 0 | 0 / 0 | 8 / 2 | 0 / 0 | 0 / 0 | 0 / 0 |
| 6 | 0 / 1 | 65536 / 65536 | 4 / 4 | 0 / 0 | 0 / 0 | 0 / 0 | 7 / 4 | 0 / 0 | 0 / 0 | 0 / 0 |
| 7 | 0 / 1 | 65536 / 65536 | 4 / 4 | 0 / 0 | 0 / 0 | 0 / 0 | 6 / 2 | 0 / 0 | 0 / 0 | 0 / 0 |

要点：
- 每 chip 的 `DDR Capacity(MB)=0`、`Hugepages Total=0 / Usage Rate=0`。
- `HBM Usage Rate` 全为 **4%**；但 `info` 表按 MB 计算是 **2882–3164 / 65536 = 4.4%–4.8%**，属于**整数截断**（不是异常）。
- `Ctrlcpu` 为瞬时值：同一张卡两次采样出现 `6/2` → `7/7` 的变化；面板需保留 `captured_at`，并注明"瞬时采样"。
- `Aicore/Aivector/Aicpu/Aicube/NPU Utilization` 全 0 → 当前无计算负载。

### 2.4 运行态：进程、端口、容器

#### 2.4.1 vLLM 进程（宿主 `ps`）

20 条全部为 `<defunct>`（僵尸），**没有活跃 vLLM 进程**：

| 类型 | PID | 父 PID | 存活时长（etime） |
|---|---|---|---|
| `[vllm]` | 35177 / 83417 / 129371 | 4037001 | 9天5小时 / 9天5小时 / 8天1小时 |
| `[vllm]` | 51913 / 166618 | 3785264 | 12天3小时 |
| `[VLLM::Worker_PP]` | 138609, 141288, 144065, 146539, 149065, 152113, 155065, 157923, 160574, 163473, 166285, 169577, 172784, 175365, 177986 | 4037001 | 约 8天1小时（依次递减） |

> 僵尸进程不占 CPU/NPU，但会占用 PID 表；本报告**不做清理建议**（清理属于写操作，禁止）。

#### 2.4.2 监听端口（`ss -ltnp`，39 条 LISTEN，节选）

| 地址 | 进程 | 说明 |
|---|---|---|
| `0.0.0.0:443` | docker-proxy | 容器映射 |
| `0.0.0.0:30080` / `0.0.0.0:30081` | systemd / docker-proxy | 控制面 |
| `0.0.0.0:50088` / `0.0.0.0:9003` | mooncake_master（pid 3797944） | mooncake 传输 |
| `0.0.0.0:9004` | python3（pid 1473420） | 业务/代理 |
| `127.0.0.1:5000` / `127.0.0.1:8090` | python3（pid 1683535） | 本地服务 |
| `127.0.0.1:8765` / `127.0.0.1:18080` | python3 | 本地服务 |
| `127.0.0.1:2380` | etcd | 控制面 |
| `127.0.0.1:3080` | MainThread | 本地服务（与本地 DSH Web 端口同号，纯属巧合） |
| `127.0.0.1:25317` | docker-proxy | 映射 |

**没有 8000 或常见 vLLM serving 端口**。容器网络命名空间与宿主隔离（未执行 `docker inspect`，属常规推断），宿主 `ss` 看不到容器内监听；因此"服务端点"不能只靠宿主 `ss` 发现。

#### 2.4.3 容器（`docker ps`，37 个运行中）

镜像分布（按 tag 聚合）：

| 镜像 | 数量 | 备注 |
|---|---:|---|
| `quay.io/ascend/vllm-ascend:v0.30.0rc1-a3` | 7 | 最新 rc1 主线，多为 `lln_*` / `vllm-ren` / `cdw-vllm-30` |
| `quay.nju.edu.cn/ascend/vllm-ascend:v0.23.0-a3` | 6 | `ali`、`niming-*`、`lmcache-*`、`vllm-ascend-jjy` |
| `docker.cnb.cool/.../kindest-node` | 4 | `tts-cloud-*`（k8s control-plane/worker） |
| `quay.nju.edu.cn/ascend/vllm-ascend:v0.30.0rc2-a3` | 3 | `ipr-vllm`、`lwq_xlite`、`dsv41-flash-pd` |
| 镜像 ID `7b485a6e417b` | 3 | `lmcache-mp-p2p-c00948744`、`cdw-vllm`、`ks-pp-m12-priv` |
| `quay.nju.edu.cn/ascend/vllm-ascend:v0.18.0rc1-a3` | 2 | `ram-a-memcache`、`ram-a-agentpage` |
| `quay.nju.edu.cn/ascend/vllm-ascend:v0.30.0-a3` | 1 | `vllm-ascend-jjy-030`（Up 4 days） |
| `quay.nju.edu.cn/ascend/vllm-ascend:v0.27.1rc1-a3` | 1 | `vllm27`（Up 2 weeks） |
| `quay.nju.edu.cn/ascend/vllm-ascend`（无 tag） | 1 | `gqx-policy4-graph-12-20261013` |
| `quay.io/ascend/vllm-ascend:v0.30.0rc2-a5` | 1 | `lln_a5` |
| `quay.io/jd_xllm/xllm-ai:xllm-dev-a3-arm-cann9-20260801` | 1 | `xllm-ren` |
| `ram-a-ucm-czt:migrate-20261010` / `sijie-dev:base` / `qwen-ren-mig:20261031` | 各 1 | 自定义镜像 |
| `.../third-party/headlamp:v0.45.0` / `aiserver-agent:1.2.0` | 各 1 | 工具 |
| 镜像 ID `ce42d65b2403` / `7b407f27e8e2` | 各 1 | `lln_vllm_30` / `lln` |

运行时长跨度：4 小时（`ipr-vllm`）到 3 周（`lln_vllm_30_rc1`、`tts-cloud-*`、`headlamp`），说明是长期共享环境。

### 2.5 CPU / 内存 / 磁盘

| 项目 | 值 |
|---|---|
| CPU | 192 核（`nproc`） |
| 内存 | total 2.0Ti；used 370Gi；free 97Gi；shared 43Gi；buff/cache 1.5Ti；available 1.5Ti；Swap 0 |
| `/`（`/dev/sda2`） | 491G，used 281G，avail 190G，**60%** |
| `/mnt/sdb`（`/dev/sdb`） | 9.7T，used 9.1T，avail **114G**，**99%** |
| `/dev/shm` | 1006G，used 33G，4% |
| `/tmp` | 1006G，used 6.6G，1% |
| `/boot/efi` | 1022M，used 7.9M，1% |
| NFS（`192.168.0.x:/mnt/sdb/gw/...`，4 个挂载点） | 9.7T，used 9.2T，avail 40G，**100%** |
| overlay（`/mnt/sdb/docker/overlay2/*/merged`，7 个） | 9.7T，9.1T，114G，**99%** |

结论：**存储余量非常紧张**。任何"跑 benchmark 并落盘"的动作都可能失败或影响他人；MVP 演示数据应只读、小体积、写入本地。

### 2.6 设备与目录

- `/dev`：`davinci0`–`davinci15` 共 16 个字符设备（`crw-rw-rw- HwHiAiUser`），另有 `/dev/davinci_manager`、`/dev/devmm_svm`、`/dev/hisi_hdc`。
- `/mnt/sdb`：47 个一级条目，包括 `Ascend`、`atc_data`、`datasets`（空）、`models`、`docker`、`gw`、`shared`、`.cache`、`.config` 以及大量用户目录（`cdw`、`csy`、`czt`、`jjy`、`lln`、`lwq`、`mengzi`、`qr`、`ren`、`sijie`、`junyi` 等）。
- `/mnt/sdb/models`：`root:root 755`，44 个条目；其中 **35 个模型目录**，其余为 venv 结构（`bin`、`include`、`lib`、`lib64`、`pyvenv.cfg`、`runtime`）与 `kernel_meta`（337 个子目录，750）、`log`（301 个子目录）、`extra-info`（700）。
- `/root`：`ascend/`、`Ascend/`、`atc_data/`、`Atlas-A3-hdk-npu-firmware_9.0.0.9.220.run` 及若干实验目录（仅一级列表，未深入）。
- `/home`：30 个用户目录，含 `cdw`、`csy`、`czt`、`daily_aisbench_reports`、`daily_reports`、`logs`、`HwHiAiUser` 等。

模型目录清单（`/mnt/sdb/models`，按家族分组）：

| 家族 | 目录 |
|---|---|
| DeepSeek | `DeepSeek-V3.1-w8a8-mtp-QuaRot`、`DeepSeek-V3.2-W8A8`、`DeepSeek-V4.1-Flash-w8a8`、`DeepSeek-V4-Flash-0731-w8a8`、`DeepSeek-V4-Flash-w8a8-mtp` |
| GLM | `GLM-5.1-w8a8`、`GLM-5.1-w8a8c8-MTP`、`GLM-5.2-MTP`、`GLM-5.2-W4A8`、`GLM-5.2-w8a8`、`GLM-5.3-Flash-w8a8`、`GLM-5-w4a8`（750） |
| Qwen | `Qwen3-0.6B`、`Qwen3-8B`、`Qwen3-32B`、`Qwen3-30B-A3B`、`Qwen3-30B-A3B-Instruct-2507`、`Qwen3-30B-A3B-Instruct-2507-W8A8`、`Qwen3-30B-A3B-W8A8-vllm-ascend`、`Qwen3-4B-Instruct-2507`、`Qwen3-8B-DFlash-b16`、`Qwen3-a3B_eagle3`、`Qwen3.5-0.8B`、`Qwen3.5-9B`、`Qwen3.5-35B-A3B`、`Qwen3.5-122B-A10B`、`Qwen3.6-35B-A3B-clawgym-merged-v1`、`Qwen3-VL-8B-Instruct-w8a8-QuaRot`、`Qwen3-VL-30B-A3B-Instruct` |
| 其他 | `Llama-2-7b-chat-hf`、`Llama2-Chinese-13b-Chat`、`MiniMax-M2.7-w8a8-QuaRot`、`dspark_qwen3_8b_block7` |
| 投机解码 | `EAGLE3-Qwen3-235B-A22B-Instruct-2507-nebius`、`EAGLE3-Qwen3-30B-A3B-Instruct-2507-RedHatAI` |

> 量化格式集中在 W8A8/W4A8 + MTP/QuaRot，与 Ascend 推理的常见部署一致；这些只是目录名，**未读取模型配置，不推断实际精度**。

### 2.7 关键环境变量

- `probe` 的 env 过滤结果为**空**（非交互 SSH 不加载 `/etc/profile`、`/etc/profile.d/*`、`~/.bashrc`）。
- 因此以下变量**未采集**：`ASCEND_HOME_PATH`、`ASCEND_TOOLKIT_HOME`、`LD_LIBRARY_PATH`、`PYTHONPATH`、`VLLM_*`、`HCCL_*`、`RANK_TABLE_FILE` 等。
- 采集方案（均待授权，见 §7）：登录 shell 读取（会执行 rc 脚本）、`cat set_env.sh`（只读但只反映脚本值）、`docker inspect`（容器 env，最准确）。
- **当前结论**：环境变量维度 = `unknown`，面板不得默认写死路径或从版本号反推。

---

## 3. 原始样例（供 t2 / t4 fixture）

所有样例均为**真实输出**（未改写数值），已做最小脱敏：不含 IP、SSH 目标、密钥、环境变量值；主机名保留以便内部定位（外发前建议替换）。文件名与用途：

| 文件 | 内容 | 建议用途 |
|---|---|---|
| `ascend-perf/docs/samples/npu-smi-info.txt` | `npu-smi info` 完整表（8 卡 16 die + 进程表） | 解析器主 fixture（两行/chip、`-` 空值、空进程） |
| `ascend-perf/docs/samples/npu-smi-usages-all.txt` | `npu-smi info -t usages -i 0..7` | 每卡 usages 解析 fixture（16 个 chip 块） |
| `ascend-perf/docs/samples/npu-smi-usages-error.txt` | 裸 `npu-smi info -t usages` 的 help + `EXIT=215` | 错误路径 fixture（缺 `-i`） |
| `ascend-perf/docs/samples/ascend-version.txt` | `version.cfg` + Python + `pip show` | 版本解析 fixture |
| `ascend-perf/docs/samples/ps-vllm.txt` | 20 条 defunct 进程 | 僵尸过滤 fixture |
| `ascend-perf/docs/samples/ss-listen.txt` | 39 条 LISTEN | 端口/服务发现 fixture（含"无 8000"） |
| `ascend-perf/docs/samples/docker-ps.txt` | 37 个容器 | 容器/镜像版本画像 fixture |
| `ascend-perf/docs/samples/system-resources.txt` | `free -h` + `df -h` | 资源卡片 + 磁盘告警 fixture |
| `ascend-perf/docs/fixtures/npu-snapshot.sample.json` | 上述数据的**建议规范化结构**（draft） | t2 定契约、t4 解析输出对照、无 NPU demo 数据 |

### 3.1 `npu-smi info` 片段（卡 0 与卡 7）

```
+------------------------------------------------------------------------------------------------------------------+
| npu-smi 26.1.1                              Version: 26.1.1                                                      |
+---------------------------+---------------+----------------------------------------------------------------------+
| NPU   Name                | Health        | Power(W)             Temp(C)                 Hugepages-Usage(page)   |
| Chip  Phy-ID              | Bus-Id        | AICore(%)            Memory-Usage(MB)        HBM-Usage(MB)           |
+===========================+===============+======================================================================+
| 0     Ascend910           | OK            | 165.5                49                      0    / 0                |
| 0     0                   | 0000:9D:00.0  | 0                    0    / 0                3131 / 65536            |
+------------------------------------------------------------------------------------------------------------------+
| 0     Ascend910           | OK            | -                    47                      0    / 0                |
| 1     1                   | 0000:9F:00.0  | 0                    0    / 0                2892 / 65536            |
+===========================+===============+======================================================================+
...
| 7     Ascend910           | OK            | 164.8                45                      0    / 0                |
| 0     14                  | 0000:81:00.0  | 0                    0    / 0                3126 / 65536            |
+------------------------------------------------------------------------------------------------------------------+
| 7     Ascend910           | OK            | -                    46                      0    / 0                |
| 1     15                  | 0000:83:00.0  | 0                    0    / 0                2893 / 65536            |
+===========================+===============+======================================================================+
| No running processes found in NPU 0                                                                              |
...
| No running processes found in NPU 7                                                                              |
```

### 3.2 `npu-smi info -t usages -i 0` 片段

```
	NPU ID                         : 0
	Chip Count                     : 2

	DDR Capacity(MB)               : 0
	DDR Usage Rate(%)              : 0
	DDR Hugepages Total(page)      : 0
	DDR Hugepages Usage Rate(%)    : 0
	HBM Capacity(MB)               : 65536
	HBM Usage Rate(%)              : 4
	Aicore Usage Rate(%)           : 0
	Aivector Usage Rate(%)         : 0
	Aicpu Usage Rate(%)            : 0
	Ctrlcpu Usage Rate(%)          : 7
	DDR Bandwidth Usage Rate(%)    : 0
	HBM Bandwidth Usage Rate(%)    : 0
	NPU Utilization(%)             : 0
	Aicube Usage Rate(%)           : 0
	Chip ID                        : 0

	（chip 1 同结构，Chip ID : 1）
```

### 3.3 错误样例（裸 `npu-smi info -t usages`）

```
This command must input card id.

Usage: npu-smi info <watch|proc|-h|-m|-l|-t type> [Options...]
...
Options:
       -i %d          Card ID
       -c %d          Chip ID
       -p %d          Chip Physical ID
EXIT=215
```

**解析器要求**：不能把 help 文本当数据；必须先看 exit code（215 → 参数错误），并提示"需要 `-i <card>`"。

### 3.4 版本片段

```
# version: 1.0
runtime_running_version=[7.7.0.3.220:8.1.RC2]
compiler_running_version=[7.7.0.3.220:8.1.RC2]
hccl_running_version=[7.7.0.3.220:8.1.RC2]
opp_running_version=[7.7.0.3.220:8.1.RC2]
toolkit_running_version=[7.7.0.3.220:8.1.RC2]
aoe_running_version=[7.7.0.3.220:8.1.RC2]
ncs_running_version=[7.7.0.3.220:8.1.RC2]
opp_kernel_running_version=[7.7.0.3.220:8.1.RC2]
（upgrade_* / installed_* 同值）
```

### 3.5 容器片段

```
CONTAINER ID   IMAGE                                                     STATUS        NAMES
dd42218803dc   quay.nju.edu.cn/ascend/vllm-ascend:v0.30.0rc2-a3          Up 4 hours    ipr-vllm
7c79d2fae6be   quay.nju.edu.cn/ascend/vllm-ascend:v0.23.0-a3             Up 6 hours    ali
16ce00ff8664   quay.nju.edu.cn/ascend/vllm-ascend:v0.18.0rc1-a3          Up 29 hours   ram-a-memcache
...
```

---

## 4. 可用性结论

### 4.1 可直接用于 MVP 的部分

| 能力 | 依据 | 备注 |
|---|---|---|
| 8 卡 16 die 的真实空闲快照 | §2.2 / §2.3 | 可直接作为"无 NPU 演示数据"，比虚构数据可信 |
| 解析三种真实输入形态 | `info` 表格 / `usages` 卡片级 / 错误 215 | 已提供对应 fixture，覆盖 happy path + 错误路径 |
| 版本画像 | npu-smi / Software / Firmware / CANN / torch / torch_npu / Python | 真实值，可直接展示 |
| 容器镜像版本画像 | `docker ps` 只读 | 轻量、可长期采集，但只是"镜像线索"，不是"运行中 vLLM 版本" |
| 资源余量卡片 | `free -h` / `df -h` | 可直接展示磁盘告警（99%/100%） |
| 进程僵尸识别 | `ps` 20 条 `<defunct>` | 可作为"脏数据/异常洞察"的演示素材 |

### 4.2 不能确认、必须标注 unknown 的部分

| 项 | 原因 | 面板处理 |
|---|---|---|
| 容器内 vLLM / vLLM-Ascend 版本 | 宿主未安装；容器内未查询（`docker inspect/exec` 未授权） | 展示"未知"，可附镜像 tag 作为线索 |
| 活跃 serving 端点（8000 等） | 宿主 `ss` 看不到容器 netns；未做容器网络探测 | 端点字段 `unknown`，禁止自动 HTTP 探测 |
| 启动参数 / KV cache / 并行配置 | 需 `docker inspect` / 进程 cmdline（容器内） | 不展示或标注"未采集" |
| `ASCEND_*`/`VLLM_*` 环境变量 | 非交互 SSH 为空 | 字段 `null` + 说明 |
| "HBM 4% 但无进程" | 可能是预留/未释放/容器内进程未显示，证据不足 | 标注 `unexplained`，**不判定为泄漏** |
| 吞吐 / 时延 / 算力利用率真实值 | 未跑 benchmark（禁止） | 演示数据须标注"合成"或"空闲快照" |

### 4.3 风险与注意事项

1. **存储**：`/mnt/sdb` 99%、NFS 100%——任何落盘都可能失败或影响共享环境；MVP 演示数据应写入本地。
2. **共享性**：37 个容器、多用户目录、NFS 同源；采集必须限频（建议 ≥5s/次）、可关闭、只读，默认不自动连接真实环境。
3. **权限**：模型目录多为 root 可读，个别 750/700；非 root 采集会受限（本次为 root）。
4. **凭据**：`~/.config/ascend-perf/` 下的 `npu.env` / `npu-ssh.md` 均 600（且不在插件目录内）；不得进 git、不得外发、不得写入报告。
5. **安全边界**：本次仅执行白名单只读命令；`npu-env.sh` 的 `DENY_RE` 仍应作为 Host 工具的第一道防线，并在插件层再做一次只读命令白名单。

---

## 5. 对看板字段的影响（给 t2 / t4）

> 本节是 t6 对产品最直接的输入：真实输出决定了字段的可空性、解析状态机和展示口径。

| # | 面板字段 | 真实值形态 | 解析 / 展示要求 | 风险 / 备注 |
|---:|---|---|---|---|
| 1 | `model`（型号） | `Ascend910`；board 的 Product/Model/Serial 全 `NA` | 取 `npu-smi info` 的 Name 列；显示"8 卡 × 2 die = 16 die" | 不要依赖 board 型号；不要显示 `NA` 为主型号 |
| 2 | 卡/芯片层级 | 8 card × 2 chip（Phy-ID 0–15） | 数据模型必须 **card → chips[]** 两层；不能一卡一行 | 面板卡片数按 die（16）展示时需注明"die" |
| 3 | `health` | 全部 `OK` | 枚举化（OK/Warning/Critical/Unknown） | 保留原始字符串以便未知值透传 |
| 4 | `power_w` | chip0 有值（160–188W），chip1 为 `-`；**卡级总功率未提供** | `number \| null`；**缺失一律 `null`，不得填 0**；chip1 不参与求和；`card.power_w` 置 `null`，不要拿 chip0 值顶替 | 8 卡求和只覆盖 chip0，会低估 |
| 5 | `temp_c` | 每 chip 不同（45–49°C）；**卡级温度非实测** | 按 chip 展示；`card.temp_c` 置 `null`；如需卡片值，由 chips 派生并标 `derived` | 两行合并时不要覆盖 chip0 温度 |
| 6 | `aicore_pct` / `npu_util_pct` | 都为 0%，但语义不同 | **分开字段**，不可合并 | `AICore` 是算力核占用；`NPU Utilization` 是综合利用率 |
| 7 | `hbm_used_mb` / `hbm_total_mb` | 2882–3164 / 65536 | 以 MB 计算百分比；`HBM Usage Rate` 仅作交叉校验 | 截断导致 4% vs 4.78% 的差异，必须在 UI 解释或统一取 MB |
| 8 | `ddr_used_mb` / `ddr_total_mb` | 0 / 0 MB | 避免除零；显示"DDR 0/0（仅 HBM）" | 不要用 DDR 参与显存利用率 |
| 9 | `hugepages` | 0 / 0 | 显示"0/0" | 低优先级字段 |
| 10 | `processes` | `No running processes found in NPU x` | 解析为空数组 `[]` | 空数组 ≠ 无显存占用（见 #12） |
| 11 | 宿主进程统计 | 20 条 `<defunct>` 的 `[vllm]` / `[VLLM::Worker_PP]` | **过滤僵尸**，不计入"运行中 vLLM" | 建议同时展示"僵尸数"作为运维指标 |
| 12 | "HBM 占用但无进程" | HBM 4% + 进程表空 | 标记为 `unexplained`，展示提示而非告警 | 不做泄漏/异常判定（证据不足） |
| 13 | `vllm_version` | 宿主无包；镜像 tag 有 v0.18.0rc1-a3 … v0.30.0rc2-a5 | 字段 `unknown`；可附 `container_images` 线索；来源打标 `host/image/unknown` | 绝不能把镜像 tag 当运行中版本 |
| 14 | `cann_version` | 宿主 `8.1.RC2`；镜像 tag 有 `cann9` | 双来源：宿主 CANN 与镜像 CANN 分开 | 混用会导致"版本对比"结论错误 |
| 15 | 服务端点 | 宿主无 8000；有 443/30080/30081/50088/9003/9004 等 | 端点字段 `unknown`；禁止自动探测 | 容器 netns 隔离，宿主看不到 |
| 16 | 存储余量 | `/mnt/sdb` 99%（114G）、NFS 100% | 展示告警卡片；benchmark 结果保存前检查余量 | 演示数据不要写共享盘 |
| 17 | 模型目录 | `/mnt/sdb/models` 44 项（35 模型）；`NPU_MODEL_DIR` 未设 | 路径可配置 + 候选探测；权限不足要提示 | 部分目录 750/700 |
| 18 | 环境变量 | 未采集 | 字段 `null` + "未采集（需授权）" | 不默认写死 `ASCEND_HOME_PATH` |
| 19 | 采样时间 / 抖动 | 单次快照；Ctrlcpu 两次采样 6/2 → 7/7 | 必须带 `captured_at`；标注"瞬时值" | 建议采样间隔 ≥5s |
| 20 | 退出码 / 错误 | 裸 usages exit 215 + help | 以 exit code 判错，help 不当数据 | 错误需可读化为"需要 -i <card>" |
| 21 | 语言 / locale | 本次输出为英文 | 建议采集时固定 `LC_ALL=C`（未验证本地化差异） | 若环境为中文 locale，表头可能变化 |
| 22 | 固定宽度表格 | 列对齐靠空格；`-` 表示空 | 解析用"按管道符分列 + 去空白"，不要按字符位置硬切 | 数值列宽随位数变化 |

### 5.1 给 t2 的契约建议（待 t2 定稿）

1. **两层模型**：`cards[] -> chips[]`；chip 级字段可空（`power_w`、`hbm_usage_rate_pct` 等）。`card_count` 按 `npu-smi info` 的 NPU ID 去重（=8），`chip_count` 按 Phy-ID 去重（=16）；**不得按输出行数统计**（每 chip 两行，末尾还有进程段）。
2. **来源标注**：每个版本字段带 `source: host | image | unknown`；每个指标带 `captured_at`。
3. **错误类型**：至少区分 `npu_smi_missing_card_id`（exit 215）、`ssh_unreachable`、`permission_denied`、`parse_error`。
4. **派生指标**：`hbm_used_ratio = hbm_used_mb / hbm_total_mb`（不要用 rate 反推）；`unexplained_hbm = hbm_used_mb > 0 && processes == []`。
5. **快照元数据**：`hostname`、`kernel`、`arch`、`npu_smi`、`collected_at`、`collector_version`、`readonly=true`。

### 5.2 给 t4 的实现建议

1. 解析器用**状态机**：`npu-smi info` 每个 chip 固定两行；第一行取 NPU/Health/Power/Temp/Hugepages，第二行取 Chip/Phy-ID/Bus/AICore/Memory/HBM；按 NPU ID 归并为 card，chip 行挂到对应 card 下，**不要按行数算卡数**。
2. **先枚举后逐卡调用**：`npu-smi info`（exit 0）→ NPU ID 列表；再 `npu-smi info -t usages -i <NPU ID>`（每条 exit 0）。裸 `npu-smi info -t usages` 是 **exit 215**；**先判 exit code 再解析**，help 文本当错误处理，不要当表格。
3. 空值规则：`-` → `null`；`0 / 0` → `{used:0,total:0}`；`No running processes found in NPU x` → `[]`；**卡级未提供的 power/temp 用 `null`，不得填 0，也不得用 chip0 值代替**。
4. 演示数据：`fixtures/npu-snapshot.sample.json` 可直接作为"真实空闲"快照；"对比场景"需另造并**标注 synthetic**（t4 负责，t6 不伪造）。
5. Host 工具默认**不自动连真实环境**，需显式开关 + 限频（≥5s）+ 只读白名单；所有采集命令应可在 UI 中查看（审计可见）。

---

## 6. 后续需要但当前不允许的操作（待授权）

> 所有条目均**未执行**。按"对 MVP 的价值 / 风险"排序；执行前需用户明确授权。

| # | 操作 | 目的 | 风险 | 优先级 |
|---:|---|---|---|---|
| 1 | `docker inspect <container>`（只读） | 读容器内 vLLM 版本、启动参数、挂载、端口、env | 低（只读），但会进入他人容器元数据 | P0 |
| 2 | `docker exec <c> cat .../version.cfg`、`pip show vllm vllm-ascend` | 容器内真实版本 | 中（进入他人容器，命令需固定只读） | P0 |
| 3 | `docker logs --tail N <c>` | serving 错误 / 启动参数线索 | 中（日志可能含敏感信息） | P1 |
| 4 | `curl 127.0.0.1:<port>/v1/models`（容器网络内） | 端点与模型名 | 中（会产生请求，影响负载） | P1 |
| 5 | `npu-smi info -t memory / sensors / power / temp / ecc / topo / hccs-bw` | DDR/HBM 带宽、ECC、拓扑、功耗细化 | 低（只读），但不在当前白名单 | P1 |
| 6 | `npu-smi info -t proc-mem` / `npu-smi watch -n 1` | 解释"HBM 占用但无进程"；连续采样 | 中（高频采样可能影响） | P1 |
| 7 | `systemctl status` / `journalctl -u` | 服务状态与错误历史 | 中（暴露系统日志） | P2 |
| 8 | `bash -lc 'env'` 或 source `set_env.sh` | 真实环境变量 | 中（会执行用户 rc 脚本） | P2 |
| 9 | benchmark（vLLM benchmark / aisbench） | 真实吞吐、时延、算力利用率 | **高**（占 NPU、写结果、影响共享用户） | P2（当前禁止） |
| 10 | 启动/停止容器或 vLLM 服务 | 采集服务态、复现问题 | **高**（影响他人） | 禁止 |
| 11 | 写远端文件 / 启动常驻采集器 | 长期指标序列 | 高（改环境） | 禁止 |
| 12 | `kill` 僵尸进程 / 清理 | 释放 PID 表 | 中（可能影响他人） | 禁止 |
| 13 | `npu-smi set`（功率/ECC/风扇等） | 配置类 | **写操作** | 禁止 |
| 14 | `du -sh /mnt/sdb/*` 等递归统计 | 容量归因 | 中（扫盘 IO，共享环境） | P2（本次仅 `df` + 一级 `ls`） |
| 15 | 读 `/var/log/npu` 等日志目录 | 历史错误/黑匣子 | 中（可能含敏感信息） | P2 |
| 16 | `sudo` 提权 | — | 已是 root，且禁止 | 禁止 |

**授权说明**：P0 两项（`docker inspect`、容器内 `cat/pip show`）能把"vLLM 版本/启动参数/端点"从 `unknown` 变成事实，是看板从"空闲快照"走向"真实服务画像"的关键；建议在 t2 契约把这两个来源设计为可选字段（未授权时优雅降级）。

---

## 7. 未执行命令与原因（合规清单）

| 命令/操作 | 是否执行 | 原因 |
|---|---|---|
| `npu-smi set` | 未执行 | 写操作，任务硬性禁止 |
| `systemctl` / `reboot` / `pkill` / `kill` | 未执行 | 启停/管理类，禁止 |
| `sudo` | 未执行 | 禁止；且当前为 root，无需提权 |
| 安装包（`pip install` / `apt` / `yum`） | 未执行 | 禁止 |
| 启动/停止容器、启动 vLLM | 未执行 | 禁止 |
| benchmark / 压测 | 未执行 | 禁止（且存储 99%，风险高） |
| 远端写文件 | 未执行 | 禁止；`probe` 用 heredoc 不落盘 |
| `docker inspect` / `exec` / `logs` | 未执行 | 不在白名单（仅允许 `docker ps`），待授权 |
| `npu-smi info -t memory/sensors/power/temp/ecc/topo/...` | 未执行 | 仅授权 `info` 与 `info -t usages`；版本类补采了 `-t board`（见下） |
| `npu-smi info -t board -i 0` | **已执行** | 归为"版本查询"（Software/Firmware/Board ID），仅读取，无写操作；此处如实披露 |
| `npu-smi info -t usages -i 0..7` | **已执行** | 属授权的 `info -t usages`，用于 16 die 全量快照 |
| 登录 shell（`bash -lc`） | 未执行 | 会执行用户 rc 脚本（副作用）；probe 使用非交互 shell |
| 模型目录递归（`du`/深层 `find`） | 未执行 | 非白名单；仅执行一级 `ls` |
| `curl` 探测端口 | 未执行 | 不在白名单，且可能影响负载 |
| 读取 `/root/.bash_history`、用户家目录内容 | 未执行 | 与任务无关，涉及隐私 |
| 任何凭据输出 | 未执行 | 禁止外发；报告与样例均不含凭据 |

---

## 8. 脱敏与安全说明

- **凭据**：`~/.config/ascend-perf/npu.env`、`~/.config/ascend-perf/npu-ssh.md` 权限 600（插件目录仅保留 `scripts/npu-ssh.template.md` 模板）；未写入报告/样例/JSON；未执行任何输出凭据的命令。
- **地址**：SSH 目标 IP/端口在报告中以 `<已脱敏>` 表示；NFS 服务端仅写 `192.168.0.x`。
- **主机名**：保留 `liteserver-hps-805f-00004.novalocal` 便于内部定位；外发前建议替换为 `<host-1>`。
- **容器名 / 镜像仓库**：保留以定位工作负载；外发前建议替换 registry 域名、个人目录名（`lln`、`sijie`、`cdw` 等）。
- **未采集**：任何 token、密钥、密码、环境变量值、模型权重内容。
- **只读证据**：全部命令与 exit code 见 §1.2；脚本 `DENY_RE` 拦截写类命令；远端无文件产生。

---

## 9. 复现方式

```bash
# 前置：~/.config/ascend-perf/npu.env（600）与私钥存在
bash ascend-perf/scripts/npu-env.sh check          # 本地检查配置
bash ascend-perf/scripts/npu-env.sh probe          # 一次性只读采集（不写远端）

# 补充只读查询（与本次一致）
bash ascend-perf/scripts/npu-env.sh ssh-ro 'npu-smi info -t usages -i 0'
bash ascend-perf/scripts/npu-env.sh ssh-ro 'ls -la /mnt/sdb/models'
```

> 复现时请保持与本报告相同的只读边界；`probe` 输出建议只落本地临时目录，不入库。

---

## 10. 附录：采集产物与说明

| 路径 | 说明 |
|---|---|
| `ascend-perf/docs/samples/` | 8 个真实输出样例（脱敏），供 t2/t4 直接做 fixture |
| `ascend-perf/docs/fixtures/npu-snapshot.sample.json` | 建议的规范化快照（draft，schema 由 t2 定稿） |
| `/tmp/npu-probe/raw.txt` | 本次 probe 原始输出（273 行，本地临时，不入库） |

**版本记录**：v1（2026-11-07）首次采集；**v1.1（2026-11-07 01:00 CST）**按 t2 反馈补充：卡/chip 计数规则（NPU ID / Phy-ID 去重）、usages 实际 argv 与逐条退出码、卡级 power/temp 用 `null`、fixture `_meta.parsing_rules`。后续如获授权补采容器内版本/端点，应新增章节并保留本版本作为"授权前基线"。
