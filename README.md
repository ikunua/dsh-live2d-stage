# dsh-live2d-stage

把一个 **Cubism 3/4 Live2D 模型**渲染成 DeepSeek Harness Web GUI 的**背景层**：模型固定在对
话界面之后、`pointer-events: none`，不遮挡消息 / 输入框 / 按钮；视线跟随鼠标，随会话阶段切换
表情，空闲时从「表情库 / 动作库」里随机演出。

![Live2D](https://img.shields.io/badge/Live2D-Cubism%203%2F4-4d6bfe)
![PixiJS](https://img.shields.io/badge/pixi-6.5.10-ff69b4)

> 📖 **完整说明书见 [说明书.txt](说明书.txt)** —— 含全部设置项（键名 / 默认值 / 范围）、
> 阶段与优先级、演出池机制、模型兼容性、故障排查、文件结构与发布流程。
> 本 README 只做概览。

## 已实现

| 能力 | 说明 |
| --- | --- |
| 背景层 | `position: fixed` + `z-index: -2`，挂在 `document.body`；画布透明、随窗口自适应、默认穿透鼠标 |
| 模型自适应 | 读取 `*.model3.json` 时**就地补全**：扫描同目录（含一层子目录）里未声明进清单的 `*.exp3.json` / `*.motion3.json`，并读 `*.vtube.json` 热键取友好名（只改内存，不动用户文件） |
| 能力识别 | 设置页「模型能力（自动识别）」列出格式 / 贴图数 / 物理 / 表情数 / 动作组 / 命中区域 / 眨眼口型参数，扫描补全的项带 `·扫描` 标记 |
| 待机组自动 | 自动挑真正的待机循环（`Idle/idle/待机/loop/scene…`）；空字符串组（如 z46 把 14 个动作塞在 `""`）自动别名到 `__idle__`；也可在设置里手动指定 |
| 视线跟随 | 绝对写入 `ParamAngleX/Y`、`ParamEyeBallX/Y`（基准 + 偏移并按上下限钳制，不会累积漂移）；失焦缓动回正 |
| 两级演出 | **高层级**：提问 / 刚输入 / 刚输出 三个场景表情，优先级最高；**低层级**：常态下从表情库、动作库各自随机抽取播放，表情与动作各有独立总开关 |
| 演出时长 | 表情停留时长、动作持续时间都**由渲染 tick 按墙钟推进**（不用 `setTimeout`，窗口后台 / 被节流时同样准点收尾）；表情到期恢复走"停队列→回写基线→贴基础表情"单次原子序列，且**跳过视线/摇摆参数**，不会让头/身体瞬跳（修复"闪动"） |
| 身体跟随 | 鼠标左右 / 上下移动时胸腔、胯骨、肩膀跟着转向（可关，动作会主动让位给跟随感） |
| 实时预览窗 | 打开设置页时在 `document.body` 顶层 portal 出一个小窗（设置页是带 `backdrop-filter` 的模态，会模糊遮挡）：与背景层**同一块画布零拷贝**、真 60fps，可拖动、可改大小、可调模型取景缩放 |
| 黑鼻子修正 | 按 `cdi3.json` 的**部件名**（鼻 / nose）+ UV 主体亮度判定，只隐藏真正是纯黑贴块的部件（不写死 `Part46`），补一张柔和径向贴片跟随脸部 |
| 对话反应 | 用户发消息 / 工具开始结束 / 出现选项时做身体脉冲（点头 / 歪头），任何模型都有效，再叠加场景表情 |
| 设置页 | 分组见下；改完 **400ms 自动保存并应用**（SSE 推送），也保留「保存并应用」按钮；操作条吸底不随滚动消失 |
| 稳定性 | 表情名缺失回退参数快照并告警，绝不写入无效表情；模型加载失败只提示不清 UI；切模型 / 换组时清理 SDK 残留预约，避免动作定住 |

## 设置页分组

```
模型            选择 / 扫描 / 站内 URL / 本地 model3.json 绝对路径
模型能力        自动识别结果 + 重新识别
位置与尺寸      锚点 / 缩放 / 屏高占比 / 水平垂直偏移
外观            不透明度 / 暗角遮罩 / 层级 / 透明界面 / 预览里的模型大小
行为            视线跟随 + 头部眼球幅度 + 平滑度 + 身体转向 + 台词气泡时长
① 对话表情      刚输入 / 刚输出 / 提问（高层级，优先级最高）
② 常态演出池    表情/动作总开关 + 表情库 / 动作库（勾选进组，空 = 全部可用项）
② 常态演出节奏  待机循环开关 / 触发概率 / 间隔 / 表情停留时长 / 动作持续时间
对话感知反应    用户发消息 / 工具调用 / 出现选项 时是否反应
模型外观细节    鼻子样式（仅检测到黑贴块时出现）/ 动作幅度
演出试玩        逐个点表情 / 动作立即预览
空闲台词        每行一句，随机播放
```

## 使用

安装后无需重启客户端：桌面端会热加载 Host 半与 Client 半。

1. **打开设置**：左下角账户 / 设置 → 左侧导航「Live2D 背景」。
2. **换模型**：把整个模型目录（含 `.model3.json`、`.moc3`、贴图）放进
   `%USERPROFILE%\.dsh\live2d-stage\models\`，点「重新扫描」后在下拉框选择；也可直接填
   主机绝对路径或站内 / HTTP 模型 URL。
   > 模型 URL 建议用**站内路径**（`/dsh-live2d-stage/models/...`）。填绝对 `http://127.0.0.1:<port>/...`
   > 会因桌面端端口每次变化而报 `Network error.`。
3. **调位置 / 外观 / 行为**：锚点、缩放、屏高占比、偏移、不透明度、暗角、层级（必须 < 0）、
   视线与身体跟随幅度。
4. **配两级演出**：
   - 「① 对话表情」给提问 / 刚输入 / 刚输出各选一个表情；
   - 「② 常态演出池」勾选想随机播放的表情和动作（不勾 = 全部可用项）；
   - 「② 常态演出节奏」调触发概率、间隔、表情停留时长、动作持续时间。
5. **实时预览**：进入设置页时右侧自动弹出预览小窗（拖标题栏移动、拖右下角 `⤡` 改大小、
   `－ / ＋` 调取景缩放，都会记住）；离开设置页自动隐藏。
6. 修改即自动保存，写入 `%USERPROFILE%\.dsh\live2d-stage\settings.json` 并通过 SSE 推给页面，
   模型 / 位置 / 演出立即生效，无需刷新。

## 架构

```
Host (index.js)                              Client (client.js)
├─ agent/status        → thinking/success     ├─ shell.overlay：StageAnchor（图层 + 气泡 + 报错）
├─ tools/pre-execute   → tool                 ├─ shell.overlay：PreviewWindow（portal 到 body）
├─ tools/result        → error (held)         ├─ settings.section「Live2D 背景」
├─ approval/request    → waiting              ├─ SSE /events 接收 phase / config / model-react
├─ agent/error         → error (held)         ├─ 渲染 tick 驱动：调度器 + 表情/动作占用期收尾
├─ session/event       → model-react          └─ pixi-live2d-display 渲染
└─ 清单就地补全 + /api/settings、/models、/assets
```

槽位本身无法位于对话列之后（`shell.overlay` 处于 `z-index: 20` 的层叠上下文），所以真正的背景
元素是 body 级单个固定 `div`；React 侧只在 `shell.overlay` 注册生命周期锚点。预览窗反过来必须
**跳出**这个上下文（portal 到 `document.body` + 超高 `z-index`），否则会被设置页模态的
`backdrop-filter` 压在下一层并糊掉。这是对「不挂全局 DOM」的一处必要偏离，卸载时完整移除。

应用框架与侧栏通过 `body[data-dsh-live2d]` 把 `--dsw-alias-bg-base`、
`--dsw-specific-sidebar-fill` 置为透明来露出模型；气泡和面板仍用各自不透明的
`--dsw-alias-bg-layer-*`，保证可读性。

## 接口

| 路由 | 用途 |
| --- | --- |
| `GET /dsh-live2d-stage/events` | SSE：`hello`（phase + config）、`state`、`config`、`model-react` |
| `GET/POST /dsh-live2d-stage/api/settings` | 读取 / 保存设置（POST JSON，≤32KB，未知键丢弃、值全部钳制） |
| `GET /dsh-live2d-stage/api/state` | 当前 phase、config、诊断 reports |
| `POST /dsh-live2d-stage/api/report` | 页面侧诊断上报（ready / error / alive / dom-report / model-info） |
| `GET /dsh-live2d-stage/assets/*` | 内置 vendor（pixi 6.5.10、pixi-live2d-display 0.4.0、Cubism Core）与示例模型 |
| `GET /dsh-live2d-stage/models/*` | `~/.dsh/live2d-stage/models` 下的用户模型 |
| `GET /dsh-live2d-stage/model/*` | `modelPath` 所在目录（只读） |

## 排错

- **看不到模型**：确认「透明界面」开启；`zIndex` 必须在 -10 ~ 0；加载结果看
  `/api/state` 的 `reports.ready` / `reports.error`。桌面端 WebGL 画布用系统截屏抓不到，
  可用设置页旁的实时预览窗或 `reports.snapshot` 判断。
- **表情不生效**：模型要有对应 `.exp3.json`（能力面板会显示数量）。没表情文件的模型只会用
  动作与参数回退。
- **动作闪一下就没了**：调大「动作持续时间」；演出动作在 hold 期间不会被待机循环顶掉。
- **动作只在空闲出现**：这是设计——思考 / 工具执行 / 等待期间不放动作，只保留呼吸、视线、微动。
- **设置页空白**：多为 React Hook 顺序问题（Hook 写在提前 return 之后）。本仓库带
  `checkhooks` 静态检查；应用侧可用 `reports['dom-report'].settings` 判断是否真的渲染出来。
- **画面发暗**：降低「暗角遮罩」。**卡顿**：降低缩放 / 屏高占比；页面隐藏时本来就会停帧。

## 许可

插件代码 MIT（见 `LICENSE`）。`assets/model/Natori` 与 `assets/vendor/live2dcubismcore.min.js`
来自 Live2D 官方 Cubism Web Samples / Cubism SDK，遵循其各自许可（Live2D Proprietary Software
License），仅作示例；分发前请替换为你拥有授权的模型与 Core。
