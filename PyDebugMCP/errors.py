class BridgeError(Exception):
    """Base class for bridge-related errors."""


class BridgeUnavailableError(BridgeError):
    """Raised when the local PyDebugBridge cannot be reached."""


class BridgeProtocolError(BridgeError):
    """Raised when the bridge returns malformed data."""


class BridgeRemoteError(BridgeError):
    """Raised when the bridge responds with a non-success HTTP status."""

    def __init__(self, status_code: int, message: str, body: object | None = None) -> None:
        super().__init__(f"[{status_code}] {message}")
        self.status_code = status_code
        self.message = message
        self.body = body
