import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  makeAgentToolResultMessage,
  makeAgentUserMessage,
} from "../test-helpers/agent-message-fixtures.js";
import {
  appendComputerUseObservationContinuation,
  installComputerUseObservationContext,
} from "./computer-use-observation-context.js";

function makeComputerUseToolResult(overrides?: {
  images?: Array<{ data: string; mimeType?: string }>;
  details?: Record<string, unknown>;
}) {
  const images = overrides?.images ?? [{ data: "before-image", mimeType: "image/png" }];
  return makeAgentToolResultMessage({
    toolCallId: "tool-cu-1",
    toolName: "computer_use",
    content: [
      { type: "text", text: "Completed screen observation" },
      ...images.map((image, index) => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mimeType ?? "image/png",
        fileName: `capture-${index + 1}.png`,
      })),
    ],
    details: {
      kind: "computer_use/v1",
      stage: "completed",
      observation: {
        targetKind: "window",
        appName: "WeChat",
        windowId: "wechat-win",
        windowTitle: "WeChat",
        displayId: "1",
      },
      axSnapshot: {
        supported: true,
        appName: "WeChat",
        windowTitle: "WeChat",
        nodeCount: 3,
        selectedText: "hello",
        nodes: [],
      },
      candidates: [
        {
          id: "candidate-send",
          label: "发送",
          role: "AXButton",
          confidence: 0.96,
        },
      ],
      ...overrides?.details,
    },
  });
}

describe("appendComputerUseObservationContinuation", () => {
  it("moves the latest computer_use image into a synthetic user continuation message", () => {
    const messages: AgentMessage[] = [makeComputerUseToolResult()];

    const transformed = appendComputerUseObservationContinuation(messages);

    expect(transformed).not.toBe(messages);
    expect(transformed).toHaveLength(2);
    expect(transformed[0]).toMatchObject({
      role: "toolResult",
      toolName: "computer_use",
      content: [{ type: "text", text: "Completed screen observation" }],
    });
    expect(transformed[1]).toMatchObject({
      role: "user",
      content: [
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining(
            "Computer Use observation for the next action. Treat the attached image as the latest desktop state.",
          ),
        }),
        expect.objectContaining({
          type: "image",
          data: "before-image",
          mimeType: "image/png",
        }),
      ],
    });
    const continuationText = (transformed[1] as Extract<AgentMessage, { role: "user" }>)
      .content?.[0];
    expect(continuationText).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        "Observation target: target=window | app=WeChat | window=WeChat | display=1",
      ),
    });
    expect(continuationText).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        "AX snapshot: supported=yes | app=WeChat | window=WeChat | nodes=3",
      ),
    });
  });

  it("prefers the latest verification image when the tool result carries multiple screenshots", () => {
    const messages: AgentMessage[] = [
      makeComputerUseToolResult({
        images: [
          { data: "before-image", mimeType: "image/png" },
          { data: "after-image", mimeType: "image/png" },
        ],
      }),
    ];

    const transformed = appendComputerUseObservationContinuation(messages);

    expect(transformed[1]).toMatchObject({
      role: "user",
      content: [
        expect.any(Object),
        expect.objectContaining({
          type: "image",
          data: "after-image",
        }),
      ],
    });
  });

  it("does not inject when the latest trailing tool result is not computer_use", () => {
    const messages: AgentMessage[] = [
      makeComputerUseToolResult(),
      makeAgentToolResultMessage({
        toolCallId: "tool-read-1",
        toolName: "read",
        content: [{ type: "text", text: "plain text result" }],
      }),
    ];

    const transformed = appendComputerUseObservationContinuation(messages);

    expect(transformed).toBe(messages);
  });
});

describe("installComputerUseObservationContext", () => {
  it("wraps an existing transformContext and restores it on dispose", async () => {
    const upstream = async (messages: AgentMessage[]) => [...messages, makeComputerUseToolResult()];
    const agent: { transformContext?: (messages: AgentMessage[], signal: AbortSignal) => unknown } =
      {
        transformContext: upstream,
      };

    const dispose = installComputerUseObservationContext({ agent });
    const transformed = (await agent.transformContext?.(
      [makeAgentUserMessage({ content: "hi" }) as unknown as AgentMessage],
      new AbortController().signal,
    )) as AgentMessage[];

    expect(transformed).toHaveLength(3);
    expect(transformed[2]).toMatchObject({
      role: "user",
      content: [
        expect.any(Object),
        expect.objectContaining({ type: "image", data: "before-image" }),
      ],
    });

    dispose();
    expect(agent.transformContext).toBe(upstream);
  });
});
