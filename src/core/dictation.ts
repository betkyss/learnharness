/** Nova-3 monolingual language codes, including documented locale aliases.
 * Source: https://developers.deepgram.com/docs/models-languages-overview
 * Multilingual is a separate mode; its supported language set differs.
 */
const NOVA_3_LANGUAGES = [
	["Afrikaans", ["af", "af-ZA"]],
	["Arabic", ["ar", "ar-AE", "ar-SA", "ar-QA", "ar-KW", "ar-SY", "ar-LB", "ar-PS", "ar-JO", "ar-EG", "ar-SD", "ar-TD", "ar-MA", "ar-DZ", "ar-TN", "ar-IQ", "ar-IR"]],
	["Armenian", ["hy"]],
	["Assamese", ["as", "as-IN"]],
	["Belarusian", ["be"]],
	["Bengali", ["bn"]],
	["Bosnian", ["bs"]],
	["Bulgarian", ["bg"]],
	["Catalan", ["ca"]],
	["Chinese (Cantonese, Traditional)", ["zh-HK"]],
	["Chinese (Mandarin, Simplified)", ["zh", "zh-CN", "zh-Hans"]],
	["Chinese (Mandarin, Traditional)", ["zh-TW", "zh-Hant"]],
	["Croatian", ["hr"]],
	["Czech", ["cs", "cs-CZ"]],
	["Danish", ["da", "da-DK"]],
	["Dutch", ["nl"]],
	["English", ["en", "en-US", "en-AU", "en-GB", "en-IN", "en-NZ"]],
	["Estonian", ["et"]],
	["Finnish", ["fi"]],
	["Flemish", ["nl-BE"]],
	["French", ["fr", "fr-CA"]],
	["Georgian", ["ka", "ka-GE"]],
	["German", ["de"]],
	["German (Switzerland)", ["de-CH"]],
	["Greek", ["el"]],
	["Gujarati", ["gu", "gu-IN"]],
	["Hebrew", ["he"]],
	["Hindi", ["hi"]],
	["Hungarian", ["hu"]],
	["Indonesian", ["id"]],
	["Italian", ["it"]],
	["Japanese", ["ja"]],
	["Kannada", ["kn"]],
	["Kazakh", ["kk", "kk-KZ"]],
	["Korean", ["ko", "ko-KR"]],
	["Latvian", ["lv"]],
	["Lithuanian", ["lt"]],
	["Macedonian", ["mk"]],
	["Malay", ["ms"]],
	["Marathi", ["mr"]],
	["Mongolian", ["mn"]],
	["Nepali", ["ne"]],
	["Norwegian", ["no"]],
	["Pashto", ["ps", "ps-AF"]],
	["Persian", ["fa"]],
	["Polish", ["pl"]],
	["Portuguese", ["pt", "pt-BR", "pt-PT"]],
	["Punjabi", ["pa", "pa-IN"]],
	["Romanian", ["ro"]],
	["Russian", ["ru"]],
	["Serbian", ["sr"]],
	["Slovak", ["sk"]],
	["Slovenian", ["sl"]],
	["Spanish", ["es", "es-419"]],
	["Swedish", ["sv", "sv-SE"]],
	["Tagalog", ["tl"]],
	["Tamil", ["ta"]],
	["Telugu", ["te"]],
	["Thai", ["th", "th-TH"]],
	["Turkish", ["tr", "tr-TR"]],
	["Ukrainian", ["uk"]],
	["Urdu", ["ur"]],
	["Vietnamese", ["vi"]],
] as const;

export type DictationLanguage = "multi" | (typeof NOVA_3_LANGUAGES)[number][1][number];

export const DICTATION_LANGUAGES: readonly { code: DictationLanguage; label: string }[] = [
	{ code: "multi", label: "Multilingual" },
	...NOVA_3_LANGUAGES.flatMap(([name, codes]) =>
		codes.map((code, i) => ({ code, label: i === 0 ? name : `${name} (${code})` })),
	).sort((a, b) => a.label.localeCompare(b.label, "en")),
];

export function isDictationLanguage(value: unknown): value is DictationLanguage {
	return DICTATION_LANGUAGES.some(({ code }) => code === value);
}

/** Only language varies. Keep the owner's tuned streaming parameters. */
export function deepgramListenUrl(language: DictationLanguage): string {
	return "wss://api.deepgram.com/v1/listen" +
		"?model=nova-3&encoding=linear16&sample_rate=16000&channels=1" +
		"&smart_format=true&punctuate=true&endpointing=300" +
		`&language=${encodeURIComponent(language)}`;
}

export const DICTATION_SAMPLE_RATE = 16_000;
export const DICTATION_FRAME_SAMPLES = 2048;

export interface PcmResampler {
	/** Process a Float32 mono audio block; returns RMS loudness (0..1) and any completed 16kHz Int16 frames. */
	push(channel: Float32Array): { rms: number; frames: Int16Array[] };
	/** Emit any remaining partial samples as a final Int16Array frame (empty if none buffered). */
	flush(): Int16Array | null;
}

/**
 * Downsample Float32 mono audio from any hardware rate (e.g. iOS 48kHz / 44.1kHz
 * or desktop 16kHz) to 16kHz linear16 PCM frames using an exact weighted box filter.
 * Mirrors public/worklets/pcm-capture.js for the ScriptProcessorNode fallback and unit tests.
 */
export function createPcmResampler(
	inputRate: number,
	targetRate = DICTATION_SAMPLE_RATE,
	frameSamples = DICTATION_FRAME_SAMPLES,
): PcmResampler {
	const safeInputRate = Number.isFinite(inputRate) && inputRate > 0 ? inputRate : targetRate;
	const ratio = safeInputRate / targetRate;
	let frame = new Int16Array(frameSamples);
	let count = 0;
	let bucketSum = 0;
	let bucketFill = 0;

	const toInt16 = (sample: number): number => {
		const s = Math.max(-1, Math.min(1, sample));
		return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
	};

	const emitSample = (sample: number, frames: Int16Array[]) => {
		frame[count++] = toInt16(sample);
		if (count === frame.length) {
			frames.push(frame);
			frame = new Int16Array(frameSamples);
			count = 0;
		}
	};

	return {
		push(channel: Float32Array) {
			const frames: Int16Array[] = [];
			if (channel.length === 0) return { rms: 0, frames };
			let sumSquares = 0;
			for (let i = 0; i < channel.length; i++) {
				const x = channel[i]!;
				sumSquares += x * x;
			}
			const rms = Math.sqrt(sumSquares / channel.length);

			if (Math.abs(ratio - 1) < 1e-6) {
				for (let i = 0; i < channel.length; i++) emitSample(channel[i]!, frames);
			} else if (ratio > 1) {
				for (let i = 0; i < channel.length; i++) {
					const x = channel[i]!;
					let remain = 1;
					while (remain > 1e-9) {
						const need = ratio - bucketFill;
						const take = remain < need ? remain : need;
						bucketSum += x * take;
						bucketFill += take;
						remain -= take;
						if (bucketFill >= ratio - 1e-9) {
							emitSample(bucketSum / ratio, frames);
							bucketSum = 0;
							bucketFill = 0;
						}
					}
				}
			} else {
				// Upsampling fallback (rare: inputRate < 16kHz) via linear interpolation.
				const outLen = Math.max(1, Math.round(channel.length / ratio));
				for (let o = 0; o < outLen; o++) {
					const pos = o * ratio;
					const idx = Math.min(channel.length - 1, Math.floor(pos));
					const next = Math.min(channel.length - 1, idx + 1);
					const frac = pos - idx;
					emitSample(channel[idx]! * (1 - frac) + channel[next]! * frac, frames);
				}
			}
			return { rms, frames };
		},
		flush() {
			const frames: Int16Array[] = [];
			if (bucketFill > 1e-6 && ratio > 1) {
				emitSample(bucketSum / bucketFill, frames);
				bucketSum = 0;
				bucketFill = 0;
			}
			if (frames.length > 0 && count === 0) return frames[0]!;
			if (count === 0) return null;
			const tail = frame.slice(0, count);
			count = 0;
			if (frames.length > 0) {
				const combined = new Int16Array(frames[0]!.length + tail.length);
				combined.set(frames[0]!);
				combined.set(tail, frames[0]!.length);
				return combined;
			}
			return tail;
		},
	};
}
