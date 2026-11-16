import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = join(root, 'dist', 'dsh-ascend-perf')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const files = ['index.js', 'client.js', 'profile.js', 'deploy.js', 'deploy-exec.js', 'tune.js', 'tune-exec.js', 'cordis.patch.yml', 'icon.svg']
for (const file of files) cpSync(join(root, file), join(out, file))
cpSync(join(root, 'locale'), join(out, 'locale'), { recursive: true })
cpSync(join(root, 'fixtures', 'profile'), join(out, 'fixtures', 'profile'), { recursive: true })
cpSync(join(root, 'scripts', 'market-readme.md'), join(out, 'README.md'))
cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'))

let client = readFileSync(join(out, 'client.js'), 'utf8')
if (!client.includes("const EDITION = 'full'")) throw new Error('edition marker not found')
client = client
  .replace("const EDITION = 'full'", "const EDITION = 'deploy'")
  .replace("'panel.title': '昇腾性能调优'", "'panel.title': '昇腾环境监控与服务部署'")
  .replace("'panel.title': 'Ascend Performance Tuning'", "'panel.title': 'Ascend NPU Monitor & Deploy'")
  .replace(
    "'panel.guideDescription': '三段视图：环境信息（NPU 卡与芯片占用）、服务部署（候选 vs 基线部署计划）、性能调优（调优作业、运行对比与洞察）。'",
    "'panel.guideDescription': '两段视图：环境信息（多环境 NPU 占用）与服务部署（在选定环境预览/启动受控 vLLM 容器，默认只预览）。'",
  )
  .replace(
    "'panel.guideDescription': 'Three views: Environments (NPU card/chip occupancy), Deployments (candidate-vs-baseline plans), and Tuning (jobs, run comparison, and insights).'",
    "'panel.guideDescription': 'Two views: Environments (fleet NPU occupancy) and Deployment (preview/start a controlled vLLM container; preview-only by default).'",
  )
writeFileSync(join(out, 'client.js'), client)

const marketPkg = {
  name: pkg.name,
  version: pkg.version,
  private: false,
  type: 'module',
  description:
    'DeepSeek Harness 的昇腾 NPU 环境监控与服务部署：从 envs.json 读取多台昇腾主机，只读采集 npu-smi 占用；在选定环境上预览/启动受控 vLLM 容器服务，默认只预览，真实启动需 allowRealExecution + 确认令牌。',
  license: 'MIT',
  engines: pkg.engines,
  repository: {
    type: 'git',
    url: 'https://github.com/newpage1/dsh-ascend-perf.git',
  },
  keywords: ['dsh-plugin', 'deepseek-harness', 'ascend', 'npu', 'npu-smi', 'observability', 'vllm', 'deployment'],
  exports: pkg.exports,
  files: [
    'index.js',
    'client.js',
    'profile.js',
    'deploy.js',
    'deploy-exec.js',
    'tune.js',
    'tune-exec.js',
    'cordis.patch.yml',
    'locale/*.json',
    'fixtures/profile/*',
    'icon.svg',
    'README.md',
    'LICENSE',
  ],
  dsh: pkg.dsh,
}
writeFileSync(join(out, 'package.json'), `${JSON.stringify(marketPkg, null, 2)}\n`)

console.log(`built ${out}`)
console.log(`files: ${files.join(', ')}, locale/, README.md, LICENSE, package.json`)
