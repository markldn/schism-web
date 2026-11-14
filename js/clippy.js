// Browser clipboard adapter for schism/clippy.c (GPL-2.0-or-later).
import { status, NEED_UPDATE, DIALOG_NONE } from './state.js';
import { pages, handle_text_input } from './page.js';
import { active_widget } from './widget.js';

export function clipboard_paste(text) {
	text = text.replace(/\r\n?/g, '\n').replace(/\0/g, '');
	const widget = active_widget();
	if (widget?.clipboard_paste?.(0, text)) return;
	if (status.dialog_type === DIALOG_NONE && pages[status.current_page].clipboard_paste?.(0, text)) return;
	handle_text_input(text);
	status.flags |= NEED_UPDATE;
}

// Capture the destination before awaiting browser permission. Navigation while
// a permission prompt is open must not send clipboard data to another page.
export async function clippy_paste(callback) {
	const page = status.current_page, dialog = status.dialog_type, widget = active_widget();
	let text = null;
	try { text = await navigator.clipboard.readText(); } catch { /* use internal clipboard */ }
	if (status.current_page !== page || status.dialog_type !== dialog || active_widget() !== widget) return;
	callback(text);
}

export function clippy_copy(text) {
	try { navigator.clipboard?.writeText(text).catch(() => {}); } catch { /* unavailable */ }
}
