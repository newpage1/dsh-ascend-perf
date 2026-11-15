# 昇腾性能工作台二期 · 性能调优控制台 UI/UX 设计

| 项 | 内容 |
| --- | --- |
| 文档版本 | v1.0（2026-11-07） |
| 作者 | 设计师（AgentTeams `设计师`） |
| 适用任务 | t8：二期 UI/UX——性能调优控制台的新建、运行与结果三流程 |
| 关联产物 | t7 `docs/tuning-design.md`（技术契约，字段以它为准）；t3 `docs/ui-design.md`（一期观测面板与视觉基线）；t4 一期实现；后续二期实现与独立审查 |
| 交付范围 | 右侧栏“昇腾性能”面板内“调优”页的信息架构、三流程、全状态、组件与字段、危险确认、locale、视觉与可访问性、组件清单与状态映射；不含业务代码，不执行真实调优 |
| 平台前提 | 同一右侧栏 tab（`id=dsh-ascend-perf`、`kind=ascend-perf`）内增加“观测 / 调优”；TuneService、`ascend_tune_*` 四工具与 `/api/ascend-perf/tuning`；仅 `--dsw-alias-*` token 与 Client locale 服务 |
| 契约状态 | 对齐 t7 `tuning-v1` / `tune-plan-v1` / `tune-store-v1`；枚举与字段 snake_case；t7 未固定的展示细节在本文标注“待实现确认” |
| 当前阶段 | 设计稿。调优执行器尚未交付；一期 t4 面板不应提前出现调优入口。真实共享环境仍为只读，真实执行受维护窗口授权门限制 |

> 本文不是“调优已可用”的声明，也不把 DEMO、dry-run 或 `captured` 以外的数据写成真实收益。示例中的 target、窗口、数值均为说明用占位；真实 target 只由 Host 注册表提供。任何“启动/停止/清理”都必须经过 §9 的确认与 Host 安全门。

| t8 要求 | 对应章节 |
| --- | --- |
| 三流程：新建规格 → dry-run 预览 → 确认启动；运行中；结果 | §3、§4、§5、§6 |
| 全状态与每态文案、操作 | §7（§7.2 总表、§7.3 trial、§7.4 缺值） |
| 组件与字段：trial 表、best 卡、对比条、约束 badge、日志抽屉 | §8、§12.1 |
| 危险确认：启动真实调优、停止、清理进程 | §9 |
| 只读/演示/待授权标识、视觉一致、窄栏、可访问性 | §2.3、§7、§10、§11 |
| locale zh/en key、数字单位格式、组件清单与状态映射 | §10、§12 |

## 0 设计目标、原则与非目标

### 0.1 目标

1. 让用户在右侧栏内完成一条可审阅的链路：**定义可复现实验 → 生成计划 → dry-run 预览 → 显式启动 → 观察 → 结果/导出**；任何一步都能说清“当前是否接触真机、是否已产生副作用”。
2. 把“调优”与“观测”的语义分开：观测回答“现在是什么状态、两次运行差多少”，调优回答“在固定条件下搜索哪些服务配置、为什么推荐它”。两者共用视觉与来源标识，但不共用“只读”承诺。
3. 让计划、预算、授权、清理和失败都可解释：用户不必读日志或猜 Host 状态，就能知道下一步能做什么、为什么按钮不可用。
4. 无 NPU 环境也能完整演示搜索、SLO 失败、暂停/继续、部分失败和导出；演示数据始终不可伪装成真机。

### 0.2 设计原则

| 原则 | 含义 | 对 UI 的约束 |
| --- | --- | --- |
| 计划先行 | `plan` 是纯本地计算；计划不等于授权、不等于执行 | 生成计划不创建 job；计划页没有“直接跑真机”的快捷入口 |
| dry-run 不是执行 | dry-run 只检查计划/授权/资源是否 ready，返回 `job_id=null` | 预览页不能显示“已启动”“进行中”；不轮询、不产生 trial |
| Host 权威 | 状态机、score、best、Pareto、可行性、允许动作均由 Host 给出 | Client 不计算 best/score/前沿/判定；只格式化、过滤、展示 |
| 自有进程边界 | 只能停止/清理本插件通过 supervisor 启动并记录 ownership 的进程 | 不提供按名称杀进程、停容器、停系统服务；文案反复说明“仅本插件进程” |
| 证据先于结论 | 推荐必须带 SLO 证据、样本数、噪声带、清理状态 | best 卡不能只显示一个数字；无证据时显示“暂无/未知” |
| 状态显式 | `accepted` 只是受理；`stopping` 不等于已停止；`completed` 不等于有收益 | 按钮、进度和 toast 都区分“请求已受理/清理已验证/报告已完成” |
| 演示完整 | DEMO 走同一状态机；`remote_readonly=true`，`process_mutation`/`benchmark_traffic`/`remote_write=false`（Host 私有写入仍可能为 true），`evidence_kind=synthetic` | DEMO 横幅常驻；退出 DEMO 只切视图，不把同一 job 转成真机 |
| 窄栏优先 | 300–419px 仍能完成三流程 | 表单全屏、trial 卡片、Pareto 列表降级；不整页横向滚动 |
| 可访问 | 键盘、读屏、非颜色编码、减少动效 | 危险确认、图表、进度、日志都有文本替代 |

### 0.3 非目标（本期不做）

- 不做算子/kernel 调优、算子替换、精度或量化策略变更、权重转换、训练、多机/跨节点、Bayesian/RL。
- 不做自动部署、生产流量切换、把 best 参数写入常驻服务；不提供“一键应用/一键上线”。
- 不在 UI 内构造 shell 命令、任意 argv、URL、Host 路径、模型路径或 upload；只接受 Host 注册表中的逻辑 ID。
- 不在共享 target 上执行真实调优；不绕过 target policy、授权桥或维护窗口。
- 不让 Agent 在 UI 中自签授权；Agent 视图不渲染授权按钮。
- 不新建第二个右侧栏 tab、不另起网页、不使用 iframe。
- 不在 Client 端重新搜索、重算 score、重算 Pareto 或从失败表里挑最高吞吐。
- 不提供“强制通过/忽略 SLO/跳过清理”开关。

### 0.4 成功标准（可验收）

| 编号 | 标准 | 验收方式 |
| --- | --- | --- |
| U1 | 5 分钟内用 DEMO 完成“新建规格 → 生成计划 → dry-run 预览 → 运行演示 → 暂停/继续 → 完成 → 查看结果/导出” | 无 NPU 环境人工走查；每步有明确下一步 |
| U2 | 覆盖 §7.2 的全部主状态，且每态有文案、主操作与禁止项 | 状态快照/受控 fixture 走查 |
| U3 | 启动真实调优、停止、清理残留均有二次确认；危险文案明确“仅本插件进程” | 交互走查 + 文案表核对 |
| U4 | trial 表、best 卡、对比条、约束 badge、日志抽屉的字段与 t7 契约一致 | §8.8 对齐表逐项核对 |
| U5 | 所有调优文案有 zh/en key；数字、单位、百分比、时长、token 格式一致 | locale 切换走查 + §10.2 表 |
| U6 | 只读/演示/待授权/会产生副作用/清理待确认标识不可隐藏 | 截图检查 + 读屏播报 |
| U7 | 300px 宽度、键盘、200% 缩放、减少动效下三流程仍可完成 | 响应式与 a11y 走查 |
| U8 | 未授权/未满足门时零启动、零 SSH、零 HTTP、零远端写；UI 不提供旁路 | 与 t7 安全测试对应；UI 只依赖 Host 返回的 `allowed_actions` |

## 1 名词与角色

| 名词 | 定义 |
| --- | --- |
| 观测 / 调优 | 同一右侧栏 tab 内的两个内部页；观测是一期只读看板，调优是本文的搜索控制台 |
| Spec（规格） | 用户定义的目标、逻辑资产、固定条件、baseline、搜索空间、负载、SLO、测量与预算；`tune-spec-v1` |
| Plan（计划） | Host 由 spec 编译出的候选、剪枝、命令预览、effect manifest、预算与 blockers；`tune-plan-v1` |
| Job（作业） | 一次调优执行的生命周期；有状态机、预算、epoch、best 引用与 allowed_actions |
| Trial（试验） | 一个配置在某一 phase 的一次完整测量；包含 attempts（warmup/measure）、aggregate、可行性、清理状态 |
| Phase | `baseline` / `candidate` / `checkpoint` / `confirm` |
| Epoch | 因环境漂移重开的一组测量；旧 epoch 保留，不拼接收益 |
| dry-run | 只校验计划/门/预算，不创建 job、不启进程、不发 HTTP/SSH；返回 `job_id=null` |
| 真实执行 | local/ssh 上由本插件 supervisor 启动实验服务并产生 benchmark 流量；需配置开关、维护窗口 target、有效 grant、资源锁与窗口预算 |
| Grant（授权） | 可信用户对某个 `plan_hash`、target、资源集合、动作、窗口和预算的授权；UI 只引用 `grant_id`，不持有能力值 |
| EffectManifest | 计划中可审阅的副作用清单：端口、sandbox、启动/健康请求/bench/停止/清理、上限与模板 hash |
| 自有进程 | 本 job 的 supervisor 记录 `ownership_ref` 的 service/bench 进程组；不是系统中同名进程，也不是容器或 systemd 服务 |
| confirmed / provisional / recommended | 已完成最终确认的最佳 / 未完成确认的暂定最佳 / 无清晰改善时的推荐（可为 baseline，或 null） |
| Pareto | Host 计算的“吞吐↑、最坏 TTFT P99↓、最坏 TPOT P99↓、最小成功率↑”非支配集；UI 只画 |
| SLO | 用户明确给出的 TTFT/TPOT 上限与成功率下限；是硬约束，不是综合分 |
| Agent 视图 | 由 Agent 工具调用或非可信会话触发的视图；不提供授权按钮/参数 |

## 2 入口与信息架构

### 2.1 入口

| 入口 | 位置 | 行为 |
| --- | --- | --- |
| 同一右侧栏 tab | 右侧栏 tab 条，标题仍为“昇腾性能” | 打开一期既有面板；不新增第二个 sidebar tab |
| 内部 tab `观测 / 调优` | 面板标题栏下方，两等宽 tab | 默认“观测”；切到“调优”只换视图，不创建/启动 job |
| Agent 链接/指令 | Agent 回复中的定位 | 允许打开同一 tab 并定位 `params.tab='tuning'`（若 Client 实现）；不新开页面 |
| 最近作业 | 调优 landing 的列表 | 打开已有 job 的 status/report；不自动 resume |

规则：

- tab 标题固定“昇腾性能”；内部 tab 的可见文案用“观测”“调优”，完整无障碍名为“性能调优”。
- 不新增 guide 卡；一期 guide 仍指向观测。调优入口只在面板内部，避免把实验能力伪装成默认入口。
- 一期面板的视觉与三区结构不变；内部 tab 条是唯一新增的顶层导航。调优页不沿用“只读”页脚（见 §10.4）。
- 不新建浏览器路由、iframe 或独立页面；所有内容渲染在既有 keyed slot 内。

### 2.2 调优页骨架

调优页是**单列、阶段化**结构，而不是观测页的三区平铺：

```
标题栏：昇腾性能 [观测][调优]   [状态 chip] [读取状态]
来源/阶段条：executor · target · plan_hash · [演示/待授权/只读/副作用]
步骤条：① 规格  ② 计划与预览  ③ 运行  ④ 结果
├─ A 没有活动作业（landing）
│    目标与授权摘要 → [新建调优] [运行演示] → 最近作业
├─ B 已有计划、未启动
│    计划摘要（候选/剪枝/预算/阻断）→ 影响清单 → [dry-run 预览] [启动]
├─ C 运行中/暂停
│    作业头（状态/原因/epoch/预算/清理）→ 进度与当前 trial → best 卡 → trial 表 → 日志抽屉
└─ D 结果
     结论与 best vs baseline → 对比条 → Pareto/散点 → 失败 trial → 报告/导出 → 清理证据
页脚：默认仅规划 · 真实执行需维护窗口 · 只操作本插件进程 · 不自动部署
```

- 阶段条是导航与上下文，不是安全门；安全门只看 Host 的 `allowed_actions`、plan blockers、grant 和 target policy。
- 同一时刻只显示一个主阶段；历史 job 通过“最近作业”或阶段条回到对应 job，不并行打开多个作业视图。
- 不把“新建规格”做成常驻大表单；没有活动 job 时 landing 简洁，点击后进入全屏 sheet，避免窄栏首屏被表单淹没。

### 2.3 宽度与响应式

| 宽度 | 场景 | 调优页布局 |
| --- | --- | --- |
| `< 300px` | 平台不显示右侧栏 | 不适用；展开时按全屏处理 |
| `300–419px` | 窄栏/分屏 | 单列；内部 tab 等宽；规格 sheet 全屏；计划影响清单卡片化；trial 表变卡片；Pareto 变排序列表；危险弹窗全屏；按钮整行 |
| `420–559px` | 默认右栏 | 单列；计划摘要 2 列；trial 表紧凑 4 列（配置/状态、吞吐、SLO、耗时），行展开补充 TTFT/TPOT/成功率/score/清理；Pareto 图可显示，表 fallback 常驻 |
| `560–719px` | 右栏拉宽 | 单列；trial 表 7 列（试验/phase、配置摘要、状态、吞吐、TTFT P99、TPOT P99、成功率），展开显示耗时/score/清理/证据 |
| `≥ 720px` | 全屏/浮动 | 单列，内容最大宽 960px；trial 表 10–11 列；计划摘要与预算可并排；Pareto 图与列表并排；不改成左右双栏阅读 |

规则：

- 任何宽度下都不出现整页横向滚动；trial 表在 560–719px 可局部横向滚动，但 300–419px 必须用卡片替代。
- 危险确认在窄栏下不使用小弹窗；改为全屏 `alertdialog`，确认按钮与取消按钮均整行、顺序固定（取消在上，危险在下）。
- 内部 tab 不换行、不隐藏；标题“观测/调优”各 2 个汉字，窄栏仍可点。
- 图表至少 180px 高；300–419px 默认显示排序列表，用户可切“图表”但图表允许整块横向滚动并带 `role="region"`。

### 2.4 状态记忆、刷新与轮询

- 记忆：当前内部 tab、当前 job id、阶段、trial 过滤、trial 展开行、日志抽屉开合；按 pane + 工作区记忆。规格草稿只保存在 pane 内存，关闭/刷新丢失，不写 Host、不写 localStorage。
- 打开调优页**不自动采集目标、不自动生成计划、不自动启动**；只读取 Host 仓储中的最近作业/状态。
- 轮询：仅当调优 tab 可见、浏览器页面可见、且当前 job 处于非终态时，每 2s 调 `status`（`after_seq` 增量）；`hidden`/切到观测/无 job/终态时停止轮询。重新可见时先做一次完整状态同步，不重复发送 start。
- 事件 `gap`（`last_seq` 不连续）→ 重新拉取完整 `JobStatusPage`，再继续增量；不得跳过未知事件。
- `status` 5s 超时：保留上次成功数据，显示“状态读取失败，数据可能过期”+“重试”；连续失败指数退避，最长 30s；不自动重发任何控制动作。401/403/503 停止轮询，显示鉴权/后端错误，不降级为无鉴权。
- 计划生成 10s、start/resume/stop 15s 超时：只显示“请求已发出/等待受理”，不得自动重试；按 `idempotency_key` 查 receipt（UI 不展示 key，除诊断折叠）。
- 关闭 tab、浏览器断线、Agent 调用结束都不 cancel 作业；后台继续，重连按 `last_seq` 续读。

### 2.5 边界与“不做什么”

| 场景 | UI 行为 |
| --- | --- |
| 打开调优页 | 只读仓储；不连接 target、不探测端口、不调 `status` 采集 |
| 生成计划 | 纯本地编译；可写 Host 计划仓储；不启进程、不发 bench、不写远端 |
| dry-run 预览 | 只返回 ready/blocked；`job_id=null`；不占资源；不显示运行进度 |
| 运行演示 | 显式 `dry_run=false`；`executor=demo`；`remote_readonly=true`、`process_mutation`/`benchmark_traffic`/`remote_write=false`；可完整走状态机 |
| 真实启动 | 必须同时满足 t7 §5.1 的四个条件；UI 只转发 Host 返回的 `allowed_actions`，不自造旁路 |
| 停止 | 只停止本 job 拥有的 service/bench；文案不承诺“立即释放”，以 `cleanup_state` 为准 |
| 清理 | 只处理 manifest/ownership 记录的残留；不确定就进入人工处理，不扩大范围 |
| 结果 | 只读报告；不部署、不写目标、不自动发布 |

## 3 线框

> 线框只表达信息层级、顺序和状态，不固定像素。示例数值均为 DEMO/占位，不代表真实收益。

### 3.1 Landing（420–559px，无活动作业）

```
┌──────────────────────────────────────────────────┐
│ 昇腾性能   [观测] [调优]        [读取状态] [⋯]    │
├──────────────────────────────────────────────────┤
│ ● demo · demo-ascend · 合成 · 非真机              │
│ ① 规格   ② 计划与预览   ③ 运行   ④ 结果           │
├──────────────────────────────────────────────────┤
│ 性能调优                                          │
│ 在固定模型、设备与负载下搜索服务配置；先计划，     │
│ 预览通过后再启动。真实执行需要维护窗口授权。       │
│                                                  │
│ ┌ 目标与授权 ────────────────────────────────┐    │
│ │ 执行器：demo                               │    │
│ │ 目标：demo-ascend（合成，不接触真机）       │    │
│ │ 真实执行：关闭 · 共享 target：只读          │    │
│ │ [查看授权说明]                              │    │
│ └────────────────────────────────────────────┘    │
│                                                  │
│ [ 新建调优 ]        [ 运行演示 ]                  │
│                                                  │
│ 最近作业                                          │
│ ┌ 2026-11-07 14:20 · qwen-demo-throughput ─────┐  │
│ │ 已完成 · 3 可行 / 1 失败 · 无清晰改善        │  │
│ │ [查看结果] [导出报告]                        │  │
│ └──────────────────────────────────────────────┘  │
│ …                                                 │
├──────────────────────────────────────────────────┤
│ 默认仅规划 · 真实执行需维护窗口 · 不自动部署       │
└──────────────────────────────────────────────────┘
```

要点：没有 NPU 时 landing 仍显示“运行演示”，但不把真实执行静默切换成 DEMO；目标卡明确“演示/只读/关闭”。

### 3.2 新建规格（面板内全屏 sheet，420–559px）

```
┌ 新建调优规格 ─────────────────────────────── ✕ ┐
│ ① 目标与资产  ② 基线  ③ 搜索空间  ④ 负载与 SLO │
│ ── ④ 负载与 SLO ───────────────────────────── │
│ 输入长度       [ 512        ] token             │
│ 输出长度       [ 128        ] token             │
│ 请求数         [ 1000       ]                   │
│ 最大并发       [ 32         ]                   │
│ 请求速率       (•) 不限制  ( ) 固定 [ 10 ] rps  │
│ 随机种子       [ 42         ]                   │
│                                                  │
│ SLO（硬约束，不能留空后称“最佳”）                │
│ TTFT P99 ≤     [ 800        ] ms                │
│ TPOT P99 ≤     [ 60         ] ms                │
│ 成功率 ≥       [ 99         ] %                 │
│                                                  │
│ ▸ 测量与预算（默认值，通常不用改）                │
│   repeats 3 · warmup 1 · max_trials 12 …        │
│                                                  │
│ 高级设置只接受数值/枚举，不提供命令、路径、URL。  │
│                          [上一步] [生成计划]     │
└──────────────────────────────────────────────────┘
```

要点：逻辑资产在步骤①选择；数值错误就地定位；候选数与剪枝不在表单里猜，生成计划后由 Host 返回。

### 3.3 计划与 dry-run 预览（420–559px）

```
┌──────────────────────────────────────────────────┐
│ 昇腾性能 [观测] [调优]                 [读取状态] │
│ ● demo · demo-ascend · 计划未过期 · [仅预览]     │
│ ① 规格   ② 计划与预览   ③ 运行   ④ 结果          │
├──────────────────────────────────────────────────┤
│ 计划 qwen-demo-throughput                        │
│ hash 8f3c1a2e… [复制] · 2026-11-07 14:05 过期    │
│ 3 个候选 · 1 个剪枝 · 7 个配置批次 · 26 次 bench  │
│ 超时上界 ≤ 1 小时（不是承诺）· 最晚 14:20 截止    │
│                                                  │
│ ▾ 候选与剪枝                                      │
│   1  max_num_seqs 16 / batched 2048              │
│   2  max_num_seqs 32 / batched 2048              │
│   3  max_num_seqs 32 / batched 4096              │
│   剪枝：max_model_len 4096 < input+output        │
│                                                  │
│ ▾ 影响清单（EffectManifest）                      │
│   启动本插件服务 · 健康检查 · 26 次 bench         │
│   写入专属 sandbox · 停止本插件进程               │
│   不会停止其他服务/容器；不会按名称杀 vllm        │
│                                                  │
│ ▾ 命令预览（已脱敏，仅供审查）                    │
│   serve-v1  python -m vllm.entrypoints…          │
│                                                  │
│ [返回修改] [dry-run 预览] [运行演示] [申请授权]  │
├──────────────────────────────────────────────────┤
│ 预览结果：ready · 未创建作业 · 未占用设备/端口    │
│ [启动演示] / [启动真实作业]（需授权且 hash 一致） │
└──────────────────────────────────────────────────┘
```

要点：`dry-run 预览` 与 `启动` 分开；预览 receipt 明说 `job_id=null`；真实启动按钮在预览前禁用，计划变更后预览失效。

### 3.4 运行中（420–559px）

```
┌──────────────────────────────────────────────────┐
│ 昇腾性能 [观测] [调优]                 [读取状态] │
│ ● local · npu-lab · 运行中 · [会产生副作用]      │
│ ① 规格   ② 计划与预览   ③ 运行   ④ 结果          │
├──────────────────────────────────────────────────┤
│ 作业 tun-7f2a · 计划 8f3c1a2e · epoch 1           │
│ 运行中 · trial 4/7 · 已用 12:40 / 预算 ≤ 1:00:00 │
│ 清理：不适用（运行中） · [暂停] [停止]            │
│ ███████████░░░░  4/7 批次 · 1 失败                │
│                                                  │
│ 当前最佳（暂定）                                  │
│ ┌ max_num_seqs 32 · batched 4096 ─────────────┐  │
│ │ 输出吞吐 1,284.2 token/s  ± 31.5             │  │
│ │ TTFT P99 742 ms · TPOT P99 58.4 ms · 成功 99.4│  │
│ │ SLO 通过 · score ×1.08 · 未完成最终确认       │  │
│ └──────────────────────────────────────────────┘  │
│                                                  │
│ trial 表（紧凑 4 列，展开看全部）                 │
│ 试验/phase      状态      吞吐         耗时      │
│ t-01 baseline   已成功    1,187.4 ± 22  4:12     │
│ t-02 candidate  已成功    1,284.2 ± 31  4:30     │
│ ...                                              │
│ [查看证据/日志]                                   │
├──────────────────────────────────────────────────┤
│ 只操作本插件启动的进程 · 停止需等待清理确认        │
└──────────────────────────────────────────────────┘
```

### 3.5 暂停/清理待确认/恢复需人工

```
┌ 作业 tun-7f2a ───────────────────────────────────┐
│ 已暂停 · 原因：环境漂移（基线吞吐偏移 6.2%）      │
│ 当前 epoch 的 best 降为“暂定”；已完成 trial 保留  │
│ 清理：已验证 · 设备/端口锁已释放                  │
│ [继续（需重新校验授权）] [停止] [查看报告]         │
├──────────────────────────────────────────────────┤
│ 清理待确认（cleanup_pending）                     │
│ 无法确认本作业进程组已退出；不会再发起新 trial。   │
│ 已记录 ownership_ref；请核对清理或查看诊断。       │
│ [检查清理状态] [查看诊断]（不提供按名称杀进程）    │
├──────────────────────────────────────────────────┤
│ 恢复需人工（recovery_required）                   │
│ Host 重启/租约到期，作业未自动续跑；旧报告保留。   │
│ [核对清理] [导出部分报告] [新建计划]               │
└──────────────────────────────────────────────────┘
```

### 3.6 结果（560–719px）

```
┌──────────────────────────────────────────────────┐
│ 作业 tun-7f2a · 已完成 · 原因：no_clear_gain      │
│ DEMO · 合成 · 非真机 · 真机验证：未验证           │
├──────────────────────────────────────────────────┤
│ 结论：无清晰改善；建议保持 baseline               │
│ 2 可行 · 1 失败 · 0 无可行 · 最终确认 1 项        │
│ [导出 Markdown] [导出 JSON] [查看证据]            │
│                                                  │
│ best vs baseline（对比条）                        │
│ 输出吞吐   baseline 1,187.4 → best 1,284.2 +8.2%  │
│           [█████████████░░] 噪声带 ±31.5          │
│ TTFT P99   74.2 → 58.4 ms  -21.3%  SLO ≤800 通过  │
│ TPOT P99   61.0 → 58.4 ms  -4.3%   SLO ≤60 通过   │
│ 成功率     99.4% → 99.4%   0.0 pp  SLO ≥99 通过   │
│                                                  │
│ Pareto / 散点（吞吐 ↑ × TTFT P99 ↓）              │
│   ┌──────────────────────────────┐               │
│   │        ● confirmed           │               │
│   │   ○ provisional   △ baseline │               │
│   └──────────────────────────────┘               │
│   [切换轴：TPOT / 成功率] [表格视图]              │
│                                                  │
│ 失败 trial（1）                                   │
│ t-03 · OOM · 已清理 · [证据]（不自动重试）         │
│                                                  │
│ 清理证据：verified · 本插件进程组已退出            │
│ 报告：完整 · 规则/算法版本 …                       │
└──────────────────────────────────────────────────┘
```

### 3.7 窄栏（300–419px，卡片降级）

```
┌────────────────────────────┐
│ 昇腾性能 [观测][调优]       │
│ ● demo · 合成 · [仅预览]   │
│ ① ② ③ ④                   │
├────────────────────────────┤
│ 计划摘要                   │
│ 3 候选 · 7 批次 · 26 bench │
│ 超时上界 ≤ 1 小时          │
│ [dry-run 预览]             │
├────────────────────────────┤
│ trial 卡片                 │
│ ┌ t-02 candidate ────────┐ │
│ │ 已成功 · 可行          │ │
│ │ 吞吐 1,284.2 ±31.5     │ │
│ │ TTFT 742 ms · TPOT 58.4│ │
│ │ 成功 99.4% · 耗时 4:30 │ │
│ │ SLO 通过 · score ×1.08 │ │
│ │ [证据] [日志]          │ │
│ └────────────────────────┘ │
│ …                          │
├────────────────────────────┤
│ Pareto（列表）             │
│ 1. t-02 1,284 / 742 ms     │
│ 2. t-01 1,187 / 780 ms     │
│ [切换图表]                 │
└────────────────────────────┘
```

### 3.8 危险确认（全宽 sheet / 300–419px 全屏）

```
┌ 启动真实调优作业？ ─────────────────────── ✕ ┐
│ 目标：npu-lab（ssh）· 计划 hash 8f3c1a2e      │
│ 维护窗口：2026-11-08 22:00–23:00（本地）      │
│ 影响：启动本插件服务 · 26 次 bench · 写 sandbox│
│       · 停止本插件进程；不影响其他服务/容器    │
│ 预算：7 批次 / 26 bench / ≤ 1 小时            │
│                                                │
│ [ ] 我确认窗口已获可信授权，且只操作本插件进程  │
│ 输入计划 hash 前 8 位：[________]              │
│                                                │
│ [取消]              [启动真实作业]（危险）     │
└────────────────────────────────────────────────┘
```

停止与清理确认见 §9；三者共享同一危险弹窗组件，但文案、确认方式和禁用条件不同。

## 4 流程 A：新建规格 → dry-run 预览 → 确认启动

### 4.1 Landing 与初始状态

- 首次打开：`plan=null`、`job=null`、`status=empty`；显示“新建调优”和“运行演示”两个主操作。
- `最近作业`：来自 `status` 的 `jobs[]`，只显示 `job_id`、label、state、reason、更新时间、trial 进度、清理状态；点击进入该 job，不自动 resume。
- 无可用 target：`target` 卡显示“未配置可调优目标”；真实执行按钮禁用；仍可创建 demo 规格；不自动把 target 设为 demo。
- 无 NPU 但 demo 可用：显示“未发现真实 NPU；可运行演示”；不把它写成“无设备错误”。
- target 为 `readonly`：显示“共享只读”badge；真实启动按钮禁用并给 tooltip；演示仍可用。
- `tuning.enabled=false`：整个调优入口隐藏/禁用（以 t7 配置为准）；不要在 UI 里自行覆盖。

### 4.2 新建规格（四步 sheet）

| 步骤 | 字段（必须/可选） | UI 规则 |
| --- | --- | --- |
| ① 目标与资产 | `executor`（必须，demo/local/ssh）、`target_id`、`profile_id`、`model_asset_id`、`dataset_asset_id`、`label`（可选） | 只显示 Host 注册表中的逻辑 ID；不提供路径/URL/命令输入；选择 local/ssh 时显示 target policy 与授权状态；demo 显示“合成，不接触真机” |
| ①+ 固定条件 | `fixed.dtype`、`fixed.quantization`、`fixed.tensor_parallel`、`fixed.device_ids`、`fixed.served_model_name` | 默认由 profile 声明；只允许 profile 支持值或只读；`device_ids` 是逻辑整数，不显示物理路径；不提供任意 flags/extra_args |
| ② 基线 | `baseline.max_num_seqs`、`max_num_batched_tokens`、`gpu_memory_utilization`、`max_model_len`（四个都给出） | 数值输入 + 单位/范围提示；profile 约束就地校验；不从既有服务反推；不提供“自动探测最优基线” |
| ③ 搜索空间 | `space.max_num_seqs[]`、`space.max_num_batched_tokens[]`（必须轴）；可选 `gpu_memory_utilization[]`、`max_model_len[]` | 离散值编辑（增删/排序/去重）；不接受表达式、通配符、任意 flags；轴值上限提示；候选数生成计划后由 Host 算，表单不预览 |
| ④ 负载与 SLO | `workload`（input/output、num_prompts、max_concurrency、request_rate_mode/rps、seed、stream、ignore_eos）；`objective.constraints`（TTFT/TPOT 上限、成功率下限）；`min_gain_pct`、`noise_floor_pct`、`tie_epsilon_pct`；`measurement`；`budget` | 默认值可折叠；SLO 不得留空；`finite` 时必须给 rps，`unbounded` 时置灰并写 `null`；`unknown` 不可执行；预算只能收紧，不能超过 Host 硬上限 |

交互细节：

- 步骤条可点击回退，但“下一步”先做本步校验；错误列表在顶部，点击定位字段并用 `aria-describedby` 关联。
- 数值输入使用 `inputmode=decimal`，失焦格式化；粘贴超大文本拒绝；不把 `NaN/Infinity/-0` 当合法值。
- 空间轴编辑使用“值 chip + 输入”而非多行 JSON；最后仍以 Host JSON Schema 校验为准。
- `高级` 默认折叠，包含 repeats/confirm/budget/timeout；展开时显示“这些值影响预算和耗时”提示，不显示真实命令。
- `保存草稿` 只存在 pane 内存；关闭页面即丢失，不写 Host；开始生成计划前提示“计划基于当前草稿”。
- 规格变化会使旧 plan/preview 失效；UI 显示“规格已修改，请重新生成计划”，不清空旧 plan 历史但禁止用旧 hash 启动。

### 4.3 生成计划（无副作用）

1. 点击“生成计划” → `ascend_tune_plan({spec})`；按钮进入 busy，禁用重复提交；10s 超时后显示“计划生成超时，未创建作业”。
2. 成功：`plan_id`/`plan_hash`/`candidates`/`pruned`/`commands_preview`/`effect_manifest`/`budget_estimate`/`blockers`/`expires_at` 进入计划页；不自动 dry-run、不自动启动。
3. 失败：`INVALID_SPEC`/`UNKNOWN_FIELD`/`SPACE_TOO_LARGE`/`ASSET_UNKNOWN`/`PROFILE_UNSUPPORTED` 等显示在表单顶部；字段错误定位到具体输入；不生成可执行作业。
4. 计划默认 24h 过期；页面显示 `expires_at` 与“过期后需重新生成”；过期后启动/预览按钮禁用，授权不可复用。
5. `plan_hash` 可复制；`spec_hash` 放诊断折叠；`compiler_version` 只读展示；不显示 Host 绝对路径或凭据。

### 4.4 计划审阅

计划页按“先看阻断，再看影响，最后看命令”的顺序：

| 区块 | 内容 | 规则 |
| --- | --- | --- |
| 计划摘要 | label、`plan_hash`、有效期、候选数、剪枝数、`trial_batches`、`bench_invocations`、`timeout_upper_bound_s`、`configured_deadline_s` | “超时上界”必须标注“不是承诺”；没有 `demo_estimate` 时不编造“预计 20 分钟” |
| 候选与剪枝 | `candidates[]` 四参数；`pruned[]` 的 `reason`、`params` | 只显示 Host 结果；不提供“取消剪枝”或“手动加候选”绕过 |
| 影响清单 | `effect_manifest` 的 target/executor/model/device_ids/ports/sandbox/start_service/health_requests/benchmark_requests/stop_owned_processes/write_sandbox/cleanup_owned_files/上限/模板 hash | 路径只显示 opaque sandbox/逻辑 ID；端口可显示 loopback；必须出现“仅停止本插件启动的进程” |
| 命令预览 | `commands_preview[].step/template_id/argv_redacted` | 只读、脱敏；无“执行”按钮；可复制用于审查；不把命令塞进可编辑输入 |
| 预算 | `BudgetEstimate` 的 candidate_count/pruned_count/trial_batches/bench_invocations/warmup_invocations/measured_invocations/max_requests/reserved_tokens/timeout_upper_bound_s/configured_deadline_s/cleanup_reserve_s/fit/warnings | “fit=no/partial”必须警告；预算不足时启动按钮禁用或提示重新规划 |
| 阻断项 | `blockers[].code/field/message` | 阻断未清空时禁止启动；每条给“去修改”定位；不提供“忽略” |
| 授权摘要 | target policy、是否有可信授权桥、当前 grant 摘要 | 只读；授权动作仅在可信用户会话显示（§9.5） |

按钮顺序（宽栏）：

- 主：`dry-run 预览`（次级主操作）→ 预览通过后 `运行演示` 或 `启动真实作业`。
- 次：`返回修改`、`复制计划 hash`、`查看规则/诊断`。
- 禁用：计划过期、blockers 非空、规格已变更、真实执行门不满足。

### 4.5 dry-run 预览

- 调用 `ascend_tune_run({action:'start', plan_id, dry_run:true, idempotency_key})`；这是一个**无副作用**的控制请求。
- 成功时 `ControlReceipt.job_id=null`、`dry_run=true`、`job_state=planned`、`cleanup_state=not_needed`；UI 显示“预览通过，未创建作业、未占用设备/端口”。
- 失败时 `status=blocked` 或 `error`；显示 `blockers[]`/`error.code`；不创建 job；不显示“已启动”。
- 预览摘要固定包含 t8 要求的 **trial 数** 与 **预计耗时**：trial 数用 `budget_estimate.trial_batches`（配置批次）并附 `bench_invocations`；预计耗时因 t7 `BudgetEstimate` 没有点估计，显示为“预计耗时上界 ≤ `timeout_upper_bound_s`（不是承诺）”，并附 `configured_deadline_s` 最晚时限；若 Host 后续提供区间/点估计字段，优先显示。预算明细还包括 `max_requests`、`reserved_tokens`、`cleanup_reserve_s` 与 `fit`；不承诺实际完成时间。
- 预览通过记录 `preview_plan_hash` 与时间；如果计划 hash 或 spec 变化，预览失效；真实启动按钮要求当前 plan 的预览通过。
- 预览不轮询、不显示“运行中”；`读取状态`不因预览而启动作业。

### 4.6 确认启动

#### A. 运行演示（demo）

- 条件：`executor=demo`、计划无阻断、demo profile/model/dataset 可用。
- 动作：`start` + `dry_run:false`；`source.is_demo=true`、`evidence_kind=synthetic`；`remote_readonly=true`，`process_mutation`/`benchmark_traffic`/`remote_write=false`。
- 确认：普通确认弹窗（非危险确认）说明“将运行合成搜索，不接触真机、不产生真实流量”；按钮“运行演示”。
- 启动后进入运行页；不因为“只是演示”而跳过状态机；暂停/继续/停止与真实作业同一交互（但真实副作用标记保持 false）。
- DEMO 横幅常驻；退出 DEMO 只切到观测/其他计划，不把同一个 job 转成真实。

#### B. 启动真实调优（local/ssh）

前置条件（全部满足才允许点击）：

1. `tuning.enableRealExecutors=true`；当前 target policy 为 `maintenance_only`（共享 `readonly` 不可）；
2. 选中的 profile 受支持，资产指纹已审阅；
3. 存在有效、未过期、绑定当前 `plan_hash` 的 `AuthorizationGrant`；
4. 资源锁/端口/窗口预算可用；
5. 当前用户会话是可信用户（Agent 视图不提供按钮）。

按钮行为：

- 条件不满足：按钮禁用，旁边显示原因 chip（`共享只读`/`真实执行关闭`/`待授权`/`授权已过期`/`计划已过期`/`有阻断`）；不提供“强制启动”。
- 满足：打开 §9.2 危险确认；确认后调用 `start` + `dry_run:false` + `authorization_id`；返回 `accepted` 后进入运行页，`job_id` 以 receipt 为准。
- `accepted` 只代表受理：运行页先显示“已受理，等待锁/租约/启动”，直到 status 真正进入 `running`；不要用 toast 宣布“调优已开始”。
- 启动失败：`AUTH_*`/`TARGET_READONLY`/`REAL_EXECUTION_DISABLED`/`RESOURCE_LOCKED`/`PORT_BUSY`/`SSH_UNREACHABLE` 显示为页内错误，不创建假 job；不自动切 demo。

### 4.7 计划变更、过期与幂等

| 事件 | UI | 数据 |
| --- | --- | --- |
| 用户改规格 | 顶部提示“规格已修改，旧计划/预览失效”；返回计划页时禁用旧“启动” | 旧 plan 保留在历史；新计划须重新生成 |
| 计划过期 | 摘要显示“已过期”；按钮禁用；说明“重新生成计划，不要复用旧授权” | `expires_at` 过后不启动 |
| 预览后计划变更 | 预览标记“已失效”；真实启动要求重新预览 | `preview_plan_hash` 不匹配 |
| 重复点击启动 | 按钮 busy；同一 `idempotency_key` 返回原 receipt；不重复创建 job | UI 不生成新 key；超时后先查 status/receipt |
| 409 revision conflict | 刷新 status，显示“状态已变化，已更新按钮”；不盲目重试 | 使用最新 `expected_revision` |
| 授权过期/撤销 | 启动按钮禁用；显示“需重新授权”；不自动续期 | grant 由可信用户桥管理 |

## 5 流程 B：运行中监控

### 5.1 作业头

作业头是所有运行态的第一屏，必须回答：**在哪个目标上、由谁执行、处于什么状态、为什么、预算还剩多少、清理是否完成、现在能做什么。**

| 元素 | 字段 | 展示规则 |
| --- | --- | --- |
| 标题 | `job_id`、`label`、`plan_id`/`plan_hash` | `job_id` 等宽；hash 可复制；不显示绝对路径 |
| 来源 | `source.mode`、`target_id`、`is_demo`、`evidence_kind` | DEMO/合成/未验证不可隐藏；target 只显示别名 |
| 状态 | `job.state`、`job.reason`、`epoch` | 状态 badge + 原因文本；`completed` 不自动等于有收益 |
| 副作用 | `effects.remote_readonly/host_private_write/process_mutation/benchmark_traffic/remote_write` | 真实运行显示“会产生副作用”；status/report 显示“只读”；demo 显示“无真实副作用” |
| 预算 | `budget.limits/reserved/consumed/remaining` | 时间/请求/token 三条进度；remaining 为 0 时禁止新动作；不在 UI 自行放宽 |
| 进度 | `progress.planned/complete/failed`、`active_trial_id` | 计数来自 Host；失败计数单独显示，不并进“完成” |
| 清理 | `cleanup_state` | `not_needed`/`pending`/`verified`/`unknown`；`unknown` 时显示“需人工核对”，不显示“已释放” |
| 授权 | `authorization_summary` | 窗口、资源、预算摘要；不显示 capability；过期显示“已过期” |
| 动作 | `allowed_actions` | 只渲染 Host 允许的动作；按钮的禁用/隐藏以它为准 |

### 5.2 进度与当前 trial

- 进度条：`progress.complete / progress.planned`，失败用独立计数与文字，不用红色把整条进度染红；`role=progressbar`，`aria-valuetext` 包含“已完成 X / 计划 Y，失败 Z”。
- 当前 trial：显示 `trial_id`、`candidate_id`、`phase`、`state`、`params`、当前 attempt；状态细分为 preparing/starting/health_check/warming/measuring/evaluating/cleaning，不让用户只看到“运行中”。
- 时间：显示 `started_at`、已用时间、`budget.remaining`；有 `configured_deadline_s` 时显示“最晚截止”，不把上界写成预计完成。
- 预算条：时间/请求/token 三条；接近上限时用警告色 + 文本“剩余预算不足，可能提前结束”，不自动降低测量次数。
- `baseline_drift` 事件或 `environment_drift`：显示警告条，说明“基线已漂移，当前 epoch 的 best 仅为暂定”；提供“查看证据/暂停/生成新计划”，不提供“继续用漂移数据”。

### 5.3 trial 表

trial 表是运行页的核心证据表。列定义与 t7 字段对齐（详见 §8.4）：

| 列 | 字段 | 说明 |
| --- | --- | --- |
| 试验 / phase | `trial_id`、`candidate_id`、`phase` | 短 ID + 完整 ID tooltip；phase 用文字 badge |
| 配置 | `params.max_num_seqs`、`max_num_batched_tokens`、`gpu_memory_utilization`、`max_model_len` | 窄栏折叠为“seq/batched”摘要，展开看全量 |
| 状态 | `state`、`feasibility` | 状态与可行性分开；“失败”不等于“不可行”（未测到） |
| 吞吐 | `aggregate.throughput.median`、`mad`、`min`、`max`、`noise_low/high`；`metrics.output_throughput_tps` | 显示“中位数 ± 噪声带”，不把噪声带画成置信区间；保留 sample_count |
| TTFT P99 | `metrics.ttft_p99_ms`；`aggregate.ttft_p99_policy` | 标注“最坏重复批次 P99”，不写“全请求 P99” |
| TPOT P99 | `metrics.tpot_p99_ms`；`aggregate.tpot_p99_policy` | 同上；缺值显示“缺失 + 原因” |
| 成功率 | `metrics.success_rate_pct`；`aggregate.success_policy` | 显示最小值口径；不把多个成功率平均 |
| SLO | `violated_constraints[]`、`feasibility` | 通过/超限/未知三态；约束 badge 显示 limit/observed/operator |
| score | `score` | Host 给的相对比值，显示 `×1.08`；`null` 不显示 0 |
| 耗时 | `started_at`、`ended_at` | 展示派生时长†；运行中显示“已运行”；不自行改判状态 |
| 清理 | `cleanup_state` | 失败/中断 trial 尤其要显示；`unknown` 不写“已清理” |
| 证据 | `attempts[]`、`artifact_refs[]` | 打开日志抽屉；不内联全日志 |

排序与筛选：

- 默认按 Host 返回的 trial 顺序（计划/阶段顺序），不默认按吞吐排序，避免把“最高吞吐但 SLO 失败”顶到最前。
- 过滤：全部/可行/失败/基线/确认；筛选不影响表头汇总和报告结论；筛选后显示“显示 X / 共 Y”。
- 行展开：配置全量、attempts、约束证据、score、清理与失败原因；窄栏用卡片内展开。
- 不提供“从此表选最佳”；best 只来自 Host 的 refs/report。

### 5.4 当前 best 卡

运行中只显示 `provisional_best`（若 Host 已给）与 baseline；**不能**在 UI 里挑吞吐最高的 trial 当 best。

| 状态 | 卡标题 | 内容 | 动作 |
| --- | --- | --- | --- |
| 有暂定 best | 当前最佳（暂定） | candidate/trial、四参数、吞吐中位数 ± 噪声、TTFT/TPOT P99、成功率、SLO、score、样本数、“未完成最终确认” | 查看证据、查看对比（若报告可用） |
| 无暂定 best、有可行 trial | 暂无确认最佳 | “已有可行配置，等待最终确认”；列出最近可行 trial 数 | 查看 trial 表 |
| 无可行 trial | 暂无可行配置 | “当前没有同时满足 SLO 的配置”；显示失败/超限计数 | 查看失败证据 |
| 基线不可行 | 基线未满足 SLO | 明确“不能声称在保持基线 SLO 下改善”；候选可入选但不写“保持基线” | 查看约束证据 |
| 完成 | 已确认最佳 | 仅当 `confirmed_best` 存在；显示确认样本数、gain、SLO、清理/报告链接 | 查看报告、导出 |

best 卡不显示“一键应用/部署/上线”；最多显示“查看报告”和“复制参数”（复制为文本，不执行）。

### 5.5 暂停、继续、停止

| 动作 | 语义 | UI 行为 | 二次确认 |
| --- | --- | --- | --- |
| 暂停 `pause` | 立即阻止新 invocation，取消当前 bench，清理本作业服务；部分 repeat 标 interrupted 保留；`paused` 仅在清理 verified 后 | 点击后按钮 busy；显示“正在暂停，等待当前动作收尾与清理确认”；不显示“已暂停”直到 status | 轻确认：“暂停会取消当前 bench 并停止本作业服务；已完成 trial 保留。” |
| 继续 `resume` | 从该 trial 的 warmup + 全 repeats 重测；重新获取相同资源、重新检查授权窗口 | 按钮来自 `allowed_actions`；若授权过期/资源变化，显示“需重新授权/重新计划”；不自动续跑 | 轻确认 + 显示“会重新校验授权与资源” |
| 停止 `stop` | 永久停止请求；重复 stop 幂等；终态不可 resume；先取消 bench，再停止自有进程并清理 | 点击后显示“已受理，等待清理确认”；`cleanup_state=verified` 前不写“资源已释放”；按钮不重复发信号 | §9.3 危险确认（checkbox） |
| 清理/核对 | 仅在 `cleanup_pending`/`recovery_required`；只处理 ownership 记录 | 显示“检查清理状态”或 Host 允许的清理动作；不按名称杀进程；不确定则人工 | §9.4 危险确认（输入 job 短 ID） |

反馈原则：

- `accepted` 不等于 `paused`/`cancelled`；toast 文案用“停止请求已受理”，最终状态看作业头。
- 停止中不要同时显示“继续”；`allowed_actions` 决定按钮，避免用户误点。
- 暂停/停止失败：`CLEANUP_UNVERIFIED`/`CONNECTION_LOST` 进入 `cleanup_pending`，显示“不会启动下一个 trial”；不自动重试 stop 信号。
- 关闭 tab/浏览器断线不自动停止作业；回归时从 `last_seq` 继续，gap 时全量同步；永不重复发送 start。

### 5.6 事件、日志与证据抽屉

日志抽屉从右侧滑出（窄栏全屏），三个 tab：

| tab | 内容 | 规则 |
| --- | --- | --- |
| 事件 | `events[]` 的 seq/type/time/trial_id/operation_id/code/message | 默认只显示状态变更/错误/清理；按 seq 稳定分页；不重复展示每 2s 轮询 |
| 日志 | 本 job stdout/stderr 的限额分段 | 纯文本渲染，不用 `dangerouslySetInnerHTML`；ANSI 清洗；`truncated=true` 明示；不自动跟随滚动 |
| 证据 | `artifact_refs[]`、attempt 退出码、SLO 证据、清理事实 | 只显示 opaque artifact_id/metadata；下载走授权路由；不显示 Host 路径；不把日志当指令 |

- 抽屉标题显示“本作业日志（已脱敏）”；关闭后焦点回触发按钮；Esc 关闭；不因新事件自动弹出。
- 日志中可能含外部文本；仅当数据，不渲染链接/HTML，不执行其中命令。
- 复制诊断包含 job_id、plan_hash、错误码、时间，不包含凭据、完整路径或 prompt 正文。

### 5.7 环境漂移、超时与部分失败

| 情况 | UI 表现 | 操作 |
| --- | --- | --- |
| 环境漂移 `ENVIRONMENT_DRIFT` | 作业 `paused`；横幅“基线漂移超过阈值，当前 epoch 的 best 仅为暂定”；显示偏移证据 | 查看证据、重新授权后 `restart_epoch`、停止；不提供“忽略漂移继续” |
| Trial 超时 `timeout` | trial 状态“超时”；显示启动/bench 超时项、已停止与清理状态；计入失败预算 | 查看日志、停止作业、导出部分报告；不自动换小负载重试 |
| 作业时限 `WINDOW_EXPIRED`/`BUDGET_EXHAUSTED` | 作业头原因；显示已用预算/截止；“完成”可能是部分报告 | 查看部分报告、导出、新建计划；不自动续期/扩预算 |
| 部分失败 | `completed` + `progress.failed>0`；横幅“部分 trial 失败，结论仅基于成功且可行样本” | 查看失败 trial、导出报告；不重试失败 trial（需新计划） |
| 清理未确认 | `cleanup_pending`/`CLEANUP_UNVERIFIED`；不发起下一 trial；按钮受限 | 检查清理、诊断、导出部分报告；不显示“资源已释放” |
| 恢复需人工 | `recovery_required`；旧 job 不自动续跑 | 核对清理、导出、新建计划；不自动重发 bench |

## 6 流程 C：结果与导出

### 6.1 完成与报告读取

- 作业进入 `completed`/`cancelled`/`failed` 后，结果页读取 `ascend_tune_report`；`is_partial=true` 时顶部显示“部分报告”，不隐藏失败/未确认信息。
- 结果页先显示结论区，再显示证据；不先展示“收益 +8%”而把 SLO 失败藏在下面。
- `summary` 使用 Host 给的结论文本/结构化字段；UI 不自行拼“成功/失败”大结论。
- 无报告（`REPORT_NOT_READY`/仓储未完成）显示“报告尚未生成”+重试；不根据 trial 表自造报告。

### 6.2 best vs baseline 对比条

四行固定（顺序不随数值变化）：

1. 输出吞吐 `output_throughput_tps`（越高越好）
2. TTFT P99 `ttft_p99_ms`（越低越好）
3. TPOT P99 `tpot_p99_ms`（越低越好）
4. 成功率 `success_rate_pct`（越高越好）

每行显示：

- baseline 原值、best/推荐值、绝对差、相对变化（Host `comparison` 或报告字段；UI 不计算 verdict）。
- 吞吐噪声带：baseline/best 的 `aggregate.throughput.noise_low/high`；文案“噪声带，不是置信区间”。
- SLO 约束：limit、observed、通过/超限/未知；badge 文字 + 图标，不仅颜色。
- 若 `baseline` 不满足 SLO：整条加警告说明“基线本身未满足 SLO，不能声称保持基线 SLO 改善”。
- 若 `recommended=baseline/no_clear_gain`：标题写“推荐保持基线”，不强行展示“最佳”。
- 若 `no_feasible_candidate`：不显示绿色 best 条，显示“无可行配置”空态与失败证据入口。

### 6.3 Pareto / 散点

- 数据来自 `report.pareto`（Host 已按同 epoch/指纹、完整且可行过滤）；UI 不重新计算支配关系。
- 默认轴：X=输出吞吐（↑），Y=最坏 TTFT P99（↓）；可切 Y=TPOT P99/成功率；切换只改视图，不改数据/结论。
- 点样式：
  - `confirmed_best`：实心圆 + 外环 + 星标 + 文本“已确认”；
  - `provisional_best`：空心圆 + “暂定”；
  - baseline：三角 + “基线”；
  - 其他可行：小圆；被支配/不可行不进入前沿（若 Host 返回参考点则灰色方块并标“参考”）。
- 交互：hover/focus 显示 trial/candidate、四参数、吞吐、TTFT/TPOT、成功率、SLO、score；点击选中 trial 行；键盘可 Tab 到点、方向键切换。
- 图例用形状 + 文本，不只颜色；轴标签带方向箭头与单位；无数据时显示“没有满足约束的配置，无法绘制 Pareto”。
- 300–419px 默认显示 `ParetoTable` 排序列表（吞吐降序），可切图表；图表允许横向滚动并带 `role="region"`。
- 图表下方提供“表格视图”切换；表格是完整可读替代，不是隐藏的 a11y 补丁。

### 6.4 失败 trial 与部分报告

- 失败筛选包含 `failed/timeout/oom/invalid_metrics/interrupted/cancelled`；显示 `state`、`reason`、`attempts`、`exit_code`、`cleanup_state`、artifact 入口。
- 不提供“重试此 trial”按钮；文案“失败配置不自动重试；需要新计划或新作业”并链接“新建计划”。
- 不把失败 trial 从“总数/预算”中隐藏；显示“失败 X / 总 Y”，并说明失败计入预算。
- 报告 `limitations` 原文展示；不删减 Host 给出的限制；DEMO 报告每页/导出都带“DEMO，非实测调优”。

### 6.5 导出

| 动作 | 行为 | 约束 |
| --- | --- | --- |
| 导出 Markdown | `report(format:'markdown')`；浏览器下载或复制 | 返回 `filename/mime/content/sha256`，inline ≤64KiB；超限稳定分页，不静默截断 |
| 导出 JSON | `report(format:'json')`；下载 | 同上；保留 `is_partial`、`is_demo`、`evidence_kind`、`real_execution_verified=false` |
| 导出 trial 证据 | `report(trial_id)` 或 artifact 下载 | 只读；不含凭据/绝对路径/prompt 正文；大文件分页 |
| 复制参数 | 复制 best 四参数文本 | 不执行、不部署；不写目标；贴到别处需用户自行负责 |
| 发布到观测 | 本期结果页不提供 | t7 `/publish` 是否在本期暴露见 §13；不提供“部署” |

- 导出页脚/头部固定写：`DEMO/合成`（如适用）、`is_partial`、`source`、`plan_hash`、`report_revision`、`cleanup_evidence`、`real_execution_verified`。
- 不导出设备原始快照、日志原文（除非单独 artifact 且经授权）、凭据、真实主机路径。
- 文件名由 Host 给；UI 不拼接 Host 路径；下载失败给可重试提示，不显示本地任意路径输入。

### 6.6 清理证据与终结

- 结果页底部显示 `cleanup_evidence` 摘要：`cleanup_state`、已停止的 ownership refs（不显示敏感 pid 细节）、端口/资源锁释放、无法核对的项。
- `cleanup_state=verified` 才显示“资源已释放”；`pending/unknown/recovery_required` 显示“待核对/需人工”，并解释不会自动清理。
- 停止原因 `user_stop`/`window_expired`/`auth_revoked`/`budget_exhausted` 在结论区单独展示；不把“预算耗尽”写成“已完成最优”。
- 作业终态不可 resume；新计划需重新生成/授权；UI 不提供“重开同一 job”按钮。

## 7 全状态矩阵

### 7.1 作业状态机（UI 视图）

```
planned ──blocked（规格/策略/授权不足）
   │
   └─queued ──running ──pausing ──paused
                 │           │
                 ├─stopping ──┴─> cancelled（清理 verified）
                 ├─completed（清理 verified）
                 ├─failed（清理 verified）
                 └─cleanup_pending ──> recovery_required（租约/重启）
paused ──queued（显式 resume + 新门检查）
paused/stopping ──cleanup_pending
recovery_required ──paused（核对清理成功）/ cancelled（放弃并核对）
```

UI 只渲染 Host 的状态，不自行推进；`allowed_actions` 决定按钮。`blocked` 是计划状态，不是“正在执行”。

### 7.2 状态总表（每态文案与操作）

| # | 状态 | 触发/判定 | 主文案（zh） | 主要操作 | 禁止/继续显示 |
| --- | --- | --- | --- | --- | --- |
| 1 | 无真机/无目标 | 无可用 target；或无 NPU 但 demo 可用 | “未发现可用的调优目标。可先运行演示，真实执行需配置维护窗口目标。” | 新建 demo 规格、运行演示、查看配置说明 | 不自动切 demo；不伪造 target |
| 2 | SSH 失败/断线 | `SSH_UNREACHABLE`/`CONNECTION_LOST` | “SSH 目标不可达，未创建/未继续作业。已收到的状态保留，不会自动重发 benchmark。” | 重新读取状态、查看诊断、停止（若已有 job）、改用演示 | 不自动重试启动；不杀远端进程 |
| 3 | 权限不足/待授权 | `AUTH_*`/`TARGET_READONLY`/`REAL_EXECUTION_DISABLED` | “当前目标/环境不允许真实执行：共享只读或缺少可信用户授权。演示仍可运行。” | 查看授权说明、申请维护窗口（可信用户）、运行演示 | 不提供强制启动/Agent 自签；不显示“执行成功” |
| 4 | 演示模式 | `source.mode=demo`；`is_demo=true` | “演示数据，非真机；合成搜索不代表真实性能。” | 运行/暂停/停止演示范例、导出 DEMO 报告、退出演示 | 不转真机；不隐藏 DEMO；不产生真实流量 |
| 5 | 空数据 | 无 plan/job/trial/report | “还没有调优作业。先生成计划，预览通过后再启动。” | 新建调优、运行演示、查看最近作业 | 不自动生成计划；不显示假 trial |
| 6 | 加载 | 计划生成/状态/报告读取中 | “正在读取调优状态…” / “正在生成计划…” | 等待；超时后重试；取消当前读取（不取消后台 job） | 不显示空表为“无数据”；不重复提交 |
| 7 | 计划已生成 | plan 有 blockers=[] | “计划已生成，尚未启动；dry-run 预览不会创建作业。” | dry-run 预览、运行演示、申请授权 | 不显示为“运行中”；不改计划 hash |
| 8 | 计划阻断 | `blockers[]` 非空 | “计划有 N 个阻断项，修正后才能启动。” | 返回修改、查看阻断详情、重新生成计划 | 不提供忽略/强制启动 |
| 9 | 已排队 | `queued` | “已受理，等待资源锁/租约；尚未开始测量。” | 查看状态、停止 | 不把 accepted 写成 running；不重复 start |
| 10 | 运行中 | `running` | “正在测量 trial X/Y；预算剩余 …；清理状态不适用。” | 暂停、停止、查看 trial/日志/证据 | 不显示“资源已释放”；不自动暂停 |
| 11 | 暂停中/已暂停 | `pausing`/`paused` | 暂停中：“正在取消当前 bench 并清理本作业服务…”；已暂停：“已暂停，清理已验证；继续需重新校验授权。” | 继续、停止、查看报告/证据 | 不显示“模型仍驻留”；不在清理未验证时 resume |
| 12 | 停止中/已取消 | `stopping`/`cancelled` | 停止中：“停止请求已受理，等待清理确认…”；已取消：“作业已取消，终态不可继续。” | 查看清理证据、导出部分报告、新建计划 | 不显示“已停止”直到 verified；不提供 resume |
| 13 | 完成 | `completed` | “作业完成；结论：{improved/no_clear_gain/no_feasible_candidate}。” | 查看报告、导出、新建计划 | 不自动部署；无收益时不写“最佳提升” |
| 14 | 部分失败 | `completed` + `progress.failed>0` | “部分 trial 失败（X/Y）；结论仅基于成功且可行样本。” | 查看失败证据、导出部分报告、新建计划 | 不重试失败 trial；不隐藏失败计数 |
| 15 | 超时 | trial `timeout`；job `WINDOW_EXPIRED`/预算时限 | “启动/bench 超时，已停止本 trial 并等待清理确认；不会自动换小负载重试。” | 查看日志、停止作业、导出部分报告 | 不自动重发 bench；不越过窗口 |
| 16 | 清理待确认 | `cleanup_pending`/`CLEANUP_UNVERIFIED` | “无法确认本作业进程组已退出；不会再发起新 trial。仅本插件进程会被处理。” | 检查清理状态、查看诊断、导出部分报告 | 不按名称杀 vllm；不显示“资源已释放” |
| 17 | 恢复需人工 | `recovery_required` | “Host 重启/租约到期，作业未自动续跑；旧报告保留。” | 核对清理、导出、新建计划 | 不自动 resume；不重发 bench |
| 18 | 计划/授权过期 | `PLAN_EXPIRED`/`AUTH_EXPIRED` | “计划或授权已过期；请重新生成计划并重新授权，不复用旧 grant。” | 重新生成计划、申请授权、导出旧报告 | 不自动续期；不复用旧 hash |
| 19 | 仓储配额/损坏 | `STORE_QUOTA`/`STORE_CORRUPT`/`SCHEMA_UNSUPPORTED` | “调优仓储不可写/配额不足/版本不支持；未启动新副作用。” | 查看诊断、清理已完成作业（若允许）、新建独立计划 | 不自动清空；不跳过 provenance |

> “无真机”与“权限不足”是两种文案：前者是设备/目标不存在，后者是存在但当前不允许真实执行。不要把两者合并成“无法调优”。

### 7.3 trial 状态

| 状态 | 含义 | 主文案 | 允许操作 |
| --- | --- | --- | --- |
| `pending` | 已排队未开始 | 等待执行 | 查看 |
| `preparing` | 准备 sandbox/资源 | 正在准备 | 查看/停止作业 |
| `starting` | 启动自有服务 | 正在启动本插件服务 | 查看/停止 |
| `health_check` | 健康与 ownership 校验 | 正在确认服务归属 | 查看/停止 |
| `warming` | warmup | 正在预热（不计入排名） | 查看/停止 |
| `measuring` | 测量 | 正在测量 repeats | 查看/暂停/停止 |
| `evaluating` | 归一化/约束/统计 | 正在计算可行性 | 查看 |
| `cleaning` | 停止/清理 | 正在清理本插件进程 | 查看/等待 |
| `succeeded` | 成功 | 已完成 | 查看证据 |
| `failed`/`timeout`/`oom`/`invalid_metrics`/`interrupted`/`cancelled` | 失败分支 | 对应原因 + “不自动重试” | 查看证据/日志；不提供重试 |

状态颜色与可行性分离：`failed` 不等于 `infeasible`；`infeasible` 表示测到但未满足 SLO，`invalid_metrics` 表示无法判定。

### 7.4 部分字段缺失的展示规则

| 字段 | 缺失时 | 禁止 |
| --- | --- | --- |
| `metrics.*.value` | 显示“缺失”+`missing_reason`；不参与 best/Pareto | 不补 0、不用其他 repeat 顶替 |
| `aggregate=null` | 显示“聚合未完成”；不能显示中位数/噪声 | 不自行平均 |
| `score=null` | 不显示 score；best 仍以 Host refs 为准 | 不用吞吐排序替代 |
| `feasibility=unknown` | “未知（证据不足）”；不进入前沿/推荐 | 不写成失败或通过 |
| `cleanup_state=unknown` | “清理待核对”；不显示资源已释放 | 不写成 `verified` |
| `ended_at=null` | 显示“已运行 X 分”（从 started_at 起） | 不伪造完成耗时 |
| `budget.remaining` 缺失 | 显示“预算未知”，禁用需要预算的动作 | 不推测剩余 |
| `report.is_partial` 缺失 | 默认按部分报告处理并提示 | 不宣称完整 |
| `authorization_summary` 缺失 | 显示“授权摘要不可用”；真实启动按钮禁用 | 不推测已授权 |
| `pareto=[]` | 显示“无满足约束的配置” | 不画假前沿 |

### 7.5 错误码展示

- 统一 `error.<code>` 本地化；Host `message` 是中文兜底。未知 code 显示原文并记录 warning，不显示裸 key。
- 安全门错误 `retryable=false`：不提供“重试启动”；显示“需要用户/配置处理”。
- `REVISION_CONFLICT`：刷新状态、更新按钮；不盲目重试。
- `IDEMPOTENCY_CONFLICT`：提示“同一请求键对应不同请求体”；查原 receipt，不自动换 key。
- `AUTH_BACKEND_UNAVAILABLE`/503：停止轮询，显示“鉴权后端不可用”，不降级。
- 业务 SLO 失败不是错误页：trial 显示 `infeasible` 与证据，正常返回。

## 8 组件与字段契约

### 8.1 UI 消费的信封与类型（对齐 t7）

> 下面只列 UI 消费的字段，不替代 t7 的 JSON Schema；所有字段 snake_case。UI 不修改 Host 返回对象。

```typescript
type TuneResult<T> = {
  schema: 'dsh-ascend-perf/tuning-v1';
  kind: 'tune_plan' | 'tune_control' | 'tune_status' | 'tune_report';
  status: 'ok' | 'accepted' | 'blocked' | 'error';
  readonly: boolean;
  effects: {
    remote_readonly: boolean; host_private_write: boolean; process_mutation: boolean;
    benchmark_traffic: boolean; remote_write: boolean;
  };
  source: { mode: 'demo' | 'local' | 'ssh'; is_demo: boolean; evidence_kind: 'synthetic' | 'captured' | 'unverified_import'; target_id: string | null };
  warnings: Array<{ code: string; message: string; field: string | null }>;
  data: T | null;
  error: null | { code: string; message: string; retryable: boolean; details: object | null };
};

type BudgetEstimate = {
  candidate_count: number; pruned_count: number; trial_batches: number;
  bench_invocations: number; warmup_invocations: number; measured_invocations: number;
  max_requests: number; reserved_tokens: number; timeout_upper_bound_s: number;
  configured_deadline_s: number; cleanup_reserve_s: number;
  fit: 'yes' | 'partial' | 'no'; warnings: string[];
};

type ControlReceipt = {
  control_request_id: string; action: string; accepted_at: string;
  plan_id: string; job_id: string | null; dry_run: boolean; job_state: string;
  revision: number; idempotency_key: string;
  blockers: Array<{ code: string; field: string | null; message: string }>;
  next_actions: string[]; cleanup_state: 'not_needed' | 'pending' | 'verified' | 'unknown';
};
```

`readonly` 与 `effects` 分开读：status/report 通常 `readonly=true`；真实 start/stop/pause/resume 受理后 `readonly=false`，并以 `process_mutation`/`benchmark_traffic` 标副作用；demo 始终无真实副作用。UI 不因 `readonly=true` 就把调优页写成“只读”。

### 8.2 规格表单字段

| 分组 | 字段 | 控件 | 默认/校验 |
| --- | --- | --- | --- |
| 目标 | `executor` | 三选一（demo/local/ssh） | 默认 demo；切到 local/ssh 显示 target 与授权状态；不静默回退 |
| 目标 | `target_id`、`profile_id`、`model_asset_id`、`dataset_asset_id` | 逻辑 ID 选择器 | 只列 Host 注册表；不允许手工路径/URL |
| 标识 | `label` | 文本框 | 可选，仅显示，不参与可比性指纹 |
| 固定 | `fixed.dtype`/`fixed.quantization` | 选择器/只读 | 只允许 profile 支持值；变更会改变指纹并需重新计划 |
| 固定 | `fixed.tensor_parallel`/`fixed.device_ids`/`fixed.served_model_name` | 只读/受限选择 | 由 profile 提供；设备 ID 为逻辑整数；不显示物理路径 |
| 基线 | `baseline.max_num_seqs` | 整数 | 1–1024；profile 可收紧 |
| 基线 | `baseline.max_num_batched_tokens` | 整数 | 128–131072；默认 128 倍数 |
| 基线 | `baseline.gpu_memory_utilization` | 小数 | 0.1–0.95，≤2 位小数 |
| 基线 | `baseline.max_model_len` | 整数 | 256–131072；≥input+output；≤模型上限 |
| 空间 | `space.max_num_seqs[]` | 值 chip 编辑 | 必填非空；≤16 值；升序去重 |
| 空间 | `space.max_num_batched_tokens[]` | 值 chip 编辑 | 必填非空；≤16 值；128 倍数 |
| 空间 | `space.gpu_memory_utilization[]`、`space.max_model_len[]` | 可选值 chip | 默认空=不搜索；给出时校验 |
| 负载 | `workload.input_len`/`output_len` | 整数 | input≥1，output≥2（TPOT 有定义） |
| 负载 | `workload.num_prompts` | 整数 | 1000–10000；小于 1000 不允许自动推荐 |
| 负载 | `workload.max_concurrency` | 整数 | 1–1024；不等于 `max_num_seqs` |
| 负载 | `workload.request_rate_mode`/`request_rate_rps` | 单选 + 数值 | finite 时 (0,10000]；unbounded 时 null；unknown 不可执行 |
| 负载 | `workload.seed`/`stream`/`ignore_eos` | 整数/开关 | seed uint32；stream=true 才可产 TTFT/TPOT |
| SLO | `objective.constraints.ttft_p99_ms_max` | 数值 ms | >0；不得留空 |
| SLO | `objective.constraints.tpot_p99_ms_max` | 数值 ms | >0 |
| SLO | `objective.constraints.success_rate_pct_min` | 数值 % | 0–100 |
| 目标 | `objective.metric`/`direction` | 固定展示 | `output_throughput_tps`/higher；不提供第二目标 |
| 统计 | `min_gain_pct`/`noise_floor_pct`/`tie_epsilon_pct` | 数值 % | 默认 3/2/1；范围按 t7 |
| 测量 | `warmup_runs`/`repeats`/`confirm_repeats`/`confirm_top_k`/`baseline_check_every`/`baseline_drift_pct_max`/`quantile_policy` | 数值/只读 | 默认按 t7；高级折叠 |
| 预算 | `max_trials`/`max_bench_invocations`/`max_total_seconds`/`max_total_tokens`/`startup_timeout_s`/`bench_timeout_s`/`shutdown_grace_s`/`cleanup_reserve_s`/`max_failed_trials`/`max_consecutive_failures`/`patience` | 数值 | 只能收紧；不能超过 Host 硬上限 |
| 搜索 | `search.method`/`seed`/`max_candidates` | 单选/整数 | grid/random；候选上限 64；笛卡尔积 >4096 先缩小 |

表单底部显示“计划生成后才计算候选数与预算”；不显示客户端计算的候选数，避免与 profile 剪枝不一致。

### 8.3 计划与授权字段

| 区块 | 字段 | 展示 |
| --- | --- | --- |
| 计划标识 | `plan_id`、`plan_hash`、`spec_hash`、`compiler_version`、`created_at`、`expires_at` | hash 等宽可复制；过期红色/警告文本 |
| 指纹 | `assets_fingerprint`、`environment_fingerprint`、`execution_fingerprint` | 默认折叠显示短 hash + 复制；用于复现审阅，不显示路径/凭据 |
| 搜索 | `candidates[].candidate_id/params`、`pruned[].params/reason` | 候选列表；剪枝原因逐条显示 |
| 命令 | `commands_preview[].step/template_id/argv_redacted` | 只读、脱敏、可复制；无执行按钮 |
| 影响 | `effect_manifest.*` | 分组显示；端口/sandbox/上限；不显示真实路径/凭据 |
| 预算 | `budget_estimate.*` | 批次/调用/请求/token/超时上界/截止/预留/ fit；fit=no 警告 |
| 阻断 | `blockers[].code/field/message` | 置顶；每条定位字段；不可忽略 |
| 授权 | `target_policy`、`authorization_summary`、`grant_id`（短）、窗口、资源、预算、`allowed_actions` | 只读摘要；不显示 capability；Agent 视图隐藏授权动作 |
| 来源 | `source.mode/is_demo/evidence_kind/target_id` | demo=合成；dry-run local/ssh 不装成实采 |

### 8.4 trial 表字段与列降级

| 字段 | 宽栏（≥720） | 中栏（560–719） | 紧凑（420–559） | 卡片（300–419） |
| --- | --- | --- | --- | --- |
| `trial_id`/`candidate_id`/`phase` | 列 | 列 | 列 | 卡片头 |
| `params` 四参数 | 列 | 摘要 | 摘要 | 展开 |
| `state`/`feasibility` | 列 | 列 | 列 | 卡片 badge |
| `aggregate.throughput.median`/`noise_low/high`/`sample_count` | 列 | 列 | 列 | 卡片行 |
| `metrics.ttft_p99_ms` | 列 | 列 | 展开 | 卡片行 |
| `metrics.tpot_p99_ms` | 列 | 列 | 展开 | 卡片行 |
| `metrics.success_rate_pct` | 列 | 列 | 展开 | 卡片行 |
| `violated_constraints`/SLO | 列 | 列 | 列 | 卡片 badge |
| `score` | 列 | 展开 | 展开 | 卡片行 |
| `started_at`/`ended_at` 派生时长† | 列 | 列 | 列 | 卡片行 |
| `cleanup_state` | 列 | 展开 | 展开 | 卡片行 |
| `attempts`/artifact 证据 | 展开 | 展开 | 展开 | 展开 |

数值格式见 §10.3；`score` 显示 `×1.08`，不是百分比；`gain_pct` 若报告提供则显示 `+8.0%`，不把 score 当 gain。

### 8.5 best 卡、对比条、约束 badge 字段

| 元素 | 字段 | 规则 |
| --- | --- | --- |
| best 类型 | `report.best`/`provisional_best`/`recommended`；`job.best_ref`/`provisional_best_ref`/`baseline_ref` | 三态分开；无可行项不造 best |
| best 参数 | `candidate_id`、`params` 四参数 | 显示全量；可复制文本 |
| 吞吐 | `aggregate.throughput.median/mad/min/max/noise_low/noise_high`、`metrics.output_throughput_tps` | 中位数 + 噪声带；不画置信区间 |
| 延迟 | `metrics.ttft_p99_ms`、`metrics.tpot_p99_ms`；policy | “最坏重复批次 P99”标注 |
| 成功率 | `metrics.success_rate_pct`；`min_repeat` policy | 显示最小口径 |
| SLO | `violated_constraints[]`、`feasibility` | badge：通过/超限/未知；limit/observed/operator 可见 |
| score/gain | `score`（相对比值）、报告 `comparison` 的 `gain_pct`（若有） | UI 不计算；缺值显示“缺失” |
| 对比条 | `report.comparison` 或 `baseline/best` 的原值 + Host delta | 方向标签；无 Host delta 时只显示原值 |
| Pareto | `report.pareto` | 点字段由 Host 提供；UI 不重算支配 |

### 8.6 报告与导出字段

`ReportPage`：`report_id`、`job_id`、`report_revision`、`is_partial`、`summary`、`baseline`、`best`、`provisional_best`、`recommended`、`pareto`、`comparison`、`trial_rows`、`artifact_refs`、`limitations`、`cleanup_evidence`、`next_cursor`；Markdown 追加 `filename/mime/content/sha256`。

UI 规则：

- `summary` 若为结构化对象，按 Host 字段展示；若为文本，按纯文本渲染，不解析成数字。
- `is_partial` 置顶；`limitations` 原文展示；`cleanup_evidence` 不省略。
- 分页用 `next_cursor`，不自行截断；inline >64KiB 时提示“报告较大，已分页”，仍可导出。
- 导出不包含授权 capability、凭据、真实路径、prompt 正文；DEMO/未验证标识必须保留。

### 8.7 与 t7 对齐检查

| t7 契约 | UI 对应 | 状态 |
| --- | --- | --- |
| 同一 tab id/kind，内部“观测/调优” | §2.1 | ✅ |
| `tune-spec-v1` 字段与约束 | §4.2、§8.2 | ✅ |
| plan 字段/candidates/pruned/commands/effect/budget/blockers | §4.4、§8.3 | ✅ |
| `tune-plan-v1` 哈希/过期/24h | §4.3、§4.7 | ✅ |
| dry-run `job_id=null`、无副作用 | §4.5 | ✅ |
| 真实执行四个前置条件 | §4.6、§9.5 | ✅ |
| `effects`/`readonly` 分离 | §5.1、§8.1 | ✅ |
| JobStatusPage/`allowed_actions` | §5.1、§5.5 | ✅ |
| Trial/Aggregate/feasibility/constraints/score | §5.3、§8.4 | ✅ |
| confirmed/provisional/recommended | §5.4、§6.2 | ✅ |
| Pareto 由 Host 计算 | §6.3 | ✅ |
| ReportPage/导出 ≤64KiB | §6.5、§8.6 | ✅ |
| 错误码与 retryable | §7.5 | ✅ |
| 授权桥不可用就不真跑 | §4.6、§9.5 | ✅ |
| `report.summary`/`pareto` 内部形状 | §8.6 消费字段 | ⚠ 待 t7 实现 schema 固定 |
| `allowed_actions` 是否含 cleanup | §9.4 | ⚠ 以 Host 为准；无则不显示清理动作 |
| `BudgetEstimate` 无“预计完成时间”点估计 | §4.4/§4.5 用超时上界 | ⚠ 见 §13 |

## 9 危险确认与授权

### 9.1 通用原则

1. 危险动作只有三个入口：**启动真实调优、停止作业、清理残留进程**；demo 启动不属于危险动作，但需说明“不接触真机”。
2. 危险弹窗使用 `role="alertdialog"`，标题 + 影响 + 确认控件 + 取消/危险按钮；默认焦点在“取消”，Esc 取消，Tab 焦点陷阱；危险按钮不得是默认焦点。
3. 二次确认不是安全门：Host 仍校验 grant/target/plan/资源；UI 不能替代或绕过。确认失败/过期时，错误回到弹窗内显示。
4. 所有危险文案都包含“仅操作本插件启动/记录的进程”，并明确不会停止容器、systemd、其他服务、PID 复用者。
5. 不做“不再提示/永远允许”的勾选；每次真实启动/停止都需要确认（stop 可幂等，但仍显示确认）。
6. 弹窗关闭后焦点回触发按钮；不因超时自动确认。

### 9.2 启动真实调优确认

标题：`启动真实调优作业？`

正文（中文，key 见 §10.2）：

- 目标：`{target_alias}`（`{executor}`）；计划 hash：`{plan_hash_short}`；窗口：`{window_start}–{window_end}`。
- 影响：启动本插件服务、健康检查、发送 `{bench_invocations}` 次 benchmark、写入 `{sandbox_id}`、停止本插件创建的进程；不会停止其他服务/容器/系统服务。
- 预算：`{trial_batches}` 批次 / `{bench_invocations}` 次 bench / 最晚 `{deadline}`；超时上界不是承诺。
- 约束：`TTFT P99 ≤ …`、`TPOT P99 ≤ …`、成功率 `≥ …`；SLO 不通过不会推荐。
- 风险提示：“真实执行会产生负载和进程变更；共享环境/他人服务不会被操作。窗口结束后不继续。”

确认控件：

- 复选框：“我确认维护窗口已由可信用户批准，且只操作本插件创建的进程。”
- 输入框：“输入计划 hash 前 8 位以确认”；粘贴允许；大小写不敏感；错误时不关闭弹窗，聚焦输入框。
- 危险按钮：“启动真实作业”；禁用条件：未勾选、hash 不匹配、plan 过期、blockers 非空、授权无效/过期、target readonly、预览未通过（若要求）、当前会话非可信用户。
- 取消：“取消，返回计划”；关闭后保留计划，不启动。
- 成功后：关闭弹窗，进入作业页；显示“已受理，等待锁/租约”；不要显示“已开始测量”。

### 9.3 停止确认

标题：`停止调优作业？`

正文：

- “将取消当前 bench，并停止本作业通过 supervisor 启动的 service/bench 进程组；随后执行清理。不会按名称杀 vllm，不会停止容器/systemd，不会影响其他服务。”
- “停止请求受理后，仍需等待 `cleanup_state=verified`；在此之前不会显示‘资源已释放’。”
- “已完成的 trial 与证据保留；未完成 trial 标记 interrupted；终态不可继续。”
- 预算/时间不退还；“停止”不等于“回滚设备/配置”（本插件未修改常驻配置）。

确认控件：

- 复选框：“我理解当前未完成 trial 会被中断，停止需要等待清理确认。”
- 按钮：“取消” / “停止作业”（危险）；不需要输入 hash；重复点击幂等，但按钮 busy。
- 若 `cleanup_state=unknown` 或 `recovery_required`：停止按钮可能不可用；改为“查看清理/诊断”，不要显示“强制停止”。

### 9.4 清理残留进程确认

仅在 `cleanup_pending`/`recovery_required` 且 Host `allowed_actions` 明确允许清理/核对时显示；否则只显示“检查清理状态”。

标题：`清理本插件的残留进程？`

正文：

- “仅处理 job `{job_id}` 的 ownership 记录：`{ownership_refs}`；不处理同名系统进程、容器、systemd、PID 复用者。”
- “无法证明归属时不会发信号；结果可能是 `cleanup_pending`/`recovery_required`，需要人工核对。”
- “清理不会删除模型/数据/注册表；只删除本 job 在 sandbox 中创建且 manifest 记录的产物。”

确认控件：

- 输入 job 短 ID（前 8 位）；或由 Host 返回的 cleanup challenge；不使用通用“确认”二字。
- 按钮：“取消” / “核对并清理”（危险）；若 Host 未提供清理动作，按钮不渲染，文案改为“请按诊断指引人工核对”。
- 完成后显示 `cleanup_state` 与证据；`unknown` 不显示成功 toast。

### 9.5 授权面板

| 状态 | 展示 | 动作 |
| --- | --- | --- |
| 共享只读 `readonly` | “当前 target 为共享只读；真实执行不可用。” | 运行演示、查看说明；不显示申请按钮（除非可信用户流程明确支持） |
| `maintenance_only` 且无 grant | “需要维护窗口授权；授权由可信用户完成。” | 可信用户：“申请维护窗口”；Agent 视图：无按钮 |
| grant 有效 | 目标、窗口、资源、允许动作、预算、短 grant_id、过期时间 | 撤销（可信用户）；刷新摘要 |
| grant 过期/不匹配 | “授权已过期/与计划不匹配”；不显示“继续” | 重新申请、重新计划 |
| 授权桥不可用 | “当前环境没有可验证的用户授权桥，真实执行不可用。” | 运行演示、查看诊断；不显示手工 grant 输入 |
| 真实执行关闭 | “`enableRealExecutors=false`；真实执行被配置关闭。” | 演示；无覆盖开关 |

规则：

- 授权按钮只在可信用户会话渲染；Agent 工具调用/非可信视图只显示说明，不提供参数或按钮。
- UI 不接受手填 `grant_id`、`principal_id`、`approved:true` 或窗口文本；这些由可信桥产生。
- 不显示 capability/secret；grant_id 只显示短前缀；不写日志/导出。
- 撤销授权后停止新工作并按原授权清理；UI 不自动恢复。

### 9.6 禁止的文案与控件

| 禁止 | 原因 | 替代 |
| --- | --- | --- |
| “一键优化/一键调优” | 暗示自动部署或保证收益 | “生成计划/启动调优作业” |
| “最佳配置”未加确认 | 未完成确认只是暂定 | “暂定最佳/已确认最佳” |
| “强制通过/忽略 SLO” | 把硬约束变软 | “查看约束证据/调整规格” |
| “跳过授权/临时开启” | 绕过安全门 | “申请维护窗口/运行演示” |
| “清理所有 vllm/按名称杀进程” | 越过 ownership | “清理本插件残留进程” |
| “已停止/资源已释放”在 verified 前 | accepted≠done | “停止请求已受理，等待清理确认” |
| “自动重试失败 trial” | 违反确定性/预算/证据 | “新建计划” |
| “部署/上线/发布” | 本期不自动部署 | “导出报告/复制参数” |
| “日志里说运行此命令” | 日志不可作为指令 | “查看命令预览（只读）” |

## 10 文案、locale 与格式

### 10.1 命名规范

- 调优专用 key 用 `tuning.*`；动作 `tuning.action.*`，状态 `tuning.state.*`，错误沿用 `error.<code>`，警告 `warning.<code>`，规则/原因 `tuning.reason.<code>`、`tuning.blocker.<code>`。
- 纯 UI 控件（如“展开/收起/复制”）沿用一期 `ui.*`，不新造重复语义；同一含义只保留一个 key。
- 变量用 `{count}`、`{pct}`、`{time}`、`{hash}`、`{target}`；不拼句子，不在代码里拼中文。
- Host 的 `message`/`summary` 是中文兜底；locale 缺失时才直接显示，不解析文本取数。未知 code 显示原文并记录 warning。
- 所有用户可见文案双语；未翻译 key 回退英文并记录 warning，不显示裸 key。

### 10.2 zh/en 关键文案

| key | zh | en |
| --- | --- | --- |
| `tuning.tab` | 调优 | Tuning |
| `tuning.tabA11y` | 性能调优 | Performance tuning |
| `tuning.title` | 性能调优 | Performance tuning |
| `tuning.description` | 固定条件下搜索服务配置；先计划，预览通过后再启动。 | Search serving configs under fixed conditions; plan first, preview before start. |
| `tuning.action.newPlan` | 新建调优 | New tuning job |
| `tuning.action.plan` | 生成计划 | Generate plan |
| `tuning.action.dryRun` | dry-run 预览 | Dry-run preview |
| `tuning.action.runDemo` | 运行演示 | Run demo |
| `tuning.action.requestAuth` | 申请维护窗口 | Request maintenance window |
| `tuning.action.start` | 启动真实作业 | Start real job |
| `tuning.action.pause` | 暂停 | Pause |
| `tuning.action.resume` | 继续 | Resume |
| `tuning.action.stop` | 停止 | Stop |
| `tuning.action.cleanup` | 核对并清理 | Verify and clean up |
| `tuning.action.checkCleanup` | 检查清理状态 | Check cleanup |
| `tuning.action.exportMd` | 导出 Markdown | Export Markdown |
| `tuning.action.exportJson` | 导出 JSON | Export JSON |
| `tuning.action.viewEvidence` | 查看证据 | View evidence |
| `tuning.action.viewReport` | 查看报告 | View report |
| `tuning.action.backToSpec` | 返回修改 | Back to spec |
| `tuning.action.refreshStatus` | 读取状态 | Read status |
| `tuning.action.copy` | 复制 | Copy |
| `tuning.action.close` | 关闭 | Close |
| `tuning.action.cancel` | 取消 | Cancel |
| `tuning.step.spec` | 规格 | Spec |
| `tuning.step.plan` | 计划与预览 | Plan & preview |
| `tuning.step.run` | 运行 | Run |
| `tuning.step.result` | 结果 | Result |
| `tuning.spec.executor` | 执行器 | Executor |
| `tuning.spec.target` | 目标 | Target |
| `tuning.spec.profile` | 版本档案 | Profile |
| `tuning.spec.model` | 模型资产 | Model asset |
| `tuning.spec.dataset` | 数据资产 | Dataset asset |
| `tuning.spec.label` | 标签（可选） | Label (optional) |
| `tuning.spec.baseline` | 基线 | Baseline |
| `tuning.spec.space` | 搜索空间 | Search space |
| `tuning.spec.requiredAxes` | 必须搜索轴 | Required axes |
| `tuning.spec.optionalAxes` | 可选搜索轴 | Optional axes |
| `tuning.spec.workload` | 负载 | Workload |
| `tuning.spec.slo` | SLO 硬约束 | SLO constraints |
| `tuning.spec.advanced` | 测量与预算（高级） | Measurement & budget (advanced) |
| `tuning.spec.inputLen` | 输入长度 | Input length |
| `tuning.spec.outputLen` | 输出长度 | Output length |
| `tuning.spec.numPrompts` | 请求数 | Requests |
| `tuning.spec.concurrency` | 最大并发 | Max concurrency |
| `tuning.spec.requestRate` | 请求速率 | Request rate |
| `tuning.spec.unbounded` | 不限制 | Unbounded |
| `tuning.spec.fixedRate` | 固定速率 | Fixed rate |
| `tuning.spec.seed` | 随机种子 | Seed |
| `tuning.spec.ttftLimit` | TTFT P99 上限 | TTFT P99 limit |
| `tuning.spec.tpotLimit` | TPOT P99 上限 | TPOT P99 limit |
| `tuning.spec.successMin` | 成功率下限 | Success rate minimum |
| `tuning.plan.hash` | 计划哈希 | Plan hash |
| `tuning.plan.candidates` | {count} 个候选 | {count} candidates |
| `tuning.plan.pruned` | {count} 个剪枝 | {count} pruned |
| `tuning.plan.batches` | {count} 个配置批次 | {count} config batches |
| `tuning.plan.benchInvocations` | {count} 次 bench | {count} benchmark calls |
| `tuning.plan.timeoutUpper` | 超时上界 ≤ {time}（不是承诺） | Timeout upper bound ≤ {time} (not a promise) |
| `tuning.plan.deadline` | 最晚 {time} | Latest {time} |
| `tuning.plan.effects` | 影响清单 | What will happen |
| `tuning.plan.commands` | 命令预览（已脱敏） | Command preview (redacted) |
| `tuning.plan.blockers` | {count} 个阻断项 | {count} blockers |
| `tuning.plan.previewOk` | 预览通过，未创建作业 | Preview passed; no job created |
| `tuning.plan.previewBlocked` | 预览被阻断，未创建作业 | Preview blocked; no job created |
| `tuning.plan.expires` | 计划有效期至 {time} | Plan expires {time} |
| `tuning.auth.title` | 授权与目标 | Authorization & target |
| `tuning.auth.readonly` | 共享只读 | Shared read-only |
| `tuning.auth.maintenance` | 维护窗口 | Maintenance window |
| `tuning.auth.bridgeUnavailable` | 无可验证的用户授权桥；真实执行不可用 | No verifiable user authorization bridge; real execution unavailable |
| `tuning.auth.required` | 需要维护窗口授权 | Maintenance window authorization required |
| `tuning.auth.expired` | 授权已过期 | Authorization expired |
| `tuning.auth.agentHidden` | 授权按钮仅对可信用户显示 | Authorization controls are shown to trusted users only |
| `tuning.job.state` | 状态 | State |
| `tuning.job.reason` | 原因 | Reason |
| `tuning.job.epoch` | 轮次 | Epoch |
| `tuning.job.budget` | 预算 | Budget |
| `tuning.job.remaining` | 剩余 | Remaining |
| `tuning.job.progress` | 已完成 {done} / 计划 {planned} · 失败 {failed} | {done} of {planned} done · {failed} failed |
| `tuning.job.cleanup` | 清理 | Cleanup |
| `tuning.job.cleanupVerified` | 清理已验证 | Cleanup verified |
| `tuning.job.cleanupPending` | 清理待确认 | Cleanup pending |
| `tuning.job.cleanupUnknown` | 清理无法确认 | Cleanup unknown |
| `tuning.job.effects` | 会产生副作用 | Has side effects |
| `tuning.job.demoNoEffects` | 演示：无真实副作用 | Demo: no real side effects |
| `tuning.trial.phase` | 阶段 | Phase |
| `tuning.trial.phase.baseline` | 基线 | Baseline |
| `tuning.trial.phase.candidate` | 候选 | Candidate |
| `tuning.trial.phase.checkpoint` | 检查点 | Checkpoint |
| `tuning.trial.phase.confirm` | 确认 | Confirmation |
| `tuning.trial.state` | 状态 | State |
| `tuning.trial.state.pending` | 等待 | Pending |
| `tuning.trial.state.preparing` | 准备中 | Preparing |
| `tuning.trial.state.starting` | 启动中 | Starting |
| `tuning.trial.state.healthCheck` | 健康检查 | Health check |
| `tuning.trial.state.warming` | 预热中 | Warming up |
| `tuning.trial.state.measuring` | 测量中 | Measuring |
| `tuning.trial.state.evaluating` | 计算中 | Evaluating |
| `tuning.trial.state.cleaning` | 清理中 | Cleaning |
| `tuning.trial.state.succeeded` | 已成功 | Succeeded |
| `tuning.trial.state.failed` | 失败 | Failed |
| `tuning.trial.state.timeout` | 超时 | Timed out |
| `tuning.trial.state.oom` | 显存不足 | Out of memory |
| `tuning.trial.state.invalidMetrics` | 指标无效 | Invalid metrics |
| `tuning.trial.state.interrupted` | 已中断 | Interrupted |
| `tuning.trial.state.cancelled` | 已取消 | Cancelled |
| `tuning.trial.throughput` | 吞吐 | Throughput |
| `tuning.trial.noise` | 噪声带 ±{value} | Noise band ±{value} |
| `tuning.trial.worstP99` | 最坏重复批次 P99 | Worst-repeat P99 |
| `tuning.trial.success` | 成功率 | Success rate |
| `tuning.trial.slo` | SLO | SLO |
| `tuning.trial.sloPass` | 通过 | Pass |
| `tuning.trial.sloFail` | 超限 | Exceeded |
| `tuning.trial.sloUnknown` | 未知 | Unknown |
| `tuning.trial.score` | score | Score |
| `tuning.trial.duration` | 耗时 | Duration |
| `tuning.trial.cleanup` | 清理 | Cleanup |
| `tuning.trial.evidence` | 证据 | Evidence |
| `tuning.best.title` | 已确认最佳 | Confirmed best |
| `tuning.best.provisional` | 当前最佳（暂定） | Current best (provisional) |
| `tuning.best.none` | 暂无确认最佳 | No confirmed best yet |
| `tuning.best.noFeasible` | 暂无可行配置 | No feasible configuration |
| `tuning.best.recommendedBaseline` | 推荐保持基线 | Recommended: keep baseline |
| `tuning.best.gain` | 相对基线 {pct} | {pct} vs baseline |
| `tuning.best.noClearGain` | 无清晰改善 | No clear gain |
| `tuning.best.compare` | 与基线对比 | Compare with baseline |
| `tuning.pareto.title` | Pareto / 散点 | Pareto / scatter |
| `tuning.pareto.empty` | 没有满足约束的配置，无法绘制 Pareto | No feasible configuration; cannot plot Pareto |
| `tuning.pareto.tableView` | 表格视图 | Table view |
| `tuning.pareto.chartView` | 图表视图 | Chart view |
| `tuning.pareto.confirmed` | 已确认 | Confirmed |
| `tuning.pareto.provisional` | 暂定 | Provisional |
| `tuning.pareto.baseline` | 基线 | Baseline |
| `tuning.failed.title` | 失败 trial | Failed trials |
| `tuning.failed.noRetry` | 失败配置不自动重试；需新计划 | Failed configs are not retried automatically; create a new plan |
| `tuning.log.title` | 本作业日志（已脱敏） | Job logs (redacted) |
| `tuning.log.events` | 事件 | Events |
| `tuning.log.logs` | 日志 | Logs |
| `tuning.log.artifacts` | 证据文件 | Artifacts |
| `tuning.log.truncated` | 日志已截断 | Logs truncated |
| `tuning.log.empty` | 暂无日志 | No logs yet |
| `tuning.state.noTarget.title` | 未发现可用的调优目标 | No usable tuning target |
| `tuning.state.noTarget.desc` | 可先运行演示；真实执行需配置维护窗口目标。 | Run a demo; real execution needs a maintenance-window target. |
| `tuning.state.sshFailed.title` | SSH 目标不可达 | SSH target unreachable |
| `tuning.state.sshFailed.desc` | 不会自动重发 benchmark；已收到的状态保留。 | Benchmarks are not retried automatically; received state is kept. |
| `tuning.state.authRequired.title` | 需要维护窗口授权 | Maintenance window authorization required |
| `tuning.state.authRequired.desc` | 当前目标/环境不允许真实执行；演示仍可运行。 | This target/environment cannot run real jobs; demo is still available. |
| `tuning.state.demo.title` | 演示模式 | Demo mode |
| `tuning.state.demo.desc` | 合成搜索，不接触真机，不代表真实性能。 | Synthetic search; no real device; not real performance. |
| `tuning.state.empty.title` | 还没有调优作业 | No tuning jobs yet |
| `tuning.state.empty.desc` | 先生成计划，预览通过后再启动。 | Generate a plan and preview it before starting. |
| `tuning.state.loading.title` | 正在读取调优状态… | Reading tuning state… |
| `tuning.state.loading.desc` | 打开页面不会自动启动或采集目标。 | Opening the page does not start jobs or probe targets. |
| `tuning.state.planning.title` | 正在生成计划… | Generating plan… |
| `tuning.state.planning.desc` | 计划生成是本地计算，不会创建作业。 | Planning is local computation; no job is created. |
| `tuning.state.blocked.title` | 计划有阻断项 | Plan has blockers |
| `tuning.state.blocked.desc` | 修正后才能启动；不提供忽略。 | Fix blockers before starting; no override. |
| `tuning.state.queued.title` | 已受理，等待资源 | Accepted; waiting for resources |
| `tuning.state.queued.desc` | 尚未开始测量；以状态机为准。 | Measurement has not started; the state machine is authoritative. |
| `tuning.state.running.title` | 运行中 | Running |
| `tuning.state.running.desc` | 正在测量 trial；可暂停或停止。 | Measuring trials; you can pause or stop. |
| `tuning.state.paused.title` | 已暂停 | Paused |
| `tuning.state.paused.desc` | 清理已验证；继续需重新校验授权。 | Cleanup verified; resume re-checks authorization. |
| `tuning.state.cancelled.title` | 作业已取消 | Job cancelled |
| `tuning.state.cancelled.desc` | 终态不可继续；可导出部分报告。 | Terminal; export a partial report. |
| `tuning.state.completed.title` | 作业完成 | Job completed |
| `tuning.state.completed.desc` | 完成不代表有收益；查看结论与证据。 | Completion does not imply a gain; review conclusions and evidence. |
| `tuning.state.partial.title` | 部分 trial 失败 | Some trials failed |
| `tuning.state.partial.desc` | 结论仅基于成功且可行样本。 | Conclusions use only successful feasible samples. |
| `tuning.state.timeout.title` | 超时 | Timed out |
| `tuning.state.timeout.desc` | 不会自动换小负载重试；等待清理确认。 | No automatic retry with smaller load; waiting for cleanup. |
| `tuning.state.cleanupPending.title` | 清理待确认 | Cleanup pending |
| `tuning.state.cleanupPending.desc` | 无法确认本作业进程组已退出；不会发起新 trial。 | Cannot confirm this job's process group exited; no new trials. |
| `tuning.state.recoveryRequired.title` | 恢复需人工 | Manual recovery required |
| `tuning.state.recoveryRequired.desc` | 不会自动续跑或重复 bench；旧报告保留。 | No automatic resume or benchmark retry; the old report is kept. |
| `tuning.state.expired.title` | 计划或授权已过期 | Plan or authorization expired |
| `tuning.state.expired.desc` | 重新生成计划并重新授权；不复用旧 grant。 | Generate a new plan and authorize again; do not reuse the old grant. |
| `tuning.danger.startTitle` | 启动真实调优作业？ | Start a real tuning job? |
| `tuning.danger.startBody` | 将启动本插件服务、发送 benchmark、写入 sandbox 并停止本插件进程；不会影响其他服务/容器。 | Starts this plugin's service, sends benchmarks, writes its sandbox, and stops its processes; does not affect other services/containers. |
| `tuning.danger.ownedOnly` | 仅操作本插件启动的进程。 | Only processes started by this plugin are touched. |
| `tuning.danger.typeHash` | 输入计划 hash 前 8 位以确认 | Type the first 8 characters of the plan hash to confirm |
| `tuning.danger.stopTitle` | 停止调优作业？ | Stop the tuning job? |
| `tuning.danger.stopBody` | 取消当前 bench 并停止本作业进程组；需等待清理确认，终态不可继续。 | Cancels the current benchmark and stops this job's process group; wait for cleanup; terminal. |
| `tuning.danger.cleanupTitle` | 清理本插件的残留进程？ | Clean up this plugin's leftover processes? |
| `tuning.danger.cleanupBody` | 仅处理 ownership 记录；不按名称杀进程，不停止容器/systemd；无法确认则人工处理。 | Only ownership records; no kill-by-name, containers, or systemd; manual if uncertain. |
| `tuning.danger.typeJob` | 输入 job 短 ID 以确认 | Type the short job ID to confirm |
| `tuning.danger.confirmStart` | 启动真实作业 | Start real job |
| `tuning.danger.confirmStop` | 停止作业 | Stop job |
| `tuning.danger.confirmCleanup` | 核对并清理 | Verify and clean up |
| `tuning.footer` | 默认仅规划 · 真实执行需维护窗口 · 只操作本插件进程 · 不自动部署 | Planning by default · Real execution needs a maintenance window · Only plugin-owned processes · No auto-deploy |
| `tuning.a11y.progress` | 调优进度：已完成 {done} / 计划 {planned}，失败 {failed} | Tuning progress: {done} of {planned} done, {failed} failed |
| `tuning.a11y.stateChanged` | 作业状态变为 {state} | Job state changed to {state} |
| `tuning.a11y.chartSummary` | Pareto 图：{count} 个可行配置；已确认 {confirmed}，暂定 {provisional}，基线 {baseline} | Pareto chart: {count} feasible configs; {confirmed} confirmed, {provisional} provisional, {baseline} baseline |
| `tuning.a11y.dangerDialog` | 危险操作确认 | Dangerous action confirmation |
| `tuning.a11y.pollingStopped` | 已停止自动刷新；点击读取状态以更新 | Auto-refresh stopped; select Read status to update |

> 错误码使用一期已有的 `error.<code>` 机制；t7 §8.3 的 `INVALID_SPEC`、`TARGET_READONLY`、`AUTH_*`、`REVISION_CONFLICT`、`CLEANUP_UNVERIFIED` 等不重新造 key。`tuning.reason.*` 对应 `job.reason` 的 `budget_exhausted/no_improvement/search_exhausted/no_feasible_candidate/environment_drift/window_expired/auth_revoked/user_stop`。

### 10.3 数字、单位与百分比

| 类型 | 规则 | 示例 |
| --- | --- | --- |
| 计数 | 本地化千分位 | `1,000`、`16,640,000` |
| 吞吐 | 1 位小数 + `token/s` | `1,284.2 token/s` |
| 噪声带 | `±` + 1 位小数 + 单位 | `±31.5 token/s` |
| 延迟 | 1 位小数 + `ms`；≥10000ms 用 `s` 2 位 | `742.0 ms`、`1.24 s` |
| SLO 上限 | 运算符 + 数值 + 单位 | `≤ 800 ms`、`≥ 99%` |
| 百分比 | 0–100，1 位小数 + `%` | `99.4%` |
| 相对变化 | 带符号 1 位小数 + `%` | `+8.2%`、`-21.3%` |
| 百分点 | 带符号 1 位小数 + `pp` | `0.0 pp` |
| score | `×` + 2 位小数（是比值，不是百分比） | `×1.08` |
| 时长 | `m:ss` 或 `h:mm:ss`；超过预算显示上限 | `12:40`、`≤ 1:00:00` |
| 预算时间 | 本地时区；窗口显示起止 | `2026-11-08 22:00–23:00` |
| token/请求 | 千分位整数；预算显示预留/已用 | `16,640,000` |
| hash | 等宽，默认显示前 12 位 + 复制完整值 | `8f3c1a2e…` |
| 缺失 | “缺失”+原因，不显示 0/— | `缺失：未提供 P99` |

- 内部计算保留原始精度；显示才四舍五入；不在 UI 里用四舍五入后的值重算差值。
- 所有数值字体 `tabular-nums`；正负号保留；颜色不是唯一方向编码（箭头 + 文本）。
- 时长由 `started_at`/`ended_at` 派生时标 `†`；Host 若提供正式 duration，则优先 Host。

### 10.4 只读、演示、待授权与来源标识

| 标识 | 何时显示 | 文案/颜色 | 不可隐藏 |
| --- | --- | --- | --- |
| `只读` | status/report/plan 等无副作用视图 | 锁图标 + “只读”；中性色 | 是 |
| `会产生副作用` | 真实 start/stop 受理后 `process_mutation`/`benchmark_traffic`/`remote_write` 为 true | 警告图标 + 文本；警告色 | 是 |
| `DEMO · 合成` | `is_demo=true` / `evidence_kind=synthetic` | DEMO 反色 chip + “非真机”；顶部整宽条 | 是 |
| `待授权` | 计划 ready 但无有效 grant | 锁/钥匙图标 + “待授权” | 是 |
| `授权已过期` | grant 过期/不匹配 | 警告 badge + 原因 | 是 |
| `仅预览` | dry-run receipt / 计划页 | 中性 chip + “未创建作业” | 是 |
| `共享只读` | target policy=readonly | 中性/警告 chip + 说明 | 是 |
| `维护窗口` | target policy=maintenance_only 且有 grant | 信息 chip + 窗口 | 是 |
| `清理待确认` | cleanup_state=pending/unknown | 警告 badge | 是 |
| `部分报告` | is_partial=true | 警告 badge | 是 |
| `未验证真机` | `real_execution_verified=false` | 中性/警告文本；报告与导出保留 | 是 |
| `未验证导入` | `evidence_kind=unverified_import`（如适用） | 一期同款 badge | 是 |

页脚（调优页）：`默认仅规划 · 真实执行需维护窗口 · 只操作本插件进程 · 不自动部署`。不要沿用观测页的“设备只读 · 不上传”作为调优页唯一说明；调优页有 Host 私有写入与（授权后）进程变更。

### 10.5 语气与禁用词

- 用“计划/预览/受理/等待清理/已验证”区分阶段；不用“成功”概括 `accepted`。
- 不以“智能/自动”描述搜索；说“按固定空间和 seed 搜索”。
- 失败文案给原因和出路；不指责用户；不用感叹号。
- 禁用：“一键优化”“自动最佳”“保证提升”“强制通过”“跳过授权”“清理所有 vllm”“已释放资源”（未 verified）。
- DEMO 必含“非真机/合成”；真实报告必须写 `real_execution_verified` 的真实值。

## 11 视觉与可访问性

### 11.1 视觉一致性

- 复用一期 token：`--dsw-alias-bg-base`、`bg-layer-1..4`、`border-l1..l4`、`label-primary/secondary/tertiary/quaternary/link`、`state-success-*`、`state-warn-*`、`state-error-*`、`state-business-primary`、`focus-ring-*`、`elevation-*`、`--dsw-font-family-code`。不新增硬编码色。
- 调优页与观测页使用同一标题栏、区块头、badge、按钮高度、间距和圆角；新增的是阶段条、计划卡、trial 表、Pareto 图，不另起一套设计系统。
- 区块顺序固定：状态/安全 → 计划/预算 → 证据 → 结论/导出；不把“最佳”放到授权/清理之前。

| 语义 | token | 用途 |
| --- | --- | --- |
| 计划/中性 | `bg-layer-1`、`border-l2`、`label-secondary` | 计划卡、trial 默认行 |
| 运行/信息 | `state-business-primary` | running、暂定 best、Pareto 可行点 |
| 成功/已确认 | `state-success-primary` | confirmed best、SLO 通过、cleanup verified |
| 警告/暂停/待授权 | `state-warn-primary`、`state-warn-label` | paused、blocked、待授权、SLO 超限提示 |
| 危险/失败 | `state-error-primary`、`state-error-secondary` | 危险按钮、failed/oom/timeout、清理未知 |
| 只读/禁用 | `label-quaternary`、`bg-layer-2` | 只读 chip、禁用按钮、缺失 |
| 图表辅助 | `border-l3`、`label-tertiary` | 轴、网格、图例 |

### 11.2 状态颜色映射

| 状态组 | 颜色/形状 | 说明 |
| --- | --- | --- |
| planned/queued | 中性 + 圆点 | 不暗示成功 |
| running | 业务蓝 + 脉冲？ | 不使用无限动画；静态图标 + 文本 “运行中” |
| pausing/paused/blocked | 警告色 + 暂停/锁图标 | 文案说明等待清理/授权 |
| stopping/cancelled | 中性 + 停止图标 | 停止未 verified 时加警告边 |
| completed | 成功色 + 勾选 | 仅状态；不表示有收益（结论另显示） |
| failed/partial/timeout | 危险色 + 感叹号 | 失败计数与原因同时显示 |
| cleanup_pending/recovery_required | 警告/危险 + 扳手/警告 | 不显示“已释放” |
| demo | 业务蓝虚线边框 + DEMO chip | 不用大面积黄色，避免与警告混淆 |

### 11.3 排版、密度与布局

- 标题 `--dsw-font-base-16`/600；区块 13px/600；正文 13px；辅助 12px；数值等宽。
- trial 表行高 36–40；紧凑模式 32；表头 sticky 在滚动容器内；表头不 sticky 到页面外层，避免遮挡作业头。
- 计划页每块最多 3 层嵌套；影响清单用定义列表而非超宽表格；命令预览横向滚动仅限该块。
- 图表高度 180–240；窄栏列表行高 44；Pareto 图例在下方换行，不挤压图。
- 危险弹窗宽 480–560；窄栏全屏；按钮高度 ≥32，危险按钮不贴屏幕边缘。

### 11.4 键盘与焦点

| 区域 | 键 | 行为 |
| --- | --- | --- |
| 内部 tab | ←/→、Home/End | roving tabindex；切换后焦点留在 tab |
| 步骤条 | Tab/Enter | 可回到已完成步骤；未完成步骤不跳过校验 |
| 规格表单 | Tab/Shift+Tab | 正常顺序；错误摘要可跳转；`Esc` 关闭 sheet 前提示未保存 |
| trial 表 | Tab / Enter / Space | 行展开；过滤 chips 方向键；排序表头（若提供）`aria-sort` |
| Pareto | Tab / 方向键 / Enter | 点可聚焦；方向键在点间移动；Enter 选中 trial |
| 日志抽屉 | Esc / Tab | 焦点陷阱；Esc 关闭并归还焦点 |
| 危险弹窗 | Esc / Tab | Esc 取消；焦点陷阱；确认输入可键盘完成 |
| 轮询 | — | 不抢焦点；状态更新不移动焦点 |

- 仅 `:focus-visible` 显示焦点环；用 `--dsw-focus-ring-*`；危险弹窗打开时焦点先到“取消”。
- 关闭 sheet/抽屉后焦点回触发按钮；删除/过滤导致行消失时，焦点移到相邻行或表头并播报。
- 200% 缩放不丢内容；不依赖 hover 才能看关键信息。

### 11.5 屏幕阅读器与语义

- 状态区 `role="status" aria-live="polite"`，只播报状态迁移/受理/清理变化，不播报每 2s 的进度 tick；错误 `role="alert"`。
- 进度条 `role="progressbar"` + `aria-valuemin/max/now/valuetext`；预算三条各有标签，不用颜色区分。
- trial 表 `<caption>` 含 job/phase；列头 `scope="col"`；SLO badge 有文本；score 读作“score 1.08 倍”。
- 图表 `role="img"` + `aria-describedby` 摘要；同时提供表格视图；点形状 + 文本，不只颜色。
- 危险弹窗 `role="alertdialog"`，`aria-labelledby`/`aria-describedby`；确认输入有 label 和错误提示。
- 日志区 `aria-live="off"`；不自动播报新行；“已截断”可读。
- DEMO 横幅 `role="note"`，进入调优页播报一次；不重复打断。

### 11.6 对比度、缩放与减少动效

- 正文/背景 ≥4.5:1；大文本/图标 ≥3:1；badge 浅底深字 + 边框；语义色不单独承载状态。
- 成功/失败/警告都有图标 + 文本；Pareto 用形状区分；trial 状态不只颜色。
- `prefers-reduced-motion`：关闭进度 shimmer、图表过渡、toast 滑入、抽屉动画；仅保留即时更新。
- 动画 ≤150ms；不自动轮播、不自动滚动、不自动弹浮层（危险弹窗仅由用户动作触发）。
- 320px/200% 下不横向滚动；trial 表在 560–719 才允许自身滚动。

## 12 交付组件清单与状态映射

### 12.1 组件清单

| # | 组件 | 职责 | 关键 props/状态 | 验收点 |
| --- | --- | --- | --- | --- |
| 1 | `TuningRoot` | 调优页根：加载/轮询/错误边界/阶段编排 | `jobId`、`plan`、`job`、`report`、`visible` | 不自动启动；无白屏；切 tab 停止轮询 |
| 2 | `TuningTabBar` | 观测/调优内部 tab | `active`、`onChange` | 键盘可达；窄栏不换行 |
| 3 | `TuningHeader` | 标题、来源、状态 chips、读取状态 | `source`、`effects`、`job`、`busy` | 只读/副作用/DEMO 不可隐藏 |
| 4 | `StatusChipGroup` | 状态/授权/清理/部分报告 chip | `chips[]` | 文本+图标；读屏 |
| 5 | `TuningStepper` | ①–④ 阶段导航 | `current`、`enabledSteps` | `aria-current`；不跳过校验 |
| 6 | `Landing` | 无作业首屏、目标/授权摘要、最近作业 | `target`、`jobs` | 无真机/只读/空态 |
| 7 | `RecentJobs` | 最近作业列表 | `jobs[]`、`onOpen` | 不自动 resume |
| 8 | `SpecWizard` | 四步 sheet 容器 | `draft`、`step`、`errors` | 全屏窄栏；焦点陷阱 |
| 9 | `StepNav` | 步骤条与校验 | `step`、`errors` | 可回退；错误摘要 |
| 10 | `AssetFields` | 逻辑 target/model/profile/dataset | `ids`、`options` | 无路径/URL 输入 |
| 11 | `BaselineFields` | 四参数基线 | `baseline`、`profile` | 范围/关联校验 |
| 12 | `SpaceEditor` | 离散轴编辑 | `space`、`limits` | 去重/排序；不计算候选 |
| 13 | `WorkloadFields` | 负载与 seed | `workload` | rate mode 联动 |
| 14 | `SloFields` | TTFT/TPOT/成功率硬约束 | `constraints` | 不允许留空 |
| 15 | `BudgetFields` | 测量/预算高级项 | `measurement`、`budget` | 只能收紧；默认折叠 |
| 16 | `ValidationSummary` | 表单/计划错误汇总 | `errors[]` | 定位字段；`role=alert` |
| 17 | `PlanReview` | 计划摘要/候选/剪枝/预算/阻断 | `plan`、`budget` | blockers 置顶；过期禁用 |
| 18 | `PlanHashLine` | plan/spec hash、复制、有效期 | `plan` | 等宽；不泄露路径 |
| 19 | `CandidateList` | 候选四参数与剪枝原因 | `candidates`、`pruned` | 不提供手动加候选 |
| 20 | `CommandPreview` | 脱敏命令预览 | `commands_preview` | 只读；无执行按钮 |
| 21 | `EffectManifestTable` | 影响清单 | `effect_manifest` | 端口/sandbox 安全显示；“仅本插件进程” |
| 22 | `BudgetEstimateCard` | 批次/调用/请求/token/超时上界/截止/fit | `budget_estimate` | 上界不是承诺；fit=no 警告 |
| 23 | `BlockerList` | blockers + 字段跳转 | `blockers[]` | 不可忽略 |
| 24 | `DryRunPreview` | 预览 receipt、ready/blocked、`job_id=null` | `receipt`、`plan` | 不显示运行中 |
| 25 | `AuthorizationPanel` | target policy/grant 摘要/申请/撤销 | `policy`、`grant`、`trusted` | Agent 无按钮；桥不可用禁用 |
| 26 | `GrantSummary` | 窗口/资源/预算/短 grant_id | `grant` | 不显示 capability |
| 27 | `StartConfirmDialog` | 真实启动危险确认 | `plan`、`grant`、`onConfirm` | 复选框+hash 输入；失败不关闭 |
| 28 | `JobHeader` | 作业状态/原因/epoch/预算/清理/动作 | `job`、`allowed_actions` | accepted≠running；清理状态 |
| 29 | `BudgetBars` | 时间/请求/token 预算 | `budget` | 三条独立；aria |
| 30 | `JobProgress` | 批次/失败/当前 trial | `progress`、`active_trial` | 失败独立计数 |
| 31 | `BestPanel` | confirmed/provisional/recommended/无可行 | `best`、`report` | 不客户端挑 best；不部署 |
| 32 | `ComparisonBars` | best vs baseline 四行 | `comparison`、`baseline`、`best` | SLO limit/噪声带；不计算 verdict |
| 33 | `TrialTable` | 宽/中栏 trial 表 | `trials`、`filter` | 列降级；caption |
| 34 | `TrialRow` | 行展开、证据入口 | `trial`、`expanded` | 状态/可行性分开 |
| 35 | `TrialCards` | 窄栏卡片 | `trials` | 全部关键字段可见 |
| 36 | `TrialStateBadge` | trial 状态 | `state` | 文本+图标 |
| 37 | `ConstraintBadge` | SLO 通过/超限/未知 | `constraint` | limit/observed/operator |
| 38 | `BestMarker` | confirmed/provisional/baseline | `kind` | 形状+文本 |
| 39 | `TrialControls` | pause/resume/stop/check cleanup | `allowed_actions` | 只渲染允许动作；busy |
| 40 | `CleanupBanner` | cleanup_pending/recovery_required | `cleanup_state` | 不显示资源已释放 |
| 41 | `EventTimeline` | events 分页 | `events`、`next_cursor` | seq 稳定；不重复 |
| 42 | `LogDrawer` | 事件/日志/证据抽屉 | `job`、`artifacts` | 纯文本；脱敏；焦点陷阱 |
| 43 | `ReportView` | 结论/部分报告/限制/清理证据 | `report` | is_partial 置顶 |
| 44 | `BestVsBaseline` | 结果对比条 | `report` | 四行固定顺序 |
| 45 | `ParetoChart` | 散点/Pareto | `pareto`、`axes` | 形状+文本；表格替代 |
| 46 | `ParetoTable` | 窄栏/表格视图 | `pareto` | 完整可读；不重算 |
| 47 | `FailedTrials` | 失败筛选与证据 | `trials` | 不自动重试 |
| 48 | `ExportMenu` | Markdown/JSON/复制参数 | `report` | 分页/≤64KiB；DEMO 标识 |
| 49 | `DangerDialog` | 三类危险确认 | `kind`、`challenge` | alertdialog；二次确认 |
| 50 | `EmptyState`/`ErrorState` | 空/错状态 | `titleKey`、`descKey`、`action` | 每态一个主操作 |
| 51 | `Toast` | 轻提示 | `messageKey`、`tone` | accepted 文案不夸大 |
| 52 | `Footer` | 调优页安全说明 | `version` | 固定文案 |

建议 `data-testid`：`tuning.root`、`tuning.tab`、`tuning.plan.hash`、`tuning.plan.blocker.{code}`、`tuning.preview.receipt`、`tuning.auth.panel`、`tuning.job.header`、`tuning.job.state`、`tuning.trial.{trial_id}`、`tuning.best`、`tuning.compare.row.{metric}`、`tuning.pareto.point.{trial_id}`、`tuning.log.drawer`、`tuning.danger.{kind}`、`tuning.export`。

### 12.2 状态 → 组件映射

| 状态 | 标题/来源 | 主区 | 动作 | 隐藏/禁用 |
| --- | --- | --- | --- | --- |
| 无真机/无目标 | SourceBar + 空态 | Landing + 目标卡 | 新建 demo、运行演示 | 真实启动 |
| SSH 失败 | 警告 SourceBar | ErrorState + 当前 job（若有） | 读取状态、诊断、停止/演示 | 自动重试启动 |
| 权限不足/待授权 | StatusChip“待授权” | PlanReview + AuthorizationPanel | 申请授权、演示 | 启动真实作业 |
| DEMO | DemoBanner 常驻 | 全页 + synthetic 标识 | 运行/暂停/停止演示、导出 | 转真机、隐藏标识 |
| 空数据 | SourceBar | Landing 空态 | 新建、运行演示 | 假 trial/报告 |
| 加载 | Header busy | Skeleton/保留旧值 | 等待/重试 | 空表“无数据” |
| 计划阻断 | StatusChip“有阻断” | PlanReview + BlockerList | 返回修改、重新计划 | 启动、忽略 |
| 已排队 | JobHeader queued | Progress/Best 占位 | 读取状态、停止 | 说“测量中” |
| 运行中 | JobHeader running | Progress + Best + TrialTable + LogDrawer | 暂停、停止、证据 | 资源已释放 |
| 暂停中/已暂停 | JobHeader paused | CleanupBanner + Best + TrialTable | 继续、停止、报告 | 清理未验证时继续 |
| 停止中/已取消 | JobHeader stopping/cancelled | CleanupBanner + Report | 查看清理、导出、新建 | 继续、重复 stop 发信号 |
| 完成 | JobHeader completed | Report + BestVsBaseline + Pareto + Failed | 报告、导出、新建 | 自动部署 |
| 部分失败 | JobHeader completed + 横幅 | Report + FailedTrials | 证据、导出、新建 | 重试失败 trial |
| 超时 | JobHeader timeout/原因 | CleanupBanner + 部分报告 | 日志、停止、导出 | 自动换小负载 |
| 清理待确认 | JobHeader cleanup_pending | CleanupBanner + LogDrawer | 检查清理、诊断 | 新 trial、资源已释放 |
| 恢复需人工 | JobHeader recovery_required | CleanupBanner + 旧报告 | 核对、导出、新建 | 自动 resume |
| 计划/授权过期 | StatusChip expired | PlanReview + AuthPanel | 重新计划、授权 | 复用旧 grant/预览 |
| 仓储配额/损坏 | 全局 ErrorState | 诊断 | 清理已完成作业（若允许）、新建独立计划 | 自动清空/新副作用 |

### 12.3 实现顺序（给二期开发）

| 里程碑 | 内容 | 依赖 |
| --- | --- | --- |
| M0 | 内部 tab、TuningRoot、状态机/轮询、SourceBar/StatusChip、Footer、locale 接入 | t7 §8/§9；t3 视觉 |
| M1 | SpecWizard 四步、字段校验、plan 生成/计划页、blockers/预算 | t7 §3 |
| M2 | DryRunPreview、EffectManifest、AuthorizationPanel、真实启动危险确认、demo 启动 | t7 §4/§5/§6 |
| M3 | JobHeader、进度、TrialTable、BestPanel、pause/resume/stop、事件/日志 | t7 §6/§8 |
| M4 | Report、BestVsBaseline、Pareto、失败 trial、导出 | t7 §4.3/§8.3/§9 |
| M5 | cleanup_pending/recovery、超时/部分失败、错误码、状态恢复 | t7 §5/§6 |
| M6 | 窄栏、键盘/读屏、200%、减少动效、真机 GUI 取证 | M0–M5；t7 §10 |

### 12.4 验收自查（对照 t8 与 t7）

| 标准 | 设计对应 | 自查 |
| --- | --- | --- |
| t8-1 三流程 | §3–§6 | 设计覆盖；需 demo 实机/无 NPU 走查 |
| t8-2 全状态 | §7.2、§7.3 | 每态有文案/操作/禁止项 |
| t8-3 组件字段 | §8、§12.1 | 对齐 t7；⚠ 标记项待实现 schema |
| t8-4 危险确认 | §9 | 三入口、二次确认、ownedOnly |
| t8-5 标识/视觉/窄栏/a11y | §2.3、§10、§11 | 设计覆盖；需 300px 与读屏走查 |
| t8-6 locale/格式/组件映射 | §10、§12 | key/格式/映射齐全 |
| t7 默认真实零副作用 | §4.5、§4.6、§9 | dry-run 无 job；未授权不启动 |
| t7 可复现搜索 | §4.2、§4.4 | seed/plan hash/预览展示；UI 不重算 |
| t7 SLO/预算/授权/窗口 | §4.4、§4.6、§5.5 | 硬约束/预算/授权摘要可见 |
| t7 暂停/崩溃不重复 bench | §5.5、§5.7 | 不自动重试；resume 重测语义 |
| t7 停止显示实际收尾 | §5.5、§6.6 | cleanup verified 前不写已释放 |
| t7 无 NPU 完整演示 | §3.1、§4.6 | demo 全流程；DEMO 常驻 |
| t7 独立审查 | 本文 | 设计文档待实现与审查；无真实执行声明 |

> 运行时 GUI 可视化仍需人工按 t7 §9/§10 取证；t4 已知 Client Inspect 超时，不能把模块加载测试当页面验收。本文不宣称调优页已挂载。

### 12.5 与一期面板的边界

- 一期 t3 §12.5 的“二期不实现、不留入口”是当时边界；本文是二期设计，不代表 t4 一期面板现在应有入口。实现调优时再在同一 tab 增加内部页，不改变一期观测页的 API/工具/只读语义。
- 调优页不使用一期的 `demoForced`、`readonly:true` 构造器、自动淘汰仓储或“latest snapshot”；使用 TuneStore/独立信封。
- 本设计不要求一期导入/对比/洞察改动；调优结果可通过 `/publish` 发布到一期（本期不暴露，见 §13），发布后仍保留 synthetic/captured 标识。

## 13 开放问题（交给二期实现/审查）

1. **`/publish` 是否在本期暴露**：t7 定义了发布到观测的接口，但 t8 只要求导出；本文结果页不提供发布按钮。若实现要暴露，需二次确认、保留来源标识、不部署，并明确“发布不是上线”。
2. **`report.summary`/`report.pareto` 的内部形状**：t7 只列字段名，未固定嵌套 schema；UI 只消费 Host 字段，不在 Client 重算。实现前需固定 JSON Schema/表格字段。
3. **预计耗时**：`BudgetEstimate` 只有 `timeout_upper_bound_s`/`configured_deadline_s`，没有点估计；本文按“超时上界”展示，不编造“预计 20 分钟”。若产品需要点估计，需 t7 增字段或 Host warning 提供。
4. **`allowed_actions` 是否包含 cleanup/verify_cleanup**：t7 状态机有 recovery 核对，但工具签名未列 cleanup 动作；§9.4 设计为“有则显示、无则只读核对”。需实现确认。
5. **授权桥的 UI 接口**：可信用户识别、grant mint/revoke 的调用方式由 Harness 适配器提供；本文只定义面板状态，不定义安全机制。
6. **无 target 时的“目标就绪”展示**：t7 禁止为预检查连接远端；UI 不能实时探测 SSH。landing 只展示已知摘要/上次错误，是否需要“最近一次连接时间”字段待定。
7. **2s 轮询与隐藏策略**：t7 要求 visible 2s；本文按此实现，并在隐藏/终态停止。若长作业在后台，重连全量同步；是否需要可配置轮询间隔待实现。
8. **trial 时长的来源**：`Trial` 无 duration 字段，本文由 `started_at/ended_at` 派生显示并标 `†`；若 Host 增加正式字段，UI 改为直接显示。
9. **en 文案归属**：Host 的 `message/summary` 是中文兜底；`tuning.*` 的英文由插件 locale 维护。规则/原因 code 的英文模板归属需与 Host 规则库对齐，否则 en 界面会出现中文。
10. **真机视觉验收**：t4 已知 Client Inspect 超时；调优页上线前必须补原 GUI 的“计划→demo→暂停/恢复→报告/停止”取证，不能用注册/加载测试替代。

## 附录 A 设计决策记录

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 调优入口 | 同一 tab 的内部页，不新增 sidebar tab | t7 契约；避免两个入口分散；观测/调优共享来源与视觉 |
| 计划与执行 | plan 后必须 dry-run，真实启动再确认 | 让用户在副作用前看到候选/预算/影响；dry-run 无 job |
| 真实启动确认 | 复选框 + plan hash 输入 | 防止误点；hash 绑定具体计划，计划变更即失效 |
| 停止确认 | checkbox，不输入 hash | 停止是安全收尾，但仍需理解“中断 trial/等待清理” |
| 清理确认 | 输入 job 短 ID，仅 Host 允许时显示 | 防止按名称/范围扩大；无法证明归属则人工 |
| best 来源 | 只用 Host refs/report | 防止客户端从失败表挑最高吞吐；保持证据一致 |
| Pareto | Host 算，UI 只画 | 前沿/支配关系复杂且需同 epoch/指纹；Client 重算会漂移 |
| 计划候选数 | 生成计划后由 Host 算，表单不预览 | profile 剪枝/约束在 Host；避免表单承诺错误候选数 |
| 预算展示 | 批次/bench/请求/token/超时上界 | 与 t7 BudgetEstimate 对齐；不承诺实际完成时间 |
| 窄栏 | trial 卡片、Pareto 列表 | 300–419px 可读性优先；不整页横向滚动 |
| 日志 | 抽屉 + 纯文本 + 分页 | 避免日志注入/超长；证据与事件分离 |
| 发布/部署 | 本期不做发布按钮，绝不做部署 | t8 只要求导出；t7 明确不自动部署 |
| DEMO | 同一状态机、常驻标识、无真实副作用 | 可完整演示，又不误导真实收益 |
| 授权 | 只对可信用户显示，Agent 无按钮 | t7 要求；UI 不能伪造用户批准 |
| 轮询 | visible/非终态 2s，隐藏停止 | t7 契约；减少后台请求；重连全量同步 |
| 错误 | fail-closed，不自动重试控制动作 | 防止重复 bench/扩大副作用；按 idempotency/status 查账 |
