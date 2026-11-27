"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { useParams } from "next/navigation";
import { SidebarToggle } from "@/components/sidebar";
import { TopBar } from "@/components/top-bar";
import { BrailleSpinner } from "@/components/braille-spinner";
import { getCachedChatTail, getSwrData, SWR_KEYS } from "@/components/client-swr";
import { projectView, type ChatListItem } from "@/src/core";

/**
 * Instant route-transition shell for /chat/[id] (UX-3):
 * Renders immediately on sidebar tap so the previous screen never sticks
 * while the dynamic RSC payload streams. When the target chat tail is warm
 * in the client SWR cache, paints its title and recent messages pinned at
 * the bottom immediately; otherwise renders a clean session shell.
 */
export default function ChatLoading() {
	const params = useParams<{ id?: string }>();
	const chatId = typeof params?.id === "string" ? params.id : "";
	const scrollerRef = useRef<HTMLDivElement>(null);

	const cached = useMemo(() => (chatId ? getCachedChatTail(chatId) : undefined), [chatId]);
	const listMatch = useMemo(() => {
		if (!chatId) return undefined;
		return getSwrData<ChatListItem[]>(SWR_KEYS.chats)?.find((c) => c.id === chatId);
	}, [chatId]);

	const title = cached?.title || listMatch?.title || "Loading session…";
	const previewMessages = useMemo(() => {
		if (!cached?.messages?.length) return [];
		return projectView(cached.messages).slice(-6);
	}, [cached]);

	useLayoutEffect(() => {
		const el = scrollerRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [previewMessages.length, chatId]);

	return (
		<div data-session-surface="" data-testid="chat-route-loading" className="relative flex h-[var(--vvh,var(--lh-app-height,100dvh))] flex-col bg-background">
			<TopBar>
				<SidebarToggle />
				<span className="min-w-0 flex-1 truncate font-ui text-sm font-medium text-foreground">
					{title}
				</span>
			</TopBar>

			<div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
				<div className="lh-transcript-column mx-auto flex w-full max-w-[46rem] flex-col gap-4 px-6 pb-28 pt-4">
					{previewMessages.length > 0 ? (
						previewMessages.map((m) => {
							const text = m.parts
								.filter((p) => p.type === "text" && typeof p.text === "string")
								.map((p) => p.text)
								.join("\n\n")
								.trim();
							if (!text) return null;
							return m.role === "user" ? (
								<div key={m.id} className="ml-auto max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5 text-sm text-foreground">
									<p className="whitespace-pre-wrap break-words">{text}</p>
								</div>
							) : (
								<div key={m.id} className="lh-prose max-w-none text-foreground/90">
									<p className="whitespace-pre-wrap break-words">{text}</p>
								</div>
							);
						})
					) : (
						<div className="flex min-h-[45vh] items-center justify-center">
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<BrailleSpinner label="Loading session" />
								<span>Loading session…</span>
							</div>
						</div>
					)}
				</div>
			</div>

			<div className="lh-dock-block pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pb-4">
				<div className="mx-auto h-12 w-full max-w-[46rem] rounded-2xl border border-border/60 bg-card/85 shadow-sm" />
			</div>
		</div>
	);
}
