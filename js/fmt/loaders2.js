// More module loaders: fmt/mtm.c, fmt/669.c, fmt/stm.c, fmt/far.c, fmt/ult.c,
// fmt/okt.c, fmt/imf.c, fmt/stx.c, fmt/sfx.c, fmt/dsm.c, fmt/mdl.c, fmt/psm.c
// and the shared helpers of fmt/generic.c (Schism Tracker, GPL-2.0-or-later).
import { app } from '../app.js';
import * as C from '../sndconst.js';
import { csf_allocate_pattern, csf_allocate_instrument, csf_insert_restart_pos } from '../csndfile.js';
import { transpose_to_frequency } from '../effects.js';
import { finetune_table, midi_program_names, midi_percussion_names } from '../gen/tables.js';
import { fm_patches } from '../gen/fmpatches.js';
import { fpio, read_sample, csf_import_mod_effect, swap_effects, convert_voleffect_of, effect_weight,
	mod_import_note, song_loaders, LOAD_SUCCESS, LOAD_UNSUPPORTED, LOAD_FORMAT_ERROR } from './loaders.js';

const { getc, eof, u8, s8, u16, u16be, u32, bytes, cstr, seek, tell, clamp } = fpio;
const s16 = fp => (u16(fp) << 16) >> 16;
const u32be = fp => ((u8(fp) << 24) | (u8(fp) << 16) | (u8(fp) << 8) | u8(fp)) >>> 0;
const skip = (fp, n) => { fp.position += n; };
const log = (c, s) => app.log_appendf(c, s);
const SHORT_PANNING = i => ((((i) << 4) | (i)) + 2) >> 2;
const MAX_MESSAGE = 8000;
const bstr = (b, n = b.length) => { let s = ''; for (let i = 0; i < n && i < b.length; i++) { if (!b[i]) break; s += String.fromCharCode(b[i]); } return s; };
const trim = s => s.replace(/^[\s]+|[\s]+$/g, '');
const set_note = (dst, src) => { dst.note = src.note; dst.instrument = src.instrument; dst.voleffect = src.voleffect;
	dst.volparam = src.volparam; dst.effect = src.effect; dst.param = src.param; };
const blank = () => ({ note: 0, instrument: 0, voleffect: 0, volparam: 0, effect: 0, param: 0 });
const new_pattern = (song, pat, rows) => {
	song.patterns[pat] = csf_allocate_pattern(rows);
	song.pattern_size[pat] = song.pattern_alloc_size[pat] = rows;
	return song.patterns[pat];
};

// generic.c
export function read_lined_message(song, fp, len, linelen) {
	let msg = '';
	while (len > 0) {
		const linesize = Math.min(len, linelen);
		if (msg.length + linesize + 1 >= MAX_MESSAGE) { skip(fp, len); break; }
		const line = bstr(bytes(fp, linesize)).replace(/\s+$/, '');
		len -= linesize;
		msg += line + '\n';
	}
	song.message = msg;
}

const st2_tempo_table = [
	[125, 117, 110, 102, 95, 87, 80, 72, 62, 55, 47, 40, 32, 25, 17, 10],
	[125, 122, 117, 115, 110, 107, 102, 100, 95, 90, 87, 82, 80, 75, 72, 67],
	[125, 125, 122, 120, 117, 115, 112, 110, 107, 105, 102, 100, 97, 95, 92, 90],
	[125, 125, 122, 122, 120, 117, 117, 115, 112, 112, 110, 110, 107, 105, 105, 102],
	[125, 125, 125, 122, 122, 120, 120, 117, 117, 117, 115, 115, 112, 112, 110, 110],
	[125, 125, 125, 122, 122, 122, 120, 120, 117, 117, 117, 115, 115, 115, 112, 112],
	[125, 125, 125, 125, 122, 122, 122, 122, 120, 120, 120, 120, 117, 117, 117, 117],
	[125, 125, 125, 125, 125, 125, 122, 122, 122, 122, 122, 120, 120, 120, 120, 120],
	[125, 125, 125, 125, 125, 125, 122, 122, 122, 122, 122, 120, 120, 120, 120, 120],
	[125, 125, 125, 125, 125, 125, 125, 125, 122, 122, 122, 122, 122, 122, 122, 122],
	[125, 125, 125, 125, 125, 125, 125, 125, 122, 122, 122, 122, 122, 122, 122, 122],
	[125, 125, 125, 125, 125, 125, 125, 125, 122, 122, 122, 122, 122, 122, 122, 122],
	[125, 125, 125, 125, 125, 125, 125, 125, 122, 122, 122, 122, 122, 122, 122, 122],
	Array(16).fill(125), Array(16).fill(125),
];
export function convert_stm_tempo_to_bpm(tempo) {
	const tpr = (tempo >> 4) ? (tempo >> 4) : 1;
	return st2_tempo_table[tpr - 1][tempo & 15];
}
export function handle_stm_tempo_pattern(pattern, base, tempo) {
	for (let i = 0; i < 32; i++) {
		const note = pattern[base + i];
		if (note.effect === C.FX_NONE) { note.effect = C.FX_TEMPO; note.param = convert_stm_tempo_to_bpm(tempo); break; }
	}
}
export const stm_effects = [C.FX_NONE, C.FX_SPEED, C.FX_POSITIONJUMP, C.FX_PATTERNBREAK, C.FX_VOLUMESLIDE,
	C.FX_PORTAMENTODOWN, C.FX_PORTAMENTOUP, C.FX_TONEPORTAMENTO, C.FX_VIBRATO, C.FX_TREMOR, C.FX_ARPEGGIO,
	0, 0, 0, 0, 0];
export function handle_stm_effects(n) {
	switch (n.effect) {
	case C.FX_SPEED: break;
	case C.FX_VOLUMESLIDE:
		if ((n.param & 0x0f) && (n.param >> 4)) n.param &= 0x0f;
		// fallthrough
	case C.FX_PORTAMENTODOWN:
	case C.FX_PORTAMENTOUP:
		if (!n.param) n.effect = C.FX_NONE;
		break;
	case C.FX_PATTERNBREAK:
		n.param = ((n.param & 0xf0) * 10 + (n.param & 0xf)) & 0xff;
		break;
	case C.FX_POSITIONJUMP:
	case C.FX_TREMOR:
		break;
	default:
		if (!n.param) n.effect = C.FX_NONE;
		break;
	}
}

// ------------------------------------------------------------------------
// mtm.c

function mtm_unpack_track(b, notes, rows) {
	for (let n = 0, o = 0; n < rows; n++, o += 3) {
		const note = notes[n];
		note.note = (b[o] & 0xfc) ? (b[o] >> 2) + 36 + 1 : C.NOTE_NONE;
		note.instrument = ((b[o] & 0x3) << 4) | (b[o + 1] >> 4);
		note.voleffect = C.VOLFX_NONE;
		note.volparam = 0;
		note.effect = b[o + 1] & 0xf;
		note.param = b[o + 2];
		if (note.effect === 0xa && (note.param & 0xf0)) note.param &= 0xf0;
		else if (note.effect === 0x8) note.effect = note.param = 0;
		else if (note.effect === 0xe && [0, 3, 4, 6, 7, 0xf].includes(note.param >> 4)) note.effect = note.param = 0;
		if (note.effect || note.param) csf_import_mod_effect(note, 0);
	}
}

export function fmt_mtm_load_song(song, fp) {
	if (cstr(fp, 3) !== 'MTM') return LOAD_UNSUPPORTED;
	const v = u8(fp);
	song.tracker_id = `MultiTracker ${v >> 4}.${v & 0xf}`;
	song.title = cstr(fp, 20);
	const ntrk = u16(fp), npat = u8(fp), nord = u8(fp) + 1;
	const comment_len = u16(fp), nsmp = u8(fp);
	u8(fp);
	let rows = u8(fp), todo = 0;
	if (rows !== 64) todo |= 64;
	rows = Math.min(rows, 64);
	const nchan = u8(fp);
	if (eof(fp)) return LOAD_FORMAT_ERROR;
	for (let n = 0; n < 32; n++) song.channels[n].panning = SHORT_PANNING(u8(fp) & 0xf) * 4;
	for (let n = nchan; n < C.MAX_CHANNELS; n++) song.channels[n].flags = C.CHN_MUTE;
	if (nsmp > C.MAX_SAMPLES) log(4, ' Warning: Too many samples');
	for (let n = 1; n <= nsmp; n++) {
		if (n > C.MAX_SAMPLES) { skip(fp, 37); continue; }
		const s = song.samples[n];
		s.name = cstr(fp, 22);
		s.length = u32(fp); s.loop_start = u32(fp); s.loop_end = u32(fp);
		if ((s.loop_end - s.loop_start) > 2) s.flags |= C.CHN_LOOP;
		else s.loop_start = s.loop_end = 0;
		s.c5speed = transpose_to_frequency(0, s8(fp) * 16);
		s.volume = u8(fp) * 4;
		s.global_volume = 64;
		if (u8(fp) & 1) { s.flags |= C.CHN_16BIT; s.length >>>= 1; s.loop_start >>>= 1; s.loop_end >>>= 1; }
		s.vib_type = s.vib_rate = s.vib_depth = s.vib_speed = 0;
	}
	song.orderlist.set(bytes(fp, 128).subarray(0, 128));
	song.orderlist.fill(C.ORDER_LAST, nord);
	const trackdata = [];
	for (let n = 0; n < ntrk; n++) {
		const b = bytes(fp, 3 * rows), t = Array.from({ length: rows }, blank);
		const full = new Uint8Array(3 * rows); full.set(b);
		mtm_unpack_track(full, t, rows);
		trackdata.push(t);
	}
	if (npat >= C.MAX_PATTERNS) log(4, ' Warning: Too many patterns');
	for (let pat = 0; pat <= npat; pat++) {
		if (pat >= C.MAX_PATTERNS) { skip(fp, 64); continue; }
		const prow = Math.max(rows, 32);
		const pattern = new_pattern(song, pat, prow);
		for (let chan = 0; chan < 32; chan++) {
			const tmp = u16(fp);
			if (!tmp) continue;
			if (tmp > ntrk) return LOAD_FORMAT_ERROR;
			const t = trackdata[tmp - 1];
			for (let n = 0; n < rows; n++) set_note(pattern[n * 64 + chan], t[n]);
		}
		if (rows < 32) {
			let i = 64 * (rows - 1);
			while (pattern[i].effect || pattern[i].param) i++;
			pattern[i].effect = C.FX_PATTERNBREAK;
		}
	}
	read_lined_message(song, fp, comment_len, 40);
	for (let smp = 1; smp <= nsmp && smp <= C.MAX_SAMPLES; smp++) {
		const s = song.samples[smp];
		if (!s.length) continue;
		read_sample(s, C.SF_LE | C.SF_PCMU | C.SF_M | ((s.flags & C.CHN_16BIT) ? C.SF_16 : C.SF_8), fp);
	}
	song.flags = C.SONG_ITOLDEFFECTS | C.SONG_COMPATGXX;
	if (todo & 64) log(2, ' TODO: test this file with other players (beats per track != 64)');
	return LOAD_SUCCESS;
}

// ------------------------------------------------------------------------
// 669.c

export function fmt_669_load_song(song, fp) {
	const sig = u16(fp);
	let tid;
	if (sig === 0x6669) tid = 'Composer 669';
	else if (sig === 0x4e4a) tid = 'UNIS 669';
	else return LOAD_UNSUPPORTED;
	read_lined_message(song, fp, 108, 36);
	let t = song.message.slice(0, 36);
	t = t.split(/[\r\n]/)[0];
	song.title = trim(t).slice(0, 25);
	const nsmp = u8(fp), npat = u8(fp), restartpos = u8(fp);
	if (nsmp > 64 || npat > 128 || restartpos > 127) return LOAD_UNSUPPORTED;
	song.tracker_id = tid;
	song.orderlist.set(bytes(fp, 128));
	const patspeed = bytes(fp, 128), breakpos = bytes(fp, 128);
	for (let smp = 1; smp <= nsmp; smp++) {
		const b = bytes(fp, 13), s = song.samples[smp];
		s.name = bstr(b, 13);
		s.filename = bstr(b, 12);
		s.length = u32(fp);
		s.loop_start = u32(fp);
		let le = u32(fp);
		if (le > s.length) le = 0; else s.flags |= C.CHN_LOOP;
		s.loop_end = le;
		s.c5speed = 8363;
		s.volume = 60 * 4;
		s.global_volume = 64;
		s.vib_type = s.vib_rate = s.vib_depth = s.vib_speed = 0;
	}
	const effect_lut = [C.FX_PORTAMENTOUP, C.FX_PORTAMENTODOWN, C.FX_TONEPORTAMENTO, 0,
		C.FX_VIBRATO, C.FX_SPEED, C.FX_PANNINGSLIDE, C.FX_RETRIG];
	for (let pat = 0; pat < npat; pat++) {
		const effect = new Uint8Array(8).fill(255);
		const rows = (breakpos[pat] + 1) & 0xff;
		if (rows > 64) return LOAD_UNSUPPORTED;
		const pattern = new_pattern(song, pat, clamp(rows, 32, 64));
		for (let row = 0; row < rows; row++) {
			for (let chan = 0; chan < 8; chan++) {
				const note = pattern[row * 64 + chan];
				const b = [u8(fp), u8(fp), u8(fp)];
				switch (b[0]) {
				case 0xfe:
					note.voleffect = C.VOLFX_VOLUME; note.volparam = (b[1] & 0xf) << 2; break;
				case 0xff: break;
				default:
					note.note = (b[0] >> 2) + 36 + 1;
					note.instrument = ((b[0] & 3) << 4 | (b[1] >> 4)) + 1;
					note.voleffect = C.VOLFX_VOLUME;
					note.volparam = (b[1] & 0xf) << 2;
					effect[chan] = 0xff;
					break;
				}
				if (b[2] !== 0xff) effect[chan] = b[2];
				if ((b[2] & 0x0f) === 0 && b[2] !== 0x30) effect[chan] = 0xff;
				if (effect[chan] === 0xff) continue;
				note.param = effect[chan] & 0x0f;
				const e = effect[chan] >> 4;
				if (e < effect_lut.length) note.effect = effect_lut[e];
				else { note.effect = C.FX_NONE; continue; }
				switch (e) {
				case 3: note.effect = C.FX_PORTAMENTOUP; note.param |= 0xf0; effect[chan] = 0xff; break;
				case 4: note.effect = C.FX_ARPEGGIO; note.param |= (note.param << 4); note.param &= 0xff; break;
				case 5: effect[chan] = 0xff; break;
				case 6:
					if (note.param === 0) note.param = 0x4f;
					else if (note.param === 1) note.param = 0xf4;
					else note.effect = C.FX_NONE;
					break;
				}
			}
		}
		if (rows < 64) skip(fp, 3 * 8 * (64 - rows));
		for (let chan = 0; chan < 9; chan++) {
			const note = pattern[chan];
			if (note.effect === C.FX_SPEED) break;
			else if (!note.effect) { note.effect = C.FX_SPEED; note.param = patspeed[pat]; break; }
		}
		if (rows < 32) {
			for (let chan = 0; chan < 9; chan++) {
				const note = pattern[64 * (rows - 1) + chan];
				if (!note.effect) { note.effect = C.FX_PATTERNBREAK; note.param = 0; break; }
			}
		}
	}
	csf_insert_restart_pos(song, restartpos);
	for (let smp = 1; smp <= nsmp; smp++)
		if (song.samples[smp].length) read_sample(song.samples[smp], C.SF_LE | C.SF_M | C.SF_PCMU | C.SF_8, fp);
	song.initial_speed = 4;
	song.initial_tempo = 78;
	song.flags = C.SONG_ITOLDEFFECTS | C.SONG_LINEARSLIDES;
	song.pan_separation = 64;
	for (let n = 0; n < 8; n++) song.channels[n].panning = (n & 1) ? 256 : 0;
	for (let n = 8; n < 64; n++) song.channels[n].flags = C.CHN_MUTE;
	return LOAD_SUCCESS;
}

// ------------------------------------------------------------------------
// stm.c

function load_stm_pattern(pattern, fp) {
	for (let row = 0; row < 64; row++) {
		const base = row * 64;
		for (let chan = 0; chan < 4; chan++) {
			const n = pattern[base + chan];
			const v = [u8(fp), u8(fp), u8(fp), u8(fp)];
			if (v[0] < 251) n.note = (v[0] >> 4) * 12 + (v[0] & 0xf) + 37;
			n.instrument = v[1] >> 3;
			if (n.instrument > 31) n.instrument = 0;
			n.volparam = (v[1] & 0x7) + ((v[2] & 0xf0) >> 1);
			if (n.volparam <= 64) n.voleffect = C.VOLFX_VOLUME;
			else n.volparam = 0;
			n.param = v[3];
			n.effect = stm_effects[v[2] & 0x0f];
			handle_stm_effects(n);
		}
		for (let chan = 0; chan < 4; chan++) {
			const n = pattern[base + chan];
			if (n.effect === C.FX_SPEED) {
				const tempo = n.param;
				n.param >>= 4;
				handle_stm_tempo_pattern(pattern, base, tempo);
			}
		}
	}
}

export function fmt_stm_load_song(song, fp) {
	seek(fp, 20);
	const id = bytes(fp, 8), tmp = bytes(fp, 4);
	if (!((tmp[0] === 0x1a || tmp[0] === 0x02) && tmp[1] === 2 && tmp[2] === 2)) return LOAD_UNSUPPORTED;
	for (let n = 0; n < 8; n++) if (id[n] < 0x20 || id[n] > 0x7e) return LOAD_FORMAT_ERROR;
	const ids = String.fromCharCode(...id);
	const vs = `${clamp(tmp[2], 0, 9)}.${String(clamp(tmp[3], 0, 99)).padStart(2, '0')}`;
	if (ids === '!Scream!') song.tracker_id = tmp[3] > 20 ? 'Scream Tracker 2.2+ or compatible' : `Scream Tracker ${vs} or compatible`;
	else if (ids === 'BMOD2STM') song.tracker_id = 'BMOD2STM';
	else if (ids === 'WUZAMOD!') song.tracker_id = 'Wuzamod';
	else if (ids === 'SWavePro') song.tracker_id = `SoundWave Pro ${vs}`;
	else if (ids === '!Scrvrt!') song.tracker_id = 'Screamverter';
	else song.tracker_id = 'Unknown';
	seek(fp, 0);
	song.title = cstr(fp, 20);
	skip(fp, 12);
	let tempo = u8(fp);
	if (tmp[3] < 21) tempo = ((Math.trunc(tempo / 10)) << 4) + tempo % 10;
	song.initial_speed = (tempo >> 4) ? (tempo >> 4) : 1;
	song.initial_tempo = convert_stm_tempo_to_bpm(tempo);
	const npat = u8(fp);
	song.initial_global_volume = 2 * u8(fp);
	skip(fp, 13);
	if (npat > 64) return LOAD_FORMAT_ERROR;
	const para = new Uint16Array(C.MAX_SAMPLES);
	for (let n = 1; n <= 31; n++) {
		if (fp.position + 32 > fp.bytes.length) return LOAD_FORMAT_ERROR;
		const name = bytes(fp, 12).map(c => c === 0xff ? 0x20 : c);
		skip(fp, 2);
		const pcmpara = u16(fp), length = u16(fp), ls = u16(fp), le = u16(fp), vol = u8(fp);
		skip(fp, 1);
		const c5 = u16(fp);
		skip(fp, 6);
		const s = song.samples[n];
		s.filename = s.name = bstr(name, 12);
		s.length = length; s.loop_start = ls; s.loop_end = le;
		s.c5speed = c5; s.volume = vol * 4;
		if (ls < length && le !== 0xffff && ls < le) { s.flags |= C.CHN_LOOP; s.loop_end = clamp(le, ls, length); }
		para[n] = pcmpara;
	}
	const olsize = tmp[3] ? 128 : 64;
	song.orderlist.set(bytes(fp, olsize));
	for (let n = 0; n < olsize; n++) if (song.orderlist[n] >= 64) song.orderlist[n] = C.ORDER_LAST;
	for (let n = 0; n < npat; n++) load_stm_pattern(new_pattern(song, n, 64), fp);
	for (let n = 1; n <= 31; n++) {
		const s = song.samples[n];
		if (s.length < 3) s.length = 0;
		else { seek(fp, para[n] << 4); read_sample(s, C.SF_LE | C.SF_PCMS | C.SF_8 | C.SF_M, fp); }
	}
	let n;
	for (n = 0; n < 4; n++) song.channels[n].panning = ((n & 1) ? 64 : 0) * 4;
	for (; n < C.MAX_CHANNELS; n++) song.channels[n].flags |= C.CHN_MUTE;
	song.pan_separation = 64;
	song.flags = C.SONG_ITOLDEFFECTS | C.SONG_COMPATGXX | C.SONG_NOSTEREO;
	return LOAD_SUCCESS;
}

// ------------------------------------------------------------------------
// far.c

const far_effects = [C.FX_NONE, C.FX_PORTAMENTOUP, C.FX_PORTAMENTODOWN, C.FX_TONEPORTAMENTO, C.FX_RETRIG,
	C.FX_VIBRATO, C.FX_VIBRATO, C.FX_VOLUMESLIDE, C.FX_VOLUMESLIDE, C.FX_VIBRATO, C.FX_NONE, C.FX_PANNING,
	C.FX_SPECIAL, C.FX_NONE, C.FX_NONE, C.FX_SPEED];
function far_import_note(note, d) {
	if (d[0] > 0 && d[0] < 85) { note.note = d[0] + 36; note.instrument = d[1] + 1; }
	if (d[2] & 0x0f) { note.voleffect = C.VOLFX_VOLUME; note.volparam = (d[2] & 0x0f) << 2; }
	note.param = d[3] & 0xf;
	switch (d[3] >> 4) {
	case 3: note.param <<= 2; break;
	case 4: note.param = Math.trunc(6 / (1 + (note.param & 0xf))) + 1; break;
	case 6: case 7: case 0xb: note.param = (note.param << 4) & 0xff; break;
	case 0xa: note.voleffect = C.VOLFX_VOLUME; note.volparam = (note.param << 2) + 4; break;
	case 0xc: note.param = Math.trunc(6 / (1 + (note.param & 0xf))) + 1; note.param |= 0xd; break;
	}
	note.effect = far_effects[d[3] >> 4];
}
function far_read_header(fp) {
	const h = {};
	h.magic = bytes(fp, 4); h.title = bytes(fp, 40); h.eof = bytes(fp, 3);
	h.header_len = u16(fp); h.version = u8(fp); h.onoff = bytes(fp, 16);
	skip(fp, 9); h.default_speed = u8(fp); h.chn_panning = bytes(fp, 16);
	skip(fp, 4); h.message_len = u16(fp);
	if (eof(fp) || String.fromCharCode(...h.magic) !== 'FAR\xfe' || h.eof[0] !== 0x0d || h.eof[1] !== 0x0a || h.eof[2] !== 0x1a) return null;
	return h;
}
export function fmt_far_load_song(song, fp) {
	const h = far_read_header(fp);
	if (!h) return LOAD_UNSUPPORTED;
	song.title = bstr(h.title, 25);
	for (let n = 0; n < 16; n++) {
		song.channels[n].panning = SHORT_PANNING(h.chn_panning[n] & 0xf) * 4;
		if (!h.onoff[n]) song.channels[n].flags |= C.CHN_MUTE;
	}
	for (let n = 16; n < C.MAX_CHANNELS; n++) song.channels[n].flags |= C.CHN_MUTE;
	song.initial_speed = h.default_speed;
	song.initial_tempo = 80;
	song.tracker_id = 'Farandole Composer';
	read_lined_message(song, fp, h.message_len, 132);
	const orderlist = bytes(fp, 256);
	u8(fp);
	const nord = Math.min(u8(fp), C.MAX_ORDERS), restartpos = u8(fp);
	song.orderlist.set(orderlist.subarray(0, nord));
	song.orderlist.fill(C.ORDER_LAST, nord);
	const psize = []; for (let i = 0; i < 256; i++) psize.push(u16(fp));
	skip(fp, h.header_len - (869 + h.message_len));
	for (let pat = 0; pat < 256; pat++) {
		if (pat >= C.MAX_PATTERNS || psize[pat] < 2 + 16 * 4) { skip(fp, psize[pat]); continue; }
		let breakpos = u8(fp);
		u8(fp);
		const rows = Math.trunc((psize[pat] - 2) / 64);
		if (!rows) continue;
		const pattern = new_pattern(song, pat, rows);
		breakpos = breakpos && breakpos < rows - 2 ? breakpos + 1 : -1;
		for (let row = 0; row < rows; row++) {
			for (let chn = 0; chn < 16; chn++) far_import_note(pattern[row * 64 + chn], [u8(fp), u8(fp), u8(fp), u8(fp)]);
			if (row === breakpos) pattern[row * 64 + 16].effect = C.FX_PATTERNBREAK;
		}
	}
	csf_insert_restart_pos(song, restartpos);
	const data = bytes(fp, 8);
	for (let n = 0; n < 64; n++) {
		if (!(data[n >> 3] & (1 << (n & 7)))) continue;
		const s = song.samples[n + 1];
		const name = bytes(fp, 32), length = u32(fp); u8(fp);
		const volume = u8(fp), ls = u32(fp), le = u32(fp), type = u8(fp), loop = u8(fp);
		s.name = bstr(name, 25);
		s.length = length; s.loop_start = ls; s.loop_end = le;
		s.volume = (volume << 4) & 0xffff;
		if (type & 1) { s.length >>>= 1; s.loop_start >>>= 1; s.loop_end >>>= 1; }
		if (s.loop_end > s.loop_start && (loop & 8)) s.flags |= C.CHN_LOOP;
		s.c5speed = 16726;
		s.global_volume = 64;
		read_sample(s, C.SF_LE | C.SF_M | C.SF_PCMS | ((type & 1) ? C.SF_16 : C.SF_8), fp);
	}
	return LOAD_SUCCESS;
}

// ------------------------------------------------------------------------
// ult.c

const ult_efftrans = [C.FX_ARPEGGIO, C.FX_PORTAMENTOUP, C.FX_PORTAMENTODOWN, C.FX_TONEPORTAMENTO,
	C.FX_VIBRATO, C.FX_NONE, C.FX_NONE, C.FX_TREMOLO, C.FX_NONE, C.FX_OFFSET, C.FX_VOLUMESLIDE,
	C.FX_PANNING, C.FX_VOLUME, C.FX_PATTERNBREAK, C.FX_NONE, C.FX_SPEED];
function ult_translate_fx(e, p) {
	e &= 0xf;
	let fe = ult_efftrans[e];
	switch (e) {
	case 0: if (!p) fe = C.FX_NONE; break;
	case 3: if (!p) p = 1; break;
	case 0xa: if (p & 0xf0) p &= 0xf0; break;
	case 0xb: p = (p & 0xf) * 0x11; break;
	case 0xc: p >>= 2; break;
	case 0xd: p = (10 * (p >> 4) + (p & 0xf)) & 0xff; break;
	case 0xe:
		switch (p >> 4) {
		case 1: fe = C.FX_PORTAMENTOUP; p = 0xf0 | (p & 0xf); break;
		case 2: fe = C.FX_PORTAMENTODOWN; p = 0xf0 | (p & 0xf); break;
		case 8: fe = C.FX_SPECIAL; p = 0x60 | (p & 0xf); break;
		case 9: fe = C.FX_RETRIG; p &= 0xf; break;
		case 0xa: fe = C.FX_VOLUMESLIDE; p = ((p & 0xf) << 4) | 0xf; break;
		case 0xb: fe = C.FX_VOLUMESLIDE; p = 0xf0 | (p & 0xf); break;
		case 0xc: case 0xd: fe = C.FX_SPECIAL; break;
		}
		break;
	case 0xf: if (p > 0x2f) fe = C.FX_TEMPO; break;
	}
	return [fe, p];
}
// "Do that dance": fit two effects into the volume and effect columns
export function fit_two_effects(note) {
	let n;
	for (n = 0; n < 4; n++) {
		if (convert_voleffect_of(note, n >> 1)) { n = 5; break; }
		swap_effects(note);
	}
	let lost = 0;
	if (n < 5) {
		if (effect_weight[note.voleffect] > effect_weight[note.effect]) swap_effects(note);
		lost = 1;
		note.voleffect = 0;
	}
	if (!note.voleffect) note.volparam = 0;
	if (!note.effect) note.param = 0;
	return lost;
}
function read_ult_event(fp, note, lost) {
	let b = u8(fp), repeat = 1;
	if (b === 0xfc) { repeat = u8(fp); b = u8(fp); }
	note.note = (b > 0 && b < 97) ? b + 24 : C.NOTE_NONE;
	note.instrument = u8(fp);
	b = u8(fp);
	const ve = b & 0xf, fe = b >> 4;
	const vp = u8(fp), fpar = u8(fp);
	[note.voleffect, note.volparam] = ult_translate_fx(ve, vp);
	[note.effect, note.param] = ult_translate_fx(fe, fpar);
	if (note.voleffect === C.FX_OFFSET && note.effect === C.FX_OFFSET) {
		const off = ((note.volparam << 8) | note.param) >> 6;
		note.voleffect = C.FX_NONE;
		note.param = Math.min(off, 0xff);
	} else if (note.voleffect === C.FX_OFFSET) {
		note.volparam = Math.min(note.volparam * 4, 0xff);
	} else if (note.effect === C.FX_OFFSET) {
		note.param = Math.min(note.param * 4, 0xff);
	} else if (note.voleffect === note.effect) {
		note.effect = C.FX_NONE;
	}
	if (note.effect === C.FX_VOLUME || (note.effect === C.FX_NONE && note.voleffect !== C.FX_VOLUME)) swap_effects(note);
	lost.n += fit_two_effects(note);
	return repeat;
}
export function fmt_ult_load_song(song, fp) {
	if (cstr(fp, 14) !== 'MAS_UTrack_V00') return LOAD_UNSUPPORTED;
	let ver = u8(fp);
	if (ver < 0x31 || ver > 0x34) return LOAD_FORMAT_ERROR;
	ver -= 0x30;
	song.title = bstr(bytes(fp, 32), 25);
	song.tracker_id = `Ultra Tracker ${['<1.4', '1.4', '1.5', '1.6'][ver - 1]}`;
	song.flags |= C.SONG_COMPATGXX | C.SONG_ITOLDEFFECTS;
	const nmsg = getc(fp);
	if (nmsg < 0) return LOAD_FORMAT_ERROR;
	read_lined_message(song, fp, nmsg * 32, 32);
	const nsmp = getc(fp);
	if (nsmp < 0 || nsmp > C.MAX_SAMPLES) return LOAD_FORMAT_ERROR;
	for (let n = 0; n < nsmp; n++) {
		const s = song.samples[n + 1];
		const name = bytes(fp, 32), filename = bytes(fp, 12);
		const ls = u32(fp), le = u32(fp), ss = u32(fp), se = u32(fp), vol = u8(fp), fl = u8(fp);
		const speed = ver >= 4 ? u16(fp) * 2 : 8363 * 2;
		const finetune = s16(fp);
		if (eof(fp)) return LOAD_FORMAT_ERROR;
		s.name = bstr(name, 25);
		s.filename = bstr(filename, 12);
		if (se <= ss) continue;
		s.length = se - ss;
		s.loop_start = ls; s.loop_end = le;
		s.volume = vol;
		s.global_volume = 64;
		s.c5speed = speed;
		if (finetune) s.c5speed = Math.trunc(s.c5speed * Math.pow(2, finetune / (12.0 * 32768)));
		if (fl & 8) s.flags |= C.CHN_LOOP;
		if (fl & 16) s.flags |= C.CHN_PINGPONGLOOP;
		if (fl & 4) { s.flags |= C.CHN_16BIT; s.loop_start >>>= 1; s.loop_end >>>= 1; }
	}
	if (fp.position + 256 > fp.bytes.length) return LOAD_FORMAT_ERROR;
	song.orderlist.set(bytes(fp, 256).subarray(0, C.MAX_ORDERS));
	let nchn = getc(fp), npat = getc(fp);
	if (nchn < 0 || npat < 0) return LOAD_FORMAT_ERROR;
	nchn++; npat++;
	if (nchn > 32 || npat > C.MAX_PATTERNS) return LOAD_FORMAT_ERROR;
	let n;
	if (ver >= 3) for (n = 0; n < nchn; n++) song.channels[n].panning = ((u8(fp) & 0xf) << 2) + 2;
	else for (n = 0; n < nchn; n++) song.channels[n].panning = (n & 1) ? 48 : 16;
	for (; n < C.MAX_CHANNELS; n++) { song.channels[n].panning = 32; song.channels[n].flags = C.CHN_MUTE; }
	for (n = 0; n < C.MAX_CHANNELS; n++) song.channels[n].panning *= 4;
	for (let pat = 0; pat < npat; pat++) new_pattern(song, pat, 64);
	const lost = { n: 0 };
	let gxx = 0;
	for (let chn = 0; chn < nchn; chn++) {
		for (let pat = 0; pat < npat; pat++) {
			const pattern = song.patterns[pat];
			let row = 0;
			while (row < 64) {
				const ev = blank();
				let repeat = read_ult_event(fp, ev, lost);
				if (ev.effect === C.FX_TONEPORTAMENTO || ev.voleffect === C.VOLFX_TONEPORTAMENTO) gxx |= 1;
				if (repeat + row > 64) repeat = 64 - row;
				if (eof(fp) && !repeat) repeat = 64 - row;
				while (repeat-- > 0) { set_note(pattern[row * 64 + chn], ev); row++; }
			}
		}
	}
	if (gxx) log(4, ' Warning: Gxx effects may not be suitably imported');
	if (lost.n) log(4, ` Warning: ${lost.n} effect${lost.n === 1 ? '' : 's'} dropped`);
	for (let n = 0; n < nsmp; n++) {
		const s = song.samples[n + 1];
		read_sample(s, C.SF_LE | C.SF_M | C.SF_PCMS | ((s.flags & C.CHN_16BIT) ? C.SF_16 : C.SF_8), fp);
	}
	return LOAD_SUCCESS;
}

// ------------------------------------------------------------------------
// okt.c

const PROTRACKER_PANNING = n => ((((n) + 1) >> 1) & 1) * 256;
function okt_read_cmod(song, fp) {
	let cn = 0;
	for (let t = 0; t < 4; t++) {
		if (u8(fp) || u8(fp)) song.channels[cn++].panning = PROTRACKER_PANNING(t);
		song.channels[cn++].panning = PROTRACKER_PANNING(t);
	}
	for (let t = cn; t < C.MAX_CHANNELS; t++) song.channels[t].flags |= C.CHN_MUTE;
	return cn;
}
function okt_read_samp(song, fp, len, smpflag) {
	if (len % 32) log(4, ' Warning: Sample data is misaligned');
	len = Math.trunc(len / 32);
	if (len >= C.MAX_SAMPLES) { log(4, ' Warning: Too many samples in file'); len = C.MAX_SAMPLES - 1; }
	for (let n = 1; n <= len; n++) {
		const s = song.samples[n];
		const name = bytes(fp, 20), length = u32be(fp), ls = u16be(fp), ll = u16be(fp), vol = u16be(fp), mode = u16be(fp);
		s.name = bstr(name, 20);
		s.length = length & ~1;
		if (ll > 2 && ll + ls < s.length) {
			s.sustain_start = ls;
			s.sustain_end = ls + ll;
			if (s.sustain_start < s.length && s.sustain_end < s.length) s.flags |= C.CHN_SUSTAINLOOP;
			else s.sustain_start = 0;
		}
		s.loop_start *= 2; s.loop_end *= 2; s.sustain_start *= 2; s.sustain_end *= 2;
		s.volume = Math.min(vol, 64) * 4;
		smpflag[n] = (mode === 0 || mode === 2) ? C.SF_7 : C.SF_8;
		s.c5speed = 8287;
		s.global_volume = 64;
	}
}
function okt_read_pbod(song, fp, nchn, pat) {
	let effwarn = 0;
	const rows = clamp(u16be(fp), 1, 200);
	const pattern = new_pattern(song, pat, rows);
	for (let row = 0; row < rows; row++) {
		for (let chn = 0; chn < nchn; chn++) {
			const note = pattern[row * 64 + chn];
			note.note = u8(fp); note.instrument = u8(fp);
			const e = getc(fp);
			note.param = u8(fp);
			if (note.note && note.note <= 36) { note.note += 48; note.instrument++; }
			else note.instrument = 0;
			if (e < 0) return effwarn;
			switch (e) {
			case 0: break;
			case 1: note.effect = C.FX_PORTAMENTODOWN; note.param &= 0xf; break;
			case 2: note.effect = C.FX_PORTAMENTOUP; note.param &= 0xf; break;
			case 12: if (note.param) note.effect = C.FX_ARPEGGIO; break;
			case 13: if (note.param) { note.effect = C.FX_NOTESLIDEDOWN; note.param = 0x10 | Math.min(0xf, note.param); } break;
			case 30: if (note.param) { note.effect = C.FX_NOTESLIDEUP; note.param = 0x10 | Math.min(0xf, note.param); } break;
			case 21: if (note.param) { note.effect = C.FX_NOTESLIDEDOWN; note.param = 0x50 | Math.min(0xf, note.param); } break;
			case 17: if (note.param) { note.effect = C.FX_NOTESLIDEUP; note.param = 0x50 | Math.min(0xf, note.param); } break;
			case 15: note.effect = C.FX_SPECIAL; note.param = note.param ? 1 : 0; break;
			case 25: note.effect = C.FX_POSITIONJUMP; break;
			case 27: note.note = C.NOTE_OFF; note.instrument = note.effect = note.param = 0; break;
			case 28: note.effect = C.FX_SPEED; break;
			case 31:
				note.effect = C.FX_VOLUMESLIDE;
				switch (note.param >> 4) {
				case 4:
					if (note.param !== 0x40) { note.param &= 0xf; break; }
					// fallthrough
				case 0: case 1: case 2: case 3:
					note.voleffect = C.VOLFX_VOLUME; note.volparam = note.param;
					note.effect = C.FX_NONE; note.param = 0;
					break;
				case 5: note.param = (note.param & 0xf) << 4; break;
				case 6: note.param = 0xf0 | Math.min(note.param & 0xf, 0xe); break;
				case 7: note.param = (Math.min(note.param & 0xf, 0xe) << 4) | 0xf; break;
				default: note.effect = note.param = 0; break;
				}
				break;
			default:
				effwarn |= (e > 32) ? 1 : (1 << (e - 1));
				note.effect = C.FX_UNIMPLEMENTED;
				break;
			}
		}
	}
	return effwarn >>> 0;
}
export function fmt_okt_load_song(song, fp) {
	if (cstr(fp, 8) !== 'OKTASONG') return LOAD_UNSUPPORTED;
	let readflags = 0, plen = 0, npat = 0, nsmp = 1, nchn = 0, effwarn = 0;
	const patseek = [], smpseek = [], smpsize = new Uint32Array(C.MAX_SAMPLES + 2), smpflag = new Uint32Array(C.MAX_SAMPLES + 1);
	for (;;) {
		const tag = cstr(fp, 4), blklen = u32be(fp);
		if (eof(fp)) break;
		const nextpos = tell(fp) + blklen;
		switch (tag) {
		case 'CMOD': if (!(readflags & 1)) { readflags |= 1; nchn = okt_read_cmod(song, fp); } break;
		case 'SAMP': if (!(readflags & 2)) { readflags |= 2; okt_read_samp(song, fp, blklen, smpflag); } break;
		case 'SPEE': if (!(readflags & 4)) { readflags |= 4; song.initial_speed = clamp(u16be(fp), 1, 255); song.initial_tempo = 125; } break;
		case 'PLEN': if (!(readflags & 8)) { readflags |= 8; plen = u16be(fp); } break;
		case 'PATT': if (!(readflags & 16)) { readflags |= 16; song.orderlist.set(bytes(fp, Math.min(blklen, C.MAX_ORDERS))); } break;
		case 'PBOD': if (npat < C.MAX_PATTERNS) { if (blklen > 0) patseek[npat] = tell(fp); npat++; } break;
		case 'SBOD':
			if (nsmp < C.MAX_SAMPLES) { smpseek[nsmp] = tell(fp); smpsize[nsmp] = blklen; if (blklen) nsmp++; }
			break;
		}
		if (nextpos > fp.bytes.length) { log(4, ' Warning: Failed to seek (file truncated?)'); break; }
		seek(fp, nextpos);
	}
	if ((readflags & 5) !== 5) return LOAD_FORMAT_ERROR;
	for (let pat = 0; pat < npat; pat++) { seek(fp, patseek[pat] || 0); effwarn |= okt_read_pbod(song, fp, nchn, pat); }
	if (effwarn) {
		if (effwarn & 1) log(4, ' Warning: Out-of-range effects (junk data?)');
		for (let e = 2; e <= 32; e++)
			if (effwarn & (1 << (e - 1))) log(4, ` Warning: Unimplemented effect ${String.fromCharCode(e + (e < 10 ? 48 : 55))}xx`);
	}
	let sh, sd;
	for (sh = sd = 1; sh < C.MAX_SAMPLES && smpsize[sd]; sh++) {
		const s = song.samples[sh];
		if (!s.length) continue;
		if (s.length !== smpsize[sd]) {
			log(4, ` Warning: Sample ${sh}: header/data size mismatch (${s.length}/${smpsize[sd]})`);
			s.length = Math.min(smpsize[sd], s.length);
		}
		seek(fp, smpseek[sd]);
		read_sample(s, C.SF_BE | C.SF_M | C.SF_PCMS | smpflag[sh], fp);
		sd++;
	}
	for (; sh < C.MAX_SAMPLES; sh++)
		if (song.samples[sh].length) { log(4, ` Warning: Sample ${sh}: file truncated`); song.samples[sh].length = 0; }
	song.pan_separation = 64;
	if (plen < C.MAX_ORDERS) song.orderlist.fill(C.ORDER_LAST, plen);
	song.tracker_id = 'Amiga Oktalyzer';
	return LOAD_SUCCESS;
}

// ------------------------------------------------------------------------
// imf.c

const imf_efftrans = [C.FX_NONE, C.FX_SPEED, C.FX_TEMPO, C.FX_TONEPORTAMENTO, C.FX_TONEPORTAVOL, C.FX_VIBRATO,
	C.FX_VIBRATOVOL, C.FX_FINEVIBRATO, C.FX_TREMOLO, C.FX_ARPEGGIO, C.FX_PANNING, C.FX_PANNINGSLIDE, C.FX_VOLUME,
	C.FX_VOLUMESLIDE, C.FX_VOLUMESLIDE, C.FX_SPECIAL, C.FX_NOTESLIDEUP, C.FX_NOTESLIDEDOWN, C.FX_PORTAMENTOUP,
	C.FX_PORTAMENTODOWN, C.FX_PORTAMENTOUP, C.FX_PORTAMENTODOWN, C.FX_MIDI, C.FX_NONE, C.FX_OFFSET, C.FX_NONE,
	C.FX_KEYOFF, C.FX_RETRIG, C.FX_TREMOR, C.FX_POSITIONJUMP, C.FX_PATTERNBREAK, C.FX_GLOBALVOLUME,
	C.FX_GLOBALVOLSLIDE, C.FX_SPECIAL, C.FX_NONE, C.FX_NONE];
function import_imf_effect(note) {
	switch (note.effect) {
	case 0xe:
		if (note.param === 0) { /* nothing */ }
		else if (note.param === 0xf0) note.param = 0xef;
		else if (note.param === 0x0f) note.param = 0xfe;
		else if (note.param & 0xf0) note.param |= 0xf;
		else note.param |= 0xf0;
		break;
	case 0xf: note.param = 0x20 | Math.min(note.param >> 4, 0xf); break;
	case 0x14: case 0x15:
		if (note.param >> 4) note.param = 0xf0 | Math.min(note.param >> 4, 0xf);
		else note.param |= 0xe0;
		break;
	case 0x16: note.param = (255 - note.param) >> 1; break;
	case 0x1f: note.param = Math.min(note.param << 1, 0xff); break;
	case 0x21: {
		let n = 0;
		switch (note.param >> 4) {
		case 0: break;
		default: case 0x1: case 0xf: note.effect = 0; break;
		case 0x3: n = 0x20; break;
		case 0x5: n = 0x30; break;
		case 0x8: n = 0x40; break;
		case 0xa: n = 0xb0; break;
		case 0xb: n = 0xe0; break;
		case 0xc: case 0xd: break;
		case 0xe:
			switch (note.param & 0x0f) {
			case 0: case 1: note.param = 0x77; break;
			case 2: note.param = 0x79; break;
			case 3: note.param = 0x7b; break;
			}
			break;
		}
		if (n) note.param = n | (note.param & 0xf);
		break;
	}
	}
	note.effect = note.effect < 0x24 ? imf_efftrans[note.effect] : C.FX_NONE;
	if (note.effect === C.FX_VOLUME && note.voleffect === C.VOLFX_NONE) {
		note.voleffect = C.VOLFX_VOLUME; note.volparam = note.param;
		note.effect = C.FX_NONE; note.param = 0;
	}
}
function load_imf_pattern(song, pat, ignore, fp) {
	let lostfx = 0;
	u16(fp);
	const nrows = u16(fp);
	const pattern = new_pattern(song, pat, nrows);
	let row = 0;
	while (row < nrows) {
		if (eof(fp)) break;
		const mask = u8(fp);
		if (mask === 0) { row++; continue; }
		const channel = mask & 0x1f;
		const note = (ignore & (1 << channel)) ? blank() : pattern[row * 64 + channel];
		if (mask & 0x20) {
			note.note = u8(fp); note.instrument = u8(fp);
			if (note.note === 160) note.note = C.NOTE_OFF;
			else if (note.note === 255) note.note = C.NOTE_NONE;
			else {
				note.note = ((note.note >> 4) * 12 + (note.note & 0xf) + 12 + 1) & 0xff;
				if (!(note.note >= 1 && note.note <= 120)) note.note = C.NOTE_NONE;
			}
		}
		if ((mask & 0xc0) === 0xc0) {
			const e1c = u8(fp), e1d = u8(fp), e2c = u8(fp), e2d = u8(fp);
			if (e1c === 0xc) { note.volparam = Math.min(e1d, 0x40); note.voleffect = C.VOLFX_VOLUME; note.effect = e2c; note.param = e2d; }
			else if (e2c === 0xc) { note.volparam = Math.min(e2d, 0x40); note.voleffect = C.VOLFX_VOLUME; note.effect = e1c; note.param = e1d; }
			else if (e1c === 0xa) { note.volparam = Math.trunc(e1d * 64 / 255); note.voleffect = C.VOLFX_PANNING; note.effect = e2c; note.param = e2d; }
			else if (e2c === 0xa) { note.volparam = Math.trunc(e2d * 64 / 255); note.voleffect = C.VOLFX_PANNING; note.effect = e1c; note.param = e1d; }
			else { lostfx++; note.effect = e2c; note.param = e2d; }
		} else if (mask & 0xc0) {
			note.effect = u8(fp); note.param = u8(fp);
		}
		if (note.effect) import_imf_effect(note);
	}
	return lostfx;
}
const imf_envflags = [
	[C.ENV_VOLUME, C.ENV_VOLSUSTAIN, C.ENV_VOLLOOP],
	[C.ENV_PANNING, C.ENV_PANSUSTAIN, C.ENV_PANLOOP],
	[C.ENV_PITCH | C.ENV_FILTER, C.ENV_PITCHSUSTAIN, C.ENV_PITCHLOOP],
];
function load_imf_envelope(ins, env, imfins, e) {
	let min = 0;
	const shift = e === 0 ? 0 : 2, mirror = e === 2 ? 0xff : 0;
	const ie = imfins.env[e];
	env.nodes = clamp(ie.points, 2, 25);
	env.loop_start = ie.loop_start;
	env.loop_end = ie.loop_end;
	env.sustain_start = env.sustain_end = ie.sustain;
	for (let n = 0; n < env.nodes; n++) {
		const t = n < 16 ? imfins.nodes[e][n].tick : 0;
		const v = (((n < 16 ? imfins.nodes[e][n].value : 0) & 0xff) ^ mirror) >> shift;
		env.ticks[n] = Math.max(min, t);
		env.values[n] = Math.min(v, 64);
		min = t + 1;
	}
	if (ie.flags & 1) ins.flags |= imf_envflags[e][0];
	if (ie.flags & 2) ins.flags |= imf_envflags[e][1];
	if (ie.flags & 4) ins.flags |= imf_envflags[e][2];
}
export function fmt_imf_load_song(song, fp) {
	seek(fp, 0);
	const title = bytes(fp, 32);
	const ordnum = u16(fp), patnum = u16(fp), insnum = u16(fp), flags = u16(fp);
	skip(fp, 8);
	const tempo = u8(fp), bpm = u8(fp), master = u8(fp), amp = u8(fp);
	skip(fp, 8);
	if (cstr(fp, 4) !== 'IM10') return LOAD_UNSUPPORTED;
	const chans = [];
	for (let i = 0; i < 32; i++) { skip(fp, 12); const chorus = u8(fp), reverb = u8(fp), panning = u8(fp), status = u8(fp); chans.push({ chorus, reverb, panning, status }); }
	const orderlist = bytes(fp, 256);
	if (eof(fp)) return LOAD_UNSUPPORTED;
	if (ordnum > C.MAX_ORDERS || patnum > C.MAX_PATTERNS || insnum > C.MAX_INSTRUMENTS) return LOAD_FORMAT_ERROR;
	song.title = bstr(title, 25);
	song.tracker_id = 'Imago Orpheus';
	if (flags & 1) song.flags |= C.SONG_LINEARSLIDES;
	song.flags |= C.SONG_INSTRUMENTMODE;
	song.initial_speed = tempo;
	song.initial_tempo = bpm;
	song.initial_global_volume = 2 * master;
	song.mixing_volume = amp;
	let ignore = 0, n;
	for (n = 0; n < 32; n++) {
		song.channels[n].panning = Math.trunc(chans[n].panning * 64 / 255) * 4;
		switch (chans[n].status) {
		case 0: break;
		case 1: song.channels[n].flags |= C.CHN_MUTE; break;
		case 2: song.channels[n].flags |= C.CHN_MUTE; ignore |= (1 << n); break;
		default: return LOAD_FORMAT_ERROR;
		}
	}
	for (; n < C.MAX_CHANNELS; n++) song.channels[n].flags |= C.CHN_MUTE;
	if (chans[0].status === 0) {
		for (n = 1; n < 16; n++) if (chans[n].status !== 1) break;
		if (n === 16) for (n = 1; n < 16; n++) song.channels[n].flags &= ~C.CHN_MUTE;
	}
	for (n = 0; n < ordnum; n++) song.orderlist[n] = orderlist[n] === 0xff ? C.ORDER_SKIP : orderlist[n];
	let lostfx = 0;
	for (n = 0; n < patnum; n++) lostfx += load_imf_pattern(song, n, ignore, fp);
	if (lostfx) log(4, ` Warning: ${lostfx} effect${lostfx === 1 ? '' : 's'} dropped`);
	let firstsample = 1, si = 1;
	for (n = 0; n < insnum; n++) {
		const imfins = { name: bytes(fp, 32), map: bytes(fp, 120) };
		skip(fp, 8);
		imfins.nodes = [0, 1, 2].map(() => Array.from({ length: 16 }, () => ({ tick: u16(fp), value: u16(fp) })));
		imfins.env = [0, 1, 2].map(() => { const r = { points: u8(fp), sustain: u8(fp), loop_start: u8(fp), loop_end: u8(fp), flags: u8(fp) }; skip(fp, 3); return r; });
		imfins.fadeout = u16(fp); imfins.smpnum = u16(fp);
		if (cstr(fp, 4) !== 'II10' || eof(fp)) break;
		const ins = song.instruments[n + 1] = csf_allocate_instrument();
		ins.name = bstr(imfins.name, 25);
		if (imfins.smpnum) for (let s = 12; s < 120; s++) { ins.note_map[s] = s + 1; ins.sample_map[s] = (firstsample + imfins.map[s - 12]) & 0xff; }
		ins.fadeout = imfins.fadeout;
		ins.global_volume = 128;
		load_imf_envelope(ins, ins.vol_env, imfins, 0);
		load_imf_envelope(ins, ins.pan_env, imfins, 1);
		load_imf_envelope(ins, ins.pitch_env, imfins, 2);
		if (!(ins.flags & C.ENV_VOLUME)) {
			const e = ins.vol_env;
			e.ticks[0] = 0; e.ticks[1] = 1; e.values[0] = 64; e.values[1] = 0; e.nodes = 2;
			e.sustain_start = e.sustain_end = 0;
			ins.flags |= C.ENV_VOLUME | C.ENV_VOLSUSTAIN;
		}
		let s;
		for (s = 0; s < imfins.smpnum; s++) {
			const name = bytes(fp, 13); skip(fp, 3);
			const length = u32(fp), ls = u32(fp), le = u32(fp), c5 = u32(fp), vol = u8(fp), pan = u8(fp);
			skip(fp, 14);
			const sf = u8(fp);
			skip(fp, 5 + 2 + 4);
			if (cstr(fp, 4) !== 'IS10') break;
			if (si > C.MAX_SAMPLES) { skip(fp, length); continue; }
			const sample = song.samples[si];
			let sflags = C.SF_LE | C.SF_M | C.SF_PCMS;
			sample.filename = sample.name = bstr(name, 12);
			sample.length = length; sample.loop_start = ls; sample.loop_end = le;
			sample.c5speed = c5;
			sample.volume = vol * 4;
			sample.panning = pan;
			if (sf & 1) sample.flags |= C.CHN_LOOP;
			if (sf & 2) sample.flags |= C.CHN_PINGPONGLOOP;
			if (sf & 4) { sflags |= C.SF_16; sample.length >>>= 1; sample.loop_start >>>= 1; sample.loop_end >>>= 1; }
			else sflags |= C.SF_8;
			if (sf & 8) sample.flags |= C.CHN_PANNING;
			read_sample(sample, sflags, fp);
			si++;
		}
		firstsample += imfins.smpnum;
	}
	song.midi_config = { start: '', stop: '', tick: '', note_on: '', note_off: '', set_volume: '', set_panning: '',
		set_bank: '', set_program: '', sfx: Array.from({ length: 16 }, (_, i) => i ? '' : 'F0F000z'), zxx: Array(128).fill('') };
	song.flags |= C.SONG_EMBEDMIDICFG;
	return LOAD_SUCCESS;
}

// slurp_seek semantics: fails (and does not move) past the end of the data
const cseek = (fp, pos) => { if (pos < 0 || pos > fp.bytes.length) return -1; fp.position = pos; return 0; };

// ------------------------------------------------------------------------
// stx.c

export function fmt_stx_load_song(song, fp) {
	seek(fp, 20);
	const b2 = bytes(fp, 8);
	seek(fp, 60);
	const tag = cstr(fp, 4);
	for (let n = 0; n < 8; n++) if (!(b2[n] >= 0x20 && b2[n] <= 0x7e)) return LOAD_UNSUPPORTED;
	if (tag !== 'SCRM') return LOAD_UNSUPPORTED;
	seek(fp, 0);
	song.title = cstr(fp, 20);
	skip(fp, 8);
	const first_pattern_size = u16(fp);
	skip(fp, 2);
	const para_patptr = u16(fp), para_smptr = u16(fp), para_chnptr = u16(fp);
	skip(fp, 4);
	song.initial_global_volume = u8(fp) << 1;
	const tempo = u8(fp);
	song.initial_speed = (tempo >> 4) ? (tempo >> 4) : 6;
	song.initial_tempo = convert_stm_tempo_to_bpm(tempo);
	skip(fp, 4);
	const npat = u16(fp);
	let nsmp = u16(fp);
	const nord = u16(fp);
	if (nsmp > 31) nsmp = 31;
	if (nord > C.MAX_ORDERS || nsmp > C.MAX_SAMPLES || npat > C.MAX_PATTERNS) return LOAD_FORMAT_ERROR;
	song.flags = C.SONG_ITOLDEFFECTS | C.SONG_NOSTEREO;
	cseek(fp, (para_chnptr << 4) + 32);
	for (let n = 0; n < nord; n++) { song.orderlist[n] = u8(fp); skip(fp, 4); }
	cseek(fp, para_smptr << 4);
	const para_smp = []; for (let n = 0; n < nsmp; n++) para_smp.push(u16(fp));
	cseek(fp, para_patptr << 4);
	const para_pat = []; for (let n = 0; n < npat; n++) para_pat.push(u16(fp));
	const para_sdata = new Uint32Array(C.MAX_SAMPLES);
	for (let n = 0; n < nsmp; n++) {
		const sample = song.samples[n + 1];
		cseek(fp, para_smp[n] << 4);
		const type = u8(fp);
		sample.filename = bstr(bytes(fp, 12).map(c => c === 0xff ? 0x20 : c), 12);
		const b = bytes(fp, 3);
		if (type === 1) {
			para_sdata[n] = b[1] | (b[2] << 8) | (b[0] << 16);
			sample.length = u32(fp); sample.loop_start = u32(fp); sample.loop_end = u32(fp);
			sample.volume = u8(fp) * 4;
			skip(fp, 2);
			if (u8(fp) & 1) sample.flags |= C.CHN_LOOP;
		} else {
			skip(fp, 12);
			sample.volume = u8(fp) * 4;
			skip(fp, 3);
		}
		sample.c5speed = u32(fp);
		skip(fp, 12);
		sample.name = bstr(bytes(fp, 25).map(c => c === 0xff ? 0x20 : c), 25);
		sample.vib_type = sample.vib_rate = sample.vib_depth = sample.vib_speed = 0;
		sample.global_volume = 64;
	}
	let subversion = 1;
	if (first_pattern_size !== 0x1a) {
		cseek(fp, para_pat[0] << 4);
		if (u16(fp) === first_pattern_size) subversion = 0;
	}
	for (let n = 0; n < npat; n++) {
		if (!para_pat[n]) continue;
		cseek(fp, para_pat[n] << 4);
		if (!subversion) skip(fp, 2);
		const pattern = song.patterns[n] = csf_allocate_pattern(64);
		let row = 0;
		while (row < 64) {
			const mask = getc(fp);
			if (mask < 0) { log(4, ` Warning: Pattern ${n}: file truncated`); break; }
			if (!mask) { row++; continue; }
			const idx = 64 * row + (mask & 31), note = pattern[idx];
			if (mask & 32) {
				note.note = u8(fp); note.instrument = u8(fp);
				if (note.note === 255) note.note = C.NOTE_NONE;
				else if (note.note === 254) note.note = C.NOTE_CUT;
				else note.note = (((note.note >> 4) + 2) * 12 + (note.note & 0xf) + 13) & 0xff;
			}
			if (mask & 64) {
				note.voleffect = C.VOLFX_VOLUME;
				note.volparam = u8(fp);
				if (note.volparam === 255) { note.voleffect = C.VOLFX_NONE; note.volparam = 0; }
				else if (note.volparam > 64) note.volparam = 64;
			}
			if (mask & 128) {
				note.effect = stm_effects[u8(fp) & 0xf];
				note.param = u8(fp);
				handle_stm_effects(note);
			}
			for (let chn = 0; chn < 32 && idx + chn < pattern.length; chn++) {
				const cn = pattern[idx + chn];
				if (cn.effect === C.FX_SPEED) {
					const param = cn.param;
					cn.param >>= 4;
					handle_stm_tempo_pattern(pattern, idx, param);
				}
			}
		}
	}
	for (let n = 0; n < nsmp; n++) {
		const sample = song.samples[n + 1];
		if (sample.length < 3) continue;
		cseek(fp, para_sdata[n] << 4);
		read_sample(sample, C.SF_LE | C.SF_PCMS | C.SF_8 | C.SF_M, fp);
	}
	let n;
	for (n = 0; n < 4; n++) song.channels[n].panning = ((n & 1) ? 64 : 0) * 4;
	for (; n < 64; n++) song.channels[n].flags |= C.CHN_MUTE;
	song.pan_separation = 64;
	song.tracker_id = `ST Music Interface Kit (1.${subversion})`;
	return LOAD_SUCCESS;
}

// ------------------------------------------------------------------------
// sfx.c

const sfxfmts = [
	{ tagpos: 124, tag: 'SO31', nsmp: 31, dunno: 4, id: 'SoundFX 2' },
	{ tagpos: 124, tag: 'SONG', nsmp: 31, dunno: 0, id: 'SoundFX 2 (?)' },
	{ tagpos: 60, tag: 'SONG', nsmp: 15, dunno: 0, id: 'SoundFX' },
];
export function fmt_sfx_load_song(song, fp) {
	let fmt = null;
	for (const f of sfxfmts) { seek(fp, f.tagpos); if (cstr(fp, 4) === f.tag) { fmt = f; break; } }
	if (!fmt) return LOAD_UNSUPPORTED;
	const nsmp = fmt.nsmp;
	seek(fp, 0);
	const smpsize = []; for (let n = 0; n < nsmp; n++) smpsize.push(u32be(fp));
	skip(fp, 4);
	let tmp = u16(fp);
	if (!tmp) return LOAD_UNSUPPORTED;
	tmp = Math.trunc(14565 * 122 / (((tmp & 0xff) << 8) | (tmp >> 8))) & 0xffff;
	song.initial_tempo = clamp(tmp, 31, 255);
	skip(fp, 14);
	for (let n = 0; n < nsmp; n++) {
		const sample = song.samples[n + 1];
		sample.name = cstr(fp, 22);
		u16(fp);
		sample.length = smpsize[n];
		song.samples[n].c5speed = finetune_table[(u8(fp) & 0xf) ^ 8]; // (sic) samples[n], as in sfx.c
		sample.volume = Math.min(u8(fp), 64) * 4;
		sample.global_volume = 64;
		sample.loop_start = u16be(fp);
		const ll = u16be(fp) * 2;
		if (ll > 2) { sample.loop_end = sample.loop_start + ll; sample.flags |= C.CHN_LOOP; }
		else sample.loop_start = sample.loop_end = 0;
	}
	const nord = Math.min(u8(fp), 127), restart = u8(fp);
	song.orderlist.set(bytes(fp, nord));
	skip(fp, 128 - nord);
	let npat = 0;
	for (let n = 0; n < nord; n++) if (song.orderlist[n] > npat) npat = song.orderlist[n];
	npat++;
	skip(fp, fmt.dunno);
	let effwarn = 0;
	for (let pat = 0; pat < npat; pat++) {
		const pattern = new_pattern(song, pat, 64);
		for (let n = 0; n < 64; n++) {
			for (let chan = 0; chan < 4; chan++) {
				const note = pattern[n * 64 + chan];
				const p = [u8(fp), u8(fp), u8(fp), u8(fp)];
				mod_import_note(p, note);
				if (p[0] === 0xff) {
					if (p[1] === 0xfc) { note.note = C.NOTE_NONE; note.instrument = 0; pattern[n * 64 + 4].effect = C.FX_PATTERNBREAK; }
					else if (p[1] === 0xfe) { note.note = C.NOTE_CUT; note.instrument = 0; }
				}
				switch (note.effect) {
				case 0: break;
				case 1: note.effect = C.FX_ARPEGGIO; break;
				case 2:
					if (note.param >> 4) { note.effect = C.FX_PORTAMENTODOWN; note.param >>= 4; }
					else if (note.param & 0xf) { note.effect = C.FX_PORTAMENTOUP; note.param &= 0xf; }
					else note.effect = 0;
					break;
				case 5: note.effect = C.FX_VOLUMESLIDE; note.param = (note.param & 0xf) << 4; break;
				case 6:
					if (note.param > 64) note.param = 64;
					note.voleffect = C.VOLFX_VOLUME; note.volparam = 64 - note.param;
					note.effect = 0; note.param = 0;
					break;
				default:
					effwarn |= (1 << note.effect);
					note.effect = C.FX_UNIMPLEMENTED;
					break;
				}
			}
		}
	}
	for (let n = 0; n < 16; n++) if (effwarn & (1 << n)) log(4, ` Warning: Unimplemented effect ${n.toString(16).toUpperCase()}xx`);
	if (restart < npat) csf_insert_restart_pos(song, restart);
	for (let n = 0; n < nsmp; n++) {
		const sample = song.samples[n + 1];
		if (sample.length <= 2) continue;
		read_sample(sample, C.SF_8 | C.SF_LE | C.SF_PCMS | C.SF_M, fp);
	}
	song.flags = C.SONG_ITOLDEFFECTS | C.SONG_COMPATGXX;
	let n;
	for (n = 0; n < 4; n++) song.channels[n].panning = PROTRACKER_PANNING(n);
	for (; n < C.MAX_CHANNELS; n++) song.channels[n].flags = C.CHN_MUTE;
	song.tracker_id = fmt.id;
	song.pan_separation = 64;
	return LOAD_SUCCESS;
}

// ------------------------------------------------------------------------
// iff.c (the parts the loaders use)

export const IFF_CHUNK_SIZE_LE = 1, IFF_CHUNK_ALIGNED = 2;
export function iff_chunk_peek_ex(fp, flags) {
	if (fp.position + 8 > fp.bytes.length) return null;
	const id = cstr({ ...fp }, 4).padEnd(4, '\0');
	const raw = bytes(fp, 4);
	const idstr = String.fromCharCode(...raw);
	const size = (flags & IFF_CHUNK_SIZE_LE) ? u32(fp) : u32be(fp);
	const offset = tell(fp);
	void id;
	if (cseek(fp, offset + ((flags & IFF_CHUNK_ALIGNED) ? ((size + 1) & ~1) : size)) !== 0) return null;
	return { id: idstr, size, offset };
}
export function iff_chunk_read(chunk, fp, size) {
	const pos = tell(fp);
	seek(fp, chunk.offset);
	const r = bytes(fp, Math.min(chunk.size, size));
	seek(fp, pos);
	return r;
}
export function iff_read_sample(chunk, fp, smp, flags, offset) {
	const pos = tell(fp);
	if (cseek(fp, chunk.offset + offset)) return 0;
	const r = read_sample(smp, flags, fp);
	seek(fp, pos);
	return r;
}
// run fn with reads limited to `len` bytes from the chunk start (slurp_limit)
function with_limit(fp, start, len, fn) {
	const pos = tell(fp), lim = fp.limit;
	seek(fp, start);
	fp.limit = Math.min(start + len, fp.bytes.length);
	try { return fn(); } finally { fp.limit = lim; seek(fp, pos); }
}

// ------------------------------------------------------------------------
// dsm.c

function dsm_process_pattern(fp, chunk, pattern, nchn, mismatch) {
	const start = tell(fp);
	seek(fp, chunk.offset);
	if (fp.position + 2 > fp.bytes.length) return 0;
	const hdr_len = u16(fp);
	const pos0 = tell(fp), lim = fp.limit;
	fp.limit = pos0 + Math.min(chunk.size - 2, hdr_len);
	const fail = () => {
		log(4, ` WARNING: Offset (${tell(fp)}) passed length (${fp.limit}) while parsing pattern!`);
		fp.limit = lim; seek(fp, start); return 0;
	};
	let row = 0;
	while (row < 64) {
		const mask = getc(fp);
		if (mask < 0) return fail();
		if (!mask) { row++; continue; }
		const chn = mask & 0x0f;
		if (chn > nchn) mismatch.n = Math.max(chn, mismatch.n);
		const note = pattern[64 * row + chn];
		if (mask & 0x80) { const c = getc(fp); if (c < 0) return fail(); if (c <= 168) note.note = c + 12; }
		if (mask & 0x40) { const c = getc(fp); if (c < 0) return fail(); note.instrument = c; }
		if (mask & 0x20) {
			const c = getc(fp); if (c < 0) return fail();
			if (c !== 0xff) { note.voleffect = C.VOLFX_VOLUME; note.volparam = Math.min(c, 64); }
		}
		if (mask & 0x10) {
			const e = getc(fp), p = getc(fp);
			if (e < 0 || p < 0) return fail();
			note.effect = e; note.param = p;
			csf_import_mod_effect(note, 0);
			if (note.effect === C.FX_PANNING) {
				if (note.param <= 0x80) note.param <<= 1;
				else if (note.param === 0xa4) { note.effect = C.FX_SPECIAL; note.param = 0x91; }
			}
		}
	}
	fp.limit = lim; seek(fp, start);
	return 1;
}
export function fmt_dsm_load_song(song, fp) {
	const riff = cstr(fp, 4); skip(fp, 4); const dsmf = cstr(fp, 4);
	if (riff !== 'RIFF' || dsmf !== 'DSMF') return LOAD_UNSUPPORTED;
	let s = 0, p = 0, nord = 0, nsmp = 0, npat = 0, nchn = 0, headers = 0;
	let chnpan = new Uint8Array(16);
	const mismatch = { n: 0 };
	let chunk;
	while ((chunk = iff_chunk_peek_ex(fp, IFF_CHUNK_SIZE_LE))) {
		switch (chunk.id) {
		case 'SONG': {
			const ok = with_limit(fp, chunk.offset, chunk.size, () => {
				if (fp.position + 192 > fp.limit) return null;
				const h = { title: bytes(fp, 28), version: u16(fp), flags: u16(fp), pad: u32(fp),
					ordnum: u16(fp), smpnum: u16(fp), patnum: u16(fp), chnnum: u16(fp),
					gvol: u8(fp), mvol: u8(fp), is: u8(fp), it: u8(fp), chnpan: bytes(fp, 16), orders: bytes(fp, 128) };
				return h;
			}) || { title: new Uint8Array(28), ordnum: 0, smpnum: 0, patnum: 0, chnnum: 0, gvol: 0, mvol: 0, is: 0, it: 0, chnpan: new Uint8Array(16), orders: new Uint8Array(128) };
			nord = ok.ordnum; nsmp = ok.smpnum; npat = ok.patnum; nchn = ok.chnnum;
			if (nord > C.MAX_ORDERS || nsmp > C.MAX_SAMPLES || npat > C.MAX_PATTERNS || nchn > C.MAX_CHANNELS) return LOAD_UNSUPPORTED;
			song.initial_global_volume = ok.gvol << 1;
			song.mixing_volume = ok.mvol >> 1;
			song.initial_speed = ok.is;
			song.initial_tempo = ok.it;
			song.title = bstr(ok.title, 25);
			chnpan = ok.chnpan;
			song.orderlist.set(ok.orders.subarray(0, Math.min(nord, 128)));
			headers++;
			break;
		}
		case 'INST': {
			if (s > C.MAX_SAMPLES) return LOAD_UNSUPPORTED;
			const inst = with_limit(fp, chunk.offset, chunk.size, () => ({
				filename: bytes(fp, 13), flags: u16(fp), volume: u8(fp), length: u32(fp), loop_start: u32(fp),
				loop_end: u32(fp), address_ptr: u32(fp), c5speed: u16(fp), period: u16(fp), name: bytes(fp, 28) }));
			const sample = song.samples[s + 1];
			if (sample) {
				let flags = C.SF_LE | C.SF_8 | C.SF_M;
				if (inst.flags & 1) sample.flags |= C.CHN_LOOP;
				if (inst.flags & 2) flags |= C.SF_PCMS;
				else if (inst.flags & 0x40) flags |= C.SF_PCMD;
				else flags |= C.SF_PCMU;
				sample.name = bstr(inst.name, 25);
				sample.filename = bstr(inst.filename, 12);
				sample.length = inst.length; sample.loop_start = inst.loop_start; sample.loop_end = inst.loop_end;
				sample.c5speed = inst.c5speed;
				sample.volume = inst.volume * 4;
				iff_read_sample(chunk, fp, sample, flags, 64);
			}
			s++;
			break;
		}
		case 'PATT': {
			if (p > C.MAX_PATTERNS) return LOAD_UNSUPPORTED;
			if (p < C.MAX_PATTERNS) {
				song.patterns[p] = csf_allocate_pattern(64);
				dsm_process_pattern(fp, chunk, song.patterns[p], nchn, mismatch);
			}
			p++;
			break;
		}
		}
	}
	if (!headers) log(4, ' WARNING: No SONG chunk found! (invalid DSM file??)');
	else if (headers > 1) log(4, ` WARNING: Multiple (${headers}) SONG chunks found!`);
	if (s !== nsmp) log(4, ` WARNING: # of samples (${s}) different than expected (${nsmp})`);
	if (p !== npat) log(4, ` WARNING: # of patterns (${p}) different than expected (${npat})`);
	if (mismatch.n && mismatch.n !== nchn) log(4, ` WARNING: # of channels (${mismatch.n}) different than expected (${nchn})`);
	let n;
	for (n = 0; n < nchn; n++) if (chnpan[n & 15] <= 0x80) song.channels[n].panning = chnpan[n & 15] << 1;
	for (; n < C.MAX_CHANNELS; n++) song.channels[n].flags |= C.CHN_MUTE;
	song.pan_separation = 128;
	song.flags = C.SONG_ITOLDEFFECTS | C.SONG_COMPATGXX;
	song.tracker_id = 'Digital Sound Interface Kit';
	return LOAD_SUCCESS;
}

// ------------------------------------------------------------------------
// compression.c: MDL sample decompression

function mdl_decompress(smp, fp, sixteen) {
	const startpos = tell(fp);
	if (fp.position + 8 > fp.bytes.length) return 0;
	const v = u32(fp);
	let bitbuf = u32(fp), bitnum = 32;
	const bits = n => {
		const r = bitbuf & ((1 << n) - 1);
		bitbuf >>>= n; bitnum -= n;
		if (bitnum <= 24) { bitbuf = (bitbuf | (getc(fp) << bitnum)) >>> 0; bitnum += 8; }
		return r;
	};
	const len = Math.min(smp.length, C.MAX_SAMPLE_LENGTH);
	const data = sixteen ? new Int16Array(len) : new Int8Array(len);
	let dlt = 0;
	for (let j = 0; j < len; j++) {
		const low = sixteen ? bits(8) : 0;
		const sign = bits(1);
		let hi;
		if (bits(1)) hi = bits(3);
		else { hi = 8; while (!bits(1)) hi = (hi + 0x10) & 0xff; hi = (hi + bits(4)) & 0xff; }
		if (sign) hi = ~hi & 0xff;
		dlt = (dlt + hi) & 0xff;
		data[j] = sixteen ? (dlt << 8) | low : dlt;
	}
	cseek(fp, startpos + v + 4);
	smp.length = len;
	smp.flags = (smp.flags & ~(C.CHN_16BIT | C.CHN_STEREO)) | (sixteen ? C.CHN_16BIT : 0);
	smp.data = data;
	app.csf_adjust_sample_loop(smp);
	return v;
}

// ------------------------------------------------------------------------
// mdl.c

const mdl_efftrans = [C.FX_NONE, C.FX_PORTAMENTOUP, C.FX_PORTAMENTODOWN, C.FX_TONEPORTAMENTO, C.FX_VIBRATO,
	C.FX_ARPEGGIO, C.FX_NONE, C.FX_TEMPO, C.FX_PANNING, C.FX_SETENVPOSITION, C.FX_NONE, C.FX_POSITIONJUMP,
	C.FX_GLOBALVOLUME, C.FX_PATTERNBREAK, C.FX_SPECIAL, C.FX_SPEED, C.FX_VOLUMESLIDE, C.FX_VOLUMESLIDE,
	C.FX_RETRIG, C.FX_TREMOLO, C.FX_TREMOR, C.FX_NONE];
const mdl_autovib = [C.VIB_SINE, C.VIB_RAMP_DOWN, C.VIB_SQUARE, C.VIB_SINE];
function mdl_translate_fx(e, p) {
	if (e > 21) e = 0;
	let fe = mdl_efftrans[e];
	switch (e) {
	case 7: p = Math.max(p, 0x20); break;
	case 8: p = Math.min(p << 1, 0xff); break;
	case 0xd: p = (10 * (p >> 4) + (p & 0xf)) & 0xff; break;
	case 0xe:
		switch (p >> 4) {
		case 0: case 3: case 5: case 8: fe = C.FX_NONE; break;
		case 1: fe = C.FX_PANNINGSLIDE; p = ((Math.max(p & 0xf, 0xe) << 4) | 0xf) & 0xff; break;
		case 2: fe = C.FX_PANNINGSLIDE; p = 0xf0 | Math.max(p & 0xf, 0xe); break;
		case 4: p = 0x30 | (p & 0xf); break;
		case 6: p = 0xb0 | (p & 0xf); break;
		case 7: p = 0x40 | (p & 0xf); break;
		case 9: fe = C.FX_RETRIG; p &= 0xf; break;
		case 0xa: fe = C.FX_GLOBALVOLSLIDE; p = 0xf0 & (((p & 0xf) + 1) << 3); break;
		case 0xb: fe = C.FX_GLOBALVOLSLIDE; p = ((p & 0xf) + 1) >> 1; break;
		case 0xc: case 0xd: case 0xe: break;
		case 0xf: fe = C.FX_OFFSET; break;
		}
		break;
	case 0x10:
		if (p < 0xe0) { p >>= 2; if (p > 0x0f) p = 0x0f; p <<= 4; }
		else if (p < 0xf0) p = (((p & 0x0f) << 2) | 0x0f) & 0xff;
		else p = ((p << 4) | 0x0f) & 0xff;
		break;
	case 0x11:
		if (p < 0xe0) { p >>= 2; if (p > 0x0f) p = 0x0f; }
		else if (p < 0xf0) p = ((p & 0x0f) >> 2) | 0xf0;
		break;
	}
	return [fe, p];
}
function cram_mdl_effects(note, vol, e1, e2, p1, p2) {
	let lostfx = 0;
	if (e2 >= 1 && e2 <= 6) e2 += 15;
	[e1, p1] = mdl_translate_fx(e1, p1);
	[e2, p2] = mdl_translate_fx(e2, p2);
	if (e1 === C.FX_OFFSET) { p1 = (p1 & 0xf) ? 0xff : p2; if (e2 === C.FX_OFFSET) e2 = C.FX_NONE; }
	else if (e2 === C.FX_OFFSET) p2 = (p2 & 0xf) ? 0xff : 0;
	if (vol) { note.voleffect = C.VOLFX_VOLUME; note.volparam = (vol + 2) >> 2; }
	if (e2 === C.FX_VOLUMESLIDE && p1 === 0) {
		if (e1 === C.FX_TONEPORTAMENTO) { e1 = C.FX_NONE; e2 = C.FX_TONEPORTAVOL; }
		else if (e1 === C.FX_VIBRATO) { e1 = C.FX_NONE; e2 = C.FX_VIBRATOVOL; }
	}
	if (e1 === C.FX_NONE) { /* easy */ }
	else if (e2 === C.FX_NONE) { e2 = e1; p2 = p1; e1 = C.FX_NONE; }
	else if (e1 === e2 && e1 !== C.FX_SPECIAL) e1 = C.FX_NONE;
	else if (!vol) {
		for (let n = 0; n < 4; n++) {
			const t = { voleffect: e1, volparam: p1 };
			if (convert_voleffect_of(t, n >> 1)) { note.voleffect = t.voleffect; note.volparam = t.volparam; e1 = C.FX_NONE; break; }
			[e1, e2] = [e2, e1]; [p1, p2] = [p2, p1];
		}
	}
	if (e1 !== C.FX_NONE && e2 !== C.FX_NONE) {
		lostfx++;
		if (effect_weight[e1] < effect_weight[e2]) { e2 = e1; p2 = p1; }
	}
	note.effect = e2; note.param = p2;
	return lostfx;
}
function mdl_read_info(song, fp) {
	if (fp.position + 91 > fp.bytes.length) return 0;
	const title = trim(bstr(bytes(fp, 32), 31));
	skip(fp, 20);
	const numorders = u16(fp), repeatpos = u16(fp), globalvol = u8(fp), speed = u8(fp), tempo = u8(fp);
	const chanpan = bytes(fp, 32);
	song.title = title.slice(0, 25);
	song.initial_global_volume = (globalvol + 1) >> 1;
	song.initial_speed = speed ? speed : 1;
	song.initial_tempo = Math.max(tempo, 31);
	let n;
	for (n = 0; n < 32; n++) {
		song.channels[n].panning = (chanpan[n] & 127) << 1;
		if (chanpan[n] & 128) song.channels[n].flags |= C.CHN_MUTE;
	}
	for (; n < C.MAX_CHANNELS; n++) { song.channels[n].panning = 128; song.channels[n].flags |= C.CHN_MUTE; }
	const songlen = Math.min(numorders, C.MAX_ORDERS - 1);
	for (n = 0; n < songlen; n++) { const b = u8(fp); song.orderlist[n] = b < C.MAX_PATTERNS ? b : C.ORDER_SKIP; }
	return repeatpos;
}
function mdl_read_patterns(song, fp, v0) {
	const list = [];
	const npat = Math.min(u8(fp), C.MAX_PATTERNS);
	for (let pat = 0; pat < npat; pat++) {
		let nchn = 32, rows = 64;
		if (!v0) { nchn = u8(fp); rows = u8(fp) + 1; skip(fp, 16); }
		new_pattern(song, pat, rows);
		for (let chn = 0; chn < nchn; chn++) {
			const trknum = u16(fp);
			if (trknum) list.push({ track: trknum, rows, pat, chn });
		}
	}
	return list;
}
function mdl_read_track(fp, track, st) {
	let row = 0;
	while (row < 256 && !eof(fp)) {
		let b = getc(fp);
		if (b < 0) break;
		let x = b >> 2;
		const y = b & 3;
		switch (y) {
		case 0: row += x + 1; break;
		case 1:
			if (row > 0) { do { set_note(track[row], track[row - 1]); } while (++row < 256 && x--); }
			break;
		case 2: if (row > x) set_note(track[row], track[x]); row++; break;
		case 3: {
			const nab = bit => { if (!(x & bit)) return false; b = getc(fp); if (b < 0) { st.truncated = 1; return false; } return true; };
			const t = track[row];
			t.note = nab(1) ? (b > 120 ? C.NOTE_OFF : b) : 0;
			t.instrument = nab(2) ? (b >= C.MAX_INSTRUMENTS ? 0 : b) : 0;
			const vol = nab(4) ? b : 0;
			let e1 = 0, e2 = 0;
			if (nab(8)) { e1 = b & 0xf; e2 = b >> 4; }
			const p1 = nab(16) ? b : 0;
			const p2 = nab(32) ? b : 0;
			st.lostfx += cram_mdl_effects(t, vol, e1, e2, p1, p2);
			row++;
			break;
		}
		}
	}
}
function mdl_read_tracks(fp, tracks) {
	const ntrks = u16(fp), st = { lostfx: 0, truncated: 0 };
	for (let trk = 1; trk <= ntrks; trk++) {
		const startpos = tell(fp);
		const bytesleft = u16(fp);
		if (!bytesleft) continue;
		tracks[trk] = Array.from({ length: 256 }, blank);
		const sub = { bytes: fp.bytes, position: tell(fp), limit: Math.min(tell(fp) + bytesleft, fp.bytes.length) };
		mdl_read_track(sub, tracks[trk], st);
		cseek(fp, startpos + 2 + bytesleft);
	}
	if (st.lostfx) log(4, ` Warning: ${st.lostfx} effect${st.lostfx === 1 ? '' : 's'} dropped`);
	if (st.truncated) log(4, ' Warning: expected more track data than found (file truncated?)');
}
function mdl_read_instruments(song, fp) {
	let nins = u8(fp);
	while (nins--) {
		const insnum = u8(fp);
		let firstnote = 0, nsmp = u8(fp);
		if (insnum === 0 || insnum > C.MAX_INSTRUMENTS) { cseek(fp, 32 + 14 * nsmp); continue; } // (sic) SEEK_SET
		if (!song.instruments[insnum]) song.instruments[insnum] = csf_allocate_instrument();
		const ins = song.instruments[insnum];
		ins.name = bstr(bytes(fp, 25), 25);
		skip(fp, 7);
		while (nsmp--) {
			const h = { smpnum: u8(fp), lastnote: u8(fp), volume: u8(fp), volenv_flags: u8(fp), panning: u8(fp),
				panenv_flags: u8(fp), fadeout: u16(fp), vibspeed: u8(fp), vibdepth: u8(fp), vibsweep: u8(fp), vibtype: u8(fp) };
			skip(fp, 1);
			h.freqenv_flags = u8(fp);
			if (h.smpnum === 0 || h.smpnum > C.MAX_SAMPLES) continue;
			if (!song.instruments[h.smpnum]) song.instruments[h.smpnum] = csf_allocate_instrument();
			const sins = song.instruments[h.smpnum], smp = song.samples[h.smpnum];
			h.lastnote = Math.min(h.lastnote, 119);
			for (let note = firstnote; note <= h.lastnote; note++) ins.sample_map[note] = h.smpnum;
			firstnote = h.lastnote + 1;
			sins.vol_env.nodes = h.volenv_flags & 63;
			sins.pan_env.nodes = h.panenv_flags & 63;
			sins.pitch_env.nodes = h.freqenv_flags & 63;
			if (h.volenv_flags & 128) sins.flags |= C.ENV_VOLUME;
			if (h.panenv_flags & 128) sins.flags |= C.ENV_PANNING;
			if (h.freqenv_flags & 128) sins.flags |= C.ENV_PITCH;
			sins.fadeout = h.fadeout < 0x2000 ? (h.fadeout + 1) >> 1 : 0xffff;
			smp.volume = h.volume;
			smp.panning = ((Math.min(h.panning, 127) + 1) >> 1) * 4;
			if (h.panenv_flags & 64) smp.flags |= C.CHN_PANNING;
			smp.vib_speed = h.vibspeed; smp.vib_depth = h.vibdepth; smp.vib_rate = h.vibsweep;
			smp.vib_type = mdl_autovib[h.vibtype & 3];
		}
	}
}
function mdl_read_sampleinfo(song, fp, packtype, volhack) {
	let nsmp = u8(fp);
	while (nsmp--) {
		const smpnum = u8(fp), name = bytes(fp, 32), filename = bytes(fp, 8);
		const c4speed = u32(fp), length = u32(fp), loopstart = u32(fp), looplen = u32(fp), volume = u8(fp), flags = u8(fp);
		if (smpnum === 0 || smpnum > C.MAX_SAMPLES) continue;
		const smp = song.samples[smpnum];
		smp.name = bstr(name, 25);
		smp.filename = bstr(filename, 8);
		smp.c5speed = (c4speed * 2) >>> 0;
		smp.length = length; smp.loop_start = loopstart; smp.loop_end = looplen;
		smp.volume = volhack ? volume : 256;
		if (smp.loop_end) { smp.loop_end = (smp.loop_end + smp.loop_start) >>> 0; smp.flags |= C.CHN_LOOP; }
		if (flags & 1) { smp.flags |= C.CHN_16BIT; smp.length >>>= 1; smp.loop_start >>>= 1; smp.loop_end >>>= 1; }
		if (flags & 2) smp.flags |= C.CHN_PINGPONGLOOP;
		packtype[smpnum] = (flags >> 2) & 3;
		smp.global_volume = 64;
	}
}
function mdl_read_envelopes(fp, envs, flags) {
	let nenv = u8(fp);
	while (nenv--) {
		const envnum = u8(fp);
		const nodes = []; for (let i = 0; i < 15; i++) nodes.push([u8(fp), u8(fp)]);
		const eflags = u8(fp), loop = u8(fp);
		if (envnum > 63) continue;
		if (!envs[envnum]) envs[envnum] = { flags: 0, data: { ticks: new Int32Array(32), values: new Uint8Array(32), nodes: 0, loop_start: 0, loop_end: 0, sustain_start: 0, sustain_end: 0 } };
		const env = envs[envnum].data;
		env.nodes = 15;
		let tick = -nodes[0][0];
		for (let n = 0; n < 15; n++) {
			if (!nodes[n][0]) { env.nodes = Math.max(n, 2); break; }
			tick += nodes[n][0];
			env.ticks[n] = tick;
			env.values[n] = Math.min(nodes[n][1], 64);
		}
		env.loop_start = loop & 0xf;
		env.loop_end = loop >> 4;
		env.sustain_start = env.sustain_end = eflags & 0xf;
		envs[envnum].flags = 0;
		if (eflags & 16) envs[envnum].flags |= flags & (C.ENV_VOLSUSTAIN | C.ENV_PANSUSTAIN | C.ENV_PITCHSUSTAIN);
		if (eflags & 32) envs[envnum].flags |= flags & (C.ENV_VOLLOOP | C.ENV_PANLOOP | C.ENV_PITCHLOOP);
	}
}
function mdl_copy_envelope(ins, key, envs, enable) {
	const env = envs[ins[key].nodes];
	if (env) {
		ins.flags |= env.flags;
		const d = env.data;
		ins[key] = { ticks: Int32Array.from(d.ticks), values: Uint8Array.from(d.values), nodes: d.nodes,
			loop_start: d.loop_start, loop_end: d.loop_end, sustain_start: d.sustain_start, sustain_end: d.sustain_end };
	} else {
		ins.flags &= ~enable;
		ins[key].nodes = 2;
	}
}
export function fmt_mdl_load_song(song, fp) {
	if (cstr(fp, 4) !== 'DMDL') return LOAD_UNSUPPORTED;
	const fmtver = u8(fp);
	const volenvs = [], panenvs = [], freqenvs = [], packtype = new Uint8Array(C.MAX_SAMPLES), tracks = [];
	let datapos = -1, restartpos = -1, readflags = 0, patlist = [];
	while (!eof(fp)) {
		const have = fp.bytes.length - fp.position;
		if (have < 2) { if (have) log(4, ' Block tag incomplete (file truncated?)'); break; }
		const tag = cstr(fp, 2);
		if (fp.bytes.length - fp.position < 4) { log(4, ' Block length incomplete (file truncated?)'); break; }
		const blklen = u32(fp);
		const nextpos = tell(fp) + blklen;
		const once = bit => { if (readflags & bit) return false; readflags |= bit; return true; };
		switch (tag) {
		case 'IN': if (once(1)) restartpos = mdl_read_info(song, fp); break;
		case 'ME': if (once(2)) {
			const m = bytes(fp, Math.min(blklen, MAX_MESSAGE));
			song.message = bstr(m).replace(/\r/g, '\n');
		} break;
		case 'PA': if (once(4)) patlist = mdl_read_patterns(song, fp, !(fmtver >> 4)); break;
		case 'TR': if (once(8)) mdl_read_tracks(fp, tracks); break;
		case 'II': if (once(16)) mdl_read_instruments(song, fp); break;
		case 'VE': if (once(32)) mdl_read_envelopes(fp, volenvs, C.ENV_VOLLOOP | C.ENV_VOLSUSTAIN); break;
		case 'PE': if (once(64)) mdl_read_envelopes(fp, panenvs, C.ENV_PANLOOP | C.ENV_PANSUSTAIN); break;
		case 'FE': if (once(128)) mdl_read_envelopes(fp, freqenvs, C.ENV_PITCHLOOP | C.ENV_PITCHSUSTAIN); break;
		case 'IS': if (once(256)) mdl_read_sampleinfo(song, fp, packtype, !!(fmtver >> 4)); break;
		case 'SA': if (once(512)) datapos = tell(fp); break;
		}
		if (cseek(fp, nextpos) !== 0) { log(4, ' Warning: Failed to seek (file truncated?)'); break; }
	}
	if (!(readflags & 16)) {
		for (let n = 1; n < C.MAX_SAMPLES; n++) if (song.samples[n].length) {
			song.instruments[n] = csf_allocate_instrument();
			song.instruments[n].name = song.samples[n].name;
		}
	}
	if (readflags & 256) {
		if (datapos !== -1) {
			cseek(fp, datapos);
			for (let n = 1; n < C.MAX_SAMPLES; n++) {
				const smp = song.samples[n];
				if (!packtype[n] && !smp.length) continue;
				if (packtype[n] > 2) { log(4, ` Warning: Sample ${n}: unknown packing type ${packtype[n]}`); packtype[n] = 0; }
				else if (packtype[n] === ((smp.flags & C.CHN_16BIT) ? 1 : 2)) log(4, ` Warning: Sample ${n}: bit width / pack type mismatch`);
				if (!smp.length) continue;
				if (packtype[n]) mdl_decompress(smp, fp, !!(smp.flags & C.CHN_16BIT));
				else read_sample(smp, C.SF_LE | C.SF_M | C.SF_PCMS | ((smp.flags & C.CHN_16BIT) ? C.SF_16 : C.SF_8), fp);
			}
		} else for (let n = 1; n < C.MAX_SAMPLES; n++) song.samples[n].length = 0;
	}
	if (readflags & 8) {
		if (fmtver >> 4) {
			for (let trk = 1; trk < 65536 && tracks[trk]; trk++) {
				let cnote = 1;
				for (const t of tracks[trk]) {
					if (t.note >= 1 && t.note <= 120) cnote = t.note;
					if (t.instrument) {
						const ins = song.instruments[t.instrument];
						t.instrument = ins ? ins.sample_map[cnote - 1] : 0;
					}
				}
			}
		}
		for (const pat of patlist) {
			const t = tracks[pat.track];
			if (!t) continue;
			const pattern = song.patterns[pat.pat];
			for (let n = 0; n < pat.rows; n++) set_note(pattern[n * 64 + pat.chn], t[n]);
		}
	}
	for (let n = 1; n < C.MAX_INSTRUMENTS; n++) {
		const ins = song.instruments[n];
		if (!ins) continue;
		mdl_copy_envelope(ins, 'vol_env', volenvs, C.ENV_VOLUME);
		mdl_copy_envelope(ins, 'pan_env', panenvs, C.ENV_PANNING);
		mdl_copy_envelope(ins, 'pitch_env', freqenvs, C.ENV_PITCH);
		const ve = ins.vol_env;
		if (ins.flags & C.ENV_VOLUME) {
			if (!(ins.flags & C.ENV_VOLLOOP)) ve.loop_start = ve.loop_end = ve.nodes - 1;
			if (!(ins.flags & C.ENV_VOLSUSTAIN)) ve.sustain_start = ve.sustain_end = ve.nodes - 1;
			ins.flags |= C.ENV_VOLLOOP | C.ENV_VOLSUSTAIN;
		}
		if (ins.fadeout === 0xffff) {
			if (!(ins.flags & C.ENV_VOLUME)) {
				ve.ticks[0] = 0; ve.values[0] = 64;
				ve.sustain_start = ve.sustain_end = 0;
				ins.flags |= C.ENV_VOLUME | C.ENV_VOLSUSTAIN;
			}
			const se = ve.sustain_end;
			ve.nodes = se + 2;
			ve.ticks[se + 1] = ve.ticks[se] + 1;
			ve.values[se + 1] = 0;
			ins.fadeout = 0;
		}
		const smp = song.samples[n].data ? n : 0;
		for (let note = 0; note < 120; note++) { ins.sample_map[note] = smp; ins.note_map[note] = note + 1; }
	}
	if (restartpos > 0) csf_insert_restart_pos(song, restartpos);
	song.flags |= C.SONG_ITOLDEFFECTS | C.SONG_COMPATGXX | C.SONG_INSTRUMENTMODE | C.SONG_LINEARSLIDES;
	song.tracker_id = 'Digitrakker ' + (fmtver === 0x11 ? '3' : fmtver === 0x10 ? '2.3' : fmtver === 0 ? '2.0 - 2.2b' : 'v?.?');
	return LOAD_SUCCESS;
}

// ------------------------------------------------------------------------
// psm.c: "new" PSM (and Sinaria) and PSM16

const psm_convert_portamento = (p, sinaria) => sinaria ? p : p < 4 ? (p | 0xf0) : (p >> 2);
function psm_import_effect(note, fp, sinaria) {
	if (fp.position + 2 > fp.bytes.length) return 0;
	let e0 = u8(fp), e1 = u8(fp);
	const set = (fx, p) => { note.effect = fx; note.param = p & 0xff; };
	switch (e0) {
	case 0x01: set(C.FX_VOLUMESLIDE, (sinaria ? e1 << 4 : (e1 & 0x1e) << 3) | 0x0f); break;
	case 0x02: set(C.FX_VOLUMESLIDE, (sinaria ? e1 << 4 : e1 << 3) & 0x0f); break;
	case 0x03: set(C.FX_VOLUMESLIDE, (sinaria ? e1 : e1 >> 1) | 0xf0); break;
	case 0x04: set(C.FX_VOLUMESLIDE, sinaria ? (e1 & 0x0f) : e1 < 2 ? (e1 | 0xf0) : ((e1 >> 1) & 0x0f)); break;
	case 0x0b: set(C.FX_PORTAMENTOUP, 0xf0 | psm_convert_portamento(e1, sinaria)); break;
	case 0x0c: set(C.FX_PORTAMENTOUP, psm_convert_portamento(e1, sinaria)); break;
	case 0x0d: set(C.FX_PORTAMENTODOWN, 0xf0 | psm_convert_portamento(e1, sinaria)); break;
	case 0x0e: set(C.FX_PORTAMENTODOWN, psm_convert_portamento(e1, sinaria)); break;
	case 0x0f: set(C.FX_TONEPORTAMENTO, sinaria ? e1 : e1 >> 2); break;
	case 0x10: set(C.FX_TONEPORTAVOL, e1 & 0xf0); break;
	case 0x12: set(C.FX_TONEPORTAVOL, (e1 >> 4) & 0x0f); break;
	case 0x11: set(C.FX_SPECIAL, 0x10 | (e1 & 1)); break;
	case 0x13: set(C.FX_SPECIAL, e1); break;
	case 0x15: set(C.FX_VIBRATO, e1); break;
	case 0x16: set(C.FX_SPECIAL, 0x30 | (e1 & 0x0f)); break;
	case 0x17: set(C.FX_VIBRATOVOL, e1 & 0xf0); break;
	case 0x18: set(C.FX_VIBRATOVOL, e1); break;
	case 0x1f: set(C.FX_TREMOLO, e1); break;
	case 0x20: set(C.FX_SPECIAL, 0x40 | (e1 & 0x0f)); break;
	case 0x29:
		if (fp.position + 2 > fp.bytes.length) return 0;
		e0 = u8(fp); e1 = u8(fp);
		set(C.FX_OFFSET, e0);
		break;
	case 0x2a: set(C.FX_RETRIG, e1); break;
	case 0x2b: set(C.FX_SPECIAL, 0xc0 | e1); break;
	case 0x2c: set(C.FX_SPECIAL, 0xd0 | e1); break;
	case 0x33: set(C.FX_POSITIONJUMP, e1 >> 1); cseek(fp, tell(fp) + 1); break;
	case 0x34: set(C.FX_PATTERNBREAK, 0); break;
	case 0x35: set(C.FX_SPECIAL, 0xb0 | (e1 & 0x0f)); break;
	case 0x36: set(C.FX_SPECIAL, 0xe0 | (e1 & 0x0f)); break;
	case 0x3d: set(C.FX_SPEED, e1); break;
	case 0x3e: set(C.FX_TEMPO, e1); break;
	case 0x47: set(C.FX_ARPEGGIO, e1); break;
	case 0x48: set(C.FX_SPECIAL, 0x20 | (e1 & 0x0f)); break;
	case 0x49: set(C.FX_SPECIAL, 0x80 | (e1 & 0x0f)); break;
	default: set(C.FX_NONE, e1); break;
	}
	return 1;
}
const strtol10 = str => { const m = /^\s*([+-]?\d+)/.exec(str); return m ? parseInt(m[1], 10) : 0; };
function psm_read_pattern_index(fp, st) {
	if (fp.position + 4 > fp.bytes.length) return -1;
	let id = bytes(fp, 4), offset = 1;
	if (String.fromCharCode(...id) === 'PATT') {
		if (fp.position + 4 > fp.bytes.length) return -1;
		id = bytes(fp, 4);
		st.sinaria = 1;
		offset = 0;
	}
	return strtol10(bstr(id.subarray(offset), 4 - offset));
}
function psm_read_pattern(c, fp, song, st) {
	st.nchns = 0;
	seek(fp, c.offset);
	if (fp.position + 4 > fp.bytes.length) return 0;
	const length = u32(fp);
	if (length !== c.size || length < 8) return 0;
	const index = psm_read_pattern_index(fp, st);
	if (index < 0 || index >= C.MAX_PATTERNS) return 0;
	if (fp.position + 2 > fp.bytes.length) return 0;
	const rows = u16(fp);
	const pattern = song.patterns[index] = csf_allocate_pattern(rows);
	song.pattern_size[index] = rows;
	for (let i = 0; i < rows; i++) {
		if (fp.position + 2 > fp.bytes.length) return 0;
		const row_size = u16(fp);
		if (row_size <= 2) continue;
		const start = tell(fp);
		while (tell(fp) + 3 - 2 < start + row_size - 2) {
			if (fp.position + 2 > fp.bytes.length) return 0;
			const f = u8(fp), ch = u8(fp);
			if (ch >= C.MAX_CHANNELS) continue;
			st.nchns = Math.max(st.nchns, ch);
			const note = pattern[i * 64 + ch];
			if (f & 0x80) {
				const n = getc(fp);
				if (n < 0) return 0;
				if (st.sinaria) note.note = n < 85 ? n + 36 : n;
				else note.note = n === 0xff ? C.NOTE_CUT : n < 129 ? ((n & 0x0f) + (12 * (n >> 4) + 13)) & 0xff : C.NOTE_NONE;
			}
			if (f & 0x40) { const v = getc(fp); if (v < 0) return 0; note.instrument = (v + 1) & 0xff; }
			if (f & 0x20) { const v = getc(fp); if (v < 0) return 0; note.voleffect = C.VOLFX_VOLUME; note.volparam = (Math.min(v, 127) + 1) >> 1; }
			if ((f & 0x10) && !psm_import_effect(note, fp, st.sinaria)) return 0;
		}
	}
	return 1;
}
export function fmt_psm_load_song(song, fp) {
	if (cstr(fp, 4) !== 'PSM ') return LOAD_UNSUPPORTED;
	skip(fp, 4);
	if (cstr(fp, 4) !== 'FILE') return LOAD_UNSUPPORTED;
	const song_chunks = [], dsmp = [], pbod = [];
	let titl = null, c;
	while ((c = iff_chunk_peek_ex(fp, IFF_CHUNK_SIZE_LE))) {
		if (c.id === 'SONG') { if (song_chunks.length < C.MAX_ORDERS) song_chunks.push(c); }
		else if (c.id === 'DSMP') { if (dsmp.length < C.MAX_SAMPLES) dsmp.push(c); }
		else if (c.id === 'PBOD') { if (pbod.length < C.MAX_PATTERNS) pbod.push(c); }
		else if (c.id === 'TITL') titl = c;
	}
	if (titl) song.title = bstr(iff_chunk_read(titl, fp, 32), 32);
	const st = { sinaria: 0, nchns: 0 };
	for (const pc of pbod) psm_read_pattern(pc, fp, song, st);
	const sinaria = () => st.sinaria;
	for (const dc of dsmp) {
		seek(fp, dc.offset);
		const need = n => fp.position + n <= fp.bytes.length;
		if (!need(9)) break;
		const flags = u8(fp), filename = bytes(fp, 8);
		cseek(fp, tell(fp) + (sinaria() ? 8 : 4));
		if (!need(33)) break;
		const name = bytes(fp, 33);
		cseek(fp, tell(fp) + 6);
		if (!need(2)) break;
		const w = u16(fp);
		if (w > C.MAX_SAMPLES || w + 1 > C.MAX_SAMPLES) continue;
		const smp = song.samples[w + 1];
		smp.flags = 0;
		if (flags & 0x80) smp.flags |= C.CHN_LOOP;
		smp.name = bstr(name, 32);
		smp.filename = bstr(filename, 8);
		if (!need(12)) break;
		smp.length = u32(fp);
		smp.loop_start = u32(fp);
		const dw = u32(fp);
		if (sinaria()) smp.loop_end = dw;
		else if (dw) smp.loop_end = (dw + 1) >>> 0;
		cseek(fp, tell(fp) + (sinaria() ? 2 : 1));
		cseek(fp, tell(fp) + 1);
		if (!need(1)) break;
		smp.volume = (u8(fp) + 1) * 2;
		cseek(fp, tell(fp) + 4);
		if (sinaria()) { if (!need(2)) break; smp.c5speed = u16(fp); }
		else { if (!need(4)) break; smp.c5speed = u32(fp); }
		cseek(fp, tell(fp) + (sinaria() ? 16 : 19));
		read_sample(smp, C.SF_LE | C.SF_M | C.SF_8 | C.SF_PCMD, fp);
	}
	let norders = 0;
	for (let i = 0; i < song_chunks.length; i++) {
		const sc = song_chunks[i];
		let oplh = null, ppan = null;
		seek(fp, sc.offset);
		cseek(fp, tell(fp) + 10);
		const subsong_channels = getc(fp);
		if (subsong_channels < 0) break;
		if (norders > 0) {
			if (norders + 1 > C.MAX_ORDERS) break;
			song.orderlist[norders++] = C.ORDER_LAST;
		}
		while ((c = iff_chunk_peek_ex(fp, IFF_CHUNK_SIZE_LE)) && tell(fp) <= sc.offset + sc.size) {
			if (c.id === 'OPLH') oplh = c;
			else if (c.id === 'PPAN') ppan = c;
		}
		if (oplh && oplh.size >= 9) {
			let chunk_count = 0, first_order_chunk = 0xffffffff;
			seek(fp, oplh.offset);
			cseek(fp, tell(fp) + 2);
			while (tell(fp) <= oplh.offset + oplh.size) {
				const opcode = getc(fp);
				if (opcode < 0 || !opcode) break;
				switch (opcode) {
				case 0x01: {
					let index = psm_read_pattern_index(fp, st);
					if (index < 0) break;
					if (norders + 1 > C.MAX_ORDERS) break;
					if (index === 0xff) index = C.ORDER_LAST;
					else if (index === 0xfe) index = C.ORDER_SKIP;
					song.orderlist[norders++] = index & 0xff;
					if (first_order_chunk === 0xffffffff) first_order_chunk = chunk_count;
					break;
				}
				case 0x02: cseek(fp, tell(fp) + 4); break;
				case 0x03: case 0x04: {
					const restart = fp.position + 2 <= fp.bytes.length ? u16(fp) : 0;
					if (restart >= first_order_chunk) csf_insert_restart_pos(song, restart - first_order_chunk);
					if (opcode === 0x03) cseek(fp, tell(fp) + 1);
					break;
				}
				case 0x06: cseek(fp, tell(fp) + 1); break;
				case 0x05: {
					if (fp.position + 2 > fp.bytes.length) break;
					const x0 = u8(fp), x1 = u8(fp);
					if (x0 < C.MAX_CHANNELS) song.channels[x0].panning = x1;
					break;
				}
				case 0x07: { const v = getc(fp); if (v >= 0) song.initial_speed = v; break; }
				case 0x08: { const v = getc(fp); if (v >= 0) song.initial_tempo = v; break; }
				case 0x0c: {
					if (fp.position + 6 > fp.bytes.length) break;
					const t = bytes(fp, 6);
					if (!(t[0] === 0 && t[1] === 0xff && t[2] === 0 && t[3] === 0 && t[4] === 1 && t[5] === 0)) return LOAD_UNSUPPORTED;
					break;
				}
				case 0x0d: {
					if (fp.position + 3 > fp.bytes.length) break;
					const x = bytes(fp, 3);
					if (x[0] < C.MAX_CHANNELS) song.channels[x[0]].panning = x[1];
					break;
				}
				case 0x0e: {
					if (fp.position + 2 > fp.bytes.length) break;
					const x0 = u8(fp), x1 = u8(fp);
					if (x0 < C.MAX_CHANNELS) song.channels[x0].volume = (x1 >> 2) + 1;
					break;
				}
				default:
					log(4, ` PSM/OPLH: unknown opcode: ${opcode.toString(16)} at ${chunk_count}`);
					return LOAD_UNSUPPORTED;
				}
				chunk_count++;
			}
		}
		if (ppan && !i && ppan.size >= subsong_channels * 2) {
			seek(fp, ppan.offset);
			if (fp.position + subsong_channels * 2 > fp.bytes.length) break;
			const xx = new Uint8Array(C.MAX_CHANNELS * 2);
			xx.set(bytes(fp, subsong_channels * 2).subarray(0, xx.length));
			for (let j = 0; j < st.nchns; j++) {
				switch (xx[j * 2]) {
				case 0: song.channels[j].panning = xx[j * 2 + 1]; break;
				case 1: song.channels[j].panning = 128; song.channels[j].flags = C.CHN_SURROUND; break;
				case 2: song.channels[j].panning = 128; break;
				}
			}
		}
	}
	song.pan_separation = 128;
	song.flags = C.SONG_ITOLDEFFECTS | C.SONG_COMPATGXX;
	song.tracker_id = st.sinaria ? 'Epic MegaGames MASI (New Version / Sinaria)' : 'Epic MegaGames MASI (New Version)';
	return LOAD_SUCCESS;
}

function psm16_verify_header(fp) {
	if (cstr(fp, 4) !== 'PSM\xfe') return 0;
	skip(fp, 59);
	if (getc(fp) !== 0x1a) return 0;
	let b = getc(fp);
	if (b < 0 || (b & 3)) return 0;
	b = getc(fp);
	if (b !== 0x10 && b !== 0x01) return 0;
	if (getc(fp) !== 0) return 0;
	skip(fp, 1);
	b = getc(fp);
	if (!(b >= 32 && b <= 255)) return 0;
	skip(fp, 1);
	for (let i = 0; i < 4; i++) { if (fp.position + 2 > fp.bytes.length) return 0; const w = u16(fp); if (!(w >= 1 && w <= 255)) return 0; }
	for (let i = 0; i < 2; i++) { if (fp.position + 2 > fp.bytes.length) return 0; const w = u16(fp); if (!(w >= 1 && w <= 32)) return 0; }
	return 1;
}
function psm16_check_parapointer(fp, ptr, magic) {
	if (ptr < 4) return 0;
	if (cseek(fp, ptr - 4)) return 0;
	return fp.position + 4 <= fp.bytes.length && cstr(fp, 4) === magic;
}
export function fmt_psm16_load_song(song, fp) {
	if (!psm16_verify_header(fp)) return LOAD_UNSUPPORTED;
	seek(fp, 4);
	song.title = bstr(bytes(fp, 32), 32);
	skip(fp, 28);
	skip(fp, 3);
	const speed = getc(fp); if (speed < 0) return LOAD_UNSUPPORTED;
	const tempo = getc(fp); if (tempo < 0) return LOAD_UNSUPPORTED;
	const master_volume = getc(fp); if (master_volume < 0) return LOAD_UNSUPPORTED;
	song.initial_speed = speed;
	song.initial_tempo = tempo;
	song.mixing_volume = master_volume === 255 ? 48 : master_volume;
	skip(fp, 2);
	const norders = u16(fp), npatterns = u16(fp);
	let nsamples = u16(fp);
	const nchnplay = u16(fp), nchnprocess = u16(fp);
	const nchns = clamp(nchnprocess, nchnplay, C.MAX_CHANNELS);
	nsamples = Math.min(nsamples, C.MAX_SAMPLES);
	const oorders = u32(fp), ochnpans = u32(fp), opatterns = u32(fp), osamples = u32(fp);
	u32(fp);
	if (psm16_check_parapointer(fp, oorders, 'PORD')) {
		const o = bytes(fp, Math.min(norders, C.MAX_ORDERS - 1));
		song.orderlist.set(o);
		song.orderlist[o.length] = C.ORDER_LAST;
	}
	if (psm16_check_parapointer(fp, ochnpans, 'PPAN')) {
		const pans = new Uint8Array(C.MAX_CHANNELS); pans.set(bytes(fp, nchns));
		for (let n = 0; n < nchns; n++) song.channels[n].panning = Math.trunc(((15 - (pans[n] & 15)) * 256 + 8) / 15);
	}
	for (let n = nchns; n < C.MAX_CHANNELS; n++) song.channels[n].flags |= C.CHN_MUTE;
	if (psm16_check_parapointer(fp, osamples, 'PSAH')) {
		for (let i = 0; i < nsamples; i++) {
			seek(fp, osamples + i * 64);
			const filename = bytes(fp, 13), description = bytes(fp, 24);
			const osmpdata = u32(fp);
			skip(fp, 4);
			const smpnum = u16(fp);
			if (smpnum >= C.MAX_SAMPLES) continue;
			const smp = song.samples[smpnum];
			smp.filename = bstr(filename, 13);
			smp.name = bstr(description, 24);
			let b = getc(fp);
			if (b < 0) continue;
			let flags = C.SF_M | C.SF_LE | ((b & 4) ? C.SF_16 : C.SF_8);
			if (b & 8) flags |= C.SF_PCMU;
			else if ((b & 0x10) || !(b & 0x7f)) flags |= C.SF_PCMD;
			else flags |= C.SF_PCMS;
			if (b & 0x20) smp.flags |= C.CHN_PINGPONGLOOP;
			if (b & 0x80) smp.flags |= C.CHN_LOOP;
			smp.length = u32(fp);
			if (b & 4) smp.length >>>= 1;
			smp.loop_start = u32(fp);
			smp.loop_end = u32(fp);
			const finetune = getc(fp); if (finetune < 0) continue;
			b = getc(fp); if (b < 0) continue;
			smp.volume = b * 4;
			const c2freq = u16(fp);
			smp.c5speed = Math.trunc(c2freq * Math.pow(2.0, ((finetune ^ 0x08) - 0x78) / (12.0 * 16.0))) >>> 0;
			if (!cseek(fp, osmpdata)) read_sample(smp, flags, fp);
		}
	}
	if (psm16_check_parapointer(fp, opatterns, 'PPAT')) {
		for (let i = 0; i < npatterns; i++) {
			const start = tell(fp);
			const size = u16(fp);
			if (size < 4) continue;
			const nrows = u8(fp), nchans = u8(fp);
			const pattern = song.patterns[i] = csf_allocate_pattern(nrows);
			song.pattern_size[i] = nrows;
			let row = 0;
			while (tell(fp) <= start + size && row < nrows) {
				const command = getc(fp);
				if (command <= 0) { row++; continue; }
				const nn = pattern[row * 64 + Math.min(command & 31, nchans)];
				if (command & 0x80) {
					const note = getc(fp); if (note < 0) break;
					const instr = getc(fp); if (instr < 0) break;
					nn.note = (note + 36) & 0xff; nn.instrument = instr;
				}
				if (command & 0x40) {
					const v = getc(fp); if (v < 0) break;
					nn.voleffect = C.VOLFX_VOLUME; nn.volparam = Math.min(v, 64);
				}
				if (command & 0x20) {
					const effect = getc(fp); if (effect < 0) break;
					const param = getc(fp); if (param < 0) break;
					const set = (fx, p) => { nn.effect = fx; nn.param = p & 0xff; };
					switch (effect) {
					case 0x01: set(C.FX_VOLUMESLIDE, (param << 4) | 0x0f); break;
					case 0x02: set(C.FX_VOLUMESLIDE, (param << 4) & 0xf0); break;
					case 0x03: set(C.FX_VOLUMESLIDE, param | 0xf0); break;
					case 0x04: set(C.FX_VOLUMESLIDE, param & 0x0f); break;
					case 0x0a: set(C.FX_PORTAMENTOUP, param | 0xf0); break;
					case 0x0b: set(C.FX_PORTAMENTOUP, param); break;
					case 0x0c: set(C.FX_PORTAMENTODOWN, param | 0xf0); break;
					case 0x0d: set(C.FX_PORTAMENTODOWN, param); break;
					case 0x0e: set(C.FX_TONEPORTAMENTO, param); break;
					case 0x0f: set(C.FX_SPECIAL, 0x10 | (param & 0x0f)); break;
					case 0x10: set(C.FX_TONEPORTAVOL, param << 4); break;
					case 0x11: set(C.FX_TONEPORTAVOL, param & 0x0f); break;
					case 0x14: set(C.FX_VIBRATO, param); break;
					case 0x15: set(C.FX_SPECIAL, 0x30 | (param & 0x0f)); break;
					case 0x16: set(C.FX_VIBRATOVOL, param << 4); break;
					case 0x17: set(C.FX_VIBRATOVOL, param & 0x0f); break;
					case 0x1e: set(C.FX_TREMOLO, param); break;
					case 0x1f: set(C.FX_SPECIAL, 0x40 | (param & 0x0f)); break;
					case 0x28: set(C.FX_OFFSET, getc(fp)); cseek(fp, tell(fp) + 1); break;
					case 0x29: set(C.FX_RETRIG, param & 0x0f); break;
					case 0x2a: set(C.FX_SPECIAL, 0xc0); break;
					case 0x2b: set(C.FX_SPECIAL, 0xd0 | (param & 0x0f)); break;
					case 0x32: set(C.FX_POSITIONJUMP, param); break;
					case 0x33: set(C.FX_PATTERNBREAK, param); break;
					case 0x34: set(C.FX_SPECIAL, 0xb0 | (param & 0x0f)); break;
					case 0x35: set(C.FX_SPECIAL, 0xe0 | (param & 0x0f)); break;
					case 0x3c: set(C.FX_SPEED, param); break;
					case 0x3d: set(C.FX_TEMPO, param); break;
					case 0x46: set(C.FX_ARPEGGIO, param); break;
					case 0x47: set(C.FX_SPECIAL, 0x20 | (param & 0x0f)); break;
					case 0x48: set(C.FX_SPECIAL, 0x80 | (param & 0x0f)); break;
					default: set(C.FX_NONE, param); break;
					}
				}
			}
			cseek(fp, start + ((size + 15) & ~15));
		}
	}
	song.pan_separation = 128;
	song.flags = C.SONG_ITOLDEFFECTS | C.SONG_COMPATGXX;
	song.tracker_id = 'Epic MegaGames MASI (Old Version)';
	return LOAD_SUCCESS;
}

// ------------------------------------------------------------------------
// d00.c: EdLib D00 (AdLib)

export function d00_header_read(fp) {
	const could = pos => pos >= 0 && pos <= fp.bytes.length;
	const styles = [
		hdr => { // d00_header_read_new
			if (!could(tell(fp) + 119) || could(0xffff)) return 0;
			if (rawstr6(bytes(fp, 6)) !== 'JCH\x26\x02\x66') return 0;
			hdr.type = u8(fp); hdr.version = u8(fp);
			if (hdr.version & 0x80) { if (cseek(fp, 0x6b)) return 0; return styles[1](hdr); }
			hdr.speed = u8(fp); hdr.subsongs = u8(fp); hdr.soundcard = u8(fp);
			hdr.title = bytes(fp, 32); hdr.author = bytes(fp, 32); skip(fp, 32);
			hdr.tpoin = u16(fp); hdr.sequence_paraptr = u16(fp); hdr.instrument_paraptr = u16(fp);
			hdr.info_paraptr = u16(fp); hdr.spfx_paraptr = u16(fp); hdr.endmark = u16(fp);
			return 1;
		},
		hdr => { // d00_header_read_v1
			if (!could(tell(fp) + 15) || could(0xffff)) return 0;
			hdr.version = u8(fp); hdr.speed = u8(fp); hdr.subsongs = u8(fp);
			hdr.tpoin = u16(fp); hdr.sequence_paraptr = u16(fp); hdr.instrument_paraptr = u16(fp); hdr.info_paraptr = u16(fp);
			if (hdr.version > 0) hdr.spfx_paraptr = u16(fp);
			hdr.endmark = u16(fp);
			return 1;
		},
	];
	let hdr = null;
	for (const style of styles) {
		seek(fp, 0);
		const h = { type: 0, version: 0, speed: 0, subsongs: 0, soundcard: 0, title: new Uint8Array(32), author: new Uint8Array(32),
			tpoin: 0, sequence_paraptr: 0, instrument_paraptr: 0, info_paraptr: 0, spfx_paraptr: 0, endmark: 0 };
		if (style(h)) { hdr = h; break; }
	}
	if (!hdr || hdr.type || hdr.version > 4 || hdr.subsongs !== 1) return null;
	const fppos = tell(fp);
	const valid = ptr => fppos <= ptr || !could(ptr);
	if (!valid(hdr.tpoin) || !valid(hdr.info_paraptr) || !valid(hdr.instrument_paraptr) || !valid(hdr.sequence_paraptr)) return null;
	if ([1, 2, 4].includes(hdr.version) && !valid(hdr.spfx_paraptr)) return null;
	if (hdr.endmark !== 0xffff) return null;
	if (!hdr.version) hdr.speed = 70;
	const start = tell(fp);
	cseek(fp, hdr.tpoin);
	if (fp.position + 18 > fp.bytes.length) return null;
	for (let j = 0; j < 9; j++) if (!could(u16(fp))) return null;
	seek(fp, start);
	return hdr;
}
const rawstr6 = b => String.fromCharCode(...b);
const EDLIBVOLTOITVOL = x => Math.trunc((63 - (x & 63)) * 64 / 63);
export function fmt_d00_load_song(song, fp) {
	const hdr = d00_header_read(fp);
	if (!hdr) return LOAD_UNSUPPORTED;
	const warn = new Set(['D00 loader is experimental at best']);
	const speeds = new Uint16Array(10);
	speeds[0] = hdr.speed;
	song.title = bstr(hdr.title, 31);
	cseek(fp, hdr.info_paraptr);
	let msg = '';
	while (msg.length < MAX_MESSAGE) {
		const ch = getc(fp);
		if (ch < 0) break;
		if (ch === 0xff) {
			const ch2 = getc(fp);
			if (ch2 < 0 || ch2 === 0xff) break;
			msg += String.fromCharCode(ch);
			if (msg.length >= MAX_MESSAGE) break;
			msg += String.fromCharCode(ch2);
		} else msg += String.fromCharCode(ch);
	}
	song.message = msg.replace(/\0[\s\S]*$/, '');
	let ninst = 0;
	const PROWS = 64;
	const get_note = (pattern, row, c) => {
		if (!song.patterns[pattern]) new_pattern(song, pattern, PROWS);
		return song.patterns[pattern][row * 64 + c];
	};
	cseek(fp, hdr.tpoin);
	if (fp.position + 27 > fp.bytes.length) return LOAD_UNSUPPORTED;
	const ptrs = []; for (let c = 0; c < 9; c++) ptrs.push(u16(fp));
	const volume = bytes(fp, 9);
	let max_pattern = 0, max_row = 0;
	for (let c = 0; c < 9; c++) {
		const ord_transpose = new Int16Array(C.MAX_ORDERS);
		let transpose_set = 0;
		const ords = new Uint16Array(C.MAX_ORDERS - 2);
		let mem_instr = 0, mem_volfx = C.VOLFX_NONE, mem_volparam = 0, mem_effect = C.FX_NONE, mem_param = 0;
		let nords;
		if (ptrs[c] !== 0) song.channels[c].volume = EDLIBVOLTOITVOL(volume[c]);
		else { song.channels[c].flags |= C.CHN_MUTE; continue; }
		cseek(fp, ptrs[c]);
		if (fp.position + 2 > fp.bytes.length) continue;
		speeds[c + 1] = u16(fp);
		for (nords = 0; nords < ords.length;) {
			if (fp.position + 2 > fp.bytes.length) break;
			ords[nords] = u16(fp);
			if (ords[nords] === 0xffff || ords[nords] === 0xfffe) break;
			else if (ords[nords] >= 0x9000) { warn.add('Order speed ignored'); continue; }
			else if (ords[nords] >= 0x8000) {
				ord_transpose[nords] = ords[nords] & 0xff;
				if (ords[nords] & 0x100) ord_transpose[nords] = -ord_transpose[nords];
				transpose_set = 1;
				continue;
			} else {
				if (!transpose_set && nords > 0) ord_transpose[nords] = ord_transpose[nords - 1];
				transpose_set = 0;
				nords++;
			}
		}
		if (!nords) continue;
		let pattern = 0, row = 0;
		const fix_row = () => { while (row >= PROWS) { pattern++; row -= PROWS; } };
		for (let n = 0; pattern < C.MAX_PATTERNS;) {
			cseek(fp, hdr.sequence_paraptr + ords[n % nords] * 2);
			if (fp.position + 2 > fp.bytes.length) return LOAD_UNSUPPORTED;
			cseek(fp, u16(fp));
			const before = pattern * PROWS + row, n_before = n;
			for (; pattern < C.MAX_PATTERNS; fix_row()) {
				let sn = null, count = 0, stop = false, advanced = false;
				for (;;) { // D00_readnote
					if (fp.position + 2 > fp.bytes.length) { stop = true; break; }
					const event = u16(fp);
					if (event === 0xffff) { n++; stop = true; break; }
					sn = get_note(pattern, row, c);
					if (event < 0x4000) {
						let note = event & 0xff;
						if (hdr.version > 0) count = event >> 8;
						switch (note & 0x7f) {
						case 0: sn.note = C.NOTE_OFF; row += count + 1; break;
						case 0x7e:
							for (let r = 0; pattern < C.MAX_PATTERNS && r <= count; r++, row++, fix_row()) {
								sn = get_note(pattern, row, c);
								sn.effect = mem_effect; sn.param = mem_param;
							}
							break;
						default:
							mem_effect = C.FX_NONE; mem_param = 0;
							if (hdr.version > 0) {
								if (note & 0x80) note -= 0x80;
								else note += ord_transpose[n % nords];
								if (count >= 0x20) {
									if (sn.effect === C.FX_NONE) { sn.effect = C.FX_TONEPORTAMENTO; sn.param = 0xff; }
									count -= 0x20;
								}
							} else if (count < 2) note += ord_transpose[n % nords];
							sn.note = (note + 1 + 12) & 0xff;
							sn.instrument = mem_instr & 0xff;
							sn.voleffect = mem_volfx;
							sn.volparam = mem_volparam & 0xff;
							row += count + 1;
							break;
						}
						advanced = true;
						break;
					}
					const fx = event >> 12, fxop = event & 0x0fff;
					if (fx === 6) { sn.note = C.NOTE_CUT; row += fxop + 1; advanced = true; break; }
					switch (fx) {
					case 7: {
						const depth = Math.min((((fxop >> 8) & 0xff) * 4 / 3) & 0xff, 0xf);
						const speed = Math.min(Math.trunc((fxop & 0xff) * 4 / 3) & 0xff, 0xf);
						mem_effect = C.FX_VIBRATO;
						mem_param = (speed << 4) | Math.trunc(depth);
						break;
					}
					case 8: if (hdr.version === 0) count = fxop; break;
					case 9: mem_volfx = C.VOLFX_VOLUME; mem_volparam = EDLIBVOLTOITVOL(fxop); break;
					case 0xb:
						if (hdr.version === 4) {
							const oldpos = tell(fp);
							cseek(fp, hdr.spfx_paraptr + fxop);
							mem_instr = u16(fp);
							ninst = Math.max(ninst, mem_instr);
							seek(fp, oldpos);
						}
						warn.add('SPFX not implemented');
						break;
					case 0xc: mem_instr = fxop + 1; ninst = Math.max(ninst, fxop + 1); break;
					case 0xd: mem_effect = C.FX_PORTAMENTOUP; mem_param = Math.trunc(fxop * 5 / 2) & 0xff; break;
					case 0xe: mem_effect = C.FX_PORTAMENTODOWN; mem_param = Math.trunc(fxop * 5 / 2) & 0xff; break;
					}
				}
				if (stop) break;
				void advanced;
			}
			if (n === nords) {
				if (max_pattern < pattern) { max_pattern = pattern; max_row = row; }
				else if (max_pattern === pattern && max_row < row) max_row = row;
			}
			// the C code would spin here forever on truncated pattern data
			if (n === n_before && pattern * PROWS + row === before) break;
		}
	}
	if (!max_row) { max_pattern--; max_row = PROWS - 1; }
	else max_row--;
	if (max_pattern < 0) max_pattern = 0;
	for (let c = max_pattern + 1; c < C.MAX_PATTERNS; c++) { song.patterns[c] = null; song.pattern_size[c] = song.pattern_alloc_size[c] = 64; }
	song.pattern_size[max_pattern] = max_row + 1;
	if (!song.patterns[max_pattern]) new_pattern(song, max_pattern, max_row + 1);
	for (let c = 0; c <= max_pattern; c++) song.orderlist[c] = c;
	song.orderlist[max_pattern + 1] = C.ORDER_LAST;
	{
		let max_count = 1, count = 1, mode = speeds[0];
		speeds.sort();
		for (let c = 1; c < 10; c++) {
			count = speeds[c] === speeds[c - 1] ? count + 1 : 1;
			if (count > max_count) { max_count = count; mode = speeds[c]; }
		}
		if (hdr.version >= 3) {
			let speed = 3, tempo = mode * (131.0 / 32.0);
			while (tempo > 255.0) { speed *= 2; tempo /= 2; }
			song.initial_speed = speed;
			song.initial_tempo = Math.round(tempo);
		} else { song.initial_speed = mode; song.initial_tempo = 131; }
	}
	if (cseek(fp, hdr.instrument_paraptr)) return LOAD_UNSUPPORTED;
	ninst = Math.min(ninst, C.MAX_SAMPLES);
	const order = [8, 3, 7, 2, 5, 0, 6, 1, 9, 4, 10];
	for (let c = 0; c < ninst; c++) {
		if (fp.position + 11 > fp.bytes.length) continue;
		const b = bytes(fp, 11);
		const smp = song.samples[c + 1];
		if (!smp) continue;
		for (let i = 0; i < 11; i++) smp.adlib_bytes[i] = b[order[i]];
		smp.flags |= C.CHN_ADLIB;
		smp.data = new Int8Array(1);
		smp.length = 1;
		app.csf_adjust_sample_loop(smp);
		const tunelev = getc(fp);
		if (tunelev < 0) break;
		if ((hdr.version === 1 || hdr.version === 2) && tunelev !== 0xff) warn.add('Levelpuls not implemented');
		else if (hdr.version === 4) warn.add('Instrument finetune ignored');
		smp.volume = 64 * 4;
		cseek(fp, tell(fp) + 4);
	}
	for (let c = 9; c < C.MAX_CHANNELS; c++) song.channels[c].flags |= C.CHN_MUTE;
	song.tracker_id = hdr.version === 4 ? 'EdLib Tracker' : `Unknown AdLib Tracker, file version ${hdr.version}`;
	for (const w of ['D00 loader is experimental at best', 'SPFX not implemented', 'Levelpuls not implemented', 'Instrument finetune ignored', 'Order speed ignored'])
		if (warn.has(w)) log(4, ` Warning: ${w}`);
	return LOAD_SUCCESS;
}

// ------------------------------------------------------------------------
// fmpatches.c: adlib_patch_apply

export function adlib_patch_apply(smp, patchnum) {
	if (patchnum < 0 || patchnum > 127) return;
	smp.adlib_bytes = new Uint8Array(12);
	smp.adlib_bytes.set(fm_patches[patchnum]);
	smp.name = midi_program_names[patchnum].slice(0, 31);
	smp.filename = 'MIDI#' + String(patchnum + 1).padStart(3, '0');
	smp.flags |= C.CHN_ADLIB;
	smp.length = 1;
	smp.data = new Int8Array(1);
	app.csf_adjust_sample_loop(smp);
}

// ------------------------------------------------------------------------
// mid.c: Standard MIDI files (played through the AdLib patch bank)

function mid_read_mthd(fp) {
	if (fp.position + 4 > fp.bytes.length) return null;
	let tag = cstr(fp, 4);
	if (tag === 'RIFF') { skip(fp, 16); if (fp.position + 4 > fp.bytes.length) return null; tag = cstr(fp, 4); }
	if (fp.position + 10 > fp.bytes.length) return null;
	const h = { header_length: u32be(fp), format: u16be(fp), num_tracks: u16be(fp), division: u16be(fp) };
	if (tag !== 'MThd') return null;
	cseek(fp, tell(fp) + h.header_length - 6);
	return h;
}
function read_varlen(fp) {
	let b, v = 0;
	do {
		b = getc(fp);
		if (b < 0) return 0;
		v = ((v << 7) | (b & 0x7f)) >>> 0;
	} while (b & 0x80);
	return v;
}
export function fmt_mid_load_song(song, fp, lflags = 0) {
	const LOAD_NOSAMPLES = 1, LOAD_NOPATTERNS = 2;
	const mthd = mid_read_mthd(fp);
	if (!mthd) return LOAD_UNSUPPORTED;
	song.title = '';
	const midich = Array.from({ length: 16 }, () => ({ fg_note: 0, bg_note: 0, instrument: 0 }));
	let message = '', message_left = MAX_MESSAGE, nsmp = 1;
	const patch_samples = new Uint8Array(128);
	const head = { pulse: 0, chan: 0, note: blank(), next: null };
	const NOTE_FIRST = 1, NOTE_LAST = 120;
	for (let trknum = 0; trknum < mthd.num_tracks; trknum++) {
		let cur = head.next, prev = head, pulse = 0, rs = 0, found_end = 0;
		if (fp.position + 8 > fp.bytes.length) break;
		const tag = cstr(fp, 4), length = u32be(fp);
		if (tag !== 'MTrk') { log(4, ' Warning: Invalid track header (corrupt file?)'); break; }
		const nextpos = tell(fp) + length;
		while (!found_end && tell(fp) < nextpos) {
			pulse = (pulse + read_varlen(fp)) >>> 0;
			let status;
			if (fp.position < fp.bytes.length && (fp.bytes[fp.position] & 0x80)) { status = fp.bytes[fp.position]; skip(fp, 1); }
			else if (rs & 0x80) status = rs;
			else continue;
			let note = blank();
			const hi = status >> 4, lo = status & 0xf, cn = lo;
			const g = () => getc(fp) & 0xff;
			let x, y;
			switch (hi) {
			case 0x8:
				rs = status; x = g(); y = g();
				x = clamp(x + NOTE_FIRST, NOTE_FIRST, NOTE_LAST);
				if (midich[cn].fg_note === x) { note = blank(); note.note = C.NOTE_OFF; midich[cn].fg_note = 0; }
				else { note = blank(); note.effect = C.FX_SPECIAL; note.param = 0x71; midich[cn].bg_note = 0; }
				break;
			case 0x9:
				rs = status; x = g(); y = g();
				x = clamp(x + NOTE_FIRST, NOTE_FIRST, NOTE_LAST);
				if (lo === 9) { /* percussion is ignored */ }
				else if (y === 0) {
					if (midich[cn].fg_note === x) { note = blank(); note.note = C.NOTE_OFF; midich[cn].fg_note = 0; }
					else { note = blank(); note.effect = C.FX_SPECIAL; note.param = 0x71; midich[cn].bg_note = 0; }
				} else {
					if (nsmp === 1 && !(lflags & LOAD_NOSAMPLES)) { patch_samples[0] = 1; adlib_patch_apply(song.samples[1], 0); nsmp++; }
					note = blank();
					note.note = x;
					note.instrument = patch_samples[midich[cn].instrument];
					note.voleffect = C.VOLFX_VOLUME;
					note.volparam = Math.trunc((y & 0x7f) * 64 / 127);
					midich[cn].fg_note = x;
					midich[cn].bg_note = x;
				}
				break;
			case 0xa: case 0xb: case 0xe: rs = status; g(); g(); continue;
			case 0xd: rs = status; g(); continue;
			case 0xc:
				rs = status; x = g();
				midich[cn].instrument = x;
				if (x < 128 && !patch_samples[x] && !(lflags & LOAD_NOSAMPLES)) {
					if (nsmp < C.MAX_SAMPLES) { patch_samples[x] = nsmp; adlib_patch_apply(song.samples[nsmp], x); nsmp++; }
					else log(4, ' Warning: Too many samples');
				}
				note = blank();
				note.instrument = x < 128 ? patch_samples[x] : 0;
				break;
			case 0xf:
				switch (lo) {
				case 0xf: {
					x = g();
					let vlen = read_varlen(fp);
					switch (x) {
					case 1: case 2: case 3: case 4: case 5: case 6: case 7: {
						y = Math.min(vlen, message_left ? message_left - 1 : 0) & 0xff;
						const text = bstr(bytes(fp, y).map(c => c || 32), y);
						if (x === 3 && y && !song.title) song.title = text.slice(0, Math.min(y, 25));
						message += text; message_left -= y;
						if (y && !message.endsWith('\n')) { message += '\n'; message_left--; }
						vlen -= y;
						break;
					}
					case 0x2f: found_end = 1; break;
					case 0x51: {
						const buf = new Uint8Array(4);
						y = Math.min(vlen, 4);
						buf.set(bytes(fp, y), 4 - y);
						let bpm = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
						bpm = clamp(Math.trunc(60000000 / (bpm ? bpm : 1)), 0x20, 0xff);
						note = blank(); note.effect = C.FX_TEMPO; note.param = bpm;
						vlen -= y;
						break;
					}
					case 0x20: case 0x21: case 0x54: case 0x58: case 0x59: case 0x7f: break;
					default: log(2, ` Unknown meta-event FF ${x.toString(16).toUpperCase().padStart(2, '0')}`); break;
					}
					cseek(fp, tell(fp) + vlen);
					break;
				}
				case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7:
					rs = 0;
					// fallthrough
				default:
					continue;
				}
				break;
			}
			while (cur && pulse > cur.pulse) { prev = cur; cur = cur.next; }
			const ev = { pulse, chan: cn, note, next: cur };
			prev.next = ev;
			prev = ev;
		}
		if (tell(fp) !== nextpos) {
			log(2, ` Track ${trknum} ended ${tell(fp) - nextpos} bytes from boundary`);
			cseek(fp, nextpos);
		}
	}
	song.message = message;
	song.initial_speed = 3;
	song.initial_tempo = 120;
	if (lflags & LOAD_NOPATTERNS) return LOAD_SUCCESS;
	if (!mthd.division) return LOAD_FORMAT_ERROR;
	const ROWS = 200, FRACBITS = 12, FRACMASK = (1 << FRACBITS) - 1;
	let pattern = null, row = ROWS, rowfrac = 0, pat = 0, pulse = 0;
	for (let cur = head; cur; cur = cur.next) {
		const delta = (cur.pulse - pulse) >>> 0;
		if (delta) {
			row <<= FRACBITS;
			row = (row + Math.trunc((Math.imul(8, (delta << FRACBITS) >>> 0) >>> 0) / mthd.division)) | 0;
			row += rowfrac;
			rowfrac = row & FRACMASK;
			row >>= FRACBITS;
		}
		pulse = cur.pulse;
		while (row >= ROWS) {
			if (pat >= C.MAX_PATTERNS) { log(4, ' Warning: Too many patterns, song is truncated'); return LOAD_SUCCESS; }
			pattern = new_pattern(song, pat, ROWS);
			song.orderlist[pat] = pat;
			pat++;
			row -= ROWS;
		}
		const rd = pattern[64 * row + cur.chan], n = cur.note;
		if (n.note) { rd.note = n.note; rd.instrument = n.instrument; }
		if (n.voleffect) { rd.voleffect = n.voleffect; rd.volparam = n.volparam; }
		if (n.effect) { rd.effect = n.effect; rd.param = n.param; }
	}
	return LOAD_SUCCESS;
}

// ------------------------------------------------------------------------
// mus.c: DMX (Doom) music

export function mus_read_header(fp) {
	if (fp.position + 8 > fp.bytes.length || rawstr6(bytes(fp, 4)) !== 'MUS\x1a') return null;
	const scorelen = u16(fp), scorestart = u16(fp);
	if (scorestart + scorelen > fp.bytes.length) return null;
	skip(fp, 8);
	return { scorelen, scorestart };
}
export function fmt_mus_load_song(song, fp) {
	const hdr = mus_read_header(fp);
	if (!hdr) return LOAD_UNSUPPORTED;
	const ROWS = 200, SPEED_CH = 15, BREAK_CH = 16, TICKADJ_CH = 17, FRACBITS = 12, FRACMASK = (1 << FRACBITS) - 1;
	const chanstate = Array.from({ length: 16 }, () => ({ note: 0, instrument: 0, volume: 0 }));
	let prevspeed = 1, nsmp = 1, finished = 0, tickfrac = 0;
	const patch_samples = new Uint8Array(128), patch_percussion = new Uint8Array(128);
	for (let n = 16; n < C.MAX_CHANNELS; n++) song.channels[n].flags |= C.CHN_MUTE;
	cseek(fp, hdr.scorestart);
	const lim = fp.limit;
	fp.limit = tell(fp) + hdr.scorestart + hdr.scorelen; // (sic) slurp_limit is relative to the current position
	let pat = 0, row = 0;
	let pattern = new_pattern(song, pat, ROWS), base = 0;
	song.orderlist[pat] = pat;
	const at = ch => pattern[base + ch] || blank();
	const g = () => getc(fp) & 0xff;
	while (!finished && !eof(fp)) {
		const event = g(), type = (event >> 4) & 7, ch = event & 15;
		let b1, b2;
		switch (type) {
		case 0:
			b1 = g() & 127;
			b1 = Math.min((b1 & 127) + 1, 120);
			if (chanstate[ch].note === b1) { const n = at(ch); if (!(n.note >= 1 && n.note <= 120)) n.note = C.NOTE_OFF; }
			break;
		case 1:
			b1 = g();
			if (b1 & 128) { chanstate[ch].volume = ((g() & 127) + 1) >> 1; b1 &= 127; }
			chanstate[ch].note = Math.min(b1 + 1, 120);
			if (ch === 15) {
				b1 = clamp(b1, 24, 84);
				if (!patch_percussion[b1]) {
					if (nsmp < C.MAX_SAMPLES) {
						patch_percussion[b1] = nsmp;
						song.samples[nsmp].name = midi_percussion_names[b1 - 24].slice(0, 25);
						nsmp++;
					} else { log(4, ' Warning: Too many samples'); at(ch).note = C.NOTE_OFF; }
				}
				chanstate[ch].note = C.NOTE_NONE;
			} else if (chanstate[ch].instrument) {
				at(ch).note = chanstate[ch].note;
				at(ch).instrument = chanstate[ch].instrument;
			}
			at(ch).voleffect = C.VOLFX_VOLUME;
			at(ch).volparam = chanstate[ch].volume;
			break;
		case 2: g(); break;
		case 3:
			b1 = g() & 127;
			switch (b1) {
			case 10: for (let n = 0; n < 16; n++) { at(ch).note = chanstate[ch].note = C.NOTE_CUT; at(ch).instrument = 0; } break;
			case 11: for (let n = 0; n < 16; n++) { at(ch).note = chanstate[ch].note = C.NOTE_OFF; at(ch).instrument = 0; } break;
			case 14: for (const c of chanstate) { c.note = c.instrument = c.volume = 0; } break;
			}
			break;
		case 4:
			b1 = g() & 127; b2 = g() & 127;
			switch (b1) {
			case 0:
				if (ch === 15) break;
				if (!patch_samples[b2]) {
					if (nsmp < C.MAX_SAMPLES) { patch_samples[b2] = nsmp; adlib_patch_apply(song.samples[nsmp], b2); nsmp++; }
					else { log(4, ' Warning: Too many samples'); at(ch).note = C.NOTE_OFF; }
				}
				chanstate[ch].instrument = patch_samples[b2];
				break;
			case 3:
				chanstate[ch].volume = (b2 + 1) >> 1;
				at(ch).voleffect = C.VOLFX_VOLUME;
				at(ch).volparam = chanstate[ch].volume;
				break;
			}
			break;
		case 6: finished = 1; break;
		default: log(4, ` Warning: Unknown event type ${type}`); break;
		}
		if (finished) {
			const leftover = (tickfrac + (1 << FRACBITS)) >> FRACBITS;
			at(BREAK_CH).effect = C.FX_PATTERNBREAK; at(BREAK_CH).param = 0;
			if (leftover && leftover !== prevspeed) { at(SPEED_CH).effect = C.FX_SPEED; at(SPEED_CH).param = leftover & 0xff; }
		} else if (event & 0x80) {
			let ticks = 0;
			do {
				b1 = g();
				ticks = 128 * ticks + (b1 & 127);
				if (ticks > 0xffff) ticks = 0xffff;
			} while ((b1 & 128) && !eof(fp));
			ticks = Math.min(ticks, (0x7fffffff / 255) >> 12);
			ticks <<= FRACBITS;
			ticks = Math.trunc(ticks * 255 / 350);
			ticks += tickfrac;
			tickfrac = ticks & FRACMASK;
			ticks >>= FRACBITS;
			if (ticks < 1) continue;
			if (ticks > 255) {
				let adjust = ticks % 255, s6xch = TICKADJ_CH;
				while (adjust) {
					const s6x = Math.min(adjust, 0xf);
					at(s6xch).effect = C.FX_SPECIAL; at(s6xch).param = 0x60 | s6x;
					adjust -= s6x; s6xch++;
				}
			}
			if (prevspeed !== Math.min(ticks, 255)) {
				prevspeed = Math.min(ticks, 255);
				at(SPEED_CH).effect = C.FX_SPEED; at(SPEED_CH).param = prevspeed;
			}
			ticks = Math.trunc(ticks / 255) + 1;
			row += ticks;
			base += 64 * ticks;
		}
		while (row >= ROWS) {
			pat++;
			row -= ROWS;
			if (pat >= C.MAX_PATTERNS) { log(4, ' Warning: Too much note data'); finished = 1; break; }
			pattern = new_pattern(song, pat, ROWS);
			base = 0;
			song.orderlist[pat] = pat;
			pattern[SPEED_CH].effect = C.FX_SPEED; pattern[SPEED_CH].param = prevspeed;
			base = 64 * row;
		}
	}
	fp.limit = lim;
	song.flags |= C.SONG_NOSTEREO;
	song.initial_speed = 1;
	song.initial_tempo = 255;
	song.tracker_id = 'Doom Music File';
	return LOAD_SUCCESS;
}

Object.assign(song_loaders, {
	'669': fmt_669_load_song, far: fmt_far_load_song, mtm: fmt_mtm_load_song, okt: fmt_okt_load_song,
	ult: fmt_ult_load_song, imf: fmt_imf_load_song, stm: fmt_stm_load_song, stx: fmt_stx_load_song,
	sfx: fmt_sfx_load_song, dsm: fmt_dsm_load_song, mdl: fmt_mdl_load_song,
	psm: fmt_psm_load_song, psm16: fmt_psm16_load_song, d00: fmt_d00_load_song,
	mid: fmt_mid_load_song, mus: fmt_mus_load_song,
});
