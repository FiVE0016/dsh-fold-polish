# Harness 契约与 0.2.1-rc.5 实测记录

本插件的显示层直接读宿主的 DOM 标记与插槽名。这些名字没有版本号，宿主升级时可能被悄悄改掉，对应功能就会**静默消失**（不报错、不崩溃，只是按钮没了）。这份文档记录 2026-10-31 在 **0.2.1-rc.5** 上的核对结果，供下次升级时对照。

## 一、当前核对结果

- 宿主版本：`0.2.1-rc.5`（`@deepseek-ai/dsh-desktop-runtime`）
- 安装包：`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar`，2026-10-29 22:02，182.8 MB
- 结果：**39 项契约全部存在**，未触发任何缺失告警。

复现命令：

```powershell
npm run compat
```

脚本会打印每项契约的命中次数与相对基线的变化。基线在 `docs/host-contract-baseline.json`；换机器或换版本后可用 `node scripts/check-host-compat.mjs --baseline` 重新记录。

> 说明：`sessions`、`agents`、`layout`、`slots`、`connection` 这类通用词在安装包里出现几千次，**数量本身没有判别力**，只有「变成 0」才说明契约消失。真正可靠的是第三节的浏览器实测。

## 二、关键契约与对应功能

| 契约 | 功能 | rc.5 命中 |
| --- | --- | --- |
| `sidebarRightTabs` / `sidebar.right.pane.tab` | 查找页签 | 35 / 50 |
| `uiConversation` | 每轮耗时 | 120 |
| `layout` + `data-rightbar-col` + `layout.panels.setRightbar` | 右栏宽度 | 1 |
| `data-rightbar-collapsed` / `data-rightbar-fullscreen` / `data-dragging` | 右栏关栏、全屏、拖动 | 1 / 3 / 14 |
| `data-step-process` / `data-step-process-icon` | 工作步骤折叠 | 11 / 1 |
| `data-turn-process` / `-member` / `-hidden` / `-inline` | 轮次级步骤折叠 | 6 / 1 / 1 / 2 |
| `data-chat-flow-kind` / `data-streaming` | 消息折叠与耗时定位 | 19 / 4 |
| `data-conversation-scroll` / `-session` / `-composer-overlay` | 输入框定位 | 14 / 2 / 5 |
| `data-composer-seat` / `data-composer-card` / `data-input-scroll` | 输入框高度 | 4 / 5 / 1 |
| `--dsh-composer-text-max-height` | 输入框自然上限 | 3 |
| `settings.plugins.tab` | 设置面板 | 22 |
| 10 个删除对话服务（`sessionPersistence` 等） | 删除本地记录 | 全部存在 |

## 三、浏览器实测基线（2026-10-31，rc.5）

在应用内 `F12` → Console 运行诊断脚本得到。升级后重跑，下面每一项都必须保持一致：

| 项 | 基线值 |
| --- | --- |
| 插件对象 / status | 存在 / `running` |
| 查找页签 | `true` |
| 步骤按钮行 `[data-lf-step-line]` | 6 |
| 耗时条 `[data-lf-turn-timer]` | 2 |
| 输入框手柄 `[data-lf-composer-handle]` | 1 |
| 折叠按钮 `[data-lf-toggle]` | 3 |
| 输入框 `default` | 336 |
| 右栏 `renderedRatio` | 40 |
| 宿主步骤按钮 | `disabled: true`，文字「已完成，用时 5分11秒」 |
| 页面上的 `data-turn-process-member/-hidden/-inline` | 0（rc.5 未渲染这三个标记） |

## 四、刻意没有改的部分

用户要求「所有功能必须和以前一样」，因此以下重叠**保持原样**，不做合并或去重：

1. **工作步骤折叠**：宿主自带「工作步骤展示」（简洁 / 标准 / 详细 / 完全展开）与「工作步骤收起时机」（回答结束后 / 下次有新消息时）；插件仍使用自己的三层按钮（单段 / 全部 / 全收起）。
2. **每轮耗时**：宿主在过程组标题显示「已完成，用时 X」；插件在最后一条回复末尾显示「本轮用时 X 秒」。实测插件那一条被折叠层遮住，视觉上不重复。
3. **右栏宽度**：宿主自带 45% 首开、70% 上限、保会话 400px 的规则；插件仍按自己的比例写入并同步用户拖动。
4. **输入框上限变量**：`--dsh-composer-text-max-height` 定义在 composer seat 元素上，**在 `documentElement` 上读到的是空值**，读取时必须落在元素上。

## 五、已知风险

- 宿主若把 `data-step-process` 换成新的结构（rc.5 还多了 `-body` / `-content` / `-chevron` 三件套），工作步骤折叠会失效而**不会报错**。`npm run compat` 能提前发现。
- 宿主若改动 `--dsh-composer-text-max-height` 的含义（从"上限"变成别的东西），输入框高度模块需要重新核对。
- 右栏在 rc.5 由停靠系统（dockkit）管理，插件的宽度规则与宿主拖动靠 `data-dragging` 协同；若宿主改掉这个标记，拖动后会回弹。
