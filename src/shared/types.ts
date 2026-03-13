export type SessionStatus = "starting" | "running" | "paused" | "terminated" | "error";

export interface DebugSourceSummary {
  name?: string;
  path?: string;
  reference?: number;
}

export interface VariableSnapshot {
  name: string;
  value: string;
  type?: string;
  evaluateName?: string;
  variablesReference?: number;
  namedVariables?: number;
  indexedVariables?: number;
  children?: VariableSnapshot[];
  childrenTruncated?: boolean;
}

export interface ScopeSnapshot {
  name: string;
  expensive?: boolean;
  presentationHint?: string;
  variablesReference: number;
  variables: VariableSnapshot[];
}

export interface StackFrameSnapshot {
  id: number;
  name: string;
  line: number;
  column: number;
  source?: DebugSourceSummary;
  presentationHint?: string;
  scopes: ScopeSnapshot[];
}

export interface ThreadSnapshot {
  id: number;
  name: string;
  frames: StackFrameSnapshot[];
}

export interface ConsoleEntry {
  timestamp: string;
  category?: string;
  output: string;
  source?: string;
}

export interface DebugSnapshot {
  capturedAt: string;
  sessionId: string;
  sessionName: string;
  sessionType: string;
  status: SessionStatus;
  stopReason?: string;
  activeThreadId?: number;
  activeFrameId?: number;
  threads: ThreadSnapshot[];
  consoleTail: ConsoleEntry[];
}

export interface SessionSummary {
  sessionId: string;
  sessionName: string;
  sessionType: string;
  configurationName?: string;
  status: SessionStatus;
  startedAt: string;
  updatedAt: string;
  stopReason?: string;
  lastError?: string;
  activeThreadId?: number;
  activeFrameId?: number;
  hasSnapshot: boolean;
}

export interface BridgeStatePayload {
  bridgeUrl: string;
  startedAt: string;
  activeSessionId?: string;
  sessions: SessionSummary[];
}

export interface RefreshRequest {
  sessionId?: string;
  threadId?: number;
  frameId?: number;
  maxDepth?: number;
  maxFrames?: number;
  maxVariables?: number;
}

export interface EvaluateRequest {
  sessionId?: string;
  frameId?: number;
  expression: string;
  context?: string;
}

export interface EvaluateResponse {
  capturedAt: string;
  result: string;
  type?: string;
  presentationHint?: unknown;
  variablesReference?: number;
  namedVariables?: number;
  indexedVariables?: number;
  children?: VariableSnapshot[];
  childrenTruncated?: boolean;
}

export interface BridgeInfoFile {
  bridgeUrl: string;
  token: string;
  startedAt: string;
  updatedAt: string;
  processId: number;
  workspaceFolders: string[];
}
