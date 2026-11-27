import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import {
	CLAUDE_CODE_PROVIDER,
	CLIENT_DEFAULT_TAIL_GROUPS,
	sanitizeMessagesForClient,
	sessionCacheHitRate,
	sliceChatTailForClient,
	slotsConfigured,
} from "@/src/core";
import { compactionInFlight, getChat, isTurnRunning, readSettingsRecord, sessionCost, turnFailure } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function ChatPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ prompt?: string }>;
}) {
	const [{ id }, { prompt }] = await Promise.all([params, searchParams]);
	const chat = getChat(id);
	if (!chat) notFound();
	// The persistent setup CTA's seed (BYOK, owner 2026-09-22): slotsConfigured
	// over the settings record, server-read — the same gate home/new read. The
	// server's 503 stays the truth; this only decides whether the pill rides.
	const record = readSettingsRecord();
	const tail = sliceChatTailForClient(chat.messages, CLIENT_DEFAULT_TAIL_GROUPS);
	const rawTurns = chat.turns ?? [];
	const initialPricing = {
		...sessionCost(chat),
		turnCosts: {},
		turnCount: rawTurns.length,
		cliBilled: rawTurns.some((t) => t.model.startsWith(`${CLAUDE_CODE_PROVIDER}:`)),
		cacheHitRate: sessionCacheHitRate({ turns: rawTurns }),
	};
	return (
		<Chat
			key={chat.id}
			chatId={chat.id}
			title={chat.title}
			kind={chat.kind ?? "teach"}
			// Wave D: the record IS native agent history — ship only the active
			// tail window on SSR so long sessions hydrate fast on mobile; earlier
			// messages load on demand via ?tail=N or full GET. Compact oversized
			// historical tool details ONLY when the session is actually tail-sliced
			// so short/desktop sessions always retain full tool output.
			initialMessages={sanitizeMessagesForClient(tail.messages, { compactHistoricalToolDetails: tail.truncated })}
			initialTotalMessages={tail.totalMessages}
			initialOmittedViewGroups={tail.omittedViewGroups}
			initialTruncated={tail.truncated}
			initialPhase={tail.startPhase}
			initialPlanTree={chat.tree ?? null}
			initialPricing={initialPricing}
			initialError={turnFailure(chat.id)}
			initialConfigured={slotsConfigured(record?.models)}
			initialPrompt={prompt}
			// A teacher turn that outlived its client: the remounted view must
			// attach (busy shimmer + poll), never resurrect the stale record.
			initiallyInFlight={isTurnRunning(chat.id)}
			initiallyCompacting={compactionInFlight(chat.id)}
		/>
	);
}
