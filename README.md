# plan-usage — Hermes plugin

A dockable Hermes Desktop pane (plus a status-bar chip) showing subscription plan limits per provider —
5-hour / weekly windows, credits — the same data as `/usage` and `hermes usage`.

- `dashboard/plugin_api.py` — backend, runs inside the gateway/serve process: `GET /api/plugins/plan-usage/usage[?force=1]`
  (60 s server-side cache; `force=1` bypasses it). Queries every provider with a usage fetcher plus the configured default.
- `desktop/plugin.js` — the pane: one block per provider, bar per window (% left), reset times, refresh interval
  picker (1/5/10/15/30/60 min, default 10, stored per desktop), ↻ refresh-now button. Chip: click to refresh.

## Install

On the Hermes host (agent half + backend):

```bash
hermes plugins install hermesbaxterapp-bot/hermes-plan-usage
hermes plugins enable plan-usage
```

Desktop app connected to a **remote** backend: Capabilities → Plugins → Install from Git →
`hermesbaxterapp-bot/hermes-plan-usage`, tick the Desktop target, then switch it on.
