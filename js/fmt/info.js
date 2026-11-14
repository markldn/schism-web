// File type/title detection (the fmt_*_read_info functions) and sample /
// instrument loaders: fmt/wav.c, fmt/its.c, fmt/iti.c, fmt/xi.c, fmt/raw.c
// (Schism Tracker, GPL-2.0-or-later). Compressed audio (MP3, Ogg, FLAC, ...)
// is decoded by the browser's Web Audio API instead of native libraries.
import { provide } from '../app.js';
import * as C from '../sndconst.js';
import { d00_header_read, fmt_mid_load_song, mus_read_header } from './loaders2.js';
import { early_sample_info, s3i_info, brr_info, load_native_sample } from './samples.js';
import { csf_allocate } from '../csndfile.js';
import { fp_open, load_its_sample, load_it_instrument, read_sample } from './loaders.js';
import { csf_allocate_instrument, csf_adjust_sample_loop } from '../csndfile.js';
import { transpose_to_frequency } from '../effects.js';

export const TYPE_MODULE_MASK = 0xf00, TYPE_INST_MASK = 0xf000, TYPE_SAMPLE_MASK = 0xf0000;
export const TYPE_MODULE_MOD = 0x103, TYPE_MODULE_S3M = 0x203, TYPE_MODULE_XM = 0x303, TYPE_MODULE_IT = 0x403;
export const TYPE_INST_ITI = 0x1002, TYPE_INST_XI = 0x2002, TYPE_INST_OTHER = 0x3002;
export const TYPE_UNKNOWN = 0x10002, TYPE_SAMPLE_PLAIN = 0x20002, TYPE_SAMPLE_EXTD = 0x30002, TYPE_SAMPLE_COMPR = 0x40002;

const str = (b, o, n) => { let s = ''; for (let i = 0; i < n && o + i < b.length; i++) { const c = b[o + i]; if (!c) break; s += String.fromCharCode(c); } return s.replace(/\s+$/, ''); };
const tag = (b, o, t) => { if (o + t.length > b.length) return false; for (let i = 0; i < t.length; i++) if (b[o + i] !== t.charCodeAt(i)) return false; return true; };
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const rawstr = (b, o, n) => { let s = ''; for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]); return s; };
const mod = (title, description, type = TYPE_MODULE_MOD) => ({ type, title, description });

// The fmt_*_read_info functions, in the order of include/fmt-types.h.
const module_info = [
	function info_669(b) {
		if (b.length < 0x1f1) return null;
		const sig = rawstr(b, 0, 2);
		let desc;
		if (sig === 'if') desc = 'Composer 669 Module';
		else if (sig === 'JN') desc = 'Extended 669 Module';
		else return null;
		const smp = b[110], pat = b[111], rst = b[112];
		if (!smp || !pat || smp > 64 || pat > 128 || rst > 127) return null;
		for (let i = 0; i < 128; i++) if (b[0x171 + i] > 0x3f) return null;
		return mod(str(b, 2, 108), desc, TYPE_MODULE_S3M);
	},
	function info_mod(b) {
		if (b.length < 1084) return null;
		const t = rawstr(b, 1080, 4);
		if (/^(M\.K\.|M!K!|M&K!|N\.T\.|FEST|FLT[48]|EXO[48]|OCTA|OKTA|CD[68]1|\dCHN|\d\dC[HN]|TDZ\d)$/.test(t))
			return mod(str(b, 0, 20), t === 'M.K.' ? 'Amiga ProTracker' : t + ' MOD');
		return null;
	},
	b => b.length >= 48 && tag(b, 44, 'SCRM') ? mod(str(b, 0, 28), 'Scream Tracker 3', TYPE_MODULE_S3M) : null,
	b => b.length >= 98 && rawstr(b, 0, 4) === 'FAR\xfe' && rawstr(b, 44, 3) === '\r\n\x1a' ? mod(str(b, 4, 40), 'Farandole Module', TYPE_MODULE_S3M) : null,
	b => b.length >= 60 && tag(b, 0, 'Extended Module: ') ? mod(str(b, 17, 20), 'Fast Tracker 2 Module', TYPE_MODULE_XM) : null,
	function info_it(b) {
		if (b.length < 0xc0 || !tag(b, 0, 'IMPM')) return null;
		let desc = 'Impulse Tracker';
		const ordnum = u16(b, 0x20), insnum = u16(b, 0x22), smpnum = u16(b, 0x24);
		for (let n = 0; n < smpnum; n++) {
			const p = u32(b, 0xc0 + ordnum + 4 * insnum + 4 * n);
			if (p + 18 < b.length && (b[p + 18] & 8)) { desc = 'Compressed Impulse Tracker'; break; }
		}
		return mod(str(b, 4, 26), desc, TYPE_MODULE_IT);
	},
	b => b.length >= 106 && tag(b, 0, 'MT20') ? mod(str(b, 42, 64), 'MadTracker 2 Module', TYPE_MODULE_XM) : null,
	b => b.length >= 24 && tag(b, 0, 'MTM') ? mod(str(b, 4, 20), 'MultiTracker Module') : null,
	b => b.length >= 24 && tag(b, 0, 'TWNNSNG2') ? mod(str(b, 9, 15), 'NoiseTrekker') : null,
	function info_mdl(b) {
		if (b.length < 5 || !tag(b, 0, 'DMDL') || (b[4] >> 4) > 1) return null;
		for (let p = 5; p + 6 <= b.length;) {
			const id = rawstr(b, p, 2), len = u32(b, p + 2);
			if (id === 'IN') return p + 6 + 52 <= b.length ? mod(str(b, p + 6, 32), 'Digitrakker', TYPE_MODULE_XM) : null;
			p += 6; // (sic) the C code seeks with whence and offset swapped, so it never skips the block
			void len;
		}
		return null;
	},
	function info_med(b) {
		if (b.length < 52 || !tag(b, 0, 'MMD0')) return null;
		const exp = u32be(b, 32);
		if (exp + 84 > b.length) return null;
		const np = u32be(b, exp + 44), nl = u32be(b, exp + 48);
		if (np + nl > b.length) return null;
		return mod(rawstr(b, np, nl).replace(/\0[\s\S]*$/, ''), 'OctaMed');
	},
	b => b.length >= 24 && tag(b, 0, 'OKTASONG') ? mod('', 'Amiga Oktalyzer') : null,
	function info_mid(b) {
		if (!(tag(b, 0, 'MThd') || (tag(b, 0, 'RIFF') && tag(b, 20, 'MThd')))) return null;
		const tmp = csf_allocate();
		return fmt_mid_load_song(tmp, fp_open(b), 3) === 1 ? mod(tmp.title, 'Standard MIDI File') : null;
	},
	b => mus_read_header(fp_open(b)) ? mod('', 'Doom Music File') : null,
	b => b.length >= 34 && tag(b, 0, 'MOONFISH') ? mod(rawstr(b, 34, Math.min(32, b[33])), 'MoonFish') : null,
	function info_psm(b) {
		if (b.length < 12 || !tag(b, 0, 'PSM ') || !tag(b, 8, 'FILE')) return null;
		let title = '';
		for (let p = 12; p + 8 <= b.length;) {
			const id = rawstr(b, p, 4), len = u32(b, p + 4);
			if (p + 8 + len > b.length) break;
			if (id === 'TITL') { title = str(b, p + 8, Math.min(len, 256)); break; }
			p += 8 + len;
		}
		return mod(title, 'Epic MegaGames MASI', TYPE_MODULE_S3M);
	},
	function info_psm16(b) {
		if (b.length < 0x52 || rawstr(b, 0, 4) !== 'PSM\xfe' || b[63] !== 0x1a || (b[64] & 3)
			|| (b[65] !== 0x10 && b[65] !== 1) || b[66] !== 0 || b[68] < 32) return null;
		for (let i = 0; i < 4; i++) { const w = u16(b, 70 + 2 * i); if (w < 1 || w > 255) return null; }
		for (let i = 0; i < 2; i++) { const w = u16(b, 78 + 2 * i); if (w < 1 || w > 32) return null; }
		let t = ''; for (let i = 4; i < 63; i++) t += String.fromCharCode(b[i] || 32);
		return mod(t.replace(/\s+$/, ''), 'Epic MegaGames MASI', TYPE_MODULE_S3M);
	},
	function info_dsm(b) {
		if (b.length < 40 || !tag(b, 0, 'RIFF') || !tag(b, 8, 'DSMF')) return null;
		let title = '';
		for (let p = 12; p + 8 <= b.length;) {
			const id = rawstr(b, p, 4), len = u32(b, p + 4);
			if (p + 8 + len > b.length) break;
			if (id === 'SONG') { title = str(b, p + 8, 28); break; }
			p += 8 + len;
		}
		return mod(title, 'Digital Sound Interface Kit');
	},
	b => { const h = d00_header_read(fp_open(b)); return h ? mod(String.fromCharCode(...h.title).replace(/\0[\s\S]*$/, ''), 'EdLib Tracker D00', TYPE_MODULE_S3M) : null; },
];
const late_module_info = [
	b => b.length >= 47 && tag(b, 0, 'MAS_UTrack_V00') ? mod(str(b, 15, 32), 'UltraTracker Module', TYPE_MODULE_S3M) : null,
	b => b.length >= 65 && tag(b, 0, 'Liquid Module:') && b[64] === 0x1a ? mod(str(b, 14, 30), 'Liquid Tracker', TYPE_MODULE_S3M) : null,
	b => b.length >= 45 && rawstr(b, 0, 7) === 'AMShdr\x1a' ? mod(str(b, 8, Math.min(30, b[7])), 'Velvet Studio', TYPE_MODULE_XM) : null,
	b => b.length >= 46 && tag(b, 0, 'F2R') ? mod(str(b, 6, 40), 'Farandole 2 (linear)', TYPE_MODULE_S3M) : null,
];
const later_module_info = [
	b => b.length >= 64 && tag(b, 60, 'IM10') ? mod(str(b, 0, 32), 'Imago Orpheus', TYPE_MODULE_IT) : null,
	function info_sfx(b) {
		for (const [pos, t, id] of [[124, 'SO31', 'SoundFX 2'], [124, 'SONG', 'SoundFX 2 (?)'], [60, 'SONG', 'SoundFX']])
			if (b.length >= pos + 4 && rawstr(b, pos, 4) === t) return mod('', id);
		return null;
	},
	function info_stx(b) {
		if (b.length < 64 || !tag(b, 60, 'SCRM')) return null;
		for (let i = 20; i < 28; i++) if (b[i] < 0x20 || b[i] > 0x7e) return null;
		return mod(str(b, 0, 20), 'ST Music Interface Kit');
	},
];
const last_module_info = [
	function info_stm(b) {
		if (b.length < 32) return null;
		if ((b[28] !== 0x1a && b[28] !== 2) || (b[29] !== 1 && b[29] !== 2) || b[30] !== 2) return null;
		for (let i = 20; i < 28; i++) if (b[i] < 0x20 || b[i] > 0x7e) return null;
		return mod(str(b, 0, 20), 'Scream Tracker 2');
	},
];
const first_match = (list, b) => { for (const f of list) { const r = f(b); if (r) return r; } return null; };

// returns { type, title, description, ...sample info } or null
export function dmoz_file_info(base, b) {
	const ext = (base.split('.').pop() || '').toLowerCase();
	const m = first_match(module_info, b);
	if (m) return m;
	if (b.length >= 80 && tag(b, 0, 'IMPS')) {
		return { type: TYPE_SAMPLE_EXTD, title: str(b, 20, 26), description: 'Impulse Tracker Sample',
			smp_length: u32(b, 0x30), smp_flags: b[0x12], smp_filename: str(b, 4, 12) };
	}
	const es = early_sample_info(base, b);
	if (es) return es;
	if (b.length >= 12 && tag(b, 0, 'FORM') && tag(b, 8, 'AIFC')) return { type: TYPE_SAMPLE_COMPR, title: base, description: 'Audio IFF (compressed)' };
	if (b.length >= 12 && tag(b, 0, 'RIFF') && tag(b, 8, 'WAVE')) return { type: TYPE_SAMPLE_COMPR, title: base, description: 'IBM/Microsoft RIFF Audio' };
	if (tag(b, 0, 'fLaC')) return { type: TYPE_SAMPLE_COMPR, title: base, description: 'FLAC Audio' };
	if (b.length >= 554 && tag(b, 0, 'IMPI')) return { type: TYPE_INST_ITI, title: str(b, 32, 26), description: 'Impulse Tracker Instrument' };
	if (b.length >= 0x150 && tag(b, 0, 'Extended Instrument: ')) return { type: TYPE_INST_XI, title: str(b, 21, 22), description: 'Fast Tracker Instrument' };
	const m2 = first_match(late_module_info, b) || s3i_info(b) || first_match(later_module_info, b);
	if (m2) return m2;
	if (tag(b, 0, 'OggS')) return { type: TYPE_SAMPLE_COMPR, title: base, description: 'Ogg Audio' };
	const m3 = first_match(last_module_info, b);
	if (m3) return m3;
	if (tag(b, 0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && ext === 'mp3')) return { type: TYPE_SAMPLE_COMPR, title: base, description: 'MPEG Layer 3' };
	const br = brr_info(b);
	if (br) return br;
	if (['ptm', 'amf', 'dmf'].includes(ext))
		return { type: TYPE_UNKNOWN, title: '', description: ext.toUpperCase() + ' (not supported)' };
	return { type: TYPE_UNKNOWN, title: '', description: 'Unknown / raw data' };
}

// ---------------------------------------------------------------------
// sample loaders: each fills `smp` and returns true

export function fmt_load_sample(base, b, smp) {
	const info = dmoz_file_info(base, b);
	if (info.type === TYPE_SAMPLE_EXTD) {
		const fp = fp_open(b);
		return !!load_its_sample(fp, smp, 0x0214);
	}
	if (!smp.name) smp.name = base.slice(0, 25);
	if (load_native_sample(b, smp)) return true;
	if (info.type === TYPE_SAMPLE_COMPR) return false;
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
