// Writers: fmt/it.c (save), fmt/its.c, fmt/iti.c (save), fmt/wav.c (sample
// save), raw samples, and disko.c's WAV song export (Schism Tracker, GPL-2.0-or-later).
import { provide, app } from '../app.js';
import * as C from '../sndconst.js';
import { csf_get_num_orders, csf_get_num_instruments, csf_get_num_samples, csf_get_num_patterns,
	csf_pattern_is_empty, csf_export_s3m_effect, csf_allocate, csf_set_current_order } from '../csndfile.js';
import { finetune_table } from '../gen/tables.js';

// disko_t: a growable little-endian writer
export class Disko {
	constructor() { this.buf = new Uint8Array(65536); this.pos = 0; this.len = 0; }
	grow(n) {
		if (this.pos + n <= this.buf.length) return;
		let size = this.buf.length;
		while (size < this.pos + n) size *= 2;
		const b = new Uint8Array(size); b.set(this.buf); this.buf = b;
	}
	write(bytes) {
		this.grow(bytes.length);
		this.buf.set(bytes, this.pos);
		this.pos += bytes.length;
		if (this.pos > this.len) this.len = this.pos;
	}
	u8(v) { this.write([v & 0xff]); }
	u16(v) { this.write([v & 0xff, (v >> 8) & 0xff]); }
	u32(v) { this.write([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]); }
	str(s, n) { const b = new Uint8Array(n); for (let i = 0; i < n && i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; this.write(b); }
	seek(p) { this.pos = p; }
	tell() { return this.pos; }
	bytes() { return this.buf.slice(0, this.len); }
}

// csf_write_sample for the PCMS/PCMU/PCMD little-endian cases
export function csf_write_sample(fp, smp, flags) {
	const stereo = smp.flags & C.CHN_STEREO ? 2 : 1, bits = smp.flags & C.CHN_16BIT ? 16 : 8;
	const len = smp.length, d = smp.data;
	const enc = flags & C.SF_ENC_MASK, split = (flags & C.SF_CHN_MASK) === C.SF_SS;
	const bytes = bits >> 3;
	const out = new Uint8Array(len * stereo * bytes);
	const dv = new DataView(out.buffer);
	let o = 0;
	const put = v => {
		if (enc === C.SF_PCMU) v ^= bits === 16 ? 0x8000 : 0x80;
		if (bits === 16) { dv.setUint16(o, v & 0xffff, !(flags & C.SF_BE)); o += 2; } else out[o++] = v & 0xff;
	};
	const delta = [0, 0];
	const emit = (v, c) => {
		if (enc === C.SF_PCMD) { const x = v - delta[c]; delta[c] = v; put(x); } else put(v);
	};
	if (stereo === 2 && split) {
		for (let c = 0; c < 2; c++) for (let i = 0; i < len; i++) emit(d[i * 2 + c], c);
	} else {
		for (let i = 0; i < len * stereo; i++) emit(d[i], i % stereo);
	}
	fp.write(out);
	return out.length;
}

// fmt/its.c
export function save_its_header(fp, smp) {
	let flags = 0;
	if (smp.data && smp.length) flags |= 1;
	if (smp.flags & C.CHN_16BIT) flags |= 2;
	if (smp.flags & C.CHN_STEREO) flags |= 4;
	if (smp.flags & C.CHN_LOOP) flags |= 16;
	if (smp.flags & C.CHN_SUSTAINLOOP) flags |= 32;
	if (smp.flags & C.CHN_PINGPONGLOOP) flags |= 64;
	if (smp.flags & C.CHN_PINGPONGSUSTAIN) flags |= 128;
	fp.str('IMPS', 4);
	fp.str(smp.filename || '', 12);
	fp.u8(0);
	fp.u8(smp.global_volume);
	fp.u8(flags);
	fp.u8(smp.volume >> 2);
	fp.str((smp.name || '').slice(0, 25), 26);
	fp.u8(1); // signed samples
	fp.u8((smp.panning >> 2) | (smp.flags & C.CHN_PANNING ? 0x80 : 0));
	fp.u32(smp.length); fp.u32(smp.loop_start); fp.u32(smp.loop_end); fp.u32(smp.c5speed);
	fp.u32(smp.sustain_start); fp.u32(smp.sustain_end);
	fp.u32(0); // sample pointer, filled in later
	fp.u8(smp.vib_speed); fp.u8(smp.vib_depth); fp.u8(smp.vib_rate);
	fp.u8({ [C.VIB_RANDOM]: 3, [C.VIB_SQUARE]: 2, [C.VIB_RAMP_DOWN]: 1 }[smp.vib_type] || 0);
}
const sample_write_flags = smp => C.SF_LE | C.SF_PCMS | (smp.flags & C.CHN_16BIT ? C.SF_16 : C.SF_8) | (smp.flags & C.CHN_STEREO ? C.SF_SS : C.SF_M);
export function fmt_its_save_sample(smp) {
	const fp = new Disko();
	save_its_header(fp, smp);
	if (smp.data) csf_write_sample(fp, smp, sample_write_flags(smp));
	fp.seek(0x48); fp.u32(80);
	return fp.bytes();
}

// fmt/iti.c
function save_iti_envelope(fp, flags, env, adj) {
	fp.u8(flags); fp.u8(env.nodes); fp.u8(env.loop_start); fp.u8(env.loop_end); fp.u8(env.sustain_start); fp.u8(env.sustain_end);
	for (let j = 0; j < 25; j++) { fp.u8(env.values[j] - adj); fp.u16(env.ticks[j]); }
	fp.u8(0);
}
export function save_iti_instrument(fp, song, ins, iti_file) {
	const f = ins ? ins.flags : 0;
	ins = ins || { filename: '', name: '', nna: 0, dct: 0, dca: 0, fadeout: 0, pitch_pan_separation: 0, pitch_pan_center: 0,
		global_volume: 0, panning: 0, vol_swing: 0, pan_swing: 0, ifc: 0, ifr: 0, midi_channel_mask: 0, midi_program: 0, midi_bank: 0,
		note_map: new Uint8Array(120), sample_map: new Uint8Array(120),
		vol_env: { values: new Uint8Array(32), ticks: new Int32Array(32), nodes: 0, loop_start: 0, loop_end: 0, sustain_start: 0, sustain_end: 0 } };
	if (!ins.pan_env) ins.pan_env = ins.pitch_env = { values: new Uint8Array(32).fill(32), ticks: new Int32Array(32), nodes: 0, loop_start: 0, loop_end: 0, sustain_start: 0, sustain_end: 0 };
	let mch = 0;
	if (ins.midi_channel_mask >= 0x10000) { mch = ins.midi_channel_mask - 0x10000; if (mch <= 16) mch = 16; }
	else if (ins.midi_channel_mask & 0xffff) { mch = 1; while (!(ins.midi_channel_mask & (1 << (mch - 1)))) ++mch; }
	const map = new Int32Array(255).fill(-1), invmap = [];
	const notetrans = [];
	for (let j = 0; j < 120; j++) {
		let smpn = ins.sample_map[j];
		if (iti_file) {
			if (smpn > 0 && smpn < 255 && map[smpn] === -1) { map[smpn] = invmap.length; invmap.push(smpn); }
			smpn = map[smpn] + 1;
		}
		notetrans.push([(ins.note_map[j] - 1) & 0xff, smpn & 0xff]);
	}
	fp.str('IMPI', 4); fp.str(ins.filename || '', 12); fp.u8(0);
	fp.u8(ins.nna); fp.u8(ins.dct); fp.u8(ins.dca); fp.u16(ins.fadeout >> 5);
	fp.u8(ins.pitch_pan_separation & 0xff); fp.u8(ins.pitch_pan_center); fp.u8(ins.global_volume);
	fp.u8((ins.panning >> 2) | (f & C.ENV_SETPANNING ? 0 : 0x80));
	fp.u8(ins.vol_swing); fp.u8(ins.pan_swing);
	fp.u16(iti_file ? 0x1000 | 0x050 : 0); fp.u8(iti_file ? invmap.length : 0); fp.u8(0);
	fp.str((ins.name || '').slice(0, 25), 26);
	fp.u8(ins.ifc); fp.u8(ins.ifr); fp.u8(mch); fp.u8(ins.midi_program & 0xff); fp.u16(ins.midi_bank & 0xffff);
	for (const [n, s] of notetrans) { fp.u8(n); fp.u8(s); }
	save_iti_envelope(fp, (f & C.ENV_VOLUME ? 1 : 0) | (f & C.ENV_VOLLOOP ? 2 : 0) | (f & C.ENV_VOLSUSTAIN ? 4 : 0) | (f & C.ENV_VOLCARRY ? 8 : 0), ins.vol_env, 0);
	save_iti_envelope(fp, (f & C.ENV_PANNING ? 1 : 0) | (f & C.ENV_PANLOOP ? 2 : 0) | (f & C.ENV_PANSUSTAIN ? 4 : 0) | (f & C.ENV_PANCARRY ? 8 : 0), ins.pan_env, 32);
	save_iti_envelope(fp, (f & C.ENV_PITCH ? 1 : 0) | (f & C.ENV_PITCHLOOP ? 2 : 0) | (f & C.ENV_PITCHSUSTAIN ? 4 : 0) | (f & C.ENV_PITCHCARRY ? 8 : 0) | (f & C.ENV_FILTER ? 0x80 : 0), ins.pitch_env, 32);
	fp.write([0, 0, 0, 0]);
	if (iti_file) {
		let pos = fp.tell();
		const hdrpos = [];
		for (const o of invmap) { hdrpos.push(pos); pos += 80; save_its_header(fp, song.samples[o]); }
		invmap.forEach((o, j) => {
			const op = fp.tell();
			fp.seek(hdrpos[j] + 0x48); fp.u32(op); fp.seek(op);
			const smp = song.samples[o];
			if (smp.data) csf_write_sample(fp, smp, sample_write_flags(smp));
		});
	}
}
export function fmt_iti_save_instrument(song, ins) {
	const fp = new Disko();
	save_iti_instrument(fp, song, ins, 1);
	return fp.bytes();
}

// fmt/it.c
function save_it_pattern(fp, pat, patsize) {
	const lastnote = Array.from({ length: 64 }, () => ({ note: 0, instrument: 0, volparam: 0, effect: 0, param: 0 }));
	const initmask = new Uint8Array(64), lastmask = new Uint8Array(64).fill(0xff);
	const data = [];
	for (let row = 0; row < patsize; row++) {
		for (let chan = 0; chan < 64; chan++) {
			const n = pat[row * 64 + chan];
			let m = 0, vol = -1, note = n.note;
			const ep = { effect: n.effect, param: n.param };
			if (note) { m |= 1; if (note < 0x80) note--; }
			if (n.instrument) m |= 2;
			const v = n.volparam;
			switch (n.voleffect) {
			case C.VOLFX_VOLUME: vol = Math.min(v, 64); break;
			case C.VOLFX_FINEVOLUP: vol = Math.min(v, 9) + 65; break;
			case C.VOLFX_FINEVOLDOWN: vol = Math.min(v, 9) + 75; break;
			case C.VOLFX_VOLSLIDEUP: vol = Math.min(v, 9) + 85; break;
			case C.VOLFX_VOLSLIDEDOWN: vol = Math.min(v, 9) + 95; break;
			case C.VOLFX_PORTADOWN: vol = Math.min(v, 9) + 105; break;
			case C.VOLFX_PORTAUP: vol = Math.min(v, 9) + 115; break;
			case C.VOLFX_PANNING: vol = Math.min(v, 64) + 128; break;
			case C.VOLFX_VIBRATODEPTH: vol = Math.min(v, 9) + 203; break;
			case C.VOLFX_VIBRATOSPEED: vol = 203; break;
			case C.VOLFX_TONEPORTAMENTO: vol = Math.min(v, 9) + 193; break;
			}
			if (vol !== -1) m |= 4;
			csf_export_s3m_effect(ep, 1);
			if (ep.effect || ep.param) m |= 8;
			if (!m) continue;
			const ln = lastnote[chan];
			if (m & 1) { if (note === ln.note && (initmask[chan] & 1)) { m &= ~1; m |= 0x10; } else { ln.note = note; initmask[chan] |= 1; } }
			if (m & 2) { if (n.instrument === ln.instrument && (initmask[chan] & 2)) { m &= ~2; m |= 0x20; } else { ln.instrument = n.instrument; initmask[chan] |= 2; } }
			if (m & 4) { if (vol === ln.volparam && (initmask[chan] & 4)) { m &= ~4; m |= 0x40; } else { ln.volparam = vol; initmask[chan] |= 4; } }
			if (m & 8) {
				if (ep.effect === ln.effect && ep.param === ln.param && (initmask[chan] & 8)) { m &= ~8; m |= 0x80; }
				else { ln.effect = ep.effect; ln.param = ep.param; initmask[chan] |= 8; }
			}
			if (m === lastmask[chan]) data.push(chan + 1);
			else { lastmask[chan] = m; data.push((chan + 1) | 0x80, m); }
			if (m & 1) data.push(note & 0xff);
			if (m & 2) data.push(n.instrument);
			if (m & 4) data.push(vol);
			if (m & 8) data.push(ep.effect, ep.param);
		}
		data.push(0);
	}
	fp.u16(data.length); fp.u16(patsize); fp.u32(0);
	fp.write(data);
}

export function fmt_it_save_song(song) {
	const fp = new Disko();
	const msg = (song.message || '').replace(/\n/g, '\r');
	let msglen = msg.length;
	const hist = song.history || [];
	let extra = 2 + 8 * hist.length + 8;
	const nord = Math.max(2, Math.min(csf_get_num_orders(song) + 1, C.MAX_ORDERS));
	const nins = csf_get_num_instruments(song);
	const nsmp = csf_get_num_samples(song);
	const npat = csf_get_num_patterns(song) || 1;
	let cmwt = 0x0214;
	for (let n = 1; n < nins; n++) if (song.instruments[n] && (song.instruments[n].flags & C.ENV_FILTER)) { cmwt = 0x0217; break; }
	let flags = 0, special = 2 | 4;
	if (!(song.flags & C.SONG_NOSTEREO)) flags |= 1;
	if (song.flags & C.SONG_INSTRUMENTMODE) flags |= 4;
	if (song.flags & C.SONG_LINEARSLIDES) flags |= 8;
	if (song.flags & C.SONG_ITOLDEFFECTS) flags |= 16;
	if (song.flags & C.SONG_COMPATGXX) flags |= 32;
	const embed = (song.flags & C.SONG_EMBEDMIDICFG) && song.midi_config && song.midi_config.zxx;
	if (embed) { flags |= 128; special |= 8; extra += 4896; }
	if (msglen) { special |= 1; msglen++; }
	fp.str('IMPM', 4);
	fp.str((song.title || '').slice(0, 25), 26);
	fp.u8(song.row_highlight_minor); fp.u8(song.row_highlight_major);
	fp.u16(nord); fp.u16(nins); fp.u16(nsmp); fp.u16(npat);
	fp.u16(0x1000 | 0x050); fp.u16(cmwt); fp.u16(flags); fp.u16(special);
	fp.u8(song.initial_global_volume); fp.u8(song.mixing_volume); fp.u8(song.initial_speed); fp.u8(song.initial_tempo);
	fp.u8(song.pan_separation); fp.u8(0);
	fp.u16(msglen); fp.u32(msglen ? extra + 0xc0 + nord + 4 * (nins + nsmp + npat) : 0);
	fp.u32(0);
	for (let n = 0; n < 64; n++) {
		const ch = song.channels[n];
		fp.u8((ch.flags & C.CHN_SURROUND ? 100 : ch.panning >> 2) + (ch.flags & C.CHN_MUTE ? 128 : 0));
	}
	for (let n = 0; n < 64; n++) fp.u8(song.channels[n].volume);
	const ol = new Uint8Array(nord); ol.set(song.orderlist.subarray(0, nord)); fp.write(ol);
	const para_pos = fp.tell();
	fp.write(new Uint8Array(4 * (nins + nsmp + npat)));
	fp.u16(hist.length + 1);
	for (const h of hist) { fp.u16(h.fat_date || 0); fp.u16(h.fat_time || 0); fp.u32(Math.round((h.runtime || 0) * 18.2 / 1000)); }
	{
		const d = new Date();
		fp.u16(((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate());
		fp.u16((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1));
		fp.u32(Math.round(performance.now() * 18.2 / 1000));
	}
	if (embed) {
		const mc = song.midi_config;
		for (const f of ['start', 'stop', 'tick', 'note_on', 'note_off', 'set_volume', 'set_panning', 'set_bank', 'set_program']) fp.str(mc[f] || '', 32);
		for (let i = 0; i < 16; i++) fp.str(mc.sfx[i] || '', 32);
		for (let i = 0; i < 128; i++) fp.str(mc.zxx[i] || '', 32);
	}
	if (msglen) { fp.str(msg, msglen); }
	const para_ins = [], para_smp = [], para_pat = [];
	for (let n = 0; n < nins; n++) { para_ins.push(fp.tell()); save_iti_instrument(fp, song, song.instruments[n + 1], 0); }
	for (let n = 0; n < nsmp; n++) { para_smp.push(fp.tell()); save_its_header(fp, song.samples[n + 1]); }
	for (let n = 0; n < npat; n++) {
		if (csf_pattern_is_empty(song, n)) para_pat.push(0);
		else { para_pat.push(fp.tell()); save_it_pattern(fp, song.patterns[n], song.pattern_size[n]); }
	}
	for (let n = 0; n < nsmp; n++) {
		const smp = song.samples[n + 1], op = fp.tell();
		fp.seek(para_smp[n] + 0x48); fp.u32(op); fp.seek(op);
		if (smp.data) csf_write_sample(fp, smp, sample_write_flags(smp));
	}
	fp.seek(para_pos);
	for (const p of [...para_ins, ...para_smp, ...para_pat]) fp.u32(p);
	return fp.bytes();
}

// WAV writing (sample save and song export)
export function wav_bytes(pcm16, channels, rate) {
	const fp = new Disko();
	fp.str('RIFF', 4); fp.u32(36 + pcm16.byteLength); fp.str('WAVE', 4);
	fp.str('fmt ', 4); fp.u32(16); fp.u16(1); fp.u16(channels); fp.u32(rate); fp.u32(rate * channels * 2); fp.u16(channels * 2); fp.u16(16);
	fp.str('data', 4); fp.u32(pcm16.byteLength);
	fp.write(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength));
	return fp.bytes();
}
const VERSION_STRING = 'Schism Tracker 20261111';
// iff.c: iff_fill_xtra_chunk / iff_fill_smpl_chunk
function write_xtra_chunk(fp, smp) {
	fp.str('xtra', 4); fp.u32(16);
	fp.u32(smp.flags & C.CHN_PANNING ? 0x20 : 0);
	fp.u16(smp.panning); fp.u16(smp.volume); fp.u16(smp.global_volume); fp.u16(0);
	fp.u8(smp.vib_type); fp.u8(smp.vib_speed); fp.u8(smp.vib_depth); fp.u8(smp.vib_rate);
}
function write_smpl_chunk(fp, smp) {
	const loop = !!(smp.flags & C.CHN_LOOP), sus = !!(smp.flags & C.CHN_SUSTAINLOOP);
	const nloops = sus ? 2 : loop ? 1 : 0;
	fp.str('smpl', 4); fp.u32(36 + 24 * nloops);
	fp.u32(0); fp.u32(0); fp.u32(smp.c5speed ? Math.trunc(1e9 / smp.c5speed) : 0); fp.u32(72); fp.u32(0); fp.u32(0); fp.u32(0);
	fp.u32(nloops); fp.u32(0);
	const lp = (start, end, bidi) => { fp.str('FLCL', 4); fp.u32(bidi ? 1 : 0); fp.u32(start); fp.u32((end - 1) >>> 0); fp.u32(0); fp.u32(0); };
	if (sus) lp(smp.sustain_start, smp.sustain_end, smp.flags & C.CHN_PINGPONGSUSTAIN);
	if (loop) lp(smp.loop_start, smp.loop_end, smp.flags & C.CHN_PINGPONGLOOP);
	else if (sus) lp(0, 0, 0);
}
function write_wav_list(fp, title) {
	const start = fp.tell();
	fp.str('LIST', 4); fp.u32(0); fp.str('INFO', 4);
	const info = (id, text) => {
		fp.str(id, 4); fp.u32(text.length + (text.length & 1)); fp.str(text, text.length);
		if (text.length & 1) fp.u8(0x20);
	};
	info('ISFT', VERSION_STRING);
	if (title) info('INAM', title);
	const end = fp.tell();
	fp.seek(start + 4); fp.u32(end - start - 8); fp.seek(end);
}
function wav_header(fp, bits, channels, rate, length) {
	const bpf = ((bits + 7) >> 3) * channels;
	fp.write([0x52, 0x49, 0x46, 0x46, 0xff, 0xff, 0xff, 0xff]); fp.str('WAVEfmt ', 8);
	fp.u32(16); fp.u16(1); fp.u16(channels); fp.u32(rate); fp.u32(bpf * rate); fp.u16(bpf); fp.u16(bits);
	fp.str('data', 4); fp.u32(bpf * length);
	return bpf;
}
// wav.c
export function fmt_wav_save_sample(smp) {
	if (smp.flags & C.CHN_ADLIB) return null;
	const fp = new Disko();
	const ch = smp.flags & C.CHN_STEREO ? 2 : 1, bits = smp.flags & C.CHN_16BIT ? 16 : 8;
	wav_header(fp, bits, ch, smp.c5speed, smp.length);
	if (smp.data) csf_write_sample(fp, smp, C.SF_LE | (bits === 16 ? C.SF_16 | C.SF_PCMS : C.SF_8 | C.SF_PCMU) | (ch === 2 ? C.SF_SI : C.SF_M));
	write_xtra_chunk(fp, smp);
	write_smpl_chunk(fp, smp);
	write_wav_list(fp, smp.name);
	const end = fp.tell(); fp.seek(4); fp.u32(end - 8); fp.seek(end);
	return fp.bytes();
}
// ieee-float.c: float_encode_ieee_80
function float_encode_ieee_80(num) {
	const b = new Uint8Array(10);
	let sign = 0;
	if (num < 0) { sign = 0x8000; num = -num; }
	let expon = 0, hi = 0, lo = 0;
	if (num !== 0) {
		if (!isFinite(num)) expon = sign | 0x7fff;
		else {
			let e = Math.floor(Math.log2(num)) + 1, m = num / Math.pow(2, e);
			if (m >= 1) { m /= 2; e++; } else if (m < 0.5) { m *= 2; e--; }
			expon = (e + 16382) | sign;
			let f = m * 4294967296;
			hi = Math.floor(f);
			f = (f - hi) * 4294967296;
			lo = Math.floor(f);
		}
	}
	b[0] = expon >> 8; b[1] = expon & 0xff;
	b[2] = hi >>> 24; b[3] = (hi >>> 16) & 0xff; b[4] = (hi >>> 8) & 0xff; b[5] = hi & 0xff;
	b[6] = lo >>> 24; b[7] = (lo >>> 16) & 0xff; b[8] = (lo >>> 8) & 0xff; b[9] = lo & 0xff;
	return b;
}
// aiff.c: aiff_header (big-endian chunk sizes)
function aiff_header(fp, bits, channels, rate, name, length, smp) {
	const be32 = v => fp.write([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
	const be16 = v => fp.write([(v >> 8) & 0xff, v & 0xff]);
	const bps = (bits + 7) >> 3;
	fp.write([0x46, 0x4f, 0x52, 0x4d, 0xff, 0xff, 0xff, 0xff]); fp.str('AIFF', 4);
	if (name) {
		fp.str('NAME', 4); be32((name.length + 1) & ~1); fp.str(name, name.length);
		if (name.length & 1) fp.u8(0);
	}
	if (smp) {
		fp.str('MARK', 4); be32(2 + 14 + 14); be16(4);
		const marker = (id, x) => { be16(id); be32(x >>> 0); fp.u8(0); };
		marker(1, smp.loop_start); marker(2, smp.loop_end); marker(3, smp.sustain_start); marker(4, smp.sustain_end);
		fp.str('INST', 4); be32(20);
		fp.write([60, 0, 0, 127, 1, 127, 0, 0]);
		const loop = (lf, pf, a, b) => { be16((smp.flags & lf ? 1 : 0) + (smp.flags & pf ? 1 : 0)); be16(a); be16(b); };
		loop(C.CHN_SUSTAINLOOP, C.CHN_PINGPONGSUSTAIN, 3, 4);
		loop(C.CHN_LOOP, C.CHN_PINGPONGLOOP, 1, 2);
	}
	{
		const nm = VERSION_STRING;
		fp.str('APPL', 4); be32(4 + nm.length + 1); fp.str('pdos', 4); fp.u8(nm.length); fp.str(nm, nm.length);
	}
	if (smp) { fp.str('APPL', 4); be32(4 + 24); fp.str('Schm', 4); write_xtra_chunk(fp, smp); }
	fp.str('COMM', 4); be32(18); be16(channels);
	const comm_frames = fp.tell();
	be32(length >>> 0); be16(bits); fp.write(float_encode_ieee_80(rate));
	const bpf = bps * channels;
	fp.str('SSND', 4);
	const ssnd_size = fp.tell();
	be32((length * bpf + 8) >>> 0); be32(0); be32(0);
	return { bpf, bps, comm_frames, ssnd_size };
}
export function fmt_aiff_save_sample(smp) {
	if (smp.flags & C.CHN_ADLIB) return null;
	const fp = new Disko();
	const ch = smp.flags & C.CHN_STEREO ? 2 : 1, bits = smp.flags & C.CHN_16BIT ? 16 : 8;
	aiff_header(fp, bits, ch, smp.c5speed, smp.name, smp.length, smp);
	if (smp.data) csf_write_sample(fp, smp, C.SF_BE | C.SF_PCMS | (bits === 16 ? C.SF_16 : C.SF_8) | (ch === 2 ? C.SF_SI : C.SF_M));
	const end = fp.tell(); fp.seek(4); fp.write([((end - 8) >>> 24) & 0xff, ((end - 8) >>> 16) & 0xff, ((end - 8) >>> 8) & 0xff, (end - 8) & 0xff]); fp.seek(end);
	return fp.bytes();
}
// au.c
export function fmt_au_save_sample(smp) {
	if (smp.flags & C.CHN_ADLIB) return null;
	const fp = new Disko();
	const be32 = v => fp.write([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
	let ln = smp.length;
	fp.str('.snd', 4); be32(49);
	if (smp.flags & C.CHN_16BIT) ln *= 2;
	if (smp.flags & C.CHN_STEREO) ln *= 2;
	be32(ln >>> 0); be32(smp.flags & C.CHN_16BIT ? 3 : 2); be32(smp.c5speed); be32(smp.flags & C.CHN_STEREO ? 2 : 1);
	fp.str(smp.name || '', 25);
	if (smp.data) csf_write_sample(fp, smp, C.SF_BE | C.SF_PCMS | (smp.flags & C.CHN_16BIT ? C.SF_16 : C.SF_8) | (smp.flags & C.CHN_STEREO ? C.SF_SI : C.SF_M));
	return fp.bytes();
}
// sbi.c
export function fmt_sbi_save_sample(smp) {
	if (!(smp.flags & C.CHN_ADLIB)) return null;
	const fp = new Disko();
	fp.write([0x53, 0x42, 0x49, 0x1a]);
	fp.str(smp.name || '', 32);
	fp.write(smp.adlib_bytes.slice(0, 11));
	fp.write([0, 0, 0, 0, 0]);
	return fp.bytes();
}
// s3i.c
export function fmt_s3i_save_sample(smp) {
	const fp = new Disko();
	s3i_write_header(fp, smp, 0);
	if (!(smp.flags & C.CHN_ADLIB) && smp.data)
		csf_write_sample(fp, smp, C.SF_M | C.SF_LE | (smp.flags & C.CHN_16BIT ? C.SF_16 | C.SF_PCMS : C.SF_8 | C.SF_PCMU));
	return fp.bytes();
}
export function fmt_raw_save_sample(smp) {
	const fp = new Disko();
	if (smp.data) csf_write_sample(fp, smp, C.SF_LE | C.SF_PCMS | (smp.flags & C.CHN_16BIT ? C.SF_16 : C.SF_8) | (smp.flags & C.CHN_STEREO ? C.SF_SI : C.SF_M));
	return fp.bytes();
}

// disko.c: disko_export_song. Renders the song once through with the
// diskwriter settings (all voices, no backward jumps), into one stream or one
// per channel (multi-write); returns [{ channel, pcm (Uint8Array, 16-bit LE) }].
export async function song_export_render(song, multi, rate = 44100, progress) {
	const work = csf_allocate();
	for (const k of Object.keys(song)) if (!['voices', 'voice_mix', 'mix_buffer'].includes(k)) work[k] = song[k];
	work.opl = null; work.opl_to_chan = null; work.opl_from_chan = null; // a fresh OPL chip, as GM_Reset/OPL setup do
	const channels = (work.flags & C.SONG_NOSTEREO) ? 1 : 2;
	csf_set_current_order(work, 0); /* rather indirect way of resetting playback variables */
	app.csf_set_wave_config(work, rate, 16, channels);
	work.midi_out_raw = null;
	work.mix_flags |= C.SNDMIX_DIRECTTODISK | C.SNDMIX_NOBACKWARDJUMPS;
	work.repeat_count = -1;
	work.buffer_count = 0;
	work.flags &= ~(C.SONG_PAUSED | C.SONG_PATTERNLOOP | C.SONG_ENDREACHED);
	work.stop_at_order = work.stop_at_row = -1;
	work.max_voices = 256;
	const outs = Array.from({ length: multi ? C.MAX_CHANNELS : 1 }, () => ({ chunks: [], len: 0 }));
	if (multi) work.multi_write = outs.map(o => ({ buffer: new Int32Array(work.mix_buffer.length), used: 0, data: o,
		write(d, bytes, n) { d.chunks.push(bytes.slice(0, n)); d.len += n; },
		silence(d, n) { d.chunks.push(new Uint8Array(n)); d.len += n; } }));
	const buf = new Uint8Array(4096 * 2 * channels);
	let total = 0, loops = 0;
	for (;;) {
		const n = app.csf_read(work, buf, buf.length);
		if (!multi) { outs[0].chunks.push(buf.slice(0, n * 2 * channels)); outs[0].len += n * 2 * channels; }
		total += n;
		if (!n || (work.flags & C.SONG_ENDREACHED)) break; // disko_sync
		if (total > rate * 60 * 60) break; // an hour is enough
		if (++loops % 64 === 0) { if (progress) progress(total / rate); await new Promise(r => setTimeout(r, 0)); }
	}
	const result = [];
	outs.forEach((o, n) => {
		if (multi && !work.multi_write[n].used) return;
		const pcm = new Uint8Array(o.len);
		let off = 0;
		for (const c of o.chunks) { pcm.set(c, off); off += c.length; }
		result.push({ channel: n + 1, pcm });
	});
	return { channels, rate, title: song.title || '', files: result };
}
// wav.c / aiff.c export_head + body + tail for 16-bit little-endian PCM
export function wav_export_bytes(pcm, channels, rate, title) {
	const fp = new Disko();
	const bpf = wav_header(fp, 16, channels, rate, 0);
	void bpf;
	fp.write(pcm);
	write_wav_list(fp, title);
	const end = fp.tell();
	fp.seek(4); fp.u32(end - 8);
	fp.seek(40); fp.u32(pcm.length);
	fp.seek(end);
	return fp.bytes();
}
export function aiff_export_bytes(pcm, channels, rate, title) {
	const fp = new Disko();
	const h = aiff_header(fp, 16, channels, rate, title, 0xffffffff, null);
	const swapped = new Uint8Array(pcm.length);
	for (let i = 0; i + 1 < pcm.length; i += 2) { swapped[i] = pcm[i + 1]; swapped[i + 1] = pcm[i]; }
	fp.write(swapped);
	const end = fp.tell();
	const be32 = v => fp.write([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
	fp.seek(4); be32(end - 8);
	fp.seek(h.comm_frames); be32(Math.trunc(pcm.length / h.bpf));
	fp.seek(h.ssnd_size); be32(pcm.length + 8);
	fp.seek(end);
	return fp.bytes();
}
// kept for callers that want a plain stereo WAV of the whole song
export async function song_export_wav(song, rate = 44100, progress) {
	const r = await song_export_render(song, false, rate, progress);
	return wav_export_bytes(r.files[0] ? r.files[0].pcm : new Uint8Array(0), r.channels, r.rate, r.title);
}


// fmt/s3m.c (save) + fmt/s3i.c header
const S3I_TYPE_NONE = 0, S3I_TYPE_PCM = 1, S3I_TYPE_ADMEL = 2, S3I_TYPE_CONTROL = 0xff;
const it_pan_to_s3m = p => Math.min(Math.trunc(Math.max(p, 2) / 4), 15);
function s3i_write_header(fp, smp, sdata) {
	let type = S3I_TYPE_NONE;
	const start = fp.tell();
	if (smp.flags & C.CHN_ADLIB) type = S3I_TYPE_ADMEL;
	else if (smp.data) type = S3I_TYPE_PCM;
	fp.u8(type);
	fp.str(smp.filename || '', 12);
	if (type === S3I_TYPE_ADMEL) { fp.write([0, 0, 0]); fp.write(smp.adlib_bytes.slice(0, 11)); fp.u8(0); }
	else if (type === S3I_TYPE_PCM) {
		fp.write([(sdata >> 20) & 0xff, (sdata >> 4) & 0xff, (sdata >> 12) & 0xff]);
		fp.u32(smp.length); fp.u32(smp.loop_start); fp.u32(smp.loop_end);
	} else fp.write(new Uint8Array(15));
	fp.u8(smp.volume >> 2); fp.u8(0); fp.u8(0);
	fp.u8(type === S3I_TYPE_PCM ? ((smp.flags & C.CHN_LOOP ? 1 : 0) | (smp.flags & C.CHN_STEREO ? 2 : 0) | (smp.flags & C.CHN_16BIT ? 4 : 0)) : 0);
	fp.u32(smp.c5speed);
	fp.write(new Uint8Array(12));
	fp.str((smp.name || '').replace(/\s+$/, ''), 28);
	fp.str(type === S3I_TYPE_ADMEL ? 'SCRI' : type === S3I_TYPE_PCM ? 'SCRS' : '', 4);
	fp.seek(start + 0x50);
}
function write_s3m_pattern(fp, song, pat, chantypes, para_pat) {
	if (csf_pattern_is_empty(song, pat)) { para_pat[pat] = 0; return; }
	const rows = Math.min(64, song.pattern_size[pat]);
	fp.seek((fp.tell() + 15) & ~15);
	const start = fp.tell();
	para_pat[pat] = start >> 4;
	fp.u16(0);
	const p = song.patterns[pat];
	let row;
	for (row = 0; row < rows; row++) {
		for (let chan = 0; chan < 32; chan++) {
			const out = { ...p[row * 64 + chan] };
			let b = 0;
			if (song.channels[chan].flags & C.CHN_MUTE) {
				if (out.instrument || out.effect) continue;
			} else if ((song.flags & C.SONG_INSTRUMENTMODE) && out.instrument && out.note > 0 && out.note <= 120) {
				const ins = song.instruments[out.instrument];
				if (ins) { out.instrument = ins.sample_map[out.note - 1]; out.note = ins.note_map[out.note - 1]; }
			}
			if ((out.note > 0 && out.note <= 12) || (out.note >= 109 && out.note <= 120)) out.note = 255;
			else if (out.note > 12 && out.note < 109) { out.note -= 13; out.note = (out.note % 12) + (Math.trunc(out.note / 12) << 4); b |= 32; }
			else if (out.note === C.NOTE_CUT || out.note === C.NOTE_OFF) { out.note = 254; b |= 32; }
			else out.note = 255;
			if (out.instrument) {
				const smp = song.samples[out.instrument];
				const type = smp.flags & C.CHN_ADLIB ? S3I_TYPE_ADMEL : smp.data ? S3I_TYPE_PCM : S3I_TYPE_NONE;
				if (type !== S3I_TYPE_NONE && (chantypes[chan] === S3I_TYPE_NONE || chantypes[chan] === S3I_TYPE_CONTROL)) chantypes[chan] = type;
				b |= 32;
			}
			if (out.voleffect === C.VOLFX_VOLUME) b |= 64;
			csf_export_s3m_effect(out, 0);
			if (out.effect || out.param) b |= 128;
			if (chantypes[chan] === S3I_TYPE_NONE && out.effect) chantypes[chan] = S3I_TYPE_CONTROL;
			if (!b) continue;
			fp.u8(b | chan);
			if (b & 32) { fp.u8(out.note); fp.u8(out.instrument); }
			if (b & 64) fp.u8(out.volparam);
			if (b & 128) { fp.u8(out.effect); fp.u8(out.param); }
		}
		fp.u8(0);
	}
	for (; row < 64; row++) fp.u8(0);
	const end = fp.tell();
	fp.seek(start); fp.u16(end - start); fp.seek(end);
}
function fixup_chantypes(channels, chantypes) {
	let npcm = 0, nadmel = 0, pcm = 0, admel = 0x10, junk = 0x20;
	for (let n = 0; n < 32; n++) { if (chantypes[n] === S3I_TYPE_PCM) npcm++; else if (chantypes[n] === S3I_TYPE_ADMEL) nadmel++; }
	npcm = Math.min(npcm, 16); nadmel = Math.min(nadmel, 9);
	for (let n = 0; n < 32; n++) {
		switch (chantypes[n]) {
		case S3I_TYPE_PCM: chantypes[n] = pcm <= 0x0f ? pcm++ : junk++; break;
		case S3I_TYPE_ADMEL: chantypes[n] = admel <= 0x18 ? admel++ : junk++; break;
		case S3I_TYPE_NONE:
			if (channels[n].flags & C.CHN_MUTE) { chantypes[n] = 255; break; }
			// fallthrough
		default:
			if (npcm < 16) { chantypes[n] = ((pcm << 3) | (pcm >> 1)) & 0xf; pcm++; npcm++; }
			else if (nadmel < 9) { chantypes[n] = admel++; nadmel++; }
			else if (chantypes[n] === S3I_TYPE_NONE) chantypes[n] = 255;
			else chantypes[n] = junk++;
		}
		if (junk > 0x2f) junk = 0x19;
	}
}
export function fmt_s3m_save_song(song) {
	const fp = new Disko();
	let nord = csf_get_num_orders(song) + 1;
	if (nord & 1) nord++;
	nord = Math.max(2, Math.min(nord, C.MAX_ORDERS));
	const nsmp = Math.min(csf_get_num_samples(song) || 1, 99);
	const npat = Math.min(csf_get_num_patterns(song) || 1, 100);
	const chantypes = new Uint8Array(32);
	fp.str((song.title || '').slice(0, 25), 28);
	fp.u8(0x1a); fp.u8(16); fp.u16(0);
	fp.u16(nord); fp.u16(nsmp); fp.u16(npat);
	fp.u16(0); fp.u16(0x4000 | 0x050); fp.u16(2);
	fp.str('SCRM', 4);
	fp.u8(song.initial_global_volume >> 1); fp.u8(song.initial_speed); fp.u8(song.initial_tempo);
	fp.u8(Math.min(Math.max(0x10, song.mixing_volume), 0x7f) | (song.flags & C.SONG_NOSTEREO ? 0 : 128));
	fp.u8(16); fp.u8(252);
	fp.write(new Uint8Array(10));
	fp.seek(0x60);
	const ol = new Uint8Array(nord); ol.set(song.orderlist.subarray(0, nord)); fp.write(ol);
	const smphead_pos = (0x60 + nord + 2 * (nsmp + npat) + 32 + 15) & ~15;
	for (let n = 0, pos = smphead_pos; n < nsmp; n++, pos += 0x50) fp.u16(pos >> 4);
	const patptr_pos = fp.tell();
	fp.seek(patptr_pos + 2 * npat + 32);
	fp.seek(smphead_pos + 0x50 * nsmp);
	fp.write([]);
	const para_pat = new Uint16Array(npat);
	for (let n = 0; n < npat; n++) write_s3m_pattern(fp, song, n, chantypes, para_pat);
	const para_sdata = new Uint32Array(nsmp);
	for (let n = 0; n < nsmp; n++) {
		const smp = song.samples[n + 1];
		if ((smp.flags & C.CHN_ADLIB) || !smp.data) continue;
		fp.seek((fp.tell() + 15) & ~15);
		para_sdata[n] = fp.tell();
		csf_write_sample(fp, smp, C.SF_LE | C.SF_PCMU | (smp.flags & C.CHN_16BIT ? C.SF_16 : C.SF_8) | (smp.flags & C.CHN_STEREO ? C.SF_SS : C.SF_M));
	}
	fixup_chantypes(song.channels, chantypes);
	fp.seek(0x40); fp.write(chantypes);
	fp.seek(patptr_pos);
	for (const p of para_pat) fp.u16(p);
	for (let n = 0; n < 32; n++) fp.u8((chantypes[n] & 0x7f) < 0x20 ? 0x20 | it_pan_to_s3m(song.channels[n].panning >> 2) : 0);
	fp.seek(smphead_pos);
	for (let n = 0; n < nsmp; n++) s3i_write_header(fp, song.samples[n + 1], para_sdata[n]);
	return fp.bytes();
}

// fmt/mod.c (save)
const amigaperiod_table = new Uint16Array(256);
[1712, 1616, 1524, 1440, 1356, 1280, 1208, 1140, 1076, 1016, 960, 906, 856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
	428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226, 214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113,
	107, 101, 95, 90, 85, 80, 75, 71, 67, 63, 60, 56].forEach((v, i) => { amigaperiod_table[37 + i] = v; });
export function fmt_mod_save_song(song) {
	const fp = new Disko();
	const nsmp = Math.min(csf_get_num_samples(song), 31);
	const nchn = app.csf_get_highest_used_channel(song) + 1;
	fp.str(song.title || '', 20);
	for (let n = 1; n <= 31; n++) {
		const s = song.samples[n];
		if (n > nsmp) { fp.write(new Uint8Array(30)); continue; }
		fp.str(s.name || '', 22);
		const w16be = v => fp.write([(v >> 8) & 0xff, v & 0xff]);
		w16be(Math.min(s.length >> 1, 0xffff));
		let j;
		for (j = 15; j && finetune_table[j] > s.c5speed; --j) if (s.c5speed > 10000 && j === 8) break;
		fp.u8((j ^ 8) & 0x0f);
		fp.u8((s.volume + 1) >> 2);
		if (s.flags & C.CHN_LOOP) { w16be(Math.min(s.loop_start >> 1, 0xffff)); w16be(Math.min((s.loop_end - s.loop_start) >> 1, 0xffff)); }
		else fp.write([0, 0, 0, 1]);
	}
	const nord = csf_get_num_orders(song);
	fp.u8(nord); fp.u8(0x7f);
	const mod_orders = new Uint8Array(128);
	let maxpat = 0;
	for (let i = 0; i < nord && i < 128; i++) { mod_orders[i] = song.orderlist[i]; maxpat = Math.max(maxpat, mod_orders[i]); }
	fp.write(mod_orders);
	if (nchn === 4) fp.str(maxpat < 64 ? 'M.K.' : 'M!K!', 4);
	else if (nchn >= 10) fp.str(`${Math.trunc(nchn / 10)}${nchn % 10}CN`, 4);
	else fp.str(`${nchn}CHN`, 4);
	for (let n = 0; n <= maxpat; n++) {
		const out = new Uint8Array(nchn * 4 * 64);
		const pat = song.patterns[n];
		const jmax = Math.min(song.pattern_size[n] || 64, 64) * 64;
		for (let j = 0, o = 0; j < jmax && pat; j++) {
			if (j % 64 >= nchn) continue;
			const m = pat[j];
			const period = amigaperiod_table[m.note & 0xff];
			out[o] = (m.instrument & 0x10) | (period >> 8);
			out[o + 1] = period & 0xff;
			out[o + 2] = (m.instrument & 0xf) << 4;
			let fx = 0, val = m.param;
			if (m.voleffect === C.VOLFX_VOLUME) { fx = 0x0c; val = m.volparam; }
			else if (m.voleffect === C.VOLFX_NONE) {
				switch (m.effect) {
				case C.FX_NONE: val = 0; break;
				case C.FX_ARPEGGIO: fx = 0; break;
				case C.FX_PORTAMENTOUP: case C.FX_PORTAMENTODOWN: {
					const up = m.effect === C.FX_PORTAMENTOUP;
					fx = up ? 1 : 2;
					if ((val & 0xf0) === 0xe0) { fx = 0x0e; val = (up ? 0x10 : 0x20) | ((val & 0xf) >> 2); }
					else if ((val & 0xf0) === 0xf0) { fx = 0x0e; val = (up ? 0x10 : 0x20) | (val & 0xf); }
					break;
				}
				case C.FX_TONEPORTAMENTO: fx = 3; break;
				case C.FX_VIBRATO: fx = 4; break;
				case C.FX_TONEPORTAVOL: fx = 5; break;
				case C.FX_VIBRATOVOL: fx = 6; break;
				case C.FX_TREMOLO: fx = 7; break;
				case C.FX_PANNING: fx = 8; break;
				case C.FX_OFFSET: fx = 9; break;
				case C.FX_VOLUMESLIDE:
					fx = 0x0a;
					if ((val & 0xf0) && (val & 0x0f)) {
						if ((val & 0xf0) === 0xf0) { fx = 0x0e; val &= 0xbf; }
						else if ((val & 0x0f) === 0x0f) { fx = 0x0e; val = 0xa0 | (val >> 4); }
					}
					break;
				case C.FX_POSITIONJUMP: fx = 0x0b; break;
				case C.FX_VOLUME: fx = 0x0c; break;
				case C.FX_PATTERNBREAK: fx = 0x0d; val = (Math.trunc(val / 10) << 4) | (val % 10); break;
				case C.FX_SPEED: case C.FX_TEMPO: fx = 0x0f; break;
				case C.FX_SPECIAL:
					fx = 0x0e;
					switch (val & 0xf0) {
					case 0x10: val = (val & 0x0f) | 0x30; break;
					case 0x20: val = (val & 0x0f) | 0x50; break;
					case 0x30: val = (val & 0x0f) | 0x40; break;
					case 0x40: val = (val & 0x0f) | 0x70; break;
					case 0xb0: val = (val & 0x0f) | 0x60; break;
					}
					break;
				case C.FX_RETRIG: fx = 0x0e; val = 0x90 | (val & 0x0f); break;
				}
			}
			out[o + 2] |= fx & 0x0f;
			out[o + 3] = val & 0xff;
			o += 4;
		}
		fp.write(out);
	}
	for (let n = 0; n < nsmp; n++) {
		const smp = song.samples[n + 1];
		if (!smp.data || smp.length < 1) continue;
		const len = Math.min(smp.length, 0x1fffe) & ~1;
		const ch = smp.flags & C.CHN_STEREO ? 2 : 1, sh = smp.flags & C.CHN_16BIT ? 8 : 0;
		const out = new Uint8Array(len);
		for (let i = 0; i < len; i++) out[i] = (smp.data[i * ch] >> sh) & 0xff;
		if (!((smp.flags & C.CHN_LOOP) && smp.loop_start < smp.loop_end)) { out[0] = 0; if (len > 1) out[1] = 0; }
		fp.write(out);
	}
	return fp.bytes();
}

export const song_save_formats = [
	{ label: 'IT', ext: 'it', save: fmt_it_save_song },
	{ label: 'S3M', ext: 's3m', save: fmt_s3m_save_song },
	{ label: 'MOD', ext: 'mod', save: fmt_mod_save_song },
];
// audio_loadsave.c: song_export_formats (FLAC left out: no encoder in the browser)
export const song_export_formats = [
	{ label: 'WAV', name: 'WAV', ext: '.wav', multi: 0, write: wav_export_bytes },
	{ label: 'MWAV', name: 'WAV multi-write', ext: '.wav', multi: 1, write: wav_export_bytes },
	{ label: 'AIFF', name: 'Audio IFF', ext: '.aiff', multi: 0, write: aiff_export_bytes },
	{ label: 'MAIFF', name: 'Audio IFF multi-write', ext: '.aiff', multi: 1, write: aiff_export_bytes },
];
// audio_loadsave.c: sample_save_formats (FLAC is left out: no encoder in the browser)
export const sample_save_formats = [
	{ label: 'ITS', name: 'Impulse Tracker', ext: '.its', save: fmt_its_save_sample },
	{ label: 'S3I', name: 'Scream Tracker', ext: '.s3i', save: fmt_s3i_save_sample },
	{ label: 'SBI', name: 'Sound Blaster', ext: '.sbi', save: fmt_sbi_save_sample },
	{ label: 'AIFF', name: 'Audio IFF', ext: '.aiff', save: fmt_aiff_save_sample },
	{ label: 'AU', name: 'Sun/NeXT', ext: '.au', save: fmt_au_save_sample },
	{ label: 'WAV', name: 'WAV', ext: '.wav', save: fmt_wav_save_sample },
	{ label: 'RAW', name: 'Raw', ext: '.raw', save: fmt_raw_save_sample },
];

provide({ fmt_s3m_save_song, fmt_mod_save_song, fmt_it_save_song, fmt_its_save_sample, fmt_iti_save_instrument, fmt_wav_save_sample, fmt_raw_save_sample, song_export_wav });
