import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";

import { DEFAULT_BRIDGE_PORT, getBridgeInfoFilePath, toErrorMessage } from "../shared/bridge-info";
import type {
  BridgeInfoFile,
  BridgeStatePayload,
  ConsoleEntry,
  DebugSnapshot,
  EvaluateRequest,
  EvaluateResponse,
  RefreshRequest,
  ScopeSnapshot,
  SessionStatus,
  SessionSummary,
  StackFrameSnapshot,
  ThreadSnapshot,
  VariableSnapshot
} from "../shared/types";

interface DapProtocolMessage {
  type?: string;
  event?: string;
  body?: Record<string, unknown>;
  success?: boolean;
  message?: string;
}

interface SessionRuntimeState {
  session: vscode.DebugSession;
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
  snapshot?: DebugSnapshot;
  consoleEntries: ConsoleEntry[];
}

interface VariableLoadContext {
  session: vscode.DebugSession;
  filterPythonInternals: boolean;
  scopeName?: string;
  path: string[];
}

class DebugBridge implements vscode.DebugAdapterTrackerFactory, vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel("PyDebugBridge");
  private readonly sessions = new Map<string, SessionRuntimeState>();
  private readonly startedAt = new Date().toISOString();
  private readonly token = crypto.randomBytes(24).toString("hex");
  private readonly bridgeInfoPath = getBridgeInfoFilePath();

  private server?: http.Server;
  private activeSessionId?: string;
  private bridgeUrl = "";

  async start(): Promise<void> {
    const config = vscode.workspace.getConfiguration("pyDebugBridge");
    const configuredPort = config.get<number>("port", DEFAULT_BRIDGE_PORT);
    const port = Number.isInteger(configuredPort) ? configuredPort : DEFAULT_BRIDGE_PORT;

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        reject(new Error("Server was not created."));
        return;
      }

      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => resolve());
    });

    this.bridgeUrl = `http://127.0.0.1:${port}`;
    this.writeBridgeInfoFile();
    this.output.appendLine(`Bridge listening on ${this.bridgeUrl}`);
    this.output.appendLine(`Bridge info file: ${this.bridgeInfoPath}`);
  }

  getConnectionInfo(): { bridgeInfoFile: string; bridgeUrl: string } {
    return {
      bridgeInfoFile: this.bridgeInfoPath,
      bridgeUrl: this.bridgeUrl
    };
  }

  createDebugAdapterTracker(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterTracker> {
    this.ensureSession(session, "running");

    return {
      onDidSendMessage: (message: unknown) => {
        void this.handleAdapterMessage(session, message as DapProtocolMessage);
      },
      onError: (error) => {
        const state = this.ensureSession(session, "error");
        state.lastError = error.message;
        state.updatedAt = new Date().toISOString();
        this.output.appendLine(`[${state.sessionName}] tracker error: ${error.message}`);
      },
      onExit: (code, signal) => {
        const state = this.ensureSession(session, "terminated");
        state.updatedAt = new Date().toISOString();
        this.output.appendLine(`[${state.sessionName}] tracker exited (code=${code ?? "n/a"}, signal=${signal ?? "n/a"})`);
      }
    };
  }

  markTerminated(session: vscode.DebugSession): void {
    const state = this.ensureSession(session, "terminated");
    state.status = "terminated";
    state.updatedAt = new Date().toISOString();
  }

  async refreshSnapshot(request: RefreshRequest): Promise<DebugSnapshot> {
    const state = this.resolveSession(request.sessionId);
    const session = state.session;
    const config = vscode.workspace.getConfiguration("pyDebugBridge");

    const maxFrames = clampInteger(request.maxFrames, 1, 50, config.get<number>("maxStackFrames", 5));
    const maxDepth = clampInteger(request.maxDepth, 0, 5, config.get<number>("maxVariableDepth", 2));
    const maxVariables = clampInteger(request.maxVariables, 1, 500, config.get<number>("maxVariablesPerScope", 50));

    const threadsResponse = (await session.customRequest("threads")) as { threads?: Array<Record<string, unknown>> };
    const rawThreads = Array.isArray(threadsResponse.threads) ? threadsResponse.threads : [];
    const orderedThreads = orderThreads(rawThreads, request.threadId ?? state.activeThreadId);

    const threadSnapshots: ThreadSnapshot[] = [];
    for (const rawThread of orderedThreads) {
      const threadId = toNumber(rawThread.id);
      if (threadId === undefined) {
        continue;
      }

      const stackTraceResponse = (await session.customRequest("stackTrace", {
        threadId,
        startFrame: 0,
        levels: maxFrames
      })) as { stackFrames?: Array<Record<string, unknown>> };

      const rawFrames = Array.isArray(stackTraceResponse.stackFrames) ? stackTraceResponse.stackFrames : [];
      const frameSnapshots: StackFrameSnapshot[] = [];

      for (const rawFrame of rawFrames) {
        const frameId = toNumber(rawFrame.id);
        if (frameId === undefined) {
          continue;
        }

        const scopesResponse = (await session.customRequest("scopes", { frameId })) as {
          scopes?: Array<Record<string, unknown>>;
        };
        const rawScopes = Array.isArray(scopesResponse.scopes) ? scopesResponse.scopes : [];
        const orderedScopes = this.orderScopes(session, rawScopes);

        const scopes: ScopeSnapshot[] = [];
        for (const rawScope of orderedScopes) {
          const scopeName = toStringValue(rawScope.name) ?? "scope";
          const variablesReference = toNumber(rawScope.variablesReference) ?? 0;
          const variables = await this.loadVariables(session, variablesReference, maxDepth, maxVariables, {
            session,
            filterPythonInternals: this.shouldFilterPythonInternals(session),
            scopeName,
            path: []
          });

          scopes.push({
            name: scopeName,
            expensive: toBoolean(rawScope.expensive),
            presentationHint: toStringValue(rawScope.presentationHint),
            variablesReference,
            variables
          });
        }

        const compactedScopes = this.compactScopesForDisplay(session, scopes);

        const source = asRecord(rawFrame.source);
        frameSnapshots.push({
          id: frameId,
          name: toStringValue(rawFrame.name) ?? "frame",
          line: toNumber(rawFrame.line) ?? 0,
          column: toNumber(rawFrame.column) ?? 0,
          source: source
            ? {
                name: toStringValue(source.name),
                path: toStringValue(source.path),
                reference: toNumber(source.sourceReference)
              }
            : undefined,
          presentationHint: toStringValue(rawFrame.presentationHint),
          scopes: compactedScopes
        });
      }

      threadSnapshots.push({
        id: threadId,
        name: toStringValue(rawThread.name) ?? `thread-${threadId}`,
        frames: frameSnapshots
      });
    }

    state.activeThreadId = request.threadId ?? state.activeThreadId ?? threadSnapshots[0]?.id;
    state.activeFrameId = request.frameId ?? state.activeFrameId ?? threadSnapshots[0]?.frames[0]?.id;
    state.status = state.status === "terminated" ? state.status : "paused";
    state.updatedAt = new Date().toISOString();

    const snapshot: DebugSnapshot = {
      capturedAt: state.updatedAt,
      sessionId: state.sessionId,
      sessionName: state.sessionName,
      sessionType: state.sessionType,
      status: state.status,
      stopReason: state.stopReason,
      activeThreadId: state.activeThreadId,
      activeFrameId: state.activeFrameId,
      threads: threadSnapshots,
      consoleTail: this.getFilteredConsoleEntries(state, 50)
    };

    state.snapshot = snapshot;
    return snapshot;
  }

  async evaluate(request: EvaluateRequest): Promise<EvaluateResponse> {
    const state = this.resolveSession(request.sessionId);
    const frameId = request.frameId ?? state.activeFrameId ?? state.snapshot?.threads[0]?.frames[0]?.id;

    if (!request.expression.trim()) {
      throw new Error("expression is required");
    }

    const response = (await state.session.customRequest("evaluate", {
      expression: request.expression,
      frameId,
      context: request.context ?? "watch"
    })) as Record<string, unknown>;

    const variablesReference = toNumber(response.variablesReference);
    const maxVariables = clampInteger(
      undefined,
      1,
      500,
      vscode.workspace.getConfiguration("pyDebugBridge").get<number>("maxVariablesPerScope", 50)
    );

    const children =
      variablesReference && variablesReference > 0
        ? await this.loadVariables(state.session, variablesReference, 1, maxVariables, {
            session: state.session,
            filterPythonInternals: false,
            path: []
          })
        : undefined;

    return {
      capturedAt: new Date().toISOString(),
      result: toStringValue(response.result) ?? "",
      type: toStringValue(response.type),
      presentationHint: response.presentationHint,
      variablesReference,
      namedVariables: toNumber(response.namedVariables),
      indexedVariables: toNumber(response.indexedVariables),
      children,
      childrenTruncated: Boolean(variablesReference && variablesReference > 0 && !children?.length)
    };
  }

  async buildClipboardPayload(): Promise<Record<string, unknown>> {
    const state = this.resolveSession();
    const config = vscode.workspace.getConfiguration("pyDebugBridge");
    const snapshot = await this.refreshSnapshot({
      sessionId: state.sessionId,
      threadId: state.activeThreadId,
      frameId: state.activeFrameId,
      maxFrames: config.get<number>("copyCommandMaxStackFrames", 8),
      maxDepth: config.get<number>("copyCommandMaxVariableDepth", 3),
      maxVariables: config.get<number>("copyCommandMaxVariablesPerScope", 100)
    });

    const editor = vscode.window.activeTextEditor;
    const selectedText = editor?.selection.isEmpty ? undefined : editor?.document.getText(editor.selection);

    return {
      capturedAt: new Date().toISOString(),
      producer: "PyDebugBridge",
      session: {
        sessionId: state.sessionId,
        sessionName: state.sessionName,
        sessionType: state.sessionType,
        configurationName: state.configurationName,
        stopReason: state.stopReason,
        status: state.status,
        activeThreadId: state.activeThreadId,
        activeFrameId: state.activeFrameId
      },
      editorContext: editor
        ? {
            fileName: editor.document.fileName,
            languageId: editor.document.languageId,
            selection: {
              startLine: editor.selection.start.line + 1,
              startCharacter: editor.selection.start.character + 1,
              endLine: editor.selection.end.line + 1,
              endCharacter: editor.selection.end.character + 1
            },
            selectedText
          }
        : undefined,
      breakpoints: serializeBreakpoints(vscode.debug.breakpoints),
      state: this.getStatePayload(),
      snapshot,
      console: this.getConsole(state.sessionId, 200).entries
    };
  }

  getStatePayload(): BridgeStatePayload {
    return {
      bridgeUrl: this.bridgeUrl,
      startedAt: this.startedAt,
      activeSessionId: this.activeSessionId,
      sessions: this.listSessions()
    };
  }

  getSnapshot(sessionId?: string): DebugSnapshot {
    const state = this.resolveSession(sessionId, true);
    if (!state.snapshot) {
      throw new Error(`No snapshot available for session "${state.sessionName}". Call refresh first.`);
    }
    return state.snapshot;
  }

  getConsole(sessionId?: string, limit = 100): { sessionId: string; entries: ConsoleEntry[] } {
    const state = this.resolveSession(sessionId, true);
    return {
      sessionId: state.sessionId,
      entries: this.getFilteredConsoleEntries(state, limit)
    };
  }

  async dispose(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = undefined;
    }

    try {
      fs.rmSync(this.bridgeInfoPath, { force: true });
    } catch {
      // Ignore cleanup failures during shutdown.
    }

    this.output.dispose();
  }

  private async loadVariables(
    session: vscode.DebugSession,
    variablesReference: number,
    depth: number,
    maxVariables: number,
    context: VariableLoadContext
  ): Promise<VariableSnapshot[]> {
    if (!variablesReference || variablesReference <= 0) {
      return [];
    }

    const variablesResponse = (await session.customRequest("variables", {
      variablesReference,
      start: 0,
      count: maxVariables
    })) as { variables?: Array<Record<string, unknown>> };

    const rawVariables = Array.isArray(variablesResponse.variables) ? variablesResponse.variables.slice(0, maxVariables) : [];
    const items: VariableSnapshot[] = [];

    for (const rawVariable of rawVariables) {
      const variableName = toStringValue(rawVariable.name) ?? "value";
      if (shouldHidePythonVariable(context, variableName)) {
        continue;
      }

      const childReference = toNumber(rawVariable.variablesReference);
      const canExpand = Boolean(childReference && childReference > 0);
      const nextContext: VariableLoadContext = {
        ...context,
        path: [...context.path, variableName]
      };

      const children =
        canExpand && depth > 0
          ? await this.loadVariables(session, childReference ?? 0, depth - 1, maxVariables, nextContext)
          : undefined;

      items.push({
        name: variableName,
        value: toStringValue(rawVariable.value) ?? "",
        type: toStringValue(rawVariable.type),
        evaluateName: toStringValue(rawVariable.evaluateName),
        variablesReference: childReference,
        namedVariables: toNumber(rawVariable.namedVariables),
        indexedVariables: toNumber(rawVariable.indexedVariables),
        children,
        childrenTruncated: canExpand && depth === 0
      });
    }

    return items;
  }

  private compactScopesForDisplay(session: vscode.DebugSession, scopes: ScopeSnapshot[]): ScopeSnapshot[] {
    if (!isPythonSession(session)) {
      return scopes;
    }

    const localsScope = scopes.find((scope) => scope.name.trim().toLowerCase() === "locals");
    const globalsScope = scopes.find((scope) => scope.name.trim().toLowerCase() === "globals");

    if (!localsScope || !globalsScope) {
      return scopes;
    }

    if (JSON.stringify(localsScope.variables) !== JSON.stringify(globalsScope.variables)) {
      return scopes;
    }

    return scopes.filter((scope) => scope !== globalsScope);
  }

  private getFilteredConsoleEntries(state: SessionRuntimeState, limit: number): ConsoleEntry[] {
    const filtered = shouldHideTelemetryConsoleOutput()
      ? state.consoleEntries.filter((entry) => entry.category?.trim().toLowerCase() !== "telemetry")
      : state.consoleEntries;

    return filtered.slice(-Math.max(1, limit));
  }

  private orderScopes(
    session: vscode.DebugSession,
    scopes: Array<Record<string, unknown>>
  ): Array<Record<string, unknown>> {
    const config = vscode.workspace.getConfiguration("pyDebugBridge");
    if (!config.get<boolean>("prioritizePythonScopes", true) || !isPythonSession(session)) {
      return scopes;
    }

    const preferredNames = ["locals", "globals"];
    return [...scopes].sort((left, right) => {
      const leftRank = preferredScopeRank(toStringValue(left.name), preferredNames);
      const rightRank = preferredScopeRank(toStringValue(right.name), preferredNames);
      return leftRank - rightRank;
    });
  }

  private shouldFilterPythonInternals(session: vscode.DebugSession): boolean {
    if (!isPythonSession(session)) {
      return false;
    }

    return vscode.workspace.getConfiguration("pyDebugBridge").get<boolean>("hidePythonInternals", true);
  }

  private async handleAdapterMessage(session: vscode.DebugSession, message: DapProtocolMessage): Promise<void> {
    const state = this.ensureSession(session, "running");

    if (message.type === "response" && message.success === false) {
      state.lastError = message.message ?? "Debug adapter request failed";
      state.updatedAt = new Date().toISOString();
      return;
    }

    if (message.type !== "event") {
      return;
    }

    switch (message.event) {
      case "stopped":
        state.status = "paused";
        state.stopReason = toStringValue(message.body?.reason);
        state.activeThreadId = toNumber(message.body?.threadId) ?? state.activeThreadId;
        state.updatedAt = new Date().toISOString();

        try {
          await this.refreshSnapshot({ sessionId: state.sessionId, threadId: state.activeThreadId });
        } catch (error) {
          state.lastError = toErrorMessage(error);
          this.output.appendLine(`[${state.sessionName}] refresh failed: ${state.lastError}`);
        }
        break;
      case "continued":
        state.status = "running";
        state.updatedAt = new Date().toISOString();
        break;
      case "terminated":
      case "exited":
        state.status = "terminated";
        state.updatedAt = new Date().toISOString();
        break;
      case "output":
        if (vscode.workspace.getConfiguration("pyDebugBridge").get<boolean>("captureConsole", true)) {
          this.pushConsole(state, {
            timestamp: new Date().toISOString(),
            category: toStringValue(message.body?.category),
            output: toStringValue(message.body?.output) ?? "",
            source: toStringValue(message.body?.source)
          });
        }
        break;
      default:
        break;
    }
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", this.bridgeUrl || "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/health") {
        this.writeJson(response, 200, { ok: true, bridgeUrl: this.bridgeUrl, startedAt: this.startedAt });
        return;
      }

      if (!this.isAuthorized(request)) {
        this.writeJson(response, 401, { error: "Unauthorized" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/state") {
        this.writeJson(response, 200, this.getStatePayload());
        return;
      }

      if (request.method === "GET" && url.pathname === "/snapshot") {
        this.writeJson(response, 200, this.getSnapshot(url.searchParams.get("sessionId") ?? undefined));
        return;
      }

      if (request.method === "GET" && url.pathname === "/console") {
        const limit = clampInteger(Number(url.searchParams.get("limit")), 1, 1000, 100);
        this.writeJson(response, 200, this.getConsole(url.searchParams.get("sessionId") ?? undefined, limit));
        return;
      }

      if (request.method === "POST" && url.pathname === "/refresh") {
        const body = await readJsonBody(request);
        this.writeJson(response, 200, await this.refreshSnapshot(body as RefreshRequest));
        return;
      }

      if (request.method === "POST" && url.pathname === "/evaluate") {
        const body = await readJsonBody(request);
        this.writeJson(response, 200, await this.evaluate(body as EvaluateRequest));
        return;
      }

      this.writeJson(response, 404, { error: "Not found" });
    } catch (error) {
      this.writeJson(response, 500, { error: toErrorMessage(error) });
    }
  }

  private isAuthorized(request: http.IncomingMessage): boolean {
    return request.headers.authorization === `Bearer ${this.token}`;
  }

  private writeJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload, null, 2));
  }

  private ensureSession(session: vscode.DebugSession, defaultStatus: SessionStatus): SessionRuntimeState {
    const existing = this.sessions.get(session.id);
    if (existing) {
      existing.session = session;
      existing.sessionName = session.name;
      existing.sessionType = session.type;
      existing.configurationName = toStringValue(asRecord(session.configuration)?.name);
      existing.updatedAt = new Date().toISOString();
      this.activeSessionId = session.id;
      return existing;
    }

    const created: SessionRuntimeState = {
      session,
      sessionId: session.id,
      sessionName: session.name,
      sessionType: session.type,
      configurationName: toStringValue(asRecord(session.configuration)?.name),
      status: defaultStatus,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      consoleEntries: []
    };

    this.sessions.set(session.id, created);
    this.activeSessionId = session.id;
    return created;
  }

  private resolveSession(sessionId?: string, allowTerminated = false): SessionRuntimeState {
    const orderedCandidates = sessionId
      ? [this.sessions.get(sessionId)]
      : [
          this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined,
          vscode.debug.activeDebugSession ? this.sessions.get(vscode.debug.activeDebugSession.id) : undefined,
          ...this.sessions.values()
        ];

    const resolved = orderedCandidates.find(
      (candidate): candidate is SessionRuntimeState =>
        Boolean(candidate && (allowTerminated || candidate.status !== "terminated"))
    );

    if (!resolved) {
      throw new Error("No active debug session found.");
    }

    return resolved;
  }

  private listSessions(): SessionSummary[] {
    return Array.from(this.sessions.values())
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((state) => ({
        sessionId: state.sessionId,
        sessionName: state.sessionName,
        sessionType: state.sessionType,
        configurationName: state.configurationName,
        status: state.status,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
        stopReason: state.stopReason,
        lastError: state.lastError,
        activeThreadId: state.activeThreadId,
        activeFrameId: state.activeFrameId,
        hasSnapshot: Boolean(state.snapshot)
      }));
  }

  private pushConsole(state: SessionRuntimeState, entry: ConsoleEntry): void {
    state.consoleEntries.push(entry);
    if (state.consoleEntries.length > 200) {
      state.consoleEntries.splice(0, state.consoleEntries.length - 200);
    }
    state.updatedAt = new Date().toISOString();
  }

  private writeBridgeInfoFile(): void {
    const payload: BridgeInfoFile = {
      bridgeUrl: this.bridgeUrl,
      token: this.token,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      processId: process.pid,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)
    };

    fs.mkdirSync(path.dirname(this.bridgeInfoPath), { recursive: true });
    fs.writeFileSync(this.bridgeInfoPath, JSON.stringify(payload, null, 2), "utf8");
  }
}

let bridge: DebugBridge | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  bridge = new DebugBridge();
  await bridge.start();

  context.subscriptions.push(
    bridge,
    vscode.debug.registerDebugAdapterTrackerFactory("*", bridge),
    vscode.debug.onDidTerminateDebugSession((session) => {
      bridge?.markTerminated(session);
    }),
    vscode.commands.registerCommand("pyDebugBridge.copyConnectionInfo", async () => {
      if (!bridge) {
        return;
      }

      await vscode.env.clipboard.writeText(
        JSON.stringify(
          {
            ...bridge.getConnectionInfo(),
            note: "PyDebugMCP reads the bridge-info file automatically unless PYDEBUG_BRIDGE_URL and PYDEBUG_BRIDGE_TOKEN are set."
          },
          null,
          2
        )
      );

      void vscode.window.showInformationMessage("PyDebugBridge connection info copied to the clipboard.");
    }),
    vscode.commands.registerCommand("pyDebugBridge.refreshActiveSnapshot", async () => {
      if (!bridge) {
        return;
      }

      try {
        const snapshot = await bridge.refreshSnapshot({});
        void vscode.window.showInformationMessage(`Captured snapshot for ${snapshot.sessionName}.`);
      } catch (error) {
        void vscode.window.showErrorMessage(`Failed to capture snapshot: ${toErrorMessage(error)}`);
      }
    }),
    vscode.commands.registerCommand("pyDebugBridge.copyCurrentDebugInfo", async () => {
      if (!bridge) {
        return;
      }

      try {
        const payload = await bridge.buildClipboardPayload();
        await vscode.env.clipboard.writeText(JSON.stringify(payload, null, 2));
        void vscode.window.showInformationMessage("Current debug info copied to the clipboard.");
      } catch (error) {
        void vscode.window.showErrorMessage(`Failed to copy debug info: ${toErrorMessage(error)}`);
      }
    })
  );
}

export async function deactivate(): Promise<void> {
  await bridge?.dispose();
  bridge = undefined;
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  const candidate = Number.isFinite(value) ? Math.trunc(value as number) : fallback;
  return Math.min(max, Math.max(min, candidate));
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function orderThreads(threads: Array<Record<string, unknown>>, preferredThreadId?: number): Array<Record<string, unknown>> {
  if (!preferredThreadId) {
    return threads;
  }

  return [...threads].sort((left, right) => {
    const leftId = toNumber(left.id);
    const rightId = toNumber(right.id);

    if (leftId === preferredThreadId) {
      return -1;
    }

    if (rightId === preferredThreadId) {
      return 1;
    }

    return 0;
  });
}

function isPythonSession(session: vscode.DebugSession): boolean {
  const sessionType = session.type.toLowerCase();
  const configurationType = toStringValue(asRecord(session.configuration)?.type)?.toLowerCase();
  return sessionType === "python" || sessionType === "debugpy" || configurationType === "python" || configurationType === "debugpy";
}

function preferredScopeRank(name: string | undefined, preferredNames: string[]): number {
  if (!name) {
    return preferredNames.length + 1;
  }

  const normalized = name.trim().toLowerCase();
  const index = preferredNames.indexOf(normalized);
  return index === -1 ? preferredNames.length + 1 : index;
}

function shouldHidePythonVariable(context: VariableLoadContext, variableName: string): boolean {
  if (!context.filterPythonInternals) {
    return false;
  }

  const normalizedScope = context.scopeName?.trim().toLowerCase();
  const isTopLevelScopeVariable =
    context.path.length === 0 && (normalizedScope === "locals" || normalizedScope === "globals");

  if (!isTopLevelScopeVariable) {
    return false;
  }

  const normalizedName = variableName.trim().toLowerCase();
  if (PYTHON_INTERNAL_GROUP_NAMES.has(normalizedName)) {
    return true;
  }

  if (normalizedName === "__builtins__") {
    return true;
  }

  return isDunderName(variableName);
}

function serializeBreakpoints(breakpoints: readonly vscode.Breakpoint[]): Array<Record<string, unknown>> {
  return breakpoints.map((breakpoint) => {
    const breakpointRecord = asRecord(breakpoint) ?? {};
    const base: Record<string, unknown> = {
      enabled: breakpoint.enabled,
      condition: breakpoint.condition,
      hitCondition: breakpoint.hitCondition,
      logMessage: breakpoint.logMessage
    };

    if (breakpoint instanceof vscode.SourceBreakpoint) {
      return {
        ...base,
        kind: "source",
        fileName: breakpoint.location.uri.fsPath,
        line: breakpoint.location.range.start.line + 1,
        character: breakpoint.location.range.start.character + 1
      };
    }

    if (breakpoint instanceof vscode.FunctionBreakpoint) {
      return {
        ...base,
        kind: "function",
        functionName: breakpoint.functionName
      };
    }

    if (typeof breakpointRecord.label === "string") {
      return {
        ...base,
        kind: "data",
        label: breakpointRecord.label,
        canPersist: breakpointRecord.canPersist
      };
    }

    if (typeof breakpointRecord.instructionReference === "string") {
      return {
        ...base,
        kind: "instruction",
        instructionReference: breakpointRecord.instructionReference,
        offset: breakpointRecord.offset
      };
    }

    return {
      ...base,
      kind: "unknown"
    };
  });
}

const PYTHON_INTERNAL_GROUP_NAMES = new Set([
  "special variables",
  "function variables",
  "class variables",
  "protected variables",
  "private variables"
]);

function isDunderName(name: string): boolean {
  return /^__.+__$/.test(name.trim());
}

function shouldHideTelemetryConsoleOutput(): boolean {
  return vscode.workspace.getConfiguration("pyDebugBridge").get<boolean>("hideTelemetryConsoleOutput", true);
}
