import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserUseSessionConfig } from "../../browser-use/types.js";
import { createBrowserUseTool } from "./browser-use-tool.js";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => gatewayMocks.callGatewayTool(...args),
}));

const SESSION_CONFIG: BrowserUseSessionConfig = {
  enabled: true,
  mode: "plan_and_act",
  hostPolicy: "local_only",
  activation: "required",
  source: "mention",
};

describe("browser_use tool", () => {
  beforeEach(() => {
    gatewayMocks.callGatewayTool.mockReset();
  });

  it("returns page text and element candidates for observe results", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({
      payload: {
        kind: "browser_use/v1",
        browserSessionId: "browser:cdp:default",
        tabId: "tab:1",
        title: "Example",
        url: "https://example.com/",
        pageText: "Example Domain This domain is for use in illustrative examples.",
        elements: [
          {
            ref: "cdp:0:main > a:nth-of-type(1)",
            role: "link",
            name: "More information",
            tagName: "a",
          },
        ],
      },
    });

    const tool = createBrowserUseTool({
      sessionConfig: SESSION_CONFIG,
      sessionKey: "agent:main:test",
    });
    const result = await tool.execute("call-1", { action: "observe" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("browser_use observe complete");
    expect(text).toContain("Title: Example");
    expect(text).toContain("Readable text:");
    expect(text).toContain("Example Domain");
    expect(text).toContain("Visible elements:");
    expect(text).toContain("More information");
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "client.invoke",
      {},
      expect.objectContaining({
        sessionKey: "agent:main:test",
        capability: "browser_use",
        command: "browser.observe",
        params: expect.objectContaining({
          ownerSessionKey: "agent:main:test",
        }),
      }),
    );
  });

  it("returns the post-action page observation to the model", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({
      payload: {
        kind: "browser_use_action/v1",
        actionId: "browser-action-1",
        browserSessionId: "browser:cdp:default",
        tabId: "tab:1",
        status: "success",
        action: "click",
        postActionObservation: {
          kind: "browser_use/v1",
          browserSessionId: "browser:cdp:default",
          tabId: "tab:1",
          title: "Search Results",
          url: "https://search.example/?q=AI",
          pageText: "Top result about AI. Second result about automation.",
          elements: [],
        },
      },
    });

    const tool = createBrowserUseTool({
      sessionConfig: SESSION_CONFIG,
      sessionKey: "agent:main:test",
    });
    const result = await tool.execute("call-2", {
      action: "click",
      ref: "cdp:0:button:nth-of-type(1)",
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("browser_use click complete");
    expect(text).toContain("Title: Search Results");
    expect(text).toContain("Top result about AI");
  });

  it("returns the post-navigation page observation to the model", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({
      payload: {
        kind: "browser_use_navigation/v1",
        browserSessionId: "browser:cdp:default",
        status: "success",
        url: "https://example.com/",
        postNavigationObservation: {
          kind: "browser_use/v1",
          browserSessionId: "browser:cdp:default",
          tabId: "tab:1",
          title: "Example",
          url: "https://example.com/",
          pageText: "Loaded landing page content.",
          elements: [],
        },
      },
    });

    const tool = createBrowserUseTool({
      sessionConfig: SESSION_CONFIG,
      sessionKey: "agent:main:test",
    });
    const result = await tool.execute("call-3", {
      action: "navigate",
      url: "https://example.com/",
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("browser_use navigate complete");
    expect(text).toContain("Loaded landing page content");
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "client.invoke",
      {},
      expect.objectContaining({
        sessionKey: "agent:main:test",
        command: "browser.navigate",
        params: expect.objectContaining({
          ownerSessionKey: "agent:main:test",
          url: "https://example.com/",
        }),
      }),
    );
  });

  it("preserves an explicit browser session id instead of adding ownerSessionKey", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({
      kind: "browser_use/v1",
      browserSessionId: "browser:custom",
      tabId: "tab:1",
      elements: [],
    });

    const tool = createBrowserUseTool({
      sessionConfig: SESSION_CONFIG,
      sessionKey: "agent:main:test",
    });
    await tool.execute("call-explicit", {
      action: "observe",
      browserSessionId: "browser:custom",
    });

    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "client.invoke",
      {},
      expect.objectContaining({
        command: "browser.observe",
        params: expect.objectContaining({
          browserSessionId: "browser:custom",
        }),
      }),
    );
    expect(gatewayMocks.callGatewayTool.mock.calls[0]?.[2]?.params).not.toHaveProperty(
      "ownerSessionKey",
    );
  });

  it("surfaces browser action business failures instead of reporting complete", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({
      payload: {
        kind: "browser_use_action/v1",
        actionId: "browser-action-2",
        browserSessionId: "browser:cdp:default",
        tabId: "tab:1",
        status: "failed",
        action: "click",
        groundedTarget: {
          selector: "#__definitely_not_exists__",
          grounding: "locator",
        },
        error: {
          code: "LOCATOR_NOT_FOUND",
          message: "element_not_found",
          recoveryHint: "Run browser.observe again and retry with a fresh ref or selector",
        },
        executedAt: "2026-05-03T00:00:00.000Z",
      },
    });

    const tool = createBrowserUseTool({
      sessionConfig: SESSION_CONFIG,
      sessionKey: "agent:main:test",
    });
    const result = await tool.execute("call-4", {
      action: "click",
      selector: "#__definitely_not_exists__",
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("browser_use click failed: element_not_found");
    expect(result.details).toMatchObject({
      kind: "browser_use/v1",
      action: "click",
      status: "error",
      error: "element_not_found",
      result: expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({
          code: "LOCATOR_NOT_FOUND",
        }),
      }),
    });
  });

  it("surfaces browser navigation business failures", async () => {
    gatewayMocks.callGatewayTool.mockResolvedValue({
      payload: {
        kind: "browser_use_navigation/v1",
        browserSessionId: "browser:cdp:default",
        status: "failed",
        url: "not-a-valid-url",
        error: {
          code: "ENGINE_ACTION_FAILED",
          message: "INVALID_BROWSER_URL",
        },
        executedAt: "2026-05-03T00:00:00.000Z",
      },
    });

    const tool = createBrowserUseTool({
      sessionConfig: SESSION_CONFIG,
      sessionKey: "agent:main:test",
    });
    const result = await tool.execute("call-5", {
      action: "navigate",
      url: "not-a-valid-url",
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("browser_use navigate failed: INVALID_BROWSER_URL");
    expect(result.details).toMatchObject({
      action: "navigate",
      status: "error",
      error: "INVALID_BROWSER_URL",
    });
  });
});
