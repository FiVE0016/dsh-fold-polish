# 实现说明（1.0）

开发前必读 [Bug 复盘与回归要求](BUG_REVIEW.md)：**引入新功能必须测试老 Bug**，不能只验收新功能或本次修复。

## 模块

- `fold.js`：设置验证、旧偏好迁移、折叠策略。默认双方 3 行，统一折叠优先于最新轮展开。
- `browser.js`：正文预览、步骤状态、全文索引、Range 定位、输入框与视口保持。
- `client-entry.js`：DSH 单文件客户端注册与独立可选功能生命周期。
- `rightbar.js`：布局 store、局部观察和可撤销的第三列宽度规则。
- `turn-timer.js`：订阅当前会话快照，聚合可靠的已结束轮耗时。
- `settings-panel.js` / `find-panel.js`：React 面板，不拥有宿主正文状态。
- `delete-panel.js`：原生对话菜单、独立确认框及删除后的列表和选择同步。
- `delete-host.js`：服务端按对话身份删除本地历史，不接受客户端文件路径。
- `scripts/build.mjs`：无依赖构建器。客户端模块从同一清单生成 registry，React 和原生控件交给宿主 resolver；服务端文件不进客户端构建。

## 正文

保留 React 拥有的原始父子关系、原始文本和组件；不得把原正文搬入自建 wrapper。折叠使用原节点的私有属性及 `hidden="until-found"`，旁边放可丢弃的呈现预览，展开即恢复原文。关闭插件和 dispose 清除自己的节点，恢复自己改过的 hidden/style。

行数来自屏幕外预览的文字 Range 矩形。媒体和块间距不参与预算，图片出现在文字前后都完整保留。文本节点在第 N 个文字行末截断，空段落被清除；`picture/source/img` 作为媒体整体保留。图片点击代理到原图节点；会创建独立上下文或不能可靠复制的组件让该消息保持原样。

预览、按钮和测量节点都有 `data-lf-owned`。正文发现、全文搜索、变更观察、图片 load 都排除这些节点，防止把预览当原文或因克隆 load 形成重建循环。内容指纹包含完整正文、宽度和字体，支持等长编辑；原图片加载、字体完成和会话列宽变动会重新测量。

使用帧内预算处理消息队列。滚轮输入期间推迟自动折叠；点击展开保留当前可见消息位置，点击收起以按钮位置补偿内容高度变化。补偿是相对视口差值，不能跳到会话顶部或尾部。

## 步骤与宿主契约

步骤内容状态与开关布局分开记录：`stepState` 控制每块内容，`turnSpread` 控制一轮开关是否摊开。多块轮次初始合并时内容也收起；双箭头先摊开开关，单箭头控制本块，第三个按钮控制全部内容，双箭头收回内容与开关。单块轮次直接切换内容。查找命中将该轮开关摊开并打开命中块，后续扫描不能再次把它收回。默认 26px 圆形图标，可选 24px 文字胶囊；正文保留带箭头的胶囊。

验证来源：本机 DSH 0.2.1-rc.2 的 `dsh-client-ui-chat`、`dsh-client-ui-conversation`、`dsh-client-ui-layout`。

- `[data-chat-flow-kind="user"]` 的 stack 先有附件，再有正文气泡；忽略附件与插件节点。
- `assistant-step` 的 AssistantMarkdown root 首个**非插件**子节点为正文。`data-turn-process-answer` 可以是真实最终回复，不能据此排除正文。
- `[data-step-process]` 只含工作步骤；主回复位于组外。内联过程成员有 `data-turn-process-member`。
- 过程成员在整轮结束时可能原地转成主回复。更新 block.items 前必须恢复离开该步骤块的旧成员，并观察所有角色属性变化。
- 自动折叠仅设置自己的隐藏标记。显式展开时只点组头/轮次摘要的原生 disclosure，不展开工具详情，也不在每次扫描重新打开用户关过的详情。
- 输入手柄插到 `[data-composer-card]` 首位，绝对定位在顶部边缘，不占 flex 布局空间。宿主 card 自带 `gap:12px`，不能在工具栏后增加占位子项，否则按钮底下会多出手柄高度及一份 gap。保持工具栏原生底部 padding；不插到 contenteditable、占位 slot 或 dock 中。
- 活动对话的 `[data-composer-seat]` 位于同一个 `[data-conversation-scroll]` 内，沿用宿主 sticky 定位。上边界按滚动容器高度减输入框实际高度计算，防止消息区暂时低估自身高度时输入框停在中间；不搬动节点、不另建滚动区。仅在原生 sticky、活动阶段且没有 composer overlay 时启用，关闭拖拽仍保留定位修复；关闭插件或卸载完整恢复。
- 手动高度保留首选值，应用时按当前滚动视口、非编辑区占用及 64px 阅读空间限高；窗口放大后恢复原值。ResizeObserver 跟踪输入框及其滚动容器，离开页面时释放；不通过轮询更新。
- 回答进行中与完成后的布局都需要验收。输入卡优先按 `data-composer-card` 发现，编辑器按 `data-composer-input` / `contenteditable` / textarea 发现，不依赖当前是否可编辑。仅在活动会话且无交互遮罩时比较输入框与本会话视口边界，超过 2px 的实际错位使用临时 fixed 定位；在原位置插入精确等高的自有预留区，保留原节点、父节点和 ChatViewport 滚动容器。
- 恢复检查必须在同一个同步布局过程仅还原固定定位属性、移除等高预留区，再测量原生位置；编辑区高度保持不变，不能拿已经 fixed 的正确位置判断原生布局已恢复。尺寸、定位属性只在值变化时写入，原值仅在退出相关功能或清理时恢复。输入框模块不监听普通滚动、不写 `scrollTop`；不得通过临时缩短滚动范围或写回位置干扰宿主阅读状态。遮罩、非活动阶段、停用、卸载均撤销恢复并清理预留区和观察器。

## 查找

索引原正文与步骤的 text nodes，排除自己的控件与预览。每个匹配保留真实节点、字符偏移和稳定 handle，不只记整个消息。揭示时展开插件块及原生隐藏祖先，在宿主更新后用 Range 定位，并用 CSS Highlights 标出命中。没有全局快捷键和轮询。

## 删除本地对话

`sidebar.workspaces.session.menu.item` 提供原生菜单项，`shell.overlay` 独立持有确认框。确认前不发删除请求；确认后通过已有 connection RPC 载体调用 `foldPolish/deleteConversation`，参数只有对话 ID。服务端仅接受 owner 调用，并在后端重新检查任务、会话占用和持久化格式。禁止接收客户端文件路径或递归删除工作目录。

删除模块按本机 DSH 0.2.1-rc.2 的 JSONL、Cordis、会话和缓存契约核对。宿主没有公开的完整删除 API；关闭已打开对话需要精确匹配该轮生命周期的 effect，无法确认时拒绝删除。格式或宿主契约变更后应先重新验收，不能放宽校验强行删除。服务端相关依赖采用独立注入，不能让删除能力缺失影响显示功能。

只处理独立目录中的 canonical session generation 文件，未知文件、附件、工作目录和子对话保持原样。删除使用 prepared/committed 日志：提交前失败回滚记录和目标归属；提交后清理失败保留恢复标记并向界面返回 `cleanupPending`。重新加载时处理该模块自己的未完成操作。测试只使用临时生成的记录，不连接真实会话删除接口。

## 宿主与计时

根插件没有硬服务依赖，各独立功能由 Cordis `ctx.inject` 跟踪服务出现/消失；`ctx.get` 读取服务。所有可选功能安装失败均局部降级，不能让立即启动的客户端行抛错。

`uiConversation.binding(sessionId).target('chat')` 有 `subscribe`。读取当前 DOM 会话的 `timeline.turns` 与 `legacy.nodes`；只有 closed 轮次聚合最早 `stepStartTime` 到最后 `completedTime`。不能把一个工具步骤结算当整轮完成，也不能从会话目录猜一个历史 session。订阅在会话切换/插件停用时释放。

右栏只定位 `[data-rightbar-col]` 的 AppFrame。规则带 collapsed/fullscreen 排除条件，关栏后立即无效。布局订阅和局部观察处理重挂载；不使用整页定时扫描。禁用/dispose 撤销规则并恢复原宿主宽度。

## 验证

先 `npm run build`，再 `npm test`、`npm run test:browser`。`client.js` 是宿主加载的文件，改 src 后必须同步。构建会验证输出可解析，Node 测试还检查实际 bundle registry 与启动隔离。

浏览器测试执行实际控制器，覆盖默认值、真实行数、图片布局、滚轮、长文末尾收起、步骤角色转换、搜索 Range、等长更新、输入框拖拽、右栏回弹、耗时唯一、空闲稳定性及 dispose。旧版复制测量函数和大量 fake DOM 几何断言已替换；旧版诊断 API 不作为 1.0 接口。

控制台保留 `window.__DSH_FOLD_POLISH__`（同 `__DSH_BUBBLE_FOLD__`），提供 settings/update/search/revealAt/composer/rightbar/turnTimer/rescan/dispose。
