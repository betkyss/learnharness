"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { BrailleSpinner } from "./braille-spinner";
import { Shimmer } from "./ai-elements/shimmer";
import { ReasoningText } from "./ai-elements/reasoning";
import { ToolCallCard } from "./artifacts/tool-call-card";
import { blurAfterPointerClick } from "./focus-hygiene";
import type { WorkEntry } from "./work-groups";
import type { ArtifactPartProps } from "@/src/core";

export function WorkGroup({ entry }: { entry: Extract<WorkEntry, { type: "work" }> }) {
	const [open, setOpen] = useState(false);
	return (
		<Collapsible open={open} onOpenChange={setOpen} className="not-prose min-w-0 w-full" data-testid="work-group">
			<CollapsibleTrigger
				className="flex min-h-9 w-full cursor-pointer items-center gap-2 text-left font-ui text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-sm:min-h-11"
				onClick={blurAfterPointerClick}
			>
				{entry.activity ? <><BrailleSpinner label={entry.activity} /><Shimmer duration={1}>{entry.activity}</Shimmer></> : "Activity"}
				<ChevronRight aria-hidden="true" className={`size-3.5 shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`} />
			</CollapsibleTrigger>
			<CollapsibleContent className="min-w-0 border-l border-border pl-4 pb-1 mt-1 mb-3 space-y-4" data-testid="work-details">
				{entry.parts.map(({ part, key }) => part.type === "reasoning"
					? (part.text ? <ReasoningText key={key} className="text-sm text-muted-foreground">{part.text}</ReasoningText> : null)
					: <ToolCallCard key={key} part={part as ArtifactPartProps["part"]} />)}
			</CollapsibleContent>
		</Collapsible>
	);
}
