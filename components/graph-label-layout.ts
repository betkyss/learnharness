export interface LabelBox { id: string; left: number; top: number; right: number; bottom: number; priority?: number }
/** Screen-space selection. Stable order, readable anchors at Fit, priority for interaction. */
export function nonOverlappingLabels(boxes: LabelBox[], bounds: Omit<LabelBox, "id">): Set<string> {
	const placed: LabelBox[] = [];
	for (const box of [...boxes].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))) {
		if (box.left < bounds.left || box.right > bounds.right || box.top < bounds.top || box.bottom > bounds.bottom) continue;
		if (placed.some((p) => box.left < p.right + 8 && box.right + 8 > p.left && box.top < p.bottom + 6 && box.bottom + 6 > p.top)) continue;
		placed.push(box);
	}
	return new Set(placed.map((box) => box.id));
}
