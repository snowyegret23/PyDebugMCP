[English](README.md) | `한국어`

# PyDebugMCP

MCP 기반 자동화를 위한 실시간 Python 디버그 컨텍스트 도구입니다.

이 저장소는 두 부분으로 구성됩니다.
- `PyDebugMCP`: 외부에서 실행하는 Python MCP 서버
- `PyDebugBridge`: 실시간 디버그 데이터를 로컬 HTTP로 노출하는 VS Code 확장

이 구조를 분리한 이유는 명확합니다.
- VS Code가 리로드되거나 디버그 세션이 다시 시작돼도 MCP 서버는 안정적으로 유지될 수 있습니다.
- AI 클라이언트는 하나의 MCP 엔드포인트만 연결하면 됩니다.
- VS Code 쪽 브리지는 에디터 상태에 맞춰 독립적으로 다시 연결될 수 있습니다.

## 포트 구성

실사용에서 가장 중요한 부분입니다.
- MCP 서버: 기본값 `127.0.0.1:17000`
- VS Code 브리지: 기본값 `127.0.0.1:17001`

이 둘은 서로 다른 엔드포인트입니다.
- `--port` 또는 `PYDEBUG_MCP_PORT`는 MCP 서버 포트를 바꿉니다.
- `pyDebugBridge.port`는 VS Code 내부 브리지 포트를 바꿉니다.
- 브리지 정보 파일은 `PyDebugMCP`가 어떤 브리지 URL과 토큰을 써야 하는지 알려줍니다.

전송 계층도 따로 나뉩니다.
- 클라이언트 -> `PyDebugMCP`: Streamable HTTP 또는 stdio
- `PyDebugMCP` -> `PyDebugBridge`: 토큰 인증을 사용하는 로컬 HTTP

## 저장소 구성

- `PyDebugMCP`
  Python MCP 패키지
- `src/extension`
  VS Code 확장 소스
- `src/shared`
  브리지 메타데이터와 타입을 공유하는 TypeScript 코드
- `.github/workflows/release.yml`
  VSIX와 Python 배포본을 만드는 릴리즈 워크플로

## 지원 대상

현재 `PyDebugBridge`는 다음을 주 대상으로 합니다.
- VS Code Python 디버그 세션
- `python` / `debugpy`

내부적으로 `threads`, `stackTrace`, `scopes`, `variables`, `evaluate` 같은 표준 DAP 요청을 사용하고, debugpy에 맞춘 Python 전용 필터링을 추가합니다.

## PyDebugMCP 실행

가상환경 생성 및 활성화:

```bash
python -m venv .venv
. .venv/Scripts/activate
pip install -e .
```

PyInstaller나 릴리즈 빌드를 할 때는 build extra로 설치하세요:

```bash
pip install -e ".[build]"
```

기본 HTTP 포트로 MCP 서버 실행:

```bash
pydebug-mcp
```

Windows에서 `pydebug-mcp` 명령이 인식되지 않으면 다음처럼 실행하면 됩니다.

```bash
python -m PyDebugMCP
```

다른 포트나 경로로 실행:

```bash
pydebug-mcp --port 8080 --path /mcp
```

동작 방식:
- 기본 MCP transport: Streamable HTTP
- 기본 바인드: `127.0.0.1:17000`
- 시작 실패 시: 오류를 출력하고 `Enter` 입력을 기다린 뒤 종료

## MCP 클라이언트 설정 예시

`pydebug-mcp`가 `PATH`에 잡혀 있다면 이 방식이 가장 간단합니다.

```toml
[mcp_servers.PyDebugMCP]
command = "pydebug-mcp"
args = ["--transport", "stdio"]
startup_timeout_sec = 45
```

모듈을 직접 실행하고 싶다면:

```toml
[mcp_servers.PyDebugMCP]
command = "python"
args = ["-m", "PyDebugMCP", "--transport", "stdio"]
startup_timeout_sec = 45
```

`pydebug-mcp`나 `python`이 `PATH`에 안정적으로 없으면, 명시적 인터프리터 경로를 사용하면 됩니다.

```toml
[mcp_servers.PyDebugMCP]
command = 'C:\path\to\.venv\Scripts\python.exe'
args = ["-m", "PyDebugMCP", "--transport", "stdio"]
startup_timeout_sec = 45
```

PyInstaller 실행 파일을 만들었다면 그것도 직접 등록할 수 있습니다.

```toml
[mcp_servers.PyDebugMCP]
command = 'C:\path\to\PyDebugMCP_v1.0.0.exe'
args = ["--transport", "stdio"]
startup_timeout_sec = 45
```

보통은 추가 환경 변수 없이도 됩니다. `PyDebugBridge`가 사용자 프로필에 브리지 연결 정보를 자동으로 기록하기 때문입니다.

파일 기반 탐색을 우회하고 싶다면 아래 두 값을 같이 넘기면 됩니다.

```toml
[mcp_servers.PyDebugMCP.env]
PYDEBUG_BRIDGE_URL = "http://127.0.0.1:17001"
PYDEBUG_BRIDGE_TOKEN = "replace-with-live-token"
```

## 직접 실행

MCP 클라이언트 설정과 별개로 `PyDebugMCP` 자체를 직접 실행할 수도 있습니다.

`pydebug-mcp`가 `PATH`에 있을 때:

```bash
pydebug-mcp
```

모듈을 직접 실행할 때:

```bash
python -m PyDebugMCP
```

다른 포트로 띄울 때:

```bash
pydebug-mcp --port 8080 --path /mcp
```

PyInstaller로 만든 실행 파일이 있다면 그것도 직접 실행할 수 있습니다.

```powershell
& "C:\path\to\PyDebugMCP_v1.0.0.exe"
```

이 직접 실행 방식들은 모두 `PyDebugMCP`의 Streamable HTTP 서버를 시작합니다.

`stdio`가 필요하면 `--transport stdio`를 명시적으로 넘기면 됩니다.

## 브리지 탐색 순서

`PyDebugMCP`는 아래 순서로 브리지 연결 정보를 찾습니다.

1. `PYDEBUG_BRIDGE_URL` + `PYDEBUG_BRIDGE_TOKEN`
2. `DEBUG_MCP_BRIDGE_URL` + `DEBUG_MCP_BRIDGE_TOKEN`
3. `~/.pydebug-bridge/bridge-info.json`
4. `~/.pydebug-info-bridge/bridge-info.json`

즉 새 경로를 우선 사용하고, 예전 경로는 fallback으로만 유지합니다.

## PyDebugBridge 빌드 및 설치

의존성을 설치하고 확장을 빌드합니다.

```bash
npm install
npm run build
```

VSIX 패키징:

```bash
npx @vscode/vsce package --no-dependencies --allow-missing-repository --out PyDebugBridge-v1.0.0.vsix
```

VS Code에 설치:

```bash
code --install-extension .\PyDebugBridge-v1.0.0.vsix --force
```

`code`가 `PATH`에 없으면 VS Code의 `code.cmd`를 직접 쓰거나 확장 뷰에서 VSIX 설치를 사용하면 됩니다.

## VS Code에서 PyDebugBridge 사용

일반적인 흐름:
- 확장을 설치하거나 Extension Development Host에서 실행합니다.
- VS Code에서 Python 디버그 세션을 시작합니다.
- 실행이 멈추면 `PyDebugBridge`가 `~/.pydebug-bridge/bridge-info.json` 파일을 기록합니다.
- Python/debugpy가 pause 상태일 때 Variables 뷰에 `현재 모든 디버그 정보 복사` 버튼이 나타납니다.

복사 명령에 포함되는 내용:
- 세션 요약
- 스택 프레임과 변수 스냅샷
- 최근 디버그 콘솔 출력
- VS Code 브레이크포인트
- 현재 에디터 파일과 선택 영역

## 환경 변수

- `PYDEBUG_MCP_NAME`
  기본값: `PyDebugMCP`
- `PYDEBUG_MCP_HOST`
  기본값: `127.0.0.1`
- `PYDEBUG_MCP_PORT`
  기본값: `17000`
- `PYDEBUG_MCP_PATH`
  기본값: `/mcp`
- `PYDEBUG_MCP_LOG_LEVEL`
  기본값: `INFO`
- `PYDEBUG_BRIDGE_TIMEOUT_SEC`
  기본값: `10.0`
- `PYDEBUG_BRIDGE_URL`
  선택적 브리지 URL 강제 지정
- `PYDEBUG_BRIDGE_TOKEN`
  선택적 브리지 토큰 강제 지정
- `DEBUG_MCP_BRIDGE_URL`
  레거시 브리지 URL 별칭
- `DEBUG_MCP_BRIDGE_TOKEN`
  레거시 브리지 토큰 별칭

## 릴리즈 산출물

GitHub 릴리즈 워크플로는 다음 파일을 생성합니다.
- `PyDebugBridge-vx.x.x.vsix`
- `PyDebugMCP-vx.x.x.tar.gz`
- `PyDebugMCP-vx.x.x-py3-none-any.whl`
- `PyDebugMCP_vx.x.x.exe`
- `SHA256SUMS.txt`

## MCP 도구 구성

연결과 상태:
- `get_bridge_status`
- `get_bridge_connection_info`

세션과 스냅샷:
- `list_debug_sessions`
- `refresh_debug_snapshot`
- `get_debug_snapshot`

콘솔과 평가:
- `get_debug_console`
- `evaluate_debug_expression`

## 사용 예시

현재 pause된 Python 프레임의 변수를 확인하기:

사용자 프롬프트:

```text
Show me the variables in the current paused frame.
```

일반적인 호출 흐름:

```json
PyDebugMCP.list_debug_sessions({})
```

```json
PyDebugMCP.refresh_debug_snapshot({})
```

```json
PyDebugMCP.get_debug_snapshot({})
```

결과 요약:
- 활성 Python/debugpy 세션
- 현재 소스 파일과 프레임 위치
- 정리된 로컬 변수 우선 표시
- top-level Python 내부값 노이즈 축소

## 제약과 보안

- 이 프로젝트는 모든 VS Code 디버거가 아니라 Python/debugpy에 맞춰 최적화되어 있습니다.
- 일부 객체는 런타임 데이터 상태나 어댑터 한계 때문에 완전히 펼쳐지지 않을 수 있습니다.
- `evaluate`는 디버거나 런타임에 따라 부작용이 있을 수 있습니다.
- 스냅샷은 payload 크기 제어를 위해 depth와 개수 제한을 둡니다.
- `PyDebugBridge`는 `127.0.0.1`에서만 열리고 bearer token을 요구합니다.
