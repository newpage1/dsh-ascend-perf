# 昇腾性能工作台 —— 自测与安装验证记录

> 任务：t4（实现可安装 DSH 插件 `dsh-ascend-perf`）
> 环境：macOS（无 NPU）、DSH `0.2.1-rc.2`、Node `v25.5.0`
> 记录时间：2026-11-07 01:35 CST；真实页面复验：2026-11-07 11:07 CST
> 结论：**Host 工具、REST 路由、安装/卸载、自测全部通过；真实 Web 页面已用 Playwright 取证：面板自动展开、采集目标表单、粘贴导入、对比、演示、真实 SSH 只读采集（8 卡 16 chip）均可用；详见 §7。**

## 1. 文件清单

| 路径 | 行数/说明 |
| --- | --- |
| `ascend-perf/package.json` | manifest：name `dsh-ascend-perf`、version `0.1.0`、`dsh.bundle.patch`、`dsh.client` |
| `ascend-perf/cordis.patch.yml` | `insert` 条目 `id: dsh-ascend-perf`，`config.demoMode: false` |
| `ascend-perf/index.js` | 2709 行，Host 侧（多环境采集/轮询、解析/导入/存储/对比/洞察/工具/REST） |
| `ascend-perf/client.js` | 1803 行，Client 侧（右侧栏面板、多环境编辑与展示、locale、tab 注册） |
| `ascend-perf/icon.svg` | 原创图标 |
| `ascend-perf/locale/{zh,en}.json` | 面板/动作/状态/指标/对比/洞察/错误文案 |
| `ascend-perf/fixtures/` | 11 个 fixture + `README.md` |
| `ascend-perf/test/run-tests.mjs` | 44 项自测（解析/归一化/对比/洞察/存储/工具/REST/Client 注册/多环境 settings v2） |
| `ascend-perf/README.md` | 安装、配置、演示、导入、对比、洞察、隐私、自测、限制 |

## 2. 安装与卸载

```bash
# 首次安装（pnpm 链接到 profile）
plugin_manager install_bundle target=/Users/hexiaoying/workspace/ascend-perf
```

首次安装激活失败，诊断为 `cannot set property "ascendPerf" without provide`；删除无用的
`ctx.set('ascendPerf', …)` 后重装成功：

```text
bundle=dsh-ascend-perf version=0.1.0, application=applied, warnings=none
```

- 条目 id：`include:dsh-ascend-perf`（`list_plugins` 中 `enabled=true`、`fiberPhase=active`）
- profile：`/Users/hexiaoying/.dsh/profiles/web`
- 链接：`node_modules/dsh-ascend-perf -> ../../../../workspace/ascend-perf`
- 卸载：`remove_bundle target=dsh-ascend-perf` → `application=applied`，profile 依赖与链接均被移除；
  再安装可恢复 active（安装/卸载可复现）。

## 3. 语法与自测

```bash
node --check ascend-perf/index.js     # exit 0
node --check ascend-perf/client.js    # exit 0
node ascend-perf/test/run-tests.mjs   # 42 passed, 0 failed（含 /config、空态快照落库、调优 4 工具）
```

覆盖点（节选）：

- `npu-smi info`：8 卡 16 chip 去重、chip1 `power_w=null`、缺字段 `missing_reasons`、进程表解析。
- `-t usages`：必须逐卡 `-i N`；两个 Chip ID 不串值；缺卡时 `USAGES_INCOMPLETE` 警告。
- vLLM JSON / benchmark CSV / msprof CSV 导入：别名、派生吞吐、sha256 幂等、坏行整批拒绝、
  1 MiB 上限、`skip_bad_rows`、热点 share、缺值 null。
- 对比：5%/20% 阈值、`improved/regressed/stable/descriptive/missing/zero_baseline`、
  `matched/mismatch/unknown` 与结论五值。
- 洞察：`TTFT_REGRESSION`、`SUCCESS_LOW`、`HOTSPOT_CONCENTRATION`、`HBM_PRESSURE`、
  `TEMP_HIGH`、`POWER_CHANGE`、并发饱和 heuristic、空输入 `skipped_rules`。
- 存储：`0600`、原子写、损坏隔离 `quarantine/` 并从 `bak` 恢复。
- 工具：`apply` 注册 4 个工具与 `/api/ascend-perf` 前缀路由；无 npu-smi 时
  `status=empty` / `availability=command_missing` / `COMMAND_MISSING`，不抛错。
- Client：stub `window.__ModuleLoader__` 加载 `client.js`，断言 tab（`dsh-ascend-perf` / `ascend-perf`、
  `multiple=false`、guide order 70）、两个 keyed slot、zh/en 字典。
- R1：REST 鉴权 fail-closed——无 `connection` → 503 `AUTH_UNAVAILABLE`；`requestRejection` 抛错 → 500
  `AUTH_ERROR`；返回 401 → 透传 401；明确放行才 200。
- R3：演示/真实分仓——`store.json` 中 `runs` 与 `demo_runs` 分离、演示开关不持久化；重启后只看到真实运行；
  演示态导入的真实数据不可见但落真实仓；混合对比抛 `INVALID_ARGUMENT`；`/demo {enabled:false}` 可切回真实态；
  旧仓储中混放的演示条目在加载时迁出，下一次保存后磁盘结构也保持分离。

## 4. Host 工具实测

| 调用 | 结果 |
| --- | --- |
| `ascend_status {refresh:true,target:"local"}` | “昇腾状态采集失败：COMMAND_MISSING 未找到 npu-smi” —— 本机无 NPU，降级正确，未执行任何修改性命令 |
| `ascend_perf_import {action:"load_demo"}` | 导入 2 条演示运行：`demo-baseline`、`demo-candidate` |
| `ascend_perf_import {action:"list"}` | 2 条运行；store 位于 `~/.local/share/dsh-ascend-perf/store.json` |
| `ascend_perf_compare {baseline,candidate}` | 结论 `regressed`、可比性 `matched`、阈值 ±5%；output 1240→1178（-5.00%）、TTFT p50 190→215.2（+13.26%）、TTFT p99 620→700.6（+13.00%）、TPOT/ITL stable |
| `ascend_perf_insight {…}` | warning “TTFT p99 回归 13%（620 → 700.6 ms）”；info “算子 aclnnMatmul 占总任务耗时 42.1%” |

Inspect 佐证：`host Tool.listTools` 输出中可 grep 到
`ascend_status` / `ascend_perf_import` / `ascend_perf_compare` / `ascend_perf_insight` 四个工具名
（spill 文件 `…/session-3f43c6e68de3/9e444bdae9b2-cordis_inspect_query.txt`）。

### 运行期缺陷（已修复）

1. `ascend_perf_compare` 首次报 `value is not lossless JSON`：`adverse_delta_pct = -0` 经 JSON 往返变 `0`。
   已对 `delta_abs/delta_pct/adverse` 做 `Object.is(x,-0) → 0` 归一。
2. `renderImport` 对所有 action 都显示“已导入 N 条运行”：改为按 `action` 分支，并输出完整 `run_id`
   （原先截断前 12 字符，两条 demo run 的显示 id 相同）。
3. 其余运行期调用（`ascend_status` / `ascend_perf_insight` / REST）未发现新缺陷。

安装阶段另有一处启动失败：`ctx.set('ascendPerf', …)` 未先 `provide`，导致
`cannot set property "ascendPerf" without provide`；该行无实际消费方，删除后激活成功。

## 5. REST 路由

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/api/ascend-perf/state
# 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/api/ascend-perf/__nope
# 401（鉴权在路由分发前拦截，说明路由已挂载）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/api/ascend-perf2/state
# 401（未命中本插件前缀）
```

`401` 来自 `ctx.connection.requestRejection`：本 agent 的 shell 请求没有浏览器会话凭据，
因此未绕过鉴权，也未伪造登录态。

## 6. Client 面板挂载与取证

已核实并完成：

- `client.js` 通过 `window.__ModuleLoader__.load({ id: 'dsh-ascend-perf', factory })` 暴露
  `{ inject: ['slots','locale','sidebarRightTabs','sidebarRight'], apply }`。
- `apply` 注册 locale（zh/en）、`sidebarRightTabs.register({ id, kind, multiple:false, guide order 70 })`、
  两个 keyed slot：`sidebar.right.pane.tab#dsh-ascend-perf`、`sidebar.right.pane.tab.title#dsh-ascend-perf`。
- Client 注册项在 Node 侧加载并执行 `client.js`，验证上述注册行为（当前全量 42 passed）。

**已取得真实页面证据**：见 §7；`docs/screenshots/real-npu.png` 是真实 SSH 采集的设备区截图（无主机/IP）。

原因（同一限制在 t2 已出现）：

```text
cordis_inspect_query client Slots.listSubTree
→ timed out after 10000ms. Open or reconnect the Harness page, then retry.

cordis_inspect_query client Builtin.listBuiltins
→ timed out after 10000ms. Open or reconnect the Harness page, then retry.
```

即本机没有处于握手中的 Client 页面（`http://127.0.0.1:3080/` 的 HTML 也返回 401，
`window.__DSH_BOOT__` 无法从 shell 读取）；Chrome 进程虽在运行，但未开 CDP 9222，
AppleScript 读取标签页触发权限弹窗后挂起（已 kill）。插件使用说明明确禁止另起浏览器或伪造
mock 截图，因此未采用这些手段。

**给审查者/t5 的复核步骤**（需要用户在 GUI 页面侧操作）：

1. 确认 `include:dsh-ascend-perf` 仍是 active（本记录写作时是）。
2. 刷新 `http://127.0.0.1:3080` 页面（Client 插件在页面加载时装配）。
3. 右侧栏 → 插件入口/引导中应出现“昇腾性能”；打开后应看到“设备与环境 / 运行与对比 / 洞察”三区。
4. 点击“加载演示数据” → 出现 2 条运行；选择基线/候选 → 对比结论 `regressed` 与 TTFT 回归洞察。

在取得第 2–4 步的页面证据前，本任务对 Client 的验证等级为
**“静态契约 + 加载级自测通过，运行时可视化未验证”**，不应表述为“UI 已验收”。

## 7. 只读与隐私自查

- 插件不启动/停止任何容器或服务，不运行 benchmark，不写远端；`npu-smi` 只调用 `info` 与
  `info -t usages -i N`。
- SSH 采集固定 `BatchMode`/`StrictHostKeyChecking=yes`，只接受 alias 与受控远端命令，不读私钥内容。
- 导入只接受浏览器内的 UTF-8 内容（≤1 MiB），不接受 URL/任意路径。
- 数据目录 `~/.local/share/dsh-ascend-perf` 权限 `0700/0600`，`store.json` 原子写 + `bak`。
- 仓库内无凭据；fixtures 与样例均已脱敏（NFS 服务端地址掩码为 `192.168.0.x`）。

## 8. 复现命令

```bash
cd /Users/hexiaoying/workspace
node --check ascend-perf/index.js
node --check ascend-perf/client.js
node ascend-perf/test/run-tests.mjs
# 安装（幂等）
plugin_manager install_bundle target=/Users/hexiaoying/workspace/ascend-perf
```

## 9. t5 findings 收尾（t11）

| 编号 | 处理 | 证据 |
| --- | --- | --- |
| R1 | REST 鉴权改为 fail-closed：无 `connection` → 503 `AUTH_UNAVAILABLE`；`requestRejection` 异常 → 500 `AUTH_ERROR`；未认证 → 透传 401；仅显式放行才继续 | `index.js` 路由 handler；自测“R1：REST 鉴权 fail-closed” |
| R2 | 真实主机信息移出插件目录：`ascend-perf/scripts/npu-ssh.md` → `~/.config/ascend-perf/npu-ssh.md`（0600，目录 0700）；插件内改为 `scripts/npu-ssh.template.md` 占位模板，并更新 `README.md`、`docs/real-env-report.md`、`scripts/npu-env.sh` 引用 | `grep` 确认插件目录内 4 个真实 IP 与 `root@<IP>` 零命中 |
| R3 | 演示数据与真实/导入数据分仓：`store.json` 新增 `demo_runs`/`demo_snapshots`，旧仓储加载时按 `source.is_demo` 迁出；演示开关改为进程内状态、不跨重启持久化；混合对比拒绝；客户端在演示态导入时提示“退出演示后可见” | 自测“R3：演示数据与真实数据隔离……”；`store.json` 分仓断言 |
| R4 | UI 运行时可视化已用 Playwright 在真实页面取得证据（自动展开、表单、导入、对比、演示、真实 SSH）；见 §12 | 本节与 §12 |

补充：`~/.config/ascend-perf/npu-ssh.md` 与 `npu.env` 均为 `0600`，目录 `0700`；插件目录内不再包含任何真实主机/IP/凭据。

## 10. t9 二期调优验证

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 语法 | `node --check index.js`、`node --check client.js`、`node --check tune.js`、`node --check tune-exec.js` 全部 exit 0 | 见 §11 命令记录 |
| 自测 | `node ascend-perf/test/run-tests.mjs` → **42 passed, 0 failed** | 覆盖规格校验、plan/hash、random 确定性、vLLM JSON/CSV、失败/超时/缺字段分类、预算终止、暂停/恢复/停止幂等、重启恢复、真实执行门、argv 防注入、端口锁、只清理自有句柄 |
| 调优工具 | `ascend_tune_plan` / `ascend_tune_run` / `ascend_tune_status` / `ascend_tune_report` 已注册（共 8 个工具） | `cordis_inspect_query host Tool.listTools` 可检索到 8 个工具名 |
| demo 闭环 | 规格 → dry-run（不启动服务）→ demo 运行 → 报告（推荐/provisional、Pareto、失败分类、limitations） | 自测 “TuneService：plan→dry-run→demo run→status→report 闭环” 与 “tools/routes：4 个调优工具注册……” |
| 真实执行默认禁用 | demo 之外的计划带 `REAL_EXECUTION_DISABLED`/`TARGET_READONLY` 阻断项；Start 不创建作业、不 spawn | 自测 “安全：真实执行默认禁用……”；`realExecutionGate` 用例 |
| 只清理自有进程 | `OwnedProcessRunner.terminateOwned` 对非自有句柄返回 false；`PortLock` 占用即失败且不杀进程 | 自测 “OwnedProcessRunner/PortLock……” |
| 共享环境 | 未连接 NPU、未启停服务/容器、未跑 benchmark、未写远端；demo 执行器零真实副作用 | 本任务全程只读本机文件；测试使用 `mkdtemp` 临时目录 |
| UI 双 tab | `client.js` 注册“昇腾性能”（id `dsh-ascend-perf`）与“性能调优”（id `dsh-ascend-perf-tune`）两个右侧栏 tab、四个 keyed slot、zh/en 字典 | 自测 “client.js：ModuleLoader 工厂注册观测/调优双 tab……” |
| UI 运行时可视化 | 已用 Playwright 在真实页面取证：自动展开、表单、粘贴导入、对比、演示、真实 SSH 8 卡 16 chip | 见 §12；`docs/screenshots/real-npu.png` |

## 11. t9 验证命令记录

```text
$ node --check ascend-perf/index.js      # exit 0
$ node --check ascend-perf/client.js     # exit 0
$ node --check ascend-perf/tune.js       # exit 0
$ node --check ascend-perf/tune-exec.js  # exit 0
$ node ascend-perf/test/run-tests.mjs    # 42 passed, 0 failed
```


## 12. 真实 Web 页面复验（2026-11-07 11:07 CST）

环境：macOS + DSH `0.2.1-rc.2`；用 Playwright（Chromium 1217）+ DSH 启动 URL token 加载真实页面，不使用伪造会话。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 面板可见 | 每次页面加载自动打开 `ascend-perf` tab，并在 `isExpanded()===false` 时 `toggleExpanded()`；折叠后刷新仍可见（`AFTER_RELOAD_VISIBLE=true`）；`采集目标` 可见（box x=816, y=97） | `/tmp/ascend-expanded.png`（本地） |
| 采集目标表单 | 本机/SSH 切换、SSH 目标、npu-smi 路径、超时、保存并采集；保存后 `POST /config` 再刷新 `/status` | 页面文本 + `/config` 200 |
| 导入 | 弹窗含可见文件选择 + 粘贴 textarea；粘贴 vLLM JSON 后 `解析并导入` 成功，runs 4→5；测试后已删除该 run | `/tmp/ascend-imported.png`（本地） |
| 对比 | 默认 baseline/candidate 点击“开始对比”，返回“存在性能改善，0 回归 · 3 改善 · 7 稳定” | `/tmp/ascend-compare.png`（本地） |
| 演示 | “加载演示数据”显示 DEMO 横幅、8 NPU / 16 chip；随后 `POST /demo {enabled:false}` 退出 | `/tmp/ascend-demo.png`（本地） |
| 真实 SSH 只读 | 面板填 `user@host` 后 `POST /status` 返回 `status=ok`、`source.mode=ssh`、`is_demo=false`、8 cards / 16 chips、npu-smi 26.1.1、CANN 8.1.RC2；未启停服务/容器、未写远端 | `docs/screenshots/real-npu.png` |
| 空态/失败态 | 本机无 npu-smi 时显示 `COMMAND_MISSING: 未找到 npu-smi`，并直接提供“加载演示数据” | 页面文本 |
| 回归测试 | `node --check index.js`、`node --check client.js`、`node test/run-tests.mjs` → 42 passed / 0 failed | 本地输出 |

修复记录：

- 右侧栏只注册 tab、未展开：`openTab` 后若 `!sidebarRight.isExpanded()` 则 `toggleExpanded()`；每个浏览器会话自动尝试一次，失败重试 10 次。
- 空态/失败态采集（command_missing 等）没有 `out.snapshot`，导致 `/state` 永远为 null：`collect()` 现把 `result.data` 快照也落库；回归测试已加。
- 配置只有 cordis config、没有 UI：新增 `/config` GET/POST + `settings.json`（0600）；SSH 目标支持 `user@host`。
- 导入只有隐藏 file input：新增粘贴 textarea 与可见文件选择。


## 13. 真实 Web 页面复验：滚动、设备摘要与卡详情（2026-11-07 15:30 CST）

背景：用户反馈面板"不能往下翻页，下面的数据根本看不到"、"NPU 具体信息要简单展示、展示其他性能数据"。环境同 §12（Playwright + Chromium 1217，视口 1440×820），无 console error。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 面板内滚动 | 面板根节点 `overflowY:auto` + `height/maxHeight:100%`；视口 820 下内容 2195px，可滚 1413px；鼠标滚轮 6 次后 `scrollTop=261/261`（收起卡详情时） | `docs/screenshots/real-page-scroll.png` |
| 设备摘要（新增） | 顶部摘要卡：`型号/拓扑`（Ascend910 · 8 卡 / 16 chip）、`芯片温度` min–max、`总功耗` 合计、`AICore 利用率` min–max（≥90% 告警色）、`HBM 显存` used/total GiB（含使用率，≥75% 告警 / ≥90% 严重）、`占用进程` top3（VLLMWorker_TP ×N）；全部来自真实 SSH 只读快照 | `docs/screenshots/real-page-summary.png` |
| 卡详情折叠 | 默认收起，按钮"展开 8 卡详情"点击后出现 NPU 0–7 卡块与 chip 明细 | `docs/screenshots/real-page-bottom.png` |
| 底部可达 | 滚到底后 `运行与对比`、`性能洞察`、只读声明可见 | 同上 |
| 回归测试 | `node --check client.js`、`node test/run-tests.mjs` → 42 passed / 0 failed | 本地输出 |

实现要点：

- `client.js` `s.root` 增加 `height:'100%', maxHeight:'100%', minHeight:0, boxSizing:'border-box', overflowY:'auto', overscrollBehavior:'contain'`（Panel 与 TunePanel 共用），不再依赖外层 pane 滚动。
- `renderSnapshot` 拆出 `DeviceSummary`（`aggChips` 聚合 chips 的 temp/power/aicore/HBM/进程，缺值自动跳过）与 `CardsBlock`（默认折叠，保留 `CardBlock`/`ChipRow` 全量明细）；阈值：温度 ≥70°C 告警 / ≥80°C 严重、AICore ≥90% 告警、HBM ≥75% 告警 / ≥90% 严重。
- locale 新增 `device.model/temp/power/aicore/hbm/procs/showCards/hideCards`（zh/en，client 内嵌 + `locale/{zh,en}.json`）。

## 14. 多环境占用（settings v2，2026-11-07 15:4x CST）

需求（m01249）：配置了多少个环境就显示多少个环境的占用信息；静默采集 5 分钟一次；支持手动刷新；卡详情可展开。

实现与验证（无头测试）：

| 项 | 结果 | 证据 |
| --- | --- | --- |
| settings v2 结构（version/pollIntervalMs/envs≤16，env 校验 mode/alias/path/timeout/id） | 通过 | `test/run-tests.mjs` 多环境两用例；`node test/run-tests.mjs` → 44 passed / 0 failed |
| v1 自动迁移 + `npu-ssh.md`/`npu.env` 播种（hostAlias 去重、重启不再重复播种） | 通过 | 同上（`多环境：v1 settings 迁移去重…`） |
| `env_states` 仅存每环境最新记录（含失败 availability 与采集时间） | 通过 | 同上（`/state` envs 断言） |
| `/status {refresh_all}` 全量、`/status {env_id}` 单环境、未知 env_id 400 | 通过 | 同上 |
| `/config POST` v2 整体替换（坏别名/空数组/>16/interval 过小均 400）+ settings.json 0600 持久化 + 重启恢复 | 通过 | 同上 |
| 轮询生命周期（apply 启动 2.5s 首采 + interval 5min，ctx.effect 清理；`/config` 改 envs/interval 后重启定时器） | 通过（代码路径 + 生命周期 effect 注册） | `index.js` startEnvPolling/restartEnvPolling/stopEnvPolling |
| 内嵌 zh/en 字典 193 键对称；locale/{zh,en}.json 同步至 206 键（Object.keys 计数，含全部 193 个内嵌键 + 13 个历史键） | 通过 | 同步脚本输出 `zh 193 en 193 onlyZh [] onlyEn []` |

真实页面复验（Playwright 无头 Chromium + 当前 dsh web token，2026-11-07 15:55 CST，重载插件后）：

| 检查项 | 结果 |
| --- | --- |
| 「多环境占用」区块 + 4 个环境块（4 个 root@ 内网目标，自动播种自 `~/.config/ascend-perf/npu-ssh.md`，真实 IP 只保留在该 0600 文件中） | 通过，4 个 OK 状态 Pill |
| 每环境摘要卡（型号/拓扑、占用进程如 `VLLMWorker_DP ×16`）+「展开 8 卡详情」 | 通过 |
| 「每 5 分钟静默采集一次，也可手动刷新」提示 +「刷新全部」+ 每环境独立「刷新」（4 个） | 通过 |
| 单环境手动刷新后面板健康（无"读取失败"） | 通过 |
| 环境编辑器（名称/模式/SSH 目标/路径/超时/启用 + 静默采集间隔分钟） | 通过 |
| 面板内滚动（scrollHeight 3393 / clientHeight 782，scrollTop 500 生效） | 通过 |
| console/page 错误 | 0 |
| 截图 | `docs/screenshots/real-page-multienv.png`、`real-page-multienv-scroll.png` |
| settings.json 迁移 | v2（version 2、pollIntervalMs 300000、4 envs），store.json `env_states` 4 条、各 8 卡、availability 'available' |

自动打开窗口修正：无已开会话时 `sidebarRight.openTab` 会抛错，重试窗口从 10×700ms 扩到 150×800ms（约 2 分钟），覆盖"页面加载后才打开第一个会话"的场景。

安全边界不变：多环境采集沿用 `collectSsh/collectLocal` 只读命令白名单（`npu-smi info`、逐卡 `info -t usages -i N`、版本查询、`ps/ss/df/free/ls/cat/pip show/docker ps`），SSH 参数固定 `BatchMode=yes StrictHostKeyChecking=yes ClearAllForwardings=yes`，alias 白名单 `^[A-Za-z0-9_.:@-]+$` 且禁止前导 `-`（防 flag 注入）；不启停任何服务/容器，不写远端。

## 15. UI v1.2 占用视图：envs.json 配置文件化（t17，2026-11-07 16:3x CST）

需求（m01516）：「配置出页面、占用为中心、卡详情展开、频率走配置文件」；t16 `docs/ui-design.md` §14 为实现规范；captain 补充视觉规范（参考 sirlab.tech/usage，留档 `/tmp/sirlab-usage.html`）。

### 15.1 配置文件化（Host 侧）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| `~/.config/ascend-perf/envs.json`（version 1 / pollIntervalMs / envs，0600）为唯一写入口；publicConfig 暴露 `configFile` | 通过 | `test/run-tests.mjs`「多环境：npu-ssh.md 自动播种写 envs.json…」 |
| 读取优先级：envs.json → 迁移 settings.json（v2 多环境 / v1 单目标）→ npu-ssh.md/npu.env 播种；settings.json 保留不删 | 通过 | 「配置文件化：settings.json v2 自动迁移到 envs.json…」 |
| envs.json 与 settings.json 冲突时以 envs.json 为准 | 通过 | 同上（覆盖 env-x 后重启仅 1 环境） |
| envs.json 损坏 → `/state` 顶层 `envs_config_error.code=CONFIG_READ_FAILED`，原文件不被覆盖，不产生 settings.json | 通过 | 「配置文件化：envs.json 损坏…」 |
| v2 POST `/config`（envs/pollIntervalMs）改写 envs.json；v1 路径（target/ssh 别名等）仍写 settings.json（向后兼容） | 通过 | 「多环境：v1 settings 迁移去重…」（settings.json v1 内容原样保留断言） |
| 「刷新全部」前重新读取 envs.json（改完文件点一次刷新即生效，变更时重建轮询定时器） | 通过（代码路径 `reloadEnvsConfig()` + `/status refresh_all` 路由） | `index.js` |

### 15.2 占用汇总（Host 侧，导出函数）

`chipOccupancyState(chip)`：observed 且有进程 → 占用；HBM ≥5%（`hbm_usage_rate_pct` 缺失时 used/total 折算）→ 占用；AICore ≥5% → 占用；否则 `none_reported`/`unknown` → 未知，`observed` → 空闲。`summarizeEnvOccupancy(snapshot)`：非 available 快照返回 null；`total=占用+空闲`（未知不计分母）；档位 idle（0 占用）/ busy（≥⌈0.75×total⌉，total<4 需全部）/ partial / unknown（total=0）；`top_processes` 按同名进程聚合 count 与显存 MB 求和取 Top3。`/state` envs 每项新增 `occupancy: {state, busy_chip_count, total_chip_count, unknown_chip_count, chip_count, top_processes}`。单元测试 16 组断言（含 total<4 边界、未知不进分母、聚合 Σ5120MB）全绿。

### 15.3 占用视图（client.js）

- `EnvEditorForm`/`SetupSection` 删除：页面 DOM 零采集配置输入控件（渲染测试遍历断言无 `input/select/textarea`）；`Panel` 不再调用 `/config POST`；`multiEnv` 判定放宽为 `!state.demo`。
- `EnvsSection` v1.2：只读 `ConfigBar`（配置文件路径 mono tag，>48 字符截中段 22…22，点击复制，title 显示全路径；无路径时降级为「环境在配置文件中管理 · 每 N 分钟自动采集」）+ 环境块排序（空闲→部分占用→高负载→占用未知→已停用，同档名称字典序）+ 空态（指引配置文件 + 刷新全部 + 加载演示）+ `envs_config_error` 面板级错误卡。
- `EnvBlock`：`OccupancyPill`（8px 状态点 + 档位文案 + `{occ}/{total}`，aria-label 为完整判定句）为第一徽标；连接态（连接失败/缺少 npu-smi/未检测到 NPU/未采集/数据过期）降级为描边小角标 `ConnBadge`；chip 异常小字注记；已停用 60% 透明 + 「停用仅停止自动采集，仍可手动刷新」。
- 卡体三层：`OccProcRow`（占用进程聚合 `名称 ×count ΣGiB` mono 表格行；无可见进程按档位如实标注）→ `EnvMetricSummary`（型号卡数/温度区间/功耗/AICore 区间/HBM Σused/Σtotal+占比，70/80°C、90%、75/90% 只着色不改档）→ `ChipStrip`（role=list，每 chip 一格：占用琥珀实心/空闲绿弱描边/未知灰虚线，aria-label 逐格）。
- `CardsBlock`/`CardBlock`/`ChipRow`：卡头 UDot + `NPU{id} 型号 功耗 {occ}/{n} chip 占用` tag；chip 态三态描边 + 三态小徽标 + health Pill；指标 2×5（温度/功耗/AICore/NPU 利用率/HBM 用量+折算率）mono tabular-nums；进程行 `pid name MB`。
- 视觉对照（sirlab.tech/usage）：tokens 落地 `panel #FFFFFF / panel-2 #F4F7FB / panel-3 #E7EDF5`、边框 `#D5DEE9/#E3E9F1`、文字 `#16202E/#475569/#6B7A8C`、语义色 `空闲 #059669 / 占用 #D97706 / 信息 #0891B2 / 告警 #DC2626 / accent #0284C7`、阴影 `0 8px 24px -14px rgba(15,40,80,.28)`、mono 栈 `'JetBrains Mono','Cascadia Code',Consolas` + `font-variant-numeric: tabular-nums`；环境卡 12px 圆角；根容器双 radial-gradient 光晕（透明度 ≤6%）。数据结构/占用判定/刷新与折叠交互与 §14 一致，纯视觉层。
- locale：client 内嵌 zh/en 各 193 键（删 setup.* 17 键、action.saveConfig/saving、envs 编辑器 17 键；新增占用视图 39 键）；`locale/{zh,en}.json` 同步至 205 键，parity 校验 `zh 193 en 193 onlyZh [] onlyEn []`。
- 数据-testid 锚点：`envs.configbar` / `envs.empty` / `envs.block.{id}`(+`.pill/.procs/.strip/.refresh`) / `envs.chip.{card_id}.{chip_id}` / `envs.chiprow.{chip_id}`，渲染测试逐一断言。

### 15.4 回归

`node --check index.js client.js tune.js tune-exec.js` 全部 exit 0；`node test/run-tests.mjs` → **49 passed / 0 failed**（新增/改写 7 个用例：envs.json 播种、v1 迁移写 envs.json、v2 迁移与优先级、损坏配置容错、占用汇总单元、占用视图渲染、空态/错误态）。

语义不变项复验：`/state`（schema/runs/snapshot/envs 字段仅增不减）、`/status {refresh_all}`、`/status {env_id}`、`env_states` 仓储、R1 鉴权 fail-closed、R3 演示分仓、调优全链路——由既有用例原样通过覆盖。

真实页面复验（截图）由 captain 按只读边界执行，本节仅记录无头测试证据；`docs/screenshots/real-page-multienv*.png` 为 v1.1 编辑器版旧照。

### 15.5 t18 修正：占用判定收窄 unknown + chip 标签带卡号（2026-11-07 16:5x CST）

用户反馈（m01656）：①空闲机（无进程 + HBM 4.x% 基线）整体显示"占用未知"，判定过保守；②ChipStrip 标签 `c0/c1` 重复无法区分卡号。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| `none_reported`（npu-smi 正常返回、进程列表空）+ HBM<5% + AICore<5% → **idle**（原 unknown） | 通过 | `test/run-tests.mjs` 占用汇总用例：`t18：none_reported+低指标 → 空闲`、`t18：none_reported+HBM 4.x% 基线 → 空闲` |
| unknown 仅在 `processes_state='unknown'`（采集/解析异常）时出现 | 通过 | `t18：仅 processes_state=unknown（解析异常）→ 未知`；环境级"全 unknown → total 0 → unknown"用例改为双 unknown chip |
| 用户反馈场景锁定：8 卡 × 2 chip 全 none_reported + HBM 4.4% → 环境档=空闲（busy 0/16，unknown 0） | 通过 | 新增 `userCase` 断言（`state='idle', busy_chip_count=0, total_chip_count=16`） |
| occupied 判定不变（可见进程 / HBM≥5% / AICore≥5%） | 通过 | 既有 occupied 三断言原样通过 |
| index.js `chipOccupancyState` 与 client.js `chipOccState` 规则同步 | 通过 | client 测试：`chipOccState(none_reported+4.4%)='idle'`、`chipOccState(unknown)='unknown'`、`deriveEnvOccupancy` 空闲机 → idle 档 0/4 |
| ChipStrip 标签 `c{card_id}.{chip_id}`（如 c0.7、c3.1=卡3 chip1），title/aria-label 同步，条下新增图例行（zh「c卡号.chip号 · c3.1 = 卡3 chip1」，data-testid=envs.chiplegend） | 通过 | 渲染测试断言 text 含 `c0.7`、不含裸 `c7`、含图例文案、含 testid |
| locale 同步 | client 内嵌 zh/en + `locale/{zh,en}.json` 各加 `envs.chipLegend`（206 键） | json 加载 + 渲染测试（t 从 zh 字典构造） |
| 回归 | `node --check index.js client.js` exit 0；`node test/run-tests.mjs` → 49 passed / 0 failed | 本地输出 |

README §设备状态措辞同步更正（占用未知定义收窄 + c3.1 标签说明）。真实页面复验（重载插件后）由 captain 执行。

### 15.6 t19 环境卡瘦身：默认一行内联摘要，完整指标收进展开详情（2026-11-07 16:5x CST）

用户反馈（m01696）：型号/拓扑、温度、功耗等多行摘要平铺在默认视图太占地方、是噪音——"根本不需要展开来看到"。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 默认视图移除五行指标摘要平铺（型号/温度/功耗/AICore/HBM cell 列表） | 通过 | 渲染测试断言默认树不含「型号 / 拓扑/芯片温度/总功耗/AICore 利用率/HBM 显存」任一标签 |
| 默认改为卡尾一行 muted 内联摘要：`Ascend 910B3 · 16 chip · 45–60 °C · ≈3.3 kW · HBM 8/512 GiB（2%）`（12px mono tabular-nums、单行 ellipsis、title 全文） | 通过 | `data-testid=envs.block.{id}.inline` 文本断言：型号/chip 数/温度区间/kW 格式/HBM used/total+整体占比逐项命中 |
| 缺项自动跳过 | 通过 | 无温度/功耗/HBM 数据 → 摘要仅剩 `Ascend 910B · 2 chip` |
| 完整指标保留在展开详情（EnvMetricSummary 五行明细随「展开 N 卡详情」显示，逐卡逐 chip 不变） | 通过 | rawWalk 断言 EnvBlock 将 EnvMetricSummary 作为 summary 传入 CardsBlock；组件直渲含全部五行标签；展开入口文案保留 |
| 空闲环境更紧凑：无占用进程不渲染占位行（原「无占用进程」行删除） | 通过 | 空闲环境树无 `envs.block.{id}.procs` testid、无「无占用进程」文案 |
| 视觉统一：图例行 11px、卡体间距 6px | 通过 | client.js 样式（ChipStrip legend fontSize 11px；hasView 体 gap 6px） |
| locale 同步 | 通过 | 新增 `envs.inlineTitle`（zh 指标摘要 / en Metric summary）；client 内嵌 zh/en 与 locale/{zh,en}.json 各 207 键，parity=True |
| 回归 | 通过 | `node --check index.js client.js` exit 0；`node test/run-tests.mjs` → 50 passed / 0 failed（新增 t19 用例） |

真实页面复验（重载插件后默认视图/展开态截图）由 captain 执行。

### 15.7 t19 真实 Web 页面复验 + 取证方法修正（2026-11-07 17:0x CST）

本轮取证发现并修正了此前真实页面验证的方法论缺陷，并以修正后的方法完成 t19 复验：

**方法论修正（重要）**：
1. Playwright 新 context 打开的「进行中」会话即本对话本身，聊天记录包含「刷新全部/空闲/高负载/型号」等所有面板词汇——此前基于 `document.body.textContent` 的文本断言被聊天区污染，不可作为面板证据。修正：先点 `aria-label="打开右侧边栏"` 展开侧栏，再点击右侧栏 tab 条上精确文本为「昇腾性能」的按钮，再锚定「刷新全部」按钮所属面板容器做全部断言。
2. 面板 DOM 相邻行内元素在 `textContent` 中无空格拼接（「展开8卡详情」「Ascend 910B3·16 chip」），断言需用无空格模式。
3. 生产 DOM 不携带 `data-testid`（h() 不透传未知属性，仅测试渲染器有）；生产断言只能用文本/按钮锚点。
4. 认证：`/?token=<lAfh_…>` URL 流在 headless 浏览器可用；旧 cookie jar 直接注入会出现首页 401 竞态。
5. 已知限制：全新浏览器 context 中 auto-open 未能在重试窗口内自行展开侧栏并激活 tab（openTab 持续抛错原因未定位，用户真实浏览器因 tab 持久化不受影响）；已记录，后续迭代修复。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 面板挂载与激活 | 通过 | 点击 tab 条「昇腾性能」后「刷新全部」按钮存在，面板容器 623×1001、内容无溢出（scrollHeight 999=clientHeight） |
| 4 环境全部渲染（2026-11-07 17:09 时点） | 通过 | 4 个 root@ 内网目标全部渲染：环境 A 空闲、环境 B 空闲、环境 C 部分占用 8/16、环境 D 高负载 |
| ConfigBar 只读配置条 | 通过 | 面板文本含「多环境占用 / 环境在配置文件中管理 · 每 5 分钟自动采集 / /Users/hexiaoying/.config/ascend-perf/…」 |
| 内联摘要一行 | 通过 | 面板文本含 `°C`、`kW`、`GiB（5%）` 等 t19 内联摘要 token（每环境一条） |
| chip 标签带卡号 + 图例 | 通过 | 面板文本含 c0.0…c7.1 共 16 个标签与「c卡号」图例行 |
| 展开入口存在 | 通过 | `/展开\d* ?\d*卡详情/` 命中（textContent 无空格形态） |
| 占用进程行 | 通过 | 高负载/部分占用环境含 `VLLMWorker_TP×8`、`VLLMWorker_TP×12` 进程聚合行 |
| console 错误 | 0 | page console error 事件为空 |
| 截图 | — | `docs/screenshots/real-page-v12-t19.png`（默认视图）、`real-page-v12-t19-bottom.png`（滚动至底部） |

### 15.8 t20 改名「昇腾性能调优」+ 昇腾 SVG 图标 + envs 空态导入引导（2026-11-07 17:4x CST）

用户确认三件事（t20 任务书）：①显示名改「昇腾性能调优」；②新安装用户提供配置导入途径；③UI 加昇腾图标。本节记录实现与离线验证；真实页面取证由 captain 执行。

**改名与图标**：
- 显示名统一：tab 标题/tab 注册 `panel.title`/guide entry/面板头 locale zh=`昇腾性能调优`、en=`Ascend Performance Tuning`；`meta.title` 同步。包名与安装 id `dsh-ascend-perf` 不变（package.json/exports/ModuleLoader id 均未动）。
- 昇腾 SVG 图标（`AscendIcon({size,className})`）：viewBox 0 0 16 16 内联 SVG——芯片 die（rect rx1.6）+ 内部波形 path + 四角定位括号 path，全部 `stroke='currentColor'`，`aria-hidden`，无任何外部资源/字体/背景图。落在三处：`TabTitle`/`TuneTitle`（tab 条，13px）、面板 header（15px）、guide entry `icon`（DSH `SidebarRightGuideEntry.icon?: ComponentType<IconProps>` 契约；tab 定义本身无 icon 字段，经查 DSH checkout `tab-registry.d.ts` 确认，故 tab 图标放在我们自己的 title slot 组件内）。深浅主题均可用（currentColor 继承文字色）。

**envs 空态导入引导**（`envs` 为空时渲染，非空时自动消失恢复只读 ConfigBar；空态替换原 Empty）：
- **从 SSH 主机导入**：Host 侧 `readSshHostsStore(file)` 读取 DSH ssh 插件主机仓（默认 `~/.dsh/dsh-ssh.json`，`sshHostsFile` 可注入；**只取 alias/user/host/tags，auth 字段一律不读取**）。`POST /envs/import/ssh/preview` 返回预览（rows 含跳过原因、draft 按 ascend/npu 标签优先、capacity=16-现有）；`POST /envs/import/ssh`（可选 `aliases` 过滤）确认后 `applyImportedEnvs` 原子写 envs.json（0600）并后台触发首轮采集（`pollOnce()` fire-and-forget）。读不到主机仓 → preview `available:false` + 原因（SSH_HOSTS_NOT_FOUND 等），确认导入 400 同码。
- **粘贴 JSON 导入**：`POST /envs/import/json {text}` → `parseEnvsImportText`（数组或 `{envs,pollIntervalMs}`）→ `validateEnvsImport` 逐条校验（mode 枚举/safeHostAlias/safeNpuPath/id+hostAlias 去重/总数≤16），任一非法 → 200 返回 `{imported:0,errors:[{index,message}]}` 不写盘；全过 → 落盘。
- **手动模板**：引导页提示 envs.json 路径与示例（README「新用户导入」节）。
- 导入成功：UI `importDone(n)` 提示 + 重载 /state + 后台 refresh_all；引导消失。
- 安全：envs.json 落盘仅含 hostAlias 字符串引用，测试断言不含 `password/passphrase/keyPath/auth` 及密码明文；三条导入路由走面板 prefix 鉴权 fail-closed，401 测试覆盖。

**测试证据**（`node test/run-tests.mjs` → 54 passed / 0 failed；`node --check index.js client.js tune.js tune-exec.js` exit 0）：
- 改名：注册测试断言 `dict.dicts.zh['meta.title']==='昇腾性能调优'`、`en['panel.title']==='Ascend Performance Tuning'`、client 字典同步；guide icon `=== mod.__test.AscendIcon`（两个 tab）。
- 图标：TabTitle/TuneTitle 树含 `svg[aria-hidden][viewBox="0 0 16 16"]`，currentColor 计数 ≥3，无 http(s) 外链；`AscendIcon({size:20,className})` 直调透传。
- 空态引导：空态树含「从 SSH 主机导入/粘贴 JSON 导入」+ testid `envs.import.ssh/.json/.textarea`；非空态无引导文本、无任何 input/select/textarea（t17 契约回归）。
- SSH 导入：fake 主机仓 4 台（含密码/私钥/passphrase 敏感字段 + 非法别名）→ preview draft=3 ascend 优先、非法行 skip 原因 → 导入 3 → envs.json 0600、内容不含任何敏感字段、id 唯一 → `/state` envs=3 → 重启后再 preview 全 skip → 主机仓缺失 preview `available:false SSH_HOSTS_NOT_FOUND`、确认导入 400 同码。
- 粘贴 JSON：非法 JSON/形状/缺 text 400；逐条报错 index [1,2,3]（telnet/非法别名/重复 id）不落盘；空数组 errors；合法（含 pollIntervalMs 600000）落盘并反映到 /state；重复 hostAlias 拒绝；16 条超上限拒绝且不破坏现有文件；非法 npuSmiPath 回退 `npu-smi`。
- 鉴权：`requestRejection:()=>401` 下三条导入路由均 401（透传拒绝）；盘上 envs.json 保持启动兜底的空配置。
- locale：zh/en 各 209 键，client 内嵌字典与 locale/{zh,en}.json 平铺键逐值相等（脚本校验）。

对照说明（视觉规范来源）：captain 追加的 sirlab.tech/usage 视觉规范（tokens/udot/表格化进程行等）在 t17 已落地；t20 图标为其后用户指定的新增项（昇腾/芯片意象），与 §14 结构无冲突。

### 15.9 昇腾语义图标重制（2026-11-07 17:4x CST）

用户反馈（m01860）：图标应与昇腾相关。AscendIcon 重制为原创组合：NPU 芯片轮廓 + 左右引脚（描边 currentColor 跟随主题）+ 中心「昇」字符（#E2452C→#F5A623 暖色渐变，呼应昇腾品牌观感但非华为官方 logo），纯内联 SVG 无外部资源。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 渲染（tab 条 + 面板头 + guide） | 通过 | 真实页面 svg>text='昇' + linearGradient(#apf-asc-grad)：tab 条 (813,18) 13×13、面板头 (805,54) 15×15 |
| 主题适配 | 通过 | 芯片/引脚描边 currentColor；昇字符渐变暖色深浅主题均可读 |
| 无外部资源 / aria | 通过 | 图标测试 external=0、aria-hidden=true、viewBox 0 0 16 16、currentColor≥3 不变 |
| 回归 | 通过 | node --check client.js 0；54/54 测试通过；插件重载 applied |
| 截图 | — | docs/screenshots/real-page-v13-ascend-icon.png（tab 条特写）、real-page-v13-full.png |

**修订（m01907）**：用户要求改为芯片 + 字母 A。已将中心字符「昇」改为 800 weight 的「A」（system-ui 字体，保留暖色渐变），芯片轮廓与引脚不变；真实页面取证 svg>text='A' ×2、'昇' 0 残留（截图 real-page-v13-chip-a.png）；54/54 通过；插件重载 applied。

## 16. 部署 P1：services.json 资产契约 + dry-run 预览（t23，2026-11-07 18:0x CST）

依据 docs/deploy-design.md（t21 §3/§4/§9/§11 P1 行）。新增 `deploy.js`（850 行）纯本地模块：**不含任何 spawn/ssh/exec/远端连接代码路径**（`grep -c 'spawn\|ssh\|exec(' deploy.js` 仅命中注释与 P2 占位 blocker 文案）；index.js 仅做装配（import + normalizeConfig.deploy + tools/routes 注册），多环境占用、调优、导入等既有功能零改动（回归 59/59 通过）。

### 16.1 资产契约（§3）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 读取容错 | 通过 | 缺文件=空列表；损坏 JSON/校验失败统一 `SERVICES_CONFIG_READ_FAILED`，断言原文件逐字节不变（不覆盖） |
| 校验矩阵 | 通过 | 16 类非法用例全拒：version≠1、未知字段、tp≠len(device_ids)、device_ids 重复/越界 64、port 80、gmu 1.2、相对路径、无 svc- 前缀、runtime 双子对象、venv 缺 vllm_abs、max_lifetime_s 260000(>72h)、extra_env 键 `a-b`、id 重复、33 条超限、损坏 JSON |
| 默认值 | 通过 | enabled=true、max_lifetime_s=43200(12h)、health /health+/v1/models+5s+900s+3 次 |
| 写入 | 通过 | writeServicesConfig 0600（statSync mode 断言）、回读一致 |

### 16.2 dry-run 预览编译（§4）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| venv 模板 | 通过 | 内置演示服务 preview：argv_redacted 首元素与模型路径均为 `<asset:svc-demo-qwen3-8b>`，`/opt/venv-npu-demo`、`/data/models/demo` 零泄漏；argv_sha256 64hex；plan 无真实 argv 字段 |
| docker 模板 | 通过 | 固定骨架快照：`docker run --rm --detach --name dsw-apf-svc-vllm-a-<6hex>`（seq 由资产内容 sha256 派生，可复现）、`--device /dev/davinci{0,1}`+manager/devmm_svm/hisi_hdc、`-v /data/models:/data/models` 单元素、`--shm-size 8192m`、`-e ASCEND_VISIBLE_DEVICES=0,1`、`-p 127.0.0.1:18433:18433`、镜像脱敏 `<asset:svc-vllm-a>` |
| 防注入 | 通过 | 模型路径 `/data/models/Qwen3 8B"; rm -rf /; $(reboot)` 作为单个数组元素进入内部 argv（永不拼 shell），redacted 视图零注入痕迹 |
| overrides | 通过 | 白名单内（port/max_num_seqs/dtype）生效改写 argv；`name` 越白名单→UNKNOWN_FIELD；仅 tp 不联动 device_ids→INVALID_SPEC；port 80→INVALID_SPEC |
| hash 稳定 | 通过 | 同资产同证据两次 preview：plan_hash/argv_sha256 一致（apply 重编译可比对的前提），deploy_plan_id 每次新发 |
| TTL | 通过 | 注入时钟 +1h+1ms → getPlan 抛 DEPLOY_PLAN_EXPIRED |
| 未知/停用 | 通过 | SERVICE_UNKNOWN / SERVICE_DISABLED |

### 16.3 占用预检与真实门（§6 fail-closed）

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 门默认关 + 环境空闲 | 通过 | blockers 含 REAL_DEPLOYMENT_DISABLED |
| 门开 + idle | 通过 | 无门/占用类 blocker（P1 剩 PROFILE_MISSING 为 P2 已知项），occupancy.evidence={snapshot_id,captured_at,tier:'idle'} |
| 门开 + busy/partial | 通过 | ENV_OCCUPIED，message 回显 `VLLMWorker_DP×8` |
| 快照缺失 / >10min 过期 | 通过 | OCCUPANCY_UNKNOWN（preview 只读 env_states 缓存，不触发采集、无远端调用） |
| env 缺失 | 通过 | ENV_UNKNOWN |
| 演示服务 | 通过 | 无门 blocker；用户文件伪造 env_id=env-demo-ascend 无豁免（仍 ENV_UNKNOWN）——demo 身份只存在于代码常量 |

### 16.4 审计（§7.2）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 只增 | 通过 | 跨实例续 seq（1→2→3→4），历史首条未被改写 |
| 结构 | 通过 | ts/seq 单调/principal{kind:'host-session',ref,origin:tool\|rest}/action=preview/outcome=ok\|blocked/plan_hash/argv_sha256/deploy_id |
| 截断与标识 | 通过 | detail 截 256；演示记录 detail 前缀 `demo:` |

### 16.5 工具/REST/鉴权（§9）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 工具 | 通过 | `ascend_deploy_preview` 注册（9 工具集断言），execute 返回 readonly 信封 |
| REST | 通过 | GET /deploy/services（available+p1_scope+demo 条目）、POST /deploy/preview（demo plan blockers=0；未知服务 SERVICE_UNKNOWN） |
| 鉴权 | 通过 | requestRejection=401 时两条 deploy 路由一律 401 透传（prefix fail-closed 复用） |

### 16.6 验证命令（2026-11-07 18:03 CST）

```bash
node --check ascend-perf/index.js && node --check ascend-perf/client.js && node --check ascend-perf/tune.js && node --check ascend-perf/tune-exec.js && node --check ascend-perf/deploy.js   # 全部 exit 0
node ascend-perf/test/run-tests.mjs   # 59 passed, 0 failed（54 基线 + 5 新增 t23 用例）
```

### 16.7 不碰远端声明

P1 实现零远端接触：deploy.js 无网络/SSH/进程 API；占用证据读内存缓存（getEnvState 注入）；审计/计划只写本机 `~/.local/share/dsh-ascend-perf/deploy-v1/`（0700/0600）。真实页面取证（P2 UI 分段）不在本任务范围，按团队分工由 captain 负责。

### 16.8 t24 P2a UI：单 tab 三分段 IA v1.4 + 部署分段 + 预览向导（2026-11-07 18:4x CST）

依据 captain m01217 范围升级（用户 m01949 定稿 IA）：合并为单一 sidebar tab「昇腾性能调优」，面板顶部三分段 segmented control——①环境信息（§14 占用视图原样）②服务部署（P2a：服务列表/空态引导/demo 永驻/dry-run 预览向导，无执行按钮）③性能调优（TuneJobs 调优作业 + 运行与对比/导入/洞察/导出合并，内部小节标题区分）。原 `ascend-perf-tune` tab 注册、TuneTitle、tune guide entry 全部下线；分段选择为进程内 state（刷新回默认「环境信息」，已删除 localStorage 持久化助手与 `dsh-ascend-perf:segment` 键）。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 单一 tab 注册 | 通过 | 注册测试断言 1 tab / 2 keyed slot（`sidebar.right.pane.tab{,.title}#dsh-ascend-perf`）/ 1 guide entry（order 70，icon=AscendIcon） |
| 三分段与默认段 | 通过 | Panel 渲染：role=tablist + 3 个 role=tab（testid envs.seg/deploy.seg/tune.seg），aria-selected 默认「环境信息」；默认段渲染 /state 加载骨架，不渲染调优内容 |
| 键盘切换 | 通过 | SegmentedControl ←/→ 含首尾环绕（envs→Right→deploy；envs→Left→tune） |
| 分段不持久化 | 通过 | client.js 全文无 `dsh-ascend-perf:segment`；loadSegmentPref/saveSegmentPref 已删除 |
| 部署分段（P2a） | 通过 | 打开仅一次 GET /deploy/services；loading/HTTP_401/SERVICES_CONFIG_READ_FAILED/预览过期错误态如实；demo 行钉顶+蓝虚线+DEMO chip；空态引导卡含 services.json 路径与最小样例；无任何执行/启动按钮（按钮文案白名单断言：刷新/重试/复制/全部重置/生成预览/生成演示预览/编译中…） |
| 预览向导与预览卡 | 通过 | 9 字段白名单 overrides（dtype select、placeholder=资产现值、tp+device_ids 联动校验）；预览卡 argv 逐行、hash 摘要、影响行、占用证据（快照前 8 位+tier / demo-idle 文案）、blockers 13 码中文提示、TTL 剩余 mm:ss、过期弱化、只读声明 |
| IA 文档同步 | 通过 | ui-design.md §15 头部「IA v1.4 变更附注」；README 使用节按 1 环境信息 / 2 服务部署 / 3 性能调优 重排 |
| locale parity | 通过 | locale/{zh,en}.json 各 311 键（299 平铺 + 12 嵌套组），新增 deploy.seg.envs(+Short)/deploy.seg.aria/tune.jobsTitle，deploy.seg.tune 改「性能调优」；脚本校验与 client 内嵌字典逐值一致 |
| 回归 | 通过 | node --check ×5 exit 0；run-tests 63 passed / 0 failed（62 基线 + t24 4 用例改写为 IA v1.4 形态） |

**真实页面取证（2026-11-07 18:47–18:49 CST，captain 在已认证浏览器实测，插件重载新字节后）**：

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 单 tab + 三分段 | 通过 | sidebar 仅一个「昇腾性能调优」tab；面板顶部三分段按钮（环境信息/服务部署/性能调优）全部存在，默认段=环境信息正常渲染 — [real-page-v14-envs.png](screenshots/real-page-v14-envs.png) |
| 服务部署段 | 通过 | 服务列表含「Qwen3-8B 演示服务（无 NPU）」（demo 永驻）；点「生成演示预览」后预览卡完整渲染：argv 含 `vllm.entrypoints.openai.api_server`、sha256 hash 行、「未连远端」只读声明均在 — [real-page-v14-deploy.png](screenshots/real-page-v14-deploy.png)、[real-page-v14-deploy-preview.png](screenshots/real-page-v14-deploy-preview.png) |
| 性能调优段 | 通过 | 调优作业 / 运行与对比 / 洞察内容全部在位 — [real-page-v14-tune.png](screenshots/real-page-v14-tune.png) |
| 控制台 | 通过 | 全程 0 console error |
| 回归 | 通过 | captain 侧复跑 node test/run-tests.mjs 63/63 |

取证过程说明：本席位无浏览器驱动能力（bsk CLI 未安装且本机网络不可达 github.com/crates.io、启动 token 已 401），本轮真实页面截图由 captain 按 §15.7 修正方法在其已认证会话完成（文件见 docs/screenshots/real-page-v14-*.png），开发者据此记录。

**T25-1 第三步（截图像素审计与处置，2026-11-07 18:57 captain）**：DOM 级取证确认环境卡头部渲染 hostAlias（root@ 内网地址），因此 real-page-v12-t19*.png / real-page-v14-envs.png 等 UI 截图像素级确实含真实目标。处置决定：①UI 保留 hostAlias 显示（用户以 IP 识别机器，属产品功能）；②package.json `files` 白名单本就不含 docs/screenshots/ —— 发布到插件市场/npm 的包不会携带任何截图（发布面已闭合）；③仓库级公开（GitHub 等）前必须删除 docs/screenshots/ 或改用演示环境重拍，此为发布前置检查项。PNG 元数据（tEXt/zTXt/iTXt）已扫描：0 chunk、无 root@ 字符串。

## 17. 环境信息 v1.5：卡内编辑 + 按型号卡编号 + 去噪（t29，2026-11-08 09:3x CST）

### 17.1 卡内编辑（配置文件仍是唯一真源）

- 环境卡头部新增「编辑」入口（`data-testid=envs.block.{id}.edit`，`aria-expanded` 标注展开态，同一时间至多一个环境处于编辑态——`Panel.editingEnvId`）。
- 编辑表单五字段：名称（非空 ≤64）/ SSH 目标（仅 ssh 环境，`user@host` 形式或 `~/.ssh` 别名：≤128，字符集 `[A-Za-z0-9_.:@-]`，含 `@` 时须匹配 `user@host`）/ npu-smi 路径（默认 `npu-smi`，字符集 `[A-Za-z0-9_./~-]` ≤512）/ 超时 ms（整数 1000–60000）/ 启用开关；逐字段校验错误以 locale 键渲染在字段下方（`envs.edit.err.*` 8 类）。
- 「保存」= 前端 `buildEnvsPayload`（以 `/state` 的 `config.envs` 全字段为基线整体替换目标环境）→ 既有 `POST /api/ascend-perf/config` v2 → Host 端 `updateSettings` 校验后 0600 原子写回 `~/.config/ascend-perf/envs.json`，随后 UI 自动 `load()` + 后台 `refresh_all` 让新配置立即生效；「取消」直接还原（草稿仅存组件内 state，不落盘）。校验双保险：前端逐字段提示 + Host 端 `normalizeEnvInput`/`apiError` 兜底 400。
- `envs.json` 落盘 0600；编辑一个环境不丢其余环境字段（整体替换载荷测试锁定）。

### 17.2 卡编号规则（按快照型号）与按卡占用条

| 快照型号 | 编号 | 实现 |
| --- | --- | --- |
| 含 `910C` | 1..16 | `cardNumbering()` family='910C' → expected=16 |
| 含 `910B` | 1..8 | family='910B' → expected=8 |
| 其他/未知 | 1..N | expected=实际卡数 |

- 展示编号一律 `card_id + 1`（npu-smi 卡号 0 基 → 界面 1 基）；型号只进图例（`每格 = 一张 NPU 卡（编号 1..N…）`，`data-testid=envs.chiplegend`）。
- ChipStrip 重写为**按卡一卡一格**（`data-testid=envs.card.{card_id}`，旧 `c卡号.chip号` chip 格退场）：格文本 `编号 占用chip/总chip`，三态视觉不变（占用琥珀实心/空闲绿描边/未知灰虚线），`title` 悬停聚合该卡温度峰值/功率合计/AICore 峰值/HBM 峰值，`aria-label` 为完整判定句；`deriveEnvOccupancy` 新增 `cards[]` 聚合与 `numbering`。
- chip 级明细保留在「展开 N 卡详情」：CardBlock 卡头改 `NPU {编号}（id {card_id}）`，ChipRow 逐 chip 行不变。

### 17.3 环境段去噪（用户 m02366）

移除：每环境独立「刷新」按钮（手动刷新统一由「刷新全部」承担）、环境段「加载演示数据」按钮与演示说明行（含空态导入引导中的演示按钮；演示入口保留在「性能调优」分段底部）、卡尾数据过期提示行与面板底部只读 footer（只在性能调优段渲染）。保留：配置条、5 分钟静默采集、`POST /status env_id` REST 语义（工具仍可用，仅 UI 按钮移除）、`/state`、`refresh_all`、`env_states` 语义全部不变。

### 17.4 验证证据（2026-11-08 09:31 CST）

```text
node --check index.js / client.js / deploy.js / tune.js / tune-exec.js → 全部 exit 0
node test/run-tests.mjs → 66 passed, 0 failed
```

- 新增用例①：`cardNumbering`（910C→16 / 910B→8 / 其他→实际 / 空→0）+ `deriveEnvOccupancy.cards[]`（1 基编号、卡状态=任一 chip 占用→occupied、占用计数、temp/power/aicore/hbm 聚合）+ ChipStrip 按卡渲染（`envs.card.0/1`、`1/2`、`0/2`、图例 `编号 1..16`、aria `NPU 1（id 0）…占用`）+ CardBlock 卡头 `NPU 1`+`（id 0）` + ChipRow chip 明细仍在。
- 新增用例②：`validateEnvForm` 9 断言（合法 ssh/local、空名/超长名、host 缺失/非法字符/非法 user@host、路径非法、超时 500 与 61000 越界）+ `buildEnvsPayload`（目标环境整体替换含空路径回退 `npu-smi`、其余环境全字段保留、无基线→null）+ `EnvEditForm` 渲染（五字段 testid、ssh 有/local 无 hostAlias 输入）+ `EnvEditFormBase` 逐字段错误文案 + `EnvBlock` editing 开关（表单出现/消失、aria-expanded）+ `EnvsSection` 透传 editingEnvId。
- 新增用例③（Host 链路）：卡内保存的 v2 整体替换载荷 → `envs.json` 0600 + 目标环境更新 + 其余环境字段完整保留 + 重启 apply 后配置稳定 + 非法 hostAlias 仍 400。
- 改写用例：t17 渲染测试（非编辑态仍零输入控件、2 个卡格、图例 `一张 NPU 卡/编号 1..8`、旧 `c0.7` 标签断言反向、编辑入口 testid 与收起态 aria、按钮集合无单环境「刷新」、环境段无「加载演示数据」）、t19/t17 空态测试 props 与演示入口去噪断言。
- locale：`envs.chipLegend`/`envs.refresh` 删除，新增 `envs.cardLegend`/`envs.edit*`/`envs.f.*`/`envs.edit.err.*` 共 17 键（zh/en 各 316 平铺键，parity 校验通过）。

### 17.5 只读边界

本轮未改任何采集/执行代码路径：`/status`、`/config`、`/state`、轮询、占用判定 Host 侧实现零改动；编辑保存复用既有 `POST /config` → `writeEnvsConfig`（0600 原子写）；不连真实环境验证（测试 + 本地 fixture），真实页面取证由 captain 负责。

## 18. 服务部署 v2：环境选择 + 代码基线差异 + 可编辑部署计划（t30，2026-11-08 09:5x CST）

按用户 m02366 重做服务部署段：**服务资产就是 envs 配置里的环境选择**；不再有 services.json 资产目录、dry-run 预览与演示服务；核心是「验证某分支/代码基线相对基线的差异」——生成**可编辑部署计划**并保存（plans.json，0600）。纯文本，不执行任何步骤。

### 18.1 与 P1（§16）的关系

| P1（已下线） | v2（本轮） |
| --- | --- |
| services.json 资产目录（svc-* 条目） | 无资产文件；目标 = envs.json 启用环境 |
| 演示服务 svc-demo-qwen3-8b | 无内置服务（无 NPU 也可走全流程：生成/编辑/保存计划） |
| `GET /deploy/services` + `POST /deploy/preview`（TTL 草稿） | `GET/POST /deploy/plans`、`POST /deploy/plans/generate`、`GET/PUT/DELETE /deploy/plans/:id` |
| 工具 `ascend_deploy_preview` | 工具 `ascend_deploy_plan_generate/list/get/update`（envelope 只读声明） |
| 预览卡（argv redaction/blockers/TTL） | 计划编辑器（步骤增删改/上下移/scope 标注）+ 已保存计划列表 |
| 审计 audit.jsonl（preview 记录） | 随预览路径一并移除（无执行行为无需审计执行记录） |

### 18.2 校验契约（fail-closed）

- `env_id` 必须在 envs.json 且 enabled：`ENV_UNKNOWN` / `ENV_DISABLED`（环境被删/停用后旧计划不可再覆盖保存）；
- 分支/tag 非空、白名单字符 ≤200；commit 7–40 位十六进制或留空取 HEAD；模型路径绝对路径白名单字符；port 1024–65535、TP 1–8、max_num_seqs 1–1024、max_num_batched_tokens 128–131072、health_timeout_s 5–3600（默认 300）；未知字段 `UNKNOWN_FIELD`；
- 步骤：title 非空 ≤120、detail ≤1024、command 可空 ≤2048、scope ∈ candidate/baseline/both、1–64 步、计划数 ≤32；`STEP_INVALID`；
- plans.json 读失败（非法 JSON/version≠1）→ `PLAN_STORE_READ_FAILED` 且不覆盖待修复文件；
- 全部六条计划路由 fail-closed 鉴权（未认证 401 透传，无响应体；401 请求不产生 plans.json）。

### 18.3 UI（服务部署分段 v2）

向导四步（①目标环境单选——仅启用环境、显示占用档位、partial/busy 给提示但允许继续；②基线分支+commit；③候选分支+commit；④模型与启动参数 5 项）→「生成计划」（草稿不落盘；已有草稿时再次点击确认覆盖）→ 编辑器（步骤行：scope select/标题/说明/命令，↑↓/删/新增；首末行上移/下移禁用；草稿 vs 已保存标记；保存错误就地显示）→ 保存（POST/PUT）→ 已保存计划列表（刷新/打开/删除两次确认）。全程只读声明「计划仅是文本：不执行任何步骤」。v1 概念（svc-demo-qwen3-8b / services.json / DeployServiceRow / DeployPreviewCard / buildOverrides / dry-run 预览 / 演示服务）在 client.js 源码断言全量不存在。

### 18.4 验证证据（2026-11-08 09:49 CST）

```text
node --check index.js / client.js / deploy.js / tune.js / tune-exec.js → 全部 exit 0
node test/run-tests.mjs → 64 passed, 0 failed
```

- 用例①（生成）：10 步结构 s1–s10、scope 序 both/baseline×5/candidate×2/both×2、命令嵌入 ref/commit/port/TP（基线/候选 `git checkout`、`vllm serve --port 18433 --tensor-parallel-size 2`）、草稿不落盘、envelope `readonly:true`+`effects` 全 false。
- 用例②（校验矩阵）：ENV_UNKNOWN/ENV_DISABLED/INVALID_SPEC×7（空分支、非 hex commit、6 位 commit、相对路径、白名单外字符、端口 1023/65536、TP 9、健康超时 4000）/UNKNOWN_FIELD/INVALID_ARGUMENT，全部 `assert.throws`（服务层直接抛错，fail-closed），校验失败不落盘。
- 用例③（REST 全链路）：生成草稿不落盘 → 空步骤 400 STEP_INVALID → POST 保存 id=plan-16hex + plans.json 0600 {version:1} → 列表 count/step_count → GET :id → PLAN_UNKNOWN → PUT（删 1/改 1/换序/加 1：created_at 保持、updated_at 前移）→ scope/title 非法 400 → 重启 apply 后仍在 → 损坏 store GET/POST 均 400 且文件不被覆盖 → 恢复后 DELETE → 空列表 → 再删 PLAN_UNKNOWN。
- 用例④（工具面）：4 工具名与参数白名单、合法生成 envelope ok、非法（ENV_UNKNOWN）envelope error 不抛、update 新建+更新（保 created_at）、get/list、PLAN_UNKNOWN。
- 用例⑤（鉴权）：六条路由（GET/POST /deploy/plans、POST generate、GET/PUT/DELETE /deploy/plans/:id）未认证一律 401 透传无响应体、不产生 plans.json。
- 用例⑥（UI 分段）：仅启用环境出现 radio（停用环境不出现）、空闲/高负载档位文案、「仍可生成计划」提示、11 个向导输入 testid、生成按钮、只读声明、计划列表初始 loading、client.js 源码 v1 禁词 6 项、`validateDeploySpec` 合法 spec 载荷 + 非法 9 键、空环境提示。
- 用例⑦（编辑器）：三行步骤 testid、上下移边界禁用、scope 三档（候选/基线/两者）、草稿/已保存标记、保存错误显示。
- 注册测试改「12 个工具」（4 看板 + 4 调优 + 4 部署计划）；t23×4 + t24×4 旧用例整段替换。
- 实现期修复：`_normalizePlanInput` 曾把 `steps` 传进 `validatePlanSpec` 恒触发 UNKNOWN_FIELD（所有保存必挂）——已剥离 steps 再校验（用例③④锁定）；UI 编辑器补计划标题展示、向导补基线/候选分组标题。
- locale：zh/en 各 296 平铺键 parity true（12 嵌套组 + 平铺 = 308 顶层键）；deploy.* 由 v1 86 键替换为 v2 64 键。

### 18.5 只读边界

部署 v2 无任何执行路径：deploy.js 不含 spawn/ssh/exec；生成/保存只读 envs 与 env_states 快照的占用摘要（getEnv 注入），不触发采集、不连远端、不跑 benchmark；真实执行（受控 apply/启停/心跳/端口锁）留待后续授权。测试与本地 fixture 验证，未连真实环境。

## 19. 环境卡去图例 + 正常视图不展示 hostAlias/IP（t34，2026-11-08 09:5x CST）

用户 m02398 / m02416 两条反馈合并处理：①占用条下方图例说明行完全移除；②环境卡正常视图（卡头、模式行、aria/title、单快照视图信息行）不再出现 hostAlias / `root@IP`。

| 项 | 处理 |
| --- | --- |
| 图例行 | ChipStrip 不再渲染 `envs.chiplegend` 图例 div；卡格本体（`envs.card.{card_id}`、编号、占用/总 chip、三态视觉、aria/title 判定信息）与「展开 N 卡详情」全部保留 |
| locale | `envs.cardLegend` 删除；新增 `envs.modeSsh`（「SSH」）与 `envs.fallbackName`（「环境 {n}」/「Environment {n}」）；zh/en 各 309 顶层键 parity true |
| hostAlias 显示 | 卡头名称 span：`env.name` 存在且 ≠ `hostAlias` 时显示名称，否则显示 `t('envs.fallbackName', { n })`（N 按 envs 配置列表顺序，排序展示不影响编号）；模式行 ssh 环境只显示「SSH」标签（不再拼 hostAlias）；OccupancyPill 的 aria-label 同样使用友好标签；renderSnapshot 信息行去掉 `snapshot.host.alias` 段 |
| 编辑态 | `EnvEditForm` 的 SSH 目标字段（`envs.edit.hostAlias`）保留并可保存（配置需要）；编辑态回填当前值，保存/取消后恢复正常视图仍不显示 |
| 不受影响 | 多环境区分（名称/「环境 N」/「本机」）、占用档位判定与排序、刷新全部、5 分钟静默采集、`POST /config` v2 保存链路、`env_states` 语义全部不变 |

### 19.1 验证证据（2026-11-08 09:56 CST）

```text
node --check client.js → exit 0
node test/run-tests.mjs → 65 passed, 0 failed
```

- 新增用例「t34 UI：图例移除；正常视图无 hostAlias/IP…」：播种默认命名（name===hostAlias）显示「环境 1」、命名环境照常显示、整树文本无 `root@…`、`envs.chiplegend` testid 与图例文案不存在、模式行仅「SSH」、pill aria 以「环境 1：」开头且不含 root@、编辑态有 `envs.edit.hostAlias` 输入且 value 回填当前目标、三环境（本机/播种默认/命名）并存可区分。
- 反转既有断言：t17 渲染测试与 t29 ChipStrip 用例中图例存在性断言改为不存在断言；卡格/编号/aria 断言全部保留。
- 实现期修复：初版「环境 N」用排序后行号编号，导致排序展示时编号漂移——改为 EnvsSection 构建 `envOrder`（按 envs 配置顺序）注入 EnvBlock。

### 19.2 历史记录勘误

§16/§17 各节中关于「图例」（`envs.chipLegend` / `envs.cardLegend` / `data-testid=envs.chiplegend`）的描述均为当轮实现的历史记录；图例行已于本节（t34）移除，现态以本节为准。

### 19.3 t36 修订：主机标识单次显示（取代 19 中「不显示 hostAlias」的表述）

用户 m02470 澄清：**IP 必须显示**（用户靠 IP 区分环境）；要删的只是 `root@` 前缀与重复括号。t35 审查（T35-1）另指出服务部署的目标环境行存在 `root@IP（root@IP）` 重复展示。本节修订后，§19 表格中「hostAlias 显示」一行的口径**以本节为准**。

| 场景 | 展示（t36 统一口径） |
| --- | --- |
| 环境卡头（播种默认，name = hostAlias） | `环境 N · 10.0.0.5`（N 按 envs 配置列表顺序，排序展示不影响编号） |
| 环境卡头（自定义名） | `集群A · 10.0.0.5`（自定义名优先，IP 仍保留） |
| 本机环境 | 名称（无主机段） |
| 服务部署·向导目标环境 | 同口径单次显示：`集群B · ascend-ro`（别名无 @ 原样）/ `环境 N · IP`；行内 `模式：SSH/本机 · 占用档位` |
| 计划编辑器摘要 / 已保存计划列表（env 来自 REST `host_alias`） | 自定义名 `·` 裸主机；播种默认显示裸主机一次（无 `root@`、无括号重复） |
| 编辑态 SSH 字段 | 保持完整 `user@host` 可改可保存 |

实现：`stripUserPrefix` / `envHostTag` / `envDisplayName`（client.js 统一助手，四处消费：EnvBlock、部署向导环境行、DeployPlanEditor 摘要、计划列表行）；修复了初版 `??` 链在播种默认场景回落到 `env.name` 导致 `root@IP · IP` 双显的 bug。locale 新增 `envs.f.mode`（zh「模式」/ en 'Mode'，四处补齐：client.js 内嵌 zh/en 字典 + locale/{zh,en}.json）——该键此前被 EnvEditFormBase 引用但缺失（t35 审查发现，makeT 回退会显示裸键名）。

### 19.4 t36 验证证据（2026-11-08 10:10 CST）

```text
node --check index.js / client.js / deploy.js / tune.js / tune-exec.js → 全部 exit 0
node test/run-tests.mjs → 66 passed, 0 failed
```

- t34 用例改写为 t36 口径：`环境 1 · 10.9.9.9` / `训练集群A · 10.9.9.8` 存在、两 IP 可区分、`root@` 全树不出现、主机标识 `indexOf === lastIndexOf`（单次）、pill aria 以 `环境 N · IP：` 开头、编辑态 value 仍回填完整 `root@10.9.9.9`、模式行渲染「模式」。
- 新增 t36 用例：`envs.f.mode` 四处键断言（client zh/en + locale zh/en）+ locale 与 client 字典平铺键双向一致 + **t() 静态键覆盖扫描**（client.js 源码全部 `t('…')` 字面量 ≥150 个逐一必须在 zh/en 字典中，防再出现裸键）；部署向导 `集群B · ascend-ro` / 无 `（root@` 括号重复 / `模式：SSH`；编辑器摘要裸主机恰好出现一次（`split().length-1 === 1`）。

## 20. t44：环境配置弹窗 + 配置重载、SSH 单连接采集、部署组件白名单（2026-11-09）

### 20.1 A 环境配置：卡内编辑 → 全局弹窗（用户 m03645「一行行的弹出来让客户修改」）

- 删除每个环境卡的「编辑」按钮与卡内 EnvEditForm（环境卡回到纯只读视图）；
- ConfigBar 新增两按钮：**「环境配置」**（主入口，testid `envs.configbar.edit`）与**「重新加载配置」**（次级兜底，testid `envs.configbar.reload`）；
- **EnvConfigModal**（`role=dialog` + `aria-modal`，testid `envs.config.modal`）：顶部采集频率（分钟 1–60，testid `envs.config.poll`）；下方逐行环境卡（EnvConfigRow，字段 name/mode(local|ssh)/hostAlias/npuSmiPath/timeoutMs/enabled，逐字段 testid `envs.config.row.{i}.{k}`、删除按钮 `envs.config.row.{i}.del`）；添加环境 ≤16（`envs.config.add`，行内显示 `{n}/16`）；逐字段校验错误键 `envs.config.err.*` 就地显示；保存（`envs.config.save`，非法时 disabled）产出 `{pollIntervalMs, envs}` 整体替换载荷 → `POST /config`（v2）0600 原子写 envs.json → 关闭弹窗 → 自动 `refresh_all`；取消还原；
- **POST /config/reload**（Host 新增，只读无写入）：`reloadEnvsConfig()` 重读 envs.json → 成功则更新内存 envs/pollIntervalMs 并触发 `pollOnce()`，返回 `{reloaded, env_count, pollIntervalMs, config, envs}`；**损坏时 400 `CONFIG_READ_FAILED` 且保留旧配置**（内存 envs 不动），`/state` 暴露 `envs_config_error` 供面板错误卡；401 鉴权 fail-closed 透传。

### 20.2 C SSH 单连接采集（修复 sshd MaxStartups 限流 exit 255）

- 旧行为：每环境 1×`npu-smi info` + N×`info -t usages -i N` 各占一条 SSH → 卡多的机器一轮 8+ 条并发连接触发 sshd `MaxStartups` 限流（exit 255）。
- 新行为（`buildSshRemoteCommand`/`parseCombinedSshOutput` 均为导出纯函数）：**每环境 1 条 SSH**，远端一次执行 `info=$(npu-smi info); printf '%s\n' "$info"; cards=$(… | awk '/^\| [0-9]+ +Ascend/ {print $2}' | sort -nu); for i in $cards; do printf '@@CARD:%s@@\n' "$i"; npu-smi info -t usages -i "$i"; done`（npuSmiPath 经 `quotePosix` 包装；卡号仅数字列，awk 兜注入）。stdout 按 `@@CARD:<id>@@` 分段：首段 info（`parseNpuSmiInfo`），其后每卡一段（`parseUsages`），缺段只降级 warning 不失败；
- SSH 参数：`-T` + `BatchMode=yes` + `StrictHostKeyChecking=yes` + `ConnectTimeout=8` + `ServerAliveInterval=5` + `ServerAliveCountMax=2` + `ConnectionAttempts=1`；聚合超时 `max(env.timeoutMs, 45000)`；
- **exit 255 重试 1 次**（间隔 `cfg.sshRetryDelayMs` ?? 1500ms，测试可注入 0）；
- **stale 兜底**（`collectEnv`）：重试仍 255（`SSH_UNAVAILABLE`）且 store 里有上次成功快照 → 记录 `availability='stale'` + 保留旧快照渲染 + `last_success_at`（成功时=now，失败沿用上次）+ `error.message` 带 **stderr 脱敏摘要**（`summarizeSshStderr`：压空白、截 160、hostAlias 与裸 host 替换 `<host>`）；无任何历史成功才如实 `unreachable`；
- UI（EnvBlock）：`stale` 计入可视图（`hasView`），ConnBadge 首档显示 `连接抖动 · 上次 HH:MM`（`envs.conn.flap`，取 `last_success_at` 的 HH:MM）；`envsPayload` 每环境新增 `last_success_at`；
- `pollOnce` 改为**双 worker 有界并发 2**（cursor 共享队列；四环境两两并行，不再整轮串行）。

### 20.3 B 部署组件白名单

- `spec.component`：白名单 `vllm / vllm-ascend / lmcache / lmcache-ascend / mooncake`，缺省/空 → `vllm-ascend`；白名单外 `INVALID_SPEC`（fail-closed，工具面同规则）；基线/候选共用同一组件；
- 计划步骤 detail/command 携带组件与 ref（如 `vllm-ascend serve /data/models/M …`、检出步骤含 `组件 X：…`）；plans.json 落盘带 `component`；**旧计划无 component 读出时补默认不回写盘**（`getPlan`/`planSummary`，含仅顶层 `env_id` 的早期结构兼容）；
- UI：向导基线区「代码组件」下拉（testid `deploy.wiz.component`，5 项，默认 vllm-ascend；切换组件保留已填 ref）；编辑器摘要与保存载荷携带 component；client 侧 `validateDeploySpec`/`buildSpecPayload` 同白名单。

### 20.4 验证证据（2026-11-09 19:55 CST）

```text
node --check index.js / client.js / deploy.js / tune.js / tune-exec.js → 全部 exit 0
node test/run-tests.mjs → 70 passed, 0 failed
```

| # | 用例（t44 新增/改写） | 关键断言 |
| --- | --- | --- |
| 1 | t44 纯函数 | 远端脚本含 quotePosix 包装/awk/`@@CARD:%s@@`；分段解析 info 前段+两卡 Map+无标记 0；stderr 摘要脱敏 `<host>` 且 ≤160 |
| 2 | t44 SSH 集成（fake subprocess 注入） | 成功采集恰好 **1 条 ssh**、argv 含 8s/保活参数、末位为聚合远端命令、卡 3 usages 并入（hbm_total_mb 65536）且无缺段告警；首败 255 → 重试 1 次成功（2 条 ssh，available）；连续 255×2 有历史 → **stale + last_success_at + SSH_UNAVAILABLE + 消息无 root@10.3.3.3 + 旧快照 8 卡保留**；reload 后新环境无历史 → unreachable 如实 |
| 3 | t44 /config/reload | 成功重载 env_count/pollIntervalMs 更新并触发采集；损坏 envs.json → 400 CONFIG_READ_FAILED + /state 旧 envs 保留 + `envs_config_error` 出现；修复后 reload 清错；401 透传 |
| 4 | t44 部署组件白名单 | 缺省 vllm-ascend/白名单外 `codeIs('INVALID_SPEC')`；步骤含组件与双方 ref；旧计划 getPlan/listPlans 补默认不回写盘；UI 下拉 5 项默认选中、validateDeploySpec 拒 ktransformers（`deploy.v.component`）、合法载荷携带 component |
| 5 | t44 环境配置弹窗（替换 t29 卡内编辑用例） | validateEnvForm 错误键迁移 `envs.config.err.*`；dialog aria/全字段 testid/`{n}/16` 计数/local 行无 SSH 目标；保存 onClick 产出整体替换载荷（deepEqual 全字段）；EnvConfigRow 逐字段错误显示；EnvBlock 无编辑入口；ConfigBar 双按钮存在 |
| 6 | 既有用例同步 | 占用视图/t19/空态/t36 用例 props 换新签名；保存链路用例改字面量载荷（POST /config v2 → envs.json 0600 断言保留）；t30 生成用例 serve 命令前缀改 `vllm-ascend serve` |

### 20.5 只读边界（不变）

- SSH 仍只执行 `npu-smi info` / `npu-smi info -t usages -i N`（白名单命令，聚合成单连接不改变命令集合）；`BatchMode=yes` + `StrictHostKeyChecking=yes`；
- `/config/reload` 只读（重读 envs.json + 触发既有采集，不写任何文件）；`POST /config`（弹窗保存）沿用 t17 既有 v2 整体替换写 envs.json（0600）；
- 部署 v2 仍纯文本：不 git、不 pip、不启停服务、不连 NPU（本任务未触碰执行面）。

## 21. t124：服务部署 v3——容器服务预览/启动/状态/停止（2026-11-14）

### 21.1 交付物

- 新模块 `ascend-perf/deploy-exec.js`：`DeployRunService`（preview/start/status/logs/stop/listInstances）+ `createDeployRunTools`（4 工具）+ `createDeployRunRoutes`（6 路由，`/deploy/run/*`）。
- `index.js`：挂载 `deployRun`（`execSsh` 经 `runCommand`+ssh 同款参数构造，注入 mock 可测）；`envs.json` 可选 `deploy.allowRealExecution` 于 apply/`/config/reload` 时读取；`/state` 新增 `deploy_run.real_execution_enabled`；工具计数 12→16。
- `client.js`：`ContainerServicesBlock`（服务部署分段底部）：环境选择（仅 ssh）/空闲卡勾选（占用快照预筛+禁选占用卡）/镜像/模型/端口/max-model-len/预览卡（argv+令牌+有效期）/实例列表（状态/日志/停止）/未启用提示（不诱导）；v2 计划向导原样保留。
- locale zh/en 各 +27 `deploy.run.*` 键（347 键 parity）。

### 21.2 双门 fail-closed 与安全边界

- 门一：`envs.json` `"deploy": {"allowRealExecution": true}`（默认关闭）；门二：preview 返回的 `confirmation_token`（24+ hex，600s TTL，sha256 绑定 spec+容器名；start 时 spec 被篡改即 `digest_mismatch`）。缺任一门 `REAL_EXECUTION_DISABLED / INVALID_CONFIRMATION`，且未启用时**从不发出 `docker run`**（测试断言）。
- 预检（preview 与 start 各跑一遍）：环境存在/启用/ssh 模式；逐卡 `npu-smi info -t usages -i N` 实测 HBM<10% 且 AICore<5%；`ss -ltn` 端口空闲；`docker image inspect` 镜像在位；`test -d` 模型目录在位。
- 停止/日志/清理守卫：容器名必须 `dsh-apf-svc-` 前缀 **且** `dsh-ascend-perf.service` 标签匹配，否则 `FORBIDDEN` 且不发出任何写命令（测试断言）；健康超时只 `docker rm -f` 自有容器。
- 配方红线（t128 起按环境 opt-in，测试锁定 argv）：
  - **默认基线配方（安全回退）**：仅选中 `/dev/davinciN` + 三公共 device；`-p 127.0.0.1:PORT:PORT`；`-v model_root:/models:ro` + driver/dcmi/ascend_install.info 只读；**不加 `--privileged`、不加 `--ipc=host`、不设 `ASCEND_RT_VISIBLE_DEVICES`**（适用 25.x 驱动，如 c01 25.5.1——只挂选中 device 节点即完成逻辑重映射）。
  - **特权例外（显式 opt-in）**：仅当 envs.json 顶层 `deploy.privilegedHosts` 列出该环境的 hostAlias 或 env id（当前仅 b01）时，配方追加 `--privileged --ipc=host -e ASCEND_RT_VISIBLE_DEVICES=逻辑 0..N-1`——b01 驱动 26.0.rc1 下无特权即 ascend_hal 枚举失败（§22.1 探针矩阵），privileged 下必须用 env 限制可见卡否则可枚举全部 8 卡。preview 会标注 `recipe`（privileged-isolated / baseline-sandboxed）与对应风险提示；其他环境一律基线配方（测试「t128 配方 opt-in」锁定）。

### 21.3 事故与回归（captain 热修）

首版 `createDeployRunTools` 的 `output: { schema: DEPLOY_RUN_SCHEMA }` 把字符串当 JSON Schema，Cordis `JsonSchemaError: unsupported JSON schema` 导致整个 host 插件 fiber 崩溃（所有 `/api/ascend-perf/*` 404）。captain 现场热修为 `schema: { type: 'object', additionalProperties: true }`；已加回归测试（每个 run 工具 def 的 `output.schema` 必须是对象非字符串）。教训：`output.schema` 只接受 JSON Schema 对象，schema 版本字符串只能放进 envelope payload。

### 21.4 验证证据（2026-11-14）

- `node --check index.js / client.js / deploy.js / deploy-exec.js / tune.js / tune-exec.js` 全 exit 0。
- `node test/run-tests.mjs`：**78 passed / 0 failed**（新增 6 个 t124 用例：validateRunSpec 白名单与卡/TP 约束、预览 argv 配方+令牌、预检五类 fail-closed、启动双门（未启用零 docker run/坏令牌/过期/篡改）、状态-日志-停止（健康/超时清理/FORBIDDEN 守卫）、工具+REST+401 透传+schema 回归、UI 渲染）。execSsh 全 mock，测试不真启动容器、不连任何远端。
- locale：zh/en 347 键 parity（`deploy.run.*` 27 键）。
- captain 在 b01 空闲卡做真实启动验证（本任务契约外）；c01 未触碰。

### 21.5 已知边界

- 实例登记表为进程内状态：插件重启后 `deploy_run.instances` 不含历史容器，需按容器名（`dsh-apf-svc-*` 前缀）经 status/stop 路由操作；v1 记录于 README。
- UI 空闲卡预筛基于最新占用快照（可能过期），最终以 preview 的逐卡实测为准（`CHIP_BUSY` fail-closed）。

## 22. t126：修复轮（t125 review 8 条 + captain b01 实机 start 失败）（2026-11-14）

### 22.1 b01 实机失败根因（全部实测，不靠猜）

环境：b01 = 8×910B3，npu-smi **26.0.rc1**（/dev/davinci* 节点 11 月 9 日 18:22 重置）；他人容器 lmcache-qwen（零 davinci device + `ASCEND_RT_VISIBLE_DEVICES=0-7` + privileged）与 hold（全 16 device + privileged）正常运行。

最小 torch_npu/device_count 探针矩阵（自有 `--rm` 容器，只碰卡 6）：

| 变体 | 配置 | 结果 |
|---|---|---|
| skill 原 smoke | davinci6 无 env 无 privileged | COUNT 0（skill 的「已验证」配方在新驱动下失效） |
| A/B/C | 无 davinci dev+env=6 / davinci6+env=0 / davinci6 无 env（均无 privileged） | COUNT 0 |
| D/E | v0.23.0 全 device 无 env / +env=6 | COUNT 0 |
| F/G/H/I/J | v0.30.0rc2 全部单卡/全 device 变体（无 privileged） | COUNT 0 |
| **L** | **privileged + davinci6 无 env** | **COUNT 8（隔离失效！）** |
| **M** | **privileged + davinci6 + `ASCEND_RT_VISIBLE_DEVICES=0`** | **COUNT 1 + matmul OK** |
| N/P | privileged + davinci[6,7] + env=0,1 / =6,7 | COUNT 2 + matmul OK |
| Q | v0.23.0 + privileged + env=0 | COUNT 1（默认镜像保留可用） |

根因链：① 驱动 26.0.rc1 下无 `--privileged` 时 `ascend_hal` 枚举失败（`Can't get ascend_hal device count` → vLLM `std::logic_error basic_string::_S_construct null` → Engine core initialization failed，即 captain 实测的 38s Exited(1)）；② privileged 下若不设 `ASCEND_RT_VISIBLE_DEVICES`，容器能枚举全部 8 卡（隔离失效）；设为**逻辑 0..N-1** 后与只挂的 `--device=/dev/davinciN` 一一对应。定稿配方：`--privileged --ipc=host` + 选中 `--device` + `-e ASCEND_RT_VISIBLE_DEVICES=0..N-1` + `-p 127.0.0.1:PORT:PORT` + `--` 分隔 image。真机验证：Llama-3.2-1B 卡 6 端口 18433 → ~2.5min 就绪 + 真实补全（两次：手工配方 + 走 DeployRunService 插件代码路径 preview→start→healthy(t=120s)→completion→stop，stop 后 0 dsh-apf 容器、卡 6 HBM 回 5%）。

### 22.2 t125 8 条修复对照

| # | 修复 | 测试 |
|---|---|---|
| ① | 重启后按容器名接管：`_adoptByName` 逐启用 ssh 环境 inspect，前缀+label 守卫通过即可 status/logs/stop（端口/启动时间如实标 unknown；非法名 INSTANCE_UNKNOWN 不发远端命令） | `t126 接管` 用例（running/stopped/logs/stop+rm/label 空 FORBIDDEN/非法名零命令） |
| ② | `_reservations` 原子占位（docker run 前）：同 env 或同 hostAlias 的卡交集/同端口 → `RESERVATION_CONFLICT`（对已登记活跃实例同样生效） | 启动双门用例扩展（同 spec 重复 start + 卡 7 交叠 spec 均拒绝且零二次 docker run） |
| ③ | `envsConfigPayload(cfg, preservePayload)` 保留未知顶层键（deploy 等）；POST /config 与 envs 导入两路写盘后**重读文件并同步内存 gate** | `t126 envs.json 未知键保留` 用例（两路写后文件仍含 deploy.allowRealExecution=true 且 /state gate 保持 true） |
| ④ | `IMAGE_RE` 拒绝前导 `-`；argv 在 image 前加 `--` 分隔 | `t126 恶意 image` 用例（`-evil --privileged` 在 validate 层 INVALID_ARGUMENT，不进任何远端命令）+ 预览断言 ` -- '<image>'` |
| ⑤ | `_guardOwnContainer(info, id, expectedServiceId)` 统一守卫（status/logs/stop 全走）：前缀 FORBIDDEN / label 空 FORBIDDEN / expected 不符 FORBIDDEN | `label 非空但值错误→FORBIDDEN`（status/logs/stop 三处）+ 既有空 label 用例 |
| ⑥ | docker run 失败 → `_cleanupContainerQuietly`（inspect+守卫+rm -f best-effort）+ 释放占位；**stop 语义 = `docker stop -t 30 && docker rm`**（不保留 Exited 容器） | `t126 占位与失败清理`（失败后 rm -f 自有容器 + 占位释放后同卡同端口重试成功）；stop 断言更新为 stop+rm 组合 |
| ⑦ | render 返回树断言（testid/文案在返回值上而非入参）；`buildDeploySshExec(ctx)` 导出可测（resolved argv 精确断言）；restart/logs/错误 label/并发/失败清理回归 | `t126 render 返回值` + `t126 execSsh 构造` 用例 + ①②⑥ 各回归 |
| ⑧ | 远端插值全部 `quotePosix`（export）：npuSmi 路径/image（`-- ${q(image)}`）/模型目录双段/容器名/inspect/logs/stop/rm | 预览与 stop 用例断言引号形态；`t126 恶意 image` 证明注入面收敛 |

### 22.3 验证证据（2026-11-14）

- `node --check index.js client.js deploy.js deploy-exec.js` 全部 exit 0。
- `node test/run-tests.mjs`：**84 passed / 0 failed**（78 + t126 新增 6 用例；含 t124 旧断言按新配方翻转）。
- b01 真机（走 DeployRunService 插件代码路径，真实 SSH）：preview argv 与 22.1 定稿配方逐 token 一致 → start（容器 `dsh-apf-svc-meta-llama--llama-3-2-1b-instruct-3e09a1`）→ t=120s healthy → `/v1/completions` 真实补全「 Paris. The Eiffel Tower is located in Paris.」→ stop（stopped=true removed=true）→ `docker ps -a` 0 个 dsh-apf 容器、卡 6 HBM 5%。期间 `envs.json deploy.allowRealExecution` 保持 false（未动宿主插件配置；gate 逻辑由单测覆盖）。

## 22.4 t128 修复轮（repair-round-3，2026-11-14）

### 22.4.1 修复对照（t127 review 4 条 + captain 回归 2 条）

| 项 | 内容 | 锁定测试 |
| --- | --- | --- |
| 回归 R1（captain m09510） | `buildDeploySshExec(ctx)` 漏传 cfg → runCommand `cfg.cwd` undefined → 真实 SSH 预览全挂（COMMAND_FAILED "Cannot read properties of undefined (reading 'includes')"）。修：`buildDeploySshExec(ctx, cfg)` + `runCommand(ctx, { ...cfg, timeout })`，调用处传 cfg | 「t128 回归：buildDeploySshExec …」断言 spawns[0].cwd 透传 |
| 回归 R2（fresh 验证发现） | deploy-exec 路由 `api` 包装漏传 `params` → pattern 路由（instances/:id、:id/logs、:id/stop）REST 调用 `params[0]` undefined → STORE_IO "reading '0'"（工具面与 401 不受影响，故 t124 未暴露）。修：api 包装透传 params（与 deploy.js 计划路由对齐） | 「t128 回归：REST pattern 路由透传 params」经 prefix 路由全链断言 INSTANCE_UNKNOWN 而非 STORE_IO |
| t127-① | Host 重载后实测 preview/status/接管 | §22.4.2 fresh-process 17/17 |
| t127-② | --privileged/--ipc=host/ASCEND_RT_VISIBLE_DEVICES 仅对 envs.json `deploy.privilegedHosts` 显式列出的 hostAlias/env id 生效（当前仅 b01）；其他环境默认基线配方（安全回退）；preview 标注 `recipe` 与风险/适用驱动提示 | 「t128 配方 opt-in」（b01 未列入→baseline；列入→privileged-isolated+warning） |
| t127-③ | §21.2 配方红线改双配方口径；README 同步；文档一致性测试锁定两文档均含 privilegedHosts/ASCEND_RT_VISIBLE_DEVICES/26.0 且无过期单配方红线 | 「t128 文档一致性」 |
| t127-④ | 接管态 label 严格校验：须匹配 `^svc-[a-z0-9][a-z0-9-]{0,40}$` 且与容器名后缀一致；非空但错误（伪造/他人）→ FORBIDDEN | t126 接管用例新增 svc-somebodyelse / not-a-service-label 两段三操作断言 |

### 22.4.2 fresh-process 真实验证（2026-11-14 16:58，当前字节、真实 SSH）

方法：全新 Node 进程 import 当前 `index.js` 并 `apply()`（等价 Host 重载后的代码路径；Host 进程本身的重启由使用者执行，本验证不依赖旧进程状态），经 prefix 路由 HTTP handler（含鉴权分支）调用，execSsh 为真实 ssh 二进制。结果 **17/17 通过**：

- b01 preview（真实预检 npu-smi/ss/docker inspect/test -d）：recipe=**privileged-isolated**，argv 含 `--privileged --ipc=host -e ASCEND_RT_VISIBLE_DEVICES=0` + `--device=/dev/davinci6` + `127.0.0.1:18433:18433` + `--` 分隔；
- c01 preview（未 opt-in）：recipe=**baseline-sandboxed**，argv **无** privileged/ipc/env 三件；
- 接管路径：b01 起自有 sleep 容器（正确 label `svc-f1e2d3`）→ status 接管 `health=running, adopted=true` → stop 成功且容器移除；
- 错 label 探针：`svc-somebody`（模式合法但后缀不符）→ status/stop 均 **FORBIDDEN**，容器手动清理；
- 收尾：b01 `docker ps -a --filter name=dsh-apf-svc-verify` 计数 0。

### 22.4.3 验证证据

- `node --check` index.js/client.js/deploy.js/deploy-exec.js（+tune.js/tune-exec.js）全 0；
- `node test/run-tests.mjs`：**90 passed / 0 failed**（85+t128 两项新增；含 t126 全部回归）；
- 宿主 envs.json：`deploy = { "allowRealExecution": false, "privilegedHosts": ["b01"] }`（执行门保持关闭）。

## 23. t131：msprof Profile P1——导入/展示/R01–R05（2026-11-16）

### 23.1 范围与依据

按 `docs/tuning-msprof-design.md`（t130，419 行，sha256 前 16 位 `4353bdebc46062b1`）实现 P1：`op_statistic.csv` / `kernel_details.csv` 解析、`profile-v1` 私有存储、R01–R05 证据规则、REST/工具、调优段 profile 子视图。P2（stream/memory/communication、host 关联）与 P3 不在本轮。不改 `deploy-exec.js` / `tune-exec.js` 执行语义；不自动跑 msprof、不连远端。

### 23.2 解析契约（对设计 §3.2/§5 的落实）

- **判型只看 header 指纹**：statistic 需 6 必需列（Device_id/OP Type/Core Type/Count/Total Time(us)/Ratio(%)），kernel 需 9 必需列（Device_id/Task ID/Stream ID/Name/Type/OP State/Accelerator Core/Start Time(us)/Duration(us)）；空文件 `empty_file`、未知 `unrecognized_header`，native `op_summary` 表头不命中任何 dialect（不冒充）。
- **us→ns 十进制定点**：`usToNsDecimal` 用 BigInt 定点（≤3 位小数精确；>3 位四舍五入 + `precisionLoss` 标记）；`NaN`/非十进制 → 拒绝。
- **真实样本验收值**（`fixtures/profile/`，源自 910B3 微 probe E1/E3，内容纯数值已核对无主机/路径/秘密）：Count 总和 **21**、三类 Total 和 **13170463 ns**（= 13170.463 us）、实例 **21** 条、100% 记录带 `row:N` 来源。
- **降级**：`Count=0` → `calls=0` + `mean/min/max` 空值 + `missing_reasons`；行级非法（NaN/负时长）→ `rejected` + session `partial`；缺必需列 → `PROFILE_PARSE_ERROR`（结构化，不猜）。CRLF/BOM/引号内嵌逗号换行（`""` 转义）均正确解析并保留记录起始行号。
- **counter 语义**：`aic_mac_ratio` 等 6 个 fraction counter → `verified`（值域 0..1 之外记 warning）；`aicore_time(us)`/`aiv_time(us)` → ns metric；`Ratio(%)`/`cube_utilization(%)` → `source_reported`（/100），不作硬件利用率。kernel 表缺 counter 列时返回 `counters_absent`（R02 skipped 的依据）。
- 聚合视图与实例视图分表存储（`record_kind` 区分），绝不相加。

### 23.3 存储与入口

- `<dataDir>/profile-v1/{real|demo}/<session_id>/manifest.json + ops.ndjson`；目录 0700、文件 0600、tmp+rename 原子写；`index.json` 会话列表；删除同步清理。与 `runs`/`hotspots`/`store.json` 完全独立，旧 90 项测试零回归（含旧 `op_summary` 热点导入路径）。
- REST（fail-closed 鉴权沿用，401 透传已测）：`POST /profile/imports`、`POST /profile/demo`、`GET /profile/sessions`、`GET/DELETE /profile/sessions/:id`（pattern `prof-[a-z0-9]{16}`）、`GET /profile/sessions/:id/report`。
- 工具：`ascend_profile_import` / `ascend_profile_list` / `ascend_profile_report`（结构化信封，`ProfileError` 不抛）。工具总数 16→19。
- 限额：≤8 文件、单文件 ≤4 MiB、总量 ≤8 MiB → `PROFILE_TOO_LARGE`（REST 层超大请求体由 HTTP 层 `INPUT_TOO_LARGE` 先拒，同为结构化拒绝）。

### 23.4 R01–R05 落实（设计 §6.2）

真实样本判定（与手算一致）：R01 `triggered`（LaserAttention 88.894% ≥30%，证据 `op_statistic.csv row:2`）；R02 `not_triggered`（duration 加权 `aic_mac_ratio`≈0.790 ≥0.5）；R03 `triggered`（Transpose+Cast 11.1% ≥10% 且 18 次 ≥10）；R04 `not_triggered`（两视图 Count/Total 容差内一致；doctored 丢实例样本 → `triggered`，测试锁定）；R05 `skipped`（21 <100 实例，不伪造中位数；合成 150×10us 样本 → `triggered`）。缺 `aic_mac_ratio` 列 → R02 `skipped`，结论明写「不能从算子名称或 AI Core 时间份额推断 MAC 利用率」。规则输出含 `evidence[]`（文件/行/字段/值）、`conclusion`、`actions`、`confidence`、`status`、`missing_fields`；全部文案经测试断言不含「必然提速」。

### 23.5 UI（调优段第四小节）

`ProfileSection`：导入（多选 file input，FileReader 读文本 → REST）、加载演示 profile、session 下拉 + 删除、会话摘要（session_id/state/parser/coverage/文件与 dialect/演示徽标）、Top 算子表（类型/核/次数/总时长 ns/份额/来源行）、R01–R05 建议卡（状态色 + 证据展开按钮 `aria-expanded` + 展开证据块 + 建议动作 + 缺失字段）。窄栏 390px 单列可读（沿用既有 token/样式）。locale zh/en 与 client 内嵌字典同步（399 平铺键 parity 断言）。

### 23.6 验证证据

- `node --check index.js` / `node --check client.js` / `node --check profile.js` 全过。
- `node test/run-tests.mjs`：**102 passed / 0 failed**（既有 90 + 新增 12；工具注册数断言 16→19 同步更新）。新增用例：CSV 基础（引号/内嵌换行/BOM/CRLF/行号）、us→ns（精确/舍入/精度标记/非法）、判型（真实表头/未知/空/native 不冒充）、op_statistic 真实样本（21/13170463/份额/行号/来源）、降级（Count=0/NaN/缺列/partial/CRLF）、kernel 真实样本（21 实例/row:8/0.79/counters_absent/负时长）、存储（0700/0600/列表/详情/删除/清理）、R01–R05 真实判定 + 缺 counter skipped + 禁语断言、R04 doctored/R05 合成触发、service（限额/未知格式/混合导入/demo/CRUD）、REST 全链 + 401 + 超大、UI（导入入口/空态 loading/摘要/Top 表/规则卡/证据展开/未展开不渲染/aria-expanded/locale parity）。
- 独立冒烟（本仓根 `node -e` 真实 fixture 全链）：导入→detail→report→list→delete 全通过；`index.json` 0600、`profile-v1` 0700 实测。

## 23.7 t133：t132 findings 修复（R05 真实分母 / R04 容差 / strict 默认 / 判型白名单 / 负值 NaN / 越界 / schema 校验 / NS 安全 / 串联）

### 23.7.1 修复对照（12 条 → 用例）

| Finding | 修复 | 对应用例 |
| --- | --- | --- |
| T132-01（blocker）R05 分母自比（share 恒 1.0） | 分母=**全部实例总时长**；分子/分母/share/candidate 写 metrics；按 op_type 分组（≥100 实例才候选） | `t133 T132-01`（150 TinyOp 10us + 3 HugeOp 500000us → not_triggered，share≈0.001，结论「份额不足」）；既有 R05 合成用例补分母断言（denominator=numerator='1500000'，单类样本 share=1 仍触发，证明分母真实存在而非恒等式） |
| T132-02 负 ns 时长 | Total/Min/Avg/Max 负值 → 行级 `rejected`（negative_duration，带字段+行号） | `t133 T132-02/03`（负 Total、负 Min 各 rejected；空值仍缺省不误伤） |
| T132-03 NaN 当空值 | `RAW_EMPTY` 移除 NaN；Min=NaN / kernel Start=NaN → 整行 `rejected`（not_a_decimal_us，字段+行号） | 同上用例（NaN 三断言 + Start 空值缺省回归） |
| T132-04 未知额外列进统计 | 判型白名单（statistic 9 列/kernel 45 列，可选列可缺席）；未知列 → `unknown_columns` 不进定量统计 | `t133 T132-04`（WeirdCol → unsupported + unknown 清单；白名单子集仍判型） |
| T132-05 R04 无容差 | Count 按 `max(1%, 0)`、Total 按 `max(1%, 1000ns)`，严格超出才触发 | `t133 T132-05`（100v99 not_triggered / 100v100 not_triggered / 100v98 triggered） |
| T132-06 R04 不查 ratio 越界 | 扫描聚合 `source_ratio` 与实例 ratio counter 的 [0,1] 越界 → mismatch（字段/值/行号） | `t133 T132-06`（1.5 / -0.5 → ratio_out_of_range） |
| T132-07 evidence 缺四要素 | R04 mismatch 带 row/kernel_row；R05 为 median/份额/实例集合各写 evidence；每条含 source_id/locator/transform/values | `t133 T132-01`（evidence 循环断言四要素）+ R05 合成用例同款断言 |
| T132-08 rejected 仍落库 | 默认 **strict**：有 rejected → `PROFILE_REJECTED_RECORDS` 整 session 不落库；显式 `partial` 才跳坏行；REST/工具透传 policy | `t133 T132-08`（一好一坏默认拒 + 列表 0；partial → state=partial/coverage；`lax` → PROFILE_INVALID_POLICY） |
| T132-09 越界 counter 进 metrics | 越界/非有限 ratio → warning + 不进 metrics；R02 因缺 counter skipped | `t133 T132-09`（1.5/-0.5 → metrics 无 aic_mac_ratio + R02 skipped missing aic_mac_ratio） |
| T132-10 落库不校验 | `commitSession` 前校验 session/op 必填、类型、sha256 64hex、op_id 16hex、sources 外键；非法 → `PROFILE_SCHEMA_INVALID` 不写字节 | Store 用例扩展（6 个非法子用例：bad session_id/sha/state/session 不一致/op_id/外键悬空） |
| T132-11 UI 只 mock | **server route + DOM 级联**：真实 apply() 路由 demo→sessions→detail→report→ProfileSessionView/ProfileRuleCard 用**真实载荷**渲染（row:2 行号文本、aria-expanded、evidence testid）→DELETE | `t133 T132-11` |
| T132-12 NS TypeError | `NS()` 删除 → `nsFromString()`（null 不抛）；R01–R05 结构化降级（`invalid_total_ns_records:N`） | `t133 T132-12`（'12.5' 全非法 → skipped；混合 → 仍计算 + 降级注记；R05 不抛） |

### 23.7.2 旧实现失败证明（要求 #2；t135 补全 12/12 对照）

`profile.js` 在 git 中尚未提交（t131 交付未含 commit），无 stash 基线；采用**旧行为 shim**（临时把修复点逐条改回 t133/t135 前的行为）运行测试后恢复。两轮 shim 覆盖全部 12 条 finding：

**第一轮（t133，3 处核心行为还原：R05 share=total/total 自比、R04 任意 count 差即触发、无 strict 策略）**：108 passed / 3 failed——失败为 `t133 T132-01`（R05 真实分母）、`t133 T132-05`（R04 容差）、`t133 T132-08`（strict 默认）。

**第二轮（t135，其余 9 条旧行为 shim）**——还原点：负值静默接受（S02）、'NaN' 计入 RAW_EMPTY 静默缺省（S03）、判型无白名单（S04）、R04 无 ratio 越界扫描（S06）、R04/R05 evidence 退回旧形状 {file,fields,values}（S07，含 R05 values 去掉 first_row/last_row）、越界 counter 照旧进 metrics（S09）、commitSession 跳过 _validateSession（S10）、nsFromString 直接 BigInt('12.5') 抛 TypeError（S12）。运行结果 **104 passed / 8 failed**，逐条失败输出（`node test/run-tests.mjs`，test 名 → 断言消息节选）：

| finding | 失败用例 | 旧实现失败输出（节选） |
|---|---|---|
| T132-02/03 | `t133 T132-02/03：负 Total / 负 Min / Min=NaN / kernel Start=NaN → 行级 rejected（不再静默）` | `Expected values to be strictly equal`（rejected 计数为 0，负值/NaN 被静默接受或缺省） |
| T132-04 | `t133 T132-04：未知额外列 → unsupported（unknown_columns），不进定量统计` | `Expected values to be strictly equal: 'unknown' ≠ 'statistic'`（无白名单，WeirdCol 文件照常判型） |
| T132-06 | `t133 T132-06：R04 扫描 ratio 越界 … 写 mismatch+行号` | `Expected values to be strictly equal`（mismatch_detail 无 ratio_out_of_range 条目） |
| T132-07 | `profile：R04 交叉核验（doctored 实例触发）/ R05 合成样本触发` | `evidence 缺 source_id`（R05 evidence 旧形状无四要素） |
| T132-07/T134-02 | `t135 T134-02：R04 每条 evidence 四要素非空（含 overview 代表行 locator）` | `source_id 非空：{"file":"op_statistic.csv","fields":[…],"values":{…}}`（R04 evidence 旧形状无 source_id/locator/transform） |
| T132-09 | `t133 T132-09：越界/非有限 ratio counter 不进 metrics，R02 走 skipped` | `越界 ratio 不得进入 metrics`（旧实现照旧 push aic_mac_ratio） |
| T132-10 | `profile：ProfileStore 私有存储（0700/0600/原子写/列表/详情/删除）` | `Missing expected exception: 应拒绝：manifest.session_id 非法`（旧实现无 _validateSession，非法 manifest 照常落库） |
| T132-12 | `t133 T132-12：total_ns 非整数字符串不抛 TypeError，结构化降级` | `Cannot convert 12.5 to a BigInt`（旧 NS 直接 BigInt 抛 TypeError） |

**T132-11（REST+DOM 级联）**：该 finding 的修复本身就是新增级联测试（产品代码无 delta——t131 已具备 demo/会话/详情/报告路由与渲染），故不存在可还原的旧行为；级联用例在旧字节上同样通过，无旧/新差异可证，如实记录。恢复新实现后全量 **113 passed / 0 failed**。

### 23.7.3 验证证据（t135 后）

- `node --check index.js` / `node --check client.js` / `node --check profile.js` 全 0。
- `node test/run-tests.mjs`：**113 passed / 0 failed**（t133 后 111 + t135 新增 1：R04 evidence 四要素非空；既有用例零删除，无断言改写）。
- 旧行为 shim 两轮共 **11/12 条 finding 有旧实现失败输出**（t133 轮 3 failed + t135 轮 8 failed，见 23.7.2 的 12/12 对照表）；T132-11 产品代码无 delta，如实记录为不可反证。

### 23.7.4 t135 修复（T134-01/02）

- **T134-02**：`ruleR04` 的两条 overview evidence 此前 `row:''/locator:''`——现填代表行（首个聚合/首个实例的 `row:N` locator，`profile.js` ruleR04 内 `firstAggRow/firstInstRow`）；新增用例 `t135 T134-02：R04 每条 evidence 四要素非空` 对 triggered R04 的**每条** evidence 断言 source_id/locator/transform/values 非空（含 overview 两条 locator=='row:2'）。
- **T134-01**：补全 9 条 finding 的旧行为 shim 与逐条失败输出（见 23.7.2 第二轮表）。
