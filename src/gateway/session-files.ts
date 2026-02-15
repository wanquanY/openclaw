import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type {
  SessionFileAction,
  SessionFileKind,
  SessionFileRecord,
  SessionsFilesListParams,
  SessionsFilesListResult,
} from "./protocol/index.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { loadSessionStore, type SessionEntry } from "../config/sessions.js";
import {
  resolveGatewaySessionStoreTarget,
  resolveSessionTranscriptCandidates,
} from "./session-utils.js";

const TOOL_CALL_TYPES = new Set(["toolcall", "tool_call", "tooluse", "tool_use"]);
const TOOL_RESULT_ROLES = new Set(["tool", "toolresult", "tool_result"]);
const SESSION_FILES_MAX_SCAN_ENTRIES = 200_000;
const SESSION_FILES_FALLBACK_WINDOW_MS = 2 * 60 * 60 * 1000;
const SESSION_FILES_SCAN_START_GRACE_MS = 60_000;
const SESSION_FILES_SCAN_END_GRACE_MS = 5 * 60 * 1000;
const SESSION_FILES_EXEC_PROMOTE_BEFORE_MS = 10 * 60 * 1000;
const SESSION_FILES_EXEC_PROMOTE_AFTER_MS = 2 * 60 * 1000;
const SESSION_FILES_IGNORED_DIRS = new Set([
  ".git",
  ".openclaw",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);
const SESSION_FILES_IGNORED_FILE_NAMES = new Set([".DS_Store"]);
const APPLY_PATCH_ADD_PREFIX = "*** Add File:";
const APPLY_PATCH_UPDATE_PREFIX = "*** Update File:";
const APPLY_PATCH_DELETE_PREFIX = "*** Delete File:";
const APPLY_PATCH_MOVE_PREFIX = "*** Move to:";
const APPLY_PATCH_SUMMARY_RE = /^\s*([AMD])\s+(.+?)\s*$/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const COMMAND_PATH_EXT_RE =
  /\.(xlsx|xls|csv|json|txt|md|markdown|yaml|yml|toml|ini|xml|pdf|docx?|pptx?|png|jpe?g|gif|webp|svg|py|js|jsx|ts|tsx|sh|sql|html|css)$/i;
const ACTION_ORDER: SessionFileAction[] = ["created", "updated", "deleted", "read", "referenced"];

type SessionFilesScope = "created" | "changed" | "all";

type PathAction = {
  path: string;
  action: SessionFileAction;
};

type PendingToolCall = {
  toolName: string;
  pathActions: PathAction[];
  ts?: number;
};

type MutableSessionFile = {
  path: string;
  workspacePath?: string;
  kind: SessionFileKind;
  actions: Set<SessionFileAction>;
  exists?: boolean;
  firstSeenAt?: number;
  lastSeenAt?: number;
};

type TranscriptParseResult = {
  minTs?: number;
  maxTs?: number;
};

function isWorkspaceScanEnabled(): boolean {
  return process.env.OPENCLAW_SESSION_FILES_WORKSPACE_SCAN === "1";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function normalizeToolName(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "bash") {
    return "exec";
  }
  return normalized;
}

function normalizeType(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function normalizeRole(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function normalizeOutputPath(input: string): string {
  const normalized = input
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/")
    .trim();
  if (!normalized || normalized === "/") {
    return normalized;
  }
  return normalized.replace(/\/+$/g, "");
}

function normalizeScope(scope: unknown): SessionFilesScope {
  if (scope === "created" || scope === "changed" || scope === "all") {
    return scope;
  }
  return "created";
}

function toTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    if (value < 10_000_000_000) {
      return Math.floor(value * 1000);
    }
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsedNumber = Number(trimmed);
    if (Number.isFinite(parsedNumber) && parsedNumber > 0) {
      return toTimestampMs(parsedNumber);
    }
    const parsedDate = Date.parse(trimmed);
    if (Number.isFinite(parsedDate) && parsedDate > 0) {
      return Math.floor(parsedDate);
    }
  }
  return undefined;
}

function resolveTimestamp(record?: Record<string, unknown>): number | undefined {
  if (!record) {
    return undefined;
  }
  return (
    toTimestampMs(record.timestamp) ??
    toTimestampMs(record.ts) ??
    toTimestampMs(record.createdAtMs) ??
    toTimestampMs(record.createdAt) ??
    toTimestampMs(record.updatedAtMs) ??
    toTimestampMs(record.updatedAt)
  );
}

function updateWindow(result: TranscriptParseResult, ts: number | undefined) {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
    return;
  }
  if (result.minTs === undefined || ts < result.minTs) {
    result.minTs = ts;
  }
  if (result.maxTs === undefined || ts > result.maxTs) {
    result.maxTs = ts;
  }
}

function safeParseJsonLine(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function stringList(record: Record<string, unknown>, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      out.push(value.trim());
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) {
          out.push(item.trim());
        }
      }
    }
  }
  return out;
}

function dedupePathActions(actions: PathAction[]): PathAction[] {
  const map = new Map<string, SessionFileAction>();
  for (const item of actions) {
    const normalizedPath = normalizeOutputPath(item.path);
    if (!normalizedPath || normalizedPath === ".") {
      continue;
    }
    const existing = map.get(normalizedPath);
    if (!existing) {
      map.set(normalizedPath, item.action);
      continue;
    }
    const existingOrder = ACTION_ORDER.indexOf(existing);
    const nextOrder = ACTION_ORDER.indexOf(item.action);
    if (nextOrder >= 0 && (existingOrder < 0 || nextOrder < existingOrder)) {
      map.set(normalizedPath, item.action);
    }
  }
  return [...map.entries()].map(([pathValue, action]) => ({ path: pathValue, action }));
}

function parseApplyPatchInputActions(input: string): PathAction[] {
  const actions: PathAction[] = [];
  let currentUpdatePath: string | undefined;
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith(APPLY_PATCH_ADD_PREFIX)) {
      actions.push({
        action: "created",
        path: line.slice(APPLY_PATCH_ADD_PREFIX.length).trim(),
      });
      currentUpdatePath = undefined;
      continue;
    }
    if (line.startsWith(APPLY_PATCH_UPDATE_PREFIX)) {
      const updatePath = line.slice(APPLY_PATCH_UPDATE_PREFIX.length).trim();
      if (updatePath) {
        actions.push({ action: "updated", path: updatePath });
        currentUpdatePath = updatePath;
      } else {
        currentUpdatePath = undefined;
      }
      continue;
    }
    if (line.startsWith(APPLY_PATCH_DELETE_PREFIX)) {
      actions.push({
        action: "deleted",
        path: line.slice(APPLY_PATCH_DELETE_PREFIX.length).trim(),
      });
      currentUpdatePath = undefined;
      continue;
    }
    if (line.startsWith(APPLY_PATCH_MOVE_PREFIX)) {
      const movePath = line.slice(APPLY_PATCH_MOVE_PREFIX.length).trim();
      if (currentUpdatePath) {
        actions.push({ action: "deleted", path: currentUpdatePath });
      }
      if (movePath) {
        actions.push({ action: "created", path: movePath });
        currentUpdatePath = movePath;
      } else {
        currentUpdatePath = undefined;
      }
    }
  }
  return dedupePathActions(actions);
}

function parseApplyPatchSummaryActions(text: string): PathAction[] {
  const actions: PathAction[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = rawLine.match(APPLY_PATCH_SUMMARY_RE);
    if (!match) {
      continue;
    }
    const marker = match[1];
    const rawPath = match[2]?.trim();
    if (!rawPath) {
      continue;
    }
    if (marker === "A") {
      actions.push({ action: "created", path: rawPath });
    } else if (marker === "M") {
      actions.push({ action: "updated", path: rawPath });
    } else if (marker === "D") {
      actions.push({ action: "deleted", path: rawPath });
    }
  }
  return dedupePathActions(actions);
}

function extractCommandPathHints(command: string): string[] {
  const out = new Set<string>();
  const addCandidate = (raw: string) => {
    const trimmed = raw.trim().replace(/^[`"'“”]+|[`"'“”,;:]+$/g, "");
    if (!trimmed || trimmed.length > 280) {
      return;
    }
    if (trimmed.startsWith("-") || URL_SCHEME_RE.test(trimmed)) {
      return;
    }
    const normalized = trimmed.replaceAll("\\", "/");
    const hasPathPrefix =
      normalized.startsWith("/") ||
      normalized.startsWith("./") ||
      normalized.startsWith("../") ||
      normalized.startsWith("~/") ||
      WINDOWS_DRIVE_RE.test(trimmed);
    const hasSeparator = normalized.includes("/");
    const hasKnownExtension = COMMAND_PATH_EXT_RE.test(normalized);
    if (!hasPathPrefix && !hasSeparator && !hasKnownExtension) {
      return;
    }
    out.add(trimmed);
  };

  for (const match of command.matchAll(/(["'`])([^"'`\r\n]{1,260})\1/g)) {
    addCandidate(match[2] ?? "");
  }
  for (const token of command.split(/\s+/)) {
    addCandidate(token);
  }
  return [...out];
}

function derivePathActionsFromToolCall(toolName: string, args: unknown): PathAction[] {
  const record = asRecord(args);
  if (!record) {
    return [];
  }
  const actions: PathAction[] = [];
  const add = (action: SessionFileAction, pathValue: string | undefined) => {
    if (!pathValue) {
      return;
    }
    actions.push({ action, path: pathValue });
  };

  if (toolName === "read") {
    add("read", firstString(record, ["path", "file_path", "filePath"]));
    for (const entry of stringList(record, ["paths", "files"])) {
      add("read", entry);
    }
    return dedupePathActions(actions);
  }

  if (toolName === "write" || toolName === "edit") {
    add("updated", firstString(record, ["path", "file_path", "filePath"]));
    return dedupePathActions(actions);
  }

  if (toolName === "apply_patch") {
    const input = firstString(record, ["input", "patch"]);
    if (input) {
      actions.push(...parseApplyPatchInputActions(input));
    }
    add("updated", firstString(record, ["path", "file_path", "filePath"]));
    return dedupePathActions(actions);
  }

  if (toolName === "exec") {
    const command = firstString(record, ["command", "cmd"]);
    if (command) {
      for (const hint of extractCommandPathHints(command)) {
        add("referenced", hint);
      }
    }
    return dedupePathActions(actions);
  }

  add("referenced", firstString(record, ["path", "file_path", "filePath"]));
  for (const entry of stringList(record, ["paths", "files"])) {
    add("referenced", entry);
  }
  return dedupePathActions(actions);
}

function extractTextFromToolResultPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const texts: string[] = [];
  for (const item of content) {
    const entry = asRecord(item);
    if (!entry) {
      continue;
    }
    if (typeof entry.text === "string" && entry.text.trim()) {
      texts.push(entry.text);
    }
  }
  if (texts.length > 0) {
    return texts.join("\n");
  }
  if (typeof record.message === "string") {
    return record.message;
  }
  return "";
}

type ResolvedPathCandidate = {
  key: string;
  path: string;
  workspacePath?: string;
  absolutePath?: string;
};

function pathInsideWorkspace(workspaceDir: string, absolutePath: string): string | null {
  const workspaceRoot = path.resolve(workspaceDir);
  const relative = path.relative(workspaceRoot, absolutePath);
  if (!relative) {
    return ".";
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return normalizeOutputPath(relative);
}

function shouldIgnoreWorkspacePath(workspacePath: string): boolean {
  const normalized = normalizeOutputPath(workspacePath);
  if (!normalized || normalized === ".") {
    return false;
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    return false;
  }
  if (segments.some((segment) => SESSION_FILES_IGNORED_DIRS.has(segment))) {
    return true;
  }
  const fileName = segments[segments.length - 1];
  return SESSION_FILES_IGNORED_FILE_NAMES.has(fileName);
}

function resolvePathCandidate(
  pathValue: string,
  workspaceDir?: string,
): ResolvedPathCandidate | null {
  const trimmed = String(pathValue ?? "").trim();
  if (!trimmed || trimmed.includes("\0") || URL_SCHEME_RE.test(trimmed)) {
    return null;
  }
  let absolutePath: string | undefined;
  if (path.isAbsolute(trimmed) || WINDOWS_DRIVE_RE.test(trimmed)) {
    absolutePath = path.resolve(trimmed);
  } else if (workspaceDir) {
    absolutePath = path.resolve(workspaceDir, trimmed);
  }

  let outputPath = normalizeOutputPath(trimmed);
  let workspacePath: string | undefined;
  if (workspaceDir && absolutePath) {
    const relativePath = pathInsideWorkspace(workspaceDir, absolutePath);
    if (relativePath && relativePath !== ".") {
      workspacePath = relativePath;
      outputPath = normalizeOutputPath(absolutePath);
    } else if (relativePath === ".") {
      return null;
    } else {
      outputPath = normalizeOutputPath(absolutePath);
    }
  } else if (absolutePath) {
    outputPath = normalizeOutputPath(absolutePath);
  }

  if (!outputPath || outputPath === ".") {
    return null;
  }
  if (workspacePath && shouldIgnoreWorkspacePath(workspacePath)) {
    return null;
  }
  const key = workspacePath ? `workspace:${workspacePath}` : `path:${outputPath}`;
  return {
    key,
    path: outputPath,
    workspacePath,
    absolutePath,
  };
}

function getPathStat(absolutePath: string, cache: Map<string, fs.Stats | null>): fs.Stats | null {
  const cached = cache.get(absolutePath);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const stat = fs.statSync(absolutePath);
    cache.set(absolutePath, stat);
    return stat;
  } catch {
    cache.set(absolutePath, null);
    return null;
  }
}

function resolveKindFromStat(stat: fs.Stats | null): SessionFileKind {
  if (!stat) {
    return "unknown";
  }
  if (stat.isDirectory()) {
    return "directory";
  }
  if (stat.isFile()) {
    return "file";
  }
  return "unknown";
}

function hasErrorStatus(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "error" || normalized === "failed" || normalized === "failure";
}

function isToolResultError(message: Record<string, unknown>): boolean {
  if (message.isError === true || message.is_error === true) {
    return true;
  }
  if (hasErrorStatus(message.status)) {
    return true;
  }
  const details = asRecord(message.details);
  if (details && hasErrorStatus(details.status)) {
    return true;
  }
  const result = asRecord(message.result);
  if (result && hasErrorStatus(result.status)) {
    return true;
  }
  return false;
}

function promoteExecActionByStat(params: {
  action: SessionFileAction;
  pathValue: string;
  seenAt?: number;
  workspaceDir?: string;
  statCache: Map<string, fs.Stats | null>;
}): SessionFileAction {
  if (params.action !== "referenced") {
    return params.action;
  }
  const candidate = resolvePathCandidate(params.pathValue, params.workspaceDir);
  if (!candidate?.absolutePath) {
    return params.action;
  }
  const stat = getPathStat(candidate.absolutePath, params.statCache);
  if (!stat) {
    return params.action;
  }
  const seenAt = params.seenAt && Number.isFinite(params.seenAt) ? params.seenAt : Date.now();
  const lowerBound = Math.max(0, seenAt - SESSION_FILES_EXEC_PROMOTE_BEFORE_MS);
  const upperBound = seenAt + SESSION_FILES_EXEC_PROMOTE_AFTER_MS;
  const birthtime = toTimestampMs(stat.birthtimeMs);
  if (birthtime !== undefined && birthtime >= lowerBound && birthtime <= upperBound) {
    return "created";
  }
  const mtime = toTimestampMs(stat.mtimeMs);
  if (mtime !== undefined && mtime >= lowerBound && mtime <= upperBound) {
    return "updated";
  }
  return params.action;
}

function pushSessionFileRecord(params: {
  map: Map<string, MutableSessionFile>;
  statCache: Map<string, fs.Stats | null>;
  workspaceDir?: string;
  pathValue: string;
  action: SessionFileAction;
  seenAt?: number;
  kindHint?: SessionFileKind;
  existsHint?: boolean;
}) {
  const candidate = resolvePathCandidate(params.pathValue, params.workspaceDir);
  if (!candidate) {
    return;
  }
  const seenAt = params.seenAt && Number.isFinite(params.seenAt) ? params.seenAt : Date.now();
  const stat = candidate.absolutePath
    ? getPathStat(candidate.absolutePath, params.statCache)
    : null;
  const exists = params.existsHint ?? Boolean(stat);
  const kind = params.kindHint ?? resolveKindFromStat(stat);

  const existing = params.map.get(candidate.key);
  if (!existing) {
    params.map.set(candidate.key, {
      path: candidate.path,
      workspacePath: candidate.workspacePath,
      kind,
      actions: new Set([params.action]),
      exists,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    });
    return;
  }

  existing.actions.add(params.action);
  existing.kind = existing.kind === "unknown" ? kind : existing.kind;
  if (existing.exists === undefined) {
    existing.exists = exists;
  } else if (!exists) {
    existing.exists = false;
  }
  if (existing.firstSeenAt === undefined || seenAt < existing.firstSeenAt) {
    existing.firstSeenAt = seenAt;
  }
  if (existing.lastSeenAt === undefined || seenAt > existing.lastSeenAt) {
    existing.lastSeenAt = seenAt;
  }
}

function parseTranscriptFile(params: {
  transcriptPath: string;
  workspaceDir?: string;
  map: Map<string, MutableSessionFile>;
  statCache: Map<string, fs.Stats | null>;
}): TranscriptParseResult {
  const result: TranscriptParseResult = {};
  let raw = "";
  try {
    raw = fs.readFileSync(params.transcriptPath, "utf-8");
  } catch {
    return result;
  }
  const pendingToolCalls = new Map<string, PendingToolCall>();

  for (const line of raw.split(/\r?\n/)) {
    const parsed = safeParseJsonLine(line);
    if (!parsed) {
      continue;
    }

    const lineTs = resolveTimestamp(parsed);
    updateWindow(result, lineTs);

    const message =
      asRecord(parsed.message) ?? (typeof parsed.role === "string" ? parsed : undefined);
    if (!message) {
      continue;
    }

    const messageTs = resolveTimestamp(message) ?? lineTs;
    updateWindow(result, messageTs);

    const role = normalizeRole(message.role);
    if (role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      for (const blockRaw of content) {
        const block = asRecord(blockRaw);
        if (!block || !TOOL_CALL_TYPES.has(normalizeType(block.type))) {
          continue;
        }
        const toolCallId = firstString(block, ["id", "toolCallId", "tool_call_id", "toolUseId"]);
        const toolName = normalizeToolName(
          firstString(block, ["name", "toolName", "tool_name"]) ?? "",
        );
        const pathActions = derivePathActionsFromToolCall(
          toolName,
          block.arguments ?? block.input ?? block.args,
        );
        if (!toolCallId) {
          for (const item of pathActions) {
            pushSessionFileRecord({
              map: params.map,
              statCache: params.statCache,
              workspaceDir: params.workspaceDir,
              pathValue: item.path,
              action: item.action === "read" ? "read" : "referenced",
              seenAt: messageTs,
            });
          }
          continue;
        }
        pendingToolCalls.set(toolCallId, {
          toolName,
          pathActions,
          ts: messageTs,
        });
      }
      continue;
    }

    if (!TOOL_RESULT_ROLES.has(role)) {
      continue;
    }

    const toolCallId = firstString(message, [
      "toolCallId",
      "tool_call_id",
      "toolUseId",
      "tool_use_id",
    ]);
    const pending = toolCallId ? pendingToolCalls.get(toolCallId) : undefined;
    const toolName =
      pending?.toolName ||
      normalizeToolName(firstString(message, ["toolName", "tool_name", "name"]) ?? "");
    const isError = isToolResultError(message);

    if (pending) {
      for (const item of pending.pathActions) {
        let action = isError && item.action !== "read" ? "referenced" : item.action;
        if (!isError && pending.toolName === "exec") {
          action = promoteExecActionByStat({
            action,
            pathValue: item.path,
            seenAt: messageTs ?? pending.ts,
            workspaceDir: params.workspaceDir,
            statCache: params.statCache,
          });
        }
        pushSessionFileRecord({
          map: params.map,
          statCache: params.statCache,
          workspaceDir: params.workspaceDir,
          pathValue: item.path,
          action,
          seenAt: messageTs ?? pending.ts,
        });
      }
      if (toolCallId) {
        pendingToolCalls.delete(toolCallId);
      }
    }

    if (toolName === "apply_patch") {
      const summaryActions = parseApplyPatchSummaryActions(
        extractTextFromToolResultPayload(message) ||
          extractTextFromToolResultPayload(message.result) ||
          extractTextFromToolResultPayload(message.details),
      );
      for (const item of summaryActions) {
        pushSessionFileRecord({
          map: params.map,
          statCache: params.statCache,
          workspaceDir: params.workspaceDir,
          pathValue: item.path,
          action: isError ? "referenced" : item.action,
          seenAt: messageTs,
        });
      }
    }
  }

  for (const pending of pendingToolCalls.values()) {
    for (const item of pending.pathActions) {
      pushSessionFileRecord({
        map: params.map,
        statCache: params.statCache,
        workspaceDir: params.workspaceDir,
        pathValue: item.path,
        action: item.action === "read" ? "read" : "referenced",
        seenAt: pending.ts,
      });
    }
  }

  return result;
}

function resolveSessionTimeWindow(params: {
  entry: SessionEntry | undefined;
  transcriptPath?: string;
  transcriptWindow: TranscriptParseResult;
}): { startMs: number; endMs: number } {
  const now = Date.now();
  const transcriptStat = params.transcriptPath
    ? (() => {
        try {
          return fs.statSync(params.transcriptPath);
        } catch {
          return undefined;
        }
      })()
    : undefined;

  const endCandidates = [
    params.transcriptWindow.maxTs,
    params.entry?.updatedAt,
    transcriptStat?.mtimeMs,
    now,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const endMs = endCandidates.length > 0 ? Math.max(...endCandidates) : now;

  const fallbackStart = Math.max(0, endMs - SESSION_FILES_FALLBACK_WINDOW_MS);
  const startCandidates = [
    params.transcriptWindow.minTs,
    transcriptStat?.birthtimeMs,
    fallbackStart,
  ].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  let startMs = startCandidates.length > 0 ? Math.min(...startCandidates) : fallbackStart;
  if (!Number.isFinite(startMs) || startMs <= 0) {
    startMs = fallbackStart;
  }
  if (startMs > endMs) {
    startMs = Math.max(0, endMs - SESSION_FILES_FALLBACK_WINDOW_MS);
  }

  return { startMs, endMs };
}

function applyWorkspaceMtimeScan(params: {
  workspaceDir: string;
  window: { startMs: number; endMs: number };
  map: Map<string, MutableSessionFile>;
  statCache: Map<string, fs.Stats | null>;
}) {
  const workspaceRoot = path.resolve(params.workspaceDir);
  let rootStat: fs.Stats | null = null;
  try {
    rootStat = fs.statSync(workspaceRoot);
  } catch {
    return;
  }
  if (!rootStat?.isDirectory()) {
    return;
  }

  const scanStart = Math.max(0, params.window.startMs - SESSION_FILES_SCAN_START_GRACE_MS);
  const scanEnd = params.window.endMs + SESSION_FILES_SCAN_END_GRACE_MS;
  const stack: string[] = [workspaceRoot];
  let scannedEntries = 0;

  while (stack.length > 0 && scannedEntries < SESSION_FILES_MAX_SCAN_ENTRIES) {
    const currentDir = stack.pop();
    if (!currentDir) {
      break;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (scannedEntries >= SESSION_FILES_MAX_SCAN_ENTRIES) {
        break;
      }
      scannedEntries += 1;
      if (entry.name === "." || entry.name === "..") {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (SESSION_FILES_IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      params.statCache.set(fullPath, stat);

      const mtime = toTimestampMs(stat.mtimeMs);
      if (mtime === undefined || mtime < scanStart || mtime > scanEnd) {
        continue;
      }
      const birthtime = toTimestampMs(stat.birthtimeMs);
      const createdInWindow =
        birthtime !== undefined && birthtime >= scanStart && birthtime <= scanEnd;
      const seenAt = birthtime ?? mtime;

      if (createdInWindow) {
        pushSessionFileRecord({
          map: params.map,
          statCache: params.statCache,
          workspaceDir: workspaceRoot,
          pathValue: fullPath,
          action: "created",
          seenAt,
          kindHint: "file",
          existsHint: true,
        });
      }

      pushSessionFileRecord({
        map: params.map,
        statCache: params.statCache,
        workspaceDir: workspaceRoot,
        pathValue: fullPath,
        action: "updated",
        seenAt: mtime,
        kindHint: "file",
        existsHint: true,
      });
    }
  }
}

function sortActions(actions: Set<SessionFileAction>): SessionFileAction[] {
  return [...actions].toSorted((a, b) => ACTION_ORDER.indexOf(a) - ACTION_ORDER.indexOf(b));
}

function scopeIncludesRecord(scope: SessionFilesScope, actions: Set<SessionFileAction>): boolean {
  if (scope === "all") {
    return true;
  }
  if (scope === "created") {
    return actions.has("created");
  }
  return actions.has("created") || actions.has("updated") || actions.has("deleted");
}

function toSessionFileRecord(record: MutableSessionFile): SessionFileRecord | null {
  const actions = sortActions(record.actions);
  if (actions.length === 0) {
    return null;
  }
  return {
    path: record.path,
    workspacePath: record.workspacePath,
    kind: record.kind,
    action: actions[0],
    actions,
    exists: record.exists,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
  };
}

function resolveSessionEntryForKey(params: { cfg: OpenClawConfig; key: string }): {
  canonicalKey: string;
  agentId: string;
  storePath: string;
  entry?: SessionEntry;
} {
  const initialTarget = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    scanLegacyKeys: false,
  });
  const store = loadSessionStore(initialTarget.storePath);
  const target = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    store,
  });
  const entry = target.storeKeys.map((candidate) => store[candidate]).find(Boolean);
  return {
    canonicalKey: target.canonicalKey,
    agentId: target.agentId,
    storePath: target.storePath,
    entry,
  };
}

export function listSessionFilesForGateway(params: {
  cfg: OpenClawConfig;
  key: string;
  opts: SessionsFilesListParams;
}): SessionsFilesListResult {
  const key = params.key.trim();
  const includeMissing = params.opts.includeMissing === true;
  const scope = normalizeScope(params.opts.scope);
  const limit =
    typeof params.opts.limit === "number" && Number.isFinite(params.opts.limit)
      ? Math.max(1, Math.min(10_000, Math.floor(params.opts.limit)))
      : 500;
  const resolved = resolveSessionEntryForKey({
    cfg: params.cfg,
    key,
  });

  if (!resolved.entry?.sessionId) {
    return {
      ts: Date.now(),
      key: resolved.canonicalKey,
      status: "missing",
      workspaceDir: (() => {
        try {
          return path.resolve(resolveAgentWorkspaceDir(params.cfg, resolved.agentId));
        } catch {
          return undefined;
        }
      })(),
      files: [],
      count: 0,
    };
  }

  const workspaceDir = (() => {
    try {
      return path.resolve(resolveAgentWorkspaceDir(params.cfg, resolved.agentId));
    } catch {
      return undefined;
    }
  })();
  const transcriptPath = resolveSessionTranscriptCandidates(
    resolved.entry.sessionId,
    resolved.storePath,
    resolved.entry.sessionFile,
    resolved.agentId,
  ).find((candidate) => fs.existsSync(candidate));
  const map = new Map<string, MutableSessionFile>();
  const statCache = new Map<string, fs.Stats | null>();
  const transcriptWindow: TranscriptParseResult = {};
  if (transcriptPath) {
    const parsed = parseTranscriptFile({
      transcriptPath,
      workspaceDir,
      map,
      statCache,
    });
    transcriptWindow.minTs = parsed.minTs;
    transcriptWindow.maxTs = parsed.maxTs;
  }
  if (workspaceDir && isWorkspaceScanEnabled()) {
    applyWorkspaceMtimeScan({
      workspaceDir,
      window: resolveSessionTimeWindow({
        entry: resolved.entry,
        transcriptPath,
        transcriptWindow,
      }),
      map,
      statCache,
    });
  }

  const filtered = [...map.values()]
    .filter((item) => scopeIncludesRecord(scope, item.actions))
    .filter((item) => includeMissing || item.exists !== false)
    .map(toSessionFileRecord)
    .filter((item): item is SessionFileRecord => Boolean(item))
    .toSorted((a, b) => {
      const aSeen = a.lastSeenAt ?? a.firstSeenAt ?? 0;
      const bSeen = b.lastSeenAt ?? b.firstSeenAt ?? 0;
      if (aSeen !== bSeen) {
        return bSeen - aSeen;
      }
      return a.path.localeCompare(b.path);
    });

  const files = filtered.slice(0, limit);
  const status = files.length > 0 ? "ok" : transcriptPath ? "empty" : "no-transcript";
  return {
    ts: Date.now(),
    key: resolved.canonicalKey,
    sessionId: resolved.entry.sessionId,
    status,
    workspaceDir,
    transcriptPath,
    files,
    count: files.length,
  };
}
