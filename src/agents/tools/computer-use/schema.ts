import { Type } from "typebox";
import { COMPUTER_USE_ACTIONS } from "../../../computer-use/types.js";
import { optionalStringEnum, stringEnum } from "../../schema/typebox.js";

const COMPUTER_USE_SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;

export const ComputerUseToolSchema = Type.Object({
  action: stringEnum(COMPUTER_USE_ACTIONS, {
    description:
      "Computer action to run. Use discover_targets to retrieve real running app and window names from the device before switching apps. Prefer focus_window for app switching or bringing an app forward. Reserve hotkey for in-app shortcuts only.",
  }),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  fromX: Type.Optional(Type.Number()),
  fromY: Type.Optional(Type.Number()),
  toX: Type.Optional(Type.Number()),
  toY: Type.Optional(Type.Number()),
  text: Type.Optional(
    Type.String({
      description:
        "Text to enter for action=type or action=set_text_submit. When the user asks to search, ask a question, or fill a field, use action=type with text and the input field elementRef in one call instead of a separate click. Use action=set_text_submit when the intended next step is submitting/opening the highlighted result after text entry.",
    }),
  ),
  hotkey: Type.Optional(
    Type.String({
      description:
        "Keyboard shortcut, for example cmd+l. Use only for in-app shortcuts, not for OS-level app switching.",
    }),
  ),
  direction: Type.Optional(optionalStringEnum(COMPUTER_USE_SCROLL_DIRECTIONS)),
  amount: Type.Optional(Type.Number({ minimum: 0 })),
  waitMs: Type.Optional(Type.Number({ minimum: 0 })),
  targetId: Type.Optional(
    Type.String({
      description:
        "Stable target id from discover_targets, for example window:<id>, display:<id>, desktop:all, or app:<id>. Prefer targetId over guessed app/window names when available.",
    }),
  ),
  appName: Type.Optional(
    Type.String({
      description: "Target app display name, used by focus_window or launch_app.",
    }),
  ),
  bundleId: Type.Optional(
    Type.String({
      description: "Target macOS bundle id, used by focus_window or launch_app.",
    }),
  ),
  windowId: Type.Optional(
    Type.String({
      description: "Target window id, used by focus_window when a specific window is known.",
    }),
  ),
  elementRef: Type.Optional(
    Type.String({
      description:
        "Element candidate ref from the latest observation, for example @e1. Prefer elementRef over raw x/y when clicking, typing into, or scrolling a visible UI element.",
    }),
  ),
  verifyAfterAction: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Optional(Type.Number({ minimum: 0 })),
});
