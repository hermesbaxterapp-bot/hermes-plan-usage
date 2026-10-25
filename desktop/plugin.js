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
  const header = jsxs('div', {
    className: 'flex items-center gap-2',
    children: [
      jsx('span', { className: 'font-medium text-(--ui-text-primary)', children: p.label }),
      p.plan ? jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: p.plan }) : null,
      p.configured
        ? jsx('span', {
            className: 'ml-auto rounded px-1 text-[0.625rem] uppercase tracking-wide text-(--ui-text-tertiary)',
            style: { border: '1px solid var(--ui-stroke-secondary)' },
            children: 'default'
          })
        : null
    ]
  })

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
    body = providers.map((p, i) =>
      jsxs(
        'div',
        {
          className: 'flex flex-col',
          children: [
            i > 0 ? jsx('div', { className: 'mb-3 h-px', style: { background: 'var(--ui-stroke-tertiary)' } }) : null,
            jsx(ProviderBlock, { p, now })
          ]
        },
        p.provider
      )
    )
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
          jsx(IntervalPicker, {}),
          jsx(RefreshButton, {})
        ]
      }),
      body
    ]
  })
}

// ── status-bar chip ─────────────────────────────────────────────────────────

function StatusChip() {
  const q = useUsage()
  const refreshing = useValue($refreshing)
  const p = (q.data?.providers || []).find(x => x.available && (x.windows || []).length)
  if (!p) return null
  const parts = p.windows.slice(0, 2).map(w => `${leftPct(w)}%`)
  const minLeft = Math.min(...p.windows.map(leftPct))
  const tip = p.windows.map(w => `${windowLabel(w.label)}: ${leftPct(w)}% left`).join(' · ')
  return jsx(Tip, {
    label: `${p.label} — ${tip}. Click to open the pane and refresh.`,
    children: jsxs('button', {
      type: 'button',
      onClick: () => {
        showPane()
        forceRefresh()
      },
      className:
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
      style: minLeft <= 25 ? { color: barColor(minLeft) } : undefined,
      children: [
        jsx(Codicon, { name: refreshing ? 'sync' : 'dashboard', spinning: refreshing, size: 12 }),
        `${p.label} ${parts.join(' · ')}`
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
    ctx.onDispose(() => {
      rest = null
      storage = null
    })
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
