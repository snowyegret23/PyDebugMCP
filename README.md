`English` | [한국어](README_KO.md)

# PyDebugMCP

Live Python debug context for MCP-based automation.

This repository contains two parts:
- `PyDebugMCP`: an external Python MCP server
- `PyDebugBridge`: a VS Code extension that exposes live debug data over local HTTP

The split is intentional:
- the MCP server can stay stable while VS Code reloads or debug sessions restart
- AI clients keep a single MCP endpoint
- the VS Code-side bridge can reconnect independently whenever the editor comes back

## Port layout

This is the part that matters most in practice:
- MCP server: `127.0.0.1:17000` by default
- VS Code bridge: `127.0.0.1:17001` by default

These are different endpoints.
- `--port` or `PYDEBUG_MCP_PORT` changes the MCP server port
- `pyDebugBridge.port` changes the bridge port inside VS Code
- the bridge-info file tells `PyDebugMCP` which bridge URL and bearer token to use

There are also separate transport layers:
- Client -> `PyDebugMCP`: Streamable HTTP or stdio
- `PyDebugMCP` -> `PyDebugBridge`: local HTTP with token authentication

## Repository layout

- `PyDebugMCP`
  The Python MCP package
- `src/extension`
  The VS Code extension source
- `src/shared`
  Shared TypeScript bridge metadata and types
- `.github/workflows/release.yml`
  Release workflow for the VSIX and Python artifacts

## Supported targets

`PyDebugBridge` currently targets:
- VS Code Python debug sessions
- `python` / `debugpy`

It uses standard DAP requests such as `threads`, `stackTrace`, `scopes`, `variables`, and `evaluate`, then adds Python-focused filtering for debugpy payloads.

## Running PyDebugMCP

Create and activate a virtual environment:

```bash
python -m venv .venv
. .venv/Scripts/activate
pip install -e .
```

For PyInstaller or release builds, install the build extra instead:

```bash
pip install -e ".[build]"
```

Run the MCP server on the default HTTP port:

```bash
pydebug-mcp
```

If the `pydebug-mcp` command is not found on Windows, use:

```bash
python -m PyDebugMCP
```

Run it on a different port or path:

```bash
pydebug-mcp --port 8080 --path /mcp
```

Behavior:
- MCP transport: Streamable HTTP by default
- default bind: `127.0.0.1:17000`
- startup failure: prints the error and waits for `Enter` before exiting

## MCP client configuration

Recommended when `pydebug-mcp` is available on `PATH`:

```toml
[mcp_servers.PyDebugMCP]
command = "pydebug-mcp"
args = ["--transport", "stdio"]
startup_timeout_sec = 45
```

If you prefer to invoke the module directly:

```toml
[mcp_servers.PyDebugMCP]
command = "python"
args = ["-m", "PyDebugMCP", "--transport", "stdio"]
startup_timeout_sec = 45
```

If neither `pydebug-mcp` nor `python` is reliably on `PATH`, use an explicit interpreter path:

```toml
[mcp_servers.PyDebugMCP]
command = 'C:\path\to\.venv\Scripts\python.exe'
args = ["-m", "PyDebugMCP", "--transport", "stdio"]
startup_timeout_sec = 45
```

If you built the PyInstaller executable, you can register it directly too:

```toml
[mcp_servers.PyDebugMCP]
command = 'C:\path\to\PyDebugMCP_v1.0.0.exe'
args = ["--transport", "stdio"]
startup_timeout_sec = 45
```

Usually no extra environment variables are needed for MCP clients because `PyDebugBridge` writes bridge connection info to the user profile automatically.

If you want to bypass file-based bridge discovery, provide both of these:

```toml
[mcp_servers.PyDebugMCP.env]
PYDEBUG_BRIDGE_URL = "http://127.0.0.1:17001"
PYDEBUG_BRIDGE_TOKEN = "replace-with-live-token"
```

## Direct execution

You can also run `PyDebugMCP` directly outside MCP client configuration.

When `pydebug-mcp` is available on `PATH`:

```bash
pydebug-mcp
```

When you prefer to invoke the module directly:

```bash
python -m PyDebugMCP
```

To bind on a different port:

```bash
pydebug-mcp --port 8080 --path /mcp
```

If you built the PyInstaller executable, you can launch it directly as well:

```powershell
& "C:\path\to\PyDebugMCP_v1.0.0.exe"
```

In all of these direct-launch cases, `PyDebugMCP` starts its Streamable HTTP server.

If you need stdio instead, pass `--transport stdio`.

## Bridge discovery

`PyDebugMCP` resolves bridge connection info in this order:

1. `PYDEBUG_BRIDGE_URL` + `PYDEBUG_BRIDGE_TOKEN`
2. `DEBUG_MCP_BRIDGE_URL` + `DEBUG_MCP_BRIDGE_TOKEN`
3. `~/.pydebug-bridge/bridge-info.json`
4. `~/.pydebug-info-bridge/bridge-info.json`

That means the new path is preferred, while the legacy path still works as a fallback.

## Building and installing PyDebugBridge

Install dependencies and build the extension:

```bash
npm install
npm run build
```

Package the VSIX:

```bash
npx @vscode/vsce package --no-dependencies --allow-missing-repository --out PyDebugBridge-v1.0.0.vsix
```

Install it into VS Code:

```bash
code --install-extension .\PyDebugBridge-v1.0.0.vsix --force
```

If `code` is not on `PATH`, either use VS Code's `code.cmd` directly or install the VSIX from the Extensions view.

## Using PyDebugBridge in VS Code

Typical flow:
- install the extension or run it from an Extension Development Host
- start a Python debug session in VS Code
- when execution stops, `PyDebugBridge` writes `~/.pydebug-bridge/bridge-info.json`
- the Variables view shows the `현재 모든 디버그 정보 복사` button while Python/debugpy is paused

The copy command includes:
- session summary
- stack frames and variable snapshot
- recent debug console output
- VS Code breakpoints
- current editor file and selection

## Environment variables

- `PYDEBUG_MCP_NAME`
  Default: `PyDebugMCP`
- `PYDEBUG_MCP_HOST`
  Default: `127.0.0.1`
- `PYDEBUG_MCP_PORT`
  Default: `17000`
- `PYDEBUG_MCP_PATH`
  Default: `/mcp`
- `PYDEBUG_MCP_LOG_LEVEL`
  Default: `INFO`
- `PYDEBUG_BRIDGE_TIMEOUT_SEC`
  Default: `10.0`
- `PYDEBUG_BRIDGE_URL`
  Optional explicit bridge URL override
- `PYDEBUG_BRIDGE_TOKEN`
  Optional explicit bridge token override
- `DEBUG_MCP_BRIDGE_URL`
  Legacy bridge URL alias
- `DEBUG_MCP_BRIDGE_TOKEN`
  Legacy bridge token alias

## Release assets

The GitHub release workflow produces:
- `PyDebugBridge-vx.x.x.vsix`
- `PyDebugMCP-vx.x.x.tar.gz`
- `PyDebugMCP-vx.x.x-py3-none-any.whl`
- `PyDebugMCP_vx.x.x.exe`
- `SHA256SUMS.txt`

## MCP tool surface

Connection and status:
- `get_bridge_status`
- `get_bridge_connection_info`

Sessions and snapshots:
- `list_debug_sessions`
- `refresh_debug_snapshot`
- `get_debug_snapshot`

Console and evaluation:
- `get_debug_console`
- `evaluate_debug_expression`

## Example workflow

Find the locals in the current paused Python frame:

User prompt:

```text
Show me the variables in the current paused frame.
```

Typical tool flow:

```json
PyDebugMCP.list_debug_sessions({})
```

```json
PyDebugMCP.refresh_debug_snapshot({})
```

```json
PyDebugMCP.get_debug_snapshot({})
```

Typical result summary:
- active Python/debugpy session
- current source file and frame line
- filtered locals first
- reduced debugpy noise for top-level Python internals

## Limitations and security

- The project is optimized for Python/debugpy, not every VS Code debugger.
- Some objects may fail to fully materialize if the target runtime data is incomplete or adapter-side reads are fragile.
- `evaluate` can have side effects depending on the debugger and language runtime.
- Snapshots enforce depth and item limits to keep payload size under control.
- `PyDebugBridge` only listens on `127.0.0.1` and requires a bearer token.
