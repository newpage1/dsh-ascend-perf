# fixtures 说明

本目录是插件自测与演示用的固定输入，均为**脱敏后的真实输出**或**明确标注的合成数据**，不含主机名、IP、私钥、账号与业务模型路径。

| 文件 | 来源 | 用途 |
| --- | --- | --- |
| `npu-info-8cards.txt` | 共享昇腾环境 `npu-smi info` 原始输出（2026-11-07，已脱敏） | 验证 8 卡 × 2 chip 去重、HBM/温度/功耗解析、`-` 缺值处理 |
| `npu-usages-card0.txt` | 同一环境 `npu-smi info -t usages -i 0` 原始输出 | 验证两个 chip 的 usages 不串值（`Chip ID` 分组） |
| `npu-info-missing.txt` | 基于真实格式构造的缺失样例 | 验证功率/温度/HBM 缺失时置 `null` 并写 `missing_reasons`，不得用邻值顶替 |
| `vllm-benchmark-baseline.json` | 合成（vLLM benchmark 输出结构） | 基线运行导入、指标归一化、热点解析 |
| `vllm-benchmark-candidate.json` | 合成，与基线同条件、吞吐 −8%、TTFT p99 +13% | 回归对比（`regressed`）与 TTFT 洞察 |
| `vllm-benchmark-concurrency-array.json` | 合成，同模型 3 组并发（32/64/128） | 批量导入与并发饱和洞察（`heuristic`） |
| `vllm-benchmark-missing-fields.json` | 合成，仅含请求吞吐与部分元数据 | 缺字段降级（`missing`/`unknown`） |
| `vllm-benchmark-bad.json` | 合成，截断的 JSON | 坏格式（`PARSE_ERROR`），不得产生半条记录 |
| `benchmark.csv` | 合成，标准 28 列表头 | CSV 导入（每行一个 run）与 `inf` 处理 |
| `msprof-op-summary.csv` | 合成，`Op Name` + `Task Duration(us)` | 算子热点导入，仅热点排行、不代表 wall time |
| `ssh-failure.txt` | 构造的 SSH 失败文本（含 `exit: 255`） | 说明只读 SSH 失败时的错误形态；不用于自动重试 |

## 解析提示

- `npu-smi info`：同一 NPU 会出现多组“卡行 + 芯片行”，必须按第一列 `NPU ID` 去重合并；chip 由 `Phy-ID` 去重，禁止用行数当卡数。
- 每卡 `npu-smi info -t usages -i N` 才会返回指标；26.1.1 上裸 `-t usages` 退出码为 215。
- 缺失值保持 `null` + `missing_reasons`，不要补零、不要复制同卡另一 chip 的值。
- benchmark JSON 的 `date/timestamp` 必须带时区；无时区时记 `TIMESTAMP_UNKNOWN`，不得臆造时间。

## 安全

- 样例中的主机名、IP、路径与模型私有目录已移除或替换；`docs/samples/` 保存了更完整的采集原始样例（同样脱敏）。
- 本目录仅用于测试与演示，不可作为线上监控数据源。
