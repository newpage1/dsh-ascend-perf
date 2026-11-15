---
name: ascend-deploy
description: 在共享昇腾 NPU 主机上，用容器安全地跑一次测试（冒烟/自定义命令/vLLM 服务+基准）。只使用显式指定的空闲卡，只挂这些卡的设备节点；默认 dry-run，不启停他人容器，不 docker stop，不写远端。用于验证代码分支/镜像在真实 NPU 上的可用性。
---

# ascend-deploy — 昇腾容器测试 skill

在共享昇腾环境上做“给定环境 + 给定镜像/代码 + 指定空闲卡”的容器测试。默认只打印 docker 命令（dry-run），加 `--run` 才真正执行。

## 硬性安全边界

1. **只用显式指定的空闲卡**：`--cards 6,7` 必须由用户或面板确认空闲；脚本仍会复查 HBM < 10% 且 AICore < 5%，不满足直接拒绝。
2. **只挂指定卡**：只传 `/dev/davinci6`、`/dev/davinci7` 等；另加 `/dev/davinci_manager`、`/dev/devmm_svm`、`/dev/hisi_hdc`。不传整机 `--privileged`。
3. **不要设置 `ASCEND_RT_VISIBLE_DEVICES=6,7`**：容器内设备会被重映射为逻辑 0..N-1，设宿主卡号会导致 `torch.npu.device_count()=0`。只靠 `--device` 限制可见卡。
4. **不 docker stop / 不 kill 他人容器**：容器 `--rm`，内部命令执行完自行退出；`timeout` 在容器内兜底；脚本不调用 `docker stop`。
5. **只用自有标签**：`--name dsh-apf-test-<ts>`、`--label dsh-ascend-deploy.test=1`；结束后用标签确认无残留。
6. **模型只读挂载**：`-v <model-dir>:/models:ro`；serve 端口只绑 `127.0.0.1`，执行前检查端口未被占用。

## 用法

```sh
# 1) 只打印命令（默认 dry-run）
python3 ascend-perf/skills/ascend-deploy/scripts/ascend-deploy.py \
  --host b01 --cards 6,7 --mode smoke

# 2) 真正跑冒烟（NPU 可见性 + 2048 matmul）
python3 .../ascend-deploy.py --host b01 --cards 6,7 --mode smoke --run

# 3) 自定义命令
python3 .../ascend-deploy.py --host b01 --cards 6,7 --mode exec \
  --cmd 'python3 -c "import torch_npu; print(torch_npu.npu.device_count())"' --run

# 4) vLLM 服务 + 健康检查 + 一次生成 + 可选 bench
#    --workspace 是用户可配置的挂载目录（默认 /home/z00919396）
#    --model-root 默认 /home/z00919396/models；b01 实际模型在 /data1/models
python3 .../ascend-deploy.py --host b01 --cards 6 --mode serve \
  --workspace /home/z00919396 --model-root /data1/models \
  --model meta-llama__Llama-3.2-1B-Instruct \
  --served-name meta-llama__Llama-3.2-1B-Instruct \
  --port 18443 --tp 1 --max-model-len 2048 --bench --run
```

`--json` 输出结构化结果（host/cards/container/exit_code/stdout）。

## 已验证配方（b01，2026-11-10）

- 镜像：`quay.io/ascend/vllm-ascend:v0.23.0`（CANN 9.1.0 / torch 2.10.0+cpu / torch_npu 2.10.0.post4 / vllm 0.23.0）
- 空闲卡 6（910B3 单 chip）：容器内 `torch.npu.is_available()=True`、`device_count=1`，2048 matmul 正常。
- 真实小模型 `meta-llama__Llama-3.2-1B-Instruct`（位于 `/data1/models`，1.7G 级）在 card 6 上 serve 成功，`/v1/models` 就绪，`/v1/completions` 返回正常文本。
- `vllm bench serve`（64 prompts / concurrency 8）：64/64 成功、4.31 req/s、输出 551.88 tok/s、TTFT mean 526.55ms / P99 3162ms、TPOT mean 10.45ms / P99 11.38ms。
- 容器内无 `npu-smi`，`torch_npu` 会打印 `can not use command: npu-smi info`，无害。
- 原主机 6 个容器未动；测试容器 `--rm` 自动清理；`docker ps -a --filter label=dsh-ascend-deploy.test=1` 为空；card 6 采集恢复 HBM 5%、AICore 0。

## 当前能力与边界

- 已支持：smoke / exec / serve+健康检查+可选 `vllm bench serve`。
- 未支持：自动 clone/build 代码分支；需要先在远端准备好镜像/模型，或后续把 `repo/ref` 构建步骤补进 skill。
- 镜像必须已在远端 `docker images` 中存在，或由用户提前 pull；skill 不隐式拉取大镜像。
