// Port of schism/page_timeinfo.c (Schism Tracker, GPL-2.0-or-later).
import { provide } from './app.js';
import { status, PAGE, HELP, NEED_UPDATE, CLASSIC_MODE } from './state.js';
import { draw_text, draw_text_len, draw_char } from './vgamem.js';
import { KEYSYM, KEYMOD, KEY_PRESS, KEY_RELEASE, MOUSE_SCROLL_UP, MOUSE_SCROLL_DOWN } from './keyboard.js';
import { widget_create_other, MOUSE_SCROLL_LINES } from './widget.js';
import { pages } from './page.js';
import { current_song } from './song.js';

let display_session = 0, top_line = 0;
const hist = () => current_song.history || [];
function fat_to_date(d, t) {
	if (!d) return null;
	return new Date(1980 + (d >> 9), ((d >> 5) & 15) - 1, d & 31, t >> 11, (t >> 5) & 63, (t & 31) * 2);
}
function draw_time(secs, x, y) {
	secs = Math.min(Math.trunc(secs), 3599999);
	const s = `${String(Math.trunc(secs / 3600)).padStart(4)}:${String(Math.trunc(secs / 60) % 60).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
	draw_text_len(s, Math.min(s.length, 80 - x), x, y, 0, 2);
}
function timeinfo_redraw() {
	let total = 0;
	const module_secs = hist().reduce((a, h) => a + (h.runtime || 0), 0) / 1000;
	draw_time(module_secs, 18, 13); total += Math.trunc(module_secs);
	const session = (Date.now() - (current_song.editstart || Date.now())) / 1000;
	draw_time(session, 18, 14); total += Math.trunc(session);
	draw_time(total, 18, 16);
	for (let x = 1; x < 79; x++) draw_char(154, x, 18, 0, 2);
	if (display_session) {
		let acc = 0;
		hist().forEach((h, i) => {
			const rt = Math.trunc((h.runtime || 0) / 1000);
			acc += rt;
			if (i < top_line || i >= top_line + 29) return;
			const d = fat_to_date(h.fat_date, h.fat_time), y = 20 + i - top_line;
			if (d) {
				draw_text_len(d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }), 27, 4, y, 0, 2);
				draw_text_len(d.toLocaleTimeString(), 27, 29, y, 0, 2);
			} else draw_text('<unknown date>', 4, y, 0, 2);
			draw_time(rt, 44, y);
			draw_time(acc, 64, y);
		});
	}
	status.flags |= NEED_UPDATE; // the session clock keeps ticking
}
function timeinfo_handle_key(k) {
	if (k.sym === KEYSYM.s && k.state === KEY_RELEASE && !(status.flags & CLASSIC_MODE)) { display_session = !display_session; status.flags |= NEED_UPDATE; return 1; }
	if (k.sym === KEYSYM.GRAVE && k.state === KEY_RELEASE && (k.mod & KEYMOD.RALT) && (k.mod & KEYMOD.RSHIFT)) { display_session = !display_session; return 1; }
	if (!display_session) return 0;
	const rel = k.state === KEY_RELEASE;
	switch (k.sym) {
	case KEYSYM.UP: if (rel) return 1; top_line--; break;
	case KEYSYM.PAGEUP: if (rel) return 1; top_line -= 15; break;
	case KEYSYM.DOWN: if (rel) return 1; top_line++; break;
	case KEYSYM.PAGEDOWN: if (rel) return 1; top_line += 15; break;
	case KEYSYM.HOME: if (rel) return 1; top_line = 0; break;
	case KEYSYM.END: if (rel) return 1; top_line = hist().length; break;
	default:
		if (k.state === KEY_PRESS && k.mouse === MOUSE_SCROLL_UP) { top_line -= MOUSE_SCROLL_LINES; break; }
		if (k.state === KEY_PRESS && k.mouse === MOUSE_SCROLL_DOWN) { top_line += MOUSE_SCROLL_LINES; break; }
		return 0;
	}
	top_line = Math.max(0, Math.min(top_line, hist().length));
	status.flags |= NEED_UPDATE;
	return 1;
}
Object.assign(pages[PAGE.TIME_INFORMATION], { title: 'Time Information', ported: true, help_index: HELP.TIME_INFORMATION,
	draw_const: () => { draw_text('Module time:', 6, 13, 0, 2); draw_text('Current session:', 2, 14, 0, 2); draw_text('Total time:', 7, 16, 0, 2); },
	set_page: () => { display_session = 0; },
	widgets: [widget_create_other(0, timeinfo_handle_key, null, timeinfo_redraw)], total_widgets: 1 });
provide({});
