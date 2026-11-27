import { invalidateConnectionCatalogCache, modelCatalog, refreshConnectionCatalog, refreshModelCatalog } from "@/src/server";
import type { ModelCatalogRefreshResponse } from "@/src/core";

const headers = { "Cache-Control": "no-store" };

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs — id/name/cost/context/modality plus each
 * model's supported thinking levels. Uses TTL/SWR caching for remote
 * subscription catalog refreshes (`?refresh=1` bypasses cache).
 */
export async function GET(req?: Request) {
	const force = req ? new URL(req.url).searchParams.get("refresh") === "1" : false;
	await refreshConnectionCatalog(undefined, { force });
	return Response.json(modelCatalog(), { headers });
}

/** Only this explicit action may contact pi.dev. The API Proxy guards it. */
export async function POST() {
	let outcome;
	try {
		outcome = await refreshModelCatalog();
		invalidateConnectionCatalogCache();
		await refreshConnectionCatalog(undefined, { force: true });
	} catch {
		return Response.json({ error: "Model catalog refresh failed" }, { status: 502, headers });
	}
	return Response.json({ outcome, catalog: modelCatalog() } satisfies ModelCatalogRefreshResponse, { headers });
}
