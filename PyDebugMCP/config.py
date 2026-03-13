from __future__ import annotations

from dataclasses import dataclass
import os


DEFAULT_MCP_HOST = "127.0.0.1"
DEFAULT_MCP_PORT = 17000
DEFAULT_MCP_PATH = "/mcp"


@dataclass(frozen=True)
class ServerConfig:
    name: str
    host: str
    port: int
    path: str
    log_level: str
    bridge_timeout_sec: float

    @classmethod
    def from_env(cls) -> "ServerConfig":
        return cls(
            name=os.getenv("PYDEBUG_MCP_NAME", "PyDebugMCP").strip() or "PyDebugMCP",
            host=os.getenv("PYDEBUG_MCP_HOST", DEFAULT_MCP_HOST).strip() or DEFAULT_MCP_HOST,
            port=_safe_int(os.getenv("PYDEBUG_MCP_PORT"), DEFAULT_MCP_PORT),
            path=_normalize_http_path(os.getenv("PYDEBUG_MCP_PATH", DEFAULT_MCP_PATH)),
            log_level=os.getenv("PYDEBUG_MCP_LOG_LEVEL", "INFO").strip().upper() or "INFO",
            bridge_timeout_sec=max(0.5, _safe_float(os.getenv("PYDEBUG_BRIDGE_TIMEOUT_SEC"), 10.0)),
        )


def _safe_int(raw: str | None, default: int) -> int:
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _safe_float(raw: str | None, default: float) -> float:
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _normalize_http_path(raw: str) -> str:
    value = raw.strip()
    if not value or value == "/":
        return DEFAULT_MCP_PATH
    return value if value.startswith("/") else f"/{value}"
