/*
 * pcm-capture — the dictation audio path (STT wave, 2026-09-17).
 *
 * Runs OFF the main thread (AudioWorklet): converts the mic's Float32
 * samples to 16-bit little-endian PCM (linear16) and hands buffers to the
 * main thread in two streams:
 *
 *   { type: "level", rms }  — every render quantum (128 samples ≈ 8ms at
 *                             16kHz): the quantum's RMS level, 0..1. This
 *                             is the meter's heartbeat; posting per quantum
 *                             is what makes the meter feel instant (the
 *                             dominant latency in the owner's terminal
 *                             version was a 256ms IO buffer — see
 *                             ~/.pi/agent/extensions/dictate).
 *   { type: "audio", buffer } — Int16Array frames of 2048 samples (128ms),
 *                             zero-copy (transferred). Deepgram recommends
 *                             ~100–200ms chunks; silence is streamed too,
 *                             so the socket never idles (no KeepAlive
 *                             needed — the 10s NET-0001 timeout only bites
 *                             a stream that stops SENDING).
 *
 * Ships as a static file under public/ so it rides the standalone bundle.
 * Plain JS by necessity (worklets run outside the module graph).
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.targetRate = 16000;
		this.inputRate = typeof sampleRate === "number" && sampleRate > 0 ? sampleRate : this.targetRate;
		this.ratio = this.inputRate / this.targetRate;
		this.frame = new Int16Array(2048);
		this.count = 0;
		this.bucketSum = 0;
		this.bucketFill = 0;
		this.port.onmessage = (event) => {
			if (event && event.data && event.data.type === "flush") {
				this.flush();
			}
		};
	}

	pushSample(sample) {
		const s = Math.max(-1, Math.min(1, sample));
		this.frame[this.count++] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
		if (this.count === this.frame.length) {
			this.port.postMessage({ type: "audio", buffer: this.frame.buffer }, [this.frame.buffer]);
			this.frame = new Int16Array(2048);
			this.count = 0;
		}
	}

	flush() {
		if (this.bucketFill > 1e-6 && this.ratio > 1) {
			this.pushSample(this.bucketSum / this.bucketFill);
			this.bucketSum = 0;
			this.bucketFill = 0;
		}
		if (this.count > 0) {
			const tail = this.frame.slice(0, this.count);
			this.count = 0;
			this.port.postMessage({ type: "audio", buffer: tail.buffer }, [tail.buffer]);
		}
	}

	process(inputs) {
		const channel = inputs[0] && inputs[0][0];
		if (!channel || channel.length === 0) return true; // no input yet — stay alive

		// RMS for the meter (float domain, before conversion).
		let sumSquares = 0;
		for (let i = 0; i < channel.length; i++) sumSquares += channel[i] * channel[i];
		this.port.postMessage({ type: "level", rms: Math.sqrt(sumSquares / channel.length) });

		// Float32 (native hardware rate, e.g. 48kHz on iOS) → 16kHz Int16 PCM.
		const ratio = this.ratio;
		if (Math.abs(ratio - 1) < 1e-6) {
			for (let i = 0; i < channel.length; i++) this.pushSample(channel[i]);
		} else if (ratio > 1) {
			for (let i = 0; i < channel.length; i++) {
				const x = channel[i];
				let remain = 1;
				while (remain > 1e-9) {
					const need = ratio - this.bucketFill;
					const take = remain < need ? remain : need;
					this.bucketSum += x * take;
					this.bucketFill += take;
					remain -= take;
					if (this.bucketFill >= ratio - 1e-9) {
						this.pushSample(this.bucketSum / ratio);
						this.bucketSum = 0;
						this.bucketFill = 0;
					}
				}
			}
		} else {
			const outLen = Math.max(1, Math.round(channel.length / ratio));
			for (let o = 0; o < outLen; o++) {
				const pos = o * ratio;
				const idx = Math.min(channel.length - 1, Math.floor(pos));
				const next = Math.min(channel.length - 1, idx + 1);
				const frac = pos - idx;
				this.pushSample(channel[idx] * (1 - frac) + channel[next] * frac);
			}
		}
		return true;
	}
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
