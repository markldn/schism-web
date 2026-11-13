// Fixed-point positions and timing from include/player/sndfile.h (GPL-2.0-or-later).
const pos = v => ({ v: BigInt.asIntN(64, v) });
export const csf_smp_pos = (whole, frac) => pos((BigInt(whole | 0) << 32n) | BigInt(frac >>> 0));
export const csf_smp_pos_get_full = p => p.v;
export const csf_smp_pos_get_whole = p => Number(p.v >> 32n);
export const csf_smp_pos_get_frac = p => Number(p.v & 0xffffffffn);
export const csf_smp_pos_equals_one = p => p.v === 0x100000000n;
export const csf_smp_pos_equals_zero = p => p.v === 0n;
export const csf_smp_pos_is_positive = p => p.v > 0n;
export const csf_smp_pos_is_negative = p => p.v < 0n;
export const csf_smp_pos_add = (a, b) => pos(a.v + b.v);
export const csf_smp_pos_sub = (a, b) => pos(a.v - b.v);
export const csf_smp_pos_mul_whole = (a, b) => pos(a.v * BigInt(b));
export const csf_smp_pos_div = (a, b) => a.v / b.v;
export const csf_smp_pos_div_whole = (a, b) => pos(a.v / BigInt(b));
export const csf_smp_pos_lt = (a, b) => a.v < b.v;
export const csf_smp_pos_gt = (a, b) => a.v > b.v;
export const csf_smp_pos_le = (a, b) => a.v <= b.v;
export const csf_smp_pos_ge = (a, b) => a.v >= b.v;
export const csf_smp_pos_equ = (a, b) => a.v === b.v;
export const csf_smp_pos_neq = (a, b) => a.v !== b.v;
export const csf_smp_pos_negate = p => pos(-p.v);
export const csf_smp_pos_ratio = (a, b) => csf_smp_pos_div_whole(csf_smp_pos(a, 0), b >>> 0);
export const csf_smp_pos_muldiv = (p, mul, div) => pos(BigInt.asIntN(64, p.v * BigInt(mul >>> 0)) / BigInt(div >>> 0));
export function csf_calculate_tick_length(csf) {
	const numerator = (csf.mix_frequency * 5 * csf.tempo_factor) >>> 0;
	return Math.trunc(numerator / ((csf.current_tempo << 8) >>> 0)) >>> 0;
}
export const csf_tick_length_in_samples = (freq, tempo) => ((5 * (freq | 0)) | 0) / ((2 * (tempo | 0)) | 0);
export const csf_ticks_to_samples = (ticks, freq, tempo) => Math.trunc((ticks | 0) * csf_tick_length_in_samples(freq, tempo)) | 0;
export const csf_get_current_tick = csf => (csf.current_speed - csf.tick_count) | 0;
