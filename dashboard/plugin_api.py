"""Backend half of the plan-usage desktop plugin.

Mounted by Hermes' web server at ``/api/plugins/plan-usage`` (only while
``plan-usage`` is in ``plugins.enabled``). The logic lives in ``usage_core.py``,
loaded by path and re-loaded whenever that file's mtime changes, so updates to
it apply without restarting the gateway.

GET /usage            cached snapshot (fresh fetch if older than 60 s)
GET /usage?force=1    always refetch
"""

from __future__ import annotations

import importlib.util
import threading
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool

router = APIRouter()

_CORE_PATH = Path(__file__).resolve().parent / "usage_core.py"
_core_lock = threading.Lock()
_core = {"mtime": None, "mod": None}


def _load_core():
    mtime = _CORE_PATH.stat().st_mtime
    with _core_lock:
        if _core["mod"] is None or _core["mtime"] != mtime:
            spec = importlib.util.spec_from_file_location("hermes_plan_usage_core", _CORE_PATH)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            _core["mod"], _core["mtime"] = mod, mtime
        return _core["mod"]


def _get(force: bool):
    return _load_core().get(force)


@router.get("/usage")
async def usage(force: int = 0):
    try:
        return await run_in_threadpool(_get, bool(force))
    except Exception as exc:
        # 200 + error record: the pane labels it rather than showing a transport failure.
        return {"error": f"{type(exc).__name__}: {exc}"[:300], "providers": [],
                "fetched_at": datetime.now(timezone.utc).isoformat()}
