from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
from urllib.parse import urlparse

from .errors import BridgeProtocolError, BridgeUnavailableError

PRIMARY_BRIDGE_INFO_PATH = Path.home() / ".pydebug-bridge" / "bridge-info.json"
LEGACY_BRIDGE_INFO_PATH = Path.home() / ".pydebug-info-bridge" / "bridge-info.json"


@dataclass(frozen=True)
class BridgeConnectionInfo:
    bridge_url: str
    token: str
    source: str


def get_bridge_info_candidates() -> list[Path]:
    if PRIMARY_BRIDGE_INFO_PATH == LEGACY_BRIDGE_INFO_PATH:
        return [PRIMARY_BRIDGE_INFO_PATH]
    return [PRIMARY_BRIDGE_INFO_PATH, LEGACY_BRIDGE_INFO_PATH]


def load_bridge_connection_info() -> BridgeConnectionInfo:
    env_url = (os.getenv("PYDEBUG_BRIDGE_URL") or os.getenv("DEBUG_MCP_BRIDGE_URL") or "").strip()
    env_token = (os.getenv("PYDEBUG_BRIDGE_TOKEN") or os.getenv("DEBUG_MCP_BRIDGE_TOKEN") or "").strip()

    if env_url and env_token:
        _validate_bridge_url(env_url)
        return BridgeConnectionInfo(
            bridge_url=env_url,
            token=env_token,
            source="environment",
        )

    for path in get_bridge_info_candidates():
        if not path.exists():
            continue

        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise BridgeProtocolError(f"Bridge info file is not valid JSON: {path}") from exc

        if not isinstance(payload, dict):
            raise BridgeProtocolError(f"Bridge info file must contain a JSON object: {path}")

        bridge_url = payload.get("bridgeUrl")
        token = payload.get("token")

        if not isinstance(bridge_url, str) or not bridge_url.strip():
            raise BridgeProtocolError(f"Bridge info file is missing bridgeUrl: {path}")
        if not isinstance(token, str) or not token.strip():
            raise BridgeProtocolError(f"Bridge info file is missing token: {path}")

        _validate_bridge_url(bridge_url)

        return BridgeConnectionInfo(
            bridge_url=bridge_url.strip(),
            token=token.strip(),
            source=str(path),
        )

    checked = ", ".join(str(path) for path in get_bridge_info_candidates())
    raise BridgeUnavailableError(
        "PyDebugBridge connection info was not found. "
        f"Checked {checked}. Start the VS Code extension first or set PYDEBUG_BRIDGE_URL and PYDEBUG_BRIDGE_TOKEN."
    )


def _validate_bridge_url(value: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise BridgeProtocolError(f"Invalid bridge URL: {value}")
