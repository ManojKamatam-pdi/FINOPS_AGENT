"""
Central MCP registry — reads from MCP_REGISTRY env var (JSON array).

Each entry:
  {
    "name": "datadog",
    "url": "https://...",
    "transport": "http",          # http | sse | stdio
    "auth": "okta_forward"        # okta_forward | none | env:MY_VAR_NAME
  }

Usage:
  from agents.config.mcp_registry import get_mcp_servers
  mcp_servers = get_mcp_servers(["datadog"], okta_token=okta_token)
"""
import json
import logging
import os

logger = logging.getLogger(__name__)

# Fallback: single Datadog MCP from legacy env var
_LEGACY_DATADOG = {
    "name": "datadog",
    "url": os.getenv("DATADOG_MCP_URL", ""),
    "transport": "http",
    "auth": "okta_forward",
}


def _load_registry() -> list[dict]:
    raw = os.getenv("MCP_REGISTRY", "")
    if not raw:
        # Fall back to legacy single-MCP env var
        if _LEGACY_DATADOG["url"]:
            return [_LEGACY_DATADOG]
        return []
    try:
        entries = json.loads(raw)
        if not isinstance(entries, list):
            raise ValueError("MCP_REGISTRY must be a JSON array")
        return entries
    except Exception as e:
        logger.error("Failed to parse MCP_REGISTRY: %s", e)
        return [_LEGACY_DATADOG] if _LEGACY_DATADOG["url"] else []


def get_mcp_servers(names: list[str], okta_token: str = "") -> dict[str, dict]:
    """
    Returns mcp_servers dict ready to pass to ClaudeAgentOptions.
    Keys are MCP names; values are McpHttpServerConfig dicts.
    Filters registry to requested names, injects auth headers at call time.

    Auth modes:
      - "okta_forward": inject Authorization: Bearer {okta_token}
      - "none": no auth header
      - "env:MY_VAR": inject Authorization: Bearer {value of MY_VAR}

    Example output:
      {
        "datadog": {"type": "http", "url": "https://...", "headers": {"Authorization": "Bearer ..."}}
      }
    """
    registry = _load_registry()
    by_name = {e["name"]: e for e in registry}

    result: dict[str, dict] = {}
    for name in names:
        entry = by_name.get(name)
        if not entry:
            logger.warning("MCP '%s' not found in registry — skipping", name)
            continue

        server: dict = {
            "type": entry.get("transport", "http"),
            "url": entry["url"],
        }

        auth = entry.get("auth", "none")
        if auth == "okta_forward":
            if okta_token:
                server["headers"] = {"Authorization": f"Bearer {okta_token}"}
        elif auth.startswith("env:"):
            var_name = auth[4:]
            api_key = os.getenv(var_name, "")
            if api_key:
                server["headers"] = {"Authorization": f"Bearer {api_key}"}
            else:
                logger.warning("MCP '%s' auth env var '%s' not set", name, var_name)
        # auth == "none": no headers added

        result[name] = server

    return result
