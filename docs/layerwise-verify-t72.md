# t72 复验报告：dsv41_layerwise 单请求最小闭环（c01）

- 时间：2026-11-12 14:35–14:50 UTC（c01 本地 22:35–22:50）
- 复验人：developer（t72，attempt bcb68547）
- 被验对象：t71 修复后的 dsv41_layerwise 三仓（由 layerwise-dev 提交并推送）
- 结论：**五项验收全部通过**；t71 修复真实有效——init 阶段旁路、真实请求仍走准入、无 admission window 错误、单请求真实前向成功。

## 0. 代码身份（三仓 commit + 逐文件哈希）

| 仓库 | 分支 | commit |
| --- | --- | --- |
| vllm-ascend | dsv41_layerwise | `b2190a322` fix(dsv41-layerwise): bypass admission during engine init and adapt 0.30 calls |
| LMCache | dsv41_layerwise | `0258e4d` feat(mp): layerwise transfer RPC contract + host storage module（t63，未变） |
| LMCache-Ascend | dsv41_layerwise | `351701c` fix(mp): declare a cold step when scheduler metadata carries no request |

关键文件 sha256（git blob ↔ c01 容器实际字节，前 16 位全部一致）：

| 文件 | 哈希 |
| --- | --- |
| vllm_ascend/attention/dsv41_layerwise_admission.py | 3af4f4154c478217 |
| lmcache/v1/multiprocess/modules/layerwise_transfer.py | 64fd0b15cf62a35b |
| lmcache/v1/multiprocess/transport/base.py | be2e8baf41e8d5ca |
| lmcache_ascend/integration/vllm/dsv41_mp_adapter.py | 2e6efbd4b4ec89f4 |
| lmcache_ascend/integration/vllm/dsv41_mp_connector.py | 55f7dcae4a69690d |

容器：dsh-apf-c01-t71（镜像 quay.io/ascend/vllm-ascend:v0.30.0rc2-a3，--net=host --ipc=host --privileged，16 逻辑 device）。

## 1. 服务就绪 + 单请求真实前向（验收 ③）

- `GET /v1/models` → **200**（容器 Up 2h，t71 14:38:30Z 起服务）。
- t72 独立新发两个 chat 请求（非 t71 留档的旧请求）：
  - smoke-1（22:45 本地 / 14:45:36Z）：HTTP **200**，2.05s，id=`chatcmpl-94f0b14b97e07f3d`，finish=length，prompt 39 / completion 64 tok，`message.reasoning` 117 字符（开头逐字复述本复验的提示词「t72复验：用一句话说明你是谁」→ 真实前向输出）。
  - smoke-2（14:45:38Z）：HTTP **200**，1.23s，id=`chatcmpl-8b8ec292f5a95533`，prompt 45 / completion 32 tok，reasoning 51 字符。
- 推理模型 `content` 为空白（len=2），输出承载在 `message.reasoning`——符合 captain 指引，输出非空成立。
- JSON 证据：`/home/z00919396/zr/logs/t71/t72-smoke-{1,2}.json`。

## 2. 日志证据（验收 ④ 前半）

`serve-t71.log` 全量 grep（bash -s 干净脚本，避免引号歧义）：

| 标记 | 计数 | 含义 |
| --- | --- | --- |
| `has never opened an admission window` | **0** | t71 修复的核心错误消失 |
| `NotImplementedError` | **0** | 传输缝不在 stub 上炸 |
| `aclnnHcPre` | **0** | t64 的算子路由问题未复现 |
| `DSV41LayerwiseAdmissionError` | **0** | 运行期零准入异常 |
| `admission registry bound` | **16** | 16 worker 全部绑定注册表 |
| `admission granted` | **640** | 16 worker × 40 层（每 worker 每层一次性 grant 日志） |
| `retrieved KV ready` / `KV produced` | **640 / 640** | 逐层 KV 生命周期完整 |
| `synthetic engine forward bypassed admission` | **640** | init/capture 阶段 16×40 层全部走显式旁路（独立标记，与 granted 可区分） |

## 3. init 旁路 vs 真实请求仍走准入（captain 追加项，关键辨析）

- 代码语义（b2190a322 的 `dsv41_layerwise_admission.py`）：`admission granted` 与 `synthetic ... bypassed` 都是 **once-per-layer** 日志（`_logged_grants`/`_logged_bypasses` 集合，行 65/行 13）——我 14:45 的真实请求不再新增 granted 行是**设计使然，不是绕过**。
- 真实请求走完整链路的直接证据：
  1. `lmc-server.log` 14:45:36/14:45:38 出现**我的两个 chatcmpl id** 的 per-request lookup 会话（`Session chatcmpl-94f0b14b97e07f3d-… / chatcmpl-8b8ec292f5a95533-…`）——enqueue 真实到达 MP server；
  2. 两请求 200 完成且全日志 0 admission 错误——fail-closed 契约下未过准入必然 raise，能完成即证明窗口开启并放行；
  3. init 旁路仅在 `_init_phase=True`（`set_init_phase`/上下文管理器）生效，docstring 明示 "Outside synthetic windows: always False"。
- UT 佐证（`tests/ut/attention/test_dsv41_layerwise_init_phase.py`，6 passed）："Real request steps keep the fail-closed contract: with a registry bound and no admission window, `wait_for_layer_load` still raises"。

## 4. 测试复跑（captain 追加项）

- 聚合套件（dsv41-layerwise harness，CPU）：**133 passed**（1.72s，本席独立复跑）。
- 冷步三条：`pytest tests/test_connector.py -k cold` → **3 passed**（test_fully_cold_step_opens_step_level_windows / test_cold_step_then_real_step_keeps_full_lifecycle / test_cold_no_hit_request_admits_and_stores）。
- vllm-ascend UT：`tests/ut/attention/test_dsv41_layerwise_init_phase.py --noconftest` → **6 passed**。
- 删哨兵分支的反向验证：t71 交付记录（2 failed + KeyError: '_COLD_STEP_REQUEST'）——本席未改代码复核，采信依赖产出并以其落盘证据为准。
- 注意事项（留给后续席位）：把 origin 版 admission 文件同步进 harness worktree 会使聚合套件 `ModuleNotFoundError: No module named 'vllm'`（该文件 import vllm.logger，harness 不 stub）；t71/t72 的 133 是 worktree 旧字节（302e5369e / af0919e2f74b0eee）跑的，复验时保持 worktree 原状。

## 5. 契约 verify 命令

- `git -C repos/vllm-ascend diff --check` → exit 0。
- `python3 -m compileall -q repos/vllm-ascend/vllm_ascend`（.venv Python 3.11.15）→ exit 0。

## 6. 清理（验收 ⑤）

- 容器内 `pkill -9 -f '[V]LLM' / '[E]ngineCore' / '[l]mcache'`（方括号模式防自匹配）→ `docker stop dsh-apf-c01-t71`（重试法）→ `docker rm -f`。
- 清理后：`docker ps -a` 无任何 dsh-apf 残留；`npu-smi info` 8 卡全部 "No running processes"（16 逻辑 device 无本席位残留）。

## 7. 证据清单

- c01 `/home/z00919396/zr/logs/t71/`：t72-smoke-{1,2}.json、t72-verify-summary.txt（全部计数+请求 id 关联行）、serve-t71.log、lmc-server.log。
- c01 报告：`/home/z00919396/zr/reports/layerwise-verify-t72.md`（本文件）。
- 本地副本：`ascend-perf/docs/layerwise-verify-t72.md`。
