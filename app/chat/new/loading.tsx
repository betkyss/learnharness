"use client";

import { SidebarToggle } from "@/components/sidebar";

/** Instant route-transition shell for /chat/new (eliminates stale-screen stickiness on tap). */
export default function NewChatLoading() {
	return (
		<div className="relative flex h-[var(--vvh,var(--lh-app-height,100dvh))] flex-col bg-background">
			<header className="lh-drag lh-floating-header pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-3 px-4 py-2">
				<span className="pointer-events-auto">
					<SidebarToggle />
				</span>
			</header>
			<div className="flex flex-1 flex-col items-center justify-center px-6">
				<div className="w-full max-w-[46rem] space-y-6">
					<div className="mx-auto h-7 w-56 animate-pulse rounded-lg bg-muted/60" />
					<div className="h-24 w-full animate-pulse rounded-2xl border border-border/50 bg-card/60" />
				</div>
			</div>
		</div>
	);
}
