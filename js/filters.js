// Port of player/filters.c (GPL-2.0-or-later).
import { provide } from './app.js';
import { resonance_table } from './gen/tables.js';
const f = Math.fround;
export function setup_channel_filter(chan, reset, flt_modifier, freq) {
	const cutoff = Math.min(255, Math.trunc(chan.cutoff * (flt_modifier + 256) / 256));
	const resonance = Math.min(255, chan.resonance);
	if (resonance === 0 && cutoff >= 254) {
		if (chan.flags & 0x2000000) chan.flags &= ~0x4000;
		return;
	}
	// The C LUT has 128 entries; out-of-range resonance is invalid upstream too.
	if (resonance < 0 || resonance >= 128) throw new RangeError('Invalid filter resonance');
	chan.flags |= 0x4000;
	let frequency = f(110 * Math.pow(2, cutoff * (128 / (24 * 256)) + 0.25));
	frequency = Math.min(frequency, f(freq / 2));
	const r = f(freq / (2 * Math.PI * frequency));
	const damping = resonance_table[resonance];
	const d = f(f(f(damping * r) + damping) - 1);
	const e = f(r * r);
	const denominator = f(f(1 + d) + e);
	const fg = f(1 / denominator);
	const fb0 = f(f(f(d + e) + e) / denominator);
	const fb1 = f(-e / denominator);
	chan.filter_a0 = Math.trunc(f(fg * 16777216));
	chan.filter_b0 = Math.trunc(f(fb0 * 16777216));
	chan.filter_b1 = Math.trunc(f(fb1 * 16777216));
	if (reset) for (const channel of chan.filter_y) channel.fill(0);
}
provide({ setup_channel_filter });
