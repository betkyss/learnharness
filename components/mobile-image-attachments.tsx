"use client";

import { XIcon } from "lucide-react";
import type { ImageContent } from "@earendil-works/pi-ai";

export const SUPPORTED_UPLOAD_IMAGE_MIMES = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
]);

export const MAX_MOBILE_ATTACH_IMAGES = 4;
const DIRECT_READ_MAX_BYTES = 4 * 1024 * 1024;
const MAX_CANVAS_EDGE = 2048;
const OPENING_IMAGES_PREFIX = "lh.openingImages.";

export interface PendingImage {
	id: string;
	name: string;
	image: ImageContent;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/** Detect native image MIME from magic bytes so declared browser types never mislead the server. */
export function sniffImageMime(bytes: Uint8Array): string | null {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
		bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
	) return "image/png";
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
		bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
	) return "image/webp";
	if (
		bytes.length >= 6 &&
		bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
		(bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
	) return "image/gif";
	return null;
}

async function transcodeToJpeg(file: File): Promise<ImageContent> {
	if (typeof document === "undefined") {
		throw new Error("Image conversion requires a browser canvas.");
	}
	let source: CanvasImageSource;
	let width: number;
	let height: number;
	let cleanup: (() => void) | undefined;

	if (typeof createImageBitmap === "function") {
		try {
			const bitmap = await createImageBitmap(file);
			source = bitmap;
			width = bitmap.width;
			height = bitmap.height;
			cleanup = () => bitmap.close();
		} catch {
			// Fallback to HTMLImageElement (handles iOS Safari HEIC decoding in some WebKit versions).
			const url = URL.createObjectURL(file);
			const img = await new Promise<HTMLImageElement>((resolve, reject) => {
				const el = new Image();
				el.onload = () => resolve(el);
				el.onerror = () => reject(new Error("Could not decode image."));
				el.src = url;
			});
			source = img;
			width = img.naturalWidth;
			height = img.naturalHeight;
			cleanup = () => URL.revokeObjectURL(url);
		}
	} else {
		const url = URL.createObjectURL(file);
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const el = new Image();
			el.onload = () => resolve(el);
			el.onerror = () => reject(new Error("Could not decode image."));
			el.src = url;
		});
		source = img;
		width = img.naturalWidth;
		height = img.naturalHeight;
		cleanup = () => URL.revokeObjectURL(url);
	}

	try {
		if (width <= 0 || height <= 0) throw new Error("Empty image dimensions.");
		const scale = Math.min(1, MAX_CANVAS_EDGE / Math.max(width, height));
		const outW = Math.max(1, Math.round(width * scale));
		const outH = Math.max(1, Math.round(height * scale));
		const canvas = document.createElement("canvas");
		canvas.width = outW;
		canvas.height = outH;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Canvas 2D context unavailable.");
		ctx.drawImage(source, 0, 0, outW, outH);
		const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
		const prefix = "data:image/jpeg;base64,";
		if (!dataUrl.startsWith(prefix)) throw new Error("Failed to encode JPEG.");
		return { type: "image", mimeType: "image/jpeg", data: dataUrl.slice(prefix.length) };
	} finally {
		cleanup?.();
	}
}

/** Normalize a picked browser File into server-accepted ImageContent (JPEG/PNG/WebP/GIF). */
export async function normalizeImageFile(file: File): Promise<ImageContent> {
	const looksImage = file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic|heif|bmp|tiff?)$/i.test(file.name);
	if (!looksImage) {
		throw new Error(`Unsupported file "${file.name}". Choose an image (JPG, PNG, WebP, GIF, or HEIC).`);
	}
	const bytes = new Uint8Array(await file.arrayBuffer());
	const sniffed = sniffImageMime(bytes);
	if (sniffed && SUPPORTED_UPLOAD_IMAGE_MIMES.has(sniffed) && bytes.length > 0 && bytes.length <= DIRECT_READ_MAX_BYTES) {
		return { type: "image", mimeType: sniffed, data: bytesToBase64(bytes) };
	}
	return transcodeToJpeg(file);
}

/** Batch-convert newly selected files up to remaining capacity. */
export async function preparePendingImages(
	files: Iterable<File>,
	existingCount: number,
	maxCount = MAX_MOBILE_ATTACH_IMAGES,
): Promise<{ added: PendingImage[]; error: string | null }> {
	const room = Math.max(0, maxCount - existingCount);
	const list = Array.from(files);
	if (list.length === 0) return { added: [], error: null };
	if (room === 0) return { added: [], error: `Up to ${maxCount} images per message.` };
	const selected = list.slice(0, room);
	const overflow = list.length > room;
	const added: PendingImage[] = [];
	const errors: string[] = [];

	for (const file of selected) {
		try {
			const image = await normalizeImageFile(file);
			added.push({
				id: `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
				name: file.name || "image",
				image,
			});
		} catch (err) {
			errors.push(err instanceof Error ? err.message : `Could not attach ${file.name || "image"}.`);
		}
	}

	const error = errors[0] ?? (overflow ? `Attached first ${room} of ${list.length} images (max ${maxCount}).` : null);
	return { added, error };
}

export function stashOpeningImages(chatId: string, images: readonly ImageContent[]): boolean {
	if (images.length === 0) return true;
	try {
		const storage = globalThis.sessionStorage;
		const value = JSON.stringify(images);
		storage.setItem(`${OPENING_IMAGES_PREFIX}${chatId}`, value);
		return storage.getItem(`${OPENING_IMAGES_PREFIX}${chatId}`) === value;
	} catch {
		return false;
	}
}

export function readOpeningImages(chatId: string): ImageContent[] {
	try {
		const raw = globalThis.sessionStorage.getItem(`${OPENING_IMAGES_PREFIX}${chatId}`);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(item): item is ImageContent =>
				Boolean(item) &&
				typeof item === "object" &&
				(item as ImageContent).type === "image" &&
				typeof (item as ImageContent).data === "string" &&
				typeof (item as ImageContent).mimeType === "string",
		);
	} catch {
		return [];
	}
}

export function clearOpeningImages(chatId: string): void {
	try {
		globalThis.sessionStorage.removeItem(`${OPENING_IMAGES_PREFIX}${chatId}`);
	} catch {
		/* storage unavailable */
	}
}

/** Compact preview row of attached images shown inside/above the composer pill before sending. */
export function PendingImageStrip({
	images,
	onRemove,
}: {
	images: readonly PendingImage[];
	onRemove: (id: string) => void;
}) {
	if (images.length === 0) return null;
	return (
		<div
			data-testid="pending-image-strip"
			className="flex items-center gap-2 overflow-x-auto px-2.5 pt-2 pb-1"
		>
			{images.map((item) => (
				<div
					key={item.id}
					className="relative size-12 shrink-0 overflow-hidden rounded-xl border border-border bg-secondary"
				>
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img
						src={`data:${item.image.mimeType};base64,${item.image.data}`}
						alt={item.name}
						className="size-full object-cover"
					/>
					<button
						type="button"
						aria-label={`Remove ${item.name}`}
						data-testid={`remove-pending-image-${item.id}`}
						onClick={() => onRemove(item.id)}
						className="absolute right-0.5 top-0.5 flex size-5 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm transition-colors hover:bg-destructive hover:text-destructive-foreground"
					>
						<XIcon className="size-3" />
					</button>
				</div>
			))}
		</div>
	);
}
