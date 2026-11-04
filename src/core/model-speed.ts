/** Subscription processing speed, independent of reasoning effort. */
export const MODEL_SPEEDS = ["standard", "fast", "ultrafast"] as const;
export type ModelSpeed = (typeof MODEL_SPEEDS)[number];
export function isModelSpeed(value: unknown): value is ModelSpeed {
 return typeof value === "string" && MODEL_SPEEDS.includes(value as ModelSpeed);
}
export function supportedModelSpeeds(provider: string, id: string): readonly ModelSpeed[] {
 if (provider !== "chatgpt") return [];
 return id === "gpt-6.1-sol" || id === "gpt-6-astra" ? MODEL_SPEEDS : ["standard", "fast"];
}
export function resolveModelSpeed(provider: string, id: string, preference?: ModelSpeed): ModelSpeed | undefined {
 const supported = supportedModelSpeeds(provider, id);
 if (!supported.length) return undefined;
 return preference && supported.includes(preference) ? preference : "standard";
}
export function modelSpeedTier(speed: ModelSpeed): "default" | "priority" | "ultrafast" {
 return speed === "standard" ? "default" : speed === "fast" ? "priority" : "ultrafast";
}
