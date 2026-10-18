// The right-sidebar search view. The controller indexes both visible and folded
// content and returns opaque element handles that revealAt can open and locate.
export function createFindPanel(React, api) {
  const h = React.createElement
  const sameHit = (left, right) =>
    left &&
    right &&
    left.element === right.element &&
    left.kind === right.kind &&
    left.snippet === right.snippet
  const sameHits = (left, right) =>
    left.length === right.length &&
    left.every((hit, index) => sameHit(hit, right[index]))

  function Title() {
    return h('span', { 'data-lf-find-chip': '1' }, '查找')
  }

  function Panel() {
    const [query, setQuery] = React.useState('')
    const [hits, setHits] = React.useState([])
    const [active, setActive] = React.useState(-1)
    const inputRef = React.useRef(null)
    const stateRef = React.useRef({ query: '', hits: [], active: -1 })

    const refresh = (nextQuery = stateRef.current.query, reset = false) => {
      const previous = stateRef.current
      const result = nextQuery.trim() ? api.search(nextQuery) : []
      const found = Array.isArray(result) ? result : []
      let index = -1
      if (!reset && previous.active >= 0) {
        const selected = previous.hits[previous.active]
        index = found.findIndex((hit) => sameHit(hit, selected))
        if (index < 0 && found.length)
          index = Math.min(previous.active, found.length - 1)
      }
      stateRef.current = { query: nextQuery, hits: found, active: index }
      if (!sameHits(previous.hits, found)) setHits(found)
      if (previous.active !== index) setActive(index)
      return found
    }

    const jump = (index) => {
      const current = stateRef.current
      const hit = current.hits[index]
      if (!hit) return
      current.active = index
      setActive(index)
      api.revealAt(hit.element)
    }

    React.useEffect(() => {
      const focus = () => inputRef.current?.focus()
      const mountedOff = api.onFindPanelMounted?.(focus)
      const off = api.subscribe?.(() => refresh())
      focus()
      return () => {
        if (typeof off === 'function') off()
        if (typeof mountedOff === 'function') mountedOff()
        else api.onFindPanelMounted?.(null)
      }
    }, [])

    const change = (value) => {
      setQuery(value)
      refresh(value, true)
    }
    const navigate = (backwards) => {
      const found = refresh()
      if (!found.length) return
      const index = stateRef.current.active
      jump(
        index < 0
          ? backwards
            ? found.length - 1
            : 0
          : (index + (backwards ? -1 : 1) + found.length) % found.length,
      )
    }

    return h(
      'div',
      { 'data-lf-find': '1' },
      h(
        'div',
        { 'data-lf-find-head': '1' },
        h('input', {
          ref: inputRef,
          type: 'search',
          value: query,
          'aria-label': '搜索本会话（含折叠内容）',
          placeholder: '搜索消息和步骤（含折叠内容）',
          onChange: (event) => change(event.target.value),
          onKeyDown: (event) => {
            if (event.isComposing) return
            if (event.key === 'Enter') {
              event.preventDefault()
              navigate(event.shiftKey)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              change('')
            }
          },
        }),
        h(
          'span',
          { 'data-lf-find-count': '1', role: 'status', 'aria-live': 'polite' },
          query.trim() ? `${active + 1} / ${hits.length}` : '',
        ),
      ),
      h(
        'div',
        { 'data-lf-find-list': '1' },
        !query.trim()
          ? h(
              'div',
              { 'data-lf-find-empty': '1' },
              '输入关键词搜索本会话。回车跳到下一项，Shift + 回车跳到上一项。',
            )
          : hits.length === 0
            ? h(
                'div',
                { 'data-lf-find-empty': '1' },
                '没有匹配。已包含折叠的消息和步骤。',
              )
            : hits.map((hit, index) =>
                h(
                  'button',
                  {
                    key: index,
                    type: 'button',
                    'data-lf-find-row': '1',
                    'data-lf-find-active': index === active ? '1' : '0',
                    'aria-current': index === active ? 'true' : undefined,
                    title: '展开并跳到此位置',
                    onClick: () => jump(index),
                  },
                  h(
                    'span',
                    { 'data-lf-find-kind': '1' },
                    hit.kind === 'step' ? '步骤' : '消息',
                  ),
                  h(
                    'span',
                    { 'data-lf-find-snippet': '1' },
                    String(hit.snippet ?? ''),
                  ),
                ),
              ),
      ),
    )
  }

  return { Panel, Title }
}
