# 昇腾性能工作台 · 右侧栏面板 UI/UX 设计

| 项 | 内容 |
| --- | --- |
| 文档版本 | **v1.3**（2026-11-07）：v1.2 全文 + §15 增补「服务部署分段」（t22，依据 deploy-design §10：服务列表 + 部署向导 + 日志尾部 + 审计可视化）。部署分段相关设计与 v1.1/v1.2 冲突处以 §15 为准。v1.2（2026-11-07）：§14 增补「多环境占用视图」（t16，回应 m01516 反馈：配置出页面、占用为中心），多环境相关设计与 v1.1 冲突处以 §14 为准。v1.1 基线（2026-11-07，按 t2 正式文档 `docs/tech-design.md` 对齐） |
| 作者 | 设计师（AgentTeams `设计师`） |
| 适用任务 | t3：UI/UX——状态、导入对比与洞察三流程 |
| 关联产物 | t1 `docs/market-analysis.md`；t2 `docs/tech-design.md`（已落盘，字段以其 §3/§4.3/§5/§7/§8 为准）；t4 实现；t6 真实只读采集 |
| 交付范围 | 右侧栏“昇腾性能”面板的信息架构、三条主流程、全状态、组件与字段、zh/en 文案、视觉与可访问性、交付组件清单；不含业务代码，不含自动调优 UI |
| 平台前提 | 右侧栏 tab definition id=`dsh-ascend-perf`、kind=`ascend-perf`，keyed slot `sidebar.right.pane.tab`；`--dsw-alias-*` token；Client locale；Host 缓存优先、只读采集 |
| 字段状态 | 已按 t2 `dsh-ascend-perf/v1` 对齐：snake_case、`Result` 信封、10 项 `MetricKey`、`Verdict`/`Conclusion` 分离、`card.processes` 与 `chip.processes` 分放不重复计数、`runtime/storage` 固定 null、`source.evidence_kind`。本文 §8 为 UI 消费子集；不补算任何影响判定/结论的指标，展示派生值一律标 `†` |

> 线框仅表达层级、顺序与状态，不追求字符级像素对齐。文中所有示例数值来自真实采集样本或标注为 DEMO 的演示数据；不把示例值当作指标承诺。

| t3 要求 | 对应章节 |
| --- | --- |
| 入口/布局、窄栏响应式、三区 | §2、§3.1–3.2 |
| 三流程：打开看板 / 导入对比 / 洞察与导出 | §4、§5、§6 |
| 全状态与每态文案、操作 | §7（§7.2 总表） |
| 组件与字段（NPU 卡、runs、对比、洞察） | §8、§12.1 |
| 文案 locale、数字单位格式、只读标识 | §9 |
| 视觉与可访问性 | §10、§11 |
| 交付组件清单与状态映射、二期边界 | §12 |
| t16 增补（v1.2）：多环境占用视图重设计 | §14 |
| t22 增补（v1.3）：服务部署分段（服务列表/部署向导/日志尾部/审计） | §15 |

---

## 0 设计目标、原则与非目标

### 0.1 目标

1. **5 分钟看懂一台昇腾机器**：打开面板即可回答“有没有设备、是否健康、谁在占用（工具提供时）、软件环境是什么”。
2. **两次运行可解释地对比**：导入 baseline / candidate，看到改善与回归，能复算每个数字，能说清为什么不可比。
3. **建议有证据**：每条洞察都能回溯到指标、运行标签、规则 id 与阈值；不出现无证据的“优化建议”。
4. **全状态可演示**：加载、无设备、无 `npu-smi`、SSH 失败、解析失败、空数据、字段缺失、DEMO、过期，均有明确文案与出路。
5. **只读可信**：面板不启停服务、不改设备配置、不上传数据；所有“写”只发生在本地导入记录与用户主动导出。

### 0.2 设计原则

| 原则 | 含义 | 对本面板的约束 |
| --- | --- | --- |
| 证据优先 | 先给数值与来源，再给结论 | 洞察卡必须展开“证据”，对比行必须可看基线与候选原值 |
| 缺失不补零 | `null` 就是缺失 | 缺值显示“缺失”并给原因；派生值加 † 标注；禁止用 0 代替 |
| 错误就近 | 哪块失败只降级哪块 | SSH 失败不清空已加载的设备卡；导入失败不影响已有 runs |
| 只读不伪装 | 不出现会让人以为能改设备的控件 | 无“应用/启动/停止/删除”；按钮只有刷新、导入、对比、复制、导出 |
| 结论带方向 | 每个指标声明越高越好或越低越好 | 指标名旁有方向图标与说明；颜色只表达好坏，箭头只表达数值方向 |
| 演示常驻标识 | DEMO 不可被误认为真机 | 顶部横幅 + 数据源 chip + 导出水印，三重标识，不能手动隐藏 |
| 窄栏优先 | 右侧栏默认仅约 45% 视口宽 | 单列三区；表格在窄栏降级为卡片；不出现横向滚动 |
| 可键盘完成 | 三流程不依赖鼠标 | Tab 顺序、Enter/Space、Esc、方向键、复制按钮可达 |

### 0.3 非目标（首版不做）

- 自动调优、参数搜索、一键根因、AI 生成优化方案（无 UI 入口，见 §12.5）。
- 启动/停止推理服务、改 device 配置、清理显存、杀进程。
- 上传 benchmark 或遥测到远端；账号、云端历史、团队共享。
- 自造逐请求 P95/P99：上游未提供逐请求数据时，显示“不支持”，不估算。
- 面板内编辑阈值：首版阈值随插件配置，面板只展示与解释。

### 0.4 成功标准（可验收）

| 编号 | 标准 | 验收方式 |
| --- | --- | --- |
| U1 | 右侧栏 tab 可发现，标题不截断，guide 卡能说明用途 | 安装后打开右侧栏，tab 条出现“昇腾性能” |
| U2 | 无 NPU 时 5 分钟内完成 DEMO 三流程 | 打开 → 看设备/热点 → 选基线候选 → 看改善与回归 → 复制建议 |
| U3 | 任一数字可复算 | 对比表中 基线、候选、Δ绝对、Δ%、阈值 五项齐全，单位一致 |
| U4 | 全部状态均有文案与操作 | 按 §7.2 的 12 类状态逐项走查，无空白屏、无假 0 |
| U5 | 真实样本可展示 | 用 fixture 的 8 卡数据渲染，第二芯片功耗显示“缺失”而非 0 |
| U6 | 洞察可追溯 | 每条洞察含 severity、规则 id、证据、建议、生成时间 |
| U7 | 键盘与读屏可用 | 仅键盘完成导入→对比→复制；读屏能读出判定句 |
| U8 | 文档与实现一致 | t4 按 §8/§9 字段与文案实现，审查逐条对照 |

---

## 1 名词与角色

| 名词 | 定义 | UI 中的表现 |
| --- | --- | --- |
| 采集信封 | Host 工具返回的统一结果包装：来源、状态、警告、只读标记 | 顶部数据源条与“采集详情” |
| 快照 snapshot | 某一时刻的设备与环境状态 | 设备与环境区 |
| 运行 run | 一次 benchmark 的指标集合与来源 | runs 列表一行 |
| 基线 baseline | 对比的参照运行 | 选择器左侧，标“基线” |
| 候选 candidate | 对比的新运行 | 选择器右侧，标“候选” |
| 指标 metric | 可比较的数值，带单位与方向 | 对比表一行 |
| 方向 direction | `higher`（越高越好）/ `lower` / `neutral` | 指标名后的 ↑/↓ 与说明 |
| 阈值 threshold | 判定“改善/回归”的最小相对变化，默认 5% | 指标名 tooltip、判定 badge |
| 判定 verdict | 单指标：回归/改善/持平/缺失/零基线/描述性 | badge 文本 + 颜色 + 图标 |
| 结论 conclusion | 整体：回归/改善/持平/不确定/不可比 | 对比摘要顶部的结论条 |
| 可比性 comparability | `matched` / `mismatch` / `unknown`；mismatch 导致 `not_comparable` | 琥珀色横幅 + 受影响指标按描述性显示 |
| 热点 hotspot | 算子级耗时排行（上游 `op_summary` 提供时） | 洞察区下方排行表 |
| 洞察 insight | 规则 + 证据 + 建议 + 置信的组合 | 洞察卡 |
| 证据 evidence | 支撑洞察的具体数值与来源 | 洞察卡展开区 |
| DEMO | 内置演示数据，非真机 | 横幅、chip、导出水印 |
| 只读 readonly | 对设备与远端无写操作；导入仍写 Host 私有仓储 | 标题 chip + 页脚说明 |

角色：**工程师**在右侧栏看状态与对比；**Agent** 通过 Host 工具读取同一份结果并向人解释。设计与文案必须保证两者看到的是同一组数字与同一套判定（人机同源）。

---

## 2 入口与信息架构

### 2.1 入口

| 入口 | 位置 | 行为 |
| --- | --- | --- |
| 右侧栏 tab | 右侧栏 tab 条，标题“昇腾性能” | 打开或聚焦面板；同一 pane 内不重复开多个实例 |
| guide 卡 | 右侧栏空态/引导区 | 标题“查看昇腾性能”，描述“查看 NPU 状态、导入基准并对比两次运行”；点击等同打开 tab |
| Agent 消息内引用 | Agent 回复中的链接/指令 | 打开同一 tab 并定位到指定区块（设备 / 对比 / 洞察）；不新开浏览器页面 |

无独立 URL、无 iframe。tab 标题固定 4 个汉字，窄栏下不省略；tab 图标使用 DSH 既有图标集，若无合适图标则只用文字，不引入自定义图标资源。

### 2.2 面板骨架：三区一单列

面板是**单列、三段、可折叠**的结构，顺序即因果顺序：

```
标题栏（只读标识 + 刷新 + 更多）
数据源条（来源 / 主机 / 新鲜度 / 过期徽标）
├─ ① 设备与环境（状态卡区）
│    设备概要 → NPU 卡网格 → 软件环境 → 采集详情（默认折叠）
├─ ② 运行与对比
│    步骤指示 → 导入/选择 → 可比性提示 → 对比摘要 → 对比表/卡片 → 导出
└─ ③ 洞察
     洞察卡列表 → 热点排行
页脚（只读说明 / 规则库版本）
```

**为什么不做子 tab**：右侧栏已有 tab 层级；三区是“设备 → 运行 → 洞察”的因果链，子 tab 会切断上下文，也让窄栏多一层导航。折叠代替切换，折叠状态按 pane 记忆。

### 2.3 宽度与响应式断点

| 宽度 | 场景 | 布局 |
| --- | --- | --- |
| `< 300px` | DSH 不显示右侧栏 | 不适用；展开时由平台转全屏，按 `≥ 720px` 处理 |
| `300–419px` | 窄栏/分屏一半 | 单列；NPU 卡 1 列；对比表降级为指标卡；按钮可换行，主按钮整行 |
| `420–559px` | 默认右栏（常见） | 单列；NPU 卡 2 列（每列 ≥ 200px 时）；对比表用紧凑 4 列（指标/候选/Δ%/判定） |
| `560–719px` | 右栏拉宽 | 单列；NPU 卡 3 列；对比表 6 列（指标/基线/候选/Δ/Δ%/判定） |
| `≥ 720px` | 全屏/浮动 | 单列，内容最大宽 880px 居中；对比表 8 列（增加不利变化/阈值）；不改成左右双栏，保持阅读顺序 |

规则：任何宽度下都不出现整页横向滚动；仅“对比表”在 560px 以下允许自身横向滚动（带 `role="region"` 与 `tabindex="0"`），但 300–419px 必须用卡片布局替代滚动。

### 2.4 状态记忆与刷新

- 折叠状态、上次选中的基线/候选、导入对话框上次目录：按 pane + 工作区记忆，关闭重开恢复。
- 面板不可见（`tab.visible === false`）时暂停计时器与轮询；重新可见时若超过新鲜度阈值，标“已过期”，不自动重采集。
- 首版默认**手动刷新**，不自动轮询；如 t2 提供 `autoRefreshSeconds` 配置，面板只在页脚显示“自动刷新 60s”，不新增开关。

---

## 3 线框

### 3.1 标准宽度（420–559px，真实设备 + 已有对比）

```
┌──────────────────────────────────────────────────┐
│ 昇腾性能   [只读]                       [刷新] [⋯] │
├──────────────────────────────────────────────────┤
│ ● 本机 · 12 秒前 · captured                      │
├──────────────────────────────────────────────────┤
│ ▾ 设备与环境                          正常† · 8 卡 │
│   Ascend910 × 8 卡 · 16 芯片 · 内存单位 MiB      │
│   ┌───────────────────┐ ┌───────────────────┐    │
│   │ 卡 0  Ascend910   │ │ 卡 1  Ascend910   │    │
│   │ 正常† · 2 芯片    │ │ 正常† · 2 芯片    │    │
│   │ HBM 6.1/128 GiB†  │ │ HBM 6.1/128 GiB†  │    │
│   │ ▓░░░░░░░░░ 4%     │ │ ▓░░░░░░░░░ 4%     │    │
│   │ 进程 0† · 芯片明细 ▾│ │ 进程 0† · 芯片明细 ▾│    │
│   └───────────────────┘ └───────────────────┘    │
│   … 卡 2–7 同构（2 列 × 4 行）                     │
│   CANN 8.1.RC2 · npu-smi 26.1.1                  │
│   [采集详情 ▾]                                     │
├──────────────────────────────────────────────────┤
│ ▾ 运行与对比                          3 条运行    │
│   ① 基线 ✓   ② 候选 ✓   ③ 对比                   │
│   基线 [vllm-0.30-bs8          ▾] [更换]          │
│   候选 [vllm-0.30-kv-tune      ▾] [更换]          │
│   [开始对比]                                       │
│   ┌ 对比结果 · 2 分钟前 · 阈值 5% ────────────┐    │
│   │ 结论：回归 · 2 改善 · 3 回归 · 1 缺失 · 4 持平 │
│   │ [全部] [回归 3] [改善 2] [缺失 1]          │    │
│   │ 指标       基线     候选      Δ      判定  │    │
│   │ 输出吞吐   812.4    742.1   -8.7%   回归  │    │
│   │ TTFT p99   78.2     84.0    +7.4%   回归  │    │
│   │ TPOT p99   21.3     20.9    -1.9%   持平  │    │
│   │ 成功率     99.4     98.1    -1.3%   持平  │    │
│   └───────────────────────────────────────────┘    │
├──────────────────────────────────────────────────┤
│ ▾ 洞察                                 2 条       │
│   ⚠ TTFT p99 回归 7.4%                 [展开]     │
│     规则 TTFT_REGRESSION · 阈值 5%                │
│   ℹ 算子热点集中                        [展开]     │
│     规则 HOTSPOT_CONCENTRATION                    │
├──────────────────────────────────────────────────┤
│ 设备只读 · 不上传 · 导出仅对比摘要 · 规则 v1       │
└──────────────────────────────────────────────────┘
```

> 按 t2，实时快照固定 `runtime=null`、`storage=null`，不渲染运行态/容器/磁盘模块；软件区只显示 `software.npu_smi` 与 `software.cann`。卡头不显示功耗/温度，展开芯片行才显示。

### 3.2 窄栏（300–419px，对比表降级）

```
┌────────────────────────────────┐
│ 昇腾性能 [只读]        [刷新]  │
├────────────────────────────────┤
│ ● 本机 · 18 分钟前 · stale     │
├────────────────────────────────┤
│ ▾ 设备与环境        正常† · 8 卡│
│ ┌────────────────────────────┐ │
│ │ 卡 0  Ascend910    正常†   │ │
│ │ 2 芯片 · HBM 6.1/128 GiB† │ │
│ │ ▓░░░░░░░░░ 4%              │ │
│ │ 进程 0† · 芯片明细 ▾       │ │
│ └────────────────────────────┘ │
│ … 卡 1–7 单列                   │
├────────────────────────────────┤
│ ▾ 运行与对比        3 条运行   │
│ ① 基线 ✓ ② 候选 ✓ ③ 对比      │
│ [vllm-0.30-bs8        ▾]       │
│ [vllm-0.30-kv-tune    ▾]       │
│ [        开始对比        ]      │
│ ┌────────────────────────────┐ │
│ │ 输出吞吐          回归 -8.7%│ │
│ │ 812.4 → 742.1 token/s      │ │
│ │ 阈值 ±5% · 越高越好         │ │
│ └────────────────────────────┘ │
│ ┌────────────────────────────┐ │
│ │ TTFT p99         回归 +7.4%│ │
│ │ 78.2 → 84.0 ms             │ │
│ └────────────────────────────┘ │
├────────────────────────────────┤
│ ▾ 洞察                2 条     │
│ ⚠ TTFT p99 回归 7.4%   [展开] │
└────────────────────────────────┘
```

### 3.3 导入对话框（面板内 sheet，占满宽高）

```
┌ 导入运行数据 ───────────────────────── ✕ ┐
│ 导入为   (•) 候选   ( ) 基线              │
│                                          │
│ ┌──────────────────────────────────────┐ │
│ │   拖入文件，或 [选择本机文件]         │ │
│ │   JSON / CSV · ≤ 1 MiB               │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ 支持：benchmark JSON、metrics CSV、       │
│       msprof op_summary CSV（仅热点）     │
│                                          │
│ ─ 校验 ─────────────────────────────────  │
│ ✓ 结构有效      ✓ 10 项指标              │
│ ✓ 来源已记录    ! 2 个字段缺失            │
│ ✓ SHA-256 已计算                          │
│ [查看诊断 ▾]                              │
│                                          │
│ 坏行默认全部拒绝；勾选“跳过坏行”才部分导入。│
│ 文件仅在本机解析，不上传；导入写 Host 私有仓储。│
│                    [取消] [导入并设为候选]│
└──────────────────────────────────────────┘
```

### 3.4 SSH 失败（保留上次数据，局部降级）

```
┌──────────────────────────────────────────┐
│ 昇腾性能 [只读]                  [刷新]  │
├──────────────────────────────────────────┤
│ ⚠ SSH 采集失败 · 认证失败（SSH_AUTH_FAILED）│
│ 主机 gpu-01（仅别名，已隐藏地址与凭据）   │
│ 未读取任何设备数据。                      │
│ [重试]  [查看诊断]  [改用演示数据]         │
├──────────────────────────────────────────┤
│ 仍显示上次成功采集（3 分钟前，stale=true）│
│ ┌ 卡 0 … ┐ ┌ 卡 1 … ┐                    │
│ …                                        │
└──────────────────────────────────────────┘
```

### 3.5 DEMO 与过期

```
┌──────────────────────────────────────────┐
│ ▓ DEMO 演示数据 · 非真机 · 仅验证界面与计算│
│ [退出演示]                                │
├──────────────────────────────────────────┤
│ 昇腾性能 [只读]                          │
│ ● 演示 · demo@1 · 2026-11-06 22:00       │
│   来源：synthetic · is_demo=true         │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│ ● 本机 · 18 分钟前 · stale      [刷新]   │
│ 上次采集于 2026-11-07 00:34:12；重新采集  │
│ 以获得当前状态。                          │
└──────────────────────────────────────────┘
```

### 3.6 洞察卡展开

```
┌──────────────────────────────────────────┐
│ ⚠ TTFT p99 回归 7.4%              警告   │
│ 规则 TTFT_REGRESSION · 置信 observed      │
│ 基于对比 run-…-b 与 run-…-c · 00:58       │
│                                          │
│ 证据                                     │
│   TTFT p99  78.2 → 84.0 ms      +7.4%   │
│   TPOT p99  21.3 → 20.9 ms      -1.9%   │
│                                          │
│ 建议                                     │
│   固定 concurrency 与输入长度后复测；     │
│   检查 prefill 排队与调度等待。           │
│                                          │
│ [复制建议] [查看对比行] [规则说明]        │
└──────────────────────────────────────────┘
```

---

## 4 流程 A：打开看板

### 4.1 进入与加载（缓存优先）

1. 点击 tab 或 guide 卡后，面板先读 Host 的**已有状态/缓存**并立即渲染；**打开面板、激活 tab、读取列表都不会自动采集**，也不会因此执行 `npu-smi`。
2. 有缓存：直接显示设备与 runs，数据源条给出 `collected_at` 与来源；缓存超过 10 秒只显示“上次采集于 …”与刷新按钮，是否 `stale` 以 `collection.stale` 为准，UI 不自行改判。
3. 无缓存：设备区显示空态“尚未采集”，主操作 `刷新`；这是正常初始态，不显示无限骨架。若状态读取本身超过 200ms，只在三区顶部显示轻量骨架，不伪造设备数值。
4. 用户点 `刷新` 才发起采集：保留旧数据，按钮转 loading，数据源条显示“正在刷新…”；Host 超时 15000ms。成功则整体替换；失败但已有旧快照时保留旧数据 + 错误条 + `stale=true`；失败且无缓存时进入错误态。
5. `status=degraded`：照常渲染 `data`，顶部一条警告（`warnings[]` + `availability`）；`status=error`：`data=null`，只渲染错误卡，不显示半截数据；`status=empty`：按 `availability` 渲染空态。

### 4.2 来源判定与呈现

设备区只展示**当前目标源**（local/ssh/demo），运行区展示导入的 runs；两者不混写。目标由配置决定（`ssh.enabled`/`ssh.hostAlias`/`demoMode`），UI 不自动从本机回退到 SSH，也不在失败后静默切换。

| 场景 | 数据源条 | 说明 |
| --- | --- | --- |
| 本机缓存 | `● 本机 · 12 秒前 · captured` | 主机名只显示 `source.host` 别名 |
| 本机刷新中 | `正在刷新本机状态…` | 保留旧值 |
| SSH 缓存 | `● SSH · gpu-01 · 3 分钟前 · captured` | 不显示 IP/用户/端口 |
| SSH 未启用 | 不出现 SSH 选项；诊断里说明 `ssh.enabled=false` | 不显示灰色假入口 |
| DEMO | `● 演示 · synthetic` | 与 DEMO 横幅同时出现 |
| 导入 runs | `● 导入 · run-20261107.json · unverified_import` | 仅作用于运行区；不改变设备区来源 |

约束：同一时刻只展示一个设备来源；导入的 runs 不会把设备区改成“导入”。`source.host` 为 null 时显示“本机/未知主机”，不猜测。

### 4.3 正常态（真实 NPU）

设备区自上而下：

1. **设备概要**：`host.alias · host.arch · card_count 卡 · chip_count 芯片 · memory_unit`；右侧总健康徽标取所有芯片最差状态（标 `†`），文案“正常/警告/危险/未知”，不显示健康分。v1 快照不含 CPU 核数/内存总量，不得展示这两项。
2. **卡网格**：每卡一张卡（字段见 §8.2）。卡头行只有 `卡 n · 型号 · 健康† · n 芯片`；卡体折叠摘要可显示 `HBM 合计† · 进程数†`。**卡头不显示功耗/温度**，这两个值只存在于芯片行，避免把单芯片值伪装成整卡值。
3. **芯片明细**：点卡头展开，每芯片一行：健康（含 `health_raw` tooltip）、温度、功耗、HBM（used/total + 计算百分比†，tooltip 给 `hbm_reported_usage_rate_pct`）、AICore、NPU 利用率（两者分列，不合并）、已归属进程。第二芯片 `power_w=null` 时显示“缺失（该芯片未上报）”，不用 chip0 顶替。
4. **软件环境**：只显示 `software.npu_smi` 与 `software.cann`；缺失显示“版本未知”。不显示 torch/vLLM（v1 快照不含），也不出现“运行态/容器/磁盘”模块。
5. **采集详情（默认折叠）**：来源模式、主机别名、`command_ids`、耗时、`partial`/`stale`、`source_ref`/`sha256`（可复制）、schema 版本、`source.collected_at` 原始 ISO、与 Agent 同源说明、复制诊断。
6. **进程**：已归属芯片的只出现在 chip 行；无法归属的只出现在卡底部“未归属芯片 n 条”；两处不重复计数。状态由 `processes_state` 决定（见 §4.9）。

### 4.4 无 `npu-smi` 降级（`command_missing`）

- 设备区**不渲染空卡**，显示说明卡：标题 `未找到 npu-smi`；说明“本机未安装昇腾工具，或 PATH 对 DSH Host 不可见”；操作 `重新检测`、`查看排查步骤`（`which npu-smi`、`/dev/davinci*` 是否存在、容器是否映射设备、当前用户权限；只展示可复制命令，不执行）、`加载演示数据`。
- 运行与对比区照常可用；若一条 run 都没有，显示运行区空态。
- 不显示“0 卡”“0 W”“0%”等伪数据；诊断保留原始 stderr 与命令。

### 4.5 无设备（`no_device`）

- 标题 `未发现 NPU 设备`；说明按可能原因列三条（驱动未加载、容器未映射、权限不足），不猜测具体一条。
- 操作：`重新检测`、`查看诊断`、`加载演示数据`；运行区照常可用。
- `npu-smi` 返回非零但未识别为 `no_device` 时，归 `unknown` + `COMMAND_FAILED`；正文一句人话，原始错误进诊断。

### 4.6 SSH 失败子态（`unreachable` 及子码）

统一结构：错误标题（`SSH 采集失败 · <子态>`）+ 主机别名（不显示密钥路径、不显示凭据）+ 一句原因 + 主次操作。**保留上次成功数据并标 `stale`**，不清空。

| 子码 | 文案（zh） | 主操作 | 次操作 |
| --- | --- | --- | --- |
| `SSH_UNAVAILABLE` | `无法连接主机 gpu-01，请检查网络或主机状态。` | 重试 | 查看诊断 / 改用演示 |
| `SSH_TIMEOUT` | `连接主机 gpu-01 超时（15 秒）。` | 重试 | 查看诊断 / 改用本机 |
| `SSH_AUTH_FAILED` | `SSH 认证失败，凭据可能已失效。` | 重试 | 查看诊断（不显示密钥内容） |
| `SSH_HOST_KEY_FAILED` | `主机密钥与记录不一致，已停止连接。` | 查看诊断 | 联系管理员 |
| `SSH_CLIENT_NOT_FOUND` | `本机未找到 SSH 客户端，无法连接 gpu-01。` | 查看诊断 | 改用本机 / 演示 |
| `COMMAND_NOT_FOUND`（远端） | `已连接 gpu-01，但未找到 npu-smi。` | 重试 | 查看诊断 |
| `FORBIDDEN`/权限 | `已连接 gpu-01，但当前用户无权读取设备。` | 查看诊断 | 联系管理员 |

`ssh.enabled=false` 时不产生 SSH 连接，也不展示“连接失败”；诊断中说明配置关闭。

### 4.7 DEMO 模式

- **进入**：无设备/无工具/无缓存时的空态提供“加载演示数据”；`demoMode` 配置时可直接进入。
- **表现**：面板最顶部 DEMO 横幅（虚线边框 + `DEMO` chip + “非真机”），数据源条 `● 演示 · synthetic`，导出保留 `is_demo=true`、`evidence_kind=synthetic`，对比结论上方固定“演示数据，仅用于验证界面与计算，不代表真机性能”。
- **数据内容**：虚拟 catalog（不写 Host 真实仓储），8 卡（16 芯片）+ 2 条运行（基线/候选，含改善、回归、缺失）+ 1 条 workload 不一致 + 1 条空闲信息 + 候选热点；刻意保留第二芯片功耗缺失，用于演示“缺失”而非“0”。
- **退出**：`退出演示` 回到进入前状态；退出后不保留演示 runs；DEMO 标识不可关闭，无“隐藏横幅”。
- DEMO 只用于界面与计算验证，不生成“真机性能”措辞。

### 4.8 刷新、缓存与过期

- 刷新为手动；缓存 10 秒内重复刷新可复用（由 Host 决定），UI 不重复发请求。刷新失败保留旧数据 + 错误条，不退回骨架。
- 过期：以 `collection.stale` 为准；`stale=true` 时数据源条琥珀色 + `state.stale.title` + 刷新 CTA。相对时间只作提示，不自行把 15 分钟改写成 stale。
- 导入的 runs 是历史数据，**不按时间过期**；只显示 `历史 · timestamp`。DEMO 不过期。
- `collected_at=null` 显示“时间未知”，仍允许刷新；不伪造当前时间。

### 4.9 设备区交互

- 卡头是 `<button aria-expanded>`：Enter/Space 展开芯片明细；展开状态按卡记忆。
- 卡内不放会误触的操作按钮；进程行可展开，最多 5 条 + “还有 n 条”，每条 `pid · 名称 · memory_mb`；有 `container_pid` 时标“容器 PID”。
- 数值等宽（`font-variant-numeric: tabular-nums`），避免刷新跳动。
- 进程空态必须看 `processes_state`：
  - `none_reported`：工具明确“No running processes found”→显示“工具未报告进程”，不能证明没有服务；
  - `unknown`：显示“进程信息不可用”，不显示“无占用进程”；
  - `observed` 且空：HBM 为 0 才显示“无占用进程”（真 0）；HBM > 0 显示“未看到占用进程”+“可能来自其他容器/命名空间”，不判泄漏、不生成 critical。
- 不展示 `runtime.vllm_processes.zombie` 等运行态数据（v1 `runtime=null`）。

---

## 5 流程 B：导入 baseline / candidate 并查看差异

### 5.1 流程总览

```
① 导入/选择基线 → ② 导入/选择候选 → ③ 开始对比 → 结论与可比性 → 逐指标表 → 导出/复制
```

步骤条只在运行区顶部占一行，三项状态：未完成（空心）、完成（✓ + 运行标签）、当前（描边）。窄栏缩成 `① 基线 ✓ ② 候选 ✓ ③ 对比`，不换行。**导入后不自动对比**，必须显式点 `开始对比`。

### 5.2 入口与初始状态

| 已有 runs | 运行区表现 | 主操作 |
| --- | --- | --- |
| 0 | 空态：`还没有运行记录` + “导入 baseline 与 candidate 的 benchmark 结果后即可对比。” | `导入基线` |
| 1 | 该 run 卡片；候选槽为空 | `导入候选` 或把现有 run 设为基线 |
| ≥2 | 两个选择器 + 步骤条；默认取最近两条，较旧者为基线（仅默认值，可改） | `开始对比` |
| 已有对比 | 摘要上方“对比于 2 分钟前”，提供 `重新对比` | 重新对比 |

导入入口为 `导入基线`、`导入候选` 两个按钮；角色只是对话框预选和导入后的槽位建议，**不是 Run 的持久字段**，可在选择器中改。runs 行溢出菜单：设为基线/候选、查看来源、移除。

### 5.3 导入对话框

- 形态：面板内全高 sheet（不是居中大模态），`role="dialog" aria-modal="true"`，标题“导入运行数据”，Esc 关闭，焦点先落“选择文件”。
- **只支持浏览器文件选择/拖拽**：UI 不提供 Host 路径输入、URL、目录、压缩包；Host 只接收 UTF-8 内容。Agent 侧先用文件工具读取，再提交同一内容。
- 角色：单选“候选（默认）/基线”；`msprof op_summary CSV` 时角色禁用，改为“导入热点到当前运行”。
- 支持格式（自动识别，不靠扩展名）：
  - `vllm-json`：vLLM benchmark JSON；
  - `benchmark-csv`：benchmark 指标 CSV；
  - `msprof-op-summary-csv`：msprof `op_summary` 算子热点，**仅热点**，不产生可对比 run。
- 限制：单文件 ≤ **1 MiB**；JSON ≤200 个对象；CSV ≤10000 行、≤128 列、单字段 ≤64 KiB；UTF-8。坏行默认 **全部拒绝**（不写入）；只有用户显式点“跳过坏行导入”才部分导入。
- 校验步骤：浏览器读文件（大小/类型预检）→ 提交 Host 解析（进度条 indeterminate）→ 返回 `data`/`warnings`/错误码。`prefers-reduced-motion` 下不做逐项动画。
- 通过后预览：运行标签、`timestamp`、环境（CANN/framework/backend/TP）、workload、10 项指标的缺失数、热点数、`warnings` 列表、`evidence_kind=unverified_import` 徽标。
- 底部：`取消` / `导入`（或 `跳过坏行导入`）；失败时主按钮禁用并给原因 + 出路。
- 隐私句固定：“文件在本机由插件解析，不上传云端；导入会写入 Host 私有仓储。”

### 5.4 导入结果与失败分类

**成功**：关闭 sheet，槽位显示 `label · timestamp · 未验证导入`；toast “已导入 <label>”；另一槽已存在则提示“可以开始对比了”，不自动执行。

**幂等**：同一 `sha256` 重复导入不报错，返回旧 `run_id` + `deduplicated=true`；toast “该文件已导入，已复用原记录”，不新增 run。

**部分成功**（仅显式 skip）：
- 顶部黄条 `已导入 {accepted} 行，跳过 {rejected} 行`；展开列出行号、字段、原因；
- `provenance.rejected_rows`/`warnings` 保留；受影响指标显示“缺失”，不参与判定；
- 主按钮文案“跳过坏行导入”，首次点击前必须勾选“我知道部分数据会被跳过”。

**失败**（不写入）：错误卡显示 code、人话、行号/字段、脱敏片段（≤2 行、≤160 字符）、建议、“重新选择 / 查看诊断 / 复制诊断”。失败不清空已有 runs。

| 错误码 | 文案 | 出路 |
| --- | --- | --- |
| `INPUT_TOO_LARGE` | 文件超过 1 MiB | 裁剪或导出聚合结果 |
| `UNSUPPORTED_FORMAT` | 不支持的格式或版本 | 查看支持的三种格式 |
| `SCHEMA_UNSUPPORTED` | 契约 schema 版本不受支持 | 升级插件或导出兼容版本 |
| `PARSE_ERROR` | 第 12 行解析失败：缺少逗号 | 用示例校验后重试 |
| `NO_VALID_ROWS` | 没有可用的性能指标 | 确认导出包含指标；热点文件请走“导入热点” |
| `METADATA_CONFLICT` | 文件内元数据与请求参数冲突 | 检查 label/timestamp 覆盖参数 |
| `INVALID_ARGUMENT` | 请求参数不合法 | 重新选择文件 |
| `STORE_BUSY` / `STORE_IO` / `STORE_LIMIT` | 仓储忙/写入失败/达到上限 | 稍后重试 / 清理旧 run / 查看诊断 |

错误码与文案集中管理；新增码必须有 zh/en 文案与一个可执行出路，否则不上线。

### 5.5 选择基线/候选

- 两个原生 `<select>`（键盘、读屏可用），选项 `label · timestamp`；禁用当前另一侧已选项，避免同 run 自比。
- 未选满时 `开始对比` 禁用，按钮下给一行原因“请选择基线与候选”。
- 更换任一侧会**立即使旧对比失效**：隐藏结论与表格，显示“选择已变更，请重新对比”；禁止把旧结果挂在新选择下。
- 窄栏改为上下排列，中间 `↓`。

### 5.6 可比性闸门

点击 `开始对比` 后由 Host 输出 `comparability` 与 `comparability_issues`，UI 只呈现：

1. `matched`：结论区一条细线“环境与 workload 一致”，不占大块空间。
2. `mismatch`：琥珀横幅“关键条件不一致，只展示描述性差值，不能据此判定改善/回归”；逐条列 `field：基线值 → 候选值`；结论固定 `not_comparable`。
3. `unknown`：灰蓝横幅“关键条件未知，结论为不确定”；结论固定 `inconclusive`。
4. 不提供“忽略全部条件/强制通过”开关，也不做二次确认强行计算；`mismatch`/`unknown` 仍显示原值、`delta_abs`、`delta_pct`（Host 给出时），但隐藏“改善/回归”大字与胜负色。
5. 环境差异（CANN/framework/backend/TP）逐条列出，不静默忽略；是否影响结论由 Host 的 `comparability` 决定，UI 不改判。

### 5.7 对比阅读顺序

1. **结论条**：`summary.conclusion` + `summary.message`（Host 中文兜底；en 用 `compare.<conclusion>` 模板）。右侧可给“最差回归：`output_throughput_tps -8.7%`”（由 `adverse_delta_pct` 选最大，标 `†`）；`inconclusive`/`not_comparable` 不显示胜负措辞。
2. **可比性横幅**（如有）+ `comparability_issues`。
3. **计数**：按 10 项指标的 `verdict` 计数（`†`，仅展示；不改变 Host 结论）：`1 回归 · 2 改善 · 6 持平 · 1 缺失`。
4. **筛选**：chips `全部 / 回归 / 改善 / 持平 / 描述性 / 缺失 / 零基线`，带计数；筛选不改变结论区。
5. **对比表/卡片**：字段见 §8.4；4 项主要指标固定在前。
6. **行展开**：基线与候选原值、单位、方向、阈值、`adverse_delta_pct`、来源 run、规则说明；“复制这一行”输出 Markdown。
7. **导出/复制**：见 §6.4。

### 5.8 判定与阈值规则

| 层 | 值 | 含义 | 颜色/图标 |
| --- | --- | --- | --- |
| 单指标 `verdict` | `improved` | 好方向且 `adverse ≤ -threshold` | 成功色 ↑/↓ |
|  | `regressed` | 坏方向且 `adverse ≥ threshold` | 危险色 反箭头 |
|  | `stable` | `adverse` 落在 ±阈值内 | 次要文本 `=` |
|  | `descriptive` | 可比性为 `mismatch`/`unknown`，只描述差值 | 中性 `≠` |
|  | `missing` | 任一侧为 null | 弱文本 `?` |
|  | `zero_baseline` | 基线为 0，百分比不可算 | 弱文本 `—` |
| 整体 `conclusion` | `regressed`/`improved`/`stable`/`inconclusive`/`not_comparable` | Host 按主要指标与可比性汇总 | 结论条专用，不与单指标 badge 混用 |

- 阈值默认 **5%**（config `regressionThreshold`，0.1–50；compare 可单次覆盖）；行内 `threshold` 以 Host 返回为准，面板内不可编辑。
- 百分比 `(候选−基线)/|基线|×100`，1 位小数；基线 0 → `delta_pct=null`，显示“基线为 0，不计算百分比”，绝不 `∞` 或 `0%`。
- 绝对差同单位带符号；相对变化 `%`，率值变化 `pp`。
- 缺值不参与判定；摘要分母固定 10 项，文案分别列 `missing`/`zero_baseline`。
- 10 项指标均为性能指标；设备利用率（AICore/NPU/HBM）**不进入对比表**，只出现在快照与洞察证据中。

### 5.9 对比异常

| 情况 | 表现 |
| --- | --- |
| 一侧指标缺失 | 该行 `missing` + `missing_reason`；不补 0，不参与结论 |
| 一侧基线为 0 | 该行 `zero_baseline`；绝对差照常，百分比“不计算” |
| 指标为 NaN/Inf | Host 已转 null/missing；UI 不显示 NaN |
| 10 项指标不齐 | 缺的 key 显示“缺失”；不动态增减列 |
| 对比计算失败 | 保留选择与 runs；错误条“对比计算失败”+ 复制诊断 + 重试；不清空 runs |
| 运行被移除 | 旧对比失效，回到“请选择基线与候选” |

---

## 6 流程 C：查看洞察、导出与复制

### 6.1 洞察生成边界（UI 视角）

- 洞察由 Host 规则引擎生成，UI 不推断、不补证据、不拼接无来源建议。规则固定 8 条（`HBM_PRESSURE`、`TTFT_REGRESSION`、`TPOT_REGRESSION`、`CONCURRENCY_SATURATION`、`SUCCESS_LOW`、`TEMP_HIGH`、`POWER_CHANGE`、`HOTSPOT_CONCENTRATION`），版本由 `rule_version` 给出。
- 触发：对比完成后刷新对比级洞察；快照读取后可生成设备级洞察（如 HBM 压力、高温）；没有对比时只显示设备级洞察，不显示“性能回归”。
- 排序由 Host 返回：`critical → warning → notice → info`，同 severity 按 `rule_id`；UI 不重排。
- 最多 20 条；`omitted_count>0` 或 `skipped_rules` 非空时，底部折叠区解释“为什么没有更多洞察”。
- `confidence=observed` 直接由字段计算；`heuristic` 是推断，必须显示“推断”badge，不能与实测混排成同一可信度。
- 无对比、无命中、输入不足时显示空态，不生成伪造洞察。

### 6.2 洞察卡

| 区域 | 内容 | 规则 |
| --- | --- | --- |
| 头部 | severity 图标 + `title` + severity 文本 | `title` 为中文兜底结论句；en 用 `rule.<rule_id>.title` 模板；不做字符串解析取数 |
| 元信息 | `规则 <rule_id> · <confidence> · <created_at>` | `rule_id` 可展开规则说明；`heuristic` 显示“推断”；时间本地时区 |
| 证据 | 1–4 行 `field：value unit` + `ref` | `ref` 可点击跳到对比行或快照字段；`collected_at` 进 tooltip；可比性证据单独标注 |
| 建议 | `suggestion`（单条） | 动词开头；不写“可以尝试”；不承诺收益；复制时带规则 id 与运行标签 |
| 操作 | 复制建议 / 查看证据 / 规则说明 | 键盘可达；复制内容不含凭据 |

严重度语义（以规则定义为准，UI 不自行升降级）：

- `critical`：成功率 <99% 等明确严重问题；
- `warning`：阈值以上回归、HBM 压力、高温等；
- `notice`：并发饱和、功率变化等需注意但不构成回归；
- `info`：热点集中等背景信息。

### 6.3 热点排行

- 来源：`Run.hotspots[]`（来自 benchmark 附带或 `msprof op_summary` CSV）；列：`op_name`、`share_pct`、`calls`、`total_duration_us`、`source_rows`。
- Host 返回最多 50 条；UI 默认显示前 10，按 `share_pct` 降序，提供“查看全部 50”。占比 `%` 1 位小数，条形用中性色，不用好坏色。
- `share_pct` 是算子耗时占**总任务耗时**的比例（Host 计算），不是墙钟时间；UI 标注口径，不换算。
- 空态：`该运行未提供算子级数据，无法排行。` + “导入 msprof op_summary CSV”；不根据算子名猜耗时。
- 热点可被洞察引用，但热点本身不生成“回归”结论。

### 6.4 导出与复制

| 操作 | 产物 | 说明 |
| --- | --- | --- |
| 复制对比摘要 | Markdown 到剪贴板 | 含运行标签、时间、来源与 `evidence_kind`、可比性、10 项指标、verdict、阈值、警告 |
| 导出对比摘要 | 浏览器下载 `.md` 文件 | Host `compare(action=export)` 返回 `{filename,mime,content,sha256}`；UI 用 Blob 下载，toast 只显示文件名，**不显示 Host 路径** |
| 复制建议 | Markdown | 单条洞察：severity、`rule_id`、证据、`suggestion`、`created_at` |
| 复制全部洞察 | Markdown | 按 Host 顺序拼接；无洞察时禁用 |
| 复制诊断 | 文本 | 采集/导入错误、`command_ids`、脱敏字段、`warnings`、schema 版本；不含密钥、IP、用户、端口 |

导出内容 ≤64 KiB；超限返回 `EXPORT_TOO_LARGE`，提示“先筛选或减少指标”。导出保留 `is_demo`/`evidence_kind` 标识，不提供“去掉 DEMO 水印”。不提供设备快照原始导出（避免把未确认的原始状态当报告传播）；需要时由 Agent 读取工具结果。导出**没有上传选项**，页脚固定说明。

### 6.5 复制反馈

- 成功：toast `已复制` 2 秒后消失；`aria-live="polite"` 播报。
- 失败（无剪贴板权限）：打开可全选的只读文本块，标题“复制失败，请手动选择”，按钮“全选”。
- 复制内容不含完整主机名以外的敏感信息；不含密钥路径、NFS 服务器地址。

### 6.6 无洞察 / 无热点

- 无对比：`完成一次对比后，将根据指标变化生成带证据的建议。` + “去选择运行”（滚动到运行区）。
- 有对比但规则无命中：`本次对比未触发规则（阈值 ±5%）。` + “查看对比表” + “查看已跳过规则”。
- 数据全缺失：`指标不足，无法生成洞察。` + 列出缺失字段 + “查看诊断”。
- 无热点：见 §6.3；导入入口不隐藏。

---

## 7 全状态矩阵

### 7.1 状态机

```
open ──▶ read_cache ──┬─ 有缓存 ──▶ cached(ready) ──用户刷新──▶ refreshing ──┬─ ok/degraded
                      │                                                     ├─ error(旧缓存保留→stale)
                      │                                                     └─ error(无缓存→source_error)
                      └─ 无缓存 ──▶ not_collected ──刷新──▶ refreshing

cached ──demoMode/加载演示──▶ demo（退出回 cached 或 not_collected）
cached ──collection.stale──▶ stale（仍可读）
import（局部）: pick_file → parsing → import_ok | import_dedup | import_partial | import_error
```

**打开面板不触发采集**；`refreshing` 只由用户点刷新（或 Agent 调 status）进入。`error` 分两类：设备源错误（保留旧数据）与仓储错误（`data=null`，全局）。

### 7.2 状态总表

| 状态 | 触发 | 界面表现 | 主操作 | 次操作 | 文案（zh / key） | 禁止 |
| --- | --- | --- | --- | --- | --- | --- |
| 未采集 | 无缓存，首次打开 | 设备区空态卡；运行区仍可用 | `刷新` | 加载演示 / 查看诊断 | `尚未采集设备状态` / `state.empty.title`；`点击刷新读取本机 NPU；不会自动执行。` | 自动连设备、假装 0 卡 |
| 读取/刷新中 | 读缓存 >200ms 或用户刷新 | 轻量骨架；刷新按钮 loading；保留旧值 | 等待 | 查看诊断（>8s） | `正在读取本机缓存…` / `state.loading.title`；刷新时 `正在刷新…` | 无限骨架、空白屏 |
| 无 `npu-smi` | `availability=command_missing` | 说明卡 + 排查清单；运行区可用 | 重新检测 | 排查步骤 / 演示 | `未找到 npu-smi` / `state.commandMissing.title` | 显示 0 卡、0 W |
| 无设备 | `availability=no_device` | 说明卡列三条可能原因 | 重新检测 | 诊断 / 演示 | `未发现 NPU 设备` / `state.noDevice.title` | 猜一个原因、静默切演示 |
| SSH 失败 | `availability=unreachable` + 子码 | 错误条 + 子态；保留旧数据并标 stale | 重试 | 诊断 / 演示 | 见 §4.6，`state.connectFailed` + `error.<code>` | 显示密钥、内网 IP 全文 |
| 命令失败/未知 | `COMMAND_FAILED`/`UNSUPPORTED_OUTPUT`/`unknown` | `degraded` 警告条；有部分数据则渲染并标 partial | 重试 | 诊断 | `设备状态不完整` / `state.partial.title`；原因 `error.<code>` | 把失败当 0、隐藏警告 |
| 部分字段缺失 | `degraded`/`partial`/字段 null | 字段“缺失”+原因；顶部“部分数据不可用” | 刷新 | 诊断 | `{count} 个字段缺失` / `state.partial.title` | 用 0 代替、静默略过 |
| 数据过期 | `collection.stale=true` | 数据源条琥珀 + “已过期” + 刷新 CTA；数据仍可读 | 刷新 | 查看采集时间 | `数据已过期` / `state.stale.title` | 自动刷新冒充实时、把导入 run 标过期 |
| 演示 | `demoMode` 或空态选择 | 顶部 DEMO 横幅 + `synthetic` + 导出水印 | 退出演示 | 导入真实结果 | `演示数据，非真机` / `state.demo.title` | 隐藏标识、混入真实 runs |
| 空数据 | 无 runs/无对比/无洞察/无热点 | 对应区块空态；其他区不受影响 | 导入基线 / 去选择 / 导入热点 | 演示 | `还没有运行记录` / `state.emptyRuns.title` | 四区同时空白、无出路 |
| 仓储损坏 | `STORE_CORRUPT`/`SCHEMA_UNSUPPORTED` | 全局面板错误卡；不渲染旧数据；不自动重置 | 查看诊断 | 复制诊断 / 联系管理员 | `本地数据无法读取` / `state.storeCorrupt.title`；`不会自动清空，请先备份。` | 一键清空、静默重建 |
| 导入错误 | 导入解析/校验失败 | 仅 sheet 内错误卡 | 重新选择 | 诊断 / 查看示例 | 见 §5.4，`state.parse.title` + `error.<code>` | 覆盖已有 runs、显示大段原文 |

### 7.3 部分字段缺失的展示规则

| 字段 | 展示 | 下游影响 |
| --- | --- | --- |
| `chip.power_w=null` / `chip.temp_c=null` | 该芯片显示“缺失”+原因；不用其他芯片顶替、不求和 | 不派生卡级功耗/温度（v1 无卡级字段） |
| `processes_state=none_reported` | “工具未报告进程”；空数组≠无服务 | 不生成“设备空闲”的强结论 |
| `processes_state=unknown` | “进程信息不可用” | 不生成进程/泄漏类洞察 |
| `processes_state=observed` 且空、HBM=0 | “无占用进程”（真 0） | 可提示空闲 |
| `processes_state=observed` 且空、HBM>0 | “未看到占用进程”+可能来自其他容器/命名空间 | 不判泄漏、不生成 critical |
| `software.npu_smi/cann=null` | “版本未知” | 不阻断设备指标；环境比较显示未知 |
| `runtime`/`storage` | **固定 null，不渲染模块** | 不展示容器/磁盘/vLLM 进程；t6 证据不作当前值 |
| `hbm_usage_rate_pct` 与 used/total 不一致 | 主显示 computed†；tooltip 给 reported 与差异 | 快照展示以 used/total 计算†；洞察证据用 Host 原值，UI 不改写 |
| `card.model` 为 null 或各卡不同 | “未知型号”/“多型号”+逐卡 tooltip | 不猜测芯片型号 |
| `host.alias=null` | “本机/未知主机” | 不显示 IP/用户/端口 |
| `source.collected_at=null` | “时间未知” | 仍允许刷新；不伪造时间 |
| `collection.partial=true` | 顶部“部分数据不可用”+字段级缺失 | 不进入“完全正常”措辞 |
| `metrics[key].value=null` | “缺失”+`missing_reason` | 不参与 verdict/结论 |
| `verdict=zero_baseline` | 百分比“不计算”，绝对差照常 | 不计入改善/回归计数 |
| `verdict=descriptive` | 中性“描述性”（仅描述差值） | 不显示胜负色 |
| `source.evidence_kind=unverified_import` | “未验证导入”徽标 + 来源详情 | 不写成“实测” |
| 未知 `Notice.code`/`ApiError.code` | 显示 `message` 兜底 + 复制诊断；记录 warning | 不静默丢弃、不显示裸 code |

### 7.4 错误码展示（见 §5.4 / t2 §9.2）

错误码与文案集中管理，UI 只做 `error.<code>` 映射；未知码回退 `message`。新增码必须有 zh/en 文案与一个可执行出路，否则不允许上线。`STORE_CORRUPT` 不提供自动 reset；`EXPORT_TOO_LARGE` 给“减少指标/筛选后重试”。

---

## 8 组件与字段契约

> 本节是 **UI 消费契约**，不定义 Host 实现。契约版本 `dsh-ascend-perf/v1`（t2，2026-11-07）；字段缺失时 UI 必须降级，不得抛错白屏。按 t2 约定：`readonly` 指对设备与远端只读，导入会写 Host 私有数据；快照不自动探测 `runtime`/`storage`，仅离线报告可附带。

### 8.1 UI 消费模型（`dsh-ascend-perf/v1`）

> 以下为 UI 只读消费的子集，字段名、枚举、可空性以 `docs/tech-design.md` §3/§4.3/§5.1/§7.2/§8 为准。Host 已按 v1 输出，UI **不做补算、不做字段重命名**；标 `†` 的是 UI 展示派生值，不进入数据层。

```ts
type Kind = 'snapshot' | 'run' | 'compare' | 'insight'
type Status = 'ok' | 'degraded' | 'error' | 'empty'
type MetricKey =
  | 'request_throughput_rps' | 'output_throughput_tps' | 'total_throughput_tps'
  | 'ttft_p50_ms' | 'ttft_p99_ms' | 'tpot_p50_ms' | 'tpot_p99_ms'
  | 'itl_p50_ms' | 'itl_p99_ms' | 'success_rate_pct'

interface Notice {
  code: string
  field: string | null
  message: string                    // 中文兜底；UI 优先按 code + args 本地化
  args: Record<string, string | number | boolean | null>
}

interface Source {
  mode: 'local' | 'ssh' | 'import' | 'demo'
  is_demo: boolean
  evidence_kind: 'captured' | 'synthetic' | 'unverified_import'
  host: string | null                // 仅别名或 'local'，不含 IP/用户/端口/凭据
  path: string | null                // 仅安全 basename
  source_ref: string                 // hash 或 fixture ID
  collected_at: string | null        // ISO 8601 UTC
  sha256: string | null
}

interface Result<T, K extends Kind> {
  schema: 'dsh-ascend-perf/v1'
  kind: K
  status: Status
  readonly: true                     // 设备/远端只读；导入仍写 Host 私有仓储
  source: Source
  warnings: Notice[]
  data: T | null                     // status=error 时为 null
  error: ApiError | null
}

interface ApiError { code: string; message: string; retryable: boolean; details: unknown }

interface Metric {
  value: number | null
  unit: 'req/s' | 'token/s' | 'ms' | '%'
  direction: 'higher' | 'lower' | 'neutral'
  missing_reason: string | null
}

interface Snapshot {
  snapshot_id: string
  captured_at: string
  availability: 'available' | 'no_device' | 'command_missing' | 'unreachable' | 'unknown'
  host: { alias: string; arch: string | null }
  software: { npu_smi: string | null; cann: string | null }
  npu: { card_count: number; chip_count: number; memory_unit: 'MiB'; cards: NpuCard[] }
  runtime: null                      // 本版不采、不展示
  storage: null                      // 本版不采、不展示
  collection: { duration_ms: number; command_ids: string[]; stale: boolean; partial: boolean }
}

interface NpuCard {
  card_id: number
  model: string | null
  chips: ChipSnapshot[]
  processes: ProcessInfo[]           // 仅放“无法归属到 chip”的进程，避免与 chip.processes 重复
}

interface ChipSnapshot {
  chip_id: number
  phy_id: number
  bus_id: string | null
  health: 'ok' | 'warning' | 'critical' | 'unknown'
  health_raw: string | null
  temp_c: number | null
  power_w: number | null
  aicore_pct: number | null
  npu_util_pct: number | null
  hbm_used_mb: number | null
  hbm_total_mb: number | null
  hbm_usage_rate_pct: number | null
  hbm_reported_usage_rate_pct: number | null
  processes: ProcessInfo[]           // 仅放已归属本 chip 的进程
  processes_state: 'observed' | 'none_reported' | 'unknown'
  missing_reasons: Record<string, string | null>
}

interface ProcessInfo {
  pid: number
  name: string
  memory_mb: number | null
  chip_id: number | null
  container_pid: number | null
}

interface Run {
  run_id: string
  label: string
  created_at: string
  timestamp: string | null           // 运行时间，可能来自文件内容
  timestamp_source: 'input' | 'override' | 'unknown'
  source: Source
  env: RunEnv
  workload: Workload
  metrics: Record<MetricKey, Metric>
  hotspots: Hotspot[]
  snapshot_id: string | null
  provenance: {
    format: 'vllm-json' | 'benchmark-csv' | 'msprof-op-summary-csv'
    parser_version: '1'
    accepted_rows: number
    rejected_rows: number
    total_hotspot_duration_us: number | null
    field_sources: Record<string, string>
    missing_reasons: Record<string, string | null>
    ignored_fields: string[]
  }
}

interface Workload {
  model: string | null
  cards: number | null
  input_len: number | null
  output_len: number | null
  concurrency: number | null
  request_rate_rps: number | null
  request_rate_mode: 'finite' | 'unbounded' | 'unknown'
  dataset: string | null
  precision: string | null
}

interface RunEnv {
  hardware: string | null
  cann: string | null
  framework: string | null
  framework_version: string | null
  backend: string | null
  tensor_parallel: number | null
  notes: string | null
}

interface Hotspot {
  op_name: string
  op_type: string | null
  task_type: string | null
  calls: number | null
  total_duration_us: number
  mean_duration_us: number | null
  share_pct: number
  source_rows: number[]
}

interface MetricComparison {
  key: MetricKey
  unit: Metric['unit']
  direction: Metric['direction']
  baseline: number | null
  candidate: number | null
  delta_abs: number | null
  delta_pct: number | null
  adverse_delta_pct: number | null
  verdict: 'regressed' | 'improved' | 'stable' | 'missing' | 'zero_baseline' | 'descriptive'
  threshold: number
  missing_reason: string | null
}

interface Comparison {
  baseline_run_id: string
  candidate_run_id: string
  comparable: boolean
  comparability: 'matched' | 'mismatch' | 'unknown'
  comparability_issues: Notice[]
  metrics: MetricComparison[]
  primary_metrics: MetricKey[]       // 固定 4 项
  incomplete: boolean
  summary: {
    conclusion: 'regressed' | 'improved' | 'stable' | 'inconclusive' | 'not_comparable'
    code: string
    args: Record<string, string | number | boolean | null>
    message: string
  }
  computed_at: string
  algorithm_version: string
  threshold_pct: number
}

interface Evidence {
  ref: string                        // 如 run:candidate/output_throughput_tps、snapshot:card_0/chip_0/temp_c
  field: string
  value: string | number | null
  unit: string | null
  collected_at: string | null
}

interface Insight {
  id: string
  severity: 'info' | 'notice' | 'warning' | 'critical'
  rule_id: string
  code: string
  args: Record<string, string | number | boolean | null>
  title: string                      // 中文兜底；en 用 rule.<rule_id>.title
  evidence: Evidence[]
  suggestion: string                 // 单条，中文兜底
  confidence: 'observed' | 'heuristic'
  created_at: string
}

interface InsightReport {
  insights: Insight[]                // 最多 20 条
  skipped_rules: Array<{ rule_id: string; reason: string }>
  rule_version: string
  input_refs: string[]
  omitted_count: number
}
```

### 8.2 NPU 卡字段（状态卡区）

| UI 元素 | 字段 | 格式 | 缺失时 |
| --- | --- | --- | --- |
| 设备概要 | `host.alias`、`host.arch`、`npu.card_count`、`npu.chip_count`、`npu.memory_unit` | `本地 · aarch64 · 8 卡 · 16 芯片 · MiB` | 主机名缺失显示“本机/未知主机”；不补 CPU/内存总量（v1 不含） |
| 型号 | `cards[].model` | 全卡一致显示型号；不一致显示“多型号”，tooltip 逐卡列出 | “未知型号” |
| 软件 | `software.npu_smi`、`software.cann` | `npu-smi 26.1.1 · CANN 8.1.RC2` | “版本未知”；不展示 torch/vLLM（v1 快照不含） |
| 卡标题 | `card_id` | `卡 0` | 不适用 |
| 卡健康† | 该卡 `chips[].health` 取最差 | 正常/警告/危险/未知 + 图标；标 `†` | “未知” |
| 卡折叠摘要† | `chips[].hbm_used_mb/total`、`chips[].processes`、`cards[].processes` | `HBM 6.1/128 GiB† · 进程 0†`；HBM 仅当全部芯片有值才求和 | 任一芯片缺 HBM→“部分缺失”；进程含 `unknown`→“不可用”，不求和成 0 |
| 芯片健康 | `chips[].health` / `health_raw` | badge + 原值 tooltip | “未知” |
| 温度 | `chips[].temp_c` | `49°C`（整数） | “缺失” |
| 功耗 | `chips[].power_w` | `165.5 W`（1 位小数） | “缺失”；**不用 chip0 顶替其他芯片** |
| HBM | `hbm_used_mb` / `hbm_total_mb` | `3.06 / 64.0 GiB`（MiB 换算）+ 百分比†（used/total）；tooltip 给 `hbm_reported_usage_rate_pct` 原值 | “缺失”；有 used 无 total 只显示绝对量 |
| AICore | `chips[].aicore_pct` | `0%`；0<x<1 显示 `<1%` | “缺失”；不与 NPU 利用率互相顶替 |
| NPU 利用率 | `chips[].npu_util_pct` | 单独一行，标签“NPU 利用率” | “缺失” |
| 已归属进程 | `chips[].processes[]` | 每芯片一行；`pid · name · memory · 容器 PID` | 由 `processes_state` 决定文案 |
| 未归属进程 | `cards[].processes[]` | 卡底部独立列表“未归属芯片 n 条” | 空数组不显示该行 |
| 进程状态 | `chips[].processes_state` | `observed`=已读取；`none_reported`=工具明确未报告；`unknown`=未提供 | `unknown` 显示“进程信息不可用”，**不写“无占用进程”** |
| 采集时间 | `source.collected_at` + `collection.duration_ms` | 本地时区 `MM-DD HH:mm:ss`，tooltip 原始 ISO 与耗时 | “时间未知”；`collection.stale=true` 加“已过期” |
| 降级 | `snapshot.availability`、`collection.partial` | 顶部 notice + 设备区角标 | 见 §7 |

设备概要中的卡数、芯片数直接取 `card_count`/`chip_count`；若与 `cards[]` 行数不一致，显示 `†` 并以 Host 计数为准，不自行重算。总健康取所有芯片最差，标 `†`；**不显示健康分**。 卡折叠摘要的 HBM 合计与进程数是展示聚合，标 `†`；不得用单芯片值冒充整卡，也不得在缺值/未知时补 0。

### 8.3 runs 表/列表

| 列/元素 | 字段 | 格式 | 说明 |
| --- | --- | --- | --- |
| 标签 | `label` | 原样，最多 2 行省略 | 首版不重命名 |
| 运行时间 | `timestamp` + `timestamp_source` | `YYYY-MM-DD HH:mm`；`unknown` 显示“时间未知” | tooltip 说明来源 input/override |
| 导入时间 | `created_at` | `YYYY-MM-DD HH:mm` | 历史数据不标过期 |
| 来源 | `source.mode` + `source.evidence_kind` + `is_demo` | `导入 · 未验证` / `SSH 采集` / `DEMO` | `path` 只显示 basename；`source_ref`/`sha256` 进来源详情 |
| 环境 | `env.cann`、`env.framework`、`env.framework_version`、`env.backend`、`env.tensor_parallel` | `CANN 8.1.RC2 · torch 2.8.0 · vLLM · TP8` | 最多 2 项，其余 tooltip |
| workload | `workload.model/cards/input_len/output_len/concurrency/request_rate_rps` | `Qwen2.5-7B · 1 卡 · in 1024/out 256 · 并发 32` | 缺失“未提供”；不显示 batch/seq（v1 无） |
| 指标 | `metrics` 的 10 个 key | `8/10 项`；缺失数单独 badge | 不把缺失算 0 |
| 热点 | `hotspots.length`、`provenance.format` | `热点 12 条 · msprof` | 无则“暂无热点” |
| 操作 | — | 设为基线/候选、查看来源、移除 | 菜单内，键盘可达 |

### 8.4 对比表字段

顶部先给**结论**（`summary.conclusion` + `summary.message`），再给可比性（`comparability` 与 `comparability_issues`），最后是逐指标表。结论与逐指标判定是两层，不混用文案。

| 列 | 内容 | 窄栏卡片对应 |
| --- | --- | --- |
| 指标 | `metric.<key>` 名称 + 方向图标 + 主要指标星标 + 阈值 tooltip | 第一行左 |
| 基线 | 数值 + `unit` | 第二行 `基线 → 候选` |
| 候选 | 数值 + `unit` | 第二行 |
| Δ 绝对 | `delta_abs` 带符号 + 单位 | 第三行左 |
| Δ% | `delta_pct` 带符号 1 位小数；`zero_baseline` 显示“基线为 0，不计算百分比” | 第三行右 |
| 不利变化 | `adverse_delta_pct`，tooltip“按方向换算” | 第四行左 |
| 阈值 | `±threshold`（默认 5%） | 第四行右 |
| 判定 | `verdict` badge：回归/改善/持平/缺失/零基线/描述性 | 第一行右 |

列显示随宽度：300–419px 用卡片；420–559px 只保留“指标/候选/Δ%/判定”4 列；560–719px 6 列（指标/基线/候选/Δ/Δ%/判定）；≥720px 8 列（追加“不利变化/阈值”）。主要指标用名称前星标与行首强调，不单独占列。排序：4 项主要指标固定在前（按 `primary_metrics` 顺序），其余指标按 `verdict`（regressed→improved→stable→descriptive→missing→zero_baseline）再按 `|adverse_delta_pct|` 降序，缺失排最后。`comparability=mismatch/unknown` 时仍展示原值与描述性差值，但结论区不得出现“改善/回归”大字。

### 8.5 洞察卡字段

| 元素 | 字段 | 规则 |
| --- | --- | --- |
| 严重度 | `severity` | 四档；文本不可省略；critical/warning 用图标+文本，不只靠颜色 |
| 标题 | `title`（中文兜底）；en 用 `rule.<rule_id>.title` 模板 | 结论句含指标与幅度；不做字符串解析取数 |
| 规则 | `rule_id` | 可展开规则说明（阈值、判定逻辑、不适用条件） |
| 置信 | `confidence` | `observed`=直接观测；`heuristic`=启发式，显示“推断”badge |
| 时间 | `created_at` | 本地时区 `HH:mm`，tooltip 完整 |
| 证据 | `evidence[]` | 1–4 条；`ref` 可点击跳到对比行或快照字段；显示 `field`、`value`+`unit`、`collected_at` |
| 建议 | `suggestion`（单条） | 动词开头；不承诺收益；`code`/`args` 供本地化 |
| 操作 | — | 复制建议、查看证据、规则说明 |
| 报告级 | `skipped_rules`、`omitted_count`、`rule_version` | 折叠区“未生成的规则/已省略条数”，解释“为什么没有更多洞察” |

排序按 Host 返回（critical→warning→notice→info，再按 `rule_id`），UI 不重排；最多 20 条，`omitted_count>0` 时底部提示。无洞察时显示“暂无达到阈值的规则”，并给“查看已跳过规则”。

### 8.6 判定与格式规则

- **Verdict 与 Conclusion 分离**：`MetricComparison.verdict` 描述单指标（6 值）；`Comparison.summary.conclusion` 描述整体（5 值）。UI 不得用单指标 badge 冒充整体结论，也不得把 `inconclusive` 写成“持平”。
- **阈值**：默认 `regressionThreshold=5%`（config 0.1–50，compare 可单次覆盖）；每行 `threshold` 以 Host 返回为准，首版 UI 只读，不提供面板内编辑。
- **不利变化**：延迟类 `adverse=delta_pct`；吞吐/成功率 `adverse=-delta_pct`。`adverse≥threshold`→回归，`≤-threshold`→改善，其余持平；缺值→`missing`；基线 0→`zero_baseline`，`delta_pct`/`adverse` 均为 null。
- **可比性**：`matched` 才给正常结论；`mismatch`→`not_comparable`；`unknown`→`inconclusive`；两者都只显示描述性差值，不提供“强制通过”开关。CANN/framework/backend/TP 差异属于环境变化，由 `comparability_issues` 逐条展示，不静默忽略。
- 缺失：`null` → “缺失”，绝不 0；派生值（卡健康、HBM 百分比、计数）加 `†`。
- 单位：`MiB/GiB` 由 MiB 按 1024 换算；功耗 `W` 1 位小数；温度整数 `°C`；延迟 `ms` 1 位小数；吞吐 1 位小数；成功率 `%` 1 位小数。
- 百分比：0–100；相对变化用 `%`；率值变化用 `pp`（4%→6% 写作 `+2 pp`，不写 `+50%`）。
- 时间：对外 ISO 8601 UTC，UI 本地时区展示；快照时间用 `source.collected_at`，运行时间用 `timestamp`，导入时间用 `created_at`，三者不混用。
- 零基线：百分比为空 + 原因；绝对差照常显示；排序不按 null 参与。
- 数值精度以 Host 原值为准，UI 只做显示舍入；tooltip 给未舍入值用于复算。

### 8.7 与 t2 对齐

| UI 需要 | t2 v1 契约 | 状态 |
| --- | --- | --- |
| 信封 | `Result{schema,kind,status,readonly,source,warnings,data,error}` | ✅ |
| 来源 | `source{mode,is_demo,evidence_kind,host,path,source_ref,collected_at,sha256}` | ✅ |
| 快照 | `snapshot_id/captured_at/availability/host/software/npu/collection` | ✅ |
| 卡/芯片 | `NpuCard{card_id,model,chips,processes}`、`ChipSnapshot{...}` | ✅ 卡级 health 由 UI 派生†；卡级 power/temp 不派生、不显示 |
| 进程 | `card.processes` 仅未归属；`chip.processes` 仅已归属；`processes_state` | ✅ 不重复计数 |
| 运行 | `Run{run_id,label,created_at,timestamp,env,workload,metrics,hotspots,provenance}` | ✅ |
| 指标 | 10 个固定 `MetricKey`；`Metric{value,unit,direction,missing_reason}` | ✅ 无自定义 P90 |
| 对比 | `MetricComparison` 6 verdict、`Comparison` 5 conclusion、`comparability` | ✅ |
| 洞察 | `Insight{severity,rule_id,code,args,title,evidence,suggestion,confidence}` | ✅ 单条 suggestion |
| 导入 | 仅三种格式；内容≤1MiB；默认 reject、显式 skip；sha256 幂等 | ✅ |
| 导出 | `{filename,mime,content,sha256}`≤64KiB；不写 Host 路径 | ✅ |
| 右侧栏 | definition id=`dsh-ascend-perf`、kind=`ascend-perf`、guide order=70 | ✅ |
| 运行态/存储 | `runtime:null`、`storage:null`，本版不采不展示 | ✅ 不做“可选渲染” |

对齐规则：

1. 以 `dsh-ascend-perf/v1` 为准；`docs/fixtures/npu-snapshot.sample.json`（draft-0.1）只作原始采集参考，UI 组件不直接读 fixture 字段。
2. `readonly: true` 指对设备与远端只读；**导入会写 Host 私有数据**（run 记录、来源引用），文案不得说“不写任何数据”。
3. `runtime`/`storage` 固定 null；容器、磁盘、vLLM 进程等 t6 证据只作离线材料，不得渲染成当前值，也不在设备区出现“运行态”模块。
4. `host` 只显示别名；路径只显示安全 basename；不展示 IP、用户、端口、密钥路径；`source_ref`/`sha256` 可复制但不拼接命令。
5. 导入默认 `evidence_kind=unverified_import`，必须显示“未验证导入”；DEMO `is_demo=true`、`evidence_kind=synthetic`，三重标识不可隐藏。
6. 不把 `warnings[].message` 当中文 key；按 `code` 本地化，`message` 仅兜底。`error` 时 `data=null`，不渲染半截数据。
7. 对比结论、verdict、adverse、排序全部由 Host 计算；UI 只显示与计数（计数标†），不自行改判。

### 8.8 MetricKey 与默认阈值

| key | 名称 | 单位 | 方向 | 主要指标 | 阈值 |
| --- | --- | --- | --- | --- | --- |
| `request_throughput_rps` | 请求吞吐 | req/s | higher |  | 5% |
| `output_throughput_tps` | 输出吞吐 | token/s | higher | ★ | 5% |
| `total_throughput_tps` | 总吞吐 | token/s | higher |  | 5% |
| `ttft_p50_ms` | TTFT p50 | ms | lower |  | 5% |
| `ttft_p99_ms` | TTFT p99 | ms | lower | ★ | 5% |
| `tpot_p50_ms` | TPOT p50 | ms | lower |  | 5% |
| `tpot_p99_ms` | TPOT p99 | ms | lower | ★ | 5% |
| `itl_p50_ms` | ITL p50 | ms | lower |  | 5% |
| `itl_p99_ms` | ITL p99 | ms | lower |  | 5% |
| `success_rate_pct` | 成功率 | % | higher | ★ | 5% |

阈值列展示 `±5%`，tooltip 注明“config `regressionThreshold`，compare 可单次覆盖 0.1–50；面板内不可编辑”。无数据时不显示 0，显示“缺失”。主要指标固定 4 项，顺序以 `primary_metrics` 为准。

---

## 9 文案与 locale

### 9.1 命名规范

- key 采用 `区域.语义`；与 t2 核心集保持一致：`meta.*`、`panel.*`、`action.*`、`source.*`、`state.*`、`metric.*`、`compare.*`、`insight.*`、`warning.*`、`error.*`、`rule.*`。本文新增的纯 UI key 用 `ui.*`（如 `ui.section.device`），不冒充契约字段。
- 文案不拼接句子；变量用 `{count}`、`{name}`、`{pct}`、`{time}`，由 locale 服务插值。
- **所有用户可见文案由 code + args 本地化**；Host 返回的 `message`/`title`/`suggestion` 是中文兜底，locale 缺失时才直接显示，不解析字符串取数。
- `warnings[]` 用 `warning.<Notice.code>`，`error` 用 `error.<ApiError.code>`，洞察用 `rule.<rule_id>.title`/`rule.<rule_id>.suggestion`；未知 code 显示 `message` 并记录 warning。
- 未翻译 key 回退英文并记录 warning，不显示裸 key。

### 9.2 zh/en 关键文案

| key | zh | en |
| --- | --- | --- |
| `meta.title` | 昇腾性能工作台 | Ascend Performance Workbench |
| `meta.description` | 只读查看昇腾 NPU 状态，导入并对比 benchmark | Inspect Ascend NPU status and compare benchmarks |
| `panel.title` | 昇腾性能 | Ascend Performance |
| `panel.guide.title` | 查看昇腾性能 | Ascend performance |
| `panel.guideDescription` | 查看 NPU 状态、导入基准并对比两次运行 | Inspect NPU status, import benchmarks, compare runs |
| `panel.readonly` | 只读 | Read-only |
| `panel.readonlyTip` | 对设备与远端只读；导入会写 Host 私有数据，不上传 | Devices and remotes are read-only; imports write private Host data; nothing is uploaded |
| `action.refresh` | 刷新 | Refresh |
| `action.retry` | 重试 | Retry |
| `action.import` | 导入 | Import |
| `action.importBaseline` | 导入基线 | Import baseline |
| `action.importCandidate` | 导入候选 | Import candidate |
| `action.importHotspots` | 导入热点 | Import hotspots |
| `action.compare` | 开始对比 | Compare |
| `action.cancel` | 取消 | Cancel |
| `action.delete` | 移除 | Remove |
| `action.loadDemo` | 加载演示数据 | Load demo data |
| `action.exitDemo` | 退出演示 | Exit demo |
| `action.copySuggestion` | 复制建议 | Copy suggestion |
| `action.copyDiagnostics` | 复制诊断 | Copy diagnostics |
| `action.diagnostics` | 查看诊断 | Diagnostics |
| `action.export` | 导出对比摘要 | Export comparison |
| `action.ruleDoc` | 规则说明 | Rule details |
| `ui.section.device` | 设备与环境 | Device & environment |
| `ui.section.runs` | 运行与对比 | Runs & comparison |
| `ui.section.insights` | 洞察 | Insights |
| `ui.section.hotspots` | 热点排行 | Hotspots |
| `source.local` | 本机 | Local |
| `source.ssh` | SSH | SSH |
| `source.import` | 导入 | Imported |
| `source.demo` | 演示 | Demo |
| `source.historical` | 历史 | Historical |
| `source.unverified` | 未验证导入 | Unverified import |
| `source.captured` | 采集 | Captured |
| `source.synthetic` | 合成 | Synthetic |
| `source.justNow` | 刚刚 | just now |
| `source.minutesAgo` | {n} 分钟前 | {n} min ago |
| `source.hoursAgo` | {n} 小时前 | {n} h ago |
| `source.yesterday` | 昨天 {time} | Yesterday {time} |
| `device.summary` | {host} · {arch} · {cards} 卡 · {chips} 芯片 · {unit} | {host} · {arch} · {cards} cards · {chips} chips · {unit} |
| `device.card` | 卡 {id} | Card {id} |
| `device.chip` | 芯片 {id} | Chip {id} |
| `device.health` | 健康 | Health |
| `device.temp` | 温度 | Temp |
| `device.power` | 功耗 | Power |
| `device.hbm` | HBM | HBM |
| `device.aicore` | AICore | AICore |
| `device.npuUtil` | NPU 利用率 | NPU util. |
| `device.processes` | 进程 | Processes |
| `device.noProcess` | 无占用进程 | No processes |
| `device.noProcessReported` | 工具未报告进程 | Tool reported no processes |
| `device.processUnknown` | 进程信息不可用 | Process info unavailable |
| `device.unassigned` | 未归属芯片 {n} 条 | {n} unassigned |
| `device.env` | 软件环境 | Software |
| `device.capturedAt` | 采集于 {time} | Captured {time} |
| `device.details` | 采集详情 | Collection details |
| `device.sameSource` | 与 Agent 读取的是同一份结果 | Same result the agent reads |
| `state.loading.title` | 正在读取缓存… | Reading cache… |
| `state.loading.refresh` | 正在刷新… | Refreshing… |
| `state.empty.title` | 尚未采集设备状态 | Device not collected yet |
| `state.empty.desc` | 点击刷新读取本机 NPU；打开面板不会自动执行。 | Refresh to read the local NPU; opening the panel does not collect. |
| `state.noDevice.title` | 未发现 NPU 设备 | No NPU device found |
| `state.noDevice.desc` | 驱动未加载、设备未映射，或当前用户无权限。 | Driver not loaded, devices not mapped, or permission denied. |
| `state.commandMissing.title` | 未找到 npu-smi | npu-smi not found |
| `state.commandMissing.desc` | 本机未安装昇腾工具，或 PATH 对 DSH 不可见。 | Ascend tools are absent, or not on DSH's PATH. |
| `state.connectFailed.title` | SSH 采集失败 | SSH collection failed |
| `state.partial.title` | 设备状态不完整 | Device status is partial |
| `state.partial.desc` | {count} 个字段缺失，相关结论不可用。 | {count} fields missing; affected conclusions are unavailable. |
| `state.stale.title` | 数据已过期 | Data is stale |
| `state.stale.desc` | 上次采集于 {time}；刷新以读取当前状态。 | Last captured {time}; refresh for the current state. |
| `state.storeCorrupt.title` | 本地数据无法读取 | Local data is unreadable |
| `state.storeCorrupt.desc` | 不会自动清空；请先备份再查看诊断。 | Not reset automatically; back up and check diagnostics. |
| `state.emptyRuns.title` | 还没有运行记录 | No runs yet |
| `state.emptyRuns.desc` | 导入 baseline 与 candidate 的 benchmark 结果后即可对比。 | Import baseline and candidate results to compare. |
| `state.emptyCompare.title` | 选择两次运行开始对比 | Select two runs to compare |
| `state.demo.title` | 演示数据，非真机 | Demo data; not a real device |
| `state.demo.desc` | 仅用于验证界面与计算，不代表真机性能 | For UI and calculation checks only; not real performance |
| `state.parse.title` | 无法解析文件 | Cannot parse file |
| `state.parse.desc` | 第 {line} 行 {field}：{reason} | Line {line}, {field}: {reason} |
| `metric.requestThroughput` | 请求吞吐 | Request throughput |
| `metric.outputThroughput` | 输出吞吐 | Output throughput |
| `metric.totalThroughput` | 总吞吐 | Total throughput |
| `metric.ttftP50` | TTFT p50 | TTFT p50 |
| `metric.ttftP99` | TTFT p99 | TTFT p99 |
| `metric.tpotP50` | TPOT p50 | TPOT p50 |
| `metric.tpotP99` | TPOT p99 | TPOT p99 |
| `metric.itlP50` | ITL p50 | ITL p50 |
| `metric.itlP99` | ITL p99 | ITL p99 |
| `metric.successRate` | 成功率 | Success rate |
| `metric.missing` | 缺失 | Missing |
| `compare.baseline` | 基线 | Baseline |
| `compare.candidate` | 候选 | Candidate |
| `compare.metric` | 指标 | Metric |
| `compare.delta` | 变化 | Delta |
| `compare.deltaPct` | 变化% | Delta % |
| `compare.adverse` | 不利变化 | Adverse |
| `compare.threshold` | 阈值 ±{pct}% | Threshold ±{pct}% |
| `compare.verdict` | 判定 | Verdict |
| `compare.regressed` | 回归 | Regressed |
| `compare.improved` | 改善 | Improved |
| `compare.stable` | 持平 | Stable |
| `compare.inconclusive` | 不确定 | Inconclusive |
| `compare.notComparable` | 不可比 | Not comparable |
| `compare.descriptive` | 描述性 | Descriptive |
| `compare.zeroBaseline` | 基线为 0，不计算百分比 | Baseline is 0; percentage not calculated |
| `compare.missing` | 缺失 | Missing |
| `compare.issueEnv` | 环境差异：{field} {baseline} → {candidate} | Environment differs: {field} {baseline} → {candidate} |
| `compare.issueWorkload` | workload 差异：{field} {baseline} → {candidate} | Workload differs: {field} {baseline} → {candidate} |
| `compare.warnBanner` | 关键条件不一致，只展示描述性差值 | Key conditions differ; descriptive deltas only |
| `compare.consistent` | 环境与 workload 一致 | Environment and workload match |
| `compare.summary` | {regressed} 回归 · {improved} 改善 · {stable} 持平 · {other} 其他 | {regressed} regressed · {improved} improved · {stable} stable · {other} other |
| `insight.severity.critical` | 严重 | Critical |
| `insight.severity.warning` | 警告 | Warning |
| `insight.severity.notice` | 提示 | Notice |
| `insight.severity.info` | 信息 | Info |
| `insight.confidence.observed` | 实测 | Observed |
| `insight.confidence.heuristic` | 推断 | Heuristic |
| `insight.evidence` | 证据 | Evidence |
| `insight.suggestion` | 建议 | Suggested checks |
| `insight.rule` | 规则 {id} | Rule {id} |
| `insight.omitted` | 另有 {n} 条未显示 | {n} more not shown |
| `insight.skipped` | 未生成的规则 | Rules skipped |
| `insight.empty.title` | 暂无洞察 | No insights yet |
| `insight.empty.desc` | 完成一次对比后，将根据指标变化生成带证据的建议。 | Compare two runs to generate evidence-backed suggestions. |
| `insight.noRuleHit` | 本次对比未触发规则（阈值 ±{pct}%）。 | No rule fired (threshold ±{pct}%). |
| `import.title` | 导入运行数据 | Import run data |
| `import.supported` | 支持 vLLM JSON / benchmark CSV / msprof op_summary CSV，≤1 MiB | vLLM JSON / benchmark CSV / msprof op_summary CSV, ≤1 MiB |
| `import.privacy` | 在本机由插件解析，不上传；导入会写 Host 私有仓储。 | Parsed locally by the plugin; not uploaded; imports write private Host storage. |
| `import.confirm` | 导入 | Import |
| `import.deduplicated` | 该文件已导入，已复用原记录 | Already imported; reusing the existing run |
| `import.partial` | 已导入 {accepted} 行，跳过 {rejected} 行 | Imported {accepted} rows; skipped {rejected} |
| `import.skipBadRows` | 跳过坏行导入 | Import skipping bad rows |
| `import.noHotspotRow` | 热点文件仅生成热点，不能作为基线/候选 | Hotspot files produce hotspots only, not runs |
| `hotspot.empty` | 该运行未提供算子级数据，无法排行。 | No op-level data in this run; cannot rank. |
| `hotspot.op` | 算子 | Op |
| `hotspot.share` | 耗时占比（总任务耗时） | Share of total task time |
| `hotspot.calls` | 调用次数 | Calls |
| `export.compare` | 导出对比摘要 | Export comparison |
| `export.copyInsights` | 复制全部洞察 | Copy all insights |
| `toast.copied` | 已复制 | Copied |
| `toast.copyFailed` | 复制失败，请手动选择 | Copy failed; select the text manually |
| `toast.imported` | 已导入 {label} | Imported {label} |
| `toast.exported` | 已生成 {filename} | Generated {filename} |
| `toast.refreshed` | 已刷新 | Refreshed |
| `footer.readonly` | 设备只读 · 不上传 · 导入写 Host 私有数据 | Devices read-only · No upload · Imports write private Host data |
| `footer.rules` | 规则库 v{version} | Rules v{version} |
| `a11y.loading` | 正在加载设备数据 | Loading device data |
| `a11y.demo` | 演示数据，非真机 | Demo data, not a real device |
| `a11y.meter` | {label} 使用率 {pct}%，{used} / {total} | {label} usage {pct}%, {used} / {total} |
| `a11y.delta` | {metric} 从 {baseline} 变为 {candidate}，变化 {pct}，判定 {verdict} | {metric} changed from {baseline} to {candidate}, {pct}, verdict {verdict} |
| `a11y.sort` | 按{column}排序 | Sort by {column} |

### 9.3 数字、单位与百分比

| 类型 | 规则 | 示例 |
| --- | --- | --- |
| 整数计数 | 本地化千分位 | `9,111`、`192` |
| 功耗 | 1 位小数 + 空格 + `W` | `165.5 W` |
| 温度 | 整数 + `°C`（无空格） | `49°C` |
| 容量 | MiB 原值可读时显示 `MiB`；≥1024 MiB 换 `GiB` 1 位小数，tooltip 保留 MiB | `3.06 / 64.0 GiB`（tooltip `3131 / 65536 MiB`） |
| 吞吐 | 1 位小数 + 单位（`token/s`、`req/s`） | `812.4 token/s` |
| 延迟 | 1 位小数 + `ms`；≥10000ms 转 `s` 2 位小数 | `78.2 ms`、`1.24 s` |
| 百分比 | 0–100，整数或 1 位小数 + `%`（无空格） | `4%`、`8.7%` |
| 百分点 | 1 位小数 + `pp` | `+2.0 pp` |
| 相对变化 | 带符号 1 位小数 + `%` | `-8.7%` |
| 不利变化 | 带符号 1 位小数 + `%`；tooltip 说明方向换算 | `+8.7%` |
| 绝对变化 | 带符号 + 数值 + 单位 | `-70.3 token/s` |
| 零基线 | 百分比位置显示“基线为 0”说明 | `—` + 原因 |
| 时间 | 本地时区；运行时间用 `timestamp`，采集用 `collected_at`，导入用 `created_at` | `2026-11-07 00:52:27` |
| 数值字体 | 等宽数字，避免刷新跳动 | `tabular-nums` |

### 9.4 语气与禁用词

- 句式为“现象 + 原因（若已知）+ 出路”，不指责用户，不使用感叹号。
- 禁用：`失败啦`、`异常`（单独使用）、`请稍候`（单独使用）、`智能诊断`、`一键优化`、`AI 建议`、`性能很差`。
- 用“未发现/未检测到/无法读取”区分：无设备、无软件、无权限。
- 洞察建议以动词开头：`固定 concurrency 与输入/输出长度后复测`、`对比 KV cache 命中率`；不写“建议您尝试……”。
- DEMO 文案必须包含“非真机”与“不代表真机性能”；导入文案必须含“未验证”，不得说“实测”。

### 9.5 只读与来源标识

1. 标题右侧 `只读` chip（锁图标 + 文本），tooltip：“对设备与远端只读；不启动服务、不改配置、不上传；导入只写 Host 私有数据”。
2. 所有操作按钮均为刷新/导入/对比/复制/导出；不存在写设备动作。
3. 页脚固定：`设备只读 · 不上传 · 导入写 Host 私有数据`；不再写“不写任何数据”。
4. 来源徽标三件套：`mode`（本机/SSH/导入/演示）+ `evidence_kind`（采集/合成/未验证导入）+ `is_demo`；DEMO 与未验证导入**不可隐藏**。`source.path` 只显示 basename，`source.host` 只显示别名。
5. 导出的 `.md` 头部含 `readonly: true`、`source`、`is_demo`、`evidence_kind`、`source_ref`/`sha256`；不导出设备原始快照，不出 Host 路径。

## 10 视觉设计

### 10.1 色彩语义（只用 `--dsw-alias-*` token）

| 语义 | 主色 token | 底色 token | 使用位置 |
| --- | --- | --- | --- |
| 面板底 | `--dsw-alias-bg-base` | — | 面板背景 |
| 卡片/区块 | `--dsw-alias-bg-layer-1` | `--dsw-alias-bg-layer-2`（hover） | NPU 卡、对比卡、洞察卡 |
| 嵌套/输入 | `--dsw-alias-bg-layer-2` | — | 选择器、输入框、代码块 |
| 分隔 | `--dsw-alias-border-l2` | — | 区块间、表格行 |
| 主文本 | `--dsw-alias-label-primary` | — | 标题、数值 |
| 次文本 | `--dsw-alias-label-secondary` | — | 说明、单位 |
| 弱文本 | `--dsw-alias-label-tertiary` | — | 时间、阈值、占位 |
| 禁用/缺失 | `--dsw-alias-label-quaternary` | — | “缺失”、禁用按钮 |
| 链接 | `--dsw-alias-label-link` | — | 规则说明、查看详情 |
| 正常/改善 | `--dsw-alias-state-success-primary` | `--dsw-alias-state-success-tertiary` | 健康、改善 badge |
| 警告/不可比 | `--dsw-alias-state-warn-primary`；文本 `--dsw-alias-state-warn-label` | `--dsw-alias-state-warn-tertiary` | 过期、可比性横幅、不可比 |
| 危险/回归 | `--dsw-alias-state-error-primary` | `--dsw-alias-state-error-secondary`（过强则用 10% 派生） | 危险健康、回归 badge |
| 信息/演示 | `--dsw-alias-state-business-primary` | `--dsw-alias-bg-layer-3` | 信息洞察、DEMO 边框 |
| 焦点 | `--dsw-focus-ring-color` / `--dsw-focus-ring-width` | — | 所有可聚焦元素 |
| 弹层 | `--dsw-alias-bg-overlay` | `--dsw-elevation-panel` | 导入 sheet、菜单 |
| 骨架 | `--dsw-alias-bg-skeleton` | — | 加载占位 |

约束：不硬编码 hex；不从语义色派生新的主色；若现有底色层级不足，允许 `color-mix(in srgb, var(--dsw-alias-state-*-primary) 8–12%, transparent)` 作为行底色，且文本仍用 `label-primary`。

### 10.2 排版与间距

- 字体：标题 `--dsw-font-base-16` / 600；区块标题 13px / 600；正文 13px；辅助 12px；数值 `--dsw-font-family-code` + `tabular-nums`。
- 行高：正文 1.5；紧凑表 1.35；标题 1.3。
- 间距：4 / 8 / 12 / 16 / 24 / 32；卡片内 12；区块间 16；页面左右 12（窄栏）/ 16（宽栏）。
- 圆角：8（卡片）、6（输入/徽标）、10（sheet）。
- 高度：标题栏 44；数据源条 36；区块头 32；按钮 28（紧凑）/ 32（常规）；触控目标 ≥28×28，主按钮 ≥32 高。
- 不使用重阴影；仅 sheet/菜单用 elevation。

### 10.3 徽标、meter 与差异高亮

- **badge**：文本 + 图标 + 1px 边框 + 8% 底；`改善` 用成功色、`回归` 用危险色、`持平` 用次文本、`缺失` 用弱文本、`零基线` 用警告色、`描述性` 用中性色。不能只用颜色，必须带文字。
- **健康**：`正常` 圆点+文本、`警告` 三角+文本、`危险` 圆+感叹号+文本、`未知` 问号+文本；设备区总健康取最差。
- **meter**：HBM 用 6px 高、AICore 用 6px；底 `bg-layer-3`，填充中性色（HBM 紫/业务蓝，AICore 青，均取自现有 token；若没有对应色则统一 `state-business-primary`），**不使用红绿表示利用率高低**（利用率不是好坏）。≥90% 时在数值旁加警告图标，而不是把整条变红。
- **差异高亮**：对比行左侧 2px verdict 色条 + 行底 8% 同色；delta 单元格用等宽字体，箭头表示数值方向（↑/↓），颜色表示判定（好/坏）；例如吞吐量 `↓ 8.7%` 为红色，TTFT `↑ 7.4%` 为红色，TPOT `↓ 1.9%` 为灰色（持平）。箭头与颜色语义分离必须在 tooltip 说明。
- **过期**：数据源条顶部 2px 警告色边 + `已过期` badge；不改变内容颜色，避免“整屏报错”。
- **DEMO**：顶部整宽虚线边框条，`DEMO` 反色 chip + 文本；不使用大面积黄色底（易与警告混淆），但必须显眼。

### 10.4 明暗主题与图标

- 所有颜色走 token，明暗主题下都不出现对比度不足；骨架、边框、hover 一致。
- 图标 16px，线性，`aria-hidden`；severity 图标与文本同时出现；不把 emoji 当状态图标（跨平台不一致）。
- 选中态：选择器、filter chip 用 `bg-layer-2` + 边框；不做仅颜色变化。

---

## 11 可访问性

### 11.1 键盘

| 区域 | 键 | 行为 |
| --- | --- | --- |
| 全局 | Tab / Shift+Tab | 按 DOM 顺序：标题 → 数据源条 → 区块头 → 区块内容 → 页脚 |
| 区块头 | Enter / Space | 展开/收起 |
| NPU 卡 | Enter / Space | 展开芯片明细 |
| 选择器 | 方向键 | 原生 select 行为 |
| filter chips | 方向键 / Space | roving tabindex；`aria-pressed` |
| 对比表 | Tab | 行内可聚焦元素（展开按钮、复制） |
| 导入 sheet | Esc | 关闭并归还焦点到触发按钮 |
| 导入 sheet | Tab | 焦点陷阱，首尾循环 |
| 复制 | Enter / Space | 执行并播报 |

### 11.2 焦点

- 仅用 `:focus-visible`，使用 `--dsw-focus-ring-color` 与 `--dsw-focus-ring-width`，不自定义 outline 宽度为 0。
- sheet 打开时焦点移到标题后的第一个可操作元素；关闭后回到触发按钮。
- 刷新导致 DOM 替换时，焦点保持在刷新按钮上；不用 `autofocus` 抢焦点。
- 滚动定位（“去选择运行”）后给目标区块临时 `tabindex="-1"` 并聚焦，读屏播报区块名。

### 11.3 屏幕阅读器

- 状态消息：`role="status" aria-live="polite"`（刷新完成、导入成功、复制成功）；错误用 `role="alert"`。
- meter：`role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="4" aria-valuetext="HBM 使用率 4%，3.1 / 64.0 GiB"`。
- 对比行：视觉表 + 隐藏句 `a11y.delta`，确保读屏能听到“指标、基线、候选、变化、判定”。
- 表格：`<caption class="sr-only">运行对比：基线 …，候选 …</caption>`；排序表头用 `aria-sort`。
- 图标/颜色不作为唯一信息：badge 有文本，箭头有 tooltip 与隐藏说明。
- DEMO 横幅用 `role="note"`，进入面板时播报一次，不重复打断。

### 11.4 对比度与非颜色编码

- 正文与背景 ≥ 4.5:1；大文本/图标 ≥ 3:1；边框与相邻底色 ≥ 3:1（若 token 不满足，改用 `border-l3`）。
- 不把文本放在饱和语义色底上；badge 用浅底 + 深字，必要时加边框。
- 色觉障碍：改善/回归同时有箭头、文本、图标；图表（meter）不承载好坏判断。
- 200% 缩放与 320px 宽度下不丢内容；不出现横向滚动（对比表除外，且卡片布局优先）。
- `prefers-reduced-motion`：关闭骨架 shimmer、toast 滑入、展开动画，仅保留即时状态切换。
- 动画时长 ≤150ms；不自动轮播、不自动滚动、不自动弹 toast 以外的浮层。

---

## 12 交付组件清单与状态映射

### 12.1 组件清单

| # | 组件 | 职责 | 关键 props/状态 | 验收点 |
| --- | --- | --- | --- | --- |
| 1 | `AscendPerfPanel` | 根容器：读缓存、刷新、错误边界、三区编排 | `result`、`busy`、`demo`、`activeTab` | 各状态可渲染；不自动采集；不白屏 |
| 2 | `PanelHeader` | 标题、只读 chip、刷新、更多菜单 | `busy`、`readonly`、`onRefresh` | 刷新键盘可达；只读 tooltip |
| 3 | `SourceBar` | 来源、别名、`evidence_kind`、新鲜度、stale/demo 徽标 | `source`、`collected_at`、`stale` | 不显示 IP/路径/凭据；未验证导入可见 |
| 4 | `DemoBanner` | DEMO 常驻提示与退出 | `version`、`onExit` | 不可隐藏；导出保留 `is_demo` |
| 5 | `Section` | 可折叠区块头 | `titleKey`、`count`、`expanded`、`onToggle` | `aria-expanded`；状态记忆 |
| 6 | `DeviceSummary` | 别名/架构/卡数/芯片数/单位/总健康† | `snapshot` | 不展示 CPU/内存；总健康取最差芯片 |
| 7 | `NpuCardGrid` | 响应式卡网格 | `cards`、`columns` | 300/420/560px 断点正确 |
| 8 | `NpuCard` | 卡头、未归属进程、展开芯片 | `card`、`expanded`、`onToggle` | 卡头无功耗/温度；`card.processes` 不重复 |
| 9 | `ChipRow` | 芯片明细 | `chip` | health/health_raw、温度、功耗、HBM、AICore、NPU 利用率、`missing_reasons` |
| 10 | `Meter` | HBM/AICore 使用率 | `value`、`max`、`label`、`unit` | `role="progressbar"`；≥90% 警告 |
| 11 | `ProcessList` | 已归属/未归属进程 | `processes`、`processes_state`、`scope` | `unknown`/`none_reported` 不写成“无进程” |
| 12 | `EnvSummary` | 软件版本 | `software.npu_smi`、`software.cann` | 缺失“版本未知”；不含 runtime |
| 13 | `CollectDetails` | 采集详情、命令、来源引用、诊断 | `source`、`command_ids`、`collection`、`warnings` | 脱敏；sha256/source_ref 可复制 |
| 14 | `RunsSection` | 步骤条、槽位、runs、对比入口 | `runs`、`baselineId`、`candidateId` | 0/1/≥2 三种初始态 |
| 15 | `RunRow` | 单条运行摘要与菜单 | `run`、`role` | `evidence_kind` 徽标；设为基线/候选 |
| 16 | `ImportSheet` | 导入对话框、格式识别、提交 | `role`、`targetRunId`、`onImported` | 焦点陷阱；1 MiB；错误分类 |
| 17 | `DropZone` | 浏览器选择/拖拽文件 | `accept`、`maxBytes=1048576` | 仅文件内容；无路径输入；错误提示 |
| 18 | `ImportPreview` | 导入前预览与坏行策略 | `preview`、`skipBadRows` | 未验证徽标；skip 需显式勾选 |
| 19 | `ImportChecks` | 校验/警告列表 | `checks[]`、`warnings` | 成功/警告/失败三态；诊断展开 |
| 20 | `ComparabilityBanner` | 可比性结论与差异 | `comparability`、`issues` | `mismatch/unknown` 不显示胜负色；无强制通过 |
| 21 | `CompareSummary` | 结论、计数†、最差回归† | `summary`、`metrics` | 结论与单指标 badge 分开；计数标† |
| 22 | `CompareFilters` | verdict 筛选与排序 | `active`、`counts` | `aria-pressed`；不过滤结论区 |
| 23 | `CompareTable` | 宽屏对比表 | `metrics`、`sort`、`primary` | 指标/基线/候选/Δ/Δ%/不利/阈值/判定 |
| 24 | `CompareCards` | 窄栏指标卡 | `metrics` | 无横向滚动 |
| 25 | `VerdictBadge` | 单指标判定 | `verdict`、`threshold` | 6 值文本+图标+颜色；tooltip |
| 26 | `DeltaCell` | 绝对/相对/不利变化 | `delta_abs`、`delta_pct`、`adverse`、`reason` | 零基线/缺失可解释 |
| 27 | `InsightsSection` | 洞察列表、跳过规则、省略数 | `insights`、`skipped_rules`、`omitted_count` | 最多 20；排序不重排 |
| 28 | `InsightCard` | 单条洞察 | `insight`、`expanded` | severity/置信/证据 ref/单条建议/复制 |
| 29 | `HotspotTable` | 算子热点 | `hotspots`、`limit=10` | 空态；Top50 展开；口径标注 |
| 30 | `ExportMenu` | 导出/复制 | `compare`、`context` | 仅 compare 导出；toast 显示文件名 |
| 31 | `EmptyState` | 区块空态 | `titleKey`、`descKey`、`action` | 每区一个主操作 |
| 32 | `ErrorState` | 错误卡 | `code`、`retryable`、`actions` | 保留旧数据；store corrupt 不自动 reset |
| 33 | `Skeleton` | 加载骨架 | `blocks` | 200ms 延迟；`aria-busy` |
| 34 | `Toast` | 轻提示 | `messageKey`、`tone` | `aria-live`；2s 消失 |
| 35 | `CopyButton` | 复制与降级 | `text`、`labelKey` | 权限失败时可全选 |
| 36 | `Footer` | 只读说明与规则版本 | `rule_version` | 固定文案 |
| 37 | `ConclusionBar` | 整体结论条 | `summary.conclusion`、`message`、`comparability` | 不用单指标 badge 冒充整体结论 |

建议 `data-testid`：`ascend-perf.panel`、`panel.source`、`device.card.{card_id}`、`device.chip.{card_id}.{chip_id}`、`device.process.unknown`、`runs.row.{run_id}`、`compare.conclusion`、`compare.row.{metric_key}`、`insight.{id}`、`import.sheet`、`import.error`、`source.unverified`。

### 12.2 状态 → 组件映射

| 状态 | 顶部 | 设备区 | 运行区 | 洞察区 | 页脚 |
| --- | --- | --- | --- | --- | --- |
| 未采集 | SourceBar（无时间） | EmptyState（刷新） | 正常或空态 | 正常或空态 | 显示 |
| 读取/刷新 | Header busy + 轻骨架 | 保留旧值或 Skeleton | 正常 | 正常 | 显示 |
| 正常 | SourceBar | DeviceSummary + Grid + Env + CollectDetails | Runs + Compare | Insights | 显示 |
| `command_missing` | ErrorState（紧凑） | ErrorState + 排查 | 正常或空态 | 正常或空态 | 显示 |
| `no_device` | ErrorState | ErrorState | 正常或空态 | 正常或空态 | 显示 |
| `unreachable` | SourceBar 警告 + ErrorState | 保留旧数据（stale） | 保留 | 保留 | 显示 |
| `degraded`/partial | 警告条（可折叠） | 字段级“缺失”+原因 | 缺失 badge + 计数 | notice | 显示 |
| stale | SourceBar 琥珀 | 正常数据 + stale badge | 正常 | 正常 | 显示 |
| demo | DemoBanner + SourceBar | 演示数据 | 演示 runs | 演示洞察 | 显示（带 DEMO） |
| `STORE_CORRUPT` | 全局面板 ErrorState | 隐藏 | 隐藏 | 隐藏 | 显示 |
| 空 runs | SourceBar | 正常 | EmptyState（导入基线） | EmptyState（需对比） | 显示 |
| 空对比 | SourceBar | 正常 | 步骤条 + 选择器 + EmptyState | EmptyState | 显示 |
| 导入错误 | 不变 | 不变 | ImportSheet 内 ErrorState | 不变 | 显示 |

### 12.3 给开发的实现顺序

| 里程碑 | 内容 | 依赖 |
| --- | --- | --- |
| M0 | 面板骨架、Result 状态机、缓存优先（不自动采集）、SourceBar、DemoBanner、locale 接入 | t2 §3/§4.1 |
| M1 | 快照渲染（设备卡/芯片/软件/采集详情/processes_state）、真实 fixture 对齐 | t2 §4.3、t6 样本 |
| M2 | runs 列表、浏览器文件导入、1 MiB/三格式、reject/skip、幂等 | t2 §5 |
| M3 | 对比接入、comparability、结论与逐指标表、筛选排序、零基线/缺失 | t2 §7 |
| M4 | 洞察卡（8 规则/置信/证据）、热点、导出/复制、诊断 | t2 §8 |
| M5 | 可访问性、明暗主题走查、窄栏回归、DEMO 全流程 | M0–M4 |

### 12.4 验收自查（对照 t1 S1–S7）

| t1 标准 | 本设计对应 | 自查 |
| --- | --- | --- |
| S1 安装可发现 | §2.1 tab + guide | 待实现验证 |
| S2 5 分钟 DEMO | §4.7 + §12.3 | 演示集需覆盖改善/回归/持平/缺失/零基线，且第二芯片功耗缺失 |
| S3 差值/排序/缺值/异构可解释 | §5.8、§8.6 | 零基线、缺失、descriptive 均有文案 |
| S4 故障可恢复 | §7 | 每态有主操作与次操作；store corrupt 不自动清空 |
| S5 真实样本解析 | §4.3、§7.3 | 第二芯片功耗缺失必须显示“缺失”，不用 0/chip0 顶替 |
| S6 建议可追溯 | §6.2 | `rule_id` + `evidence.ref` + 运行标签 |
| S7 文档与实现一致 | 本文 + t2 映射 | 审查逐条核对 §8/§9 |

### 12.5 二期：自动调优（不实现、不留入口）

二期可在独立 tab “调优”中做“选择运行 → 生成调优计划 → 人工确认 → 执行 → 复测对比”。本期**不在面板放任何占位按钮、灰按钮或“敬请期待”**，避免用户误以为可执行写操作；仅在文档与规则说明中注明“当前仅提供观测与对比，不自动调优”。

---

## 13 开放问题（交给 t4 / 审查）

1. **阈值单次覆盖的 UI**：t2 允许 compare 单次覆盖 `threshold_pct`，本文 v1.1 仍不做面板编辑控件；是否在行展开里提供“本次按 X% 重算”由 t4 与审查决定，若不做则文案不得暗示可调。
2. **`op_summary` 的落点**：热点 CSV 仅生成热点，不产生可对比 run；若当前没有选中 run，是否允许先存为“待附加热点”，还是必须选 run 后导入，需要 t4 按 Host 能力定。
3. **en 文案归属**：`summary.message`、`Insight.title`、`Insight.suggestion` 是 Host 中文兜底；`rule.<rule_id>.title/suggestion` 的英文模板由谁维护（插件 locale 包还是 Host 规则库），需在 t4 前定，否则 en 界面会出现中文。
4. **卡级健康的表达**：v1 无 `card.health`，本文用芯片最差值派生并标 `†`；若后续加卡级字段，UI 改为直接显示并去掉 `†`。
5. **仓储损坏的恢复路径**：`STORE_CORRUPT` 不自动 reset；UI 只给诊断与备份提示，具体修复文档/命令是否由 t2 提供，需确认入口文案。
6. **`source.path` 的 basename 规则**：不同平台路径分隔符与同名文件如何处理；UI 只显示 Host 返回值，不再截断，避免二次泄露。

---

## 14 v1.2 增补：多环境占用视图（配置出页面 · 占用为中心）

> 本章为 t16 增补设计（2026-11-07），回应 m01516 反馈。只写设计，不改代码。v1.1 各章与本章冲突处，多环境相关一律以本章为准；对比（§5）、洞察（§6）、导入（§5.3）、DEMO（§4.7）、调优 tab 均不受影响。

### 14.0 背景与范围

用户原话（m01516，节录）：

> 你得重新看下这个页面设计呢？不展示这个采集目标呢？采集目标都是采集的具体配置，这个配置我希望你搞成一个配置文件来搞，不需要在页面上展示，然后每个配置的环境里面有一个基础信息，这个基础信息不是可用不可用，是有没有被别人占用，占用的情况是什么样的，然后可以展开看每个卡的具体信息，也可以配置这个采集的频率，你的这个ui设计逻辑就看不懂？重新派发任务设计下

翻译成四条设计目标：

1. **配置出页面**：环境列表、SSH 目标、npu-smi 路径、超时、采集频率全部交给配置文件管理；页面零编辑入口、零配置回显。
2. **占用为中心**：环境块的第一信息是占用情况（谁在占、占了多广、强度多大），连接质量（连接失败/缺工具/未采集）降级为次要角标。
3. **卡详情可展开**：逐卡逐 chip 详情保留，空闲 chip 与占用 chip 有一眼可辨的视觉区分。
4. **刷新保留**：「刷新全部」与单环境「刷新」维持现状语义，纳入状态矩阵。

范围：仅「设备与环境」区的多环境形态（配置文件里只有一个环境时同样适用本章，即"单环境=环境数 1 的多环境视图"）。本章不改变 Host 采集协议与快照字段；占用档位为 UI 派生判定（标 `†`，见 §14.3）。

### 14.1 变更总览

| # | v1.1 / 现版实现 | v1.2 设计 | 动机 |
| --- | --- | --- | --- |
| 1 | 面板顶部 `SetupSection`/`EnvEditorForm`：页内编辑环境列表（名称/模式/SSH/路径/超时/启用/删除）、采集间隔 | **整体移除**。配置全部走配置文件；页面仅保留一行只读 `ConfigBar`（文件路径 + 每 N 分钟自动采集） | 采集目标是低频运维配置，不是日常操作；现版占据首屏、喧宾夺主 |
| 2 | 环境块主视觉 = availability Pill（OK/尚未采集/连接失败/缺少 npu-smi/未检测到 NPU），等宽排布 | 主视觉 = `OccupancyPill`（空闲/部分占用/高负载 + `{occ}/{total}` chip 计数，实心、环境名后第一个徽标）；连接状态改次要角标 `ConnBadge`（描边小号） | 用户第一问题是"有没有被别人占用"，连接只是获取占用的手段 |
| 3 | `DeviceSummary`：型号/温度/功耗/AICore/HBM/进程通用摘要 | 拆为三层：`OccProcRow`（占用进程聚合，显眼位置）→ `EnvMetricSummary`（温度/功耗/AICore/HBM 摘要行）→ `ChipStrip`（每 chip 一格占用快览） | "占用的情况"= 谁（进程）+ 多广（chip 计数）+ 多强（指标） |
| 4 | `CardsBlock`/`CardBlock`/`ChipRow`：展开可用，但空闲/占用 chip 无差别 | 展开保留；chip 按占用/空闲/未知三态视觉区分；卡头补占用计数 | 展开是为了"找哪张卡能用" |
| 5 | 采集频率页内可编辑（表单字段） | 只读提示"每 N 分钟自动采集"，N 来自配置文件 | 频率属配置文件职责 |
| 6 | 刷新全部 + 单环境刷新 | 保留原位与语义，纳入 §14.6 状态矩阵 | 现版被认可的行为 |
| 7 | 环境按配置顺序渲染 | 默认排序：空闲 → 部分占用 → 高负载 → 占用未知 → 已停用；同档按名称 | 主场景是"找还有余量的机器" |

### 14.2 配置出页面（采集目标配置文件化）

**删除（页面不再出现）**：`EnvEditorForm` 与 `SetupSection` 全部——含"添加环境/删除/保存"按钮、名称/模式/SSH 目标/npu-smi 路径/超时/启用复选框、采集间隔输入框，以及旧版单机"连接方式"表单（它同样属于采集目标配置）。验收口径：页面 DOM 中不存在任何采集配置输入控件；"环境在配置文件中管理"是页面对配置的唯一表态。

**配置文件**（文件格式、路径、校验与热加载语义由开发任务确定；本章只约束 UI 消费面）：

- 文件承载：环境列表 `envs[{id, name, mode, hostAlias, npuSmiPath, timeoutMs, enabled}]` 与采集频率 `pollIntervalMs`（对应 1–60 分钟）。
- UI 只读消费：每环境 `name`（环境块的展示名，缺失时回退 `hostAlias` 再回退 `id`——回退值仅作标识，不回显其余配置字段）、`enabled`（停用呈现）、环境总数、频率换算值 N、配置文件路径一行。
- UI 不消费、不回显：hostAlias、npuSmiPath、timeoutMs 等连接细节。连接失败只呈现状态与错误码，不暴露目标串（沿用 §7.3 "不显示 IP/用户/端口"）。
- 依赖（Host，另任务）：`envs` 接口需返回配置文件路径（如 `config.path`）与频率；读取失败需有专属错误码（本文记 `CONFIG_READ_FAILED`，最终码以开发任务为准）。

**`ConfigBar`（唯一保留的配置信息，一行只读，不折叠、不可编辑）**：

```
⚙ 配置文件 ~/dsh/ascend-envs.json · 每 5 分钟自动采集 · 环境在配置文件中管理
```

- 路径过长时截中段（`~/dsh/ascend…json`），tooltip 显示全文；点击路径 = 复制全文（不打开文件、不弹选择器）。
- 频率取 Host 返回值换算分钟；未配置时显示"每 5 分钟自动采集（默认）"。
- 路径缺失（Host 未返回）时整段降级为"环境在配置文件中管理 · 每 N 分钟自动采集"，不显示空路径占位。

### 14.3 占用判定模型（UI 派生，标 `†`）

两级判定：先 chip、后环境。判定在客户端由快照字段计算，不写回 Host、不改判定/结论类指标；`OccupancyPill` 与 `ChipStrip` 的 tooltip 必须给出判定依据（信号 + 阈值）。阈值为插件级常量（可随插件配置调整，页面不提供编辑）。

**chip 级占用**——按顺序取第一个命中的信号：

| 序 | 信号 | 判定 | 说明 |
| --- | --- | --- | --- |
| 1 | `processes_state=observed` 且 `processes` 非空 | **占用** | 最强证据：进程在跑 |
| 2 | HBM 使用率 ≥ 5%（`hbm_usage_rate_pct`；缺失时用 `hbm_used_mb/hbm_total_mb` 计算†） | **占用** | 显存被持有（服务空转也占资源） |
| 3 | `aicore_pct` ≥ 5% | **占用** | 瞬时算力在用 |
| 4 | 以上未命中，且 `processes_state ∈ {none_reported, unknown}` | **未知** | 工具未报告进程，不硬判"空闲"（§7.3 原则） |
| 5 | 以上未命中（observed 且空进程、HBM<5%、AICore<5%） | **空闲** | 真 0，可下"无占用进程"结论 |

- 字段缺失（如 `power_w=null`）：缺失不参与判定、不补 0（§7.3），其余信号照常判。
- `health=critical` 的 chip：判定照常，但叠加"危险"红边与计数（见下），**不改变占用档位**——坏 chip 与忙 chip 是两个问题。

**环境级三档 + 未知**——`total` = 处于"占用或空闲"的已知 chip 数（未知 chip 不计入分母）：

| 档位 | 条件 | 主视觉 | 语义 |
| --- | --- | --- | --- |
| 空闲 | `occupied=0` 且 `total≥1` | 绿（success）实心 pill「空闲 · 0/{total}」 | 整机可用 |
| 部分占用 | `0 < occupied < ⌈0.75×total⌉` | 琥珀（warn）实心 pill「部分占用 · {occ}/{total}」 | 还有整卡级余量 |
| 高负载 | `occupied ≥ ⌈0.75×total⌉` | 红（error 色系）实心 pill「高负载 · {occ}/{total}」 | 余量不足；红=余量告急，非故障（文字消歧） |
| 占用未知 | `total=0`（全部 chip 未知 / 无 chip 数据 / 未采集 / 采集失败无旧值） | 中性灰实心 pill「占用未知」 | 无法回答占用问题 |

- `total<4` 时，"高负载"需全部 chip 被占用（`⌈0.75×total⌉=total`），避免 2 chip 占 1 就判高负载。
- 存在 `health=critical` chip 时，pill 后追加小字「{k} chip 异常」，点击展开后红边定位。

**强度预警（独立于档位，只着色与角标，不改变档位）**：温度 ≥70°C 警告 / ≥80°C 危险；AICore ≥90% 高热；HBM ≥75% 警告 / ≥90% 危险；功耗不设阈值仅展示。阈值与 v1.1 摘要及现实现一致。"空闲但温度高"等组合按各自信号独立呈现，不互相掩盖。

**`OccProcRow` 占用进程聚合**（占用块的第二行，显眼位置）：跨全部已知 chip 按 `processes[].name` 聚合，显示 `名称 ×计数（Σ 显存 GiB）`，取计数前 3，其余折叠为「+{n} 个进程」。例：`VLLMWorker_DP ×6（Σ 168.4 GiB）· mindie-service ×2（Σ 11.9 GiB）`。三种子文案：无进程且空闲=「无占用进程」；无可见进程但档位非空闲=「进程信息不可用（按指标判定占用）」；全部未知=「进程信息不可用」。

### 14.4 组件树（v1.2）

```
EnvsSection
├─ SectionHeader（多环境占用 ｜ 刷新全部 ｜ busy）
├─ ConfigBar（只读一行：配置文件路径 · 每 N 分钟自动采集 · “配置文件管理”提示）
├─ EnvBlock ×N
│   ├─ EnvHead
│   │   ├─ EnvName（环境名 · 粗体；不回显 SSH/路径/超时）
│   │   ├─ OccupancyPill（档位 + {occ}/{total}；主视觉，实心，第一个徽标）
│   │   ├─ ChipAbnormalNote（“{k} chip 异常”，仅有异常时，小字）
│   │   ├─ Meta（采集于 {time} · 弱色小字）
│   │   ├─ ConnBadge（次要角标 · 描边小号，可多个：连接失败/缺少 npu-smi/
│   │   │            未检测到 NPU/未采集/数据过期/进程信息不可用/已停用）
│   │   └─ EnvRefresh（单环境“刷新”）
│   ├─ OccProcRow（占用进程聚合 · 第二行显眼位置；空/未知有专文案）
│   ├─ EnvMetricSummary（型号×卡数/chip 数 · 温度区间 · 总功耗 · AICore 区间 ·
│   │                   HBM Σused/Σtotal（占比）；临界值着色）
│   ├─ ChipStrip（每 chip 一格：占用=琥珀实心 / 空闲=绿描边 / 未知=灰虚线；
│   │            强度临界叠红点；title=判定依据；点击=展开卡详情并聚焦该 chip）
│   └─ CardsBlock（[展开 {n} 卡详情 / 收起]，aria-expanded）
│       └─ CardBlock ×N
│           ├─ CardHead（NPU {id} · 型号 · 卡功耗 · {occ}/{n} chip 占用）
│           └─ ChipRow ×N
│               ├─ ChipHead（chip {id}·Phy{phy} ｜ 占用/空闲/未知徽标 ｜ health）
│               ├─ ChipMetrics（温度 / 功耗 / AICore / NPU 利用率 / HBM 用量+占比†，2×3）
│               └─ ChipProcs（进程行：pid name memory_mb；空/未知按 §7.3 文案）
│           └─ 软件行（CANN x.y · npu-smi x.y，弱色小字，展开区尾部）
├─ EnvsEmptyState（envs=0：指引配置文件 + [刷新全部] + [加载演示数据]）
└─ WarningsFoot（环境级 warnings ≤4 条，code: message 折叠展示）
```

- **删除**：`EnvEditorForm`、`SetupSection`（多环境表单与旧单机表单一并下线）。
- **新增**：`ConfigBar`、`OccupancyPill`、`ConnBadge`、`OccProcRow`、`ChipStrip`、`EnvsEmptyState`。
- **改造**：`EnvsSection`（+ConfigBar/排序/空态）、`EnvBlock`（信息重排为占用优先）、`DeviceSummary` → `EnvMetricSummary`（沿用聚合逻辑，加占用计数，型号行保留）、`CardBlock`（卡头 + 占用计数）、`ChipRow`（+占用三态徽标、+NPU 利用率与 HBM 占比、+进程显存、空闲态弱化）、`CardsBlock`（展开文案不变，+聚焦目标 chip）。
- **复用不动**：`Section`、`Pill`、`StateMsg`、i18n 插值、`action.loadDemo`、`state.demoDesc`、错误码展示规则（§7.4）。
- 排序：空闲 → 部分占用 → 高负载 → 占用未知 → 已停用；同档按环境名字典序。不做排序切换控件（记入 §14.11 开放问题）。

### 14.5 线框

#### 14.5.1 标准宽度（420–559px）：三个环境（部分占用已展开 / 高负载 / 空闲）

```
┌──────────────────────────────────────────────────┐
│ 昇腾性能  [只读]                       [刷新] [⋯] │
├──────────────────────────────────────────────────┤
│ ▾ 多环境占用                          [刷新全部] │
│   ⚙ 配置文件 ~/dsh/ascend-envs.json · 每 5 分钟  │
│     自动采集 · 环境在配置文件中管理               │
│ ┌────────────────────────────────────────────┐   │
│ │ 训练机-A  ▐部分占用 6/8▌         采集于 16:02│   │
│ │ 占用进程  VLLMWorker_DP ×6(Σ168.4GiB)       │   │
│ │          · mindie-service ×2(Σ11.9GiB)     │   │
│ │ Ascend910B×4卡/8chip · 温度42–61°C         │   │
│ │ 功耗≈1214W · AICore 3–92% · HBM 412/640GiB │   │
│ │ (64%)                                       │   │
│ │ chip ■■■■■■□□  （title: 逐格判定依据）      │   │
│ │ [▾ 展开 4 卡详情]                           │   │
│ │ ┌ NPU 0 · Ascend910B · 388W · 2/2 占用 ───┐│   │
│ │ │ chip 0 ▐占用▌ 61°C 192W AICore 92%⚠     ││   │
│ │ │   NPU util 88% · HBM 58.2/64.0GiB(91%)⚠ ││   │
│ │ │   3127 VLLMWorker_DP 58.4GiB            ││   │
│ │ │ chip 1 ▐占用▌ 58°C 196W AICore 89%      ││   │
│ │ │   …（同上）                              ││   │
│ │ └──────────────────────────────────────────┘│   │
│ │ ┌ NPU 1 · Ascend910B · 12W · 0/2 占用 ────┐│   │
│ │ │ chip 2 ▏空闲▎ 39°C 6W AICore 0%（弱化）  ││   │
│ │ │   NPU util 0% · HBM 0.4/64.0GiB(1%)     ││   │
│ │ │   无占用进程                             ││   │
│ │ │ chip 3 ▏空闲▎ …                          ││   │
│ │ └──────────────────────────────────────────┘│   │
│ │ CANN 8.1.RC2 · npu-smi 26.1.1               │   │
│ └────────────────────────────────────────────┘   │
│ ┌────────────────────────────────────────────┐   │
│ │ 训练机-B  ▐高负载 16/16▌ 2 chip 异常 16:02 │   │
│ │ 占用进程  VLLMWorker_DP ×16(Σ451.0GiB)      │   │
│ │ Ascend910B×8卡/16chip · 温度52–78°C⚠       │   │
│ │ 功耗≈3120W · AICore 55–97% · HBM 601/1024G │   │
│ │ (59%)                                       │   │
│ │ chip ■■■■■■■■■■■■■■■■（2 格叠红点）        │   │
│ │ [▸ 展开 8 卡详情]                           │   │
│ └────────────────────────────────────────────┘   │
│ ┌────────────────────────────────────────────┐   │
│ │ 训练机-C  ▐空闲 0/8▌ [进程信息不可用] 16:03 │   │
│ │ 占用进程  无占用进程                         │   │
│ │ …（摘要行同上结构）                          │   │
│ │ chip ▢▢▢▢▢▢▢▢（全部绿描边）               │   │
│ │ [▸ 展开 4 卡详情]                           │   │
│ └────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────┤
│ （运行与对比 / 洞察区不变，见 §3.1）             │
└──────────────────────────────────────────────────┘
```

读法：环境名后第一个徽标就是占用档（实心）；连接信息不在主行——正常时无角标，异常时才出现描边小角标（见 14.5.2）。「■」琥珀=占用、「□」绿描边=空闲、「▨」灰虚线=未知，右上红点=强度临界。

#### 14.5.2 失败态 / 未知态（同一列表中的降级块）

```
│ ┌────────────────────────────────────────────┐   │
│ │ 训练机-D  ▐占用未知▌          [未采集] [刷新]│   │
│ │ 首次采集进行中，或点击“刷新”立即采集。      │   │
│ └────────────────────────────────────────────┘   │
│ ┌────────────────────────────────────────────┐   │
│ │ 训练机-E  ▐部分占用 6/8▌·旧数据  采集于 09:41│   │
│ │                              [连接失败][刷新]│   │
│ │ （以下为上次成功快照，摘要行右上标“数据过期”）│   │
│ │ 占用进程 / 摘要行 / chip 条 / 展开 —— 照常   │   │
│ └────────────────────────────────────────────┘   │
│ ┌────────────────────────────────────────────┐   │
│ │ 训练机-F  ▐占用未知▌      [缺少 npu-smi][刷新]│ │
│ │ 远端未找到 npu-smi：需安装驱动工具包或在配置 │   │
│ │ 文件中修正路径。错误码 COMMAND_NOT_FOUND     │   │
│ └────────────────────────────────────────────┘   │
│ ┌────────────────────────────────────────────┐   │
│ │ 训练机-G  ▐已停用▌                 [刷新]   │   │
│ │ 停用仅停止自动采集，仍可手动刷新。           │   │
│ └────────────────────────────────────────────┘   │
```

#### 14.5.3 空态与配置失败（环境列表级）

```
│ ▾ 多环境占用                          [刷新全部] │
│   ⚙ 配置文件 ~/dsh/ascend-envs.json · 每 5 分钟  │
│     自动采集 · 环境在配置文件中管理               │
│ ┌────────────────────────────────────────────┐   │
│ │ 尚未配置环境                                │   │
│ │ 环境列表与采集频率由配置文件管理：在上述文件 │   │
│ │ 中添加环境后，点击“刷新全部”重新加载。      │   │
│ │ [加载演示数据]                              │   │
│ └────────────────────────────────────────────┘   │

配置读取失败（面板级，替换整个环境区）：
│ ┌────────────────────────────────────────────┐   │
│ │ ⚠ 配置读取失败                              │   │
│ │ 无法读取环境配置文件，占用视图暂不可用。     │   │
│ │ CONFIG_READ_FAILED: <Host message>          │   │
│ │ [刷新全部]  [复制诊断]                       │   │
│ └────────────────────────────────────────────┘   │
```

#### 14.5.4 窄栏（300–419px）

```
│ ┌──────────────────────────────┐ │
│ │ 训练机-A  ▐部分占用 6/8▌     │ │
│ │ 采集于 16:02 [连接失败] [↻]  │ │
│ │ 占用 VLLMWorker_DP ×6        │ │
│ │           +4 个进程          │ │
│ │ 温度 42–61°C   功耗 ≈1214W  │ │
│ │ AICore 3–92%   HBM 64%      │ │
│ │ chip ■■■■■■□□               │ │
│ │ [▸ 展开 4 卡详情]            │ │
│ └──────────────────────────────┘ │
```

（EnvHead 换行为两行：名+档 pill 一行，时间+角标+图标刷新一行；摘要行降为 2×2；进程聚合只留 Top1 + 计数；ChipStrip 16 格内单行，>16 格换两行。）

### 14.6 状态矩阵（占用 × 连接 交叉）

交叉表：行=连接/采集状态（availability 及采集过程），列=占用档（来自当前或上次成功快照）。格中编号对应下方明细。

| 连接＼占用档 | 空闲 | 部分占用 | 高负载 | 未知/无档 |
| --- | --- | --- | --- | --- |
| 正常已采集 | ① | ② | ③ | ④ |
| 采集中（有旧值） | ⑤ | ⑤ | ⑤ | ⑤ |
| 采集中（无旧值） | — | — | — | ⑥ |
| 未采集（首次） | — | — | — | ⑦ |
| 连接失败（有旧快照） | ⑧ | ⑧ | ⑧ | ⑨ |
| 连接失败（无快照） | — | — | — | ⑨ |
| 缺少 npu-smi | ⑩ | ⑩ | ⑩ | ⑪ |
| 未检测到 NPU | — | — | — | ⑫ |
| 已停用 | ⑬ | ⑬ | ⑬ | ⑭ |
| 配置读取失败 | ⑮（面板级） | ← | ← | ← |
| 环境列表为空 | ⑯（空态） | ← | ← | ← |

"—"= 不可达组合（无快照则不可能有档；无设备则无 chip 数据）。

| 编号 | 呈现（主视觉 / 角标 / 内容） | 主操作 | 次操作 | 关键文案（key） |
| --- | --- | --- | --- | --- |
| ① | 绿 pill「空闲 · 0/{total}」；无角标；OccProcRow=无占用进程；摘要/ChipStrip 全绿描边 | 刷新 | 展开卡详情 | `envs.tier.idle` `envs.procsNone` |
| ② | 琥珀 pill「部分占用 · {occ}/{total}」；无角标；占用进程行 + 摘要 + 双色 ChipStrip | 刷新 | 展开卡详情 | `envs.tier.partial` `envs.procsLabel` |
| ③ | 红 pill「高负载 · {occ}/{total}」（红=余量告急非故障）；临界叠红点 | 刷新 | 展开卡详情 | `envs.tier.busy` |
| ④ | 灰 pill「占用未知」；角标「进程信息不可用」；摘要照常，ChipStrip 全灰虚线；不下空闲结论 | 刷新 | 展开卡详情 | `envs.tier.unknown` `envs.procsUnavailable` |
| ⑤ | 旧档照常 + 摘要处 inline「正在采集…」+ 刷新按钮 loading；**不清空旧值** | 等待/刷新 | 展开卡详情 | `envs.conn.collecting` |
| ⑥ | 轻骨架（两行）+ 刷新按钮 loading；无旧值不显示档位 | 等待 | — | `state.loading.title` |
| ⑦ | 灰 pill「占用未知」+ 角标「未采集」；说明一行 | 刷新 | — | `envs.conn.pending` `envs.firstCollect` |
| ⑧ | **旧档 pill 照常**（用户先看到上次占用）+ 角标「连接失败」「数据过期」+ 采集时间为旧值；错误详情折叠在块尾 | 刷新 | 展开卡详情 / 查看诊断 | `envs.conn.unreachable` `envs.conn.stale` `envs.staleHint` |
| ⑨ | 灰 pill「占用未知」+ 角标「连接失败」+ 错误码与一句话出路（v1.1 §4.6 子码复用） | 刷新 | 查看诊断 | `envs.conn.unreachable` `error.<code>` |
| ⑩ | 同 ⑧ 呈现，角标换「缺少 npu-smi」 | 刷新 | 排查步骤 | `envs.conn.commandMissing` |
| ⑪ | 灰 pill + 角标「缺少 npu-smi」+ 排查清单（复用 §4.4） | 刷新 | 加载演示数据 | 同上 |
| ⑫ | 灰 pill「占用未知」+ 角标「未检测到 NPU」+ 三条可能原因（复用 §4.5） | 刷新 | 查看诊断 | `envs.conn.noDevice` |
| ⑬ | 灰 pill「已停用」（替换档位）+ 整块 60% 透明 + 说明行；有旧值时摘要弱化保留 | 刷新（手动单次采集） | 展开卡详情 | `envs.tier.disabled` `envs.disabledHint` |
| ⑭ | 同 ⑬，无摘要无 ChipStrip | 刷新 | — | 同上 |
| ⑮ | 面板级错误卡替换整个环境区；运行/洞察区不受影响；不回显配置内容 | 刷新全部 | 复制诊断 | `envs.configError.title` `error.<code>` |
| ⑯ | 空态卡：指引配置文件路径 + 示例 + 刷新全部 | 刷新全部 | 加载演示数据 | `envs.empty.title` `envs.empty.desc` |

补充规则：

- **stale 判定**：`collected_at` 距今 > 2×采集间隔（或上次采集失败）→ 叠加「数据过期」角标，内容照常可读（v1.1 §4.8 原则）。
- **展开状态**：卡详情展开/收起为每环境独立记忆（会话内）；刷新后保持展开态，不强制折叠。
- **刷新语义**：「刷新全部」逐环境并发采集（busy 禁用按钮，各块独立 ⑤/⑥ 态）；单环境「刷新」只影响该块。已停用环境的手动刷新=显式动作，允许触发一次采集。
- **warnings**：环境级 `warnings[]` 折叠在块尾（≤4 条，code: message），不占据主视觉。
- **全部环境均未成功采集**（首次或全失败）时，列表尾部保留「加载演示数据」+ `state.demoDesc`（沿用现版行为）。

### 14.7 文案与 locale（zh/en）

命名沿用 `envs.*` 命名空间（§9.1 规范）。删除键（编辑类，随组件一并下线）：`envs.editorTitle/add/name/mode/host/path/timeoutMs/enabled/remove/pollEvery/needOne/hint`、`setup.*` 全部连接表单键。

| key | zh | en |
| --- | --- | --- |
| `envs.title` | 多环境占用 | Occupancy |
| `envs.configFile` | 配置文件 {path} | Config file {path} |
| `envs.configManaged` | 环境在配置文件中管理，页面只读 | Environments live in the config file; this page is read-only |
| `envs.autoEvery` | 每 {n} 分钟自动采集 | Auto-collect every {n} min |
| `envs.autoEveryDefault` | 每 {n} 分钟自动采集（默认） | Auto-collect every {n} min (default) |
| `envs.tier.idle` | 空闲 | Idle |
| `envs.tier.partial` | 部分占用 | Partially occupied |
| `envs.tier.busy` | 高负载 | Busy |
| `envs.tier.unknown` | 占用未知 | Occupancy unknown |
| `envs.tier.disabled` | 已停用 | Disabled |
| `envs.tier.count` | {occ}/{total} chip 被占用 | {occ}/{total} chips occupied |
| `envs.chipAbnormal` | {n} chip 异常 | {n} chips unhealthy |
| `envs.procsLabel` | 占用进程 | Processes |
| `envs.procsNone` | 无占用进程 | No occupying processes |
| `envs.procsUnavailable` | 进程信息不可用（按指标判定占用） | Process info unavailable (occupancy judged by metrics) |
| `envs.procsMore` | +{n} 个进程 | +{n} more |
| `envs.chip.idle` | 空闲 | idle |
| `envs.chip.occupied` | 占用 | occupied |
| `envs.chip.unknown` | 未知 | unknown |
| `envs.expandCards` | 展开 {n} 卡详情 | Show {n} cards |
| `envs.collapseCards` | 收起卡详情 | Hide cards |
| `envs.conn.unreachable` | 连接失败 | Connection failed |
| `envs.conn.commandMissing` | 缺少 npu-smi | npu-smi missing |
| `envs.conn.noDevice` | 未检测到 NPU | No NPU found |
| `envs.conn.pending` | 未采集 | Not collected |
| `envs.conn.stale` | 数据过期 | Stale data |
| `envs.conn.collecting` | 正在采集… | Collecting… |
| `envs.firstCollect` | 首次采集进行中，或点击“刷新”立即采集。 | First collection in progress, or press "Refresh". |
| `envs.staleHint` | 展示上次成功采集（{time}） | Showing last successful collection ({time}) |
| `envs.disabledHint` | 停用仅停止自动采集，仍可手动刷新。 | Disabled stops auto-collect only; manual refresh still works. |
| `envs.empty.title` | 尚未配置环境 | No environments configured |
| `envs.empty.desc` | 环境列表与采集频率由配置文件管理：在配置文件中添加环境后，点击“刷新全部”重新加载。 | Environments and the collect interval live in the config file: add environments there, then press "Refresh all". |
| `envs.configError.title` | 配置读取失败 | Failed to load config |
| `envs.configError.desc` | 无法读取环境配置文件，占用视图暂不可用。 | Cannot read the environment config file; the occupancy view is unavailable. |
| `envs.tooltip.occWhy` | 判定依据：{signals} | Based on: {signals} |
| `envs.tooltip.occChip` | chip {id}：{state}，HBM {hbm}%，AICore {aicore}% | chip {id}: {state}, HBM {hbm}%, AICore {aicore}% |

复用不改：`envs.refreshAll`（刷新全部）、`envs.refresh`（刷新）、`envs.updatedAt`（采集于 {time}）、`action.loadDemo`、`state.demoDesc`、`state.missing`、`state.loading.title`、`warning.*`/`error.*`（§7.4）。数值与单位格式沿用 §9.3（GiB/°C/W/%、区间 `a–b`、缺失不补 0）。

### 14.8 窄栏与降级细则（300–419px）

| 元素 | 标准宽（≥420px） | 窄栏（<420px） |
| --- | --- | --- |
| EnvHead | 单行（名+pill+时间+角标+刷新按钮），放不下自然换行 | 固定两行：①名+档 pill；②时间+角标+图标化刷新（28×28 触控） |
| OccProcRow | Top3 进程 + Σ显存 | Top1 + 「+{n} 个进程」；Σ显存进 tooltip |
| EnvMetricSummary | 单行五段（型号卡数/温度/功耗/AICore/HBM） | 2×2 网格（温度/功耗/AICore/HBM），型号卡数行降为小字标题 |
| ChipStrip | 格 16px、间距 3px；≤16 格单行 | 格 14px、间距 2px；>16 格换两行（每行 ≤16） |
| CardsBlock/ChipRow | 卡块全宽；chip 指标 2×3 | 不变（本就 2 列）；卡头型号截断进 tooltip |
| 横向滚动 | 禁止 | 禁止 |
| 展开按钮 | 常规按钮 | 全宽按钮 |

降级链完整覆盖：配置路径缺失 → ConfigBar 降级文案（§14.2）；字段缺失 → 摘要对应段显示"缺失"（§7.3）；全部 chip 未知 → 档位"占用未知"（④）；无环境 → 空态卡（⑯）；配置读取失败 → 面板级错误卡（⑮）。任何降级不白屏、不误报 0。

### 14.9 可访问性补充

- `OccupancyPill` aria-label 为完整判定句：`"{环境名}：{档位}，{occ}/{total} 个 chip 被占用"`；档位颜色之外必有文字（§11.4）。
- `ChipStrip` 为 `role="list"`，每格 `role="listitem"` + `aria-label`（如 "chip 3：占用，HBM 82%，AICore 91%"）；三态用形状编码（实心/描边/虚线），不只靠颜色。
- 读屏顺序 = 视觉顺序：环境名 → 档位 → 异常计数 → 时间 → 连接角标 → 占用进程 → 摘要 → chip 条 → 展开。
- 键盘：Tab 序 = EnvRefresh → ChipStrip（格可聚焦，方向键移动）→ 展开按钮；Enter/Space 触发展开与聚焦；焦点环用 `--dsw-focus-ring-*`。
- 红色仅用于高负载档与强度临界，且均带文字（"高负载"/⚠+数值），色弱用户可依文字与形状完成全部判断。

### 14.10 实现改造清单（给开发，仅指引不改码）

| 组件 | 动作 | 要点 |
| --- | --- | --- |
| `EnvEditorForm` | 删除 | 连同其 locale 编辑类键 |
| `SetupSection` | 删除 | Panel 不再挂任何配置表单（含旧单机表单分支） |
| `EnvsSection` | 改造 | +ConfigBar、档位排序、`EnvsEmptyState`、⑮ 面板级错误态；保留刷新全部/warnings/演示入口 |
| `EnvBlock` | 重排 | EnvHead（OccupancyPill 优先、ConnBadge 角标化）→ OccProcRow → EnvMetricSummary → ChipStrip → CardsBlock；⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭ 分支渲染 |
| `DeviceSummary` → `EnvMetricSummary` | 改造 | 沿用 `aggChips` 聚合；+占用/未知计数；阈值着色沿用现状（70/80°C、90% AICore、75/90% HBM） |
| `CardsBlock` | 微调 | 展开文案 `envs.expandCards`；支持聚焦目标 chip（ChipStrip 点击联动）；尾部软件行 |
| `CardBlock` | 增强 | 卡头 + `{occ}/{n} chip 占用`；型号截断规则 |
| `ChipRow` | 增强 | 占用三态徽标（空闲弱化样式）；指标 2×3（+NPU 利用率、HBM 占比†）；进程行 + memory_mb |
| 新增 | — | `ConfigBar` / `OccupancyPill` / `ConnBadge` / `OccProcRow` / `ChipStrip` / `EnvsEmptyState` |
| locale | 增删 | 增 §14.7 新键；删编辑类键与 `setup.*` 表单键 |
| Host（另任务） | 依赖 | 配置文件加载/校验/错误码（⑮）；`envs` 接口返回配置路径与频率；`collected_at` 支撑 stale 判定 |

`data-testid` 建议：`envs.configbar`、`envs.empty`、`envs.block.{id}`、`envs.block.{id}.pill`、`envs.block.{id}.procs`、`envs.block.{id}.strip`、`envs.block.{id}.chip.{card_id}.{chip_id}`、`envs.block.{id}.refresh`。

### 14.11 开放问题（交开发任务 / 审查）

1. 配置文件路径、格式、校验规则与热加载语义（ConfigBar 只显示 Host 返回值）。
2. `CONFIG_READ_FAILED` 的最终错误码与恢复指引文案归属。
3. 环境排序是否二期提供切换（按名称/按占用/配置文件原序）。
4. chip 占用阈值（5%）与环境高负载线（75%）是否提升为插件可见配置。
5. stale 判定阈值取 2×采集间隔还是固定时长；长时间停用环境的旧数据是否设最长保留。
6. >16 chip 环境的 ChipStrip 两行呈现的实测可读性走查（32 chip 双机 910B 场景）。

### 14.12 增补决策记录

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 配置编辑去留 | 页面零编辑入口，配置文件为唯一事实源 | m01516；配置低频变更，页面高频看状态，二者不该混在一屏 |
| 主视觉 | 占用档 pill + `{occ}/{total}` chip 计数 | 用户第一问"有没有被占用"；计数比百分比直观且可复算 |
| 连接状态 | 降级为描边角标，正常态不显示 | 获取占用的手段不是目的；失败仍可见、可操作（刷新/诊断） |
| 档位判定 | chip 占用广度为主（75% 线），强度预警独立 | 广度回答"还有多少余量"，强度回答"要不要紧"，两问分开；进程数波动不影响档位稳定性 |
| chip 占用信号序 | 进程 → HBM(≥5%) → AICore(≥5%) | 进程最确定；HBM 表示持有（服务空转也算占用）；AICore 瞬时性最强放最后 |
| 进程不可见 | 不判空闲：按指标判占用或"占用未知" | 沿用 §7.3 不强下结论原则，防止误导"这台没人用" |
| 高负载用红色 | 红=余量告急，非故障，配文字"高负载" | 对找资源的用户，满载≈不可用；文字消歧避免与错误态混淆 |
| 排序 | 空闲优先，已停用沉底，无切换控件 | 主场景"找还有余量的机器"；控件最小化 |
| 已停用环境 | 保留手动刷新，整块弱化 | 与 Host 现行为一致（停用只停自动采集）；显式动作仍属只读采集 |
| 旧快照 | 连接失败时保留旧档展示 + 过期角标 | 占用信息有滞后价值，清空比陈旧更误导（v1.1 §3.4 原则） |
| EnvMetricSummary 更名 | `DeviceSummary` → `EnvMetricSummary` | 语义从"设备健康"转向"占用强度"；聚合逻辑复用降低实现成本 |

### 14.13 视觉规范（sirlab 参考，t16 后置补充）

> 本节为 t16 完成后的 append-only 补充（2026-11-07）：用户追加视觉参考 `https://sirlab.tech/usage`（SIR · 开发环境调度台，昇腾 910B 集群占用面板），要求信息卡片按其风格美化。本节只定义 §14 组件的"皮肤"（色板、卡片、圆点、字体、徽标规格），**不改变 §14.2–§14.10 的信息架构、状态语义与交互**；落地任务为 t17。参考实现留档 `/tmp/sirlab-usage.html`（395 KB，本节色值与该文件核对一致）。

#### 14.13.1 与 §10.1 token 策略的关系

下述 hex 是**目标观感的规范值**，不是让组件散写 hex（§10.1"不硬编码"原则继续有效）：实现时优先映射到语义相近的 `--dsw-alias-*` token；dsw 无对应语义处，以插件作用域 CSS 变量（`--ascend-perf-*`，本文即其规范定义）单点承载，深浅主题整组切换。与 §10/§11 冲突时：色值以本节为准，可访问性规则（形状+文字双编码、对比度、reduced-motion）**不变**——红/绿仍然必须带文字档名，不允许"只靠颜色读档位"。

#### 14.13.2 浅色调色板（默认主题）

| 用途 | 变量（建议） | 值 | 对应 §14 组件 |
| --- | --- | --- | --- |
| 页面/区块底 | `--ascend-perf-bg` | `#F4F7FB` | EnvsSection 区底 |
| 卡片底 | `--ascend-perf-panel` | `#FFFFFF` | EnvBlock、CardBlock |
| 嵌套底 / 行 hover | `--ascend-perf-panel-2` | `#E7EDF5` | OccProcRow 行 hover、ConfigBar 底 |
| 边框（主，卡片描边） | `--ascend-perf-border` | `#D5DEE9` | 卡片外框、展开区 |
| 边框（弱，行分隔） | `--ascend-perf-border-weak` | `#E3E9F1` | 进程行分隔、ChipStrip 格描边 |
| 文字主 | `--ascend-perf-text-1` | `#16202E` | 环境名、数值 |
| 文字次 | `--ascend-perf-text-2` | `#475569` | 标签、说明 |
| 文字弱 | `--ascend-perf-text-3` | `#6B7A8C` | 时间、"未知"档、占位 |

#### 14.13.3 语义色（占用档位映射）

| 语义 | 变量（建议） | 值 | 使用位置（对照 §14.3/§14.4） |
| --- | --- | --- | --- |
| 空闲/可用 | `--ascend-perf-ok` | `#059669` | 空闲 pill、ChipStrip 空闲格、状态圆点 |
| 占用/部分占用 | `--ascend-perf-warn` | `#D97706` | 部分占用 pill、占用 chip 格、占用圆点 |
| 告警/高负载/临界 | `--ascend-perf-danger` | `#DC2626` | 高负载 pill、强度临界红点/红边、"chip 异常" |
| 强调/聚焦/链接 | `--ascend-perf-accent` | `#0284C7` | 展开按钮 hover、ChipStrip 点击聚焦框、路径链接 |
| 占用未知（中性） | `--ascend-perf-neutral` | `#94A3B8` | "占用未知" pill、未知 chip 格（灰虚线） |

档位三态与 §14.3 完全对应：空闲=绿 `#059669`、部分占用=琥珀 `#D97706`、高负载=`#DC2626`、未知=中性 `#94A3B8`。底色一律用对应色 8–12% 透明派生（同 §10.1 约束），文字仍用 `text-1` 保证对比度。

#### 14.13.4 卡片与可折叠卡头

- 卡片：`#FFFFFF` 底、`12px` 圆角、`1px #E3E9F1` 细边框（EnvBlock）；内层 NPU 卡（CardBlock）同构降级为 `8px` 圆角、`#D5DEE9` 边框，形成"卡中卡"层级。无重阴影（§10.2 不变）。
- 可折叠卡头（EnvBlock 与 CardBlock 同构）：`▸/▾` caret（12px 线性图标）+ 名称（13px/600）+ 右浮 tag 徽标组；点击整行折叠/展开，行高 ≥28px；`aria-expanded` 沿用 §12.1-5。EnvBlock 折叠态收起 OccProcRow/摘要/ChipStrip，仅留卡头（名 + 档位 tag + 时间 + 角标）；ChipStrip 属于"展开摘要"层，随折叠收起。

#### 14.13.5 状态圆点

- 规格：`8px` 直径圆点 + 外圈 1.5px 白描边（深色主题为 `#161b22` 描边），置于档位 pill 内最左、卡头 tag 前、ConfigBar 提示行首。
- 颜色同 §14.13.3 语义色；"正在采集"**不用**闪烁/呼吸动画（§11 reduced-motion），用文字「正在采集…」（状态⑤⑥ 不变）。

#### 14.13.6 占用进程：表格式行（OccProcRow 升级）

- 每个聚合进程一行，三列：`进程名`（左对齐，`text-1`）｜`×计数`（mono）｜`Σ显存 GiB`（mono + `tabular-nums`，右对齐）。
- 行规格：高 28px、分隔线 `#E3E9F1`、行 hover 底 `#E7EDF5`；数字右对齐、等宽字体（`--dsw-font-family-code` 或 `ui-monospace`）+ `tabular-nums`，同列可逐位对比。
- 默认 Top3 + 「+{n} 个进程」折叠行（§14.3 不变）；空/未知文案沿用 `envs.procsNone` / `envs.procsUnavailable`。

#### 14.13.7 chip 格与数字排版

- ChipStrip 格：16px（窄栏 14px）、3px 圆角、间距 2–3px；占用=琥珀实心、空闲=绿描边空心、未知=灰虚线（§14.4 不变，色值替换为本节语义色）。
- ChipRow 指标（2×3）：标签 `text-2` 左对齐、数值 mono + `tabular-nums` 右对齐（温度/功耗/AICore/NPU 利用率/HBM 用量+占比†）。临界仍用 ⚠+数值（§14.3），不整格变红。

#### 14.13.8 tag 徽标（ConnBadge / 档位 tag）

- 规格：字号 `10.5px`、内边距 `2px 6px`、圆角 `4px`、`1px` 描边 + 对应语义色 8–12% 透明底；文本色取语义色或 `text-1`，以对比度优先。
- ConnBadge 即此规格（描边小号角标语义不变，§14.4）；档位 tag 加粗一档（11px/600）+ 前置状态圆点。

#### 14.13.9 深色主题变量（可选开关，随主题切换）

| 用途 | 变量 | 值 |
| --- | --- | --- |
| 页面底 | `--ascend-perf-bg` | `#0d1117` |
| 卡片底 | `--ascend-perf-panel` | `#161b22` |
| 强调/聚焦 | `--ascend-perf-accent` | `#58a6ff` |
| 边框（主） | `--ascend-perf-border` | `#30363d`（参考实现内现值） |

其余语义色与文字灰阶在深色主题下沿用 dsw 深色 `--dsw-alias-*` label/border token 派生，不逐条新造；三态语义色仅做亮度适配（`#3fb950`/`#d29922`/`#f85149` 可作深色候选，落地以对比度走查为准）。深色为本节**可选**项，浅色为默认。

#### 14.13.10 落地与走查点（给 t17）

1. 全部色值经 `--ascend-perf-*` 变量单点定义，组件不出现字面 hex；深浅主题整组切换无遗漏（含 hover、描边、透明底）。
2. 档位仍可仅凭文字+形状判读（摘掉颜色走查一遍 ①–⑯ 状态）。
3. mono 数字列逐位对齐抽查（进程 Σ显存、chip 指标、HBM 占比）。
4. 折叠卡头键盘可达：Tab 聚焦、Enter/Space 展开、`aria-expanded` 正确。
5. 10.5px 徽标在 200% 缩放下可读；不满足则升 11px 并记录。

---

## 15 v1.3 增补：服务部署分段（服务列表 + 部署向导 + 日志尾部）

> 本章为 t22 增补设计（2026-11-07），依据 [deploy-design.md](./deploy-design.md) §10 的信息架构输入定稿部署功能的完整 UI/UX。只写设计，不改代码。token 与组件风格沿用 §14/§14.13；危险确认、日志抽屉、状态色、键盘与可访问性规范沿用 [tuning-ui-design.md](./tuning-ui-design.md) §9/§5.6/§11（冲突处部署分段以本章为准，调优流程章节不受影响）。章节落在本文件（ui-design.md）而非 tuning-ui-design.md，是为了让部署 UI 的组件树、状态矩阵与文案和观测视图（§14）同一处对照维护；两文档通过本章交叉引用保持一致（决策记录 15.15-D1）。

> **IA v1.4 变更附注（t24，2026-11-07）**：用户定稿将原「昇腾性能调优」「性能调优」两个侧栏 tab 合并为**单一 tab「昇腾性能调优」**，tab 内顶部以三分段 segmented control 切换：①**环境信息**＝§14 多环境占用视图原样；②**服务部署**＝本章 P2a 范围（服务列表 + 空态引导 + demo 永驻 + dry-run 预览向导，无执行按钮）；③**性能调优**＝原主 tab 的运行与对比/导入运行/洞察/导出 + 调优作业（TuneJobs）合并，内部以小节标题区分（调优作业 / 运行与对比 / 洞察）。分段选择只保存在进程内 state（刷新回默认「环境信息」，不做 localStorage 持久化）；原 `ascend-perf-tune` tab 注册与 guide entry 下线；标题、chip-A 图标与 auto-open 行为沿用。本章 15.1 描述的「tab 标题栏正下方二级分段」据此升级为「单 tab 顶部三分段」，其余小节的分段内部布局、状态矩阵与文案不受影响。

> **服务部署 v2 重做附注（t30，2026-11-08）**：用户 m02366 定稿重做服务部署段——服务资产概念整体下线（无 services.json / 无服务列表 / 无 dry-run 预览 / 无演示服务），部署目标改为**从 envs 配置的启用环境中选择**；核心场景是「验证某分支/代码基线相对基线的差异」：填写候选分支+commit、基线分支+commit、模型与启动参数 → 生成**可编辑部署计划**（10 步模板，每步 title/detail/command + candidate/baseline/both 标注）→ 编辑（增删改/上下移）→ 保存 configDir/plans.json（0600）→ 列表打开/删除（两次确认）。重新生成覆盖草稿需二次点击确认。**不执行任何步骤**（无 git/pip/启停/benchmark/NPU 连接），真实执行留待后续授权。本章 15.2–15.13 的服务列表/预览卡/打标等小节随之作废；分段入口（§15 头部 IA v1.4 的「服务部署」段位）与环境信息/性能调优两段不受影响。

### 15.0 背景与范围

用户诉求：把推理服务（vLLM on 昇腾）受控地部署到对应机器，并在插件里看到服务状态。t21 已定技术方案：`services.json` 资产 → dry-run 预览 → 显式确认 + 三重门 → 受控执行 → 健康轮询 → 服务面板打标。本章定稿其界面与交互。

范围（deploy-design §10 硬边界，全部继承）：

1. **不新增 sidebar tab、不新增页面路由**：部署 UI 并入「性能调优」pane tab（keyed slot `sidebar.right.pane.tab`，key `dsh-ascend-perf-tune`），内部新增二级分段「调优作业 | 服务部署」。
2. **token/组件复用**：视觉一律 §14.13 `--ascend-perf-*` 语义色 + dsw `--dsw-alias-*` token，不新增硬编码色；组件复用 §14 组件族（ConfigBar/OccupancyPill/ConnBadge/ChipStrip/OccProcRow/StateMsg/Empty）与调优页模式（sheet 向导、危险弹窗、抽屉）。
3. **资产配置出页面**：services.json 与 envs.json 一样由文件管理；页面零资产编辑、零写入口（与 t20 的 envs 导入不同，服务资产**不提供**页内导入/生成——见 15.15-D4）。
4. 分段内三块：**服务列表**（主体，常驻）+ **部署向导**（四步 sheet，从列表发起）+ **只读日志尾部抽屉**（从服务行/进度视图打开）。

本章不改变：观测 tab 的多环境占用视图（§14）、调优作业流程（tuning-ui-design.md）、Host 采集协议。涉及远端写操作的一切按钮，其可用性以 Host 返回的 blockers/门状态为准，UI 不自造旁路。

### 15.1 信息架构与入口

现状：右侧栏两个 pane tab——「昇腾性能」（观测，多环境占用视图 §14）与「性能调优」（TunePanel，order 71）。

| 入口 | 位置 | 行为 |
| --- | --- | --- |
| 二级分段「服务部署」 | 「性能调优」tab 标题栏正下方，等宽两段 segmented control「调优作业｜服务部署」 | 默认「调优作业」；切换只换视图，不触发任何采集/预览/执行 |
| 「部署服务 →」 | 观测 tab 环境块（EnvBlock）空闲档（tier=idle）操作区的次级 ghost 链接 | 切到「性能调优」tab 服务部署分段，向导 Step1 预选该环境（仅预选，不自动开始向导、不预览）；部分占用/高负载/未知/停用档不显示该入口 |
| 「查看占用视图」 | 服务部署分段内每条服务行（含环境摘要处） | 切回观测 tab 并滚动定位到对应环境块；不新开 tab |
| Agent 链接/指令 | Agent 回复中的定位 | 允许打开同一 tab 并定位分段与 deploy_id（若 Client 实现）；不新开页面 |

规则：

- 分段选择记入 pane 记忆（同 tuning-ui §2.4：按 pane + 工作区记忆；关闭/刷新后保持）。
- 「部署服务 →」是只读快捷方式：入口只出现在空闲环境，避免在他人占用的环境上提供"一键部署"误导；非空闲环境的部署意图走向导内选环境（可见但会被预检拒绝，见 15.4）。
- 服务部署分段页脚（常驻，替代调优页页脚）：`默认仅预览 · 真实部署需三重门 · 只操作本插件记录的进程/容器 · 服务最长 72 小时`。

### 15.2 分段骨架与数据流

```
性能调优  [调优作业 | 服务部署]        [真实执行：默认关闭]（小字角标）
├─ ConfigBar（只读）：服务资产 services.json：<路径> · N 个服务 · [刷新]
├─ 摘要行：我部署的 n（运行 a · 降级 b）· 外部占用 m · 空闲可部署 k
├─ 服务列表（主体，见 15.3）
│    └─ 服务行展开 = 部署进度视图（15.5，record 活跃时）
├─ [ 部署服务 ]（主按钮，空态时被引导卡取代）
├─ 审计（次级链接，见 15.8）
└─ 页脚：默认仅预览 · 真实部署需三重门 · 只操作本插件记录的进程/容器 · 服务最长 72h
覆盖层：部署向导 sheet（15.4）· 日志抽屉（15.7）· 危险确认 alertdialog（15.6）
```

数据流（REST 全部沿用 deploy-design §9.2，无新增字段依赖）：

| 动作 | 接口 | 触发 |
| --- | --- | --- |
| 打开分段 | `GET /deploy/services` | 仅一次；打开不自动采集、不自动预览 |
| 刷新列表/摘要 | `GET /deploy/services` | 分段头部「刷新」按钮 |
| 预览 | `POST /deploy/preview` | 向导 Step3「生成预览」/ 续期 |
| 执行/停止 | `POST /deploy/apply` | Step4 确认后 / 服务行「停止」 |
| 状态轮询 | `GET /deploy/status`（增量 `after_seq`） | 仅分段可见 + 页面可见 + 存在非终态 record 时每 2s；终态/隐藏即停；重可见先全量同步 |
| 日志尾部 | `GET /deploy/logs`（`deploy_id` + `tail`） | 日志抽屉「刷新」按钮（手动，不自动跟随） |
| 审计 | `GET /deploy/audit`（**新增 Host 依赖**，只读按 seq 分页） | 审计视图打开/翻页/过滤 |

轮询超时/失败处理沿用 tuning-ui §2.4：保留上次数据 +「状态读取失败，数据可能过期」+ 重试 + 指数退避；不自动重发控制动作；401/503 停止轮询。

### 15.3 服务列表与打标（ServiceList / ServiceRow）

列表项数据契约 = `/deploy/services` 返回项（deploy-design §10.3）。字段 → UI 元素：

| 契约字段 | UI 元素 |
| --- | --- |
| `name` / `service_id` | 行首服务名（13px/600）；hover/展开显示 `service_id` 与 `served_model_name` |
| `env.name` + `env.occupancy` / `env.conn` | 环境名（次色）+ 微缩 `OccupancyPill`（档位+计数）+ `ConnBadge`（次要角标，§14.4 同款） |
| `state` / `health` / `owned_by_plugin` | 打标（见下表） |
| `port` / `params_summary` | mono 行：`:18080 · tp4 · fp16 · max_len 16384`（`tabular-nums`） |
| `started_at` / `lifetime_expires_at` | 启动时间（绝对时间，次色）+ 剩余时长（15.5 lifetime 条，仅 mine 活跃态） |
| `last_event` | 展开区最近事件一行（时间 + code + message） |
| `deploy_id` | 展开区/日志/审计的定位 id |

打标六档（判定与视觉；色值用 §14.13.3 语义色，形状+文字双编码，不只靠颜色）：

| 打标 | 判定（deploy-design §10.2） | 视觉 | 图标+文字 | 主操作 | 次操作 |
| --- | --- | --- | --- | --- | --- |
| `mine-running` | 活跃 record 且 health=healthy | 成功色（`--ascend-perf-ok`）实底 chip + 8px 圆点 | ▶ 运行中 | 停止 | 日志 · 续期 · 审计 |
| `mine-degraded` | 活跃 record 且 degraded | 警告色（`--ascend-perf-warn`）实底 | ⚠ 已降级 | 停止 | 日志 · 审计 |
| `mine-stopped` | record 终态（stopped/failed） | 中性（`--ascend-perf-neutral`）描边 + 停止图标 | ■ 已停止 / ✕ 失败（终态细分见 15.5） | 重新预览 | 日志 · 审计 |
| `external-occupied` | 无活跃 record 且环境档位 ≠idle | 警告色描边 + ⚠ 图标；行内附加 top3 占用进程（`OccProcRow` 紧凑型）+ `ChipStrip` 微缩 | ⚠ 外部占用 · 非本插件部署 | 查看占用视图 | 刷新占用 |
| `env-idle` | 环境空闲、服务未部署 | 成功色描边空心 | ○ 可部署 | 部署 | 查看占用视图 |
| `unknown` | 占用未知/连接失败/数据过期 | 中性虚线 +「数据过期」角标（同 §14 连接态降级） | ? 状态未知 | 刷新 | 查看占用视图 |

- 排序（deploy-design §10.2 固定）：`mine-degraded → mine-running → external-occupied → env-idle → mine-stopped → unknown`；同档按环境名 → 服务名。无切换控件（与 §14.1-⑦ 同理：主场景优先，控件最小化）。
- `external-occupied` 行**没有任何启停动作**：不提供停止/清理（ownership 边界）；「查看占用视图」是唯一出路。
- demo record：整行业务蓝虚线左边框 + `DEMO` chip（§10.4/§11.2 tuning-ui 规范，不可隐藏）。
- 停用服务（`enabled:false`）：列表可见、行弱化（`label-tertiary`），chip「已停用」（`SERVICE_DISABLED`），无部署入口。

列表空态三型（复用 t20 ImportGuide 的引导卡样式——`Empty` 容器 + 内部 `s.card` 卡片；风格一致但**无写入口**）：

| 型 | 触发 | 内容 |
| --- | --- | --- |
| 引导卡 | services.json 文件不存在或 `services` 为空 | 标题「还没有服务资产」+ 说明（路径、两运行时一句话）+ **可复制的最小样例片段**（折叠代码块，mono）+「如何编写服务资产」静态指引（指向 README/文档）+ [运行演示部署]（demo 形态，不接触真机）+ [刷新] |
| 配置失败 | `SERVICES_CONFIG_READ_FAILED` | 面板级 `StateMsg`（error）替换列表：路径 + Host 返回的错误信息 + 「修正文件后刷新」（同 §14.6-⑮ 模式；**绝不**提供页内改写/重建文件入口） |
| 有资产无 record | 正常态 | 即列表本身（全部 `env-idle`/`external-occupied` 打标） |

### 15.4 部署向导（DeployWizard，四步 sheet）

面板内全屏 sheet（窄栏全屏、≥420px 居中 480–560px），顶部步骤条 `① 环境与服务 → ② 参数 → ③ 命令预览 → ④ 确认执行`（可回退已完成步骤；未完成不跳步；Esc 关闭时若已有参数改动提示「草稿不保存」）。向导头部常驻中性 chip `仅预览 · 未执行`，直到 Step4 确认受理。草稿仅存 pane 内存（同 tuning-ui §2.4）。

#### Step 1 环境与服务（选择 + 占用信号）

环境优先选择器：环境卡列表（分组容器），每卡 = §14 EnvBlock 的紧凑形态：

```
┌ ( ) env-ascend-a · 910B ×8          [空闲 0/8]  ✓ 连接正常      [刷新占用] ┐
│    ○○○○○○○○  ChipStrip（微缩）      采集于 3 分钟前                        │
│    ├ (•) Qwen3-8B @ A机   docker · tp4 · :18080                          │
│    └ ( ) Qwen3-14B @ A机  venv  · tp8 · :18081                          │
└──────────────────────────────────────────────────────────────────────────┘
┌ ( ) env-ascend-b                      [部分占用 5/16] ⚠                   ┐
│    ▓▓▓░░ …  top3: VLLMWorker_DP ×5 …「部署预检将拒绝：环境被占用」         │
└──────────────────────────────────────────────────────────────────────────┘
```

- 环境卡数据来自 `env_states` 缓存（与观测 tab 同源）：`OccupancyPill` + `ConnBadge` + `ChipStrip` + `top3` 进程（`OccProcRow` 紧凑型）+ 采集时间。
- 服务单选挂在环境卡内（`service.env_id` 固定绑定，不存在跨环境选服务；无服务的环境显示「无服务资产」且不可选）。
- 每卡「刷新占用」= 现有单环境只读刷新接口（§14 复用）；不新增探测。
- 占用/连接信号是**只读预告，不是判定**（真判定在 apply 前强制重采集，fail-closed）：

| 环境信号（缓存） | Step1 呈现 | 「下一步」 |
| --- | --- | --- |
| 空闲 + 连接正常 | 绿 pill 正常 | 可用 |
| 部分占用/高负载 | 警告 pill + top3 进程 + 预告文案「部署预检将拒绝：环境被占用（ENV_OCCUPIED）」 | 可用（允许走完预览看权威 blockers；预检在 apply 前强制重采集，占用可能已变化） |
| 占用未知 / 数据过期（>10 分钟） | 中性虚线 + 「占用数据过期，先刷新占用」（对应 blocker `OCCUPANCY_UNKNOWN`） | 可用（同上） |
| 连接失败/缺少 npu-smi/无设备 | `ConnBadge` 角标 + 原因；预告「将无法通过占用预检」 | 可用（预览会给出 `OCCUPANCY_UNKNOWN` blocker；不静默假装可部署） |
| 环境在 envs.json 缺失（`ENV_UNKNOWN`） | 卡片弱化 + 「服务引用的环境不存在于 envs.json」 | **禁用**（配置层错误，预览无法编译目标） |
| 服务 `enabled:false` | 服务行禁选 + chip「已停用」 | 选其他服务 |
| services.json 为空 | 向导不可开启（入口即引导卡，15.3） | — |

#### Step 2 参数（白名单覆盖表单）

- 表单字段 = preview `overrides` 白名单（deploy-design §5.1）8 项，默认值来自资产条目，占位符即当前值；非白名单字段不可见：

| 字段 | 控件 | 界（§3.2 同源，前端同校验） |
| --- | --- | --- |
| `params.port` | number | 1024–65535 |
| `params.max_num_seqs` | number | 1–1024 |
| `params.max_num_batched_tokens` | number | 128–131072 |
| `params.gpu_memory_utilization` | number(step 0.05) | 0.1–0.95 |
| `params.max_model_len` | number | 256–131072 |
| `model.dtype` | select | float16/bfloat16/float32 |
| `model.quantization` | text | none 或运行时认可标识 |
| `model.tensor_parallel` + `device_ids` | 联动：tp 下拉 1–8，device_ids 显示为对应数量的 chip 位选择器 | tp 必须等于所选 device 数 |

- runtime 信息只读展示卡（docker：image/shm/mounts；venv：python/vllm 绝对路径），无编辑。
- 越界/非法即时行内校验（错误不进 Step3）；顶部 chip「已覆盖 n 项 · [全部重置]」。
- `max_lifetime_s` 只读展示（换算 `12 小时（最长 72 小时）`），不可在向导改（属资产文件）。

#### Step 3 命令预览（dry-run，权威 blockers）

「生成预览」按钮 → `POST /deploy/preview`（纯本地编译，不连远端）。结果卡：

```
┌ 命令预览（DRY-RUN · 仅预览 · 未执行）                    计划有效 59:41 ┐
│ start  argv（已脱敏）：                                              │
│   docker run --rm --detach --name dsw-apf-svc-qwen3-8b-a-<seq> …     │
│   <asset:svc-qwen3-8b-a> …（mono，块内横向滚动，[复制]）              │
│ argv_sha256 3f9c…a21 · plan_hash 91d0…77c · 模板 serve-docker-v1     │
│ 影响：env-ascend-a · 端口 18080 · 设备 0-3 · 容器前缀 dsw-apf-       │
│       最长 12 小时 · 健康检查 /health + /v1/models（阈值 3 次）       │
│ 占用证据：snapshot 4f2a…（3 分钟前 · 空闲）｜窗口：always 允许        │
│ 阻断（2）：⚠ ENV_OCCUPIED — A 机被 VLLMWorker_DP ×5 占用（top3 回显）│
│           ⚠ AUTH_BRIDGE_UNAVAILABLE — 无授权桥，真实执行不可用      │
│ 确认凭据已生成：10 分钟内有效（Step4 使用）                          │
└──────────────────────────────────────────────────────────────────────┘
```

- argv 一律渲染 Host 返回的 `argv_redacted`（真实 argv 不出 Host）；纯文本 mono，不渲染链接/HTML；块内横向滚动。
- blockers 非空 → 「下一步」禁用，逐条给出路（见 15.9 表 D 错误码映射）。
- TTL 倒计时（1 小时，来自 `expires_at`）：过期 → 卡片弱化 + 「计划已过期，重新预览」（`DEPLOY_PLAN_EXPIRED`）。
- 请求失败（REST 错误/校验错误）→ 卡片内 `StateMsg`（error）+ 重试；错误码进 15.9 表 D。

#### Step 4 确认执行

- demo 形态（demo env + demo service）：普通确认区（非 alertdialog，demo 三重门直通）：命令摘要三行（环境/服务/端口/时长）+ 说明「演示部署不接触真机，数据为合成」+ 主按钮「运行演示部署」（业务蓝 + DEMO chip）。
- 真实形态：危险确认弹窗（15.6-启动）。受理后向导关闭、列表滚动并展开该服务行的部署进度视图；反馈文案「已受理，等待占用预检与端口锁」——**不得**显示「已部署/已启动」。

向导各步的 loading / error / blocked / empty 状态汇总见 15.9 表 B。

### 15.5 执行与生命周期呈现（DeployProgress，record 状态机）

record 状态机（deploy-design §5.2）10 态 → UI（嵌在服务行展开区；活跃 record 时列表摘要行同步最小信号）：

| record 状态 | 呈现 | 操作 |
| --- | --- | --- |
| `planned` | 中性「已生成计划（未执行）」+ plan_hash 前 8 + TTL | 取消（关向导即弃）· 重新预览 |
| `blocked` | blockers 回显（同 Step3 格式，含出路链接） | 重新预览 · 查看占用视图 |
| `executing` | 进行中条「拉起中…」（不承诺时长，无百分比） | 停止 |
| `health_pending` | 「健康检查中 · 已通过 n/N 次 · 最长等待 T 上界」（计数而非进度条：无可靠分母） | 停止 · 日志 |
| `running` | 成功色「运行中」+ 心跳上次回传时间 + **lifetime 剩余条**（`role="progressbar"` + 文字「剩余 Xh Ym · 到期自动停止」） | 停止 · 日志 · 续期 |
| `degraded` | 警告「健康连续失败 ≥3 · 自动恢复观察中」+ 最近失败原因 | 停止 · 日志 |
| `stopping` | 「停止请求已受理，等待清理确认」（禁用词「已释放」） | 日志 |
| `stopped` | 终态；`cleanup_state=verified` 才显示「资源已释放」；`unknown` → `CLEANUP_UNKNOWN` 人工核实指引（显示诊断命令**文本**，不代执行） | 重新预览 · 日志 · 审计 |
| `failed` | 危险色 + 失败原因（如 `HEALTH_TIMEOUT`）+ 清理状态 | 查看日志 · 重新预览 · 审计 |
| `recovery_required` | 「Host 重启后需人工核实」说明；本地形态提供「受控停止（仅本插件进程）」（过门+确认）；SSH 形态仅「核实/标记已处理」 | 核实 · 标记已处理 · 审计 |

- lifetime 到期前 30 分钟：`role="status"` 警示条「服务将于 X 分钟后自动停止」+ [续期]。
- 续期 = 重新 preview（同资产同参数）→ Step3 预览卡（新 TTL）→ Step4 续期确认（15.6）；总上限 72h 不变，弹窗内明示。
- 幂等：对已有活跃 record 的服务再点「部署」→ 不开向导，直接定位并展开该 record，提示「已有进行中的部署」。
- 心跳租约语义向用户透明化：运行态详情小字「服务与本插件会话绑定；插件退出后约 20 秒内远端自动收尾（不留孤儿）」——这是特性不是故障，提前说明避免误读（15.15-D7）。

### 15.6 危险确认弹窗（对齐 tuning-ui §9，四个入口）

通用原则逐条沿用 tuning-ui §9.1（alertdialog、默认焦点在「取消」、Esc 取消、焦点陷阱、无"不再提示"、二次确认不是安全门——Host 仍校验三重门/hash/占用；错误回弹窗内显示）。

| 入口 | 标题 | 正文要点 | 确认控件 | 危险按钮 |
| --- | --- | --- | --- | --- |
| 启动真实部署（Step4） | `启动真实部署？` | 目标环境+主机、服务+模型、端口+设备、计划 hash、影响清单（启动本插件自有进程/容器 `dsw-apf-` 前缀、健康检查、最长 X 小时到期自动停止）、风险句「真实执行会在目标机拉起进程/容器；不会停止他人服务、容器或系统服务」 | 复选框「我确认仅操作本插件记录的进程与容器」+ 输入 plan_hash 前 8 位（粘贴允许、大小写不敏感、错误不关弹窗） | `启动真实部署`（危险色；禁用条件：未勾选/hash 不匹配/plan 过期/blockers 非空/无授权桥） |
| 停止服务 | `停止部署的服务？` | 「将按受控流程停止本插件启动的进程/容器（`{name}`）；等待清理确认前不显示已释放。不会停止其他服务/容器/系统服务。」 | 复选框「我理解停止需等待清理确认」 | `停止服务`（危险色；`cleanup_state=unknown` 时改为「查看清理/诊断」） |
| 续期 | `续期服务运行？` | 新到期时间、总上限 72h、续期 = 重新预览+确认 | 复选框「我确认仍在维护窗口与授权内」 | `确认续期`（危险色） |
| 恢复核实（recovery_required） | `核实/标记远端状态？` | 「Host 重启后无法自动证明远端身份；请人工确认目标机状态后标记。」本地形态可选「受控停止（仅 pid 匹配的本插件进程）」 | 无 hash 输入（无计划） | `标记已处理`（中性/危险视动作） |

demo 启动/停止不属危险动作，但保留完整摘要与「不接触真机」说明（同 tuning-ui §9.1-1）。

### 15.7 只读日志尾部抽屉（DeployLogDrawer）

对齐 tuning-ui §5.6 抽屉规范，简化为单 tab：

- 右侧滑出（窄栏全屏）；标题「部署日志（尾部，已脱敏）」+ 元信息行（deploy_id · 服务 · 环境 · 端口 · 时间范围）。
- 内容 = `GET /deploy/logs` 尾部（≤16KiB）纯文本 mono；**手动刷新**按钮；不自动跟随滚动、不自动刷新、不实时 tail（数据经 status/logs 回传，非流式——不承诺实时性）；`truncated` 明示「已截断，仅尾部 16KiB」。
- 远端日志属外部文本：仅当数据渲染，不渲染链接/HTML、不把日志内容当指令（tuning-ui §5.6 同款红线）。
- Esc 关闭、焦点回触发按钮；不因新事件自动弹出。
- 复制诊断：deploy_id、plan_hash 前 8、最近错误码、时间；不含凭据、完整主机路径、真实 argv。

### 15.8 审计与安全可视化（AuditView）

入口：分段头部次级链接「审计」。抽屉内表格（默认最近 50 条，按 seq 倒序，翻页加载），列：

| 列 | 内容 |
| --- | --- |
| 时间/seq | RFC3339 本地化 + seq（mono） |
| 谁 | `origin`（tool/rest/ui 徽标）+ 会话标识短前缀；固定小字说明「记录会话标识而非个人身份（当前无用户体系）」——诚实呈现，不伪装归因（DR-11） |
| 动作 | `action`（preview / apply_start / apply_stop / health_fail / lifetime_expiry / cleanup / recover）；`preview` 行带中性 chip「仅预览」，`apply_*` 行带色点 |
| 环境 / 服务 | env_id + service_id（mono，紧凑） |
| 命令 | plan_hash 前 8 + argv_sha256 前 8（真实 argv 永不出审计视图；hover 提示「真实命令以 hash 溯源，不落 UI」） |
| 结果 | outcome（ok/blocked/failed 色点+文字）+ exit_code + detail（≤256 截断原样显示；`demo:` 前缀行高亮 DEMO chip） |

- 过滤（次级）：按 env_id / action / outcome；只读。
- dry-run vs 真实执行的全局视觉区分（四条规则，缺一不可）：
  1. 向导常驻 `仅预览 · 未执行` 中性 chip（Step1–3）；preview 结果卡头部 `DRY-RUN` chip（§10.4「仅预览」语义）。
  2. 执行按钮：demo = 业务蓝 + `DEMO` chip；真实 = 危险色 + 图标 + 文案必含「真实」二字；两者永不同时出现。
  3. 分段头部常驻小字角标 `真实执行：默认关闭`（静态说明，实际可用性以每次预览的 blockers 为准——不造动态字段依赖，15.15-D6）。
  4. 真实 apply 受理后顶部 `role="status"` 条「真实部署已受理（{env} · {service}）」；demo 受理显示 DEMO 条。审计视图内 `preview` 与 `apply_*` 永远可区分（规则表）。

### 15.9 状态矩阵与错误码

**表 A　列表打标 × 环境连接态**（打标优先级自上而下，命中即停）：

| # | owned_by_plugin | record 状态 | 环境（连接/占用） | 打标 |
| --- | --- | --- | --- | --- |
| A1 | true | running/health_pending | 任意 | mine-running（health_pending 显示「启动中」变体） |
| A2 | true | degraded | 任意 | mine-degraded |
| A3 | true | stopped/failed | 任意 | mine-stopped（细分 已停止/失败） |
| A4 | false | — | available + 档位≠idle | external-occupied |
| A5 | false | — | available + idle | env-idle |
| A6 | false | — | unreachable/command_missing/no_device/未采集/占用未知/数据过期 | unknown |
| A7 | — | — | envs.json 缺该环境 | unknown +「环境配置缺失」角标（`ENV_UNKNOWN`） |
| A8 | — | — | `enabled:false` | 行弱化 + 已停用 chip（叠加在 A1–A6 之上） |
| A9 | demo record | 任意活跃 | demo | A1–A3 + DEMO 虚线/chip |

**表 B　向导步骤 × 阶段状态**：

| 步骤 | loading | ready | blocked/empty | error |
| --- | --- | --- | --- | --- |
| Step1 | 环境卡骨架 ×3（静态占位，不用 shimmer 动画） | 环境卡 + 服务单选 | services 空（入口即引导卡）/ `ENV_UNKNOWN` 禁用下一步 / `SERVICE_DISABLED` 禁选 | 列表加载失败 → 重试 |
| Step2 | — | 表单 + 只读 runtime 卡 | —（越界即时行内校验） | — |
| Step3 | 「编译中…」（本地，应瞬时） | 预览卡 + TTL | blockers 非空禁下一步 / 计划过期重预览 | preview 失败 → StateMsg + 重试（表 D） |
| Step4 | apply 受理中（按钮 busy） | 确认区/弹窗 | 无授权桥：按钮不渲染改说明 | apply 失败 → 回显错误码（表 D），弹窗不自动关 |

**表 C　record 终态 × cleanup_state**：

| 组合 | 呈现 |
| --- | --- |
| stopped + verified | 「已停止 · 资源已释放」（唯一可显示"已释放"的组合） |
| stopped + unknown | 「已停止 · 清理未核实（CLEANUP_UNKNOWN）」+ 人工指引 |
| failed + verified | 「失败（原因）· 已清理」 |
| failed + unknown | 「失败（原因）· 清理未核实」+ 人工指引 |
| stopping（滞留）+ unknown | 「停止中 · 清理未知，需人工核实」（不自动转终态） |
| recovery_required + 任意 | §15.5 表行（不自动重启/停止） |

**表 D　错误码 → UI 呈现**（18 码全表；文案 key 见 §15.10）：

| 错误码 | 出现位置 | 呈现与出路 |
| --- | --- | --- |
| `SERVICES_CONFIG_READ_FAILED` | 列表 | 面板级错误卡 + 路径 + 「修正文件后刷新」 |
| `SERVICE_UNKNOWN` | 向导/预览 | 「服务不存在（资产已变更）」→ 返回 Step1 |
| `SERVICE_DISABLED` | 列表/向导 Step1 | 行弱化/禁选 + 「在 services.json 中启用」指引（页面无开关） |
| `ENV_UNKNOWN` | 列表/向导 | 「环境不在 envs.json」→ 查看占用视图/修配置 |
| `PORT_BUSY` | 预览 blockers | 「端口被占用（{port}）」→ Step2 改端口 或 查看占用 |
| `ENV_OCCUPIED` | 预览 blockers/apply | 「环境被占用」+ top3 进程回显 → 查看占用视图/换环境 |
| `OCCUPANCY_UNKNOWN` | 预览 blockers/apply | 「占用情况不明（看不清不动手）」→ 刷新占用后重预览 |
| `HEALTH_TIMEOUT` | record failed | 「启动超时未达健康阈值」+ 日志入口 + 已清理状态 |
| `DEPLOY_PLAN_EXPIRED` | Step3/apply | 「计划已过期（1 小时）」→ 重新预览 |
| `DEPLOY_HASH_MISMATCH` | apply | 「资产文件已变更，计划作废」→ 重新预览并重新确认（防旧计划盲签） |
| `CONFIRMATION_REQUIRED` | apply | 回到 Step4 弹窗（凭据缺失） |
| `CONFIRMATION_INVALID` | apply（弹窗内） | 「确认凭据无效/过期（10 分钟）」→ 重新预览；输入框聚焦 |
| `MAINTENANCE_WINDOW_CLOSED` | 预览 blockers/apply | 「维护窗口外（窗口：{schedule}）」→ 窗口期内重试 |
| `REAL_DEPLOYMENT_DISABLED` | 预览 blockers/apply | 「真实执行被配置关闭」→ 查看授权说明（不提供页内开关） |
| `AUTH_BRIDGE_UNAVAILABLE` | 预览 blockers/apply | 「无授权桥，真实执行不可用」→ 运行演示部署 |
| `NOT_OWNED_SERVICE` | 停止/续期 | 「非本插件部署的服务，不可操作」→ 查看占用视图（与 external-occupied 行为一致） |
| `CLEANUP_UNKNOWN` | 停止后 | 表 C 对应行 + 人工核实指引 |
| `RECOVERY_REQUIRED` | 状态轮询 | §15.5 recovery_required 行 |

### 15.10 文案与 locale（zh/en，命名空间 `deploy.*`）

风格沿用 §9（zh 直说、en 简洁；禁用词见本节末）。主要键（家族合并列出）：

| key | zh | en |
| --- | --- | --- |
| `deploy.seg.tune` / `deploy.seg.deploy` / `deploy.seg.short` | 调优作业 / 服务部署 / 调优｜部署 | Tuning jobs / Deployments / Tune｜Deploy |
| `deploy.title` | 服务部署 | Service deployment |
| `deploy.footer` | 默认仅预览 · 真实部署需三重门 · 只操作本插件记录的进程/容器 · 服务最长 72 小时 | Preview by default · real deploys need triple gate · plugin-owned processes only · max 72h |
| `deploy.realOffBadge` | 真实执行：默认关闭 | Real execution: off by default |
| `deploy.gotoEnvs` / `deploy.deployHere` | 查看占用视图 / 部署服务 → | View occupancy / Deploy service → |
| `deploy.config.bar` | 服务资产：{path} · {n} 个服务 | Assets: {path} · {n} services |
| `deploy.summary` | 我部署的 {mine}（运行 {a} · 降级 {b}）· 外部占用 {ext} · 可部署 {idle} | Mine {mine} (running {a}, degraded {b}) · external {ext} · deployable {idle} |
| `deploy.badge.*`（mineRunning/mineDegraded/mineStopped/mineFailed/external/idle/unknown/disabled/demo） | 运行中/已降级/已停止/失败/外部占用 · 非本插件部署/可部署/状态未知/已停用/DEMO | Running/Degraded/Stopped/Failed/External · not deployed by this plugin/Deployable/Unknown/Disabled/DEMO |
| `deploy.empty.title` / `.desc` / `.sample` / `.demo` / `.refresh` | 还没有服务资产 / 在 {path} 中声明…（两运行时一句话）/ 最小样例（可复制）/ 运行演示部署 / 刷新 | No service assets yet / Declare services in {path}… / Minimal sample / Run demo deploy / Refresh |
| `deploy.wiz.title` / `.dryChip` | 部署服务 / 仅预览 · 未执行 | Deploy a service / Preview only |
| `deploy.wiz.envStale` / `.envBusyWarn` / `.envMissing` / `.noServices` / `.envUnreachable` | 占用数据过期，先刷新占用 / 部署预检将拒绝：环境被占用（ENV_OCCUPIED）/ 服务引用的环境不存在于 envs.json / 该环境无服务资产 / 将无法通过占用预检 | Occupancy stale, refresh first / Precheck will reject: env occupied / Env missing from envs.json / No services on this env / Occupancy precheck will fail |
| `deploy.wiz.overrides` / `.reset` | 已覆盖 {n} 项 / 全部重置 | {n} overridden / Reset all |
| `deploy.wiz.preview.*`（title/redacted/effects/evidence/window/blockers/ttl/challenge） | 命令预览（DRY-RUN）/ 已脱敏 / 影响 / 占用证据 / 窗口 / 阻断（{n}）/ 计划有效 {mm}:{ss} / 确认凭据已生成：10 分钟内有效 | Command preview (DRY-RUN) / redacted / effects / occupancy evidence / window / blockers ({n}) / plan valid {mm}:{ss} / challenge issued, valid 10 min |
| `deploy.confirm.start.*`（title/body/check/hashLabel/btn） | 启动真实部署？/（§15.6 正文要点拼装）/ 我确认仅操作本插件记录的进程与容器 / 输入计划 hash 前 8 位 / 启动真实部署 | Start real deployment? / … / I confirm plugin-owned processes only / Type first 8 chars of plan hash / Start real deployment |
| `deploy.confirm.stop.*`（title/check/btn） | 停止部署的服务？/ 我理解停止需等待清理确认 / 停止服务 | Stop deployed service? / I understand cleanup confirmation is required / Stop service |
| `deploy.confirm.renew.*`（title/btn） | 续期服务运行？/ 确认续期 | Renew service? / Confirm renew |
| `deploy.confirm.mark.*`（title/btn） | 核实/标记远端状态？/ 标记已处理 | Verify remote state? / Mark handled |
| `deploy.demo.body` / `.btn` / `.accepted` | 演示部署不接触真机，数据为合成 / 运行演示部署 / 演示部署已受理 | Demo deploy never touches real machines / Run demo deploy / Demo deploy accepted |
| `deploy.state.*`（planned/blocked/executing/healthPending/running/degraded/stopping/stopped/failed/recovery） | 已生成计划（未执行）/被阻断/拉起中…/健康检查中（{n}/{N}，最长 {T}）/运行中/已降级（连续失败 ≥3）/停止中·等待清理确认/已停止/失败/恢复需人工 | Planned (not run)/Blocked/Starting…/Health checks {n}/{N} (max {T})/Running/Degraded/Stopping…/Stopped/Failed/Recovery required |
| `deploy.lifetime.left` / `.warn` | 剩余 {h} 时 {m} 分 · 到期自动停止 / 服务将于 {m} 分钟后自动停止，可续期一次 | {h}h {m}m left · auto-stop at expiry / Auto-stop in {m} min; one renewal available |
| `deploy.lease.note` | 服务与本插件会话绑定；插件退出后约 20 秒内远端自动收尾，不留孤儿 | Service is bound to this plugin session; remote self-stops within ~20s after plugin exit |
| `deploy.cleanup.verified` / `.unknown` | 资源已释放 / 清理未核实，需人工处理 | Resources released / Cleanup unverified, manual check needed |
| `deploy.idempotent.existing` | 已有进行中的部署，已定位到该部署 | An active deployment exists; located it |
| `deploy.logs.*`（title/refresh/truncated/empty/copy） | 部署日志（尾部，已脱敏）/ 刷新 / 已截断，仅尾部 16KiB / 暂无日志 / 复制诊断 | Deploy logs (tail, redacted) / Refresh / Truncated to last 16KiB / No logs / Copy diagnostics |
| `deploy.audit.*`（title/who/origin.tool/origin.rest/origin.ui/action/cmd/result/note/empty） | 部署审计 / 谁 / 工具/接口/界面 / 动作 / 命令(hash) / 结果 / 记录会话标识而非个人身份（当前无用户体系）/ 暂无审计记录 | Deploy audit / Who / Tool/REST/UI / Action / Command (hash) / Outcome / Session identity, not personal attribution / No audit records |
| `deploy.hint.*`（ENV_OCCUPIED/OCCUPANCY_UNKNOWN/MAINTENANCE_WINDOW_CLOSED/REAL_DEPLOYMENT_DISABLED/AUTH_BRIDGE_UNAVAILABLE/DEPLOY_HASH_MISMATCH/DEPLOY_PLAN_EXPIRED/CONFIRMATION_INVALID） | 见 15.9 表 D「呈现与出路」列的 zh 文案（逐键对应） | see table D wording |

禁用词（在 tuning-ui §9.6 基础上追加）：「一键部署」「自动扩容/自愈」（"自愈"只可描述租约收尾机制，不用作卖点词）、「永远在线/长驻」（与 72h 上限矛盾）、「已部署」（受理≠完成，用「已受理」）。替代动词：**启动部署（受控）/ 停止服务 / 续期**。

### 15.11 窄栏与降级（300–419px）及宽栏

| 区域 | 300–419px | 420–559px（默认右栏） | ≥560px |
| --- | --- | --- | --- |
| 分段控件 | 等宽两段，文案用 `deploy.seg.short` 短版（调优｜部署） | 全称两段 | 同左；内容最大宽 960px 居中 |
| 服务行 | 两行卡：① 名+打标 ② 模型·端口·环境；动作收进「⋯」菜单 | 单行紧凑 + 展开区 | 单行，审计链接外露 |
| 向导 | 全屏 sheet；步骤条变「1/4」+短题 | 居中 480–560px sheet | 同左 |
| argv 预览 | 块内横向滚动（唯一允许滚动的块） | 同左，滚动条可见 | 尽量整行显示 |
| 危险弹窗 | 全屏 alertdialog；取消在上、危险在下，均整行 | 居中 480–560px | 同左 |
| 日志/审计抽屉 | 全屏 | 右侧滑出 | 右侧滑出（审计表 ≥7 列） |

任何宽度不出现整页横向滚动；徽标/chip 在 200% 缩放下可读（§14.13.10-5 同款走查）。

### 15.12 可访问性

- 键盘（对齐 tuning-ui §11.4）：分段控件 ←/→ roving tabindex；向导 Tab/Shift+Tab 顺序 = 步骤条→表单→动作；hash 确认输入可纯键盘完成；抽屉/弹窗 Esc 关闭 + 焦点陷阱 + 焦点归还触发按钮；状态更新不抢焦点。
- 屏幕阅读器：record 状态迁移 `role="status" aria-live="polite"` 只播报迁移（running→degraded 等），不播报每 2s 轮询 tick；错误 `role="alert"`；lifetime 剩余条 `role="progressbar"` + `aria-valuetext="剩余 3 小时 12 分"`；打标 chip 均有文本（形状+文字双编码：▶ 运行中 / ⚠ 外部占用 / ○ 可部署 / ? 未知）；「仅预览」chip 进入向导播报一次。
- 对比度与非颜色编码：语义色仅承载强调，档位与打标永远有图标+文字；外部占用与已降级同为警告色时以图标+文字区分（⚠外 / ⚠降）；demo 虚线边框在深浅主题均可见。

### 15.13 实现改造清单（给开发，仅指引不改码）

1. **client.js 新增**：`DeploySegment`（分段容器）、`DeployConfigBar`（复用 `ConfigBar` 参数化）、`ServiceList`/`ServiceRow`（打标+展开进度）、`DeployWizard`（四步 sheet，内部复用 `OccupancyPill`/`ConnBadge`/`ChipStrip`/`OccProcRow`/`StateMsg`/`Empty`）、`DeployPreviewCard`、`DeployProgress`、`DeployLogDrawer`、`AuditView`、危险弹窗复用调优页确认弹窗模式。
2. **TunePanel 外包一层 `SegmentedControl`**（调优作业｜服务部署）；分段选择并入 pane 记忆（localStorage 既有 key 体系）；观测 tab `EnvBlock` 空闲档操作区加 ghost 链接「部署服务 →」（§15.1）。
3. **Host 依赖**（记入开发任务，UI 不造字段）：`/deploy/services` 按 deploy-design §10.3 返回；`env_states` 缓存含采集时间（Step1 新鲜度）；**新增 `GET /deploy/audit`**（只读、按 seq 分页、过滤参数 env_id/action/outcome——15.14-O1）；demo preview 在 services.json 为空时可用（内置 demo 资产——15.14-O2）。
4. **data-testid**：`deploy.seg`、`deploy.list`、`deploy.row.{service_id}`、`deploy.row.{service_id}.badge`、`deploy.wiz.step{1..4}`、`deploy.wiz.env.{env_id}`、`deploy.preview.argv`、`deploy.preview.blockers`、`deploy.confirm.input`、`deploy.progress.{deploy_id}`、`deploy.logs.drawer`、`deploy.audit.view`。
5. **locale**：§15.10 键表落 `locale/zh.json`/`en.json`（含窄栏短版 `deploy.seg.short`）。

### 15.14 开放问题（交开发任务 / 审查）

1. **O1 审计路由**：deploy-design §9.2 未列 `/deploy/audit`；本章 AuditView 依赖该只读路由（分页+过滤）。若排期不纳，P1/P2 先以「审计文件由 Agent 经工具读取、UI 仅静态说明」降级（决策权在开发/architect）。
2. **O2 空资产下的 demo preview**：演示按钮需要 Host 在 services.json 为空时提供内置 demo 服务条目参与 preview/apply（demo 分仓）。
3. **O3 门状态动态角标**：`deploy.realOffBadge` 现为静态文案；若后续 `/deploy/services` 返回门/窗口摘要，可升级为动态（不阻塞本期）。
4. **O4 审计 detail 的渲染边界**：`detail` 截断 256 字符原样显示；是否需要 redaction 复核（含路径/镜像名的暴露程度）由审查确认。
5. **O5 external-occupied 的教育路径**：用户误对他人服务点停止时仅 `NOT_OWNED_SERVICE` 文案；是否在列表头部加一次性说明卡（可关闭）待演示走查后定。

### 15.15 增补决策记录

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 章节落 ui-design.md §15，交叉引用 tuning-ui-design.md | 部署分段与观测视图共享组件族（OccupancyPill/ChipStrip）与打标语义，同文件对照维护成本低；t22 指令亦明确落本文件 |
| D2 | 二级 segmented control 而非第三个 pane tab | deploy-design §10 硬边界（不加 sidebar tab）；部署与调优同属"受控执行"心智，与观测（只读）分开 |
| D3 | Step1 环境优先、服务挂环境内单选 | services.json 的 env_id 与服务强绑定，"选环境"实为分组导航；分组展示占用信号才能在选服务前看到 ENV_OCCUPIED 预告 |
| D4 | services.json 空态引导卡**无写入口**（与 t20 envs 导入不同） | 服务资产含内网拓扑与执行链路参数，页内导入/生成会稀释"资产文件为唯一事实源"（DR-12）；引导卡只做样式一致 |
| D5 | Step1 占用信号只读预告、允许继续走到预览 | 预览是免费且权威的（blockers 由 Host 计算）；缓存信号可能过期，提前硬拦会制造假确定；真判定在 apply 前强制重采集（fail-closed） |
| D6 | 门状态用静态角标 + 预览 blockers 动态呈现 | 不为角标新增数据字段依赖；"真实可用性"只有 preview 的 blockers 才是权威，避免列表头角标与预览结果矛盾 |
| D7 | 心跳租约语义对用户透明（运行态小字说明） | 服务随插件退出而收尾是用户可感知的行为差异，提前说明优于事后解释"为什么服务停了" |
| D8 | health_pending 用计数（n/N + 上界）不用进度条 | 启动时长无可靠分母，百分比是伪精度（§7.3 不造假原则的推广） |
| D9 | 续期复用 preview→confirm 全链路 | 与"任何执行都过门+审计"一致；不造轻量旁路（哪怕只是延长寿命） |
| D10 | external-occupied 行无任何启停动作 | ownership 边界（DR-10/§7.3）；UI 可供性必须与权限一致，否则诱导越权操作 |
| D11 | 审计命令列只显示 hash 短前缀 | 真实 argv 永不出 Host（§4.1）；hash 可溯源即可，UI 不成为 argv 展示面 |

---

## 附录 A 设计决策记录

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 三区结构 vs 子 tab | 单列三区，可折叠 | 窄栏多一层导航成本高；三区有因果顺序 |
| 打开面板是否采集 | 缓存优先，不自动采集 | t2 规定；避免打开即触发远端命令，也让“刷新”成为明确动作 |
| 对比触发 | 显式“开始对比”，不自动 | 避免选择变化时旧结果被误读 |
| 选择变更 | 立即失效旧对比 | 防止旧数字挂在新选择下 |
| 缺失展示 | “缺失”+原因，不用 0/— | 满足“不造假 0”；`—` 易被当成 0 |
| 健康表达 | 具体指标 + 芯片最差派生†，不做健康分 | v1 无卡级字段；分数不可解释、不可复算 |
| DEMO | 三重标识、不可隐藏 | 防止演示数据被当真实性能 |
| 过期 | 以 `collection.stale` 为准；导入标“历史” | 历史运行不会“过期”，UI 不自行改判 |
| 对比表窄栏 | 卡片而非横向滚动 | 300–419px 下可读性优先 |
| 阈值编辑 | 首版不做 | 控制范围；面板只解释阈值 |
| 运行态/存储 | 不展示（`null`） | t2 在线不采；避免把 t6 离线证据当当前值 |
| 导入输入 | 仅浏览器文件内容 | t2 拒绝 URL/任意 Host 路径/目录/压缩包 |
| 可比性不一致 | 只显示描述性差值，无“仍要对比” | 防止把不可比结果读成改善/回归 |
| 导出 | 仅对比摘要，不导出设备快照 | 避免传播未确认原始数据；由 Agent 读工具结果 |
| 自动调优 | 不做、不留按钮 | 避免虚假可供性；写操作超出 MVP 边界 |
