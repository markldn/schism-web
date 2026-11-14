// ModPlug clipboard decoder from schism/page_patedit.c (GPL-2.0-or-later).
import { get_effect_number, get_ptm_effect_number } from './keyboard.js';
import { NOTE_OFF, NOTE_CUT, NOTE_FADE } from './sndconst.js';

const blank = () => ({ note: 0, instrument: 0, voleffect: 0, volparam: 0, effect: 0, param: 0 });
const volumes = { v: 1, p: 2, c: 3, d: 4, a: 5, b: 6, u: 7, h: 8, l: 9, r: 10, g: 11, f: 12, e: 13 };

export function pattern_selection_system_paste_modplug(text) {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	const magic = lines.shift()?.slice(-3);
	const fx = magic === ' IT' || magic === 'S3M' ? get_effect_number
		: magic === ' XM' || magic === 'MOD' ? get_ptm_effect_number : null;
	if (!fx || !lines[0]?.startsWith('|')) return null;
	const rows = [];
	let channels = 0;
	for (const line of lines) {
		if (!line) continue;
		if (!line.startsWith('|')) return null;
		if (rows.length === 200) break;
		const cells = line.slice(1).split('|');
		if (cells.at(-1) === '') cells.pop();
		const row = [];
		for (const cell of cells.slice(0, 64)) {
			if (cell.length < 5 || (cell.length - 5) % 3) return null;
			const n = blank();
			const pitch = { C: 1, D: 3, E: 5, F: 6, G: 8, A: 10, B: 12 }[cell[0].toUpperCase()];
			if (pitch && /[0-9]/.test(cell[2])) {
				n.note = pitch + (cell[1] === '#' ? 1 : cell[1] === 'b' ? -1 : 0) + Number(cell[2]) * 12;
				if (n.note < 1 || n.note > 120) n.note = 0;
			} else n.note = { '=': NOTE_OFF, '^': NOTE_CUT, '~': NOTE_FADE }[cell[0]] || 0;
			// ModPlug encodes 100..255 with punctuation/letters in the tens digit.
			const tens = cell.charCodeAt(3) - 48, ones = cell.charCodeAt(4) - 48;
			if (tens >= 0 && tens <= 25 && ones >= 0 && ones <= 9) {
				const instrument = tens * 10 + ones;
				if (instrument <= 255) n.instrument = instrument;
			}
			for (let i = 5; i < cell.length; i += 3) {
				const c = cell[i], value = cell.slice(i + 1, i + 3);
				if (c >= 'a' && c <= 'z') {
					n.voleffect = volumes[c] || 0;
					n.volparam = n.voleffect ? (parseInt(value, 10) || 0) : 0;
				} else {
					n.effect = Math.max(0, fx(c.charCodeAt(0)));
					n.param = parseInt(value, 16) || 0;
				}
			}
			row.push(n);
		}
		channels = Math.max(channels, row.length);
		rows.push(row);
	}
	if (!channels || !rows.length) return null;
	return { channels, rows: rows.length, data: rows.flatMap(row =>
		Array.from({ length: channels }, (_, i) => row[i] || blank())) };
}
