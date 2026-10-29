export interface DiffLine {
	kind: "same" | "removed" | "added";
	text: string;
}

/** Beyond this many line pairs, the diff shows every old line removed and every new line added. */
const MAX_PAIRS = 250_000;

/** The lines two texts share, and the ones removed and added between them. */
export function lineDiff(before: string, after: string): DiffLine[] {
	const a = before === "" ? [] : before.split("\n");
	const b = after === "" ? [] : after.split("\n");
	if (a.length * b.length > MAX_PAIRS) {
		return [
			...a.map((text): DiffLine => ({ kind: "removed", text })),
			...b.map((text): DiffLine => ({ kind: "added", text })),
		];
	}
	// shared(i, j): the longest run of lines a[i..] and b[j..] have in common.
	const width = b.length + 1;
	const table = new Uint32Array((a.length + 1) * width);
	const shared = (i: number, j: number) => table[i * width + j] ?? 0;
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * width + j] =
				a[i] === b[j] ? shared(i + 1, j + 1) + 1 : Math.max(shared(i + 1, j), shared(i, j + 1));
		}
	}
	const lines: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		const old = a[i];
		const next = b[j];
		if (old !== undefined && old === next) {
			lines.push({ kind: "same", text: old });
			i++;
			j++;
		} else if (old !== undefined && (next === undefined || shared(i + 1, j) >= shared(i, j + 1))) {
			lines.push({ kind: "removed", text: old });
			i++;
		} else {
			lines.push({ kind: "added", text: next ?? "" });
			j++;
		}
	}
	return lines;
}
