// AdLib (OPL) instrument playback: port of player/snd_fm.c (Schism Tracker,
// GPL-2.0-or-later), driving the OPL3 emulator in fmopl3.js as the native
// build does (OPLSOURCE == 3).
import { provide } from './app.js';
import { ymf262_init, ymf262_reset_chip, ymf262_write, ymf262_update_multi, OPL_VOLUME } from './fmopl3.js';

const OPLRATEBASE = 49716, OPLRATEDIVISOR = 288;
const OPL_CHANNELS = 18, OPL_BANK_SIZE = 9, MAX_VOICES = 256;
const OPL_BASE = 0x388;
const CHN_MUTE = 0x100;
const TEST_REGISTER = 0x01, ENABLE_WAVE_SELECT = 0x20, TIMER1_REGISTER = 0x02, TIMER_CONTROL_REGISTER = 0x04;
const IRQ_RESET = 0x80, TIMER1_MASK = 0x40, TIMER2_MASK = 0x20, TIMER1_START = 0x01;
const OPL3_MODE_REGISTER = 0x05, OPL3_ENABLE = 0x01;
const AM_VIB = 0x20, KSL_LEVEL = 0x40, KSL_MASK = 0xc0, TOTAL_LEVEL_MASK = 0x3f, ATTACK_DECAY = 0x60;
const SUSTAIN_RELEASE = 0x80, WAVE_SELECT = 0xe0, FNUM_LOW = 0xa0, KEYON_BLOCK = 0xb0, KEYON_BIT = 0x20;
const FNUM_HIGH_MASK = 0x03, FEEDBACK_CONNECTION = 0xc0, CONNECTION_BIT = 0x01, STEREO_BITS = 0x30;
const VOICE_TO_LEFT = 0x10, VOICE_TO_RIGHT = 0x20;
const PortBases = [0, 1, 2, 8, 9, 10, 16, 17, 18];

function milliHertzToFnum(milliHertz, conversionFactor) {
	if (milliHertz <= 0) return [0, 0];
	if (milliHertz > 6208431) return [1023, 7];
	let block;
	if (milliHertz > 3104215) block = 7;
	else if (milliHertz > 1552107) block = 6;
	else if (milliHertz > 776053) block = 5;
	else if (milliHertz > 388026) block = 4;
	else if (milliHertz > 194013) block = 3;
	else if (milliHertz > 97006) block = 2;
	else if (milliHertz > 48503) block = 1;
	else block = 0;
	const f = b => Math.trunc(Number(BigInt(milliHertz) << BigInt(20 - b)) / (conversionFactor * 1000.0) + 0.5) >>> 0;
	let fnum = f(block);
	if (fnum > 1023) { block++; fnum = f(block); }
	return [fnum, block];
}

function ensure_state(csf) {
	if (csf.opl_to_chan) return;
	csf.opl = null; csf.oplretval = 0; csf.oplregno = 0; csf.opl_fm_active = 0;
	csf.opl_dtab = new Array(OPL_CHANNELS).fill(null);
	csf.opl_keyontab = new Uint8Array(OPL_CHANNELS);
	csf.opl_pans = new Int32Array(MAX_VOICES);
	csf.opl_to_chan = new Int32Array(OPL_CHANNELS).fill(-1);
	csf.opl_from_chan = new Int32Array(MAX_VOICES).fill(-1);
}

function Fmdrv_Outportb(csf, port, value) {
	if (!csf.opl || port < OPL_BASE || port >= OPL_BASE + 4) return;
	const ind = port - OPL_BASE;
	ymf262_write(csf.opl, ind, value);
	if (ind & 1) {
		if (csf.oplregno === 4) {
			if (value === 0x80) csf.oplretval = 0x02;
			else if (value === 0x21) csf.oplretval = 0xc0;
		}
	} else csf.oplregno = value;
}
const Fmdrv_Inportb = (csf, port) => port >= OPL_BASE && port < OPL_BASE + 4 ? csf.oplretval : 0;

export function Fmdrv_Init(csf, mixfreq) {
	ensure_state(csf);
	csf.opl = ymf262_init(OPLRATEBASE * OPLRATEDIVISOR, mixfreq);
	OPL_Reset(csf);
}

const vu_max = new Uint32Array(OPL_CHANNELS);
const buffers = new Array(OPL_CHANNELS);
export function Fmdrv_Mix(csf, count) {
	if (!csf.opl_fm_active) return;
	for (let i = 0; i < OPL_CHANNELS; i++) {
		const v = csf.opl_to_chan[i];
		vu_max[i] = 0;
		if (v < 0 || v >= MAX_VOICES) { buffers[i] = null; continue; }
		vu_max[i] = Math.trunc(((csf.voices[v].vu_meter << 16) >>> 0) / OPL_VOLUME);
		buffers[i] = csf.multi_write ? csf.multi_write[v].buffer : (csf.voices[v].flags & CHN_MUTE) ? null : csf.mix_buffer;
	}
	ymf262_update_multi(csf.opl, buffers, count, vu_max);
	for (let i = 0; i < OPL_CHANNELS; i++) {
		const v = csf.opl_to_chan[i];
		if (v < 0 || v >= MAX_VOICES) continue;
		csf.voices[v].vu_meter = Math.trunc(vu_max[i] * OPL_VOLUME / 65536) >>> 0;
	}
}

const GetVoice = (csf, c) => csf.opl_from_chan[c];
function SetVoice(csf, c) {
	if (csf.opl_from_chan[c] === -1) {
		for (let a = 0; a < OPL_CHANNELS; a++) {
			if (csf.opl_to_chan[a] === -1) { csf.opl_to_chan[a] = c; csf.opl_from_chan[c] = a; break; }
		}
		if (csf.opl_from_chan[c] === -1) {
			for (let a = 0; a < OPL_CHANNELS; a++) {
				if ((csf.opl_keyontab[a] & KEYON_BIT) === 0) {
					csf.opl_from_chan[csf.opl_to_chan[a]] = -1;
					csf.opl_to_chan[a] = c;
					csf.opl_from_chan[c] = a;
					break;
				}
			}
		}
	}
	return GetVoice(csf, c);
}
function OPL_Byte(csf, idx, data) { Fmdrv_Outportb(csf, OPL_BASE, idx); Fmdrv_Outportb(csf, OPL_BASE + 1, data & 0xff); }
function OPL_Byte_RightSide(csf, idx, data) { Fmdrv_Outportb(csf, OPL_BASE + 2, idx); Fmdrv_Outportb(csf, OPL_BASE + 3, data & 0xff); }
const side = oplc => oplc < OPL_BANK_SIZE ? OPL_Byte : OPL_Byte_RightSide;

export function OPL_NoteOff(csf, c) {
	if (!csf.opl_from_chan) return;
	const oplc = GetVoice(csf, c);
	if (oplc === -1) return;
	csf.opl_keyontab[oplc] &= ~KEYON_BIT;
	if (oplc < OPL_BANK_SIZE) OPL_Byte(csf, KEYON_BLOCK + oplc, csf.opl_keyontab[oplc]);
	else OPL_Byte_RightSide(csf, KEYON_BLOCK + oplc - OPL_BANK_SIZE, csf.opl_keyontab[oplc]);
}

export function OPL_HertzTouch(csf, c, milliHertz, keyoff) {
	if (!csf.opl_from_chan) return;
	const oplc = GetVoice(csf, c);
	if (oplc === -1) return;
	csf.opl_fm_active = 1;
	const [outfnum, outblock] = milliHertzToFnum(milliHertz >>> 0, OPLRATEBASE);
	csf.opl_keyontab[oplc] = (keyoff ? 0 : KEYON_BIT) | (outblock << 2) | ((outfnum >> 8) & FNUM_HIGH_MASK);
	if (oplc < OPL_BANK_SIZE) {
		OPL_Byte(csf, FNUM_LOW + oplc, outfnum & 0xff);
		OPL_Byte(csf, KEYON_BLOCK + oplc, csf.opl_keyontab[oplc]);
	} else {
		OPL_Byte_RightSide(csf, FNUM_LOW + oplc - OPL_BANK_SIZE, outfnum & 0xff);
		OPL_Byte_RightSide(csf, KEYON_BLOCK + oplc - OPL_BANK_SIZE, csf.opl_keyontab[oplc]);
	}
}

export function OPL_Touch(csf, c, vol) {
	if (!csf.opl_from_chan) return;
	const oplc = GetVoice(csf, c);
	if (oplc === -1) return;
	const D = csf.opl_dtab[oplc];
	if (!D) return;
	const Ope = PortBases[oplc % OPL_BANK_SIZE], send = side(oplc);
	vol >>>= 0;
	if (D[10] & CONNECTION_BIT)
		send(csf, KSL_LEVEL + Ope, (D[2] & KSL_MASK) | (63 + Math.trunc((D[2] & TOTAL_LEVEL_MASK) * vol / 63) - vol));
	send(csf, KSL_LEVEL + 3 + Ope, (D[3] & KSL_MASK) | (63 + Math.trunc((D[3] & TOTAL_LEVEL_MASK) * vol / 63) - vol));
}

const pan_bits = (csf, c) => csf.opl_pans[c] < 85 ? VOICE_TO_LEFT : csf.opl_pans[c] > 170 ? VOICE_TO_RIGHT : (VOICE_TO_LEFT | VOICE_TO_RIGHT);
export function OPL_Pan(csf, c, val) {
	if (!csf.opl_from_chan) return;
	csf.opl_pans[c] = Math.max(0, Math.min(256, val));
	const oplc = GetVoice(csf, c);
	if (oplc === -1) return;
	const D = csf.opl_dtab[oplc];
	if (!D) return;
	side(oplc)(csf, FEEDBACK_CONNECTION + (oplc % OPL_BANK_SIZE), (D[10] & ~STEREO_BITS) | pan_bits(csf, c));
}

export function OPL_Patch(csf, c, D) {
	if (!csf.opl_from_chan) return;
	const oplc = SetVoice(csf, c);
	if (oplc === -1) return;
	csf.opl_dtab[oplc] = D;
	const Ope = PortBases[oplc % OPL_BANK_SIZE], send = side(oplc);
	send(csf, AM_VIB + Ope, D[0]);
	send(csf, KSL_LEVEL + Ope, D[2]);
	send(csf, ATTACK_DECAY + Ope, D[4]);
	send(csf, SUSTAIN_RELEASE + Ope, D[6]);
	send(csf, WAVE_SELECT + Ope, D[8] & 7);
	send(csf, AM_VIB + 3 + Ope, D[1]);
	send(csf, KSL_LEVEL + 3 + Ope, D[3]);
	send(csf, ATTACK_DECAY + 3 + Ope, D[5]);
	send(csf, SUSTAIN_RELEASE + 3 + Ope, D[7]);
	send(csf, WAVE_SELECT + 3 + Ope, D[9] & 7);
	// (sic) snd_fm.c writes FEEDBACK_CONNECTION + oplc here, not oplc % OPL_BANK_SIZE
	send(csf, FEEDBACK_CONNECTION + oplc, (D[10] & ~STEREO_BITS) | pan_bits(csf, c));
}

export function OPL_Reset(csf) {
	ensure_state(csf);
	if (!csf.opl) return;
	ymf262_reset_chip(csf.opl);
	OPL_Detect(csf);
	csf.opl_from_chan.fill(-1);
	csf.opl_to_chan.fill(-1);
	csf.opl_dtab.fill(null);
	OPL_Byte(csf, TEST_REGISTER, ENABLE_WAVE_SELECT);
	OPL_Byte_RightSide(csf, OPL3_MODE_REGISTER, OPL3_ENABLE);
	csf.opl_fm_active = 0;
}

export function OPL_Detect(csf) {
	OPL_Byte(csf, TIMER_CONTROL_REGISTER, TIMER1_MASK | TIMER2_MASK);
	OPL_Byte_RightSide(csf, TIMER_CONTROL_REGISTER, TIMER1_MASK | TIMER2_MASK);
	OPL_Byte(csf, TIMER_CONTROL_REGISTER, IRQ_RESET);
	OPL_Byte_RightSide(csf, TIMER_CONTROL_REGISTER, IRQ_RESET);
	const ST1 = Fmdrv_Inportb(csf, OPL_BASE);
	OPL_Byte(csf, TIMER1_REGISTER, 255);
	OPL_Byte(csf, TIMER_CONTROL_REGISTER, TIMER2_MASK | TIMER1_START);
	OPL_Byte_RightSide(csf, TIMER1_REGISTER, 255);
	OPL_Byte_RightSide(csf, TIMER_CONTROL_REGISTER, TIMER2_MASK | TIMER1_START);
	const ST2 = Fmdrv_Inportb(csf, OPL_BASE);
	OPL_Byte(csf, TIMER_CONTROL_REGISTER, TIMER1_MASK | TIMER2_MASK);
	OPL_Byte(csf, TIMER_CONTROL_REGISTER, IRQ_RESET);
	OPL_Byte_RightSide(csf, TIMER_CONTROL_REGISTER, TIMER1_MASK | TIMER2_MASK);
	OPL_Byte_RightSide(csf, TIMER_CONTROL_REGISTER, IRQ_RESET);
	return (ST2 & 0xe0) === 0xc0 && !(ST1 & 0xe0) ? 0 : -1;
}

export function OPL_Close(csf) { csf.opl = null; }

provide({ Fmdrv_Init, Fmdrv_Mix, OPL_NoteOff, OPL_HertzTouch, OPL_Touch, OPL_Pan, OPL_Patch, OPL_Reset, OPL_Detect, OPL_Close });
