// Host settings contribution. All values come from the running controller;
// the panel owns only unfinished number edits.
export function createPanel(React, api) {
  const h = React.createElement

  function Row({ label, hint, children }) {
    return h(
      'div',
      { 'data-lf-setting-row': '1' },
      h(
        'div',
        { 'data-lf-setting-text': '1' },
        h('div', { 'data-lf-setting-label': '1' }, label),
        hint ? h('div', { 'data-lf-setting-hint': '1' }, hint) : null,
      ),
      h('div', { 'data-lf-setting-control': '1' }, children),
    )
  }

  function Toggle({ label, checked, disabled, onChange }) {
    return h(
      'button',
      {
        type: 'button',
        role: 'switch',
        disabled,
        'aria-label': label,
        'aria-checked': Boolean(checked),
        'data-lf-switch': checked ? '1' : '0',
        onClick: () => onChange(!checked),
      },
      h('span', { 'data-lf-knob': '1' }),
    )
  }

  function NumberBox({ label, value, min, max, suffix, disabled, onChange }) {
    const [draft, setDraft] = React.useState(() => String(value))
    React.useEffect(() => setDraft(String(value)), [value])
    const commit = () => {
      const number = draft.trim() === '' ? NaN : Number(draft)
      if (!Number.isFinite(number)) {
        setDraft(String(value))
        return
      }
      const next = Math.max(min, Math.min(max, Math.round(number)))
      setDraft(String(next))
      if (next !== value) onChange(next)
    }
    return h(
      'span',
      { 'data-lf-number': '1' },
      h('input', {
        type: 'number',
        inputMode: 'numeric',
        value: draft,
        min,
        max,
        step: 1,
        disabled,
        'aria-label': label,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
          if (event.key === 'Escape') setDraft(String(value))
        },
      }),
      suffix ? h('span', { 'data-lf-suffix': '1' }, suffix) : null,
    )
  }

  const read = () => ({
    settings: api.settings?.(),
    composer: api.composer?.(),
    rightbar: api.rightbar?.(),
  })

  function SettingsPanel() {
    const [snapshot, setSnapshot] = React.useState(read)
    React.useEffect(() => {
      const refresh = () => setSnapshot(read())
      const off = api.subscribe?.(refresh)
      refresh()
      return () => {
        if (typeof off === 'function') off()
      }
    }, [])
    const { settings, composer, rightbar } = snapshot
    if (!settings)
      return h(
        'div',
        { 'data-lf-setting-empty': '1' },
        '插件尚未启动，请重新启用后打开设置。',
      )

    const toggle = (key, label, hint, disabled = false) =>
      h(
        Row,
        { key, label, hint },
        h(Toggle, {
          label,
          checked: settings[key],
          disabled,
          onChange: (value) => api.update({ [key]: value }),
        }),
      )
    const number = (key, label, hint, min, max, disabled = false) =>
      h(
        Row,
        { key, label, hint },
        h(NumberBox, {
          label,
          value: settings[key],
          min,
          max,
          disabled,
          onChange: (value) => api.update({ [key]: value }),
        }),
      )
    const height = composer?.height ?? composer?.value
    const defaultHeight = composer?.default ?? composer?.fallback

    return h(
      'div',
      { 'data-lf-setting': '1' },
      h(
        'div',
        { 'data-lf-setting-intro': '1' },
        '改动立即生效并自动记住。长消息默认保留 3 行，图片完整显示。',
      ),
      toggle(
        'enabled',
        '启用插件',
        '控制消息折叠、步骤折叠、输入框调高、右栏宽度和耗时显示。',
      ),
      toggle('userEnabled', '折叠我的输入', '超过保留行数时显示展开按钮。'),
      number(
        'userLines',
        '我的输入保留行数',
        '图片不占文字行数。',
        2,
        120,
        !settings.userEnabled || settings.collapseAll,
      ),
      toggle('assistantEnabled', '折叠助手回复', '正在输出的回复保持展开。'),
      number(
        'assistantLines',
        '助手回复保留行数',
        '图片不占文字行数。',
        2,
        120,
        !settings.assistantEnabled || settings.collapseAll,
      ),
      toggle(
        'keepLatestOpen',
        '最新一轮保持展开',
        settings.collapseAll
          ? '「全部消息都折叠」已开启，当前使用统一行数。'
          : '最新一轮的输入和回复默认展开；仍可手动收起。',
        settings.collapseAll,
      ),
      toggle(
        'collapseAll',
        '全部消息都折叠',
        '包含最新一轮，统一使用下方行数；短消息无需折叠。',
      ),
      number(
        'collapsedLines',
        '折叠后保留行数',
        '开启「全部消息都折叠」时使用。',
        2,
        60,
        !settings.collapseAll,
      ),
      number(
        'extraPx',
        '折叠后与控件的间距 (px)',
        '正文与展开按钮之间的距离。',
        0,
        120,
      ),
      toggle(
        'workStepButtons',
        '步骤区与回复之间加折叠按钮',
        '展开和收起本轮工具步骤。',
      ),
      toggle(
        'foldAllSteps',
        '步骤默认收起',
        '新出现的步骤区默认折叠。',
        !settings.workStepButtons,
      ),
      toggle(
        'mergeByDefault',
        '默认只留一个按钮',
        '先收成一个按钮；点开显示各段开关，再展开单段或所有步骤。',
        !settings.workStepButtons,
      ),
      toggle(
        'stepLabels',
        '按钮显示文字',
        '在步骤按钮上显示展开或收起的文字。',
        !settings.workStepButtons,
      ),
      toggle(
        'composerResize',
        '输入框可拖动调高',
        '拖动输入框顶部手柄调整高度，双击手柄恢复默认。',
      ),
      h(
        Row,
        {
          label: '输入框高度',
          hint: composer
            ? `可调范围 ${composer.min}–${composer.max} px，默认 ${defaultHeight} px。`
            : '打开会话输入框后即可调整。',
        },
        composer
          ? h(
              'span',
              { 'data-lf-height-row': '1' },
              h(NumberBox, {
                label: '输入框高度',
                value: height,
                min: composer.min,
                max: composer.max,
                suffix: 'px',
                disabled: !settings.composerResize,
                onChange: (value) => api.setHeight(value),
              }),
              h(
                'button',
                {
                  type: 'button',
                  'data-lf-height-reset': '1',
                  disabled: !settings.composerResize,
                  onClick: () => api.resetHeight(),
                },
                '恢复默认',
              ),
            )
          : null,
      ),
      h(
        Row,
        {
          label: '右侧栏占比 (%)',
          hint:
            rightbar?.supported === false
              ? '当前宿主不支持调整右侧栏宽度。'
              : '关闭右栏后主区域自动恢复宽度，下次打开沿用此设置。',
        },
        h(NumberBox, {
          label: '右侧栏占比 (%)',
          value: settings.rightbarRatio,
          min: 30,
          max: 70,
          suffix: '%',
          disabled: rightbar?.supported === false,
          onChange: (value) => api.setRightbarRatio(value),
        }),
      ),
      toggle(
        'turnTimer',
        '每轮显示耗时',
        '从开始处理到最后一步输出完成，包含工具执行时间。',
      ),
    )
  }

  return SettingsPanel
}
