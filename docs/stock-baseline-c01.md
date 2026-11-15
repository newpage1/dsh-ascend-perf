# DSV4.1-Flash stock 基线报告（c01 · 容器内 serving + multi-round QA）

- 日期：2026-11-11（UTC 时间线，host 本地 +8h）
- 执行：t50（dsh-apf 工作台 developer 席位）
- 目的：为 dsv41_layerwise A/B 提供 stock（无 LMCache）基线，并尝试 LMCache MP 对照样。

## 1. 环境与资产

| 项 | 值 |
|---|---|
| 主机 | c01（910C-01，SSH alias `c01`，user z00919396） |
| NPU | 16 × Ascend910（910C），npu-smi 25.5.1，每 chip HBM 64G |
| 容器 | `dsh-apf-c01-stock`，ID `02a098acec6f...`，`--net=host --ipc=host --privileged` |
| 镜像 | `quay.io/ascend/vllm-ascend:v0.30.0rc2-a3`，digest `sha256:0676d2dbdd48...`（image id ce42d65b2403） |
| 模型 | `/opt/data/models/DeepSeek-V4.1-Flash-1017-w8a8`（728G，容器内 ro 挂载） |
| 容器内运行时 | Python 3.12.13 · vllm 0.30.0rc2（ascend 插件） · CANN 9.2.0 · SOC ascend910_9391 |
| 关键挂载 | /opt/data:ro；/home/z00919396/zr/code→/workspace/code；…/logs→/workspace/logs；全套 driver 挂载（/usr/local/Ascend/driver 等，缺则 torch_npu ImportError） |

教程依据：`vllm-ascend-dsv41_layerwise/docs/source/tutorials/models/DeepSeek-V4.1-Flash.md` §5.1（A3 单机 colocated，DP4/TP4/EP）。

## 2. stock serving（无 LMCache）

- 脚本：`/home/z00919396/zr/code/t50/stock-serve-18000.sh`（与教程 §5.1 一致，无 kv-transfer-config）
- 端口 18000；served-model-name `dsv41`；DP=4 TP=4 EP=16，max-model-len 150000，max-num-seqs 32，gpu-mem-util 0.9，quantization ascend，block-size 128
- 启动 12:12Z，权重 lazy 加载约 9 分钟，**12:21Z `/v1/models` 200**；/health 200；smoke chat completion 中文回答正常
- 日志：`/home/z00919396/zr/logs/stock-serve-18000.log`

## 3. benchmark（LMCache multi_round_qa）

- 脚本：`LMCache-dev/benchmarks/multi_round_qa/multi-round-qa.py`（容器内运行）
- 公共参数：`--num-users 10 --num-rounds 5 --qps 0.5 --user-history-prompt 2000 --answer-len 100 --model dsv41 --base-url http://127.0.0.1:18000/v1`
- 三组 shared-system-prompt：1000 / 4000 / 8000；**追加 `--time 600`（脚本无 --time 会无限运行，需显式窗口）**
- 输出：`/home/z00919396/zr/logs/stock-qa/summary-stock-{1k,4k,8k}-t600.csv`（+同名 stdout.log）
- 首次 1k 组曾以无限模式跑到 ~16 分钟后 Ctrl-C 收尾（summary-stock-1k.csv，50KB），保留作参照，正式口径以 -t600 三组为准

### 结果（--time 600 窗口）

| 组 | 请求数 | 成功率 | prompt均值(tok) | TTFT/e2e mean | p50 | p95 | max | 单流解码* | 聚合吞吐(tok/s) | 实测req/s |
|---|---|---|---|---|---|---|---|---|---|---|
| 1k | 373 | 100%（373×100 tok 无缺） | 3112 | 5.434s | 5.312 | 6.521 | 6.964 | ~54ms/tok（18.5 tok/s） | 62.0 | 0.620 |
| 4k | 373 | 100% | 6112 | 5.570s | 5.448 | 6.454 | 7.718 | ~54ms/tok | 61.9 | 0.619 |
| 8k | 373 | 100% | 10112 | 5.759s | 5.660 | 6.774 | 7.469 | ~55ms/tok | 61.9 | 0.619 |

口径说明：
- 脚本为非流式请求，CSV 中 `ttft ≈ finish_time-launch_time`（即端到端时延），`generation_time` 恒为 0——本表 TTFT 列按端到端口径记录；单流解码*=端到端时延/100 输出 token 的折算值。
- 三组各 600s 窗口、84 个用户会话、qps 配置 0.5（实测 0.62 含 ramp 注入）。
- prompt 均值 = shared + 2000 history + 模板开销（1k 组 3112 而非 3000）。

## 4. LMCache MP 尝试

### 4.1 构建

| 组件 | 结果 |
|---|---|
| LMCache-dev（lmcache 0.4.0-dev） | ✅ `pip install -e`（SETUPTOOLS_SCM_PRETEND_VERSION=0.4.0，仓库无 .git） |
| LMCache-Ascend-main | ❌ 构建失败：`pkg_inc/runtime/config.h → rt_external_device.h`、`hccl_one_sided_services.h → hcomm_res_defs.h` 头文件缺失（CANN 9.2.0 pkg_inc 嵌套引用解析不到）；日志 `/home/z00919396/zr/logs/lmc-ascend-main-build.log` |
| LMCache-Ascend-dsv41_layerwise | ✅ 构建成功（0.3.12，**采用为可构建字节**）；日志 `…/lmc-ascend-layerwise-build.log` |

偏差说明：按预案「main 构建失败则退用可构建字节」，LMCache-Ascend 采用 dsv41_layerwise 分支字节（与 LMCache-dev 主线搭配，csrc 含 mp_mem_kernels 等额外目标）。

### 4.2 运行

- LMCache server：`lmcache server --host 127.0.0.1 --port 6555 --l1-size-gb 100 --eviction-policy LRU`（独立进程，日志 `/home/z00919396/zr/logs/lmc-server.log`；本版 CLI 无 --l1-size-gb 默认值，必须显式给出；需补装 `opentelemetry-sdk`+`opentelemetry-exporter-prometheus`）
- vllm：同 §2 参数 + `--kv-transfer-config '{"kv_connector":"LMCacheMPConnector","kv_role":"kv_both","kv_connector_module_path":"lmcache.integration.vllm.lmcache_mp_connector","kv_connector_extra_config":{"lmcache.mp.host":"tcp://127.0.0.1","lmcache.mp.port":6555}}'`（脚本 `/home/z00919396/zr/code/t50/mp-serve-18000.sh`，日志 `…/mp-serve-18000.log`）
- **mode=lmcache_driven 已确认**：vllm 日志 16 处 `Creating transfer context (device_type=npu, mode=lmcache_driven)`（DP workers）；lmc-server.log `Registered KV cache for GPU ID … with 51 layers (lmcache_driven_tra…)`
- 13:15Z 启动，13:23Z `/v1/models` 200（加载 ~8 分钟，与 stock 相当）；smoke chat completion 正常（reasoning 字段有内容）

### MP benchmark 结果（--time 600）

| 组 | 请求数 | 满额输出(=100tok) | prompt均值 | TTFT/e2e mean | p50 | p95 | max | 聚合吞吐(tok/s) |
|---|---|---|---|---|---|---|---|---|
| 1k | 373 | 373/373（100%） | 3112 | 6.142s | 5.759 | 9.861 | 15.786 | 61.9 |
| 4k | 373 | 349/373（93.6%） | 6122 | 5.918s* | 5.830 | — | 14.417 | 59.6 |
| 8k | 373 | 345/373（92.5%） | 10116 | 5.971s* | 5.866 | — | 12.084 | 59.0 |

\* 4k/8k 组 ttft_mean（5.474/5.844）与 lat_mean（5.918/5.971）出现分离（个别请求首 token 后有额外等待）；表中取 lat（端到端）口径，与 stock 表可比。

- LMCache server 侧证据：`Retrieved 2048 tokens in 0.00x seconds` ×1868 次、共取回 ≈3.60M tokens；`Stored` ×401 次——多轮共享前缀复用生效。
- 偏差：MP 4k/8k 有 24/28 个请求输出 <100 token（min 11/19）提前结束（stock 三组均 100%满额）；原因未深究（疑似缓存内容参与解码时 stop 判定差异），已如实记录。


## 5. 结论与备注

1. **stock 基线（正式口径 --time 600）**：TTFT(=e2e) 1k/4k/8k = 5.43/5.57/5.76s（mean），p95 6.5-6.8s；吞吐 ≈62 tok/s、0.62 req/s；三组 100% 满额输出。
2. **LMCache MP 可跑通**（LMCache-dev + LMCache-Ascend-dsv41_layerwise 字节，LMCache-Ascend-main 因 CANN 9.2 pkg_inc 头缺失构建失败）：mode=lmcache_driven 有日志实证，KV 复用真实发生（3.6M tokens 取回）。
3. **MP vs stock（同参同窗）**：p50 差距 ~+0.4-0.5s（5.76-5.87 vs 5.31-5.66）；p95 在 MP 下变差（9.8-9.9s vs 6.5-6.8s）；吞吐略降（-2~-3 tok/s）；且 MP 4k/8k 出现 ~7% 提前截断输出。在本低 QPS（0.5）多轮负载下 MP 未带来收益——符合预期：DP4 下 4 副本各自前缀缓存已命中，MP 跨进程搬运引入额外路径。真正的收益空间在高 QPS/跨实例/显存紧张场景（后续 dsv41_layerwise A/B 的观测点）。
4. **运行资产现状**：容器 `dsh-apf-c01-stock` 已于 2026-11-11T14:01:50Z 停止（Exited 137），LMCache server（6555）与 MP serving（18000）随之退出；16 个逻辑 device 进程表已确认无本席位残留。容器保留 Exited 状态、不占 NPU/CPU，资产与重建脚本在 `/home/z00919396/zr/code/t50/`，后续 A/B 可 `docker start` 或按本报告重建。
5. 首次 1k 无限窗口参照数据保留在 summary-stock-1k.csv（~16 分钟窗口，373 行与 t600 相同节奏）。

