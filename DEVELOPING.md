# 开发与实现笔记

面向要改这个插件的人。**功能说明请看 [README.md](README.md)**，这里只放实现细节、兼容性、开发流程与踩过的坑。

## 先读这条：启动安全（踩过一次大坑）

这个插件的客户端行是 `dsh.client.immediately: true` —— **它属于启动图，`apply()` 抛错会让整个 DSH 起不来**，用户看到的是崩溃对话框：

```
web boot: 1 entry did not activate
dsh-fold-polish: failed
```

诊断日志：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-<时间>-web-boot.log`。

已经踩过的两次：

1. **受限 ctx 只用 `ctx.get(name)`**。属性访问未声明的服务（例如 `ctx.sidebarRightTabs`）会**直接抛错**，不是返回 `undefined`。查服务一律 `try { ctx.get(name) } catch { null }`。
2. **`apply` 已包一层外层 try/catch**（`apply` → `plugin.applyRow`），任何异常都只降级停用插件，不再拖垮应用。别把这层删了。

铁律：**改完 `src/client-entry.js` 必须先跑 `node test/entry.test.mjs` 与 `node test/runtime.test.mjs` 通过，再让用户重启**（`test/entry.test.mjs` 里有一条"敌意 ctx"用例专门守这条线）。

## 折叠控件挂在哪儿、由谁来折

每条**折叠的**消息下方一个气泡胶囊键；每一段工作步骤一个折叠缝。

| 位置 | 控件 | 作用范围 |
|---|---|---|
| 每条折叠的消息下方 | 气泡胶囊（`▾ 展开我的输入 · 还有 12 行` / `▾ 展开全文 · 还有 30 行`，展开后变 `▴ 收起`） | 只这一条消息 |
| 工作步骤与后面那条回复之间 | 一条横线上的圆形键（单箭头图标） | 这一段里的全部工作步骤 |
| **同一轮最后一条缝**（主按钮，默认每轮只有它） | 双箭头键（`展开全部` / `收起全部`） | 这一轮的**缝**（版面）：展开全部 = 摊开各条缝、内容仍收起；收起全部 = 内容全收 + 回到只剩这一个按钮 |
| **同一轮最后一条缝**（仅摊开时出现） | 箭头+横线键（`展开所有步骤` / `收起所有步骤`） | 这一轮**所有段的内容**，缝的数量不动 |

三个控件一个几何、一层视觉：文字关掉时各自是一个 26px 圆形图标键（三个图标不同，不看文字也能区分）；文字打开时按钮本身变成胶囊、内层图标去掉边框/背景/阴影（`[data-lf-text="1"] [data-lf-icon]`），所以不会出现"胶囊里套圆圈"。

"缝"是插件插入的**一条线**（`[data-lf-step-line]`：两侧细线 + 线上的控件）。线上的单箭头键（`[data-lf-step-toggle]`）管自己那一段；只有一轮的**最后一条缝**才携带主按钮（`[data-lf-step-all]`）与"所有步骤"键（`[data-lf-step-every]`）。状态是会话级的：

- `mergedTurns` = 状态 0（只留一个按钮）：同步时对该轮的块强制保持折叠（宿主重渲染把开关复位也会折回），并隐藏除最后一条外的所有缝与它自己的单箭头；
- 摊开（状态 1/2）：主按钮变成 `收起全部`，"所有步骤"键按 `info.openCount === info.count` 在 `展开所有步骤` / `收起所有步骤` 之间切换；
- 单块轮次没有"摊开"可言：它的主按钮直接等于那一段自己的开关（文案 `展开全部` / `收起全部`，点击即开合）。
- 点过的块记进"读者手动操作过"集合，自动折叠不会再碰它。

工作步骤由谁来折，取决于宿主当前的工作详情模式 —— 两种都由同一个折叠缝驱动：

| 宿主渲染方式 | 折叠缝做什么 |
|---|---|
| **分组模式**（工作详情 compact / standard，以及 detailed 的已结束轮） | 步骤被包在 `[data-step-process]` 容器里，容器自带标题开关。折叠缝点击宿主自己的开关（以及各轮的 `[data-turn-process]` 摘要行），状态完全归宿主，连它自己的标题箭头都同步 |
| **内联模式**（工作详情 verbose，宿主不提供开关） | 宿主的摘要行是 `disabled`、步骤全部展开。此时折叠缝自己把这串行折起来：在这些行上打私有属性 `data-lf-step-folded` **并设 `hidden="until-found"`**（纯显示层，插件一关或卸载，行立刻全部回来）。用 until-found 而不是 `display: none` 是为了让浏览器搜索够得着：命中时会触发 `beforematch`，插件据此把整段打开 |

搜索的两条路径：

- **折叠的消息正文**：限高盒是 `overflow-y: auto`（滚动条隐藏）。浏览器揭示搜索结果的方式就是滚动它所在的滚动容器，所以插件在正文的 `scroll` 事件里直接把这条消息展开——`scrollTop > 0` 只可能来自"有人想读被折掉的部分"。
- **折叠的步骤**：`hidden="until-found"` / 宿主自己的 `content-visibility: hidden` 都会被浏览器搜索命中（`display: none` 不会）。`beforematch` 处理器按块边界找到那一行所属的整段，走宿主开关或清掉插件自己的标记，并把它记入"读者手动操作过"集合，避免自动折叠立刻把它折回去。

折叠缝上的箭头与提示跟随当前状态切换；**读者手动点开过的那一段不会再被自动收起**（自动折叠只在某段第一次出现时发生一次）。

## 宿主设置页

插件注册一个 `settings.plugins.tab` 贡献（`id: "bubble-fold", order: 20, label: "UI 美化"`）：在 **设置 → 插件** 页与内置"全部"tab 并列。宿主只画 tab 条与外壳，页面内容由 `src/settings-panel.js` 的 React 组件（纯 `createElement`，无 JSX）绘制；组件通过注册项的 `inject: () => ({ api })` 拿到 `{ settings(), update(patch), subscribe(fn) }`，与 DOM 层控制器写通。控制器 `subscribe` 是浮层面板与设置页双向同步的通道。`apply(ctx)` 里若 `ctx.slots` 缺失（旧宿主）则整体跳过注册，折叠功能不受影响；`inject: ['slots']` 是为此新增的唯一依赖声明。面板样式在插件自己的样式表里，且**不套 `[data-dsh-fold-polish]` 作用域**——插件被自己的开关关掉时，设置页仍要能正常显示并把它开回来。

## 右侧栏「查找」

查找是**右侧栏的一个 tab**（与宿主自带的"上下文""文件"同列），而不是左侧栏面板或浮动条。tab 由三处注册组成，**共用同一个 id**（`bubble-fold-find`），这正是宿主自带面板（`dsh-context`、`ui-schedule`）的形态：

| 注册 | 座位 | 作用 |
|---|---|---|
| tab 类型 | `ctx.sidebarRightTabs.register({ id, kind: id, title })` | 让右栏知道存在这个 tab（`title` 传函数以便跟随语言） |
| 面板体 | `slots.register({ name: 'sidebar.right.pane.tab', key: id, inject: () => ({ api }) }, Panel)` | 按 id 分派的 tab 内容 |
| 标题 chip | `slots.register({ name: 'sidebar.right.pane.tab.title', key: id }, Title)` | tab 条上的文字 |

打开方式：用户在右栏 tab 列表里点开（2026-10-13 起不再有 `Ctrl + F` 键盘入口——插件不注册任何全局快捷键）。真浏览器里折叠内容通过 until-found 对原生查找可见。搜索与揭示逻辑在 DOM 层（`controller.search` / `controller.revealAt`），面板只是它的 React 外壳。

## 右侧栏宽度（怎么设、怎么读、为什么这么绕）

设置项 `rightbarRatio`（30–70%，默认 45%）。这条链路绕，是因为宿主的宽度语义和它公开的接口都不直观——**下面每一条都是在真机上验证/被坑出来的**：

| 事情 | 结论 |
|---|---|
| `ctx.layout` 是什么 | 一个 `LayoutController` 实例，字段只有 `panels` / `hasMainPanel` / `panelInfo` / `navigation`。**没有** `layoutInfo`，**没有** `layout.setRightbar` |
| 设宽度 | `layout.panels.setRightbar(px)`（`panels` 是 store 的**已绑定** actions）。**必须先** `layout.panels.setViewportWidth(真实帧宽)`：store 启动时 `viewportWidth` 可能是 0，它按自己的值钳位 → `clampWidth(px, 300, max(300, 0))` 恒等于 300，写进去以后宿主的 45% 默认值也不会再补（`rightbar ??=` 只在 null 时生效） |
| 为什么设了还是不变宽 | 宿主把右栏那一列写成 **`minmax(0px, max)`**，格子按**内容**定宽：往里传再大的"最大值"也撑不宽面板 |
| 真正的办法 | 插件自己写一条带 `!important` 的样式规则把第三列钉到目标像素（另外两列从宿主内联样式原样复制）。内联样式打不过 `!important`，于是宽度归我们；折叠（`data-rightbar-collapsed`）与全屏（`data-rightbar-fullscreen`）是呈现状态，检测到就撤规则 |
| 怎么读宽度 | 服务没有 getter。AppFrame 是**唯一**被写了**内联** `grid-template-columns` 的元素（按这个特征定位），宽度取内联里最后一个 `minmax(0px, Npx)` 的 N——宿主自己的原始意图。从子元素往上找"第一个 grid"会命中内部 grid，读到无关数字（这条坑了一整轮） |
| 收起 / 全屏 / 第三列为 0 | **必须撤掉规则**：否则宿主关闭右栏后，那一列仍被 `!important` 占着，会话区卡在半宽。重新打开时再按设置恢复；插件总开关关闭时同样撤掉 |
| 拖动怎么联动 | 宿主拖手柄时会用**它自己的数字**重渲染内联 grid。我们把该数字与"刚写进去的值"比较：不同、且不在刚应用后的 800ms 内 → 采纳为新占比并重写规则。这个 800ms 门闩是必需的，否则我们自己的应用会被当成拖动、把设置改写成测量值（也坑过一轮） |

自检：`rightbar()` 同时给出 `ratio`（宿主意图）与 `renderedRatio`（实际渲染），两者的差值就能指出"是没设进去"还是"被别的样式压过"。

## 输入框高度

宿主把输入区限制在 `--dsh-composer-text-max-height`（默认 336px），超出后内部滚动。

- 0.6.x 只抬高这个上限：内容短的时候，拖拽看不出任何变化（这就是"调节器不起作用"的原因）。
- 0.7.0 起插件在输入框卡片顶部加一条拖拽手柄，手动模式会同时**钉住输入区的实际高度**，所以拖拽跟手。
- 0.8.0 修正方向（手柄在顶边：向上=拉高）。

高度存在 `dsh.bubble-fold.composer-height`，重启后保留。手柄是卡片里的普通 flex 元素（`order: -1` 固定在最上），不是浮动覆盖层，不会挡住输入框或发送按钮。宿主的引导弹窗（预览版说明 / 添加 API Key）是 `aria-modal` 全屏遮罩，打开时会挡住弹窗下方的一切（包括手柄）—— 这是宿主行为，关掉弹窗即可。

输出宽度用宿主自带的左右拖拽手柄，本插件不提供宽度功能。

## 控制台 API

```js
__DSH_BUBBLE_FOLD__.settings()               // 看当前设置
__DSH_BUBBLE_FOLD__.update({ userLines: 3 }) // 改一项
__DSH_BUBBLE_FOLD__.rescan()                 // 强制重扫
__DSH_BUBBLE_FOLD__.stats()                  // 性能计数器（见下）
__DSH_BUBBLE_FOLD__.dispose()                // 临时停用并还原 DOM
__DSH_BUBBLE_FOLD__.status                   // 'running' | 'failed'
// 右栏宽度与输入框高度这两个"跟宿主纠缠"的功能各带自检：
__DSH_BUBBLE_FOLD__.rightbar()               // { supported, ratio, renderedRatio, viewport }
__DSH_BUBBLE_FOLD__.layoutDebug()            // layout 服务的真实形状（keys / panels / setRightbar 类型）
__DSH_BUBBLE_FOLD__.layoutTry(60)            // 真机实验：普查所有三列 grid，调一次 setRightbar，再普查一遍
__DSH_BUBBLE_FOLD__.dragLog()                // 最近几次输入框拖拽：基准值/来源/applied/一帧后实测
__DSH_BUBBLE_FOLD__.composer()               // { min, max, value, fallback, manual }
```

`test/diagnose.js` 是一段可直接贴进页面控制台的自检片段，会打印宿主的步骤布局、容器/成员行数量与插件状态，排查"为什么不折"时先跑它。

### 浏览器环境怎么测

`test/browser-check.mjs` 是**浏览器验收检查**：它对一个正在运行的 `dsh --profile web` 界面开无头 Chrome，验证只有真浏览器才能证明的事——插件从**已安装的包**里跑起来（不是源码）、真实会话能折叠、`Ctrl+F` 交还给浏览器原生查找、打印媒体下内容完整、以及右栏收起时**没有**被 `!important` 规则占着那一列。

```sh
dsh --profile web                     # 打印 http://127.0.0.1:<port>/?token=...
node test/browser-check.mjs "http://127.0.0.1:3080/?token=..."
```

会话为空时它会明确 SKIP 掉折叠相关的项并提示你先打开一个有内容的会话。它不是 CI 的一部分（需要真实应用在跑）。

`test/live-probe.mjs` 会开一个无头 Chrome 连上**正在运行**的界面并自动跑上面这些自检（`node test/live-probe.mjs`）。注意 `dsh web` 需要 URL 里的令牌，缺令牌时它只能看到鉴权页。

## 性能：为什么它必须"懒惰"

长会话可以有 1000+ 个 flow item。这条链路里每一步都很贵：读 `scrollHeight` 会触发**强制同步重排**，而写属性会触发插件自己的 MutationObserver。

`__DSH_BUBBLE_FOLD__.stats()` 会告诉你实情：

| 字段 | 含义 | 健康表现 |
|---|---|---|
| `scans` | 扫描次数 | 空闲时应停止增长 —— 持续增长就是自我喂养的循环 |
| `measured` | 本轮真正做过布局测量的行数 | 应远小于总会话行数 |
| `selfMutations` | 由插件自己节点触发的变更 | 一次折叠后应停止增长 |

为此有三道闸门，删任何一个都会让界面变卡：

1. **写入幂等** —— 值没变就不碰 DOM，否则自己的写入会触发自己再扫一次，形成 60fps 永不停止的循环
2. **视口闸门** —— 只处理屏幕附近（上下各一屏）的消息与步骤段；滚入视口时再折
3. **每帧 4ms 预算**（`SCAN_BUDGET_MS`）—— 超时就 `requestAnimationFrame` 续做，绝不在一帧里处理上千行

实测（真实 Chrome，1200 条消息的会话）：空闲 4 秒 0 次扫描；强制扫描一次 2.1ms，只测 28 行。

## 实现方式与它的代价

纯客户端插件（`index.js` 是无副作用的空壳，只为让 bundle 被加载）。折叠靠两条东西：

1. **宿主 DOM 契约属性**：`data-chat-flow-kind="user" | "assistant-step" | "turn-process"`、`data-chat-anchor-key`、`data-chat-turn`、`data-streaming`、`data-turn-process*`、`data-step-process*` 等，加结构下钻找正文/步骤本体。**不依赖 CSS Module 的哈希类名**，宿主换皮不会失效。
2. **只动样式与自有节点**：限高走 `max-height` 变量 + 私有属性选择器；注入的控件挂在 React 托管范围之外，React 重渲染时不参与 diff（位置在每次扫描时幂等校正）。

⚠️ 诚实说明代价：这仍是一条 DOM 契约路线。DSH 升级若改了上面那些 `data-*` 的含义，折叠会失效 —— 但失效方式是"不折了"，而不是弄坏会话：设置里关掉插件或直接卸载，DOM 立刻回到原生状态。这也是没有 fork 宿主渲染器的原因（那样更彻底，但每次宿主升级都要重新适配）。

## 兼容性

- 宿主：`@deepseek-ai/dsh` 0.2.0-rc.2（契约按这个版本核对，见 `src/browser.js` 顶部注释）
- 与 DSH 原生「工作步骤展示」、过程折叠、右缘 TurnNavigator 互不干扰（不同 DOM 区域）
- 与 `dsh-thought-fold` 同时装没有冲突（它折过程包封，本插件显式跳过包封内部）

### `dsh.client.immediately` 不能删

`package.json` 里这一行是**必需**的：

```json
"dsh": { "client": { "platform": "web", "immediately": true, "inject": [] } }
```

客户端 bundle 走宿主的启动图（`window.__DSH_BOOT__`），而只有被标记 `immediately` 的行、或被其他模块请求的行才会被执行。本插件是纯 DOM 插件，不向任何 slot 注册组件，因此没有任何东西会"请求"它 —— 去掉 `immediately` 后 bundle 仍会被投递但永不执行，表现就是控制台里 `__DSH_BUBBLE_FOLD__` 为 `undefined`、界面上什么都不发生（0.1.0 正是这样失败的）。

`inject` 留空同样是故意的：列 UI 模块只为排序激活，本插件不依赖任何客户端服务。

## 结构

```
index.js                  宿主侧空壳（注入服务为空，无副作用）
client.js                 构建产物：浏览器半，由宿主模块加载器投递
cordis.patch.yml          bundle 补丁：把 bubble-fold 行插进平台树
src/fold.js               纯逻辑（设置归一化、限高计算、折叠判定）—— 可在 plain Node 下测
src/browser.js            DOM 运行时（扫描、包裹、控件、设置面板、快捷键、输入框手柄）
src/client-entry.js       ModuleLoader 入口 + 宿主集成（设置页 tab、右栏查找 tab、右栏宽度）
src/settings-panel.js     宿主设置页的 React 组件（与浮层面板一一对应）
src/find-panel.js         右栏「查找」tab 的 React 组件
scripts/build.mjs         把上面这些文件打包成单文件 client.js
tools/make-demo-gif.py    用 Pillow 把两张截图合成 README 用的 demo.gif
test/fold.test.mjs        纯逻辑单测（21 项）
test/runtime.test.mjs     运行时、交互与真实 client.js 构建产物的加载测试（101 项）
test/entry.test.mjs       入口契约：注册、右栏宽度、敌意 ctx 不崩（15 项）
test/visual-fixture.html  宿主样式的可视化夹具（两轮对话 / 步骤串 / 两种步骤布局）
test/visual-check.mjs     真实 Chrome 里跑夹具：折叠状态、几何、点击行为 + 生成 assets/ 截图
test/live-probe.mjs       连正在运行的界面跑自检（需要 dsh web 的令牌）
test/diagnose.js          排查用：贴进页面控制台，打印宿主模式与插件状态
assets/                   README 里的截图与 demo.gif（截图由 test/visual-check.mjs 生成）
.github/workflows/test.yml CI：构建同步检查 + 三套测试（不需要浏览器与网络）
```

## 开发

```sh
node scripts/build.mjs            # 重新打包 client.js
node scripts/build.mjs --check    # 检查 client.js 是否与源码同步
node test/fold.test.mjs           # 纯逻辑
node test/runtime.test.mjs        # DOM 与交互（不需要浏览器）
node test/visual-check.mjs        # 真实 Chrome 渲染检查（需要本机 Chrome，同时刷新 assets/ 截图）
```

改完 `src/` 必须重新构建：宿主加载的是 `client.js`，不是 `src/`。**提交前把 `client.js` 一并提交** —— 它才是真正跑起来的东西，CI 会检查它与源码是否同步。

### 三个已经踩过的坑

1. **`index.js` 必须能被 `import()` 解析。** 它是 ESM 入口，宿主用裸 `import()` 加载。0.1.0–0.1.3 在这里失败过：文件开头写成了 Python 风格的 `#` 注释 —— 第一行被 Node 当成 shebang 跳过，第三行直接是语法错误，于是宿主报 `bubble-fold (dsh-fold-polish): failed to import`，宿主半不存在 → 客户端 bundle 也就永远不会被执行。改完务必跑一次导入自检：

   ```sh
   node -e "import('./index.js').then(m=>console.log('OK',Object.keys(m)))"
   ```

2. **`factory` 不能声明 `require` 参数。** 宿主这样调用 bundle：

   ```js
   registration.factory(specifier => { /* 只认 react 等平台模块，其余全部抛错 */ })
   ```

   `build.mjs` 在 IIFE 作用域上提供了自己的 `require`（先查本地模块表，兜不住才落到宿主）。一旦写成 `factory: (require) => {…}`，这个参数会遮蔽包内的 `require`，于是 `require('./src/browser.js')` 跑到宿主模块表里去要，直接炸：

   ```
   dsh-fold-polish: import failed: client-modules: require("./src/browser.js") missed the module table
   ```

   桌面端会把它显示成「应用无法启动」对话框（0.1.5 的现象）。正确写法是 `factory: () => {…}`。`test/runtime.test.mjs` 用**只认 `react` 的严格替身**调用 factory，这类遮蔽会被测试直接抓住。

3. **别用 PowerShell 的 `Set-Content -Encoding UTF8` 改 `package.json` / `client.js`。** Windows PowerShell 5.1 会写入 BOM，Node 的 `JSON.parse` 直接报 `Unexpected token '\uFEFF'`。用 Node 脚本改：

   ```sh
   node -e "const fs=require('fs');fs.writeFileSync('package.json', fs.readFileSync('package.json','utf8'))"
   ```
