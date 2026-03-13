from __future__ import annotations

import argparse
import sys
import traceback

from .config import DEFAULT_MCP_HOST, DEFAULT_MCP_PATH, DEFAULT_MCP_PORT
from .server import mcp


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run PyDebugMCP.")
    parser.add_argument(
        "--transport",
        choices=("streamable-http", "stdio"),
        default="streamable-http",
        help="MCP transport to run. Default is streamable-http.",
    )
    parser.add_argument(
        "--host",
        default=DEFAULT_MCP_HOST,
        help=f"Host for streamable-http transport. Default is {DEFAULT_MCP_HOST}.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_MCP_PORT,
        help=f"Port for streamable-http transport. Default is {DEFAULT_MCP_PORT}.",
    )
    parser.add_argument(
        "--path",
        default=DEFAULT_MCP_PATH,
        help=f"HTTP path for streamable-http transport. Default is {DEFAULT_MCP_PATH}.",
    )
    args = parser.parse_args(argv)

    if args.transport == "streamable-http" and not (1 <= args.port <= 65535):
        parser.error("--port must be between 1 and 65535.")

    return args


def _wait_for_exit(exc: BaseException) -> None:
    print("PyDebugMCP failed to start.", file=sys.stderr)
    traceback.print_exception(type(exc), exc, exc.__traceback__)
    try:
        input("Press Enter to exit...")
    except EOFError:
        pass


def main(argv: list[str] | None = None) -> None:
    args = _parse_args(argv)

    if args.transport == "streamable-http":
        mcp.settings.host = args.host
        mcp.settings.port = args.port
        mcp.settings.streamable_http_path = args.path if args.path.startswith("/") else f"/{args.path}"

    try:
        mcp.run(transport=args.transport)
    except KeyboardInterrupt:
        return
    except BaseException as exc:
        _wait_for_exit(exc)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
