import type { ComputerUseCandidate } from "../../../computer-use/types.js";

export type GatewayComputerStatusPayload = {
  platform?: string;
  permissions?: Record<string, unknown>;
  observeAllowed?: boolean;
  controlAllowed?: boolean;
  supportsWindowCapture?: boolean;
  supportsAx?: boolean;
  supportsOcr?: boolean;
  supportsCdp?: boolean;
  actions?: string[];
};

export type GatewayComputerTargetBindingPayload = {
  targetId?: string | null;
  kind?: string | null;
  observedAt?: string | null;
  app?: {
    appName?: string | null;
    bundleId?: string | null;
    processId?: number | null;
    running?: boolean | null;
  } | null;
  window?: {
    windowId?: string | null;
    title?: string | null;
    isFocused?: boolean | null;
    isMinimized?: boolean | null;
    isMaximized?: boolean | null;
  } | null;
  display?: {
    displayId?: string | null;
    name?: string | null;
    isPrimary?: boolean | null;
    isBuiltin?: boolean | null;
    scaleFactor?: number | null;
  } | null;
  boundsGlobal?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  } | null;
  frameSize?: {
    width?: number;
    height?: number;
  } | null;
  logicalSize?: {
    width?: number;
    height?: number;
  } | null;
  capture?: {
    backend?: string | null;
    scaleFactor?: number | null;
  } | null;
};

export type GatewayComputerPerceptionContextPayload = {
  scopeType?: string | null;
  targetKind?: string | null;
  targetId?: string | null;
  observationId?: string | null;
  backend?: string | null;
  displayId?: string | null;
  displayIds?: string[] | null;
  appName?: string | null;
  bundleId?: string | null;
  windowId?: string | null;
  windowTitle?: string | null;
  globalX?: number | null;
  globalY?: number | null;
  logicalWidth?: number | null;
  logicalHeight?: number | null;
  scaleFactor?: number | null;
  width?: number;
  height?: number;
  mimeType?: string;
  base64Png?: string;
  frameId?: string;
  framePath?: string;
  frameUrl?: string;
  capturedAt?: string;
  target?: GatewayComputerTargetBindingPayload | null;
  diagnostics?: GatewayComputerDiagnosticsPayload | null;
};

export type GatewayComputerCapturePayload = GatewayComputerPerceptionContextPayload & {
  mimeType?: string;
  base64Png?: string;
  frameId?: string;
  framePath?: string;
  frameUrl?: string;
};

export type GatewayComputerActionPayload = {
  action?: string;
  status?: string;
  executedAt?: string;
  targetId?: string | null;
  elementSelector?: ComputerUseCandidate["selector"] | null;
  appName?: string | null;
  bundleId?: string | null;
  windowId?: string | null;
  windowTitle?: string | null;
  point?: { x?: number; y?: number } | null;
  inputBackend?: string | null;
  semanticPath?: string | null;
  selectorAttempted?: boolean | null;
  selectorMatched?: boolean | null;
  fallbackReason?: string | null;
  cursorRestored?: boolean | null;
  focusLocked?: boolean | null;
  diagnostics?: GatewayComputerDiagnosticsPayload | null;
  warning?: string | null;
};

export type GatewayComputerCaptureDiagnosticsPayload = {
  backend?: string | null;
  scopeType?: string | null;
  targetKind?: string | null;
  targetId?: string | null;
  observationId?: string | null;
  appName?: string | null;
  bundleId?: string | null;
  windowId?: string | null;
  windowTitle?: string | null;
  displayId?: string | null;
  displayIds?: unknown[] | null;
  globalRect?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  } | null;
  frameSize?: {
    width?: number;
    height?: number;
  } | null;
  logicalSize?: {
    width?: number;
    height?: number;
  } | null;
  scaleFactor?: number | null;
  overlayWasVisibleBeforeCapture?: boolean | null;
  overlayHiddenBeforeCapture?: boolean | null;
  overlayHideSettledMs?: number | null;
  overlayPayloadId?: string | null;
  contaminationCheck?: {
    status?: string | null;
    attempts?: number | null;
    reason?: string | null;
  } | null;
  capturedAt?: string | null;
};

export type GatewayComputerActionDiagnosticsPayload = {
  scopeType?: string | null;
  targetKind?: string | null;
  targetId?: string | null;
  observationId?: string | null;
  mappingSource?: string | null;
  interactionMode?: string | null;
  inputBackend?: string | null;
  semanticPath?: string | null;
  selectorAttempted?: boolean | null;
  selectorMatched?: boolean | null;
  fallbackReason?: string | null;
  focusLocked?: boolean | null;
  cursorRestored?: boolean | null;
  frameSize?: {
    width?: number;
    height?: number;
  } | null;
  relativePoint?: { x?: number; y?: number } | null;
  relativeFromPoint?: { x?: number; y?: number } | null;
  relativeToPoint?: { x?: number; y?: number } | null;
  absolutePoint?: { x?: number; y?: number } | null;
  absoluteFromPoint?: { x?: number; y?: number } | null;
  absoluteToPoint?: { x?: number; y?: number } | null;
  deltaX?: number | null;
  deltaY?: number | null;
  observationAgeMs?: number | null;
  executedAt?: string | null;
};

export type GatewayComputerDiagnosticsPayload = {
  capture?: GatewayComputerCaptureDiagnosticsPayload | null;
  postActionCapture?: GatewayComputerCaptureDiagnosticsPayload | null;
  action?: GatewayComputerActionDiagnosticsPayload | null;
};

export type GatewayComputerTargetWindowPayload = {
  targetId?: string | null;
  kind?: string | null;
  windowId?: string | null;
  appName?: string | null;
  bundleId?: string | null;
  processId?: number | null;
  windowTitle?: string | null;
  monitorId?: string | null;
  isFocused?: boolean | null;
  isMinimized?: boolean | null;
  isMaximized?: boolean | null;
  rect?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  } | null;
};

export type GatewayComputerTargetAppPayload = {
  targetId?: string | null;
  kind?: string | null;
  appName?: string | null;
  bundleId?: string | null;
  processId?: number | null;
  isFrontmost?: boolean | null;
  isHidden?: boolean | null;
  activationPolicy?: string | null;
  visibleWindowCount?: number | null;
  visibleWindowIds?: unknown[] | null;
};

export type GatewayComputerTargetDisplayPayload = {
  targetId?: string | null;
  kind?: string | null;
  displayId?: string | null;
  name?: string | null;
  isPrimary?: boolean | null;
  isBuiltin?: boolean | null;
  scaleFactor?: number | null;
  rect?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  } | null;
};

export type GatewayComputerCdpPagePayload = {
  pageId?: string | null;
  page_id?: string | null;
  id?: string | null;
  pageType?: string | null;
  page_type?: string | null;
  type?: string | null;
  title?: string | null;
  url?: string | null;
  webSocketDebuggerUrl?: string | null;
  web_socket_debugger_url?: string | null;
};

export type GatewayComputerCdpEndpointPayload = {
  endpointId?: string | null;
  endpoint_id?: string | null;
  kind?: string | null;
  host?: string | null;
  port?: number | null;
  browser?: string | null;
  protocolVersion?: string | null;
  protocol_version?: string | null;
  webSocketDebuggerUrl?: string | null;
  web_socket_debugger_url?: string | null;
  pageCount?: number | null;
  page_count?: number | null;
  pages?: GatewayComputerCdpPagePayload[] | null;
  discoveredAt?: string | null;
  discovered_at?: string | null;
};

export type GatewayComputerTargetCatalogPayload = {
  generatedAt?: string | null;
  desktopTargetId?: string | null;
  displays?: GatewayComputerTargetDisplayPayload[] | null;
  windows?: GatewayComputerTargetWindowPayload[] | null;
  apps?: GatewayComputerTargetAppPayload[] | null;
  cdpEndpoints?: GatewayComputerCdpEndpointPayload[] | null;
  cdp_endpoints?: GatewayComputerCdpEndpointPayload[] | null;
};

export type GatewayComputerAxNodePayload = {
  id?: string;
  path?: unknown[] | null;
  role?: string;
  subrole?: string | null;
  axIdentifier?: string | null;
  ax_identifier?: string | null;
  label?: string | null;
  value?: string | null;
  description?: string | null;
  help?: string | null;
  url?: string | null;
  rect?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  } | null;
  enabled?: boolean | null;
  focused?: boolean | null;
  selected?: boolean | null;
  expanded?: boolean | null;
  editable?: boolean | null;
  actions?: unknown[] | null;
  rolePath?: unknown[] | null;
  role_path?: unknown[] | null;
  labelPath?: unknown[] | null;
  label_path?: unknown[] | null;
  children?: GatewayComputerAxNodePayload[] | null;
};

export type GatewayComputerAxPayload = {
  supported?: boolean;
  scopeType?: string | null;
  targetKind?: string | null;
  targetId?: string | null;
  observationId?: string | null;
  backend?: string | null;
  displayId?: string | null;
  displayIds?: string[] | null;
  bundleId?: string | null;
  permissionState?: string | null;
  windowId?: string | null;
  appName?: string | null;
  windowTitle?: string | null;
  globalX?: number | null;
  globalY?: number | null;
  logicalWidth?: number | null;
  logicalHeight?: number | null;
  scaleFactor?: number | null;
  width?: number;
  height?: number;
  capturedAt?: string;
  target?: GatewayComputerTargetBindingPayload | null;
  diagnostics?: GatewayComputerDiagnosticsPayload | null;
  targetMatched?: boolean | null;
  nodeCount?: number | null;
  truncated?: boolean | null;
  selectedText?: string | null;
  nodes?: GatewayComputerAxNodePayload[] | null;
  message?: string | null;
};

export type GatewayComputerOcrRegionPayload = {
  id?: string | null;
  text?: string | null;
  confidence?: number | null;
  rect?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  } | null;
};

export type GatewayComputerOcrPayload = {
  supported?: boolean;
  scopeType?: string | null;
  targetKind?: string | null;
  targetId?: string | null;
  observationId?: string | null;
  backend?: string | null;
  displayId?: string | null;
  displayIds?: string[] | null;
  engine?: string | null;
  appName?: string | null;
  bundleId?: string | null;
  windowId?: string | null;
  windowTitle?: string | null;
  globalX?: number | null;
  globalY?: number | null;
  logicalWidth?: number | null;
  logicalHeight?: number | null;
  scaleFactor?: number | null;
  width?: number;
  height?: number;
  capturedAt?: string;
  target?: GatewayComputerTargetBindingPayload | null;
  diagnostics?: GatewayComputerDiagnosticsPayload | null;
  regionCount?: number | null;
  truncated?: boolean | null;
  fullText?: string | null;
  regions?: GatewayComputerOcrRegionPayload[] | null;
  message?: string | null;
};

export type GatewayComputerCdpNodePayload = {
  id?: string | null;
  role?: string | null;
  label?: string | null;
  selectorPath?: string | null;
  selector_path?: string | null;
  tagName?: string | null;
  tag_name?: string | null;
  inputType?: string | null;
  input_type?: string | null;
  text?: string | null;
  href?: string | null;
  rect?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  } | null;
  cssRect?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  } | null;
  css_rect?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  } | null;
  coordinateMapping?: string | null;
  coordinate_mapping?: string | null;
  enabled?: boolean | null;
  editable?: boolean | null;
  actionCapabilities?: unknown[] | null;
  action_capabilities?: unknown[] | null;
};

export type GatewayComputerCdpPayload = GatewayComputerPerceptionContextPayload & {
  supported?: boolean;
  engine?: string | null;
  endpointId?: string | null;
  endpoint_id?: string | null;
  browser?: string | null;
  protocolVersion?: string | null;
  protocol_version?: string | null;
  pageId?: string | null;
  page_id?: string | null;
  pageTitle?: string | null;
  page_title?: string | null;
  pageUrl?: string | null;
  page_url?: string | null;
  viewport?: {
    innerWidth?: number | null;
    innerHeight?: number | null;
    outerWidth?: number | null;
    outerHeight?: number | null;
    screenX?: number | null;
    screenY?: number | null;
    scrollX?: number | null;
    scrollY?: number | null;
    devicePixelRatio?: number | null;
  } | null;
  nodeCount?: number | null;
  node_count?: number | null;
  truncated?: boolean | null;
  coordinateMapping?: string | null;
  coordinate_mapping?: string | null;
  nodes?: GatewayComputerCdpNodePayload[] | null;
  message?: string | null;
};

export type GatewayPluginApprovalRequestPayload = {
  id?: string;
  decision?: string | null;
  createdAtMs?: number;
  expiresAtMs?: number;
};

export type GatewayPluginApprovalWaitPayload = {
  id?: string;
  decision?: string | null;
  createdAtMs?: number;
  expiresAtMs?: number;
};
