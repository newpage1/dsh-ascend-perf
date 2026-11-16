# dsh-ascend-perf · 昇腾性能调优（源码主仓）

面向 DSH（DeepSeek Harness）的昇腾性能插件（环境采集只读、服务部署受控）：单一侧栏 tab 三分段——**环境信息**（多环境 NPU 占用视图）/ **服务部署**（容器服务预览/启动/状态/停止，受控执行）/ **性能调优**（导入 vLLM benchmark 运行记录，对比基线与候选并生成带证据的洞察）。

- Host 侧：`npu-smi` 只读采集（本机或 SSH 目标）、benchmark JSON/CSV 解析归一化、本机私有仓储、对比与洞察计算、4 个 agent 工具、REST 接口。
- Client 侧：右侧栏「昇腾性能调优」面板（tab 标题/面板头带昇腾芯片意象 SVG 图标；面板顶部三段 segmented control：环境信息 / 服务部署 / 性能调优，默认停在「环境信息」），zh/en 文案，DEMO/空/错误/缺值全状态。英文显示名 `Ascend Performance Tuning`（包名/安装 id `dsh-ascend-perf` 不变）。
- 无 NPU 的 Mac 上可用 DEMO 数据完成完整闭环；样例 fixture 与自测均不依赖 NPU。

> 边界：环境采集只读，不写远端、不跑 benchmark、不修改 NPU 状态；服务部署仅在显式双门+确认令牌下操作本插件自己的 `dsh-apf-svc-*` 容器。SSH 只读采集且**每环境仅 1 条连接**：远端一次执行固定白名单命令（`npu-smi info` + 按 awk 提取的卡号逐卡 `npu-smi info -t usages -i N`，`@@CARD:<id>@@` 分段回传），`BatchMode=yes` + `StrictHostKeyChecking=yes` + 8s 连接超时与保活参数；连接失败（exit 255）1.5s 后重试一次，连续失败保留上次成功快照并标记「连接抖动」。

## 目录

```
.
├── index.js               # Host：采集/解析/导入/存储/对比/洞察/工具/REST
├── client.js              # Client：右侧栏面板（仅依赖 react）
├── tune.js / tune-exec.js # 二期：调优计划/作业与真实执行门（默认关）
├── deploy-exec.js         # 服务部署 v3：容器服务预览/启动/状态/停止（双门受控执行）
├── cordis.patch.yml       # bundle patch：插入 dsh-ascend-perf 插件
├── package.json           # 包清单（dsh.bundle / dsh.client）
├── icon.svg               # 原创图标
├── locale/{zh,en}.json    # 清单与面板文案
├── fixtures/              # 正常/缺字段/坏格式/SSH 失败样例
├── test/run-tests.mjs     # 自测：解析/导入/对比/洞察/存储/调优/部署/安全
├── docs/                  # 市场分析、技术方案、UI 方案、验证记录、截图
│   └── screenshots/        # 真实页面截图（已去除主机/IP）
└── scripts/
    ├── npu-env.sh         # 共享环境只读探针（不自动执行）
    └── npu-ssh.template.md# 登录信息模板（仅占位符，无真实主机/IP）
```

> **凭据位置**：真实 SSH 登录信息只放在插件目录之外的
> `~/.config/ascend-perf/`（`npu.env`、可选 `npu-ssh.md`；目录 700、文件 600），
> 不随插件打包，也不要提交到任何仓库。

## 安装

从 GitHub 根仓库安装（源码主仓）：

```sh
dsh plugin --profile web add "https://github.com/newpage1/dsh-ascend-perf"
```

或从 Release 的**市场版** tgz 安装（两段视图：环境信息 + 服务部署）：

```sh
dsh plugin --profile web add "https://github.com/newpage1/dsh-ascend-perf/releases/download/v1.1.2/dsh-ascend-perf-1.1.2.tgz"
```

安装/重载后刷新 Harness 页面：面板会**在每次页面加载时自动打开并展开右侧栏**；也可从侧栏「+」的引导列表打开。

卸载：`dsh plugin --profile web remove dsh-ascend-perf`。

## 开发与构建

```sh
node test/run-tests.mjs          # 90 项自测，不依赖 NPU/网络
node scripts/build-market.mjs    # 构建市场版到 dist/dsh-ascend-perf（EDITION='deploy'）
```

根目录源码是**完整三段版**（环境信息 / 服务部署 / 性能调优）。市场构建脚本会把 `EDITION` 改为 `deploy`、标题改为「昇腾环境监控与服务部署」，用于 GitHub Release / DSH 市场；调优段仍保留在源码与本地完整版。

## 配置

`cordis.patch.yml` 默认 `demoMode: false`。可在安装条目上覆盖：

```yaml
- id: dsh-ascend-perf
  name: dsh-ascend-perf
  config:
    demoMode: false          # true：强制演示数据，零次 spawn
    npuSmiPath: npu-smi      # 或绝对路径
    timeout: 15000           # 单命令超时（1000–60000 ms）
    regressionThreshold: 5   # 对比阈值（0.1–50 %）
    dataDir: ~/.local/share/dsh-ascend-perf
    ssh:
      enabled: false
      hostAlias: null        # 别名或 user@host；使用系统 ~/.ssh 配置与默认密钥
      npuSmiPath: npu-smi
```

SSH 只读采集要求：

1. 在 `envs.json` 中把环境 `mode` 设为 `ssh`，`hostAlias` 填 `~/.ssh/config` 的 `Host` 别名或 `user@host`；使用系统默认密钥（插件不保存密码/私钥）；
2. 远端账号可执行 `npu-smi`，且已接受过 host key（插件不写 `known_hosts`）；
3. 失败（退出码 255）会先重试 1 次（间隔 1.5s）；仍失败返回 `SSH_UNAVAILABLE`，若有上次成功快照则显示 `stale` 与上次采集时间；不修改远端。

## 环境配置文件（envs.json）

多环境的**唯一真源**是配置文件 `~/.config/ascend-perf/envs.json`（页面对它的修改统一走配置条「环境配置」弹窗，写回同一文件）。首次启动时插件会自动生成它：优先迁移旧 `~/.local/share/dsh-ascend-perf/settings.json`（v2 多环境 / v1 单目标），否则从 `~/.config/ascend-perf/npu-ssh.md` / `npu.env` 播种已有登录目标。旧 `settings.json` 保留不删。

```json
{
  "version": 1,
  "pollIntervalMs": 300000,
  "envs": [
    { "id": "env-local", "name": "本机开发机", "mode": "local", "hostAlias": null, "npuSmiPath": "npu-smi", "timeoutMs": 15000, "enabled": true },
    { "id": "env-a", "name": "集群A", "mode": "ssh", "hostAlias": "root@10.0.0.5", "npuSmiPath": "/usr/local/bin/npu-smi", "timeoutMs": 15000, "enabled": true },
    { "id": "env-night", "name": "夜间池", "mode": "ssh", "hostAlias": "ascend-ro", "npuSmiPath": "npu-smi", "timeoutMs": 15000, "enabled": false }
  ]
}
```

- `pollIntervalMs`：静默采集间隔，60000–3600000 ms（默认 5 分钟）；
- 每个环境：`id`（`env-` 前缀，唯一）、`name`、`mode`（`local` | `ssh`）、`hostAlias`（ssh 必填）、`npuSmiPath`、`timeoutMs`（1000–60000）、`enabled`（`false` 仅停止自动采集，仍可手动刷新）；最多 16 个；
- 文件权限 0600（含目标主机信息）；改完文件点面板「刷新全部」即可生效（每次刷新全部前重新读取该文件）；
- 文件损坏时面板顶部显示 `CONFIG_READ_FAILED` 错误卡（含原因与路径），原文件不会被覆盖，修复 JSON 后「刷新全部」恢复；
- REST `GET/POST /config` 仍保留供工具/脚本调用：POST v2（`envs` / `pollIntervalMs`）写入的也是 `envs.json`。

### 新用户导入（三途径）

首次使用（`envs.json` 尚无任何环境）时，面板空态会显示**导入引导**；配置存在后引导自动消失，恢复只读配置条。

1. **从 SSH 主机导入**：面板读取 DSH ssh 插件的主机仓（`~/.dsh/dsh-ssh.json`，即 `ssh_list` 的数据源，路径可经 `sshHostsFile` 配置注入）。点击「浏览」生成草稿预览——`ascend`/`npu` 标签的主机优先排序，非法别名与已存在别名标明跳过原因；确认后原子写入 `envs.json`（0600）并自动触发首轮采集。**只保存 `hostAlias` 引用**：主机的密码、私钥路径、passphrase 等凭据字段一律不读取、不落盘、不传输。读不到主机仓时如实显示不可用原因（未安装 / 文件不存在 / 解析失败）。
2. **粘贴 JSON 导入**：把环境数组（或 `{ "pollIntervalMs": 600000, "envs": [...] }`）粘贴进文本框，点「校验并导入」。逐条校验（`mode` 枚举、`hostAlias`/`npuSmiPath` 正则、id/别名去重、总数 ≤16），任一条非法则**全部拒绝**并逐条列出 `{序号} {原因}`，不写盘；全部合法才落盘。非法 `npuSmiPath` 沿用既有语义静默回退 `npu-smi`。
3. **手动模板**：直接编辑 `~/.config/ascend-perf/envs.json`（上方示例即模板），保存后点配置条「重新加载配置」生效（该按钮走 `POST /config/reload`，只读重载并触发全量采集，成功提示环境数，失败保留旧配置并显示 envs.json 解析错误）。

三条导入 REST（`POST /envs/import/ssh/preview`、`POST /envs/import/ssh`、`POST /envs/import/json`）沿用面板鉴权，未认证一律 401。

## 使用

单一侧栏 tab「**昇腾性能调优**」（chip-A 图标），面板顶部三段 segmented control：**环境信息 / 服务部署 / 性能调优**。分段选择仅保存在进程内状态，刷新后回到默认「环境信息」；窄栏下自动使用短标签（环境 / 部署 / 调优），支持 ←→ 键切换（`role=tablist` + `aria-selected`）。

### 1. 环境信息（多环境占用视图）

面板顶部一行**配置条**：显示 envs.json 路径（点击复制）、「每 N 分钟自动采集」提示，右侧两个按钮——**「环境配置」**（主入口）与**「重新加载配置」**（次级兜底）。envs.json 仍是唯一真源；常用修改不必手写文件——点「环境配置」打开**全局结构化弹窗**：顶部采集频率（分钟，1–60），下方逐行列出所有环境字段（名称 / 模式 local-ssh / SSH 目标 user@host / npu-smi 路径 / 超时 ms / 启用开关），支持添加（≤16）与删除环境，逐字段校验错误就地提示；「保存」走 `POST /config`（v2 整体替换，Host 端 0600 原子写回 envs.json）→ 关闭弹窗 → 自动刷新采集，「取消」原样还原。「重新加载配置」走 `POST /config/reload`：只读重读 envs.json（不写任何文件）→ 更新内存配置 → 触发全量采集；envs.json 损坏时返回 400 并**保留旧配置**，面板显示配置错误卡。环境卡本身不再有编辑入口（保持只读视图）。envs 为空时该区域替换为**导入引导**（SSH 主机导入 / 粘贴 JSON / 手动模板三途径，见「新用户导入」），首次配置无需手写文件。

「多环境占用」以**占用为中心**逐块展示环境：环境名旁第一徽标是**占用档位**（空闲 / 部分占用 / 高负载 + 占用 chip 计数如 `8/8`）。卡头**主机标识单次显示**（t36 口径，用户靠 IP 区分环境）：自定义名优先并并列裸主机（如 `集群A · 10.0.0.5`）；播种默认（名称 = SSH 目标）显示 `环境 N · IP`（N 按 envs 配置列表顺序，排序展示不影响编号）；`user@` 前缀不显示、同一主机标识不重复出现；连接方式以「SSH」标签标注；配置弹窗中的 SSH 目标字段仍为完整 `user@host`（配置需要），连接态（连接失败 / 缺少 npu-smi / 未检测到 NPU / 未采集 / 数据过期 / 连接抖动）降级为次要小角标；SSH 连续失败但有上次成功快照时环境标记 `stale`——仍显示上次数据并注明「连接抖动 · 上次 HH:MM」（`last_success_at`），仅无任何历史成功时才显示连接失败。占用档位由 chip 级信号判定：有占用进程、HBM ≥5%、或 AICore ≥5% 即计占用；`none_reported`（npu-smi 正常返回、进程列表为空）且指标低于阈值即计**空闲**——无进程 + HBM 4% 基线的空闲机显示为空闲档；仅当进程信息确实拿不到（`processes_state='unknown'`，采集/解析异常）才计**未知**，未知 chip 不计入分母。排序为空闲 → 部分占用 → 高负载 → 占用未知 → 已停用，一眼找到可用的机器。

每个环境卡默认视图保持精简，自上而下：**占用进程行**（有占用进程才显示，聚合 top3，如 `VLLMWorker_DP ×6 Σ168.4 GiB`；空闲环境不渲染占位行）→ **按卡占用条**（一张 NPU 卡一格，编号按型号，见下表；格内：占用=琥珀实心 / 空闲=绿描边 / 未知=灰虚线，格文本为 `编号 占用chip数/总chip数`，悬停见该卡温度峰值/功率合计/AICore 峰值/HBM 峰值）→ 卡尾一行 **muted 内联摘要**：`Ascend 910B3 · 16 chip · 45–60 °C · ≈3.3 kW · HBM 8/512 GiB（2%）`（12px mono 等宽对齐数字，缺项自动跳过，单行截断）。chip 级明细（卡头带每卡占用计数，chip 含温度/功耗/AICore/NPU 利用率/HBM 用量与占用进程，空闲与占用视觉区分）全部收进「展开 N 卡详情」折叠区，默认不打扰。已停用环境 60% 透明度置底并提示「停用仅停止自动采集，仍可手动刷新」。

**卡编号规则（v1.5，按快照型号判断）**：

| 快照型号 | 编号 | 说明 |
| --- | --- | --- |
| 含 `910C` | 1..16 | 910C 机器按 16 卡编号 |
| 含 `910B` | 1..8 | 910B（如 910B3）按 8 卡编号 |
| 其他 / 未知 | 1..N | 按实际卡数编号 |

展示编号一律为 npu-smi 原始 `card_id + 1`（1 基），型号只决定「应有卡数」（快速核对用）；展开详情的卡头同样显示 `NPU 编号（id 原始卡号）`。占用条下方不再附图例说明行（用户 m02398 要求移除，卡格 aria/title 仍带完整判定信息）。

手动刷新统一由「刷新全部」承担（每环境独立刷新按钮与底部提示行已按用户要求移除，环境段更安静）；插件启动后每 N 分钟静默采集所有启用环境，失败如实显示（连接失败保留上次成功快照并叠加「数据过期」角标）。所有采集只读（`npu-smi info` + 逐卡 `info -t usages`），不启停服务/容器、不写远端。演示模式与未配置 envs 的单机快照沿用旧版单快照视图；「加载演示数据」入口保留在「性能调优」分段底部。

真实 SSH 采集结果（8 NPU / 16 chip）截图：`docs/screenshots/real-npu.png`；单环境摘要/滚动/底部截图：`docs/screenshots/real-page-summary.png`、`real-page-scroll.png`、`real-page-bottom.png`（§13）；多环境占用截图：`docs/screenshots/real-page-multienv.png`、`real-page-multienv-scroll.png`（§14）；v1.2 占用视图重制截图：`real-page-v12-t18.png`（chip 标签带卡号）、`real-page-v12-t19.png` / `real-page-v12-t19-bottom.png`（默认一行内联摘要 + 底部，§15.6–15.7）。

#### 无 NPU 时：加载演示数据

面板底部「加载演示数据」或工具：

```text
ascend_perf_import { "action": "load_demo" }
```

将写入 1 个 8 卡 × 16 chip 的演示快照与 baseline/candidate 两条运行（candidate 吞吐 −5%、TTFT p99 +13%），可直接对比并看到 `TTFT_REGRESSION` 洞察。导出内容带 DEMO 标识。

演示数据存放在独立的 `demo_runs` / `demo_snapshots` 分仓，不会混入真实或导入运行；演示开关只在当前进程内有效，**重启后自动回到真实数据**。演示模式下导入的真实数据会正常保存，但需点击「退出演示」后才可见；演示数据与真实数据不能混合对比（会返回 `INVALID_ARGUMENT`）。

### 2. 服务部署（容器服务，受控执行）

切换到「服务部署」分段后，只有一个主入口：**容器服务**。

1. **选择环境**：下拉框来自 `envs.json` 的启用 SSH 环境，显示「环境 N · IP / 自定义名 · IP」，无 `env-new` 前缀、无 `root@` 重复。
2. **选择 chip**：按该环境最新占用快照展开逻辑 chip（c01 A3 16 chip、b01 8 chip），只允许勾选空闲项；提供「全选 / 前 8 张 / 后 8 张」；TP 自动等于选中 chip 数。
3. **填写运行参数**：镜像（下拉，按环境默认：c01/A3 16-chip 用 `v0.30.0rc2-a3`，b01/8-chip 用 `v0.23.0`）、模型根目录（默认 `/data1/models`，挂 `/models` 只读）、模型相对路径、代码目录（默认 `/home/z00919396`，挂 `/code` 只读）、端口、max-model-len（默认 131072，范围 256–262144）。
4. **预览启动命令**：返回完整 `docker run` 命令与 10 分钟确认令牌；预检 fail-closed（`CHIP_BUSY / PORT_IN_USE / IMAGE_NOT_FOUND / MODEL_DIR_MISSING / SSH_UNAVAILABLE`）。
5. **启动**：双门——`envs.json` 顶层 `"deploy": {"allowRealExecution": true}` + 确认令牌；启动前重跑预检并原子占位，失败自动清理自有容器。
6. **状态/日志/停止**：只操作 `dsh-apf-svc-` 前缀 + `dsh-ascend-perf.service` 标签匹配的自有容器；停止会 `docker stop` + `docker rm`。

> 旧版“按代码分支生成部署计划”UI 已移除；相关 REST/工具仅保留后端兼容，不再在页面展示。

#### 容器服务运行细节

在选定 ssh 环境上以**容器方式受控启动 vLLM 服务**（配方在 b01 驱动 26.0.rc1 上实测定稿，见下）。

- **预览（始终可用）**：选环境（仅 ssh）→ 勾选空闲 NPU 卡（按环境信息段的最新占用快照预筛；预览时仍会逐卡实测 `npu-smi info -t usages -i N`，HBM<10% 且 AICore<5% 才算空闲）→ 填镜像（按环境默认）、模型根目录（默认 `/data1/models`）/相对路径、代码目录、端口、max-model-len（默认 131072） → 返回完整 `docker run` 命令与 **10 分钟确认令牌**。预检 fail-closed：`CHIP_BUSY / PORT_IN_USE / IMAGE_NOT_FOUND / MODEL_DIR_MISSING / SSH_UNAVAILABLE`。
- **启动（双门，默认全关）**：门一 `envs.json` 顶层 `"deploy": {"allowRealExecution": true}`（默认缺失=false；插件保存/导入 envs 时**保留该未知顶层键**，写盘后重新读取并同步内存开关）；门二 预览确认令牌（未启用时按钮禁用且无任何 `docker run` 发出）。启动前重跑全部预检并**原子占位**（同环境/同主机的卡集合相交或端口相同即 `RESERVATION_CONFLICT`，含已有活跃实例；docker run 失败自动按前缀+label 清理自有容器并释放占位，可重试）；启动后登记实例，健康检查 `curl /v1/models`，超 `health_timeout_s`（默认 300s）未就绪自动 `docker rm -f` 自有容器。
- **状态/日志/停止**：状态=运行态+健康探针（starting/healthy/stopped/error/gone；插件重启后内存登记为空时，对 `dsh-apf-svc-*` 容器名做**接管查询**——逐启用 ssh 环境 `docker inspect`，前缀+label 校验通过即可 status/logs/stop，端口/启动时间如实标注未知）；日志 `docker logs --tail`（10–1000 行）；停止 `docker stop -t 30` **并 `docker rm`**（不保留 Exited 容器，避免 stopped 累积）。**停止/日志/清理只对 `dsh-apf-svc-` 前缀且 `dsh-ascend-perf.service` 标签匹配的自有容器生效（label 缺失或值不符均 `FORBIDDEN`）**（绝不触碰他人容器）。
- **配方（按环境 opt-in，t128 起）**：
  - **默认基线（安全回退）**：只挂选中 `/dev/davinciN` + `davinci_manager/devmm_svm/hisi_hdc`，driver/dcmi/ascend_install.info 与模型目录只读挂载，端口只绑 `127.0.0.1`，image 前 `--` 分隔（镜像名以 `-` 开头在校验层直接拒绝）。**不加 `--privileged`、不加 `--ipc=host`、不设 `ASCEND_RT_VISIBLE_DEVICES`**——适用 25.x 驱动（如 c01 25.5.1），只挂选中 device 节点即完成逻辑重映射。
  - **特权例外（显式 opt-in）**：envs.json 顶层 `"deploy": {"privilegedHosts": ["b01"]}` 列入该环境的 hostAlias 或 env id 后，配方追加 `--privileged --ipc=host -e ASCEND_RT_VISIBLE_DEVICES=逻辑 0..N-1`。依据（b01 驱动 26.0.rc1 实测）：新驱动下无 `--privileged` 时 `ascend_hal` 枚举失败（`Can't get ascend_hal device count` → 引擎初始化失败）；privileged 下不设 `ASCEND_RT_VISIBLE_DEVICES` 则容器可枚举全部 8 卡（隔离失效，实测 =0 时 COUNT=1、=0,1 时 COUNT=2）。**风险**：`--privileged` 放大容器权限（仅本插件启动的容器、仍只挂选中卡），请仅对可信镜像启用。
  - preview 会标注 `recipe`（`privileged-isolated` / `baseline-sandboxed`）与对应提示；远端命令插值一律 POSIX 单引号包裹。
- **按分支构建（高级选项，默认关闭）**：勾选「按分支构建后启动」后，五个组件（vllm / vllm-ascend / lmcache / lmcache-ascend / mooncake）各自填写分支/tag 与仓库地址（`https://…` 或 `git@…`）。启动时容器先执行 `git clone --recursive` / `checkout` / `git submodule update --init --recursive` / `pip install --no-build-isolation -e`，全部成功后才 `exec vllm serve`；构建日志走 `docker logs`。首次构建可能 10–60 分钟（UI 勾选构建时自动把健康超时提到 3600s），构建失败容器不会就绪并被清理。仓库地址与分支在预览时做白名单/正则校验；不写入宿主目录，只写容器内 `/opt/dsh-src`。**限制**：构建依赖容器内网络可达与镜像自带编译链；c01 直连 GitHub 不通时需换成内网镜像/镜像源。不开启构建时，分支字段只记录到运行规格，实际仍用镜像代码。
- REST/工具面：`POST /deploy/run/preview`、`POST /deploy/run/start`、`GET /deploy/run/instances[/:id[/:logs]]`、`POST /deploy/run/instances/:id/stop`；工具 `ascend_deploy_run_preview / start / status / stop`（预览只读，启动/停止在 envelope 中如实声明 `remote_write/process_mutation`）。测试全部 mock `execSsh`，不真启动容器；真机链路（preview→start→healthy→stop）已在 b01 卡 6 用 Llama-3.2-1B 实测通过（t≈120s 健康、真实补全、stop 后 0 容器、卡回空闲）。

### 3. 性能调优（调优作业、运行对比与洞察）

同一分段内自上而下三个小节：**调优作业**（demo 执行器全流程，见下文「性能调优（二期）」）、**运行与对比**（导入 → 对比 → 洞察）、底部导出。

#### 导入真实 benchmark

面板「导入运行」选择 ≤1 MiB 的 UTF-8 文件，或直接把 JSON/CSV 粘贴进文本框；也可用工具：

```text
ascend_perf_import {
  "action": "import",
  "filename": "benchmark.json",
  "content": "<文件文本>"
}
```

支持：

- vLLM benchmark JSON（单对象或数组，≤200 对象）；
- benchmark 指标 CSV（每行一个 run，≤10000 行 × 128 列）；
- msprof `op_summary` CSV（仅算子热点，需 `target_run_id` 关联到已有运行）。

坏行默认整批拒绝（`PARSE_ERROR` + 行号）；显式 `skip_bad_rows: true` 才部分导入。重复文件按内容 sha256 幂等复用。

#### 对比与洞察

```text
ascend_perf_compare {
  "baseline_run_id": "run_...",
  "candidate_run_id": "run_..."
}
ascend_perf_insight { "baseline_run_id": "run_...", "candidate_run_id": "run_..." }
```

- 阈值默认 ±5%；判定 `improved / regressed / stable / descriptive / missing / zero_baseline`；
- 可比性 `matched / mismatch / unknown`；不一致时只给描述性差值，结论 `not_comparable`；
- 结论 `regressed / improved / stable / inconclusive / not_comparable`；
- 8 条洞察规则：HBM 压力、TTFT 回归、TPOT 回归、并发饱和、成功率低、高温、功耗变化、热点集中；最多 20 条，未触发前置条件写入 `skipped_rules`；
- 导出 Markdown/JSON（≤64 KiB），CSV 字段做公式注入防护。

#### msprof Profile 分析（P1：导入 + 展示 + R01–R05）

调优段内的第四个小节 **msprof Profile 分析（P1）** 回答的是「**为什么慢**」（算子层面证据），与上文 benchmark 对比（「慢多少」）互补，互不替代。

**导入**：面板「导入 CSV」选择 msprof 导出的 `op_statistic.csv` / `kernel_details.csv`（可多选；按**表头指纹**判型，不看文件名），或点「加载演示 profile」用内置真实脱敏样本（见 `fixtures/profile/`，源自 910B3 微 probe 的 E1/E3 导出）。限额：单文件 ≤4 MiB、总量 ≤8 MiB、≤8 个文件，超限结构化拒绝（`PROFILE_TOO_LARGE`）。未知表头返回 `PROFILE_UNSUPPORTED_FORMAT`，不猜 schema。数据只落本机私有目录 `~/.local/share/dsh-ascend-perf/profile-v1/`（0700/0600、原子写），与既有 `runs`/`hotspots` 完全独立；旧 `op_summary` 热点导入路径不受影响。

**解析口径**：

- 时间单位 us→ns 用十进制定点换算（非浮点乘法）；超过 3 位小数时四舍五入到 ns 并记 `precisionLoss`。
- `Count=0`：保留行、`mean/min/max` 置空并记 `missing_reasons`；`NaN`（不算空值）/负时长/非法数 → 行级 `rejected`（带字段与行号）。
- 默认 **strict** 导入策略：只要有行级 `rejected`，整个 session 不落库（`PROFILE_REJECTED_RECORDS`）；确认要跳过坏行必须显式传 `policy='partial'`，落库后 session 标 `partial`。
- 表头白名单：判型只认已验证的列集合（statistic 9 列 / kernel 45 列，允许可选列缺席）；出现未知额外列 → 该文件 `unsupported`（`unknown_columns`），不进任何定量统计。
- `Ratio(%)` / `cube_utilization(%)` 只按 `source_reported` 语义保留（/100），不当硬件利用率；`aic_mac_ratio` 等 PIPE counter 按 `verified` 语义（0..1）。
- 每条记录 100% 保留来源（`source_id` + `row:N` + 字段名）。
- 聚合视图（op_statistic）与实例视图（kernel_details）分表存储，绝不相加。

**R01–R05 证据规则**（确定性规则，无 LLM；每条输出 `status=triggered|not_triggered|skipped`、`evidence`（文件/行/字段/值）、`conclusion`、`actions`、`confidence`、`missing_fields`）：

| 规则 | 问题 | 触发（摘要） | 缺数据时 |
| --- | --- | --- | --- |
| R01 | 热点是否集中在单一算子类 | 单类份额 ≥30% 或 Top5 ≥70%（分母=已导入聚合行总和） | 无聚合视图 → skipped |
| R02 | Cube/MAC 管线占比是否偏低 | MIX/AI Core、duration≥100us 实例的 duration 加权 `aic_mac_ratio`<0.5 且覆盖计算时长 ≥20% | 未采集 PIPE counter → skipped（**不**从名称推断利用率） |
| R03 | Vector 转换开销是否可见 | Transpose+Cast 份额 ≥10% 且调用 ≥10 次 | 无聚合视图 → skipped |
| R04 | 统计/实例两视图是否一致 | Count 按 max(1%, 0)、Total 按 max(1%, 1000ns 舍入容差) 比较，严格超出才告警；同时扫描 `source_ratio` 与 PIPE counter 的 [0,1] 越界（mismatch 带行号） | 只有单份视图 → skipped |
| R05 | 任务粒度是否偏小 | 按 op_type 分组：某类 ≥100 实例、中位数 <20us 且该类时长占**全部实例总时长**（真实分母）≥20%；分子/分母/share 写入 metrics | 没有任何类 ≥100 实例 → skipped（不按均值伪造中位数） |

规则文案不输出「必然提速 N%」之类的承诺；每条建议都要求改动后维持精度/误差门槛再做 A/B。

**REST 与工具**（均沿用 fail-closed 鉴权）：

```text
POST /api/ascend-perf/profile/imports     { "files": [{ "name": "op_statistic.csv", "content": "<CSV 文本>" }, ...] }
POST /api/ascend-perf/profile/demo
GET  /api/ascend-perf/profile/sessions
GET  /api/ascend-perf/profile/sessions/:id
GET  /api/ascend-perf/profile/sessions/:id/report
DELETE /api/ascend-perf/profile/sessions/:id

ascend_profile_import { "files": [...] }
ascend_profile_list {}
ascend_profile_report { "session_id": "prof-..." }
```

#### 设备状态工具（Host 侧，只读）

```text
ascend_status { "target": "local", "refresh": true }
```

返回统一 `Result` 信封：`status = ok | degraded | empty | error`，`readonly: true`，并带 `source`（mode/evidence_kind/host/collected_at）与 `warnings`。

## 性能调优（二期）：调优作业

调优作业位于「昇腾性能调优」tab 的第三段「**性能调优**」（与运行对比/洞察同段，内部以小节标题区分；原独立 `ascend-perf-tune` tab 已随 IA v1.4 合并下线）。当前只交付**演示执行器**：真实 `local`/`ssh` 执行默认关闭，共享环境不会被自动启停，也不会自动执行 `scripts/npu-env.sh`。

### 流程（无 NPU 也可跑通）

1. 编辑 JSON 规格（内置 Qwen3-8B 演示规格，至少含 `max-num-seqs` 与 `max-num-batched-tokens` 两轴）；
2. 点“预览计划（dry-run）”——Host 解析、校验、生成候选/预算/阻断项与模板化命令预览，不启动任何服务；
3. 点“启动演示运行”——demo executor 按状态机跑 baseline → candidates → confirm，零真实进程/端口/网络副作用；
4. 运行中可暂停/恢复/停止；完成后自动拉取报告：推荐参数、best 指标、Pareto 前沿、失败试次与限制说明。

`grid` 与 `random`（xorshift32，seed 可复现）两种搜索；预算、SLO、测量重复次数、失败容忍均可在规格中收紧，Host 只会拒绝放大预算的请求。

### 工具

| 工具 | 作用 |
| --- | --- |
| `ascend_tune_plan({ spec })` | 规格校验 + 计划/预算/阻断项 + 命令预览 |
| `ascend_tune_run({ action, ... })` | `dry_run` / `Start` / `Pause` / `Resume` / `Stop`，Start 支持幂等键与 revision |
| `ascend_tune_status({ job_id?, after_seq? })` | 作业进度、试次、事件增量、清理状态 |
| `ascend_tune_report({ job_id, format? })` | JSON 或 Markdown 报告（推荐、Pareto、失败分类、限制） |

### 真实执行授权（默认关闭）

真实执行需要同时满足：配置 `tuning.enableRealExecutors=true`、target policy 为 `maintenance_only`、携带绑定 plan_hash 的有效授权（窗口/nonce）并持有资源锁。缺少授权桥时返回 `AUTH_BRIDGE_UNAVAILABLE`，计划会带阻断项且**不会启动任何进程**。当前版本不提供授权桥，请用 demo 形态演示。

### 安全与清理

- 命令全部模板化、argv 数组直传，不经 shell；参数只接受受控白名单与范围校验；
- 端口先探测后占用（`PORT_BUSY` 时直接失败，不杀占用进程）；
- 超时/停止只 `terminate` 本插件自己 spawn 的句柄，从不按名称或端口杀进程；
- 日志与报告脱敏（资产以 `<asset:…>` 引用，不含密钥/路径全量）；
- 状态与试次持久化在 `~/.local/share/dsh-ascend-perf/tuning-v1/`（0700/0600，原子写）；重启发现未完成作业标记 `recovery_required`，不自动重启。

### 自测

```bash
node --check index.js
node --check client.js
node test/run-tests.mjs
```

覆盖规格校验、plan hash 稳定、random 确定性、vLLM JSON/CSV 解析、失败/超时/缺字段分类、预算终止、暂停/恢复/停止幂等、重启恢复、真实执行门与 argv 防注入、端口锁、只清理自有进程。

## 旧版服务部署 v2 API（UI 已移除，仅保留兼容）

> v2 = **纯文本计划**：以 envs 环境为部署目标，生成「候选 vs 基线」代码差异验证计划，可编辑、可保存（`plans.json`，0600 原子写）。**不执行任何步骤、不连远端、不启停服务、不跑 benchmark**；真实执行属后续授权范围。

### 生成输入（spec）

```json
{
  "env_id": "env-a",
  "component": "vllm-ascend",
  "candidate": { "ref": "feat/kv-cache-opt", "commit": "a1b2c3d4e5f6a7b8" },
  "baseline": { "ref": "main", "commit": "" },
  "model": { "path": "/data/models/Qwen3-8B", "served_name": "qwen3-8b" },
  "params": {
    "port": 18433,
    "tensor_parallel": 2,
    "max_num_seqs": 256,
    "max_num_batched_tokens": 8192,
    "health_timeout_s": 300
  }
}
```

- `env_id` 必须是 `envs.json` 中**存在且启用**的环境（否则 `ENV_UNKNOWN` / `ENV_DISABLED`，fail-closed：环境被删/停用后旧计划也不可再覆盖保存）；
- `component`：代码组件，白名单 `vllm / vllm-ascend / lmcache / lmcache-ascend / mooncake`，缺省/空即 `vllm-ascend`（旧计划无此字段读出时同样补默认，不回写盘）；基线与候选共用同一组件；
- `candidate/baseline.ref`：分支或 tag，非空、白名单字符（字母/数字/`.`/`_`/`-`/`/`）、≤200 字符；`commit` 7–40 位十六进制，留空取 HEAD；
- `model.path` 绝对路径（白名单字符）；`params`：port 1024–65535、tensor_parallel 1–8、max_num_seqs 1–1024、max_num_batched_tokens 128–131072、health_timeout_s 5–3600（默认 300）；
- 未知字段一律拒绝（`UNKNOWN_FIELD`）；计划标题默认「环境 · 候选 vs 基线」。

### 计划数据结构（schema `dsh-ascend-perf/deploy-plan-v2`，保存于 configDir/plans.json，0600）

```json
{
  "version": 1,
  "updated_at": "…",
  "plans": [
    {
      "schema": "dsh-ascend-perf/deploy-plan-v2",
      "id": "plan-0123456789abcdef",
      "title": "A 环境 · feat/kv-cache-opt vs main",
      "env": { "id": "env-a", "name": "A 环境", "mode": "ssh", "host_alias": "…" },
      "component": "vllm-ascend",
      "candidate": { "ref": "feat/kv-cache-opt", "commit": "a1b2c3d4e5f6a7b8" },
      "baseline": { "ref": "main", "commit": "" },
      "model": { "path": "/data/models/Qwen3-8B", "served_name": "qwen3-8b" },
      "params": { "…": "同上" },
      "steps": [
        { "id": "s1", "title": "环境占用检查", "detail": "…", "command": null, "scope": "both" },
        { "id": "s2", "title": "获取代码并检出基线", "detail": "…", "command": "git checkout main", "scope": "baseline" }
      ],
      "executes": false,
      "created_at": "…",
      "updated_at": "…"
    }
  ]
}
```

- 步骤校验：`title` 非空 ≤120、`detail` ≤1024、`command` 可空 ≤2048（纯文本占位）、`scope` ∈ candidate/baseline/both、步骤数 1–64、id 服务端归一；计划数上限 32；
- `plans.json` 读失败（非法 JSON / version ≠ 1）返回 `PLAN_STORE_READ_FAILED` 且**不覆盖待修复文件**；
- 工具 `ascend_deploy_plan_generate / list / get / update` 输出统一 envelope（`readonly: true`、`effects` 全 false、`source: {mode:'plan-only', executes:false}`），错误也走 envelope 不抛；
- 全部 deploy 路由复用 `/api/ascend-perf` 前缀 fail-closed 鉴权（未认证 401，六条路由测试覆盖）；
- deploy.js 无 spawn/ssh/exec 代码路径；生成与保存只读 envs/env_states 快照的占用摘要，不触发采集。

### 历史版本说明

三期 P1（services.json 资产 + dry-run 预览 + 演示服务 `svc-demo-qwen3-8b`）已随 v2 下线：服务资产目录、`/deploy/services`、`/deploy/preview`、`ascend_deploy_preview` 工具与对应 UI 均已移除。

## 数据与隐私

- 仓储目录 `~/.local/share/dsh-ascend-perf`（0700），`store.json`（0600）+ `store.json.bak` + `quarantine/`；
- 原子写：临时文件 → fsync → 保存 bak → rename；上限 200 runs / 20 snapshots / 5 MiB；
- 损坏时隔离并从 bak 恢复（`STORE_RECOVERED` 警告）；双坏返回 `STORE_CORRUPT`，不自动清空；
- 导入文件只在本机解析，不上传云端；错误信息截断 512 字符，不记录 stdout/stderr 全文与凭据。

## 开发与自测

```bash
node --check index.js
node --check client.js
node test/run-tests.mjs
```

自测 90 项，覆盖：8 卡 16 chip 去重、缺值 null、usages 双 chip 不串值、JSON/CSV/msprof 导入、坏格式拒绝、1 MiB 上限、阈值与可比性、8 条洞察、仓储 600 权限、损坏恢复、工具与 REST 注册、无 NPU 降级、多环境占用视图与 envs.json、SSH/JSON 导入、调优全链路、部署 v2（计划生成/校验矩阵/持久化与编辑/工具面/鉴权/UI 渲染）、t44（SSH 单连接聚合与 @@CARD 分段解析/exit 255 重试/stale 兜底与 stderr 脱敏/`POST /config/reload` 成功与损坏回退/部署组件白名单与旧计划兼容/环境配置弹窗整体替换载荷）、t124 容器服务（validateRunSpec 白名单与卡/TP 约束、预览 argv 配方与确认令牌、五类预检 fail-closed、启动双门（未启用零 docker run）、健康探针与超时清理、FORBIDDEN 容器守卫、output.schema 必须为对象的回归、UI 空闲卡勾选与未启用提示）、t126（新配方 argv 断言翻转：--privileged/--ipc=host/ASCEND_RT_VISIBLE_DEVICES/-- 分隔；重启后按容器名接管 status/logs/stop；重复 start 与卡/端口冲突 RESERVATION_CONFLICT；docker run 失败清理+占位释放可重试；envs.json 未知键保留与 gate 同步（POST /config 与导入两路）；恶意 image 前导 - 校验层拒绝；label 值错误 FORBIDDEN；buildDeploySshExec resolved argv；render 返回树断言）、t131（c01 16 chip / b01 8 chip 选择、代码目录 /code 只读挂载）、t132（vLLM 启动参数进入 argv、五组件代码分支记录与校验）、t133（构建模式 repo/ref 必填、clone+submodule+pip install 脚本、bash -lc 启动、默认关闭不构建）、t128（execSsh cfg 透传回归、REST pattern 路由 params 透传回归（INSTANCE_UNKNOWN 而非 STORE_IO）、配方按 deploy.privilegedHosts opt-in（b01 特权/其他基线回退）、接管 label 与容器名后缀一致性、README/verification 文档一致性）。

## 已知限制

- 共享昇腾环境（2026-11-07 只读采集）：宿主 8 卡 × 16 chip、npu-smi 26.1.1、CANN 8.1.RC2、torch_npu 2.8.0.post4；宿主未安装 vLLM，负载运行在 36 个容器内，宿主侧 `ps` 仅有 20 个 defunct 残留，`ss` 无 8000 端口；`/mnt/sdb` 使用率 99%。详见 `docs/real-env-report.md`。
- 插件不进入容器采集，因此容器内 vLLM 的实时指标不在本版范围；运行记录通过 benchmark 文件导入。
- 首版无 SSE 自动刷新：面板打开只读缓存，手动刷新触发采集。
