// Port of schism/vgamem.c and schism/fonts.c (Schism Tracker, GPL-2.0-or-later).
// The fake 80x50 VGA text screen: character cells, pixel overlays, and the
// scanner that turns both into 640x400 pixels.

import { FONTS } from "./gen/fonts.js";
import { status, INVERTED_PALETTE, CLASSIC_MODE } from "./state.js";

export const DEFAULT_FG = 3;

const SAMPLE_DATA_COLOR = 13;
const SAMPLE_LOOP_COLOR = 3;

const FONT_HALFWIDTH = 0x80000000 | 0;
const FONT_OVERLAY = 0x40000000;
const FONT_UNICODE = 0x20000000;
const FONT_BIOS = 0x10000000;

// box flags
export const BOX_OUTSET = 0, BOX_INSET = 1, BOX_FLAT_LIGHT = 2, BOX_FLAT_DARK = 3, BOX_SHADE_NONE = 4;
export const BOX_SHADE_MASK = 7;
export const BOX_INNER = 0 << 4, BOX_OUTER = 1 << 4, BOX_CORNER = 2 << 4;
export const BOX_TYPE_MASK = 3 << 4;
export const BOX_THIN = 0 << 6, BOX_THICK = 1 << 6;
export const BOX_THICKNESS_MASK = 1 << 6;

// ---------------------------------------------------------------------------
// fonts (fonts.c)

export const font_normal = new Uint8Array(2048);
export const font_half_data = new Uint8Array(1024);
font_half_data.set(FONTS.half_width);

function make_half_width_middot() {
	for (let i = 0; i < 4; i++) {
		font_half_data[173 * 4 + i] =
			(font_normal[184 * 8 + i * 2] & 0xf0) | ((font_normal[184 * 8 + i * 2 + 1] & 0xf0) >> 4);
		font_half_data[184 * 4 + i] =
			((font_normal[184 * 8 + i * 2] & 0xf) << 4) | (font_normal[184 * 8 + i * 2 + 1] & 0xf);
	}
}

export function font_reset() {
	font_normal.set(FONTS.default_lower, 0);
	font_normal.set(FONTS.default_upper_itf, 1024);
	make_half_width_middot();
}

export function font_reset_bios() {
	font_normal.set(FONTS.default_lower, 0);
	font_normal.set(FONTS.default_upper_alt, 1024);
	make_half_width_middot();
}

font_reset();

// ---------------------------------------------------------------------------

const vgamem = new Int32Array(4000);
const vgamem_read = new Int32Array(4000);
const ovl = new Uint8Array(640 * 400);

export function vgamem_flip() { vgamem_read.set(vgamem); }
export function vgamem_clear() { vgamem.fill(0); }

// ---------------------------------------------------------------------------
// overlays: {x1, y1, x2, y2} in character cells; alloc fills in the rest

export function vgamem_ovl_alloc(n) {
	n.q = n.x1 * 8 + n.y1 * 5120; // offset into ovl
	n.width = 8 * (n.x2 - n.x1 + 1);
	n.height = 8 * (n.y2 - n.y1 + 1);
	n.skip = 640 - n.width;
	return n;
}

export function vgamem_ovl_apply(n) {
	for (let y = n.y1; y <= n.y2; y++)
		for (let x = n.x1; x <= n.x2; x++)
			vgamem[x + y * 80] = FONT_OVERLAY;
}

export function vgamem_ovl_clear(n, color) {
	let q = n.q;
	for (let j = 0; j < n.height; j++) {
		ovl.fill(color, q, q + n.width);
		q += 640;
	}
}

export function vgamem_ovl_drawpixel(n, x, y, color) {
	ovl[n.q + 640 * y + x] = color;
}

export function vgamem_ovl_drawline(n, xs, ys, xe, ye, color) {
	const dx = xe - xs, dy = ye - ys;

	if (dx === 0) {
		const a = Math.min(ys, ye), b = Math.max(ys, ye);
		for (let y = a; y <= b; y++) ovl[n.q + 640 * y + xs] = color;
		return;
	}
	if (dy === 0) {
		const a = Math.min(xs, xe), b = Math.max(xs, xe);
		for (let x = a; x <= b; x++) ovl[n.q + 640 * ys + x] = color;
		return;
	}

	const ax = Math.abs(dx) << 1, sx = dx < 0 ? -1 : 1;
	const ay = Math.abs(dy) << 1, sy = dy < 0 ? -1 : 1;
	let x = xs, y = ys, d;

	if (ax > ay) {
		d = ay - (ax >> 1);
		for (;;) {
			ovl[n.q + 640 * y + x] = color;
			if (x === xe) break;
			if (d >= 0) { y += sy; d -= ax; }
			x += sx;
			d += ay;
		}
	} else {
		d = ax - (ay >> 1);
		for (;;) {
			ovl[n.q + 640 * y + x] = color;
			if (y === ye) break;
			if (d >= 0) { x += sx; d -= ay; }
			y += sy;
			d += ax;
		}
	}
}

// ---------------------------------------------------------------------------
// scanner: text cells + overlay -> pixels

const uFFFD = Uint8Array.of(0x42, 0x99, 0xF9, 0xF3, 0xE7, 0xFF, 0xE7, 0x7E);

function unpack_halfw(c) {
	if (c <= 95) return c + 32;
	return 96 - c + 173; // sic: mirrors the C source
}

function pack_halfw(c) {
	if (c >= 32 && c <= 127) return c - 32;
	if (c >= 173 && c <= 205) return 96 + c - 173;
	return 63; // '?'
}

// TODO(port): charset.c tables (cp437 / cp866 / hiragana) for the Unicode path.
function unicode_glyph_row(c, yl) {
	if (c >= 0x20 && c <= 0x7F) return font_normal[(c << 3) + yl];
	if (c >= 0xA0 && c <= 0xFF) return FONTS.extended_latin[((c - 0xA0) << 3) + yl];
	if (c >= 0x390 && c <= 0x3C9) return FONTS.greek[((c - 0x390) << 3) + yl];
	return uFFFD[yl];
}

/* Renders the whole screen into `out` (Uint32Array of 640*400, one entry per
 * pixel). `tc` maps the 16 palette indexes (0-255 for overlay bytes) to pixel
 * values. `mouse` is optional: {lines: Uint32Array(400*80), masks: ...} as
 * produced by video.js for the software cursor. */
export function vgamem_scan_all(out, tc, mouse) {
	const bioshi = FONTS.default_upper_alt, bioslo = FONTS.default_lower;
	let o = 0;

	for (let ry = 0; ry < 400; ry++) {
		const y = ry >> 3, yl = ry & 7;
		let q = ry * 640;
		let bp = y * 80;

		for (let x = 0; x < 80; x++, bp++, q += 8) {
			const cell = vgamem_read[bp];
			const ml = mouse ? mouse.lines[ry * 80 + x] : 0;
			const mm = mouse ? mouse.masks[ry * 80 + x] : 0;
			let fg, bg, fg2, bg2, dg;

			if (cell & FONT_HALFWIDTH) {
				const dg1 = font_half_data[(unpack_halfw((cell >>> 15) & 0x7F) << 2) + (yl >> 1)];
				const dg2 = font_half_data[(unpack_halfw(cell & 0x7F) << 2) + (yl >> 1)];
				dg = !(ry & 1) ? ((dg1 & 0xF0) | (dg2 >> 4)) : (((dg1 << 4) & 0xF0) | (dg2 & 0xF));
				fg = (cell >>> 26) & 0xF;
				bg = (cell >>> 22) & 0xF;
				fg2 = (cell >>> 11) & 0xF;
				bg2 = (cell >>> 7) & 0xF;
			} else if (cell & FONT_OVERLAY) {
				for (let b = 0; b < 8; b++)
					out[o++] = tc[(ovl[q + b] | ((ml & (0x80 >> b)) ? 15 : 0)) & 0xFF];
				continue;
			} else if (cell & FONT_UNICODE) {
				dg = unicode_glyph_row(cell & 0x1FFFFF, yl);
				fg = fg2 = (cell >>> 25) & 0xF;
				bg = bg2 = (cell >>> 21) & 0xF;
			} else if (cell & FONT_BIOS) {
				const c = cell & 0xFF;
				fg = fg2 = (cell >>> 12) & 0xF;
				bg = bg2 = (cell >>> 8) & 0xF;
				dg = ((c & 0x80) ? bioshi : bioslo)[((c & 0x7F) << 3) + yl];
			} else {
				fg = fg2 = (cell >>> 12) & 0xF;
				bg = bg2 = (cell >>> 8) & 0xF;
				dg = font_normal[((cell & 0xFF) << 3) + yl];
			}

			dg |= ml;
			dg &= ~(mm ^ ml);

			const f = tc[fg], b = tc[bg], f2 = tc[fg2], b2 = tc[bg2];
			out[o++] = (dg & 0x80) ? f : b;
			out[o++] = (dg & 0x40) ? f : b;
			out[o++] = (dg & 0x20) ? f : b;
			out[o++] = (dg & 0x10) ? f : b;
			out[o++] = (dg & 0x08) ? f2 : b2;
			out[o++] = (dg & 0x04) ? f2 : b2;
			out[o++] = (dg & 0x02) ? f2 : b2;
			out[o++] = (dg & 0x01) ? f2 : b2;
		}
	}
}

// ---------------------------------------------------------------------------
// character drawing. Text may be a JS string (one byte per char, ITF/CP437
// code points 0-255) or a byte array; a zero byte ends it, as in C.

function inbounds(x, y) {
	if (x < 0 || y < 0 || x >= 80 || y >= 50)
		throw new RangeError(`draw outside the screen: ${x},${y}`);
}

const byte_at = (text, i) => (typeof text === "string" ? text.charCodeAt(i) & 0xFF : text[i]);

export function draw_char(c, x, y, fg, bg) {
	inbounds(x, y);
	vgamem[x + y * 80] = (fg << 12) | (bg << 8) | (c & 0xFF);
}

export function draw_char_bios(c, x, y, fg, bg) {
	inbounds(x, y);
	vgamem[x + y * 80] = FONT_BIOS | (fg << 12) | (bg << 8) | (c & 0xFF);
}

export function draw_char_unicode(c, x, y, fg, bg) {
	inbounds(x, y);
	vgamem[x + y * 80] = FONT_UNICODE | (fg << 25) | (bg << 21) | (c & 0x1FFFFF);
}

export function draw_text(text, x, y, fg, bg) {
	let n = 0;
	for (; n < text.length; n++) {
		const c = byte_at(text, n);
		if (!c) break;
		draw_char(c, x + n, y, fg, bg);
	}
	return n;
}

export function draw_text_bios(text, x, y, fg, bg) {
	let n = 0;
	for (; n < text.length; n++) {
		const c = byte_at(text, n);
		if (!c) break;
		draw_char_bios(c, x + n, y, fg, bg);
	}
	return n;
}

/* `text` is a real JS (Unicode) string here */
export function draw_text_utf8(text, x, y, fg, bg) {
	let n = 0;
	for (const ch of text.normalize("NFC")) {
		draw_char_unicode(ch.codePointAt(0), x + n, y, fg, bg);
		n++;
	}
	return n;
}

export function draw_fill_chars(xs, ys, xe, ye, fg, bg) {
	const v = (fg << 12) | (bg << 8);
	for (let y = ys; y <= ye; y++)
		for (let x = xs; x <= xe; x++)
			vgamem[x + y * 80] = v;
}

export function draw_text_len(text, len, x, y, fg, bg) {
	let n = 0;
	for (; n < text.length && n < len; n++) {
		const c = byte_at(text, n);
		if (!c) break;
		draw_char(c, x + n, y, fg, bg);
	}
	draw_fill_chars(x + n, y, x + len - 1, y, fg, bg);
	return n;
}

export function draw_text_bios_len(text, len, x, y, fg, bg) {
	let n = 0;
	for (; n < text.length && n < len; n++) {
		const c = byte_at(text, n);
		if (!c) break;
		draw_char_bios(c, x + n, y, fg, bg);
	}
	draw_fill_chars(x + n, y, x + len - 1, y, fg, bg);
	return n;
}

export function draw_text_utf8_len(text, len, x, y, fg, bg) {
	let n = 0;
	for (const ch of text.normalize("NFC")) {
		if (n >= len) break;
		draw_char_unicode(ch.codePointAt(0), x + n, y, fg, bg);
		n++;
	}
	draw_fill_chars(x + n, y, x + len - 1, y, fg, bg);
	return n;
}

export function draw_half_width_chars(c1, c2, x, y, fg1, bg1, fg2, bg2) {
	inbounds(x, y);
	vgamem[x + y * 80] = FONT_HALFWIDTH
		| (fg1 << 26) | (fg2 << 11) | (bg1 << 22) | (bg2 << 7)
		| (pack_halfw(c1) << 15) | pack_halfw(c2);
}

// ---------------------------------------------------------------------------
// boxes

const BOX_COLORS = [[3, 1], [1, 3], [3, 3], [1, 1], [0, 0]];
const BOX_CHARS = [
	[139, 138, 137, 136, 134, 129, 132, 131], // thin inner
	[128, 130, 133, 135, 129, 134, 131, 132], // thin outer
	[128, 141, 140, 135, 129, 134, 131, 132], // corner outer
	[153, 152, 151, 150, 148, 143, 146, 145], // thick inner
	[142, 144, 147, 149, 143, 148, 145, 146], // thick outer
];

export function draw_box(xs, ys, xe, ye, flags) {
	let tl = BOX_COLORS[flags & BOX_SHADE_MASK][0];
	let br = BOX_COLORS[flags & BOX_SHADE_MASK][1];
	let trbl, box;

	if (status.flags & INVERTED_PALETTE) [tl, br] = [br, tl];

	switch (flags & (BOX_TYPE_MASK | BOX_THICKNESS_MASK)) {
	case BOX_THIN | BOX_INNER: trbl = br; box = 0; break;
	case BOX_THICK | BOX_INNER: trbl = tl; box = 3; break;
	case BOX_THIN | BOX_OUTER: trbl = br = tl; box = 1; break;
	case BOX_THICK | BOX_OUTER: trbl = br = tl; box = 4; break;
	case BOX_THIN | BOX_CORNER:
	case BOX_THICK | BOX_CORNER: trbl = 1; box = 2; break;
	default: return;
	}

	const b = BOX_CHARS[box];
	draw_char(b[0], xs, ys, tl, 2);
	draw_char(b[1], xe, ys, trbl, 2);
	draw_char(b[2], xs, ye, trbl, 2);
	draw_char(b[3], xe, ye, br, 2);

	for (let n = xs + 1; n < xe; n++) {
		draw_char(b[4], n, ys, tl, 2);
		draw_char(b[5], n, ye, br, 2);
	}
	for (let n = ys + 1; n < ye; n++) {
		draw_char(b[6], xs, n, tl, 2);
		draw_char(b[7], xe, n, br, 2);
	}
}

// ---------------------------------------------------------------------------
// thumb bars and VU meters

const THUMB_CHARS = [
	[155, 156, 157, 158, 159, 160, 161, 162],
	[0, 0, 0, 163, 164, 165, 166, 167],
];

function draw_thumb_bar_internal(width, x, y, val, fg) {
	let n = ++val >> 3;
	val %= 8;
	draw_fill_chars(x, y, x + n - 1, y, DEFAULT_FG, 0);
	draw_char(THUMB_CHARS[0][val], x + n, y, fg, 0);
	if (++n < width) draw_char(THUMB_CHARS[1][val], x + n, y, fg, 0);
	if (++n < width) draw_fill_chars(x + n, y, x + width - 1, y, DEFAULT_FG, 0);
}

export function draw_thumb_bar(x, y, width, min, max, val, selected) {
	if (val < min || val > max) {
		draw_fill_chars(x, y, x + width - 1, y, DEFAULT_FG, (status.flags & CLASSIC_MODE) ? 2 : 0);
		return;
	}
	val -= min;
	max -= min;
	draw_thumb_bar_internal(width, x, y,
		max ? Math.trunc(val * (width - 1) * 8 / max) : 0, selected ? 3 : 2);
}

const VU_ENDTEXT = [
	[174, 0, 0], [175, 0, 0], [176, 0, 0], [176, 177, 0],
	[176, 178, 0], [176, 179, 180], [176, 179, 181], [176, 179, 182],
];

export function draw_vu_meter(x, y, width, val, color, peak) {
	const chunks = Math.trunc(width / 3);
	const maxval = Math.trunc(width * 8 / 3);

	val = Math.min(Math.max(Math.trunc(val * width / 24), 0), maxval - 1);
	if (!val) return;

	const leftover = val & 7;
	val >>= 3;
	if (val < chunks - 1 || (status.flags & CLASSIC_MODE)) peak = color;

	draw_char(VU_ENDTEXT[leftover][0], 3 * val + x + 0, y, peak, 0);
	draw_char(VU_ENDTEXT[leftover][1], 3 * val + x + 1, y, peak, 0);
	draw_char(VU_ENDTEXT[leftover][2], 3 * val + x + 2, y, peak, 0);
	while (val--) {
		draw_char(176, 3 * val + x + 0, y, color, 0);
		draw_char(179, 3 * val + x + 1, y, color, 0);
		draw_char(182, 3 * val + x + 2, y, color, 0);
	}
}

// ---------------------------------------------------------------------------
// sample / audio stream drawing. `data` is an Int8Array, Int16Array or
// Int32Array of interleaved frames; `bits` is its sample width.

function draw_sample_data_raw(r, data, bits, length, inputchans, outputchans) {
	const nh = Math.trunc(r.height / outputchans);
	const min = new Array(inputchans), max = new Array(inputchans);
	const hi = 2 ** (bits - 1) - 1, lo = -(2 ** (bits - 1));
	const div = 2 ** bits;

	length = Math.trunc(length / inputchans);
	if (length <= 0) return;

	// 32.32 fixed point, done in doubles (exact for sample lengths < 2^21 frames
	// per pixel column; rounding beyond that only moves a column boundary)
	const step = length / r.width;
	let pos = 0;

	for (let x = 0; x < r.width; x++) {
		const next = pos + step;
		let start = Math.floor(pos);
		let scanlength = Math.ceil(next) - start;
		if (start >= length) start = length - 1;
		if (start + scanlength > length) scanlength = length - start;
		if (scanlength < 1) scanlength = 1;

		min.fill(hi);
		max.fill(lo);
		for (let i = start * inputchans, e = (start + scanlength) * inputchans, c = 0; i < e; i++) {
			const v = data[i];
			if (v < min[c]) min[c] = v;
			if (v > max[c]) max[c] = v;
			if (++c === inputchans) c = 0;
		}

		for (let cc = 0; cc < outputchans; cc++) {
			const icc = cc % inputchans;
			const np = r.height - (nh >> 1) - nh * cc;
			const mi = Math.floor(min[icc] * nh / div);
			const ma = Math.floor(max[icc] * nh / div);
			vgamem_ovl_drawline(r, x, np - 1 - ma, x, np - 1 - mi, SAMPLE_DATA_COLOR);
		}

		pos = next;
	}
}

export function draw_sample_data_rect(r, data, bits, length, inputchans, outputchans) {
	vgamem_ovl_clear(r, 0);
	draw_sample_data_raw(r, data, bits, length, inputchans, outputchans);
	vgamem_ovl_apply(r);
}

export function draw_sample_loop_marks(r, start, end, length, colorbits) {
	const c = (status.flags & CLASSIC_MODE) ? SAMPLE_DATA_COLOR : SAMPLE_LOOP_COLOR;
	const ls = Math.trunc(start * (r.width - 1) / length);
	const le = Math.trunc(end * (r.width - 1) / length);
	for (let y = 0; y < r.height; y++) {
		const col = (colorbits & (1 << (y & 3))) ? c : 0;
		vgamem_ovl_drawpixel(r, ls, y, col);
		vgamem_ovl_drawpixel(r, le, y, col);
	}
}

// TODO(port): draw_sample_data(overlay, sample) with AdLib box, loop marks and
// play marks lands with the song/player modules (needs song_sample + voices).
export { draw_sample_data_raw };
