"""Backend half of the plan-usage desktop plugin.

Mounted by Hermes' web server at ``/api/plugins/plan-usage`` (only while
``plan-usage`` is in ``plugins.enabled``). It runs inside the gateway / serve
process, so it calls ``agent.account_usage.fetch_account_usage`` directly -- the
same fetch ``/usage`` and ``hermes usage`` use -- for every provider that can
report subscription windows, plus the configured default provider.

GET /usage            cached snapshot (fresh fetch if older than CACHE_S)
GET /usage?force=1    always refetch
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool

router = APIRouter()

# Several desktop windows (laptop + this box) polling should not each hit the
# provider APIs; anything younger than this is served from memory.
CACHE_S = 60.0
FETCH_TIMEOUT_S = 25.0

_lock = threading.Lock()
_cache: dict[str, Any] = {"at": 0.0, "doc": None}

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


def _fetch_one(provider: str) -> dict[str, Any]:
    from agent.account_usage import fetch_account_usage

    try:
        return _doc(provider, fetch_account_usage(provider))
    except Exception as exc:  # fetch_account_usage fails open, but be defensive
        out = _doc(provider, None)
        out["error"] = str(exc)[:200]
        return out


def _collect() -> dict[str, Any]:
    names = _candidates()
    configured = _configured_provider()
    with ThreadPoolExecutor(max_workers=max(1, len(names))) as pool:
        futures = {n: pool.submit(_fetch_one, n) for n in names}
        results = []
        for n, fut in futures.items():
            try:
                results.append(fut.result(timeout=FETCH_TIMEOUT_S))
            except Exception:
                results.append({"provider": n, "label": PRETTY.get(n, n), "available": False, "error": "timed out"})
    # Providers with data first; among the rest only show the configured one
    # (an unconfigured Codex/OpenRouter just means "not signed in" -- noise).
    shown = [r for r in results if r["available"]]
    shown += [r for r in results if not r["available"] and r["provider"] == configured]
    for r in shown:
        r["configured"] = r["provider"] == configured
    return {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "configured_provider": configured,
        "providers": shown,
    }


def _get(force: bool) -> dict[str, Any]:
    with _lock:
        if not force and _cache["doc"] is not None and time.monotonic() - _cache["at"] < CACHE_S:
            return _cache["doc"]
    doc = _collect()
    with _lock:
        _cache["doc"], _cache["at"] = doc, time.monotonic()
    return doc


@router.get("/usage")
async def usage(force: int = 0):
    try:
        return await run_in_threadpool(_get, bool(force))
    except Exception as exc:
        # 200 + error record: the pane labels it rather than showing a transport failure.
        return {"error": str(exc)[:300], "providers": [], "fetched_at": datetime.now(timezone.utc).isoformat()}
