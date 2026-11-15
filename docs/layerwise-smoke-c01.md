# t64 · c01 单请求 layerwise 端到端 smoke 报告

日期：2026-11-12 · 执行：developer（attempt 495218cc）· 结论：**未跑通——精确 blocker 已定位（vllm-ascend 分支引擎侧原生算子路由 × CANN 9.2.0 算子库缺口），与 LMCache/layerwise 传输缝无关**

## 1. 代码版本（三 hash 实测使用）

| 仓库 | commit | 用法 |
|---|---|---|
| vllm-ascend dsv41_layerwise | 302e5369e（t62） | rsync → c01 `/home/z00919396/zr/code/vllm-ascend-dsv41_layerwise`，容器内 `PYTHONPATH=/workspace/code/vllm-ascend-dsv41_layerwise` 影子加载；6 关键文件 sha256 本地↔远端全等 |
| LMCache dsv41_layerwise | 0258e4d（t63） | 容器内 editable 安装（SETUPTOOLS_SCM_PRETEND_VERSION=0.4.0） |
| LMCache-Ascend dsv41_layerwise | 00fda61（t63） | 容器内源码构建安装 0.3.12（install-lmc-ascend-2.log EXIT=0，ops 导入冒烟过） |

镜像：quay.io/ascend/vllm-ascend:v0.30.0rc2-a3（未新拉）。模型：/opt/data/models/DeepSeek-V4.1-Flash-1017-w8a8（728G）。容器：dsh-apf-c01-t64（--net=host --ipc=host --privileged + 全套 driver 挂载；已停止并删除）。

## 2. 环境前置核验

- 启动前 16 逻辑 device（8 卡×2 chip）全空闲：AICore 0%、HBM≈2.8–3.2GB/64GB 基线、NPU 0–7 进程表 No running processes（setup.log）。
- 他人容器（lmcache-mp-hixl-c00948744、modes-*、serving030-*、sd-*、clmjev-* 等）全程未触碰；自有旧容器 dsh-apf-c01-hitrate（已 Exited）删除。
- lmcache server（127.0.0.1:6555，--l1-size-gb 100 --eviction-policy LRU）就绪（lmc-server.log，无错误）。

## 3. 执行过程（逐层兼容 backport → 到达模型前向 → blocker）

分支代码在 0.30.0rc2 镜像内启动需要 10 层文件级 backport（全部容器内编辑，符合 t61 §3.1.1 方法；每层日志见 serve-layerwise*.log 各 attempt）：

| # | 缺口 | 处置 |
|---|---|---|
| B1 | vllm 0.30 无 kv_cache_planning 模块（分支误判版本巷道） | 镜像 vllm 建 kv_cache_planning.py = kv_cache_utils 模块别名 shim |
| B2 | engram_head_shard_rank（main-only） | 上游原文逐字追加到镜像 engram.py |
| B3 | transformers_utils.deepseek_v4_utils 缺失 | 上游整文件（812B）docker cp |
| B4 | enable_dsa_cp 键 0.30 拒收 | 从 serve 参数删除（分支代码 0 消费） |
| B5 | acl.rt 导入路径 | set_env.sh 前置 CANN python 路径（PYTHONPATH 追加式修正） |
| B6 | fusion.mm_input_norm 缺失 | 上游 422 行整文件（本机 curl→scp→docker cp） |
| B7 | spec_decode.target_dependent_ar 包缺失 | 最小 shim 包（唯一消费点立即覆写，上游实现 Ascend 不用） |
| B8 | target_dependent_ar.cudagraph_utils 再导出 | 从镜像 spec_decode/autoregressive 真类再导出 |
| B9 | gumbel._log1p_neg_stable 缺失 | 上游 @triton.jit 原文逐字追加 |
| B10 | VllmConfig.aux_output_config 属性缺失 | 类属性注入（enabled=False 等价 main 未启用路径） |

backport 后到达模型首个真实前向（26 workers 全部 spawn、权重加载完成）——**blocker**：

```
RuntimeError: aclnnHcPre or aclnnHcPreGetWorkspaceSize not in libopapi.so, or libopapi.sonot found.
  File ".../vllm_ascend/models/deepseek_v41/model.py", line 767, in hc_pre
    return torch.ops._C_ascend.npu_hc_pre_v3(
  调用参数（插桩实测）：x=npu bf16 (8,4,5120) fn=npu fp32 scale/base=fp32 pm=npu fp32 (8,4) hc_mult=4 iters=20
```

## 4. 决定性对照实验（根因定位）

| 实验 | 配置 | 结果 |
|---|---|---|
| stock（t50 脚本原样，无 PYTHONPATH、无 kv-transfer） | 镜像代码 | ✅ 两次成功：04:23:38Z /v1/models=200 + smoke 对话成功；04:44Z Application startup complete |
| 分支 overlay + 无 kv-transfer（实验 A/A2/A3） | 仅 PYTHONPATH 指向分支 | ❌ 同一 aclnnHcPre 错误（04:28:47Z/04:36/04:51 三次复现，参数插桩一致） |
| 分支 overlay + kv-transfer（attempt13，03:42:11Z） | 完整目标配置 | ❌ 同一错误（未到达 enqueue_step_transports） |

根因链（全部实证）：
1. **非容器/镜像/B1–B10 backport 问题**：同容器同镜像 stock 两次跑通（间隔仅 20 分钟）。
2. **非 kv-transfer/LMCache 问题**：去掉 kv-transfer 后分支 overlay 独立复现。
3. 模型 Python 代码逐字节一致（init/hc_pre/前向形状：镜像 855–880 行 vs 分支 766–777 行）。
4. 分歧在原生算子内部路由：**stock worker 只加载分库 opapi（libopapi_cv/math/nn/oam/ras/transformer，/proc/PID/maps 实证），hc_pre 走纯 NPU 核路径**；**分支 worker 额外加载 /usr/local/Ascend/cann-9.2.0/opp/vendors/batch_invariant/op_api/lib/libcust_opapi.so（HCPRE_MAPS 插桩实证），hc_pre 派发进入 dlsym aclnnHcPre 路径**。
5. CANN 9.2.0 两份 libopapi.so nm -D 均无任何 aclnnHc* 符号 → dlsym 必然失败。

**结论**：vllm-ascend dsv41_layerwise 分支的 custom-op bootstrap/batch-invariant vendor 注册路径与 0.30.0rc2 镜像不同，使 hc_pre 选择需要 aclnnHcPre 的路由，而 CANN 9.2.0 不提供该符号。属**引擎侧（vllm-ascend 分支）兼容缺口**，LMCache/LMCache-Ascend 侧无法修复；需分支回移植 0.30.0rc2 的 custom-op 路由，或 CANN 升级到含 aclnnHcPre 的版本。layerwise 传输缝（t63 交付）在本次运行中未被执行到。

## 5. 失败的最小复现

```bash
# c01：容器（已删，可重建）
docker run -d --name dsh-apf-c01-t64 --net=host --ipc=host --privileged \
  -v /usr/local/dcmi:/usr/local/dcmi -v /usr/local/Ascend/driver/tools/hccn_tool:/usr/local/Ascend/driver/tools/hccn_tool \
  -v /usr/local/bin/npu-smi:/usr/local/bin/npu-smi -v /usr/local/Ascend/driver/lib64:/usr/local/Ascend/driver/lib64:ro \
  -v /usr/local/Ascend/driver/version.info:/usr/local/Ascend/driver/version.info:ro \
  -v /etc/ascend_install.info:/etc/ascend_install.info:ro -v /etc/hccn.conf:/etc/hccn.conf:ro \
  -v /home/z00919396/zr/code:/workspace/code -v /home/z00919396/zr/logs:/workspace/logs \
  -v /opt/data:/opt/data:ro quay.io/ascend/vllm-ascend:v0.30.0rc2-a3 sleep infinity
# 按 §3 表做 B1–B10 容器内 backport 后：
bash /home/z00919396/zr/code/t64/serve-branchA-18000.sh   # 分支 overlay 无 kv-transfer，4–5 分钟内 aclnnHcPre 崩溃
bash /home/z00919396/zr/code/t50/stock-serve-18000.sh     # 同容器 stock，约 8 分钟就绪
```

## 6. 清理与证据

- 容器内 vllm/EngineCore/lmcache 进程全部 pkill；NPU 0–7 进程表全空（8× No running processes）；dsh-apf-c01-t64 已 docker stop + rm；插桩的分支 model.py 已用本地母本还原。
- 证据目录 c01:/home/z00919396/zr/logs/t64/（14 文件）：serve-layerwise.log（attempt13 完整 traceback 3343 行）、t64-branchA{,2,3}-serve.log（对照实验+插桩）、t64-stock{,2}-serve.log（stock 两次成功）、lmc-server.log、install-lmc-ascend{,-2}.log、setup.log、stock-compare.status/smoke.json。
- serve/smoke 脚本：c01:/home/z00919396/zr/code/t64/{serve-layerwise-18000.sh,serve-branchA-18000.sh,stock-compare.sh}。

## 7. 验收对照（诚实标注）

| 验收项 | 结果 |
|---|---|
| 记录三 hash 并在容器内使用对应代码 | ✅ §1 |
| 16 device 启动前全空闲、未触碰他人容器 | ✅ §2 |
| 728B 服务就绪、单请求成功输出非空 | ❌ 分支配置未达就绪（stock 对照就绪成功，证明环境可用） |
| 日志证明 plan/admission 生成且 enqueue/wait 真实执行 | ❌ 未到达（首个前向即 blocker；无 NotImplementedError——t63 缝实现未被触达） |
| 清理自有容器且 NPU 无残留、报告与证据落盘 | ✅ §6+本文件 |
