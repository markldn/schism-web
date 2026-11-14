// Module loaders: fmt/it.c, fmt/its.c, fmt/iti.c, fmt/compression.c (IT part),
// fmt/s3m.c, fmt/xm.c, fmt/mod.c, fmt/generic.c and the load half of
// schism/audio_loadsave.c (Schism Tracker, GPL-2.0-or-later).
// Tracker-id fingerprinting is reduced to the common cases.
import { provide, app } from '../app.js';
import * as C from '../sndconst.js';
import { csf_allocate, csf_allocate_pattern, csf_allocate_instrument, csf_read_sample,
	csf_import_s3m_effect, csf_insert_restart_pos } from '../csndfile.js';
import { transpose_to_frequency } from '../effects.js';
import { copy_midi_config } from '../midimacro.js';
import { QUIRK, finetune_table, vc_portamento_table } from '../gen/tables.js';

// ------------------------------------------------------------------------
// memory reader (slurp_t over a Uint8Array)

export function fp_open(bytes) {
	return { bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), position: 0, limit: Infinity };
}
const getc = fp => fp.position < fp.bytes.length && fp.position < fp.limit ? fp.bytes[fp.position++] : -1;
const eof = fp => fp.position >= fp.bytes.length || fp.position >= fp.limit;
function u8(fp) { const c = getc(fp); return c < 0 ? 0 : c; }
function s8(fp) { return (u8(fp) << 24) >> 24; }
function u16(fp) { return u8(fp) | (u8(fp) << 8); }
function u16be(fp) { return (u8(fp) << 8) | u8(fp); }
function u32(fp) { return (u8(fp) | (u8(fp) << 8) | (u8(fp) << 16) | (u8(fp) << 24)) >>> 0; }
function bytes(fp, n) {
	const end = Math.min(fp.position + n, fp.bytes.length, fp.limit);
	const out = fp.bytes.slice(fp.position, Math.max(end, fp.position));
	fp.position += n;
	return out;
}
// fixed-size C string field -> JS string (one char per byte, cp437 codes)
function cstr(fp, n, nul_to_space = false) {
	const b = bytes(fp, n);
	let s = '';
	for (let i = 0; i < b.length; i++) {
		if (!b[i]) { if (nul_to_space) { s += ' '; continue; } break; }
		s += String.fromCharCode(b[i]);
	}
	return s;
}
const rtrim = s => s.replace(/[\s\0]+$/, '');
const seek = (fp, pos) => { fp.position = pos; };
const tell = fp => fp.position;
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

// ------------------------------------------------------------------------
// fmt/compression.c: IT 2.14/2.15 sample decompression

function it_readbits(n, st, fp) {
	let value = 0;
	for (let i = n; i--;) {
		if (!st.bitnum) { st.bitbuf = u8(fp); st.bitnum = 8; }
		value >>>= 1;
		value |= (st.bitbuf << 31);
		st.bitbuf >>>= 1;
		st.bitnum--;
	}
	return (value >>> (32 - n)) >>> 0;
}

export function it_decompress(dest, offset, len, fp, it215, channels, sixteen) {
	const start = tell(fp);
	const maxblk = sixteen ? 0x4000 : 0x8000, startwidth = sixteen ? 17 : 9;
	const bits = sixteen ? 16 : 8, mask = sixteen ? 0xffff : 0xff;
	let destpos = offset;
	while (len) {
		const c1 = getc(fp), c2 = getc(fp);
		if (c1 < 0 || c2 < 0 || fp.position + (c1 | (c2 << 8)) > fp.bytes.length) return tell(fp) - start;
		const st = { bitbuf: 0, bitnum: 0 };
		const blklen = Math.min(maxblk, len);
		let blkpos = 0, width = startwidth, d1 = 0, d2 = 0;
		while (blkpos < blklen) {
			if (width > startwidth) return tell(fp) - start;
			let value = it_readbits(width, st, fp);
			if (width < 7) {
				if (value === 1 << (width - 1)) {
					value = it_readbits(sixteen ? 4 : 3, st, fp) + 1;
					width = value < width ? value : value + 1;
					continue;
				}
			} else if (width < startwidth) {
				const border = sixteen ? ((0xffff >> (17 - width)) - 8) : (((0xff >> (9 - width)) - 4) & 0xff);
				if (value > border && value <= border + (sixteen ? 16 : 8)) {
					value -= border;
					width = value < width ? value : value + 1;
					continue;
				}
			} else if (value & (sixteen ? 0x10000 : 0x100)) {
				width = (value + 1) & 0xff;
				continue;
			}
			let v;
			if (width < bits) {
				const shift = 32 - width;
				v = (value << shift) >> shift;
			} else {
				v = sixteen ? (value << 16) >> 16 : (value << 24) >> 24;
			}
			if (sixteen) { d1 = ((d1 + v) << 16) >> 16; d2 = ((d2 + d1) << 16) >> 16; }
			else { d1 = ((d1 + v) << 24) >> 24; d2 = ((d2 + d1) << 24) >> 24; }
			dest[destpos] = it215 ? d2 : d1;
			destpos += channels;
			blkpos++;
		}
		len -= blklen;
	}
	void mask;
	return tell(fp) - start;
}

// csf_read_sample, extended with the IT214/IT215 and PCMD16 branches.
export function read_sample(smp, flags, fp) {
	const enc = flags & C.SF_ENC_MASK;
	if (enc === C.SF_IT214 || enc === C.SF_IT215) {
		if (!smp.length) return 0;
		smp.length = Math.min(smp.length, C.MAX_SAMPLE_LENGTH);
		const sixteen = (flags & C.SF_BIT_MASK) === C.SF_16;
		const stereo = (flags & C.SF_CHN_MASK) === C.SF_SS;
		const ch = stereo ? 2 : 1;
		const data = sixteen ? new Int16Array(smp.length * ch) : new Int8Array(smp.length * ch);
		const start = tell(fp);
		it_decompress(data, 0, smp.length, fp, enc === C.SF_IT215, ch, sixteen);
		if (stereo) it_decompress(data, 1, smp.length, fp, enc === C.SF_IT215, ch, sixteen);
		smp.flags = (smp.flags & ~(C.CHN_16BIT | C.CHN_STEREO)) | (sixteen ? C.CHN_16BIT : 0) | (stereo ? C.CHN_STEREO : 0);
		smp.data = data;
		app.csf_adjust_sample_loop(smp);
		return tell(fp) - start;
	}
	if (enc === C.SF_PCMD16) {
		// 8-bit ADPCM with a 16-entry table (MOD "ADPCM" samples)
		const table = bytes(fp, 16);
		const data = new Int8Array(smp.length);
		let delta = 0;
		for (let j = 0; j < smp.length; j += 2) {
			const b = u8(fp);
			delta = (delta + ((table[b & 15] << 24) >> 24)) << 24 >> 24; data[j] = delta;
			if (j + 1 < smp.length) { delta = (delta + ((table[b >> 4] << 24) >> 24)) << 24 >> 24; data[j + 1] = delta; }
		}
		smp.flags &= ~(C.CHN_16BIT | C.CHN_STEREO);
		smp.data = data;
		app.csf_adjust_sample_loop(smp);
		return 16 + ((smp.length + 1) >> 1);
	}
	const saved = fp.limit; // csf_read_sample checks against bytes.length only
	if (fp.limit !== Infinity && fp.limit < fp.bytes.length) {
		const sub = { bytes: fp.bytes.subarray(0, fp.limit), position: fp.position };
		const r = csf_read_sample(smp, flags, sub);
		fp.position = sub.position;
		return r;
	}
	void saved;
	const r = csf_read_sample(smp, flags, fp);
	if (!r && smp.length && !smp.data) {
		// truncated file: read what is there, zero the rest (as the C allocator does)
		const avail = fp.bytes.length - fp.position;
		const bits = (flags & C.SF_BIT_MASK) === C.SF_16 ? 2 : 1;
		const ch = (flags & C.SF_CHN_MASK) === C.SF_M ? 1 : 2;
		if (avail > 0) {
			const want = smp.length * bits * ch;
			const padded = new Uint8Array(want);
			padded.set(fp.bytes.subarray(fp.position, fp.position + Math.min(avail, want)));
			const sub = { bytes: padded, position: 0 };
			const rr = csf_read_sample(smp, flags, sub);
			fp.position = fp.bytes.length;
			return rr;
		}
		smp.length = 0;
	}
	return r;
}

// ------------------------------------------------------------------------
// fmt/generic.c

export function fmt_fill_schism_quirks(csf, ver) {
	const q = [
		[0x079a, 'PERIODS_ARE_HERTZ'], [0x0970, 'IT_SHORT_SAMPLE_RETRIG'],
		[0x1087, 'IT_DO_NOT_OVERRIDE_CHANNEL_PAN'], [0x1087, 'IT_PANNING_RESET'],
		[0x113e, 'IT_PITCH_PAN_SEPARATION'], [0x11f2, 'IT_EMPTY_NOTE_MAP_SLOT'],
		[0x11f2, 'IT_PORTAMENTO_SWAP_RESETS_POSITION'], [0x11f2, 'IT_MULTI_SAMPLE_INSTRUMENT_NUMBER'],
		[0x132b, 'IT_INITIAL_NOTE_MEMORY'], [0x1409, 'IT_DCT_BEHAVIOR'],
		[0x140b, 'IT_SAMPLE_AND_HOLD_PANBRELLO'], [0x140b, 'IT_PORTAMENTO_NO_NOTE'],
		[0x140e, 'IT_FIRST_TICK_HANDLING'], [0x140e, 'IT_MULTI_SAMPLE_INSTRUMENT_NUMBER'],
		[0x1499, 'IT_PANBRELLO_HOLD'], [0x14d9, 'IT_NO_SUSTAIN_ON_PORTAMENTO'],
		[0x14d9, 'IT_EMPTY_NOTE_MAP_SLOT_IGNORE_CELL'], [0x14e8, 'IT_OFFSET_WITH_INSTRUMENT_NUMBER'],
		[0x1573, 'IT_DOUBLE_PORTAMENTO_SLIDES'], [0x15ca, 'IT_CARRY_AFTER_NOTE_OFF'],
		[0x17ca, 'IT_COMPAT_GXX_CARRY_PORTA_WITH_INS'],
	];
	for (const [verfixed, name] of q)
		if (verfixed >= ver && name in QUIRK) csf.quirks[QUIRK[name]] = 0;
}

const PERIOD_C0 = 13696, PERIOD_MIN = 14, PERIOD_MAX = PERIOD_C0;
export function mod_import_note(p, note) {
	const period = ((p[0] & 0xf) << 8) + p[1];
	note.note = period >= PERIOD_MIN && period <= PERIOD_MAX
		? Math.round(12 * Math.log2(PERIOD_C0 / period)) + 1 : C.NOTE_NONE;
	note.instrument = (p[0] & 0xf0) + (p[2] >> 4);
	note.voleffect = C.VOLFX_NONE;
	note.volparam = 0;
	note.effect = p[2] & 0xf;
	note.param = p[3];
}

export const effect_weight = new Uint8Array(C.FX_MAX);
Object.entries({ PATTERNBREAK: 248, POSITIONJUMP: 240, SPEED: 232, TEMPO: 224, GLOBALVOLUME: 216,
	GLOBALVOLSLIDE: 208, CHANNELVOLUME: 200, CHANNELVOLSLIDE: 192, TONEPORTAVOL: 184,
	TONEPORTAMENTO: 176, ARPEGGIO: 168, RETRIG: 160, TREMOR: 152, OFFSET: 144, VOLUME: 136,
	VIBRATOVOL: 128, VOLUMESLIDE: 120, PORTAMENTODOWN: 112, PORTAMENTOUP: 104, NOTESLIDEDOWN: 96,
	NOTESLIDEUP: 88, PANNING: 80, PANNINGSLIDE: 72, MIDI: 64, SPECIAL: 56, PANBRELLO: 48,
	VIBRATO: 40, FINEVIBRATO: 32, TREMOLO: 24, KEYOFF: 16, SETENVPOSITION: 8 })
	.forEach(([k, v]) => { effect_weight[C['FX_' + k]] = v; });

export function swap_effects(note) {
	const e = note.effect, p = note.param;
	note.effect = note.voleffect; note.param = note.volparam;
	note.voleffect = e; note.volparam = p;
}

const SHORT_PANNING = i => ((((i) << 4) | (i)) + 2) >> 2;
// convert_voleffect on note.voleffect/volparam (convert_voleffect_of)
export function convert_voleffect_of(note, force) {
	let e = note.voleffect, p = note.volparam, ok = 1;
	const set = () => { note.voleffect = e; note.volparam = p & 0xff; return ok; };
	switch (e) {
	case C.FX_NONE: return 1;
	case C.FX_VOLUME: e = C.VOLFX_VOLUME; p = Math.min(p, 64); return set();
	case C.FX_PORTAMENTOUP:
	case C.FX_PORTAMENTODOWN:
		if (!force && ((p & 3) || p > 9 * 4 + 3)) return 0;
		p = Math.min(p >> 2, 9);
		e = e === C.FX_PORTAMENTOUP ? C.VOLFX_PORTAUP : C.VOLFX_PORTADOWN;
		return set();
	case C.FX_TONEPORTAMENTO:
		if (p >= 0xf0) { e = C.VOLFX_TONEPORTAMENTO; p = 9; return set(); }
		for (let n = 0; n < 10; n++)
			if (force ? p <= vc_portamento_table[n] : p === vc_portamento_table[n]) {
				e = C.VOLFX_TONEPORTAMENTO; p = n; return set();
			}
		return 0;
	case C.FX_VIBRATO: {
		let depth = p & 0x0f, speed = p & 0xf0;
		if (speed && depth && !force) return 0;
		if (speed) {
			if (force) speed = Math.min(speed, 9); else if (speed > 9) return 0;
			e = C.VOLFX_VIBRATOSPEED; p = speed; return set();
		} else if (depth || force) {
			if (force) depth = Math.min(depth, 9); else if (depth > 9) return 0;
			e = C.VOLFX_VIBRATODEPTH; p = depth; return set();
		}
		return 0;
	}
	case C.FX_FINEVIBRATO:
		if (force) p = 0; else if (p) return 0;
		e = C.VOLFX_VIBRATODEPTH; return set();
	case C.FX_PANNING:
		p = Math.min(64, Math.trunc(p * 64 / 255)); e = C.VOLFX_PANNING; return set();
	case C.FX_VOLUMESLIDE:
		if (p === 0) return 0;
		if ((p & 0xf) === 0) {
			if (force) p = Math.min(p >> 4, 9); else if ((p >> 4) > 9) return 0; else p >>= 4;
			e = C.VOLFX_VOLSLIDEUP;
		} else if ((p & 0xf0) === 0) {
			if (force) p = Math.min(p, 9); else if (p > 9) return 0;
			e = C.VOLFX_VOLSLIDEDOWN;
		} else if ((p & 0xf) === 0xf) {
			if (force) p = Math.min(p >> 4, 9); else if ((p >> 4) > 9) return 0; else p >>= 4;
			e = C.VOLFX_FINEVOLUP;
		} else if ((p & 0xf0) === 0xf0) {
			if (force) p = Math.min(p, 9); else if ((p & 0xf) > 9) return 0; else p &= 0xf;
			e = C.VOLFX_FINEVOLDOWN;
		} else return 0;
		return set();
	case C.FX_SPECIAL:
		switch (p >> 4) {
		case 8: e = C.VOLFX_PANNING; p = SHORT_PANNING(p & 0xf); return set();
		case 0: case 1: case 2: case 0xf:
			if (force) { e = p = 0; return set(); }
			break;
		}
		return 0;
	case C.FX_PANNINGSLIDE:
		if (!(p & 0xf0)) { e = C.VOLFX_PANSLIDERIGHT; p &= 0xf; ok = p < 10 ? 1 : 0; return set(); }
		if (!(p & 0x0f)) { e = C.VOLFX_PANSLIDELEFT; p >>= 4; ok = p < 10 ? 1 : 0; return set(); }
		return 0;
	default: return 0;
	}
}

// player/csndfile.c csf_import_mod_effect
export function csf_import_mod_effect(m, from_xm) {
	let effect = m.effect, param = m.param;
	if (!param || (effect === 0x0e && !(param & 0xf))) {
		switch (effect) {
		case 0x01: case 0x02: case 0x0a: if (!from_xm) effect = 0; break;
		case 0x0e:
			switch (param & 0xf0) {
			case 0x10: case 0x20: case 0xa0: case 0xb0: if (from_xm) break; // fallthrough
			// eslint-disable-next-line no-fallthrough
			case 0x90: effect = param = 0; break;
			}
			break;
		}
	}
	switch (effect) {
	case 0x00: if (param) effect = C.FX_ARPEGGIO; break;
	case 0x01: effect = C.FX_PORTAMENTOUP; break;
	case 0x02: effect = C.FX_PORTAMENTODOWN; break;
	case 0x03: effect = C.FX_TONEPORTAMENTO; break;
	case 0x04: effect = C.FX_VIBRATO; break;
	case 0x05: effect = C.FX_TONEPORTAVOL; if (param & 0xf0) param &= 0xf0; break;
	case 0x06: effect = C.FX_VIBRATOVOL; if (param & 0xf0) param &= 0xf0; break;
	case 0x07: effect = C.FX_TREMOLO; break;
	case 0x08: effect = C.FX_PANNING; break;
	case 0x09: effect = C.FX_OFFSET; break;
	case 0x0a:
		effect = C.FX_VOLUMESLIDE;
		param = (param & 0xf0) ? param & 0xf0 : param & 0x0f;
		if (param === 0xf0) param = 0xe0; else if (param === 0x0f) param = 0x0e;
		break;
	case 0x0b: effect = C.FX_POSITIONJUMP; break;
	case 0x0c:
		if (from_xm) effect = C.FX_VOLUME;
		else { m.voleffect = C.VOLFX_VOLUME; m.volparam = clamp(param, 0, 64); effect = param = 0; }
		break;
	case 0x0d: effect = C.FX_PATTERNBREAK; param = ((param >> 4) * 10) + (param & 0x0f); break;
	case 0x0e:
		effect = C.FX_SPECIAL;
		switch (param & 0xf0) {
		case 0x10: effect = C.FX_PORTAMENTOUP; param |= 0xf0; break;
		case 0x20: effect = C.FX_PORTAMENTODOWN; param |= 0xf0; break;
		case 0x30: param = (param & 0x0f) | 0x10; break;
		case 0x40: param = (param & 0x0f) | 0x30; break;
		case 0x50: param = (param & 0x0f) | 0x20; break;
		case 0x60: param = (param & 0x0f) | 0xb0; break;
		case 0x70: param = (param & 0x0f) | 0x40; break;
		case 0x90: effect = C.FX_RETRIG; param &= 0x0f; break;
		case 0xa0: effect = C.FX_VOLUMESLIDE; param = (param & 0x0f) ? ((param << 4) | 0x0f) & 0xff : 0; break;
		case 0xb0: effect = C.FX_VOLUMESLIDE; param = (param & 0x0f) ? 0xf0 | Math.min(param & 0x0f, 0x0e) : 0; break;
		}
		break;
	case 0x0f: effect = param < (from_xm ? 0x20 : 0x21) ? C.FX_SPEED : C.FX_TEMPO; break;
	case 16: effect = C.FX_GLOBALVOLUME; param = Math.min(param << 1, 0x80); break; // G
	case 17: effect = C.FX_GLOBALVOLSLIDE; // H
		param = Math.min((param & 0xf0) << 1, 0xf0) | Math.min((param & 0xf) << 1, 0xf); break;
	case 20: effect = C.FX_KEYOFF; break; // K
	case 21: effect = C.FX_SETENVPOSITION; break; // L
	case 22: effect = C.FX_CHANNELVOLUME; break; // M
	case 23: effect = C.FX_CHANNELVOLSLIDE; break; // N
	case 25: effect = C.FX_PANNINGSLIDE; // P
		param = (param & 0xf0) ? param >> 4 : (param & 0xf) << 4; break;
	case 27: effect = C.FX_RETRIG; break; // R
	case 29: effect = C.FX_TREMOR; break; // T
	case 33: // X
		switch (param & 0xf0) {
		case 0x10: effect = C.FX_PORTAMENTOUP; param = 0xe0 | (param & 0xf); break;
		case 0x20: effect = C.FX_PORTAMENTODOWN; param = 0xe0 | (param & 0xf); break;
		case 0x50: case 0x60: case 0x70: case 0x90: case 0xa0: effect = C.FX_SPECIAL; break;
		default: effect = param = 0; break;
		}
		break;
	case 34: effect = C.FX_PANBRELLO; break; // Y
	case 35: effect = C.FX_MIDI; break; // Z
	default: effect = 0;
	}
	m.effect = effect;
	m.param = param & 0xff;
}

// ------------------------------------------------------------------------
// fmt/its.c

export function load_its_sample(fp, smp, cwtv) {
	if (cstr(fp, 4) !== 'IMPS') return 0;
	const filename = cstr(fp, 12); u8(fp);
	const gvl = u8(fp); let flags = u8(fp); const vol = u8(fp);
	const name = cstr(fp, 26); const cvt = u8(fp), dfp = u8(fp);
	const length = u32(fp), loopbegin = u32(fp), loopend = u32(fp), c5speed = u32(fp);
	const susloopbegin = u32(fp), susloopend = u32(fp), samplepointer = u32(fp);
	const vis = u8(fp), vid = u8(fp), vir = u8(fp), vit = u8(fp);

	smp.length = length;
	smp.global_volume = gvl;
	if (flags & 16) { smp.flags |= C.CHN_LOOP; if (flags & 64) smp.flags |= C.CHN_PINGPONGLOOP; }
	if (flags & 32) { smp.flags |= C.CHN_SUSTAINLOOP; if (flags & 128) smp.flags |= C.CHN_PINGPONGSUSTAIN; }
	if (cwtv < 0x0214) flags &= ~4;
	smp.name = name.slice(0, 25);
	smp.filename = filename;
	smp.volume = vol * 4;
	smp.panning = (dfp & 127) * 4;
	if (dfp & 128) smp.flags |= C.CHN_PANNING;
	smp.loop_start = loopbegin; smp.loop_end = loopend;
	smp.c5speed = c5speed;
	smp.sustain_start = susloopbegin; smp.sustain_end = susloopend;
	smp.vib_type = [C.VIB_SINE, C.VIB_RAMP_DOWN, C.VIB_SQUARE, C.VIB_RANDOM][vit & 3];
	smp.vib_rate = vir; smp.vib_depth = vid; smp.vib_speed = vis;

	const pos = tell(fp);
	let r;
	if ((flags & 1) && cvt === 64 && length === 12) {
		seek(fp, samplepointer);
		smp.adlib_bytes = bytes(fp, 12);
		smp.flags |= C.CHN_ADLIB;
		smp.length = 1;
		smp.data = new Int8Array(1);
		r = 12;
	} else if (flags & 1) {
		seek(fp, samplepointer);
		let sf = C.SF_LE | ((flags & 4) ? C.SF_SS : C.SF_M);
		if (flags & 8) sf |= (cvt & 4) ? C.SF_IT215 : C.SF_IT214;
		else sf |= (cvt & 4) ? C.SF_PCMD : (cvt & 1) ? C.SF_PCMS : C.SF_PCMU;
		sf |= (flags & 2) ? C.SF_16 : C.SF_8;
		r = read_sample(smp, sf, fp);
	} else {
		r = smp.length = 0;
	}
	seek(fp, pos);
	return r;
}

// ------------------------------------------------------------------------
// fmt/iti.c

function load_it_notetrans(instrument, fp) {
	for (let n = 0; n < 120; n++) {
		let note = getc(fp), smp = getc(fp);
		if (note < 0 || smp < 0) return 0;
		note += C.NOTE_FIRST;
		if (!(note > 0 && note <= C.NOTE_LAST)) note = n + C.NOTE_FIRST;
		instrument.note_map[n] = note;
		instrument.sample_map[n] = smp;
	}
	return 1;
}
const env_flags = [
	[C.ENV_VOLUME, C.ENV_VOLLOOP, C.ENV_VOLSUSTAIN, C.ENV_VOLCARRY],
	[C.ENV_PANNING, C.ENV_PANLOOP, C.ENV_PANSUSTAIN, C.ENV_PANCARRY],
	[C.ENV_PITCH, C.ENV_PITCHLOOP, C.ENV_PITCHSUSTAIN, C.ENV_PITCHCARRY],
];
function load_it_envelope(env, fp, envtype, adj) {
	const eflags = u8(fp), num = u8(fp), lpb = u8(fp), lpe = u8(fp), slb = u8(fp), sle = u8(fp);
	const nodes = [];
	for (let i = 0; i < 25; i++) nodes.push([s8(fp), u16(fp)]);
	u8(fp);
	env.nodes = clamp(num, 2, 25);
	env.loop_start = Math.min(lpb, env.nodes);
	env.loop_end = clamp(lpe, env.loop_start, env.nodes);
	env.sustain_start = Math.min(slb, env.nodes);
	env.sustain_end = clamp(sle, env.sustain_start, env.nodes);
	for (let n = 0; n < env.nodes; n++) {
		env.values[n] = clamp(nodes[n][0] + adj, 0, 64);
		env.ticks[n] = nodes[n][1];
	}
	env.ticks[0] = 0;
	let flags = 0;
	for (let n = 0; n < 4; n++) if (eflags & (1 << n)) flags |= env_flags[envtype][n];
	if (envtype === 2 && (eflags & 0x80)) flags |= C.ENV_FILTER;
	return flags;
}
export function load_it_instrument(instrument, fp) {
	if (cstr(fp, 4) !== 'IMPI') return 0;
	const filename = cstr(fp, 12); u8(fp);
	const nna = u8(fp), dct = u8(fp), dca = u8(fp), fadeout = u16(fp);
	const pps = s8(fp), ppc = u8(fp), gbv = u8(fp), dfp = u8(fp), rv = u8(fp), rp = u8(fp);
	u16(fp); u8(fp); u8(fp);
	const name = cstr(fp, 26);
	const ifc = u8(fp), ifr = u8(fp), mch = u8(fp), mpr = u8(fp), mbank = u16(fp);
	instrument.name = name.slice(0, 25);
	instrument.filename = filename;
	instrument.nna = nna % 4; instrument.dct = dct % 4; instrument.dca = dca % 3;
	instrument.fadeout = fadeout << 5;
	instrument.pitch_pan_separation = clamp(pps, -32, 32);
	instrument.pitch_pan_center = Math.min(ppc, 119);
	instrument.global_volume = Math.min(gbv, 128);
	instrument.panning = Math.min(dfp & 127, 64) * 4;
	if (!(dfp & 128)) instrument.flags |= C.ENV_SETPANNING;
	instrument.vol_swing = Math.min(rv, 100);
	instrument.pan_swing = Math.min(rp, 64);
	instrument.ifc = ifc; instrument.ifr = ifr;
	instrument.midi_channel_mask = mch > 16 ? 0x10000 + mch : mch > 0 ? 1 << (mch - 1) : 0;
	instrument.midi_program = mpr;
	instrument.midi_bank = mbank;
	if (!load_it_notetrans(instrument, fp)) return 0;
	instrument.flags |= load_it_envelope(instrument.vol_env, fp, 0, 0);
	instrument.flags |= load_it_envelope(instrument.pan_env, fp, 1, 32);
	instrument.flags |= load_it_envelope(instrument.pitch_env, fp, 2, 32);
	fp.position += 4;
	return 1;
}
function load_it_instrument_old(instrument, fp) {
	if (cstr(fp, 4) !== 'IMPI') return 0;
	const filename = cstr(fp, 12); u8(fp);
	const flags = u8(fp), vls = u8(fp), vle = u8(fp), sls = u8(fp), sle = u8(fp);
	u16(fp); const fadeout = u16(fp); const nna = u8(fp), dnc = u8(fp);
	u16(fp); u8(fp); u8(fp);
	const name = cstr(fp, 26); fp.position += 6;
	instrument.name = name.slice(0, 25); instrument.filename = filename;
	instrument.nna = nna % 4;
	if (dnc) { instrument.dct = C.DCT_NOTE; instrument.dca = C.DCA_NOTECUT; }
	instrument.fadeout = fadeout << 6;
	instrument.pitch_pan_separation = 0;
	instrument.pitch_pan_center = C.NOTE_MIDC;
	instrument.global_volume = 128;
	instrument.panning = 32 * 4;
	if (!load_it_notetrans(instrument, fp)) return 0;
	if (flags & 1) instrument.flags |= C.ENV_VOLUME;
	if (flags & 2) instrument.flags |= C.ENV_VOLLOOP;
	if (flags & 4) instrument.flags |= C.ENV_VOLSUSTAIN;
	Object.assign(instrument.vol_env, { loop_start: vls, loop_end: vle, sustain_start: sls, sustain_end: sle, nodes: 25 });
	fp.position += 200;
	const nodes = bytes(fp, 50);
	for (let n = 0; n < 25; n++) {
		const node = nodes[2 * n];
		if (node === 0xff) { instrument.vol_env.nodes = n; break; }
		instrument.vol_env.ticks[n] = node;
		instrument.vol_env.values[n] = nodes[2 * n + 1];
	}
	return 1;
}

// ------------------------------------------------------------------------
// fmt/it.c

function it_import_voleffect(note, v) {
	let adj;
	if (v <= 64) { adj = 0; note.voleffect = C.VOLFX_VOLUME; }
	else if (v >= 128 && v <= 192) { adj = 128; note.voleffect = C.VOLFX_PANNING; }
	else if (v >= 65 && v <= 74) { adj = 65; note.voleffect = C.VOLFX_FINEVOLUP; }
	else if (v >= 75 && v <= 84) { adj = 75; note.voleffect = C.VOLFX_FINEVOLDOWN; }
	else if (v >= 85 && v <= 94) { adj = 85; note.voleffect = C.VOLFX_VOLSLIDEUP; }
	else if (v >= 95 && v <= 104) { adj = 95; note.voleffect = C.VOLFX_VOLSLIDEDOWN; }
	else if (v >= 105 && v <= 114) { adj = 105; note.voleffect = C.VOLFX_PORTADOWN; }
	else if (v >= 115 && v <= 124) { adj = 115; note.voleffect = C.VOLFX_PORTAUP; }
	else if (v >= 193 && v <= 202) { adj = 193; note.voleffect = C.VOLFX_TONEPORTAMENTO; }
	else if (v >= 203 && v <= 212) { adj = 203; note.voleffect = C.VOLFX_VIBRATODEPTH; }
	else return;
	note.volparam = v - adj;
}

function load_it_pattern(pat, fp, rows, cwtv) {
	const last = Array.from({ length: 64 }, () => ({ note: 0, instrument: 0, voleffect: 0, volparam: 0, effect: 0, param: 0 }));
	const last_mask = new Uint8Array(64);
	let row = 0, base = 0;
	while (row < rows) {
		const chanvar = getc(fp);
		if (chanvar < 0) return;
		if (chanvar === 0) { row++; base += 64; continue; }
		const chan = (chanvar - 1) % 64;
		let maskvar;
		if (chanvar & 128) { maskvar = u8(fp); last_mask[chan] = maskvar; }
		else maskvar = last_mask[chan];
		const note = pat[base + chan] || {}, ln = last[chan];
		if (maskvar & 1) {
			let c = u8(fp);
			if (c === 255) c = C.NOTE_OFF;
			else if (c === 254) c = C.NOTE_CUT;
			else if (c > 119) c = C.NOTE_FADE;
			else c += C.NOTE_FIRST;
			note.note = ln.note = c;
		}
		if (maskvar & 2) note.instrument = ln.instrument = u8(fp);
		if (maskvar & 4) {
			it_import_voleffect(note, u8(fp));
			ln.voleffect = note.voleffect; ln.volparam = note.volparam;
		}
		if (maskvar & 8) {
			note.effect = u8(fp) & 0x1f;
			note.param = u8(fp);
			csf_import_s3m_effect(note, 1);
			if (note.effect === C.FX_SPECIAL && (note.param & 0xf0) === 0xa0 && cwtv < 0x0200) note.effect = C.FX_NONE;
			else if (note.effect === C.FX_GLOBALVOLUME && note.param > 0x80 && cwtv >= 0x1000 && cwtv <= 0x1050) note.param = 0x80;
			ln.effect = note.effect; ln.param = note.param;
		}
		if (maskvar & 16) note.note = ln.note;
		if (maskvar & 32) note.instrument = ln.instrument;
		if (maskvar & 64) { note.voleffect = ln.voleffect; note.volparam = ln.volparam; }
		if (maskvar & 128) { note.effect = ln.effect; note.param = ln.param; }
	}
}

const MIDI_FIELDS = ['start', 'stop', 'tick', 'note_on', 'note_off', 'set_volume', 'set_panning', 'set_bank', 'set_program'];
export function it_read_midi_config(midi, fp) {
	if (fp.position + 4896 > fp.bytes.length) return 0;
	const rd = () => cstr(fp, 32);
	for (const f of MIDI_FIELDS) midi[f] = rd();
	midi.sfx = Array.from({ length: 16 }, rd);
	midi.zxx = Array.from({ length: 128 }, rd);
	return 1;
}

export function fmt_it_load_song(song, fp) {
	if (cstr(fp, 4) !== 'IMPM') return LOAD_UNSUPPORTED;
	const hdr = {};
	hdr.songname = cstr(fp, 26, true);
	hdr.hilight_minor = u8(fp); hdr.hilight_major = u8(fp);
	hdr.ordnum = u16(fp); hdr.insnum = u16(fp); hdr.smpnum = u16(fp); hdr.patnum = u16(fp);
	hdr.cwtv = u16(fp); hdr.cmwt = u16(fp); hdr.flags = u16(fp); hdr.special = u16(fp);
	hdr.globalvol = u8(fp); hdr.mv = u8(fp); hdr.speed = u8(fp); hdr.tempo = u8(fp);
	hdr.sep = u8(fp); hdr.pwd = u8(fp); hdr.msglength = u16(fp); hdr.msgoffset = u32(fp);
	hdr.reserved = u32(fp);
	hdr.chnpan = bytes(fp, 64); hdr.chnvol = bytes(fp, 64);

	if (hdr.insnum > C.MAX_INSTRUMENTS || hdr.smpnum > C.MAX_SAMPLES || hdr.patnum > C.MAX_PATTERNS) return LOAD_FORMAT_ERROR;
	song.title = rtrim(hdr.songname);
	const ignoremidi = hdr.cmwt < 0x0214 && hdr.cwtv < 0x0214;
	if (hdr.special & 4) { song.row_highlight_minor = hdr.hilight_minor; song.row_highlight_major = hdr.hilight_major; }
	else { song.row_highlight_minor = 4; song.row_highlight_major = 16; }
	if (!(hdr.flags & 1)) song.flags |= C.SONG_NOSTEREO;
	if (hdr.flags & 4) song.flags |= C.SONG_INSTRUMENTMODE;
	if (hdr.flags & 8) song.flags |= C.SONG_LINEARSLIDES;
	if (hdr.flags & 16) song.flags |= C.SONG_ITOLDEFFECTS;
	if (hdr.flags & 32) song.flags |= C.SONG_COMPATGXX;
	if ((hdr.flags & 128) && !ignoremidi) song.flags |= C.SONG_EMBEDMIDICFG;
	else song.flags &= ~C.SONG_EMBEDMIDICFG;
	song.initial_global_volume = Math.min(hdr.globalvol, 128);
	song.mixing_volume = Math.min(hdr.mv, 128);
	song.initial_speed = hdr.speed || 6;
	song.initial_tempo = Math.max(hdr.tempo, 31);
	song.pan_separation = hdr.sep;
	for (let n = 0; n < 64; n++) {
		const channel = song.channels[n];
		let pan = hdr.chnpan[n];
		if (pan & 128) { channel.flags |= C.CHN_MUTE; pan &= ~128; }
		if (pan === 100) { channel.flags |= C.CHN_SURROUND; channel.panning = 32; }
		else channel.panning = Math.min(pan, 64);
		channel.panning *= 4;
		channel.volume = Math.min(hdr.chnvol[n], 64);
	}
	const ord = bytes(fp, Math.min(hdr.ordnum, C.MAX_ORDERS));
	song.orderlist.set(ord);
	if (hdr.ordnum > C.MAX_ORDERS) fp.position += hdr.ordnum - C.MAX_ORDERS;
	const para_ins = [], para_smp = [], para_pat = [];
	for (let n = 0; n < hdr.insnum; n++) para_ins.push(u32(fp));
	for (let n = 0; n < hdr.smpnum; n++) para_smp.push(u32(fp));
	for (let n = 0; n < hdr.patnum; n++) para_pat.push(u32(fp));
	let para_min = (hdr.special & 1) && hdr.msglength ? hdr.msgoffset : 0xffffffff;
	for (const p of para_ins) if (p < para_min) para_min = p;
	for (const p of para_smp) if (p < para_min) para_min = p;
	for (const p of para_pat) if (p && p < para_min) para_min = p;
	let hist = 0;
	if (hdr.special & 2) {
		hist = u16(fp);
		if (para_min < tell(fp) + 8 * hist) hist = 0;
	}
	song.history = [];
	for (let i = 0; i < hist; i++) {
		const fat_date = u16(fp), fat_time = u16(fp), run_time = u32(fp);
		song.history.push({ fat_date, fat_time, runtime: Math.trunc(run_time * 1000 / 18.2) });
	}
	if (ignoremidi) { if (hdr.special & 8) fp.position += 4896; }
	else if (hdr.special & 8) it_read_midi_config(song.midi_config || (song.midi_config = {}), fp);
	if ((hdr.special & 1) && hdr.msglength && hdr.msgoffset + hdr.msglength <= fp.bytes.length) {
		seek(fp, hdr.msgoffset);
		song.message = cstr(fp, Math.min(8000, hdr.msglength));
	}
	for (let n = 0; n < hdr.insnum; n++) {
		if (!para_ins[n]) continue;
		seek(fp, para_ins[n]);
		const inst = song.instruments[n + 1] = csf_allocate_instrument();
		if (hdr.cmwt >= 0x0200) load_it_instrument(inst, fp);
		else load_it_instrument_old(inst, fp);
	}
	for (let n = 0; n < hdr.smpnum; n++) {
		seek(fp, para_smp[n]);
		load_its_sample(fp, song.samples[n + 1], hdr.cwtv);
	}
	for (let n = 0; n < hdr.patnum; n++) {
		if (!para_pat[n]) continue;
		seek(fp, para_pat[n]);
		u16(fp); const rows = u16(fp); fp.position += 4;
		song.patterns[n] = csf_allocate_pattern(rows);
		song.pattern_size[n] = song.pattern_alloc_size[n] = rows;
		load_it_pattern(song.patterns[n], fp, rows, hdr.cwtv);
	}
	const ver = `${(hdr.cwtv & 0xf00) >> 8}.${(hdr.cwtv & 0xff).toString(16).padStart(2, '0')}`;
	if ((hdr.cwtv >> 12) === 1) {
		song.tracker_id = 'Schism Tracker';
		fmt_fill_schism_quirks(song, hdr.cwtv === 0x1fff ? hdr.reserved : (hdr.cwtv & 0x0fff));
	} else if ((hdr.cwtv >> 12) === 5) song.tracker_id = 'OpenMPT ' + ver;
	else if (hdr.cwtv === 0x0888 || hdr.cwtv === 0x0300) song.tracker_id = 'OpenMPT 1.17+';
	else if (hdr.cwtv === 0x0217 && hdr.cmwt === 0x0200) song.tracker_id = 'Modplug Tracker / OpenMPT';
	else if ((hdr.cwtv >> 12) === 0) {
		if (hdr.cwtv >= 0x0215 && hdr.cwtv <= 0x0217) song.tracker_id = 'Impulse Tracker 2.14p' + ['1-2', '3', '4-5'][hdr.cwtv - 0x0215];
		else song.tracker_id = 'Impulse Tracker ' + ver;
	} else song.tracker_id = 'Unknown tracker';
	return LOAD_SUCCESS;
}

// ------------------------------------------------------------------------
// fmt/s3m.c

const s3m_pan_to_it = pan => (((pan & 0xf) << 2) + 2);
export function fmt_s3m_load_song(song, fp) {
	seek(fp, 44);
	if (cstr(fp, 4) !== 'SCRM') return LOAD_UNSUPPORTED;
	seek(fp, 0);
	song.title = cstr(fp, 25);
	fp.position = 25 + 7;
	const nord = u16(fp), nsmp = u16(fp), npat = u16(fp);
	if (nord > C.MAX_ORDERS || nsmp > C.MAX_SAMPLES || npat > C.MAX_PATTERNS) return LOAD_FORMAT_ERROR;
	let misc = 3; // S3M_UNSIGNED | S3M_CHANPAN
	song.flags = C.SONG_ITOLDEFFECTS;
	const flags = u16(fp), trkvers = u16(fp), ffi = u16(fp);
	void flags;
	if (ffi === 1) misc &= ~1;
	fp.position += 4;
	song.initial_global_volume = u8(fp) << 1;
	song.initial_speed = u8(fp) || 6;
	song.initial_tempo = u8(fp);
	if (song.initial_tempo <= 32) song.initial_tempo = 125;
	song.mixing_volume = u8(fp);
	if (song.mixing_volume & 0x80) song.mixing_volume ^= 0x80;
	else song.flags |= C.SONG_NOSTEREO;
	u8(fp);
	if (u8(fp) !== 0xfc) misc &= ~2;
	fp.position += 8 + 2;
	const channel_types = bytes(fp, 32);
	let adlib = 0;
	for (let n = 0; n < 32; n++) {
		let c = channel_types[n];
		const ch = song.channels[n];
		if (c & 0x80) { ch.flags |= C.CHN_MUTE; c &= ~0x80; }
		if (c < 0x08) ch.panning = 14;
		else if (c < 0x10) ch.panning = 50;
		else if (c < 0x19) { ch.panning = 32; adlib |= 1 << n; }
		else { ch.panning = 32; ch.flags |= C.CHN_MUTE; }
		ch.volume = 64;
	}
	for (let n = 32; n < 64; n++) Object.assign(song.channels[n], { panning: 32, volume: 64, flags: C.CHN_MUTE });
	song.orderlist.fill(C.ORDER_LAST);
	song.orderlist.set(bytes(fp, nord));
	const para_smp = [], para_pat = [];
	for (let n = 0; n < nsmp; n++) para_smp.push(u16(fp));
	for (let n = 0; n < npat; n++) para_pat.push(u16(fp));
	if (misc & 2) for (let n = 0; n < 32; n++) {
		const pan = u8(fp);
		if ((pan & 0x20) && (!(adlib & (1 << n)) || trkvers > 0x1320)) song.channels[n].panning = s3m_pan_to_it(pan);
	}
	for (let n = 0; n < 64; n++) song.channels[n].panning *= 4;
	const para_sdata = [], smp_flags = [];
	let gus_addresses = 0;
	for (let n = 0; n < nsmp; n++) {
		const sample = song.samples[n + 1];
		seek(fp, para_smp[n] << 4);
		const type = u8(fp);
		sample.filename = cstr(fp, 12);
		const b = bytes(fp, 3);
		if (type === 1) {
			para_sdata[n] = b[1] | (b[2] << 8) | (b[0] << 16);
			sample.length = u32(fp); sample.loop_start = u32(fp); sample.loop_end = u32(fp);
			sample.volume = u8(fp) * 4; u8(fp); u8(fp);
			const c = u8(fp);
			if (c & 1) sample.flags |= C.CHN_LOOP;
			smp_flags[n] = C.SF_LE | ((misc & 1) ? C.SF_PCMU : C.SF_PCMS) | ((c & 4) ? C.SF_16 : C.SF_8) | ((c & 2) ? C.SF_SS : C.SF_M);
		} else if (type === 2) {
			sample.adlib_bytes = bytes(fp, 12);
			sample.volume = u8(fp) * 4; fp.position += 3;
			sample.flags |= C.CHN_ADLIB; sample.length = 1; sample.data = new Int8Array(1);
		} else {
			fp.position += 12; sample.volume = u8(fp) * 4; fp.position += 3;
		}
		sample.c5speed = u32(fp);
		if (type === 2 && (sample.c5speed < 1000 || sample.c5speed > 0xffff)) sample.c5speed = 8363;
		fp.position += 4;
		gus_addresses |= u16(fp);
		fp.position += 6;
		sample.name = cstr(fp, 25);
		sample.vib_type = sample.vib_rate = sample.vib_depth = sample.vib_speed = 0;
		sample.global_volume = 64;
	}
	for (let n = 0; n < nsmp; n++) {
		const sample = song.samples[n + 1];
		if (!sample.length || (sample.flags & C.CHN_ADLIB)) continue;
		seek(fp, para_sdata[n] << 4);
		read_sample(sample, smp_flags[n], fp);
	}
	if (gus_addresses > 1) song.mixing_volume = 48;
	for (let n = 0; n < npat; n++) {
		if (!para_pat[n]) continue;
		seek(fp, para_pat[n] << 4);
		const end = (para_pat[n] << 4) + u16(fp) + 2;
		const pat = song.patterns[n] = csf_allocate_pattern(64);
		let row = 0;
		while (row < 64 && tell(fp) < end) {
			const mask = getc(fp);
			if (mask < 0) break;
			if (!mask) { row++; continue; }
			const chn = mask & 31;
			const note = pat[64 * row + chn];
			if (mask & 32) {
				note.note = u8(fp); note.instrument = u8(fp);
				if (note.note === 255) note.note = C.NOTE_NONE;
				else if (note.note === 254) note.note = (adlib & (1 << chn)) ? C.NOTE_OFF : C.NOTE_CUT;
				else note.note = (note.note >> 4) * 12 + (note.note & 0xf) + 13;
			}
			if (mask & 64) {
				note.voleffect = C.VOLFX_VOLUME;
				note.volparam = u8(fp);
				if (note.volparam === 255) { note.voleffect = C.VOLFX_NONE; note.volparam = 0; }
				else if (note.volparam >= 128 && note.volparam <= 192) { note.voleffect = C.VOLFX_PANNING; note.volparam -= 128; }
				else if (note.volparam > 64) note.volparam = 64;
			}
			if (mask & 128) {
				note.effect = u8(fp); note.param = u8(fp);
				csf_import_s3m_effect(note, 0);
				if (note.effect === C.FX_SPECIAL) {
					if (note.param === 0xd0) Object.assign(note, { note: 0, instrument: 0, voleffect: 0, volparam: 0, effect: 0, param: 0 });
					else if (note.param === 0xc0) { note.effect = 0; note.param = 0; }
					else if ((note.param & 0xf0) === 0xa0) {
						const ctype = channel_types[chn] & 0x7f;
						if (gus_addresses > 1 || ctype >= 0x10) note.effect = 0;
						else if (note.param === 0xa0 || note.param === 0xa2) note.param = (ctype & 8) ? 0x8c : 0x83;
						else if (note.param === 0xa1 || note.param === 0xa3) note.param = (ctype & 8) ? 0x83 : 0x8c;
						else if (note.param <= 0xa7) note.param = 0x88;
						else note.effect = 0;
					}
				}
			}
		}
	}
	const v = `${(trkvers & 0xf00) >> 8}.${(trkvers & 0xff).toString(16).padStart(2, '0')}`;
	switch (trkvers >> 12) {
	case 1: song.tracker_id = 'Scream Tracker ' + v; break;
	case 2: song.tracker_id = 'Imago Orpheus ' + v; break;
	case 3: song.tracker_id = 'Impulse Tracker ' + v; break;
	case 4: song.tracker_id = 'Schism Tracker'; break;
	case 5: song.tracker_id = 'OpenMPT ' + v; break;
	default: song.tracker_id = '';
	}
	return LOAD_SUCCESS;
}

// ------------------------------------------------------------------------
// fmt/xm.c

const autovib_import = [C.VIB_SINE, C.VIB_SQUARE, C.VIB_RAMP_DOWN, C.VIB_RAMP_DOWN, C.VIB_RANDOM, C.VIB_SINE, C.VIB_SINE, C.VIB_SINE];

function load_xm_patterns(song, hdr, fp) {
	for (let pat = 0; pat < hdr.patterns; pat++) {
		const start = tell(fp);
		let patlen = u32(fp);
		u8(fp);
		let rows;
		if (hdr.version === 0x0102) { rows = u8(fp) + 1; patlen++; }
		else rows = u16(fp);
		const nbytes = u16(fp);
		seek(fp, start + patlen);
		if (!rows) continue;
		if (pat >= C.MAX_PATTERNS) { fp.position += nbytes; continue; }
		const pattern = song.patterns[pat] = csf_allocate_pattern(rows);
		song.pattern_size[pat] = song.pattern_alloc_size[pat] = rows;
		if (!nbytes) continue;
		const end = tell(fp) + nbytes;
		fp.limit = end;
		for (let row = 0; row < rows; row++) {
			for (let chan = 0; !eof(fp) && chan < hdr.channels; chan++) {
				const note = pattern[row * 64 + chan];
				const b = u8(fp);
				if (b & 128) {
					if (b & 1) note.note = u8(fp);
					if (b & 2) note.instrument = u8(fp);
					if (b & 4) note.volparam = u8(fp);
					if (b & 8) note.effect = u8(fp);
					if (b & 16) note.param = u8(fp);
				} else {
					note.note = b; note.instrument = u8(fp); note.volparam = u8(fp);
					note.effect = u8(fp); note.param = u8(fp);
				}
				if (note.note > 0 && note.note < 97) note.note += 12;
				else if (note.note === 97) { note.note = C.NOTE_OFF; note.instrument = 0; }
				else note.note = C.NOTE_NONE;
				if (note.effect || note.param) csf_import_mod_effect(note, 1);
				if (note.instrument === 0xff) note.instrument = 0;
				const hi = note.volparam >> 4;
				if ((hi >= 1 && hi <= 4) || note.volparam === 0x50) { note.voleffect = C.FX_VOLUME; note.volparam -= 0x10; }
				else switch (hi) {
				case 0: case 5: note.voleffect = C.FX_NONE; note.volparam = 0; break;
				case 6: note.volparam &= 0xf; if (note.volparam) note.voleffect = C.FX_VOLUMESLIDE; break;
				case 7: note.volparam = (note.volparam & 0xf) << 4; if (note.volparam) note.voleffect = C.FX_VOLUMESLIDE; break;
				case 8: note.volparam &= 0xf;
					if (note.volparam) { if (note.volparam === 0xf) note.volparam = 0xe; note.volparam |= 0xf0; note.voleffect = C.FX_VOLUMESLIDE; }
					break;
				case 9: note.volparam = (note.volparam & 0xf) << 4;
					if (note.volparam) { note.volparam |= 0xf; note.voleffect = C.FX_VOLUMESLIDE; }
					break;
				case 10: note.volparam = (note.volparam & 0xf) << 4; note.voleffect = C.FX_VIBRATO; break;
				case 11: note.volparam &= 0xf; note.voleffect = C.FX_VIBRATO; break;
				case 12: note.voleffect = C.FX_SPECIAL; note.volparam = 0x80 | (note.volparam & 0xf); break;
				case 13: note.volparam &= 0xf;
					if (note.volparam) { note.volparam <<= 4; note.voleffect = C.FX_PANNINGSLIDE; }
					else { note.volparam = 0x80; note.voleffect = C.FX_SPECIAL; }
					break;
				case 14: note.volparam &= 0xf; if (note.volparam) note.voleffect = C.FX_PANNINGSLIDE; break;
				case 15: note.volparam = (note.volparam & 0xf) << 4; note.voleffect = C.FX_TONEPORTAMENTO; break;
				}
				if (note.effect === C.FX_KEYOFF && note.param === 0) { note.note = C.NOTE_NONE; note.instrument = 0; }
				else if (note.note === C.NOTE_OFF && note.effect === C.FX_SPECIAL && (note.param >> 4) === 0xd) {
					note.note = C.NOTE_NONE; note.instrument = 0;
					if (note.voleffect === C.FX_PANNING) { note.voleffect = note.volparam = note.effect = note.param = 0; }
				}
				if (note.effect === C.FX_NONE && note.voleffect !== C.FX_NONE) swap_effects(note);
				else if (note.effect === note.voleffect) note.voleffect = note.volparam = 0;
				if (note.effect === C.FX_VOLUME) swap_effects(note);
				let n;
				for (n = 0; n < 4; n++) {
					if (convert_voleffect_of(note, n >> 1)) { n = 5; break; }
					swap_effects(note);
				}
				if (n < 5) {
					if (effect_weight[note.voleffect] > effect_weight[note.effect]) { note.effect = note.voleffect; note.param = note.volparam; }
					note.voleffect = note.volparam = 0;
				}
			}
		}
		fp.limit = Infinity;
		seek(fp, end);
	}
}

function load_xm_samples(song, first, total, fp) {
	for (let ns = 0; ns < total; ns++) {
		const smp = song.samples[first + ns];
		if (!smp.length) continue;
		if (smp.flags & C.CHN_16BIT) { smp.length >>= 1; smp.loop_start >>= 1; smp.loop_end >>= 1; }
		if (smp.flags & C.CHN_STEREO) { smp.length >>= 1; smp.loop_start >>= 1; smp.loop_end >>= 1; }
		const bytesize = smp.length * ((smp.flags & C.CHN_16BIT) ? 2 : 1) * ((smp.flags & C.CHN_STEREO) ? 2 : 1);
		const pos = tell(fp);
		if (smp.adlib_bytes[0] !== 0xad) {
			read_sample(smp, C.SF_LE | ((smp.flags & C.CHN_STEREO) ? C.SF_SS : C.SF_M) | C.SF_PCMD | ((smp.flags & C.CHN_16BIT) ? C.SF_16 : C.SF_8), fp);
			seek(fp, pos + bytesize);
		} else {
			smp.adlib_bytes[0] = 0;
			read_sample(smp, C.SF_8 | C.SF_M | C.SF_LE | C.SF_PCMD16, fp);
		}
	}
}

function fix_xm_envelope_loop(env, sustain_flag) {
	if (env.loop_end <= 0) return;
	if (env.ticks[env.loop_end - 1] === env.ticks[env.loop_end] - 1) { env.loop_end--; return; }
	for (let n = env.nodes; n > env.loop_end; n--) { env.ticks[n] = env.ticks[n - 1]; env.values[n] = env.values[n - 1]; }
	env.nodes++;
	env.ticks[env.loop_end]--;
	let v = env.values[env.loop_end + 1] - env.values[env.loop_end - 1];
	v *= env.ticks[env.loop_end] - env.ticks[env.loop_end - 1];
	v /= env.ticks[env.loop_end + 1] - env.ticks[env.loop_end - 1];
	v = v >= 0 ? v + 0.5 : v - 0.5;
	env.values[env.loop_end] = (Math.trunc(v) & 0xff) + env.values[env.loop_end - 1];
	if (sustain_flag && env.sustain_start >= env.loop_end) { env.sustain_start++; env.sustain_end++; }
}

function load_xm_instruments(song, hdr, fp) {
	let abssamp = 1;
	for (let ni = 1; ni <= hdr.instruments; ni++) {
		const istart = tell(fp);
		const ihdr = u32(fp) | 0;
		if (ni >= C.MAX_INSTRUMENTS) break;
		const ins = song.instruments[ni] = csf_allocate_instrument();
		ins.name = cstr(fp, 22);
		u8(fp);
		const nsmp = u16(fp);
		const shdr = u32(fp) | 0;
		if (!nsmp) { seek(fp, istart + ihdr); continue; }
		for (let n = 0; n < 120; n++) ins.note_map[n] = n + 1;
		for (let n = 0; n < 12; n++) ins.sample_map[n] = 0;
		for (let n = 12; n < 108; n++) ins.sample_map[n] = u8(fp) + abssamp;
		const envs = [[ins.vol_env, C.ENV_VOLUME, C.ENV_VOLSUSTAIN, C.ENV_VOLLOOP], [ins.pan_env, C.ENV_PANNING, C.ENV_PANSUSTAIN, C.ENV_PANLOOP]];
		for (const [env] of envs) {
			let prevtick = 0;
			for (let n = 0; n < 12; n++) {
				let w = u16(fp);
				if (n > 0 && w < prevtick && !(w & 0xff00)) { w |= prevtick & 0xff00; if (w < prevtick) w += 0x100; }
				env.ticks[n] = prevtick = w & 0xffff;
				env.values[n] = Math.min(u16(fp), 64);
			}
		}
		for (const [env] of envs) { const b = getc(fp); if (b >= 0) env.nodes = clamp(b, 0, 12); }
		for (const [env] of envs) {
			let b = u8(fp); env.sustain_start = env.sustain_end = clamp(b, 0, env.nodes);
			b = u8(fp); env.loop_start = clamp(b, 0, env.nodes);
			b = u8(fp); env.loop_end = clamp(b, 0, env.nodes);
		}
		for (const [env, f, sf, lf] of envs) {
			const b = getc(fp);
			if (b >= 0) {
				if ((b & 1) && env.nodes > 0) ins.flags |= f;
				if (b & 2) ins.flags |= sf;
				if (b & 4) ins.flags |= lf;
			}
		}
		const vtype = autovib_import[u8(fp) & 7];
		let vsweep = u8(fp), vdepth = Math.min(u8(fp), 32), vrate = Math.min(u8(fp), 64);
		if (vrate | vdepth) vsweep = vsweep ? clamp(Math.trunc((vdepth * 256 + (vsweep >> 1)) / vsweep), 0, 255) : 255;
		ins.fadeout = u16(fp);
		if (ins.flags & C.ENV_VOLUME) {
			if (!(ins.flags & C.ENV_VOLLOOP) || ins.vol_env.loop_start === ins.vol_env.loop_end)
				ins.vol_env.loop_start = ins.vol_env.loop_end = ins.vol_env.nodes - 1;
			else fix_xm_envelope_loop(ins.vol_env, ins.flags & C.ENV_VOLSUSTAIN);
			if (!(ins.flags & C.ENV_VOLSUSTAIN)) ins.vol_env.sustain_start = ins.vol_env.sustain_end = ins.vol_env.nodes - 1;
			ins.flags |= C.ENV_VOLLOOP | C.ENV_VOLSUSTAIN;
			if (ins.vol_env.sustain_start > ins.vol_env.loop_start) ins.flags &= ~C.ENV_VOLSUSTAIN;
		} else {
			ins.vol_env.ticks[0] = 0; ins.vol_env.ticks[1] = 1;
			ins.vol_env.values[0] = 64; ins.vol_env.values[1] = 0;
			ins.vol_env.nodes = 2; ins.vol_env.sustain_start = ins.vol_env.sustain_end = 0;
			ins.flags |= C.ENV_VOLUME | C.ENV_VOLSUSTAIN;
		}
		if ((ins.flags & C.ENV_PANNING) && (ins.flags & C.ENV_PANLOOP)) {
			if (ins.pan_env.loop_start === ins.pan_env.loop_end) ins.flags &= ~C.ENV_PANLOOP;
			else fix_xm_envelope_loop(ins.pan_env, ins.flags & C.ENV_PANSUSTAIN);
		}
		ins.panning = 128; ins.global_volume = 128; ins.pitch_pan_center = 60;
		const midi_enabled = u8(fp), mch = u8(fp);
		ins.midi_channel_mask = midi_enabled === 1 ? 1 << Math.min(mch, 15) : 0;
		ins.midi_program = Math.min(u16(fp), 127);
		u16(fp);
		if (getc(fp) === 1) ins.global_volume = 0;
		seek(fp, istart + ihdr);
		let ns;
		for (ns = 0; ns < nsmp; ns++) {
			if (abssamp + ns >= C.MAX_SAMPLES) break;
			const smp = song.samples[abssamp + ns];
			const sstart = tell(fp);
			smp.length = u32(fp);
			smp.loop_start = u32(fp);
			smp.loop_end = (u32(fp) + smp.loop_start) >>> 0;
			smp.volume = Math.min(64, u8(fp)) * 4;
			smp.global_volume = 64;
			smp.flags = C.CHN_PANNING;
			const finetune = s8(fp);
			let b = u8(fp);
			if (smp.loop_start >= smp.loop_end) b &= ~3;
			switch (b & 3) {
			case 3: case 2: smp.flags |= C.CHN_PINGPONGLOOP; // fallthrough
			// eslint-disable-next-line no-fallthrough
			case 1: smp.flags |= C.CHN_LOOP; break;
			}
			if (b & 0x10) smp.flags |= C.CHN_16BIT;
			if (b & 0x20) smp.flags |= C.CHN_STEREO;
			smp.panning = u8(fp);
			const relnote = s8(fp);
			smp.c5speed = transpose_to_frequency(relnote, finetune);
			const reserved = u8(fp);
			if (reserved === 0xad && !(b & 0x30)) smp.adlib_bytes[0] = 0xad;
			smp.name = cstr(fp, 22);
			smp.vib_type = vtype; smp.vib_rate = vsweep; smp.vib_depth = vdepth; smp.vib_speed = vrate;
			seek(fp, sstart + shdr);
		}
		if (hdr.version === 0x0104) load_xm_samples(song, abssamp, ns, fp);
		abssamp += ns;
		if (ns !== nsmp) break;
	}
	return hdr.version < 0x0104 ? abssamp : 0;
}

export function fmt_xm_load_song(song, fp) {
	if (cstr(fp, 17) !== 'Extended Module: ') return LOAD_UNSUPPORTED;
	const name = cstr(fp, 20);
	if (u8(fp) !== 0x1a) return LOAD_UNSUPPORTED;
	const tracker = cstr(fp, 20);
	const hdr = { version: u16(fp), headersz: u32(fp), songlen: u16(fp), restart: u16(fp),
		channels: u16(fp), patterns: u16(fp), instruments: u16(fp), flags: u16(fp), tempo: u16(fp), bpm: u16(fp) };
	if (hdr.channels > C.MAX_CHANNELS) return LOAD_UNSUPPORTED;
	song.title = name; song.tracker_id = rtrim(tracker);
	if (hdr.flags & 1) song.flags |= C.SONG_LINEARSLIDES;
	song.flags |= C.SONG_ITOLDEFFECTS | C.SONG_COMPATGXX | C.SONG_INSTRUMENTMODE;
	song.initial_speed = Math.min(hdr.tempo, 255) || 255;
	song.initial_tempo = clamp(hdr.bpm, 31, 255);
	song.initial_global_volume = 128;
	song.mixing_volume = 48;
	for (let n = 0; n < hdr.channels; n++) song.channels[n].panning = 128;
	for (let n = hdr.channels; n < 64; n++) song.channels[n].flags |= C.CHN_MUTE;
	hdr.songlen = Math.min(C.MAX_ORDERS, hdr.songlen);
	for (let n = 0; n < hdr.songlen; n++) { const b = u8(fp); song.orderlist[n] = b >= C.MAX_PATTERNS ? C.ORDER_SKIP : b; }
	seek(fp, 60 + hdr.headersz);
	if (hdr.version === 0x0104) {
		load_xm_patterns(song, hdr, fp);
		load_xm_instruments(song, hdr, fp);
	} else {
		const nsamp = load_xm_instruments(song, hdr, fp);
		load_xm_patterns(song, hdr, fp);
		load_xm_samples(song, 1, nsamp - 1, fp);
	}
	csf_insert_restart_pos(song, hdr.restart);
	return LOAD_SUCCESS;
}

// ------------------------------------------------------------------------
// fmt/mod.c

const PROTRACKER_PANNING = n => ((((n) + 1) >> 1) & 1) * 256;
const MOD_FINETUNE = b => finetune_table[((b) & 0xf) ^ 8];

function fmt_mod_load_song(song, fp, force) {
	seek(fp, 1080);
	const tag = cstr(fp, 4);
	const t = [...tag].map(c => c.charCodeAt(0));
	let nchan, startrekker = 0, his_masters_noise = 0, nsamples = 31, tid = null;
	const dig = c => c >= 48 && c <= 57;
	if (tag === 'M.K.') { nchan = 4; tid = 'Amiga-NewTracker'; }
	else if (tag === 'M!K!') { nchan = 4; tid = 'Amiga-ProTracker'; }
	else if (tag === 'M&K!' || tag === 'N.T.' || tag === 'FEST') { nchan = 4; tid = 'Amiga-NoiseTracker'; his_masters_noise = tag !== 'N.T.'; }
	else if ((tag.startsWith('FLT') || tag.startsWith('EXO')) && (tag[3] === '4' || tag[3] === '8')) { nchan = +tag[3]; startrekker = nchan === 8; tid = `${nchan} Channel Startrekker`; }
	else if (tag === 'OCTA' || tag === 'OKTA') { nchan = 8; tid = 'Amiga Oktalyzer'; }
	else if (tag === 'CD61' || tag === 'CD81') { nchan = 8; tid = '8 Channel Falcon'; }
	else if (t[0] > 48 && t[0] <= 57 && tag.slice(1) === 'CHN') { nchan = t[0] - 48; tid = `${nchan} Channel MOD`; }
	else if (t[0] > 48 && t[0] <= 57 && dig(t[1]) && tag[2] === 'C' && (tag[3] === 'H' || tag[3] === 'N')) { nchan = 10 * (t[0] - 48) + t[1] - 48; tid = `${nchan} Channel MOD`; }
	else if (tag.startsWith('TDZ') && t[3] > 48 && t[3] <= 57) { nchan = t[3] - 48; tid = `${nchan} Channel TakeTracker`; }
	else if (force) { nchan = 4; nsamples = 15; tid = '4 Channel MOD'; }
	else return LOAD_UNSUPPORTED;
	if (nchan > C.MAX_CHANNELS) return LOAD_FORMAT_ERROR;
	seek(fp, 0);
	song.title = cstr(fp, 20);
	for (let n = 1; n <= nsamples; n++) {
		const s = song.samples[n];
		if (fp.position + 30 > fp.bytes.length) return LOAD_UNSUPPORTED;
		s.name = cstr(fp, 22);
		s.length = u16be(fp) * 2;
		const ft = u8(fp);
		s.c5speed = his_masters_noise ? transpose_to_frequency(0, -(((ft << 3) << 24) >> 24)) : MOD_FINETUNE(ft);
		s.volume = Math.min(u8(fp), 64) * 4;
		s.global_volume = 64;
		s.loop_start = u16be(fp) * 2;
		const ll = u16be(fp) * 2;
		if (ll > 2) s.flags |= C.CHN_LOOP;
		s.loop_end = s.loop_start + ll;
		s.vib_type = s.vib_rate = s.vib_depth = s.vib_speed = 0;
	}
	const nord = u8(fp), restart = u8(fp);
	const ol = bytes(fp, 128);
	if (ol.length !== 128) return LOAD_UNSUPPORTED;
	song.orderlist.set(ol);
	if (startrekker && [...ol].some(o => o & 1)) { startrekker = 0; nchan = 4; }
	if (startrekker) for (let n = 0; n < 128; n++) song.orderlist[n] >>= 1;
	let npat = 0;
	for (let n = 0; n < 128; n++) {
		if (song.orderlist[n] >= C.MAX_PATTERNS) song.orderlist[n] = C.ORDER_SKIP;
		else if (song.orderlist[n] > npat) npat = song.orderlist[n];
	}
	song.orderlist.fill(C.ORDER_LAST, nord);
	seek(fp, nsamples === 15 ? 600 : 1084);
	const p = new Uint8Array(4);
	const rd = note => { for (let i = 0; i < 4; i++) p[i] = u8(fp); mod_import_note(p, note); csf_import_mod_effect(note, 0); };
	for (let pat = 0; pat <= npat; pat++) {
		const pattern = song.patterns[pat] = csf_allocate_pattern(64);
		song.pattern_size[pat] = song.pattern_alloc_size[pat] = 64;
		if (fp.position + 64 * (startrekker ? 8 : nchan) * 4 > fp.bytes.length) return LOAD_UNSUPPORTED;
		if (startrekker) {
			for (let half = 0; half < 2; half++)
				for (let n = 0; n < 64; n++) for (let chan = 0; chan < 4; chan++) rd(pattern[n * 64 + half * 4 + chan]);
		} else {
			for (let n = 0; n < 64; n++) for (let chan = 0; chan < nchan; chan++) rd(pattern[n * 64 + chan]);
		}
	}
	if (restart < npat) csf_insert_restart_pos(song, restart);
	for (let n = 1; n <= nsamples; n++) {
		if (!song.samples[n].length) continue;
		let flags = C.SF_8 | C.SF_M | C.SF_LE;
		if (cstr({ ...fp }, 5) === 'ADPCM') { fp.position += 5; flags |= C.SF_PCMD16; }
		else flags |= C.SF_PCMS;
		const pos = tell(fp);
		read_sample(song.samples[n], flags, fp);
		if (!(flags & C.SF_PCMD16)) seek(fp, pos + song.samples[n].length);
	}
	song.flags = C.SONG_ITOLDEFFECTS | C.SONG_COMPATGXX;
	for (let n = 0; n < nchan; n++) song.channels[n].panning = PROTRACKER_PANNING(n);
	for (let n = nchan; n < 64; n++) song.channels[n].flags = C.CHN_MUTE;
	song.pan_separation = 64;
	song.tracker_id = tid;
	return LOAD_SUCCESS;
}

// ------------------------------------------------------------------------
// audio_loadsave.c: song_create_load

export const LOAD_SUCCESS = 1, LOAD_UNSUPPORTED = 2, LOAD_FORMAT_ERROR = 3, LOAD_FILE_ERROR = 4;

// filled in by loaders2.js (the other formats); order as in include/fmt-types.h
export const song_loaders = {
	mod31: (s, f) => fmt_mod_load_song(s, f, 0), s3m: fmt_s3m_load_song, xm: fmt_xm_load_song,
	it: fmt_it_load_song, mod15: (s, f) => fmt_mod_load_song(s, f, 1),
};
const LOAD_ORDER = ['669', 'mod31', 's3m', 'far', 'xm', 'it', 'mtm', 'mdl', 'okt', 'mid', 'mus', 'psm',
	'psm16', 'dsm', 'd00', 'ult', 'imf', 'sfx', 'stx', 'stm', 'mod15'];

export function song_create_load(data, template) {
	const fp = fp_open(data);
	for (const func of LOAD_ORDER.map(k => song_loaders[k]).filter(Boolean)) {
		const newsong = csf_allocate();
		if (template) {
			newsong.mix_flags = template.mix_flags;
			newsong.row_highlight_major = template.row_highlight_major;
			newsong.row_highlight_minor = template.row_highlight_minor;
			if (template.midi_config) newsong.midi_config = copy_midi_config(template.midi_config);
		}
		fp.position = 0; fp.limit = Infinity;
		let r;
		try { r = func(newsong, fp); }
		catch (e) { console.error(e); r = LOAD_FORMAT_ERROR; }
		if (r === LOAD_UNSUPPORTED) continue;
		if (r !== LOAD_SUCCESS) return null;
		newsong.stop_at_order = newsong.stop_at_row = -1;
		newsong.message = (newsong.message || '').replace(/\r\n?/g, '\n');
		for (let n = 1; n < newsong.samples.length; n++) {
			const s = newsong.samples[n];
			s.name = (s.name || '').replace(/\0/g, '');
			s.filename = (s.filename || '').replace(/\0/g, '');
		}
		return newsong;
	}
	return null;
}
export const fpio = { getc, eof, u8, s8, u16, u16be, u32, bytes, cstr, rtrim, seek, tell, clamp };
provide({ song_create_load, csf_import_mod_effect });
