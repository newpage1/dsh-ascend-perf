# 昇腾性能工作台：DSH 市场结构、相邻产品与 MVP 决策

> 决策：先交付“采集或导入 → 理解瓶颈 → 对比回归”的性能看板；环境体检作为入口能力，自动调优排入二期。本文是产品市场论证，不是运行时接口或实现代码。统计仅代表指定目录快照，需求排序属于基于代理指标的产品判断。

## 1. 数据来源、统计口径与可追溯性

- 唯一市场数据源：[plugins.json](/tmp/catalog/package/plugins.json)，目录为 `awesome-dsh-plugin`，`updated=2026-11-05`，声明与实际记录数均为 **9,111**，分类表 **23** 类。统计执行时间为 2026-11-07（Asia/Shanghai）。
- 来源仓库：[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。本报告没有使用网站实时值覆盖本地快照。
- 原始文件 SHA-256：`2c1c23854d7857f610f3f85df7adf8ceb96dbfd6aa52c96d888af1a6c394a96b`。
- 统计实体为 `plugins[]` 中的一条目录记录，以 `url` 标识；**9,111 个唯一 URL、8,353 个唯一 name**。同名不同作者属于不同条目，不能仅按 name 去重。表格中的插件名链接到该记录 URL，可回到原始记录。
- `downloads` 为目录提供的下载数，非累计安装人数：**4,669 条有值（51.25%），4,442 条缺失（48.75%）**；所有有值记录均为 `downloadsStart=2026-10-07`、`downloadsEnd=2026-11-05` 的 30 日窗口，`downloadsCheckedAt=2026-11-06`。缺失在展示时记“—”，求和时跳过，不能据此判定需求为零。
- `stars` 有值 **8,847 条**，缺失 **264 条（2.90%）**。GitHub 星标可能属于整仓库，尤其单仓库多插件和大项目集成，因此只衡量关注度，不等于该插件的专属用户数；跨记录求和存在重复归属。
- 目录可见下载合计 **18,684,621**，星标字段合计 **676,826**。前者含自动安装/CI 等可能重复下载，后者含仓库级重复，均不应当作去重用户规模。
- 类别数量按 `category` 精确分组；占比以 9,111 为分母保留两位小数。排名各自过滤指标为 null 的记录，按指标降序，再按 `name`、`url` 字典序升序处理并列；保留原始插件名和目录分类。原始定位可用 `plugins[i]` 的 `url` 唯一查找，字段路径为 `category`、`downloads`、`stars`、`description.zh/en`。

## 2. 市场结构：23 类完整分布

“下载覆盖”列表示该类别有非空 downloads 的条数；下载和星标合计仅为快照可见字段合计。由于类别划分和覆盖率不同，不应仅凭合计比较单个插件质量。


| 分类键 | 中文类别 | 记录数 | 占比 | 下载覆盖 | 可见下载合计 | 星标字段合计 |
| --- | --- | --- | --- | --- | --- | --- |
| agi | AGI 架构探索 | 62 | 0.68% | 40/62 | 197,298 | 1,724 |
| ui | UI 增强 | 1,792 | 19.67% | 881/1792 | 2,509,221 | 57,302 |
| usage | 用量与计费 | 483 | 5.30% | 234/483 | 897,279 | 7,296 |
| theme | 主题与外观 | 350 | 3.84% | 158/350 | 651,040 | 12,095 |
| model | 模型与账号接入 | 468 | 5.14% | 257/468 | 723,337 | 71,125 |
| identity | 身份与通信 | 109 | 1.20% | 54/109 | 142,427 | 6,589 |
| session | 会话与消息 | 678 | 7.44% | 350/678 | 3,719,098 | 13,041 |
| memory | 记忆 | 403 | 4.42% | 205/403 | 861,573 | 129,087 |
| tools | 工具与能力 | 1,231 | 13.51% | 668/1231 | 1,496,035 | 100,361 |
| wsl | WSL 与 Windows 互操作 | 85 | 0.93% | 10/85 | 14,114 | 209 |
| browser | 浏览器与网页 | 185 | 2.03% | 117/185 | 494,058 | 14,263 |
| vision | 视觉与多模态 | 173 | 1.90% | 86/173 | 499,479 | 8,244 |
| voice | 语音与音频 | 118 | 1.30% | 68/118 | 151,546 | 842 |
| docs | 文档与渲染 | 163 | 1.79% | 89/163 | 284,189 | 94,424 |
| skill | 技能包 | 323 | 3.55% | 137/323 | 504,007 | 28,418 |
| workflow | 工作流与自动化 | 530 | 5.82% | 293/530 | 693,131 | 30,732 |
| git | Git 与代码评审 | 173 | 1.90% | 94/173 | 345,898 | 10,671 |
| notify | 通知与集成 | 317 | 3.48% | 157/317 | 624,190 | 10,942 |
| dev | 开发与运行时 | 529 | 5.81% | 285/529 | 740,094 | 16,050 |
| security | 安全与权限 | 244 | 2.68% | 130/244 | 381,937 | 7,113 |
| remote | 远程与移动端 | 265 | 2.91% | 149/265 | 723,760 | 24,978 |
| market | 插件市场与管理 | 124 | 1.36% | 65/124 | 1,137,781 | 21,530 |
| fun | 娱乐 | 306 | 3.36% | 142/306 | 893,129 | 9,790 |


UI 增强（1,792）和工具与能力（1,231）合计 **3,023 条、33.18%**，说明 DSH 用户正在把会话环境扩展成日常工作台。会话与消息虽然只有 678 条，却贡献 3,719,098 次可见下载，其中 billion-context 一项为 2,889,440，存在头部集中。下载前 20 条占全部可见下载 **38.44%**；这一集中度意味着不能把“某类出现冠军”直接推断成整类都高需求。

### 2.1 下载 Top 20（2026-10-07 至 2026-11-05）


| 排名 | 插件（链接即原记录 URL） | 类别 | 30 日下载 | 星标 |
| --- | --- | --- | --- | --- |
| 1 | [billion-context](https://github.com/ranxianglei/billion-context) | session | 2,889,440 | 4,131 |
| 2 | [dsh-market](https://github.com/dsh-market/dsh-market) | market | 953,547 | 10,295 |
| 3 | [dsh-pet#dsh-pet](https://github.com/PC2005-cloud/dsh-pet/tree/main/dsh-pet) | fun | 435,719 | 5,347 |
| 4 | [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) | ui | 405,845 | 6,922 |
| 5 | [dsh-context](https://github.com/bowenliang123/dsh-context) | usage | 361,079 | 4,288 |
| 6 | [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | ui | 269,118 | 4,933 |
| 7 | [modlens](https://github.com/liustack/modlens) | vision | 242,568 | 4,725 |
| 8 | [dsh-skills-manager](https://github.com/MichengAI/dsh-skills-manager) | dev | 179,549 | 444 |
| 9 | [dsh-web#packages/dsh-skill-explorer](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-skill-explorer) | skill | 144,629 | 9,959 |
| 10 | [dsh-ops](https://github.com/T-Auto/dsh-ops) | tools | 138,405 | 5,074 |
| 11 | [dsh-pet](https://github.com/zhu1090093659/dsh-pet) | fun | 134,571 | 62 |
| 12 | [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter) | usage | 128,808 | 635 |
| 13 | [dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine) | theme | 127,915 | 5,317 |
| 14 | [dsh-web#packages/dsh-task-board](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-task-board) | ui | 119,962 | 10,124 |
| 15 | [cc-safety-net](https://github.com/kenryu42/cc-safety-net) | security | 119,120 | 1,900 |
| 16 | [dsh-web#packages/dsh-git-graph](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-git-graph) | git | 112,626 | 9,959 |
| 17 | [dsh-web#packages/dsh-remote-web-ui](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-remote-web-ui) | remote | 109,620 | 9,959 |
| 18 | [dsh-im](https://github.com/xmanrui/dsh-im) | notify | 106,140 | 3,118 |
| 19 | [dsh-web#packages/dsh-ssh](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-ssh) | remote | 104,186 | 9,959 |
| 20 | [dsh-web#packages/dsh-web-all](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-web-all) | ui | 99,379 | 10,124 |

### 2.2 星标 Top 20（目录快照）

星标排名保留整仓库关注度效应；同仓多个插件的重复星标原样展示。


| 排名 | 插件（链接即原记录 URL） | 类别 | 30 日下载 | 星标 |
| --- | --- | --- | --- | --- |
| 1 | [archify#integrations/deepseek-harness](https://github.com/tt-a1i/archify/tree/main/integrations/deepseek-harness) | docs | 44,568 | 92,724 |
| 2 | [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) | model | — | 62,526 |
| 3 | [hindsight#coding-agents](https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/coding-agents) | memory | 87,948 | 59,151 |
| 4 | [OpenViking#examples/dsh-memory-plugin](https://github.com/volcengine/OpenViking/tree/main/examples/dsh-memory-plugin) | memory | 41,270 | 41,648 |
| 5 | [next-ai-draw-io#dsh-plugin](https://github.com/DayuanJiang/next-ai-draw-io/tree/main/packages/dsh-plugin) | tools | 925 | 36,718 |
| 6 | [WeKnora#dsh-weknora](https://github.com/Tencent/WeKnora/tree/main/packages/dsh-weknora) | tools | 7,978 | 36,302 |
| 7 | [MemOS#memos-local-plugin](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin) | memory | — | 12,286 |
| 8 | [dsh-market](https://github.com/dsh-market/dsh-market) | market | 953,547 | 10,295 |
| 9 | [dsh-web#packages/dsh-task-board](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-task-board) | ui | 119,962 | 10,124 |
| 10 | [dsh-web#packages/dsh-web-all](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-web-all) | ui | 99,379 | 10,124 |
| 11 | [dsh-web#packages/dsh-git-graph](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-git-graph) | git | 112,626 | 9,959 |
| 12 | [dsh-web#packages/dsh-plugin-manager](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-plugin-manager) | market | — | 9,959 |
| 13 | [dsh-web#packages/dsh-remote-web-ui](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-remote-web-ui) | remote | 109,620 | 9,959 |
| 14 | [dsh-web#packages/dsh-skill-explorer](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-skill-explorer) | skill | 144,629 | 9,959 |
| 15 | [dsh-web#packages/dsh-ssh](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-ssh) | remote | 104,186 | 9,959 |
| 16 | [BrowserSkill#dsh-plugin-browserskill](https://github.com/Tencent/BrowserSkill/tree/main/packages/dsh-plugin-browserskill) | browser | 42,116 | 9,929 |
| 17 | [treg](https://github.com/superdesigndev/treg) | tools | — | 7,042 |
| 18 | [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) | ui | 62,591 | 7,006 |
| 19 | [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) | dev | — | 6,994 |
| 20 | [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) | ui | 405,845 | 6,922 |


## 3. 开发者最常用、最需要的能力类型

这里的“常用”指下载、目录供给和典型产品热度所显示的代理信号；“需要”指对开发工作流的价值推断，尚未经过访谈、留存或付费验证。以下类别不互相排斥，也不以相加方式估算用户规模。

| 能力类型 | 快照依据 | 对昇腾工作台的启示 |
| --- | --- | --- |
| 长任务与上下文连续性 | session 678 条、3,719,098 次可见下载；billion-context 下载 2,889,440、星标 4,131 | 训练/推理实验跨回合，应保留可追溯的运行记录与对比基线 |
| 工作台界面与状态可视化 | ui 1,792 条、19.67%；2,509,221 次可见下载；DSH-better-sidebar 下载 269,118，dsh-web#packages/dsh-task-board 下载 119,962 | 关键结果需直接出现在 Web 面板，并与会话中的工具结果一致 |
| 工具集成与可操作证据 | tools 1,231 条、1,496,035 次可见下载；dsh-ops 下载 138,405、星标 5,074 | 必须同时提供 Agent 可读的结构化工具结果与人可读摘要 |
| 用量、成本与效率观测 | usage 483 条、897,279 次可见下载；dsh-context 下载 361,079，dsh-cost-meter 下载 128,808 | 让吞吐、延迟、资源占用及变化有明确单位与来源，避免只展示“健康分” |
| 远程设备协作 | remote 265 条、723,760 次可见下载；dsh-web#packages/dsh-remote-web-ui 下载 109,620、dsh-web#packages/dsh-ssh 下载 104,186 | 真机通常在服务器，首版先保证 Host 本地/导入流程，未来复用受控远程连接 |
| 知识记忆与检索 | memory 403 条、861,573 次可见下载；hindsight#coding-agents 下载 87,948、星标 59,151，OpenViking#examples/dsh-memory-plugin 下载 41,270 | 实验配置、环境版本和输入数据必须随结果保存，历史才能复用；星标属于上游项目的效应需保留 |
| 自动化与开发验证 | workflow 530 条、693,131 次可见下载；dev 529 条、740,094 次；dsh-agent-bench 下载 814、星标 1 | 先有确定性的两次运行对比，再讨论自动参数搜索；回归结论须能复算 |
| 插件发现与技能管理 | market 124 条、1,137,781 次可见下载；dsh-market 下载 953,547；dsh-skills-manager 下载 179,549 | 可安装、依赖可解释、无硬件可演示，是开发者尝试成本的一部分 |

表中代表插件的 URL 可在前文 Top 20 或第 4 节找到；其余逐项原记录链接如下：


- [dsh-context](https://github.com/bowenliang123/dsh-context)
- [dsh-cost-meter](https://github.com/GooDAnDReaDY/dsh-cost-meter)
- [dsh-cost-meter](https://github.com/guojinpeng/dsh-cost-meter)
- [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter)
- [dsh-cost-meter](https://github.com/Sttrevens/dsh-cost-meter)
- [hindsight#coding-agents](https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/coding-agents)
- [OpenViking#examples/dsh-memory-plugin](https://github.com/volcengine/OpenViking/tree/main/examples/dsh-memory-plugin)
- [dsh-ops](https://github.com/T-Auto/dsh-ops)
- [dsh-skills-manager](https://github.com/MichengAI/dsh-skills-manager)


## 4. 昇腾专用空白与相邻插件扫描

### 4.1 严格结果：0 条

扫描范围是每条记录的 `name`、`npm`、`description.en`、`description.zh` 拼接文本，忽略英文大小写。匹配规则为：

`昇腾|(?<![A-Za-z])Ascend(?![A-Za-z])|(?<![A-Za-z])NPU(?![A-Za-z])|(?<![A-Za-z])CANN(?![A-Za-z])`

| 核验项 | 结果 | 解释 |
| --- | --- | --- |
| “昇腾”任意子串 | 0 | 中文描述或名称无显式昇腾条目 |
| “Ascend”任意子串 | 0 | 即便放宽英文词边界，也无命中 |
| 四词严格规则的记录并集 | **0** | 是目录层面的专用能力空白证据 |
| 扩展专业信号：`msprof`、`mindstudio`、`torch[._-]?npu`、`npu-smi` | 0 | 同一文本范围，进一步核查工具链名称 |
| 华为相关宽扫描：`华为|huawei|鸿蒙|harmonyos` | 22 | 涵盖云模型接入、鸿蒙、网络工程，不等同昇腾性能 |

直接用 `npu` 子串会命中 **341 条**（例如 input），`cann` 子串会命中 **168 条**（例如 cannot、scanner）。[dsh-cannbot-connect](https://github.com/gentle-knight/dsh-cannbot-connect) 名称确实含 cann，但其描述是 **CANNBOT 网关模型接入**、复用 CANNWork 登录态，星标 0、下载缺失；没有 CANN/NPU 性能采集或分析声明，因此不纳入昇腾专用插件。

**推断边界：**0 表示这份快照的这些显式字段没有专用条目，不证明 README、未收录插件或整个昇腾生态不存在工具，也不代表已证实付费市场。下面的竞争分析只基于目录 description，并未逐仓验收其实现。

### 4.2 华为相关 22 条完整清单

保留命中的全部条目，避免将“华为生态相关”偷换成“昇腾性能”。网络工程助手存在同名不同作者的两条记录，URL 可区分。


| 插件 | 类别 | 30 日下载 | 星标 | 目录所述能力 |
| --- | --- | --- | --- | --- |
| [dsh-network-engineer](https://github.com/sososilencing/dsh-network-engineer) | agi | 909 | 5 | 网络工程师助手预设 + 四厂商（迪普/新华三/华为/锐捷）交换机路由器命令知识库：32 篇文档随插件以技能形式分发（含来源链接与 verified 分级），KB 优先检索、跨厂商语法对照、拓扑与回显截图识别、联网查官方手册并注明出处、高危命令强制 ⚠️ 风险标注；只回答网络工程主题。 |
| [dsh-codearts-connect](https://github.com/2239058652/dsh-codearts-connect) | model | — | 0 | 华为云 CodeArts 的 DeepSeek Harness 接入插件：内置 OAuth2（PKCE + DPoP）登录、多账号轮转、模型发现，以及积分与用量查看。本项目是 elegant01/dsh-codearts（MIT）的衍生版，补充了账号与图片相关能力；请勿与上游同时安装——两者注册同一个 `codearts` provider。 |
| [dsh-codearts-auth](https://github.com/anye-99/dsh-codearts-auth) | model | — | 16 | 华为云 CodeArts 浏览器登录，并把 CodeBuddy、WorkBuddy、LobsterAI、Qoder（国际版与中国版）、TRAE、Cline、Loomy、Raccoon Work、MiniMax Code、TeleAgent、ZCode、Step Code、Antigravity 注册为 LLM 提供商；各 provider 独立账号池，其中多家在同一面板内提供额度余额与每日签到。 |
| [dsh-codearts](https://github.com/elegant01/dsh-codearts) | model | 4,016 | 11 | 把华为云 CodeArts 接入 DeepSeek Harness：内置华为云 OAuth2 登录（PKCE + DPoP），也支持粘贴 token；登录后即可在 DSH 对话窗口使用 CodeArts 提供的模型。积分余额、即将过期额度与每日签到读 CodeArts 自己的积分接口，请求数与 token 用量按账号在本机统计；对话输入框下方那行积分可点开看逐号明细，积分与上游排队位置都能在设置里单独关掉。 |
| [model-failover-manager](https://github.com/liaoyuqing/model-failover-manager) | model | — | 2 | 模型选择弹窗＋路由分组：模型失败后自动换到组内下一个可用模型并继续本轮；另含数据看板与免费渠道页签。页签一键安装六个渠道插件 —— Our Free Model（唯一不登录、不填 API Key 也能用的）、CodeArts、WorkBuddy、Trae、Qoder、Providers Hub，覆盖 23 个平台：华为云 CodeArts、腾讯 CodeBuddy、WorkBuddy、有道 LobsterAI、Qoder、TRAE、Cline、讯飞 Loomy、商汤 Raccoon、MiniMax、智谱 ZCode、Gemini Code Assist、阿里 Accio、讯飞 AStudio、OpenCode、OfficeAce、AutoClaw、魔搭 ModelScope、七牛云 Qiniu、Codely、MonkeyCode、百智云、超级麦吉 MagiCrew 等平台。 |
| [dsh-huawei-connect](https://github.com/wang111928/dsh-huawei-connect) | model | 424 | 1 | 把华为「码道 CodeArts」与「果办 OfficeAce」两个平台的模型接入 DeepSeek Harness：复用已有登录态（码道桌面端或 dsh-codearts 已登录；果办桌面端需在 Windows 上运行并登录），显示各账号积分余量、按平台勾选模型，并按官方客户端形态构造请求。 |
| [dsh-hdc-bridge](https://github.com/1na-ko/dsh-hdc-bridge) | tools | 2,293 | 20 | 鸿蒙设备桥：hdc 截图/装包/日志/崩溃/UI 自动化闭环（配 read_image 看图），官方优先版本化 API 知识层（SDK .d.ts + 离线随包文档），以及 DevEco CLI 构建/签名/lint 通道。 |
| [fnos-dsh#dsh-midscene-plugin](https://github.com/FNOSP/fnos-dsh/tree/main/plugins/dsh-midscene-plugin) | tools | 3,236 | 91 | 让 Midscene 直接用 DeepSeek Harness 里已配置的模型，不再需要第三方模型 API Key：在 127.0.0.1 托管一个 OpenAI 兼容桥接服务（默认端口 8787，被占用时自动跳号），把流式与非流式的对话补全代理到 DSH 宿主模型层，DeepSeek 官方路由、CodeBuddy、Codex 与自定义 OpenAI/Anthropic 端点对 Midscene 全部可用；凭据留在各提供方插件内，桥不接触。`/v1/midscene-env` 端点直接生成四行 MIDSCENE_MODEL_* 环境变量并自动推断模型家族；浏览器、桌面、Android、iOS、鸿蒙自动化加 Vitest E2E 与 Midscene 知识参考共 7 个内置技能随装随用，无需 `npx skills add`。npm 安装：`dsh plugin --profile web add @tnnevol/dsh-midscene`。 |
| [dsh-harmony](https://github.com/kexijiang/dsh-harmony) | tools | — | 0 | 面向 Windows x64 上的 DSH NEXT 桌面版（在 DSH NEXT 2.0.21-next + Better Sidebar 0.28.2 上验证）的鸿蒙设备工作台；悬浮投屏复用 DSH 的 Electron，没有时首次打开会下载约 140 MB 的 Electron。 |
| [dsh-hos-scrcpy](https://github.com/ns-zzj/dsh-hos-scrcpy) | vision | — | 8 | 在 DSH 网页中用 AI 操控鸿蒙手机：实时 H.264 投屏、触控与系统按键、hilog 日志，并让模型读屏、定位 UI 控件，再执行点击/长按/按键/输入。 |
| [dsh-network-engineer](https://github.com/kinggkl/dsh-network-engineer) | skill | — | 0 | 网络工程师助手预设 + 12 厂商 96 篇交换机/路由器/防火墙命令知识库技能（华为/新华三/锐捷/迪普/思科 IOS·NX-OS/Junos/Arista EOS/FortiOS/中兴/VyOS/MikroTik），支持知识库优先检索、跨厂商命令对照、拓扑与 CLI 截图识图、带引用的联网查手册，并对高危命令强制 ⚠️ 风险标注；仅回答网络工程主题。是 sososilencing/dsh-network-engineer 的社区延续版（见 NOTICE.md）；两者注册同一个 network-command-kb 技能和同一个「网络工程师助手」预设，不能与上游同装。 |
| [harmony-next.skills](https://github.com/linhay/harmony-next.skills) | skill | — | 365 | 为 DeepSeek Harness 提供 HarmonyOS NEXT 技能包、离线 API 参考及 DevEco、HDC 与模拟器自动化指南。 |
| [scenes-skill-creator](https://github.com/wasteoneslife/scenes-skill-creator) | skill | 1,242 | 0 | Web 界面上的技能创建面板：拉取官方 creator 技能，把需求交给华为云 / 通用 / REST API 三个 creator 之一执行创建，随后按 10 分制评测产物，未达 8.5 分就把逐项扣分交回 creator 修改直到通过。 |
| [dwguard-dsh-hmos](https://github.com/Dogwind221/dwguard-dsh-hmos) | workflow | 1,640 | 0 | DSH 侧鸿蒙交付编排插件：冻结四维验收任务包（可量化判据带机器可校验断言）、派发前对抗预审、以 Goal 模式交给 DevEco Code，再用独立取证（截图 / 布局树 / 日志 / 带 SHA-256 的证据包）做外部审计，按实测值重算断言判定并生成返工单；含带官方引用的规则目录、用户确认状态与闸门校准账本。 |
| [dsh-harmonyos-hiboard](https://github.com/MaybeMeibeMaybi/dsh-harmonyos-hiboard) | notify | 1,285 | 3 | 把DSH的任务结果，以服务卡片形式推送到华为鸿蒙负一屏。安装后请在插件设置页输入授权码，位置：主页面左上角「插件」→ 「dsh-harmonyos-hiboard」。 |
| [dsh-hiboard-push](https://github.com/QinpanWan/dsh-hiboard-push) | notify | — | 3 | 华为鸿蒙负一屏（智慧助手·今天）任务完成推送：hiboard_push / hiboard_verify 工具把 Markdown 任务结果推送到手机卡片流，与 OpenClaw today-task 技能线级兼容，授权码可在 dsh 设置面板配置。 |
| [huaweicloud-devkit](https://github.com/huaweicloud/huaweicloud-devkit) | dev | 9,786 | 70 | 让 AI 智能体掌握华为云全流程操作——构建、部署、运维全程受控，助您轻松安全上云。 |
| [dsh-app-packager](https://github.com/lw0129a/dsh-app-packager) | dev | 2,679 | — | uni-app x 项目打包流水线：读取本机 HBuilderX 版本，按版本推荐并一键配置对应的 iOS / Android / HarmonyOS 离线 SDK（面板卡片附官方下载入口），再按项目配置调用 HBuilderX CLI 打出、签名并上传；引擎同时以 list / doctor / check / build 四个工具暴露给 agent。 |
| [dsh-deveco](https://github.com/MoonlitDropOfBlood/dsh-deveco) | dev | 2,332 | 5 | HarmonyOS 全栈开发套件：右侧边栏提供 HiLog 检查器（实时流与级别/包名/关键词过滤）与 ArkUI Inspector（截图点选高亮、可折叠组件树、节点属性搜索、盒子模型），两种树源——DevEco 调试源（ark 调试链路，提供 padding/margin/border 声明值与自定义组件名）与 uitest 无障碍树；.ets 查看器提供 ArkTS 语法高亮；注册 harmony_ui_tree agent 工具供对话内取组件树；设置页管理 DevEco Studio/CLT 工具链与 USB/网络设备。21 个 Remote 方法，82 个单元测试。 |
| [harmonyos-dev-mcp-for-dsh](https://github.com/NormanFxxkingRockwell/harmonyos-dev-mcp-for-dsh) | dev | 804 | 2 | 把 harmonyos-dev-mcp Python MCP 服务桥接进 DSH：鸿蒙设备发现、构建/安装/运行/卸载、UI 自动化（点击/输入/按键/滑动/截图）、E2E 界面树检查、日志与崩溃分析，共 18 个 mcp__harmonyos__* 工具。 |
| [dsh-remote-control#plugin](https://github.com/MoonlitDropOfBlood/dsh-remote-control/tree/main/plugin) | remote | 1,401 | 2 | 用 HarmonyOS 手机遥控 DeepSeek Harness：浏览/切换/新建会话；发送提示词（手机跟随宿主的繁忙行为，排队或插话）；流式接收正文、思考与工具步骤；应答审批请求与提问；查看会话图片（缩略图内联 + 大图按需拉取）；切换模型与思考强度；取消运行中的任务；接收推送通知。流量端到端加密（HKDF-SHA256 派生密钥 + AES-256-GCM），经只转发密文的哑管道中继；v1.1.3 增加会话纪元抗重放握手与中继原生 TLS。中继可跑在本机（由插件托管）或 VPS 上；手机 App 与插件同仓库发布。5 个 Remote 方法。 |
| [open-whale#dsh-openwhale](https://github.com/T1gerD/open-whale/tree/main/packages/plugin) | remote | — | 1 | 把手机变成你这台电脑上 DeepSeek Harness 的个人助理——扫一次码即可远程聊天、收发图片与文件、看回复流式输出，多台手机还能在同一会话里协作；连接方式可选局域网 / Tailscale / 公网隧道。附带安卓安装包、iOS 构建流水线，以及鸿蒙和 iOS 浏览器可直接用的网页版客户端。 |


### 4.3 GPU、模型运行与性能相邻产品

以下六条是产品参照，不是昇腾专用竞品；缺失下载不被解释为没有用户。


| 插件 | 类别 | 30 日下载 | 星标 | 已声明能力 | 可借鉴点与差异 |
| --- | --- | --- | --- | --- | --- |
| [dsh-gpu-pulse](https://github.com/zhubaohi/dsh-gpu-pulse) | ui | 780 | 1 | nvidia-smi 驱动 GPU 浮条：利用率、显存、温度、功耗；无 NVIDIA 驱动降级 n/a | 借鉴设备概览与无硬件降级；差异是昇腾数据源、实验归档和基线对比 |
| [dsh-spark-scope](https://github.com/juliankang4/dsh-spark-scope) | model | 1,671 | 0 | Spark Scope 服务提供 decode/prefill、请求队列、KV、TTFT/TPOT p95、DGX Spark GPU 指标 | 借鉴端到端推理 KPI；依赖外部服务，目录没有声明昇腾适配 |
| [dsh-model-manager](https://github.com/Ansonfishing/dsh-model-manager) | model | — | 0 | 本地推理服务注册/健康/停止，llama.cpp、SGLang、vLLM 参数 profile，KV/显存检查、tok/s 测速 | 借鉴环境元信息和参数记录；MVP 不接管服务部署与启停 |
| [dsh-model-deploy](https://github.com/ethanrise/dsh-model-deploy) | dev | — | 0 | ONNX 检查，本地/SSH ONNX Runtime 测速，平均/P50/P95/P99、FPS、实际执行后端和门槛 | 借鉴真实执行后端及确定性门槛；不能从“支持远程”推断支持 CANN/NPU |
| [dsh-remote-gpu](https://github.com/NNNNyang/dsh-remote-gpu) | remote | — | 0 | 远程空闲卡、利用率/显存/温度/占用用户，同一快照同时提供面板与 remote_gpu 工具 | 借鉴工具和面板共享结果；远程连接管理留后续 |
| [dsh-agent-bench](https://github.com/songrui111/dsh-agent-bench) | dev | 814 | 1 | 隔离沙箱、固定 Agent 用例、确定性断言、两次运行退化对比 | 借鉴双运行比较与证据；其对象为 Agent 行为，不是 NPU 算子性能 |


### 4.4 生态事实：已有官方工具，缺的是 DSH 内闭环

[MindStudio Profiler（msProf）官方仓库 26.1.0 说明](https://raw.gitcode.com/Ascend/msprof/raw/26.1.0/README_EN.md) 表明：它面向训练与推理，采集和解析 CANN 与 Ascend NPU 层软件/硬件 profile 数据，包含在 CANN Toolkit 中，并提供采集、解析导出及分析流程。这足以确认“昇腾没有性能工具”的说法不成立。

本项目要补的是 DSH 内的低摩擦入口：发现可用能力、读取已有证据、把关键指标和热点解释给人看、把两次运行的变化交给 Agent 使用。现有官方性能工具作为数据来源与深度分析入口，MVP 不替代其完整时间线、算子研发和跨集群分析功能。具体版本支持必须由后续技术方案及真实样本验证确定，本文不承诺所有 CANN 导出版本通用。

调研过程：AutoGLM 搜索脚本因本地 token 服务连接被拒绝而不可用；改用可用网页搜索，查询 `site.hiascend.com msprof npu-smi 性能分析 MindStudio`，仅深读上面一份官方仓库说明。市场数字仍全部来自本地目录，没有混入网页热度或模型估计。

## 5. 三个候选方向比较

比较结论为项目决策判断，非用户实验分数。目标人群为在 DSH 内运行或分析昇腾训练/推理任务的模型开发者、性能工程师；核心工作是回答“哪里慢、为什么值得排查、这次改动是否更好”。

| 方向 | 用户价值与相邻证据 | 首版主要约束 | 无 NPU 演示可信度 | 当前决策 |
| --- | --- | --- | --- | --- |
| 性能看板 | 把设备、运行指标、热点及回归放到同一入口；gpu-pulse、spark-scope 与 agent-bench 提供形态参照 | 需统一单位、输入契约、数据来源和缺失状态；解析版本要有明确范围 | 高：固定样本可演示从导入到对比，必须标明 DEMO | **主方向**，能先形成可验收证据闭环 |
| 自动调优 | 后续可减少参数试错，理论收益高 | 需要代表性 workload、正确性约束、稳定基线、重复测量、资源预算和回滚；不同模型/硬件结论不可直接复用 | 低：模拟推荐无法证明真实加速或正确性 | **二期**，以首版运行记录、参数和对比作为输入 |
| 环境体检 | 解答 CANN/驱动/设备/工具是否可用，降低首次使用门槛 | 版本矩阵持续变化；只报告“能发现”不代表 workload 可跑 | 中高：可模拟缺依赖状态，但真机兼容性仍需验证 | **MVP 子能力**，作为采集前置检查，不独立发展成大而全修复器 |

选择看板的理由：现有工具提供数据生产基础，目录已有“硬件状态 + 推理指标 + 回归比较”的相邻需求信号，面板与 Agent 工具又分别对应 ui/tools 的高供给类别。先把证据读对、展示清楚和比较可信，才能让后续建议或调参有依据。上述是可验证的切入点假设，尚不能由 0 条专用插件直接推出用户一定愿意安装。

二期自动调优进入条件：完成至少一个实际 Ascend workload 的可复现实验；固定模型、数据、精度/正确性标准；记录硬件/CANN/框架版本；支持重复测量和波动报告；明确搜索参数范围、耗时预算和人工触发/停止；每个建议必须能回溯到基线和验证结果。首版没有这些证据时只能给排查提示，不能宣称自动提速。

## 6. 看板 MVP 边界

下面规定产品结果与验收目标；接口和数据结构由下一阶段技术方案细化。必须项如被降级需明确记录限制，不应把模拟结果当作真机验收。

### 6.1 必须具备

1. **可安装与可发现。** 交付可安装的 DSH 插件包，提供 Host 工具和 Web 性能面板；说明安装、依赖、入口、支持平台及版本范围。
2. **同一份证据服务人和 Agent。** 工具返回结构化设备/运行/对比结果；面板显示相同 run 标识、来源、时间、单位、环境与告警，避免两个口径。
3. **Host 只读采集入口。** 探测工具和设备可用性；有支持的 NPU 环境时读取设备快照或已有采集产物；对缺少命令、无设备、超时和权限不足给出明确状态。有界执行，不把任意用户字符串交给 shell。
4. **离线导入和解析。** 至少支持一类经过样本验证的昇腾性能导出 CSV/JSON 与一类基准摘要输入；声明字段、单位和版本范围。保留原始路径/来源及解析诊断。只有设备快照时不能推断算子瓶颈。
5. **关键观察和热点。** 设备概览呈现数据源可提供的利用率、HBM 使用、温度、功耗；运行概览呈现输入实际提供的吞吐和延迟；profiling 数据提供热点排行。缺失值显示“暂无/不支持”，不得显示假 0；没有逐请求样本时不自造 P95。
6. **两次运行对比。** 明确基线/候选方向，按可比指标显示绝对差和百分比，注明越高/越低越好；零基线不能直接除法，缺失值不参与改善率；环境或 workload 不一致时显示可比性警告。规则性提示引用证据，避免把相关性说成因果。
7. **无 NPU 的完整演示。** 随包提供基线、候选和至少一份设备/热点样本；用户无需 NPU 能完成导入、查看热点、对比和理解回归。全程持续标识 DEMO/演示数据，并与真实采集结果区分。
8. **可验证限制与数据控制。** 拒绝不合法输入、超大文件及不可读路径；数据默认留在 Host，不自动向外部模型或服务上传性能文件；错误能恢复且不拖垮 DSH。导入与采集均保留来源信息。
9. **交付文档。** 市场分析、技术接口与数据结构、UI 交互方案、演示步骤和已知限制齐备；实现完成后由独立审查者验证。

### 6.2 可选，时间允许再做

- 从已配置的受控 SSH 通道读取远程产物；首版可用人工拷贝后导入替代。
- 低频刷新设备快照、小型趋势线、按卡/算子搜索、导出 Markdown 比较摘要。
- 从现有服务摘要读取 TTFT/TPOT 等更细 KPI，前提是源数据定义和统计窗口清楚。
- 引导复制官方采集命令；只有工具版本和安全边界经过验证时再做受控采集执行。

### 6.3 首版不做

- 自动调参、自动修改训练代码、驱动/CANN 安装或升级、重启/终止任务。
- 调度训练/推理服务、管理集群租户和资源、自动申请云算力。
- 完整替代 MindStudio/Perfetto 时间线，通吃所有 CANN 二进制产物或所有硬件版本。
- 无样本证据的“AI 一键根因”、跨硬件性能结论、模拟的真实提速百分比。
- 自动上传完整模型、日志或 profile 到远端；MVP 不需要用户额外注册账号。

## 7. 成功标准与后续需求验证

以下是待实施阶段验收的**目标**，不是本文已经完成的实现结果。

| 编号 | 可验收标准 | 证据 |
| --- | --- | --- |
| S1 | 在声明支持的 DSH 版本从交付包安装，Host 工具与 Web 面板均可发现且可打开 | 安装命令、版本、工具清单和界面截图 |
| S2 | 无 NPU 环境可在 5 分钟演示内完成“加载样本 → 看设备/热点 → 选择基线和候选 → 看到改善与回归” | 干净环境演示步骤、持续 DEMO 标记；5 分钟仅为目标 |
| S3 | 样本关键指标、热点排序、绝对差/百分比与人工复算一致；零基线、缺值、异构环境处理可解释 | 固定样本和确定性验证输出；UI 与工具显示一致 |
| S4 | 缺命令、无设备、超时、格式错误、不可读/超限文件均显示明确可恢复错误，不崩溃或伪装成功 | 故障用例与独立审查记录 |
| S5 | 至少一个声明支持的真实 Ascend 导出样本完成解析验证，标注 CANN/工具版本及来源 | 经许可的脱敏样本或真机记录；没有真机时显式标注“采集链路未实机验收” |
| S6 | 任何“建议排查”都能追溯到具体来源、指标和规则；无自动改参和自动外发行为 | 工具结果、面板证据、实现审查 |
| S7 | 三份设计/分析文档与实现边界一致，并完成开发者自测及独立审查 | 验证命令、审查结论和已知限制 |

交付后优先找 3–5 位昇腾模型开发者做任务式访谈：他们当前如何确认设备状态、查看 profile、比较两次实验；记录完成时间、最常找不到的字段、是否愿意在 DSH 内重复使用。真实验证指标应包括首次成功导入率、对比任务完成率、每周重复使用次数及误报率；在拿到用户样本前不编造采用率或 ROI。

## 8. 复核清单与来源

1. 对本地快照计算 SHA-256，对照第 1 节；解析 `count`、`categories` 和 `plugins`，核对 9,111/23，检查每个 `category` 都有定义、URL 无重复。
2. 对 `plugins` 精确按 `category` 分组并求非空 downloads/stars 合计；下载有值记录的窗口全部为 2026-10-07 至 2026-11-05。
3. 下载/星标各自降序排序，并列时按 name、url 升序；前 20 输出 name、category、downloads、stars、url，逐行比对第 2 节。
4. 对 `name + npm + description.en + description.zh` 按第 4.1 节严格正则忽略大小写扫描，并集应为 0；华为宽扫描并集应为 22；额外专业词扫描应为 0。不要把 input/cannot/CANNBOT 当作 NPU/CANN 性能能力。
5. 用 URL 定位第 3、4 节代表插件，核对 description；报告只转述目录声明，无仓库运行验收结论。
6. 昇腾工具背景只引用已读取的 [MindStudio Profiler 官方 26.1.0 README](https://raw.gitcode.com/Ascend/msprof/raw/26.1.0/README_EN.md)，仓库入口为 [Ascend/msprof](https://gitcode.com/Ascend/msprof)。网页内容读取于 2026-11-07，不参与目录排名计算。

本文的可确认结论是：指定 DSH 目录有广泛的界面、工具、观测与自动化需求信号，却没有显式昇腾/NPU/CANN 专用条目；先做可安装、可演示、可复核的性能看板，是比首版自动调优更容易验证的切入点。对实际使用频率、硬件兼容覆盖和真实调优收益仍需后续实验。
