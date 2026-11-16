/**
 * msprof profile P1：op_statistic / kernel_details 解析、profile-v1 私有存储与 R01–R05 证据规则。
 *
 * 设计依据 docs/tuning-msprof-design.md（t130）§3.2/§5/§6.2：
 * - 文件判型只认 header 指纹（不靠文件名）；未知 header → unsupported，不猜 schema。
 * - us→ns 用十进制定点换算（不是 Number(x)*1000），超出 ns 精度按四舍五入并保留精度标记。
 * - 原始空值（空串/N/A/-/NULL）只在具体字段处变 null；0 是观测值；NaN/负数/非法 → rejected record。
 * - 聚合视图（op_statistic）与实例视图（kernel_details）分表保存，绝不相加（§5 约束 6）。
 * - R01–R05 输出 evidence（文件/行/字段/值）/conclusion/action/confidence/status；
 *   缺 counter/样本不足 → skipped，禁止从名称推断利用率、禁止输出“必然提速 %”。
 * - 旧 parseMsprofCsv（legacy op_summary 热点路径）在 index.js 原样保留，本模块不触碰。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROFILE_SCHEMA = 'dsh-ascend-perf/profile-v1'
export const PROFILE_SESSION_SCHEMA = 'profile-session-v1'
export const PROFILE_PARSER_VERSION = 'ascend-pt-p1-v1'
export const PROFILE_RULE_VERSION = 'p1-rules-v1'

/** 已验证 dialect：header 指纹（列名集合必须包含全部必需列，允许额外列）。 */
export const PROFILE_DIALECTS = {
  statistic: {
    id: 'ascend-pt-statistic-v1',
    required: ['Device_id', 'OP Type', 'Core Type', 'Count', 'Total Time(us)', 'Ratio(%)'],
    // 已验证列白名单（真实导出表头的超集）：额外未知列 → 该文件 unsupported，不进定量统计。
    known: ['Device_id', 'OP Type', 'Core Type', 'Count', 'Total Time(us)', 'Min Time(us)', 'Avg Time(us)', 'Max Time(us)', 'Ratio(%)'],
  },
  kernel: {
    id: 'ascend-pt-kernel-v1',
    required: ['Device_id', 'Task ID', 'Stream ID', 'Name', 'Type', 'OP State', 'Accelerator Core', 'Start Time(us)', 'Duration(us)'],
    known: ['Device_id', 'Model ID', 'Task ID', 'Stream ID', 'Name', 'Type', 'OP State', 'Accelerator Core', 'Start Time(us)', 'Duration(us)', 'Wait Time(us)', 'Block Num', 'Mix Block Num', 'HF32 Eligible', 'Input Shapes', 'Input Data Types', 'Input Formats', 'Output Shapes', 'Output Data Types', 'Output Formats', 'Context ID', 'aicore_time(us)', 'aic_total_cycles', 'aic_mac_time(us)', 'aic_mac_ratio', 'aic_scalar_time(us)', 'aic_scalar_ratio', 'aic_mte1_time(us)', 'aic_mte1_ratio', 'aic_mte2_time(us)', 'aic_mte2_ratio', 'aic_fixpipe_time(us)', 'aic_fixpipe_ratio', 'aic_icache_miss_rate', 'aiv_time(us)', 'aiv_total_cycles', 'aiv_vec_time(us)', 'aiv_vec_ratio', 'aiv_scalar_time(us)', 'aiv_scalar_ratio', 'aiv_mte2_time(us)', 'aiv_mte2_ratio', 'aiv_mte3_time(us)', 'aiv_mte3_ratio', 'aiv_icache_miss_rate', 'cube_utilization(%)'],
  },
}

/** kernel_details 中会进入 metrics 的 PIPE counter 列（fraction，0..1；本样例无百分号）。 */
const KERNEL_RATIO_COUNTERS = ['aic_mac_ratio', 'aiv_vec_ratio', 'aic_mte1_ratio', 'aic_mte2_ratio', 'aiv_mte2_ratio', 'aiv_mte3_ratio']
/** 时间型 counter 列（us 源单位）。 */
const KERNEL_TIME_COUNTERS = ['aicore_time(us)', 'aiv_time(us)']
/** 上游数学定义未核实，仅 source_reported（§3.2 cube_utilization 行）。 */
const KERNEL_REPORTED_ONLY = ['cube_utilization(%)']
/** E1/E3 已验证 type 分类中的“格式转换”集合（初始启发式，仅 R03 候选筛选）。 */
const CONVERSION_OP_TYPES = ['Transpose', 'Cast']

const RAW_EMPTY = new Set(['', 'N/A', '-', 'NULL', 'null'])

export class ProfileError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.name = 'ProfileError'
    this.code = code
    this.details = details
  }
}

const fail = (code, message, details) => { throw new ProfileError(code, message, details) }
const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const nowIso = () => new Date().toISOString()
const rid = (prefix) => `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 16)}`

/* ------------------------------------------------------------------ */
/* CSV：带引号/内嵌换行的行解析（保留记录行号；表头为第 1 行）           */
/* ------------------------------------------------------------------ */

/**
 * 解析 CSV 文本为记录数组。支持双引号字段（内嵌逗号/换行/""转义）、CRLF、BOM。
 * 返回 { records: string[][], rows: number[] }，rows[i] 为第 i 条记录的行号
 * （无内嵌换行时等于物理行号；有内嵌换行时为该记录起始物理行）。
 */
export function parseCsvRecords(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '')
  const records = []
  const rows = []
  let field = ''
  let record = []
  let inQuotes = false
  let line = 1
  let recordLine = 1
  let started = false
  const pushField = () => { record.push(field); field = '' }
  const pushRecord = () => {
    if (!started && record.length === 1 && record[0] === '') { record = []; return }
    records.push(record)
    rows.push(recordLine)
    record = []
  }
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1 } else { inQuotes = false }
      } else {
        if (ch === '\n') line += 1
        field += ch
      }
      continue
    }
    if (ch === '"') { inQuotes = true; started = true; continue }
    if (ch === ',') { pushField(); started = true; continue }
    if (ch === '\r') {
      if (src[i + 1] === '\n') i += 1
      pushField(); pushRecord(); started = false
      line += 1; recordLine = line
      continue
    }
    if (ch === '\n') {
      pushField(); pushRecord(); started = false
      line += 1; recordLine = line
      continue
    }
    field += ch
    started = true
  }
  if (field !== '' || record.length > 0 || started) { pushField(); pushRecord() }
  return { records, rows }
}

/** 十进制 us 字符串 → ns 十进制整数字符串（定点换算，四舍五入到 ns）。 */
export function usToNsDecimal(raw) {
  const s = String(raw ?? '').trim()
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return { ok: false, reason: 'not_a_decimal' }
  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const [int, frac = ''] = body.split('.')
  if (frac.length <= 3) {
    const ns = BigInt(int + frac.padEnd(3, '0'))
    return { ok: true, ns: (neg ? '-' : '') + ns.toString(), precisionLoss: false }
  }
  const head = frac.slice(0, 3)
  const tail = frac.slice(3)
  let ns = BigInt(int + head)
  if (BigInt(tail[0]) >= 5) ns += 1n
  return { ok: true, ns: (neg ? '-' : '') + ns.toString(), precisionLoss: true, lost: '0.' + tail }
}

const decToNsMetric = (raw, { file, row, field }) => {
  const conv = usToNsDecimal(raw)
  if (!conv.ok) return { ok: false }
  return {
    ok: true,
    value: conv.ns,
    metric: {
      key: field,
      value: conv.ns,
      unit: 'ns',
      semantic_status: 'verified',
      source: { source_id: file.source_id, locator: `row:${row}`, fields: [field] },
    },
    precisionLoss: conv.precisionLoss === true,
  }
}

const parseNonNegativeInt = (raw) => {
  const s = String(raw ?? '').trim()
  if (!/^\d+$/.test(s)) return null
  return Number(s)
}

const parseFiniteFloat = (raw) => {
  const s = String(raw ?? '').trim().replace(/,+$/, '')
  if (!/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return null
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

/* ------------------------------------------------------------------ */
/* 判型：header 指纹（不看文件名）                                      */
/* ------------------------------------------------------------------ */

/**
 * 按 header 指纹识别 dialect。返回 { dialect, header } 或 { dialect: 'unknown', reason }。
 * 空文件 / 只有表头无判型能力 → unknown（结构化错误由调用方决定）。
 */
export function detectProfileDialect(content) {
  const text = String(content ?? '')
  if (text.replace(/^\uFEFF/, '').trim() === '') return { dialect: 'unknown', reason: 'empty_file' }
  const { records } = parseCsvRecords(text)
  if (records.length === 0) return { dialect: 'unknown', reason: 'empty_file' }
  const header = records[0].map((h) => String(h ?? '').trim())
  for (const [key, def] of Object.entries(PROFILE_DIALECTS)) {
    const missing = def.required.filter((col) => !header.includes(col))
    if (missing.length > 0) continue
    const unknownCols = header.filter((col) => !def.known.includes(col))
    if (unknownCols.length > 0) continue
    return { dialect: key, header }
  }
  const knownAny = Object.values(PROFILE_DIALECTS).some((def) => def.required.every((col) => header.includes(col)))
  if (knownAny) {
    const def = Object.values(PROFILE_DIALECTS).find((d) => d.required.every((col) => header.includes(col)))
    return { dialect: 'unknown', reason: 'unknown_columns', unknown: header.filter((col) => !def.known.includes(col)) }
  }
  return { dialect: 'unknown', reason: 'unrecognized_header' }
}

/* ------------------------------------------------------------------ */
/* 解析器：op_statistic（聚合视图）与 kernel_details（实例视图）          */
/* ------------------------------------------------------------------ */

const nullIfRawEmpty = (v) => {
  const s = String(v ?? '').trim()
  if (s === '') return null
  if (RAW_EMPTY.has(s)) return null
  return s
}

/** 解析 op_statistic.csv → 聚合 op_record（record_kind='aggregate'）。 */
export function parseOpStatistic(content, { file, sessionId }) {
  const { records, rows } = parseCsvRecords(content)
  if (records.length < 1) fail('PROFILE_PARSE_ERROR', 'op_statistic.csv 没有表头')
  const header = records[0].map((h) => String(h ?? '').trim())
  const idx = (name) => header.indexOf(name)
  const required = ['Device_id', 'OP Type', 'Core Type', 'Count', 'Total Time(us)']
  const missingCols = required.filter((c) => idx(c) < 0)
  if (missingCols.length > 0) fail('PROFILE_PARSE_ERROR', `op_statistic.csv 缺少必需列：${missingCols.join('、')}`, { missing: missingCols })
  const iDev = idx('Device_id'); const iType = idx('OP Type'); const iCore = idx('Core Type')
  const iCount = idx('Count'); const iTotal = idx('Total Time(us)')
  const iMin = idx('Min Time(us)'); const iAvg = idx('Avg Time(us)'); const iMax = idx('Max Time(us)')
  const iRatio = idx('Ratio(%)')
  const ops = []
  const rejected = []
  const warnings = []
  for (let r = 1; r < records.length; r += 1) {
    const row = records[r]
    const line = rows[r]
    if (row.length === 1 && String(row[0]).trim() === '') continue
    const record = {
      session_id: sessionId,
      op_id: '',
      record_kind: 'aggregate',
      device_id: nullIfRawEmpty(row[iDev]),
      rank_id: null,
      step: null,
      op_name: null,
      op_type: nullIfRawEmpty(row[iType]),
      core_type: nullIfRawEmpty(row[iCore]),
      calls: null,
      total_ns: null,
      min_ns: null,
      mean_ns: null,
      max_ns: null,
      metrics: [],
      sources: [],
      missing_reasons: {},
    }
    const reject = (field, reason) => rejected.push({ row: line, field, reason, raw: String(row[header.indexOf(field)] ?? '').slice(0, 64) })
    let continueOuter = false
    const count = parseNonNegativeInt(row[iCount])
    if (count === null) { reject('Count', 'not_a_non_negative_integer'); continue }
    record.calls = count
    if (count === 0) {
      record.missing_reasons.mean_ns = 'count_is_zero_source_mean_undefined'
      record.missing_reasons.min_ns = 'count_is_zero'
      record.missing_reasons.max_ns = 'count_is_zero'
    }
    const totalNs = decToNsMetric(row[iTotal], { file, row: line, field: 'Total Time(us)' })
    if (!totalNs.ok) { reject('Total Time(us)', 'not_a_decimal_us'); continue }
    if (totalNs.value.startsWith('-')) { reject('Total Time(us)', 'negative_duration'); continue }
    record.total_ns = totalNs.value
    if (totalNs.metric) record.metrics.push(totalNs.metric)
    if (totalNs.precisionLoss) warnings.push({ code: 'PROFILE_PRECISION_LOSS', row: line, field: 'Total Time(us)' })
    const putNs = (i, field, target, onlyIfCount) => {
      if (i < 0) return null
      if (onlyIfCount && count === 0) return null
      const raw = nullIfRawEmpty(row[i])
      if (raw === null) return null
      const conv = decToNsMetric(raw, { file, row: line, field })
      if (!conv.ok) return 'not_a_decimal_us'
      if (conv.value.startsWith('-')) return 'negative_duration'
      record[target] = conv.value
      return null
    }
    for (const [iX, name, target] of [[iMin, 'Min Time(us)', 'min_ns'], [iAvg, 'Avg Time(us)', 'mean_ns'], [iMax, 'Max Time(us)', 'max_ns']]) {
      const bad = putNs(iX, name, target, true)
      if (bad !== null) { reject(name, bad); continueOuter = true; break }
    }
    if (continueOuter) continue
    if (iRatio >= 0) {
      const rawRatio = nullIfRawEmpty(row[iRatio])
      if (rawRatio !== null) {
        const ratioValue = parseFiniteFloat(rawRatio)
        if (ratioValue === null) warnings.push({ code: 'PROFILE_FIELD_REJECTED', row: line, field: 'Ratio(%)', reason: 'not_a_finite_percent' })
        else if (ratioValue < 0 || ratioValue > 100) warnings.push({ code: 'PROFILE_RATIO_OUT_OF_RANGE', row: line, field: 'Ratio(%)', value: ratioValue })
        else record.metrics.push({ key: 'source_ratio', value: ratioValue / 100, unit: 'ratio', semantic_status: 'source_reported', source: { source_id: file.source_id, locator: `row:${line}`, fields: ['Ratio(%)'] } })
      }
    }
    const fields = ['OP Type', 'Count', 'Total Time(us)']
    if (iRatio >= 0) fields.push('Ratio(%)')
    record.sources.push({ source_id: file.source_id, locator: `row:${line}`, fields })
    record.op_id = sha256Hex([sessionId, file.source_id, line, record.device_id ?? '', record.op_type ?? ''].join('|')).slice(0, 16)
    ops.push(record)
  }
  if (ops.length === 0 && rejected.length === 0) fail('PROFILE_PARSE_ERROR', 'op_statistic.csv 没有数据行')
  return { kind: 'aggregate', ops, rejected, warnings }
}

/** 解析 kernel_details.csv → 实例 op_record（record_kind='instance'）+ PIPE counter metrics。 */
export function parseKernelDetails(content, { file, sessionId }) {
  const { records, rows } = parseCsvRecords(content)
  if (records.length < 1) fail('PROFILE_PARSE_ERROR', 'kernel_details.csv 没有表头')
  const header = records[0].map((h) => String(h ?? '').trim())
  const idx = (name) => header.indexOf(name)
  const required = PROFILE_DIALECTS.kernel.required
  const missingCols = required.filter((c) => idx(c) < 0)
  if (missingCols.length > 0) fail('PROFILE_PARSE_ERROR', `kernel_details.csv 缺少必需列：${missingCols.join('、')}`, { missing: missingCols })
  const iName = idx('Name'); const iType = idx('Type'); const iCore = idx('Accelerator Core')
  const iDur = idx('Duration(us)'); const iStart = idx('Start Time(us)')
  const iTask = idx('Task ID'); const iStream = idx('Stream ID'); const iDev = idx('Device_id')
  const ops = []
  const rejected = []
  const warnings = []
  const counterCols = [...KERNEL_RATIO_COUNTERS, ...KERNEL_TIME_COUNTERS, ...KERNEL_REPORTED_ONLY]
  const presentCounters = counterCols.filter((c) => idx(c) >= 0)
  for (let r = 1; r < records.length; r += 1) {
    const row = records[r]
    const line = rows[r]
    if (row.length === 1 && String(row[0]).trim() === '') continue
    const reject = (field, reason) => rejected.push({ row: line, field, reason, raw: String(row[header.indexOf(field)] ?? '').slice(0, 64) })
    const opName = nullIfRawEmpty(row[iName])
    const durRaw = nullIfRawEmpty(row[iDur])
    if (durRaw === null) { reject('Duration(us)', 'empty'); continue }
    const durNs = decToNsMetric(durRaw, { file, row: line, field: 'Duration(us)' })
    if (!durNs.ok) { reject('Duration(us)', 'not_a_decimal_us'); continue }
    if (durNs.value.startsWith('-')) { reject('Duration(us)', 'negative_duration'); continue }
    const record = {
      session_id: sessionId,
      op_id: '',
      record_kind: 'instance',
      device_id: nullIfRawEmpty(row[iDev]),
      rank_id: null,
      step: null,
      op_name: opName,
      op_type: nullIfRawEmpty(row[iType]),
      core_type: nullIfRawEmpty(row[iCore]),
      calls: 1,
      total_ns: durNs.value,
      min_ns: durNs.value,
      mean_ns: durNs.value,
      max_ns: durNs.value,
      metrics: [],
      sources: [],
      missing_reasons: {},
    }
    record.metrics.push(durNs.metric)
    const startRaw = nullIfRawEmpty(row[iStart])
    if (startRaw === null) {
      // 原始空值：字段缺省，不是错误
    } else {
      const startNs = decToNsMetric(startRaw, { file, row: line, field: 'Start Time(us)' })
      if (!startNs.ok) { reject('Start Time(us)', 'not_a_decimal_us'); continue }
      record.metrics.push(startNs.metric)
    }
    for (const col of KERNEL_RATIO_COUNTERS) {
      const i = idx(col)
      if (i < 0) continue
      const raw = nullIfRawEmpty(row[i])
      if (raw === null) continue
      const value = parseFiniteFloat(raw)
      if (value === null) { warnings.push({ code: 'PROFILE_FIELD_REJECTED', row: line, field: col, reason: 'not_a_finite_ratio' }); continue }
      if (value < 0 || value > 1) { warnings.push({ code: 'PROFILE_RATIO_OUT_OF_RANGE', row: line, field: col, value }); continue }
      record.metrics.push({ key: col, value, unit: 'ratio', semantic_status: 'verified', source: { source_id: file.source_id, locator: `row:${line}`, fields: [col] } })
    }
    for (const col of KERNEL_TIME_COUNTERS) {
      const i = idx(col)
      if (i < 0) continue
      const raw = nullIfRawEmpty(row[i])
      if (raw === null) continue
      const conv = decToNsMetric(raw, { file, row: line, field: col })
      if (!conv.ok) { warnings.push({ code: 'PROFILE_FIELD_REJECTED', row: line, field: col, reason: 'not_a_decimal_us' }); continue }
      record.metrics.push(conv.metric)
    }
    for (const col of KERNEL_REPORTED_ONLY) {
      const i = idx(col)
      if (i < 0) continue
      const raw = nullIfRawEmpty(row[i])
      if (raw === null) continue
      const value = parseFiniteFloat(raw)
      if (value === null) { warnings.push({ code: 'PROFILE_FIELD_REJECTED', row: line, field: col, reason: 'not_a_finite_percent' }); continue }
      record.metrics.push({ key: col.replace('(%)', ''), value: value / 100, unit: 'ratio', semantic_status: 'source_reported', source: { source_id: file.source_id, locator: `row:${line}`, fields: [col] } })
    }
    record.sources.push({ source_id: file.source_id, locator: `row:${line}`, fields: ['Name', 'Type', 'Accelerator Core', 'Duration(us)', `Task ID=${String(row[iTask] ?? '')}`, `Stream ID=${String(row[iStream] ?? '')}`] })
    record.op_id = sha256Hex([sessionId, file.source_id, line, 'instance'].join('|')).slice(0, 16)
    ops.push(record)
  }
  return {
    kind: 'instance',
    ops,
    rejected,
    warnings,
    counters_present: presentCounters,
    counters_absent: counterCols.filter((c) => idx(c) < 0),
  }
}

/* ------------------------------------------------------------------ */
/* 存储：<dataDir>/profile-v1/{real|demo}/<session_id>/（0700/0600）      */
/* ------------------------------------------------------------------ */

export class ProfileStore {
  constructor(dataDir) {
    this.root = join(dataDir, 'profile-v1')
    this.indexFile = join(this.root, 'index.json')
  }

  _ensureRoot() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    try { chmodSync(this.root, 0o700) } catch { /* best-effort */ }
  }

  _readIndex() {
    if (!existsSync(this.indexFile)) return { schema: PROFILE_SCHEMA, sessions: [] }
    try {
      const data = JSON.parse(readFileSync(this.indexFile, 'utf8'))
      if (data?.schema !== PROFILE_SCHEMA || !Array.isArray(data.sessions)) return { schema: PROFILE_SCHEMA, sessions: [] }
      return data
    } catch {
      return { schema: PROFILE_SCHEMA, sessions: [] }
    }
  }

  _writeIndex(index) {
    this._ensureRoot()
    const tmp = `${this.indexFile}.tmp-${Date.now()}`
    writeFileSync(tmp, JSON.stringify({ ...index, updated_at: nowIso() }, null, 2), { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch { /* best-effort */ }
    renameSync(tmp, this.indexFile)
  }

  _atomicWrite(path, text) {
    const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`
    writeFileSync(tmp, text, { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch { /* best-effort */ }
    renameSync(tmp, path)
  }

  /** 落库前结构校验（T132-10）：非法 manifest/op 一律 PROFILE_SCHEMA_INVALID，不写任何字节。 */
  _validateSession({ manifest, ops }) {
    const bad = (field) => fail('PROFILE_SCHEMA_INVALID', `session 数据不合法：${field}`, { field })
    if (manifest == null || typeof manifest !== 'object') bad('manifest')
    if (manifest.schema !== PROFILE_SESSION_SCHEMA) bad('manifest.schema')
    if (typeof manifest.session_id !== 'string' || !SESSION_ID_RE.test(manifest.session_id)) bad('manifest.session_id')
    if (!Number.isInteger(manifest.revision) || manifest.revision < 1) bad('manifest.revision')
    if (manifest.state !== 'ready' && manifest.state !== 'partial') bad('manifest.state')
    if (typeof manifest.is_demo !== 'boolean') bad('manifest.is_demo')
    if (typeof manifest.created_at !== 'string' || manifest.created_at === '') bad('manifest.created_at')
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) bad('manifest.files')
    const sourceIds = new Set()
    for (const f of manifest.files) {
      if (f == null || typeof f !== 'object') bad('manifest.files[]')
      if (typeof f.source_id !== 'string' || f.source_id === '') bad('manifest.files[].source_id')
      if (typeof f.path_redacted !== 'string') bad('manifest.files[].path_redacted')
      if (typeof f.sha256 !== 'string' || !SHA256_RE.test(f.sha256)) bad('manifest.files[].sha256')
      if (!Number.isInteger(f.bytes) || f.bytes < 0) bad('manifest.files[].bytes')
      if (typeof f.dialect !== 'string' || f.dialect === '') bad('manifest.files[].dialect')
      if (typeof f.validation !== 'string' || f.validation === '') bad('manifest.files[].validation')
      sourceIds.add(f.source_id)
    }
    if (!Array.isArray(ops)) bad('ops')
    for (const op of ops) {
      if (op == null || typeof op !== 'object') bad('ops[]')
      if (op.session_id !== manifest.session_id) bad('ops[].session_id 与 manifest 不一致')
      if (typeof op.op_id !== 'string' || !OP_ID_RE.test(op.op_id)) bad('ops[].op_id')
      if (op.record_kind !== 'aggregate' && op.record_kind !== 'instance') bad('ops[].record_kind')
      if (!Array.isArray(op.metrics)) bad('ops[].metrics')
      if (!Array.isArray(op.sources) || op.sources.length === 0) bad('ops[].sources')
      for (const s of op.sources) {
        if (s == null || typeof s !== 'object' || typeof s.source_id !== 'string') bad('ops[].sources[]')
        if (!sourceIds.has(s.source_id)) bad(`ops[].sources[].source_id 未在 manifest.files 中（外键悬空）：${s.source_id}`)
      }
    }
  }

  /** 提交一个 session（manifest + ops NDJSON + 索引），全部成功才写索引（原子提交语义）。 */
  commitSession({ manifest, ops }) {
    this._validateSession({ manifest, ops })
    const realmDir = join(this.root, manifest.is_demo ? 'demo' : 'real')
    mkdirSync(realmDir, { recursive: true, mode: 0o700 })
    const dir = join(realmDir, manifest.session_id)
    if (existsSync(dir)) fail('PROFILE_SESSION_EXISTS', `session 已存在：${manifest.session_id}`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try { chmodSync(dir, 0o700) } catch { /* best-effort */ }
    this._atomicWrite(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    this._atomicWrite(join(dir, 'ops.ndjson'), ops.map((op) => JSON.stringify(op)).join('\n') + '\n')
    const index = this._readIndex()
    index.sessions.push({
      session_id: manifest.session_id,
      revision: manifest.revision,
      state: manifest.state,
      is_demo: manifest.is_demo,
      created_at: manifest.created_at,
      op_count: ops.length,
      coverage: manifest.coverage,
      files: manifest.files.map((f) => ({ source_id: f.source_id, path_redacted: f.path_redacted, dialect: f.dialect, validation: f.validation })),
    })
    this._writeIndex(index)
    return manifest.session_id
  }

  listSessions() {
    return this._readIndex().sessions.map(({ files, ...rest }) => rest)
  }

  _sessionDir(sessionId, isDemo) {
    return join(this.root, isDemo ? 'demo' : 'real', sessionId)
  }

  getManifest(sessionId) {
    const index = this._readIndex()
    const entry = index.sessions.find((s) => s.session_id === sessionId)
    if (!entry) fail('PROFILE_SESSION_NOT_FOUND', `profile session 不存在：${sessionId}`)
    const dir = this._sessionDir(sessionId, entry.is_demo)
    try {
      return { manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')), index_entry: entry }
    } catch (error) {
      fail('PROFILE_SESSION_CORRUPT', `manifest 读取失败：${String(error?.message ?? error).slice(0, 120)}`)
    }
  }

  queryOps(sessionId, { kind = null, sort = 'total_ns', limit = 200 } = {}) {
    const { manifest } = this.getManifest(sessionId)
    const dir = this._sessionDir(sessionId, manifest.is_demo)
    if (!existsSync(join(dir, 'ops.ndjson'))) return []
    let ops = readFileSync(join(dir, 'ops.ndjson'), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
    if (kind) ops = ops.filter((op) => op.record_kind === kind)
    const num = (v) => (v == null ? -Infinity : Number(v))
    ops.sort((a, b) => num(b[sort]) - num(a[sort]))
    if (limit > 0) ops = ops.slice(0, limit)
    return ops
  }

  deleteSession(sessionId) {
    const index = this._readIndex()
    const entry = index.sessions.find((s) => s.session_id === sessionId)
    if (!entry) fail('PROFILE_SESSION_NOT_FOUND', `profile session 不存在：${sessionId}`)
    rmSync(this._sessionDir(sessionId, entry.is_demo), { recursive: true, force: true })
    index.sessions = index.sessions.filter((s) => s.session_id !== sessionId)
    this._writeIndex(index)
    return true
  }
}

/* ------------------------------------------------------------------ */
/* R01–R05：证据规则（确定性，无 LLM；缺字段 → skipped）                  */
/* ------------------------------------------------------------------ */

const NS_INT_RE = /^[+-]?\d+$/
/** 安全 ns 转换：非整数十进制字符串不抛 TypeError，返回 null 由调用方结构化降级（T132-12）。 */
export const nsFromString = (v) => {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v)
  if (typeof v === 'string' && NS_INT_RE.test(v)) return BigInt(v)
  return null
}
const groupBy = (list, keyFn) => {
  const out = {}
  for (const item of list) {
    const k = keyFn(item)
    ;(out[k] ??= []).push(item)
  }
  return out
}
const SESSION_ID_RE = /^prof-[a-z0-9]{16}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const OP_ID_RE = /^[0-9a-f]{16}$/
const ruleBase = (ruleId, status) => ({
  rule_id: ruleId,
  rule_version: PROFILE_RULE_VERSION,
  status,
  severity: ruleId === 'R01' ? 'high' : 'info',
  scope: { view: 'p1-records' },
  metrics: [],
  thresholds: {},
  evidence: [],
  conclusion: '',
  actions: [],
  false_positive_notes: [],
  missing_fields: [],
})

const sumAggregates = (aggregates) => aggregates.reduce((acc, op) => {
  const n = op.total_ns == null ? 0n : nsFromString(op.total_ns)
  return acc + (n ?? 0n)
}, 0n)
/** 统计非整数 total_ns 记录数（规则内结构化降级用，T132-12）。 */
const countInvalidNs = (ops) => ops.filter((op) => op.total_ns != null && nsFromString(op.total_ns) === null).length

/**
 * R01 算子热点集中：同一统计视图内某 op_type 总时长份额 ≥30%，或 Top5 ≥70%。
 * 需要聚合表（op_statistic）；分母 = 已导入聚合行的 Total Time 总和（源导出舍入容差内）。
 */
function ruleR01(aggregates, statisticFile) {
  const rule = ruleBase('R01', 'skipped')
  rule.thresholds = { single_share: 0.30, top5_share: 0.70 }
  if (!statisticFile || aggregates.length === 0) {
    rule.missing_fields.push('op_statistic aggregate view')
    rule.conclusion = '缺少 op_statistic 聚合视图，无法计算算子份额。'
    return rule
  }
  const invalidNs = countInvalidNs(aggregates)
  if (invalidNs > 0) rule.missing_fields.push(`invalid_total_ns_records:${invalidNs}`)
  const validAggregates = aggregates.filter((op) => op.total_ns == null || nsFromString(op.total_ns) !== null)
  if (validAggregates.length === 0) {
    rule.missing_fields.push('valid_aggregate_total_ns')
    rule.conclusion = '聚合视图 total_ns 全部非法（非整数十进制），无法计算份额。'
    return rule
  }
  const denom = sumAggregates(validAggregates)
  if (denom === 0n) {
    rule.missing_fields.push('non_zero_total_time')
    rule.conclusion = '聚合总时长为 0，无法计算份额。'
    return rule
  }
  const byType = new Map()
  for (const op of validAggregates) {
    const entry = byType.get(op.op_type ?? '') ?? { op_type: op.op_type, total_ns: 0n, sources: [] }
    entry.total_ns += op.total_ns == null ? 0n : nsFromString(op.total_ns)
    entry.sources.push(op)
    byType.set(op.op_type ?? '', entry)
  }
  const groups = [...byType.values()].sort((a, b) => (a.total_ns < b.total_ns ? 1 : -1))
  const share = (v) => Number((v * 10000n) / denom) / 10000
  const top = groups[0]
  const top5 = groups.slice(0, 5).reduce((acc, g) => acc + g.total_ns, 0n)
  const topShare = share(top.total_ns)
  const top5Share = share(top5)
  rule.metrics.push({ key: 'top_op_type_share', value: topShare, unit: 'ratio' }, { key: 'top5_share', value: top5Share, unit: 'ratio' })
  rule.evidence.push({
    file: statisticFile.path_redacted,
    row: top.sources[0]?.sources?.[0]?.locator ?? '',
    fields: ['OP Type', 'Total Time(us)', 'Ratio(%)'],
    values: { op_type: top.op_type, total_ns: top.total_ns.toString(), recomputed_share: topShare },
  })
  if (topShare >= 0.30 || top5Share >= 0.70) {
    rule.status = 'triggered'
    rule.confidence = { description: 'high', causal: 'low' }
    rule.conclusion = `本次采样中 ${top.op_type ?? '(unknown)'} 占已报告算子总时长 ${(topShare * 100).toFixed(3)}%（按已导入聚合行重算），样本内该类占主导。`
    rule.actions = ['在相同输入与精度门槛下，优先核验该类算子的 kernel 实现、shape/tiling 与 dtype 输出正确性，再以无 profile 基准做 A/B 比较。']
    rule.false_positive_notes = ['微 probe 天然单算子集中；截断统计只覆盖已导入部分；份额是源统计视图内占比，不是硬件利用率。']
  } else {
    rule.status = 'not_triggered'
    rule.confidence = { description: 'high', causal: 'low' }
    rule.conclusion = `最大单类份额 ${(topShare * 100).toFixed(3)}%、Top5 ${(top5Share * 100).toFixed(3)}%，未达热点集中阈值。`
  }
  return rule
}

/**
 * R02 Cube/MAC 效率线索：MIX/AI Core 实例 duration≥100us 且 duration 加权 aic_mac_ratio<0.5，
 * 且这些实例 duration 占计算 duration ≥20%。缺 PIPE counter 采集 → skipped（不推断）。
 */
function ruleR02(instances, kernelFile) {
  const rule = ruleBase('R02', 'skipped')
  rule.thresholds = { min_instance_duration_ns: 100000, weighted_mac_ratio: 0.5, compute_share: 0.20 }
  if (!kernelFile || instances.length === 0) {
    rule.missing_fields.push('kernel_details instance view')
    rule.conclusion = '缺少 kernel_details 实例视图，无法评估 MAC 管线占比。'
    return rule
  }
  const macInstances = instances.filter((op) => op.core_type === 'MIX_AIC' || op.core_type === 'AI_CORE')
  if (macInstances.length === 0) {
    rule.missing_fields.push('mix_aic_or_ai_core_instances')
    rule.conclusion = '样本中没有 MIX_AIC / AI_CORE 实例（例如纯 Vector），MAC 管线占比不适用。'
    return rule
  }
  const withCounter = macInstances.filter((op) => op.metrics.some((m) => m.key === 'aic_mac_ratio'))
  if (withCounter.length === 0) {
    rule.missing_fields.push('aic_mac_ratio')
    rule.conclusion = '该 capture 未采集 aic_mac_ratio（PIPE counters 缺失），不能从算子名称或 AI Core 时间份额推断 MAC 利用率。'
    rule.actions = ['如需该线索，请用开启 PIPE counter 的采集配置重新导出 kernel_details.csv。']
    return rule
  }
  const computeTotal = instances.reduce((acc, op) => {
    const n = op.total_ns == null ? 0n : nsFromString(op.total_ns)
    return acc + (n ?? 0n)
  }, 0n)
  let weighted = 0n
  let covered = 0n
  for (const op of macInstances) {
    const mac = op.metrics.find((m) => m.key === 'aic_mac_ratio')
    if (mac == null || typeof mac.value !== 'number') continue
    const dur = op.total_ns == null ? 0n : nsFromString(op.total_ns)
    if (dur == null || dur < 100000n) continue
    weighted += BigInt(Math.round(mac.value * 1e6)) * dur
    covered += dur
  }
  if (covered === 0n || computeTotal === 0n) {
    rule.missing_fields.push('instances_over_100us')
    rule.conclusion = '没有 duration≥100us 且带 aic_mac_ratio 的 MIX/AI Core 实例，无法计算加权占比。'
    return rule
  }
  const weightedRatio = Number(weighted / covered) / 1e6
  const computeShare = Number((covered * 10000n) / computeTotal) / 10000
  rule.metrics.push({ key: 'weighted_aic_mac_ratio', value: weightedRatio, unit: 'ratio' }, { key: 'covered_compute_share', value: computeShare, unit: 'ratio' })
  const sample = withCounter.find((op) => { const n = nsFromString(op.total_ns); return n !== null && n >= 100000n }) ?? withCounter[0]
  rule.evidence.push({
    file: kernelFile.path_redacted,
    row: sample?.sources?.[0]?.locator ?? '',
    fields: ['Accelerator Core', 'Duration(us)', 'aic_mac_ratio'],
    values: { core_type: sample?.core_type, duration_ns: sample?.total_ns, aic_mac_ratio: sample?.metrics.find((m) => m.key === 'aic_mac_ratio')?.value },
  })
  rule.conclusion = `duration≥100us 的 MIX/AI Core 实例 aic_mac_ratio 加权值为 ${weightedRatio.toFixed(3)}（覆盖计算时长份额 ${(computeShare * 100).toFixed(1)}%）。`
  if (weightedRatio < 0.5 && computeShare >= 0.20) {
    rule.status = 'triggered'
    rule.confidence = { description: 'medium', causal: 'low' }
    rule.actions = ['检查矩阵尺寸、tiling、padding、NZ 布局转换与 batch 组织；任何改动都要保持误差/精度门槛后再比较。']
    rule.false_positive_notes = ['内存带宽或依赖等待也会压低 MAC 占比；cube_utilization 是另一列，不与 aic_mac_ratio 合并。']
    rule.conclusion += 'MAC 管线占比偏低，值得核查。'
  } else {
    rule.status = 'not_triggered'
    rule.confidence = { description: 'medium', causal: 'low' }
  }
  return rule
}

/**
 * R03 Vector 转换开销：已验证 type 分类（Transpose/Cast）聚合份额 ≥10% 且 calls ≥10。
 */
function ruleR03(aggregates, statisticFile) {
  const rule = ruleBase('R03', 'skipped')
  rule.thresholds = { conversion_share: 0.10, min_calls: 10, conversion_types: CONVERSION_OP_TYPES }
  if (!statisticFile || aggregates.length === 0) {
    rule.missing_fields.push('op_statistic aggregate view')
    rule.conclusion = '缺少聚合视图，无法计算转换类份额。'
    return rule
  }
  const denom = sumAggregates(aggregates)
  if (denom === 0n) { rule.missing_fields.push('non_zero_total_time'); rule.conclusion = '聚合总时长为 0。'; return rule }
  let convNs = 0n
  let convCalls = 0
  const convRows = []
  for (const op of aggregates) {
    if (!CONVERSION_OP_TYPES.includes(op.op_type ?? '')) continue
    const n = op.total_ns == null ? 0n : nsFromString(op.total_ns)
    if (n === null) { rule.missing_fields.push(`invalid_total_ns_records:${op.op_type ?? ''}`); continue }
    convNs += n
    convCalls += op.calls ?? 0
    convRows.push(op)
  }
  const share = Number((convNs * 10000n) / denom) / 10000
  rule.metrics.push({ key: 'conversion_share', value: share, unit: 'ratio' }, { key: 'conversion_calls', value: convCalls, unit: 'count' })
  for (const op of convRows) {
    rule.evidence.push({ file: statisticFile.path_redacted, row: op.sources?.[0]?.locator ?? '', fields: ['OP Type', 'Count', 'Total Time(us)'], values: { op_type: op.op_type, calls: op.calls, total_ns: op.total_ns } })
  }
  rule.conclusion = `Transpose/Cast 类合计占已报告算子总时长 ${(share * 100).toFixed(3)}%、调用 ${convCalls} 次。`
  if (share >= 0.10 && convCalls >= 10) {
    rule.status = 'triggered'
    rule.confidence = { description: 'high', causal: 'low' }
    rule.actions = ['检查相邻 shape/dtype/layout 转换是否可消除或融合；验证 dtype 精度与结果一致性后再比较。']
    rule.false_positive_notes = ['必要格式转换可能不可消除；只有聚合表时仅提出候选，不宣称可融合。']
    rule.conclusion += '转换成本可见，值得排查。'
  } else {
    rule.status = 'not_triggered'
    rule.confidence = { description: 'high', causal: 'low' }
  }
  return rule
}

/**
 * R04 统计/实例交叉核验：同视图 Count 与 Total 差异 > max(1%, 导出舍入容差) → 质量告警。
 * 只有一份输入 → skipped（不报性能故障）。
 */
function ruleR04(aggregates, instances, statisticFile, kernelFile) {
  const rule = ruleBase('R04', 'skipped')
  rule.thresholds = { count_tolerance_ratio: 0.01, time_tolerance_ratio: 0.01, time_rounding_ns: 1000 }
  if (!statisticFile || !kernelFile || aggregates.length === 0 || instances.length === 0) {
    rule.missing_fields.push('both_statistic_and_kernel_views')
    rule.conclusion = '缺少统计/实例双视图，交叉核验跳过（只有一份输入不构成差异结论）。'
    return rule
  }
  const statByType = new Map()
  for (const op of aggregates) {
    const e = statByType.get(op.op_type ?? '') ?? { calls: 0, total_ns: 0n, sample: op }
    e.calls += op.calls ?? 0
    const n = op.total_ns == null ? 0n : nsFromString(op.total_ns)
    e.total_ns += n ?? 0n
    statByType.set(op.op_type ?? '', e)
  }
  const instByType = new Map()
  for (const op of instances) {
    const e = instByType.get(op.op_type ?? '') ?? { calls: 0, total_ns: 0n, sample: op }
    e.calls += 1
    const n = op.total_ns == null ? 0n : nsFromString(op.total_ns)
    e.total_ns += n ?? 0n
    instByType.set(op.op_type ?? '', e)
  }
  const mismatches = []
  // 容差（T132-05）：count 用 max(1% 的 Count, 0)（导出为整数，舍入容差 0）；time 用 max(1%, 1000ns 舍入容差)。只有严格超出才触发。
  for (const [type, stat] of statByType) {
    const inst = instByType.get(type)
    if (!inst) { mismatches.push({ type, reason: 'missing_in_instances', stat_calls: stat.calls, inst_calls: 0, row: stat.sample?.sources?.[0]?.locator ?? '' }); continue }
    const callsDelta = Math.abs(stat.calls - inst.calls)
    const countTol = Math.max(Math.floor((stat.calls * 0.01)), 0)
    const timeDelta = stat.total_ns > inst.total_ns ? stat.total_ns - inst.total_ns : inst.total_ns - stat.total_ns
    const timeTol = (stat.total_ns / 100n) + 1000n
    if (callsDelta > countTol || timeDelta > timeTol) {
      mismatches.push({
        type,
        reason: callsDelta > countTol ? 'count_mismatch' : 'time_mismatch',
        stat_calls: stat.calls, inst_calls: inst.calls,
        stat_total_ns: stat.total_ns.toString(), inst_total_ns: inst.total_ns.toString(),
        delta_ns: timeDelta.toString(),
        count_tolerance: countTol, time_tolerance_ns: timeTol.toString(),
        row: stat.sample?.sources?.[0]?.locator ?? '',
        kernel_row: inst.sample?.sources?.[0]?.locator ?? '',
      })
    }
  }
  // ratio 越界扫描（T132-06）：聚合 source_ratio 与实例 ratio counter 超出 [0,1] → 数据质量 mismatch（带行号）
  const ratioOutOfBound = (op) => op.metrics.filter((m) => m.unit === 'ratio' && typeof m.value === 'number' && (m.value < 0 || m.value > 1))
    .map((m) => ({ metric: m.key, value: m.value, row: op.sources?.[0]?.locator ?? '' }))
  for (const op of aggregates) {
    for (const b of ratioOutOfBound(op)) mismatches.push({ type: op.op_type ?? '', reason: 'ratio_out_of_range', field: b.metric, value: b.value, row: b.row, file: statisticFile.path_redacted })
  }
  for (const op of instances) {
    for (const b of ratioOutOfBound(op)) mismatches.push({ type: op.op_type ?? '', reason: 'ratio_out_of_range', field: b.metric, value: b.value, row: b.row, file: kernelFile.path_redacted })
  }
  rule.metrics.push({ key: 'statistic_types', value: statByType.size, unit: 'count' }, { key: 'instance_types', value: instByType.size, unit: 'count' }, { key: 'mismatches', value: mismatches.length, unit: 'count' })
  // T134-02：overview evidence 也带代表行（首个聚合/首个实例的 locator），evidence 四要素不再有空值
  const firstAggRow = aggregates[0]?.sources?.[0]?.locator ?? ''
  const firstInstRow = instances[0]?.sources?.[0]?.locator ?? ''
  rule.evidence.push({ file: statisticFile.path_redacted, source_id: statisticFile.source_id ?? null, row: firstAggRow, locator: firstAggRow, transform: 'us→ns 十进制定点', fields: ['OP Type', 'Count', 'Total Time(us)'], values: { types: [...statByType.keys()] } })
  rule.evidence.push({ file: kernelFile.path_redacted, source_id: kernelFile.source_id ?? null, row: firstInstRow, locator: firstInstRow, transform: 'us→ns 十进制定点', fields: ['Type', 'Duration(us)'], values: { instances: instances.length } })
  for (const m of mismatches.slice(0, 5)) {
    rule.evidence.push({ file: m.file ?? (m.reason === 'missing_in_instances' || m.reason === 'count_mismatch' || m.reason === 'time_mismatch' ? statisticFile.path_redacted : kernelFile.path_redacted), source_id: (m.file ?? statisticFile.path_redacted) === statisticFile.path_redacted ? (statisticFile.source_id ?? null) : (kernelFile.source_id ?? null), row: m.row ?? '', locator: m.row ?? '', transform: 'us→ns 十进制定点', fields: m.reason === 'ratio_out_of_range' ? [m.field] : ['OP Type', 'Count', 'Total Time(us)'], values: m })
  }
  if (mismatches.length > 0) {
    rule.status = 'triggered'
    rule.severity = 'medium'
    rule.confidence = { description: 'high', causal: 'n/a' }
    rule.conclusion = `统计视图与实例视图存在 ${mismatches.length} 处 Count/Total/ratio 差异超出容差，采样/导入视图可能不一致。`
    rule.actions = ['先核对 capture 过滤器、core 定义与导出选项，再基于一致视图分析性能。']
    rule.false_positive_notes = ['异步子 task 或不同过滤器会造成合理差异；本规则只报数据质量，不报性能故障。']
    rule.metrics.push({ key: 'mismatch_detail', value: mismatches.slice(0, 5), unit: 'unknown' })
  } else {
    rule.status = 'not_triggered'
    rule.confidence = { description: 'high', causal: 'n/a' }
    rule.conclusion = '统计与实例视图的 Count/Total 在容差内一致。'
  }
  return rule
}

/**
 * R05 小任务下发候选：≥100 个实例、median duration<20us 且实例总 duration≥20%。
 * 样本不足 → skipped；只有聚合表无法计算 median → skipped。
 */
function ruleR05(instances, kernelFile) {
  const rule = ruleBase('R05', 'skipped')
  rule.thresholds = { min_instances_per_type: 100, median_duration_ns: 20000, duration_share: 0.20 }
  if (!kernelFile || instances.length === 0) {
    rule.missing_fields.push('kernel_details instance view')
    rule.conclusion = '缺少实例视图，无法计算 duration 中位数。'
    return rule
  }
  const invalidNs = countInvalidNs(instances)
  if (invalidNs > 0) rule.missing_fields.push(`invalid_total_ns_records:${invalidNs}`)
  const valid = instances.filter((op) => op.total_ns == null || nsFromString(op.total_ns) !== null)
  if (valid.length === 0) {
    rule.missing_fields.push('valid_instance_total_ns')
    rule.conclusion = '实例视图 total_ns 全部非法（非整数十进制），无法评估小任务候选。'
    return rule
  }
  // 真实分母（T132-01）：整个实例视图的总 duration——与 R05 scope（同一 capture 的全部 kernel 实例）一致。
  const denominator = valid.reduce((acc, op) => acc + (op.total_ns == null ? 0n : nsFromString(op.total_ns)), 0n)
  rule.metrics.push({ key: 'r05_denominator_ns', value: denominator.toString(), unit: 'ns' })
  rule.metrics.push({ key: 'instance_count', value: valid.length, unit: 'count' })
  const withEnough = []
  for (const [type, group] of Object.entries(groupBy(valid, (op) => op.op_type ?? ''))) {
    if (group.length < 100) continue
    const durs = group.map((op) => (op.total_ns == null ? 0n : nsFromString(op.total_ns))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const median = durs[Math.floor(durs.length / 2)]
    const numerator = durs.reduce((a, b) => a + b, 0n)
    const share = denominator === 0n ? 0 : Number((numerator * 10000n) / denominator) / 10000
    withEnough.push({ type, group, median, numerator, share, count: group.length })
  }
  if (withEnough.length === 0) {
    rule.missing_fields.push('op_type_with_100_instances')
    rule.conclusion = `没有任何 op_type 实例数 ≥100（共 ${valid.length} 个实例），样本不足，按设计跳过（不能按均值伪造中位数）。`
    return rule
  }
  withEnough.sort((a, b) => (a.share < b.share ? 1 : -1))
  const best = withEnough[0]
  rule.metrics.push(
    { key: 'candidate_op_type', value: best.type, unit: 'name' },
    { key: 'candidate_instance_count', value: best.count, unit: 'count' },
    { key: 'r05_numerator_ns', value: best.numerator.toString(), unit: 'ns' },
    { key: 'median_duration_ns', value: best.median.toString(), unit: 'ns' },
    { key: 'small_task_share', value: best.share, unit: 'ratio' },
  )
  const sample = best.group[Math.floor(best.group.length / 2)]
  // T132-07：median/份额/实例集合各写 evidence（source_id/locator/转换/值）
  rule.evidence.push({
    file: kernelFile.path_redacted, source_id: kernelFile.source_id ?? null,
    row: sample?.sources?.[0]?.locator ?? '', locator: sample?.sources?.[0]?.locator ?? '',
    transform: 'us→ns 十进制定点',
    fields: ['Name', 'Type', 'Duration(us)'],
    values: { op_type: best.type, median_ns: best.median.toString(), sample_duration_ns: sample?.total_ns ?? null, instance_count: best.count },
  })
  rule.evidence.push({
    file: kernelFile.path_redacted, source_id: kernelFile.source_id ?? null,
    row: best.group[0]?.sources?.[0]?.locator ?? '', locator: best.group[0]?.sources?.[0]?.locator ?? '',
    transform: '分子/分母均为 us→ns 十进制定点后求和',
    fields: ['Type', 'Duration(us)'],
    values: { numerator_ns: best.numerator.toString(), denominator_ns: denominator.toString(), share: best.share },
  })
  rule.evidence.push({
    file: kernelFile.path_redacted, source_id: kernelFile.source_id ?? null,
    row: best.group[best.group.length - 1]?.sources?.[0]?.locator ?? '', locator: best.group[best.group.length - 1]?.sources?.[0]?.locator ?? '',
    transform: '按 op_type 分组计数',
    fields: ['Type'],
    values: { instance_set_size: best.count, first_row: best.group[0]?.sources?.[0]?.locator ?? '', last_row: best.group[best.group.length - 1]?.sources?.[0]?.locator ?? '' },
  })
  rule.conclusion = `候选 ${best.type}：${best.count} 个实例，duration 中位数 ${best.median.toString()}ns，占全部实例总时长 ${(best.share * 100).toFixed(3)}%。`
  if (best.median < 20000n && best.share >= 0.20) {
    rule.status = 'triggered'
    rule.confidence = { description: 'medium', causal: 'low' }
    rule.actions = ['考察算子融合、图执行与 batch 组织对下发粒度的改善；P2 补 host 关联后再验证 launch gap。']
    rule.false_positive_notes = ['该规则只是下发优化候选，不证明 host 已阻塞；高 calls 不等于小 task。']
    rule.conclusion += '任务粒度偏小，作为下发优化候选。'
  } else {
    rule.status = 'not_triggered'
    rule.confidence = { description: 'medium', causal: 'low' }
    if (best.median >= 20000n) rule.conclusion += '中位数未达小任务阈值。'
    if (best.share < 0.20) rule.conclusion += '候选类时长份额不足 20%。'
  }
  return rule
}

/** 对一个已提交 session 评估 R01–R05（全量返回，含 triggered/not_triggered/skipped）。 */
export function evaluateProfileRules({ manifest, ops }) {
  const statisticFile = manifest.files.find((f) => f.dialect === PROFILE_DIALECTS.statistic.id) ?? null
  const kernelFile = manifest.files.find((f) => f.dialect === PROFILE_DIALECTS.kernel.id) ?? null
  const aggregates = ops.filter((op) => op.record_kind === 'aggregate')
  const instances = ops.filter((op) => op.record_kind === 'instance')
  return {
    rule_version: PROFILE_RULE_VERSION,
    session_id: manifest.session_id,
    revision: manifest.revision,
    rules: [
      ruleR01(aggregates, statisticFile),
      ruleR02(instances, kernelFile),
      ruleR03(aggregates, statisticFile),
      ruleR04(aggregates, instances, statisticFile, kernelFile),
      ruleR05(instances, kernelFile),
    ],
  }
}

/* ------------------------------------------------------------------ */
/* 服务：导入（upload/demo）、查询、报告                                 */
/* ------------------------------------------------------------------ */

export const PROFILE_LIMITS = {
  maxFiles: 8,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
}

const here = () => fileURLToPath(new URL('.', import.meta.url))

export function createProfileService({ dataDir, fixturesDir = null } = {}) {
  const store = new ProfileStore(dataDir)
  const demoDir = fixturesDir ?? join(here(), 'fixtures', 'profile')

  const importFiles = ({ files, mode = 'upload', envId = null, isDemo = false, metadata = null, policy = 'strict' }) => {
    if (policy !== 'strict' && policy !== 'partial') fail('PROFILE_INVALID_POLICY', `未知导入策略：${String(policy)}（只接受 strict/partial）`)
    if (!Array.isArray(files) || files.length === 0) fail('PROFILE_NO_FILES', '没有可导入的文件')
    if (files.length > PROFILE_LIMITS.maxFiles) fail('PROFILE_TOO_LARGE', `文件数超过上限 ${PROFILE_LIMITS.maxFiles}`)
    let total = 0
    for (const f of files) {
      const content = String(f?.content ?? '')
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > PROFILE_LIMITS.maxFileBytes) fail('PROFILE_TOO_LARGE', `文件 ${basename(String(f?.name ?? 'file'))} 超过单文件上限 ${PROFILE_LIMITS.maxFileBytes} 字节`, { file: basename(String(f?.name ?? 'file')), bytes })
      total += bytes
    }
    if (total > PROFILE_LIMITS.maxTotalBytes) fail('PROFILE_TOO_LARGE', `总输入超过上限 ${PROFILE_LIMITS.maxTotalBytes} 字节`)
    const sessionId = rid('prof')
    const fileEntries = []
    const parsedParts = []
    let accepted = 0
    let rejected = 0
    let anySupported = false
    for (const f of files) {
      const name = basename(String(f?.name ?? 'file')).replace(/[^\w.\-]/g, '_')
      const content = String(f?.content ?? '')
      const detected = detectProfileDialect(content)
      const sourceId = `src-${sha256Hex(content).slice(0, 12)}`
      const entry = {
        source_id: sourceId,
        path_redacted: name,
        sha256: sha256Hex(content),
        bytes: Buffer.byteLength(content, 'utf8'),
        dialect: detected.dialect === 'unknown' ? 'unknown' : PROFILE_DIALECTS[detected.dialect].id,
        validation: detected.dialect === 'unknown' ? 'unsupported' : 'native_sample_verified',
      }
      fileEntries.push(entry)
      if (detected.dialect === 'unknown') continue
      anySupported = true
      const parsed = detected.dialect === 'statistic'
        ? parseOpStatistic(content, { file: entry, sessionId })
        : parseKernelDetails(content, { file: entry, sessionId })
      parsedParts.push(parsed)
      accepted += parsed.ops.length
      rejected += parsed.rejected.length
    }
    if (!anySupported) fail('PROFILE_UNSUPPORTED_FORMAT', '没有任何可识别的 profile 文件（header 指纹未命中已验证 dialect）', { files: fileEntries.map((f) => ({ path_redacted: f.path_redacted, dialect: f.dialect })) })
    const ops = parsedParts.flatMap((p) => p.ops)
    const warnings = parsedParts.flatMap((p) => p.warnings.map((w) => ({ ...w, dialect: p.kind })))
    // T132-08：默认 strict——只要有行级 rejected 就拒绝整个 session（不落库）；只有显式 policy='partial' 才跳过坏行并标 partial。
    if (rejected > 0 && policy === 'strict') {
      fail('PROFILE_REJECTED_RECORDS', `默认 strict 策略：${rejected} 行被拒绝，整个 session 不落库；确认要跳过坏行请显式传 policy='partial'`, {
        rejected,
        rejected_records: parsedParts.flatMap((p) => p.rejected.map((r) => ({ ...r, dialect: p.kind }))).slice(0, 20),
        coverage: { accepted, rejected },
      })
    }
    const manifest = {
      schema: PROFILE_SESSION_SCHEMA,
      session_id: sessionId,
      revision: 1,
      state: rejected > 0 ? 'partial' : 'ready',
      evidence_kind: isDemo ? 'demo' : 'unverified_import',
      is_demo: isDemo === true,
      created_at: nowIso(),
      source: { mode: isDemo ? 'demo' : mode, env_id: envId ?? null, parser_version: PROFILE_PARSER_VERSION },
      model: { name: metadata?.model_name ?? null, revision: metadata?.model_revision ?? null, origin: metadata?.model_name ? 'user_declared' : 'unknown' },
      parallel: { tp: null, pp: null, dp: null, cp: null, ep: null, device_count: null },
      versions: { cann: metadata?.cann ?? null, driver: null, torch_npu: metadata?.torch_npu ?? null, msprof: null },
      capture: { started_at: null, ended_at: null, command_redacted: null, parameters: {}, stability: 'unknown' },
      clocks: [],
      files: fileEntries,
      coverage: { accepted, rejected, unhandled: 0, join_exact: 0, join_ambiguous: 0, join_missing: 0, complete_device_timeline: false },
      linked_run_ids: [],
      missing_reasons: parsedParts.some((p) => p.kind === 'instance' && p.counters_absent?.length > 0) ? { pipe_counters: 'not_collected_in_source' } : {},
    }
    store.commitSession({ manifest, ops })
    return { schema: PROFILE_SCHEMA, session_id: sessionId, state: manifest.state, coverage: manifest.coverage, files: manifest.files, warnings, parser_version: PROFILE_PARSER_VERSION, is_demo: manifest.is_demo }
  }

  const importDemo = () => {
    const names = ['op_statistic.csv', 'kernel_details.csv']
    const files = names.map((name) => ({ name, content: readFileSync(join(demoDir, name), 'utf8') }))
    return importFiles({ files, mode: 'demo', isDemo: true })
  }

  const detail = (sessionId) => {
    const { manifest } = store.getManifest(sessionId)
    const aggregates = store.queryOps(sessionId, { kind: 'aggregate' })
    const instances = store.queryOps(sessionId, { kind: 'instance' })
    const denom = sumAggregates(aggregates)
    const top = aggregates.slice(0, 10).map((op) => ({
      op_type: op.op_type,
      core_type: op.core_type,
      device_id: op.device_id,
      calls: op.calls,
      total_ns: op.total_ns,
      mean_ns: op.calls === 0 ? null : op.mean_ns,
      share: denom === 0n || op.total_ns == null || nsFromString(op.total_ns) === null ? null : Number((nsFromString(op.total_ns) * 10000n) / denom) / 10000,
      row: op.sources?.[0]?.locator ?? '',
      source_ratio: op.metrics.find((m) => m.key === 'source_ratio')?.value ?? null,
    }))
    return { schema: PROFILE_SCHEMA, manifest, top_ops: top, instance_count: instances.length }
  }

  const report = (sessionId) => {
    const { manifest } = store.getManifest(sessionId)
    const ops = store.queryOps(sessionId, { limit: 0 })
    const evaluation = evaluateProfileRules({ manifest, ops })
    return { schema: PROFILE_SCHEMA, ...evaluation, evidence_kind: manifest.evidence_kind, is_demo: manifest.is_demo }
  }

  return {
    store,
    importFiles,
    importDemo,
    list: () => ({ schema: PROFILE_SCHEMA, sessions: store.listSessions() }),
    detail,
    report,
    remove: (sessionId) => ({ schema: PROFILE_SCHEMA, deleted: store.deleteSession(sessionId), session_id: sessionId }),
  }
}

/* ------------------------------------------------------------------ */
/* Host 工具与 REST 路由                                                */
/* ------------------------------------------------------------------ */

const toolEnvelope = (kind, payload) => ({ schema: PROFILE_SCHEMA, kind, ...payload })

export function createProfileTools(service) {
  const wrap = (name, fn) => ({
    name,
    async execute(args) {
      try {
        return await fn(args ?? {})
      } catch (error) {
        if (error instanceof ProfileError) return toolEnvelope(name, { status: 'error', error: { code: error.code, message: error.message, details: error.details ?? null } })
        return toolEnvelope(name, { status: 'error', error: { code: 'PROFILE_INTERNAL', message: String(error?.message ?? error).slice(0, 200), details: null } })
      }
    },
  })
  return [
    {
      ...wrap('ascend_profile_import', (args) => {
        const out = service.importFiles({ files: args.files ?? [], mode: 'upload', metadata: args.metadata ?? null, policy: args.policy ?? 'strict' })
        return toolEnvelope('ascend_profile_import', { status: 'ok', result: out })
      }),
      description: '导入 msprof profile CSV（op_statistic.csv / kernel_details.csv，按 header 指纹判型）到本机私有 profile-v1 存储。只接收小文本内容，不执行采样。',
      parameters: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } }, required: ['name', 'content'], additionalProperties: false } },
          metadata: { type: 'object', properties: { model_name: { type: 'string' }, model_revision: { type: 'string' }, cann: { type: 'string' }, torch_npu: { type: 'string' } }, additionalProperties: false },
          policy: { type: 'string', enum: ['strict', 'partial'], description: "strict（默认）：有任何被拒行则整个 session 不落库；partial：显式跳过坏行并标记 session 为 partial" },
        },
        required: ['files'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, payload) => [{ type: 'text', text: JSON.stringify(payload, null, 2) }] },
      timeoutMs: 30000,
    },
    {
      ...wrap('ascend_profile_list', () => toolEnvelope('ascend_profile_list', { status: 'ok', result: service.list() })),
      description: '列出已导入的 profile session（含 coverage 与来源文件）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, payload) => [{ type: 'text', text: JSON.stringify(payload, null, 2) }] },
    },
    {
      ...wrap('ascend_profile_report', (args) => toolEnvelope('ascend_profile_report', { status: 'ok', result: service.report(String(args.session_id ?? '')) })),
      description: '对指定 profile session 输出 Top 算子与 R01–R05 证据规则报告（含 triggered/not_triggered/skipped 与 evidence）。',
      parameters: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'], additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, payload) => [{ type: 'text', text: JSON.stringify(payload, null, 2) }] },
    },
  ]
}

export function createProfileRoutes(service) {
  const api = (fn) => async (body, query, params) => fn(body ?? {}, query ?? {}, params ?? [])
  const sessionIdPattern = /^\/profile\/sessions\/(prof-[a-z0-9]{16})$/
  const reportPattern = /^\/profile\/sessions\/(prof-[a-z0-9]{16})\/report$/
  return [
    { path: '/profile/imports', method: 'POST', handler: api((body) => service.importFiles({ files: body.files, mode: 'upload', metadata: body.metadata ?? null, policy: body.policy ?? 'strict' })) },
    { path: '/profile/demo', method: 'POST', handler: api(() => service.importDemo()) },
    { path: '/profile/sessions', method: 'GET', handler: api(() => service.list()) },
    { path: '/profile/sessions/:id', method: 'GET', pattern: sessionIdPattern, handler: api((body, query, params) => service.detail(params[0])) },
    { path: '/profile/sessions/:id', method: 'DELETE', pattern: sessionIdPattern, handler: api((body, query, params) => service.remove(params[0])) },
    { path: '/profile/sessions/:id/report', method: 'GET', pattern: reportPattern, handler: api((body, query, params) => service.report(params[0])) },
  ]
}
