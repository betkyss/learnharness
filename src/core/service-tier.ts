/** Requested speed is independent of reasoning and of server admission. */
export const SERVICE_TIERS = ["default", "fast", "ultrafast"] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];
export function isServiceTier(value: unknown): value is ServiceTier {
	return SERVICE_TIERS.some((tier) => tier === value);
}
// Exact model IDs only; request compatibility does not establish account access.
// https://learn.chatgpt.com/docs/agent-configuration/speed (2026-11-03).
const FAST_MODELS = new Set(["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna"]);
export function supportedServiceTiers(provider: string, id: string): readonly ServiceTier[] {
	if (provider !== "chatgpt") return [];
	if (id === "gpt-6.1-sol" || id === "gpt-6-astra") return SERVICE_TIERS;
	return FAST_MODELS.has(id) ? ["default", "fast"] : ["default"];
}
export function serviceTierError(model: { provider: string; id: string } | undefined, tier: unknown): string | undefined {
	if (tier === undefined) return undefined;
	if (!isServiceTier(tier)) return "serviceTier must be default, fast, or ultrafast";
	if (!model || !supportedServiceTiers(model.provider, model.id).includes(tier)) return `Speed ${tier} is not supported for ${model ? `${model.provider}:${model.id}` : "an unset model"}`;
	return undefined;
}
type Selection = { model?: { provider: string; id: string }; serviceTier?: ServiceTier };
/** Missing means inherit only within the same identity, never across models. */
export function inheritedServiceTier(override: Selection | undefined, slot: Selection | undefined): ServiceTier | undefined {
	if (override?.serviceTier !== undefined) return override.serviceTier;
	if (override?.model && (override.model.provider !== slot?.model?.provider || override.model.id !== slot?.model?.id)) return undefined;
	return slot?.serviceTier;
}
export function tierField(serviceTier: ServiceTier | undefined): { serviceTier?: ServiceTier } {
	return serviceTier === undefined ? {} : { serviceTier };
}
export interface ServiceTierReport {
	requestedServiceTier?: ServiceTier;
	/** Raw successful response value; null means the server did not report it. */
	receivedServiceTier: string | null;
}
/** Pi usage objects travel through every foreground and background collector. */
export function serviceTierUsage(usage: object): { serviceTier?: ServiceTierReport } {
	const report = (usage as { serviceTier?: ServiceTierReport }).serviceTier;
	return report ? { serviceTier: report } : {};
}
export function serviceTierLabel(tier: string): string {
	return ({ default: "Default", fast: "Fast", priority: "Fast", ultrafast: "Ultrafast" } as Record<string, string>)[tier] ?? tier;
}
export function serviceTierSummary(report: ServiceTierReport): string {
	return `Requested: ${report.requestedServiceTier === undefined ? "Not sent" : serviceTierLabel(report.requestedServiceTier)} · Received: ${report.receivedServiceTier === null ? "Not reported" : serviceTierLabel(report.receivedServiceTier)}`;
}
