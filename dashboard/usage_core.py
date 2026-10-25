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
        return msg[:240]


def _fetch_one(provider: str) -> dict[str, Any]:
    from agent.account_usage import fetch_account_usage

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


def get(force: bool) -> dict[str, Any]:
    with _lock:
        if not force and _cache["doc"] is not None and time.monotonic() - _cache["at"] < CACHE_S:
            return _cache["doc"]
    doc = collect()
    with _lock:
        _cache["doc"], _cache["at"] = doc, time.monotonic()
    return doc
