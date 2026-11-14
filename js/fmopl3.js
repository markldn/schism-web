// YMF262 (OPL3) emulator: port of player/fmopl3.c (MAME ymf262.c by Jarek
// Burczynski, as carried in Schism Tracker, GPL-2.0-or-later). Timers and IRQ
// callbacks are left out (Schism never installs handlers); everything that
// affects the output is kept bit for bit.
//
// Slot "connect" pointers become indexes into chip.out: 0..17 are the channel
// outputs, 18 is phase_modulation and 19 is phase_modulation2.

const FREQ_SH = 16, EG_SH = 16, LFO_SH = 24;
const FREQ_MASK = (1 << FREQ_SH) - 1;
const ENV_BITS = 10, ENV_LEN = 1 << ENV_BITS, ENV_STEP = 128.0 / ENV_LEN;
const MAX_ATT_INDEX = (1 << (ENV_BITS - 1)) - 1, MIN_ATT_INDEX = 0;
const SIN_BITS = 10, SIN_LEN = 1 << SIN_BITS, SIN_MASK = SIN_LEN - 1;
const TL_RES_LEN = 256;
const EG_ATT = 4, EG_DEC = 3, EG_SUS = 2, EG_REL = 1, EG_OFF = 0;
const PM = 18, PM2 = 19;
export const OPL_VOLUME = 2274;

const slot_array = [0, 2, 4, 1, 3, 5, -1, -1, 6, 8, 10, 7, 9, 11, -1, -1,
	12, 14, 16, 13, 15, 17, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1];

const DV = 0.1875 / 2.0;
const ksl_tab = [
	0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000,
	0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.000, 0.750, 1.125, 1.500, 1.875, 2.250, 2.625, 3.000,
	0.000, 0.000, 0.000, 0.000, 0.000, 1.125, 1.875, 2.625, 3.000, 3.750, 4.125, 4.500, 4.875, 5.250, 5.625, 6.000,
	0.000, 0.000, 0.000, 1.875, 3.000, 4.125, 4.875, 5.625, 6.000, 6.750, 7.125, 7.500, 7.875, 8.250, 8.625, 9.000,
	0.000, 0.000, 3.000, 4.875, 6.000, 7.125, 7.875, 8.625, 9.000, 9.750, 10.125, 10.500, 10.875, 11.250, 11.625, 12.000,
	0.000, 3.000, 6.000, 7.875, 9.000, 10.125, 10.875, 11.625, 12.000, 12.750, 13.125, 13.500, 13.875, 14.250, 14.625, 15.000,
	0.000, 6.000, 9.000, 10.875, 12.000, 13.125, 13.875, 14.625, 15.000, 15.750, 16.125, 16.500, 16.875, 17.250, 17.625, 18.000,
	0.000, 9.000, 12.000, 13.875, 15.000, 16.125, 16.875, 17.625, 18.000, 18.750, 19.125, 19.500, 19.875, 20.250, 20.625, 21.000,
].map(v => v / DV);
const ksl_shift = [31, 1, 2, 0];
const sl_tab = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 31].map(db => Math.trunc(db * (2.0 / ENV_STEP)));

const RATE_STEPS = 8;
const eg_inc = Uint8Array.from([
	0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 2, 2, 1, 2, 2, 2,
	2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 2, 2, 2, 4, 2, 4, 2, 4, 2, 4, 2, 4, 2, 4, 4, 4, 2, 4, 4, 4,
	4, 4, 4, 4, 4, 4, 4, 4, 8, 8, 8, 8, 8, 8, 8, 8, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const eg_rate_select = new Uint8Array(96), eg_rate_shift = new Uint8Array(96);
{
	let n = 0;
	for (let i = 0; i < 16; i++) eg_rate_select[n++] = 14 * RATE_STEPS;
	for (let r = 0; r < 13; r++) for (let i = 0; i < 4; i++) eg_rate_select[n++] = i * RATE_STEPS;
	for (let i = 4; i < 8; i++) eg_rate_select[n++] = i * RATE_STEPS;
	for (let i = 8; i < 12; i++) eg_rate_select[n++] = i * RATE_STEPS;
	for (let i = 0; i < 20; i++) eg_rate_select[n++] = 12 * RATE_STEPS;
	n = 16;
	for (let r = 12; r >= 0; r--) for (let i = 0; i < 4; i++) eg_rate_shift[n++] = r;
}
const mul_tab = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30];

const TL_TAB_LEN = 13 * 2 * TL_RES_LEN;
const ENV_QUIET = TL_TAB_LEN >> 4;
const tl_tab = new Int32Array(TL_TAB_LEN);
const sin_tab = new Uint32Array(SIN_LEN * 8);

const lfo_am_table = (() => {
	const t = [0, 0, 0, 0, 0, 0, 0];
	for (let v = 1; v <= 25; v++) t.push(v, v, v, v);
	t.push(26, 26, 26);
	for (let v = 25; v >= 1; v--) t.push(v, v, v, v);
	return Uint8Array.from(t);
})();
const LFO_AM_TAB_ELEMENTS = 210;
const lfo_pm_table = Int8Array.from([
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 0,
	1, 0, 0, 0, -1, 0, 0, 0, 2, 1, 0, -1, -2, -1, 0, 1,
	1, 0, 0, 0, -1, 0, 0, 0, 3, 1, 0, -1, -3, -1, 0, 1,
	2, 1, 0, -1, -2, -1, 0, 1, 4, 2, 0, -2, -4, -2, 0, 2,
	2, 1, 0, -1, -2, -1, 0, 1, 5, 2, 0, -2, -5, -2, 0, 2,
	3, 1, 0, -1, -3, -1, 0, 1, 6, 3, 0, -3, -6, -3, 0, 3,
	3, 1, 0, -1, -3, -1, 0, 1, 7, 3, 0, -3, -7, -3, 0, 3,
]);

(function init_tables() {
	for (let x = 0; x < TL_RES_LEN; x++) {
		let m = (1 << 16) / Math.pow(2.0, (x + 1) * (ENV_STEP / 4.0) / 8.0);
		m = Math.floor(m);
		let n = m | 0;
		n >>= 4;
		n = (n & 1) ? (n >> 1) + 1 : n >> 1;
		n <<= 1;
		tl_tab[x * 2] = n;
		tl_tab[x * 2 + 1] = ~tl_tab[x * 2];
		for (let i = 1; i < 13; i++) {
			tl_tab[x * 2 + i * 2 * TL_RES_LEN] = tl_tab[x * 2] >> i;
			tl_tab[x * 2 + 1 + i * 2 * TL_RES_LEN] = ~tl_tab[x * 2 + i * 2 * TL_RES_LEN];
		}
	}
	for (let i = 0; i < SIN_LEN; i++) {
		const m = Math.sin(((i * 2) + 1) * Math.PI / SIN_LEN);
		let o = m > 0.0 ? 8 * Math.log(1.0 / m) / Math.log(2.0) : 8 * Math.log(-1.0 / m) / Math.log(2.0);
		o = o / (ENV_STEP / 4);
		let n = Math.trunc(2.0 * o);
		n = (n & 1) ? (n >> 1) + 1 : n >> 1;
		sin_tab[i] = n * 2 + (m >= 0.0 ? 0 : 1);
	}
	for (let i = 0; i < SIN_LEN; i++) {
		sin_tab[SIN_LEN + i] = (i & (1 << (SIN_BITS - 1))) ? TL_TAB_LEN : sin_tab[i];
		sin_tab[2 * SIN_LEN + i] = sin_tab[i & (SIN_MASK >> 1)];
		sin_tab[3 * SIN_LEN + i] = (i & (1 << (SIN_BITS - 2))) ? TL_TAB_LEN : sin_tab[i & (SIN_MASK >> 2)];
		sin_tab[4 * SIN_LEN + i] = (i & (1 << (SIN_BITS - 1))) ? TL_TAB_LEN : sin_tab[i * 2];
		sin_tab[5 * SIN_LEN + i] = (i & (1 << (SIN_BITS - 1))) ? TL_TAB_LEN : sin_tab[(i * 2) & (SIN_MASK >> 1)];
		sin_tab[6 * SIN_LEN + i] = (i & (1 << (SIN_BITS - 1))) ? 1 : 0;
		let x = (i & (1 << (SIN_BITS - 1))) ? ((SIN_LEN - 1) - i) * 16 + 1 : i * 16;
		if (x > TL_TAB_LEN) x = TL_TAB_LEN;
		sin_tab[7 * SIN_LEN + i] = x;
	}
})();

function new_slot() {
	return { ar: 0, dr: 0, rr: 0, KSR: 0, ksl: 0, ksr: 0, mul: 0, Cnt: 0, Incr: 0, FB: 0, connect: PM,
		op1_out0: 0, op1_out1: 0, CON: 0, eg_type: 0, state: 0, TL: 0, TLL: 0, volume: 0, sl: 0,
		eg_m_ar: 0, eg_sh_ar: 0, eg_sel_ar: 0, eg_m_dr: 0, eg_sh_dr: 0, eg_sel_dr: 0,
		eg_m_rr: 0, eg_sh_rr: 0, eg_sel_rr: 0, key: 0, AMmask: 0, vib: 0, waveform_number: 0, wavetable: 0 };
}

export function ymf262_init(clock, rate) {
	const chip = {
		P_CH: Array.from({ length: 18 }, () => ({ SLOT: [new_slot(), new_slot()], block_fnum: 0, fc: 0, ksl_base: 0, kcode: 0, extended: 0 })),
		pan: new Int32Array(18 * 4), pan_ctrl_value: new Uint32Array(18),
		out: new Int32Array(20),
		eg_cnt: 0, eg_timer: 0, eg_timer_add: 0, eg_timer_overflow: 0, fn_tab: new Uint32Array(1024),
		LFO_AM: 0, LFO_PM: 0, lfo_am_depth: 0, lfo_pm_depth_range: 0, lfo_am_cnt: 0, lfo_am_inc: 0,
		lfo_pm_cnt: 0, lfo_pm_inc: 0, noise_rng: 0, noise_p: 0, noise_f: 0, OPL3_mode: 0, rhythm: 0,
		T: [0, 0], st: [0, 0], address: 0, status: 0, statusmask: 0, nts: 0, clock, rate, freqbase: 0,
	};
	// OPL3_initalize
	chip.freqbase = rate ? (clock / (8.0 * 36)) / rate : 0;
	for (let i = 0; i < 1024; i++) chip.fn_tab[i] = Math.trunc(i * 64 * chip.freqbase * (1 << (FREQ_SH - 10))) >>> 0;
	chip.lfo_am_inc = Math.trunc((1.0 / 64.0) * (1 << LFO_SH) * chip.freqbase) >>> 0;
	chip.lfo_pm_inc = Math.trunc((1.0 / 1024.0) * (1 << LFO_SH) * chip.freqbase) >>> 0;
	chip.noise_f = Math.trunc((1.0 / 1.0) * (1 << FREQ_SH) * chip.freqbase) >>> 0;
	chip.eg_timer_add = Math.trunc((1 << EG_SH) * chip.freqbase) >>> 0;
	chip.eg_timer_overflow = 1 << EG_SH;
	ymf262_reset_chip(chip);
	return chip;
}

function STATUS_SET(chip, flag) {
	chip.status |= (flag & chip.statusmask);
	if (!(chip.status & 0x80) && (chip.status & 0x7f)) chip.status |= 0x80;
}
function STATUS_RESET(chip, flag) {
	chip.status &= ~flag & 0xff;
	if ((chip.status & 0x80) && !(chip.status & 0x7f)) chip.status &= 0x7f;
}

function advance_lfo(chip) {
	chip.lfo_am_cnt = (chip.lfo_am_cnt + chip.lfo_am_inc) >>> 0;
	if (chip.lfo_am_cnt >= LFO_AM_TAB_ELEMENTS * (1 << LFO_SH)) chip.lfo_am_cnt = (chip.lfo_am_cnt - LFO_AM_TAB_ELEMENTS * (1 << LFO_SH)) >>> 0;
	const tmp = lfo_am_table[chip.lfo_am_cnt >>> LFO_SH];
	chip.LFO_AM = chip.lfo_am_depth ? tmp : tmp >> 2;
	chip.lfo_pm_cnt = (chip.lfo_pm_cnt + chip.lfo_pm_inc) >>> 0;
	chip.LFO_PM = ((chip.lfo_pm_cnt >>> LFO_SH) & 7) | chip.lfo_pm_depth_range;
}

function advance(chip) {
	chip.eg_timer = (chip.eg_timer + chip.eg_timer_add) >>> 0;
	while (chip.eg_timer >= chip.eg_timer_overflow) {
		chip.eg_timer -= chip.eg_timer_overflow;
		chip.eg_cnt = (chip.eg_cnt + 1) >>> 0;
		const eg_cnt = chip.eg_cnt;
		for (let i = 0; i < 36; i++) {
			const op = chip.P_CH[i >> 1].SLOT[i & 1];
			switch (op.state) {
			case EG_ATT:
				if (!(eg_cnt & op.eg_m_ar)) {
					op.volume += ((~op.volume) * eg_inc[op.eg_sel_ar + ((eg_cnt >>> op.eg_sh_ar) & 7)]) >> 3;
					if (op.volume <= MIN_ATT_INDEX) { op.volume = MIN_ATT_INDEX; op.state = EG_DEC; }
				}
				break;
			case EG_DEC:
				if (!(eg_cnt & op.eg_m_dr)) {
					op.volume += eg_inc[op.eg_sel_dr + ((eg_cnt >>> op.eg_sh_dr) & 7)];
					if (op.volume >= op.sl) op.state = EG_SUS;
				}
				break;
			case EG_SUS:
				if (!op.eg_type && !(eg_cnt & op.eg_m_rr)) {
					op.volume += eg_inc[op.eg_sel_rr + ((eg_cnt >>> op.eg_sh_rr) & 7)];
					if (op.volume >= MAX_ATT_INDEX) op.volume = MAX_ATT_INDEX;
				}
				break;
			case EG_REL:
				if (!(eg_cnt & op.eg_m_rr)) {
					op.volume += eg_inc[op.eg_sel_rr + ((eg_cnt >>> op.eg_sh_rr) & 7)];
					if (op.volume >= MAX_ATT_INDEX) { op.volume = MAX_ATT_INDEX; op.state = EG_OFF; }
				}
				break;
			}
		}
	}
	for (let i = 0; i < 36; i++) {
		const CH = chip.P_CH[i >> 1], op = CH.SLOT[i & 1];
		if (op.vib) {
			let block_fnum = CH.block_fnum;
			const fnum_lfo = (block_fnum & 0x0380) >> 7;
			const off = lfo_pm_table[chip.LFO_PM + 16 * fnum_lfo];
			if (off) {
				block_fnum = (block_fnum + off) >>> 0;
				const block = (block_fnum & 0x1c00) >> 10;
				op.Cnt = (op.Cnt + (chip.fn_tab[block_fnum & 0x03ff] >>> (7 - block)) * op.mul) >>> 0;
			} else op.Cnt = (op.Cnt + op.Incr) >>> 0;
		} else op.Cnt = (op.Cnt + op.Incr) >>> 0;
	}
	chip.noise_p = (chip.noise_p + chip.noise_f) >>> 0;
	let i = chip.noise_p >>> FREQ_SH;
	chip.noise_p &= FREQ_MASK;
	while (i) {
		if (chip.noise_rng & 1) chip.noise_rng ^= 0x800302;
		chip.noise_rng >>>= 1;
		i--;
	}
}

function op_calc(phase, env, pm, wave_tab) {
	const p = (env << 4) + sin_tab[wave_tab + ((((phase & ~FREQ_MASK) + (pm << 16)) | 0) >> FREQ_SH & SIN_MASK)];
	return p >= TL_TAB_LEN ? 0 : tl_tab[p];
}
function op_calc1(phase, env, pm, wave_tab) {
	const p = (env << 4) + sin_tab[wave_tab + ((((phase & ~FREQ_MASK) + pm) | 0) >> FREQ_SH & SIN_MASK)];
	return p >= TL_TAB_LEN ? 0 : tl_tab[p];
}
const volume_calc = (chip, op) => op.TLL + op.volume + (chip.LFO_AM & op.AMmask);

function chan_calc(chip, CH) {
	const out = chip.out;
	out[PM] = 0; out[PM2] = 0;
	let SLOT = CH.SLOT[0];
	let env = volume_calc(chip, SLOT);
	let o = SLOT.op1_out0 + SLOT.op1_out1;
	SLOT.op1_out0 = SLOT.op1_out1;
	SLOT.op1_out1 = 0;
	if (env < ENV_QUIET) {
		if (!SLOT.FB) o = 0;
		SLOT.op1_out1 = op_calc1(SLOT.Cnt, env, o << SLOT.FB, SLOT.wavetable);
	}
	out[SLOT.connect] += SLOT.op1_out1;
	SLOT = CH.SLOT[1];
	env = volume_calc(chip, SLOT);
	if (env < ENV_QUIET) out[SLOT.connect] += op_calc(SLOT.Cnt, env, out[PM], SLOT.wavetable);
}
function chan_calc_ext(chip, CH) {
	const out = chip.out;
	out[PM] = 0;
	let SLOT = CH.SLOT[0];
	let env = volume_calc(chip, SLOT);
	if (env < ENV_QUIET) out[SLOT.connect] += op_calc(SLOT.Cnt, env, out[PM2], SLOT.wavetable);
	SLOT = CH.SLOT[1];
	env = volume_calc(chip, SLOT);
	if (env < ENV_QUIET) out[SLOT.connect] += op_calc(SLOT.Cnt, env, out[PM], SLOT.wavetable);
}
function chan_calc_rhythm(chip, noise) {
	const out = chip.out, P = chip.P_CH;
	out[PM] = 0;
	let SLOT = P[6].SLOT[0];
	let env = volume_calc(chip, SLOT);
	let o = SLOT.op1_out0 + SLOT.op1_out1;
	SLOT.op1_out0 = SLOT.op1_out1;
	if (!SLOT.CON) out[PM] = SLOT.op1_out0;
	SLOT.op1_out1 = 0;
	if (env < ENV_QUIET) {
		if (!SLOT.FB) o = 0;
		SLOT.op1_out1 = op_calc1(SLOT.Cnt, env, o << SLOT.FB, SLOT.wavetable);
	}
	SLOT = P[6].SLOT[1];
	env = volume_calc(chip, SLOT);
	if (env < ENV_QUIET) out[6] += op_calc(SLOT.Cnt, env, out[PM], SLOT.wavetable) * 2;
	const S71 = P[7].SLOT[0], S72 = P[7].SLOT[1], S81 = P[8].SLOT[0], S82 = P[8].SLOT[1];
	env = volume_calc(chip, S71);
	if (env < ENV_QUIET) {
		const c = S71.Cnt >>> FREQ_SH;
		const res1 = (((c >> 2) & 1) ^ ((c >> 7) & 1)) | ((c >> 3) & 1);
		let phase = res1 ? (0x200 | (0xd0 >> 2)) : 0xd0;
		const c8 = S82.Cnt >>> FREQ_SH;
		if (((c8 >> 3) & 1) ^ ((c8 >> 5) & 1)) phase = 0x200 | (0xd0 >> 2);
		if (phase & 0x200) { if (noise) phase = 0x200 | 0xd0; }
		else if (noise) phase = 0xd0 >> 2;
		out[7] += op_calc(phase << FREQ_SH, env, 0, S71.wavetable) * 2;
	}
	env = volume_calc(chip, S72);
	if (env < ENV_QUIET) {
		let phase = ((S71.Cnt >>> FREQ_SH) >> 8) & 1 ? 0x200 : 0x100;
		if (noise) phase ^= 0x100;
		out[7] += op_calc(phase << FREQ_SH, env, 0, S72.wavetable) * 2;
	}
	env = volume_calc(chip, S81);
	if (env < ENV_QUIET) out[8] += op_calc(S81.Cnt, env, 0, S81.wavetable) * 2;
	env = volume_calc(chip, S82);
	if (env < ENV_QUIET) {
		const c = S71.Cnt >>> FREQ_SH;
		const res1 = (((c >> 2) & 1) ^ ((c >> 7) & 1)) | ((c >> 3) & 1);
		let phase = res1 ? 0x300 : 0x100;
		const c8 = S82.Cnt >>> FREQ_SH;
		if (((c8 >> 3) & 1) ^ ((c8 >> 5) & 1)) phase = 0x300;
		out[8] += op_calc(phase << FREQ_SH, env, 0, S82.wavetable) * 2;
	}
}

function FM_KEYON(SLOT, key_set) {
	if (!SLOT.key) { SLOT.Cnt = 0; SLOT.state = EG_ATT; }
	SLOT.key |= key_set;
}
function FM_KEYOFF(SLOT, key_clr) {
	if (SLOT.key) {
		SLOT.key &= key_clr;
		if (!SLOT.key && SLOT.state > EG_REL) SLOT.state = EG_REL;
	}
}
function set_ar_rates(SLOT) {
	if ((SLOT.ar + SLOT.ksr) < 16 + 60) {
		SLOT.eg_sh_ar = eg_rate_shift[SLOT.ar + SLOT.ksr];
		SLOT.eg_m_ar = (1 << SLOT.eg_sh_ar) - 1;
		SLOT.eg_sel_ar = eg_rate_select[SLOT.ar + SLOT.ksr];
	} else {
		SLOT.eg_sh_ar = 0;
		SLOT.eg_m_ar = 0;
		SLOT.eg_sel_ar = 13 * RATE_STEPS;
	}
}
function set_dr_rates(SLOT) {
	SLOT.eg_sh_dr = eg_rate_shift[SLOT.dr + SLOT.ksr];
	SLOT.eg_m_dr = (1 << SLOT.eg_sh_dr) - 1;
	SLOT.eg_sel_dr = eg_rate_select[SLOT.dr + SLOT.ksr];
}
function set_rr_rates(SLOT) {
	SLOT.eg_sh_rr = eg_rate_shift[SLOT.rr + SLOT.ksr];
	SLOT.eg_m_rr = (1 << SLOT.eg_sh_rr) - 1;
	SLOT.eg_sel_rr = eg_rate_select[SLOT.rr + SLOT.ksr];
}
function CALC_FCSLOT(CH, SLOT) {
	SLOT.Incr = (CH.fc * SLOT.mul) >>> 0;
	const ksr = CH.kcode >> SLOT.KSR;
	if (SLOT.ksr !== ksr) {
		SLOT.ksr = ksr;
		set_ar_rates(SLOT);
		set_dr_rates(SLOT);
		set_rr_rates(SLOT);
	}
}
// the channel whose frequency data drives `chan_no` (the first of a 4-op pair in OPL3 mode)
function freq_channel(chip, chan_no) {
	if ((chip.OPL3_mode & 1) && [3, 4, 5, 12, 13, 14].includes(chan_no) && chip.P_CH[chan_no - 3].extended)
		return chip.P_CH[chan_no - 3];
	return chip.P_CH[chan_no];
}
function set_mul(chip, slot, v) {
	const SLOT = chip.P_CH[slot >> 1].SLOT[slot & 1];
	SLOT.mul = mul_tab[v & 0x0f];
	SLOT.KSR = (v & 0x10) ? 0 : 2;
	SLOT.eg_type = v & 0x20;
	SLOT.vib = v & 0x40;
	SLOT.AMmask = (v & 0x80) ? -1 : 0;
	CALC_FCSLOT(freq_channel(chip, slot >> 1), SLOT);
}
function set_ksl_tl(chip, slot, v) {
	const SLOT = chip.P_CH[slot >> 1].SLOT[slot & 1];
	SLOT.ksl = ksl_shift[v >> 6];
	SLOT.TL = (v & 0x3f) << (ENV_BITS - 1 - 7);
	SLOT.TLL = SLOT.TL + (freq_channel(chip, slot >> 1).ksl_base >>> SLOT.ksl);
}
function set_ar_dr(chip, slot, v) {
	const SLOT = chip.P_CH[slot >> 1].SLOT[slot & 1];
	SLOT.ar = (v >> 4) ? 16 + ((v >> 4) << 2) : 0;
	set_ar_rates(SLOT);
	SLOT.dr = (v & 0x0f) ? 16 + ((v & 0x0f) << 2) : 0;
	set_dr_rates(SLOT);
}
function set_sl_rr(chip, slot, v) {
	const SLOT = chip.P_CH[slot >> 1].SLOT[slot & 1];
	SLOT.sl = sl_tab[v >> 4];
	SLOT.rr = (v & 0x0f) ? 16 + ((v & 0x0f) << 2) : 0;
	set_rr_rates(SLOT);
}
function refresh_slots(CH, src) {
	for (const S of CH.SLOT) S.TLL = S.TL + (src.ksl_base >>> S.ksl);
	for (const S of CH.SLOT) CALC_FCSLOT(src, S);
}

function OPL3WriteReg(chip, r, v) {
	let ch_offset = 0;
	const P = chip.P_CH;
	if (r & 0x100) {
		switch (r) {
		case 0x101: return;
		case 0x104: {
			const set = [0, 1, 2, 9, 10, 11];
			for (let b = 0; b < 6; b++) P[set[b]].extended = (v >> b) & 1;
			return;
		}
		case 0x105: chip.OPL3_mode = v & 1; return;
		}
		ch_offset = 9;
	}
	r &= 0xff; v &= 0xff;
	let slot, CH;
	switch (r & 0xe0) {
	case 0x00:
		switch (r & 0x1f) {
		case 0x02: chip.T[0] = (256 - v) * 4; break;
		case 0x03: chip.T[1] = (256 - v) * 16; break;
		case 0x04:
			if (v & 0x80) STATUS_RESET(chip, 0x60);
			else {
				STATUS_RESET(chip, v & 0x60);
				chip.statusmask = (~v) & 0x60;
				STATUS_SET(chip, 0); STATUS_RESET(chip, 0);
				chip.st[1] = (v >> 1) & 1;
				chip.st[0] = v & 1;
			}
			break;
		case 0x08: chip.nts = v; break;
		}
		break;
	case 0x20: slot = slot_array[r & 0x1f]; if (slot < 0) return; set_mul(chip, slot + ch_offset * 2, v); break;
	case 0x40: slot = slot_array[r & 0x1f]; if (slot < 0) return; set_ksl_tl(chip, slot + ch_offset * 2, v); break;
	case 0x60: slot = slot_array[r & 0x1f]; if (slot < 0) return; set_ar_dr(chip, slot + ch_offset * 2, v); break;
	case 0x80: slot = slot_array[r & 0x1f]; if (slot < 0) return; set_sl_rr(chip, slot + ch_offset * 2, v); break;
	case 0xa0: {
		if (r === 0xbd) {
			if (ch_offset !== 0) return;
			chip.lfo_am_depth = v & 0x80;
			chip.lfo_pm_depth_range = (v & 0x40) ? 8 : 0;
			chip.rhythm = v & 0x3f;
			const kk = (s, on) => on ? FM_KEYON(s, 2) : FM_KEYOFF(s, ~2);
			if (chip.rhythm & 0x20) {
				kk(P[6].SLOT[0], v & 0x10); kk(P[6].SLOT[1], v & 0x10);
				kk(P[7].SLOT[0], v & 0x01);
				kk(P[7].SLOT[1], v & 0x08);
				kk(P[8].SLOT[0], v & 0x04);
				kk(P[8].SLOT[1], v & 0x02);
			} else {
				for (const s of [P[6].SLOT[0], P[6].SLOT[1], P[7].SLOT[0], P[7].SLOT[1], P[8].SLOT[0], P[8].SLOT[1]]) FM_KEYOFF(s, ~2);
			}
			return;
		}
		if ((r & 0x0f) > 8) return;
		const chan_no = (r & 0x0f) + ch_offset;
		CH = P[chan_no];
		let block_fnum;
		const opl3 = chip.OPL3_mode & 1;
		const first = [0, 1, 2, 9, 10, 11].includes(chan_no), second = [3, 4, 5, 12, 13, 14].includes(chan_no);
		if (!(r & 0x10)) block_fnum = (CH.block_fnum & 0x1f00) | v;
		else {
			block_fnum = ((v & 0x1f) << 8) | (CH.block_fnum & 0xff);
			const key = (S) => (v & 0x20) ? FM_KEYON(S, 1) : FM_KEYOFF(S, ~1);
			if (opl3 && first && CH.extended) { key(CH.SLOT[0]); key(CH.SLOT[1]); key(P[chan_no + 3].SLOT[0]); key(P[chan_no + 3].SLOT[1]); }
			else if (opl3 && second && P[chan_no - 3].extended) { /* handled by the first channel of the pair */ }
			else { key(CH.SLOT[0]); key(CH.SLOT[1]); }
		}
		if (CH.block_fnum !== block_fnum) {
			const block = block_fnum >> 10;
			CH.block_fnum = block_fnum;
			CH.ksl_base = Math.trunc(ksl_tab[block_fnum >> 6]) >>> 0;
			CH.fc = chip.fn_tab[block_fnum & 0x03ff] >>> (7 - block);
			CH.kcode = (CH.block_fnum & 0x1c00) >> 9;
			if (chip.nts & 0x40) CH.kcode |= (CH.block_fnum & 0x100) >> 8;
			else CH.kcode |= (CH.block_fnum & 0x200) >> 9;
			if (opl3 && first && CH.extended) { refresh_slots(CH, CH); refresh_slots(P[chan_no + 3], CH); }
			else if (opl3 && second && P[chan_no - 3].extended) { /* nothing */ }
			else refresh_slots(CH, CH);
		}
		break;
	}
	case 0xc0: {
		if ((r & 0xf) > 8) return;
		const chan_no = (r & 0xf) + ch_offset;
		CH = P[chan_no];
		const base = chan_no * 4;
		if (chip.OPL3_mode & 1) {
			chip.pan[base] = (v & 0x10) ? -1 : 0;
			chip.pan[base + 1] = (v & 0x20) ? -1 : 0;
			chip.pan[base + 2] = (v & 0x40) ? -1 : 0;
			chip.pan[base + 3] = (v & 0x80) ? -1 : 0;
		} else chip.pan.fill(-1, base, base + 4);
		chip.pan_ctrl_value[chan_no] = v;
		CH.SLOT[0].FB = ((v >> 1) & 7) ? ((v >> 1) & 7) + 7 : 0;
		CH.SLOT[0].CON = v & 1;
		const two_op = () => { CH.SLOT[0].connect = CH.SLOT[0].CON ? chan_no : PM; CH.SLOT[1].connect = chan_no; };
		const four_op = (A, B, a) => {
			switch ((A.SLOT[0].CON << 1) | B.SLOT[0].CON) {
			case 0: A.SLOT[0].connect = PM; A.SLOT[1].connect = PM2; B.SLOT[0].connect = PM; B.SLOT[1].connect = a + 3; break;
			case 1: A.SLOT[0].connect = PM; A.SLOT[1].connect = a; B.SLOT[0].connect = PM; B.SLOT[1].connect = a + 3; break;
			case 2: A.SLOT[0].connect = a; A.SLOT[1].connect = PM2; B.SLOT[0].connect = PM; B.SLOT[1].connect = a + 3; break;
			case 3: A.SLOT[0].connect = a; A.SLOT[1].connect = PM2; B.SLOT[0].connect = a + 3; B.SLOT[1].connect = a + 3; break;
			}
		};
		if (chip.OPL3_mode & 1) {
			if ([0, 1, 2, 9, 10, 11].includes(chan_no)) {
				if (CH.extended) four_op(CH, P[chan_no + 3], chan_no); else two_op();
			} else if ([3, 4, 5, 12, 13, 14].includes(chan_no)) {
				if (P[chan_no - 3].extended) four_op(P[chan_no - 3], CH, chan_no - 3); else two_op();
			} else two_op();
		} else two_op();
		break;
	}
	case 0xe0: {
		slot = slot_array[r & 0x1f];
		if (slot < 0) return;
		slot += ch_offset * 2;
		CH = P[slot >> 1];
		v &= 7;
		CH.SLOT[slot & 1].waveform_number = v;
		if (!(chip.OPL3_mode & 1)) v &= 3;
		CH.SLOT[slot & 1].wavetable = v * SIN_LEN;
		break;
	}
	}
}

export function ymf262_reset_chip(chip) {
	chip.eg_timer = 0;
	chip.eg_cnt = 0;
	chip.noise_rng = 1;
	chip.nts = 0;
	STATUS_RESET(chip, 0x60);
	OPL3WriteReg(chip, 0x01, 0);
	OPL3WriteReg(chip, 0x02, 0);
	OPL3WriteReg(chip, 0x03, 0);
	OPL3WriteReg(chip, 0x04, 0);
	for (let c = 0xff; c >= 0x20; c--) OPL3WriteReg(chip, c, 0);
	for (let c = 0x1ff; c >= 0x120; c--) OPL3WriteReg(chip, c, 0);
	for (const CH of chip.P_CH) for (const S of CH.SLOT) { S.state = EG_OFF; S.volume = MAX_ATT_INDEX; }
}

export function ymf262_write(chip, a, v) {
	v &= 0xff;
	switch (a & 3) {
	case 0: chip.address = v; break;
	case 1: case 3: OPL3WriteReg(chip, chip.address, v); break;
	case 2:
		if (chip.OPL3_mode & 1) chip.address = v | 0x100;
		else chip.address = v === 5 ? v | 0x100 : v;
		break;
	}
	return chip.status >> 7;
}
export const ymf262_read = (chip, a) => a === 0 ? chip.status : 0;

// buffers: 18 entries, each an Int32Array (interleaved stereo) or null; vu_max: Uint32Array(18)
export function ymf262_update_multi(chip, buffers, length, vu_max) {
	const out = chip.out, P = chip.P_CH, pan = chip.pan;
	const rhythm = chip.rhythm & 0x20;
	for (let i = 0; i < length; i++) {
		advance_lfo(chip);
		out.fill(0, 0, 18);
		chan_calc(chip, P[0]);
		if (P[0].extended) chan_calc_ext(chip, P[3]); else chan_calc(chip, P[3]);
		chan_calc(chip, P[1]);
		if (P[1].extended) chan_calc_ext(chip, P[4]); else chan_calc(chip, P[4]);
		chan_calc(chip, P[2]);
		if (P[2].extended) chan_calc_ext(chip, P[5]); else chan_calc(chip, P[5]);
		if (!rhythm) { chan_calc(chip, P[6]); chan_calc(chip, P[7]); chan_calc(chip, P[8]); }
		else chan_calc_rhythm(chip, chip.noise_rng & 1);
		chan_calc(chip, P[9]);
		if (P[9].extended) chan_calc_ext(chip, P[12]); else chan_calc(chip, P[12]);
		chan_calc(chip, P[10]);
		if (P[10].extended) chan_calc_ext(chip, P[13]); else chan_calc(chip, P[13]);
		chan_calc(chip, P[11]);
		if (P[11].extended) chan_calc_ext(chip, P[14]); else chan_calc(chip, P[14]);
		chan_calc(chip, P[15]); chan_calc(chip, P[16]); chan_calc(chip, P[17]);
		for (let j = 0; j < 18; j++) {
			const x = Math.abs(out[j]);
			if (x > vu_max[j]) vu_max[j] = x;
		}
		for (let j = 0; j < 18; j++) {
			const b = buffers[j];
			if (b) {
				b[i * 2] += (out[j] & pan[j * 4]) * OPL_VOLUME;
				b[i * 2 + 1] += (out[j] & pan[j * 4 + 1]) * OPL_VOLUME;
			}
		}
		advance(chip);
	}
}
