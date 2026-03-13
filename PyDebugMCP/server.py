from __future__ import annotations

import logging
from typing import Any

from mcp.server.fastmcp import FastMCP

from .bridge_client import PyDebugBridgeClient
from .bridge_info import get_bridge_info_candidates, load_bridge_connection_info
from .config import ServerConfig

CONFIG = ServerConfig.from_env()

logging.basicConfig(level=getattr(logging, CONFIG.log_level, logging.INFO))
logger = logging.getLogger("pydebug_mcp")

mcp = FastMCP(CONFIG.name)
mcp.settings.host = CONFIG.host
mcp.settings.port = CONFIG.port
mcp.settings.streamable_http_path = CONFIG.path
mcp.settings.log_level = CONFIG.log_level

_bridge_client = PyDebugBridgeClient(timeout_sec=CONFIG.bridge_timeout_sec)


@mcp.tool()
async def get_bridge_status() -> dict[str, Any]:
    """Check whether the local PyDebugBridge is reachable and list known debug sessions."""
    return await _bridge_client.get_json("/state")


@mcp.tool()
async def list_debug_sessions() -> dict[str, Any]:
    """List live debug sessions available from the local PyDebugBridge."""
    state = await _bridge_client.get_json("/state")
    return {
        "activeSessionId": state.get("activeSessionId"),
        "sessions": state.get("sessions", []),
    }


@mcp.tool()
async def get_debug_snapshot(sessionId: str | None = None) -> dict[str, Any]:
    """Read the last captured stack and variable snapshot for a debug session."""
    return await _bridge_client.get_json(
        "/snapshot",
        query={
            "sessionId": sessionId,
        },
    )


@mcp.tool()
async def refresh_debug_snapshot(
    sessionId: str | None = None,
    threadId: int | None = None,
    frameId: int | None = None,
    maxDepth: int | None = None,
    maxFrames: int | None = None,
    maxVariables: int | None = None,
) -> dict[str, Any]:
    """Fetch the latest threads, stack frames, scopes, and variables from the active debug session."""
    return await _bridge_client.post_json(
        "/refresh",
        payload={
            "sessionId": sessionId,
            "threadId": threadId,
            "frameId": frameId,
            "maxDepth": maxDepth,
            "maxFrames": maxFrames,
            "maxVariables": maxVariables,
        },
    )


@mcp.tool()
async def get_debug_console(
    sessionId: str | None = None,
    limit: int | None = None,
) -> Any:
    """Read recent debug output captured from the adapter."""
    return await _bridge_client.get_json(
        "/console",
        query={
            "sessionId": sessionId,
            "limit": limit,
        },
    )


@mcp.tool()
async def evaluate_debug_expression(
    expression: str,
    sessionId: str | None = None,
    frameId: int | None = None,
    context: str | None = None,
) -> dict[str, Any]:
    """Evaluate an expression in the current debug frame."""
    return await _bridge_client.post_json(
        "/evaluate",
        payload={
            "expression": expression,
            "sessionId": sessionId,
            "frameId": frameId,
            "context": context,
        },
    )


@mcp.tool()
async def get_bridge_connection_info() -> dict[str, Any]:
    """Return the current bridge-info source and candidate file locations used by PyDebugMCP."""
    info = load_bridge_connection_info()
    return {
        "bridgeUrl": info.bridge_url,
        "source": info.source,
        "bridgeInfoCandidates": [str(path) for path in get_bridge_info_candidates()],
    }
