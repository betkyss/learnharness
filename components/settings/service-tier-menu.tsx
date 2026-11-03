"use client";
import { serviceTierLabel, supportedServiceTiers, type ServiceTier } from "@/src/core";

export function ServiceTierMenu({ provider, id, value, inherited, onPick }: {
	provider: string; id: string; value?: ServiceTier; inherited?: ServiceTier;
	onPick: (value: ServiceTier | undefined) => void;
}) {
	return <>
		{[undefined, ...supportedServiceTiers(provider, id)].map((tier) => <button
			key={tier ?? "inherit"} type="button" data-testid={`speed-option-${tier ?? "inherit"}`}
			onClick={() => onPick(tier)}
			className="flex items-center justify-between rounded-lg px-2 py-1.5 text-left hover:bg-muted"
		>
			<span>{tier === undefined ? `Inherit${inherited ? `: ${serviceTierLabel(inherited)}` : " / not sent"}` : serviceTierLabel(tier)}</span>
			{tier === value && <span aria-hidden>✓</span>}
		</button>)}
		<p className="mt-1 border-t px-2 pt-1.5 text-xs text-muted-foreground">Requested speed. Actual tier is reported after each response.</p>
	</>;
}
