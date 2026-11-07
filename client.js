/**
 * dsh-live2d-stage — browser half.
 *
 * Renders a Live2D (Cubism 4) model as a *background* layer of the DSH web
 * GUI: below every column, fully transparent, mouse-events pass through, and
 * the model reacts to the agent's live phase (idle / thinking / tool /
 * success / error / waiting) with expressions, gaze tracking and occasional
 * idle chatter.
 *
 * Why the layer lives on <body> instead of inside the slot host:
 * `shell.overlay` is rendered inside `.mP3x-q_overlayLayer` which declares
 * `z-index: 20` — a stacking context. Any position:fixed child of that slot is
 * trapped above the app columns no matter which z-index it asks for. A true
 * background therefore has to be a direct child of <body> at a negative
 * z-index (the same technique dsh-plugin-wallpaper-engine uses). The slot
 * registration below is this plugin's UI entry point and owns the layer's
 * lifecycle; the single fixed <div> it appends is removed on cleanup.
 *
 * The host half serves:
 *   /dsh-live2d-stage/assets/...   bundled vendor scripts + model
 *   /dsh-live2d-stage/events       SSE phase/config stream
 *   /dsh-live2d-stage/api/state    JSON snapshot (fallback)
 *   /dsh-live2d-stage/model/...    user-supplied model directory
 */
;(() => {
  const PREFIX = '/dsh-live2d-stage'
  // 构建标记：应用里热加载的是哪一版，看 /api/state 的 apply.build 就知道。
  const BUILD = '2026-11-07.9'
  const STAGE_ATTR = 'data-dsh-live2d'
  const DEFAULT_MODEL = PREFIX + '/assets/model/Natori/Natori.model3.json'

  // Phase -> candidate expression names. Names are matched case-insensitively
  // against FileReferences.Expressions of the loaded model. A missing entry is
  // *never* written to the model: the previous expression's parameter snapshot
  // is restored and a warning is emitted instead.
  const PHASE_EXPRESSION = {
    // ── 三个真正的场景（设置页只暴露这三项）──────────────────
    // input  = 刚输入：用户刚发来消息
    // output = 刚输出：这一轮回答结束
    // ask    = 提问 / 等待用户确认
    input: ['Surprised', 'surprised', 'exp_01', 'Normal', 'neutral'],
    output: ['Smile', 'happy', 'joy', 'fun', 'Normal'],
    ask: ['expect', 'question', 'Surprised', 'exp_02', 'Normal'],
    // ── 兼容旧配置的阶段键 ──────────────────────────────────
    idle: ['Normal', 'neutral', 'idle', 'calm'],
    thinking: ['exp_01', 'think', 'thinking', 'ponder'],
    running: ['exp_02', 'focus', 'serious'],
    tool: ['exp_02', 'focus', 'serious'],
    success: ['Smile', 'happy', 'joy', 'fun'],
    error: ['Sad', 'sad', 'cry', 'angry'],
    waiting: ['Surprised', 'surprised', 'expect', 'question'],
  }

  // 设置页只暴露这三个场景；它们优先级最高，空闲随机表情不会盖掉它们。
  const EXPR_SCENES = [
    { key: 'input', label: '刚输入', hint: '你刚发来消息时' },
    { key: 'output', label: '刚输出', hint: '这一轮回答结束时' },
    { key: 'ask', label: '提问 / 等待', hint: '需要你确认或回答时' },
  ]

  const EXPRESSION_PARAMS = [
    'ParamEyeLOpen', 'ParamEyeLSmile', 'ParamEyeLForm',
    'ParamEyeROpen', 'ParamEyeRSmile', 'ParamEyeRForm',
    'ParamEyeBallForm', 'ParamBrowLY', 'ParamBrowRY',
    'ParamBrowLX', 'ParamBrowRX', 'ParamBrowLAngle', 'ParamBrowRAngle',
    'ParamBrowLForm', 'ParamBrowLForm2', 'ParamBrowRForm', 'ParamBrowRForm2',
    'ParamMouthForm', 'ParamMouthOpenY', 'ParamMouthForm2',
    'ParamTeethOn', 'ParamCheek',
  ]

  const DEFAULT_CONFIG = {
    modelPath: '',
    modelUrl: '',
    scale: 1,
    heightRatio: 0.74,
    anchor: 'bottom-right',
    offsetX: 36,
    offsetY: 0,
    opacity: 1,
    zIndex: -2,
    appTransparent: true,
    scrim: 0.18,
    gaze: true,
    // 视线参数（新增可配置）
    gazeAngleX: 20,      // ParamAngleX 幅度（度）
    gazeAngleY: 14,      // ParamAngleY 幅度（度）
    gazeEyeBallX: 0.7,   // ParamEyeBallX 幅度
    gazeEyeBallY: 0.6,   // ParamEyeBallY 幅度
    gazeSmooth: 0.08,    // 缓动系数 0~1，越小越跟随、越大越平滑，默认 0.08
    gazeReturnSmooth: 0.04, // 回正缓动
    // 身体朝向：鼠标在哪边，身体/肩膀/胯就跟着转向哪边（虚拟主播的"跟人"感）
    bodyFollowX: 10,     // 侧向倾斜幅度（度）
    bodyFollowY: 7,      // 前后俯仰幅度（度）
    idleSeconds: 45,
    bubbleMs: 5200,
    minDwellMs: 380,
    successMs: 2600,             // 完成（success）阶段停留时长
    errorMs: 5200,               // 报错（error）阶段停留时长
    // 空闲/演出频率（新增）
    idleExpressionChance: 0.7,   // 空闲说台词时触发表情概率
    idleMotionChance: 0.35,      // 空闲说台词时触发动作概率
    // 独立随机动作（不依赖空闲台词）
    randomMotionSeconds: 45,     // 随机动作间隔秒数；想关掉请把「动作触发概率」设为 0
    randomMotionChance: 0.35,     // 到点时实际触发概率
    motionHoldMs: 4000,          // 单个动作持续时间：到点收尾，保证"完整播一段"
    // 空闲随机演出池：留空 = 该模型全部可用项；勾选后只从池里随机
    idleMotionPool: [],        // 动作池（motionCatalog 里的 label）
    idleExpressionPool: [],     // 表情池（expressionNames）
    // 常态演出总开关：关掉后随机表情/动作完全不启动（呼吸、视线、微动不受影响）
    idleExpressionEnabled: true,
    idleMotionEnabled: true,
    // 表情独立随机：到点按概率做个表情，0 = 关闭
    idleExpressionSeconds: 15,
    randomExpressionChance: 0.5,
    expressionHoldMs: 4000,      // 随机表情停留时长
    // 待机动作组：留空 = 自动挑（Idle/idle/待机…，再退回第一个组）
    idleMotionGroup: '',
    // 待机循环动作总开关：关掉后连基础循环动作都不播，只剩呼吸/视线
    idleLoopEnabled: true,
    // 预览小窗里的取景：缩放 + 平移（只影响预览，不影响背景层）
    previewZoom: 1.6,
    previewOffsetX: 0,
    previewOffsetY: 0,
    // 对话感知（新增）
    reactToUserMessage: true,    // 用户发消息时反应
    reactToToolCall: true,       // 工具调用时反应
    reactToChoices: true,        // 出现选项/待确认时反应
    showNose: false,             // 兼容旧配置，等价 noseMode='original'
    noseMode: 'soft',            // 'soft' 手绘柔和鼻子 / 'off' 完全不要鼻子 / 'original' 模型原版黑块
    motionIntensity: 1.4,        // 全身动作幅度倍率（呼吸/身体/头部微动）
    expressions: {},
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
  }

  const CSS = `
.dsh-l2d-layer{position:fixed;inset:0;overflow:hidden;pointer-events:none;opacity:0;transition:opacity .9s ease;}
.dsh-l2d-layer[data-ready="1"]{opacity:var(--dsh-l2d-opacity,1);}
/* 关掉透明度过渡：Chromium 在「负 z-index + opacity 动画 + WebGL 画布」的组合下
   偶尔不会把画布合成上去（readPixels 有像素、屏幕全黑），静态 opacity 才稳。 */
.dsh-l2d-layer,.dsh-l2d-layer[data-ready="1"]{transition:none !important;}
.dsh-l2d-layer canvas{display:block;width:100%;height:100%;pointer-events:none;}
.dsh-l2d-scrim{position:fixed;inset:0;pointer-events:none;z-index:-1;}
body[${STAGE_ATTR}]{--dsw-alias-bg-base:transparent;--dsw-specific-sidebar-fill:transparent;}
html[${STAGE_ATTR}]{background-color:transparent;}
.dsh-l2d-bubble{position:fixed;z-index:40;transform:translate(-50%,-100%);max-width:min(280px,60vw);
  padding:9px 13px;border-radius:13px;pointer-events:none;font-size:13px;line-height:1.5;
  background:var(--dsw-alias-bg-layer-3,rgba(24,26,32,.92));color:var(--dsw-alias-label-primary,#f2f4f8);
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  box-shadow:0 8px 26px rgba(0,0,0,.28);animation:dsh-l2d-pop .26s ease-out;}
.dsh-l2d-bubble::after{content:"";position:absolute;left:50%;bottom:-6px;width:12px;height:12px;
  transform:translateX(-50%) rotate(45deg);background:inherit;border-right:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));}
.dsh-l2d-alert{position:fixed;left:14px;bottom:14px;z-index:40;display:flex;gap:10px;align-items:center;
  max-width:min(420px,72vw);padding:8px 12px;border-radius:10px;font-size:12px;line-height:1.4;
  background:var(--dsw-alias-bg-layer-2,rgba(30,32,38,.94));color:var(--dsw-alias-label-secondary,#c8ccd6);
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));box-shadow:0 6px 20px rgba(0,0,0,.22);}
.dsh-l2d-alert button{flex:none;padding:3px 9px;border-radius:7px;cursor:pointer;font:inherit;
  color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.12));
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));}
.dsh-l2d-alert button:hover{background:var(--dsw-alias-bg-layer-4,rgba(255,255,255,.2));}
@keyframes dsh-l2d-pop{from{opacity:0;transform:translate(-50%,-92%) scale(.96);}to{opacity:1;transform:translate(-50%,-100%) scale(1);}}
`

  const SETTINGS_CSS = `
.dsh-l2d-set{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.5;}
.dsh-l2d-set__group{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border-radius:12px;
  background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));}
.dsh-l2d-set__legend{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary,inherit);}
.dsh-l2d-set__row{display:grid;grid-template-columns:132px minmax(0,1fr);gap:8px 12px;align-items:center;}
.dsh-l2d-set__label{color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95));}
.dsh-l2d-set__control{min-width:0;display:flex;align-items:center;gap:8px;}
.dsh-l2d-set__hint{grid-column:2;font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8));}
.dsh-l2d-set__inline{display:flex;gap:8px;align-items:center;min-width:0;width:100%;}
.dsh-l2d-set__inline select{flex:1;min-width:0;}
.dsh-l2d-set input[type="text"],.dsh-l2d-set input[type="number"],.dsh-l2d-set select,.dsh-l2d-set textarea{
  width:100%;min-width:0;padding:5px 8px;border-radius:8px;font:inherit;
  color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));outline:none;}
.dsh-l2d-set input[type="text"]:focus,.dsh-l2d-set input[type="number"]:focus,.dsh-l2d-set select:focus,.dsh-l2d-set textarea:focus{
  border-color:var(--dsw-alias-brand-primary,#4d6bfe);}
.dsh-l2d-set textarea{resize:vertical;line-height:1.5;font-family:inherit;}
.dsh-l2d-set input[type="number"]{max-width:96px;}
.dsh-l2d-set__range{display:flex;align-items:center;gap:10px;width:100%;}
.dsh-l2d-set__range input[type="range"]{flex:1;min-width:0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe);}
.dsh-l2d-set__range output{flex:none;min-width:52px;text-align:right;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95));}
.dsh-l2d-set__check{display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--dsw-alias-label-primary,inherit);}
.dsh-l2d-set__check input[type="checkbox"]{accent-color:var(--dsw-alias-brand-primary,#4d6bfe);}
.dsh-l2d-set__actions{position:sticky;bottom:-2px;z-index:3;display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:10px 12px;margin:0 -2px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-1,#1b1e26);
  backdrop-filter:blur(6px);
  box-shadow:0 -8px 16px -10px rgba(0,0,0,.55);
  border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));}
.dsh-l2d-set__actions button{padding:6px 14px;border-radius:8px;font:inherit;cursor:pointer;
  color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));}
.dsh-l2d-set__actions button.primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff;}
.dsh-l2d-set__actions button:hover{filter:brightness(1.08);}
.dsh-l2d-set__status{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));}
.dsh-l2d-set__chips{display:flex;flex-wrap:wrap;gap:6px;}
.dsh-l2d-set__chips .chip{padding:3px 10px;border-radius:999px;font:inherit;font-size:12px;cursor:pointer;
  color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.1));
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));}
.dsh-l2d-set__chips .chip:hover{filter:brightness(1.12);border-color:var(--dsw-alias-brand-primary,#4d6bfe);}
.dsh-l2d-set__pool{display:flex;flex-direction:column;gap:6px;margin-top:8px;padding:8px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));}
.dsh-l2d-set__pool-head{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-primary,inherit);}
.dsh-l2d-set__pool-head span{flex:1 1 auto;}
.dsh-l2d-set__pool-head button{padding:2px 8px;font-size:11px;border-radius:6px;cursor:pointer;
  color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.12));
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));}
.dsh-l2d-set__pool-list{display:flex;flex-wrap:wrap;gap:5px;max-height:140px;overflow-y:auto;padding-top:4px;}
.dsh-l2d-set__pool-item{display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;
  padding:2px 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.1));
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));}
.dsh-l2d-set__tag{font-size:10px;padding:0 4px;border-radius:4px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8));
  background:rgba(127,127,127,.12);}
.dsh-l2d-set__kv{display:flex;flex-direction:column;gap:3px;font-size:12px;}
.dsh-l2d-set__kv-row{display:flex;gap:8px;align-items:baseline;}
.dsh-l2d-set__kv-key{flex:0 0 76px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));}
.dsh-l2d-set__kv-val{flex:1 1 auto;color:var(--dsw-alias-label-primary,inherit);word-break:break-word;}
.dsh-l2d-set__warn{font-size:12px;margin:4px 0 0;color:var(--dsw-alias-label-warning,#e0a44a);}
.dsh-l2d-set__live{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 8px;margin:2px 0 4px;
  border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));
  border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.28));font-size:12px;}
.dsh-l2d-set__live-line{flex:1 1 240px;color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95));}
.dsh-l2d-set__live .chip{padding:2px 9px;border-radius:999px;font:inherit;font-size:12px;cursor:pointer;
  color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));}
.dsh-l2d-set__group>button[type="button"]{align-self:flex-start;padding:5px 12px;border-radius:8px;font:inherit;cursor:pointer;
  color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));}
@media (max-width:520px){.dsh-l2d-set__row{grid-template-columns:1fr;}.dsh-l2d-set__hint{grid-column:1;}}
.dsh-l2d-preview{position:fixed;z-index:2147483000;width:340px;max-width:calc(100vw - 16px);background:var(--dsw-alias-bg-layer-1,#1b1e26);
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:12px;overflow:hidden;pointer-events:auto;
  box-shadow:0 8px 28px rgba(0,0,0,.35);color:var(--dsw-alias-label-primary,#fff);
  display:flex;flex-direction:column;min-width:220px;min-height:160px;
  /* 浏览器原生调尺寸手柄：即使自定义拖拽失效，用户也一定能拉动这个角 */
  resize:both;}
.dsh-l2d-preview__head{display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:grab;
  background:var(--dsh-alias-bg-layer-2,rgba(127,127,127,.08));font-size:12px;
  color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8));user-select:none;}
.dsh-l2d-preview__head span{flex:1 1 auto;font-weight:600;color:var(--dsw-alias-label-primary,#fff);}
.dsh-l2d-preview__head button{padding:2px 8px;font-size:11px;border-radius:6px;cursor:pointer;
  color:var(--dsw-alias-label-primary,inherit);background:var(--dsh-alias-bg-layer-2,rgba(127,127,127,.14));
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));}
.dsh-l2d-preview__body{padding:8px;position:relative;background:var(--dsh-alias-bg-layer-1,#1b1e26);display:flex;flex-direction:column;flex:1 1 auto;min-height:0;}
.dsh-l2d-preview__canvas{position:relative;display:block;width:100%;flex:1 1 auto;min-height:120px;overflow:hidden;border-radius:8px;background:#000;}
.dsh-l2d-preview__x{white-space:nowrap;}
.dsh-l2d-preview__z{min-width:26px;padding:2px 6px !important;font-size:13px !important;line-height:1;}
.dsh-l2d-preview__zoom{flex:0 0 auto !important;font-size:11px;opacity:.85;white-space:nowrap;
  font-weight:400 !important;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.85)) !important;}
.dsh-l2d-preview__grip{position:absolute;right:6px;bottom:4px;font-size:12px;line-height:1;
  opacity:.55;pointer-events:none;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8));}
.dsh-l2d-preview__line{margin-top:6px;font-size:12px;color:var(--dsh-alias-label-primary,#fff);}
.dsh-l2d-preview__hint{margin-top:2px;font-size:10px;color:var(--dsh-alias-label-tertiary,rgba(127,127,127,.7));}
.dsh-l2d-set__live canvas{display:block;width:100%;max-width:360px;border-radius:8px;background:#000;
  border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));}
.dsh-l2d-preview-toggle{position:fixed;right:12px;bottom:12px;z-index:9800;padding:6px 12px;border-radius:999px;
  cursor:pointer;font:inherit;font-size:12px;color:var(--dsh-alias-label-primary,inherit);
  background:var(--dsh-alias-bg-layer-1,#1b1e26);border:1px solid var(--dsh-alias-border-l2,rgba(127,127,127,.3));}
`

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v))
  }

  function postReport(payload) {
    try {
      fetch(PREFIX + '/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        keepalive: true,
        body: JSON.stringify(Object.assign({ at: Date.now() }, payload)),
      }).catch(() => {})
    } catch { /* diagnostics only */ }
  }

  function num(v, fallback, lo, hi) {
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n)) return fallback
    return clamp(n, lo, hi)
  }

  // 演出池：数组里只留非空字符串，最多 200 项；空数组 = "全部可用项"
  function toPool(value) {
    if (!Array.isArray(value)) return []
    const out = []
    value.forEach((item) => {
      if (typeof item === 'string' && item.trim() && !out.includes(item)) out.push(item)
    })
    return out.slice(0, 200)
  }

  function normalizeConfig(raw) {
    const input = raw && typeof raw === 'object' ? raw : {}
    const c = Object.assign({}, DEFAULT_CONFIG, input)
    c.scale = num(c.scale, 1, 0.2, 4)
    c.heightRatio = num(c.heightRatio, 0.74, 0.2, 1.6)
    c.offsetX = num(c.offsetX, 36, -4000, 4000)
    c.offsetY = num(c.offsetY, 0, -4000, 4000)
    c.opacity = num(c.opacity, 1, 0, 1)
    c.scrim = num(c.scrim, 0.18, 0, 0.8)
    c.idleSeconds = num(c.idleSeconds, 45, 10, 3600)
    c.bubbleMs = num(c.bubbleMs, 5200, 1500, 30000)
    c.minDwellMs = num(c.minDwellMs, 380, 0, 5000)
    c.successMs = num(c.successMs, 2600, 400, 10000)
    c.errorMs = num(c.errorMs, 5200, 600, 20000)
    c.zIndex = Math.round(num(c.zIndex, -2, -10, 0))
    c.gaze = c.gaze !== false
    c.appTransparent = c.appTransparent !== false
    // 视线参数
    c.gazeAngleX = num(c.gazeAngleX, 20, 0, 60)
    c.gazeAngleY = num(c.gazeAngleY, 14, 0, 40)
    c.gazeEyeBallX = num(c.gazeEyeBallX, 0.7, 0, 2)
    c.gazeEyeBallY = num(c.gazeEyeBallY, 0.6, 0, 2)
    c.gazeSmooth = num(c.gazeSmooth, 0.08, 0.01, 0.5)
    c.gazeReturnSmooth = num(c.gazeReturnSmooth, 0.04, 0.01, 0.5)
    c.bodyFollowX = num(c.bodyFollowX, 10, 0, 30)
    c.bodyFollowY = num(c.bodyFollowY, 7, 0, 25)
    // 空闲/演出频率
    c.idleExpressionChance = num(c.idleExpressionChance, 0.7, 0, 1)
    c.idleMotionChance = num(c.idleMotionChance, 0.35, 0, 1)
    // 独立随机动作。间隔下限 5s：以前 0 表示"关闭"，但滑杆拉到 0 时用户
    // 以为"最频繁"，结果是彻底不动 —— 所以 0 不再等于关闭，关闭请用概率 0。
    c.randomMotionSeconds = num(c.randomMotionSeconds, 45, 5, 3600)
    c.randomMotionChance = num(c.randomMotionChance, 0.35, 0, 1)
    c.motionHoldMs = num(c.motionHoldMs, 4000, 600, 20000)
    // 空闲随机演出池（动作池 + 表情池）：空数组 = 全部可用项
    c.idleMotionPool = toPool(c.idleMotionPool)
    c.idleExpressionPool = toPool(c.idleExpressionPool)
    c.idleExpressionEnabled = c.idleExpressionEnabled !== false
    c.idleMotionEnabled = c.idleMotionEnabled !== false
    c.idleExpressionSeconds = num(c.idleExpressionSeconds, 15, 3, 3600)
    c.randomExpressionChance = num(c.randomExpressionChance, 0.5, 0, 1)
    c.expressionHoldMs = num(c.expressionHoldMs, 4000, 300, 30000)
    c.idleMotionGroup = typeof c.idleMotionGroup === 'string' ? c.idleMotionGroup : ''
    c.idleLoopEnabled = c.idleLoopEnabled !== false
    // 预览取景（只作用于预览小窗）
    c.previewZoom = num(c.previewZoom, 1.6, 0.3, 5)
    c.previewOffsetX = num(c.previewOffsetX, 0, -2000, 2000)
    c.previewOffsetY = num(c.previewOffsetY, 0, -2000, 2000)
    // 对话感知
    c.reactToUserMessage = c.reactToUserMessage !== false
    c.reactToToolCall = c.reactToToolCall !== false
    c.reactToChoices = c.reactToChoices !== false
    c.showNose = c.showNose === true
    c.noseMode = c.noseMode === 'off' || c.noseMode === 'original' ? c.noseMode : (c.showNose ? 'original' : 'soft')
    c.motionIntensity = num(c.motionIntensity, 1.4, 0, 3)
    if (!Array.isArray(c.idleLines) || c.idleLines.length === 0) c.idleLines = DEFAULT_CONFIG.idleLines
    c.idleLines = c.idleLines.filter((line) => typeof line === 'string' && line.trim())
    if (!c.idleLines.length) c.idleLines = DEFAULT_CONFIG.idleLines
    c.expressions = Object.assign({}, input.expressions && typeof input.expressions === 'object' ? input.expressions : {})
    if (typeof c.anchor !== 'string' || !/^(bottom|center|top)-(left|center|right)$/.test(c.anchor)) c.anchor = 'bottom-right'
    if (!c.modelUrl) c.modelUrl = DEFAULT_MODEL
    return c
  }

  const scriptCache = new Map()
  function loadScript(src) {
    if (!scriptCache.has(src)) {
      scriptCache.set(src, new Promise((resolve, reject) => {
        const el = document.createElement('script')
        el.src = src
        el.async = false
        el.onload = () => resolve()
        el.onerror = () => reject(new Error(`脚本加载失败：${src}`))
        document.head.appendChild(el)
      }))
    }
    return scriptCache.get(src)
  }

  let libsPromise = null
  async function ensureLibs() {
    if (window.PIXI && window.PIXI.live2d) return
    if (!libsPromise) {
      libsPromise = (async () => {
        if (!window.Live2DCubismCore) await loadScript(PREFIX + '/assets/vendor/live2dcubismcore.min.js')
        if (!window.PIXI) await loadScript(PREFIX + '/assets/vendor/pixi.min.js')
        await loadScript(PREFIX + '/assets/vendor/cubism4.min.js')
        if (!window.PIXI || !window.PIXI.live2d) throw new Error('pixi-live2d-display 初始化失败')
      })().catch((err) => {
        libsPromise = null
        throw err
      })
    }
    return libsPromise
  }

  async function fetchJson(url) {
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) throw new Error(`读取模型配置失败：HTTP ${res.status}`)
    return res.json()
  }

  function createStage(options) {
    options = options || {}
    const config = normalizeConfig(options.config)
    const phaseHook = typeof options.onPhase === 'function' ? options.onPhase : () => {}
    const sayHook = typeof options.onSay === 'function' ? options.onSay : () => {}
    const errorHook = typeof options.onError === 'function' ? options.onError : () => {}
    const readyHook = typeof options.onReady === 'function' ? options.onReady : () => {}

    if (window.__dshLive2DStage && typeof window.__dshLive2DStage.destroy === 'function') {
      try { window.__dshLive2DStage.destroy() } catch { /* ignore */ }
    }

    let destroyed = false
    let ready = false
    let app = null
    let model = null
    let expressionNames = []
    let motionGroups = []
    let motionCatalog = []
    let modelInfo = null
    let cdi3Names = null
    let modelRefs = {}
    let noseSampleLogged = false
    // 按 model3.json 的顺序自己加载贴图：SDK 的 internalModel.textures
    // 在加载完成前是空数组，采样黑块不能依赖它。
    let modelTextureImages = []

    function encodeModelPath(root, rel) {
      const parts = String(rel).split('/').map((seg) => (/^[A-Za-z0-9._~%+-]+$/.test(seg) ? seg : encodeURIComponent(seg)))
      return root + parts.join('/')
    }

    async function loadModelTextures(refs) {
      const list = (refs && refs.Textures) || []
      if (!list.length) return []
      const root = config.modelUrl.replace(/[^/]*$/, '')
      const images = []
      for (const rel of list.slice(0, 12)) {
        images.push(await new Promise((resolve) => {
          try {
            const el = new Image()
            el.crossOrigin = 'anonymous'
            el.onload = () => resolve(el)
            el.onerror = () => resolve(null)
            el.src = encodeModelPath(root, rel)
          } catch { resolve(null) }
        }))
      }
      return images
    }
    let currentExpression = null
    let previousExpressionName = null
    // 运行计数：设置页"是否真的起作用"的自检依据
    const stats = { motions: 0, idles: 0, expressions: 0, phases: 0, reacts: 0 }
    let reactStart = 0
    let reactDur = 0
    let reactKind = ''
    let baseParamSnapshot = null
    // 表情竞态守卫：exprSeq 每次应用/收尾都自增；exprPending 是在途的表情 promise。
    // 收尾必须"恰好一次"，且在途 promise 落地之后 —— 表情 motion 是加法队列项，
    // 在它存活期间裸写参数会污染 SDK 的 original 快照，造成每轮累加。
    let exprSeq = 0
    let exprPending = null
    let expressionWarned = {}
    let phase = typeof options.phase === 'string' ? options.phase : 'idle'
    let phaseAt = 0
    let phaseTimer = null
    let tempExprTimer = null
    // 表情占用期：高优先级表情（对话反应 > 阶段 > 空闲随机）在 hold 期间
    // 不被低优先级覆盖，到点一定回到当前阶段的基础表情。
    let exprTimer = null
    let exprHoldUntil = 0
    let exprHoldPriority = 0
    // 表情占用期同样由渲染 tick 推进：setTimeout 在窗口后台/被节流时
    // 会晚很多甚至不跑，用户看到的就是一次表情粘住不走。
    let exprHoldArmedAt = 0
    let exprRestoreCount = 0
    let idleTimer = null
    let randomMotionTimer = null
    let randomExpressionTimer = null
    // 上面两个 timer 已废弃（调度改由渲染 tick 的墙钟 deadline 驱动）；
    // 保留声明只是为了 destroy() 里的 clearInterval 兜底不报错。
    let sse = null
    let sayTimer = null
    let naturalHeight = 0
    let lastActivity = Date.now()
    let lastPointerAt = 0
    // 随机动作调度器的排障计数器：调了概率却"没反应"时，看 alive 报告里的
    // motionTicks / lastMotionSkip 就知道是没到点、被跟随让位、还是压根没跑。
    let motionTicks = 0
    let lastMotionSkip = 'init'
    let expressionTicks = 0
    let lastExpressionSkip = 'init'
    let lastMotionFired = ''      // 'yes' = 上一次到点确实播了动作
    let lastExpressionFired = ''  // 上一次到点实际贴上的表情名
    // 下一次随机动作 / 表情的墙钟截止时间（由渲染 tick 检查，不用定时器）
    let nextMotionAt = 0
    let nextExpressionAt = 0
    let lastSayAt = 0
    let tilt = 0
    let tiltTarget = 0
    let idleHead = 0
    let glance = 0            // 当前"瞥一眼"的偏移量（度）
    let glanceAt = 0          // 下一次触发的时间戳
    let glanceTarget = 0
    let glanceHold = 0
    let glanceBusy = false
    let host = null
    let canvas = null
    let scrim = null
    let styleEl = null
    let noseSprite = null
    let nosePartDrawables = []
    let idleErrReported = false

    const focus = { x: 0, y: 0, tx: 0, ty: 0, active: false }
    const listeners = []

    function listen(target, type, fn, opts) {
      target.addEventListener(type, fn, opts)
      listeners.push(() => target.removeEventListener(type, fn, opts))
    }

    function warnOnce(key, message) {
      if (expressionWarned[key]) return
      expressionWarned[key] = true
      console.warn('[dsh-live2d-stage] ' + message)
      if (typeof options.onWarn === 'function') options.onWarn(message)
    }

    // One-shot self check: the host writes this to a temp file, so a blank
    // stage can be diagnosed from outside the browser.
    function report(event, extra) {
      if (typeof options.report === 'function') {
        try { options.report(event, extra) } catch { /* ignore */ }
      }
      try {
        postReport(Object.assign({
          event,
          modelUrl: config.modelUrl,
          phase,
          viewport: [window.innerWidth, window.innerHeight],
          dpr: window.devicePixelRatio || 1,
        }, extra || {}))
      } catch { /* ignore */ }
    }

    function buildDom() {
      host = document.createElement('div')
      host.className = 'dsh-l2d-layer'
      host.setAttribute('aria-hidden', 'true')
      host.setAttribute('role', 'presentation')
      host.style.zIndex = String(config.zIndex)
      host.style.setProperty('--dsh-l2d-opacity', String(config.opacity))

      canvas = document.createElement('canvas')
      canvas.className = 'dsh-l2d-canvas'
      host.appendChild(canvas)

      // The app frame is about to become transparent, so the layer itself has
      // to carry the page's base colour — otherwise a transparent window (or
      // a white browser canvas) would show through around the model.
      try {
        const base = getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim()
        host.style.backgroundColor = base && base !== 'transparent' && base !== 'rgba(0, 0, 0, 0)' ? base : '#14161c'
      } catch {
        host.style.backgroundColor = '#14161c'
      }

      styleEl = document.createElement('style')
      styleEl.setAttribute('data-dsh-live2d', '')
      styleEl.textContent = CSS
      host.appendChild(styleEl)

      if (config.appTransparent) {
        document.documentElement.setAttribute(STAGE_ATTR, '')
        document.body.setAttribute(STAGE_ATTR, '')
      }

      updateScrim()
      document.body.appendChild(host)
    }

    function scrimGradient() {
      return 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,' +
        (config.scrim * 0.35).toFixed(3) + ') 55%, rgba(0,0,0,' + config.scrim.toFixed(3) + ') 100%)'
    }

    function updateScrim() {
      if (config.scrim > 0) {
        if (!scrim) {
          scrim = document.createElement('div')
          scrim.className = 'dsh-l2d-scrim'
          document.body.appendChild(scrim)
        }
        scrim.style.zIndex = String(config.zIndex + 1)
        scrim.style.background = scrimGradient()
      } else if (scrim) {
        if (scrim.parentNode) scrim.parentNode.removeChild(scrim)
        scrim = null
      }
    }

    function destroyDom() {
      if (host && host.parentNode) host.parentNode.removeChild(host)
      if (scrim && scrim.parentNode) scrim.parentNode.removeChild(scrim)
      document.documentElement.removeAttribute(STAGE_ATTR)
      document.body.removeAttribute(STAGE_ATTR)
    }

    function layout() {
      if (!app || !model) return
      // 预览模式下画布被搬进预览小窗，整个舞台按小窗尺寸重排，
      // 这样预览里看到的就是"背景层本身"，不需要任何截屏/拷贝。
      const w = previewBox
        ? Math.max(80, previewBox.clientWidth || 300)
        : (window.innerWidth || document.documentElement.clientWidth || 1)
      const h = previewBox
        ? Math.max(60, previewBox.clientHeight || 220)
        : (window.innerHeight || document.documentElement.clientHeight || 1)
      // 注意：app.renderer.width/height 是"物理像素"（已乘 resolution），
      // 拿它跟 innerWidth 比较会永远不相等，于是每帧都 resize，
      // WebGL 帧缓冲被反复重建 → 画布上永远出不来画面。
      // 用 renderer.screen（CSS 像素）判断，并留 1px 容差。
      const screen = app.renderer.screen
      if (Math.abs(screen.width - w) > 1 || Math.abs(screen.height - h) > 1) {
        app.renderer.resize(w, h)
      }
      const baseHeight = naturalHeight || model.internalModel.height || 1
      // 预览模式单独一套取景：默认把模型放大约 1.6 倍并对齐顶部中央，
      // 这样小窗里看到的是"头 + 上半身"，而不是被压成一个小人。
      const zoom = previewBox ? Math.max(0.2, Number(config.previewZoom) || 1) : 1
      const scale = (h * config.heightRatio * config.scale * zoom) / baseHeight
      model.scale.set(scale, scale)
      const anchorBits = previewBox ? ['top', 'center'] : config.anchor.split('-')
      const ay = anchorBits[0]
      const ax = anchorBits[1] === 'center' ? 'center' : anchorBits[1]
      const anchorX = ax === 'left' ? 0 : ax === 'right' ? 1 : 0.5
      const anchorY = ay === 'top' ? 0 : ay === 'bottom' ? 1 : 0.5
      model.anchor.set(anchorX, anchorY)
      let x
      let y
      if (previewBox) {
        // 预览：顶部对齐 + 水平居中（胸像取景）
        x = w / 2 + (Number(config.previewOffsetX) || 0)
        y = (Number(config.previewOffsetY) || 0)
      } else if (ax === 'left') x = config.offsetX
      else if (ax === 'right') x = w - config.offsetX
      else x = w / 2 + config.offsetX
      if (!previewBox) {
        if (ay === 'top') y = config.offsetY
        else if (ay === 'bottom') y = h - config.offsetY
        else y = h / 2 + config.offsetY
      }
      model.position.set(x, y)
    }

    function hasParam(id) {
      try {
        return model.internalModel.coreModel.getParameterIndex(id) >= 0
      } catch {
        return false
      }
    }

    function addParam(id, delta) {
      if (!delta) return
      try {
        const core = model.internalModel.coreModel
        const index = core.getParameterIndex(id)
        if (!(index >= 0)) return
        const base = core.getParameterValueById(id)
        if (!Number.isFinite(base)) return
        core.setParameterValueById(id, base + delta)
      } catch { /* parameter not present in this model */ }
    }

    // Store the resting (neutral) values of gaze parameters captured before any
    // gaze has been applied. These are the model-author baseline.
    let gazeBase = null

    function captureGazeBase() {
      try {
        const core = model.internalModel.coreModel
        gazeBase = {}
        for (const id of ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
          'ParamEyeBallX', 'ParamEyeBallY', 'HipAngleX', 'HipAngleY', 'HipAngleZ']) {
          if (core.getParameterIndex(id) >= 0) gazeBase[id] = core.getParameterValueById(id)
        }
      } catch { gazeBase = {} }
      for (const key of Object.keys(gazeApplied || {})) gazeApplied[key] = 0
      for (const key of Object.keys(swayApplied || {})) swayApplied[key] = 0
    }

    // Hide accessory/effect parts whose name suggests they are not part of the
    // base appearance.  This is a heuristic for VTube-Studio-exported models
    // where every Part ships with opacity 1 by default.
    // Zero out every custom-accessory parameter the model declares.  These are
    // VTube Studio "expression keys" that ship with non-zero defaults and
    // control glasses / sweat / skirt toggle / hand props / alternate eyes.
    // `model.update(0)` was already called so every parameter's backing
    // storage is allocated and writable.
    //
    // Additionally, some VTube Studio exports ship *dark-variant* parts
    // (face shadow, alternate nose, etc.) that the artist intends to
    // toggle on/off via expression keys — but if those keys are zero the
    // SDK's Parameter→Part evaluation keeps the parts at default opacity=1,
    // so the shadow/nose2 renders as a black spot on top of the base art.
    // The named-part blacklist below hides them by name.
    function hideDefaultAccessories() {
      if (!model) return
      // 这几组参数是大肥鱼（VTube Studio 导出）专属的配件开关，
      // 别的模型上同名参数可能另有含义，所以只在识别到黑色鼻子方块时才处理。
      if (!nosePartDrawables.length) return
      try {
        const core = model.internalModel.coreModel
        for (let i = 1; i <= 20; i++) {
          const id = 'key' + i
          if (core.getParameterIndex(id) >= 0) core.setParameterValueById(id, 0)
        }
        for (const prefix of ['Clothes', 'Movement', 'Divider', 'Hat2ph',
          'RFlip', 'LFlip', 'LControl', 'RCry', 'LCry']) {
          for (let i = 1; i <= 10; i++) {
            const id = prefix + i
            if (core.getParameterIndex(id) >= 0) core.setParameterValueById(id, 0)
          }
        }
        for (const id of ['SHOCKEYE', 'Param11', 'Startwinkle', 'Startwinkle2',
          'Paramshuiyin7', 'Paramshuiyin8', 'Param12', 'Param13',
          'AniEyerolling', 'Ani1', 'Ani2', 'SWITCHA']) {
          if (core.getParameterIndex(id) >= 0) core.setParameterValueById(id, 0)
        }
      } catch { /* outer guard */ }
    }

    // Write gaze as an OFFSET on top of whatever the idle motion produced this
    // frame. We subtract the offset we added last frame first, so the write is
    // idempotent and never accumulates (the old bug that made the eyes roll
    // out), while the motion's own head movement still shows through.
    const gazeApplied = {}
    // 绝对写入：base + offset。曾经的"读当前值再加减"在动作曲线每帧
    // 覆写参数时会不断累积漂移，最终把头部参数顶到 ±30 的极限，
    // 看起来就是"跟随没反应"。
    function setGazeParam(id, offset) {
      if (!gazeBase) return
      try {
        const core = model.internalModel.coreModel
        const idx = core.getParameterIndex(id)
        if (idx < 0) return
        const b = (gazeBase[id] === undefined) ? core.getParameterValueById(id) : gazeBase[id]
        const lo = typeof core.getParameterMinimumValue === 'function' ? core.getParameterMinimumValue(idx) : -1e9
        const hi = typeof core.getParameterMaximumValue === 'function' ? core.getParameterMaximumValue(idx) : 1e9
        let v = b + offset
        if (v < lo) v = lo
        if (v > hi) v = hi
        core.setParameterValueById(id, v, 1)
        gazeApplied[id] = offset
      } catch { /* ignore */ }
    }

    function resetGazeOffsets() {
      for (const key of Object.keys(gazeApplied)) gazeApplied[key] = 0
    }

    // 表情 motion 是持续写参数的队列项：不先停掉它，任何"恢复"都会在
    // 下一帧被它重新覆写。stopAllExpressions 是 SDK 表达式队列的收尾入口。
    function expressionManager() {
      return model && model.internalModel && model.internalModel.motionManager
        && model.internalModel.motionManager.expressionManager || null
    }
    function stopExpressions() {
      const em = expressionManager()
      try {
        if (em && em.stopAllExpressions) em.stopAllExpressions()
        else if (em && em.queueManager && em.queueManager.stopAllMotions) em.queueManager.stopAllMotions()
      } catch { /* ignore */ }
    }
    // 全参数快照：不依赖 EXPRESSION_PARAMS 白名单 —— 模型作者自定义的表情
    // 参数（如薇薇安的 Param144）不在标准名单里，白名单方案永远恢复不掉。
    function snapshotParameters() {
      try {
        const vals = model.internalModel.coreModel._model.parameters.values
        return vals ? Float32Array.from(vals) : null
      } catch { return null }
    }
    // 每帧由视线/摇摆/呼吸写入的参数。恢复基线时必须跳过它们：
    // 1) 整表回写会让它们瞬间跳回旧快照（可见的"闪动"）；
    // 2) addSway 是相对写入（cur - prev + offset），被回写后 cur 变基线值
    //    而 swayApplied 仍是旧偏移，等于每个参数永久漂移 -旧偏移 —— 头/身体
    //    突然错位就是这么来的。
    function protectedParamIds() {
      const ids = new Set()
      Object.keys(gazeBase || {}).forEach((id) => ids.add(id))
      Object.keys(gazeApplied || {}).forEach((id) => ids.add(id))
      Object.keys(swayApplied || {}).forEach((id) => ids.add(id))
      ids.add('ParamBreath')
      return ids
    }
    function restoreParameters(snap) {
      if (!snap) return
      try {
        const core = model.internalModel.coreModel
        const vals = core._model.parameters.values
        const ids = core._model.parameters.ids
        const prot = protectedParamIds()
        const n = Math.min(snap.length, vals.length)
        for (let i = 0; i < n; i += 1) {
          if (prot.has(String(ids[i] || ''))) continue
          vals[i] = snap[i]
        }
        // 非受保护的摇摆参数（若有）被回写后，相对写入的账目要清零
        Object.keys(swayApplied || {}).forEach((id) => {
          if (!prot.has(id)) swayApplied[id] = 0
        })
      } catch { /* ignore */ }
    }
    // 回到"无表情"基线：停掉表情队列 + 整表恢复参数快照。
    // 若此刻还有表情在异步加载（SDK 会 load 完再启动队列项），加载落地后
    // 再停+回写一次；期间若有新的表情应用（seq 变了）则跳过，互不误伤。
    // thenApply：收尾后立刻贴上的"基础表情"（如 idle 的 Normal）。
    // 整个"停队列 + 回写基线 + 贴新表情"必须在迟到的加载落地后一次完成，
    // 否则裸写会被仍在呼吸的表情加法队列覆写，出现每轮累加。
    function returnToBase(thenApply) {
      if (destroyed || !model) return
      const seq = ++exprSeq
      const pend = exprPending
      exprPending = null
      const settle = function () {
        if (destroyed || !model || seq !== exprSeq) return
        stopExpressions()
        restoreParameters(baseParamSnapshot)
        currentExpression = null
        if (thenApply) setExpressionRaw(thenApply, 'base-then')
      }
      if (pend && !pend.__dshDone) pend.then(settle, settle)
      else settle()
    }

    function resolveExpression(nextPhase) {
      // 新的三场景键优先，旧的阶段键作为兼容回退：
      //   input  = 刚输入（用户发了消息）
      //   output = 刚输出（这一轮回答结束）
      //   ask    = 提问/等待（需要用户确认或回答）
      const chain = [nextPhase]
      if (nextPhase === 'success') chain.push('output')
      if (nextPhase === 'waiting') chain.push('ask')
      if (nextPhase === 'input') chain.push('idle')
      if (nextPhase === 'output') chain.push('success')
      if (nextPhase === 'ask') chain.push('waiting')
      const map = config.expressions || {}
      for (const key of chain) {
        const override = map[key]
        if (typeof override !== 'string' || !override) continue
        const hit = expressionNames.find((name) => name.toLowerCase() === override.toLowerCase())
        if (hit) return hit
      }
      const candidates = []
      for (const key of chain) {
        for (const candidate of PHASE_EXPRESSION[key] || []) {
          if (!candidates.some((c) => c.toLowerCase() === candidate.toLowerCase())) candidates.push(candidate)
        }
      }
      for (const candidate of candidates) {
        const exact = expressionNames.find((name) => name.toLowerCase() === candidate.toLowerCase())
        if (exact) return exact
      }
      for (const candidate of candidates) {
        const partial = expressionNames.find((name) => name.toLowerCase().includes(candidate.toLowerCase()))
        if (partial) return partial
      }
      return null
    }

    // 真正的写入：只负责把表情写进模型，不碰计时器。
    function setExpressionRaw(name, reason) {
      if (!model || destroyed) return false
      // 模型本身没有任何 exp3 表情（如 z46）：静默跳过，不必每次阶段切换都告警。
      if (!expressionNames.length) return false
      if (!name) {
        // 没有可用表情：明确回到基线（停 motion + 恢复参数），而不是留着上一张
        returnToBase()
        return true
      }
      if (name === currentExpression) return true
      const index = expressionNames.findIndex((n) => n.toLowerCase() === name.toLowerCase())
      if (index < 0) {
        warnOnce('invalid:' + name, `表情 ${name} 不在模型定义中，拒绝写入并回退参数快照`)
        returnToBase()
        return false
      }
      try {
        // 切换表情前先回到基线：上一张的 motion 不停掉，它的参数会一直叠在新表情上
        if (currentExpression) returnToBase()
        if (!baseParamSnapshot) baseParamSnapshot = snapshotParameters()
        previousExpressionName = currentExpression
        exprSeq += 1
        try {
          const res = model.expression(index)
          if (res && typeof res.then === 'function') {
            exprPending = res
            res.then(function () { res.__dshDone = true }, function () { res.__dshDone = true })
          } else {
            exprPending = null
          }
        } catch (err0) { exprPending = null }
        currentExpression = expressionNames[index]
        stats.expressions += 1
        return true
      } catch (err) {
        warnOnce('apply:' + name, `表情 ${name} 应用失败，回退参数快照：${err && err.message ? err.message : err}`)
        returnToBase()
        return false
      }
    }

    // 到期后应该回到的表情：当前阶段的专属表情，没有就用 idle 的基础表情。
    function baseExpression() {
      if (phase === 'waiting') return resolveExpression('ask')
      if (phase === 'success') return resolveExpression('output')
      return resolveExpression('idle')
    }

    // 带优先级与"占用期"的表情写入。
    //   priority 3 = 对话反应（刚输入/提问），2 = 阶段表情，1 = 空闲随机
    //   ttl > 0：占用 ttl 毫秒，到点**无论如何**回到 baseExpression()。
    //   以前这里错误地要求 phase 必须是 idle 才恢复，导致对话进行中
    //   临时表情永远不消失（用户报的"表情停留时长无效"）。
    function applyExpression(name, opts) {
      const o = opts || {}
      const priority = typeof o.priority === 'number' ? o.priority : 1
      const ttl = typeof o.ttl === 'number' ? o.ttl : 0
      const now = Date.now()
      if (priority < exprHoldPriority && now < exprHoldUntil) return false
      const ok = setExpressionRaw(name, o.reason)
      if (!ok) return false
      if (ttl > 0) {
        exprHoldPriority = priority
        exprHoldUntil = now + ttl
      } else {
        // 没有 ttl 就是"一次性写入"，不占用：空闲随机立刻可以覆盖。
        // （曾经这里给 priority ≥2 设成"占用到下次阶段切换"，但只要某次
        //  阶段切换没走到，占用就永久不释放 —— 表现就是"一个表情永远不变"。）
        exprHoldPriority = 0
        exprHoldUntil = 0
      }
      clearTimeout(exprTimer)
      exprTimer = null
      // 到点收尾统一交给渲染 tick 里的 pumpExpressionHold()：
      // setTimeout 在窗口失焦时被节流到分钟级，表情就会"一直不停"。
      if (ttl > 0) exprHoldArmedAt = now + ttl
      return true
    }

    // 表情占用期收尾：到点必须回到"基础表情"，且要走 SDK 的 expression
    // 通道（裸写参数会被动作曲线下一帧覆写，等于没恢复）。
    function pumpExpressionHold() {
      if (!exprHoldArmedAt || Date.now() < exprHoldArmedAt) return
      exprHoldArmedAt = 0
      exprHoldPriority = 0
      exprHoldUntil = 0
      exprRestoreCount += 1
      if (destroyed || !model) return
      // 无论当前记录的是哪张，先真正回到基线（停 motion + 回写全参数快照），
      // 再把阶段基础表情贴上去。以前只改记录不写参数，就会出现
      // "状态行显示基础表情、脸还停在哭/慌张"的错位。
      returnToBase(baseExpression())
    }

    function playMotion(preferred, force) {
      if (!model || destroyed || !motionGroups.length) return
      var candidates = []
      var idleGroup = motionGroups.includes('IDLE') ? 'IDLE' : (motionGroups.includes('idle') ? 'idle' : null)
      if (preferred && motionGroups.includes(preferred)) candidates.push(preferred)
      for (var g = 0; g < motionGroups.length; g++) {
        var grp = motionGroups[g]
        if (grp === idleGroup) continue
        candidates.push(grp)
      }
      if (!candidates.length && idleGroup) candidates.push(idleGroup)
      if (!candidates.length) return
      var group = candidates[Math.floor(Math.random() * candidates.length)]
      // MotionPriority.NORMAL=2  → force-interrupts idle loop
      startRandomFrom(group, 2)
    }

    function applyPhase(next, immediate, force) {
      if (!next) return
      if (next === phase && !force) return
      const now = Date.now()
      const dwell = now - phaseAt
      if (!immediate && dwell < config.minDwellMs) {
        clearTimeout(phaseTimer)
        phaseTimer = setTimeout(() => applyPhase(next, true), config.minDwellMs - dwell)
        return
      }
      phase = next
      phaseAt = now
      lastActivity = now
      stats.phases += 1
      tiltTarget = next === 'waiting' ? 1 : 0
      clearTimeout(exprTimer)
      exprTimer = null
      exprHoldArmedAt = 0
      // 任何阶段切换都结束上一段"高层级"表情的占用，否则它会一直挡住常态随机。
      exprHoldPriority = 0
      exprHoldUntil = 0
      if (ready) {
        // 层级 1（高）：只有「刚输出 / 提问」这两个场景独占表情，占用时长 = 表情停留时长；
        // 层级 2（低）：idle/thinking/tool/error 只做一次性写入，不占用，常态随机可以覆盖。
        const sceneKey = next === 'success' ? 'output' : (next === 'waiting' ? 'ask' : null)
        const sceneTtl = sceneKey ? Math.max(1200, Math.min(10000, Number(config.expressionHoldMs) || 4000)) : 0
        applyExpression(baseExpression(), { ttl: sceneTtl, priority: sceneKey ? 2 : 1, reason: 'phase' })
        // 阶段一变就重算"能不能放动作"：只有回到 idle 才重新启动循环/池子动作。
        applyIdleLoopSwitch()
      }
      phaseHook(next)
    }

    function bubblePoint() {
      let x = window.innerWidth * 0.78
      let y = window.innerHeight * 0.42
      try {
        const bounds = model.getBounds()
        if (bounds.width > 0 && bounds.height > 0) {
          x = bounds.x + bounds.width * 0.5
          y = bounds.y + bounds.height * 0.12
        }
      } catch { /* model not ready */ }
      return { x: clamp(x, 110, window.innerWidth - 110), y: clamp(y, 90, window.innerHeight - 220) }
    }

    function speak(text, ttl) {
      if (!text || destroyed) return
      lastSayAt = Date.now()
      lastActivity = Date.now()
      const point = bubblePoint()
      sayHook({ text, x: point.x, y: point.y, ttl: ttl || config.bubbleMs })
    }

    function speakIdle() {
      const line = config.idleLines[Math.floor(Math.random() * config.idleLines.length)]
      speak(line)
      stats.idles += 1
      // 空闲台词时顺带做个表情：优先用表情池，没有池子就按"开心"类挑，
      // 再没有就随便挑一个可用的表情。
      const poolPicked = poolPick(config.idleExpressionPool, expressionNames)
      const playful = expressionNames.filter((name) => /smile|blush|happy|joy/i.test(name))
      let exprName = poolPicked
      if (!exprName) {
        if (playful.length) exprName = playful[Math.floor(Math.random() * playful.length)]
        else if (expressionNames.length) exprName = expressionNames[Math.floor(Math.random() * expressionNames.length)]
      }
      if (exprName && config.idleExpressionEnabled !== false && config.idleExpressionChance > 0 && Math.random() < config.idleExpressionChance) {
        // 空闲随机表情：优先级 1，只占用 expressionHoldMs，到点必定回到阶段表情
        applyExpression(exprName, { ttl: config.expressionHoldMs, priority: 1, reason: 'idle-play' })
      }
      if (config.idleMotionEnabled !== false && config.idleMotionChance > 0 && Math.random() < config.idleMotionChance) playPooledMotion()
    }

    // ── 空闲演出池：把"要随机做哪些动作/表情"交给用户自己组池 ────────
    // 池子为空 = 该模型全部可用项；勾选后只从池里随机，做到"挑几个动作/
    // 表情放进一个组"自由组合。
    function poolPick(pool, available) {
      const usable = (available || []).filter(Boolean)
      if (!usable.length) return ''
      const list = pool && pool.length ? pool.filter((name) => usable.indexOf(name) >= 0) : usable
      if (!list.length) return ''
      return list[Math.floor(Math.random() * list.length)]
    }

    // 动作池：按 label 命中 catalog 条目播放。
    // priority 1 = IDLE（当作基础待机循环用），2 = NORMAL。
    //
    // 占用期和常态表情一样：放出去之后，在它播完 / 占用期结束前，新的动作
    // 一律不打断。否则"每隔几秒抽一个新动作"会变成刚起个头就被下一个掐断。
    let motionBusyUntil = 0
    let motionStopTimer = null
    let motionStops = 0
    let holdArmed = 0
    let motionHoldUntil = 0

    // 动作持续时间由渲染 tick 推进（不依赖 setTimeout：窗口后台 / 虚拟时钟下
    // 定时器不可靠，之前就是"设了 3 秒却一直不收尾"）。
    function pumpMotionHold() {
      if (!motionHoldUntil) return
      if (Date.now() < motionHoldUntil) return
      motionHoldUntil = 0
      motionStops += 1
      try {
        const m = model && model.internalModel && model.internalModel.motionManager
        const st2 = m && m.state
        if (m && m.playing && st2 && st2.currentPriority >= 2) {
          if (m.stopAllMotions) m.stopAllMotions()
          if (st2.complete) st2.complete()
        }
        if (m && m.groups && m.groups.__holdIdle !== undefined) {
          m.groups.idle = m.groups.__holdIdle
          delete m.groups.__holdIdle
        }
      } catch { /* ignore */ }
      motionBusyUntil = 0
      if (!destroyed && ready) startIdleBeat()
    }
    function motionBusy() {
      // 只看"占用期"：有界，不会因为某个 Loop 动作永远不结束而把动作池锁死。
      return Date.now() < motionBusyUntil
    }
    function markMotionBusy(ms) {
      motionBusyUntil = Math.max(motionBusyUntil, Date.now() + Math.max(1200, Number(ms) || 0))
    }

    function playPooledMotion(priority) {
      const prio = priority === 1 ? 1 : 2
      if (!model || destroyed || !motionCatalog.length) return false
      // 正在播 / 还在占用期：这一拍直接放弃，不打断
      if (motionBusy()) return false
      const label = poolPick(config.idleMotionPool, motionCatalog.map((m) => m.label))
      const hit = motionCatalog.filter((m) => m.label === label)[0]
      if (!hit || !hit.group) {
        // 池子里没有匹配条目（模型换了、或全是扫描项）：退回全量随机
        playMotion(null)
        markMotionBusy(2500)
        return true
      }
      try {
        // 上一拍的演出动作如果是 Loop（SDK 里永远不会 isFinished），reserve() 会以
        // "Motion is already playing" 拒掉新动作 —— 先主动收尾，再放新的。
        const mgr = model.internalModel.motionManager
        const st = mgr && mgr.state
        if (mgr && mgr.playing && st && st.currentPriority >= 2) {
          if (mgr.stopAllMotions) mgr.stopAllMotions()
          if (st.complete) st.complete()
        }
      } catch { /* ignore */ }
      const started = startRandomFrom(hit.group, prio)
      // 只有"演出动作"才登记占用期；待机循环（prio 1）不该把后续动作挡住。
      // 时长由「动作持续时间」控制，到点如果还在播（Loop 动作不会自己结束）就收掉，
      // 保证用户看到的是"完整一段动作"，而不是一闪而过或永远循环。
      if (prio === 2) {
        markMotionBusy(config.motionHoldMs)
        motionHoldUntil = Date.now() + Math.max(600, Number(config.motionHoldMs) || 4000)
        // hold 期间不让 SDK 自己把待机循环接回来 —— 否则短动作播完 1 秒就被
        // 下一段循环顶掉，看起来就是"闪一下就没了"。
        try {
          const m2 = model.internalModel.motionManager
          if (m2 && m2.groups && m2.groups.idle !== '__none__' && m2.groups.__holdIdle === undefined) {
            m2.groups.__holdIdle = m2.groups.idle
            m2.groups.idle = '__none__'
          }
        } catch { /* ignore */ }
      }
      if (started && typeof started.then === 'function') {
        started.then(function (ok) { if (ok) stats.motions += 1 }).catch(function () {})
      }
      return true
    }

    // 基础待机循环的一拍：用户在动作池里挑过动作就只从池子里出，
    // 否则用自动识别/指定的待机组。这样「动作池」既是随机演出，
    // 也是基础循环的唯一来源 —— 池子选了就不会再乱播别的动作。
    function startIdleBeat() {
      if (destroyed || !model) return null
      // 演出动作的 hold 期间不重开待机，否则会立刻把刚起头的动作顶掉
      if (motionHoldUntil && Date.now() < motionHoldUntil) return null
      if (config.idleMotionPool && config.idleMotionPool.length && motionCatalog.length) {
        return playPooledMotion(1)
      }
      var mgr = model.internalModel && model.internalModel.motionManager
      if (!mgr || !mgr.groups || !mgr.groups.idle) return null
      return startRandomFrom(mgr.groups.idle, 1)
    }

    // 表情池：随机挑一个做表情，hold 到点后必定恢复（不再要求 phase 是 idle）
    function playPooledExpression(ttl) {
      if (!model || destroyed || !expressionNames.length) return ''
      const name = poolPick(config.idleExpressionPool, expressionNames)
      if (!name) return ''
      const hold = ttl || config.expressionHoldMs
      const ok = applyExpression(name, { ttl: hold, priority: 1, reason: 'idle-pool' })
      return ok ? name : ''
    }

    // 强制重开一拍待机：有些模型的 idle 动作是 Loop，状态机优先级一直是 1、
    // 永远不会"播完"，只靠看门狗的话换了动作池也不会生效。这里主动收尾再起一拍。
    function restartIdleBeat() {
      if (!model || destroyed) return false
      if (config.idleLoopEnabled === false) return false
      if (phase !== 'idle') return false  // 动作只在常态放
      try {
        var mgr = model.internalModel.motionManager
        if (!mgr) return false
        try { if (mgr.state && mgr.state.setReservedIdle) mgr.state.setReservedIdle(void 0, void 0) } catch (_) { /* ignore */ }
        try { if (mgr.stopAllMotions) mgr.stopAllMotions() } catch (_) { /* ignore */ }
        try { if (mgr.state && mgr.state.complete) mgr.state.complete() } catch (_) { /* ignore */ }
      } catch (_) { /* ignore */ }
      var started = startIdleBeat()
      try {
        if (started && typeof started.catch === 'function') started.catch(function () {})
      } catch (_) { /* ignore */ }
      return true
    }

    // 直接按定义挑一个动作条目播放。SDK 的 startRandomMotion 只会从
    // "已经加载过" 的条目里挑（全是 null 时直接返回 false），而 startMotion
    // 会按需加载，所以自己掷骰子更可靠。
    function startRandomFrom(group, priority) {
      if (!model || destroyed) return null
      try {
        var mgr = model.internalModel.motionManager
        var defs = mgr && mgr.definitions ? mgr.definitions[group] : null
        if (!defs || !defs.length) return null
        // 换模型/换动作时 SDK 可能留下一个永远清不掉的 idle 预约，
        // 之后所有 IDLE 请求都会被 reserve() 拒掉 → 模型定住。这里清一次。
        try {
          var st = mgr.state
          if (st && priority === 1 && st.currentPriority === 0 && st.reservedIdleGroup !== undefined) {
            st.setReservedIdle(void 0, void 0)
          }
          if (st && priority >= 2 && st.reservePriority && st.reservedGroup === group && st.currentPriority < priority) {
            st.setReserved(void 0, void 0, 0)
          }
        } catch (_) { /* ignore */ }
        var index = Math.floor(Math.random() * defs.length)
        var started = mgr.startMotion(group, index, priority)
        if (started && typeof started.then === 'function') {
          started.then(function (ok) {
            if (ok) stats.motions += 1
          }).catch(function () {})
        }
        return started
      } catch (_) { return null }
    }

    // 动作看门狗：动作播完/被打断后立刻把 IDLE 循环接回去，
    // 避免"动作做完就定住像一张图"。
    var stuckSince = 0
    function ensureIdleMotion() {
      if (destroyed || !model) return
      if (config.idleLoopEnabled === false) return
      // 动作只在常态放：思考/工具/等待/收尾期间不启动、也不续接待机循环。
      if (phase !== 'idle') return
      try {
        var mgr = model.internalModel.motionManager
        if (!mgr || !mgr.groups || !mgr.groups.idle) return
        var prio = mgr.state && typeof mgr.state.currentPriority === 'number' ? mgr.state.currentPriority : 0
        if (prio >= 1) {
          // 保护：状态机卡在"有动作"但实际没在播（例如动作权重被清掉），
          // 超过 8 秒就强制收尾，否则待机循环永远接不回来。
          if (mgr.playing) { stuckSince = 0; return }
          if (!stuckSince) { stuckSince = Date.now(); return }
          if (Date.now() - stuckSince > 8000) {
            stuckSince = 0
            if (mgr.state && mgr.state.complete) mgr.state.complete()
          }
          return
        }
        stuckSince = 0
        var started = startIdleBeat()
        if (started && typeof started.then === 'function') {
          started.then(function (ok) {
            if (ok === false && !idleErrReported) {
              idleErrReported = true
              diagnoseMotion(mgr, mgr.groups.idle)
            }
          }).catch(function (err) {
            if (!idleErrReported) {
              idleErrReported = true
              postReport({ event: 'idle-start-error', group: mgr.groups.idle, message: err && err.message ? err.message : String(err) })
            }
          })
        }
      } catch (err) {
        if (!idleErrReported) {
          idleErrReported = true
          postReport({ event: 'idle-start-error', message: err && err.message ? err.message : String(err) })
        }
      }
    }

    // 排障用：动作起不来时把 SDK 解析出的 URL、fetch 结果、状态机一起上报一次
    function diagnoseMotion(mgr, group) {
      try {
        var defs = (mgr.definitions && mgr.definitions[group]) || []
        var first = defs[0] || {}
        var resolved = ''
        try { resolved = mgr.settings && mgr.settings.resolveURL ? mgr.settings.resolveURL(first.File || '') : '' } catch (_) {}
        var info = {
          event: 'idle-start-error',
          group: group,
          file: first.File,
          resolved: resolved,
          defs: defs.length,
          reserved: JSON.stringify(mgr.state && { p: mgr.state.currentPriority, rg: mgr.state.reservedGroup, ri: mgr.state.reservedIndex, rid: mgr.state.reservedIdleGroup }),
          motionGroups: Object.keys(mgr.motionGroups || {}),
          loaded: (mgr.motionGroups && mgr.motionGroups[group] || []).slice(0, 20).map(function (m) { return m ? 'y' : 'n' }).join(''),
        }
        postReport(info)
        if (resolved) {
          fetch(resolved, { credentials: 'same-origin' }).then(function (r) {
            postReport({ event: 'idle-start-fetch', resolved: resolved, status: r.status })
          }).catch(function (e) {
            postReport({ event: 'idle-start-fetch', resolved: resolved, error: String(e) })
          })
        }
      } catch (_) { /* ignore */ }
    }

    function currentMotionPriority() {
      try {
        const s = model && model.internalModel && model.internalModel.motionManager
          ? model.internalModel.motionManager.state
          : null
        return s && typeof s.currentPriority === 'number' ? s.currentPriority : 0
      } catch { return 0 }
    }

    // 停掉正在循环的待机动作（「待机循环动作」关掉时用）。
    // 只清动作层，保留视线/呼吸/身体微动，所以模型不会"死掉"。
    let loopStops = 0
    function stopIdleLoop() {
      if (!model) return
      loopStops += 1
      try {
        const mgr = model.internalModel.motionManager
        if (mgr.stopAllMotions) mgr.stopAllMotions()
        if (mgr.state && mgr.state.complete) mgr.state.complete()
      } catch { /* ignore */ }
    }

    // 动作开关：只有「常态（idle）」才放动作。
    //   - config.idleLoopEnabled === false → 用户彻底关掉循环动作
    //   - phase !== 'idle'                 → 思考/工具/等待/收尾期间不放动作
    // 注意 SDK 的 MotionManager.update() 在动作播完时会自己
    // `startRandomMotion(groups.idle)` 续播，光调 stopAllMotions() 下一秒就被接回去
    //（这正是用户反馈「关了还有动作」「动作停不下来」的原因）。所以把 groups.idle
    // 指到一个不存在的组名，自动续播自然失败；重新允许时再还原。
    function applyIdleLoopSwitch() {
      if (destroyed || !model) return
      try {
        var mgr = model.internalModel.motionManager
        if (!mgr || !mgr.groups) return
        var wantLoop = config.idleLoopEnabled !== false && phase === 'idle'
        if (!wantLoop) {
          if (mgr.groups.idle !== '__none__') {
            mgr.groups.__realIdle = mgr.groups.idle
            mgr.groups.idle = '__none__'
          }
          // 只收掉"待机循环"（priority 1）。正在播的演出动作（priority ≥ 2）
          // 必须让它自己播完 —— 以前这里是 >= 1，一进入 tool 阶段就把刚起头
          // 的动作掐掉，用户看到的就是"闪一下就没了"。
          if (currentMotionPriority() === 1) stopIdleLoop()
        } else if (mgr.groups.__realIdle !== undefined) {
          mgr.groups.idle = mgr.groups.__realIdle
          delete mgr.groups.__realIdle
          if (ready) ensureIdleMotion()
        } else if (mgr.groups.__holdIdle !== undefined && Date.now() >= motionBusyUntil) {
          // 兜底：占用期已过但收尾定时器没跑到（例如切模型/掉帧），把待机组还回去
          mgr.groups.idle = mgr.groups.__holdIdle
          delete mgr.groups.__holdIdle
          if (ready) ensureIdleMotion()
        }
      } catch { /* ignore */ }
    }

    function tickIdle() {
      applyIdleLoopSwitch()
      if (config.idleLoopEnabled === false) return
      ensureIdleMotion()
      if (destroyed || !ready || document.hidden) return
      if (phase !== 'idle') return
      const now = Date.now()
      if (now - lastActivity < config.idleSeconds * 1000) return
      if (now - lastSayAt < config.idleSeconds * 1000) return
      speakIdle()
      lastActivity = now
    }

    // 独立随机动作：按 randomMotionSeconds 间隔触发，不依赖空闲台词。
    // 触发什么动作由「空闲演出池」决定，池子为空就全量随机。
    //
    // 注意：这里**不再用 setInterval 计时**。窗口不在前台时 Chromium 会把
    // 定时器节流到分钟级，用户会觉得"调了概率根本没反应"。改成在渲染 tick
    // （rAF）里按墙钟时间比较 deadline：只要模型在画，到点就一定触发。
    function motionIntervalMs() {
      return Math.max(5, Number(config.randomMotionSeconds) || 5) * 1000
    }
    function expressionIntervalMs() {
      return Math.max(3, Number(config.idleExpressionSeconds) || 3) * 1000
    }
    function scheduleRandomMotion() {
      nextMotionAt = Date.now() + motionIntervalMs()
    }
    function scheduleRandomExpression() {
      nextExpressionAt = Date.now() + expressionIntervalMs()
    }

    function pumpSchedulers() {
      if (destroyed) return
      var now = Date.now()
      if (nextMotionAt && now >= nextMotionAt) {
        motionTicks += 1
        if (!ready) {
          lastMotionSkip = 'not-ready'
          nextMotionAt = now + 1000
        } else if (document.hidden) {
          lastMotionSkip = 'hidden'
          nextMotionAt = now + 1000
        } else if (config.idleMotionEnabled === false) {
          lastMotionSkip = 'switch-off'
          nextMotionAt = now + motionIntervalMs()
        } else if (config.randomMotionChance <= 0) {
          lastMotionSkip = 'chance-0'
          nextMotionAt = now + motionIntervalMs()
        } else if (!motionGroups.length && !config.idleMotionPool.length) {
          lastMotionSkip = 'no-motions'
          nextMotionAt = now + motionIntervalMs()
        } else if (phase !== 'idle') {
          // 动作只在常态放：对话/思考/工具执行期间不放，回到 idle 再说
          lastMotionSkip = 'phase'
          nextMotionAt = now + 2000
        } else if (Date.now() - lastPointerAt < 800) {
          // 光标刚动过：这一拍让位给视线跟随，但只等 3 秒，不能把整轮间隔作废
          lastMotionSkip = 'pointer'
          nextMotionAt = now + 3000
        } else if (Math.random() >= config.randomMotionChance) {
          lastMotionSkip = 'probability'
          nextMotionAt = now + motionIntervalMs()
        } else {
          lastMotionSkip = 'fired'
          nextMotionAt = now + motionIntervalMs()
          lastMotionFired = playPooledMotion() ? 'yes' : 'no'
        }
      }
      if (nextExpressionAt && now >= nextExpressionAt) {
        expressionTicks += 1
        if (!ready) {
          lastExpressionSkip = 'not-ready'
          nextExpressionAt = now + 1000
        } else if (document.hidden) {
          lastExpressionSkip = 'hidden'
          nextExpressionAt = now + 1000
        } else if (config.idleExpressionEnabled === false) {
          lastExpressionSkip = 'switch-off'
          nextExpressionAt = now + expressionIntervalMs()
        } else if (config.randomExpressionChance <= 0) {
          lastExpressionSkip = 'chance-0'
          nextExpressionAt = now + expressionIntervalMs()
        } else if (!expressionNames.length) {
          lastExpressionSkip = 'no-expressions'
          nextExpressionAt = now + expressionIntervalMs()
        } else if (Math.random() >= config.randomExpressionChance) {
          lastExpressionSkip = 'probability'
          nextExpressionAt = now + expressionIntervalMs()
        } else {
          // 表情不影响视线跟随，不再因为"光标刚动过"跳过 —— 那会让
          // 用户盯着看的时候永远不出表情（正是"倒计时结束什么都没发生"）。
          lastExpressionSkip = 'fired'
          nextExpressionAt = now + expressionIntervalMs()
          lastExpressionFired = playPooledExpression(config.expressionHoldMs) || null
        }
      }
    }

    // 处理对话事件触发的模型反应
    // 对话反应：先做身体反馈（任何模型都有效），再尽量配一个表情。
    function pulse(kind, ms) {
      reactKind = kind
      reactStart = Date.now()
      reactDur = ms
    }

    function maybeExpr(phaseKey, ms) {
      if (!expressionNames.length) return false
      const name = resolveExpression(phaseKey)
      if (!name) return false
      // 对话反应优先级 3（最高）：即使空闲随机表情正在占用，也立刻盖掉
      return applyExpression(name, { ttl: ms, priority: 3, reason: 'react' })
    }

    function handleModelReact(type) {
      if (destroyed || !ready) return
      stats.reacts += 1
      // 只保留三个真正有意义的场景：刚输入 / 刚输出 / 提问。
      // 「刚输出」由阶段 success 统一处理（见 applyPhase），这里不重复。
      switch (type) {
        case 'user-message':
          if (!config.reactToUserMessage) return
          pulse('nod', 900)
          maybeExpr('input', config.expressionHoldMs > 0 ? Math.min(2500, config.expressionHoldMs) : 1500)
          break
        case 'tool-start':
          if (!config.reactToToolCall) return
          pulse('perk', 700)
          break
        case 'tool-end':
          if (!config.reactToToolCall) return
          pulse('nod', 800)
          break
        case 'choices':
          if (!config.reactToChoices) return
          pulse('tilt', 1600)
          maybeExpr('ask', 2400)
          break
        case 'assistant-message':
        case 'turn-end':
          pulse('nod', 700)
          maybeExpr('output', 1600)
          break
      }
    }

    // 桌面端用的是 dsh-app:// 自定义协议，EventSource 偶尔会在宿主重启后
    // 卡在重连状态；用低频轮询作为兜底，保证状态/配置始终能同步过来。
    let pollTimer = null
    let lastPollJSON = ''

    function startPolling() {
      if (pollTimer) return
      pollTimer = setInterval(function () {
        if (destroyed) return
        fetch(PREFIX + '/api/state', { cache: 'no-store' })
          .then(function (res) { return res.ok ? res.json() : null })
          .then(function (data) {
            if (!data || destroyed) return
            if (typeof data.phase === 'string') applyPhase(data.phase, false)
            if (data.config) {
              var key = JSON.stringify(data.config)
              if (key !== lastPollJSON) { lastPollJSON = key; updateConfig(data.config) }
            }
          })
          .catch(function () { /* offline; try again next tick */ })
      }, 5000)
    }

    function connected() {
      const shouldConnect = typeof options.connect === 'function' ? options.connect() : options.connect !== false
      if (!shouldConnect) return
      startPolling()
      try {
        sse = new EventSource(PREFIX + '/events')
        const onPhase = (event) => {
          try {
            const data = JSON.parse(event.data)
            if (data && typeof data.phase === 'string') applyPhase(data.phase, false)
          } catch { /* ignore malformed frame */ }
        }
        const onHello = (event) => {
          try {
            const data = JSON.parse(event.data)
            postReport({ event: 'sse-frame', kind: event.type, hasConfig: !!(data && data.config), scale: data && data.config && data.config.scale })
            const frameConfig = data && data.config
              ? data.config
              : (data && typeof data.modelUrl === 'string' ? data : null)
            if (frameConfig) updateConfig(frameConfig)
            if (data && typeof data.phase === 'string') applyPhase(data.phase, true)
          } catch (err) {
            postReport({ event: 'sse-error', message: err && err.message ? err.message : String(err) })
          }
        }
        sse.addEventListener('state', onPhase)
        sse.addEventListener('hello', onHello)
        sse.addEventListener('config', onHello)
        sse.addEventListener('model-react', (event) => {
          try {
            const data = JSON.parse(event.data)
            if (data && data.type) handleModelReact(data.type)
          } catch { /* ignore */ }
        })
        // 断线后 4 秒重建；轮询在后台兜底，所以这里失败也不会失去状态同步。
        sse.onerror = function () {
          try { sse.close() } catch { /* ignore */ }
          sse = null
          if (destroyed) return
          setTimeout(function () { if (!destroyed && !sse) connected() }, 4000)
        }
      } catch (err) {
        console.warn('[dsh-live2d-stage] SSE 不可用，使用静态状态：' + (err && err.message ? err.message : err))
      }
    }

    function onPointerMove(event) {
      if (!config.gaze) return
      const w = window.innerWidth || 1
      const h = window.innerHeight || 1
      focus.tx = clamp((event.clientX / w) * 2 - 1, -1, 1)
      focus.ty = clamp((event.clientY / h) * 2 - 1, -1, 1)
      focus.active = true
      lastActivity = Date.now()
      lastPointerAt = Date.now()
    }

    function onBlur() {
      focus.active = false
      focus.tx = 0
      focus.ty = 0
      lastActivity = Date.now()
    }

    // 指针离开窗口：不再算"正盯着"，恢复完整的摆动与瞥视幅度（否则一旦动过
    // 鼠标，焦点就永远停在最后位置，瞥视被永久压小，模型显得没生气）。
    function onPointerLeave() {
      focus.active = false
      focus.tx = 0
      focus.ty = 0
      lastActivity = Date.now()
    }

    function onVisibility() {
      if (!app) return
      if (document.hidden) {
        app.ticker.stop()
      } else {
        app.ticker.start()
        lastActivity = Date.now()
      }
    }

    function applyGaze() {
      if (!model) return
      const target = focus.active && config.gaze ? 1 : 0
      const smooth = target ? config.gazeSmooth : config.gazeReturnSmooth
      focus.x += (focus.tx - focus.x) * smooth
      focus.y += (focus.ty - focus.y) * smooth

      // 常驻的"活人感"。鼠标在窗口里时降到很低的幅度（视线跟随优先，
      // 用户盯着看时头必须稳定指着指针）；离开窗口才回到完整摆动。
      const wantIdle = focus.active ? 0.22 : 1
      idleHead += (wantIdle - idleHead) * 0.05
      const amp = config.motionIntensity
      const t = bodyTime

      // 头部：有机摆动 + 一点点固定微抖，避免完全静止的死板感
      const swayX = swayState.hx * amp * idleHead + Math.sin(t * 1.9) * 1.2 * amp * idleHead
      const swayY = swayState.hy * amp * idleHead + Math.sin(t * 1.4 + 1.1) * 0.8 * amp * idleHead
      const swayZ = swayState.hz * amp * idleHead + Math.sin(t * 1.15 + 2.2) * 0.9 * amp * idleHead

      // 对话反应：一个短促的点头/歪头脉冲，和表情无关，
      // 所以没有 exp3 的模型（比如 z46）也会有可见反馈。
      let reactNod = 0
      let reactTilt = 0
      if (reactKind) {
        const p = (Date.now() - reactStart) / reactDur
        if (p >= 1) { reactKind = '' } else {
          const env = Math.sin(Math.PI * p)
          if (reactKind === 'nod') reactNod = -7.5 * env
          else if (reactKind === 'tilt') reactTilt = 8.5 * env
          else if (reactKind === 'perk') reactNod = -4.5 * env
        }
      }

      // 每隔 6~11 秒来一次"瞥一眼"的小动作（转头 + 回正）。
      // 关键：只要指针在窗口里（focus.active），瞥视幅度压到 25%（约 ±2~3°），
      // 当"活人感"的微动用，绝不把视线从指针上拉走；指针离开窗口才给完整幅度。
      // 以前无条件 ±7~13° 拉走再扭回来，正是"看一会就不跟了、扭一下又看回来"。
      if (glanceAt === 0) glanceAt = Date.now() + 4000 + Math.random() * 5000
      const now = Date.now()
      const pointerEngaged = !!focus.active
      if (now >= glanceAt && !glanceBusy) {
        glanceBusy = true
        const gain = pointerEngaged ? 0.25 : 1
        glanceTarget = (Math.random() < 0.5 ? -1 : 1) * (7 + Math.random() * 6) * gain
        glanceHold = 700 + Math.random() * 900
        setTimeout(function () { glanceBusy = false; glanceAt = Date.now() + 5000 + Math.random() * 6000 }, glanceHold + 900)
      }
      glance += ((glanceBusy ? glanceTarget : 0) - glance) * 0.06

      // 每帧都写（哪怕偏移是 0），这样失焦/停手时偏移能平滑回落到 0，
      // 而不是把上一次的偏移永远留在脸上。
      setGazeParam('ParamAngleX', focus.x * config.gazeAngleX + swayX + glance)
      setGazeParam('ParamAngleY', -focus.y * config.gazeAngleY + swayY + reactNod)
      setGazeParam('ParamEyeBallX', focus.x * config.gazeEyeBallX + swayX * 0.10 + glance * 0.06)
      setGazeParam('ParamEyeBallY', -focus.y * config.gazeEyeBallY + swayY * 0.08 + reactNod * 0.10)
      setGazeParam('ParamAngleZ', tilt * 9 + swayZ + glance * 0.22 + reactTilt)
      tilt += (tiltTarget - tilt) * 0.08
    }

    // ── 灵动感：呼吸 + 身体微摇 + 头部自然晃动 ──────────────
    // VTube Studio 的 IdleAnimation / Auto Breath / Model Position Movement
    // 三合一合成一帧循环，让人物看起来"像虚拟主播一样灵动"
    let bodyTime = 0

    // 有机摆动：不再用固定正弦（那样一眼就是机械往复），
    // 而是"随机目标值 + 缓动跟随 + 随机停顿"——像真人站着时的重心换脚。
    const swayState = { bz: 0, bx: 0, by: 0, hx: 0, hy: 0, hz: 0, arm: 0 }
    const swayTarget2 = { bz: 0, bx: 0, by: 0, hx: 0, hy: 0, hz: 0, arm: 0 }
    let swayNextAt = 0
    let swayHoldUntil = 0

    function pick(a, b) { return a + Math.random() * (b - a) }
    function pickSign() { return Math.random() < 0.5 ? -1 : 1 }

    function retargetSway(now) {
      // 约 1/3 的概率什么都不做，让身体"停一下"，避免匀速摇摆的感觉
      if (Math.random() < 0.33) {
        swayHoldUntil = now + pick(1200, 3200)
        swayNextAt = swayHoldUntil
        return
      }
      swayHoldUntil = 0
      swayTarget2.bz = pickSign() * pick(0.2, 1) * 7.5   // 重心左右
      swayTarget2.bx = pickSign() * pick(0.15, 1) * 5.5  // 前后
      swayTarget2.by = pickSign() * pick(0.1, 1) * 4.2
      swayTarget2.hx = pickSign() * pick(0.3, 1) * 9.5   // 头部
      swayTarget2.hy = pickSign() * pick(0.2, 1) * 6.0
      swayTarget2.hz = pickSign() * pick(0.2, 1) * 4.0
      swayTarget2.arm = pickSign() * pick(0.2, 1) * 0.16
      swayNextAt = now + pick(900, 2600)
    }

    function stepOrganicSway(dtMs) {
      const now = Date.now()
      if (swayNextAt === 0) { swayNextAt = now + 600; retargetSway(now) }
      if (now >= swayNextAt && now >= swayHoldUntil) retargetSway(now)
      // 指数缓动：时间常数 ~450ms，动作看起来柔和但不拖沓
      const k = 1 - Math.exp(-Math.max(0, dtMs) / 450)
      for (const key in swayState) {
        const target = now < swayHoldUntil ? swayState[key] : swayTarget2[key]
        swayState[key] += (target - swayState[key]) * k
      }
    }

    // 叠加式写入：先减掉上一帧我们自己加的量，再加上这一帧的偏移，
    // 这样 IDLE 动作本身的幅度不会被覆盖掉，呼吸/摇摆是"叠"在动作上的。
    var swayApplied = {}

    function addSway(id, offset) {
      var core = model.internalModel.coreModel
      if (core.getParameterIndex(id) < 0) return
      var cur = core.getParameterValueById(id)
      var prev = swayApplied[id] || 0
      core.setParameterValueById(id, cur - prev + offset)
      swayApplied[id] = offset
    }

    function tickBodySway(dtMs) {
      if (!model || !gazeBase) return
      try {
        bodyTime += dtMs * 0.001
        var k = config.motionIntensity
        var t = bodyTime
        var sin = Math.sin

        stepOrganicSway(dtMs)

        // 身体朝向：鼠标在右边 → 胸腔/胯骨向右转，鼠标在上边 → 略微后仰。
        // Cubism 惯例：BodyAngleY 是"左右转"，BodyAngleX 是"前后俯仰"，
        // BodyAngleZ 是"左右侧倾"；三个一起动才像真人转头带身体。
        var track = focus.active ? 1 : 0.15
        var yaw = focus.x * config.bodyFollowX * track * k
        var pitch = focus.y * config.bodyFollowY * track * k

        // ── 呼吸：胸腔起伏（固定节奏，但幅度被有机摆动调制一点点）──
        addSway('ParamBreath', (sin(t * 2 * Math.PI / 3.2) * 0.5 + 0.5) * 0.9 * k)
        addSway('ShoulderY', (sin(t * 2 * Math.PI / 3.2) * 0.5 + 0.5) * 3.2 * k)

        // ── 躯干：有机摆动 + 朝向鼠标 ────────────────────────
        addSway('ParamBodyAngleY', swayState.by * k * idleHead + yaw)
        addSway('ParamBodyAngleZ', swayState.bz * k * idleHead + yaw * 0.30)
        addSway('ParamBodyAngleX', swayState.bx * k * idleHead + pitch)
        addSway('ParamBodyAngleY2', swayState.by * 0.40 * k * idleHead + yaw * 0.55)
        addSway('ParamBodyAngleX2', swayState.bx * 0.45 * k * idleHead + pitch * 0.5)

        // ── 骨盆：跟着重心 + 朝向摆动 ───────────────────────
        addSway('HipAngleZ', swayState.bz * 0.55 * k * idleHead + yaw * 0.35)
        addSway('HipAngleX', swayState.bx * 0.30 * k * idleHead + pitch * 0.35)
        addSway('HipAngleY', swayState.by * 0.25 * k * idleHead + yaw * 0.45)
        addSway('ShoulderZ', swayState.bz * 0.25 * k * idleHead + yaw * 0.25)

        // ── 手臂：跟着身体轻轻前后摆（量纲 -1..1）──
        addSway('LArm', swayState.arm * k)
        addSway('RArm', -swayState.arm * k)
        addSway('LForearm', swayState.arm * 0.8 * k)
        addSway('RForearm', -swayState.arm * 0.8 * k)

        // ── 整体重心：左右轻微平移，像人在原地换脚 ──────────
        addSway('PositionX', swayState.bz * 0.05 * k)
        addSway('PositionY', swayState.by * 0.02 * k)
      } catch { /* ignore */ }
    }

    // Per-frame part opacity override.  `model.update()` re-evaluates
    // every part's opacity from its controlling parameter every frame.
    // A one-shot hideDefaultAccessories() gets wiped on the next tick.
    // This runs *after* update so the overrides survive.
    var tickPartOverrides = null
    function applyPartOverrides() {
      if (!tickPartOverrides || !model) return
      try {
        var core = model.internalModel.coreModel
        var n = core._partOpacities ? core._partOpacities.length : 0
        // 直接写底层数组：SDK 的 setPartOpacityByIndex 在个别模型上会因为
        // 内部 parts 数组未分配而抛 "Cannot set properties of undefined"。
        for (var i = 0; i < tickPartOverrides.length; i++) {
          var pi = tickPartOverrides[i]
          if (pi >= 0 && pi < n) core._partOpacities[pi] = 0
        }
      } catch { /* ignore */ }
    }

    function buildPartOverrides() {
      tickPartOverrides = null
      if (!model) return
      // 没有识别出「黑色鼻子方块」的模型不做任何部位遮罩。
      if (!nosePartDrawables.length) return
      try {
        var core = model.internalModel.coreModel
        var ids = core._partIds || []
        tickPartOverrides = []
        // Part46 是大肥鱼模型里那块纯黑「鼻子」贴图（实测 UV 区域就是一条黑色
        // 圆角竖条），默认隐藏它；想看原版黑块可在设置里切「原图」。
        // Part10 没有任何 drawable（空组），隐藏它对画面毫无作用，之前误hide
        // 它导致模型 bounds 变化、看起来整张脸错位。
        var hide = config.noseMode === 'original' ? [] : ['Part46']
        for (var i = 0; i < ids.length; i++) {
          if (hide.indexOf(String(ids[i] || '')) >= 0) tickPartOverrides.push(i)
        }
      } catch { /* ignore */ }
    }

    // ── 手绘鼻子贴片 ────────────────────────────────────────────
    // 隐藏黑块后脸上没有鼻子，用一个柔和径向渐变的像素点补上，位置每帧
    // 跟着 Part46 的网格中心走，所以转头/呼吸时也不会飘。
    function makeNoseTexture() {
      var size = 64
      var c = document.createElement('canvas')
      c.width = c.height = size
      var ctx = c.getContext('2d')
      var g = ctx.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2)
      g.addColorStop(0, 'rgba(168,106,94,0.60)')
      g.addColorStop(0.22, 'rgba(168,106,94,0.34)')
      g.addColorStop(0.62, 'rgba(168,106,94,0.10)')
      g.addColorStop(1, 'rgba(168,106,94,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, size, size)
      return window.PIXI.Texture.from(c)
    }

    // 判断某个"鼻子"部件是不是纯黑贴块。做法：取该部位每个 drawable 的
    // UV 中心采样模型纹理，按 UV 面积排序后看*主体*那张图的亮度——大肥鱼
    // 的鼻子部件里既有纯黑贴块(0,0,0)也有鼻头高光，取平均会互相抵消，
    // 必须看主体。
    function isBlackNosePart(core, raw, pi) {
      try {
        var draws = raw.drawables
        var tex = model.internalModel.textures
        var list = []
        var detail = []
        for (var d = 0; d < draws.count; d++) {
          if (draws.parentPartIndices[d] !== pi) continue
          var uv = core.getDrawableVertexUvs(d)
          if (!uv || uv.length < 2) continue
          var cu = 0, cv = 0, n = 0
          var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
          for (var k = 0; k < uv.length; k += 2) {
            cu += uv[k]; cv += uv[k + 1]; n++
            if (uv[k] < minU) minU = uv[k]
            if (uv[k] > maxU) maxU = uv[k]
            if (uv[k + 1] < minV) minV = uv[k + 1]
            if (uv[k + 1] > maxV) maxV = uv[k + 1]
          }
          cu /= n; cv /= n
          var ti = draws.textureIndices ? draws.textureIndices[d] : 0
          var texture = tex && tex[ti] ? tex[ti] : null
          var base = texture && (texture.baseTexture || texture)
          var res = base && base.resource
          var img = (modelTextureImages[ti] || modelTextureImages[0]) || (res && (res.source || res))
          if (!img || !img.width) continue
          try {
            var c = document.createElement('canvas')
            c.width = 1; c.height = 1
            var cx = c.getContext('2d')
            cx.drawImage(img, Math.floor(cu * img.width), Math.floor((1 - cv) * img.height), 1, 1, 0, 0, 1, 1)
            var px = cx.getImageData(0, 0, 1, 1).data
            var lum = (px[0] + px[1] + px[2]) / 3 * (px[3] / 255)
            list.push({ d: d, lum: lum, area: (maxU - minU) * (maxV - minV) })
            if (detail.length < 4) {
              detail.push({ d: d, ti: ti, u: Number(cu.toFixed(3)), v: Number(cv.toFixed(3)), rgba: [px[0], px[1], px[2], px[3]], size: [img.width, img.height] })
            }
          } catch (_) { /* 纹理还没解码好，下次再判 */ }
        }
        if (!list.length) {
          if (!noseSampleLogged) {
            noseSampleLogged = true
            postReport({
              event: 'nose-sample',
              part: pi,
              draws: draws.count,
              textures: (model.internalModel.textures || []).length,
              reason: 'no sample',
              detail: detail,
            })
          }
          return false // 采样不到就当作"没有黑块"，宁可不动模型
        }
        list.sort(function (a, b) { return b.area - a.area })
        var main = list[0]
        if (!noseSampleLogged) {
          noseSampleLogged = true
          postReport({
            event: 'nose-sample',
            part: pi,
            samples: list.length,
            main: { d: main.d, lum: Math.round(main.lum) },
            lums: list.slice(0, 8).map(function (x) { return Math.round(x.lum) }),
            detail: detail,
          })
        }
        // 主体绘制是一块近黑贴图才算"黑块"；鼻头高光这类小图不参与判断
        return main.lum < 60
      } catch (_) { return false }
    }

    // 通过模型自带的 cdi3.json 找"鼻子"部件。绝不能写死 Part46：
    // 编号是每个模型自己的，薇薇安的 Part46 其实是左腿。
    async function loadCdi3Names() {
      try {
        const base = config.modelUrl.split('/').pop()
        if (!base || !/\.model3\.json$/i.test(base)) return null
        const sibling = config.modelUrl.replace(/[^/]*$/, base.replace(/\.model3\.json$/i, '.cdi3.json'))
        const json = await fetchJson(sibling)
        const parts = (json && json.Parts) || []
        const map = {}
        parts.forEach((p) => { if (p && p.Id) map[p.Id] = p.Name || '' })
        return Object.keys(map).length ? map : null
      } catch {
        return null
      }
    }

    function buildNoseDecal() {
      nosePartDrawables = []
      if (!model || !window.PIXI) return
      try {
        var core = model.internalModel.coreModel
        var raw = core._model
        if (!raw || !raw.parts || !raw.drawables) return
        if (!cdi3Names) return
        var ids = Array.from(raw.parts.ids)
        var draws = raw.drawables
        // 候选：cdi3 里名字含"鼻/nose"的部件
        var candidates = []
        ids.forEach(function (id, i) {
          var name = cdi3Names[id] || ''
          if (!/鼻|nose/i.test(name)) return
          var hasDraw = false
          for (var d = 0; d < draws.count; d++) if (draws.parentPartIndices[d] === i) { hasDraw = true; break }
          if (!hasDraw) return // 大肥鱼的 Part10(鼻子) 没有任何绘制，跳过
          candidates.push({ id: id, index: i, black: isBlackNosePart(core, raw, i) })
        })
        var black = candidates.filter(function (c) { return c.black })
        postReport({
          event: 'nose-detect',
          cdi3: Object.keys(cdi3Names).length,
          candidates: candidates.map(function (c) { return c.id + (c.black ? '(black)' : '(ok)') }),
          hidden: black.length,
        })
        if (!black.length) return // 鼻子正常（薇薇安/奈特莉）→ 不动它
        var pi = black[0].index
        var best = -1
        var bestArea = -1
        for (var d = 0; d < draws.count; d++) {
          if (draws.parentPartIndices[d] !== pi) continue
          // 按 UV 面积挑主体，黑色贴块下可能还挂着几个细小的附属 drawable
          var uv = core.getDrawableVertexUvs(d)
          var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
          for (var k = 0; k < uv.length; k += 2) {
            if (uv[k] < minU) minU = uv[k]
            if (uv[k] > maxU) maxU = uv[k]
            if (uv[k + 1] < minV) minV = uv[k + 1]
            if (uv[k + 1] > maxV) maxV = uv[k + 1]
          }
          var area = (maxU - minU) * (maxV - minV)
          if (area > bestArea) { bestArea = area; best = d }
        }
        if (best >= 0) nosePartDrawables = [best]
        if (!noseSprite) {
          noseSprite = new window.PIXI.Sprite(makeNoseTexture())
          noseSprite.anchor.set(0.5, 0.5)
          noseSprite.zIndex = 2
          app.stage.addChild(noseSprite)
        }
      } catch { /* ignore */ }
    }

    function updateNoseDecal() {
      if (!noseSprite) return
      var show = config.noseMode === 'soft' && nosePartDrawables.length > 0 && model
      noseSprite.visible = !!show
      if (!show) return
      try {
        var im = model.internalModel
        // getDrawableVertices 返回「原图像素空间」的顶点（已乘 pixelsPerUnit），
        // 再经 centeringTransform → model 世界矩阵 转成画布坐标。
        var v = im.getDrawableVertices(nosePartDrawables[0])
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
        for (var k = 0; k < v.length; k += 2) {
          if (v[k] < minX) minX = v[k]
          if (v[k] > maxX) maxX = v[k]
          if (v[k + 1] < minY) minY = v[k + 1]
          if (v[k + 1] > maxY) maxY = v[k + 1]
        }
        if (!isFinite(minX) || maxX <= minX || maxY <= minY) { noseSprite.visible = false; return }
        var lx = (minX + maxX) / 2
        var ly = minY + (maxY - minY) * 0.55
        // getDrawableVertices 已经是模型贴图空间（0..originalWidth/Height，
        // 原点左上、y 向下），正好等于 pixi 模型的局部坐标，直接 toGlobal。
        var p = new window.PIXI.Point(lx, ly)
        model.toGlobal(p, p)
        var h = model.height || 1
        var radius = Math.max(2.0, h * 0.0072)
        noseSprite.x = p.x
        noseSprite.y = p.y
        noseSprite.scale.set(radius / 32)
      } catch { noseSprite.visible = false }
    }

    var tickErrors = 0
    var tickCount = 0
    var heartbeatTimer = null
    var heartbeatStalls = 0
    var canvasProbeTimer = 0
    var lastCanvasHash = ''

    // 用像素本身证明"画面到底有没有在变"：把舞台缩到 48×48 采样，
    // 算一个简单校验和，跟上次比对后上报。桌面包里看不到 devtools 时，
    // 这是唯一可靠的运行时证据。
    function probeCanvas() {
      if (!app || !app.renderer) return
      try {
        // 先看"屏幕上那张画布"的默认帧缓冲里到底有没有像素。
        // extract 走的是离屏 RenderTexture，即使屏幕缓冲是空的也能出图，
        // 所以这一步才是判断"用户能不能看见"的关键。
        var glInfo = null
        try {
          var gl = app.renderer.gl
          if (gl && model) {
            var bb = model.getBounds()
            var p = { x: bb.x + bb.width * 0.45, y: bb.y + bb.height * 0.45 }
            var sx = Math.max(0, Math.min(app.renderer.screen.width - 2, Math.round(p.x)))
            var sy = Math.max(0, Math.min(app.renderer.screen.height - 2, Math.round(p.y)))
            var px = new Uint8Array(4)
            app.renderer.render(app.stage)
            gl.readPixels(
              Math.round(sx * app.renderer.resolution),
              Math.round((app.renderer.screen.height - sy) * app.renderer.resolution),
              1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px,
            )
            glInfo = { at: [sx, sy], px: [px[0], px[1], px[2], px[3]] }
          }
        } catch (e) { glInfo = { error: String(e && e.message) } }

        var src = app.renderer.extract.canvas(app.stage)
        var c = document.createElement('canvas')
        c.width = 48
        c.height = 48
        var c2 = c.getContext('2d')
        c2.drawImage(src, 0, 0, 48, 48)
        var data = c2.getImageData(0, 0, 48, 48).data
        var hash = 2166136261
        var lit = 0
        for (var i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 8) lit += 1
          hash ^= data[i] + data[i + 1] * 3 + data[i + 2] * 7 + data[i + 3] * 11
          hash = (hash * 16777619) >>> 0
        }
        postReport({
          event: 'canvas-signature',
          hash: String(hash),
          changed: hash !== lastCanvasHash,
          opaque: lit,
          tickCount: tickCount,
          gl: glInfo,
          inner: [window.innerWidth, window.innerHeight],
          dpr: window.devicePixelRatio,
        })
        lastCanvasHash = String(hash)
        // 把舞台缩略图（160×96）一并回传，便于在没有任何截图工具时确认
        // "画布上到底画了什么、画在哪里"。
        try {
          var thumb = document.createElement('canvas')
          thumb.width = 300
          thumb.height = 180
          thumb.getContext('2d').drawImage(c, 0, 0, 300, 180)
          postReport({ event: 'snapshot', dataUrl: thumb.toDataURL('image/jpeg', 0.5) })
        } catch (_) { /* ignore */ }
        // 同时上报 DOM 侧的可见性事实：body 属性、层级、不透明度、尺寸。
        // “画布在变但屏幕上没有” 与 “画布被挡住” 是两类完全不同的 bug。
        var cs = host ? getComputedStyle(host) : null
        var at = function (x, y) {
          try {
            var el = document.elementFromPoint(x, y)
            if (!el) return 'null'
            return (el.tagName || '?').toLowerCase() + '.' + String(el.className || '').split(' ')[0]
          } catch (_) { return 'err' }
        }
        postReport({
          event: 'dom-report',
          bodyAttr: document.body.hasAttribute('data-dsh-live2d'),
          bodyBg: getComputedStyle(document.body).backgroundColor,
          htmlBg: getComputedStyle(document.documentElement).backgroundColor,
          topAtModel: at(window.innerWidth - 200, window.innerHeight - 260),
          topAtRight: at(window.innerWidth - 40, window.innerHeight - 400),
          hostOpacity: cs ? cs.opacity : '?',
          hostZ: cs ? cs.zIndex : '?',
          hostVis: cs ? cs.visibility : '?',
          hostRect: host ? [Math.round(host.getBoundingClientRect().width), Math.round(host.getBoundingClientRect().height)] : null,
          canvasAttr: canvas ? [canvas.width, canvas.height] : null,
          canvasCss: canvas ? [canvas.clientWidth, canvas.clientHeight] : null,
          modelXY: model ? [Math.round(model.x), Math.round(model.y), Math.round(model.width), Math.round(model.height)] : null,
          canvasConnected: canvas ? canvas.isConnected : null,
          canvasIsView: app ? canvas === app.view : null,
          canvasParent: canvas && canvas.parentElement ? String(canvas.parentElement.className || canvas.parentElement.tagName) : null,
          canvasStyle: canvas ? (canvas.getAttribute('style') || '') : null,
          canvasRect: canvas ? (function () { var r = canvas.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })() : null,
          canvasVis: canvas ? (function () { var s = getComputedStyle(canvas); return [s.visibility, s.opacity, s.display, s.transform] })() : null,
          canvasCount: document.querySelectorAll('.dsh-l2d-layer canvas').length,
          canvasZ: canvas ? getComputedStyle(canvas).zIndex : null,
          hostRectB: host ? (function () { var r = host.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })() : null,
          tickerStarted: app && app.ticker ? app.ticker.started : null,
          appHeight: app && app.renderer ? [app.renderer.width, app.renderer.height] : null,
          ready: host ? host.getAttribute('data-ready') : null,
          scrimBg: (function () {
            var el = document.querySelector('.dsh-l2d-scrim')
            return el ? getComputedStyle(el).backgroundImage : null
          })(),
          preview: (function () {
            var el = document.querySelector('.dsh-l2d-preview')
            if (!el) return null
            var box = el.querySelector('.dsh-l2d-preview__canvas')
            var line = el.querySelector('.dsh-l2d-preview__line')
            var view = app && app.view
            return {
              rect: (function () { var r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })(),
              hosted: !!(view && box && view.parentNode === box),
              canvasParent: view && view.parentNode ? (view.parentNode.className || view.parentNode.tagName) : null,
              canvasRect: view ? (function () { var r = view.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] })() : null,
              // 设置页是带 backdrop-filter 的模态框；预览窗必须 portal 到 body
              // 并抬到模态框之上，否则会"在下一层被模糊"。
              parent: el.parentElement ? (el.parentElement.tagName + (el.parentElement.id ? '#' + el.parentElement.id : '')) : null,
              zIndex: getComputedStyle(el).zIndex,
              line: line ? line.textContent : null,
            }
          })(),
          // 设置页自身的 DOM 事实：用户报「设置页空白」时，这里能区分
          // 「没打开」（present:false）/「打开了但渲染崩了」（present:true,
          // groups:0, text 为空）/「正常」（groups>0）。
          settings: (function () {
            try {
              var el = document.querySelector('.dsh-l2d-set')
              if (!el) return { present: false }
              var text = String(el.textContent || '').replace(/\s+/g, ' ').trim()
              return {
                present: true,
                groups: el.querySelectorAll('.dsh-l2d-set__group').length,
                controls: el.querySelectorAll('input,select,button,textarea').length,
                poolItems: el.querySelectorAll('.dsh-l2d-set__pool-item').length,
                preview: !!document.querySelector('.dsh-l2d-preview'),
                text: text.slice(0, 150),
              }
            } catch (e) {
              return { present: false, error: String(e) }
            }
          })(),
          stats: stats,
        })
      } catch (err) {
        postReport({ event: 'canvas-probe-error', message: err && err.message ? err.message : String(err) })
      }
    }

    function layerCount() {
      try { return document.querySelectorAll('.dsh-l2d-layer').length } catch (_) { return -1 }
    }

    function tick() {
      if (!model || destroyed) return
      tickCount += 1
      try {
        var dt = app.ticker.deltaMS
        model.update(dt)
        applyPartOverrides()
        updateNoseDecal()
        tickBodySway(dt)
        applyGaze()
        // 随机演出（动作 / 表情）在这里按时钟到点触发，而不是靠 setInterval：
        // 窗口不在前台时定时器会被节流到分钟级，用户会以为"概率调了没反应"。
        pumpMotionHold()
        pumpExpressionHold()
        pumpSchedulers()
        // 自己再渲染一次：某些情况下（autoStart 被外部 stop 过、
        // ticker 上没挂 Application.render）画布会一直是空的，
        // 而 renderer.extract 却能正常出图，非常难查。
        if (app && app.renderer && !document.hidden) app.renderer.render(app.stage)
      } catch (err) {
        // 模型刷新/销毁的瞬间 Cubism Core 的参数数组可能已释放，
        // 这一帧直接跳过，避免变成 unhandled-rejection。
        tickErrors += 1
        if (tickErrors === 1) {
          postReport({ event: 'tick-error', message: err && err.message ? err.message : String(err) })
        }
      }
    }

    function fail(err) {
      const message = err && err.message ? err.message : String(err)
      console.warn('[dsh-live2d-stage] ' + message)
      try {
        if (app) {
          app.ticker.stop()
          app.destroy(true, { children: true })
          app = null
        }
      } catch { /* ignore */ }
      model = null
      ready = false
      if (host) host.removeAttribute('data-ready')
      errorHook(err instanceof Error ? err : new Error(message))
      report('error', { message, stack: err && err.stack ? String(err.stack).slice(0, 1200) : '' })
    }

    // ── 模型能力识别 ───────────────────────────────────────────
    // 每个模型"肚子里到底有什么"差别很大：有的动作表情都有，有的只有
    // 表情，有的把动作全塞在空字符串组里，还有的（VTube Studio 导出）
    // 文件在文件夹里却没写进清单——host 会就地补全，这里统一识别成
    // 可展示、可驱动的清单，供设置页自适应。
    var IDLE_GROUP_PREF = ['Idle', 'idle', 'IDLE', '待机', '默认', 'main', 'home', 'complete', 'loop']

    function pickIdleGroup(names) {
      const forced = config.idleMotionGroup
      if (forced && names.indexOf(forced) >= 0) return forced
      for (var i = 0; i < IDLE_GROUP_PREF.length; i += 1) {
        if (names.indexOf(IDLE_GROUP_PREF[i]) >= 0) return IDLE_GROUP_PREF[i]
      }
      for (var j = 0; j < names.length; j += 1) {
        if (/idle|待机|默认|loop|main|home|complete|scene/i.test(names[j])) return names[j]
      }
      return names.length ? names[0] : null
    }

    // 待机组只认 SDK 的 mgr.groups.idle。把解析逻辑独立出来，
    // 这样用户在设置里换了「待机动作组」可以立刻生效，不必重载模型。
    function setupIdleGroup() {
      var mgr = model && model.internalModel && model.internalModel.motionManager
      if (!mgr || !mgr.definitions) return null
      var names = Object.keys(mgr.definitions).filter(function (n) { return n !== '__idle__' })
      var idleName = pickIdleGroup(names)
      if (idleName === '') {
        // 有些模型把所有动作放在空字符串组里（如 z46）。SDK 用 group 名去
        // definitions[group] / motionGroups[group] 取定义与已加载的实例，
        // 所以两张表都要复制成 SDK 认的 idle 名，否则动作永远起不来。
        var all = (mgr.definitions && mgr.definitions['']) || []
        // 两级筛选：先只认真正的待机文件名（idle/待机/stand/scene/默认/loop），
        // 找不到再放宽到 main/home/complete 等。z46 有 14 个动作（含 login、
        // wedding、touch_body），全塞进循环会"动作停不下来"，这里必须收紧。
        var strict = []
        var loose = []
        all.forEach(function (item) {
          var file = String((item && item.File) || '')
          if (/(^|\/)(idle|待机|stand|scene|default|loop)[^/]*\.motion3\.json$/i.test(file)) strict.push(item)
          else if (/idle|待机|默认|loop|main|home|complete/i.test(file)) loose.push(item)
        })
        var keep = strict.length ? strict : (loose.length ? loose : all.slice())
        mgr.definitions.__idle__ = keep
        mgr.motionGroups = mgr.motionGroups || {}
        // 必须按定义数量预分配。稀疏数组（hole = undefined）才是"还没加载"，
        // 填 null 会被 SDK 当成"上次加载失败"，动作永远起不来。
        // 复用已有数组（只改 length）而不是新建：换待机组/动作池时可能有
        // 正在加载的动作回调仍要写 motionGroups[group][index]，把数组换掉会
        // 让那次写入落到 undefined 上，抛 "Cannot set properties of undefined"。
        var slot = mgr.motionGroups.__idle__
        if (!Array.isArray(slot)) slot = new Array(keep.length)
        slot.length = keep.length
        mgr.motionGroups.__idle__ = slot
        mgr.groups.__idle__ = mgr.groups['']
        mgr.groups.idle = '__idle__'
      } else if (idleName) {
        mgr.groups.idle = idleName
      }
      try {
        var st = startIdleBeat()
        if (st && typeof st.catch === 'function') st.catch(function () {})
      } catch (_) { /* may reject in some bundles */ }
      return mgr.groups.idle
    }

    function applyModelManifest(json) {
      var refs = (json && json.FileReferences && typeof json.FileReferences === 'object') ? json.FileReferences : {}
      var info = {
        format: 'cubism4', version: 0, moc: '', textures: 0,
        physics: false, pose: false, userdata: false,
        hitAreas: [], eyeBlink: [], lipSync: [], layout: null,
        expressions: [], motionGroups: [], scanned: false, warnings: [],
      }
      var expressions = []
      var motions = {}
      if (refs.Moc) {
        info.version = Number(json.Version) || 0
        info.moc = String(refs.Moc)
        info.textures = (refs.Textures || []).length
        info.physics = !!refs.Physics
        info.pose = !!refs.Pose
        info.userdata = !!refs.UserData
        expressions = (refs.Expressions || []).map(function (item) {
          return { name: item && item.Name, file: item && item.File, source: (item && item.Source) || 'decl' }
        })
        motions = refs.Motions || {}
      } else {
        info.format = 'cubism2'
        info.moc = String(json.model || json.moc || '')
        info.textures = (json.textures || []).length
        info.physics = !!json.physics
        info.pose = !!json.pose
        expressions = (json.expressions || []).map(function (item) {
          return {
            name: item && (item.name || item.Name),
            file: item && (item.file || item.File),
            source: (item && item.Source) || 'decl',
          }
        })
        motions = json.motions || {}
        info.warnings.push('Cubism 2.1 模型：当前只打包了 Cubism 4 运行时，渲染需要额外的 live2d.min.js。')
      }

      info.expressions = expressions.filter(function (item) { return item.file })
      if (info.expressions.some(function (item) { return item.source === 'scan' })) info.scanned = true
      expressionNames = info.expressions.map(function (item) { return item.name || item.file }).filter(Boolean)

      motionGroups = Object.keys(motions).filter(function (group) { return (motions[group] || []).length })
      info.motionGroups = motionGroups.map(function (group) {
        return { name: group, count: (motions[group] || []).length }
      })

      motionCatalog = []
      Object.keys(motions).forEach(function (group) {
        ;(motions[group] || []).forEach(function (item, index) {
          var file = String((item && (item.File || item.file)) || '')
          if (!file) return
          var base = file.split('/').pop().replace(/\.(motion3|motion)\.json$/i, '').replace(/\.json$/i, '')
          var source = (item && item.Source) || 'decl'
          if (source === 'scan') info.scanned = true
          motionCatalog.push({
            group: group,
            index: index,
            label: (group ? group + ' · ' : '') + base,
            file: file,
            source: source,
          })
        })
      })

      info.hitAreas = (json.HitAreas || []).map(function (hit) {
        return { id: hit && hit.Id, name: hit && hit.Name }
      })
      ;(json.Groups || []).forEach(function (group) {
        if (!group || group.Target !== 'Parameter') return
        if (group.Name === 'EyeBlink') info.eyeBlink = group.Ids || []
        else if (group.Name === 'LipSync') info.lipSync = group.Ids || []
      })
      info.layout = json.Layout || null
      modelInfo = info

      var mgr = model.internalModel.motionManager
      if (!mgr) return info

      // 排障：动作文件加载失败时把 SDK 的真实错误抓出来（否则只会静默 warn）
      if (typeof mgr.on === 'function' && !mgr.__dshHooked) {
        mgr.__dshHooked = true
        mgr.on('motionLoadError', function (g, i, err) {
          postReport({
            event: 'motion-load-error',
            group: String(g),
            index: i,
            message: err && err.message ? err.message : String(err),
            stack: err && err.stack ? String(err.stack).slice(0, 400) : '',
          })
        })
        mgr.on('motionLoaded', function (g, i) {
          postReport({ event: 'motion-loaded', group: String(g), index: i })
        })
      }

      var idleUsed = setupIdleGroup()

      postReport({
        event: 'model-info',
        modelUrl: config.modelUrl,
        info: {
          format: info.format,
          version: info.version,
          textures: info.textures,
          physics: info.physics,
          pose: info.pose,
          userdata: info.userdata,
          expressions: info.expressions.length,
          expressionNames: expressionNames.slice(0, 40),
          motions: info.motionGroups,
          hitAreas: info.hitAreas.length,
          eyeBlink: info.eyeBlink.length,
          lipSync: info.lipSync.length,
          scanned: info.scanned,
          warnings: info.warnings,
        },
      })
      return info
    }

    async function attachModel() {
      if (model) {
        // 先停掉动作循环：SDK 的动作 Promise 在模型销毁后仍会回写 motionGroups，
        // 那正是 "Cannot set properties of undefined (setting '2')" 的来源。
        try { model.internalModel.motionManager.stopAllMotions() } catch { /* ignore */ }
        try { model.destroy({ children: true, texture: true, baseTexture: true }) } catch { /* ignore */ }
        model = null
      }
      ready = false
      if (host) host.removeAttribute('data-ready')
      expressionNames = []
      motionGroups = []
      baseParamSnapshot = null
      motionCatalog = []
      modelInfo = null
      cdi3Names = null
      modelRefs = {}
      modelTextureImages = []
      noseSampleLogged = false
      idleErrReported = false

      const next = await window.PIXI.live2d.Live2DModel.from(config.modelUrl, {
        autoInteract: false,
        autoUpdate: false,
      })
      if (destroyed) {
        try { next.destroy({ children: true }) } catch { /* ignore */ }
        return
      }
      model = next
      app.stage.addChild(model)
      naturalHeight = model.internalModel.height || 1

      // One full cycle of model.update(0) lets Cubism Core allocate the
      // internal parameter-value arrays for *every* parameter declared in
      // cdi3.json.  Before that point `setParameterValueById` on custom
      // params (key1-key13 from VTubeStudio exports) either throws or is
      // silently dropped, so accessory parts stay at their default opacity=1
      // and the black square near the nose persists.
      try { model.update(0) } catch { /* ignore */ }

      // 先读清单：贴图路径、部件名（cdi3）、表情动作定义都要用它。
      try {
        const json = await fetchJson(config.modelUrl)
        modelRefs = (json && json.FileReferences) || {}
        modelInfo = null
      } catch (err) {
        modelRefs = {}
        warnOnce('model3', '模型清单读取失败，表情将不可用：' + (err && err.message ? err.message : err))
      }
      if (destroyed) return

      // 部件名来自模型自己的 cdi3.json，鼻子检测据此判断，
      // 而不是按 Part46 这种模型私有编号硬猜。
      cdi3Names = await loadCdi3Names()
      if (destroyed) return
      modelTextureImages = await loadModelTextures(modelRefs)
      if (destroyed) return
      buildNoseDecal()
      hideDefaultAccessories()
      buildPartOverrides()
      captureGazeBase()

      try {
        const json = await fetchJson(config.modelUrl)
        modelRefs = (json && json.FileReferences) || {}
        applyModelManifest(json)
      } catch (err) {
        warnOnce('model3', '模型清单读取失败，表情将不可用：' + (err && err.message ? err.message : err))
      }

      layout()
      ready = true
      host.setAttribute('data-ready', '1')
      currentExpression = null
      applyPhase(phase, true, true)
      phaseAt = Date.now()
      report('ready', {
        expressions: expressionNames,
        motions: motionGroups,
        motionLabels: motionCatalog.map(function (m) { return m.label }).slice(0, 40),
        nose: nosePartDrawables.length > 0,
        modelSize: [Math.round(model.width), Math.round(model.height)],
        canvas: [canvas.width, canvas.height],
        renderer: app.renderer && app.renderer.type,
      })
    }

    async function boot() {
      try {
        await ensureLibs()
        if (destroyed) return
        const w = window.innerWidth || 1
        const h = window.innerHeight || 1
        app = new window.PIXI.Application({
          view: canvas,
          width: w,
          height: h,
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          powerPreference: 'high-performance',
          // 实时预览窗口要按帧把画面拷出来，保留绘制缓冲最稳
          preserveDrawingBuffer: true,
        })
        app.ticker.add(tick)
        // 兜底心跳：rAF 在窗口失焦/被遮挡时可能被节流到 0，
        // 用 4Hz 的定时器记录是否还在跑，并顺带把"画面是否真的在动"
        // 采样上报，方便在 /api/state 里查（桌面包调试用）。
        app.ticker.start()
        var lastTickCount = -1
        heartbeatTimer = setInterval(function () {
          if (destroyed || !model) return
          if (tickCount === lastTickCount) {
            heartbeatStalls += 1
            if (heartbeatStalls === 3) {
              postReport({ event: 'frozen', tickCount: tickCount, hidden: document.hidden, layers: layerCount() })
            }
            // rAF 被节流时手动推进一帧，保证画面不会真的停住
            try { tick() } catch (_) {}
          } else {
            heartbeatStalls = 0
          }
          lastTickCount = tickCount
          if (canvasProbeTimer === 0) canvasProbeTimer = Date.now() + 3000
          if (Date.now() >= canvasProbeTimer) {
            canvasProbeTimer = Date.now() + 4000
            probeCanvas()
          }
          if (tickCount % 60 < 4 && tickCount > 0) {
            var core = model.internalModel.coreModel
            var mm = model.internalModel.motionManager
            postReport({
              event: 'alive',
              tickCount: tickCount,
              angleX: +(+core.getParameterValueById('ParamAngleX') || 0).toFixed(2),
              breath: +(+core.getParameterValueById('ParamBreath') || 0).toFixed(3),
              bodyZ: +(+core.getParameterValueById('ParamBodyAngleZ') || 0).toFixed(2),
              layer: layerCount(),
              idleGroup: mm && mm.groups ? mm.groups.idle : null,
              motionPrio: mm && mm.state ? mm.state.currentPriority : null,
              motionRunning: !!(mm && mm.state && mm.state.currentGroup),
              motionKeys: mm && mm.definitions ? Object.keys(mm.definitions).slice(0, 6) : null,
              groupKeys: mm && mm.groups ? Object.keys(mm.groups).slice(0, 6) : null,
              idleDefs: mm && mm.definitions && mm.definitions.__idle__ ? mm.definitions.__idle__.length : -1,
              idleLoopEnabled: config.idleLoopEnabled !== false,
              loopStops: loopStops,
              motionTicks: motionTicks,
              lastMotionSkip: lastMotionSkip,
              lastMotionFired: lastMotionFired,
              expressionTicks: expressionTicks,
              lastExpressionSkip: lastExpressionSkip,
              lastExpressionFired: lastExpressionFired,
              expression: currentExpression,
              expressionPool: (config.idleExpressionPool || []).slice(0, 6),
              exprRestore: exprRestoreCount,
              exprHoldLeft: exprHoldArmedAt ? Math.max(0, exprHoldArmedAt - Date.now()) : 0,
              motionSec: Math.max(5, Number(config.randomMotionSeconds) || 5),
              expressionSec: Math.max(3, Number(config.idleExpressionSeconds) || 3),
              nextMotionIn: nextMotionAt ? Math.max(0, nextMotionAt - Date.now()) : -1,
              nextExpressionIn: nextExpressionAt ? Math.max(0, nextExpressionAt - Date.now()) : -1,
              lastPointerAgo: lastPointerAt ? Date.now() - lastPointerAt : -1,
              // 注视排障：pointerEngaged=指针在窗口里（瞥视被压到 25%），
              // glance=当前瞥视偏移，focusX/focusY=平滑后的指针目标，idleHead=摆动强度
              pointerEngaged: !!focus.active,
              glance: +glance.toFixed(2),
              focusX: +focus.x.toFixed(3),
              focusY: +focus.y.toFixed(3),
              idleHead: +idleHead.toFixed(3),
              stats: stats,
              phase: phase,
              now: Date.now(),
            })
          }
        }, 250)

        await attachModel()
        if (destroyed) return
        readyHook()
        connected()
        idleTimer = setInterval(tickIdle, 1000)
        scheduleRandomMotion()
        scheduleRandomExpression()
      } catch (err) {
        fail(err)
      }
    }

    // Apply a partial config (from the settings page or the SSE `config`
    // frame) without tearing down the whole stage. A model change reloads the
    // model in place; everything else is a CSS/layout update.
    function updateConfig(partial) {
      if (destroyed) return
      const next = normalizeConfig(Object.assign({}, config, partial || {}))
      const modelChanged = next.modelUrl !== config.modelUrl
      const idleGroupChanged = String(next.idleMotionGroup || '') !== String(config.idleMotionGroup || '')
      const idleLoopChanged = next.idleLoopEnabled !== config.idleLoopEnabled
      Object.assign(config, next)

      if (host) {
        host.style.zIndex = String(config.zIndex)
        host.style.setProperty('--dsh-l2d-opacity', String(config.opacity))
      }
      if (config.appTransparent) {
        document.documentElement.setAttribute(STAGE_ATTR, '')
        document.body.setAttribute(STAGE_ATTR, '')
      } else {
        document.documentElement.removeAttribute(STAGE_ATTR)
        document.body.removeAttribute(STAGE_ATTR)
      }
      updateScrim()
      scheduleRandomMotion()
      scheduleRandomExpression()
      buildPartOverrides()

      if (modelChanged) {
        reloadModel().catch(fail)
        return
      }
      if (idleLoopChanged) {
        applyIdleLoopSwitch()
        report('idle-loop-changed', { enabled: config.idleLoopEnabled, prio: currentMotionPriority() })
      }
      if (idleGroupChanged && ready) {
        var used = setupIdleGroup()
        report('idle-group-changed', { requested: config.idleMotionGroup, used: used })
      }
      // 换了动作池要立刻反映到画面上：很多模型的 idle 是 Loop，光等看门狗
      // 永远等不到"播完"，用户会觉得"选了也没用"。
      var poolNow = (config.idleMotionPool || []).join('\u0001')
      var poolPrev = (prevMotionPool || []).join('\u0001')
      if (poolNow !== poolPrev) {
        prevMotionPool = (config.idleMotionPool || []).slice()
        if (ready) {
          restartIdleBeat()
          report('motion-pool-changed', { pool: config.idleMotionPool, prio: currentMotionPriority() })
        }
      }
      layout()
      report('config-applied', {
        scale: config.scale,
        heightRatio: config.heightRatio,
        anchor: config.anchor,
        opacity: config.opacity,
        scrim: config.scrim,
        zIndex: config.zIndex,
        appTransparent: config.appTransparent,
        gaze: config.gaze,
        modelUrl: config.modelUrl,
      })
      if (!modelChanged) {
        // Expression overrides may have changed: re-apply the current phase.
        currentExpression = null
        applyPhase(phase, true, true)
      }
    }

    async function reloadModel() {
      if (destroyed || !app) return
      try {
        await attachModel()
        if (!destroyed) readyHook()
      } catch (err) {
        fail(err)
      }
    }

    buildDom()
    listen(window, 'resize', layout)
    listen(window, 'pointermove', onPointerMove, { passive: true })
    listen(window, 'blur', onBlur)
    listen(document, 'pointerleave', onPointerLeave)
    listen(document, 'visibilitychange', onVisibility)
    boot()

    // ── 实时预览帧 ──────────────────────────────────────────────
    // 把舞台当前画面按"模型包围盒"裁剪后缩放进目标 2D canvas。
    // 相比 snapshot() 的 toDataURL(JPEG)，这里只做一次 GPU→2D 的
    // drawImage，可以每帧调用，预览窗口因此是真正 60fps 的实时画面。
    let previewFrames = 0
    // ── 实时预览：直接把舞台画布搬进预览小窗 ─────────────────────
    // 预览必须是"和背景一模一样的实时画面"（用户明确要求 60fps），
    // 所以这里不做任何截屏/拷贝：把 canvas 元素挪进预览窗，整个舞台
    // 按小窗尺寸重排；关掉预览再搬回背景层。零拷贝、零读回，天然 60fps。
    let prevMotionPool = []
    let previewBox = null
    let previewObserver = null
    function setPreviewBox(el) {
      if (!app) return false
      const view = app.view
      if (!view) return false
      // 预览窗尺寸一改就要重新排版舞台，否则画面会按旧尺寸裁切。
      if (previewObserver) {
        try { previewObserver.disconnect() } catch (_) { /* ignore */ }
        previewObserver = null
      }
      if (el) {
        previewBox = el
        try {
          el.appendChild(view)
        } catch (_) {
          previewBox = null
          return false
        }
        view.style.position = 'static'
        view.style.left = 'auto'
        view.style.top = 'auto'
        view.style.inset = 'auto'
        view.style.width = '100%'
        view.style.height = '100%'
        view.style.display = 'block'
        try {
          if (typeof ResizeObserver === 'function') {
            previewObserver = new ResizeObserver(function () {
              if (destroyed) return
              try { layout() } catch (_) { /* ignore */ }
            })
            previewObserver.observe(el)
          }
        } catch (_) { /* ignore */ }
      } else {
        previewBox = null
        try {
          if (host && view.parentNode !== host) host.appendChild(view)
        } catch (_) { /* ignore */ }
        view.style.position = 'absolute'
        view.style.left = '0'
        view.style.top = '0'
        view.style.inset = '0'
        view.style.width = '100%'
        view.style.height = '100%'
        view.style.display = 'block'
      }
      try { layout() } catch (_) { /* ignore */ }
      return true
    }

    function drawPreviewFrame(target, outW, outH) {
      if (destroyed || !app || !target) return false
      const view = app.view
      if (!view || !view.width || !view.height) return false
      // 保证 WebGL 绘制缓冲里是最新的一帧（同一次任务里画才拿得到）
      try { app.renderer.render(app.stage) } catch (_) { /* ignore */ }

      let box = null
      try { if (model) box = model.getBounds() } catch (_) { /* ignore */ }
      const res = app.renderer.resolution || 1
      let sx = 0
      let sy = 0
      let sw = view.width
      let sh = view.height
      if (box && box.width > 1 && box.height > 1) {
        const pad = Math.max(16, box.height * 0.06)
        sx = Math.max(0, Math.round((box.x - pad) * res))
        sy = Math.max(0, Math.round((box.y - pad) * res))
        sw = Math.min(view.width - sx, Math.round((box.width + pad * 2) * res))
        sh = Math.min(view.height - sy, Math.round((box.height + pad * 2) * res))
      }
      if (sw <= 1 || sh <= 1) return false

      const w = Math.max(64, Math.round(outW || 300))
      const h = Math.max(64, Math.round(outH || 210))
      if (target.width !== w || target.height !== h) {
        target.width = w
        target.height = h
      }
      const g = target.getContext('2d')
      if (!g) return false
      g.clearRect(0, 0, w, h)
      // 直接从舞台 canvas 拷（同一任务里刚 render 过，缓冲是新的）。
      // 这条路径比 extract+readPixels 便宜得多，能稳定撑住 60fps。
      try {
        g.drawImage(view, sx, sy, sw, sh, 0, 0, w, h)
      } catch (_) {
        // 少数驱动下 WebGL canvas 可能拷不出来，退回 PIXI 的 extract
        try {
          const src = app.renderer.extract.canvas(
            app.stage,
            new window.PIXI.Rectangle(sx / res, sy / res, sw / res, sh / res),
          )
          if (!src || !src.width) return false
          g.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h)
        } catch (_) {
          return false
        }
      }
      previewFrames += 1
      return true
    }

    const handle = {
      get config() { return config },
      get phase() { return phase },
      get ready() { return ready },
      get model() { return model },
      get noseDebug() {
        let raw = null
        try {
          const core = model && model.internalModel.coreModel
          if (core && nosePartDrawables.length) {
            const v = core.getDrawableVertexPositions(nosePartDrawables[0])
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
            for (let k = 0; k < v.length; k += 2) {
              if (v[k] < minX) minX = v[k]
              if (v[k] > maxX) maxX = v[k]
              if (v[k + 1] < minY) minY = v[k + 1]
              if (v[k + 1] > maxY) maxY = v[k + 1]
            }
            const lt = model.internalModel.localTransform
            raw = {
              bbox: [minX, minY, maxX, maxY].map((n) => Math.round(n)),
              lt: [lt.a, lt.b, lt.c, lt.d, Math.round(lt.tx), Math.round(lt.ty)].map((n) => +n.toFixed(3)),
              modelBounds: model.getBounds(),
              internal: [model.internalModel.originalWidth, model.internalModel.originalHeight, model.internalModel.width, model.internalModel.height],
            }
          }
        } catch (err) { raw = String(err && err.message) }
        return {
          mode: config.noseMode,
          drawables: nosePartDrawables.slice(),
          visible: noseSprite ? noseSprite.visible : null,
          pos: noseSprite ? [Math.round(noseSprite.x), Math.round(noseSprite.y)] : null,
          scale: noseSprite ? +noseSprite.scale.x.toFixed(3) : null,
          raw,
        }
      },
      setPhase(next, immediate) { applyPhase(next, immediate === true) },
      speak(text, ttl) { speak(text, ttl) },
      updateConfig(patch) { updateConfig(patch) },
      reload() { return reloadModel() },
      // 供设置页展示 / 试玩
      assets() {
        return {
          expressions: expressionNames.slice(), motions: motionGroups.slice(), catalog: motionCatalog.slice(),
          motionPool: config.idleMotionPool.slice(), expressionPool: config.idleExpressionPool.slice(),
        }
      },
      // 当前模型的能力，用来让设置页自适应：
      // 没有 exp3 表情的模型不显示表情选择，没有黑色鼻子问题的模型不显示鼻子选项
      capabilities() {
        return {
          expressions: expressionNames.slice(),
          motions: motionGroups.slice(),
          catalog: motionCatalog.slice(),
          motionPool: config.idleMotionPool.slice(),
          expressionPool: config.idleExpressionPool.slice(),
          nose: nosePartDrawables.length > 0,
          modelUrl: config.modelUrl,
          info: modelInfo,
        }
      },
      playMotionAt(group, index) {
        if (!model || destroyed) return false
        try {
          var started = model.motion(group, index, 2)
          if (started && typeof started.catch === 'function') started.catch(function () {})
          return true
        } catch (_) { return false }
      },
      playExpression(name, ttl) { return applyExpression(name, { ttl: ttl || 4000, priority: 3, reason: 'play' }) },
      // 实时预览：把舞台当前这一帧按模型包围盒裁剪后画进目标 2D canvas。
      // 每帧（rAF）调用，不走 toDataURL，所以是真正的实时画面而不是几秒一帧。
      previewFrame(target, outW, outH) {
        return drawPreviewFrame(target, outW, outH)
      },
      previewFrames() { return previewFrames },
      // 预览窗把舞台画布搬过去 / 还回来（零拷贝实时预览）
      setPreviewHost(el) { return setPreviewBox(el) },
      // 预览窗里的模型缩放：只影响预览取景，并持久化到宿主设置
      setPreviewZoom(z) {
        const v = Math.max(0.3, Math.min(5, Math.round((Number(z) || 1) * 100) / 100))
        updateConfig({ previewZoom: v })
        try {
          fetch(PREFIX + '/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ previewZoom: v }),
          }).catch(function () {})
        } catch { /* ignore */ }
        return v
      },
      setPreviewPan(dx, dy) {
        updateConfig({ previewOffsetX: Number(dx) || 0, previewOffsetY: Number(dy) || 0 })
        return true
      },
      get previewHosted() { return !!previewBox },
      // 空闲演出池：随机做一个动作 / 表情（设置页自检用）
      playPooledMotion() { return playPooledMotion() },
      playPooledExpression(ttl) { return playPooledExpression(ttl) },
      // 「立即试一次」：绕过概率/间隔，直接触发一次，并重置倒计时
      fireMotionNow() {
        nextMotionAt = Date.now() + motionIntervalMs()
        lastMotionSkip = 'manual'
        return playPooledMotion(2)
      },
      fireExpressionNow(ttl) {
        nextExpressionAt = Date.now() + expressionIntervalMs()
        lastExpressionSkip = 'manual'
        return playPooledExpression(ttl || config.expressionHoldMs)
      },
      // 对话反应（设置页自检 / SSE 都走这里）
      react(type) { handleModelReact(type); return stats.reacts },
      // 舞台缩略图：设置页预览 / 自检对比都用它（不依赖屏幕截图）
      snapshot(w, h) {
        try {
          var c = app.renderer.extract.canvas(app.stage, new window.PIXI.Rectangle(0, 0, app.renderer.width, app.renderer.height))
          var t = document.createElement('canvas')
          t.width = w || 240
          t.height = h || 150
          var g = t.getContext('2d')
          g.clearRect(0, 0, t.width, t.height)
          g.drawImage(c, 0, 0, t.width, t.height)
          return t.toDataURL('image/jpeg', 0.6)
        } catch (err) { return '' }
      },
      // 自检用：把"模型此刻到底被什么参数驱动"暴露出来，
      // 设置页/自动化测试都能据此判断某个设置是否真的起作用。
      probe() {
        var core = model && model.internalModel && model.internalModel.coreModel
        var ids = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamEyeBallX', 'ParamEyeBallY',
          'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ', 'ParamBreath',
          'HipAngleX', 'HipAngleZ', 'LArm', 'RArm', 'ShoulderY']
        var params = {}
        var present = {}
        if (core) {
          ids.forEach(function (id) {
            try {
              var idx = core.getParameterIndex(id)
              present[id] = idx >= 0
              params[id] = idx >= 0 ? +Number(core.getParameterValueById(id)).toFixed(3) : null
            } catch (_) { present[id] = false; params[id] = null }
          })
        }
        var mgr = model && model.internalModel && model.internalModel.motionManager
        return {
          ready: ready,
          phase: phase,
          stats: { motions: stats.motions, idles: stats.idles, expressions: stats.expressions, phases: stats.phases, reacts: stats.reacts },
          react: reactKind ? { kind: reactKind, remaining: Math.max(0, reactDur - (Date.now() - reactStart)) } : null,
          modelUrl: config.modelUrl,
          params: params,
          present: present,
          expression: currentExpression,
          // 预览取景（只影响预览小窗）
          previewZoom: config.previewZoom,
          previewOffsetX: config.previewOffsetX,
          previewOffsetY: config.previewOffsetY,
          // 下次动作/表情的倒计时（毫秒，-1 = 未排程）。设置页用它显示
          // "下次表情 12s"，用户就不用猜"到底有没有生效"。
          schedule: {
            nextMotionIn: nextMotionAt ? Math.max(0, nextMotionAt - Date.now()) : -1,
            nextExpressionIn: nextExpressionAt ? Math.max(0, nextExpressionAt - Date.now()) : -1,
            motionSec: Math.max(5, Number(config.randomMotionSeconds) || 5),
            expressionSec: Math.max(3, Number(config.idleExpressionSeconds) || 3),
            motionChance: config.randomMotionChance,
            expressionChance: config.randomExpressionChance,
            motionPool: (config.idleMotionPool || []).length,
            expressionPool: (config.idleExpressionPool || []).length,
          },
          idle: {
            hidden: document.hidden,
            visibility: document.visibilityState,
            lastActivity: lastActivity,
            lastSayAt: lastSayAt,
            sinceActivity: Date.now() - lastActivity,
            idleSeconds: config.idleSeconds,
          },
          motion: mgr && mgr.state ? {
            priority: mgr.state.currentPriority,
            playing: !!mgr.playing,
            idleGroup: mgr.groups && mgr.groups.idle,
            // 占用期：true 时新的演出动作会被拒（正在播 / 刚起头）
            busy: motionBusy(),
            stops: motionStops,
            armed: holdArmed,
            holdMs: config.motionHoldMs,
          } : null,
          layout: model ? {
            x: Math.round(model.x), y: Math.round(model.y),
            scaleX: +model.scale.x.toFixed(3),
            w: Math.round(model.width), h: Math.round(model.height),
          } : null,
          stage: host ? {
            opacity: getComputedStyle(host).opacity,
            zIndex: getComputedStyle(host).zIndex,
            hasScrim: !!document.querySelector('.dsh-l2d-scrim'),
            scrimBg: (function () {
              var el = document.querySelector('.dsh-l2d-scrim')
              return el ? getComputedStyle(el).backgroundImage : ''
            })(),
            bodyAttr: document.body.hasAttribute(STAGE_ATTR),
          } : null,
        }
      },
      playMotion(group) {
        if (!model || destroyed) return false
        var picked = startRandomFrom(group, 2)
        if (picked && typeof picked.catch === 'function') picked.catch(function () {})
        return !!picked
      },
      resetExpression() {
        returnToBase()
        return true
      },
      destroy() {
        if (destroyed) return
        destroyed = true
        clearInterval(idleTimer)
        clearInterval(randomMotionTimer)
        clearInterval(randomExpressionTimer)
        clearInterval(heartbeatTimer)
        clearTimeout(phaseTimer)
        clearTimeout(exprTimer)
        exprHoldArmedAt = 0
        clearTimeout(motionStopTimer)
        motionStopTimer = null
        clearTimeout(tempExprTimer)
        clearTimeout(sayTimer)
        for (const off of listeners.splice(0)) { try { off() } catch { /* ignore */ } }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        if (sse) { try { sse.close() } catch { /* ignore */ } sse = null }
        try { if (app) app.ticker.stop() } catch { /* ignore */ }
        // 预览窗可能正拿着这块 canvas，销毁前先搬回背景层，避免留下孤儿画面
        try { setPreviewBox(null) } catch { /* ignore */ }
        if (noseSprite) {
          try { noseSprite.destroy({ texture: true, baseTexture: true }) } catch { /* ignore */ }
          noseSprite = null
        }
        nosePartDrawables = []
        if (model) {
          // 先停掉动作循环：SDK 的动作 Promise 在模型销毁后仍会回写 motionGroups，
        // 那正是 "Cannot set properties of undefined (setting '2')" 的来源。
        try { model.internalModel.motionManager.stopAllMotions() } catch { /* ignore */ }
        try { model.destroy({ children: true, texture: true, baseTexture: true }) } catch { /* ignore */ }
          model = null
        }
        try { if (app) app.destroy(true, { children: false }) } catch { /* ignore */ }
        app = null
        ready = false
        destroyDom()
        if (window.__dshLive2DStage === handle) window.__dshLive2DStage = null
      },
    }
    window.__dshLive2DStage = handle
    return handle
  }

  function makeFactory(require) {
    const React = require('react')
    const h = React.createElement

    function StageAnchor() {
      const [say, setSay] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [nonce, setNonce] = React.useState(0)
      const sayTimer = React.useRef(null)
      const stageRef = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        const stage = createStage({
          onSay(payload) {
            if (!alive) return
            setSay(payload)
            clearTimeout(sayTimer.current)
            sayTimer.current = setTimeout(() => { if (alive) setSay(null) }, payload.ttl || 5200)
          },
          onError(err) {
            if (alive) setError(err && err.message ? err.message : String(err))
          },
          onReady() {
            if (alive) setError(null)
          },
        })
        stageRef.current = stage
        return () => {
          alive = false
          clearTimeout(sayTimer.current)
          stage.destroy()
          stageRef.current = null
        }
      }, [nonce])

      const children = []
      if (error) {
        children.push(h('div', { className: 'dsh-l2d-alert', key: 'alert' },
          h('span', null, 'Live2D 背景未能加载：' + error),
          h('button', { type: 'button', onClick: () => setNonce((n) => n + 1) }, '重试'),
        ))
      }
      if (say && !error) {
        children.push(h('div', {
          className: 'dsh-l2d-bubble',
          key: 'bubble-' + say.text,
          style: { left: say.x + 'px', top: say.y + 'px' },
        }, say.text))
      }
      return children.length ? h(React.Fragment, null, children) : null
    }

    function Field(props) {
      return h('div', { className: 'dsh-l2d-set__row' },
        h('span', { className: 'dsh-l2d-set__label' }, props.label),
        h('div', { className: 'dsh-l2d-set__control' }, props.children),
        props.hint ? h('span', { className: 'dsh-l2d-set__hint' }, props.hint) : null,
      )
    }

    function Range(props) {
      return h('div', { className: 'dsh-l2d-set__range' },
        h('input', {
          type: 'range', min: props.min, max: props.max, step: props.step, value: props.value,
          onChange: (event) => props.onChange(Number(event.target.value)),
        }),
        h('output', null, props.format ? props.format(props.value) : String(props.value)),
      )
    }

    const EDIT_KEYS = [
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
      // 空闲演出池（动作池 + 表情池）
      'idleMotionPool', 'idleExpressionPool', 'idleExpressionSeconds', 'randomExpressionChance', 'expressionHoldMs',
      'idleExpressionEnabled', 'idleMotionEnabled',
      // 对话感知
      'reactToUserMessage', 'reactToToolCall', 'reactToChoices',
      // 模型外观细节
      'noseMode', 'motionIntensity',
      // 预览取景
      'previewZoom', 'previewOffsetX', 'previewOffsetY',
    ]

    // 把毫秒倒计时变成人能读的字串（-1 = 未排程）
    function countdown(ms) {
      if (typeof ms !== 'number' || ms < 0) return '未排程'
      if (ms < 1000) return '即将'
      return Math.round(ms / 1000) + 's'
    }

    function pickEditable(cfg) {      const out = {}
      for (const key of EDIT_KEYS) out[key] = cfg[key]
      out.expressions = Object.assign({}, cfg.expressions || {})
      out.idleLines = Array.isArray(cfg.idleLines) ? cfg.idleLines.slice() : []
      // 演出池：空数组 = 全部可用项（显示成"全选"语义）
      out.idleMotionPool = Array.isArray(cfg.idleMotionPool) ? cfg.idleMotionPool.slice() : []
      out.idleExpressionPool = Array.isArray(cfg.idleExpressionPool) ? cfg.idleExpressionPool.slice() : []
      return out
    }

    // 模型能力面板：把"这个模型到底有什么"直接摊开给用户看，
    // 免得出现"设置里没有那一项"却以为是插件坏了。
    function CapabilityPanel(props) {
      const info = props && props.info
      const yes = (v) => (v ? '有' : '无')
      const rows = []
      if (info) {
        rows.push(['格式', info.format === 'cubism2' ? 'Cubism 2.1（需额外运行时）' : 'Cubism 3/4/5'])
        if (info.version) rows.push(['清单版本', 'Version ' + info.version])
        rows.push(['贴图', (info.textures || 0) + ' 张'])
        rows.push(['物理演算', yes(info.physics)])
        if (info.pose) rows.push(['Pose', '有'])
        if (info.userdata) rows.push(['UserData', '有'])
        const scanned = (info.expressions || []).filter((e) => e.source === 'scan').length
        rows.push(['表情', (info.expressions || []).length
          ? (info.expressions || []).length + ' 个' + (scanned ? '（其中 ' + scanned + ' 个由文件夹扫描补全）' : '')
          : '无 exp3 文件'])
        const groups = info.motionGroups || []
        const total = groups.reduce((sum, g) => sum + (g.count || 0), 0)
        rows.push(['动作', total
          ? total + ' 个 / ' + groups.length + ' 组：' + groups.map((g) => (g.name || '(默认)') + '×' + g.count).join('、')
          : '无 motion3 文件'])
        rows.push(['命中区域', (info.hitAreas || []).length + ' 个'])
        rows.push(['眨眼参数', (info.eyeBlink || []).length + ' 个'])
        rows.push(['口型参数', (info.lipSync || []).length ? info.lipSync.length + ' 个' : '未声明'])
      }
      return h('div', { className: 'dsh-l2d-set__group' },
        h('div', { className: 'dsh-l2d-set__legend' }, '模型能力（自动识别）'),
        info
          ? h('div', { className: 'dsh-l2d-set__kv' }, rows.map((row) => h('div', { key: row[0], className: 'dsh-l2d-set__kv-row' },
            h('span', { className: 'dsh-l2d-set__kv-key' }, row[0]),
            h('span', { className: 'dsh-l2d-set__kv-val' }, row[1]),
          )))
          : h('p', { className: 'dsh-l2d-set__hint' }, '还没读到模型信息：模型加载完成后这里会列出它实际拥有的表情、动作组与物理等。'),
        info && info.scanned
          ? h('p', { className: 'dsh-l2d-set__hint' }, '带「·扫描」标记的项目来自文件夹扫描——模型清单里没有声明，插件读取清单时自动补全，可直接在下面试玩。')
          : null,
        info && (info.warnings || []).length
          ? (info.warnings || []).map((w, i) => h('p', { key: 'warn-' + i, className: 'dsh-l2d-set__warn' }, '⚠ ' + w))
          : null,
        h('button', { type: 'button', onClick: props.onRescan }, '重新识别模型'),
      )
    }

    function Live2DSettings() {
      const [data, setData] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [status, setStatus] = React.useState('')
      const [error, setError] = React.useState('')
      const [assets, setAssets] = React.useState({ expressions: [], motions: [], catalog: [], nose: false })
      // 实时排程快照：让用户直接看到"下次表情还有几秒"，
      // 不用靠猜来判断设置到底有没有生效。
      const [live, setLive] = React.useState(null)
      const autoReady = React.useRef(false)
      const saveRef = React.useRef(null)

      React.useEffect(() => {
        const timer = setInterval(() => {
          const stage = window.__dshLive2DStage
          if (!stage || typeof stage.probe !== 'function') { setLive(null); return }
          try {
            const p = stage.probe()
            setLive({ schedule: p.schedule || null, expression: p.expression || null, phase: p.phase || null })
          } catch { setLive(null) }
        }, 700)
        return () => clearInterval(timer)
      }, [])

      const readAssets = React.useCallback(() => {
        const stage = window.__dshLive2DStage
        if (stage && typeof stage.capabilities === 'function') {
          try { setAssets(stage.capabilities()) } catch { /* ignore */ }
        } else if (stage && typeof stage.assets === 'function') {
          try { setAssets(Object.assign({ nose: false }, stage.assets())) } catch { /* ignore */ }
        }
      }, [])

      const load = React.useCallback(() => {
        return fetch(PREFIX + '/api/settings', { credentials: 'same-origin' })
          .then((res) => {
            if (!res.ok) throw new Error('HTTP ' + res.status)
            return res.json()
          })
          .then((json) => {
            setData(json)
            setForm(pickEditable(Object.assign({}, DEFAULT_CONFIG, json.config)))
            setError('')
          })
          .catch((err) => setError(err && err.message ? err.message : String(err)))
      }, [])

      React.useEffect(() => {
        let alive = true
        fetch(PREFIX + '/api/settings', { credentials: 'same-origin' })
          .then((res) => {
            if (!res.ok) throw new Error('HTTP ' + res.status)
            return res.json()
          })
          .then((json) => {
            if (!alive) return
            setData(json)
            setForm(pickEditable(Object.assign({}, DEFAULT_CONFIG, json.config)))
            setError('')
          })
          .catch((err) => {
            if (alive) setError(err && err.message ? err.message : String(err))
          })
        readAssets()
        const timer = setTimeout(readAssets, 1500)
        return () => { alive = false; clearTimeout(timer) }
      }, [])

      // 拖动滑杆/勾选后 400ms 自动保存应用 —— 不需要用户再记得点按钮，
      // 避免"改了设置却没生效"的困惑。按钮仍然保留，用于手动立刻保存。
      // 注意：所有 Hook 必须写在下方的提前 return 之前，否则 form 从 null
      // 变成对象后 Hook 数量变化，React 会抛 "Rendered more hooks than
      // during the previous render." 整个设置页会变空白。
      const autoTimer = React.useRef(null)
      React.useEffect(() => {
        if (!form) return undefined
        if (!autoReady.current) { autoReady.current = true; return undefined }
        clearTimeout(autoTimer.current)
        autoTimer.current = setTimeout(() => {
          if (typeof saveRef.current === 'function') saveRef.current(true)
        }, 400)
        return () => clearTimeout(autoTimer.current)
      }, [form])

      if (error) {
        return h('div', { className: 'dsh-l2d-set' },
          h('div', { className: 'dsh-l2d-set__group' },
            h('div', { className: 'dsh-l2d-set__legend' }, 'Live2D 背景'),
            h('p', { className: 'dsh-l2d-set__hint' }, '设置读取失败：' + error),
            h('button', { type: 'button', onClick: load }, '重试'),
          ),
        )
      }
      if (!form) {
        return h('div', { className: 'dsh-l2d-set' },
          h('div', { className: 'dsh-l2d-set__group' }, '加载中…'),
        )
      }

      const set = (key) => (value) => setForm((prev) => Object.assign({}, prev, { [key]: value }))
      // 演出池：勾选/取消某一项；返回的数组就是最终要存的配置值
      const setPool = (key, list) => setForm((prev) => Object.assign({}, prev, { [key]: list.slice() }))
      const togglePool = (key, name, checked) => setForm((prev) => {
        const list = (prev[key] || []).slice()
        const at = list.indexOf(name)
        if (checked && at < 0) list.push(name)
        else if (!checked && at >= 0) list.splice(at, 1)
        return Object.assign({}, prev, { [key]: list })
      })
      const models = (data && data.models) || []
      const builtin = data && data.builtin
      const anchors = (data && data.anchors) || []
      const phases = (data && data.phases) || []

      const modelOptions = [{ url: '', name: '使用本地路径 / 内置默认' }]
      if (builtin) modelOptions.push({ url: builtin.url, name: builtin.name })
      for (const entry of models) {
        if (!modelOptions.some((item) => item.url === entry.url)) modelOptions.push(entry)
      }
      if (form.modelUrl && !modelOptions.some((item) => item.url === form.modelUrl)) {
        modelOptions.push({ url: form.modelUrl, name: '当前：' + form.modelUrl })
      }

      const save = async (silent) => {
        if (!silent) setStatus('保存中…')
        try {
          const res = await fetch(PREFIX + '/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(form),
          })
          const json = await res.json()
          if (!res.ok) throw new Error(json.error || 'HTTP ' + res.status)
          if (window.__dshLive2DStage && typeof window.__dshLive2DStage.updateConfig === 'function') {
            window.__dshLive2DStage.updateConfig(json.config)
          }
          setData((prev) => Object.assign({}, prev, { config: json.config }))
          setStatus(silent ? '已自动应用' : '已保存并应用')
        } catch (err) {
          setStatus('保存失败：' + (err && err.message ? err.message : err))
        }
      }

      const rescan = async () => {
        try {
          const res = await fetch(PREFIX + '/api/settings', { credentials: 'same-origin' })
          const json = await res.json()
          setData(json)
          setStatus('模型列表已刷新（共 ' + ((json.models || []).length) + ' 个本地模型）')
        } catch (err) {
          setStatus('刷新失败：' + (err && err.message ? err.message : err))
        }
      }

      const reset = () => {
        setForm(pickEditable(DEFAULT_CONFIG))
        setStatus('已恢复默认值（自动应用）')
      }
      saveRef.current = save

      return h('div', { className: 'dsh-l2d-set' },
        h('div', { className: 'dsh-l2d-set__group' },
          h('div', { className: 'dsh-l2d-set__legend' }, '模型'),
          h(Field, { label: '选择模型' },
            h('div', { className: 'dsh-l2d-set__inline' },
              h('select', { value: form.modelUrl, onChange: (event) => set('modelUrl')(event.target.value) },
                modelOptions.map((item) => h('option', { key: item.url || 'none', value: item.url }, item.name)),
              ),
              h('button', { type: 'button', onClick: rescan }, '重新扫描'),
            ),
          ),
          h(Field, {
            label: '模型 URL',
            hint: '可填写站内路径（/dsh-live2d-stage/...）或 http(s) 链接；留空则使用下面的本地路径或内置示例。',
          },
            h('input', {
              type: 'text',
              value: form.modelUrl,
              placeholder: '留空 = 本地路径或内置 Natori',
              onChange: (event) => set('modelUrl')(event.target.value),
            }),
          ),
          h(Field, {
            label: '本地 model3.json',
            hint: data && data.modelsDir
              ? '主机绝对路径。模型目录：' + data.modelsDir + '（把整个模型文件夹放进去后点「重新扫描」）'
              : '主机绝对路径。',
          },
            h('input', {
              type: 'text',
              value: form.modelPath,
              placeholder: 'C:\\Models\\Hiyori\\Hiyori.model3.json',
              onChange: (event) => set('modelPath')(event.target.value),
            }),
          ),
        ),

        h(CapabilityPanel, { info: assets.info, onRescan: readAssets }),

        h('div', { className: 'dsh-l2d-set__group' },
          h('div', { className: 'dsh-l2d-set__legend' }, '位置与尺寸'),
          h(Field, { label: '锚点' },
            h('select', { value: form.anchor, onChange: (event) => set('anchor')(event.target.value) },
              anchors.map((value) => h('option', { key: value, value }, value)),
            ),
          ),
          h(Field, { label: '缩放' },
            h(Range, { value: form.scale, min: 0.2, max: 2, step: 0.05, onChange: set('scale'), format: (v) => Number(v || 0).toFixed(2) + '×' }),
          ),
          h(Field, { label: '屏高占比' },
            h(Range, { value: form.heightRatio, min: 0.2, max: 1.4, step: 0.02, onChange: set('heightRatio'), format: (v) => Math.round(v * 100) + '%' }),
          ),
          h(Field, { label: '水平偏移' },
            h(Range, { value: form.offsetX, min: -800, max: 800, step: 2, onChange: set('offsetX'), format: (v) => v + 'px' }),
          ),
          h(Field, { label: '垂直偏移' },
            h(Range, { value: form.offsetY, min: -800, max: 800, step: 2, onChange: set('offsetY'), format: (v) => v + 'px' }),
          ),
        ),

        h('div', { className: 'dsh-l2d-set__group' },
          h('div', { className: 'dsh-l2d-set__legend' }, '外观'),
          h(Field, { label: '不透明度' },
            h(Range, { value: form.opacity, min: 0, max: 1, step: 0.05, onChange: set('opacity'), format: (v) => Math.round(v * 100) + '%' }),
          ),
          h(Field, { label: '暗角遮罩' },
            h(Range, { value: form.scrim, min: 0, max: 0.8, step: 0.02, onChange: set('scrim'), format: (v) => Math.round(v * 100) + '%' }),
          ),
          h(Field, { label: '层级 z-index', hint: '必须小于 0 才能位于对话界面之后；范围 -10 ~ 0。' },
            h('input', {
              type: 'number', min: -10, max: 0, step: 1, value: form.zIndex,
              onChange: (event) => set('zIndex')(Number(event.target.value)),
            }),
          ),
          h(Field, { label: '透明界面' },
            h('label', { className: 'dsh-l2d-set__check' },
              h('input', {
                type: 'checkbox', checked: form.appTransparent !== false,
                onChange: (event) => set('appTransparent')(event.target.checked),
              }),
              '让应用背景透明，露出模型（关闭后模型几乎不可见）',
            ),
          ),
          h(Field, {
            label: '预览里的模型大小',
            hint: '只影响设置页旁边那个预览小窗的取景，不影响背景层；预览窗大小拖它右下角 ⤡ 调整。',
          },
            h(Range, {
              value: form.previewZoom, min: 0.3, max: 5, step: 0.1,
              onChange: set('previewZoom'),
              format: (v) => Number(v || 0).toFixed(1) + '×',
            }),
          ),
        ),

        h('div', { className: 'dsh-l2d-set__group' },
          h('div', { className: 'dsh-l2d-set__legend' }, '行为'),
          h(Field, { label: '视线跟随' },
            h('label', { className: 'dsh-l2d-set__check' },
              h('input', {
                type: 'checkbox', checked: form.gaze !== false,
                onChange: (event) => set('gaze')(event.target.checked),
              }),
              '跟随鼠标转动头部与视线',
            ),
          ),
          h(Field, { label: '头部转动幅度 X', hint: 'ParamAngleX 最大度数（默认 15，原 30 过大）' },
            h(Range, { value: form.gazeAngleX, min: 0, max: 60, step: 1, onChange: set('gazeAngleX'), format: (v) => v + '°' }),
          ),
          h(Field, { label: '头部转动幅度 Y', hint: 'ParamAngleY 最大度数（默认 10）' },
            h(Range, { value: form.gazeAngleY, min: 0, max: 40, step: 1, onChange: set('gazeAngleY'), format: (v) => v + '°' }),
          ),
          h(Field, { label: '眼球转动幅度 X', hint: 'ParamEyeBallX 幅度（默认 0.4，原 0.9 过大）' },
            h(Range, { value: form.gazeEyeBallX, min: 0, max: 2, step: 0.05, onChange: set('gazeEyeBallX'), format: (v) => Number(v || 0).toFixed(2) }),
          ),
          h(Field, { label: '眼球转动幅度 Y', hint: 'ParamEyeBallY 幅度（默认 0.35）' },
            h(Range, { value: form.gazeEyeBallY, min: 0, max: 2, step: 0.05, onChange: set('gazeEyeBallY'), format: (v) => Number(v || 0).toFixed(2) }),
          ),
          h(Field, { label: '视线跟随平滑度', hint: '越小越跟随、越大越平滑（默认 0.08）' },
            h(Range, { value: form.gazeSmooth, min: 0.01, max: 0.5, step: 0.01, onChange: set('gazeSmooth'), format: (v) => Number(v || 0).toFixed(2) }),
          ),
          h(Field, { label: '身体左右转向', hint: '鼠标左右移动时，胸腔/胯骨跟着转多少度（默认 10）' },
            h(Range, { value: form.bodyFollowX, min: 0, max: 30, step: 1, onChange: set('bodyFollowX'), format: (v) => Number(v || 0).toFixed(0) }),
          ),
          h(Field, { label: '身体前后俯仰', hint: '鼠标上下移动时，身体前后倾多少度（默认 7）' },
            h(Range, { value: form.bodyFollowY, min: 0, max: 25, step: 1, onChange: set('bodyFollowY'), format: (v) => Number(v || 0).toFixed(0) }),
          ),
          h(Field, { label: '视线回正平滑度', hint: '失焦/离开时回正速度（默认 0.04）' },
            h(Range, { value: form.gazeReturnSmooth, min: 0.01, max: 0.5, step: 0.01, onChange: set('gazeReturnSmooth'), format: (v) => Number(v || 0).toFixed(2) }),
          ),
          h(Field, { label: '气泡停留' },
            h(Range, { value: form.bubbleMs, min: 1500, max: 15000, step: 250, onChange: set('bubbleMs'), format: (v) => (v / 1000).toFixed(1) + 's' }),
          ),
          h(Field, { label: '阶段最短停留', hint: '切换过快时先压住，避免表情闪烁（默认 380ms）' },
            h(Range, { value: form.minDwellMs, min: 0, max: 3000, step: 20, onChange: set('minDwellMs'), format: (v) => v + 'ms' }),
          ),
          h(Field, { label: '完成表情停留', hint: 'success/done 保持多久再回 idle（默认 2.6s）' },
            h(Range, { value: form.successMs, min: 400, max: 10000, step: 100, onChange: set('successMs'), format: (v) => (v / 1000).toFixed(1) + 's' }),
          ),
          h(Field, { label: '报错表情停留', hint: 'error/failed 保持多久（默认 5.2s）' },
            h(Range, { value: form.errorMs, min: 600, max: 20000, step: 200, onChange: set('errorMs'), format: (v) => (v / 1000).toFixed(1) + 's' }),
          ),
        ),

        h('div', { className: 'dsh-l2d-set__group' },
          h('div', { className: 'dsh-l2d-set__legend' }, '① 对话表情：提问 / 输入 / 输出（高层级）'),
          assets.expressions.length === 0
            ? h('p', { className: 'dsh-l2d-set__hint' }, '当前模型没有 exp3 表情文件，阶段切换只会使用动作与参数回退。')
            : h('p', { className: 'dsh-l2d-set__hint' }, '这三个场景优先级最高：触发时立刻盖掉常态随机表情，' +'停留「表情停留时长」后自动回到基础表情。'),
          assets.expressions.length === 0 ? null : EXPR_SCENES.map((scene) => h(Field, { key: scene.key, label: scene.label, hint: scene.hint },
            h('select', {
              value: (form.expressions && assets.expressions.indexOf(form.expressions[scene.key]) >= 0 ? form.expressions[scene.key] : '') || '',
              onChange: (event) => {
                const value = event.target.value
                setForm((prev) => {
                  const expressions = Object.assign({}, prev.expressions)
                  if (value) expressions[scene.key] = value
                  else delete expressions[scene.key]
                  return Object.assign({}, prev, { expressions })
                })
              },
            },
              h('option', { value: '' }, '内置默认（' + ((PHASE_EXPRESSION[scene.key] || [])[0] || '-') + '）'),
              assets.expressions.map((name) => h('option', { key: name, value: name }, name)),
            ),
          )),
          h('button', { type: 'button', onClick: readAssets }, '重新读取当前模型的表情 / 动作'),
        ),

        h('div', { className: 'dsh-l2d-set__group' },
          h('div', { className: 'dsh-l2d-set__legend' }, '② 常态演出池：表情库 / 动作库（低层级）'),
          h('p', { className: 'dsh-l2d-set__hint' },
            '勾选放进池子里的动作与表情，空闲时会随机从池里抽一个播放；不勾选任何项 = 该模型全部可用项都参与随机。',
          ),
          h('div', { className: 'dsh-l2d-set__live' },
            h('label', { className: 'dsh-l2d-set__check' },
              h('input', {
                type: 'checkbox', checked: form.idleExpressionEnabled !== false,
                onChange: (event) => set('idleExpressionEnabled')(event.target.checked),
              }),
              '启动常态表情（关闭后随机表情完全不出现）',
            ),
            h('label', { className: 'dsh-l2d-set__check' },
              h('input', {
                type: 'checkbox', checked: form.idleMotionEnabled !== false,
                onChange: (event) => set('idleMotionEnabled')(event.target.checked),
              }),
              '启动常态动作（关闭后随机动作完全不出现）',
            ),
          ),
          h('p', { className: 'dsh-l2d-set__hint' },
            '动作只在「常态（idle）」释放：思考、工具执行、等待你回答、收尾期间都不会放动作，只保留呼吸 / 视线 / 身体微动。',
          ),
          h('div', { className: 'dsh-l2d-set__pool' },
            h('div', { className: 'dsh-l2d-set__pool-head' },
              h('span', null, '动作池（' + assets.catalog.length + ' 个可用）'),
              h('button', { type: 'button', onClick: () => setPool('idleMotionPool', assets.catalog.map((m) => m.label)) }, '全选'),
              h('button', { type: 'button', onClick: () => setPool('idleMotionPool', []) }, '清空'),
            ),
            assets.catalog.length
              ? h('div', { className: 'dsh-l2d-set__pool-list' },
                  assets.catalog.map((item) => h('label', { key: 'pm-' + item.label, className: 'dsh-l2d-set__pool-item' },
                    h('input', {
                      type: 'checkbox',
                      checked: form.idleMotionPool.indexOf(item.label) >= 0,
                      onChange: (event) => togglePool('idleMotionPool', item.label, event.target.checked),
                    }),
                    h('span', null, item.label),
                    item.source === 'scan' ? h('span', { className: 'dsh-l2d-set__tag' }, '扫描') : null,
                  )),
                )
              : h('p', { className: 'dsh-l2d-set__hint' }, '当前模型没有动作文件。'),
          ),
          h('div', { className: 'dsh-l2d-set__pool' },
            h('div', { className: 'dsh-l2d-set__pool-head' },
              h('span', null, '表情池（' + assets.expressions.length + ' 个可用）'),
              h('button', { type: 'button', onClick: () => setPool('idleExpressionPool', assets.expressions) }, '全选'),
              h('button', { type: 'button', onClick: () => setPool('idleExpressionPool', []) }, '清空'),
            ),
            assets.expressions.length
              ? h('div', { className: 'dsh-l2d-set__pool-list' },
                  assets.expressions.map((name) => h('label', { key: 'pe-' + name, className: 'dsh-l2d-set__pool-item' },
                    h('input', {
                      type: 'checkbox',
                      checked: form.idleExpressionPool.indexOf(name) >= 0,
                      onChange: (event) => togglePool('idleExpressionPool', name, event.target.checked),
                    }),
                    h('span', null, name),
                  )),
                )
              : h('p', { className: 'dsh-l2d-set__hint' }, '当前模型没有 exp3 表情文件。'),
          ),
        ),

        h('div', { className: 'dsh-l2d-set__group' },
          h('div', { className: 'dsh-l2d-set__legend' }, '② 常态演出节奏与概率'),
          h('div', { className: 'dsh-l2d-set__live' },
            h('span', { className: 'dsh-l2d-set__live-line' },
              '下次表情：' + countdown(live && live.schedule ? live.schedule.nextExpressionIn : -1) +
              '　下次动作：' + countdown(live && live.schedule ? live.schedule.nextMotionIn : -1) +
              (live && live.expression ? '　当前表情：' + live.expression : ''),
            ),
            h('button', {
              type: 'button',
              className: 'chip',
              onClick: () => {
                const stage = window.__dshLive2DStage
                if (stage && stage.fireExpressionNow) { const ok = stage.fireExpressionNow(); setStatus(ok ? '已立即播放一次表情' : '立即播放失败（看模型能力里的表情数）') }
                else setStatus('背景层还没就绪')
              },
            }, '立即试一次表情'),
            h('button', {
              type: 'button',
              className: 'chip',
              onClick: () => {
                const stage = window.__dshLive2DStage
                if (stage && stage.fireMotionNow) { const ok = stage.fireMotionNow(); setStatus(ok ? '已立即播放一次动作' : '立即播放失败（看模型能力里的动作数）') }
                else setStatus('背景层还没就绪')
              },
            }, '立即试一次动作'),
          ),
          h(Field, {
            label: '待机动作组',
            hint: '循环播放哪一组动作。不同模型分组名不一样（有的叫 Idle，有的所有动作塞在“默认”组里）。',
          },
            h('select', {
              value: form.idleMotionGroup || '',
              onChange: (event) => set('idleMotionGroup')(event.target.value),
            },
              h('option', { value: '' }, '自动识别'),
              ((assets.info && assets.info.motionGroups) || []).map((g) => h('option', {
                key: 'idle-' + (g.name || 'default'),
                value: g.name || '',
              }, (g.name || '（默认组）') + ' · ' + g.count + ' 个动作')),
            ),
          ),
          h(Field, { label: '待机循环动作', hint: '关掉后连模型自带的基础循环动作也不播，只剩呼吸、身体微动与视线跟随' },
            h('label', { className: 'dsh-l2d-set__check' },
              h('input', {
                type: 'checkbox', checked: form.idleLoopEnabled !== false,
                onChange: (event) => set('idleLoopEnabled')(event.target.checked),
              }),
              '保持模型自带的待机循环动作',
            ),
          ),
          h(Field, { label: '空闲时触发表情概率', hint: '「说台词」那一刻顺带做个表情的概率（什么时候说台词由下面「空闲台词 → 台词触发时间」决定）' },
            h(Range, { value: form.idleExpressionChance, min: 0, max: 1, step: 0.05, onChange: set('idleExpressionChance'), format: (v) => Math.round(v * 100) + '%' }),
          ),
          h(Field, { label: '空闲时触发动作概率', hint: '「说台词」那一刻顺带做一个动作的概率' },
            h(Range, { value: form.idleMotionChance, min: 0, max: 1, step: 0.05, onChange: set('idleMotionChance'), format: (v) => Math.round(v * 100) + '%' }),
          ),
          h(Field, { label: '动作间隔', hint: '多久随机触发一次动作（走动作池）。想完全不随机动作，把下面的「动作触发概率」调到 0' },
            h(Range, { value: form.randomMotionSeconds, min: 5, max: 600, step: 5, onChange: set('randomMotionSeconds'), format: (v) => v + 's' }),
          ),
          h(Field, { label: '动作触发概率', hint: '每到「动作间隔」时真的做一个动作的概率（与上面说台词那条互不影响）' },
            h(Range, { value: form.randomMotionChance, min: 0, max: 1, step: 0.05, onChange: set('randomMotionChance'), format: (v) => Math.round(v * 100) + '%' }),
          ),
          h(Field, { label: '动作持续时间', hint: '单个动作播多久。到点会收尾（Loop 动作不会自己停），保证每次都是完整的一段' },
            h(Range, { value: form.motionHoldMs, min: 600, max: 20000, step: 200, onChange: set('motionHoldMs'), format: (v) => (v / 1000).toFixed(1) + 's' }),
          ),
          h(Field, { label: '表情间隔', hint: '多久随机做一个表情（走表情池）。想完全不随机表情，把下面的「表情触发概率」调到 0' },
            h(Range, { value: form.idleExpressionSeconds, min: 3, max: 600, step: 3, onChange: set('idleExpressionSeconds'), format: (v) => v + 's' }),
          ),
          h(Field, { label: '表情触发概率', hint: '每到「表情间隔」时真的弹一个表情的概率（与上面说台词那条互不影响）' },
            h(Range, { value: form.randomExpressionChance, min: 0, max: 1, step: 0.05, onChange: set('randomExpressionChance'), format: (v) => Math.round(v * 100) + '%' }),
          ),
          h(Field, { label: '表情停留时长', hint: '随机表情做完后保持多久再恢复基础表情' },
            h(Range, { value: form.expressionHoldMs, min: 300, max: 30000, step: 100, onChange: set('expressionHoldMs'), format: (v) => (v / 1000).toFixed(1) + 's' }),
          ),
        ),

        h('div', { className: 'dsh-l2d-set__group' },
          h('div', { className: 'dsh-l2d-set__legend' }, '对话感知反应'),
          h(Field, { label: '用户发消息时反应' },
            h('label', { className: 'dsh-l2d-set__check' },
              h('input', {
                type: 'checkbox', checked: form.reactToUserMessage !== false,
                onChange: (event) => set('reactToUserMessage')(event.target.checked),
              }),
              '用户发送消息时模型做出反应（如眨眼、点头）',
            ),
          ),
          h(Field, { label: '工具调用时反应' },
            h('label', { className: 'dsh-l2d-set__check' },
              h('input', {
                type: 'checkbox', checked: form.reactToToolCall !== false,
                onChange: (event) => set('reactToToolCall')(event.target.checked),
              }),
              '工具开始/结束时模型做出反应',
            ),
          ),
          h(Field, { label: '出现选项/待确认时反应' },
            h('label', { className: 'dsh-l2d-set__check' },
              h('input', {
                type: 'checkbox', checked: form.reactToChoices !== false,
                onChange: (event) => set('reactToChoices')(event.target.checked),
              }),
              '弹出选项、请求确认等待用户选择时，模型做出疑惑/期待表情',
            ),
          ),
        ),

        h('div', { className: 'dsh-l2d-set__group' },
          h('div', { className: 'dsh-l2d-set__legend' }, '模型外观细节'),
          assets.nose
            ? h(Field, { label: '鼻子样式', hint: '当前模型有纯黑的鼻子贴块（Part46）；「柔和」会用一点淡阴影补出鼻子，跟着脸部一起动' },
              h('select', {
                value: form.noseMode || 'soft',
                onChange: (event) => set('noseMode')(event.target.value),
              },
                h('option', { value: 'soft' }, '柔和（推荐）'),
                h('option', { value: 'off' }, '不要鼻子'),
                h('option', { value: 'original' }, '模型原版黑块'),
              ),
            )
            : h('p', { className: 'dsh-l2d-set__hint' }, '当前模型没有黑色鼻子贴块，不需要鼻子修正。'),
          h(Field, { label: '动作幅度', hint: '呼吸 / 身体摇摆 / 头部微动的整体倍率，0 = 完全静止' },
            h(Range, { value: form.motionIntensity, min: 0, max: 3, step: 0.1, onChange: set('motionIntensity'), format: (v) => '×' + Number(v || 0).toFixed(1) }),
          ),
        ),

        h('div', { className: 'dsh-l2d-set__group' },
          h('div', { className: 'dsh-l2d-set__legend' }, '演出试玩'),
          h('p', { className: 'dsh-l2d-set__hint' }, '预览模型里全部 exp3 表情与 Animation 动作，点一下立即播放（不改变阶段设置）。'),
          h('div', { className: 'dsh-l2d-set__chips' },
            (assets.info && assets.info.expressions && assets.info.expressions.length
              ? assets.info.expressions.map((e) => ({ label: e.name || e.file, source: e.source }))
              : assets.expressions.map((name) => ({ label: name, source: 'decl' }))
            ).map((item, i) => h('button', {
              key: 'expr-' + item.label + '-' + i,
              type: 'button',
              className: 'chip',
              title: item.source === 'scan' ? '扫描文件夹发现的表达式' : '模型清单里声明的表达式',
              onClick: () => {
                const stage = window.__dshLive2DStage
                if (stage && stage.playExpression) { stage.playExpression(item.label); setStatus('播放表情：' + item.label) }
                else setStatus('背景层还没就绪')
              },
            }, item.label + (item.source === 'scan' ? ' ·扫描' : ''))),
          ),
          h('div', { className: 'dsh-l2d-set__chips' },
            (assets.catalog && assets.catalog.length
              ? assets.catalog
              : assets.motions.map((name) => ({ group: name, index: null, label: name || '默认动作组', source: 'decl' }))
            ).map((item, i) => h('button', {
              key: 'mot-' + item.group + '-' + (item.index == null ? i : item.index),
              type: 'button',
              className: 'chip',
              title: (item.file || item.group) + (item.source === 'scan' ? '（扫描发现）' : ''),
              onClick: () => {
                const stage = window.__dshLive2DStage
                if (!stage) { setStatus('背景层还没就绪'); return }
                if (item.index != null && stage.playMotionAt) {
                  stage.playMotionAt(item.group, item.index)
                } else if (stage.playMotion) {
                  stage.playMotion(item.group)
                }
                setStatus('播放动作：' + item.label)
              },
            }, item.label + (item.source === 'scan' ? ' ·扫描' : ''))),
          ),
          assets.expressions.length
            ? h('button', { type: 'button', onClick: () => {
              const stage = window.__dshLive2DStage
              if (stage && stage.resetExpression) { stage.resetExpression(); setStatus('已恢复基础表情') }
            } }, '恢复基础表情')
            : null,
        ),

        h('div', { className: 'dsh-l2d-set__group' },
          h('div', { className: 'dsh-l2d-set__legend' }, '空闲台词'),
          h('p', { className: 'dsh-l2d-set__hint' }, '每行一句，随机播放；留空则不在空闲时说话。'),
          h(Field, { label: '台词触发时间', hint: '空闲（没有对话、指针也不动）多久后开始说台词；同时是两句台词之间的最小间隔' },
            h(Range, { value: form.idleSeconds, min: 10, max: 600, step: 5, onChange: set('idleSeconds'), format: (v) => v + 's' }),
          ),
          h('textarea', {
            rows: 5,
            value: (form.idleLines || []).join('\n'),
            onChange: (event) => set('idleLines')(event.target.value.split('\n').map((line) => line.trim()).filter(Boolean)),
          }),
        ),

        h('div', { className: 'dsh-l2d-set__actions' },
          h('button', { type: 'button', className: 'primary', onClick: () => save() }, '保存并应用'),
          h('button', { type: 'button', onClick: () => { previewControl.dismissed = false } }, '打开实时预览'),
          h('button', { type: 'button', onClick: reset }, '恢复默认'),
          status ? h('span', { className: 'dsh-l2d-set__status' }, status) : null,
        ),
      )
    }

    // 浮动的「实时预览窗口」。
  // 设计要点（针对"挡视线 / 关不掉 / 一帧一帧"三个反馈）：
  //  1. 只在设置页真的显示时出现 —— 每 350ms 检查一次自己的设置面板
  //     `.dsh-l2d-set` 是否可见，离开设置页立即隐藏，不存在"常态挂着"。
  //  2. 有 × 关闭按钮，关掉后本次设置会话不再自动弹出（重开设置页恢复）。
  //  3. 画面走 rAF 每帧 drawImage，不再用 toDataURL 的 JPEG 缩略图，
  //     所以是实时 60fps 动态画面，和背景层看到的一致。
  var previewControl = { dismissed: false }

  // 预览窗默认尺寸/位置，存在 localStorage，用户拖过一次就记住。
  function readPreviewPrefs() {
    try {
      const raw = window.localStorage && window.localStorage.getItem('dsh-live2d-preview-prefs')
      if (raw) {
        const v = JSON.parse(raw)
        if (v && typeof v === 'object') return v
      }
    } catch { /* ignore */ }
    return {}
  }
  function writePreviewPrefs(v) {
    try {
      if (window.localStorage) window.localStorage.setItem('dsh-live2d-preview-prefs', JSON.stringify(v))
    } catch { /* ignore */ }
  }

  function PreviewWindow() {
    const prefs = readPreviewPrefs()
    const [open, setOpen] = React.useState(false)
    const [line, setLine] = React.useState('等待背景层就绪…')
    const [zoom, setZoom] = React.useState(1.6)
    const [pos, setPos] = React.useState(null)
    const [size, setSize] = React.useState({
      w: Math.max(260, Number(prefs.w) || 420),
      h: Math.max(200, Number(prefs.h) || 520),
    })
    const boxRef = React.useRef(null)
    const winRef = React.useRef(null)
    const dragging = React.useRef(null)

    // 只在设置页可见时出现
    React.useEffect(() => {
      const check = () => {
        let settingsVisible = false
        try {
          const el = document.querySelector('.dsh-l2d-set')
          settingsVisible = !!(el && el.getClientRects && el.getClientRects().length)
        } catch { /* ignore */ }
        if (!settingsVisible) {
          previewControl.dismissed = false
          setOpen(false)
          return
        }
        setOpen(!previewControl.dismissed)
      }
      check()
      const timer = setInterval(check, 350)
      return () => clearInterval(timer)
    }, [])

    // 实时画面：把背景层那块 canvas 直接搬进预览窗（零拷贝，天生 60fps）
    React.useEffect(() => {
      if (!open) return undefined
      const box = boxRef.current
      const stage = window.__dshLive2DStage
      if (box && stage && typeof stage.setPreviewHost === 'function') {
        stage.setPreviewHost(box)
      }
      // 浏览器原生 resize:both 拖动只改元素尺寸、不改我们的 state，
      // 这里把它同步回 state 并持久化，否则下一次渲染会弹回旧尺寸。
      let ro = null
      const win = winRef.current
      if (win && win instanceof Element && typeof ResizeObserver === 'function') {
        ro = new ResizeObserver(() => {
          const r = win.getBoundingClientRect()
          const w = Math.max(220, Math.round(r.width))
          const hh = Math.max(160, Math.round(r.height))
          setSize((prev) => {
            if (Math.abs(prev.w - w) < 3 && Math.abs(prev.h - hh) < 3) return prev
            writePreviewPrefs({ width: w, height: hh })
            return { w, h: hh }
          })
        })
        ro.observe(win)
      }
      return () => {
        if (ro) ro.disconnect()
        const s = window.__dshLive2DStage
        if (s && typeof s.setPreviewHost === 'function') s.setPreviewHost(null)
      }
    }, [open])

    // 状态文字 500ms 刷新一次（画面每帧刷，文字不需要那么快）
    React.useEffect(() => {
      if (!open) return undefined
      const tickLine = () => {
        const stage = window.__dshLive2DStage
        if (!stage || typeof stage.probe !== 'function') return
        // 自愈：只要画布不在预览窗里（重挂载、DOM 被重建、刚打开），就重新搬一次。
        // setPreviewBox 是幂等的，重复调用没有副作用。
        try {
          const box = boxRef.current
          if (box && typeof stage.setPreviewHost === 'function') {
            const inBox = box.querySelector('canvas')
            if (!stage.previewHosted || !inBox) stage.setPreviewHost(box)
          }
        } catch { /* ignore */ }
        try {
          const info = stage.probe()
          if (!info) return
          const motion = (info.motion && info.motion.playing) ? (info.motion.group || info.motion.idleGroup || '动作') : '循环待机'
          const exprName = typeof info.expression === 'string' ? info.expression : ''
          const expr = exprName || '基础表情'
          const stat = info.stats || {}
          if (typeof info.previewZoom === 'number') {
            setZoom((prev) => (Math.abs(prev - info.previewZoom) < 0.01 ? prev : info.previewZoom))
          }
          setLine(info.phase + ' · ' + expr + ' · ' + motion + ' · 动作×' + (stat.motions || 0) + ' 表情×' + (stat.expressions || 0))
        } catch { /* ignore */ }
      }
      tickLine()
      const timer = setInterval(tickLine, 500)
      return () => clearInterval(timer)
    }, [open])

    // 初始位置：默认贴在窗口右侧中部；用过一次就沿用上次的位置
    React.useEffect(() => {
      const place = () => {
        setPos((prev) => {
          if (prev) return prev
          const saved = readPreviewPrefs()
          if (typeof saved.left === 'number' && typeof saved.top === 'number') {
            return { left: saved.left, top: saved.top }
          }
          return {
            left: Math.max(8, Math.round(window.innerWidth - 400)),
            top: Math.max(8, Math.round((window.innerHeight - 420) / 2)),
          }
        })
      }
      place()
      window.addEventListener('resize', place)
      return () => window.removeEventListener('resize', place)
    }, [])

    const onHeaderDown = (event) => {
      try { window.getSelection().removeAllRanges() } catch { /* ignore */ }
      dragging.current = {
        x: event.clientX,
        y: event.clientY,
        left: pos ? pos.left : 0,
        top: pos ? pos.top : 0,
      }
      const onMove = (move) => {
        const d = dragging.current
        if (!d) return
        const next = {
          left: Math.max(8, Math.min(window.innerWidth - 120, d.left + move.clientX - d.x)),
          top: Math.max(8, Math.min(window.innerHeight - 40, d.top + move.clientY - d.y)),
        }
        setPos(next)
        writePreviewPrefs(Object.assign({}, readPreviewPrefs(), next))
      }
      const onUp = () => {
        dragging.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }

    // 右下角改大小交给浏览器原生 `resize: both`（见 CSS），这里只把结果同步回
    // state 并持久化 —— 见下方 [open] effect 里的 ResizeObserver。

    if (!open) return null

    const win = h('div', {
      ref: winRef,
      className: 'dsh-l2d-preview',
      style: Object.assign({}, pos, { width: size.w + 'px', height: size.h + 'px' }),
      onPointerDown: (e) => { try { e.stopPropagation() } catch { /* ignore */ } },
    },
      h('div', { className: 'dsh-l2d-preview__head', onPointerDown: onHeaderDown },
        h('span', null, 'Live2D 实时预览'),
        h('button', {
          type: 'button',
          className: 'dsh-l2d-preview__z',
          title: '预览里把模型缩小（只影响预览取景）',
          onPointerDown: (e) => { try { e.stopPropagation() } catch { /* ignore */ } },
          onClick: () => {
            const next = Math.max(0.3, Math.round((zoom / 1.25) * 100) / 100)
            setZoom(next)
            try { window.__dshLive2DStage.setPreviewZoom(next) } catch { /* ignore */ }
          },
        }, '－'),
        h('span', { className: 'dsh-l2d-preview__zoom' }, '模型 ' + zoom.toFixed(1) + '×'),
        h('button', {
          type: 'button',
          className: 'dsh-l2d-preview__z',
          title: '预览里把模型放大（只影响预览取景）',
          onPointerDown: (e) => { try { e.stopPropagation() } catch { /* ignore */ } },
          onClick: () => {
            const next = Math.min(5, Math.round((zoom * 1.25) * 100) / 100)
            setZoom(next)
            try { window.__dshLive2DStage.setPreviewZoom(next) } catch { /* ignore */ }
          },
        }, '＋'),
        h('button', {
          type: 'button',
          className: 'dsh-l2d-preview__x',
          title: '关闭预览（重新打开设置页会再出现）',
          onPointerDown: (e) => { try { e.stopPropagation() } catch { /* ignore */ } },
          onClick: () => { previewControl.dismissed = true; setOpen(false) },
        }, '× 关闭'),
      ),
      h('div', { className: 'dsh-l2d-preview__body' },
        h('div', {
          ref: boxRef,
          className: 'dsh-l2d-preview__canvas',
        }),
        h('div', { className: 'dsh-l2d-preview__grip', title: '拖这里改预览窗大小' }, '⤡'),
        h('div', { className: 'dsh-l2d-preview__line' }, line),
        h('div', { className: 'dsh-l2d-preview__hint' }, '拖标题栏移动 · 拖右下角 ⤡ 改大小 · ＋/－ 调模型大小（只影响预览）'),
      ),
    )

    // 设置页是一个带 backdrop-filter 的模态框，插件注册在 shell.overlay 里
    // 会被那个堆叠上下文困住（看起来"在下一层、被模糊"）。所以走 portal 挂到
    // document.body，配一个远高于模态框的 z-index。
    try {
      const ReactDOM = require('react-dom')
      if (ReactDOM && typeof ReactDOM.createPortal === 'function') {
        return ReactDOM.createPortal(win, document.body)
      }
    } catch { /* react-dom 不可用时退回原位置（会受设置页模糊影响） */ }
    return win
  }
  function apply(ctx) {
      postReport({ event: 'apply', phase: 'boot', build: BUILD, ua: navigator.userAgent })
      try {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-dsh-live2d-settings', '')
          style.textContent = SETTINGS_CSS
          document.head.appendChild(style)
          return () => { if (style.parentNode) style.parentNode.removeChild(style) }
        })
      } catch { /* older client contexts: styles are cosmetic only */ }
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({ name: 'shell.overlay', id: 'dsh-live2d-stage', order: 900 }, StageAnchor)
      })
      // 实时预览窗口：和设置页分开，浮在最上层（设置页会模糊/遮挡周围）
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({ name: 'shell.overlay', id: 'dsh-live2d-preview', order: 950 }, PreviewWindow)
      })
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          { name: 'settings.section', id: 'dsh-live2d-stage', order: 600, label: () => 'Live2D 背景' },
          Live2DSettings,
        )
      })
    }

    return {
      name: 'dsh-live2d-stage',
      inject: ['slots'],
      apply,
      createStage,
      normalizeConfig,
      PHASE_EXPRESSION,
      DEFAULT_CONFIG,
    }
  }

  window.__ModuleLoader__.load({ id: 'dsh-live2d-stage', factory: makeFactory })
})()
