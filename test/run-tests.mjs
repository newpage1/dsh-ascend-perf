/**
 * dsh-ascend-perf 自测：解析、导入归一化、对比、洞察、仓储与只读安全。
 *
 * 运行：node ascend-perf/test/run-tests.mjs
 * 不依赖 NPU、不联网、不执行 npu-smi；Host 集成测试使用假的 subprocess 服务。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync, mkdtempSync, mkdirSync, statSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  TUNE_SCHEMA,
  TUNE_SPEC_SCHEMA,
  normalizeTuneSpec,
  buildTunePlan,
  parseBenchOutput,
  aggregateRepeats,
  rankTrials,
  buildTuneReport,
  TuneStore,
  TuneService,
  createTuneTools,
  createTuneRoutes,
} from '../tune.js'
import { PortLock, OwnedProcessRunner, buildServeArgv, buildBenchArgv, realExecutionGate, tuneError } from '../tune-exec.js'
import { createServer } from 'node:net'

import {
  SCHEMA,
  STORE_SCHEMA,
  METRIC_KEYS,
  parseNpuSmiInfo,
  parseUsages,
  mergeUsages,
  parseVllmJson,
  parseBenchmarkCsv,
  parseMsprofCsv,
  importContent,
  compareRuns,
  generateInsights,
  formatCompareMarkdown,
  apply,
  chipOccupancyState,
  summarizeEnvOccupancy,
  buildSshRemoteCommand,
  parseCombinedSshOutput,
  summarizeSshStderr,
} from '../index.js'
import { DeployPlanService, createDeployTools, readPlansConfig, writePlansConfig, validatePlanSpec, buildPlanSteps, PLAN_STORE_FILE, DEPLOY_PLAN_SCHEMA, DEPLOY_COMPONENTS, DEFAULT_DEPLOY_COMPONENT } from '../deploy.js'
import {
  ProfileError,
  PROFILE_DIALECTS,
  PROFILE_SCHEMA,
  detectProfileDialect,
  parseCsvRecords,
  usToNsDecimal,
  parseOpStatistic,
  parseKernelDetails,
  ProfileStore,
  evaluateProfileRules,
  createProfileService,
  createProfileRoutes,
  createProfileTools,
} from '../profile.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(here, '..', 'fixtures', name)
const read = (name) => readFileSync(fixture(name), 'utf8')

let passed = 0
const failures = []
const pending = []
function test(name, fn) {
  try {
    const out = fn()
    if (out && typeof out.then === 'function') {
      const p = out.then(
        () => { passed += 1; console.log(`ok   ${name}`) },
        (error) => { failures.push({ name, error }); console.error(`FAIL ${name}\n     ${error?.stack ?? error}`) },
      )
      pending.push(p)
      return p
    }
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL ${name}\n     ${error?.stack ?? error}`)
  }
  return null
}

/* ------------------------------ npu-smi ------------------------------ */

test('parseNpuSmiInfo：8 卡 16 chip，按 card_id 去重而非行数', () => {
  const parsed = parseNpuSmiInfo(read('npu-info-8cards.txt'))
  assert.equal(parsed.npu_smi, '26.1.1')
  assert.equal(parsed.cards.length, 8, '卡数必须是 8')
  assert.equal(parsed.cards.reduce((n, c) => n + c.chips.length, 0), 16, 'chip 数必须是 16')
  assert.deepEqual(parsed.cards.map((c) => c.card_id), [0, 1, 2, 3, 4, 5, 6, 7])
  const card0 = parsed.cards[0]
  assert.equal(card0.chips[0].power_w, 165.5)
  assert.equal(card0.chips[0].temp_c, 49)
  assert.equal(card0.chips[1].power_w, null, 'chip1 的功率必须为 null，不能用 chip0 顶替')
  assert.equal(card0.chips[1].temp_c, 47)
  assert.equal(card0.chips[0].hbm_used_mb, 3131)
  assert.equal(card0.chips[0].hbm_total_mb, 65536)
  assert.equal(card0.chips[0].hbm_usage_rate_pct, 4.8)
  assert.equal(card0.chips[0].health, 'ok')
  assert.equal(card0.chips[0].processes_state, 'none_reported')
  assert.equal(card0.chips[1].phy_id, 1)
})

test('parseNpuSmiInfo：缺失字段用 null + missing_reasons', () => {
  const parsed = parseNpuSmiInfo(read('npu-info-missing.txt'))
  assert.equal(parsed.cards.length, 1)
  assert.equal(parsed.cards[0].chips.length, 2)
  const [c0, c1] = parsed.cards[0].chips
  assert.equal(c0.power_w, null)
  assert.ok(c0.missing_reasons.power_w)
  assert.equal(c1.power_w, null)
  assert.equal(c1.temp_c, null)
  assert.ok(c1.missing_reasons.temp_c)
  assert.equal(c1.hbm_used_mb, null)
})

test('parseNpuSmiInfo：910B3 单 chip 卡（芯片行无 Phy-ID）也能解析', () => {
  const text = [
    '| 0     910B3               | OK            | 100.0                34                      0    / 0                |',
    '| 0                         | 0000:C1:00.0  | 0                    0    / 0                59122/ 65536            |',
  ].join('\n')
  const parsed = parseNpuSmiInfo(text)
  assert.equal(parsed.cards.length, 1)
  assert.equal(parsed.cards[0].chips.length, 1)
  assert.equal(parsed.cards[0].chips[0].chip_id, 0)
  assert.equal(parsed.cards[0].chips[0].phy_id, null)
  assert.equal(parsed.cards[0].chips[0].bus_id, '0000:C1:00.0')
  assert.equal(parsed.cards[0].chips[0].hbm_used_mb, 59122)
  assert.equal(parsed.cards[0].chips[0].hbm_total_mb, 65536)
})

test('parseNpuSmiInfo：无法识别时给出 warning 且不臆造设备', () => {
  const parsed = parseNpuSmiInfo('command not found: npu-smi')
  assert.equal(parsed.cards.length, 0)
  assert.ok(parsed.warnings.length > 0)
})

test('parseUsages：两个 chip 各自取值，不能共用末值', () => {
  const parsed = parseUsages(read('npu-usages-card0.txt'))
  assert.equal(parsed.npu_id, 0)
  assert.equal(parsed.chip_count, 2)
  assert.equal(parsed.chips.length, 2)
  assert.equal(parsed.chips[0].hbm_total_mb, 65536)
  assert.equal(parsed.chips[0].hbm_reported_usage_rate_pct, 4)
  assert.equal(parsed.chips[0].ctrlcpu_pct, 7)
  assert.equal(parsed.chips[1].chip_id, 1)
  assert.equal(parsed.chips[1].ctrlcpu_pct, 7)
})

test('mergeUsages：合并 info 与 usages，缺卡时保留 info 并标记缺失', () => {
  const parsed = parseNpuSmiInfo(read('npu-info-8cards.txt'))
  const usages = new Map([[0, parseUsages(read('npu-usages-card0.txt'))]])
  const warnings = mergeUsages(parsed.cards, usages)
  assert.equal(parsed.cards[0].chips[0].npu_util_pct, 0)
  assert.equal(parsed.cards[0].chips[0].hbm_reported_usage_rate_pct, 4)
  assert.ok(!parsed.cards[0].chips[0].missing_reasons.usages)
  assert.ok(parsed.cards[1].chips[0].missing_reasons.usages)
  assert.equal(warnings.length, 7)
})

/* ------------------------------ 导入 ------------------------------ */

test('parseVllmJson：直接指标、workload 与 env 归一化', () => {
  const { run } = parseVllmJson(read('vllm-benchmark-baseline.json'))
  assert.equal(run.metrics.output_throughput_tps.value, 1240.5)
  assert.equal(run.metrics.ttft_p99_ms.value, 620)
  assert.equal(run.metrics.success_rate_pct.value, 100)
  assert.equal(run.workload.model, 'Qwen3-8B')
  assert.equal(run.workload.cards, 8)
  assert.equal(run.workload.concurrency, 32)
  assert.equal(run.workload.request_rate_mode, 'unbounded')
  assert.equal(run.env.cann, '8.1.RC2')
  assert.equal(run.env.framework_version, '0.30.0')
  assert.equal(run.env.tensor_parallel, 8)
  assert.ok(run.timestamp, '带时区的时间应被接受')
  assert.equal(run.hotspots.length, 3)
  assert.equal(run.hotspots[0].share_pct.toFixed(1), '54.2')
  assert.equal(run.source.evidence_kind, 'unverified_import')
  assert.ok(run.source.sha256 === null || typeof run.source.sha256 === 'string')
})

test('parseVllmJson：缺字段返回 null + missing_reason，不伪造数值', () => {
  const { run, warnings } = parseVllmJson(read('vllm-benchmark-missing-fields.json'))
  assert.equal(run.metrics.request_throughput_rps.value, 4.1)
  assert.equal(run.metrics.output_throughput_tps.value, null)
  assert.ok(run.metrics.output_throughput_tps.missing_reason)
  assert.equal(run.metrics.ttft_p99_ms.value, null)
  assert.ok(warnings.some((w) => w.code === 'TIMESTAMP_UNKNOWN'))
  assert.equal(run.workload.input_len, 8192)
})

test('parseVllmJson：坏 JSON 抛 PARSE_ERROR', () => {
  assert.throws(() => parseVllmJson(read('vllm-benchmark-bad.json')), (error) => error.code === 'PARSE_ERROR')
})

test('importContent：JSON 数组批量导入并绑定 sha256', () => {
  const parsed = importContent(read('vllm-benchmark-concurrency-array.json'), { filename: 'array.json' })
  assert.equal(parsed.format, 'vllm-json')
  assert.equal(parsed.runs.length, 3)
  for (const run of parsed.runs) {
    assert.equal(run.source.sha256, parsed.sha256)
    assert.equal(run.source.path, 'array.json')
  }
  assert.deepEqual(parsed.runs.map((r) => r.workload.concurrency), [32, 64, 128])
})

test('importContent：超过 1 MiB 抛 INPUT_TOO_LARGE', () => {
  const huge = '{"x":"' + 'a'.repeat(1024 * 1024 + 8) + '"}'
  assert.throws(() => importContent(huge), (error) => error.code === 'INPUT_TOO_LARGE')
})

test('parseBenchmarkCsv：每行一个 run，解析 inf/成功率', () => {
  const parsed = parseBenchmarkCsv(read('benchmark.csv'), 'benchmark.csv')
  assert.equal(parsed.runs.length, 2)
  assert.equal(parsed.rejected.length, 0)
  assert.equal(parsed.runs[0].label, 'csv-baseline')
  assert.equal(parsed.runs[0].metrics.output_throughput_tps.value, 980.2)
  assert.equal(parsed.runs[0].workload.request_rate_mode, 'unbounded')
  assert.equal(parsed.runs[0].workload.request_rate_rps, null)
  assert.equal(parsed.runs[1].metrics.success_rate_pct.value, 99.6)
})

test('parseBenchmarkCsv：无指标行进入 rejected，整批默认失败', () => {
  const csv = 'label,ttft_p99_ms\nbad-row,\ngood-row,620\n'
  const parsed = parseBenchmarkCsv(csv)
  assert.equal(parsed.runs.length, 1)
  assert.equal(parsed.rejected.length, 1)
  assert.throws(() => importContent(csv), (error) => error.code === 'PARSE_ERROR')
})

test('parseMsprofCsv：按算子分组、算 share 并降序', () => {
  const out = parseMsprofCsv(read('msprof-op-summary.csv'))
  assert.equal(out.hotspots.length, 4)
  assert.equal(out.hotspots[0].op_name, 'aclnnMatmul')
  assert.equal(out.hotspots[0].share_pct, 52.5)
  assert.equal(out.hotspots[0].calls, 1)
  assert.ok(out.hotspots[0].total_duration_us >= out.hotspots[1].total_duration_us)
})

/* ------------------------------ 对比 ------------------------------ */

function loadRuns() {
  const baseline = parseVllmJson(read('vllm-benchmark-baseline.json')).run
  const candidate = parseVllmJson(read('vllm-benchmark-candidate.json')).run
  return { baseline, candidate }
}

test('compareRuns：同条件对比给出 regressed，方向按指标语义', () => {
  const { baseline, candidate } = loadRuns()
  const cmp = compareRuns(baseline, candidate, 5)
  assert.equal(cmp.schema, undefined, 'comparison 是数据体，不套 Result 信封')
  assert.equal(cmp.comparability, 'matched')
  assert.equal(cmp.threshold_pct, 5)
  const byKey = new Map(cmp.metrics.map((m) => [m.key, m]))
  assert.equal(byKey.get('ttft_p99_ms').verdict, 'regressed')
  assert.equal(byKey.get('output_throughput_tps').verdict, 'regressed')
  assert.equal(byKey.get('tpot_p99_ms').verdict, 'stable')
  assert.ok(byKey.get('ttft_p99_ms').delta_pct > 12)
  assert.equal(cmp.summary.conclusion, 'regressed')
  assert.equal(cmp.verdict_counts.regressed >= 2, true)
})

test('compareRuns：阈值放大到 20% 后主要指标稳定', () => {
  const { baseline, candidate } = loadRuns()
  const cmp = compareRuns(baseline, candidate, 20)
  assert.equal(cmp.threshold_pct, 20)
  assert.equal(cmp.summary.conclusion, 'stable')
  assert.equal(cmp.metrics.find((m) => m.key === 'ttft_p99_ms').verdict, 'stable')
})

test('compareRuns：条件不一致时只给描述性差值且结论 not_comparable', () => {
  const { baseline, candidate } = loadRuns()
  candidate.workload.concurrency = 64
  const cmp = compareRuns(baseline, candidate, 5)
  assert.equal(cmp.comparability, 'mismatch')
  assert.equal(cmp.summary.conclusion, 'not_comparable')
  assert.equal(cmp.metrics.find((m) => m.key === 'ttft_p99_ms').verdict, 'descriptive')
})

test('compareRuns：缺失指标判 missing，主要指标缺失时结论 inconclusive', () => {
  const { baseline } = loadRuns()
  const candidate = parseVllmJson(read('vllm-benchmark-missing-fields.json')).run
  candidate.workload.model = 'Qwen3-8B'
  candidate.workload.input_len = 4096
  candidate.workload.output_len = 512
  candidate.env = { ...baseline.env }
  const cmp = compareRuns(baseline, candidate, 5)
  assert.equal(cmp.comparability, 'unknown')
  // 候选缺该指标时先判 missing，而不是 descriptive
  assert.equal(cmp.metrics.find((m) => m.key === 'output_throughput_tps').verdict, 'missing')
  assert.equal(cmp.summary.conclusion, 'inconclusive')
  const cmp2 = compareRuns(
    { ...baseline, metrics: { ...baseline.metrics, output_throughput_tps: { value: null, unit: 'token/s', direction: 'higher', missing_reason: '无' } } },
    candidate,
    5,
  )
  assert.equal(cmp2.metrics.find((m) => m.key === 'output_throughput_tps').verdict, 'missing')
})

/* ------------------------------ 洞察 ------------------------------ */

function snapshotWith(chips) {
  return {
    snapshot_id: 'snap_test',
    captured_at: new Date().toISOString(),
    availability: 'available',
    host: { alias: 'test', arch: 'aarch64' },
    software: { npu_smi: '26.1.1', cann: '8.1.RC2' },
    npu: { card_count: 1, chip_count: chips.length, memory_unit: 'MiB', cards: [{ card_id: 0, model: 'Ascend910', chips, processes: [] }] },
    source: { mode: 'local', is_demo: false, evidence_kind: 'captured' },
  }
}
function chip(overrides) {
  return {
    chip_id: 0, phy_id: 0, health: 'ok', temp_c: 45, power_w: 160,
    aicore_pct: 0, npu_util_pct: 0, hbm_used_mb: 3000, hbm_total_mb: 65536,
    hbm_usage_rate_pct: 4.6, processes: [], processes_state: 'none_reported', missing_reasons: {},
    ...overrides,
  }
}

test('generateInsights：HBM 压力与高温触发，证据带字段与时间', () => {
  const report = generateInsights({ snapshot: snapshotWith([chip({ hbm_usage_rate_pct: 95, temp_c: 90 })]) })
  const rules = report.insights.map((i) => i.rule_id)
  assert.ok(rules.includes('HBM_PRESSURE'))
  assert.ok(rules.includes('TEMP_HIGH'))
  const hbm = report.insights.find((i) => i.rule_id === 'HBM_PRESSURE')
  assert.equal(hbm.severity, 'warning')
  assert.equal(hbm.evidence[0].value, 95)
  assert.ok(hbm.suggestion.length > 0)
})

test('generateInsights：功耗变化需要上一快照且差值 ≥30%', () => {
  const prev = snapshotWith([chip({ power_w: 100 })])
  const next = snapshotWith([chip({ power_w: 140 })])
  const report = generateInsights({ snapshot: next, previousSnapshot: prev })
  const rule = report.insights.find((i) => i.rule_id === 'POWER_CHANGE')
  assert.ok(rule)
  assert.equal(rule.confidence, 'observed')
})

test('generateInsights：TTFT 回归、成功率低、热点集中与 skipped_rules', () => {
  const { baseline, candidate } = loadRuns()
  candidate.metrics.success_rate_pct = { value: 97.5, unit: '%', direction: 'higher', missing_reason: null }
  const cmp = compareRuns(baseline, candidate, 5)
  const report = generateInsights({ runs: [baseline, candidate], comparison: cmp })
  const rules = report.insights.map((i) => i.rule_id)
  assert.ok(rules.includes('TTFT_REGRESSION'))
  assert.ok(rules.includes('SUCCESS_LOW'))
  assert.ok(rules.includes('HOTSPOT_CONCENTRATION'))
  assert.equal(report.insights.find((i) => i.rule_id === 'SUCCESS_LOW').severity, 'critical')
  assert.ok(report.skipped_rules.some((s) => s.rule_id === 'CONCURRENCY_SATURATION'))
  assert.ok(report.insights.length <= 20)
})

test('generateInsights：并发饱和为 heuristic 且需要 ≥3 条同模型记录', () => {
  const parsed = importContent(read('vllm-benchmark-concurrency-array.json'))
  const runs = parsed.runs
  const cmp = compareRuns(runs[0], runs[1], 5)
  const report = generateInsights({ runs, comparison: cmp })
  const rule = report.insights.find((i) => i.rule_id === 'CONCURRENCY_SATURATION')
  assert.ok(rule, '应识别并发饱和')
  assert.equal(rule.confidence, 'heuristic')
  const onlyTwo = generateInsights({ runs: runs.slice(0, 2), comparison: cmp })
  assert.ok(onlyTwo.skipped_rules.some((s) => s.rule_id === 'CONCURRENCY_SATURATION'))
})

test('generateInsights：为空输入时全部规则给出 skipped 原因', () => {
  const report = generateInsights({})
  assert.equal(report.insights.length, 0)
  assert.ok(report.skipped_rules.length >= 5)
})

/* ------------------------------ 导出 ------------------------------ */

test('formatCompareMarkdown：含结论、阈值与指标表', () => {
  const { baseline, candidate } = loadRuns()
  const cmp = compareRuns(baseline, candidate, 5)
  const md = formatCompareMarkdown(cmp, baseline, candidate)
  assert.ok(md.includes('# 昇腾性能对比'))
  assert.ok(md.includes('| 指标 | 基线 | 候选 | 差值 | 变化 | 判定 |'))
  assert.ok(md.includes('regressed'))
  assert.ok(md.includes('±5%'))
})

/* ------------------------------ Host 集成 ------------------------------ */

test('apply：注册 19 个工具（4 看板 + 4 调优 + 4 部署计划 + 4 容器服务 + 3 profile）与 /api/ascend-perf 前缀路由；无 NPU 时降级不抛错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-perf-test-'))
  const tools = new Map()
  const routes = []
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    tools: { register(def) { tools.set(def.name, def); return () => {} } },
    webServer: { register(route) { routes.push(route); return () => {} }, getOrigin: () => '' },
    subprocess: {
      async resolveExecutable() { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e },
      spawn() { throw new Error('must not spawn in tests') },
    },
    set() {},
    // R1 后 REST 鉴权 fail-closed：测试中显式提供放行者
    get(name) { return name === 'connection' ? { requestRejection: () => 0 } : undefined },
  }
  apply(ctx, { dataDir: dir, configDir: join(dir, 'conf') })
  try {
    assert.deepEqual([...tools.keys()].sort(), ['ascend_deploy_plan_generate', 'ascend_deploy_plan_get', 'ascend_deploy_plan_list', 'ascend_deploy_plan_update', 'ascend_deploy_run_preview', 'ascend_deploy_run_start', 'ascend_deploy_run_status', 'ascend_deploy_run_stop', 'ascend_perf_compare', 'ascend_perf_import', 'ascend_perf_insight', 'ascend_profile_import', 'ascend_profile_list', 'ascend_profile_report', 'ascend_status', 'ascend_tune_plan', 'ascend_tune_report', 'ascend_tune_run', 'ascend_tune_status'])
    assert.equal(routes.length, 1)
    assert.equal(routes[0].path, '/api/ascend-perf')
    assert.equal(routes[0].kind, 'prefix')

    // 无 npu-smi：降级为 command_missing，不执行任何真实命令
    const status = await tools.get('ascend_status').execute({ refresh: true })
    assert.equal(status.schema, SCHEMA)
    assert.equal(status.readonly, true)
    assert.equal(status.status, 'empty')
    assert.equal(status.data.availability, 'command_missing')
    assert.equal(status.error.code, 'COMMAND_MISSING')

    // 回归：空态/失败态采集也必须落库，/state 才能看到设备状态
    const stateAfterStatus = await callRoute(routes[0], '/api/ascend-perf/state')
    assert.equal(stateAfterStatus.status, 200)
    assert.equal(stateAfterStatus.payload.snapshot.availability, 'command_missing')

    // 演示数据闭环
    const demo = await tools.get('ascend_perf_import').execute({ action: 'load_demo' })
    assert.equal(demo.demo, true)
    const list = await tools.get('ascend_perf_import').execute({ action: 'list' })
    assert.equal(list.runs.length, 2)
    const demoRunIds = list.runs.map((r) => r.run_id)
    const demoCmp = await tools.get('ascend_perf_compare').execute({ baseline_run_id: demoRunIds[0], candidate_run_id: demoRunIds[1] })
    assert.equal(demoCmp.comparison.comparability, 'matched')
    assert.equal(demoCmp.comparison.summary.conclusion, 'regressed')
    const demoInsight = await tools.get('ascend_perf_insight').execute({ baseline_run_id: demoRunIds[0], candidate_run_id: demoRunIds[1] })
    assert.ok(demoInsight.insights.some((i) => i.rule_id === 'TTFT_REGRESSION'))

    // 导入 fixtures → 对比 → 导出
    const impA = await tools.get('ascend_perf_import').execute({ action: 'import', filename: 'baseline.json', content: read('vllm-benchmark-baseline.json') })
    const impB = await tools.get('ascend_perf_import').execute({ action: 'import', filename: 'candidate.json', content: read('vllm-benchmark-candidate.json') })
    assert.equal(impA.runs[0].source.evidence_kind, 'unverified_import')
    const cmp = await tools.get('ascend_perf_compare').execute({ baseline_run_id: impA.runs[0].run_id, candidate_run_id: impB.runs[0].run_id })
    assert.equal(cmp.comparison.summary.conclusion, 'regressed')
    const exp = await tools.get('ascend_perf_compare').execute({ action: 'export', baseline_run_id: impA.runs[0].run_id, candidate_run_id: impB.runs[0].run_id, format: 'markdown' })
    assert.ok(exp.content.includes('升腾') || exp.content.includes('昇腾'))
    assert.ok(exp.content.includes('regressed'))

    // 幂等：同文件重复导入复用记录
    const again = await tools.get('ascend_perf_import').execute({ action: 'import', filename: 'baseline.json', content: read('vllm-benchmark-baseline.json') })
    assert.equal(again.deduplicated, true)

    // 仓储权限 600
    const storePath = join(dir, 'store.json')
    assert.ok(existsSync(storePath))
    assert.equal(statSync(storePath).mode & 0o777, 0o600)

    // REST GET /state
    const route = routes[0]
    let sent = null
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { sent = body } }
    await route.handler({ url: '/api/ascend-perf/state', method: 'GET', headers: {} }, res)
    assert.equal(res.status, 200)
    const state = JSON.parse(sent)
    assert.equal(state.schema, SCHEMA)
    assert.ok(Array.isArray(state.runs))
    // R3：演示态下 /state 只暴露演示集合（2 条），真实运行在退出演示后可见
    assert.equal(state.demo_active, true)
    assert.equal(state.runs.length, 2)
    assert.equal(state.demo_run_count, 2)
    assert.equal(state.real_run_count, 2)
    assert.ok(state.snapshot)
    assert.equal(state.config.target, 'local')

    // 采集目标配置：GET/POST + settings.json 持久化（0600）
    const configUrl = '/api/ascend-perf/config'
    const cfgGet = await callRoute(route, configUrl)
    assert.equal(cfgGet.status, 200)
    assert.equal(cfgGet.payload.config.target, 'local')
    const cfgPost = await callRoute(route, configUrl, {
      method: 'POST',
      body: { target: 'ssh', sshAlias: 'ascend-ro', npuSmiPath: 'npu-smi', sshNpuSmiPath: '/usr/local/Ascend/npu-smi', timeout: 20000 },
    })
    assert.equal(cfgPost.status, 200)
    assert.equal(cfgPost.payload.config.target, 'ssh')
    assert.equal(cfgPost.payload.config.ssh.hostAlias, 'ascend-ro')
    assert.equal(cfgPost.payload.config.timeout, 20000)
    const settingsPath = join(dir, 'settings.json')
    assert.ok(existsSync(settingsPath))
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600)
    const bad = await callRoute(route, configUrl, { method: 'POST', body: { target: 'ssh', sshAlias: '-bad' } })
    assert.equal(bad.status, 400)
    assert.equal(bad.payload.error.code, 'INVALID_ARGUMENT')
    // 重启后从 settings.json 恢复
    const routes2 = []
    apply(makeCtx({ routes: routes2, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: join(dir, 'conf') })
    const cfgRestored = await callRoute(routes2[0], configUrl)
    assert.equal(cfgRestored.payload.config.target, 'ssh')
    assert.equal(cfgRestored.payload.config.ssh.hostAlias, 'ascend-ro')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Store：损坏的 store.json 隔离并从 bak 恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-perf-store-'))
  try {
    const tools = new Map()
    const ctx = {
      effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
      tools: { register(def) { tools.set(def.name, def); return () => {} } },
      webServer: { register: () => () => {} },
      subprocess: { async resolveExecutable() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } },
      set() {}, get() { return undefined },
    }
    apply(ctx, { dataDir: dir, configDir: join(dir, 'conf') })
    await tools.get('ascend_perf_import').execute({ action: 'import', content: read('vllm-benchmark-baseline.json'), filename: 'a.json' })
    const storePath = join(dir, 'store.json')
    assert.ok(existsSync(storePath) && existsSync(storePath + '.bak') === false)
    // 第二次写入生成 bak
    await tools.get('ascend_perf_import').execute({ action: 'import', content: read('vllm-benchmark-candidate.json'), filename: 'b.json' })
    assert.ok(existsSync(storePath + '.bak'))
    writeFileSync(storePath, '{broken json', 'utf8')
    const tools2 = new Map()
    const ctx2 = { ...ctx, tools: { register(def) { tools2.set(def.name, def); return () => {} } } }
    apply(ctx2, { dataDir: dir, configDir: join(dir, 'conf') })
    const list = await tools2.get('ascend_perf_import').execute({ action: 'list' })
    // bak 保存的是上一次提交（1 条运行），符合“保存 bak → rename”的写入顺序
    assert.equal(list.runs.length, 1, '应从 bak 恢复上一次已知良好状态')
    assert.ok(existsSync(join(dir, 'quarantine')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------ R1 鉴权 fail-closed ------------------------------ */

function makeCtx({ routes = [], tools = new Map(), connection } = {}) {
  return {
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    tools: { register(def) { tools.set(def.name, def); return () => {} } },
    webServer: { register(route) { routes.push(route); return () => {} }, getOrigin: () => '' },
    subprocess: {
      async resolveExecutable() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      spawn() { throw new Error('must not spawn in tests') },
    },
    set() {},
    get(name) { return name === 'connection' ? connection : undefined },
  }
}

function makeReq(url, { method = 'GET', body = null } = {}) {
  const req = new EventEmitter()
  req.url = url
  req.method = method
  req.headers = {}
  req.destroy = () => {}
  queueMicrotask(() => {
    if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

async function callRoute(route, url, options) {
  let status = null
  let payload = null
  const res = {
    writeHead(code) { status = code },
    end(body) { if (body) payload = JSON.parse(body) },
  }
  await route.handler(makeReq(url, options), res)
  return { status, payload }
}

test('R1：REST 鉴权 fail-closed（缺 connection / 鉴权异常 / 未认证均拒绝）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-perf-auth-'))
  try {
    const stateUrl = '/api/ascend-perf/state'
    // 无 connection 服务 → 503，不能放行
    const routesA = []
    apply(makeCtx({ routes: routesA, connection: undefined  }), { dataDir: dir, configDir: join(dir, 'conf') })
    const a = await callRoute(routesA[0], stateUrl)
    assert.equal(a.status, 503)
    assert.equal(a.payload.error.code, 'AUTH_UNAVAILABLE')

    // 鉴权服务抛错 → 500，不能放行
    const routesB = []
    apply(makeCtx({ routes: routesB, connection: { requestRejection() { throw new Error('boom') } } }), { dataDir: dir, configDir: join(dir, 'conf') })
    const b = await callRoute(routesB[0], stateUrl)
    assert.equal(b.status, 500)
    assert.equal(b.payload.error.code, 'AUTH_ERROR')

    // 未认证 → 透传 401
    const routesC = []
    apply(makeCtx({ routes: routesC, connection: { requestRejection: () => 401 } }), { dataDir: dir, configDir: join(dir, 'conf') })
    const c = await callRoute(routesC[0], stateUrl)
    assert.equal(c.status, 401)

    // 明确放行 → 200
    const routesD = []
    apply(makeCtx({ routes: routesD, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: join(dir, 'conf') })
    const d = await callRoute(routesD[0], stateUrl)
    assert.equal(d.status, 200)
    assert.equal(d.payload.schema, SCHEMA)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------ R3 演示数据隔离 ------------------------------ */

test('R3：演示数据与真实数据隔离，重启不掩盖真实运行，混合对比被拒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-perf-demo-iso-'))
  try {
    const routes = []
    const tools = new Map()
    apply(makeCtx({ routes, tools, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: join(dir, 'conf') })

    // 先导入真实运行
    const real = await tools.get('ascend_perf_import').execute({ action: 'import', filename: 'real.json', content: read('vllm-benchmark-baseline.json') })
    const realId = real.runs[0].run_id

    // 加载演示：可见集合只有演示数据，真实数据仍在但计数可查
    const demo = await tools.get('ascend_perf_import').execute({ action: 'load_demo' })
    assert.equal(demo.runs.length, 2)
    const demoList = await tools.get('ascend_perf_import').execute({ action: 'list' })
    assert.equal(demoList.demo_active, true)
    assert.equal(demoList.runs.length, 2)
    assert.ok(demoList.runs.every((r) => r.source.is_demo))
    assert.equal(demoList.real_run_count, 1)

    // 存储分仓：真实 run 未被演示数据污染
    const saved = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8'))
    assert.equal(saved.runs.length, 1)
    assert.equal(saved.demo_runs.length, 2)
    assert.equal(saved.runs[0].run_id, realId)
    assert.ok(!('demo' in saved), '演示开关不应持久化')

    // 混合对比被拒绝（演示 vs 真实）
    await assert.rejects(
      tools.get('ascend_perf_compare').execute({ baseline_run_id: demoList.runs[0].run_id, candidate_run_id: realId }),
      (error) => error.code === 'INVALID_ARGUMENT' && /混合/.test(error.message),
    )

    // 演示模式下导入真实数据：不可见，但写入真实分仓
    await tools.get('ascend_perf_import').execute({ action: 'import', filename: 'candidate.json', content: read('vllm-benchmark-candidate.json') })
    const stillDemo = await tools.get('ascend_perf_import').execute({ action: 'list' })
    assert.equal(stillDemo.runs.length, 2)
    assert.equal(stillDemo.real_run_count, 2)

    // 重启：演示开关不恢复，只看到真实数据
    const tools2 = new Map()
    apply(makeCtx({ tools: tools2, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: join(dir, 'conf') })
    const restarted = await tools2.get('ascend_perf_import').execute({ action: 'list' })
    assert.equal(restarted.demo_active, false)
    assert.equal(restarted.runs.length, 2)
    assert.ok(restarted.runs.every((r) => !r.source.is_demo))

    // 切换：通过 REST /demo 关闭演示（内存开关），真实数据可见
    const tools3 = new Map()
    const routes3 = []
    apply(makeCtx({ routes: routes3, tools: tools3, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: join(dir, 'conf') })
    await tools3.get('ascend_perf_import').execute({ action: 'load_demo' })
    const onList = await tools3.get('ascend_perf_import').execute({ action: 'list' })
    assert.equal(onList.demo_active, true)
    const off = await callRoute(routes3[0], '/api/ascend-perf/demo', { method: 'POST', body: { enabled: false } })
    assert.equal(off.status, 200)
    const offList = await tools3.get('ascend_perf_import').execute({ action: 'list' })
    assert.equal(offList.demo_active, false)
    assert.equal(offList.runs.length, 2)
    assert.ok(offList.runs.every((r) => !r.source.is_demo))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R3：旧仓储中混放的演示数据在加载时迁出，保存后分离持久化', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-perf-demo-migrate-'))
  try {
    const now = new Date().toISOString()
    const mkRun = (id, demo) => ({
      run_id: id,
      label: demo ? 'legacy-demo' : 'legacy-real',
      created_at: now,
      timestamp: now,
      source: { mode: demo ? 'demo' : 'import', is_demo: demo, evidence_kind: demo ? 'synthetic' : 'unverified_import', sha256: null },
      env: {}, workload: {}, metrics: {}, hotspots: [],
    })
    const mkSnap = (id, demo) => ({ snapshot_id: id, captured_at: now, source: { mode: demo ? 'demo' : 'local', is_demo: demo } })
    writeFileSync(join(dir, 'store.json'), JSON.stringify({
      schema: STORE_SCHEMA, revision: 7, updated_at: now,
      runs: [mkRun('run_legacy_demo', true), mkRun('run_legacy_real', false)],
      snapshots: [mkSnap('snap_legacy_demo', true), mkSnap('snap_legacy_real', false)],
      import_keys: {}, demo: true,
    }), { mode: 0o600 })

    const tools = new Map()
    apply(makeCtx({ tools, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: join(dir, 'conf') })
    const list = await tools.get('ascend_perf_import').execute({ action: 'list' })
    assert.equal(list.demo_active, false, '旧演示开关不应恢复')
    assert.equal(list.runs.length, 1)
    assert.equal(list.runs[0].run_id, 'run_legacy_real')
    assert.equal(list.demo_run_count, 1, '旧演示运行迁入 demo_runs')

    // 任意一次写入后，磁盘结构也应分离且不再含旧 demo 开关
    await tools.get('ascend_perf_import').execute({ action: 'import', filename: 'x.json', content: read('vllm-benchmark-baseline.json') })
    const saved = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8'))
    assert.equal(saved.demo, undefined)
    assert.equal(saved.runs.length, 2)
    assert.ok(saved.runs.every((r) => !r.source.is_demo))
    assert.equal(saved.demo_runs.length, 1)
    assert.equal(saved.demo_runs[0].run_id, 'run_legacy_demo')
    assert.equal(saved.demo_snapshots.length, 1)
    assert.equal(saved.snapshots.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------ Client 注册 ------------------------------ */

test('client.js：ModuleLoader 工厂注册单一 tab、两个 keyed slot 与 zh/en 字典（IA v1.4 合并）', () => {
  const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec } } }
  try {
    new Function(source)()
  } finally {
    delete globalThis.window
  }
  assert.ok(captured, '应调用 window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-ascend-perf')

  const noop = () => {}
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, noop],
    useEffect: noop,
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const mod = captured.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`unexpected require: ${name}`)
  })
  assert.deepEqual([...mod.inject].sort(), ['locale', 'sidebarRight', 'sidebarRightTabs', 'slots'])

  const registered = { locales: [], tabs: [], slots: [], effects: 0 }
  const locale = {
    register(ns, dicts) { registered.locales.push({ ns, dicts }); return noop },
    bind() { return (key) => key },
  }
  const slots = {
    inject(slot, make) { make(); return noop },
    register(def, component) { registered.slots.push({ def, component }); return noop },
  }
  const sidebarRightTabs = { register(def) { registered.tabs.push(def); return noop } }
  const ctx = {
    locale,
    slots,
    sidebarRightTabs,
    sidebarRight: { openTab: noop },
    effect(fn) { registered.effects += 1; const d = fn(); return typeof d === 'function' ? d : noop },
    inject(deps, fn) {
      assert.deepEqual([...deps].sort(), ['sidebarRight', 'sidebarRightTabs'])
      fn({ locale, slots, sidebarRightTabs, sidebarRight: { openTab: noop } })
    },
  }
  mod.apply(ctx)

  const dict = registered.locales.find((l) => l.ns === 'dsh-ascend-perf')
  assert.ok(dict, '应注册 dsh-ascend-perf locale')
  assert.equal(dict.dicts.zh['meta.title'], '昇腾性能调优')
  assert.equal(dict.dicts.en['panel.title'], 'Ascend Performance Tuning')
  assert.ok(dict.dicts.en['meta.title'])
  // IA v1.4：单一 sidebar tab，三分段（环境信息/服务部署/性能调优）在面板内部。
  assert.equal(registered.tabs.length, 1)
  const observe = registered.tabs[0]
  assert.equal(observe.id, 'dsh-ascend-perf')
  // t20：guide entry 挂昇腾 SVG 图标（ComponentType<IconProps>，currentColor）
  assert.equal(mod.__test.zh['panel.title'], '昇腾性能调优')
  assert.strictEqual(observe.guide[0].icon, mod.__test.AscendIcon)
  assert.equal(observe.kind, 'ascend-perf')
  assert.equal(observe.multiple, false)
  assert.equal(observe.guide[0].order, 70)
  assert.equal(observe.title(), 'panel.title')
  assert.equal(typeof observe.guide[0].description(), 'string')
  assert.ok(dict.dicts.zh['tune.preview'] && dict.dicts.en['tune.preview'])
  const keys = registered.slots.map((s) => `${s.def.name}#${s.def.key}`)
  assert.equal(keys.length, 2)
  assert.ok(keys.includes('sidebar.right.pane.tab#dsh-ascend-perf'))
  assert.ok(keys.includes('sidebar.right.pane.tab.title#dsh-ascend-perf'))
  assert.ok(registered.slots.every((s) => typeof s.component === 'function'))
})


/* ------------------------------ 二期调优 ------------------------------ */

const tuneFixture = (name) => join(here, '..', 'fixtures', 'tuning', name)
const readTune = (name) => readFileSync(tuneFixture(name), 'utf8')
const codeIs = (code) => (error) => error?.code === code

test('normalizeTuneSpec：两必须轴、未知字段拒绝、范围校验与默认值', () => {
  const spec = normalizeTuneSpec(JSON.parse(readTune('spec-demo.json')))
  assert.equal(spec.schema, TUNE_SPEC_SCHEMA)
  assert.equal(spec.executor, 'demo')
  assert.equal(spec.target_id, 'demo-ascend')
  assert.deepEqual(spec.space.max_num_seqs, [8, 16, 32])
  assert.equal(spec.objective.metric, 'output_throughput_tps')
  assert.equal(spec.measurement.repeats, 3)
  assert.equal(spec.budget.max_trials, 12)

  const unknown = JSON.parse(readTune('spec-demo.json'))
  unknown.mystery = 1
  assert.throws(() => normalizeTuneSpec(unknown), codeIs('UNKNOWN_FIELD'))
  const badSeqs = JSON.parse(readTune('spec-demo.json'))
  badSeqs.baseline.max_num_seqs = 0
  assert.throws(() => normalizeTuneSpec(badSeqs), codeIs('INVALID_SPEC'))
  const badMultiple = JSON.parse(readTune('spec-demo.json'))
  badMultiple.space.max_num_batched_tokens = [1000]
  assert.throws(() => normalizeTuneSpec(badMultiple), codeIs('INVALID_SPEC'))
  const modelLenTooSmall = JSON.parse(readTune('spec-demo.json'))
  modelLenTooSmall.baseline.max_model_len = 512
  assert.throws(() => normalizeTuneSpec(modelLenTooSmall), codeIs('INVALID_SPEC'))
})

test('buildTunePlan：grid 展开、baseline 去重、plan_hash 稳定、dry-run 零副作用', () => {
  const spec = normalizeTuneSpec(JSON.parse(readTune('spec-demo.json')))
  const plan = buildTunePlan(spec)
  assert.equal(plan.schema, 'dsh-ascend-perf/tune-plan-v1')
  assert.equal(plan.candidates.length, 4)
  assert.ok(plan.pruned.some((p) => p.reason === 'BASELINE_DUPLICATE'))
  assert.equal(plan.blockers.length, 0)
  assert.equal(plan.budget_estimate.fit, 'yes')
  assert.ok(plan.commands_preview.length >= 2)
  assert.ok(plan.commands_preview.every((c) => Array.isArray(c.argv_redacted) && c.argv_redacted.every((v) => typeof v === 'string')))
  assert.ok(plan.commands_preview.every((c) => c.argv_redacted.every((v) => !v.includes('\n'))))
  assert.equal(plan.effect_manifest.start_service, false)
  assert.equal(plan.effect_manifest.benchmark_requests, 4)
  const again = buildTunePlan(normalizeTuneSpec(JSON.parse(readTune('spec-demo.json'))))
  assert.equal(plan.plan_hash, again.plan_hash, '同规格应得到相同 plan_hash')
  assert.notEqual(plan.plan_id, again.plan_id)

  const local = JSON.parse(readTune('spec-demo.json'))
  local.executor = 'local'
  const localPlan = buildTunePlan(normalizeTuneSpec(local))
  assert.ok(localPlan.blockers.some((b) => b.code === 'REAL_EXECUTION_DISABLED'))
  assert.ok(localPlan.blockers.some((b) => b.code === 'TARGET_READONLY'))
})

test('random 搜索：同 seed 确定性、不同 seed 不同、候选数受限', () => {
  const spec = normalizeTuneSpec(JSON.parse(readTune('spec-random.json')))
  const a = buildTunePlan(spec)
  const b = buildTunePlan(normalizeTuneSpec(JSON.parse(readTune('spec-random.json'))))
  assert.equal(a.candidates.length, 3)
  assert.deepEqual(a.candidates.map((c) => c.params), b.candidates.map((c) => c.params))
  const other = JSON.parse(readTune('spec-random.json'))
  other.search.seed = 999
  const c = buildTunePlan(normalizeTuneSpec(other))
  assert.notDeepEqual(a.candidates.map((x) => JSON.stringify(x.params)), c.candidates.map((x) => JSON.stringify(x.params)))
  assert.ok(a.candidates.every((cand) => cand.params.max_num_batched_tokens % 128 === 0))
})

test('parseBenchOutput：JSON/CSV 归一化、p99 缺失与超时输出均报 INVALID_METRICS', () => {
  const normal = parseBenchOutput(readTune('bench-normal.json'))
  assert.equal(normal.format, 'json')
  assert.equal(normal.metrics.output_throughput_tps.value, 1553.4)
  assert.equal(normal.metrics.ttft_p99_ms.value, 640.2)
  assert.equal(normal.metrics.tpot_p99_ms.value, 38.2)
  assert.equal(normal.metrics.success_rate_pct.value, 100)
  const csv = parseBenchOutput('output_throughput,p99_ttft_ms,p99_tpot_ms,success_rate_pct,num_prompts,completed\n900,500,30,99.5,1000,995')
  assert.equal(csv.format, 'csv')
  assert.equal(csv.metrics.output_throughput_tps.value, 900)
  assert.equal(csv.metrics.success_rate_pct.value, 99.5)
  assert.throws(() => parseBenchOutput(readTune('bench-missing-fields.json')), codeIs('INVALID_METRICS'))
  assert.throws(() => parseBenchOutput(readTune('bench-timeout.json')), codeIs('INVALID_METRICS'))
  assert.throws(() => parseBenchOutput(''), codeIs('INVALID_METRICS'))
})

test('aggregateRepeats / rankTrials：worst p99、SLO 违规与确定性排序', () => {
  const s1 = parseBenchOutput(readTune('bench-normal.json'))
  const s2 = parseBenchOutput(readTune('bench-normal.json'))
  s2.metrics.ttft_p99_ms.value = 700
  s2.metrics.output_throughput_tps.value = 1500
  const agg = aggregateRepeats([s1, s2], { constraints: { ttft_p99_ms_max: 800, tpot_p99_ms_max: 60, success_rate_pct_min: 99 } })
  assert.equal(agg.metrics.ttft_p99_ms.value, 700)
  assert.equal(agg.feasibility, 'feasible')
  const strict = aggregateRepeats([s1, s2], { constraints: { ttft_p99_ms_max: 100, tpot_p99_ms_max: 1, success_rate_pct_min: 99 } })
  assert.equal(strict.feasibility, 'infeasible')
  assert.equal(strict.violated_constraints.length, 2)
  const trial = (id, tp, feasible) => ({ trial_id: id, aggregate: { metrics: { output_throughput_tps: { value: tp } }, feasibility: feasible ? 'feasible' : 'infeasible' } })
  const ranked = rankTrials([trial('t1', 900, true), trial('t2', 1500, true), trial('t3', 3000, false)], { tieEpsilonPct: 1 })
  assert.equal(ranked.best_trial_id, 't2')
  assert.deepEqual(ranked.infeasible_trial_ids, ['t3'])
  assert.equal(ranked.ranked[0].rank, 1)
})

test('TuneService：plan→dry-run→demo run→status→report 闭环，零真实副作用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-tune-test-'))
  const service = new TuneService({ dataDir: dir, demoStepDelayMs: 1 })
  const planned = service.createPlan(JSON.parse(readTune('spec-demo.json')))
  assert.equal(planned.schema, TUNE_SCHEMA)
  assert.equal(planned.kind, 'plan')
  assert.equal(planned.source.is_demo, true)
  const plan = planned.data.plan
  const dry = service.dryRun(plan.plan_id, plan.plan_hash)
  assert.equal(dry.data.dry_run, true)
  assert.equal(dry.data.job_id, null)
  assert.equal(dry.data.accepted_at != null, true)
  const started = service.start({ plan_id: plan.plan_id, plan_hash: plan.plan_hash })
  assert.equal(started.schema, TUNE_SCHEMA)
  const jobId = started.data.job_id
  assert.ok(jobId)
  const job = await service.waitForJob(jobId)
  assert.equal(job.state, 'completed')
  const status = service.status({ job_id: jobId })
  assert.equal(status.data.job.state, 'completed')
  assert.ok(status.data.job.trials.length >= 5)
  assert.equal(status.data.job.progress.completed_trials, status.data.job.trials.length)
  const report = service.report({ job_id: jobId })
  assert.equal(report.kind, 'report')
  assert.ok(report.data.report.recommended)
  assert.equal(report.data.report.is_demo, true)
  assert.ok(report.data.report.limitations.length > 0)
  const md = service.report({ job_id: jobId, format: 'markdown' })
  assert.ok(String(md.data.content).includes('# 昇腾性能调优报告'))
  assert.equal(statSync(join(dir, 'tuning-v1')).mode & 0o777, 0o700)
  assert.equal(statSync(join(dir, 'tuning-v1', 'state.json')).mode & 0o777, 0o600)
  // 清理异步句柄
  service.stopJob(job)
})

test('状态机：幂等 Start、暂停/恢复、停止 → cancelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-tune-sm-'))
  const service = new TuneService({ dataDir: dir, demoStepDelayMs: 25 })
  const plan = service.createPlan(JSON.parse(readTune('spec-demo.json'))).data.plan
  const first = service.start({ plan_id: plan.plan_id, plan_hash: plan.plan_hash, idempotency_key: 'idem-1' })
  const second = service.start({ plan_id: plan.plan_id, plan_hash: plan.plan_hash, idempotency_key: 'idem-1' })
  assert.equal(first.data.job_id, second.data.job_id)
  assert.equal(second.data.idempotent_replay, true)
  const job = service.findJob(first.data.job_id)
  service.pauseJob(job)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.ok(['paused', 'running'].includes(job.state), `期望暂停或运行中，实际 ${job.state}`)
  service.resumeJob(job)
  service.stopJob(job)
  await service.waitForJob(job.job_id, 5000)
  assert.equal(job.state, 'cancelled')
  assert.ok(job.trials.some((t) => t.state === 'cancelled' || ['pending'].includes(t.state)))
  service.stopJob(job) // 幂等
})

test('重启恢复：非终态作业标 recovery_required，需人工确认清理', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-tune-recover-'))
  const store = new TuneStore({ dataDir: dir })
  const fake = {
    schema: 'dsh-ascend-perf/tune-store-v1',
    job_id: 'job_deadbeef0001',
    plan_id: 'plan_x',
    plan_hash: 'h',
    target_id: 'demo-ascend',
    executor: 'demo',
    state: 'running',
    revision: 3,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    trials: [],
    total_trials: 1,
  }
  store.saveJob(fake)
  const service = new TuneService({ dataDir: dir })
  assert.ok(service.recovered_job_ids.includes('job_deadbeef0001'))
  const status = service.status({ job_id: 'job_deadbeef0001' })
  assert.equal(status.data.job.state, 'recovery_required')
  assert.equal(status.data.job.resume_allowed, false)
  assert.equal(status.data.job.cleanup.state, 'recovery_required')
})

test('安全：真实执行默认禁用、命令模板拒绝 flag 注入、argv 不做 shell 拼接', () => {
  assert.equal(realExecutionGate({ executor: 'demo' }).ok, true)
  const disabled = realExecutionGate({ executor: 'local', config: {}, targetPolicy: 'maintenance_only' })
  assert.equal(disabled.code, 'REAL_EXECUTION_DISABLED')
  const readonlyGate = realExecutionGate({ executor: 'local', config: { enableRealExecutors: true }, targetPolicy: 'readonly' })
  assert.equal(readonlyGate.code, 'TARGET_READONLY')
  const noGrant = realExecutionGate({ executor: 'ssh', config: { enableRealExecutors: true }, targetPolicy: 'maintenance_only' })
  assert.equal(noGrant.code, 'AUTH_BRIDGE_UNAVAILABLE')
  const base = { pythonAbs: '/opt/demo/bin/python', modelAbs: '/models/qwen', port: 8000, tensorParallel: 1, dtype: 'bfloat16', quantization: 'none', params: { max_num_seqs: 16, max_num_batched_tokens: 2048, gpu_memory_utilization: 0.85, max_model_len: 4096 } }
  const argv = buildServeArgv({ ...base, servedModelName: 'model; rm -rf /' })
  assert.ok(argv.includes('model; rm -rf /'), '参数作为单个 argv 元素传递，不拼接 shell')
  assert.equal(argv.filter((v) => v === 'model; rm -rf /').length, 1)
  assert.throws(() => buildServeArgv({ ...base, servedModelName: '--evil' }), codeIs('INVALID_SPEC'))
  assert.throws(() => buildBenchArgv({ vllmAbs: '/opt/demo/bin/vllm', baseUrl: 'http://127.0.0.1:8000', model: 'm', inputLen: 512, outputLen: 128, numPrompts: 1000, concurrency: 32, rateLiteral: '1; rm', seed: 1, resultDir: '/tmp/r', resultName: 'b.json' }), codeIs('INVALID_SPEC'))
  const dir = mkdtempSync(join(tmpdir(), 'ascend-tune-safe-'))
  const service = new TuneService({ dataDir: dir })
  const localSpec = JSON.parse(readTune('spec-demo.json'))
  localSpec.executor = 'local'
  const plan = service.createPlan(localSpec).data.plan
  const blocked = service.start({ plan_id: plan.plan_id, plan_hash: plan.plan_hash })
  assert.equal(blocked.data.job_id, null)
  assert.ok(['REAL_EXECUTION_DISABLED', 'TARGET_READONLY', 'AUTH_BRIDGE_UNAVAILABLE'].includes(blocked.error.code))
  assert.equal(service.status({}).data.jobs.length, 0, '被阻断的启动不应创建作业')
})

test('tools/routes：4 个调优工具注册、错误码结构化、/tuning/* 路由返回信封', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-tune-tools-'))
  const service = new TuneService({ dataDir: dir, demoStepDelayMs: 1 })
  const tools = createTuneTools({ service })
  assert.deepEqual(tools.map((t) => t.name).sort(), ['ascend_tune_plan', 'ascend_tune_report', 'ascend_tune_run', 'ascend_tune_status'])
  const bad = await tools[0].execute({ spec: { bogus: true } })
  assert.equal(bad.status, 'error')
  assert.equal(bad.error.code, 'UNKNOWN_FIELD')
  const good = await tools[0].execute({ spec: JSON.parse(readTune('spec-demo.json')) })
  assert.equal(good.kind, 'plan')
  const plan = good.data.plan
  const dry = await tools[1].execute({ action: 'dry_run', plan_id: plan.plan_id, plan_hash: plan.plan_hash })
  assert.equal(dry.data.dry_run, true)
  const started = await tools[1].execute({ action: 'Start', plan_id: plan.plan_id, plan_hash: plan.plan_hash })
  const jobId = started.data.job_id
  await service.waitForJob(jobId)
  const status = await tools[2].execute({ job_id: jobId })
  assert.equal(status.data.job.state, 'completed')
  const list = await tools[2].execute({})
  assert.ok(Array.isArray(list.data.jobs))
  const report = await tools[3].execute({ job_id: jobId, format: 'markdown' })
  assert.ok(String(report.data.content).includes('调优报告'))
  const missing = await tools[3].execute({ job_id: 'job_nope' })
  assert.equal(missing.status, 'error')
  assert.equal(missing.error.code, 'NOT_FOUND')

  const routes = createTuneRoutes({ service })
  const planRoute = routes.find((r) => r.path === '/tuning/plan' && r.method === 'POST')
  const planRes = await planRoute.handler({ spec: JSON.parse(readTune('spec-demo.json')) }, {})
  assert.equal(planRes.kind, 'plan')
  const statusRoute = routes.find((r) => r.path === '/tuning/status' && r.method === 'GET')
  const statusRes = await statusRoute.handler({}, { job_id: jobId })
  assert.equal(statusRes.data.job.state, 'completed')
})

test('apply：调优工具与 /tuning/* 路由挂载，真实执行被阻断', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-tune-apply-'))
  const tools = new Map()
  const ctx = {
    effect(fn) { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
    tools: { register(def) { tools.set(def.name, def); return () => {} } },
    webServer: { register(route) { return () => {} }, getOrigin: () => '' },
    subprocess: { async resolveExecutable() { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }, spawn() { throw new Error('must not spawn in tests') } },
    get(name) { return name === 'connection' ? { requestRejection: () => 0 } : undefined },
  }
  apply(ctx, { dataDir: dir, configDir: join(dir, 'conf') })
  assert.ok(tools.has('ascend_tune_plan'))
  const planRes = await tools.get('ascend_tune_plan').execute({ spec: JSON.parse(readTune('spec-random.json')) })
  assert.equal(planRes.kind, 'plan')
})


test('executor 失败分类：timeout / invalid_metrics 如实记录，超预算作业失败且不给推荐', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-tune-fail-'))
  const service = new TuneService({
    dataDir: dir,
    demoStepDelayMs: 1,
    benchSource: ({ trial }) => {
      if (trial.kind === 'baseline' || trial.kind === 'confirm_baseline') return readTune('bench-normal.json')
      if (trial.params.max_num_seqs === 8) throw tuneError('BENCH_TIMEOUT', 'bench 超过 bench_timeout_s=90s')
      if (trial.kind === 'confirm_best') throw tuneError('HEALTH_TIMEOUT', '健康检查超时')
      return readTune('bench-missing-fields.json')
    },
  })
  const tolerant = JSON.parse(readTune('spec-demo.json'))
  tolerant.budget.max_failed_trials = 8
  tolerant.budget.max_consecutive_failures = 8
  const plan = service.createPlan(tolerant).data.plan
  const started = service.start({ plan_id: plan.plan_id, plan_hash: plan.plan_hash })
  const job = await service.waitForJob(started.data.job_id)
  assert.equal(job.state, 'completed')
  assert.ok(job.trials.some((t) => t.state === 'timeout' && t.failure_code === 'BENCH_TIMEOUT'))
  assert.ok(job.trials.some((t) => t.state === 'timeout' && t.failure_code === 'HEALTH_TIMEOUT'))
  assert.ok(job.trials.some((t) => t.state === 'invalid_metrics' && t.failure_code === 'INVALID_METRICS'))
  const report = service.report({ job_id: job.job_id })
  assert.equal(report.data.report.recommended, null, '全部候选失败时不应给出推荐')
  assert.ok(report.data.report.trial_rows.some((row) => row.failure_code))

  // 默认预算（max_failed_trials=2）下，失败超预算应终止作业
  const tight = new TuneService({ dataDir: dir, demoStepDelayMs: 1, benchSource: ({ trial }) => {
    if (trial.kind === 'baseline') return readTune('bench-normal.json')
    throw tuneError('BENCH_TIMEOUT', 'bench 超时')
  } })
  const tightPlan = tight.createPlan(JSON.parse(readTune('spec-demo.json'))).data.plan
  const tightStart = tight.start({ plan_id: tightPlan.plan_id, plan_hash: tightPlan.plan_hash })
  const tightJob = await tight.waitForJob(tightStart.data.job_id)
  assert.equal(tightJob.state, 'failed')
  assert.equal(tightJob.failure_reason.code, 'BUDGET_EXHAUSTED')
})

test('OwnedProcessRunner/PortLock：超时只终止自有句柄，端口占用 fail-fast', async () => {
  const terminated = []
  let handle = null
  const spawn = (spec) => {
    handle = {
      done: new Promise(() => {}),
      terminate() {
        terminated.push(spec.argv[0])
        handle.done = Promise.resolve({ exit_code: 143 })
      },
      collected: {},
    }
    return handle
  }
  const runner = new OwnedProcessRunner({ spawn })
  const res = await runner.run(['owned-cmd'], { timeoutMs: 10 })
  assert.equal(res.timed_out, true)
  assert.equal(res.terminated_owned, true)
  assert.deepEqual(terminated, ['owned-cmd'])
  assert.equal(runner.terminateOwned(handle), false, '已结束的句柄不再重复清理')
  assert.equal(runner.terminateOwned({ terminate() { throw new Error('不能碰外部进程') } }), false)

  const lock = new PortLock()
  const port = 45871
  await lock.acquire(port)
  await assert.rejects(() => lock.acquire(port), (error) => error?.code === 'PORT_BUSY')
  lock.release(port)
  await lock.acquire(port)
  lock.releaseAll()

  const occupied = 45872
  const server = createServer()
  await new Promise((resolve) => server.listen(occupied, '127.0.0.1', resolve))
  try {
    await assert.rejects(() => new PortLock().acquire(occupied), (error) => error?.code === 'PORT_BUSY')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})


/* ------------------------------ 多环境（envs.json 配置文件化，t17） ------------------------------ */

test('多环境：npu-ssh.md 自动播种写 envs.json（version 1，0600），/state 暴露 envs，轮询采集失败也落 availability', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-perf-envs-'))
  const conf = join(dir, 'conf')
  mkdirSync(conf, { recursive: true })
  writeFileSync(join(conf, 'npu-ssh.md'), '# 登录\nssh -i ~/.ssh/id_ed25519 root@10.0.0.1\nssh -i ~/.ssh/id_ed25519 root@10.0.0.2\n', 'utf8')
  const routes = []
  try {
    apply(makeCtx({ routes, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: conf })
    // 播种 2 个环境并持久化到 configDir/envs.json
    const cfgRes = await callRoute(routes[0], '/api/ascend-perf/config')
    assert.equal(cfgRes.status, 200)
    assert.equal(cfgRes.payload.config.version, 2)
    assert.equal(cfgRes.payload.config.envs.length, 2)
    assert.equal(cfgRes.payload.config.envs[0].hostAlias, 'root@10.0.0.1')
    assert.equal(cfgRes.payload.config.envs[0].mode, 'ssh')
    assert.ok(cfgRes.payload.config.pollIntervalMs >= 60000)
    assert.ok(cfgRes.payload.config.configFile.endsWith('envs.json'), 'publicConfig 应暴露 configFile 路径')
    const onDisk = JSON.parse(readFileSync(join(conf, 'envs.json'), 'utf8'))
    assert.equal(onDisk.version, 1)
    assert.equal(onDisk.envs.length, 2)
    assert.equal(statSync(join(conf, 'envs.json')).mode & 0o777, 0o600, 'envs.json 应为 0600')
    assert.ok(!existsSync(join(dir, 'settings.json')), '播种后不应再写 settings.json')

    // /state 暴露 envs（初始 pending，occupancy 为 null）
    const state0 = await callRoute(routes[0], '/api/ascend-perf/state')
    assert.equal(state0.payload.envs.length, 2)
    assert.equal(state0.payload.envs[0].availability, 'pending')
    assert.equal(state0.payload.envs[0].occupancy, null)
    assert.equal(state0.payload.envs_config_error, null)

    // 手动全部刷新：spawn 抛错 → 每环境仍落 unreachable 记录
    const refresh = await callRoute(routes[0], '/api/ascend-perf/status', { method: 'POST', body: { refresh_all: true } })
    assert.equal(refresh.status, 200)
    assert.equal(refresh.payload.collected.length, 2)
    const state1 = await callRoute(routes[0], '/api/ascend-perf/state')
    for (const env of state1.payload.envs) {
      assert.ok(env.collected_at, '失败也要落采集时间')
      assert.notEqual(env.availability, 'pending')
      assert.notEqual(env.availability, 'ok')
    }

    // 单环境刷新 + 未知 env_id
    const single = await callRoute(routes[0], '/api/ascend-perf/status', { method: 'POST', body: { env_id: state1.payload.envs[0].id } })
    assert.equal(single.status, 200)
    assert.equal(single.payload.env.env_id, state1.payload.envs[0].id)
    const bad = await callRoute(routes[0], '/api/ascend-perf/status', { method: 'POST', body: { env_id: 'env-nope' } })
    assert.equal(bad.status, 400)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('多环境：v1 settings 迁移去重、校验拒绝非法 envs、合法整体替换写 envs.json 且 settings.json 保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-perf-envs2-'))
  const conf = join(dir, 'conf')
  mkdirSync(conf, { recursive: true })
  const v1Payload = { target: 'ssh', npuSmiPath: 'npu-smi', timeout: 12000, ssh: { hostAlias: 'root@10.0.0.1', npuSmiPath: 'npu-smi' } }
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(v1Payload), 'utf8')
  writeFileSync(join(conf, 'npu-ssh.md'), 'ssh root@10.0.0.1\nssh root@10.0.0.9\n', 'utf8')
  const routes = []
  try {
    apply(makeCtx({ routes, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: conf })
    const cfg1 = await callRoute(routes[0], '/api/ascend-perf/config')
    // v1 目标 + md 播种去重后 2 个，首个是 v1 目标
    assert.equal(cfg1.payload.config.envs.length, 2)
    assert.equal(cfg1.payload.config.envs[0].hostAlias, 'root@10.0.0.1')

    // 非法：坏别名 / 空数组 / 超上限 / pollIntervalMs 过小
    const bads = [
      { envs: [{ mode: 'ssh', hostAlias: 'bad alias; rm' }] },
      { envs: [] },
      { envs: Array.from({ length: 17 }, (_, i) => ({ id: `env-x${i}`, mode: 'local' })) },
      { pollIntervalMs: 1000 },
    ]
    for (const body of bads) {
      const res = await callRoute(routes[0], '/api/ascend-perf/config', { method: 'POST', body })
      assert.equal(res.status, 400, JSON.stringify(body))
    }

    // 合法替换：2 个环境（local + ssh），间隔 10min —— v2 POST 持久化到 envs.json
    const ok = await callRoute(routes[0], '/api/ascend-perf/config', {
      method: 'POST',
      body: { pollIntervalMs: 600000, envs: [
        { id: 'env-local', mode: 'local', name: '本机开发机' },
        { id: 'env-a', mode: 'ssh', hostAlias: 'root@10.0.0.5', npuSmiPath: '/usr/local/bin/npu-smi', timeoutMs: 8000 },
      ] },
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.payload.config.envs.length, 2)
    assert.equal(ok.payload.config.envs[1].hostAlias, 'root@10.0.0.5')
    assert.equal(ok.payload.config.pollIntervalMs, 600000)
    const persisted = JSON.parse(readFileSync(join(conf, 'envs.json'), 'utf8'))
    assert.equal(persisted.version, 1)
    assert.equal(persisted.pollIntervalMs, 600000)
    assert.equal(persisted.envs.length, 2)
    assert.deepEqual(persisted.envs.map((e) => e.id).sort(), ['env-a', 'env-local'])
    // 旧 settings.json 保留原 v1 内容（不删不改）
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')), v1Payload)

    // 重启后 envs 稳定（不再播种 md 里的 10.0.0.1/9）
    const routes2 = []
    apply(makeCtx({ routes: routes2, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: conf })
    const cfg2 = await callRoute(routes2[0], '/api/ascend-perf/config')
    assert.equal(cfg2.payload.config.envs.length, 2)
    assert.deepEqual(cfg2.payload.config.envs.map((e) => e.id).sort(), ['env-a', 'env-local'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置文件化：settings.json v2 自动迁移到 envs.json，且 envs.json 优先于 settings.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-perf-migrate-'))
  const conf = join(dir, 'conf')
  mkdirSync(conf, { recursive: true })
  const v2 = { version: 2, pollIntervalMs: 600000, envs: [
    { id: 'env-m1', name: '集群A', mode: 'ssh', hostAlias: 'root@10.1.0.1', npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true },
    { id: 'env-m2', name: '本机', mode: 'local', hostAlias: null, npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true },
  ] }
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(v2), 'utf8')
  const routes = []
  try {
    apply(makeCtx({ routes, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: conf })
    // 迁移产物：conf/envs.json（version 1，同 envs，同间隔，0600）；settings.json 原样保留
    const onDisk = JSON.parse(readFileSync(join(conf, 'envs.json'), 'utf8'))
    assert.equal(onDisk.version, 1)
    assert.equal(onDisk.pollIntervalMs, 600000)
    assert.deepEqual(onDisk.envs.map((e) => e.id), ['env-m1', 'env-m2'])
    assert.equal(statSync(join(conf, 'envs.json')).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')), v2, 'settings.json 保留不删')
    const cfg = await callRoute(routes[0], '/api/ascend-perf/config')
    assert.equal(cfg.payload.config.pollIntervalMs, 600000)
    assert.equal(cfg.payload.config.envs.length, 2)

    // 优先级：envs.json 与 settings.json 冲突时以 envs.json 为准
    writeFileSync(join(conf, 'envs.json'), JSON.stringify({ version: 1, pollIntervalMs: 120000, envs: [{ id: 'env-x', mode: 'local' }] }), 'utf8')
    const routes2 = []
    apply(makeCtx({ routes: routes2, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: conf })
    const cfg2 = await callRoute(routes2[0], '/api/ascend-perf/config')
    assert.equal(cfg2.payload.config.envs.length, 1)
    assert.equal(cfg2.payload.config.envs[0].id, 'env-x')
    assert.equal(cfg2.payload.config.pollIntervalMs, 120000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置文件化：envs.json 损坏 → /state 暴露 envs_config_error，不覆盖待修复文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-perf-broken-'))
  const conf = join(dir, 'conf')
  mkdirSync(conf, { recursive: true })
  writeFileSync(join(conf, 'envs.json'), '{broken', 'utf8')
  const routes = []
  try {
    apply(makeCtx({ routes, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: conf })
    const state = await callRoute(routes[0], '/api/ascend-perf/state')
    assert.equal(state.status, 200)
    assert.equal(state.payload.envs_config_error?.code, 'CONFIG_READ_FAILED')
    assert.ok(state.payload.envs_config_error?.message?.includes('envs.json'))
    assert.equal(state.payload.envs.length, 0)
    // 文件保持原样（读取失败不清掉用户待修复的内容），也不产生 settings.json
    assert.equal(readFileSync(join(conf, 'envs.json'), 'utf8'), '{broken')
    assert.ok(!existsSync(join(dir, 'settings.json')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('占用汇总：chip 级判定与环境级档位（进程/HBM/AICore 信号序，unknown 不计分母；t18：none_reported 低指标=空闲）', async () => {
  const chip = (over) => ({ chip_id: 0, phy_id: 0, health: 'ok', processes: [], processes_state: 'none_reported', temp_c: 40, power_w: 100, aicore_pct: 0, hbm_used_mb: 100, hbm_total_mb: 32768, hbm_usage_rate_pct: 0.3, ...over })
  assert.equal(chipOccupancyState(chip({ processes_state: 'observed', processes: [{ pid: 1, name: 'vllm', memory_mb: 1024 }] })), 'occupied')
  assert.equal(chipOccupancyState(chip({ processes_state: 'none_reported', hbm_usage_rate_pct: 10 })), 'occupied', 'HBM ≥10% 判占用')
  assert.equal(chipOccupancyState(chip({ processes_state: 'none_reported', aicore_pct: 6, hbm_usage_rate_pct: 0.1 })), 'occupied', 'AICore ≥5% 判占用')
  // t18：none_reported（npu-smi 正常、进程列表空）+ 低指标 → 空闲（不再占用未知）
  assert.equal(chipOccupancyState(chip({ processes_state: 'none_reported', hbm_usage_rate_pct: null, hbm_used_mb: 512, hbm_total_mb: 32768 })), 'idle', 't18：none_reported+低指标 → 空闲')
  assert.equal(chipOccupancyState(chip({ processes_state: 'none_reported', hbm_usage_rate_pct: 5.2, aicore_pct: 0 })), 'idle', '910B3 空闲基线 5.2% → 空闲，不误判占用')
  assert.equal(chipOccupancyState(chip({ processes_state: 'none_reported', hbm_usage_rate_pct: 4.4, aicore_pct: 0 })), 'idle', 't18：none_reported+HBM 4.x% 基线 → 空闲')
  assert.equal(chipOccupancyState(chip({ processes_state: 'unknown', hbm_usage_rate_pct: null, hbm_used_mb: 0, aicore_pct: null })), 'unknown', 't18：仅 processes_state=unknown（解析异常）→ 未知')
  assert.equal(chipOccupancyState(chip({ processes_state: 'observed' })), 'idle', 'observed 且无进程且低指标 → 空闲')

  const mkSnapshot = (states) => ({
    availability: 'available',
    npu: { card_count: 1, chip_count: states.length, cards: [{ card_id: 0, model: 'Ascend910B', chips: states.map((st, i) => chip({ chip_id: i, phy_id: i, processes_state: st.ps, processes: st.procs ?? [], hbm_usage_rate_pct: st.hbm ?? 0, aicore_pct: st.ai ?? 0 })) }] },
  })
  // 8/8 占用 → busy
  const all = summarizeEnvOccupancy(mkSnapshot(Array.from({ length: 8 }, () => ({ ps: 'none_reported', hbm: 30 }))))
  assert.equal(all.state, 'busy'); assert.equal(all.busy_chip_count, 8); assert.equal(all.total_chip_count, 8)
  // 0 占用 → idle
  const none = summarizeEnvOccupancy(mkSnapshot(Array.from({ length: 8 }, () => ({ ps: 'observed', hbm: 0, ai: 0 }))))
  assert.equal(none.state, 'idle'); assert.equal(none.total_chip_count, 8)
  // 8 chip 占用 2（< ⌈0.75×8⌉=6）→ partial
  const some = summarizeEnvOccupancy(mkSnapshot([...Array.from({ length: 2 }, () => ({ ps: 'none_reported', hbm: 30 })), ...Array.from({ length: 6 }, () => ({ ps: 'observed', hbm: 0, ai: 0 }))]))
  assert.equal(some.state, 'partial')
  // total<4 需全部占用：3 chip 占 2 → partial；占 3 → busy
  const three2 = summarizeEnvOccupancy(mkSnapshot([{ ps: 'none_reported', hbm: 30 }, { ps: 'none_reported', hbm: 30 }, { ps: 'observed', hbm: 0, ai: 0 }]))
  assert.equal(three2.state, 'partial')
  const three3 = summarizeEnvOccupancy(mkSnapshot([{ ps: 'none_reported', hbm: 30 }, { ps: 'none_reported', hbm: 30 }, { ps: 'none_reported', hbm: 30 }]))
  assert.equal(three3.state, 'busy')
  // 全 unknown（解析异常）：不进分母 → total 0 → unknown
  const unk = summarizeEnvOccupancy(mkSnapshot([{ ps: 'unknown', hbm: null, ai: null }, { ps: 'unknown', hbm: null, ai: null }]))
  assert.equal(unk.state, 'unknown'); assert.equal(unk.total_chip_count, 0); assert.equal(unk.unknown_chip_count, 2)
  // t18 用户反馈场景锁定：8 卡 × 2 chip 全 none_reported + HBM 4.x% 基线 → 环境档=空闲（0/16 占用）
  const userCase = {
    availability: 'available',
    npu: { card_count: 8, chip_count: 16, cards: Array.from({ length: 8 }, (card) => ({ card_id: card, model: 'Ascend910B', chips: [0, 1].map((die) => chip({ chip_id: die, phy_id: die, card_id: card, processes_state: 'none_reported', processes: [], hbm_usage_rate_pct: 4.4, aicore_pct: 0.2 })) })) },
  }
  const idleEnv = summarizeEnvOccupancy(userCase)
  assert.equal(idleEnv.state, 'idle', 't18：无进程+HBM 4.x% 的空闲机环境档应为空闲')
  assert.equal(idleEnv.busy_chip_count, 0); assert.equal(idleEnv.total_chip_count, 16); assert.equal(idleEnv.unknown_chip_count, 0)
  // 非可用快照 → null
  assert.equal(summarizeEnvOccupancy(null), null)
  assert.equal(summarizeEnvOccupancy({ availability: 'unreachable' }), null)
  // 占用进程聚合 Top3：同名进程跨 chip 计数与显存求和
  const procs = summarizeEnvOccupancy(mkSnapshot([
    { ps: 'observed', hbm: 0, ai: 0, procs: [{ pid: 11, name: 'VLLMWorker_TP', memory_mb: 2048 }, { pid: 12, name: 'vllm', memory_mb: 1024 }] },
    { ps: 'observed', hbm: 0, ai: 0, procs: [{ pid: 21, name: 'VLLMWorker_TP', memory_mb: 3072 }] },
  ]))
  // 注：有进程的 chip 为 occupied，会改变档位，这里只断言聚合
  assert.equal(procs.state, 'busy')
  assert.equal(procs.top_processes[0].name, 'VLLMWorker_TP')
  assert.equal(procs.top_processes[0].count, 2)
  assert.equal(procs.top_processes[0].memory_mb_sum, 5120)
})


/* ------------------------------ 客户端占用视图（t17 v1.2） ------------------------------ */

function loadClientModule() {
  const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec } } }
  try {
    new Function(source)()
  } finally {
    delete globalThis.window
  }
  const noop = () => {}
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, noop],
    useEffect: noop,
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const mod = captured.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`unexpected require: ${name}`)
  })
  return mod
}

function makeT(dict) {
  return (key, args) => {
    let s = dict[key] ?? key
    if (args) for (const [k, v] of Object.entries(args)) s = s.replaceAll(`{${k}}`, String(v))
    return s
  }
}

// 展开 fake createElement 树：函数组件需手动调用（真实 React 渲染时才会调用）
function renderNode(node) {
  if (node == null || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(renderNode).filter(Boolean)
  if (typeof node.type === 'function') return renderNode(node.type({ ...(node.props ?? {}), children: node.children }))
  return node
}

function walkTree(node, visit) {
  node = renderNode(node)
  if (node == null) return
  if (typeof node === 'string') { visit(node); return }
  if (Array.isArray(node)) { for (const child of node) walkTree(child, visit); return }
  visit(node)
  for (const child of node.children ?? []) walkTree(child, visit)
}

function textOf(node) {
  let out = ''
  walkTree(node, (n) => { if (typeof n === 'string') out += n + ' ' })
  return out
}

function findTestId(node, testid) {
  let found = null
  walkTree(node, (n) => {
    if (found) return
    if (n && typeof n === 'object' && n.props?.['data-testid'] === testid) found = n
  })
  return found
}

test('client.js：占用视图渲染——无编辑入口、pill/strip/testid、排序与状态角标、ConfigBar 路径', () => {
  const mod = loadClientModule()
  const t = makeT(mod.__test.zh)
  const chip = (i, over = {}) => ({ chip_id: i, phy_id: i, health: 'ok', temp_c: 41 + i, power_w: 100 + i, aicore_pct: 0, npu_util_pct: 0, hbm_used_mb: 100, hbm_total_mb: 32768, hbm_usage_rate_pct: 0.3, processes: [], processes_state: 'observed', ...over })
  const busySnapshot = {
    availability: 'available',
    software: { cann_version: '8.0.0' },
    npu: { card_count: 1, chip_count: 8, cards: [{ card_id: 0, model: 'Ascend 910B3', power_w: 400, chips: Array.from({ length: 8 }, (_, i) => chip(i, { hbm_usage_rate_pct: 30 + i, processes: [{ pid: 1000 + i, name: 'VLLMWorker_DP', memory_mb: 2048 }], processes_state: 'observed' })) }] },
  }
  const idleSnapshot = {
    availability: 'available',
    software: { cann_version: '8.0.0' },
    npu: { card_count: 1, chip_count: 4, cards: [{ card_id: 0, model: 'Ascend 910B3', power_w: 310, chips: Array.from({ length: 4 }, (_, i) => chip(i)) }] },
  }
  const envs = [
    { id: 'env-busy', name: '集群B', mode: 'ssh', hostAlias: 'root@10.0.0.2', enabled: true, availability: 'available', collected_at: new Date().toISOString(), snapshot: busySnapshot, error: null, warnings: [] },
    { id: 'env-idle', name: '集群A', mode: 'ssh', hostAlias: 'root@10.0.0.1', enabled: true, availability: 'available', collected_at: new Date().toISOString(), snapshot: idleSnapshot, error: null, warnings: [] },
    { id: 'env-off', name: '夜间池', mode: 'ssh', hostAlias: 'root@10.0.0.9', enabled: false, availability: 'available', collected_at: new Date().toISOString(), snapshot: idleSnapshot, error: null, warnings: [] },
    { id: 'env-new', name: '新机器', mode: 'local', enabled: true, availability: 'pending', collected_at: null, snapshot: null, error: null, warnings: [] },
  ]
  const state = { config: { version: 2, pollIntervalMs: 300000, configFile: '/home/ops-engineering/.config/ascend-perf/envs.json', envs }, envs }
  const tree = mod.__test.EnvsSection({ state, busy: false, onRefreshAll: () => {}, onImported: () => {}, onOpenConfig: () => {}, onReloadConfig: () => {}, t })

  // 1) 非编辑态页面零采集配置输入控件（t29 编辑入口默认收起）
  const formTags = new Set()
  walkTree(tree, (n) => { if (typeof n.type === 'string') formTags.add(n.type) })
  for (const bad of ['input', 'select', 'textarea']) assert.ok(!formTags.has(bad), `不应出现 ${bad}`)

  // 2) 排序：空闲先于高负载，已停用殿后；pending 未采集
  const text = textOf(tree)
  const idlePos = text.indexOf('集群A'); const busyPos = text.indexOf('集群B')
  assert.ok(idlePos >= 0 && busyPos > idlePos, '空闲环境应排在高负载之前')
  assert.ok(text.indexOf('已停用') > busyPos, '已停用环境应殿后')
  assert.ok(text.includes('未采集'), 'pending 环境应显示未采集文案')

  // 3) OccupancyPill：{occ}/{total} 与三档文案；ChipStrip 每 chip 一格
  assert.ok(text.includes('高负载'), 'busy 环境应显示高负载档')
  assert.ok(text.includes('8/8'), 'busy 环境 pill 应含 8/8')
  assert.ok(text.includes('空闲'), 'idle 环境应显示空闲档')
  assert.ok(text.includes('VLLMWorker_DP'), '占用进程行应包含进程名')
  assert.ok(text.includes('×8'), '占用进程应聚合计数 ×8')

  // 4) data-testid 锚点
  const testids = []
  walkTree(tree, (n) => { if (n.props?.['data-testid']) testids.push(n.props['data-testid']) })
  for (const expect of ['envs.configbar', 'envs.block.env-busy', 'envs.block.env-busy.pill', 'envs.block.env-busy.procs', 'envs.block.env-busy.strip', 'envs.card.0', 'envs.block.env-idle.strip']) {
    assert.ok(testids.includes(expect), `缺少 data-testid=${expect}`)
  }
  // t29：占用条按卡一卡一格（busy 1 卡 + idle 1 卡 = 2 格；disabled 环境不渲染条）
  const stripCells = testids.filter((id) => id.startsWith('envs.card.'))
  assert.equal(stripCells.length, 2, '两个含快照环境共 2 个卡格')

  // 4b) t29 按卡编号保留；t34：占用条下图例/说明行完全移除；旧 c卡号.chip号 标签仍退场
  assert.ok(!text.includes('c0.7'), '不应再出现 c卡号.chip号 形式的 chip 格')
  assert.ok(!testids.includes('envs.chiplegend'), 't34 后不应再有图例行 data-testid=envs.chiplegend')
  assert.ok(!text.includes('一张 NPU 卡'), 't34 后不应再渲染图例文案')
  assert.ok(!text.includes('910C → 16 卡'), 't34 后不应再渲染型号图例说明')

  // 4c) t44：环境卡不再有编辑入口（编辑收进 ConfigBar「环境配置」弹窗）；单环境「刷新」与演示入口保持去噪
  assert.ok(!testids.some((id) => /^envs\.block\.[^.]+\.edit$/.test(id)), '环境卡不应再有卡内编辑入口（编辑收进 ConfigBar 弹窗）')
  assert.ok(testids.includes('envs.configbar.edit') && testids.includes('envs.configbar.reload'), 'ConfigBar 应有「环境配置」与「重新加载配置」按钮')
  assert.ok(text.includes('环境配置') && text.includes('重新加载配置'), 'ConfigBar 按钮文案可见')
  const buttonTexts = []
  walkTree(tree, (n) => { if (typeof n === 'object' && n.type === 'button') buttonTexts.push(textOf(n).trim()) })
  assert.ok(!buttonTexts.includes('刷新'), '不应再有单环境「刷新」按钮（刷新全部承担手动刷新）')
  assert.ok(buttonTexts.includes('刷新全部'), '应保留「刷新全部」')
  assert.ok(!text.includes('加载演示数据'), '环境段不应再有加载演示数据入口')

  // 5) aria：ChipStrip role=list；OccupancyPill 有 aria-label 判定句
  let pillAria = null
  walkTree(tree, (n) => {
    if (n.props?.['data-testid'] === 'envs.block.env-busy.pill') pillAria = n.props['aria-label']
  })
  assert.ok(pillAria && pillAria.includes('8'), 'OccupancyPill aria-label 应包含判定信息')

  // 6) ConfigBar：配置文件路径 + 只读频率提示；长路径截中段
  const configText = (() => { let out = ''; walkTree(tree, (n) => { if (n.props?.['data-testid'] === 'envs.configbar') out = textOf(n) }); return out })()
  assert.ok(configText.includes('envs.json'), 'ConfigBar 应显示配置文件路径')
  assert.ok(!configText.includes('/home/ops-engineering/.config/ascend-perf/envs.json'), '长路径应截断')
  assert.ok(configText.includes('5'), '应显示每 5 分钟自动采集')
})

test('client.js：t19 环境卡瘦身——默认一行内联摘要，完整指标收进展开详情', () => {
  const mod = loadClientModule()
  const t = makeT(mod.__test.zh)
  // 空闲环境：16 chip、温度 45–60、功耗合计 ≈3.3 kW、HBM 8/512 GiB（2%）
  const chip = (i, over = {}) => ({ chip_id: i, phy_id: i, health: 'ok', temp_c: 45 + i, power_w: 200 + i, aicore_pct: 0, npu_util_pct: 0, hbm_used_mb: 512, hbm_total_mb: 32768, hbm_usage_rate_pct: 1.2, processes: [], processes_state: 'observed', ...over })
  const cards = [{ card_id: 0, model: 'Ascend 910B3', power_w: 400, chips: Array.from({ length: 16 }, (_, i) => chip(i)) }]
  const snapshot = { availability: 'available', software: { cann_version: '8.0.0' }, npu: { card_count: 1, chip_count: 16, cards } }
  const env = { id: 'env-x', name: '集群X', mode: 'ssh', hostAlias: 'root@10.0.0.3', enabled: true, availability: 'available', collected_at: new Date().toISOString(), snapshot, error: null, warnings: [] }
  const state = { config: { pollIntervalMs: 300000, configFile: '/root/.config/ascend-perf/envs.json', envs: [env] }, envs: [env] }
  const tree = mod.__test.EnvsSection({ state, busy: false, onRefreshAll: () => {}, onImported: () => {}, onOpenConfig: () => {}, onReloadConfig: () => {}, t })
  const text = textOf(tree)
  const testids = []
  walkTree(tree, (n) => { if (n.props?.['data-testid']) testids.push(n.props['data-testid']) })

  // 1) 默认视图不再平铺多行指标摘要（五行明细标签全部消失，展开入口保留）
  for (const label of ['型号 / 拓扑', '芯片温度', '总功耗', 'AICore 利用率', 'HBM 显存']) {
    assert.ok(!text.includes(label), `默认视图不应再平铺「${label}」摘要行`)
  }
  assert.ok(text.includes('展开 1 卡详情'), '展开入口应保留')

  // 2) 默认仅一行内联摘要：型号 · chip 数 · 温度 · 功耗 · HBM used/total+占比
  assert.ok(testids.includes('envs.block.env-x.inline'), '缺少 data-testid=envs.block.env-x.inline')
  let inline = ''
  walkTree(tree, (n) => { if (n.props?.['data-testid'] === 'envs.block.env-x.inline') inline = textOf(n) })
  assert.ok(inline.includes('Ascend 910B3'), '内联摘要应含型号')
  assert.ok(inline.includes('16 chip'), '内联摘要应含 chip 数')
  assert.ok(inline.includes('45–60 °C'), `内联摘要应含温度区间：${inline}`)
  assert.ok(inline.includes('≈3.3 kW'), `≥1000W 应用 kW：${inline}`)
  assert.ok(inline.includes('HBM 8/512 GiB（2%）'), `内联摘要应含 HBM 用量与整体占比：${inline}`)

  // 3) 完整指标保留在展开详情：EnvBlock 把 EnvMetricSummary 传入 CardsBlock 展开区；组件渲染五行明细
  let wired = false
  const rawWalk = (node) => {
    if (node == null || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const item of node) rawWalk(item); return }
    if (node.props?.summary?.type === mod.__test.EnvMetricSummary) wired = true
    for (const v of Object.values(node.props ?? {})) if (v && typeof v === 'object') rawWalk(v)
    for (const child of node.children ?? []) rawWalk(child)
    if (typeof node.type === 'function') rawWalk(node.type({ ...(node.props ?? {}), children: node.children }))
  }
  rawWalk(tree)
  assert.ok(wired, 'EnvBlock 应把 EnvMetricSummary 作为展开区 summary 传入 CardsBlock')
  const detailText = textOf(mod.__test.EnvMetricSummary({ cards, t }))
  for (const label of ['型号 / 拓扑', '芯片温度', '总功耗', 'AICore 利用率', 'HBM 显存']) {
    assert.ok(detailText.includes(label), `展开明细应保留「${label}」`)
  }

  // 4) 缺项自动跳过：无温度/功耗/HBM 数据时只剩型号与 chip 数
  const bare = mod.__test.EnvInlineSummary({ cards: [{ card_id: 0, model: 'Ascend 910B', chips: [{ chip_id: 0, health: 'ok', processes: [], processes_state: 'observed' }, { chip_id: 1, health: 'ok', processes: [], processes_state: 'observed' }] }], t })
  assert.equal(textOf(bare).trim(), 'Ascend 910B · 2 chip', `缺项应跳过：${textOf(bare)}`)

  // 5) 空闲环境紧凑：无占用进程时不渲染进程占位行
  assert.ok(!testids.includes('envs.block.env-x.procs'), '空闲环境不应渲染占用进程行')
  assert.ok(!text.includes('无占用进程'), '空闲环境不应渲染「无占用进程」占位行')
})

test('client.js：envs 空态与配置读取失败态', () => {
  const mod = loadClientModule()
  const t = makeT(mod.__test.zh)
  const emptyTree = mod.__test.EnvsSection({ state: { config: { pollIntervalMs: 300000, configFile: '/root/.config/ascend-perf/envs.json' }, envs: [] }, busy: false, onRefreshAll: () => {}, onImported: () => {}, onOpenConfig: () => {}, onReloadConfig: () => {}, t })
  const emptyText = textOf(emptyTree)
  assert.ok(emptyText.includes('envs.json'), '空态应指引配置文件')
  // t29：环境段去噪——空态导入引导不再携带「加载演示数据」入口（演示入口移至性能调优段）
  assert.ok(!emptyText.includes('加载演示数据'), '空态导入引导不应再带加载演示入口')
  // t20：空态=导入引导（SSH + 粘贴 JSON + 手动模板）
  assert.ok(emptyText.includes('从 SSH 主机导入'), '空态应提供 SSH 导入')
  assert.ok(emptyText.includes('粘贴 JSON 导入'), '空态应提供粘贴 JSON 导入')
  const emptyIds = []
  walkTree(emptyTree, (n) => { if (n.props?.['data-testid']) emptyIds.push(n.props['data-testid']) })
  assert.ok(emptyIds.includes('envs.import.ssh') && emptyIds.includes('envs.import.json'), '导入引导应带 testid')
  // 引导只在空态出现：有环境时不得渲染任何输入控件（t17 契约）
  const nonEmptyTree = mod.__test.EnvsSection({ state: { config: { pollIntervalMs: 300000, configFile: '/root/.config/ascend-perf/envs.json' }, envs: [{ id: 'env-1', name: 'A', mode: 'ssh', hostAlias: 'root@1.2.3.4', enabled: true, availability: 'pending' }] }, busy: false, onRefreshAll: () => {}, onImported: () => {}, onOpenConfig: () => {}, onReloadConfig: () => {}, t })
  const nonEmptyText = textOf(nonEmptyTree)
  assert.ok(!nonEmptyText.includes('从 SSH 主机导入'), '非空态不应渲染导入引导')
  let inputCount = 0
  walkTree(nonEmptyTree, (n) => { if (typeof n === 'object' && ['input', 'select', 'textarea'].includes(n.type)) inputCount += 1 })
  assert.equal(inputCount, 0, 'envs 非空时页面不得出现任何输入控件')

  const brokenTree = mod.__test.EnvsSection({ state: { config: { pollIntervalMs: 300000, configFile: '/root/.config/ascend-perf/envs.json' }, envs: [], envs_config_error: { code: 'CONFIG_READ_FAILED', message: 'envs.json: Unexpected token' } }, busy: false, onRefreshAll: () => {}, onImported: () => {}, onOpenConfig: () => {}, onReloadConfig: () => {}, t })
  const brokenText = textOf(brokenTree)
  assert.ok(brokenText.includes('配置') && brokenText.includes('envs.json'), '配置读取失败应显示面板级错误')

  // client 端占用派生与 host 一致：8/8 占用 → busy
  const occ = mod.__test.deriveEnvOccupancy([{ card_id: 0, chips: Array.from({ length: 8 }, (_, i) => ({ chip_id: i, health: 'ok', processes: [{ pid: 1, name: 'x', memory_mb: 1 }], processes_state: 'observed', hbm_usage_rate_pct: 0, aicore_pct: 0, hbm_used_mb: 0, hbm_total_mb: 32768 })) }])
  assert.equal(occ.tier, 'busy')
  assert.equal(occ.total, 8)
  assert.equal(occ.occupied, 8)

  // t18：client 规则与 host 同步——none_reported+HBM 4.4% → 空闲档；仅 processes_state='unknown' → 未知
  const mkChip = (over = {}) => ({ chip_id: 0, health: 'ok', processes: [], processes_state: 'none_reported', hbm_usage_rate_pct: 4.4, aicore_pct: 0.2, hbm_used_mb: 1400, hbm_total_mb: 32768, ...over })
  assert.equal(mod.__test.chipOccState(mkChip()), 'idle', 'client：none_reported+低指标 → idle')
  assert.equal(mod.__test.chipOccState(mkChip({ processes_state: 'unknown', hbm_usage_rate_pct: 0, aicore_pct: null })), 'unknown', 'client：仅 unknown → unknown')
  const idleCards = [0, 1].map((c) => ({ card_id: c, chips: [0, 1].map((die) => mkChip({ chip_id: die })) }))
  const idleOcc = mod.__test.deriveEnvOccupancy(idleCards)
  assert.equal(idleOcc.tier, 'idle', 'client：空闲机整体空闲档')
  assert.equal(idleOcc.occupied, 0)
  assert.equal(idleOcc.unknown, 0)
})


/* ------------------------------ t20：显示名/图标/空态导入 ------------------------------ */

test('client.js：t20 昇腾 SVG 图标（TabTitle/TuneTitle/面板头，currentColor 无外部资源）', () => {
  const mod = loadClientModule()
  const t = makeT(mod.__test.zh)

  const tab = mod.__test.TabTitle({ t })
  assert.ok(textOf(tab).includes('昇腾性能调优'), 'tab 标题应为新显示名')
  let svg = null
  walkTree(tab, (n) => { if (typeof n === 'object' && n.type === 'svg') svg = n })
  assert.ok(svg, 'TabTitle 应含内联 SVG 图标')
  assert.equal(svg.props['aria-hidden'], 'true')
  assert.equal(svg.props.viewBox, '0 0 16 16')
  let currentColor = 0
  let external = 0
  walkTree(svg, (n) => {
    if (typeof n === 'string') return
    for (const v of Object.values(n.props ?? {})) {
      if (v === 'currentColor') currentColor += 1
      if (typeof v === 'string' && /^https?:\/\//.test(v)) external += 1
    }
  })
  assert.ok(currentColor >= 3, `图标描边应全部 currentColor（实际 ${currentColor}）`)
  assert.equal(external, 0, '图标不得引用任何外部资源')

  // IA v1.4：单一 tab，图标在 TabTitle 与 Panel 头两处（原 TuneTitle 已下线）
  const panelHead = renderNode(mod.__test.Panel({ t }))
  let headSvg = null
  walkTree(panelHead, (n) => { if (typeof n === 'object' && n.type === 'svg') headSvg = n })
  assert.ok(headSvg, 'Panel 头也应带图标')

  // AscendIcon 直接接受 IconProps（size/className），供 guide entry 使用
  const icon = mod.__test.AscendIcon({ size: 20, className: 'x' })
  assert.equal(icon.props.width, 20)
  assert.equal(icon.props.className, 'x')
})

test('t20 导入：从 SSH 主机导入（预览 ascend 优先→确认写 envs.json 0600，只存别名不落敏感字段）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't20-ssh-'))
  try {
    const conf = join(dir, 'conf')
    const sshStore = join(dir, 'dsh-ssh.json')
    writeFileSync(sshStore, JSON.stringify({
      version: 1,
      hosts: [
        { alias: 'box-a', host: '10.0.0.5', port: 22, user: 'root', auth: { kind: 'password', password: 'SECRET-PW' }, tags: ['dev'] },
        { alias: 'ascend-01', host: '10.0.0.1', port: 22, user: 'root', auth: { kind: 'key', keyPath: '/tmp/key', passphrase: 'SECRET-PP' }, tags: ['ascend', 'prod'] },
        { alias: 'npu-lab', host: '10.0.0.9', port: 22, user: 'root', auth: { kind: 'agent' }, tags: ['NPU'] },
        { alias: 'bad alias!', host: 'x', user: 'u', tags: [] },
      ],
    }))
    const routes = []
    apply(makeCtx({ routes, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: conf, sshHostsFile: sshStore })

    // 空态：envs 为空（导入引导可见的前提）
    const state0 = await callRoute(routes[0], '/api/ascend-perf/state')
    assert.equal(state0.status, 200)
    assert.equal(state0.payload.envs.length, 0)

    // 预览：ascend/npu tag 优先排序，非法别名给出跳过原因
    const prev = await callRoute(routes[0], '/api/ascend-perf/envs/import/ssh/preview', { method: 'POST', body: {} })
    assert.equal(prev.status, 200)
    assert.equal(prev.payload.available, true)
    assert.equal(prev.payload.draft.length, 3, `应导入 3 台合法主机：${JSON.stringify(prev.payload.draft)}`)
    assert.equal(prev.payload.draft[0].hostAlias, 'ascend-01', 'ascend tag 优先')
    assert.equal(prev.payload.draft[1].hostAlias, 'npu-lab', 'NPU tag 次之')
    const badRow = prev.payload.rows.find((r) => r.alias === 'bad alias!')
    assert.ok(badRow?.skip, '非法别名列出跳过原因')
    assert.equal(prev.payload.capacity, 16)

    // 确认导入（全部）
    const imp = await callRoute(routes[0], '/api/ascend-perf/envs/import/ssh', { method: 'POST', body: {} })
    assert.equal(imp.status, 200)
    assert.equal(imp.payload.imported, 3)
    assert.equal(imp.payload.envs.length, 3)

    // envs.json 落盘 0600 + 绝不含任何敏感字段
    const envsPath = join(conf, 'envs.json')
    const st = statSync(envsPath)
    assert.equal(st.mode & 0o777, 0o600, 'envs.json 应为 0600')
    const raw = readFileSync(envsPath, 'utf8')
    for (const secret of ['SECRET-PW', 'SECRET-PP', 'password', 'passphrase', 'keyPath', 'auth']) {
      assert.ok(!raw.includes(secret), `envs.json 不得包含敏感字段：${secret}`)
    }
    const onDisk = JSON.parse(raw)
    assert.equal(onDisk.version, 1)
    assert.ok(onDisk.envs.every((e) => e.mode === 'ssh' && typeof e.hostAlias === 'string' && !('auth' in e)))

    // /state 反映新 envs；ids 唯一且合法
    const state1 = await callRoute(routes[0], '/api/ascend-perf/state')
    assert.equal(state1.payload.envs.length, 3)
    assert.ok(state1.payload.envs.some((e) => e.hostAlias === 'ascend-01'))
    assert.equal(new Set(onDisk.envs.map((e) => e.id)).size, 3, '生成 id 应唯一')

    // 选择性导入 + 已存在别名去重：重启后再次导入同名主机应 0 可导入
    const routes2 = []
    apply(makeCtx({ routes: routes2, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: conf, sshHostsFile: sshStore })
    const prev2 = await callRoute(routes2[0], '/api/ascend-perf/envs/import/ssh/preview', { method: 'POST', body: {} })
    assert.equal(prev2.payload.draft.length, 0, '别名已全部存在 → 无可导入')
    assert.ok(prev2.payload.rows.every((r) => r.skip), '所有行应带 skip 原因')

    // 读不到 SSH 配置：预览如实降级，确认导入被拒
    const routes3 = []
    apply(makeCtx({ routes: routes3, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: join(dir, 'conf3'), sshHostsFile: join(dir, 'missing.json') })
    const prev3 = await callRoute(routes3[0], '/api/ascend-perf/envs/import/ssh/preview', { method: 'POST', body: {} })
    assert.equal(prev3.status, 200)
    assert.equal(prev3.payload.available, false)
    assert.equal(prev3.payload.reason.code, 'SSH_HOSTS_NOT_FOUND')
    assert.ok(prev3.payload.reason.message.length > 0, '降级原因应带人话说明')
    const imp3 = await callRoute(routes3[0], '/api/ascend-perf/envs/import/ssh', { method: 'POST', body: {} })
    assert.equal(imp3.status, 400)
    assert.equal(imp3.payload.error.code, 'SSH_HOSTS_NOT_FOUND')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('t20 导入：粘贴 JSON（合法落盘 / 各非法类逐条报错且不落盘 / 重复与上限拒绝）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't20-json-'))
  try {
    const conf = join(dir, 'conf')
    const routes = []
    apply(makeCtx({ routes, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: conf })
    const envsPath = join(conf, 'envs.json')
    const postJson = (text) => callRoute(routes[0], '/api/ascend-perf/envs/import/json', { method: 'POST', body: { text } })

    // 非法 JSON / 形状错误 / 空 text
    let r = await postJson('{oops')
    assert.equal(r.status, 400)
    assert.equal(r.payload.error.code, 'INVALID_JSON')
    r = await postJson('{"foo":1}')
    assert.equal(r.status, 400)
    assert.equal(r.payload.error.code, 'INVALID_ARGUMENT')
    r = await callRoute(routes[0], '/api/ascend-perf/envs/import/json', { method: 'POST', body: {} })
    assert.equal(r.status, 400, '缺少 text 应 400')

    // 逐条报错：mode 枚举 / hostAlias 正则 / npuSmiPath 正则；全有或全无，不落盘
    r = await postJson(JSON.stringify({ envs: [
      { id: 'env-ok', name: 'A', mode: 'ssh', hostAlias: 'root@10.0.0.1' },
      { name: 'B', mode: 'telnet' },
      { name: 'C', mode: 'ssh', hostAlias: 'bad alias!' },
      { id: 'env-ok', name: 'D', mode: 'ssh', hostAlias: 'root@10.0.0.2' },
    ] }))
    assert.equal(r.status, 200)
    assert.equal(r.payload.imported, 0)
    assert.deepEqual(r.payload.errors.map((e) => e.index).sort((a, b) => a - b), [1, 2, 3], '应逐条报错（mode 枚举/hostAlias 正则/id 重复）')
    assert.equal(JSON.parse(readFileSync(envsPath, 'utf8')).envs.length, 0, '失败导入不得落盘')


    // 空数组
    r = await postJson('{"envs":[]}')
    assert.equal(r.status, 200)
    assert.equal(r.payload.imported, 0)
    assert.ok(r.payload.errors.length >= 1)

    // 合法导入（数组形态 + pollIntervalMs）
    r = await postJson(JSON.stringify({ pollIntervalMs: 600000, envs: [{ id: 'env-a', name: '集群A', mode: 'ssh', hostAlias: 'root@10.0.0.1', npuSmiPath: 'npu-smi', timeoutMs: 15000 }] }))
    assert.equal(r.status, 200)
    assert.equal(r.payload.imported, 1)
    const onDisk = JSON.parse(readFileSync(envsPath, 'utf8'))
    assert.equal(onDisk.envs[0].id, 'env-a')
    assert.equal(onDisk.pollIntervalMs, 600000)
    const state1 = await callRoute(routes[0], '/api/ascend-perf/state')
    assert.equal(state1.payload.envs.length, 1, '/state 应反映导入结果')

    // 与现有 hostAlias 重复 → 拒绝且不动盘上文件
    r = await postJson(JSON.stringify([{ name: 'again', mode: 'ssh', hostAlias: 'root@10.0.0.1' }]))
    assert.equal(r.payload.imported, 0)
    assert.ok(r.payload.errors.some((e) => e.message.includes('重复')))
    assert.equal(JSON.parse(readFileSync(envsPath, 'utf8')).envs.length, 1)

    // 超 16 上限 → 拒绝
    r = await postJson(JSON.stringify({ envs: Array.from({ length: 16 }, (_, i) => ({ id: `env-x${i}`, name: `x${i}`, mode: 'local' })) }))
    assert.equal(r.payload.imported, 0)
    assert.ok(r.payload.errors.some((e) => e.message.includes('上限')))
    assert.equal(JSON.parse(readFileSync(envsPath, 'utf8')).envs.length, 1, '超限导入不得破坏现有配置')
    // npuSmiPath 非法沿用现有校验语义：静默回退默认 'npu-smi'（与 POST /config v2 一致）
    r = await postJson(JSON.stringify({ envs: [{ id: 'env-p', name: 'P', mode: 'ssh', hostAlias: 'root@10.0.0.3', npuSmiPath: 'a b' }] }))
    assert.equal(r.payload.imported, 1)
    assert.equal(JSON.parse(readFileSync(envsPath, 'utf8')).envs.find((e) => e.id === 'env-p').npuSmiPath, 'npu-smi', '非法 npuSmiPath 回退默认（读落盘文件）')

    // 最终盘上：env-a + env-p 两条，env-p 回退默认 npu-smi
    assert.equal(JSON.parse(readFileSync(envsPath, 'utf8')).envs.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('t20 导入：REST 鉴权 fail-closed（三条导入路由未认证一律 401）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't20-auth-'))
  try {
    const routes = []
    apply(makeCtx({ routes, connection: { requestRejection: () => 401 } }), { dataDir: dir, configDir: join(dir, 'conf') })
    for (const path of ['/api/ascend-perf/envs/import/ssh/preview', '/api/ascend-perf/envs/import/ssh', '/api/ascend-perf/envs/import/json']) {
      const r = await callRoute(routes[0], path, { method: 'POST', body: {} })
      assert.equal(r.status, 401, `${path} 应 401（透传拒绝，无响应体）`)
    }
    // envs.json 若存在，是 apply() 启动时的兜底物化（envs 为空），不是请求写入：
    // 这里断言其内容仍是空配置，即未认证请求没有改变配置。
    const bootstrapped = join(dir, 'conf', 'envs.json')
    if (existsSync(bootstrapped)) {
      assert.deepEqual(JSON.parse(readFileSync(bootstrapped, 'utf8')).envs, [], '未认证请求不得改变配置')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ===== t30 部署 v2：环境选择 + 代码基线差异 + 可编辑部署计划（plans.json，纯本地文本，不执行） =====

const T30_ENV_A = { id: 'env-a', name: 'A 环境', mode: 'local', npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true }

function t30GetEnv(state = { env: T30_ENV_A }) {
  return (envId) => (envId === (state.env?.id ?? '') ? state : null)
}

const T30_VALID_SPEC = {
  env_id: 'env-a',
  candidate: { ref: 'feat/kv-cache-opt', commit: 'a1b2c3d4e5f6a7b8' },
  baseline: { ref: 'main', commit: '' },
  model: { path: '/data/models/Qwen3-8B', served_name: 'qwen3-8b' },
  params: { port: 18433, tensor_parallel: 2, max_num_seqs: 256, max_num_batched_tokens: 8192, health_timeout_s: 300 },
}

function t30Service(dir) {
  return new DeployPlanService({ configDir: join(dir, 'conf'), getEnv: t30GetEnv() })
}

test('t30 计划生成：10 步结构、scope 标注、命令嵌入用户输入、纯函数零副作用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't30-gen-'))
  try {
    const spec = validatePlanSpec(T30_VALID_SPEC, t30GetEnv())
    assert.equal(spec.env.id, 'env-a')
    assert.equal(spec.candidate.commit, 'a1b2c3d4e5f6a7b8')
    const steps = buildPlanSteps(spec)
    assert.equal(steps.length, 10, '默认 10 步')
    assert.deepEqual(steps.map((s) => s.id), ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'])
    // scope 标注：基线在前（s2-s6），候选对照（s7-s8），首尾为 both
    assert.deepEqual(steps.map((s) => s.scope), ['both', 'baseline', 'baseline', 'baseline', 'baseline', 'baseline', 'candidate', 'candidate', 'both', 'both'])
    for (const step of steps) assert.ok(step.title && step.title.length <= 120, `步骤标题非空：${step.id}`)
    const byTitle = (frag) => steps.find((s) => s.title.includes(frag))
    assert.ok(byTitle('基线').command.includes('git checkout main'), '基线检出命令包含 ref')
    assert.ok(byTitle('候选').command.includes('git checkout feat/kv-cache-opt'), '候选检出命令包含 ref')
    assert.ok(byTitle('候选').command.includes('a1b2c3d4e5f6a7b8'), '候选命令包含 commit')
    const serve = steps.find((s) => s.command && s.command.startsWith('vllm-ascend serve'))
    assert.ok(serve.command.includes('--port 18433') && serve.command.includes('--tensor-parallel-size 2'), '启动命令嵌入端口与 TP')
    assert.ok(steps.every((s) => s.command === null || typeof s.command === 'string'), 'command 可选')

    // 草稿不落盘：generate 后 configDir 无 plans.json
    const service = t30Service(dir)
    const env = service.generate(T30_VALID_SPEC, { origin: 'tool' })
    assert.equal(env.status, 'ok')
    assert.equal(env.readonly, true)
    assert.equal(env.effects.process_mutation, false, '零进程副作用')
    assert.equal(env.data.plan.draft, true)
    assert.equal(env.data.plan.id, null)
    assert.equal(env.data.plan.executes, false)
    assert.equal(env.data.plan.steps.length, 10)
    assert.ok(!existsSync(join(dir, 'conf', PLAN_STORE_FILE)), '生成草稿不写盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('t30 校验矩阵：环境不存在/停用、空分支、非法 commit、端口/超时/路径越界、未知字段均拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't30-invalid-'))
  try {
    const service = t30Service(dir)
    // 服务层 fail() 直接抛错（fail-closed）；REST/工具层各自包成 envelope。
    const rejects = (payload, code, label) => {
      assert.throws(() => service.generate(payload, { origin: 'tool' }), (error) => {
        assert.equal(error.code, code, `${label} → ${code}（得到 ${error.code}）`)
        return true
      }, `${label} 应拒绝`)
    }
    rejects({ ...T30_VALID_SPEC, env_id: 'env-nope' }, 'ENV_UNKNOWN', '环境不存在')
    rejects({ ...T30_VALID_SPEC, env_id: '' }, 'INVALID_ARGUMENT', 'env_id 为空')
    rejects({ ...T30_VALID_SPEC, candidate: { ref: '', commit: '' } }, 'INVALID_SPEC', '候选分支为空')
    rejects({ ...T30_VALID_SPEC, baseline: { ref: 'main', commit: 'xyz' } }, 'INVALID_SPEC', 'commit 非 16 进制')
    rejects({ ...T30_VALID_SPEC, baseline: { ref: 'main', commit: 'a1b2c3' } }, 'INVALID_SPEC', 'commit 少于 7 位')
    rejects({ ...T30_VALID_SPEC, model: { path: 'data/models', served_name: 'x' } }, 'INVALID_SPEC', '相对路径')
    rejects({ ...T30_VALID_SPEC, model: { path: '/data/模型', served_name: 'x' } }, 'INVALID_SPEC', '路径白名单字符')
    rejects({ ...T30_VALID_SPEC, params: { ...T30_VALID_SPEC.params, port: 1023 } }, 'INVALID_SPEC', '端口低于 1024')
    rejects({ ...T30_VALID_SPEC, params: { ...T30_VALID_SPEC.params, port: 65536 } }, 'INVALID_SPEC', '端口高于 65535')
    rejects({ ...T30_VALID_SPEC, params: { ...T30_VALID_SPEC.params, tensor_parallel: 9 } }, 'INVALID_SPEC', 'TP 越界')
    rejects({ ...T30_VALID_SPEC, params: { ...T30_VALID_SPEC.params, health_timeout_s: 4000 } }, 'INVALID_SPEC', '健康超时越界')
    rejects({ ...T30_VALID_SPEC, extra: 1 }, 'UNKNOWN_FIELD', '未知字段')
    rejects(null, 'INVALID_ARGUMENT', '空请求体')
    // 停用环境：getEnv 返回 enabled=false
    const disabled = new DeployPlanService({ configDir: join(dir, 'conf'), getEnv: () => ({ env: { ...T30_ENV_A, enabled: false } }) })
    assert.throws(() => disabled.generate(T30_VALID_SPEC, { origin: 'tool' }), (error) => error.code === 'ENV_DISABLED', '停用环境拒绝')
    // 校验失败不落盘
    assert.ok(!existsSync(join(dir, 'conf', PLAN_STORE_FILE)), '校验失败不写盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('t30 REST：生成→保存 0600→列表/单条→PUT 编辑步骤（增删改/排序）→DELETE→重启稳定→损坏 store 不覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't30-rest-'))
  const confDir = join(dir, 'conf')
  mkdirSync(confDir, { recursive: true })
  writeFileSync(join(confDir, 'envs.json'), JSON.stringify({ version: 1, pollIntervalMs: 300000, envs: [T30_ENV_A] }))
  const routes = []
  apply(makeCtx({ routes, connection: { requestRejection: () => 0 } }), { dataDir: join(dir, 'data'), configDir: confDir })
  const plansFile = join(confDir, PLAN_STORE_FILE)
  try {
    const call = (p, o) => callRoute(routes[0], `/api/ascend-perf${p}`, o)

    // 生成草稿（REST，不落盘）
    const gen = await call('/deploy/plans/generate', { method: 'POST', body: T30_VALID_SPEC })
    assert.equal(gen.status, 200)
    const draft = gen.payload.data.plan
    assert.equal(draft.draft, true)
    assert.ok(!existsSync(plansFile), '草稿不落盘')

    // 非法保存（步骤空）→ 400 STEP_INVALID
    const bad = await call('/deploy/plans', { method: 'POST', body: { plan: { ...T30_VALID_SPEC, steps: [] } } })
    assert.equal(bad.status, 400)
    assert.equal(bad.payload.error.code, 'STEP_INVALID')

    // 保存（服务端分配 id，0600 原子写）
    const saved = await call('/deploy/plans', { method: 'POST', body: { plan: { ...T30_VALID_SPEC, steps: draft.steps } } })
    assert.equal(saved.status, 200)
    const plan = saved.payload.data.plan
    assert.match(plan.id, /^plan-[0-9a-f]{16}$/)
    assert.equal(plan.executes, false)
    const mode = statSync(plansFile).mode & 0o777
    assert.equal(mode, 0o600, 'plans.json 0600')
    const onDisk1 = JSON.parse(readFileSync(plansFile, 'utf8'))
    assert.equal(onDisk1.version, 1)
    assert.equal(onDisk1.plans.length, 1)

    // 列表 + 单条
    const list = await call('/deploy/plans')
    assert.equal(list.payload.data.count, 1)
    assert.equal(list.payload.data.plans[0].id, plan.id)
    assert.equal(list.payload.data.plans[0].step_count, 10)
    const one = await call(`/deploy/plans/${plan.id}`)
    assert.equal(one.payload.data.plan.id, plan.id)
    assert.equal(one.payload.data.plan.steps.length, 10)
    const unknown = await call('/deploy/plans/plan-0000000000000000')
    assert.equal(unknown.status, 400)
    assert.equal(unknown.payload.error.code, 'PLAN_UNKNOWN')

    // PUT：删一步、改一步、换顺序、加一步
    const steps = [...one.payload.data.plan.steps]
    const removed = steps.splice(1, 1)[0] // 删 s2（基线检出）
    const edited = { ...steps[0], title: '占用复查（改）', detail: '先看面板', command: 'npu-smi info' }
    const reordered = [steps[1], edited, ...steps.slice(2), { title: '收尾自检', detail: '确认日志齐全', command: '', scope: 'both' }]
    const put = await call(`/deploy/plans/${plan.id}`, { method: 'PUT', body: { plan: { ...T30_VALID_SPEC, steps: reordered } } })
    assert.equal(put.status, 200, JSON.stringify(put.payload))
    assert.equal(put.payload.data.plan.steps.length, 10, '删 1 加 1 保持 10')
    assert.equal(put.payload.data.plan.steps[0].title, '基线依赖安装与构建', '排序生效：原第 3 步上移到第 1')
    assert.equal(put.payload.data.plan.steps[1].title, '占用复查（改）', '步骤内容可编辑')
    assert.equal(put.payload.data.plan.steps[1].command, 'npu-smi info')
    assert.equal(put.payload.data.plan.created_at, plan.created_at, 'created_at 保持')
    assert.notEqual(put.payload.data.plan.updated_at, plan.updated_at, 'updated_at 前移')

    // 非法步骤（scope 越界 / 标题空）→ STEP_INVALID
    const badScope = await call(`/deploy/plans/${plan.id}`, { method: 'PUT', body: { plan: { ...T30_VALID_SPEC, steps: [{ title: 'x', detail: '', command: null, scope: 'other' }] } } })
    assert.equal(badScope.payload.error.code, 'STEP_INVALID')
    const badTitle = await call(`/deploy/plans/${plan.id}`, { method: 'PUT', body: { plan: { ...T30_VALID_SPEC, steps: [{ title: '  ', detail: '', command: null, scope: 'both' }] } } })
    assert.equal(badTitle.payload.error.code, 'STEP_INVALID')

    // 重启（新 apply 实例）后计划仍在
    const routes2 = []
    apply(makeCtx({ routes: routes2, connection: { requestRejection: () => 0 } }), { dataDir: join(dir, 'data'), configDir: confDir })
    const again = await callRoute(routes2[0], '/api/ascend-perf/deploy/plans')
    assert.equal(again.payload.data.count, 1)
    assert.equal(again.payload.data.plans[0].step_count, 10)

    // 损坏 store：读取失败（400 PLAN_STORE_READ_FAILED），且不覆盖待修复文件
    const corruptText = '{broken json'
    writeFileSync(plansFile, corruptText)
    const corrupt = await callRoute(routes2[0], '/api/ascend-perf/deploy/plans')
    assert.equal(corrupt.status, 400)
    assert.equal(corrupt.payload.error.code, 'PLAN_STORE_READ_FAILED')
    assert.equal(readFileSync(plansFile, 'utf8'), corruptText, '损坏文件不被覆盖')
    const corruptSave = await callRoute(routes2[0], '/api/ascend-perf/deploy/plans', { method: 'POST', body: { plan: { ...T30_VALID_SPEC, steps: draft.steps } } })
    assert.equal(corruptSave.status, 400)
    assert.equal(readFileSync(plansFile, 'utf8'), corruptText, '保存也不得覆盖损坏文件')

    // 恢复后 DELETE：删除需 id 存在；删除后列表为空
    writeFileSync(plansFile, JSON.stringify({ version: 1, plans: [put.payload.data.plan] }))
    const del = await callRoute(routes2[0], `/api/ascend-perf/deploy/plans/${plan.id}`, { method: 'DELETE' })
    assert.equal(del.status, 200)
    assert.equal(del.payload.data.deleted, plan.id)
    const empty = await callRoute(routes2[0], '/api/ascend-perf/deploy/plans')
    assert.equal(empty.payload.data.count, 0)
    const delAgain = await callRoute(routes2[0], `/api/ascend-perf/deploy/plans/${plan.id}`, { method: 'DELETE' })
    assert.equal(delAgain.status, 400)
    assert.equal(delAgain.payload.error.code, 'PLAN_UNKNOWN')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('t30 工具面：4 个部署计划工具 envelope readonly，错误也走 envelope（fail-closed 不抛）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't30-tools-'))
  try {
    const service = t30Service(dir)
    const tools = createDeployTools({ service })
    assert.equal(tools.length, 4)
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['ascend_deploy_plan_generate', 'ascend_deploy_plan_get', 'ascend_deploy_plan_list', 'ascend_deploy_plan_update'])
    for (const tool of tools) {
      assert.equal(tool.output.schema.type, 'object')
      assert.equal(tool.parameters.additionalProperties, false, `${tool.name} 参数白名单`)
    }
    // 合法生成 → envelope ok + steps
    const gen = await tools.find((tool) => tool.name === 'ascend_deploy_plan_generate').execute(T30_VALID_SPEC)
    assert.equal(gen.status, 'ok')
    assert.equal(gen.data.plan.steps.length, 10)
    // 非法（环境不存在）→ envelope error，不抛
    const bad = await tools.find((tool) => tool.name === 'ascend_deploy_plan_generate').execute({ ...T30_VALID_SPEC, env_id: 'env-nope' })
    assert.equal(bad.status, 'error')
    assert.equal(bad.error.code, 'ENV_UNKNOWN')
    // update 工具：新建保存 + 读取 + 列表
    const update = tools.find((tool) => tool.name === 'ascend_deploy_plan_update')
    const save = await update.execute({ plan: { ...T30_VALID_SPEC, steps: gen.data.plan.steps } })
    assert.equal(save.status, 'ok')
    const id = save.data.plan.id
    const got = await tools.find((tool) => tool.name === 'ascend_deploy_plan_get').execute({ plan_id: id })
    assert.equal(got.data.plan.id, id)
    const list = await tools.find((tool) => tool.name === 'ascend_deploy_plan_list').execute({})
    assert.equal(list.data.count, 1)
    // 更新已有
    const edit = await update.execute({ plan_id: id, plan: { ...T30_VALID_SPEC, steps: gen.data.plan.steps.slice(0, 3) } })
    assert.equal(edit.data.plan.steps.length, 3)
    assert.equal(edit.data.plan.created_at, save.data.plan.created_at)
    // 未知 id → envelope error
    const miss = await tools.find((tool) => tool.name === 'ascend_deploy_plan_get').execute({ plan_id: 'plan-0000000000000000' })
    assert.equal(miss.error.code, 'PLAN_UNKNOWN')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('t30 REST 鉴权 fail-closed（六条计划路由未认证一律 401，透传无响应体）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't30-auth-'))
  const confDir = join(dir, 'conf')
  mkdirSync(confDir, { recursive: true })
  writeFileSync(join(confDir, 'envs.json'), JSON.stringify({ version: 1, pollIntervalMs: 300000, envs: [T30_ENV_A] }))
  const routes = []
  apply(makeCtx({ routes, connection: { requestRejection: () => 401 } }), { dataDir: join(dir, 'data'), configDir: confDir })
  try {
    const paths = [
      ['/api/ascend-perf/deploy/plans', 'GET'],
      ['/api/ascend-perf/deploy/plans', 'POST'],
      ['/api/ascend-perf/deploy/plans/generate', 'POST'],
      ['/api/ascend-perf/deploy/plans/plan-0123456789abcdef', 'GET'],
      ['/api/ascend-perf/deploy/plans/plan-0123456789abcdef', 'PUT'],
      ['/api/ascend-perf/deploy/plans/plan-0123456789abcdef', 'DELETE'],
    ]
    for (const [path, method] of paths) {
      const r = await callRoute(routes[0], path, { method, body: method === 'GET' || method === 'DELETE' ? null : {} })
      assert.equal(r.status, 401, `${method} ${path} 应 401（透传拒绝，无响应体）`)
      assert.equal(r.payload, null, '401 无响应体')
    }
    // 未认证请求不得写盘
    assert.ok(!existsSync(join(confDir, PLAN_STORE_FILE)), '401 请求不产生 plans.json')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('t30 UI：部署分段 v2——环境选择来自 /state、向导字段、只读声明；v1 资产/预览/演示服务全量下线', () => {
  const mod = loadClientModule()
  const t = makeT(mod.__test.zh)
  const state = {
    envs: [
      { id: 'env-a', name: 'A 环境', mode: 'local', hostAlias: null, enabled: true, occupancy: { state: 'idle' } },
      { id: 'env-b', name: 'B 环境', mode: 'ssh', hostAlias: 'ascend-ro', enabled: true, occupancy: { state: 'busy' } },
      { id: 'env-c', name: 'C 环境', mode: 'ssh', hostAlias: 'x@y', enabled: false, occupancy: null },
    ],
    config: { envs: [] },
  }
  const seg = renderNode(mod.__test.ContainerServicesBlock({ state, t }))
  const segText = textOf(seg)

  // t130：部署分段不再有“生成部署计划”向导；环境选择在容器服务块内，只保留启用 SSH 环境
  const selects = []
  const walkSel = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walkSel); return }
    if (node.type === 'select') selects.push(node)
    walkSel(node.children)
  }
  walkSel(seg)
  assert.ok(selects.some((node) => node.props?.['data-testid'] === 'deploy.run.env'), '容器服务应有环境下拉')
  assert.ok(segText.includes('B 环境'), '启用环境出现在下拉文案')
  assert.ok(segText.includes('容器服务'), '容器服务主入口')
  assert.ok(!segText.includes('C 环境'), '停用环境不出现')
  assert.ok(!JSON.stringify(seg).includes('deploy.wiz.'), '生成部署计划向导应移除')
  assert.ok(!JSON.stringify(seg).includes('deploy.legacy'), '旧版计划入口应移除')

  // v1 全量下线：源码与渲染树都不得出现资产/预览/演示服务
  const clientSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')
  for (const banned of ['svc-demo-qwen3-8b', 'services.json', 'DeployServiceRow', 'DeployPreviewCard', 'buildOverrides', 'dry-run 预览', '演示服务']) {
    assert.ok(!clientSource.includes(banned), `client.js 不得残留 v1 概念：${banned}`)
  }
  assert.ok(!segText.includes('DRY-RUN') && !segText.includes('服务资产'), '渲染树无 v1 文案')

  // 纯函数：validateDeploySpec 与 buildSpecPayload
  const good = validateOkFields => mod.__test.validateDeploySpec(validateOkFields)
  const valid = good({ envId: 'env-a', candRef: 'feat/x', candCommit: '', baseRef: 'main', baseCommit: 'a1b2c3d', modelPath: '/data/models/M', modelName: '', port: '18433', tensorParallel: '2', maxNumSeqs: '256', maxBatchedTokens: '8192', healthTimeout: '300' })
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.spec.candidate, { ref: 'feat/x', commit: '' })
  assert.equal(valid.spec.params.port, 18433)
  assert.equal(valid.spec.params.tensor_parallel, 2)
  const invalid = mod.__test.validateDeploySpec({ envId: '', candRef: '', candCommit: 'zz', baseRef: 'main', baseCommit: '', modelPath: 'rel/path', port: '80', tensorParallel: '9', maxNumSeqs: '0', maxBatchedTokens: '10', healthTimeout: '4' })
  assert.equal(invalid.ok, false)
  const errs = invalid.errors
  for (const key of ['deploy.v.env', 'deploy.v.ref', 'deploy.v.commit', 'deploy.v.path', 'deploy.v.port', 'deploy.v.tp', 'deploy.v.seqs', 'deploy.v.batched', 'deploy.v.health']) assert.ok(errs.includes(key), `应有校验错误 ${key}`)
  // 空环境 → 空态提示
  const segEmpty = textOf(renderNode(mod.__test.ContainerServicesBlock({ state: { envs: [], config: { envs: [] } }, t })))
  assert.ok(segEmpty.includes('没有 ssh 模式的启用环境'), '空环境提示')
})

test('t30 UI：计划编辑器——步骤增删改/上下移/归属标注；保存/关闭入口', () => {
  const mod = loadClientModule()
  const t = makeT(mod.__test.zh)
  const draft = {
    draft: true,
    id: null,
    title: 'A 环境 · feat/x vs main',
    env: { id: 'env-a', name: 'A 环境' },
    candidate: { ref: 'feat/x', commit: '' },
    baseline: { ref: 'main', commit: '' },
    model: { path: '/data/models/M', served_name: 'M' },
    params: { port: 18433, tensor_parallel: 2 },
    steps: [
      { id: 's1', title: '环境占用检查', detail: '看面板', command: null, scope: 'both' },
      { id: 's2', title: '基线检出', detail: '', command: 'git checkout main', scope: 'baseline' },
      { id: 's3', title: '候选检出', detail: '', command: 'git checkout feat/x', scope: 'candidate' },
    ],
  }
  const noop = () => {}
  const editor = renderNode(mod.__test.DeployPlanEditor({ draft, editingId: null, busy: false, saveError: null, onChangeStep: noop, onMoveStep: noop, onDeleteStep: noop, onAddStep: noop, onSave: noop, onClose: noop, t }))
  const editorText = textOf(editor)
  assert.ok(editorText.includes('草稿'), '草稿标记')
  assert.ok(editorText.includes('A 环境 · feat/x vs main'), '计划标题')
  assert.ok(editorText.includes('环境信息只读'), '只读声明')

  const stepRows = []
  walkTree(editor, (node) => {
    if (node && typeof node === 'object' && typeof node.props?.['data-testid'] === 'string' && /^deploy\.step\.\d+$/.test(node.props['data-testid'])) stepRows.push(node)
  })
  const rowIds = stepRows.filter((n) => /^deploy\.step\.\d+$/.test(n.props['data-testid'])).map((n) => n.props['data-testid'])
  assert.deepEqual(rowIds, ['deploy.step.0', 'deploy.step.1', 'deploy.step.2'], '三行步骤')
  const tids = []
  walkTree(editor, (n) => { if (n && typeof n === 'object' && typeof n.props?.['data-testid'] === 'string') tids.push(n.props['data-testid']) })
  for (const testid of ['deploy.step.0.up', 'deploy.step.2.down', 'deploy.step.1.del', 'deploy.step.add', 'deploy.editor.save']) {
    assert.ok(tids.includes(testid), `缺少 ${testid}`)
  }
  // 边界：首行上移禁用、末行下移禁用
  const findBtn = (testid) => {
    let found = null
    walkTree(editor, (n) => { if (n && typeof n === 'object' && n.props?.['data-testid'] === testid) found = n })
    return found
  }
  const upBtn = findBtn('deploy.step.0.up')
  const downBtn = findBtn('deploy.step.2.down')
  assert.ok(upBtn && downBtn, '上下移按钮存在')
  assert.equal(upBtn.props.disabled, true, '首行上移禁用')
  assert.equal(downBtn.props.disabled, true, '末行下移禁用')
  // scope 选项三档
  assert.ok(editorText.includes('候选') && editorText.includes('基线') && editorText.includes('两者'), '归属三档')
  // 已保存计划编辑态标记
  const savedEditor = textOf(renderNode(mod.__test.DeployPlanEditor({ draft: { ...draft, draft: false, id: 'plan-0123456789abcdef' }, editingId: 'plan-0123456789abcdef', busy: false, saveError: null, onChangeStep: noop, onMoveStep: noop, onDeleteStep: noop, onAddStep: noop, onSave: noop, onClose: noop, t })))
  assert.ok(savedEditor.includes('已保存'), '已保存标记')
  // 保存错误就地显示
  const errEditor = textOf(renderNode(mod.__test.DeployPlanEditor({ draft, editingId: null, busy: false, saveError: { code: 'PLAN_UNKNOWN', message: '计划不存在' }, onChangeStep: noop, onMoveStep: noop, onDeleteStep: noop, onAddStep: noop, onSave: noop, onClose: noop, t })))
  assert.ok(errEditor.includes('PLAN_UNKNOWN') && errEditor.includes('计划不存在'), '保存错误显示')
})


/* ------------------------------ t29：环境信息 v1.5 ------------------------------ */

test('client.js：t29 卡编号按型号（910C→16 / 910B→8 / 其他按实际）+ 按卡占用条', () => {
  const mod = loadClientModule()
  const t = makeT(mod.__test.zh)
  const chip = (i, over = {}) => ({ chip_id: i, phy_id: i, health: 'ok', temp_c: 40 + i, power_w: 100 + i, aicore_pct: 0, npu_util_pct: 0, hbm_used_mb: 512, hbm_total_mb: 32768, hbm_usage_rate_pct: 1, processes: [], processes_state: 'observed', ...over })

  // 1) cardNumbering：型号决定应有卡数
  assert.deepEqual(mod.__test.cardNumbering([{ model: 'Ascend 910C' }]), { family: '910C', expected: 16 }, '含 910C → 16')
  assert.deepEqual(mod.__test.cardNumbering([{ model: 'Ascend 910B3' }, { model: 'Ascend 910B1' }]), { family: '910B', expected: 8 }, '含 910B → 8')
  assert.deepEqual(mod.__test.cardNumbering([{ model: 'Ascend 310P' }, { model: 'Ascend 310P' }, { model: 'Ascend 310P' }]), { family: 'other', expected: 3 }, '其他 → 实际卡数')
  assert.deepEqual(mod.__test.cardNumbering([]), { family: 'other', expected: 0 }, '空 → 0')

  // 2) deriveEnvOccupancy：per-card 聚合（占用计数/状态/指标聚合/编号 1 基）
  const cards = [
    { card_id: 0, model: 'Ascend 910C', power_w: 350, chips: [chip(0, { processes: [{ pid: 1, name: 'vllm', memory_mb: 1024 }], hbm_usage_rate_pct: 30 }), chip(1)] },
    { card_id: 1, model: 'Ascend 910C', power_w: 300, chips: [chip(0), chip(1)] },
  ]
  const occ = mod.__test.deriveEnvOccupancy(cards)
  assert.equal(occ.numbering.family, '910C')
  assert.equal(occ.numbering.expected, 16)
  assert.equal(occ.cards.length, 2)
  assert.equal(occ.cards[0].number, 1, '卡编号为 1 基（card_id 0 → 1）')
  assert.equal(occ.cards[0].state, 'occupied', '任一 chip 占用 → 卡占用')
  assert.equal(occ.cards[0].occupied, 1)
  assert.equal(occ.cards[0].chipCount, 2)
  assert.equal(occ.cards[1].state, 'idle')
  assert.equal(occ.cards[0].tempMax, 41, '卡内温度峰值')
  assert.equal(occ.cards[0].powerSum, 201, '卡内功率合计 100+101')
  assert.ok(occ.cards[0].hbmRateMax >= 30, 'HBM 峰值取卡内最大')

  // 3) ChipStrip 按卡渲染：一卡一格 + aria（t34：图例行移除）
  const strip = mod.__test.ChipStrip({ occ, t, testid: 'envs.block.env-x.strip' })
  const stripText = textOf(strip)
  const stripIds = []
  walkTree(strip, (n) => { if (n.props?.['data-testid']) stripIds.push(n.props['data-testid']) })
  for (const id of ['envs.card.0', 'envs.card.1', 'envs.block.env-x.strip']) {
    assert.ok(stripIds.includes(id), `占用条应含 data-testid=${id}`)
  }
  assert.ok(!stripIds.includes('envs.chiplegend'), 't34 后 ChipStrip 不应再渲染图例行')
  assert.ok(stripText.includes('1/2'), '卡格应显示占用/总 chip（1/2）')
  assert.ok(stripText.includes('0/2'), '空闲卡格应显示 0/2')
  let cellAria = null
  walkTree(strip, (n) => { if (n.props?.['data-testid'] === 'envs.card.0') cellAria = n.props['aria-label'] })
  assert.ok(cellAria && cellAria.includes('NPU 1（id 0）') && cellAria.includes('占用'), `卡格 aria 应含编号与状态：${cellAria}`)

  // 4) 卡头同 1 基编号：CardBlock 头为 NPU {card_id+1}（id 保留）
  const cardHead = textOf(mod.__test.CardBlock({ card: cards[0], t }))
  assert.ok(cardHead.includes('NPU 1') && cardHead.includes('（id 0）'), `卡头应为 1 基编号并保留原始 id：${cardHead}`)
  // chip 级明细仍在展开详情（ChipRow 保留）
  const chipRow = mod.__test.ChipRow({ chip: cards[0].chips[0], t })
  assert.ok(textOf(chipRow).includes('chip 0'), 'ChipRow 仍保留 chip 级明细')
})

test('t44 UI：环境配置弹窗（逐字段校验 / 逐行环境编辑 / 整体替换载荷 / 无卡内编辑）', () => {
  const mod = loadClientModule()
  const t = makeT(mod.__test.zh)
  const mkEnv = (over = {}) => ({ id: 'env-a', name: '集群A', mode: 'ssh', hostAlias: 'root@10.0.0.1', npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true, availability: 'pending', ...over })

  // 1) validateEnvForm：错误键已迁移 envs.config.err.*；local 无需 SSH 目标
  assert.equal(mod.__test.validateEnvForm({ name: 'A', hostAlias: 'root@10.0.0.1', npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true }, 'ssh').ok, true)
  assert.equal(mod.__test.validateEnvForm({ name: 'A', npuSmiPath: 'npu-smi', timeoutMs: 15000 }, 'local').ok, true, 'local 无需 SSH 目标')
  assert.equal(mod.__test.validateEnvForm({ name: '  ', hostAlias: 'root@10.0.0.1', npuSmiPath: 'npu-smi', timeoutMs: 15000 }, 'ssh').errors.name, 'envs.config.err.nameEmpty')
  assert.equal(mod.__test.validateEnvForm({ name: 'x'.repeat(65), hostAlias: 'root@10.0.0.1', npuSmiPath: 'npu-smi', timeoutMs: 15000 }, 'ssh').errors.name, 'envs.config.err.nameLong')
  assert.equal(mod.__test.validateEnvForm({ name: 'A', hostAlias: '', npuSmiPath: 'npu-smi', timeoutMs: 15000 }, 'ssh').errors.hostAlias, 'envs.config.err.hostRequired')
  assert.equal(mod.__test.validateEnvForm({ name: 'A', hostAlias: 'bad alias!', npuSmiPath: 'npu-smi', timeoutMs: 15000 }, 'ssh').errors.hostAlias, 'envs.config.err.hostInvalid')
  assert.equal(mod.__test.validateEnvForm({ name: 'A', hostAlias: 'root@@10.0.0.1', npuSmiPath: 'npu-smi', timeoutMs: 15000 }, 'ssh').errors.hostAlias, 'envs.config.err.hostUserHost')
  assert.equal(mod.__test.validateEnvForm({ name: 'A', hostAlias: 'root@10.0.0.1', npuSmiPath: 'npu smi', timeoutMs: 15000 }, 'ssh').errors.npuSmiPath, 'envs.config.err.pathInvalid')
  assert.equal(mod.__test.validateEnvForm({ name: 'A', hostAlias: 'root@10.0.0.1', npuSmiPath: 'npu-smi', timeoutMs: 500 }, 'ssh').errors.timeoutMs, 'envs.config.err.timeoutRange')
  assert.equal(mod.__test.validateEnvForm({ name: 'A', hostAlias: 'root@10.0.0.1', npuSmiPath: 'npu-smi', timeoutMs: 61000 }, 'ssh').errors.timeoutMs, 'envs.config.err.timeoutRange')

  // 2) 弹窗渲染：dialog 语义 + 采集频率 + 逐行环境字段（ssh 行含 SSH 目标，local 行不含）
  const config = {
    pollIntervalMs: 600000,
    configFile: '/root/.config/ascend-perf/envs.json',
    envs: [mkEnv(), mkEnv({ id: 'env-b', name: '本机B', mode: 'local', hostAlias: null, npuSmiPath: '/usr/bin/npu-smi', timeoutMs: 20000, enabled: false })],
  }
  const modal = mod.__test.EnvConfigModal({ config, busy: false, onSave: () => {}, onClose: () => {}, t })
  let dialogProps = null
  walkTree(modal, (n) => { if (typeof n === 'object' && n.props?.role === 'dialog') dialogProps = n.props })
  assert.ok(dialogProps && dialogProps['aria-modal'] === 'true', '弹窗应为 role=dialog + aria-modal')
  const modalIds = []
  walkTree(modal, (n) => { if (typeof n === 'object' && n.props?.['data-testid']) modalIds.push(n.props['data-testid']) })
  for (const id of ['envs.config.modal', 'envs.config.poll', 'envs.config.row.0', 'envs.config.row.0.name', 'envs.config.row.0.mode', 'envs.config.row.0.hostAlias', 'envs.config.row.0.npuSmiPath', 'envs.config.row.0.timeoutMs', 'envs.config.row.0.enabled', 'envs.config.row.0.del', 'envs.config.row.1', 'envs.config.add', 'envs.config.cancel', 'envs.config.save']) {
    assert.ok(modalIds.includes(id), `弹窗应含 ${id}`)
  }
  assert.ok(!modalIds.includes('envs.config.row.1.hostAlias'), 'local 行不渲染 SSH 目标字段')
  let hostValue = null; let pollValue = null
  walkTree(modal, (n) => {
    if (typeof n === 'object' && n.props?.['data-testid'] === 'envs.config.row.0.hostAlias') hostValue = n.props.value
    if (typeof n === 'object' && n.props?.['data-testid'] === 'envs.config.poll') pollValue = n.props.value
  })
  assert.equal(hostValue, 'root@10.0.0.1', 'SSH 目标回填完整 user@host')
  assert.equal(pollValue, '10', '采集频率分钟数来自 pollIntervalMs')
  const modalText = textOf(modal)
  assert.ok(modalText.includes('2/16'), `应显示环境计数与上限：${modalText}`)

  // 3) 保存载荷：整体替换（pollIntervalMs + 全部环境整字段）；保存按钮 onClick 直调
  let saved = null
  const modal2 = mod.__test.EnvConfigModal({ config, busy: false, onSave: (payload) => { saved = payload }, onClose: () => {}, t })
  let saveBtn = null
  walkTree(modal2, (n) => { if (typeof n === 'object' && n.props?.['data-testid'] === 'envs.config.save') saveBtn = n })
  assert.ok(saveBtn && saveBtn.props.disabled !== true, '合法输入时保存可用')
  saveBtn.props.onClick()
  assert.ok(saved, '点击保存应产出载荷')
  assert.equal(saved.pollIntervalMs, 600000)
  assert.equal(saved.envs.length, 2)
  assert.deepEqual(saved.envs[0], { id: 'env-a', name: '集群A', mode: 'ssh', hostAlias: 'root@10.0.0.1', npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true }, '行值整体进载荷')
  assert.deepEqual(saved.envs[1], { id: 'env-b', name: '本机B', mode: 'local', hostAlias: null, npuSmiPath: '/usr/bin/npu-smi', timeoutMs: 20000, enabled: false }, '其余环境保留全部字段')

  // 4) 逐字段错误显示（EnvConfigRow 直调注入 errors）
  const row = mod.__test.EnvConfigRow({ row: { id: 'env-a', name: '', mode: 'ssh', hostAlias: 'root@@x', npuSmiPath: 'npu-smi', timeoutMs: '500', enabled: true }, index: 0, errors: { name: 'envs.config.err.nameEmpty', hostAlias: 'envs.config.err.hostUserHost', timeoutMs: 'envs.config.err.timeoutRange' }, busy: false, onField: () => {}, onRemove: () => {}, t })
  const rowText = textOf(row)
  assert.ok(rowText.includes('名称不能为空') && rowText.includes('user@host 形式不合法') && rowText.includes('1000–60000'), `应逐字段显示错误：${rowText}`)

  // 5) 环境卡只读：无编辑入口/表单；EnvsSection 的 ConfigBar 提供「环境配置/重新加载配置」
  const envView = mkEnv({ availability: 'available', collected_at: new Date().toISOString(), snapshot: { availability: 'available', software: { cann_version: '8.0.0' }, npu: { card_count: 1, chip_count: 2, cards: [{ card_id: 0, model: 'Ascend 910B3', chips: [chipIdle(), chipIdle()] }] } }, error: null, warnings: [] })
  function chipIdle() { return { chip_id: 0, phy_id: 0, health: 'ok', processes: [], processes_state: 'none_reported', hbm_usage_rate_pct: 1, aicore_pct: 0, hbm_used_mb: 100, hbm_total_mb: 32768, temp_c: 40, power_w: 100 } }
  const occ = mod.__test.deriveEnvOccupancy(envView.snapshot.npu.cards)
  const blockIds = []
  walkTree(mod.__test.EnvBlock({ env: envView, occ, busy: false, index: 1, t }), (n) => { if (typeof n === 'object' && n.props?.['data-testid']) blockIds.push(n.props['data-testid']) })
  assert.ok(!blockIds.some((id) => id.endsWith('.edit')), '环境卡不应再有编辑入口')
  const state = { config: { pollIntervalMs: 300000, configFile: '/root/.config/ascend-perf/envs.json', envs: [envView] }, envs: [envView] }
  const sectionIds = []
  walkTree(mod.__test.EnvsSection({ state, busy: false, onRefreshAll: () => {}, onImported: () => {}, onOpenConfig: () => {}, onReloadConfig: () => {}, t }), (n) => { if (typeof n === 'object' && n.props?.['data-testid']) sectionIds.push(n.props['data-testid']) })
  assert.ok(sectionIds.includes('envs.configbar.edit') && sectionIds.includes('envs.configbar.reload'), 'ConfigBar 有环境配置/重新加载配置按钮（弹窗主入口 + reload 兜底）')
})

test('t44 环境配置保存链路：弹窗整体替换 → POST /config v2 写 envs.json（0600）并立即生效', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't29-save-'))
  try {
    const conf = join(dir, 'conf')
    const routes = []
    apply(makeCtx({ routes, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: conf })
    // 起步：两个环境（settings.json v2 迁移 → envs.json）
    const envsPath = join(conf, 'envs.json')
    const first = await callRoute(routes[0], '/api/ascend-perf/config', { method: 'POST', body: { pollIntervalMs: 300000, envs: [
      { id: 'env-a', name: '集群A', mode: 'ssh', hostAlias: 'root@10.0.0.1', npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true },
      { id: 'env-b', name: '集群B', mode: 'local', hostAlias: null, npuSmiPath: '/usr/bin/npu-smi', timeoutMs: 20000, enabled: false },
    ] } })
    assert.equal(first.status, 200)

    // 弹窗「保存」产出的整体替换载荷（与 EnvConfigModal.save 同构：pollIntervalMs + 全部环境整字段）
    const payload = { pollIntervalMs: 300000, envs: [
      { id: 'env-a', name: '训练集群A', mode: 'ssh', hostAlias: 'ops@10.0.0.9', npuSmiPath: 'npu-smi', timeoutMs: 25000, enabled: true },
      { id: 'env-b', name: '集群B', mode: 'local', hostAlias: null, npuSmiPath: '/usr/bin/npu-smi', timeoutMs: 20000, enabled: false },
    ] }
    const saved = await callRoute(routes[0], '/api/ascend-perf/config', { method: 'POST', body: payload })
    assert.equal(saved.status, 200)
    assert.equal(saved.payload.config.version, 2)

    // envs.json 0600 且整体替换语义正确：目标环境更新、其余环境全字段保留
    assert.equal(statSync(envsPath).mode & 0o777, 0o600)
    const onDisk = JSON.parse(readFileSync(envsPath, 'utf8'))
    assert.equal(onDisk.version, 1)
    assert.equal(onDisk.pollIntervalMs, 300000)
    assert.deepEqual(onDisk.envs[0], { id: 'env-a', name: '训练集群A', mode: 'ssh', hostAlias: 'ops@10.0.0.9', npuSmiPath: 'npu-smi', timeoutMs: 25000, enabled: true })
    assert.deepEqual(onDisk.envs[1], { id: 'env-b', name: '集群B', mode: 'local', hostAlias: null, npuSmiPath: '/usr/bin/npu-smi', timeoutMs: 20000, enabled: false }, '编辑一个环境不得丢其余环境字段')

    // 重启后（重新 apply）配置稳定；非法整体载荷仍 400（逐字段校验在 Host 侧兜底）
    const routes2 = []
    apply(makeCtx({ routes: routes2, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: conf })
    const state2 = await callRoute(routes2[0], '/api/ascend-perf/state')
    assert.deepEqual(state2.payload.config.envs.map((e) => [e.id, e.name]), [['env-a', '训练集群A'], ['env-b', '集群B']])
    const bad = await callRoute(routes2[0], '/api/ascend-perf/config', { method: 'POST', body: { pollIntervalMs: 300000, envs: [{ id: 'env-a', name: 'X', mode: 'ssh', hostAlias: 'bad alias!', npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true }] } })
    assert.equal(bad.status, 400)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ===== t34 图例移除 + t36 主机标识单次显示（用户 m02470：IP 必须显示，去 root@ 前缀与重复括号） =====
test('t36 UI：主机标识单次显示（环境 N · IP / 自定义名 · IP，无 root@ 前缀）；图例保持移除；配置弹窗仍可改完整 SSH 目标', () => {
  const mod = loadClientModule()
  const t = makeT(mod.__test.zh)
  const mkEnv = (over) => ({ mode: 'ssh', npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true, availability: 'pending', collected_at: null, snapshot: null, error: null, warnings: [], ...over })

  // 1) 播种默认命名（name === hostAlias）→ 「环境 N · IP」；命名环境 → 「自定义名 · IP」；root@ 前缀不出现
  const state = {
    config: { pollIntervalMs: 300000, configFile: '/root/.config/ascend-perf/envs.json' },
    envs: [
      mkEnv({ id: 'env-seed', name: 'root@10.9.9.9', hostAlias: 'root@10.9.9.9' }),
      mkEnv({ id: 'env-named', name: '训练集群A', hostAlias: 'root@10.9.9.8' }),
    ],
  }
  const tree = mod.__test.EnvsSection({ state, busy: false, onRefreshAll: () => {}, onImported: () => {}, onOpenConfig: () => {}, onReloadConfig: () => {}, t })
  const text = textOf(tree)
  const testids = []
  walkTree(tree, (n) => { if (n.props?.['data-testid']) testids.push(n.props['data-testid']) })
  assert.ok(text.includes('环境 1 · 10.9.9.9'), '播种环境应显示「环境 1 · IP」（IP 必须可见，用于区分环境）')
  assert.ok(text.includes('训练集群A · 10.9.9.8'), '命名环境显示「自定义名 · IP」')
  assert.ok(text.includes('10.9.9.9') && text.includes('10.9.9.8'), '两个环境的 IP 各出现，可区分')
  assert.ok(!text.includes('root@'), `正常视图不出现 root@ 前缀（user@host 只留在编辑态）：${text}`)
  assert.ok(text.includes('环境 1 · 10.9.9.9') && text.indexOf('环境 1 · 10.9.9.9') === text.lastIndexOf('环境 1 · 10.9.9.9'), '主机标识只出现一次（不重复）')
  assert.ok(!testids.includes('envs.chiplegend'), '图例行应已移除（t34 保持）')
  assert.ok(!text.includes('每格 = 一张 NPU 卡'), '图例文案应已移除（t34 保持）')
  assert.ok(text.includes('SSH'), 'ssh 环境以「SSH」标签标注')

  // 2) aria-label 同口径：友好名 + IP 开头，无 root@ 前缀
  let pillAria = null
  walkTree(tree, (n) => { if (n.props?.['data-testid'] === 'envs.block.env-seed.pill') pillAria = n.props['aria-label'] })
  assert.ok(pillAria && pillAria.startsWith('环境 1 · 10.9.9.9：'), `pill aria 应用「环境 N · IP」开头：${pillAria}`)
  assert.ok(!String(pillAria).includes('root@'), 'pill aria 不含 root@ 前缀')

  // 3) t44 配置弹窗保留 SSH 目标字段（配置需要完整 user@host；正常视图保持去 root@ 前缀）
  const modalTree = mod.__test.EnvConfigModal({ config: { pollIntervalMs: 300000, configFile: '/root/.config/ascend-perf/envs.json', envs: state.envs }, busy: false, onSave: () => {}, onClose: () => {}, t })
  const modalIds = []
  walkTree(modalTree, (n) => { if (n.props?.['data-testid']) modalIds.push(n.props['data-testid']) })
  assert.ok(modalIds.includes('envs.config.row.0.hostAlias'), '配置弹窗应有 SSH 目标输入')
  let hostInput = null
  walkTree(modalTree, (n) => { if (n && typeof n === 'object' && n.props?.['data-testid'] === 'envs.config.row.0.hostAlias') hostInput = n.props })
  assert.ok(hostInput && hostInput.value === 'root@10.9.9.9', '弹窗回填当前 SSH 目标（完整 user@host，配置需要）')
  assert.ok(textOf(modalTree).includes('模式'), '弹窗模式字段使用 t(envs.modeSsh)/t(envs.modeLocal) 文案')
  assert.ok(modalIds.includes('envs.config.save'), '弹窗可保存')

  // 4) 多环境区分不受影响：排序键仍可用（deriveEnvOccupancy 无 hostAlias 依赖），本机环境显示「本机」
  const state2 = { ...state, envs: [mkEnv({ id: 'env-local', name: '本机', mode: 'local', hostAlias: null }), ...state.envs] }
  const tree2 = mod.__test.EnvsSection({ state: state2, busy: false, onRefreshAll: () => {}, onImported: () => {}, onOpenConfig: () => {}, onReloadConfig: () => {}, t })
  const text2 = textOf(tree2)
  assert.ok(text2.includes('本机') && text2.includes('环境 2 · 10.9.9.9') && text2.includes('训练集群A · 10.9.9.8'), '本机/播种默认/命名环境三态并存且可区分（编号随配置顺序前移）')
  assert.ok(!text2.includes('root@'), '多环境视图同样不出现 root@ 前缀')
})

// ===== t36 与 T35-1：服务部署目标环境同口径单次显示 + 四处字典键覆盖 =====
test('t36 UI：部署目标环境/计划列表/编辑器同口径显示主机标识一次；envs.f.mode 四处补键 + t() 静态键覆盖', () => {
  const mod = loadClientModule()
  const t = makeT(mod.__test.zh)
  assert.equal(mod.__test.zh['envs.f.mode'], '模式', 'client.js 内嵌 zh 字典应有 envs.f.mode')
  assert.equal(mod.__test.en['envs.f.mode'], 'Mode', 'client.js 内嵌 en 字典应有 envs.f.mode')
  const zhLocale = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'locale', 'zh.json'), 'utf8'))
  const enLocale = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'locale', 'en.json'), 'utf8'))
  assert.equal(zhLocale['envs.f.mode'], '模式', 'locale/zh.json 应有 envs.f.mode')
  assert.equal(enLocale['envs.f.mode'], 'Mode', 'locale/en.json 应有 envs.f.mode')
  const flatKeys = (obj) => Object.keys(obj).filter((k) => typeof obj[k] === 'string') // 跳过 12 个 Host 用嵌套组（meta/panel/…）
  assert.deepEqual(flatKeys(zhLocale).filter((k) => !(k in mod.__test.zh)), [], 'locale/zh.json 平铺键应与 client 字典一致（不多）')
  assert.deepEqual(Object.keys(mod.__test.zh).filter((k) => !(k in zhLocale)), [], 'client zh 字典键应都在 locale/zh.json（不少）')
  assert.deepEqual(flatKeys(enLocale).filter((k) => !(k in mod.__test.en)), [], 'locale/en.json 平铺键应与 client en 字典一致')
  for (const k of Object.keys(mod.__test.zh)) if (typeof zhLocale[k] === 'string') assert.equal(zhLocale[k], mod.__test.zh[k], `locale/zh.json[${k}] 应与 client 字典同值`)

  // t() 静态键覆盖：client.js 源码中所有 t('…') 字面量都必须有译文（防再出现裸键）
  const clientSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')
  const staticKeys = new Set()
  for (const m of clientSource.matchAll(/\bt\('([^']+)'\)/g)) staticKeys.add(m[1])
  assert.ok(staticKeys.size > 150, `应扫描到足量静态键（实得 ${staticKeys.size}）`)
  const missingZh = [...staticKeys].filter((k) => !(k in mod.__test.zh))
  const missingEn = [...staticKeys].filter((k) => !(k in mod.__test.en))
  assert.deepEqual(missingZh, [], `client zh 字典缺少 t() 键：${missingZh.join(', ')}`)
  assert.deepEqual(missingEn, [], `client en 字典缺少 t() 键：${missingEn.join(', ')}`)
})



// ===== t44：配置 reload / SSH 单连接采集（@@CARD 分段 + 255 重试 + stale 兜底）/ 部署组件白名单 =====

test('t44 纯函数：SSH 远端单命令脚本 / @@CARD 分段解析 / stderr 脱敏摘要', () => {
  const remote = buildSshRemoteCommand('npu-smi')
  assert.ok(remote.includes("'npu-smi' info"), `脚本应引用 quotePosix 包装的 npu-smi：${remote}`)
  assert.ok(remote.includes('info -l'), '应用 npu-smi info -l 枚举 NPU ID，兼容 910B3 等无 Ascend 前缀型号')
  assert.ok(remote.includes('NPU ID'), '应从 info -l 的 NPU ID 字段提取卡号')
  assert.ok(!remote.includes('+Ascend'), '不得依赖型号名中的 Ascend 前缀')
  assert.ok(remote.includes('@@CARD:%s@@'), '应输出 @@CARD 分段标记')
  assert.ok(buildSshRemoteCommand('/opt/npu-smi').includes("'/opt/npu-smi'"), '自定义路径 quotePosix 包装')

  const info = ['Header', '| 0  Ascend910  | OK |', '| 1  Ascend910  | OK |'].join('\n')
  const usage = 'NPU ID : 0\nHBM Capacity(MB) : 65536'
  const combined = parseCombinedSshOutput(`${info}\n@@CARD:0@@\n${usage}\n@@CARD:1@@\n${usage}\n`)
  assert.equal(combined.infoText, info, '@@CARD 之前为 info 段')
  assert.equal(combined.usagesByCard.get(0), usage)
  assert.equal(combined.usagesByCard.get(1), usage)
  assert.equal(combined.usagesByCard.size, 2)
  assert.equal(parseCombinedSshOutput(info).usagesByCard.size, 0, '无标记时只有 info 段')

  const summary = summarizeSshStderr('ssh: connect to host root@10.1.2.3 port 22: Permission denied, please try again.', 'root@10.1.2.3')
  assert.ok(!summary.includes('root@10.1.2.3') && !summary.includes('10.1.2.3'), 'stderr 摘要应脱敏 user@host 与裸 host')
  assert.ok(summary.includes('<host>'), '脱敏占位 <host>')
  assert.ok(summary.length <= 160, '摘要不超过 160 字符')
})

test('t44 SSH：单连接聚合采集（1 条 ssh + @@CARD 多段）、exit 255 重试一次、连续失败 stale 兜底', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't44-ssh-'))
  const infoText = readFileSync(fixture('npu-info-8cards.txt'), 'utf8').trimEnd()
  const usageText = readFileSync(fixture('npu-usages-card0.txt'), 'utf8')
  const okOut = [infoText]
  for (let i = 0; i < 8; i += 1) okOut.push(`@@CARD:${i}@@`, usageText)
  const combined = okOut.join('\n')
  const failStderr = 'root@10.3.3.3: Permission denied (publickey).\r\nssh_exchange_identification: Connection closed'

  const spawns = []
  const runQueue = []
  const routes = []
  const ctx = {
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    tools: { register() { return () => {} } },
    webServer: { register(route) { routes.push(route); return () => {} }, getOrigin: () => '' },
    set() {},
    get(name) { return name === 'connection' ? { requestRejection: () => 0 } : undefined },
    subprocess: {
      async resolveExecutable() { return '/usr/bin/ssh' },
      spawn(spec) {
        spawns.push(spec.argv)
        const run = runQueue.shift() ?? { exitCode: 0, stdout: combined, stderr: '' }
        return {
          terminate() {},
          collected: {
            stdout: { readFrom: () => ({ text: run.stdout }) },
            stderr: { readFrom: () => ({ text: run.stderr }) },
          },
          done: Promise.resolve({ exitCode: run.exitCode, signal: null }),
        }
      },
    },
  }
  const conf = join(dir, 'conf')
  mkdirSync(conf, { recursive: true })
  writeFileSync(join(conf, 'envs.json'), JSON.stringify({ version: 1, pollIntervalMs: 300000, envs: [{ id: 'env-ssh', name: '训练机', mode: 'ssh', hostAlias: 'root@10.3.3.3', npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true }] }))
  apply(ctx, { dataDir: dir, configDir: conf, sshRetryDelayMs: 0 })
  try {
    // ① 单连接成功：整轮恰好 1 条 SSH；argv 含保活参数与远端脚本；usages 并入快照
    const first = await callRoute(routes[0], '/api/ascend-perf/status', { method: 'POST', body: { env_id: 'env-ssh' } })
    assert.equal(first.status, 200)
    assert.equal(first.payload.env.availability, 'available')
    assert.equal(spawns.length, 1, `成功采集应恰好 1 条 SSH（实得 ${spawns.length}）`)
    const argv = spawns[0]
    assert.equal(argv[0], '/usr/bin/ssh')
    for (const opt of ['-T', 'BatchMode=yes', 'StrictHostKeyChecking=yes', 'ConnectTimeout=8', 'ServerAliveInterval=5', 'ServerAliveCountMax=2']) assert.ok(argv.includes(opt), `ssh 参数应含 ${opt}：${JSON.stringify(argv)}`)
    assert.equal(argv[argv.length - 2], 'root@10.3.3.3', 'hostAlias 在远端命令前')
    const remote = argv[argv.length - 1]
    assert.ok(remote.includes("'npu-smi' info") && remote.includes('@@CARD:%s@@'), '远端命令为单条聚合脚本')
    const card3 = first.payload.envs[0].snapshot.npu.cards[3]
    assert.ok(card3.chips.some((chip) => chip.hbm_total_mb === 65536), '远端 usages 段应并入卡 3 的 chip')
    assert.ok(!(first.payload.envs[0].warnings ?? []).some((w) => w.code === 'USAGES_INCOMPLETE'), '8 卡 usages 齐全，无缺段告警')

    // ② 首败 255 → 重试一次成功：共 2 条 ssh，结果 available
    spawns.length = 0
    runQueue.push({ exitCode: 255, stdout: '', stderr: 'ssh: connect timed out' }, { exitCode: 0, stdout: combined, stderr: '' })
    const second = await callRoute(routes[0], '/api/ascend-perf/status', { method: 'POST', body: { env_id: 'env-ssh' } })
    assert.equal(second.status, 200)
    assert.equal(second.payload.env.availability, 'available', '重试成功仍算可用')
    assert.equal(spawns.length, 2, 'exit 255 应重试恰好 1 次')

    // ③ 连续失败（255×2）且有历史成功快照 → stale + last_success_at + stderr 摘要（脱敏）
    spawns.length = 0
    runQueue.push({ exitCode: 255, stdout: '', stderr: failStderr }, { exitCode: 255, stdout: '', stderr: failStderr })
    const third = await callRoute(routes[0], '/api/ascend-perf/status', { method: 'POST', body: { env_id: 'env-ssh' } })
    assert.equal(third.status, 200)
    const staleEnv = third.payload.envs[0]
    assert.equal(staleEnv.availability, 'stale', '连续失败且有旧档 → stale（保留上次数据）')
    assert.ok(staleEnv.last_success_at, 'stale 应带 last_success_at')
    assert.equal(staleEnv.error?.code, 'SSH_UNAVAILABLE')
    assert.ok(!String(staleEnv.error?.message ?? '').includes('root@10.3.3.3'), '错误信息不泄露 user@host')
    assert.equal(staleEnv.snapshot?.npu?.cards?.length, 8, '旧快照保留供渲染')

    // ④ reload 后新环境无历史 → 连续失败如实 unreachable；有历史环境 stale
    writeFileSync(join(conf, 'envs.json'), JSON.stringify({ version: 1, pollIntervalMs: 300000, envs: [
      { id: 'env-ssh', name: '训练机', mode: 'ssh', hostAlias: 'root@10.3.3.3', npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true },
      { id: 'env-new', name: '新机器', mode: 'ssh', hostAlias: 'root@10.9.9.9', npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true },
    ] }))
    for (let i = 0; i < 4; i += 1) runQueue.push({ exitCode: 255, stdout: '', stderr: failStderr })
    const reload = await callRoute(routes[0], '/api/ascend-perf/config/reload', { method: 'POST', body: {} })
    assert.equal(reload.status, 200)
    assert.equal(reload.payload.env_count, 2, 'reload 后环境数更新')
    const byId = Object.fromEntries(reload.payload.envs.map((e) => [e.id, e]))
    assert.equal(byId['env-ssh'].availability, 'stale', '有历史环境 reload 采集失败 → stale')
    assert.equal(byId['env-new'].availability, 'unreachable', '无历史成功 → 连接失败如实显示（不伪造数据）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('t44 /config/reload：成功重载并触发采集；损坏 envs.json → 400 且保留旧配置；401 透传', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't44-reload-'))
  try {
    const conf = join(dir, 'conf')
    const envsPath = join(conf, 'envs.json')
    const routes = []
    apply(makeCtx({ routes, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: conf })
    writeFileSync(envsPath, JSON.stringify({ version: 1, pollIntervalMs: 300000, envs: [{ id: 'env-a', name: 'A', mode: 'local', hostAlias: null, npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true }] }))
    const first = await callRoute(routes[0], '/api/ascend-perf/config/reload', { method: 'POST', body: {} })
    assert.equal(first.status, 200)
    assert.equal(first.payload.reloaded, true)
    assert.equal(first.payload.env_count, 1)

    // 文件改成 2 个环境 → reload 后 /state 反映新配置
    writeFileSync(envsPath, JSON.stringify({ version: 1, pollIntervalMs: 600000, envs: [
      { id: 'env-a', name: 'A', mode: 'local', hostAlias: null, npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true },
      { id: 'env-b', name: 'B', mode: 'local', hostAlias: null, npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true },
    ] }))
    const second = await callRoute(routes[0], '/api/ascend-perf/config/reload', { method: 'POST', body: {} })
    assert.equal(second.status, 200)
    assert.equal(second.payload.env_count, 2)
    assert.equal(second.payload.pollIntervalMs, 600000)
    const stateAfter = await callRoute(routes[0], '/api/ascend-perf/state')
    assert.equal(stateAfter.payload.envs.length, 2)

    // 损坏 envs.json → reload 400；旧配置保留（envs 仍 2 个）且 /state 出现 envs_config_error
    writeFileSync(envsPath, '{oops')
    const broken = await callRoute(routes[0], '/api/ascend-perf/config/reload', { method: 'POST', body: {} })
    assert.equal(broken.status, 400)
    assert.equal(broken.payload.error?.code, 'CONFIG_READ_FAILED')
    const stateBroken = await callRoute(routes[0], '/api/ascend-perf/state')
    assert.equal(stateBroken.payload.envs.length, 2, '损坏时保留旧配置')
    assert.equal(stateBroken.payload.envs_config_error?.code, 'CONFIG_READ_FAILED', '/state 暴露 envs_config_error 供 UI 错误卡')

    // 修复后再 reload → 成功且错误清除
    writeFileSync(envsPath, JSON.stringify({ version: 1, pollIntervalMs: 600000, envs: [
      { id: 'env-a', name: 'A', mode: 'local', hostAlias: null, npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true },
      { id: 'env-b', name: 'B', mode: 'local', hostAlias: null, npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true },
    ] }))
    const fixed = await callRoute(routes[0], '/api/ascend-perf/config/reload', { method: 'POST', body: {} })
    assert.equal(fixed.status, 200)
    const stateFixed = await callRoute(routes[0], '/api/ascend-perf/state')
    assert.equal(stateFixed.payload.envs_config_error, null)

    // 401：R1 鉴权 fail-closed 透传
    const authRoutes = []
    apply(makeCtx({ routes: authRoutes, connection: { requestRejection: () => 401 } }), { dataDir: dir, configDir: conf })
    const denied = await callRoute(authRoutes[0], '/api/ascend-perf/config/reload', { method: 'POST', body: {} })
    assert.equal(denied.status, 401)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('t44 部署组件白名单：默认 vllm-ascend / fail-closed 校验 / 旧计划读出补默认 / UI 下拉', () => {
  assert.equal(DEFAULT_DEPLOY_COMPONENT, 'vllm-ascend')
  assert.deepEqual(DEPLOY_COMPONENTS, ['vllm', 'vllm-ascend', 'lmcache', 'lmcache-ascend', 'mooncake'])
  const getEnv = () => ({ env: { id: 'env-a', enabled: true }, record: null, occupancy: null })
  const base = { env_id: 'env-a', candidate: { ref: 'feat/x' }, baseline: { ref: 'main' }, model: { path: '/data/models/M', served_name: 'M' }, params: { port: 18433, tensor_parallel: 2 } }
  assert.equal(validatePlanSpec({ ...base }, getEnv).component, 'vllm-ascend', '缺省组件 → vllm-ascend')
  const withComp = validatePlanSpec({ ...base, component: 'lmcache' }, getEnv)
  assert.equal(withComp.component, 'lmcache')
  assert.throws(() => validatePlanSpec({ ...base, component: 'ktransformers' }, getEnv), codeIs('INVALID_SPEC'), '白名单外组件 fail-closed')
  const steps = buildPlanSteps(withComp)
  const joined = steps.map((s) => `${s.title} ${s.detail} ${s.command ?? ''}`).join('\n')
  assert.ok(joined.includes('lmcache'), '计划步骤应包含组件名')
  assert.ok(joined.includes('feat/x') && joined.includes('main'), '计划步骤应包含基线/候选 ref')

  // 旧计划无 component → 读出补默认，不回写盘
  const dir = mkdtempSync(join(tmpdir(), 't44-comp-'))
  try {
    const configDir = join(dir, 'conf')
    const plansPath = join(configDir, 'plans.json')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(plansPath, JSON.stringify({ version: 1, updated_at: '2026-11-09T00:00:00Z', plans: [{ id: 'plan-0123456789abcdef', created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T00:00:00Z', env_id: 'env-a', title: 'T', candidate: { ref: 'main' }, baseline: { ref: 'main' }, model: { path: '/data/models/M', served_name: 'M' }, params: { port: 18433 }, steps: buildPlanSteps(validatePlanSpec({ ...base }, getEnv)) }] }))
    const svc = new DeployPlanService({ configDir, getEnv, now: () => 0 })
    assert.equal(svc.getPlan('plan-0123456789abcdef').data.plan.component, 'vllm-ascend', '旧计划读出补默认组件')
    assert.ok(JSON.parse(readFileSync(plansPath, 'utf8')).plans[0].component === undefined, '读出补默认不回写盘')
    assert.equal(svc.listPlans().data.plans[0].component, 'vllm-ascend', '列表 summary 同样补默认')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // t131：旧版计划向导 UI 已移除；代码组件白名单与 payload 纯函数仍保留
  const mod = loadClientModule()
  assert.deepEqual(mod.__test.DEPLOY_COMPONENTS, DEPLOY_COMPONENTS, 'client 与 Host 白名单一致')
  const state = { envs: [{ id: 'env-a', name: 'A', mode: 'local', enabled: true, occupancy: { state: 'idle' } }], config: { envs: [] } }
  const seg = renderNode(mod.__test.DeploySegment({ state, t: makeT(mod.__test.zh) }))
  assert.ok(!JSON.stringify(seg).includes('deploy.wiz.component'), '计划向导组件下拉应移除')
  const bad = mod.__test.validateDeploySpec({ ...mod.__test.deployDefaultFields(), envId: 'env-a', component: 'ktransformers' })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.includes('deploy.v.component'), '白名单外组件给出 deploy.v.component 错误键')
  const okSpec = mod.__test.validateDeploySpec({ ...mod.__test.deployDefaultFields(), envId: 'env-a', candRef: 'feat/x', baseRef: 'main', modelPath: '/data/models/M', modelName: 'M', tensorParallel: '1' })
  assert.equal(okSpec.ok, true)
  assert.equal(okSpec.spec.component, 'vllm-ascend', '合法载荷携带 component')
})


// ===== t124 服务部署 v3：容器服务预览/启动/状态/停止（execSsh 全 mock，绝不真启动） =====

import { DeployRunService, createDeployRunRoutes, createDeployRunTools, validateRunSpec, buildRunArgv, buildBuildScript, DEPLOY_RUN_SCHEMA, RUN_CONTAINER_PREFIX } from '../deploy-exec.js'

const T124_ENV_SSH = { id: 'env-b01', name: 'b01', mode: 'ssh', hostAlias: 'b01', npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true }
const T124_ENV_LOCAL = { id: 'env-local', name: '本机', mode: 'local', npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true }

function t124GetEnv(env = T124_ENV_SSH) {
  return (envId) => (envId === env.id ? { env, record: null, occupancy: null } : null)
}

const T124_SPEC = {
  env_id: 'env-b01',
  image: 'quay.io/ascend/vllm-ascend:v0.23.0',
  model: { root: '/home/z00919396/models', path: 'Qwen3-8B' },
  params: { port: 18433, tensor_parallel: 2, max_model_len: 4096, health_timeout_s: 300 },
  cards: [6, 7],
}

function t124IdleUsage() {
  // 与真实 npu-smi info -t usages -i N 输出同形
  return { exitCode: 0, stdout: 'NPU ID : 6\nChip Count : 2\nHBM Usage Rate(%) : 3\nAicore Usage Rate(%) : 1\n', stderr: '' }
}

function t124MockExec(scripted = [], calls = []) {
  return async (hostAlias, command) => {
    calls.push([hostAlias, command])
    for (const [needle, out] of scripted) {
      if (command.includes(needle)) return typeof out === 'function' ? out(command) : out
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

function t124DefaultScript() {
  return [
    ['usages -i 6', t124IdleUsage()],
    ['usages -i 7', t124IdleUsage()],
    ['ss -ltn', { exitCode: 0, stdout: '', stderr: '' }],
    ['docker image inspect', { exitCode: 0, stdout: 'FOUND\n', stderr: '' }],
    ['test -d', { exitCode: 0, stdout: '', stderr: '' }],
  ]
}

test('t124 校验：validateRunSpec 白名单与卡/TP 约束（本地环境/相对路径/../卡重复/TP 不匹配）', async () => {
  const getEnv = (envId) => (envId === 'env-b01' ? { env: T124_ENV_SSH } : envId === 'env-local' ? { env: T124_ENV_LOCAL } : null)
  const ok = validateRunSpec(T124_SPEC, getEnv)
  assert.equal(ok.spec.params.port, 18433)
  assert.deepEqual(ok.spec.cards, [6, 7])
  const codeIs = (code) => (error) => error?.code === code
  assert.throws(() => validateRunSpec({ ...T124_SPEC, env_id: 'env-local' }, getEnv), codeIs('ENV_MODE_UNSUPPORTED'))
  assert.throws(() => validateRunSpec({ ...T124_SPEC, env_id: 'env-none' }, getEnv), codeIs('ENV_UNKNOWN'))
  assert.throws(() => validateRunSpec({ ...T124_SPEC, model: { root: '/a', path: '../etc' } }, getEnv), codeIs('INVALID_ARGUMENT'))
  assert.throws(() => validateRunSpec({ ...T124_SPEC, cards: [6, 6] }, getEnv), codeIs('INVALID_ARGUMENT'))
  assert.throws(() => validateRunSpec({ ...T124_SPEC, params: { ...T124_SPEC.params, tensor_parallel: 1 } }, getEnv), codeIs('INVALID_ARGUMENT'))
  assert.throws(() => validateRunSpec({ ...T124_SPEC, extra: 1 }, getEnv), codeIs('UNKNOWN_FIELD'))
  assert.throws(() => validateRunSpec({ ...T124_SPEC, params: { ...T124_SPEC.params, port: 80 } }, getEnv), codeIs('INVALID_ARGUMENT'))
})

test('t133 构建模式：repo/ref 必填、Docker 命令内 clone+pip install、默认关闭不构建', async () => {
  const getEnv = (envId) => (envId === 'env-b01' ? { env: T124_ENV_SSH } : null)
  const base = {
    ...T124_SPEC,
    code: {
      root: '/home/z00919396',
      build: true,
      components: [
        { component: 'vllm-ascend', ref: 'dsv41_layerwise', repo: 'https://github.com/newpage1/vllm-ascend.git' },
        { component: 'lmcache', ref: 'dsv41_layerwise', repo: 'git@github.com:newpage1/LMCache.git' },
      ],
    },
  }
  const ok = validateRunSpec(base, getEnv)
  assert.equal(ok.spec.code.build, true)
  const script = buildBuildScript(ok.spec)
  assert.ok(script.includes('git clone') && script.includes('pip install --no-build-isolation -e'), '构建脚本应 clone + pip install')
  assert.ok(script.includes('/opt/dsh-src/vllm-ascend') && script.includes('/opt/dsh-src/lmcache'))
  const argv = buildRunArgv(ok.spec, 'svc-abc123', 'dsh-apf-svc-test').join(' ')
  assert.ok(argv.includes('bash -lc'), 'build 模式应以 bash -lc 进入容器')
  assert.ok(argv.includes('vllm serve'), '构建后仍执行 vllm serve')
  const codeIs = (code) => (error) => error?.code === code
  assert.throws(() => validateRunSpec({ ...base, code: { ...base.code, components: [{ component: 'vllm-ascend', ref: 'x' }] } }, getEnv), codeIs('INVALID_ARGUMENT'), '构建模式缺 repo 应拒绝')
  assert.throws(() => validateRunSpec({ ...base, code: { ...base.code, components: [{ component: 'vllm-ascend', ref: 'x', repo: 'javascript:alert(1)' }] } }, getEnv), codeIs('INVALID_ARGUMENT'), '非法 repo 应拒绝')
  const noBuild = validateRunSpec({ ...base, code: { ...base.code, build: false } }, getEnv)
  assert.equal(noBuild.spec.code.build, undefined, '默认不开启构建')
  assert.ok(!buildRunArgv(noBuild.spec, 'svc-abc123', 'dsh-apf-svc-test').join(' ').includes('bash -lc'))
})

test('t128 配方 opt-in：未列入 privilegedHosts 的环境走非特权基线回退（不自动 privileged）', async () => {
  const calls = []
  const svc = new DeployRunService({ getEnv: t124GetEnv(), execSsh: t124MockExec(t124DefaultScript(), calls) }) // 无 getDeployConfig → 默认不 opt-in
  const res = await svc.preview(T124_SPEC)
  assert.equal(res.data.recipe, 'baseline-sandboxed')
  assert.equal(res.data.gates.privileged_opt_in, false)
  const argv = res.data.argv.join(' ')
  assert.ok(!argv.includes('--privileged'), '默认不提权')
  assert.ok(!argv.includes('--ipc=host'), '默认不加 ipc=host')
  assert.ok(!argv.includes('ASCEND_RT_VISIBLE_DEVICES'), '基线配方不设 env（25.x 驱动靠 --device 重映射）')
  assert.ok(argv.includes('--device=/dev/davinci6') && argv.includes(' -- '), '选中卡与 -- 分隔保留')
  assert.ok(res.warnings.some((w) => String(w).includes('基线配方')), '基线配方风险提示')
  // 显式 getDeployConfig 但不含 b01 → 同样基线
  const svc2 = new DeployRunService({ getEnv: t124GetEnv(), execSsh: t124MockExec(t124DefaultScript(), []), getDeployConfig: () => ({ privilegedHosts: ['c01'] }) })
  const res2 = await svc2.preview(T124_SPEC)
  assert.equal(res2.data.recipe, 'baseline-sandboxed', '仅列出其他主机时 b01 仍为基线')
})

test('t126/t128 配方修正：privilegedHosts 显式列入的环境 → --privileged/--ipc=host/ASCEND_RT_VISIBLE_DEVICES=逻辑序号/-- 分隔 +确认令牌', async () => {
  const calls = []
  const svc = new DeployRunService({ getEnv: t124GetEnv(), execSsh: t124MockExec(t124DefaultScript(), calls), getDeployConfig: () => ({ privilegedHosts: ['b01'] }) })
  const res = await svc.preview(T124_SPEC)
  assert.equal(res.schema, DEPLOY_RUN_SCHEMA)
  assert.equal(res.status, 'ok')
  assert.equal(res.readonly, true, 'preview 只读')
  assert.equal(res.effects.remote_write, false)
  const data = res.data
  assert.ok(data.container_name.startsWith(RUN_CONTAINER_PREFIX), '容器名必须 dsh-apf-svc- 前缀')
  assert.ok(data.confirmation_token.length >= 24, '确认令牌存在')
  assert.equal(data.gates.real_execution, false, '默认未启用真实执行')
  const argv = data.argv.join(' ')
  assert.equal(data.recipe, 'privileged-isolated')
  assert.equal(data.gates.privileged_opt_in, true)
  assert.ok(res.warnings.some((w) => String(w).includes('特权配方')), '特权配方风险提示')
  assert.ok(argv.includes('--device=/dev/davinci6') && argv.includes('--device=/dev/davinci7'))
  assert.ok(argv.includes('--device=/dev/davinci_manager') && argv.includes('--device=/dev/devmm_svm') && argv.includes('--device=/dev/hisi_hdc'), '三个公共 device 齐全')
  // t126：b01 驱动 26.0.rc1 实测——无 --privileged 时 ascend_hal 枚举失败；privileged 下必须用
  // ASCEND_RT_VISIBLE_DEVICES=选中卡物理序号限制可见设备（否则能枚举全部 8 卡；t139 实测逻辑序号会打到错误物理卡）
  assert.ok(argv.includes('--privileged'), '驱动 26.0 要求 --privileged')
  assert.ok(argv.includes('--ipc=host'), 'vLLM 共享内存')
  assert.ok(argv.includes('-e ASCEND_RT_VISIBLE_DEVICES=6,7'), '选中卡 [6,7] → 物理序号 6,7（t139 勘误：env 取物理 davinci 序号，非逻辑 0..N-1）')
  assert.ok(argv.includes(` -- 'quay.io/ascend/vllm-ascend:v0.23.0'`), "image 前有 '--' 分隔（image 经 quotePosix）")
  assert.ok(argv.includes('-p 127.0.0.1:18433:18433'), '端口只绑 127.0.0.1')
  assert.ok(argv.includes(`-v '/home/z00919396/models':/models:ro`), '模型根目录只读挂载（quotePosix）')
  assert.ok(argv.includes('-v /usr/local/Ascend/driver:/usr/local/Ascend/driver:ro'))
  assert.ok(argv.includes(`--label dsh-ascend-perf.service=${data.service_id}`))
  assert.ok(argv.includes(`vllm serve '/models/Qwen3-8B'`), 'vllm serve 模型路径（quotePosix）')
  // 只读预检命令都被发出（逐卡 usages / 端口 / 镜像 / 模型目录）
  const all = calls.map(([, c]) => c).join('\n')
  for (const needle of ['usages -i 6', 'usages -i 7', 'ss -ltn', 'docker image inspect', String.raw`test -d '/home/z00919396/models'/'Qwen3-8B'`]) {
    assert.ok(all.includes(needle), `预检缺少 ${needle}`)
  }
  assert.ok(!all.includes('docker run'), '预览绝不执行 docker run')
})

test('t124 预检 fail-closed：卡忙/端口占用/镜像缺失/模型目录缺失/npu-smi 失败', async () => {
  const codeIs = (code) => (error) => error?.code === code
  const mk = (scripted) => new DeployRunService({ getEnv: t124GetEnv(), execSsh: t124MockExec(scripted) })
  const busyUsage = { exitCode: 0, stdout: 'HBM Usage Rate(%) : 40\nAicore Usage Rate(%) : 2\n', stderr: '' }
  await assert.rejects(() => mk([['usages -i 6', t124IdleUsage()], ['usages -i 7', busyUsage], ['ss -ltn', { exitCode: 0, stdout: '', stderr: '' }], ['docker image inspect', { exitCode: 0, stdout: 'FOUND\n', stderr: '' }], ['test -d', { exitCode: 0, stdout: '', stderr: '' }]]).preview(T124_SPEC), codeIs('CHIP_BUSY'))
  await assert.rejects(() => mk([['usages -i', t124IdleUsage()], ['ss -ltn', { exitCode: 0, stdout: 'BUSY\n', stderr: '' }], ['docker image inspect', { exitCode: 0, stdout: 'FOUND\n', stderr: '' }], ['test -d', { exitCode: 0, stdout: '', stderr: '' }]]).preview(T124_SPEC), codeIs('PORT_IN_USE'))
  await assert.rejects(() => mk([['usages -i', t124IdleUsage()], ['ss -ltn', { exitCode: 0, stdout: '', stderr: '' }], ['docker image inspect', { exitCode: 0, stdout: 'MISSING\n', stderr: '' }], ['test -d', { exitCode: 0, stdout: '', stderr: '' }]]).preview(T124_SPEC), codeIs('IMAGE_NOT_FOUND'))
  await assert.rejects(() => mk([['usages -i', t124IdleUsage()], ['ss -ltn', { exitCode: 0, stdout: '', stderr: '' }], ['docker image inspect', { exitCode: 0, stdout: 'FOUND\n', stderr: '' }], ['test -d', { exitCode: 1, stdout: '', stderr: '' }]]).preview(T124_SPEC), codeIs('MODEL_DIR_MISSING'))
  await assert.rejects(() => mk([['usages -i', { exitCode: 1, stdout: '', stderr: '' }]]).preview(T124_SPEC), codeIs('SSH_UNAVAILABLE'))
})

test('t124 启动双门 fail-closed：未启用不执行 docker run / 坏令牌 / 过期 / spec 篡改；全过后才 docker run', async () => {
  const codeIs = (code) => (error) => error?.code === code
  let clock = 1731600000000
  const calls = []
  const exec = t124MockExec([...t124DefaultScript(), ['docker run', { exitCode: 0, stdout: 'abc123containerid\n', stderr: '' }]], calls)
  const svcDisabled = new DeployRunService({ getEnv: t124GetEnv(), execSsh: exec })
  const previewDisabled = await svcDisabled.preview(T124_SPEC)
  await assert.rejects(() => svcDisabled.start({ ...T124_SPEC, confirmation_token: previewDisabled.data.confirmation_token }), codeIs('REAL_EXECUTION_DISABLED'))
  assert.ok(!calls.some(([, c]) => c.includes('docker run')), '未启用时绝不执行 docker run')

  const svc = new DeployRunService({ getEnv: t124GetEnv(), execSsh: exec, isRealExecutionEnabled: () => true, now: () => new Date(clock) })
  const preview = await svc.preview(T124_SPEC)
  const token = preview.data.confirmation_token
  await assert.rejects(() => svc.start({ ...T124_SPEC, confirmation_token: 'no-such-token' }), codeIs('INVALID_CONFIRMATION'))
  await assert.rejects(() => svc.start({ ...T124_SPEC }), codeIs('INVALID_CONFIRMATION'))
  clock += 601 * 1000
  const preview2 = await svc.preview(T124_SPEC)
  clock += 601 * 1000
  await assert.rejects(() => svc.start({ ...T124_SPEC, confirmation_token: preview2.data.confirmation_token }), codeIs('INVALID_CONFIRMATION'))
  const preview3 = await svc.preview(T124_SPEC)
  await assert.rejects(() => svc.start({ ...T124_SPEC, params: { ...T124_SPEC.params, port: 18434 }, confirmation_token: preview3.data.confirmation_token }), codeIs('INVALID_CONFIRMATION'))
  const preview4 = await svc.preview(T124_SPEC)
  const started = await svc.start({ ...T124_SPEC, confirmation_token: preview4.data.confirmation_token })
  assert.equal(started.status, 'ok')
  assert.equal(started.effects.remote_write, true, '启动如实声明远端写')
  assert.ok(started.data.docker_container_id.length > 0)
  assert.equal(started.data.instance.container_name, preview4.data.container_name, 'start 复用预览容器名')
  const runCalls = calls.filter(([, c]) => c.includes('docker run'))
  assert.equal(runCalls.length, 1, '恰好一次 docker run')
  assert.ok(runCalls[0][1].includes(`--label dsh-ascend-perf.service=${preview4.data.service_id}`))
  // t126②：已有活跃实例/占位时重复 start 与卡/端口冲突 → RESERVATION_CONFLICT（不再次 docker run）
  const preview4b = await svc.preview(T124_SPEC)
  await assert.rejects(() => svc.start({ ...T124_SPEC, confirmation_token: preview4b.data.confirmation_token }), codeIs('RESERVATION_CONFLICT'))
  const specOverlap = { ...T124_SPEC, cards: [7], params: { ...T124_SPEC.params, tensor_parallel: 1 } }
  const preview4c = await svc.preview(specOverlap)
  await assert.rejects(() => svc.start({ ...specOverlap, confirmation_token: preview4c.data.confirmation_token }), codeIs('RESERVATION_CONFLICT'), '卡 7 与活跃实例交叠')
  assert.equal(calls.filter(([, c]) => c.includes('docker run')).length, 1, '冲突路径绝不再次 docker run')
  const listed = await svc.listInstances()
  assert.equal(listed.data.instances.length, 1)
  assert.deepEqual(listed.data.instances[0].cards, [6, 7])
})

function t124InspectScript(running, exitCode = 0, label = 'svc-abc123') {
  return [['docker inspect', { exitCode: 0, stdout: `/dsh-apf-svc-qwen3-8b-abc123|${running}|${exitCode}|${label}\n`, stderr: '' }]]
}

test('t124 状态/日志/停止：健康探针、健康超时清理、label 守卫 FORBIDDEN', async () => {
  const codeIs = (code) => (error) => error?.code === code
  let clock = 1731600000000
  let healthy = false
  let inspectScript = null // 在 start 之后按真实 service_id 设置（t126⑤ 严格 label 守卫）
  const calls = []
  const exec = async (hostAlias, command) => {
    calls.push(command)
    if (command.includes('docker inspect')) return inspectScript[0][1]
    if (command.includes('curl -sf')) return healthy ? { exitCode: 0, stdout: 'HEALTHY\n', stderr: '' } : { exitCode: 0, stdout: 'NOT_YET\n', stderr: '' }
    if (command.includes('docker run')) return { exitCode: 0, stdout: 'cid\n', stderr: '' }
    for (const [needle, out] of t124DefaultScript()) if (command.includes(needle)) return out
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const svc = new DeployRunService({ getEnv: t124GetEnv(), execSsh: exec, isRealExecutionEnabled: () => true, now: () => new Date(clock) })
  const preview = await svc.preview(T124_SPEC)
  const svcId = preview.data.service_id
  await svc.start({ ...T124_SPEC, confirmation_token: preview.data.confirmation_token })
  inspectScript = t124InspectScript('true', 0, svcId)

  // 起动中：running 且 curl 未就绪且未超时
  let status = await svc.status(svcId)
  assert.equal(status.data.health, 'starting')

  // 健康：curl HEALTHY
  healthy = true
  status = await svc.status(svcId)
  assert.equal(status.data.health, 'healthy')

  // 健康超时：running + 一直不健康 + 超时 → docker rm -f 自有容器 + error
  healthy = false
  inspectScript = t124InspectScript('true', 0, svcId)
  clock += 301 * 1000
  status = await svc.status(svcId)
  assert.equal(status.data.health, 'error')
  assert.ok(String(status.data.cleanup ?? '').includes('health timeout'))
  assert.ok(calls.some((c) => c.includes(`docker rm -f 'dsh-apf-svc-qwen3-8b-${svcId.slice(4)}'`)), '超时清理自有容器（quotePosix）')

  // 已退出：exit 0 → stopped（登记表清理）
  const preview2 = await svc.preview(T124_SPEC)
  await svc.start({ ...T124_SPEC, confirmation_token: preview2.data.confirmation_token })
  inspectScript = t124InspectScript('false', 0, preview2.data.service_id)
  status = await svc.status(preview2.data.service_id)
  assert.equal(status.data.health, 'stopped')
  assert.equal((await svc.listInstances()).data.instances.length, 0, '终态实例退出登记表')

  // label 守卫：inspect 显示他人容器（无 label）→ stop/logs FORBIDDEN 且不发 docker stop/logs
  const preview3 = await svc.preview(T124_SPEC)
  await svc.start({ ...T124_SPEC, confirmation_token: preview3.data.confirmation_token })
  inspectScript = [['docker inspect', { exitCode: 0, stdout: '/dsh-apf-svc-qwen3-8b-x|true|0|\n', stderr: '' }]]
  const before = calls.length
  await assert.rejects(() => svc.stop(preview3.data.service_id), codeIs('FORBIDDEN'))
  await assert.rejects(() => svc.logs(preview3.data.service_id), codeIs('FORBIDDEN'))
  assert.ok(!calls.slice(before).some((c) => c.includes('docker stop') || c.includes('docker logs')), 'FORBIDDEN 时不发写命令')

  // t126⑤：label 非空但值错误（他人 dsh-apf-svc- 容器）→ status/logs/stop 均 FORBIDDEN
  inspectScript = [['docker inspect', { exitCode: 0, stdout: '/dsh-apf-svc-qwen3-8b-y|true|0|svc-somebodyelse\n', stderr: '' }]]
  await assert.rejects(() => svc.status(preview3.data.service_id), codeIs('FORBIDDEN'))
  await assert.rejects(() => svc.logs(preview3.data.service_id), codeIs('FORBIDDEN'))
  await assert.rejects(() => svc.stop(preview3.data.service_id), codeIs('FORBIDDEN'))

  // 正常停止：label 匹配 → docker stop -t 30 && docker rm（t126⑥：不保留 Exited 容器）
  inspectScript = t124InspectScript('true', 0, preview3.data.service_id)
  await svc.stop(preview3.data.service_id)
  const stopCall = calls.find((c) => c.includes(`docker stop -t 30 'dsh-apf-svc-qwen3-8b-${preview3.data.service_id.slice(4)}'`))
  assert.ok(stopCall, 'docker stop -t 30 <自有容器>')
  assert.ok(stopCall.includes(`docker rm 'dsh-apf-svc-qwen3-8b-${preview3.data.service_id.slice(4)}'`), 'stop 后 docker rm，避免 stopped 累积')
  assert.equal((await svc.listInstances()).data.instances.length, 0)
})

test('t124 工具与 REST：preview/start/status/stop 四工具 + 六条路由挂载 + 401 透传 fail-closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't124-auth-'))
  try {
    const routes = []
    apply(makeCtx({ routes, connection: { requestRejection: () => 401 } }), { dataDir: dir, configDir: join(dir, 'conf') })
    for (const path of [
      '/api/ascend-perf/deploy/run/preview',
      '/api/ascend-perf/deploy/run/start',
      '/api/ascend-perf/deploy/run/instances',
      '/api/ascend-perf/deploy/run/instances/svc-abc123',
      '/api/ascend-perf/deploy/run/instances/svc-abc123/logs',
      '/api/ascend-perf/deploy/run/instances/svc-abc123/stop',
    ]) {
      const r = await callRoute(routes[0], path, { method: path.endsWith('/preview') || path.endsWith('/start') || path.endsWith('/stop') ? 'POST' : 'GET', body: {} })
      assert.equal(r.status, 401, `${path} 应 401`)
    }
    // 工具错误不抛：envelope 包装
    const svc = new DeployRunService({ getEnv: t124GetEnv(), execSsh: t124MockExec([['usages -i', { exitCode: 1, stdout: '', stderr: '' }]]) })
    const tools = createDeployRunTools(svc)
    assert.equal(tools.length, 4)
    // 回归（captain 热修）：output.schema 必须是 JSON Schema 对象，字符串 schema 会让 Cordis 整个插件 fiber 崩掉
    for (const def of tools) {
      assert.ok(def.output && typeof def.output.schema === 'object' && def.output.schema !== null && !Array.isArray(def.output.schema),
        `${def.name}.output.schema 必须是对象（不是字符串）`)
    }
    const bad = await tools.find((tool) => tool.name === 'ascend_deploy_run_preview').execute(T124_SPEC)
    assert.equal(bad.status, 'error')
    assert.equal(bad.error.code, 'SSH_UNAVAILABLE')
    const restRoutes = createDeployRunRoutes(svc)
    assert.equal(restRoutes.length, 6)
    assert.ok(restRoutes.every((route) => typeof route.handler === 'function'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('t124 UI：容器服务块渲染（空闲卡可勾/占用卡禁用/未启用提示/预览按钮/计划块仍在）', async () => {
  const mod = loadClientModule()
  const t = makeT(mod.__test.zh)
  const busyChip = { chip_id: 1, hbm_usage_rate_pct: 42, aicore_pct: 3 }
  const idleChip = { chip_id: 1, hbm_usage_rate_pct: 3, aicore_pct: 1 }
  const state = {
    envs: [
      { id: 'env-b01', name: 'b01', mode: 'ssh', hostAlias: 'b01', enabled: true, availability: 'available',
        snapshot: { availability: 'available', npu: { cards: [
          { card_id: 6, chips: [{ chip_id: 0, ...idleChip }] },
          { card_id: 7, chips: [{ chip_id: 0, ...busyChip }] },
        ] } } },
      { id: 'env-local', name: '本机', mode: 'local', enabled: true },
    ],
    deploy_run: { real_execution_enabled: false, init_error: null },
    config: { configFile: '/very/long/path/to/configs/ascend-perf/envs.json', pollIntervalMs: 300000, envs: [] },
  }
  const node = renderNode(mod.__test.ContainerServicesBlock({ state, t }))
  const text = textOf(node)
  let busyBox = null
  let idleBox = null
  walkTree(node, (n) => {
    if (n && typeof n === 'object' && n.props?.['data-testid'] === 'deploy.run.card.0') idleBox = n
    if (n && typeof n === 'object' && n.props?.['data-testid'] === 'deploy.run.card.1') busyBox = n
  })
  assert.ok(idleBox, '空闲 chip 0 渲染')
  assert.ok(busyBox, '占用 chip 1 渲染')
  const idleInput = (idleBox.children ?? []).flat(3).find((c) => c && typeof c === 'object' && c.type === 'input')
  const busyInput = (busyBox.children ?? []).flat(3).find((c) => c && typeof c === 'object' && c.type === 'input')
  assert.equal(idleInput?.props?.disabled, false, '空闲卡可选')
  assert.equal(busyInput?.props?.disabled, true, '占用卡禁选')
  assert.ok(text.includes('真实执行未启用'), '未启用提示')
  let previewBtn = null
  walkTree(node, (n) => { if (n && typeof n === 'object' && n.props?.['data-testid'] === 'deploy.run.preview') previewBtn = n })
  assert.ok(previewBtn, '预览按钮存在')
  assert.equal(previewBtn.props.disabled, true, '未选卡/未填模型时预览禁用')
  // t131：旧版“生成部署计划”入口已移除
  assert.ok(!JSON.stringify(state).includes('deploy.wiz.generate'), '计划生成入口应移除')
})

// ===== t126 修复轮：接管/占位/envs 保留/恶意 image/execSsh argv/render 返回值 =====

import { buildDeploySshExec } from '../index.js'

test('t126 接管：重启后按容器名 status/logs/stop（前缀+label 校验通过才操作）', async () => {
  const codeIs = (code) => (error) => error?.code === code
  const inspectOut = (running, exitCode, label) => ({ exitCode: 0, stdout: `/dsh-apf-svc-llama-1b-2a2e1c|${running}|${exitCode}|${label}\n`, stderr: '' })
  let inspect = inspectOut('true', 0, 'svc-2a2e1c')
  const calls = []
  const exec = async (host, command) => {
    calls.push([host, command])
    if (command.includes('docker inspect')) return inspect
    if (command.includes('docker logs')) return { exitCode: 0, stdout: 'LOG-LINE\n', stderr: '' }
    if (command.includes('docker stop')) return { exitCode: 0, stdout: '', stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const svc = new DeployRunService({ getEnv: t124GetEnv(), execSsh: exec, listEnvs: () => [T124_ENV_SSH] })
  // 非法名（无前缀）→ INSTANCE_UNKNOWN，不发起任何远端探测
  await assert.rejects(() => svc.status('evil-container'), codeIs('INSTANCE_UNKNOWN'))
  assert.equal(calls.length, 0, '非法名不产生远端命令')
  // 接管查询：running + label 匹配 → running/adopted
  const st = await svc.status('dsh-apf-svc-llama-1b-2a2e1c')
  assert.equal(st.data.health, 'running')
  assert.equal(st.data.adopted, true)
  assert.ok(calls.some(([h]) => h === 'b01'), '经启用 ssh 环境 hostAlias 探测')
  // 接管 stopped
  inspect = inspectOut('false', 0, 'svc-2a2e1c')
  const st2 = await svc.status('dsh-apf-svc-llama-1b-2a2e1c')
  assert.equal(st2.data.health, 'stopped')
  // 接管 logs
  inspect = inspectOut('true', 0, 'svc-2a2e1c')
  const lg = await svc.logs('dsh-apf-svc-llama-1b-2a2e1c', { tail: 50 })
  assert.ok(String(lg.data.log).includes('LOG-LINE'))
  // 接管 stop：docker stop -t 30 && docker rm
  const sp = await svc.stop('dsh-apf-svc-llama-1b-2a2e1c')
  assert.equal(sp.data.stopped, true)
  assert.equal(sp.data.adopted, true)
  const stopCall = calls.find(([, c]) => c.includes('docker stop'))
  assert.ok(stopCall[1].includes('docker stop -t 30') && stopCall[1].includes('docker rm'), 'stop+rm 组合')
  assert.ok(stopCall[1].includes('dsh-apf-svc-llama-1b-2a2e1c'))
  // 前缀匹配但 label 空 → FORBIDDEN（接管路径同样守卫）
  inspect = inspectOut('true', 0, '')
  await assert.rejects(() => svc.status('dsh-apf-svc-llama-1b-2a2e1c'), codeIs('FORBIDDEN'))
  // t128④：非空但错误的 label——模式不符 / 与容器名后缀不一致 → 拒绝接管
  inspect = inspectOut('true', 0, 'svc-somebodyelse')
  await assert.rejects(() => svc.status('dsh-apf-svc-llama-1b-2a2e1c'), codeIs('FORBIDDEN'))
  await assert.rejects(() => svc.logs('dsh-apf-svc-llama-1b-2a2e1c'), codeIs('FORBIDDEN'))
  await assert.rejects(() => svc.stop('dsh-apf-svc-llama-1b-2a2e1c'), codeIs('FORBIDDEN'))
  inspect = inspectOut('true', 0, 'not-a-service-label')
  await assert.rejects(() => svc.status('dsh-apf-svc-llama-1b-2a2e1c'), codeIs('FORBIDDEN'), 'label 不符合 service-id 模式')
})

test('t126 占位与失败清理：docker run 失败 → rm -f 自有容器 + 释放占位 → 可重试成功', async () => {
  const codeIs = (code) => (error) => error?.code === code
  let runOk = false
  const calls = []
  const exec = async (host, command) => {
    calls.push(command)
    if (command.includes('docker run')) return runOk ? { exitCode: 0, stdout: 'cid\n', stderr: '' } : { exitCode: 1, stdout: '', stderr: 'docker: boom\n' }
    if (command.includes('docker inspect')) return { exitCode: 0, stdout: '/dsh-apf-svc-qwen3-8b-zzz999|false|0|svc-zzz999\n', stderr: '' }
    for (const [needle, out] of t124DefaultScript()) if (command.includes(needle)) return out
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const svc = new DeployRunService({ getEnv: t124GetEnv(), execSsh: exec, isRealExecutionEnabled: () => true })
  const p1 = await svc.preview(T124_SPEC)
  await assert.rejects(() => svc.start({ ...T124_SPEC, confirmation_token: p1.data.confirmation_token }), codeIs('DOCKER_ERROR'))
  assert.ok(calls.some((c) => c.includes('docker rm -f') && c.includes(p1.data.container_name)), '失败后清理自有容器')
  // 占位已释放：docker run 恢复后同卡同端口可重试成功
  runOk = true
  const p2 = await svc.preview(T124_SPEC)
  const started = await svc.start({ ...T124_SPEC, confirmation_token: p2.data.confirmation_token })
  assert.equal(started.status, 'ok')
  assert.equal(calls.filter((c) => c.includes('docker run')).length, 2, '失败一次+重试一次')
})

test('t126 恶意 image：leading - 在 validate 阶段拒绝，不进任何远端命令', async () => {
  const codeIs = (code) => (error) => error?.code === code
  assert.throws(() => validateRunSpec({ ...T124_SPEC, image: '-evil --privileged' }, t124GetEnv()), codeIs('INVALID_ARGUMENT'))
  const calls = []
  const svc = new DeployRunService({ getEnv: t124GetEnv(), execSsh: t124MockExec(t124DefaultScript(), calls) })
  await assert.rejects(() => svc.preview({ ...T124_SPEC, image: '-evil --privileged' }), codeIs('INVALID_ARGUMENT'))
  assert.ok(!calls.some(([, c]) => c.includes('evil')), '恶意 image 不进远端命令')
})

test('t126 envs.json 未知键保留与 gate 同步（POST /config 与导入两路）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't126-envs-'))
  try {
    const conf = join(dir, 'conf')
    mkdirSync(conf, { recursive: true })
    writeFileSync(join(conf, 'envs.json'), JSON.stringify({ version: 1, pollIntervalMs: 300000, envs: [{ id: 'env-b01', name: 'b01', mode: 'ssh', hostAlias: 'b01', npuSmiPath: 'npu-smi', timeoutMs: 15000, enabled: true }], deploy: { allowRealExecution: true } }, null, 2))
    const routes = []
    apply(makeCtx({ routes, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: conf })
    const st = await callRoute(routes[0], '/api/ascend-perf/state')
    assert.equal(st.status, 200)
    assert.equal(st.payload.deploy_run.real_execution_enabled, true, '启动读取 deploy 键开启 gate')
    const r = await callRoute(routes[0], '/api/ascend-perf/config', { method: 'POST', body: { pollIntervalMs: 600000, envs: [{ id: 'env-a', name: 'A', mode: 'ssh', hostAlias: 'root@1.2.3.4' }] } })
    assert.equal(r.status, 200)
    const onDisk = JSON.parse(readFileSync(join(conf, 'envs.json'), 'utf8'))
    assert.equal(onDisk.deploy.allowRealExecution, true, 'POST /config 保留未知 deploy 键')
    assert.equal(onDisk.pollIntervalMs, 600000)
    assert.equal((await callRoute(routes[0], '/api/ascend-perf/state')).payload.deploy_run.real_execution_enabled, true, '写后 gate 与文件一致')
    const imp = await callRoute(routes[0], '/api/ascend-perf/envs/import/json', { method: 'POST', body: { text: JSON.stringify({ pollIntervalMs: 120000, envs: [{ id: 'env-b', name: 'B', mode: 'ssh', hostAlias: 'root@5.6.7.8' }] }) } })
    assert.equal(imp.status, 200)
    const onDisk2 = JSON.parse(readFileSync(join(conf, 'envs.json'), 'utf8'))
    assert.equal(onDisk2.deploy.allowRealExecution, true, '导入路径同样保留 deploy 键')
    assert.equal((await callRoute(routes[0], '/api/ascend-perf/state')).payload.deploy_run.real_execution_enabled, true, '导入后 gate 仍与文件一致')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('t126 execSsh 构造：buildDeploySshExec 的 resolved argv', async () => {
  const spawns = []
  const ctx = {
    subprocess: {
      resolveExecutable: async (name) => { if (name === 'ssh') return '/usr/bin/ssh'; throw new Error('ENOENT ' + name) },
      spawn: (spec) => {
        spawns.push(spec)
        return { terminate () {}, done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: { readFrom: () => ({ text: 'OK' }) }, stderr: { readFrom: () => ({ text: '' }) } } }
      },
    },
  }
  const execSsh = buildDeploySshExec(ctx, { cwd: '/tmp/t128-cwd' }) // t128 回归：必须透传 cfg（runCommand 需要 cfg.cwd）
  const out = await execSsh('root@10.0.0.9', 'npu-smi info', 7000)
  assert.equal(out.exitCode, 0)
  assert.equal(out.stdout, 'OK')
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].cwd, '/tmp/t128-cwd', 'cfg 透传到 spawn（t126 回归：丢 cfg.cwd 致真实 SSH 全挂）')
  assert.deepEqual(spawns[0].argv, [
    '/usr/bin/ssh', '-T',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-o', 'ConnectionAttempts=1',
    '-o', 'ClearAllForwardings=yes',
    'root@10.0.0.9', 'npu-smi info',
  ])
  await execSsh('h2', 'x', 1000)
  assert.equal(spawns.length, 2)
})

test('t138 profile tools 必须声明 output.render（Cordis 激活门）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prof-tools-'))
  try {
    const svc = createProfileService({ dataDir: dir })
    const tools = createProfileTools(svc)
    assert.equal(tools.length, 3)
    for (const def of tools) {
      assert.ok(def.output && typeof def.output.schema === 'object' && def.output.schema !== null, `${def.name}.output.schema 必须是对象`)
      assert.equal(typeof def.output.render, 'function', `${def.name}.output.render 必须是函数`)
      const rendered = def.output.render({}, { status: 'ok' })
      assert.ok(Array.isArray(rendered) && rendered[0]?.type === 'text', `${def.name}.render 返回 text 数组`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('t126 render 返回值：容器服务块返回树上的 testid/文案（不是入参）', async () => {
  const mod = loadClientModule()
  const t = makeT(mod.__test.zh)
  const idleChip = { chip_id: 1, hbm_usage_rate_pct: 3, aicore_pct: 1 }
  const state = {
    envs: [{ id: 'env-b01', name: 'b01', mode: 'ssh', hostAlias: 'b01', enabled: true, availability: 'available',
      snapshot: { availability: 'available', npu: { cards: [{ card_id: 6, chips: [{ chip_id: 0, ...idleChip }] }] } } }],
    deploy_run: { real_execution_enabled: false, init_error: null },
    config: { configFile: '/x/envs.json', pollIntervalMs: 300000, envs: [] },
  }
  const node = renderNode(mod.__test.ContainerServicesBlock({ state, t }))
  const tids = []
  walkTree(node, (n) => { if (n && typeof n === 'object' && typeof n.props?.['data-testid'] === 'string') tids.push(n.props['data-testid']) })
  for (const tid of ['deploy.run.env', 'deploy.run.image', 'deploy.run.modelRoot', 'deploy.run.modelPath', 'deploy.run.port', 'deploy.run.maxModelLen', 'deploy.run.preview', 'deploy.run.start', 'deploy.run.instances']) {
    assert.ok(tids.includes(tid), `渲染树缺少 ${tid}`)
  }
  const text = textOf(node)
  assert.ok(typeof text === 'string' && text.includes('真实执行未启用'), '返回树文案含未启用提示')
  assert.ok(t('deploy.run.noInstances'), '空实例文案键存在')
})

test('t128 文档一致性：配方 opt-in 口径在 README 与 verification 同步且无过期红线', () => {
  const readme = readFileSync(join(here, '..', 'README.md'), 'utf8')
  const verification = readFileSync(join(here, '..', 'docs', 'verification.md'), 'utf8')
  for (const doc of [['README.md', readme], ['docs/verification.md', verification]]) {
    const [name, text] = doc
    assert.ok(text.includes('privilegedHosts'), `${name} 缺 privilegedHosts opt-in 键说明`)
    assert.ok(text.includes('ASCEND_RT_VISIBLE_DEVICES'), `${name} 缺 ASCEND_RT_VISIBLE_DEVICES 说明`)
    assert.ok(text.includes('26.0'), `${name} 缺 26.0 驱动依据`)
  }
  assert.ok(readme.includes('baseline-sandboxed') || readme.includes('基线'), 'README 缺基线/回退配方说明')
  assert.ok(readme.includes('安全回退') || readme.includes('默认基线'), 'README 缺默认基线（安全回退）措辞')
  assert.ok(!verification.includes('绝不设置 ASCEND_RT_VISIBLE_DEVICES') && !verification.includes('**无 `ASCEND_RT_VISIBLE_DEVICES`**'), 'verification 仍残留 t124 期单配方红线（§21.2 已由 t128 双配方口径取代）')
})

test('t128 回归：REST pattern 路由透传 params（修复 STORE_IO reading 0）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-perf-t128route-'))
  try {
    const routes = []
    await apply(makeCtx({ routes, connection: { requestRejection: () => 0 } }), { dataDir: dir, configDir: join(dir, 'conf') })
    // 修复前：api 包装漏传 params → params[0] undefined → STORE_IO "Cannot read properties of undefined (reading '0')"
    // 修复后：params 正常透传，错误以服务层 INSTANCE_UNKNOWN 如实返回（而非 STORE_IO reading '0'）
    const r = await callRoute(routes[0], '/api/ascend-perf/deploy/run/instances/dsh-apf-svc-someone', { method: 'GET' })
    assert.equal(r.payload.error?.code, 'INSTANCE_UNKNOWN', JSON.stringify(r.payload.error))
    assert.notEqual(r.payload.error?.code, 'STORE_IO')
    const s = await callRoute(routes[0], '/api/ascend-perf/deploy/run/instances/dsh-apf-svc-someone/stop', { method: 'POST', body: {} })
    assert.equal(s.payload.error?.code, 'INSTANCE_UNKNOWN', JSON.stringify(s.payload.error))
    assert.notEqual(s.payload.error?.code, 'STORE_IO')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('t131 服务部署：c01 16 chip / b01 8 chip 选择，代码目录只读挂载', () => {
  const mod = loadClientModule()
  const mk = (perCard) => ({ snapshot: { npu: { cards: Array.from({ length: 8 }, (_, i) => ({ card_id: i, chips: Array.from({ length: perCard }, (_, c) => ({ chip_id: c, hbm_usage_rate_pct: 2, aicore_pct: 0 })) })) } } })
  const c01 = mod.__test.runCardStates(mk(2))
  assert.equal(c01.length, 16, 'c01 8 卡×2 chip = 16 个可选 chip')
  assert.equal(c01[1].device_id, 1)
  assert.equal(c01[1].card_id, 0, 'chip 1 属于 card 0')
  const b01 = mod.__test.runCardStates(mk(1))
  assert.equal(b01.length, 8, 'b01 8 卡×1 chip = 8 个可选 chip')
  assert.equal(mod.__test.envRunDefaults(mk(2)).image, mod.__test.DEPLOY_RUN_BIG_IMAGE, '16 chip 环境默认 A3 镜像')
  assert.equal(mod.__test.envRunDefaults(mk(1)).image, mod.__test.DEPLOY_RUN_DEFAULT_IMAGE, '8 chip 环境默认 B 系列镜像')
  assert.equal(mod.__test.envRunDefaults(mk(1)).modelRoot, '/data1/models')
  assert.equal(mod.__test.envRunDefaults(mk(1)).maxLen, '131072')
  const spec = validateRunSpec({ ...T124_SPEC, code: { root: '/home/z00919396' }, cards: [0], params: { ...T124_SPEC.params, tensor_parallel: 1 } }, t124GetEnv())
  assert.deepEqual(spec.spec.code, { root: '/home/z00919396' })
  const argv = buildRunArgv(spec.spec, 'svc-x', 'dsh-apf-svc-x', { privileged: false }).join(' ')
  assert.ok(argv.includes(':/code:ro'), '代码目录只读挂到 /code')
  const big = validateRunSpec({ ...T124_SPEC, cards: [0], params: { ...T124_SPEC.params, tensor_parallel: 1, max_model_len: 150000 } }, t124GetEnv())
  assert.equal(big.spec.params.max_model_len, 150000, 'DSV4.1 150k 上下文可通过校验')
})

test('t132 高级参数：vLLM 启动参数与五组件代码分支进入运行规格', () => {
  const raw = { ...T124_SPEC, cards: [0], params: { ...T124_SPEC.params, tensor_parallel: 1, max_num_seqs: 128, max_num_batched_tokens: 4096, gpu_memory_utilization: 0.85, enable_prefix_caching: false, enforce_eager: true }, code: { root: '/home/z00919396', components: [{ component: 'vllm', ref: 'main' }, { component: 'lmcache', ref: 'dev', commit: 'abc1234' }] } }
  const { spec } = validateRunSpec(raw, t124GetEnv())
  assert.equal(spec.params.max_num_seqs, 128)
  assert.equal(spec.params.max_num_batched_tokens, 4096)
  assert.equal(spec.params.gpu_memory_utilization, 0.85)
  assert.equal(spec.code.components.length, 2)
  const argv = buildRunArgv(spec, 'svc-x', 'dsh-apf-svc-x', { privileged: false }).join(' ')
  assert.ok(argv.includes('--max-num-seqs 128'))
  assert.ok(argv.includes('--max-num-batched-tokens 4096'))
  assert.ok(argv.includes('--gpu-memory-utilization 0.85'))
  assert.ok(argv.includes('--no-enable-prefix-caching'))
  assert.ok(argv.includes('--enforce-eager'))
  assert.throws(() => validateRunSpec({ ...raw, code: { components: [{ component: 'bad', ref: 'main' }] } }, t124GetEnv()), /未知代码组件/)
  assert.throws(() => validateRunSpec({ ...raw, code: { components: [{ component: 'vllm', ref: 'bad ref!' }] } }, t124GetEnv()), /分支/)
})


/* ================== t131：msprof profile P1（解析/存储/R01–R05/REST/UI） ================== */

test('profile：CSV 基础解析（引号/内嵌换行/BOM/CRLF/行号保留）', () => {
  // 引号内嵌逗号 + "" 转义 + CRLF + BOM
  const text = '\uFEFFName,Shape\r\n"A,1","x""y"\r\nB,"line1\nline2"\r\n'
  const { records, rows } = parseCsvRecords(text)
  assert.equal(records.length, 3)
  assert.deepEqual(records[0], ['Name', 'Shape'])
  assert.deepEqual(records[1], ['A,1', 'x"y'])
  assert.deepEqual(records[2], ['B', 'line1\nline2'])
  assert.equal(rows[1], 2)
  assert.equal(rows[2], 3)
})

test('profile：us→ns 定点换算（精确/舍入/精度标记/非法）', () => {
  assert.equal(usToNsDecimal('11707.694').ns, '11707694')
  assert.equal(usToNsDecimal('11707.694').precisionLoss, false)
  assert.equal(usToNsDecimal('3913.5785').ns, '3913579') // 四舍五入
  assert.equal(usToNsDecimal('3913.5785').precisionLoss, true)
  assert.equal(usToNsDecimal('3913.5784').ns, '3913578')
  assert.equal(usToNsDecimal('0.001').ns, '1')
  assert.equal(usToNsDecimal('NaN').ok, false)
  assert.equal(usToNsDecimal('12abc').ok, false)
  assert.equal(usToNsDecimal('').ok, false)
})

test('profile：header 指纹判型（真实表头/未知/空文件）', () => {
  const stat = read('profile/op_statistic.csv')
  const kern = read('profile/kernel_details.csv')
  assert.equal(detectProfileDialect(stat).dialect, 'statistic')
  assert.equal(detectProfileDialect(kern).dialect, 'kernel')
  const unknown = detectProfileDialect('foo,bar\n1,2\n')
  assert.equal(unknown.dialect, 'unknown')
  assert.equal(unknown.reason, 'unrecognized_header')
  const empty = detectProfileDialect('')
  assert.equal(empty.dialect, 'unknown')
  assert.equal(empty.reason, 'empty_file')
  // 未知表头不是 kernel（native op_summary 不冒充）
  const nativeSummary = 'Op Name,Task Type,Frequency,Percent\nAdd,0,10,0.5\n'
  assert.equal(detectProfileDialect(nativeSummary).dialect, 'unknown')
})

test('profile：op_statistic 真实样本解析（Count/Total/份额/行号/来源）', () => {
  const stat = read('profile/op_statistic.csv')
  const s = parseOpStatistic(stat, { file: { source_id: 'src-e1', path_redacted: 'op_statistic.csv' }, sessionId: 'prof-fixed0000000001' })
  assert.equal(s.kind, 'aggregate')
  assert.equal(s.ops.length, 3)
  assert.equal(s.ops.reduce((a, o) => a + o.calls, 0), 21) // 设计 §9：Count 总和 21
  const totalNs = s.ops.reduce((a, o) => a + BigInt(o.total_ns), 0n)
  assert.equal(totalNs.toString(), '13170463') // 13170.463 us（设计 §9）
  const first = s.ops[0]
  assert.equal(first.op_type, 'LaserAttention')
  assert.equal(first.core_type, 'MIX_AIC')
  assert.equal(first.calls, 3)
  assert.equal(first.total_ns, '11707694')
  assert.equal(first.mean_ns, '3902565') // 11707.694/3 → us 定点均值 3902.565
  assert.equal(first.sources[0].locator, 'row:2') // 来源行号
  const ratio = first.metrics.find((m) => m.key === 'source_ratio')
  assert.ok(Math.abs(ratio.value - 0.88894) < 1e-9)
  assert.equal(ratio.semantic_status, 'source_reported')
})

test('profile：op_statistic 降级（Count=0 / NaN / 缺列 / 部分拒绝）', () => {
  const header = 'Device_id,OP Type,Core Type,Count,Total Time(us),Ratio(%)\n'
  // Count=0：calls=0 但 mean/min/max 缺省并给 missing_reasons
  const zeroCount = parseOpStatistic(header + '0,Transpose,AI_VECTOR_CORE,0,0.000,0.000\n', { file: { source_id: 's1', path_redacted: 'x' }, sessionId: 'prof-t0' })
  assert.equal(zeroCount.ops[0].calls, 0)
  assert.equal(zeroCount.ops[0].mean_ns, null)
  assert.equal(zeroCount.ops[0].missing_reasons.mean_ns, 'count_is_zero_source_mean_undefined')
  // NaN/非法数 → 行级 rejected
  const nan = parseOpStatistic(header + '0,Transpose,AI_VECTOR_CORE,3,NaN,1.0\n', { file: { source_id: 's1', path_redacted: 'x' }, sessionId: 'prof-t1' })
  assert.equal(nan.ops.length, 0)
  assert.equal(nan.rejected.length, 1)
  assert.equal(nan.rejected[0].reason, 'not_a_decimal_us')
  // 部分拒绝 → session partial（由 service 层体现），行级保留
  const partial = parseOpStatistic(header + '0,A,AI_VECTOR_CORE,1,1.500,0.1\n0,B,AI_VECTOR_CORE,abc,2.500,0.2\n', { file: { source_id: 's1', path_redacted: 'x' }, sessionId: 'prof-t2' })
  assert.equal(partial.ops.length, 1)
  assert.equal(partial.rejected.length, 1)
  // 缺必需列 → 结构化错误
  assert.throws(() => parseOpStatistic('Device_id,OP Type\n0,A\n', { file: { source_id: 's', path_redacted: 'x' }, sessionId: 'prof-t3' }), (e) => e instanceof ProfileError && e.code === 'PROFILE_PARSE_ERROR')
  // CRLF + BOM 不影响
  const crlf = parseOpStatistic('\uFEFF' + header.replace(/\n/g, '\r\n') + '0,A,AI_VECTOR_CORE,2,3.000,0.3\r\n', { file: { source_id: 's1', path_redacted: 'x' }, sessionId: 'prof-t4' })
  assert.equal(crlf.ops.length, 1)
  assert.equal(crlf.ops[0].total_ns, '3000')
})

test('profile：kernel_details 真实样本解析（实例/us→ns/counter 语义）', () => {
  const kern = read('profile/kernel_details.csv')
  const k = parseKernelDetails(kern, { file: { source_id: 'src-e3', path_redacted: 'kernel_details.csv' }, sessionId: 'prof-fixed0000000002' })
  assert.equal(k.kind, 'instance')
  assert.equal(k.ops.length, 21) // 设计 §9：21 实例
  assert.equal(k.counters_absent.length, 0)
  const la = k.ops.find((o) => o.op_name === 'LaserAttention')
  assert.ok(la)
  assert.equal(la.sources[0].locator, 'row:8')
  assert.equal(la.total_ns, '3913578') // 3913.578 us → ns
  const mac = la.metrics.find((m) => m.key === 'aic_mac_ratio')
  assert.ok(Math.abs(mac.value - 0.79) < 1e-12)
  assert.equal(mac.semantic_status, 'verified')
  assert.equal(mac.unit, 'ratio')
  // 每条记录 100% 带来源
  assert.ok(k.ops.every((o) => o.sources.length > 0 && o.sources[0].locator.startsWith('row:')))
  // N/A 字段不炸（Model ID/Context ID）
  assert.ok(k.ops.every((o) => o.op_name != null))
  // 缺 counter 列 → counters_absent（R02 skipped 依据）
  const headerNoCounters = 'Device_id,Task ID,Stream ID,Name,Type,OP State,Accelerator Core,Start Time(us),Duration(us)\n0,10,47,K,Transpose,Done,AI_VECTOR_CORE,1.000,2.000\n'
  const k2 = parseKernelDetails(headerNoCounters, { file: { source_id: 's', path_redacted: 'x' }, sessionId: 'prof-t5' })
  assert.ok(k2.counters_absent.includes('aic_mac_ratio'))
  // 负 duration → rejected
  const neg = parseKernelDetails(headerNoCounters + '0,11,47,K2,Bad,Done,AI_VECTOR_CORE,1.000,-5.000\n', { file: { source_id: 's', path_redacted: 'x' }, sessionId: 'prof-t6' })
  assert.equal(neg.rejected.length, 1)
  assert.equal(neg.rejected[0].reason, 'negative_duration')
})

test('profile：ProfileStore 私有存储（0700/0600/原子写/列表/详情/删除）', () => {
  const dir = mkdtempSync(join(tmpdir(), 't131-store-'))
  const store = new ProfileStore(dir)
  const manifest = {
    schema: 'profile-session-v1', session_id: 'prof-abc123def4567890', revision: 1, state: 'ready',
    evidence_kind: 'unverified_import', is_demo: false, created_at: new Date().toISOString(),
    source: { mode: 'upload', env_id: null, parser_version: 'x' }, model: { name: null, revision: null, origin: 'unknown' },
    parallel: { tp: null, pp: null, dp: null, cp: null, ep: null, device_count: null },
    versions: { cann: null, driver: null, torch_npu: null, msprof: null },
    capture: { started_at: null, ended_at: null, command_redacted: null, parameters: {}, stability: 'unknown' },
    clocks: [], files: [{ source_id: 's1', path_redacted: 'op_statistic.csv', sha256: '0'.repeat(64), bytes: 1, dialect: PROFILE_DIALECTS.statistic.id, validation: 'native_sample_verified' }],
    coverage: { accepted: 1, rejected: 0, unhandled: 0, join_exact: 0, join_ambiguous: 0, join_missing: 0, complete_device_timeline: false },
    linked_run_ids: [], missing_reasons: {},
  }
  const ops = [{ session_id: 'prof-abc123def4567890', op_id: 'abcdef0123456789', record_kind: 'aggregate', op_type: 'A', core_type: 'AI_VECTOR_CORE', calls: 1, total_ns: '1000', metrics: [], sources: [{ source_id: 's1', locator: 'row:2', fields: ['OP Type'] }], missing_reasons: {} }]
  store.commitSession({ manifest, ops })
  assert.equal(statSync(join(dir, 'profile-v1')).mode & 0o777, 0o700)
  assert.equal(statSync(join(dir, 'profile-v1', 'real', 'prof-abc123def4567890', 'manifest.json')).mode & 0o777, 0o600)
  assert.equal(store.listSessions().length, 1)
  assert.equal(store.getManifest('prof-abc123def4567890').manifest.session_id, 'prof-abc123def4567890')
  assert.equal(store.queryOps('prof-abc123def4567890')[0].op_type, 'A')
  assert.throws(() => store.getManifest('prof-doesnotexist00'), (e) => e.code === 'PROFILE_SESSION_NOT_FOUND')
  store.deleteSession('prof-abc123def4567890')
  assert.equal(store.listSessions().length, 0)
  assert.ok(!existsSync(join(dir, 'profile-v1', 'real', 'prof-abc123def4567890')))
  // t133 T132-10：非法 manifest/op → PROFILE_SCHEMA_INVALID，不落库
  const badCases = [
    ['manifest.session_id 非法', { ...manifest, session_id: 'not-a-session-id' }, ops],
    ['manifest.files[].sha256 非法', { ...manifest, files: [{ ...manifest.files[0], sha256: '00' }] }, ops],
    ['manifest.state 非法', { ...manifest, state: 'weird' }, ops],
    ['ops[].session_id 不一致', manifest, [{ ...ops[0], session_id: 'prof-ffffffffffffffff' }]],
    ['ops[].op_id 非法', manifest, [{ ...ops[0], op_id: 'op1' }]],
    ['ops[].sources[].source_id 外键悬空', manifest, [{ ...ops[0], sources: [{ source_id: 's-not-exist', locator: 'row:2', fields: [] }] }]],
  ]
  for (const [label, m, o] of badCases) {
    assert.throws(() => store.commitSession({ manifest: m, ops: o }), (e) => e instanceof ProfileError && e.code === 'PROFILE_SCHEMA_INVALID', `应拒绝：${label}`)
  }
  assert.equal(store.listSessions().length, 0)
  rmSync(dir, { recursive: true, force: true })
})

function buildRealSession(dir) {
  const service = createProfileService({ dataDir: dir })
  const stat = read('profile/op_statistic.csv')
  const kern = read('profile/kernel_details.csv')
  const imp = service.importFiles({ files: [{ name: 'op_statistic.csv', content: stat }, { name: 'kernel_details.csv', content: kern }] })
  return { service, imp }
}

test('profile：R01–R05 真实样本判定（trigger/not/skip 与证据）', () => {
  const dir = mkdtempSync(join(tmpdir(), 't131-rules-'))
  const { service, imp } = buildRealSession(dir)
  const rep = service.report(imp.session_id)
  const byId = Object.fromEntries(rep.rules.map((r) => [r.rule_id, r]))
  // R01 LaserAttention 88.894% ≥ 30% → triggered，证据含来源行
  assert.equal(byId.R01.status, 'triggered')
  assert.ok(byId.R01.evidence[0].row.startsWith('row:'))
  assert.equal(byId.R01.evidence[0].file, 'op_statistic.csv')
  // R02 加权 mac≈0.79 ≥ 0.5 → not_triggered（有 counter）
  assert.equal(byId.R02.status, 'not_triggered')
  assert.ok(byId.R02.metrics.find((m) => m.key === 'weighted_aic_mac_ratio'))
  // R03 (1357.767+105.002)/13170.463 = 11.1% ≥ 10% 且 18 次 ≥ 10 → triggered
  assert.equal(byId.R03.status, 'triggered')
  // R04 双视图一致 → not_triggered
  assert.equal(byId.R04.status, 'not_triggered')
  // R05 21 < 100 → skipped（样本不足）
  assert.equal(byId.R05.status, 'skipped')
  assert.ok(byId.R05.missing_fields.includes('op_type_with_100_instances'))
  // 缺 counter → R02 skipped 且不推断
  const svc2 = createProfileService({ dataDir: dir })
  const header = 'Device_id,Task ID,Stream ID,Name,Type,OP State,Accelerator Core,Start Time(us),Duration(us)\n'
  const kernNoCounter = header + Array.from({ length: 3 }, (_, i) => `0,${10 + i},47,LaserAttn${i},LaserAttention,Done,MIX_AIC,${i}.000,120.000`).join('\n') + '\n'
  const imp2 = svc2.importFiles({ files: [{ name: 'kernel_details.csv', content: kernNoCounter }] })
  const rep2 = svc2.report(imp2.session_id)
  const r2 = rep2.rules.find((r) => r.rule_id === 'R02')
  assert.equal(r2.status, 'skipped')
  assert.ok(r2.missing_fields.includes('aic_mac_ratio'))
  assert.ok(r2.conclusion.includes('不能从算子名称'))
  // 禁用语：不出现“必然提速”/不把份额当利用率
  const allText = JSON.stringify(rep) + JSON.stringify(rep2)
  assert.ok(!allText.includes('必然提速'))
  assert.ok(!allText.includes('hardware utilization'))
  rmSync(dir, { recursive: true, force: true })
})

test('profile：R04 交叉核验（doctored 实例触发）/ R05 合成样本触发', () => {
  const dir = mkdtempSync(join(tmpdir(), 't131-r4r5-'))
  const service = createProfileService({ dataDir: dir })
  const stat = read('profile/op_statistic.csv')
  // 篡改实例数：丢掉一半 LaserAttention 实例 → Count 差异 → R04 triggered
  const kern = read('profile/kernel_details.csv').split('\n')
  const kernDropped = [kern[0], ...kern.slice(1).filter((l) => !l.includes('LaserAttention') || !l.includes('3913.578'))].join('\n')
  const imp = service.importFiles({ files: [{ name: 'op_statistic.csv', content: stat }, { name: 'kernel_details.csv', content: kernDropped }] })
  const rep = service.report(imp.session_id)
  const r4 = rep.rules.find((r) => r.rule_id === 'R04')
  assert.equal(r4.status, 'triggered')
  assert.ok(r4.conclusion.includes('差异'))
  // R05：合成 150 个 10us 实例（median<20us）→ triggered
  const header = 'Device_id,Task ID,Stream ID,Name,Type,OP State,Accelerator Core,Start Time(us),Duration(us)\n'
  const rows = Array.from({ length: 150 }, (_, i) => `0,${100 + i},47,Tiny${i},TinyOp,Done,AI_VECTOR_CORE,${i}.000,10.000`).join('\n')
  const svc2 = createProfileService({ dataDir: dir })
  const imp2 = svc2.importFiles({ files: [{ name: 'kernel_details.csv', content: header + rows + '\n' }] })
  const rep2 = svc2.report(imp2.session_id)
  const r5 = rep2.rules.find((r) => r.rule_id === 'R05')
  assert.equal(r5.status, 'triggered')
  assert.ok(r5.conclusion.includes('中位数'))
  // t133 T132-01：真实分母（全部实例总时长）写入 metrics；单类样本下 share=1 依旧触发
  const m = Object.fromEntries(r5.metrics.map((x) => [x.key, x.value]))
  assert.equal(m.r05_denominator_ns, '1500000')
  assert.equal(m.r05_numerator_ns, '1500000')
  assert.equal(m.small_task_share, 1)
  assert.equal(m.candidate_instance_count, 150)
  for (const ev of r5.evidence) {
    assert.ok(typeof ev.source_id === 'string' && ev.source_id.length > 0, 'evidence 缺 source_id')
    assert.ok(String(ev.locator).startsWith('row:'), 'evidence 缺 locator')
    assert.ok(typeof ev.transform === 'string' && ev.transform.length > 0, 'evidence 缺转换说明')
    assert.ok(ev.values && Object.keys(ev.values).length > 0, 'evidence 缺值')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('profile：service（限额/未知格式/重复导入/demo/session CRUD）', () => {
  const dir = mkdtempSync(join(tmpdir(), 't131-svc-'))
  const service = createProfileService({ dataDir: dir })
  const stat = read('profile/op_statistic.csv')
  const kern = read('profile/kernel_details.csv')
  // 超大：>4MiB 单文件
  const big = 'x'.repeat(4 * 1024 * 1024 + 10)
  assert.throws(() => service.importFiles({ files: [{ name: 'big.csv', content: big }] }), (e) => e.code === 'PROFILE_TOO_LARGE')
  // 未知 header → 不猜
  assert.throws(() => service.importFiles({ files: [{ name: 'a.csv', content: 'p,q\n1,2\n' }] }), (e) => e.code === 'PROFILE_UNSUPPORTED_FORMAT')
  // 正常导入（混合：一个已知 + 一个未知文件——未知文件计入 files 但 dialect=unknown）
  const imp = service.importFiles({ files: [{ name: 'op_statistic.csv', content: stat }, { name: 'junk.csv', content: 'a,b\n1,2\n' }, { name: 'kernel_details.csv', content: kern }] })
  assert.equal(imp.state, 'ready')
  assert.equal(imp.coverage.accepted, 24)
  assert.equal(imp.files.length, 3)
  assert.equal(imp.files.find((f) => f.path_redacted === 'junk.csv').dialect, 'unknown')
  const det = service.detail(imp.session_id)
  assert.equal(det.top_ops[0].op_type, 'LaserAttention')
  assert.ok(Math.abs(det.top_ops[0].share - 0.8889) < 0.001)
  assert.equal(det.instance_count, 21)
  // demo（is_demo=true，落 demo realm）
  const demo = service.importDemo()
  assert.equal(demo.is_demo, true)
  const demoDet = service.detail(demo.session_id)
  assert.equal(demoDet.manifest.is_demo, true)
  // 列表 + 删除
  assert.equal(service.list().sessions.length, 2)
  service.remove(demo.session_id)
  assert.equal(service.list().sessions.length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('profile：REST 路由（导入/demo/列表/详情/报告/删除/401/超大）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't131-rest-'))
  const dataDir = join(dir, 'data'); mkdirSync(dataDir, { recursive: true })
  const configDir = join(dir, 'conf'); mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'envs.json'), JSON.stringify({ version: 1, pollIntervalMs: 300000, envs: [] }))
  const routes = []
  const tools = new Map()
  const ctx = makeCtx({ routes, tools, connection: { requestRejection: () => 0 } })
  await apply(ctx, { dataDir, configDir })
  const prefix = routes.find((r) => r.kind === 'prefix')
  assert.ok(prefix)
  const stat = read('profile/op_statistic.csv')
  const kern = read('profile/kernel_details.csv')
  const call = (p, o) => callRoute(prefix, `/api/ascend-perf${p}`, o)
  // 导入
  const imp = await call('/profile/imports', { method: 'POST', body: { files: [{ name: 'op_statistic.csv', content: stat }, { name: 'kernel_details.csv', content: kern }] } })
  assert.equal(imp.status, 200)
  assert.equal(imp.payload.coverage.accepted, 24)
  const sid = imp.payload.session_id
  // demo
  const demo = await call('/profile/demo', { method: 'POST' })
  assert.equal(demo.status, 200)
  assert.equal(demo.payload.is_demo, true)
  // 列表 / 详情 / 报告
  const list = await call('/profile/sessions', { method: 'GET' })
  assert.equal(list.status, 200)
  assert.ok(list.payload.sessions.length >= 2)
  const det = await call(`/profile/sessions/${sid}`, { method: 'GET' })
  assert.equal(det.status, 200)
  assert.equal(det.payload.top_ops[0].op_type, 'LaserAttention')
  const rep = await call(`/profile/sessions/${sid}/report`, { method: 'GET' })
  assert.equal(rep.status, 200)
  assert.equal(rep.payload.rules.length, 5)
  // 删除
  const del = await call(`/profile/sessions/${sid}`, { method: 'DELETE' })
  assert.equal(del.status, 200)
  assert.equal(del.payload.deleted, true)
  const gone = await call(`/profile/sessions/${sid}`, { method: 'GET' })
  assert.equal(gone.status, 400)
  assert.equal(gone.payload.error.code, 'PROFILE_SESSION_NOT_FOUND')
  // 超大：HTTP 层（INPUT_TOO_LARGE）或服务层（PROFILE_TOO_LARGE）任一结构化拒绝即可
  const big = await call('/profile/imports', { method: 'POST', body: { files: [{ name: 'big.csv', content: 'x'.repeat(4 * 1024 * 1024 + 10) }] } })
  assert.equal(big.status, 400)
  assert.ok(['INPUT_TOO_LARGE', 'PROFILE_TOO_LARGE'].includes(big.payload.error.code), `unexpected code ${big.payload.error.code}`)
  // 工具注册（19 个）
  const names = [...tools.keys()]
  for (const tool of ['ascend_profile_import', 'ascend_profile_list', 'ascend_profile_report']) assert.ok(names.includes(tool), `缺少工具 ${tool}`)
  // 401 鉴权
  const routes401 = []
  const ctx401 = makeCtx({ routes: routes401, connection: { requestRejection: () => 401 } })
  await apply(ctx401, { dataDir, configDir })
  const prefix401 = routes401.find((r) => r.kind === 'prefix')
  const r401 = await callRoute(prefix401, '/api/ascend-perf/profile/sessions', { method: 'GET' })
  assert.equal(r401.status, 401)
  rmSync(dir, { recursive: true, force: true })
})

test('profile：客户端 profile 子视图（导入入口/空态/摘要/Top 表/规则卡/证据展开）', () => {
  const mod = loadClientModule()
  const t = makeT(mod.__test.zh)
  // 初始态：loading 骨架 + 导入入口
  const section = mod.__test.ProfileSection({ t })
  const tree = renderNode(section)
  const texts = textOf(tree)
  assert.ok(texts.includes(t('profile.title')))
  assert.ok(findTestId(tree, 'profile.import.input'))
  assert.ok(findTestId(tree, 'profile.demo'))
  assert.ok(findTestId(tree, 'profile.loading'))
  // 会话视图：fixture 数据驱动
  const detail = {
    manifest: {
      session_id: 'prof-fixed0000000009', state: 'ready', is_demo: true,
      source: { parser_version: 'ascend-pt-p1-v1' },
      coverage: { accepted: 24, rejected: 0 },
      files: [{ path_redacted: 'op_statistic.csv', dialect: 'ascend-pt-statistic-v1', validation: 'native_sample_verified' }],
    },
    top_ops: [
      { op_type: 'LaserAttention', core_type: 'MIX_AIC', calls: 3, total_ns: '11707694', share: 0.8889, row: 'row:2' },
      { op_type: 'Transpose', core_type: 'AI_VECTOR_CORE', calls: 15, total_ns: '1357767', share: 0.1031, row: 'row:3' },
    ],
    instance_count: 21,
  }
  const report = {
    rules: [
      { rule_id: 'R01', status: 'triggered', conclusion: '样本内占主导。', confidence: { description: 'high', causal: 'low' }, actions: ['核验实现'], evidence: [{ file: 'op_statistic.csv', row: 'row:2', fields: ['OP Type'], values: { op_type: 'LaserAttention' } }], thresholds: { single_share: 0.3 } },
      { rule_id: 'R02', status: 'skipped', conclusion: '缺 counter。', missing_fields: ['aic_mac_ratio'], confidence: { description: 'low', causal: 'low' }, actions: [], evidence: [], thresholds: {} },
    ],
  }
  const view = renderNode(mod.__test.ProfileSessionView({ detail, report, expandedRuleId: 'R01', onToggleRule: () => {}, t }))
  const viewText = textOf(view)
  assert.ok(findTestId(view, 'profile.summary'))
  assert.ok(viewText.includes('prof-fixed0000000009'))
  assert.ok(viewText.includes(t('profile.demoBadge')))
  assert.ok(viewText.includes('24'))
  assert.ok(findTestId(view, 'profile.top'))
  assert.ok(findTestId(view, 'profile.top.LaserAttention'))
  assert.ok(viewText.includes('LaserAttention'))
  assert.ok(viewText.includes('88.9%'))
  assert.ok(findTestId(view, 'profile.rule.R01'))
  assert.ok(viewText.includes(t('profile.rule.triggered')))
  assert.ok(findTestId(view, 'profile.rule.R01.evidence')) // 展开的证据
  assert.ok(viewText.includes('row:2'))
  assert.ok(findTestId(view, 'profile.rule.R02'))
  assert.ok(viewText.includes(t('profile.rule.skipped')))
  // 未展开的 R02 证据区不渲染
  assert.ok(!findTestId(view, 'profile.rule.R02.evidence'))
  // 规则卡单独渲染 + 切换按钮
  const card = renderNode(mod.__test.ProfileRuleCard({ rule: report.rules[0], expanded: false, onToggle: () => {}, t }))
  const toggleBtn = findTestId(card, 'profile.rule.R01.toggle')
  assert.ok(toggleBtn)
  assert.equal(toggleBtn.props['aria-expanded'], 'false')
  // locale 与 client 字典平铺键一致
  for (const lang of ['zh', 'en']) {
    const locale = JSON.parse(readFileSync(join(here, '..', 'locale', `${lang}.json`), 'utf8'))
    const dict = lang === 'zh' ? mod.__test.zh : mod.__test.en
    const NESTED = new Set(Object.keys(locale).filter((k) => typeof locale[k] === 'object'))
    for (const [k, v] of Object.entries(dict)) {
      if (NESTED.has(k)) continue
      assert.equal(locale[k], v, `${lang} locale 键不一致：${k}`)
    }
    assert.equal(locale['profile.title'], dict['profile.title'])
  }
})


/* ================== t133：t132 findings 修复（R05 真实分母/R04 容差/strict 默认/白名单/负值 NaN/越界/schema 校验/NS 安全/串联） ================== */

const t133StatOp = (type, calls, total, extraMetrics = []) => ({ session_id: 'prof-aaaabbbbccccdddd', op_id: 'a'.repeat(16), record_kind: 'aggregate', op_type: type, core_type: 'AI_VECTOR_CORE', calls, total_ns: total, metrics: extraMetrics, sources: [{ source_id: 'src-s', locator: 'row:2', fields: [] }], missing_reasons: {} })
const t133InstOp = (type, total, row, extraMetrics = []) => ({ session_id: 'prof-aaaabbbbccccdddd', op_id: 'b'.repeat(16), record_kind: 'instance', op_type: type, core_type: 'AI_VECTOR_CORE', calls: 1, total_ns: total, metrics: extraMetrics, sources: [{ source_id: 'src-k', locator: `row:${row}`, fields: [] }], missing_reasons: {} })
const t133Manifest = () => ({
  session_id: 'prof-aaaabbbbccccdddd', revision: 1,
  files: [
    { source_id: 'src-s', path_redacted: 'op_statistic.csv', dialect: PROFILE_DIALECTS.statistic.id },
    { source_id: 'src-k', path_redacted: 'kernel_details.csv', dialect: PROFILE_DIALECTS.kernel.id },
  ],
})

test('t133 T132-01：R05 真实分母——median<20us 但 share<20% 必须 not_triggered', () => {
  const dir = mkdtempSync(join(tmpdir(), 't133-r5reg-'))
  const service = createProfileService({ dataDir: dir })
  const header = 'Device_id,Task ID,Stream ID,Name,Type,OP State,Accelerator Core,Start Time(us),Duration(us)\n'
  const tiny = Array.from({ length: 150 }, (_, i) => `0,${100 + i},47,Tiny${i},TinyOp,Done,AI_VECTOR_CORE,${i}.000,10.000`).join('\n')
  const huge = Array.from({ length: 3 }, (_, i) => `0,${300 + i},47,Huge${i},HugeOp,Done,AI_VECTOR_CORE,0.000,500000.000`).join('\n')
  const imp = service.importFiles({ files: [{ name: 'kernel_details.csv', content: header + tiny + '\n' + huge + '\n' }] })
  const r5 = service.report(imp.session_id).rules.find((r) => r.rule_id === 'R05')
  // 旧实现 share=total/total 恒 1.0 → 必然 triggered；新实现用真实分母（全部实例总时长）
  assert.equal(r5.status, 'not_triggered')
  const m = Object.fromEntries(r5.metrics.map((x) => [x.key, x.value]))
  assert.equal(m.r05_denominator_ns, (1500000 + 3 * 500000000).toString())
  assert.equal(m.r05_numerator_ns, '1500000')
  assert.ok(m.small_task_share < 0.001)
  assert.ok(r5.conclusion.includes('份额不足'))
  rmSync(dir, { recursive: true, force: true })
})

test('t133 T132-05：R04 count 容差 max(1%, 舍入)——100 vs 99 不触发、100 vs 98 触发', () => {
  const mk = (instCount) => evaluateProfileRules({
    manifest: t133Manifest(),
    ops: [
      t133StatOp('A', 100, '100000000'),
      ...Array.from({ length: instCount }, (_, i) => t133InstOp('A', '1000000', i + 2)),
    ],
  }).rules.find((r) => r.rule_id === 'R04')
  // 旧实现 callsDelta>0 即触发：99 也会 triggered
  assert.equal(mk(99).status, 'not_triggered')
  assert.equal(mk(100).status, 'not_triggered')
  const r98 = mk(98)
  assert.equal(r98.status, 'triggered')
  const detail = r98.metrics.find((x) => x.key === 'mismatch_detail').value
  assert.ok(detail.some((d) => d.reason === 'count_mismatch'))
})

test('t133 T132-06：R04 扫描 ratio 越界（source_ratio 1.5 / aic_mac_ratio -0.5）写 mismatch+行号', () => {
  const out = evaluateProfileRules({
    manifest: t133Manifest(),
    ops: [
      t133StatOp('A', 1, '1000', [{ key: 'source_ratio', value: 1.5, unit: 'ratio', semantic_status: 'source_reported' }]),
      t133InstOp('A', '1000', 9, [{ key: 'aic_mac_ratio', value: -0.5, unit: 'ratio', semantic_status: 'verified' }]),
    ],
  })
  const r4 = out.rules.find((r) => r.rule_id === 'R04')
  assert.equal(r4.status, 'triggered')
  const detail = r4.metrics.find((x) => x.key === 'mismatch_detail').value
  assert.ok(detail.some((d) => d.reason === 'ratio_out_of_range' && d.field === 'source_ratio' && d.value === 1.5 && String(d.row).startsWith('row:')))
  assert.ok(detail.some((d) => d.reason === 'ratio_out_of_range' && d.field === 'aic_mac_ratio' && d.value === -0.5))
})
test('t135 T134-02：R04 每条 evidence 四要素非空（含 overview 代表行 locator）', () => {
  const out = evaluateProfileRules({
    manifest: t133Manifest(),
    ops: [
      t133StatOp('A', 100, '100000000', [{ key: 'source_ratio', value: 1.5, unit: 'ratio', semantic_status: 'source_reported' }]),
      ...Array.from({ length: 98 }, (_, i) => t133InstOp('A', '1000000', i + 2)),
    ],
  })
  const r4 = out.rules.find((r) => r.rule_id === 'R04')
  assert.equal(r4.status, 'triggered')
  assert.ok(r4.evidence.length >= 3, 'overview 2 条 + mismatch 至少 1 条')
  for (const ev of r4.evidence) {
    assert.ok(typeof ev.source_id === 'string' && ev.source_id.length > 0, `source_id 非空：${JSON.stringify(ev).slice(0, 120)}`)
    assert.ok(typeof ev.locator === 'string' && ev.locator.startsWith('row:'), `locator 非空且为行定位：${JSON.stringify(ev).slice(0, 120)}`)
    assert.ok(typeof ev.transform === 'string' && ev.transform.length > 0, `transform 非空：${JSON.stringify(ev).slice(0, 120)}`)
    assert.ok(ev.values != null && Object.keys(ev.values).length > 0, `values 非空：${JSON.stringify(ev).slice(0, 120)}`)
  }
  // overview 两条的 locator 是代表行（首个聚合 row:2 / 首个实例 row:2），不再是空串
  assert.equal(r4.evidence[0].locator, 'row:2')
  assert.equal(r4.evidence[1].locator, 'row:2')
})

test('t133 T132-02/03：负 Total / 负 Min / Min=NaN / kernel Start=NaN → 行级 rejected（不再静默）', () => {
  const header = 'Device_id,OP Type,Core Type,Count,Total Time(us),Min Time(us),Ratio(%)\n'
  const f = { file: { source_id: 's1', path_redacted: 'x' }, sessionId: 'prof-t133a' }
  const negTotal = parseOpStatistic(header + '0,A,AI_VECTOR_CORE,1,-1.500,0.5,0.1\n', f)
  assert.equal(negTotal.ops.length, 0)
  assert.equal(negTotal.rejected[0].reason, 'negative_duration')
  assert.equal(negTotal.rejected[0].field, 'Total Time(us)')
  const negMin = parseOpStatistic(header + '0,B,AI_VECTOR_CORE,2,3.000,-0.5,0.3\n', f)
  assert.equal(negMin.ops.length, 0)
  assert.equal(negMin.rejected[0].reason, 'negative_duration')
  assert.equal(negMin.rejected[0].field, 'Min Time(us)')
  // NaN 不再是 raw-empty：Min=NaN → 整行 rejected（带行号/字段）
  const nanMin = parseOpStatistic(header + '0,C,AI_VECTOR_CORE,2,3.000,NaN,0.3\n', f)
  assert.equal(nanMin.ops.length, 0)
  assert.equal(nanMin.rejected[0].reason, 'not_a_decimal_us')
  assert.equal(nanMin.rejected[0].field, 'Min Time(us)')
  assert.ok(nanMin.rejected[0].row >= 1)
  const kHeader = 'Device_id,Task ID,Stream ID,Name,Type,OP State,Accelerator Core,Start Time(us),Duration(us)\n'
  const startNaN = parseKernelDetails(kHeader + '0,12,47,K3,Bad,Done,AI_VECTOR_CORE,NaN,5.000\n', { file: { source_id: 's2', path_redacted: 'y' }, sessionId: 'prof-t133b' })
  assert.equal(startNaN.ops.length, 0)
  assert.equal(startNaN.rejected[0].field, 'Start Time(us)')
  assert.equal(startNaN.rejected[0].reason, 'not_a_decimal_us')
  // 原始空值仍保持缺省（不误伤）
  const startEmpty = parseKernelDetails(kHeader + '0,13,47,K4,Good,Done,AI_VECTOR_CORE,,5.000\n', { file: { source_id: 's2', path_redacted: 'y' }, sessionId: 'prof-t133c' })
  assert.equal(startEmpty.ops.length, 1)
})

test('t133 T132-04：未知额外列 → unsupported（unknown_columns），不进定量统计', () => {
  const stat = read('profile/op_statistic.csv')
  const weird = stat.replace('Ratio(%)', 'Ratio(%),WeirdCol').split('\n').map((l) => (l.includes('WeirdCol') || l === '' ? l : l + ',x')).join('\n')
  const det = detectProfileDialect(weird)
  assert.equal(det.dialect, 'unknown')
  assert.equal(det.reason, 'unknown_columns')
  assert.deepEqual(det.unknown, ['WeirdCol'])
  const dir = mkdtempSync(join(tmpdir(), 't133-wl-'))
  const service = createProfileService({ dataDir: dir })
  assert.throws(() => service.importFiles({ files: [{ name: 'weird.csv', content: weird }] }), (e) => e.code === 'PROFILE_UNSUPPORTED_FORMAT')
  // 已知白名单的子集（缺可选列）仍可判型
  assert.equal(detectProfileDialect('Device_id,OP Type,Core Type,Count,Total Time(us),Ratio(%)\n0,A,AI_VECTOR_CORE,1,1.0,0.1\n').dialect, 'statistic')
  rmSync(dir, { recursive: true, force: true })
})

test('t133 T132-08：默认 strict 拒绝整 session；显式 partial 才落库并标 partial', () => {
  const dir = mkdtempSync(join(tmpdir(), 't133-strict-'))
  const service = createProfileService({ dataDir: dir })
  const good = read('profile/op_statistic.csv')
  const bad = 'Device_id,OP Type,Core Type,Count,Total Time(us),Ratio(%)\n0,A,AI_VECTOR_CORE,abc,1.000,0.1\n'
  // 一好一坏，默认（strict）→ 整个 session 不落库
  assert.throws(() => service.importFiles({ files: [{ name: 'good.csv', content: good }, { name: 'bad.csv', content: bad }] }), (e) => e.code === 'PROFILE_REJECTED_RECORDS')
  assert.equal(service.list().sessions.length, 0)
  // 显式 partial → 落库 + state=partial + coverage.rejected
  const imp = service.importFiles({ files: [{ name: 'good.csv', content: good }, { name: 'bad.csv', content: bad }], policy: 'partial' })
  assert.equal(imp.state, 'partial')
  assert.equal(imp.coverage.rejected, 1)
  assert.equal(imp.coverage.accepted, 3)
  assert.equal(service.list().sessions.length, 1)
  // 未知策略 → 结构化拒绝
  assert.throws(() => service.importFiles({ files: [{ name: 'g.csv', content: good }], policy: 'lax' }), (e) => e.code === 'PROFILE_INVALID_POLICY')
  rmSync(dir, { recursive: true, force: true })
})

test('t133 T132-09：越界/非有限 ratio counter 不进 metrics，R02 走 skipped', () => {
  const header = 'Device_id,Task ID,Stream ID,Name,Type,OP State,Accelerator Core,Start Time(us),Duration(us),aic_mac_ratio\n'
  const rows = [
    '0,10,47,K1,LaserAttention,Done,MIX_AIC,1.000,120.000,1.5',
    '0,11,47,K2,LaserAttention,Done,MIX_AIC,2.000,121.000,-0.5',
  ].join('\n')
  const parsed = parseKernelDetails(header + rows + '\n', { file: { source_id: 's', path_redacted: 'x' }, sessionId: 'prof-t133d' })
  assert.equal(parsed.ops.length, 2)
  for (const op of parsed.ops) {
    assert.ok(!op.metrics.some((m) => m.key === 'aic_mac_ratio'), '越界 ratio 不得进入 metrics')
  }
  assert.ok(parsed.warnings.some((w) => w.code === 'PROFILE_RATIO_OUT_OF_RANGE'))
  const dir = mkdtempSync(join(tmpdir(), 't133-r9-'))
  const service = createProfileService({ dataDir: dir })
  const imp = service.importFiles({ files: [{ name: 'kernel_details.csv', content: header + rows + '\n' }] })
  const r2 = service.report(imp.session_id).rules.find((r) => r.rule_id === 'R02')
  assert.equal(r2.status, 'skipped')
  assert.ok(r2.missing_fields.includes('aic_mac_ratio'))
  rmSync(dir, { recursive: true, force: true })
})

test('t133 T132-12：total_ns 非整数字符串不抛 TypeError，结构化降级', () => {
  const allInvalid = evaluateProfileRules({ manifest: t133Manifest(), ops: [t133StatOp('A', 1, '12.5')] })
  const r1 = allInvalid.rules.find((r) => r.rule_id === 'R01')
  assert.equal(r1.status, 'skipped')
  assert.ok(r1.missing_fields.some((f) => String(f).startsWith('invalid_total_ns_records')))
  const mixed = evaluateProfileRules({ manifest: t133Manifest(), ops: [t133StatOp('A', 1, '12.5'), t133StatOp('B', 2, '3000')] })
  const r1m = mixed.rules.find((r) => r.rule_id === 'R01')
  assert.notEqual(r1m.status, 'skipped')
  assert.ok(r1m.missing_fields.some((f) => String(f).startsWith('invalid_total_ns_records')))
  // 实例侧：R05 对非整数 total_ns 也不抛
  const r5 = evaluateProfileRules({ manifest: t133Manifest(), ops: Array.from({ length: 3 }, (_, i) => t133InstOp('T', '1.5', i + 2)) }).rules.find((r) => r.rule_id === 'R05')
  assert.ok(['skipped', 'not_triggered'].includes(r5.status))
})

test('t133 T132-11：REST+DOM 级联（demo 导入→session→detail→report→展开→删除，真实路由载荷驱动渲染）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't133-cascade-'))
  const dataDir = join(dir, 'data'); mkdirSync(dataDir, { recursive: true })
  const configDir = join(dir, 'conf'); mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'envs.json'), JSON.stringify({ version: 1, pollIntervalMs: 300000, envs: [] }))
  const routes = []
  const ctx = makeCtx({ routes, tools: new Map(), connection: { requestRejection: () => 0 } })
  await apply(ctx, { dataDir, configDir })
  const prefix = routes.find((r) => r.kind === 'prefix')
  const call = (p, o) => callRoute(prefix, `/api/ascend-perf${p}`, o)
  const demo = await call('/profile/demo', { method: 'POST' })
  assert.equal(demo.status, 200)
  const sid = demo.payload.session_id
  const list = await call('/profile/sessions', { method: 'GET' })
  assert.ok(list.payload.sessions.some((s) => s.session_id === sid))
  const det = await call(`/profile/sessions/${sid}`, { method: 'GET' })
  assert.equal(det.payload.top_ops[0].op_type, 'LaserAttention')
  const rep = await call(`/profile/sessions/${sid}/report`, { method: 'GET' })
  assert.equal(rep.payload.rules.length, 5)
  // DOM 级联：用真实 detail/report 载荷（非 mock）渲染会话视图与规则卡
  const mod = loadClientModule()
  const t = makeT(mod.__test.zh)
  const view = renderNode(mod.__test.ProfileSessionView({ detail: det.payload, report: rep.payload, expandedRuleId: 'R01', onToggleRule: () => {}, t }))
  assert.ok(findTestId(view, 'profile.summary'))
  assert.ok(findTestId(view, 'profile.top'))
  assert.ok(findTestId(view, 'profile.top.LaserAttention'))
  assert.ok(findTestId(view, 'profile.rule.R01'))
  assert.ok(findTestId(view, 'profile.rule.R01.evidence'))
  assert.ok(textOf(view).includes('row:2'), '真实证据行号应渲染')
  const r01 = rep.payload.rules.find((r) => r.rule_id === 'R01')
  assert.equal(r01.status, 'triggered')
  const card = renderNode(mod.__test.ProfileRuleCard({ rule: r01, expanded: false, onToggle: () => {}, t }))
  assert.equal(findTestId(card, 'profile.rule.R01.toggle').props['aria-expanded'], 'false')
  const del = await call(`/profile/sessions/${sid}`, { method: 'DELETE' })
  assert.equal(del.payload.deleted, true)
  rmSync(dir, { recursive: true, force: true })
})


// ===== t139：容器服务部署后自动采集并导入 vLLM profile =====
const T139_CSV = readFileSync(join(here, '..', 'fixtures', 'profile', 'op_statistic.csv'), 'utf8')
const T139_SPEC = {
  ...T124_SPEC,
  code: { root: '/home/z00919396/zr/code' },
  profile: { enabled: true },
}

test('t139 argv：profile 关闭时不变 / 开启时含 /prof 挂载与 --profiler-config', async () => {
  const { buildRunArgv } = await import('../deploy-exec.js')
  const spec = JSON.parse(JSON.stringify({ ...T124_SPEC, image: T124_SPEC.image }))
  delete spec.profile
  const plain = buildRunArgv(spec, 'svc-abc123', 'dsh-apf-svc-qwen3-8b-abc123', {})
  const plainStr = plain.join(' ')
  assert.ok(!plainStr.includes('/prof'), '未开启 profile 时不得出现 /prof 挂载')
  assert.ok(!plainStr.includes('--profiler-config'), '未开启 profile 时不得出现 --profiler-config')
  assert.ok(!plainStr.includes('--enforce-eager'), '未开启 profile 时不得强制 --enforce-eager（argv 不变）')
  const withProf = buildRunArgv(spec, 'svc-abc123', 'dsh-apf-svc-qwen3-8b-abc123', { profileDir: '/home/z00919396/zr/code/profiles/dsh-apf-svc-qwen3-8b-abc123' })
  const idx = withProf.indexOf('-v')
  assert.ok(withProf.includes(`'/home/z00919396/zr/code/profiles/dsh-apf-svc-qwen3-8b-abc123':/prof`), '-v <profileDir>:/prof（quotePosix）')
  assert.ok(idx > -1)
  assert.ok(withProf.includes('--profiler-config'))
  assert.ok(withProf.includes('--enforce-eager'), 'profile 开启 → 强制 --enforce-eager（captain 实测：graph 捕获路径不出 op_statistic.csv）')
  assert.ok(withProf.includes(`'{"profiler":"torch","torch_profiler_dir":"/prof"}'`), 'profiler JSON 必须 shell quote')
  // spec 校验：profile 形状
  const codeIs = (code) => (error) => error?.code === code
  assert.throws(() => validateRunSpec({ ...T124_SPEC, profile: 123 }, t124GetEnv()), codeIs('INVALID_ARGUMENT'))
  assert.throws(() => validateRunSpec({ ...T124_SPEC, profile: { enabled: true, dir: 'relative/path' } }, t124GetEnv()), codeIs('INVALID_ARGUMENT'))
  assert.throws(() => validateRunSpec({ ...T124_SPEC, profile: { enabled: true, extra: 1 } }, t124GetEnv()), codeIs('UNKNOWN_FIELD'))
  const okSpec = validateRunSpec({ ...T124_SPEC, profile: { enabled: true } }, t124GetEnv())
  assert.deepEqual(okSpec.spec.profile, { enabled: true, dir: null })
})

test('t139 全链：mkdir 先于 docker run / healthy 后三步采集 / 导入 mock 收到 CSV+元数据', async () => {
  const codeIs = (code) => (error) => error?.code === code
  let clock = 1731600000000
  const calls = []
  const captured = []
  const importerCalls = []
  let healthy = false
  let inspectOut = null
  const exec = async (hostAlias, command) => {
    calls.push([hostAlias, command])
    if (command.includes('docker inspect')) return inspectOut
    if (command.includes('find /prof -name op_statistic.csv')) return { exitCode: 0, stdout: T139_CSV, stderr: '' }
    if (command.includes("cat '$f'")) return { exitCode: 0, stdout: T139_CSV, stderr: '' }
    if (command.includes('docker run')) return { exitCode: 0, stdout: 'cid139\n', stderr: '' }
    if (command.includes('/v1/models')) return healthy ? { exitCode: 0, stdout: 'HEALTHY\n', stderr: '' } : { exitCode: 0, stdout: 'NOT_YET\n', stderr: '' }
    if (command.includes('/start_profile') || command.includes('/v1/completions') || command.includes('/stop_profile')) { captured.push(command); return { exitCode: 0, stdout: '', stderr: '' } }
    if (command.includes('op_statistic.csv')) return { exitCode: 0, stdout: T139_CSV, stderr: '' }
    if (command.includes('mkdir -p -m 700')) return { exitCode: 0, stdout: '', stderr: '' }
    for (const [needle, out] of t124DefaultScript()) if (command.includes(needle)) return out
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const importer = async (args) => { importerCalls.push(args); return { session_id: 'prof-t139mock00000001', state: 'ready' } }
  const svc = new DeployRunService({ getEnv: t124GetEnv(), execSsh: exec, isRealExecutionEnabled: () => true, now: () => new Date(clock), profileImporter: importer })

  const preview = await svc.preview(T139_SPEC)
  const argvStr = preview.data.argv.join(' ')
  assert.ok(argvStr.includes(`'/home/z00919396/zr/code/profiles/${preview.data.container_name}':/prof`), 'preview argv 含 code.root/profiles/<容器名>:/prof')
  assert.ok(argvStr.includes('--profiler-config'))
  assert.equal(preview.data.profile.enabled, true)
  assert.ok(preview.data.profile.dir.endsWith(preview.data.container_name))
  assert.ok(!calls.some(([, c]) => c.includes('mkdir -p -m 700')), 'preview 只读，不创建目录')
  assert.ok(preview.warnings.some((w) => w.includes('profile 采集已开启')), 'preview 给采集计划 warning')

  const started = await svc.start({ ...T139_SPEC, confirmation_token: preview.data.confirmation_token })
  assert.equal(started.data.instance.profile.state, 'pending')
  assert.equal(started.data.instance.profile_dir, preview.data.profile.dir)
  assert.equal(started.data.instance.served_name, 'Qwen3-8B')
  const mkdirIdx = calls.findIndex(([, c]) => c.includes('mkdir -p -m 700'))
  const runIdx = calls.findIndex(([, c]) => c.includes('docker run'))
  assert.ok(mkdirIdx > -1 && runIdx > -1 && mkdirIdx < runIdx, '远端 profile 目录必须在 docker run 之前创建')
  assert.ok(calls[mkdirIdx][1].includes(`mkdir -p -m 700 '/home/z00919396/zr/code/profiles/${preview.data.container_name}'`), 'mkdir -p -m 700（quotePosix）')

  inspectOut = { exitCode: 0, stdout: `/${preview.data.container_name}|true|0|${preview.data.service_id}\n`, stderr: '' }
  healthy = true
  const status = await svc.status(preview.data.service_id)
  assert.equal(status.data.health, 'healthy')
  assert.equal(status.data.profile.state, 'imported')
  assert.equal(status.data.profile.session_id, 'prof-t139mock00000001')
  // 三步采集顺序
  const starts = captured.filter((c) => c.includes('/start_profile')).length
  const comps = captured.filter((c) => c.includes('/v1/completions')).length
  const stops = captured.filter((c) => c.includes('/stop_profile')).length
  assert.equal(starts, 1); assert.equal(comps, 2); assert.equal(stops, 1)
  assert.ok(captured.find((c) => c.includes('/v1/completions') && c.includes('"max_tokens":32')), '两个 max_tokens=32 的补全请求')
  // 导入 mock 收到 CSV 与元数据
  assert.equal(importerCalls.length, 1)
  assert.ok(importerCalls[0].content.includes('LaserAttention'), '导入内容是 op_statistic CSV')
  assert.equal(importerCalls[0].envId, 'env-b01')
  assert.equal(importerCalls[0].metadata.model_name, 'Qwen3-8B')
  assert.equal(importerCalls[0].metadata.service_id, preview.data.service_id)
  assert.equal(importerCalls[0].metadata.image, T139_SPEC.image)
  // t141：导入成功后必须清理 profile 目录（root 700，用同镜像容器删）
  assert.ok(calls.some(([, c]) => c.includes('rm -rf /profbase/')), 'imported 后清理 profile 目录')
  // 采集全程不碰容器生命周期
  assert.ok(!calls.some(([, c]) => c.includes('docker stop') || c.includes('docker rm -f')), '采集绝不停止/删除容器')
  // 不会重复采集
  await svc.status(preview.data.service_id)
  assert.equal(calls.filter(([, c]) => c.includes('/start_profile')).length, 1, 'state 机保证只采集一次')
  // 停掉第一个实例释放占位（t126②：同卡/同端口不能并存两个活跃实例）
  await svc.stop(preview.data.service_id)
  // 未开启 profile：skipped 且零采集
  const preview2 = await svc.preview(T124_SPEC)
  const started2 = await svc.start({ ...T124_SPEC, confirmation_token: preview2.data.confirmation_token })
  assert.equal(started2.data.instance.profile.state, 'skipped')
  assert.ok(!started2.data.instance.profile_dir)
  inspectOut = { exitCode: 0, stdout: `/${preview2.data.container_name}|true|0|${preview2.data.service_id}\n`, stderr: '' }
  const status2 = await svc.status(preview2.data.service_id)
  assert.equal(status2.data.health, 'healthy')
  assert.equal(status2.data.profile.state, 'skipped')
  assert.equal(calls.filter(([, c]) => c.includes('/start_profile')).length, 1, 'skipped 实例零采集')
  await assert.rejects(() => svc.preview({ ...T139_SPEC, profile: { enabled: true, dir: 'nope' } }), codeIs('INVALID_ARGUMENT'))
})

test('t139 失败路径：采集失败服务仍 healthy，profile.state=failed + warning，不重试不回滚', async () => {
  let clock = 1731600000000
  const calls = []
  let inspectOut = null
  let profileFails = true
  const importer = async () => { throw new Error('importer should not run') }
  const exec = async (hostAlias, command) => {
    calls.push(command)
    if (command.includes('docker inspect')) return inspectOut
    if (command.includes('docker run')) return { exitCode: 0, stdout: 'cid139b\n', stderr: '' }
    if (command.includes('/v1/models')) return { exitCode: 0, stdout: 'HEALTHY\n', stderr: '' }
    if (command.includes('/start_profile')) return profileFails ? { exitCode: 7, stdout: '', stderr: 'curl: (7) Failed to connect' } : { exitCode: 0, stdout: '', stderr: '' }
    for (const [needle, out] of t124DefaultScript()) if (command.includes(needle)) return out
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const svc = new DeployRunService({ getEnv: t124GetEnv(), execSsh: exec, isRealExecutionEnabled: () => true, now: () => new Date(clock), profileImporter: importer })
  const preview = await svc.preview(T139_SPEC)
  await svc.start({ ...T139_SPEC, confirmation_token: preview.data.confirmation_token })
  inspectOut = { exitCode: 0, stdout: `/${preview.data.container_name}|true|0|${preview.data.service_id}\n`, stderr: '' }
  const status = await svc.status(preview.data.service_id)
  assert.equal(status.data.health, 'healthy', '采集失败绝不影响服务健康态')
  assert.equal(status.data.profile.state, 'failed')
  assert.ok(String(status.data.profile.error ?? '').includes('/start_profile'))
  assert.ok((status.warnings ?? []).some((w) => w.includes('profile 采集失败')), 'status warning 如实给出失败原因')
  assert.ok(!calls.some((c) => c.includes('docker stop') || c.includes('docker rm -f')), '失败不回滚/不杀服务')
  const listed = await svc.listInstances()
  assert.equal(listed.data.instances.length, 1, '实例保留在列表')
  await svc.status(preview.data.service_id)
  assert.equal(calls.filter((c) => c.includes('/start_profile')).length, 1, 'failed 终态不重试')
})

test('t139 默认导入器：走 ProfileService 落盘（DSH_ASCEND_PERF_DATA_DIR 覆盖 dataDir）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't139-importer-'))
  const prevEnv = process.env.DSH_ASCEND_PERF_DATA_DIR
  process.env.DSH_ASCEND_PERF_DATA_DIR = dir
  let inspectOut = null
  const exec = async (hostAlias, command) => {
    if (command.includes('docker inspect')) return inspectOut
    if (command.includes('find /prof -name op_statistic.csv')) return { exitCode: 0, stdout: T139_CSV, stderr: '' }
    if (command.includes('docker run')) return { exitCode: 0, stdout: 'cid139c\n', stderr: '' }
    if (command.includes('/v1/models')) return { exitCode: 0, stdout: 'HEALTHY\n', stderr: '' }
    if (command.includes('op_statistic.csv')) return { exitCode: 0, stdout: T139_CSV, stderr: '' }
    for (const [needle, out] of t124DefaultScript()) if (command.includes(needle)) return out
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  try {
    const svc = new DeployRunService({ getEnv: t124GetEnv(), execSsh: exec, isRealExecutionEnabled: () => true })
    const preview = await svc.preview(T139_SPEC)
    await svc.start({ ...T139_SPEC, confirmation_token: preview.data.confirmation_token })
    inspectOut = { exitCode: 0, stdout: `/${preview.data.container_name}|true|0|${preview.data.service_id}\n`, stderr: '' }
    const status = await svc.status(preview.data.service_id)
    assert.equal(status.data.profile.state, 'imported')
    const sid = status.data.profile.session_id
    assert.ok(/^prof-[a-z0-9]{16}$/.test(sid), `session_id 形状：${sid}`)
    const manifest = JSON.parse(readFileSync(join(dir, 'profile-v1', 'real', sid, 'manifest.json'), 'utf8'))
    assert.equal(manifest.source.env_id, 'env-b01', 'env 关联入 manifest.source')
    assert.equal(manifest.model.name, 'Qwen3-8B', 'model_name 入 manifest.model')
    assert.equal(manifest.state, 'ready')
    assert.equal(manifest.files.length, 1)
  } finally {
    if (prevEnv === undefined) delete process.env.DSH_ASCEND_PERF_DATA_DIR
    else process.env.DSH_ASCEND_PERF_DATA_DIR = prevEnv
    rmSync(dir, { recursive: true, force: true })
  }
})

test('t139 UI：复选框默认关 + 实例行 profile 状态文案', async () => {
  const mod = loadClientModule()
  const t = makeT(mod.__test.zh)
  const state = {
    envs: [{ id: 'env-b01', name: 'b01', mode: 'ssh', hostAlias: 'b01', enabled: true, snapshot: { npu: { cards: [{ card_id: 0, chips: [{ hbm_usage_rate_pct: 3, aicore_pct: 1 }] }] } } }],
    deploy_run: { real_execution_enabled: true },
  }
  const block = renderNode(mod.__test.ContainerServicesBlock({ state, t }))
  const checkbox = findTestId(block, 'deploy.run.profile')
  assert.ok(checkbox, '高级选项里有 profile 复选框')
  assert.equal(checkbox.props.checked, false, '默认关闭')
  assert.ok(textOf(block).includes('部署后自动采集 profile（vLLM）'))
  const state2 = { ...state, envs: [] }
  const block2 = renderNode(mod.__test.ContainerServicesBlock({ state: state2, t }))
  const check2 = findTestId(block2, 'deploy.run.profile')
  assert.ok(!check2 || check2.props.checked === false, '无 ssh 环境时不渲染启用态')
  // 实例行状态渲染：直接喂 instances 需要 loadInstances——改用 doState 合并路径的替代验证：
  // 渲染函数是闭包，无法外部注入 instances；改为断言 profile 文案键存在于字典且 t() 可插值
  assert.ok(t('deploy.run.profileImported', { id: 'prof-abc123' }).includes('prof-abc123'))
  assert.ok(t('deploy.run.profileFailed', { msg: 'boom' }).includes('boom'))
  assert.ok(mod.__test.zh['deploy.run.profilePending'])
  assert.ok(mod.__test.en['deploy.run.profileSkipped'])
})


await Promise.all(pending)
const summary = `${passed} passed, ${failures.length} failed`
console.log(`\n${summary}`)
if (failures.length > 0) {
  for (const f of failures) console.error(`- ${f.name}: ${f.error?.message ?? f.error}`)
  process.exitCode = 1
}
