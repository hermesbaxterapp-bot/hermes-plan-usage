"""plan-usage: no agent-side tools or hooks; the work lives in dashboard/plugin_api.py and desktop/plugin.js."""


def register(ctx):  # noqa: D401 - nothing to register on the agent side
    return None
