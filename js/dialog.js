// Port of schism/dialog.c (Schism Tracker, GPL-2.0-or-later).

import { status, NEED_UPDATE, CLASSIC_MODE, DIALOG_NONE, DIALOG_MENU, DIALOG_BOX, DIALOG_OK,
	DIALOG_OK_CANCEL, DIALOG_YES_NO, DIALOG_CUSTOM } from "./state.js";
import { draw_box, draw_fill_chars, draw_text, DEFAULT_FG,
	BOX_THICK, BOX_OUTER, BOX_INNER, BOX_INSET, BOX_FLAT_LIGHT } from "./vgamem.js";
import { KEYSYM, KEY_RELEASE, NO_MODIFIER } from "./keyboard.js";
import { widget_draw_widget, widget_create_button, widget_create_textentry, ui_set } from "./widget.js";
import { app, provide } from "./app.js";

/* Only four dialogs open at a time, as in C; two is the practical maximum
 * (a custom dialog with a thumbbar plus the value prompt on top). */
const dialogs = [];

const top = () => dialogs[dialogs.length - 1];

export function dialog_draw() {
	for (const d of dialogs) {
		/* draw the border and background */
		draw_box(d.x, d.y, d.x + d.w - 1, d.y + d.h - 1, BOX_THICK | BOX_OUTER | BOX_FLAT_LIGHT);
		draw_fill_chars(d.x + 1, d.y + 1, d.x + d.w - 2, d.y + d.h - 2, DEFAULT_FG, 2);

		/* then the rest of the stuff */
		if (d.draw_const) d.draw_const();
		if (d.text) draw_text(d.text, d.text_x, 27, 0, 2);

		for (let n = d.total_widgets - 1; n >= 0; n--)
			widget_draw_widget(d.widgets[n], n === d.selected_widget);
	}
}

export function dialog_destroy() {
	if (!dialogs.length) return;
	dialogs.pop();

	if (dialogs.length) {
		const d = top();
		ui_set(d.widgets, d);
		status.dialog_type = d.type;
	} else {
		const page = app.active_page();
		ui_set(page.widgets, page);
		status.dialog_type = DIALOG_NONE;
	}
	/* it's up to the calling function to redraw the page */
}

export function dialog_destroy_all() {
	while (dialogs.length) dialog_destroy();
}

function finish(which, data) {
	if (!(status.dialog_type & DIALOG_BOX)) return;
	const d = top();
	const action = d[which];
	if (data === null || data === undefined) data = d.data;
	dialog_destroy();
	if (action) action(data);
	status.flags |= NEED_UPDATE;
}

export function dialog_yes(data) { finish("action_yes", data); }
export function dialog_no(data) { finish("action_no", data); }
export function dialog_cancel(data) { finish("action_cancel", data); }
export function dialog_yes_NULL() { dialog_yes(null); }
export function dialog_no_NULL() { dialog_no(null); }
export function dialog_cancel_NULL() { dialog_cancel(null); }

export function dialog_handle_key(k) {
	if (!(status.dialog_type & DIALOG_BOX)) return 0;
	const d = top();
	const simple = status.dialog_type === DIALOG_YES_NO || status.dialog_type === DIALOG_OK_CANCEL;

	if (d.handle_key && d.handle_key(k)) return 1;

	/* this SHOULD be handling on press but the widget key handler is stealing that key. */
	if (k.state === KEY_RELEASE && NO_MODIFIER(k.mod)) {
		switch (k.sym) {
		case KEYSYM.y:
			if (simple) { dialog_yes(d.data); return 1; }
			break;
		case KEYSYM.n:
			if (status.dialog_type === DIALOG_YES_NO) {
				/* in Impulse Tracker, 'n' means cancel, not "no"!
				(results in different behavior on sample quality convert dialog) */
				if (!(status.flags & CLASSIC_MODE)) { dialog_no(d.data); return 1; }
				dialog_cancel(d.data);
				return 1;
			}
			if (status.dialog_type === DIALOG_OK_CANCEL) { dialog_cancel(d.data); return 1; }
			break;
		case KEYSYM.c:
			if (!simple) return 0;
			/* fall through */
		case KEYSYM.ESCAPE:
			dialog_cancel(d.data);
			return 1;
		case KEYSYM.o:
			if (!simple) return 0;
			/* fall through */
		case KEYSYM.RETURN:
			dialog_yes(d.data);
			return 1;
		}
	}

	return 0;
}

function new_dialog() {
	return {
		type: DIALOG_NONE, x: 0, y: 0, w: 0, h: 0, text: null, text_x: 0,
		widgets: [], selected_widget: 0, total_widgets: 0, data: null,
		draw_const: null, handle_key: null, action_yes: null, action_no: null, action_cancel: null,
	};
}

function simple_geometry(d, textlen, pad) {
	d.text_x = 40 - (textlen >> 1);
	if (textlen > 21) {
		d.x = d.text_x - pad;
		d.w = textlen + pad * 2;
	} else {
		d.x = 26;
		d.w = 29;
	}
	d.h = 8;
	d.y = 25;
}

/* type can be DIALOG_OK, DIALOG_OK_CANCEL, or DIALOG_YES_NO
 * default_widget: 0 = ok/yes, 1 = cancel/no */
export function dialog_create(type, text, action_yes, action_no, default_widget, data) {
	if (!(type & DIALOG_BOX)) return null;

	if (status.dialog_type & DIALOG_MENU) app.menu_hide();

	const d = new_dialog();
	d.text = text;
	d.data = data === undefined ? null : data;
	d.action_yes = action_yes || null;
	d.action_no = action_no || null;
	d.selected_widget = default_widget;

	switch (type) {
	case DIALOG_OK:
		/* as wide as either the ok button or the text, whichever is more */
		simple_geometry(d, text.length, 2);
		d.widgets = [widget_create_button(36, 30, 6, 0, 0, 0, 0, 0, dialog_yes_NULL, "OK", 3)];
		break;
	case DIALOG_YES_NO:
		simple_geometry(d, text.length, 4);
		d.widgets = [
			widget_create_button(30, 30, 7, 0, 0, 1, 1, 1, dialog_yes_NULL, "Yes", 3),
			widget_create_button(42, 30, 6, 1, 1, 0, 0, 0, dialog_no_NULL, "No", 3),
		];
		break;
	default:
		type = DIALOG_OK_CANCEL;
		/* the ok/cancel buttons (with borders) are 21 chars; shorter text gets padding */
		simple_geometry(d, text.length, 4);
		d.widgets = [
			widget_create_button(31, 30, 6, 0, 0, 1, 1, 1, dialog_yes_NULL, "OK", 3),
			widget_create_button(42, 30, 6, 1, 1, 0, 0, 0, dialog_cancel_NULL, "Cancel", 1),
		];
		break;
	}
	d.total_widgets = d.widgets.length;
	d.type = type;

	dialogs.push(d);
	ui_set(d.widgets, d);
	status.dialog_type = type;
	status.flags |= NEED_UPDATE;
	return d;
}

/* builds and displays a dialog with an arbitrary widget set. the caller can
 * set other properties (the yes/no/cancel callbacks, handle_key) afterwards. */
export function dialog_create_custom(x, y, w, h, dialog_widgets, dialog_total_widgets, dialog_selected_widget, draw_const, data) {
	if (status.dialog_type & DIALOG_MENU) app.menu_hide();

	const d = new_dialog();
	d.type = DIALOG_CUSTOM;
	d.x = x; d.y = y; d.w = w; d.h = h;
	d.widgets = dialog_widgets;
	d.selected_widget = dialog_selected_widget;
	d.total_widgets = dialog_total_widgets;
	d.draw_const = draw_const || null;
	d.data = data === undefined ? null : data;

	dialogs.push(d);
	status.dialog_type = DIALOG_CUSTOM;
	ui_set(d.widgets, d);
	status.flags |= NEED_UPDATE;
	return d;
}

// ---------------------------------------------------------------------------
// number / sample-number prompts

let numprompt_title = "", numprompt_secondary = "";
let numprompt_smp_pos1 = 0, numprompt_smp_pos2 = 0, numprompt_titlelen = 0;
const numprompt_buf = { value: "" };
let numprompt_widgets = [];
let numprompt_finish = null;

/* bound to the textentry's activate callback. it can't use the normal dialog_yes
handler: the prompt must be destroyed first so that the active widget is again
whatever thumbbar triggered it. */
function numprompt_value() {
	const s = numprompt_buf.value;
	dialog_destroy();
	if (/^\s*[+-]?[0-9]+$/.test(s)) numprompt_finish(parseInt(s, 10));
}

function numprompt_draw_const() {
	const w = numprompt_widgets[0];
	draw_text(numprompt_title, w.x - numprompt_titlelen - 1, w.y, 3, 2);
	draw_box(w.x - 1, w.y - 1, w.x + w.width, w.y + 1, BOX_THICK | BOX_INNER | BOX_INSET);
}

/* `initvalue` is a character code (0 for none) */
export function numprompt_create(prompt, finish_cb, initvalue) {
	const y = 26; // an indisputable fact of life

	numprompt_title = prompt;
	numprompt_titlelen = prompt.length;
	numprompt_buf.value = initvalue ? String.fromCharCode(initvalue) : "";

	/* border, padding (2 left, 1 right), frame around the entry, the entry, and the prompt */
	const dlgwidth = 2 + 3 + 2 + 4 + numprompt_titlelen;
	const dlgx = (80 - dlgwidth) >> 1;
	const entryx = dlgx + 4 + numprompt_titlelen;

	numprompt_widgets = [widget_create_textentry(entryx, y, 4, 0, 0, 0, null, numprompt_buf, 3)];
	numprompt_widgets[0].activate = numprompt_value;
	numprompt_widgets[0].d.cursor_pos = initvalue ? 1 : 0;
	numprompt_finish = finish_cb;
	dialog_create_custom(dlgx, y - 2, dlgwidth, 5, numprompt_widgets, 1, 0, numprompt_draw_const, null);
}

function strtonum99(s) {
	let n = 0, i = 0;
	if (!s) return -1;
	if (s.length > 1) {
		const c = s[0].toLowerCase().charCodeAt(0);
		if (c >= 48 && c <= 57) n = c - 48;
		else if (c >= 97 && c <= 103) n = c - 97 + 10;
		else if (c >= 104 && c <= 122) n = c - 104 + 10;
		else return -1;
		n *= 10;
		i = 1;
	}
	const c = s.charCodeAt(i);
	return c >= 48 && c <= 57 ? n + c - 48 : -1;
}

function smpprompt_draw_const() {
	const w = numprompt_widgets[0];
	draw_text(numprompt_title, numprompt_smp_pos1, 25, 0, 2);
	draw_text(numprompt_secondary, numprompt_smp_pos2, 27, 0, 2);
	draw_box(w.x - 1, w.y - 1, w.x + w.width, w.y + 1, BOX_THICK | BOX_INNER | BOX_INSET);
}

export function smpprompt_create(title, prompt, finish_cb) {
	numprompt_title = title;
	numprompt_secondary = prompt;
	numprompt_smp_pos1 = (81 - title.length) >> 1;
	numprompt_smp_pos2 = 41 - prompt.length;
	numprompt_buf.value = "";
	numprompt_widgets = [
		widget_create_textentry(42, 27, 3, 1, 1, 1, null, numprompt_buf, 2),
		widget_create_button(36, 30, 6, 0, 0, 1, 1, 1, dialog_cancel_NULL, "Cancel", 1),
	];
	numprompt_finish = finish_cb;
	const dialog = dialog_create_custom(26, 23, 29, 10, numprompt_widgets, 2, 0, smpprompt_draw_const, null);
	dialog.action_yes = () => numprompt_finish(strtonum99(numprompt_buf.value));
}

provide({ dialog_draw, dialog_destroy, dialog_destroy_all, dialog_handle_key, dialog_create,
	dialog_create_custom, numprompt_create, smpprompt_create });
