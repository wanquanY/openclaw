import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerUseSessionConfig } from "../../computer-use/types.js";
import {
  clearComputerUseCandidateMemoryForTesting,
  createComputerUseTool,
} from "./computer-use-tool.js";
import { buildCandidateProposals, resolveSelectedTarget } from "./computer-use/perception.js";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => gatewayMocks.callGatewayTool(...args),
}));

const SESSION_CONFIG: ComputerUseSessionConfig = {
  enabled: true,
  mode: "plan_and_act",
  scope: { type: "current_window" },
  hostPolicy: "local_only",
  modelPolicy: { mode: "planner_executor_split" },
  approvals: { highRiskActionsRequireConfirm: true },
};

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p/8AAAAASUVORK5CYII=";

const OBSERVE_AX_PAYLOAD = {
  payload: {
    supported: true,
    permissionState: "granted",
    targetKind: "window",
    targetId: "window:win-1",
    observationId: "obs-observe-1",
    windowId: "win-1",
    appName: "Editor",
    bundleId: "com.example.editor",
    windowTitle: "Editor",
    displayId: "display-1",
    target: {
      targetId: "window:win-1",
      kind: "window",
      app: {
        appName: "Editor",
        bundleId: "com.example.editor",
        processId: 42,
      },
      window: {
        windowId: "win-1",
        title: "Editor",
      },
      display: {
        displayId: "display-1",
        scaleFactor: 2,
      },
      boundsGlobal: { x: 20, y: 40, width: 640, height: 360 },
      frameSize: { width: 1280, height: 720 },
      logicalSize: { width: 640, height: 360 },
      capture: {
        backend: "observation_binding",
        scaleFactor: 2,
      },
    },
    diagnostics: {
      capture: {
        backend: "observation_binding",
        scopeType: "window",
        targetKind: "window",
        targetId: "window:win-1",
        observationId: "obs-observe-1",
        appName: "Editor",
        bundleId: "com.example.editor",
        windowId: "win-1",
        windowTitle: "Editor",
        displayId: "display-1",
        frameSize: { width: 1280, height: 720 },
        globalRect: { x: 20, y: 40, width: 640, height: 360 },
      },
    },
    targetMatched: true,
    nodeCount: 2,
    nodes: [
      {
        id: "0",
        role: "AXWindow",
        label: "Editor",
        children: [
          {
            id: "0.0",
            path: [0, 0],
            role: "AXButton",
            axIdentifier: "save-button",
            label: "Save",
            actions: ["AXPress"],
            rolePath: ["AXWindow", "AXButton"],
            labelPath: ["Editor", "Save"],
            children: [],
          },
        ],
      },
    ],
  },
};

const OBSERVE_OCR_PAYLOAD = {
  payload: {
    supported: true,
    targetKind: "window",
    targetId: "window:win-wechat",
    observationId: "obs-ocr-1",
    engine: "apple-vision",
    appName: "WeChat",
    bundleId: "com.tencent.xinWeChat",
    windowId: "win-wechat",
    windowTitle: "WeChat",
    displayId: "display-1",
    target: {
      targetId: "window:win-wechat",
      kind: "window",
      app: {
        appName: "WeChat",
        bundleId: "com.tencent.xinWeChat",
        processId: 88,
      },
      window: {
        windowId: "win-wechat",
        title: "WeChat",
      },
      display: {
        displayId: "display-1",
        scaleFactor: 2,
      },
      boundsGlobal: { x: 100, y: 80, width: 1000, height: 800 },
      frameSize: { width: 2000, height: 1600 },
      logicalSize: { width: 1000, height: 800 },
      capture: {
        backend: "observation_binding",
        scaleFactor: 2,
      },
    },
    diagnostics: {
      capture: {
        backend: "observation_binding",
        scopeType: "window",
        targetKind: "window",
        targetId: "window:win-wechat",
        observationId: "obs-ocr-1",
        appName: "WeChat",
        bundleId: "com.tencent.xinWeChat",
        windowId: "win-wechat",
        windowTitle: "WeChat",
        displayId: "display-1",
        frameSize: { width: 2000, height: 1600 },
        globalRect: { x: 100, y: 80, width: 1000, height: 800 },
      },
    },
    regionCount: 2,
    fullText: "基努里维奇\n晚上好",
    regions: [
      {
        id: "ocr-1",
        text: "基努里维奇",
        confidence: 0.98,
        rect: { x: 320, y: 120, width: 220, height: 42 },
      },
      {
        id: "ocr-2",
        text: "晚上好",
        confidence: 0.94,
        rect: { x: 640, y: 680, width: 128, height: 36 },
      },
    ],
  },
};

const ACTION_AX_PAYLOAD = {
  payload: {
    supported: true,
    permissionState: "granted",
    windowId: "win-2",
    appName: "Browser",
    windowTitle: "Browser",
    targetMatched: true,
    nodeCount: 3,
    nodes: [
      {
        id: "0",
        role: "AXWindow",
        label: "Browser",
        children: [
          {
            id: "0.0",
            role: "AXButton",
            label: "Publish",
            rect: { x: 280, y: 220, width: 100, height: 60 },
            children: [],
          },
        ],
      },
    ],
  },
};

const TARGET_CATALOG_PAYLOAD = {
  payload: {
    generatedAt: "2026-04-22T00:00:30Z",
    desktopTargetId: "desktop:all",
    displays: [
      {
        targetId: "display:display-1",
        kind: "display",
        displayId: "display-1",
        name: "Main Display",
        isPrimary: true,
        rect: { x: 0, y: 0, width: 1440, height: 900 },
        scaleFactor: 2,
      },
    ],
    windows: [
      {
        targetId: "window:win-lark",
        kind: "window",
        windowId: "win-lark",
        appName: "飞书",
        bundleId: "com.lark.app",
        processId: 501,
        windowTitle: "消息",
        isFocused: false,
        isMinimized: false,
        isMaximized: false,
        rect: { x: 40, y: 50, width: 1280, height: 900 },
      },
    ],
    apps: [
      {
        targetId: "app:com.lark.app:501",
        kind: "app",
        appName: "飞书",
        bundleId: "com.lark.app",
        processId: 501,
        isFrontmost: false,
        isHidden: false,
        activationPolicy: "regular",
        visibleWindowCount: 1,
        visibleWindowIds: ["win-lark"],
      },
    ],
    cdpEndpoints: [
      {
        endpointId: "cdp:127.0.0.1:9222",
        kind: "cdp",
        host: "127.0.0.1",
        port: 9222,
        browser: "Chrome/126.0.0.0",
        protocolVersion: "1.3",
        pageCount: 1,
        pages: [
          {
            pageId: "page-1",
            pageType: "page",
            title: "Messages",
            url: "https://example.test/messages",
          },
        ],
      },
    ],
  },
};

function buildTool(sessionConfig: ComputerUseSessionConfig = SESSION_CONFIG) {
  return createComputerUseTool({
    sessionConfig,
    sessionKey: "session-default",
    agentId: "primary",
  });
}

beforeEach(() => {
  gatewayMocks.callGatewayTool.mockReset();
  clearComputerUseCandidateMemoryForTesting();
});

describe("computer_use tool", () => {
  it("streams observe payloads and returns the captured frame", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          targetId: "window:win-1",
          observationId: "obs-observe-1",
          backend: "screen_capture_kit",
          appName: "Editor",
          windowId: "win-1",
          windowTitle: "Editor",
          width: 1280,
          height: 720,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:00:00Z",
          target: {
            targetId: "window:win-1",
            kind: "window",
            observedAt: "2026-04-22T00:00:00Z",
            app: {
              appName: "Editor",
              bundleId: "com.example.editor",
              processId: 42,
              running: true,
            },
            window: {
              windowId: "win-1",
              title: "Editor",
              isFocused: true,
            },
            display: {
              displayId: "display-1",
              scaleFactor: 2,
            },
            boundsGlobal: { x: 20, y: 40, width: 640, height: 360 },
            frameSize: { width: 1280, height: 720 },
            logicalSize: { width: 640, height: 360 },
            capture: {
              backend: "screen_capture_kit",
              scaleFactor: 2,
            },
          },
          diagnostics: {
            capture: {
              backend: "screen_capture_kit",
              scopeType: "window",
              targetKind: "window",
              targetId: "window:win-1",
              observationId: "obs-observe-1",
              frameSize: { width: 1280, height: 720 },
              globalRect: { x: 20, y: 40, width: 640, height: 360 },
            },
          },
        },
      })
      .mockResolvedValueOnce(OBSERVE_AX_PAYLOAD);

    const onUpdate = vi.fn();
    const result = await buildTool().execute(
      "tool-1",
      { action: "observe" } as never,
      undefined,
      onUpdate,
    );

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({
      details: {
        kind: "computer_use/v1",
        stage: "observing",
        frame: {
          artifactId: "tool-1:observe:2026-04-22T00:00:00Z",
        },
      },
    });
    expect(result).toMatchObject({
      details: {
        kind: "computer_use/v1",
        stage: "completed",
        axSnapshot: {
          supported: true,
          targetKind: "window",
          targetId: "window:win-1",
          observationId: "obs-observe-1",
          bundleId: "com.example.editor",
          displayId: "display-1",
          targetMatched: true,
          nodeCount: 2,
          target: {
            targetId: "window:win-1",
            app: {
              bundleId: "com.example.editor",
            },
            window: {
              windowId: "win-1",
            },
          },
          diagnostics: {
            capture: {
              backend: "observation_binding",
              targetId: "window:win-1",
              observationId: "obs-observe-1",
            },
          },
        },
        candidates: expect.arrayContaining([
          expect.objectContaining({
            ref: "@e1",
            sourceId: "save-button",
            stableKey: "window:win-1:ax:axid=save-button:sid=save-button:axbutton:save:no-rect",
            selector: expect.objectContaining({
              targetId: "window:win-1",
              source: "ax",
              role: "AXButton",
              label: "Save",
              sourceId: "save-button",
              axIdentifier: "save-button",
              axPath: "0.0",
              rolePath: ["AXWindow", "AXButton"],
              labelPath: ["Editor", "Save"],
            }),
            label: "Save",
            role: "AXButton",
            actionCapabilities: expect.arrayContaining(["press", "click"]),
          }),
        ]),
        observation: {
          targetKind: "window",
          targetId: "window:win-1",
          observationId: "obs-observe-1",
          appName: "Editor",
          bundleId: "com.example.editor",
          windowId: "win-1",
          windowTitle: "Editor",
          displayId: "display-1",
        },
        target: {
          targetId: "window:win-1",
          kind: "window",
          app: {
            appName: "Editor",
            bundleId: "com.example.editor",
            processId: 42,
          },
          window: {
            windowId: "win-1",
            title: "Editor",
          },
          boundsGlobal: { x: 20, y: 40, width: 640, height: 360 },
          frameSize: { width: 1280, height: 720 },
        },
        diagnostics: {
          capture: {
            backend: "screen_capture_kit",
            scopeType: "window",
            targetKind: "window",
            targetId: "window:win-1",
            observationId: "obs-observe-1",
            frameSize: {
              width: 1280,
              height: 720,
            },
          },
        },
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("Candidates:") }),
        expect.objectContaining({ type: "image", mimeType: "image/png", data: PNG_BASE64 }),
      ]),
    );
  });

  it("grounds elementRef candidates into action points without model-supplied coordinates", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          targetId: "window:win-editor",
          observationId: "obs-ref-click-1",
          backend: "screen_capture_kit",
          appName: "Editor",
          windowId: "win-editor",
          windowTitle: "Editor",
          width: 800,
          height: 600,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:01:00Z",
          diagnostics: {
            capture: {
              backend: "screen_capture_kit",
              scopeType: "window",
              targetKind: "window",
              targetId: "window:win-editor",
              observationId: "obs-ref-click-1",
              frameSize: { width: 800, height: 600 },
              globalRect: { x: 0, y: 0, width: 800, height: 600 },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          targetKind: "window",
          targetId: "window:win-editor",
          observationId: "obs-ref-click-1",
          windowId: "win-editor",
          appName: "Editor",
          windowTitle: "Editor",
          targetMatched: true,
          nodeCount: 2,
          nodes: [
            {
              id: "0",
              role: "AXWindow",
              label: "Editor",
              children: [
                {
                  id: "0.0",
                  path: [0, 0],
                  role: "AXButton",
                  axIdentifier: "publish-button",
                  label: "Publish",
                  rect: { x: 100, y: 200, width: 80, height: 40 },
                  actions: ["AXPress"],
                  rolePath: ["AXWindow", "AXButton"],
                  labelPath: ["Editor", "Publish"],
                  children: [],
                },
              ],
            },
          ],
        },
      })
      .mockImplementationOnce(async (_method: string, _gatewayOpts: unknown, params: unknown) => {
        expect(params).toMatchObject({
          command: "computer.action",
          params: {
            action: "click",
            scopeType: "window",
            targetId: "window:win-editor",
            windowId: "win-editor",
            observationId: "obs-ref-click-1",
            point: { x: 140, y: 220 },
            elementSelector: expect.objectContaining({
              axIdentifier: "publish-button",
              axPath: "0.0",
            }),
            frameWidth: 800,
            frameHeight: 600,
          },
        });
        return {
          payload: {
            action: "click",
            status: "success",
            targetId: "window:win-editor",
            executedAt: "2026-04-22T00:01:01Z",
            point: { x: 140, y: 220 },
            diagnostics: {
              action: {
                scopeType: "window",
                targetKind: "window",
                targetId: "window:win-editor",
                observationId: "obs-ref-click-1",
                mappingSource: "observation_binding",
                frameSize: { width: 800, height: 600 },
                relativePoint: { x: 140, y: 220 },
                absolutePoint: { x: 140, y: 220 },
              },
            },
          },
        };
      });

    const result = await buildTool().execute("tool-ref-click-1", {
      action: "click",
      elementRef: "@e1",
      verifyAfterAction: false,
    } as never);

    expect(result).toMatchObject({
      details: {
        kind: "computer_use/v1",
        stage: "completed",
        selected: {
          candidateId: "0.0",
          elementRef: "@e1",
          point: { x: 140, y: 220 },
          rect: { x: 100, y: 200, width: 80, height: 40 },
        },
        action: {
          type: "click",
          status: "success",
          point: { x: 140, y: 220 },
        },
      },
    });
  });

  it("fails stale elementRef actions before sending any desktop action", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          targetId: "window:win-editor",
          observationId: "obs-ref-stale-1",
          backend: "screen_capture_kit",
          appName: "Editor",
          windowId: "win-editor",
          windowTitle: "Editor",
          width: 800,
          height: 600,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:01:30Z",
          diagnostics: {
            capture: {
              backend: "screen_capture_kit",
              scopeType: "window",
              targetKind: "window",
              targetId: "window:win-editor",
              observationId: "obs-ref-stale-1",
              frameSize: { width: 800, height: 600 },
              globalRect: { x: 0, y: 0, width: 800, height: 600 },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          targetKind: "window",
          targetId: "window:win-editor",
          observationId: "obs-ref-stale-1",
          windowId: "win-editor",
          appName: "Editor",
          windowTitle: "Editor",
          targetMatched: true,
          nodeCount: 2,
          nodes: [
            {
              id: "0",
              role: "AXWindow",
              label: "Editor",
              children: [
                {
                  id: "0.0",
                  path: [0, 0],
                  role: "AXButton",
                  axIdentifier: "publish-button",
                  label: "Publish",
                  rect: { x: 100, y: 200, width: 80, height: 40 },
                  actions: ["AXPress"],
                  rolePath: ["AXWindow", "AXButton"],
                  labelPath: ["Editor", "Publish"],
                  children: [],
                },
              ],
            },
          ],
        },
      });

    const result = await buildTool().execute("tool-ref-stale-1", {
      action: "click",
      elementRef: "@e99",
      verifyAfterAction: false,
    } as never);

    expect(
      gatewayMocks.callGatewayTool.mock.calls.some(
        ([, , params]) =>
          (params as { command?: string } | undefined)?.command === "computer.action",
      ),
    ).toBe(false);
    expect(result).toMatchObject({
      details: {
        kind: "computer_use/v1",
        status: "error",
        stage: "error",
        summary: "Element reference @e99 is stale or not present in the current observation.",
        error: expect.stringContaining("ELEMENT_STALE"),
        warning: expect.stringContaining("@e1"),
        action: {
          type: "click",
          status: "failed",
        },
        candidates: [
          expect.objectContaining({
            ref: "@e1",
            label: "Publish",
            selector: expect.objectContaining({
              targetId: "window:win-editor",
              sourceId: "publish-button",
              axIdentifier: "publish-button",
              axPath: "0.0",
              rectSignature: "13,25,10,5",
            }),
          }),
        ],
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("ELEMENT_STALE"),
        }),
      ]),
    );
  });

  it("relocates a remembered elementRef when current refs were reassigned", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          targetId: "window:win-editor",
          observationId: "obs-ref-relocate-before-1",
          backend: "screen_capture_kit",
          appName: "Editor",
          windowId: "win-editor",
          windowTitle: "Editor",
          width: 800,
          height: 600,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:01:40Z",
          diagnostics: {
            capture: {
              backend: "screen_capture_kit",
              scopeType: "window",
              targetKind: "window",
              targetId: "window:win-editor",
              observationId: "obs-ref-relocate-before-1",
              frameSize: { width: 800, height: 600 },
              globalRect: { x: 0, y: 0, width: 800, height: 600 },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          targetKind: "window",
          targetId: "window:win-editor",
          observationId: "obs-ref-relocate-before-1",
          windowId: "win-editor",
          appName: "Editor",
          targetMatched: true,
          nodes: [
            {
              id: "0",
              role: "AXWindow",
              label: "Editor",
              children: [
                {
                  id: "0.0",
                  path: [0, 0],
                  role: "AXButton",
                  axIdentifier: "publish-button",
                  label: "Publish",
                  rect: { x: 100, y: 200, width: 80, height: 40 },
                  actions: ["AXPress"],
                  rolePath: ["AXWindow", "AXButton"],
                  labelPath: ["Editor", "Publish"],
                  children: [],
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce(TARGET_CATALOG_PAYLOAD)
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          targetId: "window:win-editor",
          observationId: "obs-ref-relocate-action-1",
          backend: "screen_capture_kit",
          appName: "Editor",
          windowId: "win-editor",
          windowTitle: "Editor",
          width: 800,
          height: 600,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:01:41Z",
          diagnostics: {
            capture: {
              backend: "screen_capture_kit",
              scopeType: "window",
              targetKind: "window",
              targetId: "window:win-editor",
              observationId: "obs-ref-relocate-action-1",
              frameSize: { width: 800, height: 600 },
              globalRect: { x: 0, y: 0, width: 800, height: 600 },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          targetKind: "window",
          targetId: "window:win-editor",
          observationId: "obs-ref-relocate-action-1",
          windowId: "win-editor",
          appName: "Editor",
          targetMatched: true,
          nodes: [
            {
              id: "0",
              role: "AXWindow",
              label: "Editor",
              children: [
                {
                  id: "0.0",
                  path: [0, 0],
                  role: "AXButton",
                  axIdentifier: "cancel-button",
                  label: "Cancel Changes",
                  rect: { x: 20, y: 20, width: 80, height: 40 },
                  actions: ["AXPress"],
                  rolePath: ["AXWindow", "AXButton"],
                  labelPath: ["Editor", "Cancel Changes"],
                  children: [],
                },
                {
                  id: "0.1",
                  path: [0, 1],
                  role: "AXButton",
                  axIdentifier: "publish-button",
                  label: "Publish",
                  rect: { x: 100, y: 200, width: 80, height: 40 },
                  actions: ["AXPress"],
                  rolePath: ["AXWindow", "AXButton"],
                  labelPath: ["Editor", "Publish"],
                  children: [],
                },
              ],
            },
          ],
        },
      })
      .mockImplementationOnce(async (_method: string, _gatewayOpts: unknown, params: unknown) => {
        expect(params).toMatchObject({
          command: "computer.action",
          params: {
            action: "click",
            targetId: "window:win-editor",
            windowId: "win-editor",
            observationId: "obs-ref-relocate-action-1",
            point: { x: 140, y: 220 },
            elementSelector: expect.objectContaining({
              axIdentifier: "publish-button",
              axPath: "0.1",
            }),
          },
        });
        return {
          payload: {
            action: "click",
            status: "success",
            targetId: "window:win-editor",
            point: { x: 140, y: 220 },
            executedAt: "2026-04-22T00:01:42Z",
            inputBackend: "ax_identity_press",
            semanticPath: "selector_direct",
            selectorAttempted: true,
            selectorMatched: true,
            diagnostics: {
              action: {
                scopeType: "window",
                targetKind: "window",
                targetId: "window:win-editor",
                observationId: "obs-ref-relocate-action-1",
                mappingSource: "observation_binding",
                interactionMode: "semantic_first",
                inputBackend: "ax_identity_press",
                semanticPath: "selector_direct",
                selectorAttempted: true,
                selectorMatched: true,
                frameSize: { width: 800, height: 600 },
                relativePoint: { x: 140, y: 220 },
                absolutePoint: { x: 140, y: 220 },
              },
            },
          },
        };
      });

    const tool = buildTool();
    await tool.execute("tool-ref-relocate-observe-1", { action: "observe" } as never);
    const result = await tool.execute("tool-ref-relocate-action-1", {
      action: "click",
      elementRef: "@e1",
      verifyAfterAction: false,
    } as never);

    expect(result).toMatchObject({
      details: {
        kind: "computer_use/v1",
        status: "ok",
        stage: "completed",
        selected: {
          candidateId: "0.1",
          elementRef: "@e2",
          point: { x: 140, y: 220 },
          rect: { x: 100, y: 200, width: 80, height: 40 },
        },
        warning: expect.stringContaining("relocated to @e2"),
        action: {
          type: "click",
          status: "success",
          point: { x: 140, y: 220 },
          inputBackend: "ax_identity_press",
          semanticPath: "selector_direct",
          selectorAttempted: true,
          selectorMatched: true,
        },
        diagnostics: {
          action: {
            inputBackend: "ax_identity_press",
            semanticPath: "selector_direct",
            selectorAttempted: true,
            selectorMatched: true,
            relativePoint: { x: 140, y: 220 },
            absolutePoint: { x: 140, y: 220 },
          },
        },
      },
    });
  });

  it("fails ungroundable elementRef actions before coordinate fallback", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          targetId: "window:win-editor",
          observationId: "obs-ref-ungroundable-1",
          backend: "screen_capture_kit",
          appName: "Editor",
          windowId: "win-editor",
          windowTitle: "Editor",
          width: 800,
          height: 600,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:01:45Z",
          diagnostics: {
            capture: {
              backend: "screen_capture_kit",
              scopeType: "window",
              targetKind: "window",
              targetId: "window:win-editor",
              observationId: "obs-ref-ungroundable-1",
              frameSize: { width: 800, height: 600 },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          targetKind: "window",
          targetId: "window:win-editor",
          observationId: "obs-ref-ungroundable-1",
          windowId: "win-editor",
          appName: "Editor",
          windowTitle: "Editor",
          targetMatched: true,
          nodeCount: 2,
          nodes: [
            {
              id: "0",
              role: "AXWindow",
              label: "Editor",
              children: [
                {
                  id: "0.0",
                  role: "AXButton",
                  label: "Publish",
                  children: [],
                },
              ],
            },
          ],
        },
      });

    const result = await buildTool().execute("tool-ref-ungroundable-1", {
      action: "click",
      elementRef: "@e1",
      verifyAfterAction: false,
    } as never);

    expect(
      gatewayMocks.callGatewayTool.mock.calls.some(
        ([, , params]) =>
          (params as { command?: string } | undefined)?.command === "computer.action",
      ),
    ).toBe(false);
    expect(result).toMatchObject({
      details: {
        kind: "computer_use/v1",
        status: "error",
        stage: "error",
        summary: "Element reference @e1 cannot be grounded to a point.",
        error: expect.stringContaining("ELEMENT_UNGROUNDABLE"),
        selected: {
          candidateId: "0.0",
          elementRef: "@e1",
        },
        action: {
          type: "click",
          status: "failed",
        },
      },
    });
  });

  it("grounds type elementRef into a target point for semantic text entry", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          targetId: "window:win-editor",
          observationId: "obs-ref-type-1",
          backend: "screen_capture_kit",
          appName: "Editor",
          windowId: "win-editor",
          windowTitle: "Editor",
          width: 900,
          height: 640,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:02:00Z",
          diagnostics: {
            capture: {
              backend: "screen_capture_kit",
              scopeType: "window",
              targetKind: "window",
              targetId: "window:win-editor",
              observationId: "obs-ref-type-1",
              frameSize: { width: 900, height: 640 },
              globalRect: { x: 0, y: 0, width: 900, height: 640 },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          targetKind: "window",
          targetId: "window:win-editor",
          observationId: "obs-ref-type-1",
          windowId: "win-editor",
          appName: "Editor",
          targetMatched: true,
          nodes: [
            {
              id: "0",
              role: "AXWindow",
              label: "Editor",
              children: [
                {
                  id: "0.0",
                  role: "AXTextField",
                  label: "Message",
                  editable: true,
                  rect: { x: 50, y: 500, width: 500, height: 44 },
                  children: [],
                },
              ],
            },
          ],
        },
      })
      .mockImplementationOnce(async (_method: string, _gatewayOpts: unknown, params: unknown) => {
        expect(params).toMatchObject({
          command: "computer.action",
          params: {
            action: "type",
            targetId: "window:win-editor",
            windowId: "win-editor",
            observationId: "obs-ref-type-1",
            point: { x: 300, y: 522 },
            text: "hello semantic input",
            frameWidth: 900,
            frameHeight: 640,
          },
        });
        return {
          payload: {
            action: "type",
            status: "success",
            targetId: "window:win-editor",
            executedAt: "2026-04-22T00:02:01Z",
            point: { x: 300, y: 522 },
            textLength: 20,
            inputBackend: "ax_set_value",
            semanticPath: "hit_test_semantic",
            selectorAttempted: true,
            selectorMatched: false,
            fallbackReason: "selector_not_matched_hit_test_semantic",
            diagnostics: {
              action: {
                scopeType: "window",
                targetKind: "window",
                targetId: "window:win-editor",
                observationId: "obs-ref-type-1",
                mappingSource: "observation_binding",
                inputBackend: "ax_set_value",
                semanticPath: "hit_test_semantic",
                selectorAttempted: true,
                selectorMatched: false,
                fallbackReason: "selector_not_matched_hit_test_semantic",
                frameSize: { width: 900, height: 640 },
                relativePoint: { x: 300, y: 522 },
                absolutePoint: { x: 300, y: 522 },
              },
            },
          },
        };
      });

    const result = await buildTool({
      ...SESSION_CONFIG,
      approvals: { highRiskActionsRequireConfirm: false },
    }).execute("tool-ref-type-1", {
      action: "type",
      elementRef: "@e1",
      text: "hello semantic input",
      verifyAfterAction: false,
    } as never);

    expect(result).toMatchObject({
      details: {
        selected: {
          candidateId: "0.0",
          elementRef: "@e1",
          point: { x: 300, y: 522 },
          rect: { x: 50, y: 500, width: 500, height: 44 },
        },
        action: {
          type: "type",
          status: "success",
          point: { x: 300, y: 522 },
          inputBackend: "ax_set_value",
          semanticPath: "hit_test_semantic",
          selectorAttempted: true,
          selectorMatched: false,
          fallbackReason: "selector_not_matched_hit_test_semantic",
        },
        diagnostics: {
          action: {
            inputBackend: "ax_set_value",
            semanticPath: "hit_test_semantic",
            selectorAttempted: true,
            selectorMatched: false,
            fallbackReason: "selector_not_matched_hit_test_semantic",
            relativePoint: { x: 300, y: 522 },
            absolutePoint: { x: 300, y: 522 },
          },
        },
      },
    });
  });

  it("sends set_text_submit as one grounded transaction for search/open flows", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          targetId: "window:win-feishu",
          observationId: "obs-ref-submit-1",
          backend: "screen_capture_kit_rect",
          appName: "飞书",
          windowId: "win-feishu",
          windowTitle: "飞书",
          width: 1800,
          height: 1200,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:03:00Z",
          diagnostics: {
            capture: {
              backend: "screen_capture_kit_rect",
              scopeType: "window",
              targetKind: "window",
              targetId: "window:win-feishu",
              observationId: "obs-ref-submit-1",
              frameSize: { width: 1800, height: 1200 },
              globalRect: { x: 0, y: 0, width: 900, height: 600 },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          targetKind: "window",
          targetId: "window:win-feishu",
          observationId: "obs-ref-submit-1",
          windowId: "win-feishu",
          appName: "飞书",
          targetMatched: true,
          nodes: [
            {
              id: "0",
              role: "AXWindow",
              label: "飞书",
              children: [
                {
                  id: "0.0",
                  role: "AXSearchField",
                  label: "搜索",
                  editable: true,
                  rect: { x: 100, y: 80, width: 700, height: 52 },
                  children: [],
                },
              ],
            },
          ],
        },
      })
      .mockImplementationOnce(async (_method: string, _gatewayOpts: unknown, params: unknown) => {
        expect(params).toMatchObject({
          command: "computer.action",
          params: {
            action: "set_text_submit",
            targetId: "window:win-feishu",
            windowId: "win-feishu",
            observationId: "obs-ref-submit-1",
            point: { x: 900, y: 212 },
            text: "杨万权",
            waitMs: 250,
            frameWidth: 1800,
            frameHeight: 1200,
          },
        });
        return {
          payload: {
            action: "set_text_submit",
            status: "success",
            targetId: "window:win-feishu",
            executedAt: "2026-04-22T00:03:01Z",
            point: { x: 900, y: 212 },
            textLength: 3,
            inputBackend: "ax_set_value+enter",
            semanticPath: "hit_test_semantic",
            selectorAttempted: true,
            selectorMatched: false,
          },
        };
      });

    const result = await buildTool({
      ...SESSION_CONFIG,
      approvals: { highRiskActionsRequireConfirm: false },
    }).execute("tool-ref-submit-1", {
      action: "set_text_submit",
      elementRef: "@e1",
      text: "杨万权",
      waitMs: 250,
      verifyAfterAction: false,
    } as never);

    expect(result).toMatchObject({
      details: {
        action: {
          type: "set_text_submit",
          status: "success",
          point: { x: 900, y: 212 },
          inputBackend: "ax_set_value+enter",
        },
      },
    });
  });

  it("grounds logical-scale type coordinates against frame-scale candidates", () => {
    const selected = resolveSelectedTarget({
      point: { x: 396, y: 93 },
      target: {
        targetId: "window:win-search",
        kind: "window",
        frameSize: { width: 2580, height: 1540 },
        logicalSize: { width: 1290, height: 770 },
        capture: { scaleFactor: 2 },
        display: { scaleFactor: 2 },
      },
      candidates: [
        {
          id: "ocr:search",
          ref: "@e1",
          source: "ocr",
          role: "ocr_text",
          label: "Q 问你想问的问题，或搜索关键词",
          confidence: 0.96,
          rect: {
            x: 300,
            y: 179,
            width: 551,
            height: 49,
          },
          actionCapabilities: ["click", "type"],
        },
      ],
    });

    expect(selected).toMatchObject({
      candidateId: "ocr:search",
      elementRef: "@e1",
      point: {
        x: 575.5,
        y: 203.5,
      },
    });
  });

  it("does not let non-actionable AX containers block scaled modal result grounding", () => {
    const selected = resolveSelectedTarget({
      point: { x: 287, y: 182 },
      target: {
        targetId: "window:feishu-search",
        kind: "window",
        frameSize: { width: 3024, height: 1752 },
        logicalSize: { width: 1512, height: 876 },
        capture: { scaleFactor: 2 },
        display: { scaleFactor: 2 },
      },
      candidates: [
        {
          id: "ax:modal-container",
          ref: "@e1",
          source: "ax",
          role: "AXGroup",
          label: "ModalWebViewWidget - search:search-command-bar:default",
          confidence: 0.98,
          rect: { x: 266, y: 0, width: 2080, height: 1224 },
          actionCapabilities: ["select"],
        },
        {
          id: "ocr:person-result",
          ref: "@e2",
          source: "ocr",
          role: "ocr_line",
          label: "杨万权",
          confidence: 0.93,
          rect: { x: 501, y: 387, width: 194, height: 152 },
          actionCapabilities: ["click"],
        },
      ],
    });

    expect(selected).toMatchObject({
      candidateId: "ocr:person-result",
      elementRef: "@e2",
      point: { x: 598, y: 463 },
      rect: { x: 501, y: 387, width: 194, height: 152 },
    });
  });

  it("ranks OCR candidates before limiting so late high-confidence targets are not dropped", () => {
    const repeatedWatermarks = Array.from({ length: 12 }, (_, index) => ({
      id: `ocr:watermark:${index}`,
      text: "杨万权 5106",
      confidence: 0.97,
      rect: { x: 150 + index * 90, y: 120 + index * 36, width: 130, height: 28 },
    }));
    const candidates = buildCandidateProposals({
      limit: 6,
      capture: {
        frameSize: { width: 3024, height: 1752 },
      },
      ocrSnapshot: {
        supported: true,
        regions: [
          ...repeatedWatermarks,
          {
            id: "ocr:target:person",
            text: "杨万权",
            confidence: 1,
            rect: { x: 549, y: 443, width: 97, height: 40 },
          },
        ],
      },
    });

    expect(candidates?.some((candidate) => candidate.sourceId === "ocr:target:person")).toBe(true);
  });

  it("scopes AX candidates to an active modal surface when one is present", () => {
    const candidates = buildCandidateProposals({
      limit: 12,
      capture: {
        frameSize: { width: 1000, height: 800 },
        globalRect: { x: 0, y: 0, width: 1000, height: 800 },
      },
      axSnapshot: {
        supported: true,
        nodes: [
          {
            id: "0",
            role: "AXWindow",
            label: "飞书",
            rect: { x: 0, y: 0, width: 1000, height: 800 },
            children: [
              {
                id: "0.0",
                role: "AXButton",
                label: "底层窗口按钮",
                rect: { x: 40, y: 100, width: 160, height: 48 },
                actions: ["AXPress"],
                children: [],
              },
              {
                id: "0.1",
                role: "AXDialog",
                label: "ModalWebViewWidget - search-command-bar",
                rect: { x: 200, y: 150, width: 600, height: 420 },
                children: [
                  {
                    id: "0.1.0",
                    role: "AXButton",
                    label: "杨万权",
                    rect: { x: 240, y: 250, width: 300, height: 58 },
                    actions: ["AXPress"],
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "0.1.0",
          label: "杨万权",
        }),
      ]),
    );
    expect(candidates?.some((candidate) => candidate.label === "底层窗口按钮")).toBe(false);
  });

  it("uses local OCR regions as fallback candidates when AX is sparse", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
          supportsOcr: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          observationId: "obs-ocr-1",
          backend: "screen_capture_kit_rect",
          appName: "WeChat",
          bundleId: "com.tencent.xinWeChat",
          windowId: "win-wechat",
          windowTitle: "WeChat",
          globalX: 100,
          globalY: 80,
          logicalWidth: 1000,
          logicalHeight: 800,
          width: 2000,
          height: 1600,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:00:05Z",
          diagnostics: {
            capture: {
              backend: "screen_capture_kit_rect",
              scopeType: "window",
              targetKind: "window",
              observationId: "obs-ocr-1",
              appName: "WeChat",
              bundleId: "com.tencent.xinWeChat",
              windowId: "win-wechat",
              windowTitle: "WeChat",
              frameSize: { width: 2000, height: 1600 },
              globalRect: { x: 100, y: 80, width: 1000, height: 800 },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          windowId: "win-wechat",
          appName: "WeChat",
          windowTitle: "WeChat",
          targetMatched: true,
          nodeCount: 1,
          nodes: [
            {
              id: "0",
              role: "AXWindow",
              label: "WeChat",
              children: [],
            },
          ],
        },
      })
      .mockResolvedValueOnce(OBSERVE_OCR_PAYLOAD);

    const result = await buildTool().execute("tool-ocr-1", { action: "observe" } as never);

    expect(result).toMatchObject({
      details: {
        kind: "computer_use/v1",
        stage: "completed",
        ocrSnapshot: {
          supported: true,
          targetKind: "window",
          targetId: "window:win-wechat",
          observationId: "obs-ocr-1",
          displayId: "display-1",
          engine: "apple-vision",
          regionCount: 2,
          target: {
            targetId: "window:win-wechat",
            app: {
              bundleId: "com.tencent.xinWeChat",
            },
            window: {
              windowId: "win-wechat",
            },
          },
          diagnostics: {
            capture: {
              backend: "observation_binding",
              targetId: "window:win-wechat",
              observationId: "obs-ocr-1",
            },
          },
        },
        candidates: expect.arrayContaining([
          expect.objectContaining({
            id: "ocr-line:1",
            label: "基努里维奇",
            role: "ocr_line",
            source: "ocr",
            rect: expect.objectContaining({
              x: expect.any(Number),
              y: expect.any(Number),
              width: expect.any(Number),
              height: expect.any(Number),
            }),
          }),
          expect.objectContaining({
            id: "ocr-1",
            label: "基努里维奇",
            role: "ocr_text",
            source: "ocr",
            rect: { x: 320, y: 120, width: 220, height: 42 },
          }),
        ]),
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("OCR supported=yes"),
        }),
      ]),
    );
    const ocrCall = gatewayMocks.callGatewayTool.mock.calls.find(
      ([, , params]) => (params as { command?: string } | undefined)?.command === "computer.ocr",
    );
    expect(
      (ocrCall?.[2] as { params?: Record<string, unknown> } | undefined)?.params,
    ).toMatchObject({
      scopeType: "window",
      windowId: "win-wechat",
      observationId: "obs-ocr-1",
    });
    expect(
      (ocrCall?.[2] as { params?: Record<string, unknown> } | undefined)?.params,
    ).not.toHaveProperty("base64Png");
  });

  it("does not merge same-row OCR text across distant app columns", () => {
    const candidates = buildCandidateProposals({
      capture: {
        frameSize: { width: 2580, height: 1540 },
      },
      ocrSnapshot: {
        supported: true,
        engine: "apple-vision",
        regionCount: 3,
        truncated: false,
        regions: [
          {
            id: "ocr:left",
            text: "知识库",
            confidence: 0.92,
            rect: { x: 41, y: 471, width: 147, height: 39 },
          },
          {
            id: "ocr:middle",
            text: "来看看为你量身定制的效率工具",
            confidence: 1,
            rect: { x: 589, y: 487, width: 375, height: 34 },
          },
          {
            id: "ocr:right",
            text: "目标清单",
            confidence: 1,
            rect: { x: 1931, y: 467, width: 139, height: 40 },
          },
        ],
      },
      limit: 12,
    });

    expect(candidates).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({
          role: "ocr_line",
          label: expect.stringContaining("来看看为你量身定制的效率工具 目标清单"),
        }),
      ]),
    );
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "知识库",
          role: "ocr_line",
        }),
        expect.objectContaining({
          label: "目标清单",
          role: "ocr_line",
        }),
      ]),
    );
    expect(candidates?.find((candidate) => candidate.label === "知识库")?.rect?.width).toBeLessThan(
      260,
    );
  });

  it("grounds elementRef actions to the candidate center instead of a stale explicit point", () => {
    expect(
      resolveSelectedTarget({
        elementRef: "@e1",
        point: { x: 42, y: 450 },
        candidates: [
          {
            id: "ocr-line:1",
            ref: "@e1",
            label: "知识库",
            role: "ocr_line",
            source: "ocr",
            rect: { x: 0, y: 448, width: 214, height: 91 },
          },
        ],
      }),
    ).toMatchObject({
      candidateId: "ocr-line:1",
      elementRef: "@e1",
      point: {
        x: 107,
        y: 493.5,
      },
    });
  });

  it("marks OCR search fields as type-capable candidates", () => {
    const candidates = buildCandidateProposals({
      capture: {
        frameSize: { width: 2580, height: 1540 },
      },
      ocrSnapshot: {
        supported: true,
        engine: "apple-vision",
        regionCount: 1,
        truncated: false,
        regions: [
          {
            id: "ocr:search",
            text: "Q 问你想问的问题，或搜索关键词",
            confidence: 1,
            rect: { x: 300, y: 180, width: 551, height: 49 },
          },
        ],
      },
      limit: 12,
    });

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Q 问你想问的问题，或搜索关键词",
          actionCapabilities: expect.arrayContaining(["click", "type"]),
        }),
      ]),
    );
  });

  it("fails raw coordinate clicks that cannot be grounded to current candidates", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
          supportsOcr: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          targetId: "window:win-wechat",
          observationId: "obs-raw-miss-1",
          backend: "screen_capture_kit_rect",
          appName: "WeChat",
          bundleId: "com.tencent.xinWeChat",
          windowId: "win-wechat",
          windowTitle: "WeChat",
          width: 2000,
          height: 1600,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:00:06Z",
          diagnostics: {
            capture: {
              backend: "screen_capture_kit_rect",
              scopeType: "window",
              targetKind: "window",
              targetId: "window:win-wechat",
              observationId: "obs-raw-miss-1",
              frameSize: { width: 2000, height: 1600 },
              globalRect: { x: 100, y: 80, width: 1000, height: 800 },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          targetKind: "window",
          targetId: "window:win-wechat",
          observationId: "obs-raw-miss-1",
          windowId: "win-wechat",
          appName: "WeChat",
          targetMatched: true,
          nodeCount: 1,
          nodes: [{ id: "0", role: "AXWindow", label: "WeChat", children: [] }],
        },
      })
      .mockResolvedValueOnce(OBSERVE_OCR_PAYLOAD);

    const result = await buildTool().execute("tool-raw-miss-1", {
      action: "click",
      x: 10,
      y: 10,
      verifyAfterAction: false,
    } as never);

    expect(
      gatewayMocks.callGatewayTool.mock.calls.some(
        ([, , params]) =>
          (params as { command?: string } | undefined)?.command === "computer.action",
      ),
    ).toBe(false);
    expect(result).toMatchObject({
      details: {
        kind: "computer_use/v1",
        status: "error",
        stage: "error",
        summary: "Raw coordinate action could not be grounded to a current candidate.",
        error: expect.stringContaining("COORDINATE_UNGROUNDED"),
        selected: {
          point: { x: 10, y: 10 },
        },
        action: {
          type: "click",
          status: "failed",
        },
      },
    });
  });

  it("snaps near-miss raw coordinate clicks to the nearest current candidate", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
          supportsOcr: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          targetId: "window:win-wechat",
          observationId: "obs-raw-snap-1",
          backend: "screen_capture_kit_rect",
          appName: "WeChat",
          bundleId: "com.tencent.xinWeChat",
          windowId: "win-wechat",
          windowTitle: "WeChat",
          width: 2000,
          height: 1600,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:00:07Z",
          diagnostics: {
            capture: {
              backend: "screen_capture_kit_rect",
              scopeType: "window",
              targetKind: "window",
              targetId: "window:win-wechat",
              observationId: "obs-raw-snap-1",
              frameSize: { width: 2000, height: 1600 },
              globalRect: { x: 100, y: 80, width: 1000, height: 800 },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          targetKind: "window",
          targetId: "window:win-wechat",
          observationId: "obs-raw-snap-1",
          windowId: "win-wechat",
          appName: "WeChat",
          targetMatched: true,
          nodeCount: 1,
          nodes: [{ id: "0", role: "AXWindow", label: "WeChat", children: [] }],
        },
      })
      .mockResolvedValueOnce(OBSERVE_OCR_PAYLOAD)
      .mockImplementationOnce(async (_method: string, _gatewayOpts: unknown, params: unknown) => {
        const actionParams = (params as { params?: { point?: { x: number; y: number } } }).params;
        expect(actionParams?.point?.x).toBeCloseTo(430);
        expect(actionParams?.point?.y).toBeCloseTo(141);
        return {
          payload: {
            action: "click",
            status: "success",
            targetId: "window:win-wechat",
            executedAt: "2026-04-22T00:00:08Z",
            point: actionParams?.point,
          },
        };
      });

    const result = await buildTool().execute("tool-raw-snap-1", {
      action: "click",
      x: 250,
      y: 140,
      verifyAfterAction: false,
    } as never);

    expect(result).toMatchObject({
      details: {
        kind: "computer_use/v1",
        status: "ok",
        stage: "completed",
        selected: {
          candidateId: "ocr-line:1",
          point: {
            x: expect.any(Number),
            y: expect.any(Number),
          },
        },
        warning: expect.stringContaining("was snapped to"),
        action: {
          type: "click",
          status: "success",
        },
      },
    });
  });

  it("uses CDP DOM nodes as semantic candidates when AX is sparse", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
          supportsCdp: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          targetId: "window:win-web",
          observationId: "obs-cdp-1",
          backend: "screen_capture_kit_rect",
          appName: "Chrome",
          bundleId: "com.google.Chrome",
          windowId: "win-web",
          windowTitle: "Billing",
          globalX: 80,
          globalY: 60,
          logicalWidth: 1200,
          logicalHeight: 800,
          width: 2400,
          height: 1600,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:00:10Z",
          diagnostics: {
            capture: {
              backend: "screen_capture_kit_rect",
              scopeType: "window",
              targetKind: "window",
              targetId: "window:win-web",
              observationId: "obs-cdp-1",
              appName: "Chrome",
              bundleId: "com.google.Chrome",
              windowId: "win-web",
              windowTitle: "Billing",
              frameSize: { width: 2400, height: 1600 },
              globalRect: { x: 80, y: 60, width: 1200, height: 800 },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          targetKind: "window",
          targetId: "window:win-web",
          observationId: "obs-cdp-1",
          windowId: "win-web",
          appName: "Chrome",
          windowTitle: "Billing",
          targetMatched: true,
          nodeCount: 1,
          nodes: [
            {
              id: "0",
              role: "AXWindow",
              label: "Billing",
              children: [],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          targetKind: "window",
          targetId: "window:win-web",
          observationId: "obs-cdp-1",
          engine: "cdp-runtime",
          endpointId: "cdp:127.0.0.1:9222",
          browser: "Chrome/126.0.0.0",
          pageId: "page-1",
          pageTitle: "Billing",
          pageUrl: "https://example.test/billing",
          coordinateMapping: "screen-offset",
          nodeCount: 2,
          nodes: [
            {
              id: "cdp:0:button:nth-of-type(1)",
              role: "button",
              label: "Pay invoice",
              tagName: "button",
              rect: { x: 1400, y: 620, width: 260, height: 80 },
              cssRect: { x: 660, y: 280, width: 130, height: 40 },
              coordinateMapping: "screen-offset",
              enabled: true,
              actionCapabilities: ["click", "press"],
            },
            {
              id: "cdp:1:button:nth-of-type(2)",
              role: "button",
              label: "Unmapped",
              tagName: "button",
              cssRect: { x: 10, y: 20, width: 100, height: 30 },
              coordinateMapping: "unmapped",
              enabled: true,
              actionCapabilities: ["click"],
            },
          ],
        },
      })
      .mockResolvedValueOnce(TARGET_CATALOG_PAYLOAD);

    const result = await buildTool().execute("tool-cdp-1", { action: "observe" } as never);

    expect(result).toMatchObject({
      details: {
        kind: "computer_use/v1",
        stage: "completed",
        cdpSnapshot: {
          supported: true,
          engine: "cdp-runtime",
          endpointId: "cdp:127.0.0.1:9222",
          pageTitle: "Billing",
          coordinateMapping: "screen-offset",
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: "cdp:0:button:nth-of-type(1)",
              rect: { x: 1400, y: 620, width: 260, height: 80 },
              cssRect: { x: 660, y: 280, width: 130, height: 40 },
              coordinateMapping: "screen-offset",
            }),
          ]),
        },
        candidates: expect.arrayContaining([
          expect.objectContaining({
            ref: "@e1",
            id: "cdp:0:button:nth-of-type(1)",
            sourceId: "cdp:0:button:nth-of-type(1)",
            label: "Pay invoice",
            role: "button",
            source: "cdp",
            rect: { x: 1400, y: 620, width: 260, height: 80 },
            selector: expect.objectContaining({
              source: "cdp",
              sourceId: "cdp:0:button:nth-of-type(1)",
              targetId: "window:win-web",
              label: "Pay invoice",
            }),
            actionCapabilities: expect.arrayContaining(["click", "press"]),
          }),
        ]),
      },
    });
    const resultDetails = result.details as { candidates?: unknown[] } | undefined;
    expect(resultDetails?.candidates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "cdp:1:button:nth-of-type(2)",
        }),
      ]),
    );
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("CDP DOM supported=yes"),
        }),
      ]),
    );
    const cdpCall = gatewayMocks.callGatewayTool.mock.calls.find(
      ([, , params]) => (params as { command?: string } | undefined)?.command === "computer.cdp",
    );
    expect(
      (cdpCall?.[2] as { params?: Record<string, unknown> } | undefined)?.params,
    ).toMatchObject({
      scopeType: "window",
      targetId: "window:win-web",
      windowId: "win-web",
      observationId: "obs-cdp-1",
      maxNodes: 120,
    });
  });

  it("discovers real device targets without requiring screen observation permission", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: false,
          controlAllowed: false,
        },
      })
      .mockResolvedValueOnce(TARGET_CATALOG_PAYLOAD);

    const result = await buildTool().execute("tool-targets-1", {
      action: "discover_targets",
    } as never);

    expect(
      gatewayMocks.callGatewayTool.mock.calls.some(
        ([, , params]) =>
          (params as { command?: string } | undefined)?.command === "computer.capture",
      ),
    ).toBe(false);
    expect(result).toMatchObject({
      details: {
        kind: "computer_use/v1",
        status: "ok",
        stage: "completed",
        action: {
          type: "discover_targets",
          status: "success",
        },
        targets: {
          windows: [
            expect.objectContaining({
              windowId: "win-lark",
              appName: "飞书",
              bundleId: "com.lark.app",
            }),
          ],
          apps: [
            expect.objectContaining({
              appName: "飞书",
              bundleId: "com.lark.app",
              processId: 501,
            }),
          ],
          cdpEndpoints: [
            expect.objectContaining({
              endpointId: "cdp:127.0.0.1:9222",
              host: "127.0.0.1",
              port: 9222,
              browser: "Chrome/126.0.0.0",
            }),
          ],
        },
      },
    });
    const modelText = result.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    expect(modelText).toContain("Available CDP endpoints:");
    expect(modelText).toContain("endpointId=cdp:127.0.0.1:9222");
  });

  it("prioritizes regular running apps in the model-facing target summary even without visible windows", async () => {
    const crowdedTargetCatalog = {
      payload: {
        generatedAt: "2026-04-22T00:00:45Z",
        windows: [],
        apps: [
          ...Array.from({ length: 12 }, (_, index) => ({
            appName: `System Helper ${index}`,
            bundleId: `com.apple.helper.${index}`,
            processId: 700 + index,
            isFrontmost: false,
            isHidden: false,
            activationPolicy: "accessory",
            visibleWindowCount: 0,
            visibleWindowIds: [],
          })),
          {
            appName: "微信",
            bundleId: "com.tencent.xinWeChat",
            processId: 679,
            isFrontmost: false,
            isHidden: false,
            activationPolicy: "regular",
            visibleWindowCount: 0,
            visibleWindowIds: [],
          },
        ],
      },
    };
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: false,
          controlAllowed: false,
        },
      })
      .mockResolvedValueOnce(crowdedTargetCatalog);

    const result = await buildTool().execute("tool-targets-prioritized-apps-1", {
      action: "discover_targets",
    } as never);

    const modelText = result.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    expect(modelText).toContain("Running apps:");
    expect(modelText).toContain("微信 | bundle=com.tencent.xinWeChat");
    expect(modelText).toContain("visibleWindows=0");
    expect(modelText).toContain("policy=regular");
  });

  it("passes pre-action frame dimensions into computer.action and captures post-action verification", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          observationId: "obs-before-1",
          backend: "screen_capture_kit",
          appName: "Browser",
          windowId: "win-2",
          windowTitle: "Browser",
          width: 1512,
          height: 982,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:00:00Z",
          diagnostics: {
            capture: {
              backend: "screen_capture_kit",
              scopeType: "window",
              targetKind: "window",
              observationId: "obs-before-1",
              frameSize: { width: 1512, height: 982 },
            },
          },
        },
      })
      .mockResolvedValueOnce(ACTION_AX_PAYLOAD)
      .mockImplementationOnce(async (_method: string, _gatewayOpts: unknown, params: unknown) => {
        expect(params).toMatchObject({
          command: "computer.action",
          params: {
            action: "click",
            scopeType: "window",
            windowId: "win-2",
            observationId: "obs-before-1",
            point: { x: 320, y: 240 },
            frameWidth: 1512,
            frameHeight: 982,
          },
        });
        return {
          payload: {
            action: "click",
            status: "success",
            executedAt: "2026-04-22T00:00:02Z",
            point: { x: 320, y: 240 },
            diagnostics: {
              action: {
                scopeType: "window",
                targetKind: "window",
                observationId: "obs-before-1",
                mappingSource: "observation_binding",
                frameSize: { width: 1512, height: 982 },
                relativePoint: { x: 320, y: 240 },
                absolutePoint: { x: 640, y: 480 },
                executedAt: "2026-04-22T00:00:02Z",
              },
            },
          },
        };
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          observationId: "obs-after-1",
          backend: "screen_capture_kit",
          appName: "Browser",
          windowId: "win-2",
          windowTitle: "Browser",
          width: 1512,
          height: 982,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:00:03Z",
          diagnostics: {
            capture: {
              backend: "screen_capture_kit",
              scopeType: "window",
              targetKind: "window",
              observationId: "obs-after-1",
              frameSize: { width: 1512, height: 982 },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          windowId: "win-2",
          appName: "Browser",
          windowTitle: "Browser",
          targetMatched: false,
          nodeCount: 4,
          nodes: [
            {
              id: "0",
              role: "AXWindow",
              label: "Browser",
              children: [
                {
                  id: "0.0",
                  role: "AXStaticText",
                  value: "Published",
                  children: [],
                },
              ],
            },
          ],
        },
      });

    const result = await buildTool().execute("tool-2", {
      action: "click",
      x: 320,
      y: 240,
    } as never);

    expect(result).toMatchObject({
      details: {
        status: "ok",
        kind: "computer_use/v1",
        stage: "completed",
        axSnapshot: {
          supported: true,
          targetMatched: false,
          nodeCount: 4,
        },
        candidates: expect.arrayContaining([
          expect.objectContaining({
            label: "Published",
          }),
        ]),
        postActionFrame: {
          artifactId: "tool-2:after:2026-04-22T00:00:03Z",
        },
        action: {
          type: "click",
          status: "success",
          point: { x: 320, y: 240 },
        },
        observation: {
          observationId: "obs-after-1",
        },
        diagnostics: {
          capture: {
            backend: "screen_capture_kit",
            observationId: "obs-before-1",
          },
          postActionCapture: {
            backend: "screen_capture_kit",
            observationId: "obs-after-1",
          },
          action: {
            mappingSource: "observation_binding",
            absolutePoint: {
              x: 640,
              y: 480,
            },
          },
        },
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("Candidates:") }),
        expect.objectContaining({ type: "image", mimeType: "image/png", data: PNG_BASE64 }),
      ]),
    );
  });

  it("resolves focus_window to a real device window target before executing and verifying", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce(TARGET_CATALOG_PAYLOAD)
      .mockImplementationOnce(async (_method: string, _gatewayOpts: unknown, params: unknown) => {
        expect(params).toMatchObject({
          command: "computer.action",
          params: {
            action: "focus_window",
            scopeType: "window",
            windowId: "win-lark",
            appName: "飞书",
            bundleId: "com.lark.app",
          },
        });
        expect(params).not.toMatchObject({
          params: {
            observationId: "obs-focus-before-1",
          },
        });
        return {
          payload: {
            action: "focus_window",
            status: "success",
            executedAt: "2026-04-22T00:06:02Z",
            appName: "飞书",
            bundleId: "com.lark.app",
            windowId: "win-lark",
          },
        };
      })
      .mockImplementationOnce(async (_method: string, _gatewayOpts: unknown, params: unknown) => {
        expect(params).toMatchObject({
          command: "computer.capture",
          params: {
            scopeType: "window",
            windowId: "win-lark",
          },
        });
        return {
          payload: {
            scopeType: "window",
            targetKind: "window",
            observationId: "obs-focus-after-1",
            backend: "screen_capture_kit",
            appName: "飞书",
            bundleId: "com.lark.app",
            windowId: "win-lark",
            windowTitle: "消息",
            width: 1440,
            height: 900,
            mimeType: "image/png",
            base64Png: PNG_BASE64,
            capturedAt: "2026-04-22T00:06:03Z",
          },
        };
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          windowId: "win-lark",
          appName: "飞书",
          windowTitle: "消息",
          targetMatched: true,
          nodeCount: 1,
          nodes: [
            {
              id: "0",
              role: "AXWindow",
              label: "消息",
              children: [],
            },
          ],
        },
      })
      .mockResolvedValueOnce(TARGET_CATALOG_PAYLOAD);

    const result = await buildTool().execute("tool-focus-real-target-1", {
      action: "focus_window",
      appName: "飞书",
      verifyAfterAction: false,
    } as never);

    expect(result).toMatchObject({
      details: {
        status: "ok",
        stage: "completed",
        action: {
          type: "focus_window",
          status: "success",
        },
        observation: {
          appName: "飞书",
          bundleId: "com.lark.app",
          windowId: "win-lark",
        },
        targets: {
          windows: [
            expect.objectContaining({
              windowId: "win-lark",
            }),
          ],
        },
      },
    });
    const commands = gatewayMocks.callGatewayTool.mock.calls.map(
      ([, , params]) => (params as { command?: string } | undefined)?.command,
    );
    expect(commands.indexOf("computer.action")).toBeLessThan(commands.indexOf("computer.capture"));
  });

  it("resolves focus_window from a catalog targetId without guessed app names", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce(TARGET_CATALOG_PAYLOAD)
      .mockImplementationOnce(async (_method: string, _gatewayOpts: unknown, params: unknown) => {
        expect(params).toMatchObject({
          command: "computer.action",
          params: {
            action: "focus_window",
            targetId: "window:win-lark",
            windowId: "win-lark",
            appName: "飞书",
            bundleId: "com.lark.app",
          },
        });
        return {
          payload: {
            action: "focus_window",
            status: "success",
            targetId: "window:win-lark",
            executedAt: "2026-04-22T00:06:02Z",
            appName: "飞书",
            bundleId: "com.lark.app",
            windowId: "win-lark",
          },
        };
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          targetId: "window:win-lark",
          observationId: "obs-focus-after-1",
          backend: "screen_capture_kit",
          appName: "飞书",
          bundleId: "com.lark.app",
          windowId: "win-lark",
          windowTitle: "消息",
          width: 1440,
          height: 900,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:06:03Z",
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          windowId: "win-lark",
          appName: "飞书",
          windowTitle: "消息",
          targetMatched: true,
          nodeCount: 1,
          nodes: [],
        },
      })
      .mockResolvedValueOnce(TARGET_CATALOG_PAYLOAD);

    const result = await buildTool().execute("tool-focus-target-id-1", {
      action: "focus_window",
      targetId: "window:win-lark",
      verifyAfterAction: false,
    } as never);

    expect(result).toMatchObject({
      details: {
        action: {
          type: "focus_window",
          status: "success",
          targetId: "window:win-lark",
        },
        observation: {
          targetId: "window:win-lark",
          windowId: "win-lark",
        },
      },
    });
  });

  it("falls back to the frontmost window when post-focus capture by windowId fails", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce(TARGET_CATALOG_PAYLOAD)
      .mockResolvedValueOnce({
        payload: {
          action: "focus_window",
          status: "success",
          executedAt: "2026-04-22T00:06:12Z",
          appName: "飞书",
          bundleId: "com.lark.app",
          windowId: "win-lark",
        },
      })
      .mockRejectedValueOnce(new Error("window win-lark is no longer visible"))
      .mockImplementationOnce(async (_method: string, _gatewayOpts: unknown, params: unknown) => {
        expect(params).toMatchObject({
          command: "computer.capture",
          params: {
            scopeType: "current_window",
          },
        });
        return {
          payload: {
            scopeType: "current_window",
            targetKind: "window",
            observationId: "obs-focus-frontmost-after-1",
            backend: "screen_capture_kit",
            appName: "飞书",
            bundleId: "com.lark.app",
            windowId: "win-lark-new",
            windowTitle: "消息",
            width: 1440,
            height: 900,
            mimeType: "image/png",
            base64Png: PNG_BASE64,
            capturedAt: "2026-04-22T00:06:13Z",
          },
        };
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          windowId: "win-lark-new",
          appName: "飞书",
          windowTitle: "消息",
          targetMatched: true,
          nodeCount: 1,
          nodes: [
            {
              id: "0",
              role: "AXWindow",
              label: "消息",
              children: [],
            },
          ],
        },
      })
      .mockResolvedValueOnce(TARGET_CATALOG_PAYLOAD);

    const result = await buildTool().execute("tool-focus-frontmost-fallback-1", {
      action: "focus_window",
      appName: "飞书",
      verifyAfterAction: false,
    } as never);

    expect(result).toMatchObject({
      details: {
        status: "ok",
        stage: "completed",
        observation: {
          appName: "飞书",
          bundleId: "com.lark.app",
          windowId: "win-lark-new",
        },
      },
    });
  });

  it("fails focus_window early when the requested app name is not a real device target", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce(TARGET_CATALOG_PAYLOAD);

    const result = await buildTool().execute("tool-focus-missing-target-1", {
      action: "focus_window",
      appName: "Feishu",
      verifyAfterAction: false,
    } as never);

    expect(
      gatewayMocks.callGatewayTool.mock.calls.some(([, , params]) => {
        const command = (params as { command?: string } | undefined)?.command;
        return command === "computer.capture" || command === "computer.action";
      }),
    ).toBe(false);
    expect(result).toMatchObject({
      details: {
        kind: "computer_use/v1",
        status: "error",
        stage: "error",
        summary: "Requested focus target was not found on this device.",
        error: expect.stringContaining("appName=Feishu"),
        targets: {
          windows: [
            expect.objectContaining({
              appName: "飞书",
            }),
          ],
        },
      },
    });
  });

  it("fails focus_window when post-action verification does not match the requested target", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce(TARGET_CATALOG_PAYLOAD)
      .mockResolvedValueOnce({
        payload: {
          action: "focus_window",
          status: "success",
          executedAt: "2026-04-22T00:07:02Z",
          appName: "飞书",
          bundleId: "com.lark.app",
          windowId: "win-lark",
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          observationId: "obs-focus-mismatch-after-1",
          backend: "screen_capture_kit",
          appName: "Browser",
          bundleId: "com.example.browser",
          windowId: "win-browser",
          windowTitle: "Browser",
          width: 1440,
          height: 900,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:07:03Z",
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          windowId: "win-browser",
          appName: "Browser",
          windowTitle: "Browser",
          targetMatched: true,
          nodeCount: 1,
          nodes: [
            {
              id: "0",
              role: "AXWindow",
              label: "Browser",
              children: [],
            },
          ],
        },
      })
      .mockResolvedValueOnce(TARGET_CATALOG_PAYLOAD);

    const result = await buildTool().execute("tool-focus-mismatch-1", {
      action: "focus_window",
      appName: "飞书",
      verifyAfterAction: false,
    } as never);

    expect(result).toMatchObject({
      details: {
        kind: "computer_use/v1",
        status: "error",
        stage: "error",
        summary: "Focus target verification failed for window:win-lark.",
        warning: expect.stringContaining("did not match the requested focus target"),
        observation: {
          appName: "Browser",
          windowId: "win-browser",
        },
      },
    });
  });

  it("requests plugin approval for high-risk actions before invoking computer.action", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          observationId: "obs-hotkey-1",
          appName: "Browser",
          windowId: "win-hotkey",
          windowTitle: "Browser",
          width: 1440,
          height: 900,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:01:00Z",
        },
      })
      .mockResolvedValueOnce(ACTION_AX_PAYLOAD)
      .mockResolvedValueOnce({
        id: "plugin:approval-1",
        status: "accepted",
        expiresAtMs: 1_000,
      })
      .mockResolvedValueOnce({
        id: "plugin:approval-1",
        decision: "allow-once",
        expiresAtMs: 1_000,
      })
      .mockImplementationOnce(async (_method: string, _gatewayOpts: unknown, params: unknown) => {
        expect(params).toMatchObject({
          command: "computer.action",
          params: {
            action: "hotkey",
            hotkey: "cmd+l",
          },
        });
        return {
          payload: {
            action: "hotkey",
            status: "success",
            executedAt: "2026-04-22T00:01:02Z",
          },
        };
      });

    const onUpdate = vi.fn();
    const result = await buildTool().execute(
      "tool-hotkey-1",
      { action: "hotkey", hotkey: "cmd+l", verifyAfterAction: false } as never,
      undefined,
      onUpdate,
    );

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          kind: "computer_use/v1",
          status: "approval-pending",
          approvalKind: "plugin",
          approvalId: "plugin:approval-1",
        }),
      }),
    );
    expect(result).toMatchObject({
      details: {
        status: "ok",
        kind: "computer_use/v1",
        stage: "completed",
        action: {
          type: "hotkey",
          status: "success",
          hotkey: "cmd+l",
        },
      },
    });
  });

  it("rewrites application-switching hotkeys into focus_window when an explicit target is provided", async () => {
    const wechatTargetCatalog = {
      payload: {
        generatedAt: "2026-04-22T00:01:30Z",
        windows: [
          {
            windowId: "win-wechat",
            appName: "WeChat",
            bundleId: "com.tencent.xinWeChat",
            processId: 601,
            windowTitle: "WeChat",
            isFocused: false,
            isMinimized: false,
            isMaximized: false,
            rect: { x: 80, y: 120, width: 1200, height: 820 },
          },
        ],
        apps: [
          {
            appName: "WeChat",
            bundleId: "com.tencent.xinWeChat",
            processId: 601,
            isFrontmost: false,
            isHidden: false,
            activationPolicy: "regular",
            visibleWindowCount: 1,
            visibleWindowIds: ["win-wechat"],
          },
        ],
      },
    };
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce(wechatTargetCatalog)
      .mockImplementationOnce(async (_method: string, _gatewayOpts: unknown, params: unknown) => {
        expect(params).toMatchObject({
          command: "computer.action",
          params: {
            action: "focus_window",
            appName: "WeChat",
            bundleId: "com.tencent.xinWeChat",
            windowId: "win-wechat",
          },
        });
        expect(params).not.toMatchObject({
          params: {
            observationId: "obs-switch-1",
            hotkey: "cmd+tab",
          },
        });
        return {
          payload: {
            action: "focus_window",
            status: "success",
            executedAt: "2026-04-22T00:01:32Z",
            appName: "WeChat",
          },
        };
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          observationId: "obs-switch-2",
          appName: "WeChat",
          bundleId: "com.tencent.xinWeChat",
          windowId: "win-wechat",
          windowTitle: "WeChat",
          width: 1440,
          height: 900,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:01:33Z",
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          windowId: "win-wechat",
          appName: "WeChat",
          windowTitle: "WeChat",
          targetMatched: true,
          nodeCount: 1,
          nodes: [
            {
              id: "0",
              role: "AXWindow",
              label: "WeChat",
              children: [],
            },
          ],
        },
      })
      .mockResolvedValueOnce(wechatTargetCatalog);

    const result = await buildTool().execute("tool-switch-1", {
      action: "hotkey",
      hotkey: "cmd+tab",
      appName: "WeChat",
      verifyAfterAction: false,
    } as never);

    expect(
      gatewayMocks.callGatewayTool.mock.calls.some(
        ([method]) => method === "plugin.approval.request",
      ),
    ).toBe(false);
    expect(result).toMatchObject({
      details: {
        status: "ok",
        kind: "computer_use/v1",
        stage: "completed",
        warning:
          "Rewrote an application-switching hotkey into focus_window. Prefer focus_window with appName, bundleId, or windowId for app switching. Resolved focus_window to real device window win-wechat.",
        action: {
          type: "focus_window",
          status: "success",
        },
        observation: {
          appName: "WeChat",
          bundleId: "com.tencent.xinWeChat",
          windowId: "win-wechat",
        },
      },
    });
  });

  it("blocks application-switching hotkeys without an explicit target before approval or action execution", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          observationId: "obs-switch-blocked-1",
          appName: "Editor",
          windowId: "win-editor",
          windowTitle: "Editor",
          width: 1440,
          height: 900,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:01:40Z",
        },
      })
      .mockResolvedValueOnce(ACTION_AX_PAYLOAD);

    const result = await buildTool().execute("tool-switch-blocked-1", {
      action: "hotkey",
      hotkey: "cmd+tab",
      verifyAfterAction: false,
    } as never);

    expect(
      gatewayMocks.callGatewayTool.mock.calls.some(
        ([method]) => method === "plugin.approval.request" || method === "computer.action",
      ),
    ).toBe(false);
    expect(result).toMatchObject({
      details: {
        kind: "computer_use/v1",
        status: "error",
        stage: "error",
        summary: "Application-switching hotkey blocked; use focus_window with an explicit target.",
        error:
          "Application-switching hotkeys are not allowed without an explicit target. Retry with action=focus_window and provide appName, bundleId, or windowId.",
        warning:
          "Prefer focus_window with appName, bundleId, or windowId instead of application-switcher hotkeys such as cmd+tab.",
        action: {
          type: "hotkey",
          status: "failed",
          hotkey: "cmd+tab",
        },
      },
    });
  });

  it("skips repeated approval requests after allow-always for the same high-risk action fingerprint", async () => {
    const tool = createComputerUseTool({
      sessionConfig: SESSION_CONFIG,
      sessionKey: "session-trusted-hotkey",
      agentId: "primary",
    });

    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          observationId: "obs-hotkey-allow-1",
          appName: "Editor",
          windowId: "win-hotkey-allow",
          windowTitle: "Editor",
          width: 1280,
          height: 720,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:02:00Z",
        },
      })
      .mockResolvedValueOnce(ACTION_AX_PAYLOAD)
      .mockResolvedValueOnce({
        id: "plugin:approval-allow-always",
        status: "accepted",
        expiresAtMs: 1_000,
      })
      .mockResolvedValueOnce({
        id: "plugin:approval-allow-always",
        decision: "allow-always",
        expiresAtMs: 1_000,
      })
      .mockResolvedValueOnce({
        payload: {
          action: "hotkey",
          status: "success",
          executedAt: "2026-04-22T00:02:02Z",
        },
      });

    await tool.execute("tool-hotkey-allow-1", {
      action: "hotkey",
      hotkey: "cmd+l",
      verifyAfterAction: false,
    } as never);

    gatewayMocks.callGatewayTool.mockClear();

    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          observationId: "obs-hotkey-allow-2",
          appName: "Editor",
          windowId: "win-hotkey-allow",
          windowTitle: "Editor",
          width: 1280,
          height: 720,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:03:00Z",
        },
      })
      .mockResolvedValueOnce(ACTION_AX_PAYLOAD)
      .mockResolvedValueOnce({
        payload: {
          action: "hotkey",
          status: "success",
          executedAt: "2026-04-22T00:03:02Z",
        },
      });

    const result = await tool.execute("tool-hotkey-allow-2", {
      action: "hotkey",
      hotkey: "cmd+l",
      verifyAfterAction: false,
    } as never);

    expect(
      gatewayMocks.callGatewayTool.mock.calls.some(
        ([method]) => method === "plugin.approval.request",
      ),
    ).toBe(false);
    expect(result).toMatchObject({
      details: {
        status: "ok",
        kind: "computer_use/v1",
        stage: "completed",
      },
    });
  });

  it("uses the resolved observation target for actions and the frontmost window for verification", async () => {
    const tool = buildTool({
      ...SESSION_CONFIG,
      scope: { type: "full_desktop" },
    });

    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          observationId: "obs-desktop-before-1",
          appName: "WeChat",
          windowId: "wechat-win",
          windowTitle: "WeChat",
          displayId: "1",
          width: 1280,
          height: 900,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:04:00Z",
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          windowId: "wechat-win",
          appName: "WeChat",
          windowTitle: "WeChat",
          nodeCount: 1,
          nodes: [
            {
              id: "0",
              role: "AXWindow",
              label: "WeChat",
              children: [
                {
                  id: "0.0",
                  role: "AXButton",
                  label: "Chat",
                  rect: { x: 96, y: 48, width: 96, height: 48 },
                  children: [],
                },
              ],
            },
          ],
        },
      })
      .mockImplementationOnce(async (_method: string, _gatewayOpts: unknown, params: unknown) => {
        expect(params).toMatchObject({
          command: "computer.action",
          params: {
            action: "click",
            scopeType: "window",
            windowId: "wechat-win",
            observationId: "obs-desktop-before-1",
            point: { x: 128, y: 64 },
          },
        });
        return {
          payload: {
            action: "click",
            status: "success",
            executedAt: "2026-04-22T00:04:02Z",
            point: { x: 128, y: 64 },
          },
        };
      })
      .mockImplementationOnce(async (_method: string, _gatewayOpts: unknown, params: unknown) => {
        expect(params).toMatchObject({
          command: "computer.capture",
          params: {
            scopeType: "current_window",
          },
        });
        return {
          payload: {
            scopeType: "current_window",
            targetKind: "window",
            observationId: "obs-desktop-after-1",
            appName: "WeChat",
            windowId: "wechat-win",
            windowTitle: "WeChat",
            displayId: "1",
            width: 1280,
            height: 900,
            mimeType: "image/png",
            base64Png: PNG_BASE64,
            capturedAt: "2026-04-22T00:04:03Z",
          },
        };
      })
      .mockResolvedValueOnce({
        payload: {
          supported: true,
          permissionState: "granted",
          windowId: "wechat-win",
          appName: "WeChat",
          windowTitle: "WeChat",
          nodeCount: 1,
          nodes: [
            {
              id: "0",
              role: "AXWindow",
              label: "WeChat",
              children: [],
            },
          ],
        },
      });

    const result = await tool.execute("tool-desktop-window-target", {
      action: "click",
      x: 128,
      y: 64,
    } as never);

    expect(result).toMatchObject({
      details: {
        observation: {
          targetKind: "window",
          observationId: "obs-desktop-after-1",
          appName: "WeChat",
          windowId: "wechat-win",
          windowTitle: "WeChat",
          displayId: "1",
        },
      },
    });
  });

  it("preserves desktop observation targets when the host returns a real full-desktop capture", async () => {
    const tool = buildTool({
      ...SESSION_CONFIG,
      scope: { type: "full_desktop" },
    });

    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "desktop",
          targetKind: "desktop",
          observationId: "obs-desktop-root-1",
          width: 3840,
          height: 2062,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:05:00Z",
        },
      })
      .mockResolvedValueOnce({
        payload: {
          supported: false,
          permissionState: "granted",
          message: "当前 observation target 不是单个窗口，UI/AX 树仅对单个窗口 target 可用",
          nodes: [],
        },
      });

    const result = await tool.execute("tool-desktop-root-target", { action: "observe" } as never);

    expect(result).toMatchObject({
      details: {
        observation: {
          targetKind: "desktop",
          observationId: "obs-desktop-root-1",
        },
        axSnapshot: {
          supported: false,
        },
      },
    });
  });

  it("returns a structured failure when the host reports OBSERVATION_STALE", async () => {
    gatewayMocks.callGatewayTool
      .mockResolvedValueOnce({
        payload: {
          observeAllowed: true,
          controlAllowed: true,
        },
      })
      .mockResolvedValueOnce({
        payload: {
          scopeType: "window",
          targetKind: "window",
          observationId: "obs-stale-before-1",
          appName: "Browser",
          windowId: "win-stale",
          windowTitle: "Browser",
          width: 1280,
          height: 720,
          mimeType: "image/png",
          base64Png: PNG_BASE64,
          capturedAt: "2026-04-22T00:05:00Z",
        },
      })
      .mockResolvedValueOnce(ACTION_AX_PAYLOAD)
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error("gateway request failed"), {
          name: "GatewayClientRequestError",
          gatewayCode: "INVOKE_FAILED",
          details: {
            code: "OBSERVATION_STALE",
            message: "observation 已失效",
          },
        });
      });

    const result = await buildTool().execute("tool-stale-1", {
      action: "click",
      x: 320,
      y: 240,
    } as never);

    expect(result).toMatchObject({
      details: {
        kind: "computer_use/v1",
        status: "error",
        stage: "error",
        summary: "Desktop observation expired before the action could run.",
        warning: "Re-observe the target and retry the desktop action.",
        error: "observation 已失效",
        observation: {
          observationId: "obs-stale-before-1",
          windowId: "win-stale",
        },
        action: {
          type: "click",
          status: "failed",
          point: { x: 320, y: 240 },
        },
      },
    });
  });
});
