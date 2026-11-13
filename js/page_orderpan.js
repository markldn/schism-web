// Port of schism/page_orderpan.c (Schism Tracker, GPL-2.0-or-later).
import { app, provide } from './app.js';
import * as C from './sndconst.js';
import { status, PAGE, HELP, NEED_UPDATE, SONG_NEEDS_SAVE, CLASSIC_MODE } from './state.js';
import { draw_text, draw_char, draw_box, BOX_THICK, BOX_INNER, BOX_INSET, BOX_FLAT_LIGHT } from './vgamem.js';
import { KEYSYM, KEYMOD, KEY_PRESS, KEY_RELEASE, NO_MODIFIER, MOUSE_NONE, MOUSE_SCROLL_UP, MOUSE_SCROLL_DOWN } from './keyboard.js';
import { widget_create_other, widget_create_panbar, widget_create_thumbbar, widget_change_focus_to,
	MOUSE_SCROLL_LINES, str_from_num } from './widget.js';
import { pages, set_page } from './page.js';
import { current_song, song_get_mode, MODE_PLAYING, MODE_STOPPED, song_get_current_order, song_get_pattern_buf,
	song_pattern_allocate_copy, song_pattern_resize, song_pattern_install, song_set_next_order,
	song_start_at_order, song_get_channel, song_set_channel_mute, song_stop_unlocked } from './song.js';
import { csf_last_order, csf_pattern_is_empty, csf_get_num_patterns } from './csndfile.js';

const MAX_CHANNELS = 64;
let top_order = 0, current_order = 0, orderlist_cursor_pos = 0;
let saved_orderlist = new Uint8Array(256), _did_save_orderlist = 0;
const flash = t => app.status_text_flash(t);
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

function orderlist_reposition() {
	if (current_order < top_order) top_order = current_order;
	else if (current_order > top_order + 31) top_order = current_order - 31;
}
export function update_current_order() {
	draw_text(str_from_num(3, current_order), 12, 5, 5, 0);
	draw_text(str_from_num(3, csf_last_order(current_song)), 16, 5, 5, 0);
}
export function set_current_order(order) {
	current_order = clamp(order, 0, 255);
	orderlist_reposition();
	status.flags |= NEED_UPDATE;
}
export const get_current_order = () => current_order;

function step_order(dir) {
	const ol = current_song.orderlist;
	let new_order = current_order;
	const last_pattern = ol[new_order];
	do {
		new_order += dir;
		if (new_order < 0) { new_order = 0; break; }
		if (new_order > 255) { new_order = 255; break; }
	} while (!(status.flags & CLASSIC_MODE) && last_pattern === ol[new_order] && ol[new_order] === C.ORDER_SKIP);
	if (ol[new_order] < 200) {
		current_order = new_order;
		orderlist_reposition();
		app.set_current_pattern(ol[new_order]);
	}
}
export const prev_order_pattern = () => step_order(-1);
export const next_order_pattern = () => step_order(1);

function orderlist_cheater() {
	const ol = current_song.orderlist;
	if (ol[current_order] !== C.ORDER_SKIP && ol[current_order] !== C.ORDER_LAST) return;
	const cp = app.get_current_pattern();
	let best = -1, first = -1;
	for (let i = 0; i < 199; i++) {
		if (csf_pattern_is_empty(current_song, i)) {
			if (first === -1) first = i;
			if (best === -1) best = i;
		} else best = -1;
	}
	if (best === -1) best = first;
	if (best === -1) return;
	flash(`Pattern ${cp} copied to pattern ${best}, order ${current_order}`);
	const [data, rows] = song_pattern_allocate_copy(cp);
	song_pattern_resize(best, rows);
	song_pattern_install(best, data, rows);
	ol[current_order] = best;
	current_order++;
	status.flags |= SONG_NEEDS_SAVE | NEED_UPDATE;
}

function get_pattern_string(p) {
	return p === C.ORDER_SKIP ? '+++' : p === C.ORDER_LAST ? '---' : str_from_num(3, p);
}
function orderlist_draw() {
	const playing_order = song_get_mode() === MODE_PLAYING ? song_get_current_order() : -1;
	for (let pos = 0, n = top_order; pos < 32; pos++, n++) {
		draw_text(str_from_num(3, n), 2, 15 + pos, n === playing_order ? 3 : 0, 2);
		draw_text(get_pattern_string(current_song.orderlist[n]), 6, 15 + pos, 2, 0);
	}
	if (app.active_page().selected_widget === 0) {
		const buf = get_pattern_string(current_song.orderlist[current_order]);
		draw_char(buf.charCodeAt(orderlist_cursor_pos), orderlist_cursor_pos + 6, 15 + current_order - top_order, 0, 3);
	}
}

function orderlist_insert_pos() {
	const ol = current_song.orderlist;
	ol.copyWithin(current_order + 1, current_order, 255);
	ol[current_order] = C.ORDER_LAST;
	status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE;
}
function orderlist_save() { saved_orderlist.set(current_song.orderlist.subarray(0, 255)); _did_save_orderlist = 1; }
function orderlist_restore() {
	if (!_did_save_orderlist) return;
	const old = current_song.orderlist.slice(0, 255);
	current_song.orderlist.set(saved_orderlist.subarray(0, 255));
	saved_orderlist.set(old);
}
function orderlist_delete_pos() {
	const ol = current_song.orderlist;
	ol.copyWithin(current_order, current_order + 1, 256);
	ol[255] = C.ORDER_LAST;
	status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE;
}
function orderlist_insert_next() {
	const ol = current_song.orderlist;
	if (current_order === 0 || ol[current_order - 1] > 199) return;
	ol[current_order] = Math.min(ol[current_order - 1] + 1, 199);
	if (current_order < 255) current_order++;
	orderlist_reposition();
	status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE;
}
function orderlist_add_unused_patterns() {
	const ol = current_song.orderlist, np = csf_get_num_patterns(current_song);
	const used = new Uint8Array(200);
	let n;
	for (n = 0; n < 255; n++) if (ol[n] < 200) used[ol[n]] = 1;
	while (n >= 0 && ol[n] === 0xff) n--;
	n = n === -1 ? 0 : n + 2;
	const n0 = n;
	for (let p = 0; p < np; p++) {
		if (used[p] || csf_pattern_is_empty(current_song, p)) continue;
		if (n > 255) break;
		ol[n++] = p;
	}
	if (n === n0) flash('No unused patterns');
	else {
		set_current_order(n - 1);
		set_current_order(n0);
		flash(n - n0 === 1 ? '1 unused pattern found' : `${n - n0} unused patterns found`);
	}
	status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE;
}
function orderlist_reorder() {
	orderlist_add_unused_patterns();
	const ol = current_song.orderlist;
	const np = [], mapol = new Uint8Array(256).fill(C.ORDER_LAST);
	let j = 0;
	for (let i = 0; i < 255; i++) {
		if (ol[i] === C.ORDER_LAST || ol[i] === C.ORDER_SKIP) continue;
		if (mapol[ol[i]] === C.ORDER_LAST) {
			np[j] = song_pattern_allocate_copy(ol[i]);
			mapol[ol[i]] = j;
			j++;
		}
		ol[i] = mapol[ol[i]];
	}
	for (let i = 0; i < 200; i++) {
		if (!np[i]) song_pattern_install(i, null, 64);
		else song_pattern_install(i, np[i][0], np[i][1]);
	}
	status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE;
	song_stop_unlocked(0);
}

function orderlist_handle_char(sym) {
	const ol = current_song.orderlist;
	switch (sym) {
	case '+': status.flags |= SONG_NEEDS_SAVE; ol[current_order] = C.ORDER_SKIP; orderlist_cursor_pos = 2; break;
	case '.': case '-': status.flags |= SONG_NEEDS_SAVE; ol[current_order] = C.ORDER_LAST; orderlist_cursor_pos = 2; break;
	default: {
		if (!(sym >= '0' && sym <= '9')) return 0;
		const c = sym.charCodeAt(0) - 48;
		status.flags |= SONG_NEEDS_SAVE;
		let cur = ol[current_order];
		const n = [0, 0, 0];
		if (cur < 200) { n[0] = Math.trunc(cur / 100); n[1] = Math.trunc(cur / 10) % 10; n[2] = cur % 10; }
		n[orderlist_cursor_pos] = c;
		cur = clamp(n[0] * 100 + n[1] * 10 + n[2], 0, 199);
		song_get_pattern_buf(cur);
		ol[current_order] = cur;
	}
	}
	if (orderlist_cursor_pos === 2) {
		if (current_order < 255) current_order++;
		orderlist_cursor_pos = 0;
		orderlist_reposition();
	} else orderlist_cursor_pos++;
	status.flags |= NEED_UPDATE;
	return 1;
}
function orderlist_handle_text_input_on_list(text) {
	let success = 0;
	for (const ch of text) if (!orderlist_handle_char(ch)) success = 1;
	return success;
}

function orderlist_handle_key_on_list(k) {
	const prev_order = current_order;
	let new_order = prev_order, new_cursor_pos = orderlist_cursor_pos, n, p;
	const ol = current_song.orderlist;
	if (k.mouse !== MOUSE_NONE) {
		if (k.x >= 6 && k.x <= 8 && k.y >= 15 && k.y <= 46) {
			if (k.mouse === MOUSE_SCROLL_UP) new_order -= MOUSE_SCROLL_LINES;
			else if (k.mouse === MOUSE_SCROLL_DOWN) new_order += MOUSE_SCROLL_LINES;
			else {
				if (k.state === KEY_PRESS) return 0;
				set_current_order(k.y - 15 + top_order);
				new_order = current_order;
				if (ol[current_order] !== C.ORDER_LAST && ol[current_order] !== C.ORDER_SKIP) new_cursor_pos = k.x - 6;
			}
		}
	}
	const rel = k.state === KEY_RELEASE, nm = NO_MODIFIER(k.mod);
	switch (k.sym) {
	case KEYSYM.BACKSPACE:
		if (status.flags & CLASSIC_MODE) return 0;
		if (!(k.mod & KEYMOD.ALT)) return 0;
		if (k.state === KEY_PRESS) return 1;
		if (!_did_save_orderlist) return 1;
		flash('Restored orderlist');
		orderlist_restore();
		return 1;
	case KEYSYM.RETURN: case KEYSYM.KP_ENTER:
		if (status.flags & CLASSIC_MODE) return 0;
		if (k.mod & KEYMOD.ALT) {
			if (k.state === KEY_PRESS) return 1;
			flash('Saved orderlist');
			orderlist_save();
			return 1;
		}
		// fallthrough
	// eslint-disable-next-line no-fallthrough
	case KEYSYM.g:
		if (!nm) return 0;
		if (k.state === KEY_PRESS) return 1;
		n = ol[new_order];
		while (n >= 200 && new_order > 0) n = ol[--new_order];
		if (n < 200) { app.set_current_pattern(n); set_page(PAGE.PATTERN_EDITOR); }
		return 1;
	case KEYSYM.TAB:
		if (k.mod & KEYMOD.SHIFT) { if (rel) return 1; widget_change_focus_to(33); }
		else { if (!nm) return 0; if (rel) return 1; widget_change_focus_to(1); }
		return 1;
	case KEYSYM.LEFT: if (!nm) return 0; if (rel) return 1; new_cursor_pos--; break;
	case KEYSYM.RIGHT: if (!nm) return 0; if (rel) return 1; new_cursor_pos++; break;
	case KEYSYM.HOME: if (!nm) return 0; if (rel) return 1; new_order = 0; break;
	case KEYSYM.END:
		if (!nm) return 0; if (rel) return 1;
		new_order = csf_last_order(current_song);
		if (ol[new_order] !== C.ORDER_LAST) new_order++;
		break;
	case KEYSYM.UP:
		if (k.mod & KEYMOD.CTRL) {
			if (status.flags & CLASSIC_MODE) return 0;
			if (rel) return 1;
			app.sample_set(app.sample_get_current() - 1); status.flags |= NEED_UPDATE; return 1;
		}
		if (!nm) return 0; if (rel) return 1; new_order--; break;
	case KEYSYM.DOWN:
		if (k.mod & KEYMOD.CTRL) {
			if (status.flags & CLASSIC_MODE) return 0;
			if (rel) return 1;
			app.sample_set(app.sample_get_current() + 1); status.flags |= NEED_UPDATE; return 1;
		}
		if (!nm) return 0; if (rel) return 1; new_order++; break;
	case KEYSYM.PAGEUP: if (!nm) return 0; if (rel) return 1; new_order -= 16; break;
	case KEYSYM.PAGEDOWN: if (!nm) return 0; if (rel) return 1; new_order += 16; break;
	case KEYSYM.INSERT: if (!nm) return 0; if (rel) return 1; orderlist_insert_pos(); return 1;
	case KEYSYM.DELETE: if (!nm) return 0; if (rel) return 1; orderlist_delete_pos(); return 1;
	case KEYSYM.F7: if (!(k.mod & KEYMOD.CTRL)) return 0; // fallthrough
	// eslint-disable-next-line no-fallthrough
	case KEYSYM.SPACE:
		if (rel) return 1;
		song_set_next_order(current_order);
		flash(`Playing order ${current_order} next`);
		return 1;
	case KEYSYM.F6:
		if (k.mod & KEYMOD.SHIFT) { if (rel) return 1; song_start_at_order(current_order, 0); return 1; }
		return 0;
	case KEYSYM.n:
		if (k.mod & KEYMOD.SHIFT) { if (k.state === KEY_PRESS) return 1; orderlist_cheater(); return 1; }
		if (!nm) return 0; if (rel) return 1;
		orderlist_insert_next();
		return 1;
	case KEYSYM.c:
		if (!nm) return 0;
		if (status.flags & CLASSIC_MODE) return 0;
		if (k.state === KEY_PRESS) return 1;
		p = app.get_current_pattern();
		for (n = current_order + 1; n < 256; n++) if (ol[n] === p) { new_order = n; break; }
		if (n === 256) {
			for (n = 0; n < current_order; n++) if (ol[n] === p) { new_order = n; break; }
			if (n === current_order) { flash(`Pattern ${p} not on Order List`); return 1; }
		}
		break;
	case KEYSYM.r:
		if (k.mod & KEYMOD.ALT) { if (k.state === KEY_PRESS) return 1; orderlist_reorder(); return 1; }
		return 0;
	case KEYSYM.u:
		if (k.mod & KEYMOD.ALT) { if (rel) return 1; orderlist_add_unused_patterns(); return 1; }
		return 0;
	case KEYSYM.LESS: case KEYSYM.SEMICOLON: case KEYSYM.COLON:
		if (!nm) return 0; if (rel) return 1;
		app.sample_set(app.sample_get_current() - 1); status.flags |= NEED_UPDATE; return 1;
	case KEYSYM.GREATER: case KEYSYM.QUOTE: case KEYSYM.QUOTEDBL:
		if (!nm) return 0; if (rel) return 1;
		app.sample_set(app.sample_get_current() + 1); status.flags |= NEED_UPDATE; return 1;
	default:
		if (k.mouse !== MOUSE_NONE) break;
		if (!(k.mod & (KEYMOD.CTRL | KEYMOD.ALT)) && k.text) return orderlist_handle_text_input_on_list(k.text);
		return 0;
	}
	if (new_cursor_pos < 0) new_cursor_pos = 2;
	else if (new_cursor_pos > 2) new_cursor_pos = 0;
	if (new_order !== prev_order) set_current_order(new_order);
	else if (new_cursor_pos !== orderlist_cursor_pos) orderlist_cursor_pos = new_cursor_pos;
	else return 0;
	status.flags |= NEED_UPDATE;
	return 1;
}

function order_pan_vol_draw_const() {
	draw_box(5, 14, 9, 47, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_box(30, 14, 40, 47, BOX_THICK | BOX_INNER | BOX_FLAT_LIGHT);
	draw_box(64, 14, 74, 47, BOX_THICK | BOX_INNER | BOX_FLAT_LIGHT);
	draw_char(146, 30, 14, 3, 2);
	draw_char(145, 40, 14, 3, 2);
	draw_char(146, 64, 14, 3, 2);
	draw_char(145, 74, 14, 3, 2);
}
function orderpan_draw_const() {
	order_pan_vol_draw_const();
	draw_text('L   M   R', 31, 14, 0, 3);
	draw_text('L   M   R', 65, 14, 0, 3);
}
function ordervol_draw_const() {
	order_pan_vol_draw_const();
	draw_text(' Volumes ', 31, 14, 0, 3);
	draw_text(' Volumes ', 65, 14, 0, 3);
	const sel = app.active_page().selected_widget;
	for (let n = 1; n <= 32; n++) {
		draw_text('Channel ' + str_from_num(2, n), 20, 14 + n, !(status.flags & CLASSIC_MODE) && sel === n ? 3 : 0, 2);
		draw_text('Channel ' + str_from_num(2, n + 32), 54, 14 + n, !(status.flags & CLASSIC_MODE) && sel === n + 32 ? 3 : 0, 2);
	}
}
let last_order = -1;
function order_pan_vol_playback_update() {
	const order = song_get_mode() === MODE_STOPPED ? -1 : song_get_current_order();
	if (order !== last_order) { last_order = order; status.flags |= NEED_UPDATE; }
}

let widgets_orderpan, widgets_ordervol;
function orderpan_update_values_in_song() {
	status.flags |= SONG_NEEDS_SAVE;
	for (let n = 0; n < MAX_CHANNELS; n++) {
		const chn = song_get_channel(n), d = widgets_orderpan[n + 1].d;
		chn.panning = d.value * 4;
		if (d.surround) chn.flags |= C.CHN_SURROUND; else chn.flags &= ~C.CHN_SURROUND;
		song_set_channel_mute(n, d.muted);
	}
}
function ordervol_update_values_in_song() {
	status.flags |= SONG_NEEDS_SAVE;
	for (let n = 0; n < MAX_CHANNELS; n++) song_get_channel(n).volume = widgets_ordervol[n + 1].d.value;
}
export function orderpan_recheck_muted_channels() {
	for (let n = 0; n < MAX_CHANNELS; n++) widgets_orderpan[n + 1].d.muted = song_get_channel(n).flags & C.CHN_MUTE ? 1 : 0;
	if (status.current_page === PAGE.ORDERLIST_PANNING) status.flags |= NEED_UPDATE;
}
function order_pan_vol_song_changed_cb() {
	for (let n = 0; n < MAX_CHANNELS; n++) {
		const chn = song_get_channel(n);
		const d = widgets_orderpan[n + 1].d;
		d.value = chn.panning >> 2;
		d.surround = chn.flags & C.CHN_SURROUND ? 1 : 0;
		d.muted = chn.flags & C.CHN_MUTE ? 1 : 0;
		widgets_ordervol[n + 1].d.value = chn.volume;
	}
}
function order_pan_vol_handle_key(k) {
	let n = app.active_page().selected_widget;
	if (k.state === KEY_RELEASE || !NO_MODIFIER(k.mod)) return;
	if (k.sym === KEYSYM.PAGEDOWN) n += 8;
	else if (k.sym === KEYSYM.PAGEUP) n -= 8;
	else return;
	n = clamp(n, 1, MAX_CHANNELS);
	if (app.active_page().selected_widget !== n) widget_change_focus_to(n);
}
function order_pre_key(k) {
	if (!(status.flags & CLASSIC_MODE))
		pages[PAGE.ORDERLIST_PANNING].selected_widget = pages[PAGE.ORDERLIST_VOLUMES].selected_widget = app.active_page().selected_widget;
	if (k.sym === KEYSYM.F7) {
		if (!NO_MODIFIER(k.mod)) return 0;
		if (k.state === KEY_RELEASE) return 1;
		app.play_song_from_mark_orderpan();
		return 1;
	}
	return 0;
}
function make_list() {
	const w = widget_create_other(1, orderlist_handle_key_on_list, orderlist_handle_text_input_on_list, orderlist_draw);
	Object.assign(w, { x: 6, y: 15, width: 3, height: 32 });
	return w;
}

function orderpan_load_page(page) {
	widgets_orderpan = [make_list()];
	widgets_orderpan[0].accept_text = 0;
	widgets_orderpan[1] = widget_create_panbar(20, 15, 1, 2, 33, orderpan_update_values_in_song, 1);
	for (let n = 2; n <= 32; n++) {
		widgets_orderpan[n] = widget_create_panbar(20, 14 + n, n - 1, n + 1, n + 32, orderpan_update_values_in_song, n);
		widgets_orderpan[n + 31] = widget_create_panbar(54, 13 + n, n + 30, n + 32, 0, orderpan_update_values_in_song, n + 31);
	}
	widgets_orderpan[64] = widget_create_panbar(54, 46, 63, 64, 0, orderpan_update_values_in_song, 64);
	Object.assign(page, { title: 'Order List and Panning (F11)', draw_const: orderpan_draw_const,
		song_changed_cb: order_pan_vol_song_changed_cb, playback_update: order_pan_vol_playback_update,
		pre_handle_key: order_pre_key, handle_key: order_pan_vol_handle_key,
		set_page: orderpan_recheck_muted_channels, total_widgets: 65, widgets: widgets_orderpan,
		help_index: HELP.ORDERLIST_PANNING, ported: true });
}
function ordervol_load_page(page) {
	widgets_ordervol = [make_list()];
	widgets_ordervol[0].accept_text = 1;
	widgets_ordervol[1] = widget_create_thumbbar(31, 15, 9, 1, 2, 33, ordervol_update_values_in_song, 0, 64);
	for (let n = 2; n <= 32; n++) {
		widgets_ordervol[n] = widget_create_thumbbar(31, 14 + n, 9, n - 1, n + 1, n + 32, ordervol_update_values_in_song, 0, 64);
		widgets_ordervol[n + 31] = widget_create_thumbbar(65, 13 + n, 9, n + 30, n + 32, 0, ordervol_update_values_in_song, 0, 64);
	}
	widgets_ordervol[64] = widget_create_thumbbar(65, 46, 9, 63, 64, 0, ordervol_update_values_in_song, 0, 64);
	Object.assign(page, { title: 'Order List and Channel Volume (F11)', draw_const: ordervol_draw_const,
		playback_update: order_pan_vol_playback_update, pre_handle_key: order_pre_key,
		handle_key: order_pan_vol_handle_key, total_widgets: 65, widgets: widgets_ordervol,
		help_index: HELP.ORDERLIST_VOLUME, ported: true });
}
orderpan_load_page(pages[PAGE.ORDERLIST_PANNING]);
ordervol_load_page(pages[PAGE.ORDERLIST_VOLUMES]);

export const PANS_STEREO = 0, PANS_AMIGA = 1, PANS_LEFT = 2, PANS_RIGHT = 3, PANS_MONO = 4, PANS_SLASH = 5, PANS_BACKSLASH = 6;
export function song_set_pan_scheme(scheme) {
	const chn = current_song.channels;
	const live = [...Array(MAX_CHANNELS).keys()].filter(n => !(chn[n].flags & C.CHN_MUTE));
	switch (scheme) {
	case PANS_STEREO: live.forEach(n => { chn[n].panning = n & 1 ? 256 : 0; }); break;
	case PANS_AMIGA: live.forEach(n => { chn[n].panning = (n + 1) & 2 ? 256 : 0; }); break;
	case PANS_LEFT: live.forEach(n => { chn[n].panning = 0; }); break;
	case PANS_RIGHT: live.forEach(n => { chn[n].panning = 256; }); break;
	case PANS_MONO: live.forEach(n => { chn[n].panning = 128; }); break;
	case PANS_SLASH: live.forEach((n, nc) => { chn[n].panning = 256 - Math.trunc(256 * nc / (live.length - 1)); }); break;
	case PANS_BACKSLASH: live.forEach((n, nc) => { chn[n].panning = Math.trunc(256 * nc / (live.length - 1)); }); break;
	}
	order_pan_vol_song_changed_cb();
}

provide({ update_current_order, set_current_order, get_current_order, prev_order_pattern, next_order_pattern,
	orderpan_recheck_muted_channels, song_set_pan_scheme });
