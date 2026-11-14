// Port of the parts of schism/charset.c the UI uses (Schism Tracker, GPL-2.0-or-later):
// digraphs, Unicode -> CP437 and Unicode -> ITF (the tracker font's own charset).
import { DIGRAPHS, UNICODE_TO_CP437, UNICODE_TO_ITF } from './gen/charset.js';

const digraph_map = new Map();
for (const [pair, eq] of DIGRAPHS) {
	// DG() matches either order; the first definition wins
	for (const key of [pair, pair[1] + pair[0]]) if (!digraph_map.has(key)) digraph_map.set(key, eq);
}
export function char_digraph(k1, k2) {
	return digraph_map.get(String.fromCharCode(k1, k2)) || 0;
}
export function char_unicode_to_cp437(c) {
	if (c <= 127) return c;
	const r = UNICODE_TO_CP437.get(c);
	return r === undefined ? -1 : r;
}
export function char_unicode_to_itf(c) {
	if (!c || (c >= 32 && c <= 127)) return c;
	const r = UNICODE_TO_ITF.get(c);
	return r === undefined ? -1 : r;
}
// charset_iconv(text, CHARSET_UTF8, CHARSET_ITF): unmappable characters become '?'
export function utf_to_itf(text) {
	const out = [];
	for (const ch of text) {
		const c = char_unicode_to_itf(ch.codePointAt(0));
		out.push(c < 0 ? 63 : c);
	}
	return out;
}
