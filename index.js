/**
 * dsh-live2d-stage — host half.
 *
 * Serves the browser half's static assets, streams the agent phase over SSE,
 * and translates DSH lifecycle events into stage phases:
 *
 *   agent/status running          → thinking
 *   tools/pre-execute             → tool   (focused)
 *   tools/result (isError)        → error  (held, then back to tool/idle)
 *   approval/request, questions   → waiting
 *   agent/error                   → error  (held)
 *   agent/status idle             → success (held, then idle)
 *
 * Routes (all same-origin, page session already authenticated):
 *   GET /dsh-live2d-stage/assets/*    bundled vendor scripts and sample model
 *   GET /dsh-live2d-stage/model/*     user supplied model directory (optional)
 *   GET /dsh-live2d-stage/events      text/event-stream of {phase, seq, config}
 *   GET /dsh-live2d-stage/api/state   JSON snapshot (SSE fallback / diagnostics)
 *
 * Nothing here touches the filesystem outside this package (except an
 * explicitly configured `modelPath`), and every route is registered through
 * `ctx.effect`, so unloading the plugin closes the SSE connections and frees
 * the route table.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS_ROOT = join(HERE, 'assets')
const PREFIX = '/dsh-live2d-stage'
const DEFAULT_MODEL_URL = PREFIX + '/assets/model/Natori/Natori.model3.json'

const DEFAULTS = {
  modelPath: '',
  modelUrl: '',
  successMs: 2600,
  errorMs: 5200,
  scrim: 0.18,
  heightRatio: 0.74,
  anchor: 'bottom-right',
  offsetX: 36,
  offsetY: 0,
  scale: 1,
  opacity: 1,
  zIndex: -2,
  appTransparent: true,
  gaze: true,
  idleSeconds: 45,
  bubbleMs: 5200,
  minDwellMs: 380,
  idleLines: [
    '要不要稍微休息一下？',
    '我一直在这里陪着你。',
    '写代码的时候也要记得喝水哦。',
    '这个 bug 看起来有点棘手呢……',
    '今天也辛苦啦。',
    '悄悄说，我一直在看着你的光标。',
    '慢慢来，不着急。',
    '需要我卖个萌吗？',
  ],
  expressions: {},
  // 视线参数
  gazeAngleX: 20,
  gazeAngleY: 14,
  gazeEyeBallX: 0.7,
  gazeEyeBallY: 0.6,
  gazeSmooth: 0.08,
  gazeReturnSmooth: 0.04,
  // 身体朝向跟随鼠标
  bodyFollowX: 10,
  bodyFollowY: 7,
  // 空闲/演出频率
  idleExpressionChance: 0.7,
  idleMotionChance: 0.35,
  // 独立随机动作
  randomMotionSeconds: 45,
  randomMotionChance: 0.35,
  motionHoldMs: 4000,
  idleMotionGroup: '',
  idleLoopEnabled: true,
  // 空闲演出池：空数组 = 该模型全部可用项都参与随机
  idleExpressionEnabled: true,
  idleMotionEnabled: true,
  idleMotionPool: [],
  idleExpressionPool: [],
  // 表情随机节奏
  idleExpressionSeconds: 15,
  randomExpressionChance: 0.5,
  expressionHoldMs: 4000,
  // 对话感知
  reactToUserMessage: true,
  reactToToolCall: true,
  reactToChoices: true,
  showNose: false,
  noseMode: 'soft',
  motionIntensity: 1.4,
  previewZoom: 1.6,
  previewOffsetX: 0,
  previewOffsetY: 0,
}

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.moc3': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
}

function mimeOf(file) {
  return MIME[extname(file).toLowerCase()] || 'application/octet-stream'
}

function inside(root, candidate) {
  const base = resolve(root)
  const target = resolve(candidate)
  return target === base || target.startsWith(base + sep)
}

function clampNumber(value, fallback, lo, hi) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SETTINGS_DIR = join(DSH_HOME, 'live2d-stage')
const SETTINGS_FILE = join(SETTINGS_DIR, 'settings.json')
const MODELS_DIR = join(SETTINGS_DIR, 'models')
const MODELS_ROUTE = PREFIX + '/models'

const ANCHORS = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
]

const PHASE_KEYS = ['idle', 'thinking', 'tool', 'success', 'error', 'waiting']

// Only these keys may be changed from the settings page and persisted. The
// model path is deliberately included: it is the "add a model" escape hatch.
const SETTINGS_KEYS = [
  'modelUrl', 'modelPath', 'scale', 'heightRatio', 'anchor', 'offsetX', 'offsetY',
  'opacity', 'scrim', 'zIndex', 'gaze', 'appTransparent', 'idleSeconds', 'bubbleMs',
  'successMs', 'errorMs', 'minDwellMs', 'expressions', 'idleLines',
  // 视线参数
  'gazeAngleX', 'gazeAngleY', 'gazeEyeBallX', 'gazeEyeBallY', 'gazeSmooth', 'gazeReturnSmooth',
  'bodyFollowX', 'bodyFollowY',
  // 空闲/演出频率
  'idleExpressionChance', 'idleMotionChance',
  // 独立随机动作
  'randomMotionSeconds', 'randomMotionChance', 'idleMotionGroup', 'idleLoopEnabled', 'motionHoldMs',
  // 空闲演出池（动作池 + 表情池）与表情节奏
  'idleMotionPool', 'idleExpressionPool', 'idleExpressionSeconds', 'randomExpressionChance', 'expressionHoldMs',
  'idleExpressionEnabled', 'idleMotionEnabled',
  // 对话感知
  'reactToUserMessage', 'reactToToolCall', 'reactToChoices',
  // 模型外观细节
  'noseMode', 'motionIntensity',
  // 预览取景（只影响预览小窗）
  'previewZoom', 'previewOffsetX', 'previewOffsetY',
]

function normalizeHostConfig(raw) {
  const out = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {})
  out.successMs = clampNumber(out.successMs, 2600, 400, 30000)
  out.errorMs = clampNumber(out.errorMs, 5200, 600, 60000)
  out.scrim = clampNumber(out.scrim, 0.18, 0, 0.8)
  out.heightRatio = clampNumber(out.heightRatio, 0.74, 0.2, 1.6)
  out.scale = clampNumber(out.scale, 1, 0.2, 4)
  out.offsetX = clampNumber(out.offsetX, 36, -4000, 4000)
  out.offsetY = clampNumber(out.offsetY, 0, -4000, 4000)
  out.opacity = clampNumber(out.opacity, 1, 0, 1)
  out.idleSeconds = clampNumber(out.idleSeconds, 45, 10, 3600)
  out.bubbleMs = clampNumber(out.bubbleMs, 5200, 1500, 30000)
  out.minDwellMs = clampNumber(out.minDwellMs, 380, 0, 5000)
  out.gaze = out.gaze !== false
  out.appTransparent = out.appTransparent !== false
  out.zIndex = Math.round(clampNumber(out.zIndex, -2, -10, 0))
  if (!ANCHORS.includes(out.anchor)) out.anchor = DEFAULTS.anchor
  if (!Array.isArray(out.idleLines)) out.idleLines = []
  out.idleLines = out.idleLines.filter((line) => typeof line === 'string' && line.trim()).slice(0, 30)
  if (!out.expressions || typeof out.expressions !== 'object') out.expressions = {}
  // 视线参数
  out.gazeAngleX = clampNumber(out.gazeAngleX, 20, 0, 60)
  out.gazeAngleY = clampNumber(out.gazeAngleY, 14, 0, 40)
  out.gazeEyeBallX = clampNumber(out.gazeEyeBallX, 0.7, 0, 2)
  out.gazeEyeBallY = clampNumber(out.gazeEyeBallY, 0.6, 0, 2)
  out.gazeSmooth = clampNumber(out.gazeSmooth, 0.08, 0.01, 0.5)
  out.gazeReturnSmooth = clampNumber(out.gazeReturnSmooth, 0.04, 0.01, 0.5)
  out.bodyFollowX = clampNumber(out.bodyFollowX, 10, 0, 30)
  out.bodyFollowY = clampNumber(out.bodyFollowY, 7, 0, 25)
  // 空闲/演出频率
  out.idleExpressionChance = clampNumber(out.idleExpressionChance, 0.7, 0, 1)
  out.idleMotionChance = clampNumber(out.idleMotionChance, 0.35, 0, 1)
  // 独立随机动作
  // 间隔不再具有"0 = 关闭"的含义：滑杆拉到 0 时用户会理解成"最频繁"，
  // 而旧的 0=关闭 语义会让模型完全不动（这是用户报的 bug）。
  // 想关闭随机动作/表情，请把「动作/表情触发概率」设为 0。
  out.randomMotionSeconds = clampNumber(out.randomMotionSeconds, 45, 5, 3600)
  out.randomMotionChance = clampNumber(out.randomMotionChance, 0.35, 0, 1)
  out.motionHoldMs = clampNumber(out.motionHoldMs, 4000, 600, 20000)
  // 待机动作组：空字符串 = 自动识别
  out.idleMotionGroup = typeof out.idleMotionGroup === 'string' ? out.idleMotionGroup.slice(0, 80) : ''
  out.idleLoopEnabled = out.idleLoopEnabled !== false
  // 空闲演出池：空数组 = 全部可用
  out.idleMotionPool = Array.isArray(out.idleMotionPool)
    ? out.idleMotionPool.filter((v) => typeof v === 'string' && v.trim() && v.length <= 200).slice(0, 200).map((v) => v.trim())
    : []
  out.idleExpressionPool = Array.isArray(out.idleExpressionPool)
    ? out.idleExpressionPool.filter((v) => typeof v === 'string' && v.trim() && v.length <= 200).slice(0, 200).map((v) => v.trim())
    : []
  out.idleExpressionEnabled = out.idleExpressionEnabled !== false
  out.idleMotionEnabled = out.idleMotionEnabled !== false
  out.idleExpressionSeconds = clampNumber(out.idleExpressionSeconds, 15, 3, 3600)
  out.randomExpressionChance = clampNumber(out.randomExpressionChance, 0.5, 0, 1)
  out.expressionHoldMs = clampNumber(out.expressionHoldMs, 4000, 300, 30000)
  // 对话感知
  out.reactToUserMessage = out.reactToUserMessage !== false
  out.reactToToolCall = out.reactToToolCall !== false
  out.reactToChoices = out.reactToChoices !== false
  out.showNose = out.showNose === true
  out.noseMode = out.noseMode === 'off' || out.noseMode === 'original' ? out.noseMode : (out.showNose ? 'original' : 'soft')
  out.motionIntensity = clampNumber(out.motionIntensity, 1.4, 0, 3)
  // 预览取景：只作用于预览小窗，不影响背景层取景
  out.previewZoom = clampNumber(out.previewZoom, 1.6, 0.3, 5)
  out.previewOffsetX = clampNumber(out.previewOffsetX, 0, -2000, 2000)
  out.previewOffsetY = clampNumber(out.previewOffsetY, 0, -2000, 2000)
  out.modelPath = typeof out.modelPath === 'string' ? out.modelPath : ''
  out.modelUrl = typeof out.modelUrl === 'string' ? out.modelUrl : ''
  return out
}

function readSavedSettings() {
  try {
    const raw = readFileSync(SETTINGS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

// A user-visible patch from the settings page. Unknown keys are dropped and
// every value is clamped exactly like the activation config, so a bad POST can
// never poison the live stage.
function sanitizeSettings(input) {
  const patch = {}
  if (!input || typeof input !== 'object') return patch
  for (const key of SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    const value = input[key]
    if (key === 'modelUrl' || key === 'modelPath') {
      if (typeof value === 'string' && value.length <= 1000) patch[key] = value.trim()
      continue
    }
    if (key === 'anchor') {
      if (typeof value === 'string' && ANCHORS.includes(value)) patch[key] = value
      continue
    }
    if (key === 'noseMode') {
      if (value === 'off' || value === 'original' || value === 'soft') patch[key] = value
      continue
    }
    if (key === 'idleMotionGroup') {
      // 动作组名是模型自己的字符串（可能为空串 = 自动识别）
      if (typeof value === 'string' && value.length <= 80) patch[key] = value.trim()
      continue
    }
    if (key === 'gaze' || key === 'appTransparent' || key === 'reactToUserMessage' || key === 'reactToToolCall' || key === 'reactToChoices' || key === 'idleLoopEnabled' || key === 'idleExpressionEnabled' || key === 'idleMotionEnabled') {
      patch[key] = value !== false
      continue
    }
    if (key === 'expressions') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const map = {}
      // 三个新场景键（input/output/ask）+ 旧阶段键都接受，旧配置不会被丢掉
      for (const phase of PHASE_KEYS.concat(['input', 'output', 'ask'])) {
        const name = value[phase]
        if (typeof name === 'string' && name.trim() && name.length <= 80) map[phase] = name.trim()
      }
      patch[key] = map
      continue
    }
    if (key === 'idleLines') {
      if (!Array.isArray(value)) continue
      patch[key] = value.filter((line) => typeof line === 'string' && line.trim() && line.length <= 200).slice(0, 30).map((line) => line.trim())
      continue
    }
    if (key === 'idleMotionPool' || key === 'idleExpressionPool') {
      // 演出池是字符串数组；空数组合法（= 该类型全部可用项都参与随机）
      if (!Array.isArray(value)) continue
      patch[key] = value
        .filter((v) => typeof v === 'string' && v.trim() && v.length <= 200)
        .map((v) => v.trim())
        .slice(0, 200)
      continue
    }
    const n = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(n)) patch[key] = n
  }
  return patch
}

// ── 模型自适应 ────────────────────────────────────────────────
// 很多模型（尤其是从 VTube Studio 导出的）把 exp3 / motion3 文件放在
// 文件夹里，却忘了写进 model3.json 的 FileReferences。官方运行时只认
// 清单里声明的内容，于是「有表情有动作却驱动不了」。这里在读取清单时
// 就地补全：扫描同目录（含一层子目录）+ 读取 .vtube.json 里的热键名，
// 把没声明的表情/动作合并进去。只在内存里补，不改用户的文件。
const EXPR_FILE_RE = /\.exp3\.json$/i
const MOTION_FILE_RE = /\.motion3\.json$/i
const manifestCache = new Map()

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function toPosixPath(p) {
  return p.split(sep).join('/')
}

function collectModelFiles(dir, depth, out) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth > 1) collectModelFiles(full, depth - 1, out)
      continue
    }
    if (!entry.isFile()) continue
    if (EXPR_FILE_RE.test(entry.name)) out.expressions.push(full)
    else if (MOTION_FILE_RE.test(entry.name)) out.motions.push(full)
  }
  return out
}

// VTube Studio 的热键表里有作者写好的表情名，比文件名友好
function vtubeHotkeyNames(dir) {
  const names = new Map()
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return names
  }
  const file = entries.find((e) => e.isFile() && /\.vtube\.json$/i.test(e.name))
  if (!file) return names
  const json = readJsonSafe(join(dir, file.name))
  const hotkeys = json && Array.isArray(json.Hotkeys) ? json.Hotkeys : []
  for (const hk of hotkeys) {
    const target = typeof hk.File === 'string' ? hk.File : ''
    const label = typeof hk.Name === 'string' ? hk.Name.trim() : ''
    if (!target || !label) continue
    names.set(basename(target).replace(/\.(exp3|motion3)\.json$/i, ''), label)
  }
  return names
}

function motionIsLoop(file) {
  const json = readJsonSafe(file)
  return !!(json && json.Meta && json.Meta.Loop)
}

const IDLE_NAME_RE = /^(idle|loop|stand|scene|default|home|main|待机|默认|平时)/i

function augmentManifest(manifestPath) {
  let stat
  try {
    stat = statSync(manifestPath)
  } catch {
    return null
  }
  const cached = manifestCache.get(manifestPath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.result

  const json = readJsonSafe(manifestPath)
  if (!json || typeof json !== 'object') return null
  const dir = dirname(manifestPath)
  const refs = json.FileReferences && typeof json.FileReferences === 'object' ? json.FileReferences : null
  if (!refs || typeof refs.Moc !== 'string') return null

  const scan = collectModelFiles(dir, 2, { expressions: [], motions: [] })
  const friendly = vtubeHotkeyNames(dir)
  const added = { expressions: 0, motions: 0 }

  const expressions = Array.isArray(refs.Expressions) ? refs.Expressions.slice() : []
  const knownExpr = new Set(expressions.map((e) => String((e && e.File) || '')))
  for (const file of scan.expressions) {
    const rel = toPosixPath(relative(dir, file))
    if (knownExpr.has(rel)) continue
    const base = basename(file).replace(EXPR_FILE_RE, '')
    expressions.push({ Name: friendly.get(base) || base, File: rel, Source: 'scan' })
    knownExpr.add(rel)
    added.expressions += 1
  }
  if (expressions.length) refs.Expressions = expressions

  const motions = refs.Motions && typeof refs.Motions === 'object' ? Object.assign({}, refs.Motions) : {}
  const knownMotion = new Set()
  for (const group of Object.keys(motions)) {
    for (const item of motions[group] || []) knownMotion.add(String((item && item.File) || ''))
  }
  for (const file of scan.motions) {
    const rel = toPosixPath(relative(dir, file))
    if (knownMotion.has(rel)) continue
    const base = basename(file).replace(MOTION_FILE_RE, '')
    const group = motionIsLoop(file) || IDLE_NAME_RE.test(base) ? 'Idle' : base
    motions[group] = (motions[group] || []).concat([{ File: rel, Source: 'scan' }])
    knownMotion.add(rel)
    added.motions += 1
  }
  if (Object.keys(motions).length) refs.Motions = motions

  if (added.expressions === 0 && added.motions === 0) {
    manifestCache.set(manifestPath, { mtimeMs: stat.mtimeMs, size: stat.size, result: null })
    return null
  }
  const result = { text: JSON.stringify(json, null, 2), added }
  manifestCache.set(manifestPath, { mtimeMs: stat.mtimeMs, size: stat.size, result })
  console.log(
    '[dsh-live2d-stage] 自动补全模型清单 ' + basename(manifestPath) +
      '：表情 +' + added.expressions + '，动作 +' + added.motions,
  )
  return result
}

function resolveModel(cfg) {
  const explicit = typeof cfg.modelUrl === 'string' ? cfg.modelUrl.trim() : ''
  if (explicit) {
    if (explicit.startsWith(MODELS_ROUTE + '/')) return { url: explicit, root: MODELS_DIR }
    return { url: explicit, root: null }
  }
  const path = typeof cfg.modelPath === 'string' ? cfg.modelPath.trim() : ''
  if (path) {
    const abs = resolve(path)
    if (existsSync(abs)) return { url: PREFIX + '/model/' + encodeURIComponent(basename(abs)), root: dirname(abs) }
    console.warn('[dsh-live2d-stage] modelPath 不存在，改用内置示例模型：' + abs)
  }
  return { url: DEFAULT_MODEL_URL, root: null }
}

// Recursively collect `*.model3.json` under the user model directory (depth 3).
function listModels() {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.model3.json')) {
        const rel = relative(MODELS_DIR, full).split(sep).join('/')
        found.push({ name: rel, url: MODELS_ROUTE + '/' + rel })
      }
    }
  }
  walk(MODELS_DIR, 0)
  found.sort((a, b) => a.name.localeCompare(b.name))
  return found
}

export const inject = ['webServer']

export function apply(ctx, rawConfig) {
  const input = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const saved = readSavedSettings()
  const config = normalizeHostConfig(Object.assign({}, input, saved || {}))
  config.probe = input.probe // activation-only switch, never persisted

  let modelRoot = null
  let modelUrl = DEFAULT_MODEL_URL
  function rebuildModel() {
    const resolved = resolveModel(config)
    modelUrl = resolved.url
    modelRoot = resolved.root
  }
  rebuildModel()
  try {
    mkdirSync(MODELS_DIR, { recursive: true })
  } catch { /* the settings page reports an unwritable directory */ }

  const publicConfig = () => {
    const out = Object.assign({}, config, { modelUrl })
    delete out.modelPath
    delete out.probe
    return out
  }

  function persistSettings() {
    try {
      const out = {}
      for (const key of SETTINGS_KEYS) out[key] = config[key]
      mkdirSync(SETTINGS_DIR, { recursive: true })
      writeFileSync(SETTINGS_FILE, JSON.stringify(out, null, 2), 'utf8')
    } catch (err) {
      console.warn('[dsh-live2d-stage] 设置保存失败：' + (err && err.message ? err.message : err))
    }
  }

  function applySettings(patch) {
    Object.assign(config, normalizeHostConfig(Object.assign({}, config, patch)))
    rebuildModel()
    persistSettings()
    broadcast('config', { config: publicConfig() })
  }

  // Page-side self checks posted by the browser half and the boot probe.
  // Written to the OS temp directory so a failed render can be diagnosed
  // without opening devtools; keyed by event so none overwrites another.
  const reports = Object.create(null)
  const REPORT_FILE = join(tmpdir(), 'dsh-live2d-stage', 'last-report.json')

  // ── boot probe ─────────────────────────────────────────────────────────────
  // A tiny head script reporting page-side facts (boot graph rows, module
  // loader presence, window errors) to the same report file, so a blank stage
  // can be diagnosed without devtools. Disable with `probe: false`.
  const PROBE = [
    '(function(){',
    'function post(e,x){try{fetch("/dsh-live2d-stage/api/report",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify(Object.assign({event:e,at:Date.now()},x||{}))}).catch(function(){})}catch(_){}}',
    'window.addEventListener("error",function(ev){post("window-error",{message:String(ev.message||""),src:String(ev.filename||"")})});',
    'window.addEventListener("unhandledrejection",function(ev){post("unhandled-rejection",{message:String(ev.reason&&ev.reason.message||ev.reason||"")})});',
    'setTimeout(function(){var b=window.__DSH_BOOT__,ids=null;try{if(b){var rows=b.entries||b.plugins||b.modules;ids=Array.isArray(rows)?rows.map(function(r){return typeof r==="string"?r:(r&&(r.id||r.name))||"?"}).slice(0,120):Object.keys(b)}}catch(e){ids="err:"+e.message}',
    'post("probe",{loader:!!window.__ModuleLoader__,stage:!!window.__dshLive2DStage,layer:document.querySelectorAll("[data-dsh-live2d],.dsh-l2d-layer").length,bootKeys:b?Object.keys(b):null,entries:ids})},3500);',
    '})();',
  ].join('')

  // ── phase state machine ────────────────────────────────────────────────────
  let phase = 'idle'
  let seq = 0
  let agentRunning = false
  let lastErrorAt = 0
  let holdTimer = null
  const sseClients = new Set()

  function frame(res, event, data) {
    try {
      res.write('event: ' + event + '\n')
      res.write('data: ' + JSON.stringify(data) + '\n\n')
    } catch { /* client went away */ }
  }

  function broadcast(event, data) {
    for (const res of sseClients) frame(res, event, data)
  }

  function setPhase(next) {
    if (next === phase) return
    phase = next
    seq += 1
    broadcast('state', { phase, seq, at: Date.now() })
  }

  function holdPhase(ms, then) {
    clearTimeout(holdTimer)
    holdTimer = setTimeout(() => {
      holdTimer = null
      setPhase(typeof then === 'function' ? then() : then)
    }, Math.max(0, ms))
  }

  // ── agent lifecycle → phase ────────────────────────────────────────────────
  ctx.on('agent/status', (payload) => {
    const status = payload && payload.status
    if (status === 'running') {
      agentRunning = true
      clearTimeout(holdTimer)
      holdTimer = null
      if (phase !== 'waiting') setPhase('thinking')
      return
    }
    if (status !== 'idle') return
    agentRunning = false
    const sinceError = Date.now() - lastErrorAt
    if (sinceError < config.errorMs) {
      holdPhase(config.errorMs - sinceError, 'idle')
    } else if (phase === 'waiting') {
      holdPhase(500, 'idle')
    } else {
      setPhase('success')
      holdPhase(config.successMs, 'idle')
    }
  })

  ctx.on('tools/pre-execute', (exec, next) => {
    if (typeof next === 'function') {
      try {
        if (phase !== 'waiting') {
          clearTimeout(holdTimer)
          holdTimer = null
          setPhase('tool')
        }
      } catch { /* never break the tool pipeline for a visual */ }
      return next()
    }
    return undefined
  })

  ctx.on('tools/result', (exec, result) => {
    try {
      if (result && result.isError === true) {
        lastErrorAt = Date.now()
        setPhase('error')
        holdPhase(config.errorMs, () => (agentRunning ? 'tool' : 'idle'))
      }
    } catch { /* observe only */ }
  })

  ctx.on('agent/error', () => {
    try {
      lastErrorAt = Date.now()
      setPhase('error')
      holdPhase(config.errorMs, () => (agentRunning ? 'thinking' : 'idle'))
    } catch { /* observe only */ }
  })

  const markWaiting = (next) => {
    try {
      clearTimeout(holdTimer)
      holdTimer = null
      setPhase('waiting')
    } catch { /* ignore */ }
    let settled
    try {
      settled = Promise.resolve(typeof next === 'function' ? next() : undefined)
    } catch (err) {
      settled = Promise.reject(err)
    }
    return settled.then(
      (outcome) => {
        try {
          if (phase === 'waiting') setPhase(agentRunning ? 'tool' : 'idle')
        } catch { /* ignore */ }
        return outcome
      },
      (err) => {
        try {
          if (phase === 'waiting') setPhase(agentRunning ? 'tool' : 'idle')
        } catch { /* ignore */ }
        throw err
      },
    )
  }

  ctx.on('approval/request', (req, next) => markWaiting(next))
  ctx.on('user-questions/request', (req, next) => markWaiting(next))

  // ── Session events → model reactions ───────────────────────────────────────
  // Listen to session events to react to user messages, tool calls, choices
  ctx.on('session/event', (session, event) => {
    try {
      // User message event
      if (config.reactToUserMessage && event && event.kind === 'user-message') {
        broadcast('model-react', { type: 'user-message', at: Date.now() })
      }
      // Tool call started
      if (config.reactToToolCall && event && event.kind === 'tool-call' && event.status === 'started') {
        broadcast('model-react', { type: 'tool-start', at: Date.now() })
      }
      // Tool call completed
      if (config.reactToToolCall && event && event.kind === 'tool-call' && event.status === 'completed') {
        broadcast('model-react', { type: 'tool-end', at: Date.now() })
      }
      // Choices/approval presented
      if (config.reactToChoices && event && (event.kind === 'approval' || event.kind === 'user-question')) {
        broadcast('model-react', { type: 'choices', at: Date.now() })
      }
    } catch { /* observe only */ }
  })

  // ── HTTP routes ────────────────────────────────────────────────────────────
  async function sendFile(req, res, file, cacheControl) {
    const data = await readFile(file)
    res.writeHead(200, {
      'Content-Type': mimeOf(file),
      'Content-Length': data.length,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.end(data)
  }

  function notFound(res, message) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ error: message || 'not found' }))
  }

  async function serveFrom(req, res, root, routePath, cacheControl) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end()
      return
    }
    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
    } catch {
      notFound(res)
      return
    }
    const rel = pathname.slice(routePath.length).replace(/^\/+/, '')
    if (!rel) {
      notFound(res)
      return
    }
    const file = join(root, ...rel.split('/'))
    if (!inside(root, file)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }
    // 模型清单在读取时就地补全：把文件夹里没声明进 FileReferences 的
    // exp3 / motion3 合并进去，这样设置页和运行时都能驱动到它们。
    if (/\.model3\.json$/i.test(file)) {
      const patched = augmentManifest(file)
      if (patched) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-cache',
        })
        res.end(req.method === 'HEAD' ? undefined : patched.text)
        return
      }
    }
    try {
      await sendFile(req, res, file, cacheControl)
    } catch (err) {
      if (err && err.code === 'ENOENT') notFound(res)
      else {
        console.warn('[dsh-live2d-stage] 静态资源读取失败：' + (err && err.message ? err.message : err))
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('internal error')
      }
    }
  }

  async function serveSse(req, res) {
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' })
      res.end()
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    frame(res, 'hello', { phase, seq, config: publicConfig() })
    sseClients.add(res)
    const ping = setInterval(() => {
      try { res.write(': ping\n\n') } catch { /* ignore */ }
    }, 20000)
    let closed = false
    const done = () => {
      if (closed) return
      closed = true
      clearInterval(ping)
      sseClients.delete(res)
      try { res.end() } catch { /* ignore */ }
    }
    req.on('close', done)
    res.on('close', done)
  }

  async function acceptReport(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' })
      res.end()
      return
    }
    const chunks = []
    let size = 0
    let aborted = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 16384) {
        aborted = true
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('too large')
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', async () => {
      if (aborted) return
      try {
        const report = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const key = String(report.event || 'report')
        reports[key] = Object.assign({ at: Date.now() }, report)
        try {
          await mkdir(dirname(REPORT_FILE), { recursive: true })
          await writeFile(REPORT_FILE, JSON.stringify(reports, null, 2), 'utf8')
        } catch { /* diagnostics only */ }
        res.writeHead(204, { 'Cache-Control': 'no-store' })
        res.end()
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('bad json')
      }
    })
  }

  function serveState(req, res) {
    const body = JSON.stringify({ phase, seq, config: publicConfig(), reports, clients: sseClients.size, at: Date.now() })
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  function readBody(req, limit) {
    return new Promise((resolvePromise, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolvePromise(Buffer.concat(chunks).toString('utf8'))
        } catch (err) {
          reject(err)
        }
      })
      req.on('error', reject)
    })
  }

  function json(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  // Settings page backend: GET returns the editable config plus the models
  // discovered under ~/.dsh/live2d-stage/models; POST applies a partial patch,
  // persists it and pushes the new config to every open stage over SSE.
  async function serveSettings(req, res) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      json(res, 200, {
        config: publicConfig(),
        models: listModels(),
        anchors: ANCHORS,
        phases: PHASE_KEYS,
        builtin: { name: 'Natori（内置示例）', url: DEFAULT_MODEL_URL },
        modelsDir: MODELS_DIR,
        settingsFile: SETTINGS_FILE,
        running: Boolean(modelUrl),
      })
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'GET, HEAD, POST' })
      res.end()
      return
    }
    try {
      const raw = await readBody(req, 32768)
      const patch = sanitizeSettings(JSON.parse(raw || '{}'))
      applySettings(patch)
      json(res, 200, { ok: true, config: publicConfig() })
    } catch (err) {
      const message = err && err.message ? err.message : String(err)
      json(res, message === 'too large' ? 413 : 400, { ok: false, error: message })
    }
  }

  if (config.probe !== false) {
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'script', placement: 'head', text: PROBE })
    })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX + '/assets',
    handler: (req, res) => serveFrom(req, res, ASSETS_ROOT, PREFIX + '/assets', 'public, max-age=3600'),
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX + '/model',
    handler: (req, res) => {
      if (!modelRoot) {
        notFound(res, 'no modelPath configured')
        return
      }
      serveFrom(req, res, modelRoot, PREFIX + '/model', 'public, max-age=60')
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: MODELS_ROUTE,
    handler: (req, res) => serveFrom(req, res, MODELS_DIR, MODELS_ROUTE, 'public, max-age=60'),
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREFIX + '/api/settings',
    handler: serveSettings,
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREFIX + '/events',
    handler: serveSse,
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREFIX + '/api/state',
    handler: serveState,
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREFIX + '/api/report',
    handler: acceptReport,
  }))

  ctx.effect(() => () => {
    clearTimeout(holdTimer)
    for (const res of sseClients) {
      try { res.end() } catch { /* ignore */ }
    }
    sseClients.clear()
  })

  console.log('[dsh-live2d-stage] ready: model=' + modelUrl)
}
