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

// fmt/pat.c: Gravis Ultrasound patches
function pat_header_ok(b) {
	return b.length >= 239 && tag(b, 0, 'GF1PATCH') && (tag(b, 8, '110\0') || tag(b, 8, '100\0')) && tag(b, 12, 'ID#000002\0');
}
function pat_info(b) {
	if (!pat_header_ok(b)) return null;
	return { type: TYPE_INST_OTHER, title: str(b, 131, 16), description: 'Gravis Patch File', sampsize: Math.max(1, Math.min(16, b[198])) };
}
const gus_scale_table = [
	16351, 17323, 18354, 19445, 20601, 21826, 23124, 24499, 25956, 27500, 29135, 30867,
	32703, 34647, 36708, 38890, 41203, 43653, 46249, 48999, 51913, 54999, 58270, 61735,
	65406, 69295, 73416, 77781, 82406, 87306, 92498, 97998, 103826, 109999, 116540, 123470,
	130812, 138591, 146832, 155563, 164813, 174614, 184997, 195997, 207652, 219999, 233081, 246941,
	261625, 277182, 293664, 311126, 329627, 349228, 369994, 391995, 415304, 440000, 466163, 493883,
	523251, 554365, 587329, 622254, 659255, 698456, 739989, 783991, 830609, 880000, 932328, 987767,
	1046503, 1108731, 1174660, 1244509, 1318511, 1396914, 1479979, 1567983, 1661220, 1760002, 1864657, 1975536,
	2093007, 2217464, 2349321, 2489019, 2637024, 2793830, 2959960, 3135968, 3322443, 3520006, 3729316, 3951073,
	4186073, 4434930, 4698645, 4978041, 5274051, 5587663, 5919922, 6271939, 6644889, 7040015, 7458636, 7902150,
	0xFFFFFFFF,
];
function gusfreq(freq) {
	for (let no = 0; gus_scale_table[no] !== 0xFFFFFFFF; no++)
		if (gus_scale_table[no] <= freq && gus_scale_table[no + 1] >= freq) return no - 12;
	return 4 * 12;
}
function load_pat(b, new_sample) {
	if (!pat_header_ok(b)) return null;
	const ins = csf_allocate_instrument();
	ins.name = str(b, 131, 15);
	const nsamp = Math.max(1, Math.min(16, b[198]));
	for (let i = 0; i < 120; i++) { ins.sample_map[i] = 0; ins.note_map[i] = i + 1; }
	const fp = fp_open(b);
	fp.position = 239;
	const samples = [];
	for (let i = 0; i < nsamp; i++) {
		const p = fp.position;
		if (p + 96 > b.length) return null;
		let samplesize = u32(b, p + 8), loopstart = u32(b, p + 12), loopend = u32(b, p + 16);
		const samplerate = u16(b, p + 20), lofreq = u32(b, p + 22), hifreq = u32(b, p + 26);
		const vib_speed = b[p + 52], vib_rate = b[p + 53], vib_depth = b[p + 54], smpmode = b[p + 55];
		fp.position = p + 96;
		const n = i + 1, smp = new_sample();
		let lo = Math.max(0, Math.min(95, gusfreq(lofreq))), hi = Math.max(0, Math.min(95, gusfreq(hifreq)));
		if (lo > hi) [lo, hi] = [hi, lo];
		for (; lo < hi; lo++) ins.sample_map[lo + 12] = n;
		if (smpmode & 1) { samplesize >>>= 1; loopstart >>>= 1; loopend >>>= 1; }
		smp.length = samplesize;
		smp.loop_start = smp.sustain_start = loopstart;
		smp.loop_end = smp.sustain_end = loopend;
		smp.c5speed = samplerate;
		smp.flags = 0;
		const rs = C.SF_M | C.SF_LE | (smpmode & 1 ? C.SF_16 : C.SF_8) | (smpmode & 2 ? C.SF_PCMU : C.SF_PCMS);
		if (smpmode & 32) {
			if (smpmode & 4) smp.flags |= C.CHN_SUSTAINLOOP;
			if (smpmode & 8) smp.flags |= C.CHN_PINGPONGSUSTAIN;
		} else {
			if (smpmode & 4) smp.flags |= C.CHN_LOOP;
			if (smpmode & 8) smp.flags |= C.CHN_PINGPONGLOOP;
		}
		smp.filename = str(b, p, 7);
		smp.name = smp.filename;
		smp.vib_speed = vib_speed; smp.vib_rate = vib_rate; smp.vib_depth = vib_depth;
		read_sample(smp, rs, fp);
		samples.push(smp);
	}
	return { ins, samples };
}

// fmt/sf2.c: SoundFont 2 as a bank of samples (no key mapping, as upstream)
function sf2_read(b) {
	if (b.length < 12 || !tag(b, 0, 'RIFF') || !tag(b, 8, 'sfbk')) return null;
	// riff_chunk_peek: { id, offset (data start), size }; chunks are padded to even sizes
	const chunks = (start, end) => {
		const out = [];
		for (let p = start; p + 8 <= Math.min(end, b.length);) {
			const size = u32(b, p + 4);
			out.push({ id: String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]), offset: p + 8, size });
			p += 8 + size + (size & 1);
		}
		return out;
	};
	let cINFO = null, csdta = null, cpdta = null;
	for (const c of chunks(12, b.length)) {
		if (c.id !== 'LIST' || c.size < 4) continue;
		const id = String.fromCharCode(b[c.offset], b[c.offset + 1], b[c.offset + 2], b[c.offset + 3]);
		if (id === 'INFO') cINFO = c; else if (id === 'sdta') csdta = c; else if (id === 'pdta') cpdta = c;
	}
	if (!cINFO || !csdta || !cpdta) return null; /* definitely not sf2 */
	const cs = {};
	for (const c of chunks(cINFO.offset + 4, cINFO.offset + cINFO.size)) {
		if (c.id === 'INAM') cs.INAM = c;
		else if (c.id === 'ifil') {
			if (c.size !== 4) return null;
			if ((u32(b, c.offset) & 0xffff) !== 2) return null; /* v1 and v3 are not tested */
		}
	}
	for (const c of chunks(cpdta.offset + 4, cpdta.offset + cpdta.size)) if (c.id === 'shdr') cs.shdr = c;
	if (!cs.shdr || cs.shdr.size % 46) return null;
	for (const c of chunks(csdta.offset + 4, csdta.offset + csdta.size)) if (c.id === 'smpl') cs.smpl = c;
	if (!cs.smpl) return null;
	return cs;
}
function sf2_info(b) {
	const cs = sf2_read(b);
	if (!cs) return null;
	return { type: TYPE_INST_OTHER, title: cs.INAM ? str(b, cs.INAM.offset, cs.INAM.size) : '', description: 'SoundFont2',
		sampsize: cs.shdr.size / 46 };
}
function load_sf2(b, new_sample) {
	const cs = sf2_read(b);
	if (!cs) return null;
	const nsmp = cs.shdr.size / 46, smpl_words = Math.floor(cs.smpl.size / 2);
	const ins = csf_allocate_instrument();
	ins.name = cs.INAM ? str(b, cs.INAM.offset, Math.min(cs.INAM.size, 15)) : '';
	for (let i = 0; i < 120; i++) { ins.sample_map[i] = 0; ins.note_map[i] = i + 1; }
	const samples = [];
	const rec = i => {
		const p = cs.shdr.offset + i * 46;
		return { name: str(b, p, 20), start: u32(b, p + 20), end: u32(b, p + 24), loop_start: u32(b, p + 28), loop_end: u32(b, p + 32),
			rate: u32(b, p + 36), note: b[p + 40], cents: (b[p + 41] << 24) >> 24, link: u16(b, p + 42), type: u16(b, p + 44) };
	};
	for (let i = 0; i < nsmp; i++) {
		const h = rec(i);
		if (h.type !== 1 && h.type !== 2) continue; /* left stereo, linked, ROM: unsupported */
		if (h.end > smpl_words || h.end < h.start) continue; /* invalid ?? */
		const smp = new_sample();
		smp.name = h.name.slice(0, 25);
		smp.length = h.end - h.start;
		if (h.loop_start | h.loop_end) {
			// shdr loop points are absolute positions in the smpl chunk (upstream stores them
			// unchanged, which puts the loop outside the sample); make them sample-relative
			smp.flags |= C.CHN_LOOP;
			smp.loop_start = Math.max(0, h.loop_start - h.start);
			smp.loop_end = Math.max(0, h.loop_end - h.start);
		}
		/* transpose the frequency; also account for the cents. hopefully the sample is now a middle C */
		smp.c5speed = Math.trunc(h.rate * Math.pow(2, ((60 - h.note) - h.cents / 100) / 12)) >>> 0;
		const fp = fp_open(b);
		if (h.type === 1) {
			fp.position = cs.smpl.offset + h.start * 2;
			read_sample(smp, C.SF_16 | C.SF_M | C.SF_LE | C.SF_PCMS, fp);
		} else {
			/* right channel of a stereo pair: the linked record holds the left one */
			const l = h.link < nsmp ? rec(h.link) : h;
			const n = Math.min(smp.length, Math.max(0, l.end - l.start));
			const data = new Int16Array(smp.length * 2);
			for (let j = 0; j < smp.length; j++) {
				const lo = cs.smpl.offset + (l.start + j) * 2, ro = cs.smpl.offset + (h.start + j) * 2;
				data[j * 2] = j < n && lo + 1 < b.length ? (b[lo] | (b[lo + 1] << 8)) << 16 >> 16 : 0;
				data[j * 2 + 1] = ro + 1 < b.length ? (b[ro] | (b[ro + 1] << 8)) << 16 >> 16 : 0;
			}
			smp.flags |= C.CHN_16BIT | C.CHN_STEREO;
			smp.data = data;
		}
		csf_adjust_sample_loop(smp);
		samples.push(smp);
	}
	return { ins, samples };
}

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
	if (tag(b, 0, 'fLaC')) return { type: TYPE_SAMPLE_COMPR, title: base, description: 'FLAC Audio File' };
	if (b.length >= 554 && tag(b, 0, 'IMPI')) return { type: TYPE_INST_ITI, title: str(b, 32, 26), description: 'Impulse Tracker Instrument' };
	if (b.length >= 0x12a && tag(b, 0, 'Extended Instrument: ') && b[0x2b] === 0x1a && u16(b, 0x40) === 0x0102)
		return { type: TYPE_INST_XI, title: str(b, 0x15, 22), description: 'Fasttracker II Instrument', sampsize: u16(b, 0x128) };
	const m2 = first_match(late_module_info, b) || s3i_info(b) || first_match(later_module_info, b);
	if (m2) return m2;
	if (tag(b, 0, 'OggS')) return { type: TYPE_SAMPLE_COMPR, title: base, description: 'Ogg Audio' };
	const m3 = first_match(last_module_info, b);
	if (m3) return m3;
	if (tag(b, 0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && ext === 'mp3')) return { type: TYPE_SAMPLE_COMPR, title: base, description: 'MPEG Layer 3' };
	const br = brr_info(b);
	if (br) return br;
	const gi = pat_info(b) || sf2_info(b);
	if (gi) return gi;
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
	if (info.type === TYPE_INST_OTHER) return pat_header_ok(b) ? load_pat(b, new_sample) : load_sf2(b, new_sample);
	// a plain sample becomes a one-sample instrument
	const smp = new_sample();
	if (!fmt_load_sample(base, b, smp)) return null;
	const ins = csf_allocate_instrument();
	ins.name = smp.name;
	ins.sample_map.fill(1);
	return { ins, samples: [smp] };
}

// fmt/xi.c: fmt_xi_load_instrument
function load_xi(b, base, new_sample) {
	const ins = csf_allocate_instrument();
	ins.name = str(b, 0x15, 22);
	const snum = Array.from(b.subarray(0x42, 0x42 + 96), v => Math.min(v, 15));
	const nsamples = u16(b, 0x128);
	for (let k = 0; k < 96; k++) {
		ins.note_map[k + 12] = k + 1 + 12;
		ins.sample_map[k + 12] = snum[k] < nsamples ? snum[k] + 1 : 0;
	}
	for (let k = 0; k < 12; k++) {
		ins.note_map[k] = ins.sample_map[k] = 0;
		ins.note_map[k + 108] = ins.sample_map[k + 108] = 0;
	}
	const vtype = b[0x10a], ptype = b[0x10b];
	if (vtype & 1) ins.flags |= C.ENV_VOLUME;
	if (vtype & 2) ins.flags |= C.ENV_VOLSUSTAIN;
	if (vtype & 4) ins.flags |= C.ENV_VOLLOOP;
	if (ptype & 1) ins.flags |= C.ENV_PANNING;
	if (ptype & 2) ins.flags |= C.ENV_PANSUSTAIN;
	if (ptype & 4) ins.flags |= C.ENV_PANLOOP;
	const copy_env = (env, off, num) => {
		let prevtick = -1;
		for (let k = 0; k < num; k++) {
			const ticks = u16(b, off + k * 4), val = u16(b, off + k * 4 + 2);
			if (ticks < prevtick) prevtick++; else prevtick = ticks;
			env.ticks[k] = prevtick; env.values[k] = val;
		}
		env.nodes = num;
	};
	copy_env(ins.vol_env, 0xa2, Math.min(b[0x102], 12));
	copy_env(ins.pan_env, 0xd2, Math.min(b[0x103], 12));
	ins.vol_env.sustain_start = b[0x104]; ins.vol_env.loop_start = b[0x105]; ins.vol_env.loop_end = b[0x106];
	ins.pan_env.sustain_start = b[0x107]; ins.pan_env.loop_start = b[0x108]; ins.pan_env.loop_end = b[0x109];
	const vibtype = b[0x10c], vibsweep = b[0x10d], vibdepth = b[0x10e], vibrate = b[0x10f];
	const fp = fp_open(b);
	let smpdataoffset = 0x12a + 40 * nsamples;
	const samples = [];
	for (let k = 0; k < nsamples; k++) {
		const p = 0x12a + 40 * k;
		if (p + 40 > b.length) break;
		let samplen = u32(b, p), loopstart = u32(b, p + 4), looplen = u32(b, p + 8);
		const vol = b[p + 12], finetune = (b[p + 13] << 24) >> 24, pan = b[p + 15], relnote = (b[p + 16] << 24) >> 24;
		let type = b[p + 14];
		const rs = C.SF_LE | C.SF_PCMD | (type & 0x20 ? C.SF_SS : C.SF_M) | (type & 0x10 ? C.SF_16 : C.SF_8);
		if (type & 0x10) { looplen >>>= 1; loopstart >>>= 1; samplen >>>= 1; }
		if (type & 0x20) { looplen >>>= 1; loopstart >>>= 1; samplen >>>= 1; }
		if (loopstart >= samplen) type &= ~3;
		looplen = (looplen + loopstart) >>> 0;
		if (looplen > samplen) looplen = samplen;
		if (!looplen) type &= ~3;
		const smp = new_sample();
		smp.flags = 0;
		smp.name = str(b, p + 18, 21);
		smp.length = samplen;
		smp.loop_start = loopstart;
		smp.loop_end = looplen;
		if (smp.loop_end < smp.loop_start) smp.loop_end = smp.length;
		if (smp.loop_start >= smp.loop_end) smp.loop_start = smp.loop_end = 0;
		switch (type & 3) {
		case 3: case 2: smp.flags |= C.CHN_PINGPONGLOOP; // fall through
		case 1: smp.flags |= C.CHN_LOOP; break;
		}
		smp.volume = Math.min(vol << 2, 256);
		smp.global_volume = 64;
		smp.panning = pan;
		smp.flags |= C.CHN_PANNING;
		smp.vib_type = vibtype;
		smp.vib_speed = Math.min(vibrate, 64);
		smp.vib_depth = Math.min(vibdepth, 32);
		if (vibrate | vibdepth) {
			if (vibsweep) smp.vib_rate = Math.max(0, Math.min(255, Math.floor((smp.vib_depth * 256 + (vibsweep >> 1)) / vibsweep)));
			else smp.vib_rate = 255;
		}
		smp.c5speed = transpose_to_frequency(relnote, finetune);
		if (smp.length) {
			fp.position = smpdataoffset;
			smpdataoffset += read_sample(smp, rs, fp);
		}
		samples.push(smp);
	}
	void base;
	return { ins, samples };
}

provide({ dmoz_file_info, fmt_load_sample, fmt_decode_sample, fmt_load_instrument });
