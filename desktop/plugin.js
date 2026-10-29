// plan-usage — Hermes desktop plugin.
//
// A dockable pane (and a status-bar chip) showing subscription plan limits —
// 5-hour / weekly windows, credits — for every provider Hermes can read them
// for. Data comes from this package's backend (dashboard/plugin_api.py) via
// ctx.rest('/usage'), which runs inside the gateway process and calls the same
// fetcher as `/usage` and `hermes usage`.
//
// Refresh interval is per-desktop (ctx.storage), default 10 minutes; the ↻
// button forces a fresh fetch past the backend's 60 s cache.
import {
  atom,
  Button,
  Codicon,
  host,
  PALETTE_AREA,
  PANES_AREA,
  queryClient,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  STATUSBAR_AREAS,
  Tip,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'plan-usage'
const QUERY_KEY = [ID, 'usage']
const INTERVALS = [1, 5, 10, 15, 30, 60] // minutes
const DEFAULT_INTERVAL = 10

let rest = null
let storage = null
const $intervalMin = atom(DEFAULT_INTERVAL)
const $refreshing = atom(false)

function fetchUsage(force) {
  if (!rest) return Promise.reject(new Error('plan-usage is not registered'))
  return rest(force ? '/usage?force=1' : '/usage')
}

async function forceRefresh() {
  if ($refreshing.get()) return
  $refreshing.set(true)
  try {
    const data = await fetchUsage(true)
    queryClient.setQueryData(QUERY_KEY, data)
  } catch (err) {
    host.notify({ kind: 'error', message: `Plan usage refresh failed: ${err?.message || err}` })
  } finally {
    $refreshing.set(false)
  }
}

const PANE_ID = `${ID}:pane`

function showPane() {
  if (typeof host.undismissPane === 'function') host.undismissPane(PANE_ID)
  if (typeof host.revealPane === 'function') host.revealPane(PANE_ID)
}

function setIntervalMin(min) {
  $intervalMin.set(min)
  storage?.set('intervalMin', min)
}

// ── formatting ──────────────────────────────────────────────────────────────

const clampPct = v => Math.max(0, Math.min(100, Number(v) || 0))
const leftPct = w => Math.round(100 - clampPct(w.used_percent))

const WINDOW_LABELS = {
  'current session': '5 hours',
  session: '5 hours',
  'current week': 'Weekly',
  weekly: 'Weekly'
}
const windowLabel = label => WINDOW_LABELS[String(label || '').toLowerCase()] || label

function resetText(iso, now) {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  const ms = at.getTime() - now
  if (ms <= 0) return 'Resetting…'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `Resets in ${mins}m`
  if (ms < 24 * 3600 * 1000) {
    const h = Math.floor(mins / 60)
    return `Resets in ${h}h ${mins % 60}m`
  }
  const day = at.toLocaleDateString(undefined, { weekday: 'short' })
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  return `Resets ${day} ${time}`
}

function agoText(iso, now) {
  if (!iso) return ''
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ${m % 60}m ago`
}

const barColor = left =>
  left <= 10 ? 'var(--ui-red)' : left <= 25 ? 'var(--ui-orange)' : 'var(--ui-text-tertiary)'

const SHORT_LABELS = { '5 hours': '5h', Weekly: 'wk', Monthly: 'mo', Subscription: 'sub' }
const shortLabel = w => SHORT_LABELS[windowLabel(w.label)] || windowLabel(w.label)

// Per-provider derived state. Windows are grouped by quota pool: Antigravity reports independent
// pools ("Gemini 5h", "Claude/GPT 7d"), Claude a model-scoped "Weekly · Fable"; a plain
// "5 hours"/"Weekly" belongs to the account pool ''. A pool is blocked when any of its windows is at
// 0%; the PROVIDER is blocked only when every pool is (one pool running dry leaves the others usable).
//   short        — the bar shown collapsed: tightest 5h window among usable pools, else the first window
//   blocked      — every pool blocked; blocker = the window whose reset frees the first pool
//   blockedPools — names of blocked pools while others are still usable
//   warn         — a longer window lower than `short` and ≤ 25% left (the binding constraint)
const isShortWindow = w => {
  const l = windowLabel(w.label)
  return l === '5 hours' || /\b5h$/i.test(l)
}
const poolOf = w =>
  windowLabel(w.label)
    .replace(/^Weekly · /, '')
    .replace(/\s*\b(5h|7d|24h|1d)$/i, '')
    .replace(/^(5 hours|Weekly|Monthly|Daily|Today|Subscription|Current week|Current session)$/i, '')

function providerState(p) {
  const ws = (p.available && p.windows) || []
  const pools = new Map()
  for (const w of ws) {
    const k = poolOf(w)
    if (!pools.has(k)) pools.set(k, [])
    pools.get(k).push(w)
  }
  const latest = list => list.reduce((a, b) => (new Date(b.resets_at || 0) > new Date(a.resets_at || 0) ? b : a))
  const blockedPools = new Map() // pool → window whose reset unblocks it
  for (const [k, list] of pools) {
    const dead = list.filter(w => leftPct(w) <= 0)
    if (dead.length) blockedPools.set(k, latest(dead))
  }
  const usable = blockedPools.has('') ? [] : ws.filter(w => !blockedPools.has(poolOf(w)))
  const blocked = ws.length > 0 && usable.length === 0
  const blocker = blocked
    ? blockedPools.get('') ||
      [...blockedPools.values()].reduce((a, b) => (new Date(b.resets_at || 0) < new Date(a.resets_at || 0) ? b : a))
    : null
  const pickFrom = blocked ? ws : usable
  const shorts = pickFrom.filter(isShortWindow)
  const short = shorts.length
    ? shorts.reduce((a, b) => (leftPct(b) < leftPct(a) ? b : a))
    : pickFrom[0] || null
  const others = usable.filter(w => w !== short)
  const lowest = others.length ? others.reduce((a, b) => (leftPct(b) < leftPct(a) ? b : a)) : null
  const warn = !blocked && lowest && short && leftPct(lowest) < leftPct(short) && leftPct(lowest) <= 25 ? lowest : null
  const partial = blocked ? [] : [...blockedPools.keys()].map(k => k || 'main')
  return { short, blocked, blocker, warn, blockedPools: partial }
}

function untilText(iso, now, compact = false) {
  if (!iso) return compact ? 'blocked' : 'reset time unknown'
  const at = new Date(iso)
  const ms = at.getTime() - now
  if (Number.isNaN(ms) || ms <= 0) return compact ? 'resetting…' : 'resetting now'
  const mins = Math.round(ms / 60000)
  let s
  if (ms < 24 * 3600 * 1000) s = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`
  else {
    const day = at.toLocaleDateString(undefined, { weekday: 'short' })
    const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
    s = `${day} ${time}`
  }
  if (compact) return ms < 24 * 3600 * 1000 ? `back in ${s}` : `back ${s}`
  return ms < 24 * 3600 * 1000 ? `available again in ${s}` : `available again ${s}`
}

// Expanded providers (default collapsed), persisted per desktop.
const $expanded = atom({})
function setExpanded(provider, open) {
  const next = { ...$expanded.get(), [provider]: open }
  if (!open) delete next[provider]
  $expanded.set(next)
  storage?.set('expanded', next)
}
function setAllExpanded(providers, open) {
  const next = open ? Object.fromEntries(providers.map(p => [p.provider, true])) : {}
  $expanded.set(next)
  storage?.set('expanded', next)
}

// Usable first, then blocked, then providers with no numbers; alphabetical within each group so rows
// don't jump around on every refresh.
function sortProviders(list) {
  const rank = p => {
    const st = providerState(p)
    if (!p.available || !st.short) return 2
    return st.blocked ? 1 : 0
  }
  return [...list].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
}

// ── data hooks ──────────────────────────────────────────────────────────────

function useUsage() {
  const gateway = useValue(host.state.gateway)
  const intervalMin = useValue($intervalMin)
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchUsage(false),
    refetchInterval: intervalMin * 60 * 1000,
    refetchOnWindowFocus: false,
    staleTime: 30 * 1000,
    enabled: gateway === 'open',
    placeholderData: prev => prev
  })
}

function useClock(ms) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

// ── pane ────────────────────────────────────────────────────────────────────

function Bar({ left }) {
  return jsx('div', {
    className: 'h-1.5 w-full overflow-hidden rounded-full',
    style: { background: 'var(--ui-bg-tertiary)' },
    children: jsx('div', {
      className: 'h-full rounded-full transition-[width] duration-500',
      style: { width: `${left}%`, background: barColor(left) }
    })
  })
}

function WindowRow({ w, now }) {
  const left = leftPct(w)
  const reset = resetText(w.resets_at, now)
  return jsxs('div', {
    className: 'flex flex-col gap-1',
    children: [
      jsxs('div', {
        className: 'flex items-baseline justify-between gap-2',
        children: [
          jsx('span', { className: 'text-(--ui-text-primary)', children: windowLabel(w.label) }),
          jsx('span', {
            className: 'tabular-nums text-(--ui-text-secondary)',
            style: left <= 25 ? { color: barColor(left) } : undefined,
            children: `${left}% left`
          })
        ]
      }),
      jsx(Bar, { left }),
      reset || w.detail
        ? jsx('div', {
            className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
            children: [reset, w.detail].filter(Boolean).join(' · ')
          })
        : null
    ]
  })
}

function ProviderBlock({ p, now }) {
  const expanded = useValue($expanded)[p.provider] === true
  const st = providerState(p)
  const toggle = () => setExpanded(p.provider, !expanded)

  const header = jsxs('button', {
    type: 'button',
    onClick: toggle,
    'aria-expanded': expanded,
    className: 'flex w-full items-center gap-2 text-left',
    children: [
      jsx(Codicon, {
        name: expanded ? 'chevron-down' : 'chevron-right',
        size: 12,
        className: 'text-(--ui-text-tertiary)'
      }),
      jsx('span', {
        className: 'shrink-0 font-medium text-(--ui-text-primary)',
        style: st.blocked ? { textDecoration: 'line-through', color: 'var(--ui-red)' } : undefined,
        children: p.label
      }),
      expanded && p.plan
        ? jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: p.plan })
        : null,
      expanded ? null : jsx(CollapsedSummary, { p, st, now }),
      expanded && p.configured
        ? jsx('span', {
            className: 'ml-auto rounded px-1 text-[0.625rem] uppercase tracking-wide text-(--ui-text-tertiary)',
            style: { border: '1px solid var(--ui-stroke-secondary)' },
            children: 'default'
          })
        : null
    ]
  })

  if (!expanded) return header

  if (!p.available) {
    return jsxs('div', {
      className: 'flex flex-col gap-1',
      children: [
        header,
        jsx('div', {
          className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
          children: p.error ? `Fetch failed: ${p.error}` : 'No usage endpoint for this provider'
        })
      ]
    })
  }

  return jsxs('div', {
    className: 'flex flex-col gap-2.5',
    children: [
      header,
      st.blocked
        ? jsx('div', {
            className: 'rounded px-2 py-1 text-[0.6875rem]',
            style: { color: 'var(--ui-red)', border: '1px solid var(--ui-red)' },
            children: `Blocked — ${windowLabel(st.blocker.label).toLowerCase()} limit hit, ${untilText(st.blocker.resets_at, now)}`
          })
        : null,
      st.blockedPools.length
        ? jsx('div', {
            className: 'text-[0.6875rem]',
            style: { color: 'var(--ui-red)' },
            children: `${st.blockedPools.join(', ')} quota used up — other models still available`
          })
        : null,
      ...(p.windows || []).map((w, i) => jsx(WindowRow, { w, now }, `w${i}`)),
      ...(p.details || []).map((d, i) =>
        jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: d }, `d${i}`)
      ),
      p.unavailable_reason
        ? jsx('div', { className: 'text-[0.6875rem] text-(--ui-orange)', children: p.unavailable_reason })
        : null,
      p.stale && p.error
        ? jsx('div', {
            className: 'text-[0.6875rem] text-(--ui-orange)',
            children: `Showing last good numbers — latest fetch failed: ${p.error}`
          })
        : null
    ]
  })
}

// One-line summary for a collapsed provider: the shortest window's bar (5 hours where there is one).
// A blocked provider (any window at 0%) goes red and says when it frees up; a longer window that is
// running low gets a small warning tag so the 5-hour bar can't hide it.
function CollapsedSummary({ p, st, now }) {
  if (!p.available || !st.short) {
    return jsx('span', {
      className: 'ml-auto truncate text-[0.6875rem] text-(--ui-text-quaternary)',
      children: p.error ? 'fetch failed' : 'no usage endpoint'
    })
  }
  const left = leftPct(st.short)
  const tail = st.blocked
    ? jsx('span', {
        className: 'shrink-0 text-[0.6875rem] tabular-nums',
        style: { color: 'var(--ui-red)' },
        children: untilText(st.blocker.resets_at, now, true)
      })
    : jsxs('span', {
        className: 'flex shrink-0 items-center gap-1 text-[0.6875rem] tabular-nums text-(--ui-text-secondary)',
        children: [
          ...st.blockedPools.map(name =>
            jsx('span', { key: `b-${name}`, style: { color: 'var(--ui-red)', textDecoration: 'line-through' }, children: name })
          ),
          st.warn
            ? jsx('span', {
                style: { color: barColor(leftPct(st.warn)) },
                children: `${shortLabel(st.warn)} ${leftPct(st.warn)}%`
              })
            : null,
          jsx('span', { style: left <= 25 ? { color: barColor(left) } : undefined, children: `${left}%` })
        ]
      })
  return jsxs('span', {
    className: 'ml-auto flex min-w-0 flex-1 items-center gap-2 pl-1',
    children: [
      jsx('span', {
        className: 'min-w-0 flex-1',
        style: st.blocked ? { opacity: 0.45 } : undefined,
        children: jsx(Bar, { left: st.blocked ? 0 : left })
      }),
      tail
    ]
  })
}

function IntervalPicker() {
  const value = useValue($intervalMin)
  return jsxs(Select, {
    value: String(value),
    onValueChange: v => setIntervalMin(Number(v)),
    children: [
      jsx(SelectTrigger, {
        'aria-label': 'Refresh interval',
        size: 'sm',
        className: 'h-6 w-auto gap-1 px-1.5 text-[0.6875rem]',
        children: jsx(SelectValue, {})
      }),
      jsx(SelectContent, {
        children: INTERVALS.map(m =>
          jsx(SelectItem, { value: String(m), children: m < 60 ? `every ${m}m` : 'every 1h' }, m)
        )
      })
    ]
  })
}

function RefreshButton() {
  const refreshing = useValue($refreshing)
  return jsx(Tip, {
    label: 'Refresh now',
    children: jsx(Button, {
      'aria-label': 'Refresh plan usage',
      size: 'icon-xs',
      variant: 'ghost',
      disabled: refreshing,
      onClick: forceRefresh,
      children: jsx(Codicon, { name: 'refresh', spinning: refreshing })
    })
  })
}

function UsagePane() {
  const q = useUsage()
  const now = useClock(30 * 1000)
  const data = q.data
  const providers = data?.providers || []

  let body
  if (!data && q.isLoading) {
    body = jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'Loading…' })
  } else if (q.error && !data) {
    body = jsx('div', {
      className: 'text-(--ui-text-tertiary)',
      children: `Backend unreachable: ${q.error.message || q.error}. Is plan-usage in plugins.enabled on the Hermes host?`
    })
  } else if (data?.error) {
    body = jsx('div', { className: 'text-(--ui-orange)', children: data.error })
  } else if (!providers.length) {
    body = jsx('div', { className: 'text-(--ui-text-tertiary)', children: 'No provider reports plan usage.' })
  } else {
    const sorted = sortProviders(providers)
    body = jsx('div', {
      className: 'flex flex-col gap-2',
      children: sorted.map((p, i) =>
        jsxs(
          'div',
          {
            className: 'flex flex-col',
            children: [
              i > 0 ? jsx('div', { className: 'mb-2 h-px', style: { background: 'var(--ui-stroke-tertiary)' } }) : null,
              jsx(ProviderBlock, { p, now })
            ]
          },
          p.provider
        )
      )
    })
  }

  return jsxs('div', {
    className: 'flex h-full flex-col gap-3 overflow-y-auto p-3 text-[0.8125rem]',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-1',
        children: [
          jsx('span', {
            className: 'mr-auto text-[0.6875rem] text-(--ui-text-tertiary)',
            children: data?.fetched_at ? `Updated ${agoText(data.fetched_at, now)}` : ''
          }),
          jsx(ExpandAllButton, { providers }),
          jsx(IntervalPicker, {}),
          jsx(RefreshButton, {})
        ]
      }),
      body
    ]
  })
}

function ExpandAllButton({ providers }) {
  const expanded = useValue($expanded)
  const anyOpen = providers.some(p => expanded[p.provider])
  return jsx(Tip, {
    label: anyOpen ? 'Collapse all' : 'Expand all',
    children: jsx(Button, {
      'aria-label': anyOpen ? 'Collapse all providers' : 'Expand all providers',
      size: 'icon-xs',
      variant: 'ghost',
      onClick: () => setAllExpanded(providers, !anyOpen),
      children: jsx(Codicon, { name: anyOpen ? 'collapse-all' : 'expand-all' })
    })
  })
}

// ── status-bar chip ─────────────────────────────────────────────────────────

// Runtime session id → provider, fed by the gateway's session.info events
// (stamped on every turn, and on a mid-session model switch).
const $sessionProviders = atom({})

function rememberProvider(sessionId, provider) {
  if (!sessionId || typeof provider !== 'string' || !provider.trim()) return
  const p = provider.trim().toLowerCase()
  const map = $sessionProviders.get()
  if (map[sessionId] !== p) $sessionProviders.set({ ...map, [sessionId]: p })
}

// Provider of the focused chat: live event map first, else ask session.status
// once ("Model: <model> (<provider>)"), else the configured default.
function useFocusedProvider(fallback) {
  const focused = useValue(host.state.focusedSessionId)
  const map = useValue($sessionProviders)
  useEffect(() => {
    if (!focused || map[focused]) return
    let cancelled = false
    Promise.resolve(host.request('session.status', { session_id: focused }))
      .then(r => {
        const m = /Model:\s*.*\(([^()]+)\)\s*$/m.exec(String(r?.output || ''))
        if (!cancelled && m && !/unknown/i.test(m[1])) rememberProvider(focused, m[1])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [focused, map[focused]])
  return (focused && map[focused]) || fallback || null
}

function StatusChip() {
  const q = useUsage()
  const refreshing = useValue($refreshing)
  const providers = q.data?.providers || []
  const want = useFocusedProvider(q.data?.configured_provider)
  const p = providers.find(x => x.provider === want)
  const onClick = () => {
    showPane()
    forceRefresh()
  }
  const cls =
    'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground'
  if (!q.data || !want) return null
  if (!p || !p.available || !(p.windows || []).length) {
    const name = p?.label || want
    return jsx(Tip, {
      label: `${name}: no plan usage reported for this session's provider. Click to open the pane.`,
      children: jsxs('button', {
        type: 'button',
        onClick,
        className: cls,
        children: [jsx(Codicon, { name: 'dashboard', size: 12 }), `${name} —`]
      })
    })
  }
  const parts = p.windows.slice(0, 2).map(w => `${leftPct(w)}%`)
  const minLeft = Math.min(...p.windows.map(leftPct))
  const st = providerState(p)
  const tip = p.windows.map(w => `${windowLabel(w.label)}: ${leftPct(w)}% left`).join(' · ')
  const now = Date.now()
  return jsx(Tip, {
    label: st.blocked
      ? `${p.label} (this session) is BLOCKED — ${windowLabel(st.blocker.label).toLowerCase()} limit hit, ${untilText(st.blocker.resets_at, now)}. ${tip}.`
      : `${p.label} (this session) — ${tip}. Click to open the pane and refresh.`,
    children: jsxs('button', {
      type: 'button',
      onClick,
      className: cls,
      style: st.blocked
        ? { color: 'var(--ui-red)' }
        : minLeft <= 25
          ? { color: barColor(minLeft) }
          : undefined,
      children: [
        jsx(Codicon, { name: refreshing ? 'sync' : st.blocked ? 'circle-slash' : 'dashboard', spinning: refreshing, size: 12 }),
        st.blocked
          ? `${p.label} blocked · ${untilText(st.blocker.resets_at, now, true)}`
          : `${p.label} ${parts.join(' · ')}`
      ]
    })
  })
}

export default {
  id: ID,
  name: 'Plan usage',
  description: 'Subscription plan limits (5-hour / weekly / credits) per provider, as a dockable pane and status-bar chip.',
  register(ctx) {
    rest = ctx.rest
    storage = ctx.storage
    const saved = Number(ctx.storage.get('intervalMin', DEFAULT_INTERVAL))
    $intervalMin.set(INTERVALS.includes(saved) ? saved : DEFAULT_INTERVAL)
    const savedExpanded = ctx.storage.get('expanded', {})
    $expanded.set(savedExpanded && typeof savedExpanded === 'object' ? savedExpanded : {})
    ctx.onDispose(() => {
      rest = null
      storage = null
    })
    ctx.onEvent('session.info', ev => rememberProvider(ev?.session_id, ev?.payload?.provider))
    ctx.registerMany([
      {
        id: 'pane',
        area: PANES_AREA,
        title: 'Plan usage',
        data: { placement: 'right', width: '280px' },
        render: () => jsx(UsagePane, {})
      },
      {
        id: 'show',
        area: PALETTE_AREA,
        data: {
          id: 'plan-usage.show',
          label: 'Show plan usage',
          keywords: ['plan', 'usage', 'limits', 'quota', 'claude', 'codex'],
          run: showPane
        }
      },
      {
        id: 'refresh',
        area: PALETTE_AREA,
        data: {
          id: 'plan-usage.refresh',
          label: 'Refresh plan usage',
          keywords: ['plan', 'usage', 'refresh'],
          run: () => void forceRefresh()
        }
      },
      {
        id: 'chip',
        area: STATUSBAR_AREAS.right,
        order: 125,
        render: () => jsx(StatusChip, {})
      }
    ])
  }
}
