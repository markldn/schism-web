// Sample file loaders: fmt/wav.c, fmt/aiff.c (AIFF, 8SVX, 16SV), fmt/au.c,
// fmt/w64.c, fmt/sbi.c, fmt/s3i.c, fmt/brr.c and the IFF helpers of
// fmt/iff.c (Schism Tracker, GPL-2.0-or-later).
//
// Each loader takes the file bytes and a sample, fills it in and returns
// true; each *_info takes the bytes and returns a dmoz file-info object or
// null. They are tried in the order of include/fmt-types.h.
import { app } from '../app.js';
import * as C from '../sndconst.js';
import { fp_open, read_sample, fpio } from './loaders.js';

const { u8, u16, u16be, u32, bytes, seek, tell } = fpio;
const u32be = fp => ((u8(fp) << 24) | (u8(fp) << 16) | (u8(fp) << 8) | u8(fp)) >>> 0;
const raw = (b, o, n) => { let s = ''; for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]); return s; };
const cstring = (arr, n = arr.length) => { let s = ''; for (let i = 0; i < n && i < arr.length; i++) { if (!arr[i]) break; s += String.fromCharCode(arr[i]); } return s; };
const could = (fp, pos) => pos >= 0 && pos <= fp.bytes.length;
const cseek = (fp, pos) => { if (!could(fp, pos)) return -1; fp.position = pos; return 0; };

// TYPE_* values shared with info.js
const TYPE_SAMPLE_PLAIN = 0x20002, TYPE_SAMPLE_EXTD = 0x30002, TYPE_SAMPLE_COMPR = 0x40002, TYPE_INST_OTHER = 0x3002;

// iff.c
function iff_chunk_peek(fp, le, aligned) {
	if (fp.position + 8 > fp.bytes.length) return null;
	const id = raw(fp.bytes, fp.position, 4); fp.position += 4;
	const size = le ? u32(fp) : u32be(fp);
	const offset = tell(fp);
	if (cseek(fp, offset + (aligned ? (size + 1) & ~1 : size))) return null;
	return { id, size, offset };
}
function iff_read_sample(chunk, fp, smp, flags, offset) {
	const pos = tell(fp);
	if (cseek(fp, chunk.offset + offset)) return 0;
	const r = read_sample(smp, flags, fp);
	seek(fp, pos);
	return r;
}
function iff_chunk_bytes(chunk, fp, n) { return fp.bytes.subarray(chunk.offset, chunk.offset + Math.min(chunk.size, n)); }
export function iff_read_xtra_chunk(fp, smp) {
	if (fp.position + 16 > fp.bytes.length) return 0;
	const xtra_flags = u32(fp);
	if (xtra_flags & 0x20) smp.flags |= C.CHN_PANNING;
	let pan = u16(fp); pan = (((pan + 2) >> 2) * 4) & 0xffff; smp.panning = Math.min(pan, 256);
	let vol = u16(fp); vol = (((vol + 2) >> 2) * 4) & 0xffff; smp.volume = Math.min(vol, 256);
	smp.global_volume = Math.min(u16(fp), 64);
	fp.position += 2;
	smp.vib_type = u8(fp); smp.vib_speed = u8(fp); smp.vib_depth = u8(fp); smp.vib_rate = u8(fp);
	return 1;
}
function smpl_loop(fp, loopflag, bidiflag, smp, kstart, kend) {
	fp.position += 8;
	if (fp.position + 12 > fp.bytes.length) return 0;
	const type = u32(fp), start = u32(fp), end = u32(fp);
	if (!(start | end)) return 0;
	switch (type) {
	case 1: smp.flags |= bidiflag; // fallthrough
	case 0: smp.flags |= loopflag; break;
	default: return 0;
	}
	smp[kstart] = start;
	smp[kend] = (end + 1) >>> 0;
	return 1;
}
export function iff_read_smpl_chunk(fp, smp) {
	fp.position += 28;
	if (fp.position + 4 > fp.bytes.length) return 0;
	const num_loops = u32(fp);
	if (num_loops >= 2 && !smpl_loop(fp, C.CHN_SUSTAINLOOP, C.CHN_PINGPONGSUSTAIN, smp, 'sustain_start', 'sustain_end')) return 0;
	if (num_loops >= 1 && !smpl_loop(fp, C.CHN_LOOP, C.CHN_PINGPONGLOOP, smp, 'loop_start', 'loop_end')) return 0;
	return 1;
}

// ------------------------------------------------------------------------
// wav.c

function wav_chunk_fmt_read(d) {
	if (d.length < 16) return null;
	const f = fp_open(d);
	const fmt = { format: u16(f), channels: u16(f), freqHz: u32(f), bytessec: u32(f), samplesize: u16(f), bitspersample: u16(f) };
	if (fmt.format === 0xfffe) {
		if (d.length < 18 + 22) return null;
		const ext_size = u16(f);
		if (ext_size < 22) return null;
		f.position += 6;
		const subformat = u32(f);
		const base = bytes(f, 12);
		const check = [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
		for (let i = 0; i < 12; i++) if (base[i] !== check[i]) return null;
		fmt.format = subformat;
	}
	return fmt;
}
function wav_load(b, smp, load_sample) {
	const fp = fp_open(b);
	if (b.length < 12 || raw(b, 0, 4) !== 'RIFF' || raw(b, 8, 4) !== 'WAVE') return 0;
	fp.position = 12;
	let fmt_c = null, data_c = null, xtra_c = null, smpl_c = null, info_c = null, c;
	while ((c = iff_chunk_peek(fp, true, true))) {
		switch (c.id) {
		case 'fmt ': if (fmt_c) return 0; fmt_c = c; break;
		case 'data': if (data_c) return 0; data_c = c; break;
		case 'xtra': xtra_c = c; break;
		case 'smpl': smpl_c = c; break;
		case 'LIST': if (raw(b, c.offset, 4) === 'INFO') info_c = { id: c.id, offset: c.offset + 4, size: c.size - 4 }; break;
		}
		if (fmt_c && data_c && xtra_c && smpl_c && info_c) break;
	}
	if (!fmt_c || !data_c) return 0;
	const fmt = wav_chunk_fmt_read(iff_chunk_bytes(fmt_c, fp, fmt_c.size));
	if (!fmt) return 0;
	let flags = C.SF_LE | (fmt.channels === 2 ? C.SF_SI : C.SF_M);
	switch (fmt.bitspersample) {
	case 8: flags |= C.SF_8; break;
	case 16: flags |= C.SF_16; break;
	case 24: flags |= C.SF_24; break;
	case 32: flags |= C.SF_32; break;
	default: return 0;
	}
	if (fmt.format === 1) flags |= fmt.bitspersample === 8 ? C.SF_PCMU : C.SF_PCMS;
	else if (fmt.format === 3) flags |= C.SF_IEEE;
	else return 0;
	smp.flags = 0;
	smp.c5speed = fmt.freqHz;
	smp.length = Math.trunc(data_c.size / ((fmt.bitspersample >> 3) * fmt.channels)) >>> 0;
	if (xtra_c) { seek(fp, xtra_c.offset); iff_read_xtra_chunk(fp, smp); }
	if (smpl_c) { seek(fp, smpl_c.offset); iff_read_smpl_chunk(fp, smp); }
	if (info_c) {
		seek(fp, info_c.offset);
		const lim = fp.bytes;
		const sub = { bytes: b.subarray(0, Math.min(b.length, info_c.offset + info_c.size)), position: info_c.offset, limit: Infinity };
		let inam = null;
		while ((c = iff_chunk_peek(sub, true, true))) if (c.id === 'INAM') { inam = c; break; }
		void lim;
		if (inam) smp.name = cstring(iff_chunk_bytes(inam, fp, 31)).replace(/\s+$/, '');
	}
	if (load_sample) return iff_read_sample(data_c, fp, smp, flags, 0);
	if (fmt.channels === 2) smp.flags |= C.CHN_STEREO;
	if (fmt.bitspersample > 8) smp.flags |= C.CHN_16BIT;
	return 1;
}

// ------------------------------------------------------------------------
// aiff.c (+ ieee-float.c float_decode_ieee_80)

function float_decode_ieee_80(b) {
	let expon = ((b[0] & 0x7f) << 8) | b[1];
	const hi = ((b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5]) >>> 0;
	const lo = ((b[6] << 24) | (b[7] << 16) | (b[8] << 8) | b[9]) >>> 0;
	let f;
	if (expon === 0 && hi === 0 && lo === 0) f = 0;
	else if (expon === 0x7fff) f = Infinity;
	else {
		expon -= 16383;
		f = hi * Math.pow(2, expon - 31) + lo * Math.pow(2, expon - 63);
	}
	return (b[0] & 0x80) ? -f : f;
}
function read_iff(b, smp) {
	const fp = fp_open(b);
	const form = iff_chunk_peek(fp, false, true);
	if (!form || form.id !== 'FORM' || form.size < 4) return null;
	const filetype = raw(b, form.offset, 4);
	fp.position = form.offset + 4;
	const ch = {};
	let c;
	if (filetype === '16SV' || filetype === '8SVX') {
		while ((c = iff_chunk_peek(fp, false, true))) if (['VHDR', 'BODY', 'NAME', 'AUTH', 'ANNO'].includes(c.id)) ch[c.id] = c;
		if (!ch.VHDR || !ch.BODY || ch.VHDR.size < 20) return null;
		const v = fp_open(iff_chunk_bytes(ch.VHDR, fp, 20));
		const vh = { oneshot: u32be(v), repeat: u32be(v), cycle: u32be(v), per_sec: u16be(v), octaves: u8(v), compression: u8(v), volume: u32be(v) };
		if (vh.compression) { app.log_appendf(4, 'error: compressed IFF files are unsupported'); return null; }
		if (vh.octaves !== 1) app.log_appendf(4, `warning: IFF file contains ${vh.octaves} octaves`);
		const name = ch.NAME || ch.AUTH || ch.ANNO;
		const info = { type: TYPE_SAMPLE_PLAIN, description: filetype === '16SV' ? '16SV sample' : '8SVX sample',
			smp_speed: vh.per_sec, smp_length: ch.BODY.size, title: name ? cstring(iff_chunk_bytes(name, fp, name.size)) : '' };
		if (smp) {
			let flags = C.SF_BE | C.SF_PCMS | C.SF_M;
			smp.c5speed = vh.per_sec;
			smp.length = ch.BODY.size;
			if (name) smp.name = cstring(iff_chunk_bytes(name, fp, 32));
			let vol = Math.min(vh.volume, 0x10000);
			vol = (vol + 512) >> 10;
			smp.volume = vol * 4;
			smp.loop_end = vh.repeat;
			if (smp.loop_end) {
				smp.loop_start = vh.oneshot;
				smp.loop_end = (smp.loop_end + smp.loop_start) >>> 0;
				if (smp.loop_start > smp.length) smp.loop_start = 0;
				if (smp.loop_end > smp.length) smp.loop_end = smp.length;
				if (smp.loop_start + 2 < smp.loop_end) smp.flags |= C.CHN_LOOP;
			}
			if (filetype === '16SV') { flags |= C.SF_16; smp.length >>>= 1; smp.loop_start >>>= 1; smp.loop_end >>>= 1; }
			else flags |= C.SF_8;
			iff_read_sample(ch.BODY, fp, smp, flags, 0);
		}
		return info;
	}
	if (filetype !== 'AIFF') return null;
	let applschm = null;
	while ((c = iff_chunk_peek(fp, false, true))) {
		if (['COMM', 'SSND', 'NAME', 'MARK', 'INST'].includes(c.id)) ch[c.id] = c;
		else if (c.id === 'APPL' && raw(b, c.offset, 4) === 'Schm') applschm = { offset: c.offset + 4, size: c.size - 4 };
	}
	if (!ch.COMM || !ch.SSND || ch.COMM.size < 18) return null;
	const cm = fp_open(iff_chunk_bytes(ch.COMM, fp, 18));
	const comm = { num_channels: u16be(cm), num_frames: u32be(cm), sample_size: u16be(cm), rate: bytes(cm, 10) };
	const psmp = smp || { flags: 0, loop_start: 0, loop_end: 0, sustain_start: 0, sustain_end: 0, volume: 256, global_volume: 64, panning: 0 };
	psmp.c5speed = Math.trunc(float_decode_ieee_80(comm.rate)) >>> 0;
	psmp.length = comm.num_frames;
	const title = ch.NAME ? cstring(iff_chunk_bytes(ch.NAME, fp, ch.NAME.size)) : '';
	if (smp && ch.NAME) smp.name = cstring(iff_chunk_bytes(ch.NAME, fp, 32));
	if (ch.INST && ch.MARK) {
		fp.position = ch.INST.offset + 8;
		const sustain_type = u16be(fp), sustain_start_id = u16be(fp), sustain_end_id = u16be(fp);
		const loop_type = u16be(fp), loop_start_id = u16be(fp), loop_end_id = u16be(fp);
		fp.position = ch.MARK.offset;
		const num_markers = u16be(fp);
		for (let i = 0; i < num_markers; i++) {
			const id = u16be(fp), offset = u32be(fp);
			if (id === loop_start_id) psmp.loop_start = offset;
			if (id === loop_end_id) psmp.loop_end = offset;
			if (id === sustain_start_id) psmp.sustain_start = offset;
			if (id === sustain_end_id) psmp.sustain_end = offset;
			const len = fpio.getc(fp);
			if (len < 0) break;
			fp.position += len;
		}
		switch (loop_type) { case 2: psmp.flags |= C.CHN_PINGPONGLOOP; // fallthrough
		case 1: psmp.flags |= C.CHN_LOOP; }
		switch (sustain_type) { case 2: psmp.flags |= C.CHN_PINGPONGSUSTAIN; // fallthrough
		case 1: psmp.flags |= C.CHN_SUSTAINLOOP; }
	}
	if (applschm) {
		fp.position = applschm.offset;
		let xtra = null;
		while ((c = iff_chunk_peek(fp, false, true))) if (c.id === 'xtra') { xtra = c; break; }
		if (xtra) { fp.position = xtra.offset; iff_read_xtra_chunk(fp, psmp); }
	}
	const bits = (comm.sample_size + 7) & ~7;
	const info = { type: TYPE_SAMPLE_PLAIN, description: 'Audio IFF sample', title, smp_speed: psmp.c5speed,
		smp_length: psmp.length, smp_flags: (psmp.flags | ([16, 24, 32].includes(bits) ? C.CHN_16BIT : 0)) & ~C.CHN_STEREO };
	if (smp) {
		let flags = C.SF_BE | C.SF_PCMS;
		if (comm.num_channels === 2) flags |= C.SF_SI;
		else { if (comm.num_channels !== 1) app.log_appendf(4, 'warning: multichannel AIFF is unsupported'); flags |= C.SF_M; }
		switch (bits) {
		case 16: flags |= C.SF_16; break;
		case 24: flags |= C.SF_24; break;
		case 32: flags |= C.SF_32; break;
		default: if (bits !== 8) app.log_appendf(4, 'warning: AIFF has unsupported bit-width'); flags |= C.SF_8; break;
		}
		iff_read_sample(ch.SSND, fp, smp, flags, 8);
	}
	return info;
}

// ------------------------------------------------------------------------
// au.c

function read_header_au(b) {
	if (b.length < 24 || raw(b, 0, 4) !== '.snd') return null;
	const fp = fp_open(b); fp.position = 4;
	const h = { data_offset: u32be(fp), data_size: u32be(fp), encoding: u32be(fp), sample_rate: u32be(fp), channels: u32be(fp) };
	if (h.data_offset < 24 || h.data_offset + h.data_size > b.length) return null;
	if (h.channels !== 1 && h.channels !== 2) return null;
	return h;
}
function au_load(b, smp) {
	const au = read_header_au(b);
	if (!au) return 0;
	let sflags = C.SF_BE;
	smp.c5speed = au.sample_rate;
	smp.length = au.data_size;
	switch (au.encoding) {
	case 2: sflags |= C.SF_8 | C.SF_PCMS; break;
	case 3: sflags |= C.SF_16 | C.SF_PCMS; smp.length = Math.trunc(smp.length / 2); break;
	case 4: sflags |= C.SF_24 | C.SF_PCMS; smp.length = Math.trunc(smp.length / 3); break;
	case 5: sflags |= C.SF_32 | C.SF_PCMS; smp.length = Math.trunc(smp.length / 4); break;
	case 6: sflags |= C.SF_32 | C.SF_IEEE; smp.length = Math.trunc(smp.length / 4); break;
	case 7: sflags |= C.SF_64 | C.SF_IEEE; smp.length = Math.trunc(smp.length / 8); break;
	default: return 0;
	}
	if (au.channels === 2) { sflags |= C.SF_SI; smp.length = Math.trunc(smp.length / 2); } else sflags |= C.SF_M;
	if (au.data_offset > 24) smp.name = cstring(b.subarray(24, 24 + Math.min(au.data_offset - 24, 31)));
	const fp = fp_open(b); fp.position = 24 + Math.min(au.data_offset - 24, 31);
	// (sic) au.c reads the sample data right after the name, not from data_offset
	return read_sample(smp, sflags, fp);
}
function au_info(b) {
	const au = read_header_au(b);
	if (!au) return null;
	let len = Math.trunc(au.data_size / au.channels), flags = 0;
	switch (au.encoding) {
	case 3: flags |= C.CHN_16BIT; len = Math.trunc(len / 2); break;
	case 4: flags |= C.CHN_16BIT; len = Math.trunc(len / 3); break;
	case 5: case 6: flags |= C.CHN_16BIT; len = Math.trunc(len / 4); break;
	case 7: flags |= C.CHN_16BIT; len = Math.trunc(len / 8); break;
	default: return null;
	}
	if (au.channels === 2) flags |= C.CHN_STEREO;
	return { type: TYPE_SAMPLE_PLAIN, description: 'AU Sample', smp_length: len, smp_flags: flags, smp_speed: au.sample_rate,
		title: au.data_offset > 24 ? cstring(b.subarray(24, au.data_offset)) : '' };
}

// ------------------------------------------------------------------------
// w64.c

const GUID = s => s.split(' ').map(x => parseInt(x, 16));
const w64_RIFF = GUID('72 69 66 66 2E 91 CF 11 A5 D6 28 DB 04 C1 00 00');
const w64_WAVE = GUID('77 61 76 65 F3 AC D3 11 8C D1 00 C0 4F 8E DB 8A');
const w64_FMT_ = GUID('66 6D 74 20 F3 AC D3 11 8C D1 00 C0 4F 8E DB 8A');
const w64_DATA = GUID('64 61 74 61 F3 AC D3 11 8C D1 00 C0 4F 8E DB 8A');
const same = (b, o, g) => g.every((v, i) => b[o + i] === v);
function w64_load(b, smp, load_sample) {
	if (b.length < 40 || !same(b, 0, w64_RIFF) || !same(b, 24, w64_WAVE)) return 0;
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	let p = 40, fmt_c = null, data_c = null;
	while (p + 24 <= b.length) {
		let size = Number(dv.getBigUint64(p + 16, true));
		if (size < 24) break;
		size -= 24;
		const c = { offset: p + 24, size };
		const next = p + 24 + ((size + 7) & ~7);
		if (next > b.length) break;
		if (same(b, p, w64_FMT_)) { if (fmt_c) return 0; fmt_c = c; }
		else if (same(b, p, w64_DATA)) { if (data_c) return 0; data_c = c; }
		p = next;
	}
	if (!fmt_c || !data_c) return 0;
	const fmt = wav_chunk_fmt_read(b.subarray(fmt_c.offset, fmt_c.offset + fmt_c.size));
	if (!fmt) return 0;
	let flags = C.SF_LE | (fmt.channels === 2 ? C.SF_SI : C.SF_M);
	switch (fmt.bitspersample) {
	case 8: flags |= C.SF_8; break;
	case 16: flags |= C.SF_16; break;
	case 24: flags |= C.SF_24; break;
	case 32: flags |= C.SF_32; break;
	default: return 0;
	}
	if (fmt.format === 1) flags |= fmt.bitspersample === 8 ? C.SF_PCMU : C.SF_PCMS;
	else if (fmt.format === 3) flags |= C.SF_IEEE;
	else return 0;
	smp.flags = 0;
	smp.c5speed = fmt.freqHz;
	smp.length = Math.trunc(data_c.size / ((fmt.bitspersample >> 3) * fmt.channels));
	if (load_sample) { const fp = fp_open(b); fp.position = data_c.offset; return read_sample(smp, flags, fp); }
	if (fmt.channels === 2) smp.flags |= C.CHN_STEREO;
	if (fmt.bitspersample > 8) smp.flags |= C.CHN_16BIT;
	return 1;
}

// ------------------------------------------------------------------------
// sbi.c, s3i.c

function adlib_stub(smp) {
	smp.data = new Int8Array(1);
	smp.length = 1;
	app.csf_adjust_sample_loop(smp);
}
function sbi_load(b, smp) {
	if (b.length < 47 || raw(b, 0, 4) !== 'SBI\x1a') return 0;
	smp.name = cstring(b.subarray(4, 36));
	smp.adlib_bytes = new Uint8Array(12);
	smp.adlib_bytes.set(b.subarray(36, 47));
	smp.c5speed = 8363;
	smp.flags = C.CHN_ADLIB;
	adlib_stub(smp);
	return 1;
}
function s3i_load(b, smp, with_data) {
	if (b.length < 0x50) return 0;
	const tag = raw(b, 0x4c, 4);
	if (tag !== 'SCRS' && tag !== 'SCRI') return 0;
	const type = b[0];
	if (type !== 1 && type !== 2) return 0;
	const fp = fp_open(b);
	smp.filename = cstring(b.subarray(1, 13));
	fp.position = 20;
	smp.loop_start = u32(fp); smp.loop_end = u32(fp);
	smp.volume = u8(fp) * 4;
	fp.position += 2;
	const flags = u8(fp);
	smp.c5speed = u32(fp);
	fp.position += 12;
	smp.name = cstring(bytes(fp, 28));
	smp.flags = 0;
	smp.global_volume = 64;
	if (type === 1) {
		const bps = (flags & 2) ? 2 : 1;
		fp.position = 16;
		smp.length = u32(fp);
		fp.position = 80;
		if (!could(fp, 80 + smp.length * bps)) return 0;
		if (flags & 1) smp.flags |= C.CHN_LOOP;
		if (flags & 2) smp.flags |= C.CHN_STEREO;
		if (flags & 4) smp.flags |= C.CHN_16BIT;
		if (with_data) read_sample(smp, C.SF_M | C.SF_LE | ((smp.flags & C.CHN_16BIT) ? (C.SF_16 | C.SF_PCMS) : (C.SF_8 | C.SF_PCMU)), fp);
	} else {
		smp.flags |= C.CHN_ADLIB;
		smp.flags &= ~(C.CHN_LOOP | C.CHN_16BIT);
		smp.adlib_bytes = Uint8Array.from(b.subarray(16, 28));
		if (with_data) adlib_stub(smp); else smp.length = 1;
	}
	return 1;
}

// ------------------------------------------------------------------------
// brr.c

function brr_load(b) {
	if (b.length < 11 || b.length > 0x10000) return null;
	const brr = { blocks: b.length, loop: 0, loop_start: 0 };
	let p = 0;
	switch (b.length % 9) {
	case 0: break;
	case 2: brr.loop_start = b[0] | (b[1] << 8); brr.blocks -= 2; brr.loop = 1; p = 2; break;
	default: return null;
	}
	brr.blocks = Math.trunc(brr.blocks / 9);
	let hdr = p < b.length ? b[p++] : -1;
	if (hdr < 0 || (hdr & 1)) return null;
	const test = Math.min(64, brr.blocks);
	for (let i = 0; i < test; i++) {
		if (hdr < 0 || (hdr >> 4) > 13) return null;
		p += 8;
		hdr = p < b.length ? b[p++] : -1;
	}
	brr.start = b.length % 9;
	return brr;
}
const brr_ratio = x => Math.trunc(x * 16 / 9);
function brr_decode(nibble, st, shift, filter) {
	if (nibble >= 8) nibble -= 16;
	nibble = (nibble << shift) >> 1;
	switch (filter) {
	case 1: nibble += Math.trunc(st.s1 * 15 / 16); break;
	case 2: nibble += Math.trunc(st.s1 * 61 / 32); nibble -= Math.trunc(st.s2 * 15 / 16); break;
	case 3: nibble += Math.trunc(st.s1 * 115 / 64); nibble -= Math.trunc(st.s2 * 13 / 16); break;
	}
	nibble = Math.max(-16384, Math.min(16383, nibble));
	st.s2 = st.s1; st.s1 = nibble;
	return nibble << 1;
}
function brr_load_sample(b, smp) {
	const brr = brr_load(b);
	if (!brr) return 0;
	smp.flags = C.CHN_16BIT;
	smp.c5speed = 32000;
	smp.length = brr.blocks * 16;
	const data = new Int16Array(smp.length);
	if (brr.loop) { smp.flags |= C.CHN_LOOP; smp.loop_start = brr_ratio(brr.loop_start); smp.loop_end = smp.length; }
	const st = { s1: 0, s2: 0 };
	let p = brr.start;
	for (let i = 0; i < brr.blocks; i++) {
		if (p + 9 > b.length) return 0;
		const shift = b[p] >> 4, filter = (b[p] >> 2) & 3;
		if (shift > 12) return 0;
		for (let j = 0; j < 8; j++) {
			const blk = b[p + 1 + j];
			data[i * 16 + 2 * j] = brr_decode(blk >> 4, st, shift, filter);
			data[i * 16 + 2 * j + 1] = brr_decode(blk & 0xf, st, shift, filter);
		}
		p += 9;
	}
	smp.data = data;
	app.csf_adjust_sample_loop(smp);
	return 1;
}

// ------------------------------------------------------------------------
// detection and loading, in fmt-types.h order

function info_from_sample(load, b, extra) {
	const s = { flags: 0, length: 0, loop_start: 0, loop_end: 0, sustain_start: 0, sustain_end: 0, c5speed: 8363,
		volume: 256, global_volume: 64, panning: 0, name: '', filename: '', vib_type: 0, vib_rate: 0, vib_depth: 0, vib_speed: 0 };
	if (!load(b, s, 0)) return null;
	return Object.assign({ smp_length: s.length, smp_flags: s.flags, smp_speed: s.c5speed, smp_loop_start: s.loop_start,
		smp_loop_end: s.loop_end, title: s.name, smp_filename: s.filename }, extra(s));
}
// sample formats with magic at the start (between the module formats and ITI/XI)
export function early_sample_info(base, b) {
	return au_info(b)
		|| read_iff(b, null)
		|| info_from_sample(wav_load, b, () => ({ type: TYPE_SAMPLE_PLAIN, description: 'IBM/Microsoft RIFF Audio', title: base }))
		|| info_from_sample(w64_load, b, () => ({ type: TYPE_SAMPLE_PLAIN, description: 'Sony Wave64', title: base }))
		|| (b.length >= 47 && raw(b, 0, 4) === 'SBI\x1a' ? { type: TYPE_SAMPLE_EXTD | TYPE_INST_OTHER, description: 'Sound Blaster Instrument', title: cstring(b.subarray(4, 36)) } : null);
}
export function s3i_info(b) {
	return info_from_sample((bb, s) => s3i_load(bb, s, 0), b, s => ({ type: TYPE_SAMPLE_EXTD | TYPE_INST_OTHER, description: 'Scream Tracker Sample',
		title: s.name.slice(0, 25), smp_filename: s.filename.slice(0, 12) }));
}
export function brr_info(b) {
	const brr = brr_load(b);
	if (!brr) return null;
	const len = brr.blocks * 16;
	return { type: TYPE_SAMPLE_COMPR, description: 'SNES BRR sample', title: '', smp_flags: C.CHN_16BIT | (brr.loop ? C.CHN_LOOP : 0),
		smp_speed: 32000, smp_length: len, smp_loop_start: brr.loop ? brr_ratio(brr.loop_start) : 0, smp_loop_end: brr.loop ? len : 0 };
}
// the native sample loaders tried before ITS-less fallbacks (load_sample_funcs order, ITS handled by the caller)
export function load_native_sample(b, smp) {
	return !!(au_load(b, smp) || read_iff(b, smp) || wav_load(b, smp, 1) || w64_load(b, smp, 1) || sbi_load(b, smp)
		|| s3i_load(b, smp, 1) || brr_load_sample(b, smp));
}
