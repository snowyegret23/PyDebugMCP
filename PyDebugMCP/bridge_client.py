from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen

from .bridge_info import load_bridge_connection_info
from .errors import BridgeProtocolError, BridgeRemoteError, BridgeUnavailableError


class PyDebugBridgeClient:
    """HTTP client for the local PyDebugBridge bridge."""

    def __init__(self, timeout_sec: float = 10.0) -> None:
        self._timeout_sec = timeout_sec

    async def get_json(
        self,
        path: str,
        *,
        query: dict[str, str | int | None] | None = None,
    ) -> Any:
        return await self.request_json("GET", path, query=query)

    async def post_json(
        self,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
        query: dict[str, str | int | None] | None = None,
    ) -> Any:
        return await self.request_json("POST", path, payload=payload, query=query)

    async def request_json(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, Any] | None = None,
        query: dict[str, str | int | None] | None = None,
    ) -> Any:
        return await asyncio.to_thread(
            self._request_json_sync,
            method,
            path,
            payload,
            query,
        )

    def _request_json_sync(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        query: dict[str, str | int | None] | None,
    ) -> Any:
        info = load_bridge_connection_info()
        url = _build_url(info.bridge_url, path, query)
        body = None if payload is None else json.dumps(_compact_dict(payload)).encode("utf-8")

        request = Request(
            url=url,
            data=body,
            method=method.upper(),
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {info.token}",
                "Content-Type": "application/json",
            },
        )

        try:
            with urlopen(request, timeout=self._timeout_sec) as response:
                raw = response.read()
        except HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")
            raise BridgeRemoteError(
                status_code=exc.code,
                message=f"Bridge request failed for {path}",
                body=error_body,
            ) from exc
        except URLError as exc:
            raise BridgeUnavailableError(f"Failed to connect to PyDebugBridge at {url}") from exc

        if not raw:
            return None

        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise BridgeProtocolError(f"Bridge returned invalid JSON for {path}") from exc


def _build_url(
    bridge_url: str,
    path: str,
    query: dict[str, str | int | None] | None,
) -> str:
    base = bridge_url.rstrip("/") + "/"
    url = urljoin(base, path.lstrip("/"))
    compact_query = _compact_dict(query or {})
    if not compact_query:
        return url
    return f"{url}?{urlencode({key: str(value) for key, value in compact_query.items()})}"


def _compact_dict(payload: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if value is not None}
