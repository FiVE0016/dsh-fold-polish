// The settings page rendered inside the host's Plugins settings section, as a
// `settings.plugins.tab` contribution. Plain React.createElement — this bundle
// has no JSX transform, and React comes from the host's own module table.
//
// The component receives one `api` prop (through the slot registration's
// `inject`): { settings(), update(patch), subscribe(fn), composer(),
// setHeight(v), resetHeight() }. Everything else lives in the DOM-layer
// controller this bundle already runs.
//
// It mirrors the in-page panel (Ctrl + Shift + ,) row for row, so the two never
// disagree about which knobs exist — only the composer height is read from
// `composer()` because it drives the host's own CSS variable rather than a plugin
// setting.

export function createPanel(React, api) {
  const h = React.createElement

  function Row(props) {
    const { label, hint, children } = props
    return h('div', { 'data-lf-setting-row': '1' },
      h('div', { 'data-lf-setting-text': '1' },
        h('div', { 'data-lf-setting-label': '1' }, label),
        hint ? h('div', { 'data-lf-setting-hint': '1' }, hint) : null),
      h('div', { 'data-lf-setting-control': '1' }, children))
  }

  function Toggle(props) {
    const { checked, onChange, label } = props
    return h('button', {
      type: 'button',
      role: 'switch',
      'aria-checked': checked ? 'true' : 'false',
      'aria-label': label,
      'data-lf-switch': checked ? '1' : '0',
      onClick: () => onChange(!checked)
    }, h('span', { 'data-lf-knob': '1' }))
  }

  function NumberBox(props) {
    const { value, min, max, onChange, suffix } = props
    const [draft, setDraft] = React.useState(() => String(value))
    // Follow external writes (the floating panel can change the same value).
    React.useEffect(() => { setDraft(String(value)) }, [value])
    const commit = () => {
      const number = Number.parseInt(draft, 10)
      if (Number.isFinite(number)) onChange(Math.max(min, Math.min(max, number)))
      else setDraft(String(value))
    }
    return h('span', { 'data-lf-number': '1' },
      h('input', {
        type: 'number',
        value: draft,
        min,
        max,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => { if (event.key === 'Enter') commit() }
      }),
      suffix ? h('span', { 'data-lf-suffix': '1' }, suffix) : null)
  }

  function SettingsPanel() {
    const [settings, setSettings] = React.useState(() => api.settings())
    React.useEffect(() => api.subscribe(() => setSettings(api.settings())), [])
    if (!settings) {
      return h('div', { 'data-lf-setting-empty': '1' }, 'UI 美化未启动。')
    }
    const patch = (part) => api.update(part)
    const toggle = (key, label, hint) => h(Row, { label, hint }, h(Toggle, {
      checked: settings[key],
      label,
      onChange: (value) => patch({ [key]: value })
    }))
    const lines = (key, label, hint, min, max) => h(Row, { label, hint }, h(NumberBox, {
      value: settings[key],
      min,
      max,
      onChange: (value) => patch({ [key]: value })
    }))
    const composer = api.composer() ?? null

    return h('div', { 'data-lf-setting': '1' },
      h('div', { 'data-lf-setting-intro': '1' },
        '改动即时生效，和对话页 Ctrl + Shift + , 面板完全同步。以下为全部设置项。'),
      toggle('enabled', '启用插件', '关闭后所有折叠与控件立即消失，界面回到原生状态。'),
      toggle('keepLatestOpen', '最新一轮保持展开', '最新一轮永不折叠——那正是你正在读的内容。'),
      toggle('userEnabled', '折叠我的输入', '超过保留行数的历史输入会被折起。'),
      lines('userLines', '我的输入保留行数', '折叠我的输入时，保留可见的行数。', 2, 120),
      toggle('assistantEnabled', '折叠助手回复', '超过保留行数的历史回复会被折起。'),
      lines('assistantLines', '助手回复保留行数', '折叠助手回复时，保留可见的行数。', 2, 120),
      toggle('collapseAll', '全部消息都折叠', '打开后不论长短，所有消息都按保留行数折起。'),
      lines('collapsedLines', '折叠后保留行数', '「全部消息都折叠」使用的行数预算。', 2, 60),
      lines('extraPx', '折叠后与控件的间距 (px)', '折叠框与下方展开/复制按钮之间的距离。', 0, 120),
      toggle('workStepButtons', '步骤区与回复之间加折叠按钮', '在最后一条步骤行与下面的回复之间放一个折叠缝。'),
      toggle('foldAllSteps', '步骤默认收起', '每一段工作步骤默认折起，最新一轮也一样。'),
      toggle('mergeByDefault', '默认只留一个按钮', '每轮回复上方只显示「展开全部」；点开才摊开各条折叠缝，内容仍收起。'),
      toggle('stepLabels', '按钮显示文字', '开：三个按钮各带「展开全部 / 展开所有步骤 / 展开本步骤」文字；关：只留三个不同的箭头图标。'),
      toggle('turnTimer', '每轮显示耗时', '在每轮对话末尾显示该轮从收到命令到完成输出的用时（取自宿主的步计时数据）。'),
      toggle('composerResize', '输入框可拖动调高', '在输入框卡片顶部显示一条拖拽手柄。'),
      h(Row, {
        label: '右侧栏占比 (%)',
        hint: (() => {
          const rb = api.rightbar?.()
          if (rb && !rb.supported) return '当前宿主不支持程序化调宽；仍可拖动右栏手柄，拖动会同步回这个数字。'
          return '拖动右栏手柄会同步这个数字；下次打开保持。'
        })()
      }, h(NumberBox, {
        value: settings.rightbarRatio,
        min: 30,
        max: 70,
        suffix: '%',
        onChange: (value) => api.setRightbarRatio(value)
      })),
      h(Row, {
        label: '输入框高度',
        hint: composer
          ? `宿主原生上限 ${composer.min}–${composer.max}px；恢复默认 = ${composer.fallback}px。`
          : '未启动时不可调。'
      }, composer
        ? h('span', { 'data-lf-height-row': '1' },
            h(NumberBox, {
              value: composer.value,
              min: composer.min,
              max: composer.max,
              suffix: 'px',
              onChange: (value) => api.setHeight(value)
            }),
            h('button', {
              type: 'button',
              'data-lf-height-reset': '1',
              onClick: () => api.resetHeight()
            }, '恢复默认'))
        : null))
  }

  return SettingsPanel
}
