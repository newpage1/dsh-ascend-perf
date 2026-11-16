// ascend-perf/deploy-exec.js —— 服务部署 v3：容器服务预览/启动/状态/停止（t124）
//
// 设计要点（captain m09062 / skills/ascend-deploy 配方 + t126 b01 实测定稿）：
// - 配方：只挂选中 /dev/davinciN + manager/devmm/hdc 三个公共 device；driver/dcmi/
//   ascend_install.info 只读挂载；模型根目录只读挂到 /models；端口只绑 127.0.0.1。
// - t126 b01 实测（驱动 26.0.rc1）：无 --privileged 时 ascend_hal 枚举失败
//   （"Can't get ascend_hal device count" → vllm 引擎初始化 std::logic_error 退出）；
//   加 --privileged 后若不限制可见设备，容器能看到全部 8 卡（COUNT=8，隔离失效）。
//   因此：--privileged --ipc=host + ASCEND_RT_VISIBLE_DEVICES=选中卡物理序号（t139 勘误：env 是物理 davinci 序号）
//   （只挂选中节点 + 逻辑重映射，实测单卡 COUNT=1、双卡 COUNT=2，卡 6 冒烟+1B 服务全通）。
// - 双门 fail-closed：真实执行默认关闭（envs.json 可选 "deploy": {"allowRealExecution": true}）
//   + preview 返回的 confirmation_token（10 分钟 TTL，绑定 spec 摘要）。缺任一门即拒绝。
// - 停止/日志只对 dsh-apf-svc- 前缀 **且** label 匹配的自有容器生效，否则 FORBIDDEN。
// - 一切远端操作经注入的 execSsh(hostAlias, command, timeoutMs)（index.js 用 runCommand+ssh
//   构造；测试注入 mock），本模块自身不 spawn、不连远端。
// - 预检：环境存在且启用且为 ssh 模式；逐卡 npu-smi usages 实测空闲（HBM<10% 且 AICore<5%）；
//   端口 ss -ltn 未监听；docker image inspect 存在；模型目录 test -d。
// - t139：可选 vLLM profiler 采集——spec.profile.enabled 时挂 -v <远端目录>:/prof +
//   --profiler-config '{"profiler":"torch","torch_profiler_dir":"/prof"}'；服务 healthy 后自动
//   /start_profile → 2×/v1/completions(max_tokens 32) → /stop_profile，读回 op_statistic.csv
//   导入 ProfileService（kernel_details ~20MB 暂不导入）。采集失败只记 profile.state='failed'
//   + warning，绝不回滚/杀掉已启动的服务。

import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TuneApiError, tuneError } from './tune-exec.js'
// t139：采集到的 op_statistic.csv 走现有 ProfileService 导入（本文件不改 profile.js 的规则）
import { createProfileService } from './profile.js'

export const DEPLOY_RUN_SCHEMA = 'dsh-ascend-perf/deploy-run-v1'
export const RUN_CONTAINER_PREFIX = 'dsh-apf-svc-'
export const RUN_CONTAINER_LABEL = 'dsh-ascend-perf.service'
export const DEFAULT_RUN_IMAGE = 'quay.io/ascend/vllm-ascend:v0.23.0'
export const CONFIRMATION_TTL_MS = 10 * 60 * 1000
// t139：vLLM torch profiler 输出挂载点与启动参数（c01 实测定稿，见任务书）
export const PROFILE_MOUNT = '/prof'
const PROFILER_CONFIG_JSON = '{"profiler":"torch","torch_profiler_dir":"/prof"}'
// stop_profile 后 ascend_pt 导出异步落盘（trace.gz→rank0 目录→CSV 可达数分钟）：单次 status 有界等待 4×5s，累计 600s 超时。
const PROFILER_EXPORT_POLL_LOOPS = 4
const PROFILER_EXPORT_POLL_S = 5
const PROFILER_EXPORT_TIMEOUT_MS = 600000
export const RUN_ERROR_CODES = [
  'INVALID_ARGUMENT', 'UNKNOWN_FIELD', 'ENV_UNKNOWN', 'ENV_DISABLED', 'ENV_MODE_UNSUPPORTED',
  'SNAPSHOT_MISSING', 'CHIP_BUSY', 'PORT_IN_USE', 'IMAGE_NOT_FOUND', 'MODEL_DIR_MISSING',
  'SSH_UNAVAILABLE', 'REAL_EXECUTION_DISABLED', 'INVALID_CONFIRMATION', 'INSTANCE_UNKNOWN',
  'FORBIDDEN', 'RESERVATION_CONFLICT', 'DOCKER_ERROR', 'INTERNAL_ERROR', 'PROFILE_CAPTURE_FAILED',
]

const SPEC_KEYS = ['env_id', 'image', 'model', 'code', 'params', 'cards', 'profile']
const PROFILE_KEYS = ['enabled', 'dir']
const MODEL_KEYS = ['root', 'path']
const PARAM_KEYS = ['port', 'tensor_parallel', 'max_model_len', 'health_timeout_s', 'max_num_seqs', 'max_num_batched_tokens', 'gpu_memory_utilization', 'enable_prefix_caching', 'enforce_eager']
const CODE_COMPONENTS = ['vllm', 'vllm-ascend', 'lmcache', 'lmcache-ascend', 'mooncake']
const CODE_REF_RE = /^[A-Za-z0-9._/@+-]{1,128}$/
// 构建模式：repo 只允许 http(s)/ssh/git URL，避免把任意 shell 注进容器构建脚本。
const CODE_REPO_RE = /^(https?:\/\/|ssh:\/\/|git@)[A-Za-z0-9._~:/?#@!$&()*+,;=%-]{1,512}$/
// t126④：首字符必须是字母/数字——拒绝 leading '-' 等 docker 选项注入；argv 中 image 前另有 '--' 分隔双保险。
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/
const ABS_PATH_RE = /^\/[A-Za-z0-9_.\/-]{0,511}$/
const REL_PATH_RE = /^[A-Za-z0-9_.-][A-Za-z0-9_.\/-]{0,254}$/

const fail = (code, message, details = null) => { throw new TuneApiError(code, message, details) }

function rejectUnknown(raw, allowed, where) {
  for (const key of Object.keys(raw ?? {})) {
    if (!allowed.includes(key)) fail('UNKNOWN_FIELD', `${where} 含未知字段：${key}`, { field: key })
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// t126⑧：远端命令逐元素 shell 转义（与 index.js quotePosix 同式）。
// 所有插值（镜像/路径/容器名/npu-smi 路径）在拼进远端 shell 命令前统一走这里；
// argv 数组元素同样先转义再 join，保证 join(' ') 后仍是安全的远端命令字符串。
export function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function assertIntInRange(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('INVALID_ARGUMENT', `${field} 必须是 ${min}-${max} 的整数`, { field, value })
  }
}

export function validateRunSpec(raw, getEnv) {
  if (!isPlainObject(raw)) fail('INVALID_ARGUMENT', 'spec 必须是对象')
  rejectUnknown(raw, SPEC_KEYS, 'spec')
  if (typeof raw.env_id !== 'string' || !raw.env_id) fail('INVALID_ARGUMENT', 'env_id 必须是非空字符串')
  const envState = getEnv(raw.env_id)
  if (!envState?.env) fail('ENV_UNKNOWN', `环境不存在：${raw.env_id}`, { env_id: raw.env_id })
  if (envState.env.enabled === false) fail('ENV_DISABLED', `环境已停用：${raw.env_id}`)
  if (envState.env.mode !== 'ssh') fail('ENV_MODE_UNSUPPORTED', '容器服务仅支持 ssh 模式的环境', { env_id: raw.env_id, mode: envState.env.mode })

  const image = typeof raw.image === 'string' && raw.image.trim() ? raw.image.trim() : DEFAULT_RUN_IMAGE
  if (!IMAGE_RE.test(image)) fail('INVALID_ARGUMENT', 'image 含非法字符或超长', { image })

  if (!isPlainObject(raw.model)) fail('INVALID_ARGUMENT', 'model 必须是对象 {root, path}')
  rejectUnknown(raw.model, MODEL_KEYS, 'model')
  const root = typeof raw.model.root === 'string' ? raw.model.root.trim() : ''
  if (!root || !ABS_PATH_RE.test(root) || root.includes('..')) fail('INVALID_ARGUMENT', 'model.root 必须是绝对路径且不含 ..', { root })
  const path = typeof raw.model.path === 'string' ? raw.model.path.trim().replace(/\/+$/, '') : ''
  if (!path || !REL_PATH_RE.test(path) || path.split('/').includes('..')) fail('INVALID_ARGUMENT', 'model.path 必须是相对路径且不含 ..', { path })

  let codeRoot = null
  if (raw.code !== undefined && raw.code !== null) {
    if (!isPlainObject(raw.code)) fail('INVALID_ARGUMENT', 'code 必须是对象 {root}')
    rejectUnknown(raw.code, ['root', 'components', 'build'], 'code')
    codeRoot = typeof raw.code.root === 'string' ? raw.code.root.trim().replace(/\/+$/, '') : ''
    if (codeRoot && (!ABS_PATH_RE.test(codeRoot) || codeRoot.includes('..'))) fail('INVALID_ARGUMENT', 'code.root 必须是绝对路径且不含 ..', { root: codeRoot })
  }
  const codeComponents = []
  if (raw.code && raw.code.components !== undefined) {
    if (!Array.isArray(raw.code.components)) fail('INVALID_ARGUMENT', 'code.components 必须是数组')
    for (const item of raw.code.components) {
      if (!isPlainObject(item)) fail('INVALID_ARGUMENT', 'code.components 每项必须是 {component, ref, commit}')
      rejectUnknown(item, ['component', 'ref', 'commit', 'repo'], 'code.components[]')
      const component = String(item.component ?? '')
      if (!CODE_COMPONENTS.includes(component)) fail('INVALID_ARGUMENT', `未知代码组件：${component}`, { component })
      if (codeComponents.some((c) => c.component === component)) fail('INVALID_ARGUMENT', `代码组件重复：${component}`)
      const ref = String(item.ref ?? '').trim()
      if (!ref || !CODE_REF_RE.test(ref)) fail('INVALID_ARGUMENT', `组件 ${component} 的分支/tag 非法`, { component, ref })
      const commit = String(item.commit ?? '').trim()
      if (commit && !/^[0-9a-fA-F]{7,40}$/.test(commit)) fail('INVALID_ARGUMENT', `组件 ${component} 的 commit 必须是 7–40 位十六进制`, { component, commit })
      const repo = String(item.repo ?? '').trim()
      if (repo && !CODE_REPO_RE.test(repo)) fail('INVALID_ARGUMENT', `组件 ${component} 的仓库地址不合法`, { component, repo })
      if (raw.code.build === true && !repo) fail('INVALID_ARGUMENT', `构建模式要求组件 ${component} 提供仓库地址`, { component })
      codeComponents.push({ component, ref, commit: commit || null, repo: repo || null })
    }
  }

  const params = isPlainObject(raw.params) ? raw.params : {}
  rejectUnknown(params, PARAM_KEYS, 'params')
  const port = params.port ?? 18433
  assertIntInRange(port, 'params.port', 1024, 65535)
  const tensorParallel = params.tensor_parallel ?? 1
  assertIntInRange(tensorParallel, 'params.tensor_parallel', 1, 16)
  const maxModelLen = params.max_model_len ?? 131072
  assertIntInRange(maxModelLen, 'params.max_model_len', 256, 262144)
  const healthTimeoutS = params.health_timeout_s ?? 300
  assertIntInRange(healthTimeoutS, 'params.health_timeout_s', 30, 3600)
  const maxNumSeqs = params.max_num_seqs
  if (maxNumSeqs !== undefined) assertIntInRange(maxNumSeqs, 'params.max_num_seqs', 1, 4096)
  const maxNumBatched = params.max_num_batched_tokens
  if (maxNumBatched !== undefined) assertIntInRange(maxNumBatched, 'params.max_num_batched_tokens', 128, 131072)
  const gpuMemory = params.gpu_memory_utilization
  if (gpuMemory !== undefined && (typeof gpuMemory !== 'number' || !Number.isFinite(gpuMemory) || gpuMemory < 0.1 || gpuMemory > 1)) fail('INVALID_ARGUMENT', 'params.gpu_memory_utilization 必须是 0.1–1 的数字')
  const prefixCache = params.enable_prefix_caching
  if (prefixCache !== undefined && typeof prefixCache !== 'boolean') fail('INVALID_ARGUMENT', 'params.enable_prefix_caching 必须是布尔值')
  const enforceEager = params.enforce_eager
  if (enforceEager !== undefined && typeof enforceEager !== 'boolean') fail('INVALID_ARGUMENT', 'params.enforce_eager 必须是布尔值')

  // t139：可选 profile 采集——{enabled:boolean, dir?:远端绝对路径}
  let profile = null
  if (raw.profile !== undefined && raw.profile !== null) {
    if (!isPlainObject(raw.profile)) fail('INVALID_ARGUMENT', 'profile 必须是对象 {enabled, dir?}')
    rejectUnknown(raw.profile, PROFILE_KEYS, 'profile')
    const enabled = raw.profile.enabled === true
    let dir = typeof raw.profile.dir === 'string' ? raw.profile.dir.trim().replace(/\/+$/, '') : ''
    if (dir && (!ABS_PATH_RE.test(dir) || dir.includes('..'))) fail('INVALID_ARGUMENT', 'profile.dir 必须是远端绝对路径且不含 ..', { dir })
    profile = { enabled, dir: dir || null }
  }

  if (!Array.isArray(raw.cards) || raw.cards.length === 0) fail('INVALID_ARGUMENT', 'cards 必须是非空数组')
  const cards = []
  for (const card of raw.cards) {
    if (!Number.isInteger(card) || card < 0 || card > 63) fail('INVALID_ARGUMENT', `非法卡号：${String(card)}（0-63）`, { card })
    if (cards.includes(card)) fail('INVALID_ARGUMENT', `卡号重复：${card}`, { card })
    cards.push(card)
  }
  if (tensorParallel !== cards.length) {
    fail('INVALID_ARGUMENT', `tensor_parallel(${tensorParallel}) 必须等于选中卡数(${cards.length})`, { tensor_parallel: tensorParallel, cards: cards.length })
  }

  const build = raw.code?.build === true
  if (build && codeComponents.length === 0) fail('INVALID_ARGUMENT', '构建模式要求至少一个代码组件')

  return {
    env: envState.env,
    spec: {
      env_id: raw.env_id,
      image,
      model: { root: root.replace(/\/+$/, ''), path },
      code: codeComponents.length ? { root: codeRoot || null, ...(build ? { build: true } : {}), components: codeComponents } : (codeRoot ? { root: codeRoot } : null),
      params: { port, tensor_parallel: tensorParallel, max_model_len: maxModelLen, health_timeout_s: healthTimeoutS, ...(maxNumSeqs !== undefined ? { max_num_seqs: maxNumSeqs } : {}), ...(maxNumBatched !== undefined ? { max_num_batched_tokens: maxNumBatched } : {}), ...(gpuMemory !== undefined ? { gpu_memory_utilization: gpuMemory } : {}), ...(prefixCache !== undefined ? { enable_prefix_caching: prefixCache } : {}), ...(enforceEager !== undefined ? { enforce_eager: enforceEager } : {}) },
      cards,
      ...(profile ? { profile } : {}),
    },
  }
}

function parseUsage(text) {
  // 解析 npu-smi info -t usages -i N 输出中的 "HBM Usage Rate(%) : x" / "Aicore Usage Rate(%) : y"
  let hbm = null
  let aicore = null
  for (const line of String(text ?? '').split('\n')) {
    const idx = line.lastIndexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    const value = Number(line.slice(idx + 1).trim())
    if (!Number.isFinite(value)) continue
    if (key.includes('HBM Usage Rate')) hbm = value
    else if (key.includes('Aicore Usage Rate')) aicore = value
  }
  return { hbm, aicore }
}

export function buildBuildScript(spec) {
  const lines = ['set -euo pipefail', 'export PIP_DISABLE_PIP_VERSION_CHECK=1', 'mkdir -p /opt/dsh-src']
  for (const c of spec.code?.components ?? []) {
    if (!c.repo) continue
    const dir = `/opt/dsh-src/${c.component}`
    lines.push(`if [ -d ${quotePosix(dir + '/.git')} ]; then git -C ${quotePosix(dir)} fetch --all --tags --prune; else git clone --recursive --filter=blob:none --no-checkout ${quotePosix(c.repo)} ${quotePosix(dir)}; fi`)
    lines.push(`git -C ${quotePosix(dir)} checkout ${quotePosix(c.ref)}`)
    if (c.commit) lines.push(`git -C ${quotePosix(dir)} fetch origin ${quotePosix(c.commit)} && git -C ${quotePosix(dir)} checkout ${quotePosix(c.commit)}`)
    lines.push(`git -C ${quotePosix(dir)} submodule update --init --recursive`)
    lines.push(`pip install --no-build-isolation -e ${quotePosix(dir)}`)
  }
  lines.push('exec "$@"')
  return lines.join('\n')
}

export function buildRunArgv(spec, svcId, containerName, { privileged = false, profileDir = null } = {}) {
  // t128②：配方按环境 opt-in（envs.json 顶层 deploy.privilegedHosts，按 hostAlias 或 env id 匹配）：
  // - privileged=true（b01 等驱动 ≥26.0.rc1 的机器）：--privileged（ascend_hal 枚举必需，实测
  //   无特权时 device_count=0 ×10 变体）+ --ipc=host + ASCEND_RT_VISIBLE_DEVICES=选中卡物理序号
  //   （privileged 下不限制会枚举全部 8 卡=隔离失效；实测 =0 时 COUNT=1、=0,1 时 COUNT=2，
  //   与只挂的 --device 节点一一对应）。
  // - privileged=false（默认，安全回退）：不提权、不设 env——旧驱动（25.x，如 c01 25.5.1）下
  //   只挂选中 --device 节点即完成逻辑重映射，最小权限配方。
  // t139 勘误：privileged 下 ASCEND_RT_VISIBLE_DEVICES 取的是**物理卡号**（davinci0..N），
  // 不是逻辑序号——c01 实测 cards=[4]+env=0 会打到物理卡 0（他人满载卡 → NPU OOM 507033）；
  // env=4+只挂 davinci4 才正确隔离。故直接用选中卡的物理序号。
  const visibleDevices = spec.cards.join(',')
  const argv = ['docker', 'run', '-d',
    ...(privileged ? ['--privileged', '--ipc=host'] : []),
    '--name', quotePosix(containerName),
    '--label', `${RUN_CONTAINER_LABEL}=${svcId}`]
  for (const card of spec.cards) argv.push(`--device=/dev/davinci${card}`)
  argv.push('--device=/dev/davinci_manager', '--device=/dev/devmm_svm', '--device=/dev/hisi_hdc',
    '-v', '/usr/local/Ascend/driver:/usr/local/Ascend/driver:ro',
    '-v', '/usr/local/dcmi:/usr/local/dcmi:ro',
    '-v', '/etc/ascend_install.info:/etc/ascend_install.info:ro',
    '-v', `${quotePosix(spec.model.root)}:/models:ro`,
    ...(spec.code?.root ? ['-v', `${quotePosix(spec.code.root)}:/code:ro`] : []),
    // t139：profile 输出目录（可写挂载；启动前已在远端 mkdir -p -m 700）
    ...(profileDir ? ['-v', `${quotePosix(profileDir)}:${PROFILE_MOUNT}`] : []),
    '-p', `127.0.0.1:${spec.params.port}:${spec.params.port}`,
    ...(privileged ? ['-e', `ASCEND_RT_VISIBLE_DEVICES=${visibleDevices}`] : []),
    // t126④：'--' 分隔符保证 image 即使以 '-' 开头也不会被 docker 当选项（校验层已拒绝，双保险）。
    '--',
    quotePosix(spec.image),
    ...(spec.code?.build ? ['bash', '-lc', quotePosix(buildBuildScript(spec)), '--'] : []),
    'vllm', 'serve', quotePosix(`/models/${spec.model.path}`),
    '--served-model-name', quotePosix(spec.model.path.split('/').pop()),
    '--port', String(spec.params.port),
    '--tensor-parallel-size', String(spec.params.tensor_parallel),
    '--max-model-len', String(spec.params.max_model_len),
    ...(spec.params.max_num_seqs !== undefined ? ['--max-num-seqs', String(spec.params.max_num_seqs)] : []),
    ...(spec.params.max_num_batched_tokens !== undefined ? ['--max-num-batched-tokens', String(spec.params.max_num_batched_tokens)] : []),
    ...(spec.params.gpu_memory_utilization !== undefined ? ['--gpu-memory-utilization', String(spec.params.gpu_memory_utilization)] : []),
    ...(spec.params.enable_prefix_caching === true ? ['--enable-prefix-caching'] : spec.params.enable_prefix_caching === false ? ['--no-enable-prefix-caching'] : []),
    // t139（captain 实测勘误）：profile 采集**必须 --enforce-eager**——ACL/CUDA graph 捕获路径只产
    // torch trace.json.gz，不出 Ascend op_statistic.csv（c01 3B 三轮复现：rank0_* 目录空 600s+）。
    // 开启 profile 时强制 eager（用户显式传 false 也覆盖，preview/文档已注明取舍）。
    ...((spec.params.enforce_eager === true || profileDir) ? ['--enforce-eager'] : []),
    // t139：vLLM torch profiler（服务 healthy 后由本插件触发 /start_profile→2 请求→/stop_profile）
    ...(profileDir ? ['--profiler-config', quotePosix(PROFILER_CONFIG_JSON)] : []))
  return argv
}

function specDigest(spec, containerName) {
  return createHash('sha256').update(JSON.stringify({ spec, containerName })).digest('hex')
}

function runEnvelope(kind, { status = 'ok', data = null, error = null, warnings = [], executes = false } = {}) {
  return {
    schema: DEPLOY_RUN_SCHEMA,
    kind,
    status,
    readonly: !executes,
    effects: {
      remote_readonly: !executes,
      host_private_write: false,
      process_mutation: executes,
      benchmark_traffic: false,
      remote_write: executes,
    },
    source: { mode: executes ? 'exec' : 'dry-run', executes },
    warnings,
    data,
    error,
  }
}

function runErrorPayload(error) {
  if (error instanceof TuneApiError) {
    return { code: error.code, message: error.message, retryable: false, details: error.details ?? null }
  }
  if (error && typeof error.code === 'string' && error.code) {
    return {
      code: error.code,
      message: String(error?.message ?? error).slice(0, 500),
      retryable: false,
      details: error.details ?? null,
    }
  }
  return { code: 'INTERNAL_ERROR', message: String(error?.message ?? error).slice(0, 500), retryable: false, details: null }
}

export class DeployRunService {
  constructor({ getEnv, execSsh, isRealExecutionEnabled = () => false, now = () => new Date(), listEnvs = () => [], getDeployConfig = null, profileImporter = null }) {
    if (typeof execSsh !== 'function') throw new Error('DeployRunService 需要 execSsh 注入')
    this._getEnv = getEnv
    this._execSsh = execSsh
    this._isRealExecutionEnabled = isRealExecutionEnabled
    this._listEnvs = listEnvs
    // t128②：deploy 段配置注入（privilegedHosts：显式 opt-in 特权配式的环境清单）
    this._getDeployConfig = typeof getDeployConfig === 'function' ? getDeployConfig : () => ({})
    this._now = () => { const t = now(); return t instanceof Date ? t.getTime() : Number(t) }
    /** @type {Map<string, {token:string,digest:string,expires_at:number,spec:object,container_name:string,svc_id:string}>} */
    this._confirmations = new Map()
    /** @type {Map<string, object>} svc_id -> instance */
    this._instances = new Map()
    /** @type {Map<string, {env_id:string,host:string,cards:number[],port:number,container_name:string}>} svc_id -> reservation（t126②：docker run 前原子占位） */
    this._reservations = new Map()
    // t139：profile 导入器注入（测试 mock 用）；缺省懒构造 ProfileService——
    // dataDir 与 index.js normalizeConfig 默认一致（可用 DSH_ASCEND_PERF_DATA_DIR 覆盖），
    // 面板的 /profile/sessions 每次读盘 index.json，能立即看到新导入的 session。
    this._profileImporterFn = profileImporter
    this._profileService = null
  }

  // t139：默认导入器——把采集到的 op_statistic.csv 交给现有 ProfileService（不改其规则）
  _defaultProfileImporter({ content, envId, metadata }) {
    if (!this._profileService) {
      this._profileService = createProfileService({ dataDir: process.env.DSH_ASCEND_PERF_DATA_DIR ?? join(homedir(), '.local/share', 'dsh-ascend-perf') })
    }
    return this._profileService.importFiles({ files: [{ name: 'op_statistic.csv', content }], mode: 'upload', envId, metadata, policy: 'strict' })
  }

  // t139：profile 输出目录解析——显式 spec.profile.dir > code.root/profiles > $HOME/.dsh-ascend-perf-profiles；
  // 返回 `${base}/${containerName}`（base 末尾斜杠已归一）。
  async _resolveProfileDir(spec, env, containerName) {
    let base = spec.profile?.dir || null
    if (!base && spec.code?.root) base = `${spec.code.root.replace(/\/+$/, '')}/profiles`
    if (!base) {
      const probe = await this._ssh(env, 'printf %s "$HOME"', 10000)
      const home = String(probe.stdout ?? '').trim()
      if (probe.exitCode !== 0 || !home || !home.startsWith('/')) {
        fail('SSH_UNAVAILABLE', `无法解析远端 HOME（用于默认 profile 目录，exit ${probe.exitCode}）：${(probe.stderr ?? '').slice(0, 200)}`)
      }
      base = `${home}/.dsh-ascend-perf-profiles`
    }
    return `${base}/${containerName}`
  }

  // t128②：特权配方判定——仅当 envs.json 顶层 deploy.privilegedHosts 显式列出该环境的
  // hostAlias 或 env id 才启用 --privileged/--ipc=host/ASCEND_RT_VISIBLE_DEVICES；其余环境
  // 一律走非特权安全回退（旧驱动 25.x 的最小权限配方）。
  _privilegedFor(env) {
    try {
      const config = this._getDeployConfig() ?? {}
      const hosts = Array.isArray(config.privilegedHosts) ? config.privilegedHosts.filter((x) => typeof x === 'string') : []
      return hosts.includes(env.hostAlias) || hosts.includes(env.id)
    } catch {
      return false
    }
  }

  _ssh(env, command, timeoutMs = 20000) {
    return this._execSsh(env.hostAlias, command, timeoutMs)
  }

  async _checkCardIdle(env, card) {
    const npuSmi = quotePosix(env.npuSmiPath || 'npu-smi')
    const probe = await this._ssh(env, `${npuSmi} info -t usages -i ${card}`, 20000)
    if (probe.exitCode === 255) fail('SSH_UNAVAILABLE', `SSH 连接失败（exit 255）：${(probe.stderr ?? '').slice(0, 200) || '无 stderr'}`)
    if (probe.exitCode !== 0) fail('SSH_UNAVAILABLE', `读取卡 ${card} 的 npu-smi usages 失败（exit ${probe.exitCode}）：${(probe.stderr ?? '').slice(0, 200)}`)
    const { hbm, aicore } = parseUsage(probe.stdout)
    if (hbm === null || aicore === null) {
      fail('SSH_UNAVAILABLE', `卡 ${card} 的 usages 输出无法解析（HBM=${String(hbm)} AICore=${String(aicore)}）`)
    }
    const idle = hbm < 10 && aicore < 5
    return { card, hbm, aicore, idle }
  }

  async _precheck(spec, env) {
    const warnings = []
    const cards = []
    // t130：cards 现在是逻辑 chip/device 序号。c01 A3 8 卡×2 chip -> device 0..15；
    // b01 8 卡×1 chip -> device 0..7。容器仍按 device 挂 --device=/dev/davinciN，
    // 空闲预检按该 device 所在整卡做（容器暴露整卡，保守拒绝部分占用）。
    const snapshotCards = this._getEnv?.(env.id)?.record?.snapshot?.npu?.cards ?? env?.snapshot?.npu?.cards ?? []
    const deviceToCard = []
    for (const card of snapshotCards) {
      const chips = Array.isArray(card?.chips) ? card.chips : []
      if (chips.length === 0) {
        deviceToCard.push({ card_id: card?.card_id, chip_id: null })
      } else {
        for (const chip of chips) deviceToCard.push({ card_id: card?.card_id, chip_id: chip?.chip_id ?? null })
      }
    }
    const checked = new Map()
    for (const device of spec.cards) {
      if (deviceToCard.length > 0 && device >= deviceToCard.length) {
        fail('INVALID_ARGUMENT', `设备 ${device} 超出该环境可见 chip 数（${deviceToCard.length}）`, { device, total: deviceToCard.length })
      }
      const target = deviceToCard[device] ?? { card_id: device, chip_id: null }
      const cardId = target.card_id
      let row = checked.get(cardId)
      if (!row) {
        row = await this._checkCardIdle(env, cardId)
        checked.set(cardId, row)
      }
      if (!row.idle) {
        fail('CHIP_BUSY', `chip/设备 ${device}（卡 ${cardId}）不空闲（HBM ${row.hbm}% / AICore ${row.aicore}%，阈值 HBM<10 且 AICore<5）`, { card: cardId, device, hbm: row.hbm, aicore: row.aicore })
      }
      cards.push({ ...row, device, chip_id: target.chip_id })
    }
    const portProbe = await this._ssh(env, `ss -ltn 2>/dev/null | grep -q ':${spec.params.port} ' && echo BUSY || true`, 15000)
    if (portProbe.exitCode !== 0) fail('SSH_UNAVAILABLE', `端口检查失败（exit ${portProbe.exitCode}）：${(portProbe.stderr ?? '').slice(0, 200)}`)
    if (String(portProbe.stdout ?? '').includes('BUSY')) {
      fail('PORT_IN_USE', `端口 ${spec.params.port} 已在 ${env.hostAlias} 上监听`, { port: spec.params.port })
    }
    const imageProbe = await this._ssh(env, `docker image inspect --format '{{.Id}}' -- ${quotePosix(spec.image)} >/dev/null 2>&1 && echo FOUND || echo MISSING`, 30000)
    if (!String(imageProbe.stdout ?? '').includes('FOUND')) {
      fail('IMAGE_NOT_FOUND', `镜像不存在于 ${env.hostAlias}：${spec.image}`, { image: spec.image })
    }
    const modelDir = `${quotePosix(spec.model.root)}/${quotePosix(spec.model.path)}`
    const dirProbe = await this._ssh(env, `test -d ${modelDir}`, 15000)
    if (dirProbe.exitCode !== 0) {
      fail('MODEL_DIR_MISSING', `模型目录不存在于 ${env.hostAlias}：${modelDir}`, { dir: modelDir })
    }
    if (spec.code?.root) {
      const codeProbe = await this._ssh(env, `test -d ${quotePosix(spec.code.root)}`, 15000)
      if (codeProbe.exitCode !== 0) fail('MODEL_DIR_MISSING', `代码目录不存在于 ${env.hostAlias}：${spec.code.root}`, { dir: spec.code.root })
    }
    return { warnings, cards }
  }

  async preview(raw, { origin = 'rest' } = {}) {
    const { env, spec } = validateRunSpec(raw, this._getEnv)
    const svcId = `svc-${randomUUID().replace(/-/g, '').slice(0, 6)}`
    const containerName = `${RUN_CONTAINER_PREFIX}${spec.model.path.split('/').pop().toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${svcId.slice(4)}`
    const pre = await this._precheck(spec, env)
    // t128②：配方按环境 opt-in；preview 如实展示将使用的配方与风险提示（非特权回退 + 特权例外）。
    const privileged = this._privilegedFor(env)
    // t139：preview 如实展示 profile 挂载与采集计划（只读探测远端目录基址，不创建）
    let profileDir = null
    if (spec.profile?.enabled) profileDir = await this._resolveProfileDir(spec, env, containerName)
    const argv = buildRunArgv(spec, svcId, containerName, { privileged, profileDir })
    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 8)
    const expiresAt = this._now() + CONFIRMATION_TTL_MS
    this._confirmations.set(token, { token, digest: specDigest(spec, containerName), expires_at: expiresAt, spec, container_name: containerName, svc_id: svcId })
    const warnings = [...pre.warnings]
    if (spec.code?.build) {
      warnings.push('构建模式：容器启动前在容器内 clone/checkout + pip install -e 五个组件；首次可能 10–60 分钟，构建失败服务不会就绪；repo 必须在容器网络内可达（c01 的 GitHub 直连不通，需用可达镜像源/内网仓库）')
    } else if (spec.code?.components?.length) {
      warnings.push('代码分支已记录到运行规格，但未开启构建；实际启动仍使用镜像内代码')
    }
    if (privileged) {
      warnings.push('特权配方（该环境已列入 deploy.privilegedHosts，适用驱动 ≥26.0.rc1，如 b01）：--privileged 放大容器权限，已用 ASCEND_RT_VISIBLE_DEVICES=选中卡物理序号 + 只挂选中 --device 限制可见卡；请仅对可信镜像使用')
    } else {
      warnings.push('基线配方（非特权，默认安全回退）：适用于 25.x 驱动（如 c01 25.5.1）；若该机驱动 ≥26.0（如 b01 26.0.rc1）会因 ascend_hal 枚举失败无法启动——需在 envs.json 顶层 deploy.privilegedHosts 显式列入该环境')
    }
    if (spec.profile?.enabled) {
      warnings.push(`profile 采集已开启：强制 --enforce-eager（graph 捕获路径只出 torch trace、不出 Ascend op_statistic——c01 3B 实测）；服务 healthy 后自动 /start_profile → 2 个 max_tokens=32 请求 → /stop_profile，轮询等待 msprof 异步导出后把 op_statistic.csv 导入性能调优段（kernel_details 约 20MB 暂不导入）；采集失败不影响已启动的服务`)
    }
    return runEnvelope('preview', {
      data: {
        service_id: svcId,
        container_name: containerName,
        env: { id: env.id, name: env.name, host_alias: env.hostAlias },
        cards: pre.cards,
        code_components: spec.code?.components ?? [],
        argv,
        profile: spec.profile?.enabled ? { enabled: true, dir: profileDir } : null,
        recipe: privileged ? 'privileged-isolated' : 'baseline-sandboxed',
        confirmation_token: token,
        confirmation_expires_at: new Date(expiresAt).toISOString(),
        gates: {
          real_execution: this._isRealExecutionEnabled(),
          privileged_opt_in: privileged,
          confirmation_required: true,
          how_to_enable: '在 envs.json 增加 "deploy": {"allowRealExecution": true} 并点「重新加载配置」',
        },
        origin,
      },
      warnings,
    })
  }

  _consumeConfirmation(token, spec, containerName) {
    const entry = this._confirmations.get(token)
    if (!entry) fail('INVALID_CONFIRMATION', '确认令牌无效（请先执行预览）', { reason: 'unknown_token' })
    if (this._now() > entry.expires_at) {
      this._confirmations.delete(token)
      fail('INVALID_CONFIRMATION', '确认令牌已过期（10 分钟），请重新预览', { reason: 'expired' })
    }
    const digest = specDigest(spec, containerName)
    if (digest !== entry.digest) fail('INVALID_CONFIRMATION', '确认令牌与当前 spec 不匹配（预览后 spec 变了？请重新预览）', { reason: 'digest_mismatch' })
    this._confirmations.delete(token)
    return entry
  }

  async start(raw, { origin = 'rest' } = {}) {
    if (!this._isRealExecutionEnabled()) {
      fail('REAL_EXECUTION_DISABLED', '真实执行未启用：在 envs.json 增加 "deploy": {"allowRealExecution": true} 并重新加载配置（fail-closed）')
    }
    const { confirmation_token: token, ...specRaw } = isPlainObject(raw) ? raw : {}
    if (typeof token !== 'string' || !token) {
      fail('INVALID_CONFIRMATION', '缺少 confirmation_token（先 preview 再 start）')
    }
    const { env, spec } = validateRunSpec(specRaw, this._getEnv)
    // 令牌绑定的是预览时的 spec + 容器名；start 必须复用预览容器名（不接受调用方自造名字）
    const probe = this._confirmations.get(token)
    if (!probe) fail('INVALID_CONFIRMATION', '确认令牌无效（请先执行预览）', { reason: 'unknown_token' })
    this._consumeConfirmation(token, spec, probe.container_name)
    // t126②：docker run 前原子占位（同步检查+插入，单线程内原子）；同环境/同主机的卡或端口
    // 冲突、或已有活跃实例重复 start 一律拒绝——预检的 npu-smi 采样与 docker run 之间仍有窗口，
    // 占位表把这个窗口关掉（对已登记实例同样生效）。
    this._assertNoReservationConflict(spec, env)
    this._reservations.set(probe.svc_id, { env_id: env.id, host: env.hostAlias, cards: [...spec.cards], port: spec.params.port, container_name: probe.container_name })
    let containerId = null
    let precheckCards = null
    let profileDir = null
    try {
      const pre = await this._precheck(spec, env) // 门后重跑预检：预览到 start 之间卡可能被占
      precheckCards = pre.cards
      const privileged = this._privilegedFor(env)
      // t139：profile.enabled 时启动前创建远端输出目录（0700，失败即拒启动——挂载点必须存在且属主正确）
      if (spec.profile?.enabled) {
        profileDir = await this._resolveProfileDir(spec, env, probe.container_name)
        const mk = await this._ssh(env, `mkdir -p -m 700 ${quotePosix(profileDir)}`, 15000)
        if (mk.exitCode !== 0) {
          fail('SSH_UNAVAILABLE', `远端 profile 目录创建失败（exit ${mk.exitCode}）：${(mk.stderr ?? '').slice(0, 200)}`, { dir: profileDir })
        }
      }
    const argv = buildRunArgv(spec, probe.svc_id, probe.container_name, { privileged, profileDir })
      const run = await this._ssh(env, argv.join(' '), 60000)
      containerId = String(run.stdout ?? '').trim().split('\n')[0] || null
      if (run.exitCode !== 0) {
        // t126⑥：启动失败按前缀+label 清理自有容器（刚创建的容器可能处于 Created/Exited 态），
        // 避免半启动残留；清理失败不掩盖原始错误。
        await this._cleanupContainerQuietly(env.hostAlias, probe.container_name)
        fail('DOCKER_ERROR', `docker run 失败（exit ${run.exitCode}），已尝试清理自有容器：${(run.stderr ?? '').slice(0, 300)}`, { container: probe.container_name })
      }
    } catch (error) {
      this._reservations.delete(probe.svc_id)
      throw error
    }
    const instance = {
      service_id: probe.svc_id,
      container_name: probe.container_name,
      env_id: env.id,
      host_alias: env.hostAlias,
      cards: spec.cards,
      port: spec.params.port,
      image: spec.image,
      model: `/models/${spec.model.path}`,
      started_at: new Date(this._now()).toISOString(),
      health_timeout_s: spec.params.health_timeout_s,
      origin,
      // t139：profile 采集状态机 pending→collecting→imported|failed；skipped=未开启
      profile: { state: spec.profile?.enabled ? 'pending' : 'skipped' },
      profile_dir: profileDir,
      served_name: spec.model.path.split('/').pop(),
    }
    this._instances.set(instance.service_id, instance)
    return runEnvelope('start', {
      data: { instance, docker_container_id: containerId, precheck_cards: precheckCards },
      executes: true,
    })
  }

  _resolveInstance(idOrName) {
    if (this._instances.has(idOrName)) return this._instances.get(idOrName)
    for (const instance of this._instances.values()) {
      if (instance.container_name === idOrName) return instance
    }
    return null
  }

  // t126②：占位冲突检查——同环境或同主机的活跃占位/已登记实例，卡集合相交或端口相同即拒绝。
  _assertNoReservationConflict(spec, env) {
    const candidates = []
    for (const r of this._reservations.values()) candidates.push({ svc_id: r.svc_id ?? '', env_id: r.env_id, host: r.host, cards: r.cards, port: r.port, container_name: r.container_name })
    for (const instance of this._instances.values()) candidates.push({ svc_id: instance.service_id, env_id: instance.env_id, host: instance.host_alias, cards: instance.cards ?? [], port: instance.port, container_name: instance.container_name })
    for (const other of candidates) {
      const sameTarget = other.env_id === env.id || other.host === env.hostAlias
      if (!sameTarget) continue
      const sharedCards = (other.cards ?? []).filter((card) => spec.cards.includes(card))
      if (sharedCards.length > 0) {
        fail('RESERVATION_CONFLICT', `卡 ${sharedCards.join(',')} 已被 ${other.svc_id || other.container_name} 占用（活跃实例或启动占位）；拒绝重复 start`, { cards: sharedCards, held_by: other.svc_id || other.container_name })
      }
      if (other.port === spec.params.port) {
        fail('RESERVATION_CONFLICT', `端口 ${spec.params.port} 已被 ${other.svc_id || other.container_name} 占用；拒绝重复 start`, { port: spec.params.port, held_by: other.svc_id || other.container_name })
      }
    }
  }

  // t126⑥：静默清理自有容器（前缀+label 双校验后才执行；清理失败不抛）。
  async _cleanupContainerQuietly(hostAlias, containerName) {
    try {
      const info = await this._inspectGuarded(containerName, hostAlias)
      if (!info) return
      this._guardOwnContainer(info, containerName)
      await this._execSsh(hostAlias, `docker rm -f ${quotePosix(containerName)} >/dev/null 2>&1 || true`, 30000)
    } catch { /* best effort：不掩盖原始错误 */ }
  }

  // t126①：重启后的接管查询——对 dsh-apf-svc-* 容器名逐环境 docker inspect，
  // 找到后严格校验前缀+label（label 非空），返回接管态伪实例（无登记信息：端口/启动时间未知）。
  async _adoptByName(name) {
    if (typeof name !== 'string' || !/^dsh-apf-svc-[a-z0-9][a-z0-9-]{0,80}$/.test(name)) return null
    for (const env of this._listEnvs()) {
      if (!env || env.enabled === false || env.mode !== 'ssh' || !env.hostAlias) continue
      const info = await this._inspectGuarded(name, env.hostAlias)
      if (!info) continue
      this._guardOwnContainer(info, name) // 前缀+label 非空
      // t128④：接管态 label 严格校验——本插件容器名恒为 dsh-apf-svc-<slug>-<6hex> 且
      // label=dsh-ascend-perf.service=svc-<同 6hex>。label 必须符合 service-id 模式并与
      // 容器名后缀一致；「非空但错误」（他人容器/伪造）拒绝接管。
      if (!/^svc-[a-z0-9][a-z0-9-]{0,40}$/.test(info.label) || !info.name.endsWith(`-${info.label.slice(4)}`)) {
        fail('FORBIDDEN', `拒绝接管：容器 ${info.name} 的 ${RUN_CONTAINER_LABEL} 标签（${info.label}）与容器名后缀不一致，非本插件创建的容器`, { container: info.name, label: info.label })
      }
      return {
        instance: {
          service_id: info.label, // 接管态以容器 label 作为 service_id（stop/logs 守卫沿用）
          container_name: info.name || name,
          env_id: env.id,
          host_alias: env.hostAlias,
          cards: [], port: null, image: null, model: null,
          started_at: null, health_timeout_s: null,
          adopted: true, // 本会话未登记：状态/日志/停止按容器名接管
        },
        info,
      }
    }
    return null
  }

  async _inspectGuarded(idOrName, hostAlias) {
    // 守卫：只允许查自有前缀容器；label 校验在 stop/logs 等写操作前强制
    const probe = await this._execSsh(hostAlias, `docker inspect --format '{{.Name}}|{{.State.Running}}|{{.State.ExitCode}}|{{index .Config.Labels "${RUN_CONTAINER_LABEL}"}}' ${quotePosix(idOrName)} 2>/dev/null || echo INSPECT_FAILED`, 20000)
    if (String(probe.stdout ?? '').trim() === 'INSPECT_FAILED' || probe.exitCode !== 0) return null
    const [name, running, exitCode, label] = String(probe.stdout ?? '').trim().split('|')
    return { name: (name ?? '').replace(/^\//, ''), running: running === 'true', exit_code: Number(exitCode), label: label ?? '' }
  }

  // t126⑤：统一守卫——前缀 + label 非空 +（提供 expectedServiceId 时）label 必须精确等于期望值。
  // status/logs/stop 全部经此守卫；「label 非空但值错误」一律 FORBIDDEN。
  _guardOwnContainer(info, idOrName, expectedServiceId = null) {
    if (!info) fail('INSTANCE_UNKNOWN', `容器不存在：${idOrName}`)
    if (!info.name.startsWith(RUN_CONTAINER_PREFIX)) {
      fail('FORBIDDEN', `拒绝操作：容器名 ${info.name} 不带 ${RUN_CONTAINER_PREFIX} 前缀（只允许管理本插件启动的容器）`, { container: info.name })
    }
    if (!info.label) {
      fail('FORBIDDEN', `拒绝操作：容器 ${info.name} 缺少 ${RUN_CONTAINER_LABEL} 标签`, { container: info.name })
    }
    if (expectedServiceId !== null && info.label !== expectedServiceId) {
      fail('FORBIDDEN', `拒绝操作：容器 ${info.name} 的 ${RUN_CONTAINER_LABEL} 标签不匹配（期望 ${expectedServiceId}，实际 ${info.label}）`, { container: info.name, expected: expectedServiceId, actual: info.label })
    }
  }

  async status(idOrName, { origin = 'rest' } = {}) {
    let instance = this._resolveInstance(idOrName)
    if (!instance) {
      // t126①：插件重启后内存登记为空——对自有容器名做接管查询（逐环境 inspect + 前缀/label 守卫）
      const adopted = await this._adoptByName(idOrName)
      if (!adopted) fail('INSTANCE_UNKNOWN', `实例不存在（本会话未登记，也未找到可接管的自有容器）：${idOrName}`)
      instance = adopted.instance
      const running = adopted.info.running
      const health = running ? 'running' : (adopted.info.exit_code === 0 ? 'stopped' : 'error')
      return runEnvelope('status', { data: { ...instance, health, container: adopted.info, note: '接管查询：插件重启前启动的容器，端口/启动时间未知（健康探测不可用）' } })
    }
    const hostAlias = instance.host_alias
    const info = await this._inspectGuarded(instance.container_name, hostAlias)
    if (!info) {
      this._releaseReservation(instance)
      return runEnvelope('status', { data: { ...instance, health: 'gone' } })
    }
    this._guardOwnContainer(info, instance.container_name, instance.service_id)
    let health = 'starting'
    let cleanup = null
    if (!info.running) {
      health = info.exit_code === 0 ? 'stopped' : 'error'
    } else {
      const curl = await this._execSsh(hostAlias, `curl -sf --max-time 5 http://127.0.0.1:${instance.port}/v1/models >/dev/null 2>&1 && echo HEALTHY || echo NOT_YET`, 15000)
      if (String(curl.stdout ?? '').includes('HEALTHY')) {
        health = 'healthy'
        // t139：首次 healthy 触发一次采集（start/2×completions/stop），此后每次 status 有界等待导出；
        // 失败/超时只记录，绝不碰服务。状态机保证三步采集只跑一次。
        if (instance.profile?.state === 'pending') {
          try {
            await this._beginProfileCapture(instance)
          } catch (error) {
            instance.profile = { state: 'failed', error: String(error?.message ?? error).slice(0, 300), dir: instance.profile_dir }
          }
        }
        if (instance.profile?.state === 'collecting') {
          const startedAt = Number(instance.profile.started_at ?? 0)
          const elapsed = startedAt > 0 ? this._now() - startedAt : Infinity
          const content = elapsed < PROFILER_EXPORT_TIMEOUT_MS ? await this._awaitProfileExport(instance) : null
          if (content) {
            try {
              await this._importProfile(instance, content)
            } catch (error) {
              instance.profile = { state: 'failed', error: String(error?.message ?? error).slice(0, 300), dir: instance.profile_dir }
            }
          } else if (elapsed >= PROFILER_EXPORT_TIMEOUT_MS) {
            instance.profile = { state: 'failed', error: `msprof 导出超时（${Math.round(PROFILER_EXPORT_TIMEOUT_MS / 1000)}s 内未见 rank0*/ASCEND_PROFILER_OUTPUT/op_statistic.csv）`, dir: instance.profile_dir }
          }
          // 仍无文件且未超时 → 保持 collecting，下一次 status 继续等（服务不受影响）。
        }
      } else if (this._now() - Date.parse(instance.started_at) > instance.health_timeout_s * 1000) {
        // 健康超时：清掉自有容器（前缀+label 守卫已过），诚实报 error
        await this._execSsh(hostAlias, `docker rm -f ${quotePosix(instance.container_name)} >/dev/null 2>&1 || true`, 30000)
        health = 'error'
        cleanup = `health timeout after ${instance.health_timeout_s}s (container removed)`
      }
    }
    if (health === 'stopped' || health === 'error' || health === 'gone') {
      this._instances.delete(instance.service_id)
      this._releaseReservation(instance)
    }
    const statusWarnings = []
    if (instance.profile?.state === 'failed') {
      statusWarnings.push(`profile 采集失败（已启动的服务不受影响，可在「性能调优」段手动导入）：${instance.profile.error ?? '未知错误'}`)
    }
    return runEnvelope('status', { data: { ...instance, health, container: info, cleanup }, warnings: statusWarnings })
  }

  // t139：一次性 profile 采集——/start_profile → 2×/v1/completions(max_tokens 32) → /stop_profile
  // → 读回 rank0*/ASCEND_PROFILER_OUTPUT/op_statistic.csv → 交给 ProfileService 导入。
  // 任何一步失败抛 PROFILE_CAPTURE_FAILED（由调用方置 failed；绝不停止/回滚服务）。
  // t139：profile 采集是**跨多次 status 调用的可恢复状态机**——msprof 导出在 stop_profile 后
  // 异步进行且可达数分钟（c01 3B 实测：trace.gz 先落、rank0_* 目录次之、CSV 最后，全程可超 120s），
  // 单次 ssh 长轮询既阻塞 status 又容易在导出完成前被判失败。改为：
  //   pending →（status 触发一次 start/2×completions/stop）→ collecting(started_at) →
  //   （每次 status 有界等待 PROFILER_EXPORT_POLL_LOOPS×POLL_S）→ imported / failed(累计超时 PROFILER_EXPORT_TIMEOUT_MS)。
  async _beginProfileCapture(instance) {
    const port = instance.port
    const model = instance.served_name ?? String(instance.model ?? '').split('/').pop()
    const post = async (path, body = null) => {
      const json = body === null ? '' : ` -H 'Content-Type: application/json' -d ${quotePosix(JSON.stringify(body))}`
      const probe = await this._execSsh(instance.host_alias, `curl -sf -X POST --max-time 30 http://127.0.0.1:${port}${path}${json} >/dev/null 2>&1`, 45000)
      if (probe.exitCode !== 0) fail('PROFILE_CAPTURE_FAILED', `curl ${path} 失败（exit ${probe.exitCode}）：profile 采集中断`, { path })
      return probe
    }
    await post('/start_profile')
    try {
      await post('/v1/completions', { model, prompt: 'dsh-ascend-perf profile capture request 1', max_tokens: 32 })
      await post('/v1/completions', { model, prompt: 'dsh-ascend-perf profile capture request 2', max_tokens: 32 })
    } finally {
      try { await post('/stop_profile') } catch { /* 采集已失败，停止尽力而为，不掩盖原始错误 */ }
    }
    instance.profile = { state: 'collecting', dir: instance.profile_dir, started_at: this._now() }
  }

  // 单次 status 内的有界等待：找 CSV（最多 4×5s）；返回 CSV 内容或 null（仍无 → 下次 status 继续，直到超时）。
  async _awaitProfileExport(instance) {
    const dir = instance.profile_dir
    // t139b：rank0_* 由容器内 root 创建（目录 700，宿主用户不可读），不能用宿主 ls/cat 判断。
    // 用同一服务镜像起一个只读一次性容器，在容器内 find+cat；镜像已在目标机（服务由它启动）。
    const read = await this._execSsh(instance.host_alias, `f=""; for i in $(seq 1 ${PROFILER_EXPORT_POLL_LOOPS}); do f=$(docker run --rm -v ${quotePosix(dir)}:/prof ${quotePosix(instance.image)} bash -lc "find /prof -name op_statistic.csv -print -quit" 2>/dev/null | head -1); if [ -n "$f" ]; then break; fi; sleep ${PROFILER_EXPORT_POLL_S}; done; if [ -n "$f" ]; then docker run --rm -v ${quotePosix(dir)}:/prof ${quotePosix(instance.image)} bash -lc "cat '$f'" 2>/dev/null; fi`, 60000)
    const content = String(read.stdout ?? '')
    return read.exitCode === 0 && content.trim() ? content : null
  }

  async _importProfile(instance, content) {
    const model = instance.served_name ?? String(instance.model ?? '').split('/').pop()
    const importer = this._profileImporterFn ?? ((args) => this._defaultProfileImporter(args))
    const imported = await importer({
      content,
      envId: instance.env_id,
      // manifest 持久化 model_name/env_id；image/service_id 一并传入（profile.js 的 metadata
      // 只持久化四键，其余记录在运行实例的 profile 字段里供 UI 展示）
      metadata: { model_name: model, model_revision: instance.image ?? null, env: instance.env_id, image: instance.image, service_id: instance.service_id },
    })
    if (!imported?.session_id) {
      fail('PROFILE_CAPTURE_FAILED', `profile 导入未返回 session_id：${JSON.stringify(imported ?? null).slice(0, 200)}`)
    }
    instance.profile = { state: 'imported', session_id: imported.session_id, dir: instance.profile_dir }
  }

  // t126②：终态/停止后释放占位（按 service_id 或容器名匹配）。
  _releaseReservation(instance) {
    if (!instance) return
    for (const [svcId, r] of this._reservations.entries()) {
      if (svcId === instance.service_id || r.container_name === instance.container_name) {
        this._reservations.delete(svcId)
      }
    }
  }

  async listInstances({ origin = 'rest' } = {}) {
    // 以内存登记为准；跨重启的遗留容器需要用户用容器名单独查/停
    const instances = []
    for (const instance of this._instances.values()) {
      instances.push({ ...instance })
    }
    instances.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
    return runEnvelope('instances', { data: { instances } })
  }

  async logs(idOrName, { tail = 100, origin = 'rest' } = {}) {
    let instance = this._resolveInstance(idOrName)
    if (!instance) {
      const adopted = await this._adoptByName(idOrName)
      if (!adopted) fail('INSTANCE_UNKNOWN', `实例不存在（本会话未登记，也未找到可接管的自有容器）：${idOrName}`)
      instance = adopted.instance
    }
    const tailN = Math.min(Math.max(Number.isInteger(tail) ? tail : 100, 10), 1000)
    const info = await this._inspectGuarded(instance.container_name, instance.host_alias)
    this._guardOwnContainer(info, instance.container_name, instance.adopted ? null : instance.service_id)
    const probe = await this._execSsh(instance.host_alias, `docker logs --tail ${tailN} ${quotePosix(instance.container_name)} 2>&1`, 20000)
    if (probe.exitCode !== 0) fail('DOCKER_ERROR', `docker logs 失败（exit ${probe.exitCode}）：${(probe.stderr ?? '').slice(0, 200)}`)
    return runEnvelope('logs', { data: { container_name: instance.container_name, tail: tailN, log: String(probe.stdout ?? '').slice(0, 64 * 1024) } })
  }

  async stop(idOrName, { origin = 'rest' } = {}) {
    let instance = this._resolveInstance(idOrName)
    if (!instance) {
      // t126①：重启后按容器名接管停止（captain 实测 svc-xxx 停不掉即此缺口）
      const adopted = await this._adoptByName(idOrName)
      if (!adopted) fail('INSTANCE_UNKNOWN', `实例不存在（本会话未登记，也未找到可接管的自有容器）：${idOrName}`)
      instance = adopted.instance
    }
    const info = await this._inspectGuarded(instance.container_name, instance.host_alias)
    // t126⑤：统一守卫（接管态无期望 service_id，label 非空即可；登记态必须精确匹配）
    this._guardOwnContainer(info, instance.container_name, instance.adopted ? null : instance.service_id)
    // t126⑥：停止语义 = docker stop -t 30 后 **docker rm**（自有容器不保留 Exited 态，避免 stopped 容器累积）
    const probe = await this._execSsh(instance.host_alias, `docker stop -t 30 ${quotePosix(instance.container_name)} && docker rm ${quotePosix(instance.container_name)} >/dev/null`, 90000)
    if (probe.exitCode !== 0) fail('DOCKER_ERROR', `docker stop/rm 失败（exit ${probe.exitCode}）：${(probe.stderr ?? '').slice(0, 200)}`)
    this._instances.delete(instance.service_id)
    this._releaseReservation(instance)
    return runEnvelope('stop', { data: { container_name: instance.container_name, stopped: true, removed: true, adopted: Boolean(instance.adopted) }, executes: true })
  }
}

function toolEnvelope(kind, payload) {
  return payload
}

export function createDeployRunTools(service) {
  const wrap = (name, fn) => ({
    name,
    description: `容器服务（${name}）：受控执行，默认只读预览；真实执行需 envs.json deploy.allowRealExecution + confirmation_token 双门`,
    parameters: {
      type: 'object',
      properties: {
        env_id: { type: 'string', description: '目标环境 id（envs.json 中的 env-xxx，须为 ssh 模式）' },
        image: { type: 'string', description: `容器镜像（默认 ${DEFAULT_RUN_IMAGE}）` },
        model: {
          type: 'object',
          properties: { root: { type: 'string', description: '远端模型根目录（挂载到容器 /models）' }, path: { type: 'string', description: '模型相对路径' } },
          required: ['root', 'path'],
        },
        params: {
          type: 'object',
          properties: {
            port: { type: 'number', description: '服务端口（默认 18433，只绑 127.0.0.1）' },
            tensor_parallel: { type: 'number', description: '张量并行度（必须等于选中卡数）' },
            max_model_len: { type: 'number', description: '默认 131072，范围 256–262144' },
            health_timeout_s: { type: 'number', description: '健康超时秒（默认 300），超时自动清理自有容器' },
            max_num_seqs: { type: 'number', description: 'vLLM --max-num-seqs（可选）' },
            max_num_batched_tokens: { type: 'number', description: 'vLLM --max-num-batched-tokens（可选）' },
            gpu_memory_utilization: { type: 'number', description: 'vLLM --gpu-memory-utilization（0.1–1，可选）' },
            enable_prefix_caching: { type: 'boolean', description: 'vLLM prefix caching（可选）' },
            enforce_eager: { type: 'boolean', description: 'vLLM --enforce-eager（可选）' },
          },
        },
        code: { type: 'object', description: '代码目录与代码分支配置', properties: { root: { type: 'string' }, components: { type: 'array', items: { type: 'object', properties: { component: { type: 'string', enum: CODE_COMPONENTS }, ref: { type: 'string' }, commit: { type: 'string' } }, required: ['component', 'ref'] } } } },
        cards: { type: 'array', items: { type: 'number' }, description: 'NPU 卡号列表（0-63，唯一；启动前逐卡实测空闲）' },
        profile: { type: 'object', description: '可选：部署后自动采集 vLLM profile 并导入性能调优段', properties: { enabled: { type: 'boolean', description: '默认 false；开启后挂载 /prof + --profiler-config，healthy 后自动采集' }, dir: { type: 'string', description: '远端 profile 输出根目录（默认 <code.root>/profiles 或 $HOME/.dsh-ascend-perf-profiles）' } } },
        instance: { type: 'string', description: '容器服务 id 或容器名（status/stop/logs 用）' },
        confirmation_token: { type: 'string', description: 'preview 返回的确认令牌（start 用，10 分钟有效）' },
        tail: { type: 'number', description: 'logs 尾部行数（默认 100，最大 1000）' },
      },
      required: [],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, payload) => [{ type: 'text', text: JSON.stringify(payload, null, 2) }] },
    timeoutMs: 120000,
    async execute(args) {
      try {
        const a = args ?? {}
        if (name === 'ascend_deploy_run_preview') return toolEnvelope(name, await service.preview(a, { origin: 'tool' }))
        if (name === 'ascend_deploy_run_start') return toolEnvelope(name, await service.start(a, { origin: 'tool' }))
        if (name === 'ascend_deploy_run_status') return toolEnvelope(name, await service.status(String(a.instance ?? ''), { origin: 'tool' }))
        if (name === 'ascend_deploy_run_stop') return toolEnvelope(name, await service.stop(String(a.instance ?? ''), { origin: 'tool' }))
        fail('INTERNAL_ERROR', `未知工具：${name}`)
      } catch (error) {
        return runEnvelope(name.slice('ascend_deploy_'.length), { status: 'error', error: runErrorPayload(error) })
      }
    },
  })
  return [
    wrap('ascend_deploy_run_preview', null),
    wrap('ascend_deploy_run_start', null),
    wrap('ascend_deploy_run_status', null),
    wrap('ascend_deploy_run_stop', null),
  ]
}

export function createDeployRunRoutes(service) {
  // t128 回归修复：带 :id 的 pattern 路由需要 params（t124 的 api 包装漏传 params，
  // 导致 REST status/logs/stop 按容器名/svc id 调用时 params[0] 为 undefined，
  // 报 STORE_IO "Cannot read properties of undefined (reading '0')"）。
  const api = (fn) => async (body, query, params) => fn(body ?? {}, query ?? {}, params ?? [])
  const instanceIdPattern = /^\/deploy\/run\/instances\/([A-Za-z0-9_.-]{1,64})$/
  return [
    { path: '/deploy/run/preview', method: 'POST', handler: api((body) => service.preview(body, { origin: 'rest' })) },
    { path: '/deploy/run/start', method: 'POST', handler: api((body) => service.start(body, { origin: 'rest' })) },
    { path: '/deploy/run/instances', method: 'GET', handler: api(() => service.listInstances({ origin: 'rest' })) },
    { path: '/deploy/run/instances/:id', method: 'GET', pattern: instanceIdPattern, handler: api((body, query, params) => service.status(params[0], { origin: 'rest' })) },
    {
      path: '/deploy/run/instances/:id/logs', method: 'GET',
      pattern: /^\/deploy\/run\/instances\/([A-Za-z0-9_.-]{1,64})\/logs$/,
      handler: api((body, query, params) => service.logs(params[0], { tail: Number(query?.tail ?? 100), origin: 'rest' })),
    },
    {
      path: '/deploy/run/instances/:id/stop', method: 'POST',
      pattern: /^\/deploy\/run\/instances\/([A-Za-z0-9_.-]{1,64})\/stop$/,
      handler: api((body, query, params) => service.stop(params[0], { origin: 'rest' })),
    },
  ]
}
