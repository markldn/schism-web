// Port of schism/page_loadmodule.c (Schism Tracker, GPL-2.0-or-later), on
// top of the browser file store in dmoz.js. The directory list gets one extra
// entry, "[Import from disk]", which opens the browser's file picker.
// Saving writes into the store and also downloads the file.
import { app, provide, optional } from './app.js';
import { status, PAGE, HELP, NEED_UPDATE, SONG_NEEDS_SAVE, CLASSIC_MODE, DIR_MODULES_CHANGED,
	DIALOG_OK, DIALOG_OK_CANCEL } from './state.js';
import { draw_text, draw_text_len, draw_char, draw_box, draw_fill_chars, DEFAULT_FG, BOX_THICK, BOX_INNER, BOX_INSET } from './vgamem.js';
import { KEYSYM, KEYMOD, KEY_PRESS, KEY_RELEASE, MOUSE_NONE, MOUSE_CLICK, MOUSE_DBLCLICK, MOUSE_SCROLL_UP, MOUSE_SCROLL_DOWN } from './keyboard.js';
import { ui, widget_create_other, widget_create_textentry, widget_create_togglebutton, widget_togglebutton_set, MOUSE_SCROLL_LINES } from './widget.js';
import { dialog_create } from './dialog.js';
import { pages, set_page, show_length_dialog } from './page.js';
import { current_song, song_load_data, song_get_filename, song_set_filename } from './song.js';
import { dmoz_read_directory, dmoz_read_file, dmoz_write_file, dmoz_remove, dmoz_path_concat, dmoz_path_normal,
	dmoz_path_get_basename, dmoz_path_get_extension, dmoz_is_dir, dmoz_file_exists, dmoz_import_files, download_file } from './dmoz.js';
import { dmoz_file_info, TYPE_MODULE_MASK, TYPE_MODULE_MOD, TYPE_MODULE_S3M, TYPE_MODULE_XM, TYPE_MODULE_IT, TYPE_SAMPLE_COMPR } from './fmt/info.js';
import { song_create_load } from './fmt/loaders.js';
import { fmt_it_save_song, fmt_s3m_save_song, fmt_mod_save_song, song_export_wav } from './fmt/savers.js';
import { csf_get_length } from './csndfile.js';

export const cfg = { dir_modules: '/', dir_samples: '/', dir_instruments: '/' };
const GLOB_DEFAULT = '*.it; *.xm; *.s3m; *.mtm; *.669; *.mod; *.d00; *.psm; *.dsm; *.mdl; *.mt2; *.stm; *.stx; *.far; *.ult; *.med; *.ptm; *.okt; *.amf; *.dmf; *.imf; *.sfx; *.mus; *.mid';
const GLOB_EXPORT = '*.wav; *.aiff; *.aif';
const IMPORT_ENTRY = '[Import from disk]';

const song_save_formats = [{ label: 'IT', ext: '.it', save: fmt_it_save_song }, { label: 'S3M', ext: '.s3m', save: fmt_s3m_save_song }, { label: 'MOD', ext: '.mod', save: fmt_mod_save_song }];
const song_export_formats = [{ label: 'WAV', ext: '.wav' }];

let top_file = 0, top_dir = 0, current_file = 0, current_dir = 0;
let flist = [], dlist = [];
const filename_entry = { value: '' }, dirname_entry = { value: '' };
let glob_list = [], glob_list_src = '';
let search_text = '';
let handle_file_entered = null;
const widgets_loadmodule = [], widgets_savemodule = [], widgets_exportmodule = [];
let widgets_exportsave = widgets_savemodule;
const sel = () => app.active_page().selected_widget;

function glob_to_regex(g) {
	return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}
function set_glob(globspec) {
	glob_list_src = globspec;
	glob_list = globspec.split(';').map(s => s.trim()).filter(Boolean).map(glob_to_regex);
	read_directory();
}
function set_default_glob(set_filename) {
	const s = status.current_page === PAGE.EXPORT_MODULE ? GLOB_EXPORT : GLOB_DEFAULT;
	if (set_filename) filename_entry.value = s;
	set_glob(s);
}
function modgrep(f) {
	if (!glob_list.length) return true;
	return glob_list.some(r => r.test(f.base)) || (f.type & TYPE_MODULE_MASK);
}
function read_directory() {
	const listing = dmoz_read_directory(cfg.dir_modules);
	flist = [];
	for (const f of listing.files) {
		const info = dmoz_file_info(f.base, f.data);
		const e = { ...f, ...info };
		if (modgrep(e)) flist.push(e);
	}
	// modules first (as dmoz sorts by type), then the rest
	flist.sort((a, b) => ((b.type & TYPE_MODULE_MASK) ? 1 : 0) - ((a.type & TYPE_MODULE_MASK) ? 1 : 0) || (a.base.toLowerCase() < b.base.toLowerCase() ? -1 : 1));
	dlist = [...listing.dirs, { path: null, base: IMPORT_ENTRY }];
	current_file = Math.min(current_file, Math.max(0, flist.length - 1));
	current_dir = Math.min(current_dir, dlist.length - 1);
}
function file_list_reposition() {
	if (current_file < top_file) top_file = current_file;
	else if (current_file > top_file + 30) top_file = current_file - 30;
	status.flags |= NEED_UPDATE;
}
function dir_list_reposition() {
	if (current_dir < top_dir) top_dir = current_dir;
	else if (current_dir > top_dir + 20) top_dir = current_dir - 20;
	status.flags |= NEED_UPDATE;
}
function change_dir(dir) {
	cfg.dir_modules = dmoz_path_normal(dir);
	dirname_entry.value = cfg.dir_modules;
	search_text = '';
	top_file = current_file = top_dir = current_dir = 0;
	read_directory();
	return 1;
}

// page-dependent stuff (load or save)
function handle_file_entered_L(path) {
	const data = dmoz_read_file(path);
	if (!data) return;
	if (song_load_data(dmoz_path_get_basename(path), data)) {
		song_set_filename(path);
		set_page(PAGE.PATTERN_EDITOR);
	} else {
		dialog_create(DIALOG_OK, 'Unrecognised file type', null, null, 0, null);
	}
}
export function song_save(filename, type) {
	const fmt = song_save_formats.find(f => f.label === type);
	if (!fmt) return 0;
	let path = filename;
	if (!path.toLowerCase().endsWith(fmt.ext) && !dmoz_path_get_extension(path)) path += fmt.ext;
	optional('log_appendf', 2, `Saving ${type} module ${dmoz_path_get_basename(path)}`);
	const bytes = fmt.save(current_song);
	dmoz_write_file(path, bytes);
	download_file(dmoz_path_get_basename(path), bytes);
	song_set_filename(path);
	status.flags &= ~SONG_NEEDS_SAVE;
	status.flags |= NEED_UPDATE | DIR_MODULES_CHANGED;
	app.status_text_flash(`Saved ${dmoz_path_get_basename(path)}`);
	return 1;
}
export async function song_export(filename, type) {
	let path = filename;
	if (!dmoz_path_get_extension(path)) path += '.wav';
	app.status_text_flash('Rendering ' + dmoz_path_get_basename(path) + '...');
	const bytes = await song_export_wav(current_song, 44100, sec => app.status_text_flash(`Rendering... ${Math.trunc(sec)} s`));
	dmoz_write_file(path, bytes);
	download_file(dmoz_path_get_basename(path), bytes);
	app.status_text_flash(`Exported ${dmoz_path_get_basename(path)} (${Math.round(bytes.length / 1024)}k)`);
	status.flags |= NEED_UPDATE;
	void type;
	return 1;
}
function do_save_song(path) {
	const exp = status.current_page === PAGE.EXPORT_MODULE;
	const filename = path || song_get_filename();
	let seltype = null;
	for (let i = 4; widgets_exportsave[i]; i++) if (widgets_exportsave[i].d.state) { seltype = widgets_exportsave[i].d.text; break; }
	set_page(PAGE.PATTERN_EDITOR);
	if (!seltype) { dialog_create(DIALOG_OK, 'Could not save file', null, null, 0, null); return; }
	if (exp) song_export(filename, seltype);
	else if (!song_save(filename, seltype)) dialog_create(DIALOG_OK, 'Could not save file', null, null, 0, null);
}
export function save_song_or_save_as() {
	const f = song_get_filename();
	if (f) {
		widgets_exportsave = widgets_savemodule;
		const fmt = song_save_formats.find(x => f.toLowerCase().endsWith(x.ext)) || song_save_formats[0];
		const path = f.toLowerCase().endsWith(fmt.ext) ? f : f.replace(/\.[^./]*$/, '') + fmt.ext;
		song_save(path.startsWith('/') ? path : dmoz_path_concat(cfg.dir_modules, path), fmt.label);
	} else set_page(PAGE.SAVE_MODULE);
}
function handle_file_entered_S(name) {
	if (dmoz_is_dir(name)) { change_dir(name); return; }
	if (dmoz_file_exists(name)) dialog_create(DIALOG_OK_CANCEL, 'Overwrite file?', () => do_save_song(name), null, 1, null);
	else do_save_song(name);
}

function get_type_color(type) {
	switch (type) {
	case TYPE_MODULE_MOD: return 2;
	case TYPE_MODULE_S3M: return 5;
	case TYPE_MODULE_XM: return 6;
	case TYPE_MODULE_IT: return 3;
	case TYPE_SAMPLE_COMPR: return 4;
	default: return 7;
	}
}

function search_redraw() {
	const first = search_text.length > 25 ? search_text.length - 25 : 0;
	draw_fill_chars(51, 37, 76, 37, DEFAULT_FG, 0);
	draw_text_len(search_text.slice(first), 25, 51, 37, 5, 0);
	if (sel() === 0 || sel() === 1) draw_char(0, 51 + search_text.length - first, 37, 0, 6);
}
function search_update() {
	const t = search_text.toLowerCase();
	if (sel() === 0) {
		const n = flist.findIndex(f => f.base.toLowerCase().startsWith(t));
		if (n >= 0) { current_file = n; file_list_reposition(); }
	} else {
		const n = dlist.findIndex(d => d.base.toLowerCase().startsWith(t));
		if (n >= 0) { current_dir = n; dir_list_reposition(); }
	}
	status.flags |= NEED_UPDATE;
}
function search_text_add_char(c) {
	if (c < 32) return 0;
	search_text += String.fromCharCode(c);
	search_update();
	return 1;
}

function both_module_draw_const() {
	draw_text('Filename', 4, 46, 0, 2);
	draw_text('Directory', 3, 47, 0, 2);
	draw_char(0, 51, 37, 0, 6);
	draw_box(2, 12, 49, 44, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_box(50, 36, 77, 38, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_box(50, 39, 77, 44, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_box(12, 45, 77, 48, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_fill_chars(13, 46, 76, 47, DEFAULT_FG, 0);
}
function load_module_draw_const() {
	both_module_draw_const();
	draw_box(50, 12, 77, 35, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_fill_chars(51, 37, 76, 37, DEFAULT_FG, 0);
}
function save_module_draw_const() {
	both_module_draw_const();
	draw_box(50, 12, 68, 35, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_fill_chars(51, 37, 67, 37, DEFAULT_FG, 0);
}
const pad = (n, w) => String(n).padStart(w, '0');
function file_list_draw() {
	let pos = 13;
	draw_fill_chars(3, 13, 48, 43, DEFAULT_FG, 0);
	if (flist.length > 0) {
		if (top_file < 0) top_file = 0;
		if (current_file < 0) current_file = 0;
		for (let n = top_file; n < flist.length && pos < 44; n++, pos++) {
			const f = flist[n];
			let fg1, fg2, bg;
			if (n === current_file && sel() === 0) { fg1 = fg2 = 0; bg = 3; }
			else { fg1 = get_type_color(f.type); fg2 = (f.type & TYPE_MODULE_MASK) ? 3 : 7; bg = 0; }
			draw_text_len(f.base, 20, 3, pos, fg1, bg);
			draw_char(168, 23, pos, 2, bg);
			draw_text_len(f.title || '', 25, 24, pos, fg2, bg);
		}
		const f = flist[current_file];
		if (f) {
			const d = new Date(f.mtime);
			draw_text_len(f.description || '', 26, 51, 40, 5, 0);
			draw_text_len(pad(f.size, 9), 26, 51, 41, 5, 0);
			draw_text_len(d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }), 26, 51, 42, 5, 0);
			draw_text_len(d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }), 26, 51, 43, 5, 0);
		}
	} else {
		if (sel() === 0) {
			draw_text('No files.', 3, 13, 0, 3);
			draw_fill_chars(12, 13, 48, 13, DEFAULT_FG, 3);
			draw_char(168, 23, 13, 2, 3);
			pos = 14;
		} else {
			draw_text('No files.', 3, 13, 7, 0);
			pos = 13;
		}
		draw_fill_chars(51, 40, 76, 43, DEFAULT_FG, 0);
		draw_text_len('Drop files on the window', 26, 51, 41, 2, 0);
		draw_text_len('or use ' + IMPORT_ENTRY, 26, 51, 42, 2, 0);
	}
	while (pos < 44) draw_char(168, 23, pos++, 2, 0);
	search_redraw();
}
function do_delete_file() {
	if (current_file < 0 || current_file >= flist.length) return;
	dmoz_remove(flist[current_file].path);
	const t = top_file, c = current_file;
	search_text = '';
	read_directory();
	top_file = t; current_file = Math.min(c, flist.length - 1);
	file_list_reposition();
}
function show_selected_song_length() {
	const f = flist[current_file];
	if (!f) return;
	const song = song_create_load(f.data);
	if (!song) return;
	app.csf_set_wave_config(song, 44100, 16, 2);
	show_length_dialog(f.base, csf_get_length(song));
}
function file_list_handle_text_input(text) {
	let ok = 0;
	for (const ch of text) if (search_text_add_char(ch.charCodeAt(0))) ok = 1;
	return ok;
}
function enter_file() {
	if (current_file < flist.length) handle_file_entered(flist[current_file].path);
	search_text = '';
}
function file_list_handle_key(k) {
	let new_file = current_file;
	switch (k.sym) {
	case KEYSYM.UP: new_file--; break;
	case KEYSYM.DOWN: new_file++; break;
	case KEYSYM.PAGEUP: new_file -= 31; break;
	case KEYSYM.PAGEDOWN: new_file += 31; break;
	case KEYSYM.HOME: new_file = 0; break;
	case KEYSYM.END: new_file = flist.length - 1; break;
	case KEYSYM.RETURN: if (k.state === KEY_PRESS) return 1; enter_file(); return 1;
	case KEYSYM.DELETE:
		if (k.state === KEY_RELEASE) return 1;
		if (flist.length > 0) dialog_create(DIALOG_OK_CANCEL, 'Delete file?', do_delete_file, null, 1, null);
		return 1;
	case KEYSYM.BACKSPACE:
		if (k.state === KEY_RELEASE) return 1;
		search_text = k.mod & KEYMOD.CTRL ? '' : search_text.slice(0, -1);
		status.flags |= NEED_UPDATE;
		return 1;
	case KEYSYM.p:
		if ((k.mod & KEYMOD.ALT) && k.state === KEY_PRESS) { show_selected_song_length(); return 1; }
		// fallthrough
	// eslint-disable-next-line no-fallthrough
	default:
		if (k.mouse === MOUSE_NONE) return k.text && k.state === KEY_PRESS ? file_list_handle_text_input(k.text) : 0;
	}
	const w = ui.widgets[0];
	if (k.mouse !== MOUSE_NONE && !(k.x >= w.x && k.x <= w.x + w.width && k.y >= w.y && k.y <= w.y + w.height)) return 0;
	switch (k.mouse) {
	case MOUSE_CLICK: if (k.state !== KEY_PRESS) return 0; new_file = k.y - 13 + top_file; break;
	case MOUSE_DBLCLICK: enter_file(); return 1;
	case MOUSE_SCROLL_UP: case MOUSE_SCROLL_DOWN:
		if (k.state === KEY_PRESS) return 0;
		top_file += k.mouse === MOUSE_SCROLL_UP ? -MOUSE_SCROLL_LINES : MOUSE_SCROLL_LINES;
		if (top_file > flist.length - 31) top_file = flist.length - 31;
		if (top_file < 0) top_file = 0;
		status.flags |= NEED_UPDATE;
		return 1;
	default: if (k.state === KEY_RELEASE) return 1;
	}
	new_file = Math.max(0, Math.min(new_file, flist.length - 1));
	if (new_file !== current_file) { current_file = new_file; file_list_reposition(); status.flags |= NEED_UPDATE; }
	return 1;
}

function dir_list_draw(width) {
	draw_fill_chars(51, 13, 51 + width - 1, 34, DEFAULT_FG, 0);
	for (let n = top_dir, pos = 13; pos < 35; n++, pos++) {
		if (n < 0) continue;
		if (n >= dlist.length) break;
		const [fg, bg] = n === current_dir && sel() === 1 ? [0, 3] : [dlist[n].path ? 5 : 2, 0];
		draw_text_len(dlist[n].base, width, 51, pos, fg, bg);
	}
	search_redraw();
}
function enter_dir() {
	const d = dlist[current_dir];
	if (!d) return;
	if (!d.path) {
		dmoz_import_files(cfg.dir_modules, names => {
			read_directory();
			const n = flist.findIndex(f => f.base === names[0]);
			if (n >= 0) { current_file = n; file_list_reposition(); ui.holder.selected_widget = 0; }
			status.flags |= NEED_UPDATE;
		});
		return;
	}
	change_dir(d.path);
	if (flist.length > 0) ui.holder.selected_widget = 0;
	status.flags |= NEED_UPDATE;
}
function dir_list_handle_key(k, width) {
	let new_dir = current_dir;
	if (k.mouse !== MOUSE_NONE) {
		if (!(k.x >= 51 && k.x <= 51 + width - 1 && k.y >= 13 && k.y <= 34)) return 0;
		switch (k.mouse) {
		case MOUSE_CLICK: new_dir = k.y - 13 + top_dir; break;
		case MOUSE_DBLCLICK: enter_dir(); return 1;
		case MOUSE_SCROLL_UP: case MOUSE_SCROLL_DOWN:
			top_dir = Math.max(0, Math.min(top_dir + (k.mouse === MOUSE_SCROLL_UP ? -MOUSE_SCROLL_LINES : MOUSE_SCROLL_LINES), dlist.length - 21));
			status.flags |= NEED_UPDATE;
			break;
		}
	}
	switch (k.sym) {
	case KEYSYM.UP: new_dir--; break;
	case KEYSYM.DOWN: new_dir++; break;
	case KEYSYM.PAGEUP: new_dir -= 21; break;
	case KEYSYM.PAGEDOWN: new_dir += 21; break;
	case KEYSYM.HOME: new_dir = 0; break;
	case KEYSYM.END: new_dir = dlist.length - 1; break;
	case KEYSYM.RETURN: if (k.state === KEY_PRESS) return 0; enter_dir(); return 1;
	case KEYSYM.BACKSPACE:
		if (k.state === KEY_RELEASE) return 0;
		search_text = k.mod & KEYMOD.CTRL ? '' : search_text.slice(0, -1);
		status.flags |= NEED_UPDATE;
		return 1;
	case KEYSYM.SLASH:
		if (k.state === KEY_RELEASE) return 0;
		if (!search_text.length && current_dir !== 0) new_dir = 0;
		else if (current_dir > 0 && dlist[current_dir].path) { change_dir(dlist[current_dir].path); return 1; }
		break;
	default:
		if (k.mouse === MOUSE_NONE) return k.text && k.state === KEY_PRESS ? file_list_handle_text_input(k.text) : 0;
	}
	if (k.state !== KEY_PRESS) return 0;
	new_dir = Math.max(0, Math.min(new_dir, dlist.length - 1));
	if (new_dir !== current_dir) { current_dir = new_dir; dir_list_reposition(); status.flags |= NEED_UPDATE; }
	return 1;
}

function filename_entered() {
	if (/[?*]/.test(filename_entry.value)) set_glob(filename_entry.value);
	else handle_file_entered(dmoz_path_concat(cfg.dir_modules, filename_entry.value));
}
function dirname_entered() {
	if (!change_dir(dirname_entry.value)) return;
	ui.holder.selected_widget = flist.length > 0 ? 0 : 1;
	status.flags |= NEED_UPDATE;
}

function load_module_set_page() {
	handle_file_entered = handle_file_entered_L;
	change_dir(cfg.dir_modules);
	pages[PAGE.LOAD_MODULE].selected_widget = flist.length > 0 ? 0 : 1;
	if (glob_list_src === GLOB_DEFAULT) filename_entry.value = glob_list_src;
	else set_default_glob(1);
}
function list_widgets(w, dir_handle_key, dir_draw, dir_width) {
	w[0] = widget_create_other(1, file_list_handle_key, file_list_handle_text_input, file_list_draw);
	Object.assign(w[0], { accept_text: 1, x: 3, y: 13, width: 45, height: 30 });
	w[1] = widget_create_other(2, dir_handle_key, file_list_handle_text_input, dir_draw);
	Object.assign(w[1], { accept_text: 1, x: 50, y: 13, width: dir_width, height: 22 });
	w[2] = widget_create_textentry(13, 46, 64, 0, 3, 3, null, filename_entry, 255);
	w[2].activate = filename_entered;
}
function load_module_load_page(page) {
	const w = widgets_loadmodule;
	list_widgets(w, k => dir_list_handle_key(k, 26), () => dir_list_draw(26), 27);
	w[0].next.left = w[0].next.right = 1;
	w[3] = widget_create_textentry(13, 47, 64, 2, 3, 0, null, dirname_entry, 255);
	w[3].activate = dirname_entered;
	Object.assign(page, { title: 'Load Module (F9)', draw_const: load_module_draw_const, set_page: load_module_set_page,
		total_widgets: 4, widgets: w, help_index: HELP.GLOBAL, ported: true });
}

function save_module_set_page() {
	handle_file_entered = handle_file_entered_S;
	change_dir(cfg.dir_modules);
	set_default_glob(0);
	filename_entry.value = '';
	app.active_page().selected_widget = 2;
	widgets_exportsave = status.current_page === PAGE.EXPORT_MODULE ? widgets_exportmodule : widgets_savemodule;
	if (status.current_page === PAGE.EXPORT_MODULE && current_song.orderlist[0] === 255)
		dialog_create(DIALOG_OK, "You're about to export a blank file...", null, null, 0, null);
}
function loadsave_song_changed() {
	const f = song_get_filename() || '';
	const i = song_save_formats.findIndex(x => f.toLowerCase().endsWith(x.ext));
	widget_togglebutton_set(widgets_savemodule, (i < 0 ? 0 : i) + 4, 0);
}
function save_module_load_page(page, do_export) {
	const w = do_export ? widgets_exportmodule : widgets_savemodule;
	list_widgets(w, k => dir_list_handle_key(k, 17), () => dir_list_draw(17), 18);
	w[0].next.left = 4; w[0].next.right = w[0].next.tab = 1;
	w[1].next.right = w[1].next.tab = 4; w[1].next.left = 0;
	w[3] = widget_create_textentry(13, 47, 64, 2, 0, 0, null, dirname_entry, 255);
	w[3].activate = dirname_entered;
	const formats = do_export ? song_export_formats : song_save_formats;
	const group = formats.map((_, c) => 4 + c).concat(-1);
	formats.forEach((f, c) => {
		w[4 + c] = widget_create_togglebutton(70, 13 + 3 * c, 5, 4 + (c === 0 ? 0 : c - 1), 4 + c + 1, 1, 2, 2, null,
			f.label, Math.trunc((5 - f.label.length) / 2) + 1, group);
		w[4 + c].next.backtab = 1;
	});
	w[4 + formats.length - 1].next.down = 2;
	w[4].d.state = 1;
	Object.assign(page, { title: do_export ? 'Export Module (Shift-F10)' : 'Save Module (F10)', widgets: w,
		draw_const: save_module_draw_const, set_page: save_module_set_page, total_widgets: 4 + formats.length,
		help_index: HELP.GLOBAL, selected_widget: 2, song_changed_cb: do_export ? null : loadsave_song_changed, ported: true });
}

load_module_load_page(pages[PAGE.LOAD_MODULE]);
save_module_load_page(pages[PAGE.SAVE_MODULE], 0);
save_module_load_page(pages[PAGE.EXPORT_MODULE], 1);

provide({ save_song_or_save_as, song_save, song_export, refresh_module_list: () => { read_directory(); status.flags |= NEED_UPDATE; } });
void CLASSIC_MODE;
