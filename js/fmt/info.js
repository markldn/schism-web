// File type/title detection (the fmt_*_read_info functions) and sample /
// instrument loaders: fmt/wav.c, fmt/its.c, fmt/iti.c, fmt/xi.c, fmt/raw.c
// (Schism Tracker, GPL-2.0-or-later). Compressed audio (MP3, Ogg, FLAC, ...)
// is decoded by the browser's Web Audio API instead of native libraries.
import { provide } from '../app.js';
import * as C from '../sndconst.js';
import { fp_open, load_its_sample, load_it_instrument, read_sample } from './loaders.js';
import { csf_allocate_instrument, csf_adjust_sample_loop } from '../csndfile.js';
import { transpose_to_frequency } from '../effects.js';

export const TYPE_MODULE_MASK = 0xf00, TYPE_INST_MASK = 0xf000, TYPE_SAMPLE_MASK = 0xf0000;
export const TYPE_MODULE_MOD = 0x103, TYPE_MODULE_S3M = 0x203, TYPE_MODULE_XM = 0x303, TYPE_MODULE_IT = 0x403;
export const TYPE_INST_ITI = 0x1002, TYPE_INST_XI = 0x2002, TYPE_INST_OTHER = 0x3002;
export const TYPE_UNKNOWN = 0x10002, TYPE_SAMPLE_PLAIN = 0x20002, TYPE_SAMPLE_EXTD = 0x30002, TYPE_SAMPLE_COMPR = 0x40002;

const str = (b, o, n) => { let s = ''; for (let i = 0; i < n && o + i < b.length; i++) { const c = b[o + i]; if (!c) break; s += String.fromCharCode(c); } return s.replace(/\s+$/, ''); };
const tag = (b, o, t) => str(b, o, t.length) === t;
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// returns { type, title, description, ...sample info } or null
export function dmoz_file_info(base, b) {
	const ext = (base.split('.').pop() || '').toLowerCase();
	if (b.length >= 0xc0 && tag(b, 0, 'IMPM')) {
		let desc = 'Impulse Tracker';
		const ordnum = u16(b, 0x20), insnum = u16(b, 0x22), smpnum = u16(b, 0x24);
		for (let n = 0; n < smpnum; n++) {
			const p = u32(b, 0xc0 + ordnum + 4 * insnum + 4 * n);
			if (p + 18 < b.length && (b[p + 18] & 8)) { desc = 'Compressed Impulse Tracker'; break; }
		}
		return { type: TYPE_MODULE_IT, title: str(b, 4, 26), description: desc };
	}
	if (b.length >= 60 && tag(b, 0, 'Extended Module: ')) return { type: TYPE_MODULE_XM, title: str(b, 17, 20), description: 'Fast Tracker 2 Module' };
	if (b.length >= 48 && tag(b, 44, 'SCRM')) return { type: TYPE_MODULE_S3M, title: str(b, 0, 28), description: 'Scream Tracker 3' };
	if (b.length >= 1084) {
		const t = str(b, 1080, 4);
		if (/^(M\.K\.|M!K!|M&K!|N\.T\.|FEST|FLT[48]|EXO[48]|OCTA|OKTA|CD[68]1|\dCHN|\d\dC[HN]|TDZ\d)$/.test(t))
			return { type: TYPE_MODULE_MOD, title: str(b, 0, 20), description: t === 'M.K.' ? 'Amiga ProTracker' : t + ' MOD' };
	}
	if (b.length >= 80 && tag(b, 0, 'IMPS')) {
		return { type: TYPE_SAMPLE_EXTD, title: str(b, 20, 26), description: 'Impulse Tracker Sample',
			smp_length: u32(b, 0x30), smp_flags: b[0x12], smp_filename: str(b, 4, 12) };
	}
	if (b.length >= 554 && tag(b, 0, 'IMPI')) return { type: TYPE_INST_ITI, title: str(b, 32, 26), description: 'Impulse Tracker Instrument' };
	if (b.length >= 0x150 && tag(b, 0, 'Extended Instrument: ')) return { type: TYPE_INST_XI, title: str(b, 21, 22), description: 'Fast Tracker Instrument' };
	if (b.length >= 12 && tag(b, 0, 'RIFF') && tag(b, 8, 'WAVE')) return { type: TYPE_SAMPLE_PLAIN, title: base, description: 'IBM/Microsoft RIFF Audio' };
	if (b.length >= 12 && tag(b, 0, 'FORM') && (tag(b, 8, 'AIFF') || tag(b, 8, 'AIFC'))) return { type: TYPE_SAMPLE_COMPR, title: base, description: 'Audio IFF' };
	if (tag(b, 0, 'fLaC')) return { type: TYPE_SAMPLE_COMPR, title: base, description: 'FLAC Audio' };
	if (tag(b, 0, 'OggS')) return { type: TYPE_SAMPLE_COMPR, title: base, description: 'Ogg Audio' };
	if (tag(b, 0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && ext === 'mp3')) return { type: TYPE_SAMPLE_COMPR, title: base, description: 'MPEG Layer 3' };
	if (['669', 'mtm', 'far', 'ult', 'stm', 'mdl', 'med', 'okt', 'psm', 'amf', 'dsm', 'imf', 'ptm', 'mt2', 'mid'].includes(ext))
		return { type: TYPE_UNKNOWN, title: '', description: ext.toUpperCase() + ' (not supported)' };
	return { type: TYPE_UNKNOWN, title: '', description: 'Unknown / raw data' };
}

// ---------------------------------------------------------------------
// sample loaders: each fills `smp` and returns true

function load_wav(b, smp, base) {
	let p = 12, fmt = null, data = null, loops = null;
	while (p + 8 <= b.length) {
		const id = str(b, p, 4), size = u32(b, p + 4);
		if (id === 'fmt ') fmt = { tag: u16(b, p + 8), ch: u16(b, p + 10), rate: u32(b, p + 12), bits: u16(b, p + 22) };
		else if (id === 'data') data = [p + 8, Math.min(size, b.length - p - 8)];
		else if (id === 'smpl' && size >= 60 && u32(b, p + 8 + 28) > 0) loops = { type: u32(b, p + 8 + 36 + 4), start: u32(b, p + 8 + 36 + 8), end: u32(b, p + 8 + 36 + 12) };
		p += 8 + size + (size & 1);
	}
	if (!fmt || !data || fmt.ch < 1 || fmt.ch > 2) return false;
	const extensible = fmt.tag === 0xfffe;
	const isfloat = fmt.tag === 3 || (extensible && b[data[0] - 8] === 3 && false);
	if (!(fmt.tag === 1 || fmt.tag === 3 || extensible)) return false;
	const bpf = (fmt.bits >> 3) * fmt.ch;
	if (!bpf) return false;
	smp.length = Math.trunc(data[1] / bpf);
	smp.c5speed = fmt.rate;
	smp.name = base.slice(0, 25);
	const layout = fmt.ch === 2 ? C.SF_SI : C.SF_M;
	let flags = C.SF_LE | layout;
	if (fmt.tag === 3 || isfloat) flags |= (fmt.bits === 64 ? C.SF_64 : C.SF_32) | C.SF_IEEE;
	else if (fmt.bits <= 8) flags |= C.SF_8 | C.SF_PCMU;
	else if (fmt.bits <= 16) flags |= C.SF_16 | C.SF_PCMS;
	else if (fmt.bits <= 24) flags |= C.SF_24 | C.SF_PCMS;
	else flags |= C.SF_32 | C.SF_PCMS;
	const fp = fp_open(b); fp.position = data[0];
	if (!read_sample(smp, flags, fp)) return false;
	if (loops && loops.end > loops.start) {
		smp.loop_start = loops.start; smp.loop_end = Math.min(loops.end + 1, smp.length);
		smp.flags |= C.CHN_LOOP | (loops.type === 1 ? C.CHN_PINGPONGLOOP : 0);
		csf_adjust_sample_loop(smp);
	}
	return true;
}

export function fmt_load_sample(base, b, smp) {
	const info = dmoz_file_info(base, b);
	if (info.type === TYPE_SAMPLE_EXTD) {
		const fp = fp_open(b);
		return !!load_its_sample(fp, smp, 0x0214);
	}
	if (info.type === TYPE_SAMPLE_PLAIN) return load_wav(b, smp, base);
	if (info.type === TYPE_UNKNOWN || (info.type & TYPE_MODULE_MASK) === 0 && !(info.type & TYPE_INST_MASK)) {
		// raw: signed 8-bit mono at 8363 Hz, like Schism's raw loader
		if (!b.length) return false;
		smp.length = b.length;
		smp.c5speed = 8363;
		smp.name = base.slice(0, 25);
		const fp = fp_open(b);
		return !!read_sample(smp, C.SF_8 | C.SF_M | C.SF_LE | C.SF_PCMS, fp);
	}
	return false;
}

// browser-decoded audio (mp3/ogg/flac/aiff...) -> 16-bit sample
export async function fmt_decode_sample(base, b, smp) {
	const AC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
	if (!AC) return false;
	try {
		const ctx = new AC(1, 1, 44100);
		const buf = await ctx.decodeAudioData(b.slice().buffer);
		const ch = Math.min(2, buf.numberOfChannels), n = buf.length;
		const data = new Int16Array(n * ch);
		for (let c = 0; c < ch; c++) {
			const src = buf.getChannelData(c);
			for (let i = 0; i < n; i++) data[i * ch + c] = Math.max(-32768, Math.min(32767, Math.round(src[i] * 32767)));
		}
		smp.length = n;
		smp.c5speed = buf.sampleRate;
		smp.flags = (smp.flags & ~(C.CHN_16BIT | C.CHN_STEREO)) | C.CHN_16BIT | (ch === 2 ? C.CHN_STEREO : 0);
		smp.data = data;
		smp.name = base.slice(0, 25);
		csf_adjust_sample_loop(smp);
		return true;
	} catch { return false; }
}

// ---------------------------------------------------------------------
// instrument loaders: return { ins, samples: [smp...] } with sample_map
// holding 1-based indices into `samples`

export function fmt_load_instrument(base, b, new_sample) {
	const info = dmoz_file_info(base, b);
	if (info.type === TYPE_INST_ITI) {
		const fp = fp_open(b);
		const ins = csf_allocate_instrument();
		if (!load_it_instrument(ins, fp)) return null;
		const nos = b[0x1e];
		const samples = [];
		fp.position = 554;
		for (let i = 0; i < nos; i++) {
			const smp = new_sample();
			const pos = fp.position;
			load_its_sample(fp, smp, 0x0214);
			fp.position = pos + 80;
			samples.push(smp);
		}
		return { ins, samples };
	}
	if (info.type === TYPE_INST_XI) return load_xi(b, base, new_sample);
	// a plain sample becomes a one-sample instrument
	const smp = new_sample();
	if (!fmt_load_sample(base, b, smp)) return null;
	const ins = csf_allocate_instrument();
	ins.name = smp.name;
	ins.sample_map.fill(1);
	return { ins, samples: [smp] };
}

function load_xi(b, base, new_sample) {
	const ins = csf_allocate_instrument();
	ins.name = str(b, 21, 22);
	const map = b.subarray(0x42, 0x42 + 96);
	const fp = fp_open(b);
	const env = (off, n) => { const e = []; for (let i = 0; i < 12; i++) e.push([u16(b, off + i * 4), u16(b, off + i * 4 + 2)]); return e; };
	const venv = env(0xa2), penv = env(0xd2);
	const vn = b[0x102], pn = b[0x103];
	ins.vol_env.nodes = Math.min(vn, 12); ins.pan_env.nodes = Math.min(pn, 12);
	for (let i = 0; i < 12; i++) {
		ins.vol_env.ticks[i] = venv[i][0]; ins.vol_env.values[i] = Math.min(venv[i][1], 64);
		ins.pan_env.ticks[i] = penv[i][0]; ins.pan_env.values[i] = Math.min(penv[i][1], 64);
	}
	ins.vol_env.sustain_start = ins.vol_env.sustain_end = b[0x104];
	ins.vol_env.loop_start = b[0x105]; ins.vol_env.loop_end = b[0x106];
	ins.pan_env.sustain_start = ins.pan_env.sustain_end = b[0x107];
	ins.pan_env.loop_start = b[0x108]; ins.pan_env.loop_end = b[0x109];
	const vt = b[0x10a], pt = b[0x10b];
	if (vt & 1) ins.flags |= C.ENV_VOLUME;
	if (vt & 2) ins.flags |= C.ENV_VOLSUSTAIN;
	if (vt & 4) ins.flags |= C.ENV_VOLLOOP;
	if (pt & 1) ins.flags |= C.ENV_PANNING;
	if (pt & 2) ins.flags |= C.ENV_PANSUSTAIN;
	if (pt & 4) ins.flags |= C.ENV_PANLOOP;
	ins.fadeout = u16(b, 0x110);
	const nsmp = u16(b, 0x14a);
	fp.position = 0x150;
	const hdrs = [];
	for (let i = 0; i < nsmp; i++) {
		const p = fp.position;
		const h = { length: u32(b, p), loop_start: u32(b, p + 4), loop_len: u32(b, p + 8), vol: b[p + 12],
			finetune: (b[p + 13] << 24) >> 24, type: b[p + 14], pan: b[p + 15], relnote: (b[p + 16] << 24) >> 24, name: str(b, p + 18, 22) };
		hdrs.push(h);
		fp.position += 40;
	}
	const samples = [];
	for (const h of hdrs) {
		const smp = new_sample();
		smp.name = h.name;
		smp.volume = Math.min(h.vol, 64) * 4;
		smp.panning = h.pan;
		smp.flags |= C.CHN_PANNING;
		smp.c5speed = transpose_to_frequency(h.relnote, h.finetune);
		const sixteen = h.type & 0x10;
		smp.length = sixteen ? h.length >> 1 : h.length;
		smp.loop_start = sixteen ? h.loop_start >> 1 : h.loop_start;
		smp.loop_end = smp.loop_start + (sixteen ? h.loop_len >> 1 : h.loop_len);
		if (h.type & 3) smp.flags |= C.CHN_LOOP | ((h.type & 3) === 2 ? C.CHN_PINGPONGLOOP : 0);
		const pos = fp.position;
		read_sample(smp, C.SF_LE | C.SF_M | C.SF_PCMD | (sixteen ? C.SF_16 : C.SF_8), fp);
		fp.position = pos + h.length;
		samples.push(smp);
	}
	for (let n = 0; n < 120; n++) ins.sample_map[n] = n >= 12 && n < 108 && map[n - 12] < samples.length ? map[n - 12] + 1 : 0;
	if (!(ins.flags & C.ENV_VOLUME)) {
		ins.vol_env.ticks[0] = 0; ins.vol_env.ticks[1] = 1; ins.vol_env.values[0] = 64; ins.vol_env.values[1] = 0;
		ins.vol_env.nodes = 2; ins.flags |= C.ENV_VOLUME | C.ENV_VOLSUSTAIN;
	}
	void base;
	return { ins, samples };
}

provide({ dmoz_file_info, fmt_load_sample, fmt_decode_sample, fmt_load_instrument });
