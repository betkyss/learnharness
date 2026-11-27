/**
 * Lightweight health/auth check endpoint used by ServerEventsProvider's 401
 * auth probe (replacing heavy GET /api/chats). Protected by nginx auth_request
 * and proxy.ts like every other /api/* route.
 */
export function GET(): Response {
	return Response.json(
		{ ok: true },
		{
			headers: {
				"Cache-Control": "no-store",
			},
		},
	);
}

export function HEAD(): Response {
	return new Response(null, {
		status: 200,
		headers: {
			"Cache-Control": "no-store",
		},
	});
}
