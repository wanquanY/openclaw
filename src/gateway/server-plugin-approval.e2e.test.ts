import { describe, expect, test } from "vitest";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway plugin approval registration (e2e)", () => {
  test("serves plugin.approval.request through a running gateway websocket", async () => {
    const harness = await createGatewaySuiteHarness();
    const approvalsWs = await harness.openWs();
    const requesterWs = await harness.openWs();

    try {
      await connectOk(approvalsWs, { scopes: ["operator.approvals"] });
      await connectOk(requesterWs, { scopes: ["operator.admin"] });

      const requestEventPromise = onceMessage<{
        type: "event";
        event: "plugin.approval.requested";
        payload?: { id?: string; request?: { title?: string } };
      }>(
        approvalsWs,
        (event) => event.type === "event" && event.event === "plugin.approval.requested",
      );

      const requestResult = await rpcReq<{ id: string; status: string }>(
        requesterWs,
        "plugin.approval.request",
        {
          pluginId: "computer-use",
          title: "Computer Use E2E Approval",
          description: "Verify plugin approval is registered in the running gateway.",
          severity: "warning",
          toolName: "computer_use",
          toolCallId: "tool-call-e2e",
          timeoutMs: 5_000,
          twoPhase: true,
        },
      );

      expect(requestResult.ok, JSON.stringify(requestResult)).toBe(true);
      expect(requestResult.payload).toMatchObject({
        status: "accepted",
        id: expect.stringMatching(/^plugin:/),
      });

      const requestEvent = await requestEventPromise;
      expect(requestEvent.payload).toMatchObject({
        id: requestResult.payload?.id,
        request: {
          title: "Computer Use E2E Approval",
        },
      });

      const resolveResult = await rpcReq(approvalsWs, "plugin.approval.resolve", {
        id: requestResult.payload?.id,
        decision: "allow-once",
      });
      expect(resolveResult.ok, JSON.stringify(resolveResult)).toBe(true);

      const waitResult = await rpcReq<{ decision: string }>(
        requesterWs,
        "plugin.approval.waitDecision",
        { id: requestResult.payload?.id },
      );
      expect(waitResult.ok, JSON.stringify(waitResult)).toBe(true);
      expect(waitResult.payload?.decision).toBe("allow-once");
    } finally {
      requesterWs.close();
      approvalsWs.close();
      await harness.close();
    }
  });
});
