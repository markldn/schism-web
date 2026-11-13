// Port of schism/menu.c (Schism Tracker, GPL-2.0-or-later).

import { status, PAGE, NEED_UPDATE, DIALOG_MENU, DIALOG_MAIN_MENU, DIALOG_SUBMENU, DIALOG_NONE } from "./state.js";
import { draw_box, draw_text_len, draw_char, draw_fill_chars, draw_text, DEFAULT_FG,
	BOX_THIN, BOX_THICK, BOX_CORNER, BOX_OUTER, BOX_INSET, BOX_OUTSET, BOX_FLAT_LIGHT, BOX_FLAT_DARK } from "./vgamem.js";
import { KEYSYM, KEY_PRESS, KEY_RELEASE, MOUSE_CLICK, MOUSE_DBLCLICK } from "./keyboard.js";
import { video_is_wm_available } from "./video.js";
import { app, provide } from "./app.js";

const MODE_STOPPED = 0, MODE_SINGLE_STEP = 4; // TODO(port): from song.h once the player lands

const main_menu = {
	x: 6, y: 11, w: 25, title: " Main Menu",
	items: [
		"File Menu...",
		"Playback Menu...",
		"View Patterns        (F2)",
		"Sample Menu...",
		"Instrument Menu...",
		"View Orders/Panning (F11)",
		"View Variables      (F12)",
		"Message Editor (Shift-F9)",
		"Settings Menu...",
		"Help!                (F1)",
	],
	num_items: 10, selected_item: 0, active_item: -1, selected_cb: main_menu_selected_cb,
};

const file_menu = {
	x: 25, y: 13, w: 22, title: "File Menu",
	items: [
		"Load...           (F9)",
		"New...        (Ctrl-N)",
		"Save Current  (Ctrl-S)",
		"Save As...       (F10)",
		"Export...  (Shift-F10)",
		"Message Log (Ctrl-F11)",
		"Quit          (Ctrl-Q)",
	],
	num_items: 7, selected_item: 0, active_item: -1, selected_cb: file_menu_selected_cb,
};

const playback_menu = {
	x: 25, y: 13, w: 27, title: " Playback Menu",
	items: [
		"Show Infopage          (F5)",
		"Play Song         (Ctrl-F5)",
		"Play Pattern           (F6)",
		"Play from Order  (Shift-F6)",
		"Play from Mark/Cursor  (F7)",
		"Stop                   (F8)",
		"Reinit Soundcard   (Ctrl-I)",
		"Driver Screen    (Shift-F5)",
		"Calculate Length   (Ctrl-P)",
	],
	num_items: 9, selected_item: 0, active_item: -1, selected_cb: playback_menu_selected_cb,
};

const sample_menu = {
	x: 25, y: 20, w: 25, title: "Sample Menu",
	items: [
		"Sample List          (F3)",
		"Sample Library  (Ctrl-F3)",
	],
	num_items: 2, selected_item: 0, active_item: -1, selected_cb: sample_menu_selected_cb,
};

const instrument_menu = {
	x: 20, y: 23, w: 29, title: "Instrument Menu",
	items: [
		"Instrument List          (F4)",
		"Instrument Library  (Ctrl-F4)",
	],
	num_items: 2, selected_item: 0, active_item: -1, selected_cb: instrument_menu_selected_cb,
};

const settings_menu = {
	x: 22, y: 25, w: 34, title: "Settings Menu",
	items: [
		"Preferences             (Shift-F5)",
		"MIDI Configuration      (Shift-F1)",
		"System Configuration     (Ctrl-F1)",
		"Palette Editor          (Ctrl-F12)",
		"Font Editor            (Shift-F12)",
		"Toggle Fullscreen (Ctrl-Alt-Enter)",
	],
	num_items: 6, selected_item: 0, active_item: -1, selected_cb: settings_menu_selected_cb,
};

/* if status.dialog_type == DIALOG_SUBMENU, use current_menu[1], else current_menu[0] */
const current_menu = [null, null];

function draw_one(menu) {
	let h = 6, n = menu.num_items;

	while (n--) {
		draw_box(2 + menu.x, 4 + menu.y + 3 * n, 5 + menu.x + menu.w, 6 + menu.y + 3 * n,
			BOX_THIN | BOX_CORNER | (n === menu.active_item ? BOX_INSET : BOX_OUTSET));
		draw_text_len(menu.items[n], menu.w, 4 + menu.x, 5 + menu.y + 3 * n,
			n === menu.selected_item ? 3 : 0, 2);
		draw_char(0, 3 + menu.x, 5 + menu.y + 3 * n, 0, 2);
		draw_char(0, 4 + menu.x + menu.w, 5 + menu.y + 3 * n, 0, 2);
		h += 3;
	}

	draw_box(menu.x, menu.y, menu.x + menu.w + 7, menu.y + h - 1, BOX_THICK | BOX_OUTER | BOX_FLAT_LIGHT);
	draw_box(menu.x + 1, menu.y + 1, menu.x + menu.w + 6, menu.y + h - 2, BOX_THIN | BOX_OUTER | BOX_FLAT_DARK);
	draw_fill_chars(menu.x + 2, menu.y + 2, menu.x + menu.w + 5, menu.y + 3, DEFAULT_FG, 2);
	draw_text(menu.title, menu.x + 6, menu.y + 2, 3, 2);
}

export function menu_draw() {
	if (!(status.dialog_type & DIALOG_MENU)) return;
	draw_one(current_menu[0]);
	if (current_menu[1]) draw_one(current_menu[1]);
}

export function menu_show() {
	app.dialog_destroy_all();
	status.dialog_type = DIALOG_MAIN_MENU;
	current_menu[0] = main_menu;
	status.flags |= NEED_UPDATE;
}

export function menu_hide() {
	if (!(status.dialog_type & DIALOG_MENU)) return;
	status.dialog_type = DIALOG_NONE;
	current_menu[0].active_item = -1;
	if (current_menu[1]) current_menu[1].active_item = -1;
	current_menu[0] = current_menu[1] = null;
	// does NOT redraw; that's up to the caller (most items switch page anyway)
}

function set_submenu(menu) {
	status.dialog_type = DIALOG_SUBMENU;
	main_menu.active_item = main_menu.selected_item;
	current_menu[1] = menu;
	status.flags |= NEED_UPDATE;
}

function main_menu_selected_cb() {
	switch (main_menu.selected_item) {
	case 0: set_submenu(file_menu); break;
	case 1: set_submenu(playback_menu); break;
	case 2: app.set_page(PAGE.PATTERN_EDITOR); break;
	case 3: set_submenu(sample_menu); break;
	case 4: set_submenu(instrument_menu); break;
	case 5: app.set_page(PAGE.ORDERLIST_PANNING); break;
	case 6: app.set_page(PAGE.SONG_VARIABLES); break;
	case 7: app.set_page(PAGE.MESSAGE); break;
	case 8:
		settings_menu.num_items = video_is_wm_available() ? 6 : 5;
		set_submenu(settings_menu);
		break;
	case 9: app.set_page(PAGE.HELP); break;
	}
}

function file_menu_selected_cb() {
	switch (file_menu.selected_item) {
	case 0: app.set_page(PAGE.LOAD_MODULE); break;
	case 1: app.new_song_dialog(); break;
	case 2: app.save_song_or_save_as(); break;
	case 3: app.set_page(PAGE.SAVE_MODULE); break;
	case 4: app.set_page(PAGE.EXPORT_MODULE); break;
	case 5: app.set_page(PAGE.LOG); break;
	case 6: app.show_exit_prompt(); break;
	}
}

function playback_menu_selected_cb() {
	switch (playback_menu.selected_item) {
	case 0:
		if (app.song_get_mode() === MODE_STOPPED
		    || (app.song_get_mode() === MODE_SINGLE_STEP && status.current_page === PAGE.INFO))
			app.song_start();
		app.set_page(PAGE.INFO);
		return;
	case 1: app.song_start(); break;
	case 2: app.song_loop_pattern(app.get_current_pattern(), 0); break;
	case 3: app.song_start_at_order(app.get_current_order(), 0); break;
	case 4: app.play_song_from_mark(); break;
	case 5: app.song_stop(); break;
	case 6: app.audio_reinit(null); break;
	case 7: app.set_page(PAGE.PREFERENCES); return;
	case 8: app.show_song_length(); return;
	}
	menu_hide();
	status.flags |= NEED_UPDATE;
}

function sample_menu_selected_cb() {
	switch (sample_menu.selected_item) {
	case 0: app.set_page(PAGE.SAMPLE_LIST); break;
	case 1: app.set_page(PAGE.LIBRARY_SAMPLE); break;
	}
}

function instrument_menu_selected_cb() {
	switch (instrument_menu.selected_item) {
	case 0: app.set_page(app.instrument_list_page()); break;
	case 1: app.set_page(PAGE.LIBRARY_INSTRUMENT); break;
	}
}

function settings_menu_selected_cb() {
	switch (settings_menu.selected_item) {
	case 0: app.set_page(PAGE.PREFERENCES); return;
	case 1: app.set_page(PAGE.MIDI); return;
	case 2: app.set_page(PAGE.CONFIG); return;
	case 3: app.set_page(PAGE.PALETTE_EDITOR); return;
	case 4: app.set_page(PAGE.FONT_EDIT); return;
	case 5: app.toggle_display_fullscreen(); break;
	}
	menu_hide();
	status.flags |= NEED_UPDATE;
}

function close_one_level() {
	current_menu[1] = null;
	if (status.dialog_type === DIALOG_SUBMENU) {
		status.dialog_type = DIALOG_MAIN_MENU;
		main_menu.active_item = -1;
	} else {
		menu_hide();
	}
}

export function menu_handle_key(k) {
	if (!(status.dialog_type & DIALOG_MENU)) return 0;

	const menu = status.dialog_type === DIALOG_SUBMENU ? current_menu[1] : current_menu[0];

	if (k.mouse) {
		if (k.mouse === MOUSE_CLICK || k.mouse === MOUSE_DBLCLICK) {
			const h = menu.num_items * 3;
			if (k.x >= menu.x + 2 && k.x <= menu.x + menu.w + 5
			    && k.y >= menu.y + 4 && k.y <= menu.y + h + 4) {
				const n = Math.trunc((k.y - 4 - menu.y) / 3);
				if (n >= 0 && n < menu.num_items) {
					menu.selected_item = n;
					if (k.state === KEY_RELEASE) {
						menu.active_item = -1;
						menu.selected_cb();
					} else {
						status.flags |= NEED_UPDATE;
						menu.active_item = n;
					}
				}
			} else if (k.state === KEY_RELEASE && (k.x < menu.x || k.x > 7 + menu.x + menu.w
				|| k.y < menu.y || k.y >= 5 + menu.y + h)) {
				close_one_level();
				status.flags |= NEED_UPDATE;
			}
		}
		return 1;
	}

	switch (k.sym) {
	case KEYSYM.ESCAPE:
		if (k.state === KEY_RELEASE) return 1;
		close_one_level();
		break;
	case KEYSYM.UP:
		if (k.state === KEY_RELEASE) return 1;
		if (menu.selected_item > 0) { menu.selected_item--; break; }
		return 1;
	case KEYSYM.DOWN:
		if (k.state === KEY_RELEASE) return 1;
		if (menu.selected_item < menu.num_items - 1) { menu.selected_item++; break; }
		return 1;
	case KEYSYM.HOME:
		if (k.state === KEY_RELEASE) return 1;
		menu.selected_item = 0;
		break;
	case KEYSYM.END:
		if (k.state === KEY_RELEASE) return 1;
		menu.selected_item = menu.num_items - 1;
		break;
	case KEYSYM.RETURN:
		if (k.state === KEY_PRESS) {
			menu.active_item = menu.selected_item;
			status.flags |= NEED_UPDATE;
			return 1;
		}
		menu.selected_cb();
		return 1;
	default:
		return 1;
	}

	status.flags |= NEED_UPDATE;
	return 1;
}

provide({ menu_show, menu_hide, menu_draw, menu_handle_key });
