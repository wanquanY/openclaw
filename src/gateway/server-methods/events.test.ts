import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { eventsHandlers } from "./events.js";

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createInvokeParams(params: Record<string, unknown>, connId = "conn-1") {
  const respond = vi.fn();
  const eventsSubscribe = vi.fn();
  const eventsUnsubscribe = vi.fn();
  return {
    respond,
    eventsSubscribe,
    eventsUnsubscribe,
    invokeSubscribe: async () =>
      await eventsHandlers["events.subscribe"]({
        params,
        respond: respond as never,
        context: {
          eventsSubscribe,
        } as never,
        client: { connect: {} as never, connId },
        req: { type: "req", id: "req-1", method: "events.subscribe" },
        isWebchatConnect: () => false,
      }),
    invokeUnsubscribe: async () =>
      await eventsHandlers["events.unsubscribe"]({
        params,
        respond: respond as never,
        context: {
          eventsUnsubscribe,
        } as never,
        client: { connect: {} as never, connId },
        req: { type: "req", id: "req-1", method: "events.unsubscribe" },
        isWebchatConnect: () => false,
      }),
  };
}

function expectInvalidRequestResponse(
  respond: ReturnType<typeof vi.fn>,
  expectedMessagePart: string,
) {
  const call = respond.mock.calls[0] as RespondCall | undefined;
  expect(call?.[0]).toBe(false);
  expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
  expect(call?.[2]?.message).toContain(expectedMessagePart);
}

describe("events handlers", () => {
  it("rejects invalid subscribe params", async () => {
    const { respond, invokeSubscribe } = createInvokeParams({ streams: ["tool"] });
    await invokeSubscribe();
    expectInvalidRequestResponse(respond, "invalid events.subscribe params");
  });

  it("requires active connection for subscribe", async () => {
    const { respond, invokeSubscribe } = createInvokeParams({ sessionKey: "s-1" }, "");
    await invokeSubscribe();
    expectInvalidRequestResponse(respond, "requires an active connection");
  });

  it("subscribes with normalized streams", async () => {
    const { respond, eventsSubscribe, invokeSubscribe } = createInvokeParams({
      sessionKey: "s-1",
      streams: ["tool", " tool ", "tool"],
    });
    await invokeSubscribe();
    expect(eventsSubscribe).toHaveBeenCalledTimes(1);
    expect(eventsSubscribe).toHaveBeenCalledWith("conn-1", "s-1", ["tool"]);
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
  });

  it("unsubscribes with wildcard when streams omitted", async () => {
    const { respond, eventsUnsubscribe, invokeUnsubscribe } = createInvokeParams({
      sessionKey: "s-1",
    });
    await invokeUnsubscribe();
    expect(eventsUnsubscribe).toHaveBeenCalledTimes(1);
    expect(eventsUnsubscribe).toHaveBeenCalledWith("conn-1", "s-1", ["*"]);
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
  });
});
