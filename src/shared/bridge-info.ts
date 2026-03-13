import * as os from "os";
import * as path from "path";

export const DEFAULT_BRIDGE_PORT = 17001;

export function getBridgeInfoFilePath(): string {
  return path.join(os.homedir(), ".pydebug-bridge", "bridge-info.json");
}

export function getLegacyBridgeInfoFilePath(): string {
  return path.join(os.homedir(), ".pydebug-info-bridge", "bridge-info.json");
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}
