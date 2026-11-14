// Port of schism/page_waterfall.c: the FFT behind the waterfall page and the
// "spectrum" visualiser in the top bar (Schism Tracker, GPL-2.0-or-later).
// Single precision is kept with Math.fround where the C code uses float.
import { app, provide } from './app.js';
import { status, PAGE, NEED_UPDATE } from './state.js';
import { vgamem_ovl_alloc, vgamem_ovl_apply, vgamem_ovl_clear, vgamem_ovl_drawline, ovl as OVL } from './vgamem.js';
import { widget_create_other } from './widget.js';
import { KEYSYM, KEYMOD, KEY_PRESS, KEY_RELEASE, NO_MODIFIER, kbd_get_note } from './keyboard.js';
import { pages, set_page } from './page.js';
import { current_song, song_is_instrument_mode, song_keydown, song_keyup, song_get_mode, MODE_PLAYING,
	song_get_current_order, song_set_current_order, song_get_playing_pattern, song_get_current_row,
	song_change_current_play_channel, KEYJAZZ_NOINST, KEYJAZZ_CHAN_CURRENT } from './song.js';

const f = Math.fround;
const W = 640, H = 400, SCOPE_ROWS = 32, FFT_BANDS_SIZE = 1920;
let fft_size = 0, fft_bufsize = 0, fft_sizelog2 = 0, fft_inv_bufsize = 0;
const inv_s_range = f(1 / 32768);
const fftlog = new Uint32Array(FFT_BANDS_SIZE);
let mono = 0, noisefloor = 72;
let bit_reverse, window_, presin, precos, state_real, state_imag, incomingl, incomingr, datal, datar;

const reverse_bits = (x, bits) => {
	let r = 0;
	for (let i = 0; i < bits; i++) { r = (r << 1) | (x & 1); x >>>= 1; }
	return r >>> 0;
};
export function vis_set_size(size) {
	let n = 1; while (n < size) n <<= 1;
	if (n !== fft_size) {
		fft_size = n; fft_bufsize = n * 2; fft_sizelog2 = Math.log2(fft_bufsize);
		bit_reverse = new Uint32Array(fft_bufsize); window_ = new Float32Array(fft_bufsize);
		presin = new Float32Array(fft_size); precos = new Float32Array(fft_size);
		state_real = new Float32Array(fft_bufsize); state_imag = new Float32Array(fft_bufsize);
		incomingl = new Int16Array(fft_bufsize); incomingr = new Int16Array(fft_bufsize);
		datal = new Uint8Array(fft_size); datar = new Uint8Array(fft_size);
	}
	for (let i = 0; i < fft_bufsize; i++) {
		bit_reverse[i] = reverse_bits(i, fft_sizelog2);
		window_[i] = f(0.5 - 0.5 * Math.cos(2.0 * Math.PI * i / (fft_bufsize - 1))); // Hann
	}
	for (let i = 0; i < fft_size; i++) {
		const j = f(f(f(2.0 * f(Math.PI)) * i) / fft_bufsize);
		precos[i] = Math.cos(j);
		presin[i] = Math.sin(j);
	}
	fft_inv_bufsize = f(1 / (fft_bufsize >> 2));
	const factor = f(fft_size / FFT_BANDS_SIZE) / FFT_BANDS_SIZE; // exponential band scale
	for (let i = 0; i < FFT_BANDS_SIZE; i++) fftlog[i] = Math.trunc(i * i * factor);
}
const pdB_s = (power, corr) => {
	const db = f(f(10 * Math.log10(power)) + corr);
	const x = Math.trunc(Math.trunc(f(128 * f(db + noisefloor))) / noisefloor);
	return Math.max(0, Math.min(127, x));
};
function vis_data_work(output, input) {
	for (let n = 0; n < fft_bufsize; n++) {
		const nr = bit_reverse[n];
		state_real[n] = f(f(input[nr] * inv_s_range) * window_[nr]);
		state_imag[n] = 0;
	}
	let ex = 1, ff = fft_size;
	for (let n = fft_sizelog2; n; n--) {
		for (let k = 0; k !== ex; k++) {
			const fr = precos[k * ff], fi = presin[k * ff];
			for (let y = k; y < fft_bufsize; y += ex << 1) {
				const yp = y + ex;
				const tr = f(f(fr * state_real[yp]) - f(fi * state_imag[yp]));
				const ti = f(f(fr * state_imag[yp]) + f(fi * state_real[yp]));
				state_real[yp] = state_real[y] - tr;
				state_imag[yp] = state_imag[y] - ti;
				state_real[y] += tr;
				state_imag[y] += ti;
			}
		}
		ex <<= 1;
		ff >>= 1;
	}
	const dbinv = f(20 * Math.log10(fft_inv_bufsize));
	for (let n = 0; n < fft_size; n++) {
		const out = f(f(state_real[n] * state_real[n]) + f(state_imag[n] * state_imag[n]));
		output[n] = pdB_s(f(out + 0.0000000001), dbinv);
	}
}
// vis_work_*: pcm is 32-bit interleaved (the mixer's output), channels 1 or 2
export function vis_work(pcm32, frames, channels) {
	if (!fft_size) vis_set_size(1024);
	if (!frames) { datal.fill(0); datar.fill(0); }
	else {
		for (let i = 0; i < fft_size;) {
			for (let k = 0, j = 0; k < frames && i < fft_size; k++, i++) {
				if (channels === 2) { incomingl[i] = pcm32[j++] >> 16; incomingr[i] = pcm32[j++] >> 16; }
				else incomingl[i] = incomingr[i] = pcm32[j++] >> 16;
			}
		}
		for (let i = fft_size; i < fft_bufsize; i++) incomingl[i] = incomingr[i] = 0;
		vis_data_work(datal, incomingl);
		vis_data_work(datar, incomingr);
	}
	if (status.current_page === PAGE.WATERFALL) vis_process();
}
const fft_value = (chan, i) => chan === 1 ? datal[i] : chan === 2 ? datar[i] : (datal[i] + datar[i]) >> 1;
export function fft_get_columns(width, out, chan, base = 0) {
	if (!fft_size) return;
	for (let i = 0, a = 0; i < width && a < fft_size; i++) {
		const fi = Math.trunc(i * FFT_BANDS_SIZE / width);
		const ax = fftlog[fi];
		if (ax >= fft_size) break;
		let j;
		if (fi + 1 >= FFT_BANDS_SIZE || ax + 1 > fftlog[fi + 1]) { a = ax; j = fft_value(chan, a); }
		else {
			j = fft_value(chan, a);
			while (a <= ax) { a++; j = Math.max(j, fft_value(chan, a) | 0); }
		}
		out[base + i] = j;
	}
}

const ovl = vgamem_ovl_alloc({ x1: 0, y1: 0, x2: 79, y2: 49 });
const outfft = new Uint8Array(W);
function drawslice(x, h, c) {
	const y = ((h >> 2) & (SCOPE_ROWS - 1)) + 1;
	vgamem_ovl_drawline(ovl, x, H - y, x, H - 1, c);
}
function vis_process() {
	const k = W / 2, q = OVL; // the overlay covers the whole screen, so offsets are screen offsets
	q.copyWithin(0, W, W * (H - 1 - SCOPE_ROWS) + W);
	const row = W * (H - 1 - SCOPE_ROWS);
	const dobits = (start, from, len, step) => {
		for (let i = 0, p = start; i < len; i++, p += step) q[p] = Math.min(255, 128 + outfft[from + i]);
	};
	if (mono) { fft_get_columns(W, outfft, 0); dobits(row, 0, W, 1); }
	else {
		fft_get_columns(k, outfft, 1, 0);
		fft_get_columns(k, outfft, 2, k);
		dobits(row + k - 1, 0, k, -1);
		dobits(row + k, k, k, 1);
	}
	q.fill(0, W * (H - SCOPE_ROWS), W * H);
	if (mono) for (let i = 0; i < W; i++) drawslice(i, outfft[i], 5);
	else {
		for (let i = 0; i < k; i++) drawslice(k - i - 1, outfft[i], 5);
		for (let i = 0; i < k; i++) drawslice(k + i, outfft[k + i], 5);
	}
	status.flags |= NEED_UPDATE;
}

function waterfall_handle_key(k) {
	let n, v;
	if (NO_MODIFIER(k.mod)) {
		if (k.midi_note > -1) { n = k.midi_note; v = k.midi_volume > -1 ? k.midi_volume >> 1 : 64; }
		else { v = 64; n = kbd_get_note(k); }
		if (n > -1) {
			const ii = song_is_instrument_mode() ? app.instrument_get_current() : app.sample_get_current();
			if (k.state === KEY_RELEASE) { song_keyup(KEYJAZZ_NOINST, ii, n); status.last_keysym = 0; }
			else if (!k.is_repeat) song_keydown(KEYJAZZ_NOINST, ii, n, v, KEYJAZZ_CHAN_CURRENT);
			return 1;
		}
	}
	const rel = k.state === KEY_RELEASE;
	switch (k.sym) {
	case KEYSYM.s:
		if (!(k.mod & KEYMOD.ALT)) return 0;
		if (!rel) { app.song_toggle_stereo(); status.flags |= NEED_UPDATE; }
		return 1;
	case KEYSYM.m:
		if (!(k.mod & KEYMOD.ALT)) return 0;
		if (!rel) mono = mono ? 0 : 1;
		return 1;
	case KEYSYM.LEFT:
		if (!NO_MODIFIER(k.mod)) return 0;
		if (rel) return 1;
		noisefloor -= 4;
		break;
	case KEYSYM.RIGHT:
		if (!NO_MODIFIER(k.mod)) return 0;
		if (rel) return 1;
		noisefloor += 4;
		break;
	case KEYSYM.g: {
		if (!(k.mod & KEYMOD.ALT)) return 0;
		if (k.state === KEY_PRESS) return 1;
		const order = song_get_current_order();
		const pat = song_get_mode() === MODE_PLAYING ? current_song.orderlist[order] : song_get_playing_pattern();
		if (pat < 200) {
			app.set_current_order(order);
			app.set_current_pattern(pat);
			app.set_current_row(song_get_current_row());
			set_page(PAGE.PATTERN_EDITOR);
		}
		return 1;
	}
	case KEYSYM.r:
		if (!(k.mod & KEYMOD.ALT)) return 0;
		if (!rel) app.song_flip_stereo();
		return 1;
	case KEYSYM.PLUS: case KEYSYM.KP_PLUS:
		if (!NO_MODIFIER(k.mod)) return 0;
		if (!rel && song_get_mode() === MODE_PLAYING) song_set_current_order(song_get_current_order() + 1);
		return 1;
	case KEYSYM.MINUS: case KEYSYM.KP_MINUS:
		if (!NO_MODIFIER(k.mod)) return 0;
		if (!rel && song_get_mode() === MODE_PLAYING) song_set_current_order(song_get_current_order() - 1);
		return 1;
	case KEYSYM.SEMICOLON: case KEYSYM.COLON:
		if (rel) return 1;
		if (song_is_instrument_mode()) app.instrument_set(app.instrument_get_current() - 1);
		else app.sample_set(app.sample_get_current() - 1);
		return 1;
	case KEYSYM.QUOTE: case KEYSYM.QUOTEDBL:
		if (rel) return 1;
		if (song_is_instrument_mode()) app.instrument_set(app.instrument_get_current() + 1);
		else app.sample_set(app.sample_get_current() + 1);
		return 1;
	case KEYSYM.COMMA: case KEYSYM.LESS:
		if (!rel) song_change_current_play_channel(-1, 0);
		return 1;
	case KEYSYM.PERIOD: case KEYSYM.GREATER:
		if (!rel) song_change_current_play_channel(1, 0);
		return 1;
	default: return 0;
	}
	noisefloor = Math.max(36, Math.min(96, noisefloor));
	return 1;
}

Object.assign(pages[PAGE.WATERFALL], { title: '', draw_full: () => vgamem_ovl_apply(ovl),
	set_page: () => vgamem_ovl_clear(ovl, 0), total_widgets: 1,
	widgets: [widget_create_other(0, waterfall_handle_key, null, () => {})], ported: true });

provide({ vis_work, vis_set_size, fft_get_columns });
