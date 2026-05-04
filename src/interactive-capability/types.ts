export const INTERACTIVE_CAPABILITY_ACTIVATIONS = ["auto", "required"] as const;

export type InteractiveCapabilityActivation = (typeof INTERACTIVE_CAPABILITY_ACTIVATIONS)[number];

export const INTERACTIVE_CAPABILITY_SOURCES = [
  "mention",
  "composer_default",
  "session_policy",
  "runtime_auto",
] as const;

export type InteractiveCapabilitySource = (typeof INTERACTIVE_CAPABILITY_SOURCES)[number];
