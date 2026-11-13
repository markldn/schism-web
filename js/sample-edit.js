// Port of schism/sample-edit.c and draw_sample_data() from schism/vgamem.c
// (Schism Tracker, GPL-2.0-or-later).
import { app, provide } from './app.js';
import * as C from './sndconst.js';
import { status, SONG_NEEDS_SAVE, CLASSIC_MODE } from './state.js';
import { draw_box, draw_text_len, vgamem_ovl_clear, vgamem_ovl_apply, vgamem_ovl_drawpixel, draw_sample_data_raw,
	BOX_THICK, BOX_THIN, BOX_INNER, BOX_INSET, BOX_OUTSET } from './vgamem.js';
import { csf_adjust_sample_loop, csf_stop_sample } from './csndfile.js';
import { current_song, song_get_mode, MODE_STOPPED } from './song.js';
import { ResampleMono8BitFirFilter, ResampleMono16BitFirFilter, ResampleStereo8BitFirFilter, ResampleStereo16BitFirFilter } from './mixer.js';

const nch = s => s.flags & C.CHN_STEREO ? 2 : 1;
const lim = s => s.flags & C.CHN_16BIT ? [-32768, 32767] : [-128, 127];
const view = s => s.data.subarray(0, s.length * nch(s));
const newbuf = (s, n) => s.flags & C.CHN_16BIT ? new Int16Array(n) : new Int8Array(n);
const saved = () => { status.flags |= SONG_NEEDS_SAVE; };
function minmax(d) { let mi = Infinity, ma = -Infinity; for (const v of d) { if (v < mi) mi = v; if (v > ma) ma = v; } return [mi, ma]; }

export function sample_sign_convert(s) {
	saved();
	const d = view(s), x = s.flags & C.CHN_16BIT ? 0x8000 : 0x80, sh = s.flags & C.CHN_16BIT ? 16 : 24;
	for (let i = 0; i < d.length; i++) d[i] = ((d[i] ^ x) << sh) >> sh;
	csf_adjust_sample_loop(s);
}
export function sample_reverse(s) {
	saved();
	const ch = nch(s), d = view(s);
	for (let l = 0, r = s.length - 1; l < r; l++, r--)
		for (let c = 0; c < ch; c++) { const t = d[l * ch + c]; d[l * ch + c] = d[r * ch + c]; d[r * ch + c] = t; }
	let tmp = s.length - s.loop_start; s.loop_start = s.length - s.loop_end; s.loop_end = tmp;
	tmp = s.length - s.sustain_start; s.sustain_start = s.length - s.sustain_end; s.sustain_end = tmp;
	csf_adjust_sample_loop(s);
}
export function sample_toggle_quality(s, convert_data) {
	csf_stop_sample(current_song, s);
	const old = view(s);
	s.flags ^= C.CHN_16BIT;
	saved();
	if (convert_data) {
		const o = newbuf(s, old.length);
		if (s.flags & C.CHN_16BIT) for (let i = 0; i < old.length; i++) o[i] = old[i] << 8;
		else for (let i = 0; i < old.length; i++) o[i] = old[i] >> 8;
		s.data = o;
	} else {
		const bytes = new Uint8Array(old.buffer, old.byteOffset, old.byteLength);
		if (s.flags & C.CHN_16BIT) {
			for (const k of ['length', 'loop_start', 'loop_end', 'sustain_start', 'sustain_end']) s[k] >>= 1;
			s.data = new Int16Array(bytes.slice(0, s.length * nch(s) * 2).buffer);
		} else {
			for (const k of ['length', 'loop_start', 'loop_end', 'sustain_start', 'sustain_end']) s[k] <<= 1;
			s.data = new Int8Array(bytes.slice().buffer);
		}
	}
	csf_adjust_sample_loop(s);
}
export function sample_centralise(s) {
	saved();
	const d = view(s), [mi, ma] = minmax(d);
	const offset = (ma + mi + 1) >> 1;
	if (offset) for (let i = 0; i < d.length; i++) d[i] -= offset;
	csf_adjust_sample_loop(s);
}
export function sample_downmix(s) {
	if (!(s.flags & C.CHN_STEREO)) return;
	saved();
	const d = view(s), o = newbuf(s, s.length);
	for (let j = 0; j < s.length; j++) o[j] = Math.trunc((d[2 * j] + d[2 * j + 1]) / 2);
	s.data = o;
	s.flags &= ~C.CHN_STEREO;
	csf_adjust_sample_loop(s);
}
export function sample_amplify(s, percent) {
	saved();
	const d = view(s), [lo, hi] = lim(s);
	for (let i = 0; i < d.length; i++) { const b = Math.trunc(d[i] * percent / 100); d[i] = b < lo ? lo : b > hi ? hi : b; }
	csf_adjust_sample_loop(s);
}
export function sample_get_amplify_amount(s) {
	const d = view(s);
	let [mi, ma] = minmax(d);
	ma = Math.max(ma, -mi);
	const full = s.flags & C.CHN_16BIT ? 32768 : 128;
	const p = ma ? Math.trunc(full * 100 / ma) : 100;
	return Math.max(p, 100);
}
export function sample_delta_decode(s) {
	saved();
	const d = view(s);
	for (let p = 1; p < d.length; p++) d[p] += d[p - 1];
	csf_adjust_sample_loop(s);
}
export function sample_invert(s) {
	saved();
	const d = view(s);
	for (let i = 0; i < d.length; i++) d[i] = ~d[i];
	csf_adjust_sample_loop(s);
}
export function sample_resize(s, newlen, aa) {
	if (!newlen || !s.data || !s.length) return;
	csf_stop_sample(current_song, s);
	saved();
	const stereo = s.flags & C.CHN_STEREO, ch = nch(s), src = view(s), oldlen = s.length;
	const dst = newbuf(s, newlen * ch);
	const scale = v => Math.trunc(newlen * v / s.length);
	s.c5speed = Math.trunc(newlen * s.c5speed / s.length);
	s.loop_start = scale(s.loop_start); s.loop_end = scale(s.loop_end);
	s.sustain_start = scale(s.sustain_start); s.sustain_end = scale(s.sustain_end);
	s.length = newlen;
	if (aa) {
		const f = s.flags & C.CHN_16BIT ? (stereo ? ResampleStereo16BitFirFilter : ResampleMono16BitFirFilter)
			: (stereo ? ResampleStereo8BitFirFilter : ResampleMono8BitFirFilter);
		f(s.data, dst, oldlen, newlen);
	} else {
		const factor = oldlen / newlen;
		for (let i = 0; i < newlen; i++) {
			const pos = Math.trunc(i * factor);
			for (let c = 0; c < ch; c++) dst[i * ch + c] = src[pos * ch + c];
		}
	}
	s.data = dst;
	csf_adjust_sample_loop(s);
}
function sample_mono_(s, off) {
	csf_stop_sample(current_song, s);
	saved();
	if (s.flags & C.CHN_STEREO) {
		const d = view(s), o = newbuf(s, s.length);
		for (let j = 0, i = off ? 0 : 1; j < s.length; j++, i += 2) o[j] = d[i];
		s.data = o;
		s.flags &= ~C.CHN_STEREO;
	}
	csf_adjust_sample_loop(s);
}
export const sample_mono_left = s => sample_mono_(s, 1);
export const sample_mono_right = s => sample_mono_(s, 0);
export function sample_crossfade(smp, fade_length, law, fade_after_loop, sustain_loop) {
	saved();
	if (!smp.data) return;
	const loop_start = sustain_loop ? smp.sustain_start : smp.loop_start;
	const loop_end = sustain_loop ? smp.sustain_end : smp.loop_end;
	if (loop_end <= loop_start || loop_end > smp.length) return;
	if (loop_start < fade_length) return;
	const ch = nch(smp), d = view(smp), [lo, hi] = lim(smp);
	const e = 1 - law / 200;
	const fade = (src1, src2, len) => {
		const inv = 1 / len;
		for (let i = 0; i < len; i++) {
			const out = Math.trunc(d[src1 + i] * Math.pow(i * inv, e) + d[src2 + i] * Math.pow((len - i) * inv, e));
			d[src2 + i] = out < lo ? lo : out > hi ? hi : out;
		}
	};
	fade((loop_start - fade_length) * ch, (loop_end - fade_length) * ch, fade_length * ch);
	if (fade_after_loop) fade(loop_start * ch, loop_end * ch, Math.min(smp.length - loop_end, fade_length) * ch);
	csf_adjust_sample_loop(smp);
}

// draw_sample_data (vgamem.c)
const SAMPLE_DATA_COLOR = 13, SAMPLE_LOOP_COLOR = 3, SAMPLE_MARK_COLOR = 6, SAMPLE_BGMARK_COLOR = 7;
function _draw_loop_ex(r, start, end, length, colorbits, flags, loopflag) {
	if (!(flags & loopflag)) return;
	const c = (status.flags & CLASSIC_MODE) ? SAMPLE_DATA_COLOR : SAMPLE_LOOP_COLOR;
	const ls = Math.trunc(start * (r.width - 1) / length), le = Math.trunc(end * (r.width - 1) / length);
	for (let y = 0; y < r.height; y++) {
		const col = (colorbits & (1 << (y & 3))) ? c : 0;
		vgamem_ovl_drawpixel(r, ls, y, col);
		vgamem_ovl_drawpixel(r, le, y, col);
	}
}
function _draw_sample_play_marks(r, sample) {
	if (song_get_mode() === MODE_STOPPED) return;
	let n = Math.min(current_song.num_voices, current_song.max_voices);
	while (n--) {
		const ch = current_song.voices[current_song.voice_mix[n]];
		if (ch.ptr_sample !== sample || !ch.current_sample_data || !ch.final_volume) continue;
		const c = (ch.flags & (C.CHN_KEYOFF | C.CHN_NOTEFADE)) ? SAMPLE_BGMARK_COLOR : SAMPLE_MARK_COLOR;
		const x = Math.trunc(Number(ch.position.v >> 32n) * (r.width - 1) / sample.length);
		if (x >= r.width || x < 0) continue;
		for (let y = 0; y < r.height; y++) vgamem_ovl_drawpixel(r, x, y, c);
	}
}
export function draw_sample_data(r, sample) {
	vgamem_ovl_clear(r, 0);
	if (sample.flags & C.CHN_ADLIB) {
		vgamem_ovl_clear(r, 2);
		vgamem_ovl_apply(r);
		const y1 = r.y1, y2 = y1 + 3, b = sample.adlib_bytes, h = i => b[i].toString(16).toUpperCase().padStart(2, '0');
		draw_box(59, y1, 77, y2, BOX_THICK | BOX_INNER | BOX_INSET);
		draw_box(54, y1, 58, y2, BOX_THIN | BOX_INNER | BOX_OUTSET);
		draw_text_len('Mod', 3, 55, y1 + 1, 0, 2);
		draw_text_len('Car', 3, 55, y1 + 2, 0, 2);
		draw_text_len([0, 2, 4, 6, 8, 10].map(h).join(' '), 17, 60, y1 + 1, 2, 0);
		draw_text_len([1, 3, 5, 7, 9].map(h).join(' '), 17, 60, y1 + 2, 2, 0);
		return;
	}
	if (!sample.length || !sample.data) { vgamem_ovl_apply(r); return; }
	const ch = nch(sample);
	draw_sample_data_raw(r, sample.data, sample.flags & C.CHN_16BIT ? 16 : 8, sample.length * ch, ch, ch);
	if (!(status.flags & CLASSIC_MODE)) _draw_sample_play_marks(r, sample);
	_draw_loop_ex(r, sample.loop_start, sample.loop_end, sample.length, 0x02 | 0x04, sample.flags, C.CHN_LOOP);
	_draw_loop_ex(r, sample.sustain_start, sample.sustain_end, sample.length, 0x01 | 0x04, sample.flags, C.CHN_SUSTAINLOOP);
	vgamem_ovl_apply(r);
}

provide({ sample_sign_convert, sample_reverse, sample_toggle_quality, sample_centralise, sample_downmix,
	sample_amplify, sample_get_amplify_amount, sample_delta_decode, sample_invert, sample_resize,
	sample_mono_left, sample_mono_right, sample_crossfade, draw_sample_data });
