"""plan-usage core logic, loaded by plugin_api.py by path and re-loaded whenever
this file changes, so edits take effect without restarting the gateway.

Runs inside the gateway / serve process and calls the same fetchers as
``/usage`` and ``hermes usage``.
"""

from __future__ import annotations

import contextvars
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Optional

# Several desktop windows polling should not each hit the provider APIs
# (Anthropic's OAuth usage endpoint rate-limits); serve recent results from memory.
CACHE_S = 60.0
FETCH_TIMEOUT_S = 25.0

_lock = threading.Lock()
_cache: dict[str, Any] = {"at": 0.0, "doc": None}
# Last good snapshot per provider: a transient failure (429, timeout) keeps
# showing the previous numbers, flagged stale, instead of the provider vanishing.
_last_good: dict[str, dict[str, Any]] = {}

PRETTY = {
    "anthropic": "Claude",
    "openai-codex": "Codex",
    "openrouter": "OpenRouter",
    "opencode-go": "OpenCode Go",
    "minimax-oauth": "MiniMax",
    "kimi-coding": "Kimi",
    "xai-oauth": "Grok",
    "antigravity-oauth": "Antigravity",
    "nous": "Nous Portal",
}


def _configured_provider() -> Optional[str]:
    try:
        from hermes_cli.config import load_config

        model = (load_config() or {}).get("model") or {}
        if isinstance(model, dict):
            return (model.get("provider") or "").strip().lower() or None
    except Exception:
        pass
    return None


def _candidates() -> list[str]:
    names: list[str] = []
    try:
        from agent.account_usage import _USAGE_FETCHERS

        names.extend(_USAGE_FETCHERS.keys())
    except Exception:
        pass
    try:
        from providers import list_providers
        from providers.base import ProviderProfile

        for p in list_providers():
            if type(p).fetch_account_usage is not ProviderProfile.fetch_account_usage:
                names.append(p.name)
    except Exception:
        pass
    configured = _configured_provider()
    if configured:
        names.append(configured)
    names.extend(k for k in EXTRA_FETCHERS if k != "nous" and _pool_key(k))
    try:
        from agent.account_usage import _nous_logged_in

        if _nous_logged_in():
            names.append("nous")
    except Exception:
        pass
    seen: set[str] = set()
    return [n for n in names if n and not (n in seen or seen.add(n))]


def _doc(provider: str, snapshot) -> dict[str, Any]:
    if snapshot is None:
        return {"provider": provider, "label": PRETTY.get(provider, provider), "available": False}
    return {
        "provider": provider,
        "label": PRETTY.get(provider, provider),
        "available": True,
        "title": snapshot.title,
        "plan": snapshot.plan,
        "fetched_at": snapshot.fetched_at.isoformat() if snapshot.fetched_at else None,
        "windows": [
            {
                "label": w.label,
                "used_percent": w.used_percent,
                "resets_at": w.reset_at.isoformat() if w.reset_at else None,
                "detail": w.detail,
            }
            for w in snapshot.windows
        ],
        "details": [str(d) for d in snapshot.details],
        "unavailable_reason": snapshot.unavailable_reason,
    }


def _diagnose(provider: str) -> Optional[str]:
    """fetch_account_usage swallows exceptions; call the raw fetcher to learn why it gave nothing.
    Returns None when the provider simply has no credential (not worth showing)."""
    try:
        from agent.account_usage import _USAGE_FETCHERS

        fetcher = _USAGE_FETCHERS.get(provider)
        if fetcher is None:
            return None
        fetcher(None, None)
        return None  # returned None without raising: no credential configured
    except Exception as exc:
        msg = f"{type(exc).__name__}: {exc}"
        if "no available" in msg.lower() and "credential" in msg.lower():
            return None  # simply not signed in to this provider -- not an error worth showing
        return msg[:240]


def _pool_key(provider: str) -> Optional[str]:
    try:
        from agent.credential_pool import load_pool

        pool = load_pool(provider)
        if not pool:
            return None
        # Read entries directly, NOT select(): a credential benched after a quota 429 is skipped by
        # select(), which is exactly when the usage readout matters most.
        for entry in [pool.peek(), *pool.entries()]:
            if entry is None:
                continue
            key = (getattr(entry, "runtime_api_key", None) or getattr(entry, "access_token", None) or "").strip()
            if key:
                return key
        return None
    except Exception:
        return None


def _http_json(url: str, key: str) -> dict:
    import json
    import urllib.request

    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}", "Accept": "application/json",
                                               "User-Agent": "hermes-plan-usage/0.2"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


def _win(label: str, used_percent: float, resets_at: Optional[str], detail: Optional[str] = None) -> dict:
    return {"label": label, "used_percent": round(max(0.0, min(100.0, float(used_percent))), 1),
            "resets_at": resets_at, "detail": detail}


def _extra_doc(provider: str, windows: list, details: Optional[list] = None, plan: Optional[str] = None) -> dict:
    return {"provider": provider, "label": PRETTY.get(provider, provider), "available": True,
            "title": "Account limits", "plan": plan, "fetched_at": datetime.now(timezone.utc).isoformat(),
            "windows": windows, "details": details or [], "unavailable_reason": None}


def _fetch_kimi() -> Optional[dict]:
    """Kimi Code plan: GET api.kimi.com/coding/v1/usages (undocumented; what Kimi CLI's /usage reads)."""
    key = _pool_key("kimi-coding")
    if not key:
        return None
    body = _http_json("https://api.kimi.com/coding/v1/usages", key)
    windows = []
    ratios = body.get("usages") or {}
    if ratios:
        for k, label in (("limit_5h", "Current session"), ("limit_7d", "Current week")):
            r = ratios.get(k)
            if isinstance(r, dict) and r.get("used_ratio") is not None:
                windows.append(_win(label, float(r["used_ratio"]) * 100, r.get("reset_time")))
    else:  # older response shape: counts
        def pct(d):
            limit = float(d.get("limit") or 0)
            used = d.get("used")
            used = float(used) if used is not None else limit - float(d.get("remaining") or 0)
            return (used / limit * 100) if limit else 0.0
        for entry in body.get("limits") or []:
            d = entry.get("detail") or {}
            windows.append(_win("Current session", pct(d), d.get("resetTime")))
        if body.get("usage"):
            windows.append(_win("Current week", pct(body["usage"]), body["usage"].get("resetTime")))
    level = (((body.get("user") or {}).get("membership") or {}).get("level") or "").replace("LEVEL_", "").title() or None
    return _extra_doc("kimi-coding", windows, plan=level)


def _fetch_minimax() -> Optional[dict]:
    """MiniMax token/coding plan: GET api.minimax.io/v1/token_plan/remains. Reports remaining %."""
    key = _pool_key("minimax-oauth")
    if not key:
        return None
    body = _http_json("https://api.minimax.io/v1/token_plan/remains", key)

    def iso(ms):
        try:
            return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc).isoformat()
        except Exception:
            return None

    windows = []
    for m in body.get("model_remains") or []:
        if m.get("model_name") != "general":
            continue
        if m.get("current_interval_remaining_percent") is not None:
            windows.append(_win("Current session", 100 - float(m["current_interval_remaining_percent"]), iso(m.get("end_time"))))
        if m.get("current_weekly_remaining_percent") is not None:
            windows.append(_win("Current week", 100 - float(m["current_weekly_remaining_percent"]), iso(m.get("weekly_end_time"))))
    return _extra_doc("minimax-oauth", windows) if windows else None


def _fetch_nous() -> Optional[dict]:
    """Nous Portal subscription: Hermes' own portal-account fetch (same numbers as /usage, /topup)."""
    from agent import account_usage as au

    if not au._nous_logged_in():
        return None
    snap = au.build_nous_credits_snapshot(au._fetch_portal_account(15.0))
    if snap is None:
        return None
    doc = _doc("nous", snap)
    renews = None
    details = []
    for d in doc["details"]:
        if d.startswith("Renews:"):
            renews = d.split(":", 1)[1].strip()
        elif not d.lstrip().startswith(("Top up", "(or run", "Subscription credits", "Total usable")):
            details.append(d)
    doc["details"] = details
    for w in doc["windows"]:
        if not w.get("resets_at") and renews:
            w["resets_at"] = renews  # monthly credits refill at renewal
    return doc


def _fetch_anthropic() -> Optional[dict]:
    """Claude plan limits. Replaces Hermes' parser, which scales utilization <= 1 by 100 (so 1% reads 100%).
    Prefers the payload's ``limits`` list (integer percents, includes per-model weekly caps)."""
    from agent import account_usage as au

    tok = (au.resolve_anthropic_token() or "").strip()
    if not tok or not au._is_oauth_token(tok):
        return None
    headers = {"Authorization": f"Bearer {tok}", "Accept": "application/json", "Content-Type": "application/json",
               "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0"}
    p = au._get_json("https://api.anthropic.com/api/oauth/usage", headers, timeout=15.0)
    windows = []
    for lim in p.get("limits") or []:
        if lim.get("percent") is None:
            continue
        kind = lim.get("kind") or ""
        model = (((lim.get("scope") or {}).get("model") or {}).get("display_name") or "").strip()
        if kind == "session":
            label = "Current session"
        elif kind == "weekly_all":
            label = "Current week"
        elif model:
            label = f"Weekly · {model}"
        else:
            label = kind.replace("_", " ").title()
        windows.append(_win(label, float(lim["percent"]), lim.get("resets_at")))
    if not windows:  # older payload: utilization is already a percent — never rescale
        for key, label in (("five_hour", "Current session"), ("seven_day", "Current week"),
                           ("seven_day_opus", "Weekly · Opus"), ("seven_day_sonnet", "Weekly · Sonnet")):
            w = p.get(key) or {}
            if w.get("utilization") is not None:
                windows.append(_win(label, float(w["utilization"]), w.get("resets_at")))
    details = []
    extra = p.get("extra_usage") or {}
    if extra.get("is_enabled") and extra.get("used_credits") is not None and extra.get("monthly_limit") is not None:
        details.append(f"Extra usage: {extra['used_credits']:.2f} / {extra['monthly_limit']:.2f} {extra.get('currency') or 'USD'}")
    return _extra_doc("anthropic", windows, details) if windows else None


def _fetch_codex() -> Optional[dict]:
    """Codex windows. Hermes' fetcher only uses credentials select() returns, so a key benched after a
    quota 429 hides Codex exactly when it is maxed out; fall back to a read-only fetch on the pooled
    entry itself (read_only: never refreshes or rotates the credential)."""
    from agent import account_usage as au

    snap = au.fetch_account_usage("openai-codex")
    if snap is None:
        try:
            from agent.credential_pool import load_pool

            pool = load_pool("openai-codex")
            entries = [e for e in ([pool.peek(), *pool.entries()] if pool else []) if e is not None]
        except Exception:
            entries = []
        for e in entries:
            key = (getattr(e, "runtime_api_key", None) or "").strip()
            if key:
                snap = au._fetch_codex_account_usage_read_only(getattr(e, "runtime_base_url", None), key)
                break
    if snap is None:
        return None
    doc = _doc("openai-codex", snap)
    doc["details"] = [d.replace(" - use /usage reset to activate", " (use /usage reset)") for d in doc["details"]]
    return doc


def _fetch_xai() -> Optional[dict]:
    """SuperGrok / xai-oauth weekly credits pool: GET cli-chat-proxy.grok.com/v1/billing?format=credits
    (the meter Grok Build shows; undocumented). creditUsagePercent is already a percent; protobuf JSON
    omits zero fields, so an absent value with a current period means 0%."""
    key = _pool_key("xai-oauth")
    if not key:
        return None
    import json
    import urllib.request

    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json", "User-Agent": "hermes-plan-usage/0.3",
               "x-grok-client-surface": "grok-build", "x-grok-client-version": "1.0.0"}

    def get(url, timeout):
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as r:
            return json.load(r)

    cfg = (get("https://cli-chat-proxy.grok.com/v1/billing?format=credits", 15) or {}).get("config") or {}
    period = cfg.get("currentPeriod") or {}
    if not period and "creditUsagePercent" not in cfg:
        return None
    ptype = str(period.get("type") or "").upper()
    label = "Current week" if "WEEK" in ptype else "Monthly" if "MONTH" in ptype else "Daily" if "DAY" in ptype else "Period"
    windows = [_win(label, float(cfg.get("creditUsagePercent") or 0), period.get("end") or cfg.get("billingPeriodEnd"))]
    plan = None
    try:  # subscription tier only refines the label
        subs = get("https://grok.com/rest/subscriptions", 5).get("subscriptions") or []
        active = next((s for s in subs if s.get("status") == "SUBSCRIPTION_STATUS_ACTIVE"), None)
        if active and active.get("tier"):
            plan = str(active["tier"]).replace("SUBSCRIPTION_TIER_", "").replace("_", " ").title()
    except Exception:
        pass
    return _extra_doc("xai-oauth", windows, plan=plan)


# Providers Hermes has no (correct) built-in usage fetcher for; these run in place of fetch_account_usage.
EXTRA_FETCHERS = {"kimi-coding": _fetch_kimi, "minimax-oauth": _fetch_minimax, "nous": _fetch_nous,
                  "anthropic": _fetch_anthropic, "openai-codex": _fetch_codex, "xai-oauth": _fetch_xai}


def _fetch_one(provider: str) -> dict[str, Any]:
    from agent.account_usage import fetch_account_usage

    if provider in EXTRA_FETCHERS:
        try:
            out = EXTRA_FETCHERS[provider]()
            err = None
        except Exception as exc:
            out, err = None, f"{type(exc).__name__}: {exc}"[:240]
        if out is not None:
            _last_good[provider] = out
            return out
        out = _doc(provider, None)
        if err:
            prev = _last_good.get(provider)
            if prev is not None:
                out = dict(prev, stale=True)
            out["error"] = err
        return out

    try:
        snap = fetch_account_usage(provider)
    except Exception as exc:
        snap, err = None, f"{type(exc).__name__}: {exc}"[:240]
    else:
        err = None if snap is not None else _diagnose(provider)
    out = _doc(provider, snap)
    if snap is not None:
        _last_good[provider] = out
        return out
    if err:
        prev = _last_good.get(provider)
        if prev is not None:
            out = dict(prev, stale=True)
        out["error"] = err
    return out


def collect() -> dict[str, Any]:
    names = _candidates()
    configured = _configured_provider()
    with ThreadPoolExecutor(max_workers=max(1, len(names))) as pool:
        # Worker threads do not inherit contextvars (profile/home scope) — carry them over.
        futures = {n: pool.submit(contextvars.copy_context().run, _fetch_one, n) for n in names}
        results = []
        for n, fut in futures.items():
            try:
                results.append(fut.result(timeout=FETCH_TIMEOUT_S))
            except Exception:
                results.append({"provider": n, "label": PRETTY.get(n, n), "available": False, "error": "timed out"})
    # Show: providers with data, providers whose fetch errored (signed in but failing),
    # and the configured default. Hide not-signed-in providers.
    shown = [r for r in results if r.get("available")]
    shown += [r for r in results if not r.get("available") and (r.get("error") or r["provider"] == configured)]
    for r in shown:
        r["configured"] = r["provider"] == configured
    return {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "configured_provider": configured,
        "providers": shown,
    }


def session_provider(session_id: str) -> Optional[str]:
    """Provider a stored session last ran on (state.db billing_provider)."""
    if not session_id:
        return None
    try:
        import sqlite3

        from hermes_constants import get_hermes_home

        con = sqlite3.connect(f"file:{get_hermes_home() / 'state.db'}?mode=ro", uri=True, timeout=2)
        try:
            row = con.execute("SELECT billing_provider FROM sessions WHERE id = ?", (session_id,)).fetchone()
        finally:
            con.close()
        return (row[0] or "").strip().lower() or None if row else None
    except Exception:
        return None


def get(force: bool) -> dict[str, Any]:
    with _lock:
        if not force and _cache["doc"] is not None and time.monotonic() - _cache["at"] < CACHE_S:
            return _cache["doc"]
    doc = collect()
    with _lock:
        _cache["doc"], _cache["at"] = doc, time.monotonic()
    return doc
