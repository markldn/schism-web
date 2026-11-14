// Font file IO from schism/fonts.c, using the browser virtual disk.
// Schism Tracker, GPL-2.0-or-later.
import { font_normal, font_half_data, font_reset, make_half_width_middot } from './vgamem.js';
import { FONTS } from './gen/fonts.js';
import { dmoz_read_file, dmoz_write_file, download_file } from './dmoz.js';
import { status, NEED_UPDATE } from './state.js';
import { provide } from './app.js';

const DEFAULT_KEY = 'schism-font';
export function font_load_data(data) {
	if (data.length !== 2048 && data.length !== 4096
		&& !(data.length === 2050 && data[2049] === 2 && (data[2048] === 0x12 || data[2048] === 9))) return -1;
	if (data.length === 4096) {
		for (let n = 0; n < 2048; n++) font_normal[n] = data[n * 2] | data[n * 2 + 1];
	} else font_normal.set(data.subarray(0, 2048));
	make_half_width_middot();
	status.flags |= NEED_UPDATE;
	return 0;
}

export function font_load(filename) {
	const data = dmoz_read_file('/Fonts/' + filename);
	return data ? font_load_data(data) : -1;
}

export function font_save(filename = 'font.cfg') {
	const bytes = new Uint8Array(2050);
	bytes.set(font_normal); bytes.set([0x12, 2], 2048);
	dmoz_write_file('/Fonts/' + filename, bytes);
	if (filename.toLowerCase() === 'font.cfg') {
		try { localStorage.setItem(DEFAULT_KEY, btoa(String.fromCharCode(...font_normal))); } catch { /* disk save still works */ }
	}
	download_file(filename, bytes);
	return 0;
}

export function font_init() {
	font_half_data.set(FONTS.half_width);
	if (font_load('font.cfg') === 0) return;
	try {
		const saved = localStorage.getItem(DEFAULT_KEY);
		if (saved && font_load_data(Uint8Array.from(atob(saved), c => c.charCodeAt(0))) === 0) return;
	} catch { /* reset if storage is unavailable or corrupt */ }
	font_reset();
	status.flags |= NEED_UPDATE;
}

provide({ font_init });
