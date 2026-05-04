import type {
  ComputerUseAction,
  ComputerUseAppTarget,
  ComputerUseAxNode,
  ComputerUseAxSnapshot,
  ComputerUseCandidate,
  ComputerUseCdpNode,
  ComputerUseCdpSnapshot,
  ComputerUseCaptureDiagnostics,
  ComputerUseDiagnostics,
  ComputerUseObservation,
  ComputerUseOcrRegion,
  ComputerUseOcrSnapshot,
  ComputerUsePoint,
  ComputerUseRect,
  ComputerUseSelectedTarget,
  ComputerUseTargetBinding,
  ComputerUseTargetCatalog,
  ComputerUseWindowTarget,
} from "../../../computer-use/types.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { readNumberParam, readStringParam } from "../common.js";

const INTERACTIVE_AX_ROLES = new Set([
  "AXButton",
  "AXCheckBox",
  "AXComboBox",
  "AXDisclosureTriangle",
  "AXLink",
  "AXMenuButton",
  "AXMenuItem",
  "AXPopUpButton",
  "AXRadioButton",
  "AXRow",
  "AXSearchField",
  "AXSlider",
  "AXStaticText",
  "AXTab",
  "AXTabButton",
  "AXTextArea",
  "AXTextField",
]);
const INTERACTIVE_CDP_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);
const CONTAINER_AX_ROLES = new Set([
  "AXApplication",
  "AXBrowser",
  "AXGroup",
  "AXLayoutArea",
  "AXList",
  "AXOutline",
  "AXScrollArea",
  "AXSplitter",
  "AXSplitGroup",
  "AXUnknown",
  "AXWebArea",
  "AXWindow",
]);
const POINT_GROUNDING_ACTION_CAPABILITIES = new Set([
  "click",
  "press",
  "type",
  "setText",
  "set_text",
  "scroll",
  "drag",
  "hover",
]);
const POINT_GROUNDING_CONTAINER_ROLES = new Set([
  "application",
  "browser",
  "dialog",
  "group",
  "layoutarea",
  "list",
  "outline",
  "scrollarea",
  "splitgroup",
  "splitter",
  "unknown",
  "webarea",
  "window",
]);
const MAX_COMPUTER_USE_CANDIDATE_MEMORY_SESSIONS = 128;
const COMPUTER_USE_CANDIDATE_MEMORY_TTL_MS = 10 * 60 * 1000;

type RememberedComputerUseCandidate = {
  candidate: ComputerUseCandidate;
  observation?: ComputerUseObservation;
  updatedAtMs: number;
};
type ComputerUseCandidateMemory = {
  updatedAtMs: number;
  observation?: ComputerUseObservation;
  candidates: RememberedComputerUseCandidate[];
};
const computerUseCandidateMemoryBySession = new Map<string, ComputerUseCandidateMemory>();

type ComputerUsePendingActionPayload = {
  targetId?: string;
  elementSelector?: ComputerUseCandidate["selector"];
  point?: ComputerUsePoint;
};

function trimModelText(value: string | undefined, maxLength = 240): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function readOptionalPoint(
  params: Record<string, unknown>,
  prefix: "" | "from" | "to" = "",
): ComputerUsePoint | undefined {
  const xKey = prefix ? `${prefix}X` : "x";
  const yKey = prefix ? `${prefix}Y` : "y";
  const x = readNumberParam(params, xKey);
  const y = readNumberParam(params, yKey);
  if (typeof x !== "number" || typeof y !== "number") {
    return undefined;
  }
  return { x, y };
}

function countAxNodes(nodes: ComputerUseAxNode[] | undefined): number {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return 0;
  }
  return nodes.reduce((total, node) => total + 1 + countAxNodes(node.children), 0);
}

function collectAxHighlights(nodes: ComputerUseAxNode[] | undefined, limit = 12): string[] {
  const highlights: string[] = [];
  const queue = [...(nodes ?? [])];
  while (queue.length > 0 && highlights.length < limit) {
    const node = queue.shift();
    if (!node) {
      continue;
    }
    const primary =
      node.label ?? node.value ?? node.description ?? node.help ?? node.url ?? undefined;
    if (primary) {
      const flags = [
        node.focused ? "focused" : "",
        node.selected ? "selected" : "",
        node.editable ? "editable" : "",
      ].filter(Boolean);
      highlights.push(
        `${node.role}${node.subrole ? `/${node.subrole}` : ""}: ${primary}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`,
      );
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      queue.push(...node.children);
    }
  }
  return highlights;
}

function collectOcrHighlights(snapshot: ComputerUseOcrSnapshot | undefined, limit = 12): string[] {
  return (snapshot?.regions ?? [])
    .slice(0, limit)
    .map(
      (region) =>
        `${region.text}${typeof region.confidence === "number" ? ` (${Math.round(region.confidence * 100)}%)` : ""}`,
    );
}

function collectCdpHighlights(snapshot: ComputerUseCdpSnapshot | undefined, limit = 12): string[] {
  return (snapshot?.nodes ?? []).slice(0, limit).map((node) => {
    const flags = [
      node.editable ? "editable" : "",
      node.enabled === false ? "disabled" : "",
      node.coordinateMapping ? `mapping=${node.coordinateMapping}` : "",
    ].filter(Boolean);
    const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
    return `${node.role}: ${node.label}${suffix}`;
  });
}

function normalizeCandidateLabel(value: string | undefined): string | undefined {
  return trimModelText(value, 180) ?? undefined;
}

function buildCandidateRole(node: Pick<ComputerUseAxNode, "role" | "subrole">): string {
  return node.subrole ? `${node.role}/${node.subrole}` : node.role;
}

function isAxCandidateNode(node: ComputerUseAxNode): boolean {
  const label = normalizeCandidateLabel(
    node.label ?? node.value ?? node.description ?? node.help ?? node.url ?? undefined,
  );
  if (!label) {
    return false;
  }
  if (INTERACTIVE_AX_ROLES.has(node.role)) {
    return true;
  }
  if (node.editable || node.focused || node.selected) {
    return true;
  }
  return !CONTAINER_AX_ROLES.has(node.role);
}

function clampConfidence(value: number, min = 0.35, max = 0.99): number {
  return Math.max(min, Math.min(max, value));
}

function clipRectToFrame(
  rect: ComputerUseRect | undefined,
  frameSize: { width: number; height: number } | undefined,
): ComputerUseRect | undefined {
  if (!rect || !frameSize || frameSize.width <= 0 || frameSize.height <= 0) {
    return rect;
  }
  const left = Math.max(0, Math.min(frameSize.width, rect.x));
  const top = Math.max(0, Math.min(frameSize.height, rect.y));
  const right = Math.max(left, Math.min(frameSize.width, rect.x + rect.width));
  const bottom = Math.max(top, Math.min(frameSize.height, rect.y + rect.height));
  const width = right - left;
  const height = bottom - top;
  if (width < 1 || height < 1) {
    return undefined;
  }
  return { x: left, y: top, width, height };
}

function projectRectToFrame(params: {
  rect: ComputerUseRect | undefined;
  capture?: ComputerUseCaptureDiagnostics;
}): ComputerUseRect | undefined {
  const rect = params.rect;
  if (!rect) {
    return undefined;
  }
  const capture = params.capture;
  const globalRect = capture?.globalRect;
  const frameSize = capture?.frameSize;
  if (!globalRect || !frameSize || globalRect.width <= 0 || globalRect.height <= 0) {
    return rect;
  }
  const projected = {
    x: ((rect.x - globalRect.x) / globalRect.width) * frameSize.width,
    y: ((rect.y - globalRect.y) / globalRect.height) * frameSize.height,
    width: (rect.width / globalRect.width) * frameSize.width,
    height: (rect.height / globalRect.height) * frameSize.height,
  };
  return clipRectToFrame(projected, frameSize);
}

function candidateSignature(candidate: Pick<ComputerUseCandidate, "label" | "rect">): string {
  const label = normalizeOptionalString(candidate.label)?.toLowerCase() ?? "unknown";
  const rect = candidate.rect;
  if (!rect) {
    return label;
  }
  return [
    label,
    Math.round(rect.x / 12),
    Math.round(rect.y / 12),
    Math.round(rect.width / 12),
    Math.round(rect.height / 12),
  ].join("|");
}

function normalizeCandidateStablePart(value: string | undefined, fallback = "unknown"): string {
  const normalized = normalizeOptionalString(value)
    ?.toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[|:]+/g, " ")
    .trim();
  return normalized || fallback;
}

function rectSignature(rect: ComputerUseRect | undefined): string | undefined {
  if (!rect) {
    return undefined;
  }
  return [
    Math.round(rect.x / 8),
    Math.round(rect.y / 8),
    Math.round(rect.width / 8),
    Math.round(rect.height / 8),
  ].join(",");
}

function buildAxCandidateConfidence(node: ComputerUseAxNode, depth: number): number {
  const roleBias = INTERACTIVE_AX_ROLES.has(node.role) ? 0.94 : 0.78;
  const stateBias =
    (node.focused ? 0.03 : 0) +
    (node.selected ? 0.03 : 0) +
    (node.editable ? 0.04 : 0) +
    (node.rect ? 0.02 : -0.03);
  const depthPenalty = Math.min(depth, 8) * 0.025;
  return clampConfidence(roleBias + stateBias - depthPenalty, 0.42, 0.98);
}

function buildAxActionCapabilities(node: ComputerUseAxNode): string[] {
  const capabilities = new Set<string>();
  const actions = new Set(node.actions ?? []);
  if (actions.has("AXPress") || INTERACTIVE_AX_ROLES.has(node.role)) {
    capabilities.add("press");
    capabilities.add("click");
  }
  if (actions.has("AXShowMenu")) {
    capabilities.add("select");
  }
  if (
    node.editable ||
    node.role === "AXTextArea" ||
    node.role === "AXTextField" ||
    node.role === "AXSearchField"
  ) {
    capabilities.add("type");
    capabilities.add("setText");
  }
  if (
    actions.has("AXScrollToVisible") ||
    node.role === "AXScrollArea" ||
    node.role === "AXList" ||
    node.role === "AXOutline"
  ) {
    capabilities.add("scroll");
  }
  if (
    node.role === "AXMenuItem" ||
    node.role === "AXRow" ||
    node.role === "AXTab" ||
    node.selected !== undefined
  ) {
    capabilities.add("select");
  }
  return [...capabilities];
}

function normalizeAxRole(value: string | undefined): string {
  return normalizeOptionalString(value)?.toLowerCase().replace(/^ax/, "") ?? "";
}

function isModalAxSurface(node: ComputerUseAxNode): boolean {
  const role = normalizeAxRole(node.role);
  const subrole = normalizeAxRole(node.subrole);
  const label =
    normalizeOptionalString(
      node.label ?? node.description ?? node.help ?? node.value ?? undefined,
    )?.toLowerCase() ?? "";
  const roleCanNameSurface =
    role === "window" || role === "group" || role === "dialog" || role === "webarea";
  return (
    role === "dialog" ||
    role === "sheet" ||
    role === "popover" ||
    subrole === "dialog" ||
    subrole === "sheet" ||
    subrole === "popover" ||
    (roleCanNameSurface &&
      (label.includes("modal") ||
        label.includes("popover") ||
        label.includes("command-bar") ||
        label.includes("command palette")))
  );
}

function rectArea(rect: ComputerUseRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function rectCenterInsideRect(inner: ComputerUseRect, outer: ComputerUseRect): boolean {
  const center = centerOfRect(inner);
  return (
    center.x >= outer.x &&
    center.x <= outer.x + outer.width &&
    center.y >= outer.y &&
    center.y <= outer.y + outer.height
  );
}

function findActiveModalAxRect(
  nodes: ComputerUseAxNode[] | undefined,
  capture: ComputerUseCaptureDiagnostics | undefined,
): ComputerUseRect | undefined {
  const modalRects: ComputerUseRect[] = [];
  const queue = [...(nodes ?? [])];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) {
      continue;
    }
    const rect = projectRectToFrame({ rect: node.rect, capture });
    if (rect && isModalAxSurface(node) && rect.width >= 80 && rect.height >= 40) {
      modalRects.push(rect);
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      queue.push(...node.children);
    }
  }
  return modalRects.toSorted((left, right) => rectArea(left) - rectArea(right))[0];
}

function buildCandidatesFromAx(
  nodes: ComputerUseAxNode[] | undefined,
  capture: ComputerUseCaptureDiagnostics | undefined,
  limit = 10,
): ComputerUseCandidate[] {
  const candidates: ComputerUseCandidate[] = [];
  const seen = new Set<string>();
  const queue = (nodes ?? []).map((node) => ({ node, depth: 0 }));
  const activeModalRect = findActiveModalAxRect(nodes, capture);
  while (queue.length > 0 && candidates.length < limit) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const { node, depth } = current;
    if (isAxCandidateNode(node)) {
      const projectedRect = projectRectToFrame({ rect: node.rect, capture });
      if (
        activeModalRect &&
        (!projectedRect || !rectCenterInsideRect(projectedRect, activeModalRect))
      ) {
        if (Array.isArray(node.children) && node.children.length > 0) {
          queue.push(...node.children.map((child) => ({ node: child, depth: depth + 1 })));
        }
        continue;
      }
      const actionCapabilities = buildAxActionCapabilities(node);
      const axPath = node.path?.join(".") ?? node.id;
      const axIdentifier = normalizeOptionalString(node.axIdentifier) ?? undefined;
      const candidate: ComputerUseCandidate = {
        id: node.id,
        sourceId: axIdentifier ?? axPath,
        ...(axIdentifier ? { axIdentifier } : {}),
        ...(axPath ? { axPath } : {}),
        ...(node.rolePath?.length ? { rolePath: node.rolePath } : {}),
        ...(node.labelPath?.length ? { labelPath: node.labelPath } : {}),
        label:
          normalizeCandidateLabel(
            node.label ?? node.value ?? node.description ?? node.help ?? node.url ?? undefined,
          ) ?? node.id,
        role: buildCandidateRole(node),
        source: "ax",
        confidence: buildAxCandidateConfidence(node, depth),
        ...(projectedRect ? { rect: projectedRect } : {}),
        ...(actionCapabilities.length > 0 ? { actionCapabilities } : {}),
      };
      const signature = candidateSignature(candidate);
      if (!seen.has(signature)) {
        seen.add(signature);
        candidates.push(candidate);
      }
    }
    if (Array.isArray(node.children) && node.children.length > 0) {
      queue.push(...node.children.map((child) => ({ node: child, depth: depth + 1 })));
    }
  }
  return candidates;
}

function buildOcrCandidateConfidence(confidence: number | undefined): number {
  return clampConfidence((typeof confidence === "number" ? confidence : 0.72) * 0.96, 0.38, 0.96);
}

function isLikelyTextEntryLabel(label: string | undefined): boolean {
  const normalized = normalizeOptionalString(label)?.toLowerCase() ?? "";
  if (!normalized) {
    return false;
  }
  return [
    "搜索",
    "输入",
    "问你想问",
    "问题",
    "关键词",
    "search",
    "ask",
    "message",
    "type",
    "input",
  ].some((token) => normalized.includes(token));
}

function buildOcrActionCapabilities(label: string | undefined): string[] {
  const capabilities = new Set<string>(["click"]);
  if (isLikelyTextEntryLabel(label)) {
    capabilities.add("type");
  }
  return [...capabilities];
}

function normalizeOcrRankingLabel(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase().replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function buildOcrLabelCounts(regions: ComputerUseOcrRegion[] | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const region of regions ?? []) {
    const label = normalizeOcrRankingLabel(region.text);
    if (!label) {
      continue;
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}

function repeatedOcrLabelPenalty(
  label: string | undefined,
  labelCounts: Map<string, number>,
): number {
  const normalized = normalizeOcrRankingLabel(label);
  if (!normalized) {
    return 0;
  }
  const count = labelCounts.get(normalized) ?? 0;
  if (count < 4) {
    return 0;
  }
  return Math.min(0.48, 0.12 * (count - 3));
}

function scoreOcrCandidateForRanking(
  candidate: ComputerUseCandidate,
  labelCounts: Map<string, number>,
): number {
  const confidence = candidate.confidence ?? 0;
  const lineBonus = candidate.role === "ocr_line" ? 0.025 : 0;
  const textEntryBonus = isLikelyTextEntryLabel(candidate.label) ? 0.02 : 0;
  return (
    confidence + lineBonus + textEntryBonus - repeatedOcrLabelPenalty(candidate.label, labelCounts)
  );
}

function rankOcrCandidates(
  candidates: ComputerUseCandidate[],
  labelCounts: Map<string, number>,
  limit: number,
): ComputerUseCandidate[] {
  return candidates
    .toSorted((left, right) => {
      const scoreDelta =
        scoreOcrCandidateForRanking(right, labelCounts) -
        scoreOcrCandidateForRanking(left, labelCounts);
      if (Math.abs(scoreDelta) > 0.001) {
        return scoreDelta;
      }
      const confidenceDelta = (right.confidence ?? 0) - (left.confidence ?? 0);
      if (Math.abs(confidenceDelta) > 0.001) {
        return confidenceDelta;
      }
      const leftRect = left.rect;
      const rightRect = right.rect;
      if (leftRect && rightRect) {
        const yDelta = leftRect.y - rightRect.y;
        if (Math.abs(yDelta) > 1) {
          return yDelta;
        }
        return leftRect.x - rightRect.x;
      }
      return (right.label?.length ?? 0) - (left.label?.length ?? 0);
    })
    .slice(0, limit);
}

function unionRects(rects: ComputerUseRect[]): ComputerUseRect | undefined {
  if (rects.length === 0) {
    return undefined;
  }
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function expandOcrInteractionRect(params: {
  rect: ComputerUseRect;
  frameSize?: ComputerUseCaptureDiagnostics["frameSize"];
}): ComputerUseRect {
  const horizontalPadding = Math.max(24, params.rect.height * 1.2);
  const verticalPadding = Math.max(16, params.rect.height * 1.4);
  const expanded = {
    x: params.rect.x - horizontalPadding,
    y: params.rect.y - verticalPadding,
    width: params.rect.width + horizontalPadding * 2,
    height: params.rect.height + verticalPadding * 2,
  };
  return (
    clipRectToFrame(expanded, params.frameSize) ?? {
      x: Math.max(0, expanded.x),
      y: Math.max(0, expanded.y),
      width: Math.max(1, expanded.width),
      height: Math.max(1, expanded.height),
    }
  );
}

function groupOcrRegionsIntoLines(regions: ComputerUseOcrRegion[]): ComputerUseOcrRegion[][] {
  const sorted = regions.toSorted((left, right) => {
    const yDelta = left.rect.y - right.rect.y;
    if (Math.abs(yDelta) > 1) {
      return yDelta;
    }
    return left.rect.x - right.rect.x;
  });
  const groups: ComputerUseOcrRegion[][] = [];
  for (const region of sorted) {
    const centerY = region.rect.y + region.rect.height / 2;
    const group = groups.find((candidateGroup) => {
      const groupRect = unionRects(candidateGroup.map((item) => item.rect));
      if (!groupRect) {
        return false;
      }
      const groupCenterY = groupRect.y + groupRect.height / 2;
      const tolerance = Math.max(12, Math.min(groupRect.height, region.rect.height) * 0.65);
      if (Math.abs(centerY - groupCenterY) > tolerance) {
        return false;
      }
      const regionLeft = region.rect.x;
      const regionRight = region.rect.x + region.rect.width;
      const groupLeft = groupRect.x;
      const groupRight = groupRect.x + groupRect.width;
      const horizontalGap =
        regionLeft > groupRight
          ? regionLeft - groupRight
          : groupLeft > regionRight
            ? groupLeft - regionRight
            : 0;
      const averageHeight =
        candidateGroup.reduce((total, item) => total + item.rect.height, region.rect.height) /
        (candidateGroup.length + 1);
      const maxJoinGap = Math.max(32, Math.min(180, averageHeight * 4));
      return horizontalGap <= maxJoinGap;
    });
    if (group) {
      group.push(region);
    } else {
      groups.push([region]);
    }
  }
  return groups.map((group) => group.sort((left, right) => left.rect.x - right.rect.x));
}

function isUsableOcrLineRect(params: {
  rect: ComputerUseRect;
  groupSize: number;
  frameSize?: ComputerUseCaptureDiagnostics["frameSize"];
}): boolean {
  if (!params.frameSize || params.groupSize <= 1) {
    return true;
  }
  if (params.rect.width > params.frameSize.width * 0.55) {
    return false;
  }
  return true;
}

function buildCandidatesFromOcrLines(params: {
  snapshot?: ComputerUseOcrSnapshot;
  capture?: ComputerUseCaptureDiagnostics;
  limit?: number;
}): ComputerUseCandidate[] {
  const frameSize = params.capture?.frameSize ?? params.snapshot?.diagnostics?.capture?.frameSize;
  const groups = groupOcrRegionsIntoLines(params.snapshot?.regions ?? []);
  const candidates: ComputerUseCandidate[] = [];
  for (const [index, group] of groups.entries()) {
    if (group.length === 0) {
      continue;
    }
    const rawRect = unionRects(group.map((region) => region.rect));
    const label = normalizeCandidateLabel(group.map((region) => region.text).join(" "));
    if (!rawRect || !label) {
      continue;
    }
    if (!isUsableOcrLineRect({ rect: rawRect, groupSize: group.length, frameSize })) {
      continue;
    }
    const averageConfidence =
      group.reduce((total, region) => total + (region.confidence ?? 0.72), 0) / group.length;
    candidates.push({
      id: `ocr-line:${index + 1}`,
      sourceId: group.map((region) => region.id).join("+"),
      label,
      role: "ocr_line",
      source: "ocr",
      confidence: clampConfidence(averageConfidence * 0.9, 0.42, 0.93),
      rect: expandOcrInteractionRect({ rect: rawRect, frameSize }),
      actionCapabilities: buildOcrActionCapabilities(label),
    });
  }
  return rankOcrCandidates(
    candidates,
    buildOcrLabelCounts(params.snapshot?.regions),
    params.limit ?? 10,
  );
}

function buildCandidatesFromOcr(
  snapshot: ComputerUseOcrSnapshot | undefined,
  limit = 10,
): ComputerUseCandidate[] {
  const candidates: ComputerUseCandidate[] = [];
  const seen = new Set<string>();
  for (const region of snapshot?.regions ?? []) {
    const candidate: ComputerUseCandidate = {
      id: region.id,
      sourceId: region.id,
      label: normalizeCandidateLabel(region.text) ?? region.id,
      role: "ocr_text",
      source: "ocr",
      confidence: buildOcrCandidateConfidence(region.confidence),
      rect: region.rect,
      actionCapabilities: buildOcrActionCapabilities(region.text),
    };
    const signature = candidateSignature(candidate);
    if (!seen.has(signature)) {
      seen.add(signature);
      candidates.push(candidate);
    }
  }
  return rankOcrCandidates(candidates, buildOcrLabelCounts(snapshot?.regions), limit);
}

function buildCdpActionCapabilities(node: ComputerUseCdpNode): string[] {
  const capabilities = new Set<string>(node.actionCapabilities ?? []);
  const role = normalizeOptionalString(node.role)?.toLowerCase();
  if (role && INTERACTIVE_CDP_ROLES.has(role)) {
    capabilities.add("click");
    capabilities.add("press");
  }
  if (node.editable || role === "textbox" || role === "searchbox") {
    capabilities.add("type");
    capabilities.add("setText");
  }
  if (role === "combobox" || role === "listbox" || role === "menuitem" || role === "tab") {
    capabilities.add("select");
  }
  capabilities.add("scroll");
  return [...capabilities];
}

function buildCdpCandidateConfidence(node: ComputerUseCdpNode): number {
  const role = normalizeOptionalString(node.role)?.toLowerCase();
  const roleBias = role && INTERACTIVE_CDP_ROLES.has(role) ? 0.91 : 0.72;
  const geometryBias = node.rect ? 0.04 : -0.16;
  const enabledPenalty = node.enabled === false ? -0.18 : 0;
  const mappingPenalty = node.coordinateMapping === "unmapped" ? -0.2 : 0;
  return clampConfidence(roleBias + geometryBias + enabledPenalty + mappingPenalty, 0.36, 0.97);
}

function buildCandidatesFromCdp(
  snapshot: ComputerUseCdpSnapshot | undefined,
  limit = 10,
): ComputerUseCandidate[] {
  const candidates: ComputerUseCandidate[] = [];
  const seen = new Set<string>();
  for (const node of snapshot?.nodes ?? []) {
    if (candidates.length >= limit) {
      break;
    }
    if (!node.rect || node.coordinateMapping === "unmapped") {
      continue;
    }
    const label = normalizeCandidateLabel(node.label ?? node.text ?? node.href ?? undefined);
    if (!label) {
      continue;
    }
    const actionCapabilities = buildCdpActionCapabilities(node);
    const candidate: ComputerUseCandidate = {
      id: node.id,
      sourceId: node.id,
      label,
      role: normalizeOptionalString(node.role) ?? "dom_node",
      source: "cdp",
      confidence: buildCdpCandidateConfidence(node),
      rect: node.rect,
      ...(actionCapabilities.length > 0 ? { actionCapabilities } : {}),
    };
    const signature = candidateSignature(candidate);
    if (!seen.has(signature)) {
      seen.add(signature);
      candidates.push(candidate);
    }
  }
  return candidates;
}

function candidateSourceRank(source: ComputerUseCandidate["source"] | undefined): number {
  if (source === "ax") {
    return 0;
  }
  if (source === "cdp") {
    return 1;
  }
  if (source === "ocr") {
    return 2;
  }
  if (source === "vision") {
    return 3;
  }
  return 4;
}

function mergeCandidateLists(
  candidates: ComputerUseCandidate[],
  limit: number,
): ComputerUseCandidate[] {
  const merged = new Map<string, ComputerUseCandidate>();
  for (const candidate of candidates) {
    const signature = candidateSignature(candidate);
    const existing = merged.get(signature);
    if (!existing) {
      merged.set(signature, candidate);
      continue;
    }
    const existingScore = existing.confidence ?? 0;
    const nextScore = candidate.confidence ?? 0;
    if (nextScore > existingScore + 0.01) {
      merged.set(signature, candidate);
      continue;
    }
    if (
      Math.abs(nextScore - existingScore) <= 0.01 &&
      candidateSourceRank(candidate.source) < candidateSourceRank(existing.source)
    ) {
      merged.set(signature, candidate);
    }
  }
  return [...merged.values()]
    .toSorted((left, right) => {
      const confidenceDiff = (right.confidence ?? 0) - (left.confidence ?? 0);
      if (Math.abs(confidenceDiff) > 0.001) {
        return confidenceDiff;
      }
      const sourceRankDelta = candidateSourceRank(left.source) - candidateSourceRank(right.source);
      if (sourceRankDelta !== 0) {
        return sourceRankDelta;
      }
      return (right.label?.length ?? 0) - (left.label?.length ?? 0);
    })
    .slice(0, limit);
}

function buildCandidateStableKey(params: {
  candidate: ComputerUseCandidate;
  observation?: ComputerUseObservation;
}): string {
  const candidate = params.candidate;
  const targetId = normalizeOptionalString(params.observation?.targetId) ?? "target:unknown";
  const source = candidate.source ?? "candidate";
  const axIdentifier = normalizeCandidateStablePart(candidate.axIdentifier, "");
  const sourceId = normalizeCandidateStablePart(candidate.sourceId, "");
  const role = normalizeCandidateStablePart(candidate.role);
  const label = normalizeCandidateStablePart(candidate.label);
  const rect = rectSignature(candidate.rect) ?? "no-rect";
  return [
    targetId,
    source,
    axIdentifier ? `axid=${axIdentifier}` : "",
    sourceId ? `sid=${sourceId}` : "",
    role,
    label,
    rect,
  ]
    .filter(Boolean)
    .join(":");
}

function buildCandidateSelector(params: {
  candidate: ComputerUseCandidate;
  observation?: ComputerUseObservation;
}): NonNullable<ComputerUseCandidate["selector"]> {
  const candidate = params.candidate;
  return {
    targetId: normalizeOptionalString(params.observation?.targetId) ?? undefined,
    source: candidate.source,
    role: candidate.role,
    label: candidate.label,
    sourceId: candidate.sourceId,
    axIdentifier: candidate.axIdentifier,
    axPath: candidate.axPath,
    rolePath: candidate.rolePath,
    labelPath: candidate.labelPath,
    rectSignature: rectSignature(candidate.rect),
  };
}

function assignElementRefs(params: {
  candidates: ComputerUseCandidate[];
  observation?: ComputerUseObservation;
}): ComputerUseCandidate[] {
  return params.candidates.map((candidate, index) => {
    const ref = `@e${index + 1}`;
    return {
      ...candidate,
      ref,
      stableKey:
        candidate.stableKey ??
        buildCandidateStableKey({
          candidate,
          observation: params.observation,
        }),
      selector:
        candidate.selector ??
        buildCandidateSelector({
          candidate,
          observation: params.observation,
        }),
    };
  });
}

function buildCandidateProposals(params: {
  axSnapshot?: ComputerUseAxSnapshot;
  cdpSnapshot?: ComputerUseCdpSnapshot;
  ocrSnapshot?: ComputerUseOcrSnapshot;
  capture?: ComputerUseCaptureDiagnostics;
  observation?: ComputerUseObservation;
  limit?: number;
}): ComputerUseCandidate[] | undefined {
  const limit = Math.max(1, params.limit ?? 12);
  const candidates = mergeCandidateLists(
    [
      ...buildCandidatesFromAx(params.axSnapshot?.nodes, params.capture, limit),
      ...buildCandidatesFromCdp(params.cdpSnapshot, limit),
      ...buildCandidatesFromOcrLines({
        snapshot: params.ocrSnapshot,
        capture: params.capture,
        limit,
      }),
      ...buildCandidatesFromOcr(params.ocrSnapshot, limit),
    ],
    limit,
  );
  return candidates.length > 0
    ? assignElementRefs({ candidates, observation: params.observation })
    : undefined;
}

function collectCandidateHighlights(
  candidates: ComputerUseCandidate[] | undefined,
  limit = 6,
): string[] {
  return (candidates ?? []).slice(0, limit).map((candidate) => {
    const parts = [
      candidate.ref ?? candidate.id,
      candidate.label ?? candidate.id,
      candidate.role ?? "candidate",
      candidate.source ?? "",
    ];
    if (candidate.actionCapabilities && candidate.actionCapabilities.length > 0) {
      parts.push(`actions=${candidate.actionCapabilities.slice(0, 3).join("/")}`);
    }
    if (typeof candidate.confidence === "number") {
      parts.push(`${Math.round(candidate.confidence * 100)}%`);
    }
    return parts.filter(Boolean).join(" | ");
  });
}

function normalizeTargetLookupValue(value: string | undefined): string | undefined {
  return normalizeOptionalString(value)?.toLowerCase() ?? undefined;
}

function collectWindowTargetHighlights(
  targets: ComputerUseWindowTarget[] | undefined,
  limit = 12,
): string[] {
  return (targets ?? []).slice(0, limit).map((target) => {
    const parts = [
      target.targetId ? `targetId=${target.targetId}` : "",
      target.appName,
      target.windowTitle ? `window=${target.windowTitle}` : "",
      `windowId=${target.windowId}`,
      target.bundleId ? `bundle=${target.bundleId}` : "",
      target.isFocused ? "focused=yes" : "",
    ].filter(Boolean);
    return parts.join(" | ");
  });
}

function scoreAppTargetForModelSummary(target: ComputerUseAppTarget): number {
  const appName = normalizeOptionalString(target.appName)?.toLowerCase() ?? "";
  const bundleId = normalizeOptionalString(target.bundleId)?.toLowerCase() ?? "";
  const activationPolicy = normalizeOptionalString(target.activationPolicy)?.toLowerCase();
  const visibleWindowCount =
    typeof target.visibleWindowCount === "number" ? target.visibleWindowCount : 0;
  const isHelperLike =
    /helper|renderer|plugin|gpu|networking|web content|service|agent|daemon/.test(appName) ||
    /helper|renderer|plugin|webkit|gpu|networking|xpc|agent|daemon/.test(bundleId);
  const isSystemAccessory =
    activationPolicy === "accessory" ||
    bundleId.startsWith("com.apple.") ||
    appName.startsWith("com.apple.");
  return (
    (target.isFrontmost ? 10_000 : 0) +
    (visibleWindowCount > 0 ? 5_000 + Math.min(visibleWindowCount, 9) * 100 : 0) +
    (activationPolicy === "regular" ? 3_000 : 0) +
    (!isHelperLike ? 500 : -1_000) +
    (!isSystemAccessory ? 250 : -500)
  );
}

function collectAppTargetHighlights(
  targets: ComputerUseAppTarget[] | undefined,
  limit = 24,
): string[] {
  return (targets ?? [])
    .toSorted((left, right) => {
      const scoreDelta = scoreAppTargetForModelSummary(right) - scoreAppTargetForModelSummary(left);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      const leftName = normalizeOptionalString(left.appName) ?? "";
      const rightName = normalizeOptionalString(right.appName) ?? "";
      return leftName.localeCompare(rightName);
    })
    .slice(0, limit)
    .map((target) => {
      const parts = [
        target.targetId ? `targetId=${target.targetId}` : "",
        target.appName,
        target.bundleId ? `bundle=${target.bundleId}` : "",
        `pid=${target.processId}`,
        typeof target.visibleWindowCount === "number"
          ? `visibleWindows=${target.visibleWindowCount}`
          : "",
        target.isFrontmost ? "frontmost=yes" : "",
        target.activationPolicy ? `policy=${target.activationPolicy}` : "",
      ].filter(Boolean);
      return parts.join(" | ");
    });
}

function collectDisplayTargetHighlights(
  targets: ComputerUseTargetCatalog["displays"] | undefined,
  limit = 8,
): string[] {
  return (targets ?? []).slice(0, limit).map((target) => {
    const parts = [
      target.targetId ? `targetId=${target.targetId}` : "",
      target.name ?? target.displayId,
      `display=${target.displayId}`,
      target.isPrimary ? "primary=yes" : "",
      typeof target.scaleFactor === "number" ? `scale=${target.scaleFactor}` : "",
    ].filter(Boolean);
    return parts.join(" | ");
  });
}

function collectCdpEndpointHighlights(
  targets: ComputerUseTargetCatalog["cdpEndpoints"] | undefined,
  limit = 6,
): string[] {
  return (targets ?? []).slice(0, limit).map((target) => {
    const firstPage = target.pages?.[0];
    const parts = [
      target.endpointId ? `endpointId=${target.endpointId}` : "",
      `${target.host}:${target.port}`,
      target.browser ? `browser=${target.browser}` : "",
      target.protocolVersion ? `protocol=${target.protocolVersion}` : "",
      typeof target.pageCount === "number" ? `pages=${target.pageCount}` : "",
      firstPage?.title ? `firstPage=${trimModelText(firstPage.title, 80)}` : "",
    ].filter(Boolean);
    return parts.join(" | ");
  });
}

type PreparedComputerUseFocusTarget = {
  targetId?: string;
  appName?: string;
  bundleId?: string;
  windowId?: string;
};

type PreparedComputerUseFocusIntent =
  | {
      ok: true;
      args: Record<string, unknown>;
      focusTarget: PreparedComputerUseFocusTarget;
      targets?: ComputerUseTargetCatalog;
      warning?: string;
    }
  | {
      ok: false;
      summary: string;
      error: string;
      targets?: ComputerUseTargetCatalog;
      warning?: string;
    };

function describePreparedFocusTarget(target: PreparedComputerUseFocusTarget): string {
  if (target.targetId) {
    return target.targetId;
  }
  if (target.appName && target.windowId) {
    return `${target.appName} (${target.windowId})`;
  }
  if (target.appName && target.bundleId) {
    return `${target.appName} [${target.bundleId}]`;
  }
  if (target.appName) {
    return target.appName;
  }
  if (target.bundleId) {
    return target.bundleId;
  }
  if (target.windowId) {
    return `window ${target.windowId}`;
  }
  return "the requested desktop target";
}

function focusTargetMatchesExpectation(params: {
  focusTarget: PreparedComputerUseFocusTarget;
  observation?: ComputerUseObservation;
  axSnapshot?: ComputerUseAxSnapshot;
}): boolean {
  const expectedWindowId = normalizeTargetLookupValue(params.focusTarget.windowId);
  const expectedTargetId = normalizeTargetLookupValue(params.focusTarget.targetId);
  const expectedBundleId = normalizeTargetLookupValue(params.focusTarget.bundleId);
  const expectedAppName = normalizeTargetLookupValue(params.focusTarget.appName);
  const observedWindowId =
    normalizeTargetLookupValue(params.observation?.windowId) ??
    normalizeTargetLookupValue(params.axSnapshot?.windowId);
  const observedBundleId = normalizeTargetLookupValue(params.observation?.bundleId);
  const observedAppName =
    normalizeTargetLookupValue(params.observation?.appName) ??
    normalizeTargetLookupValue(params.axSnapshot?.appName);

  if (
    expectedTargetId &&
    normalizeTargetLookupValue(params.observation?.targetId) === expectedTargetId
  ) {
    return true;
  }
  if (expectedWindowId && observedWindowId === expectedWindowId) {
    return true;
  }
  if (expectedWindowId && (expectedBundleId || expectedAppName)) {
    if (expectedBundleId && observedBundleId) {
      return observedBundleId === expectedBundleId;
    }
    if (expectedAppName && observedAppName) {
      return observedAppName === expectedAppName;
    }
    return false;
  }
  if (expectedWindowId) {
    return false;
  }
  if (expectedBundleId && observedBundleId) {
    return observedBundleId === expectedBundleId;
  }
  if (expectedAppName) {
    return observedAppName === expectedAppName;
  }
  if (expectedBundleId) {
    return observedBundleId === expectedBundleId;
  }
  return true;
}

function readElementRef(args: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalString(readStringParam(args, "elementRef")) ??
    normalizeOptionalString(readStringParam(args, "candidateId")) ??
    normalizeOptionalString(readStringParam(args, "ref")) ??
    undefined
  );
}

function centerOfRect(rect: ComputerUseRect): ComputerUsePoint {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

function findCandidateByRef(
  candidates: ComputerUseCandidate[] | undefined,
  elementRef: string | undefined,
): ComputerUseCandidate | undefined {
  const normalizedRef = normalizeOptionalString(elementRef);
  if (!normalizedRef) {
    return undefined;
  }
  return (candidates ?? []).find(
    (candidate) =>
      candidate.ref === normalizedRef ||
      candidate.id === normalizedRef ||
      candidate.sourceId === normalizedRef ||
      candidate.stableKey === normalizedRef,
  );
}

function normalizeCandidateRoleForGrounding(role: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(role)
    ?.toLowerCase()
    .replace(/^ax/, "")
    .replace(/[^a-z0-9]+/g, "");
  return normalized || undefined;
}

function candidateSupportsPointGrounding(candidate: ComputerUseCandidate): boolean {
  if (!candidate.rect) {
    return false;
  }
  const capabilities = new Set(candidate.actionCapabilities ?? []);
  for (const capability of capabilities) {
    if (POINT_GROUNDING_ACTION_CAPABILITIES.has(capability)) {
      return true;
    }
  }
  if (candidate.source === "ocr" || candidate.source === "vision") {
    return capabilities.size === 0 || capabilities.has("click") || capabilities.has("press");
  }
  if (capabilities.size === 1 && capabilities.has("select")) {
    return false;
  }
  const role = normalizeCandidateRoleForGrounding(candidate.role);
  if (role && POINT_GROUNDING_CONTAINER_ROLES.has(role)) {
    return false;
  }
  return false;
}

function pointGroundingCandidates(
  candidates: ComputerUseCandidate[] | undefined,
): ComputerUseCandidate[] {
  return (candidates ?? []).filter(candidateSupportsPointGrounding);
}

function findCandidateByPoint(
  candidates: ComputerUseCandidate[] | undefined,
  point: ComputerUsePoint | undefined,
): ComputerUseCandidate | undefined {
  if (!point) {
    return undefined;
  }
  return pointGroundingCandidates(candidates).find((candidate) => {
    const rect = candidate.rect;
    if (!rect) {
      return false;
    }
    return (
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    );
  });
}

function distanceFromPointToRect(point: ComputerUsePoint, rect: ComputerUseRect): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

function findNearbyCandidateByPoint(
  candidates: ComputerUseCandidate[] | undefined,
  point: ComputerUsePoint | undefined,
): ComputerUseCandidate | undefined {
  if (!point) {
    return undefined;
  }
  const ranked = pointGroundingCandidates(candidates)
    .filter((candidate) => Boolean(candidate.rect))
    .map((candidate) => {
      const rect = candidate.rect!;
      const distance = distanceFromPointToRect(point, rect);
      const tolerance = Math.max(24, Math.min(56, Math.max(rect.width, rect.height) * 0.2));
      return { candidate, distance, tolerance };
    })
    .filter((item) => item.distance <= item.tolerance)
    .toSorted((left, right) => {
      const distanceDelta = left.distance - right.distance;
      if (Math.abs(distanceDelta) > 0.001) {
        return distanceDelta;
      }
      return (right.candidate.confidence ?? 0) - (left.candidate.confidence ?? 0);
    });
  return ranked[0]?.candidate;
}

function validCoordinateScale(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 1.1 || value > 4) {
    return undefined;
  }
  return value;
}

function candidateCoordinateScales(target?: ComputerUseTargetBinding): number[] {
  const scales = new Set<number>();
  const captureScale = validCoordinateScale(target?.capture?.scaleFactor);
  if (captureScale) {
    scales.add(captureScale);
  }
  const displayScale = validCoordinateScale(target?.display?.scaleFactor);
  if (displayScale) {
    scales.add(displayScale);
  }
  const frameWidth = target?.frameSize?.width;
  const frameHeight = target?.frameSize?.height;
  const logicalWidth = target?.logicalSize?.width;
  const logicalHeight = target?.logicalSize?.height;
  const widthScale =
    typeof frameWidth === "number" &&
    typeof logicalWidth === "number" &&
    frameWidth > 0 &&
    logicalWidth > 0
      ? validCoordinateScale(frameWidth / logicalWidth)
      : undefined;
  const heightScale =
    typeof frameHeight === "number" &&
    typeof logicalHeight === "number" &&
    frameHeight > 0 &&
    logicalHeight > 0
      ? validCoordinateScale(frameHeight / logicalHeight)
      : undefined;
  if (widthScale && heightScale && Math.abs(widthScale - heightScale) <= 0.05) {
    scales.add((widthScale + heightScale) / 2);
  } else {
    if (widthScale) {
      scales.add(widthScale);
    }
    if (heightScale) {
      scales.add(heightScale);
    }
  }
  return [...scales].toSorted((left, right) => left - right);
}

function scalePoint(point: ComputerUsePoint, scale: number): ComputerUsePoint {
  return {
    x: point.x * scale,
    y: point.y * scale,
  };
}

function resolveCoordinateScaledCandidate(params: {
  candidates?: ComputerUseCandidate[];
  point?: ComputerUsePoint;
  target?: ComputerUseTargetBinding;
}): { candidate: ComputerUseCandidate; point: ComputerUsePoint } | undefined {
  if (!params.point) {
    return undefined;
  }
  for (const scale of candidateCoordinateScales(params.target)) {
    const scaledPoint = scalePoint(params.point, scale);
    const matched =
      findCandidateByPoint(params.candidates, scaledPoint) ??
      findNearbyCandidateByPoint(params.candidates, scaledPoint);
    if (matched) {
      return {
        candidate: matched,
        point: matched.rect ? centerOfRect(matched.rect) : scaledPoint,
      };
    }
  }
  return undefined;
}

function resolveSelectedTarget(params: {
  point?: ComputerUsePoint;
  elementRef?: string;
  candidates?: ComputerUseCandidate[];
  target?: ComputerUseTargetBinding;
}): ComputerUseSelectedTarget | undefined {
  const matchedByRef = findCandidateByRef(params.candidates, params.elementRef);
  if (params.elementRef && !matchedByRef) {
    return undefined;
  }
  if (matchedByRef) {
    return selectedTargetFromCandidate(matchedByRef);
  }
  const matchedByPoint = findCandidateByPoint(params.candidates, params.point);
  const scaled = matchedByPoint
    ? undefined
    : resolveCoordinateScaledCandidate({
        candidates: params.candidates,
        point: params.point,
        target: params.target,
      });
  const matched =
    matchedByPoint ??
    scaled?.candidate ??
    findNearbyCandidateByPoint(params.candidates, params.point);
  const point =
    scaled?.point ??
    (!params.point || matchedByPoint
      ? (params.point ?? (matched?.rect ? centerOfRect(matched.rect) : undefined))
      : matched?.rect
        ? centerOfRect(matched.rect)
        : params.point);
  if (!matched && !point) {
    return undefined;
  }
  return {
    ...(matched?.id ? { candidateId: matched.id } : {}),
    ...(matched?.ref ? { elementRef: matched.ref } : {}),
    ...(matched?.selector ? { selector: matched.selector } : {}),
    ...(point ? { point } : {}),
    ...(matched?.rect ? { rect: matched.rect } : {}),
  };
}

function buildActionPayloadPoint(params: {
  selected?: ComputerUseSelectedTarget;
  args: Record<string, unknown>;
}): ComputerUsePoint | undefined {
  return params.selected?.point ?? readOptionalPoint(params.args);
}

function buildPendingActionPayload(params: {
  targetId?: string;
  selected?: ComputerUseSelectedTarget;
  args: Record<string, unknown>;
}): ComputerUsePendingActionPayload | undefined {
  const point = buildActionPayloadPoint({ selected: params.selected, args: params.args });
  const targetId =
    normalizeOptionalString(params.targetId) ??
    normalizeOptionalString(readStringParam(params.args, "targetId")) ??
    undefined;
  if (!point && !targetId) {
    return undefined;
  }
  return {
    ...(targetId ? { targetId } : {}),
    ...(params.selected?.selector ? { elementSelector: params.selected.selector } : {}),
    ...(point ? { point } : {}),
  };
}

function actionNeedsGroundedElementPoint(action: ComputerUseAction): boolean {
  return (
    action === "click" ||
    action === "double_click" ||
    action === "right_click" ||
    action === "type" ||
    action === "set_text_submit" ||
    action === "scroll"
  );
}

function availableElementRefs(candidates: ComputerUseCandidate[] | undefined, limit = 8): string {
  const refs = (candidates ?? [])
    .map((candidate) => candidate.ref)
    .filter((ref): ref is string => Boolean(ref))
    .slice(0, limit);
  return refs.length > 0 ? refs.join(", ") : "none";
}

function computerUseCandidateMemoryKey(params: { sessionKey?: string; agentId?: string }): string {
  return (
    normalizeOptionalString(params.sessionKey) ??
    normalizeOptionalString(params.agentId) ??
    "computer-use:default"
  );
}

function pruneComputerUseCandidateMemory(nowMs = Date.now()): void {
  for (const [key, memory] of computerUseCandidateMemoryBySession) {
    if (nowMs - memory.updatedAtMs > COMPUTER_USE_CANDIDATE_MEMORY_TTL_MS) {
      computerUseCandidateMemoryBySession.delete(key);
    }
  }
  while (computerUseCandidateMemoryBySession.size > MAX_COMPUTER_USE_CANDIDATE_MEMORY_SESSIONS) {
    const oldestKey = computerUseCandidateMemoryBySession.keys().next().value;
    if (!oldestKey) {
      break;
    }
    computerUseCandidateMemoryBySession.delete(oldestKey);
  }
}

function clearComputerUseCandidateMemoryForTesting(): void {
  computerUseCandidateMemoryBySession.clear();
}

function rememberComputerUseCandidates(params: {
  sessionKey?: string;
  agentId?: string;
  observation?: ComputerUseObservation;
  candidates?: ComputerUseCandidate[];
}): void {
  if (!params.observation && (!params.candidates || params.candidates.length === 0)) {
    return;
  }
  const nowMs = Date.now();
  pruneComputerUseCandidateMemory(nowMs);
  const key = computerUseCandidateMemoryKey(params);
  computerUseCandidateMemoryBySession.delete(key);
  computerUseCandidateMemoryBySession.set(key, {
    updatedAtMs: nowMs,
    observation: params.observation,
    candidates: (params.candidates ?? []).map((candidate) => ({
      candidate,
      observation: params.observation,
      updatedAtMs: nowMs,
    })),
  });
}

function lookupRememberedComputerUseCandidate(params: {
  sessionKey?: string;
  agentId?: string;
  elementRef?: string;
}): RememberedComputerUseCandidate | undefined {
  const normalizedRef = normalizeOptionalString(params.elementRef);
  if (!normalizedRef) {
    return undefined;
  }
  pruneComputerUseCandidateMemory();
  const memory = computerUseCandidateMemoryBySession.get(computerUseCandidateMemoryKey(params));
  if (!memory) {
    return undefined;
  }
  return memory.candidates.find(
    ({ candidate }) =>
      candidate.ref === normalizedRef ||
      candidate.id === normalizedRef ||
      candidate.sourceId === normalizedRef ||
      candidate.stableKey === normalizedRef,
  );
}

function lookupRememberedComputerUseObservation(params: {
  sessionKey?: string;
  agentId?: string;
  targetId?: string;
  windowId?: string;
  appName?: string;
  bundleId?: string;
}): ComputerUseObservation | undefined {
  const expectedTargetId = normalizeTargetLookupValue(params.targetId);
  const expectedWindowId = normalizeTargetLookupValue(params.windowId);
  const expectedAppName = normalizeTargetLookupValue(params.appName);
  const expectedBundleId = normalizeTargetLookupValue(params.bundleId);
  if (!expectedTargetId && !expectedWindowId && !expectedAppName && !expectedBundleId) {
    return undefined;
  }
  pruneComputerUseCandidateMemory();
  const memory = computerUseCandidateMemoryBySession.get(computerUseCandidateMemoryKey(params));
  const observations = [
    memory?.observation,
    ...(memory?.candidates.map((item) => item.observation) ?? []),
  ].filter((item): item is ComputerUseObservation => Boolean(item));
  return observations.find((observation) => {
    if (expectedTargetId && normalizeTargetLookupValue(observation.targetId) === expectedTargetId) {
      return true;
    }
    if (expectedWindowId && normalizeTargetLookupValue(observation.windowId) === expectedWindowId) {
      return true;
    }
    if (expectedBundleId && normalizeTargetLookupValue(observation.bundleId) === expectedBundleId) {
      return true;
    }
    return Boolean(
      expectedAppName && normalizeTargetLookupValue(observation.appName) === expectedAppName,
    );
  });
}

function targetIdsConflict(left?: string, right?: string): boolean {
  const normalizedLeft = normalizeOptionalString(left);
  const normalizedRight = normalizeOptionalString(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft !== normalizedRight);
}

function candidateSelectorScore(
  candidate: ComputerUseCandidate,
  remembered: RememberedComputerUseCandidate,
  observation?: ComputerUseObservation,
): number {
  const rememberedCandidate = remembered.candidate;
  const candidateSelector = candidate.selector;
  const rememberedSelector = rememberedCandidate.selector;
  const currentTargetId =
    normalizeOptionalString(candidateSelector?.targetId) ??
    normalizeOptionalString(observation?.targetId);
  const rememberedTargetId =
    normalizeOptionalString(rememberedSelector?.targetId) ??
    normalizeOptionalString(remembered.observation?.targetId);
  if (targetIdsConflict(currentTargetId, rememberedTargetId)) {
    return Number.NEGATIVE_INFINITY;
  }
  if (
    normalizeOptionalString(candidate.stableKey) &&
    normalizeOptionalString(candidate.stableKey) ===
      normalizeOptionalString(rememberedCandidate.stableKey)
  ) {
    return 100;
  }
  let score = 0;
  const candidateAxIdentifier =
    normalizeOptionalString(candidateSelector?.axIdentifier) ??
    normalizeOptionalString(candidate.axIdentifier);
  const rememberedAxIdentifier =
    normalizeOptionalString(rememberedSelector?.axIdentifier) ??
    normalizeOptionalString(rememberedCandidate.axIdentifier);
  if (
    candidateAxIdentifier &&
    rememberedAxIdentifier &&
    candidateAxIdentifier !== rememberedAxIdentifier
  ) {
    return Number.NEGATIVE_INFINITY;
  }
  if (
    candidateAxIdentifier &&
    rememberedAxIdentifier &&
    candidateAxIdentifier === rememberedAxIdentifier
  ) {
    score += 40;
  }
  if (currentTargetId && rememberedTargetId && currentTargetId === rememberedTargetId) {
    score += 24;
  }
  if (
    normalizeOptionalString(candidateSelector?.source ?? candidate.source) &&
    normalizeOptionalString(candidateSelector?.source ?? candidate.source) ===
      normalizeOptionalString(rememberedSelector?.source ?? rememberedCandidate.source)
  ) {
    score += 8;
  }
  if (
    normalizeCandidateStablePart(candidateSelector?.role ?? candidate.role) ===
    normalizeCandidateStablePart(rememberedSelector?.role ?? rememberedCandidate.role)
  ) {
    score += 8;
  }
  if (
    normalizeCandidateStablePart(candidateSelector?.label ?? candidate.label) ===
    normalizeCandidateStablePart(rememberedSelector?.label ?? rememberedCandidate.label)
  ) {
    score += 14;
  }
  if (
    normalizeOptionalString(candidateSelector?.sourceId ?? candidate.sourceId) &&
    normalizeOptionalString(candidateSelector?.sourceId ?? candidate.sourceId) ===
      normalizeOptionalString(rememberedSelector?.sourceId ?? rememberedCandidate.sourceId)
  ) {
    score += 3;
  }
  if (
    normalizeOptionalString(candidateSelector?.axPath ?? candidate.axPath) &&
    normalizeOptionalString(candidateSelector?.axPath ?? candidate.axPath) ===
      normalizeOptionalString(rememberedSelector?.axPath ?? rememberedCandidate.axPath)
  ) {
    score += 2;
  }
  const candidateRolePath = (candidateSelector?.rolePath ?? candidate.rolePath ?? []).join(">");
  const rememberedRolePath = (
    rememberedSelector?.rolePath ??
    rememberedCandidate.rolePath ??
    []
  ).join(">");
  if (candidateRolePath && rememberedRolePath && candidateRolePath === rememberedRolePath) {
    score += 8;
  }
  const candidateLabelPath = (candidateSelector?.labelPath ?? candidate.labelPath ?? [])
    .map((item) => normalizeCandidateStablePart(item))
    .join(">");
  const rememberedLabelPath = (rememberedSelector?.labelPath ?? rememberedCandidate.labelPath ?? [])
    .map((item) => normalizeCandidateStablePart(item))
    .join(">");
  if (candidateLabelPath && rememberedLabelPath && candidateLabelPath === rememberedLabelPath) {
    score += 8;
  }
  if (
    normalizeOptionalString(candidateSelector?.rectSignature) &&
    normalizeOptionalString(candidateSelector?.rectSignature) ===
      normalizeOptionalString(rememberedSelector?.rectSignature)
  ) {
    score += 5;
  }
  return score;
}

function candidateMatchesRememberedSelector(params: {
  candidate?: ComputerUseCandidate;
  remembered?: RememberedComputerUseCandidate;
  observation?: ComputerUseObservation;
}): boolean {
  if (!params.candidate || !params.remembered) {
    return false;
  }
  return candidateSelectorScore(params.candidate, params.remembered, params.observation) >= 50;
}

function findCandidateByRememberedSelector(params: {
  candidates?: ComputerUseCandidate[];
  remembered?: RememberedComputerUseCandidate;
  observation?: ComputerUseObservation;
}): ComputerUseCandidate | undefined {
  if (!params.candidates || params.candidates.length === 0 || !params.remembered) {
    return undefined;
  }
  const remembered = params.remembered;
  const scored = params.candidates
    .map((candidate) => ({
      candidate,
      score: candidateSelectorScore(candidate, remembered, params.observation),
    }))
    .filter((item) => Number.isFinite(item.score))
    .toSorted((left, right) => right.score - left.score);
  const best = scored[0];
  if (!best || best.score < 50) {
    return undefined;
  }
  const second = scored[1];
  if (second && best.score < 100 && best.score - second.score < 6) {
    return undefined;
  }
  return best.candidate;
}

function selectedTargetFromCandidate(
  candidate: ComputerUseCandidate,
  explicitPoint?: ComputerUsePoint,
): ComputerUseSelectedTarget {
  const point = explicitPoint ?? (candidate.rect ? centerOfRect(candidate.rect) : undefined);
  return {
    ...(candidate.id ? { candidateId: candidate.id } : {}),
    ...(candidate.ref ? { elementRef: candidate.ref } : {}),
    ...(candidate.selector ? { selector: candidate.selector } : {}),
    ...(point ? { point } : {}),
    ...(candidate.rect ? { rect: candidate.rect } : {}),
  };
}

function buildModelFacingSummary(params: {
  summary: string;
  observation?: ComputerUseObservation;
  target?: ComputerUseTargetBinding;
  targets?: ComputerUseTargetCatalog;
  diagnostics?: ComputerUseDiagnostics;
  axSnapshot?: ComputerUseAxSnapshot;
  cdpSnapshot?: ComputerUseCdpSnapshot;
  ocrSnapshot?: ComputerUseOcrSnapshot;
  candidates?: ComputerUseCandidate[];
  warning?: string;
  error?: string;
}): string {
  const lines = [params.summary];
  if (
    params.observation?.targetKind ||
    params.observation?.targetId ||
    params.observation?.appName ||
    params.observation?.windowTitle ||
    params.observation?.windowId ||
    params.observation?.displayId
  ) {
    const observationParts = [
      params.observation?.targetKind ? `target=${params.observation.targetKind}` : "",
      params.observation?.targetId ? `targetId=${params.observation.targetId}` : "",
      params.observation?.appName ? `app=${params.observation.appName}` : "",
      params.observation?.bundleId ? `bundle=${params.observation.bundleId}` : "",
      params.observation?.windowTitle
        ? `window=${params.observation.windowTitle}`
        : params.observation?.windowId
          ? `window=${params.observation.windowId}`
          : "",
      params.observation?.displayId ? `display=${params.observation.displayId}` : "",
    ].filter(Boolean);
    if (observationParts.length > 0) {
      lines.push(`Observation: ${observationParts.join(" | ")}`);
    }
  }
  if (params.target) {
    const targetParts = [
      `kind=${params.target.kind}`,
      `targetId=${params.target.targetId}`,
      params.target.app?.appName ? `app=${params.target.app.appName}` : "",
      params.target.app?.bundleId ? `bundle=${params.target.app.bundleId}` : "",
      params.target.window?.title
        ? `window=${params.target.window.title}`
        : params.target.window?.windowId
          ? `window=${params.target.window.windowId}`
          : "",
      params.target.display?.displayId ? `display=${params.target.display.displayId}` : "",
      params.target.frameSize
        ? `frame=${Math.round(params.target.frameSize.width)}x${Math.round(params.target.frameSize.height)}`
        : "",
      params.target.boundsGlobal
        ? `bounds=${Math.round(params.target.boundsGlobal.x)},${Math.round(params.target.boundsGlobal.y)},${Math.round(params.target.boundsGlobal.width)}x${Math.round(params.target.boundsGlobal.height)}`
        : "",
      params.target.capture?.backend ? `backend=${params.target.capture.backend}` : "",
    ].filter(Boolean);
    if (targetParts.length > 0) {
      lines.push(`Target binding: ${targetParts.join(" | ")}`);
    }
  }
  const contaminationCheck = params.diagnostics?.capture?.contaminationCheck;
  if (
    contaminationCheck &&
    contaminationCheck.status !== "clean" &&
    contaminationCheck.status !== "retry-clean" &&
    contaminationCheck.status !== "skipped"
  ) {
    lines.push(
      [
        `Observation warning: ${contaminationCheck.status}`,
        `attempts=${contaminationCheck.attempts}`,
        contaminationCheck.reason ?? "",
      ]
        .filter(Boolean)
        .join(" | "),
    );
  }
  if (params.axSnapshot) {
    const nodeCount = params.axSnapshot.nodeCount ?? countAxNodes(params.axSnapshot.nodes);
    const parts = [`AX supported=${params.axSnapshot.supported ? "yes" : "no"}`];
    if (params.axSnapshot.appName) {
      parts.push(`app=${params.axSnapshot.appName}`);
    }
    if (params.axSnapshot.windowTitle) {
      parts.push(`window=${params.axSnapshot.windowTitle}`);
    }
    if (nodeCount > 0) {
      parts.push(`nodes=${nodeCount}`);
    }
    if (params.axSnapshot.truncated) {
      parts.push("truncated=yes");
    }
    lines.push(parts.join(" | "));
    const highlights = collectAxHighlights(params.axSnapshot.nodes);
    if (highlights.length > 0) {
      lines.push(`AX highlights:\n- ${highlights.join("\n- ")}`);
    } else if (params.axSnapshot.message) {
      lines.push(`AX note: ${params.axSnapshot.message}`);
    }
    if (params.axSnapshot.selectedText) {
      lines.push(`Selected text: ${params.axSnapshot.selectedText}`);
    }
    const observationMismatch =
      params.axSnapshot.targetMatched === false ||
      (normalizeOptionalString(params.observation?.appName) &&
        normalizeOptionalString(params.axSnapshot.appName) &&
        normalizeOptionalString(params.observation?.appName) !==
          normalizeOptionalString(params.axSnapshot.appName)) ||
      (normalizeOptionalString(params.observation?.windowId) &&
        normalizeOptionalString(params.axSnapshot.windowId) &&
        normalizeOptionalString(params.observation?.windowId) !==
          normalizeOptionalString(params.axSnapshot.windowId)) ||
      (normalizeOptionalString(params.observation?.windowTitle) &&
        normalizeOptionalString(params.axSnapshot.windowTitle) &&
        normalizeOptionalString(params.observation?.windowTitle) !==
          normalizeOptionalString(params.axSnapshot.windowTitle));
    if (observationMismatch) {
      lines.push(
        "Warning: AX snapshot target differs from the screenshot target; prefer the screenshot and the latest observation target.",
      );
    }
  }
  if (params.ocrSnapshot) {
    const parts = [`OCR supported=${params.ocrSnapshot.supported ? "yes" : "no"}`];
    if (params.ocrSnapshot.engine) {
      parts.push(`engine=${params.ocrSnapshot.engine}`);
    }
    if (typeof params.ocrSnapshot.regionCount === "number") {
      parts.push(`regions=${params.ocrSnapshot.regionCount}`);
    }
    if (params.ocrSnapshot.truncated) {
      parts.push("truncated=yes");
    }
    lines.push(parts.join(" | "));
    const highlights = collectOcrHighlights(params.ocrSnapshot);
    if (highlights.length > 0) {
      lines.push(`OCR highlights:\n- ${highlights.join("\n- ")}`);
    } else if (params.ocrSnapshot.message) {
      lines.push(`OCR note: ${params.ocrSnapshot.message}`);
    }
  }
  if (params.cdpSnapshot) {
    const parts = [`CDP DOM supported=${params.cdpSnapshot.supported ? "yes" : "no"}`];
    if (params.cdpSnapshot.engine) {
      parts.push(`engine=${params.cdpSnapshot.engine}`);
    }
    if (params.cdpSnapshot.endpointId) {
      parts.push(`endpoint=${params.cdpSnapshot.endpointId}`);
    }
    if (params.cdpSnapshot.pageTitle) {
      parts.push(`page=${params.cdpSnapshot.pageTitle}`);
    }
    if (typeof params.cdpSnapshot.nodeCount === "number") {
      parts.push(`nodes=${params.cdpSnapshot.nodeCount}`);
    }
    if (params.cdpSnapshot.coordinateMapping) {
      parts.push(`mapping=${params.cdpSnapshot.coordinateMapping}`);
    }
    if (params.cdpSnapshot.truncated) {
      parts.push("truncated=yes");
    }
    lines.push(parts.join(" | "));
    const highlights = collectCdpHighlights(params.cdpSnapshot);
    if (highlights.length > 0) {
      lines.push(`CDP DOM highlights:\n- ${highlights.join("\n- ")}`);
    } else if (params.cdpSnapshot.message) {
      lines.push(`CDP DOM note: ${params.cdpSnapshot.message}`);
    }
  }
  if (params.targets) {
    const displayHighlights = collectDisplayTargetHighlights(params.targets.displays, 8);
    const windowHighlights = collectWindowTargetHighlights(params.targets.windows, 8);
    const appHighlights = collectAppTargetHighlights(params.targets.apps, 8);
    const cdpHighlights = collectCdpEndpointHighlights(params.targets.cdpEndpoints, 6);
    if (displayHighlights.length > 0) {
      lines.push(`Available displays:\n- ${displayHighlights.join("\n- ")}`);
    }
    if (windowHighlights.length > 0) {
      lines.push(`Available windows:\n- ${windowHighlights.join("\n- ")}`);
    }
    if (appHighlights.length > 0) {
      lines.push(`Running apps:\n- ${appHighlights.join("\n- ")}`);
    }
    if (cdpHighlights.length > 0) {
      lines.push(`Available CDP endpoints:\n- ${cdpHighlights.join("\n- ")}`);
    }
    if (
      displayHighlights.length > 0 ||
      windowHighlights.length > 0 ||
      appHighlights.length > 0 ||
      cdpHighlights.length > 0
    ) {
      lines.push(
        "Use exact targetId from the device target catalog when available. For focus_window, targetId, appName, bundleId, and windowId are supported.",
      );
    }
  }
  if (params.candidates && params.candidates.length > 0) {
    lines.push(`Candidates:\n- ${collectCandidateHighlights(params.candidates).join("\n- ")}`);
    lines.push(
      "Use exact elementRef values like @e1 for UI actions when a candidate matches the target. For text entry, use one action=type call with text and elementRef; do not click the field and observe again. For search boxes or command palettes that should open the highlighted result, use one action=set_text_submit call with text and elementRef.",
    );
  }
  if (params.warning) {
    lines.push(`Warning: ${params.warning}`);
  }
  if (params.error) {
    lines.push(`Error: ${params.error}`);
  }
  return lines.filter(Boolean).join("\n");
}

function mergeComputerUseWarnings(...values: Array<string | undefined>): string | undefined {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return unique.size > 0 ? [...unique].join(" ") : undefined;
}

export {
  actionNeedsGroundedElementPoint,
  availableElementRefs,
  buildActionPayloadPoint,
  buildCandidateProposals,
  buildModelFacingSummary,
  buildPendingActionPayload,
  candidateMatchesRememberedSelector,
  clearComputerUseCandidateMemoryForTesting,
  countAxNodes,
  describePreparedFocusTarget,
  findCandidateByRef,
  findCandidateByRememberedSelector,
  focusTargetMatchesExpectation,
  lookupRememberedComputerUseCandidate,
  lookupRememberedComputerUseObservation,
  mergeComputerUseWarnings,
  normalizeTargetLookupValue,
  readElementRef,
  rememberComputerUseCandidates,
  resolveSelectedTarget,
  selectedTargetFromCandidate,
};

export type {
  ComputerUsePendingActionPayload,
  PreparedComputerUseFocusIntent,
  PreparedComputerUseFocusTarget,
};
