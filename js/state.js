// Port of the global tracker state from include/it.h (Schism Tracker, GPL-2.0-or-later).

export const DIALOG_NONE = 0;
export const DIALOG_MENU = 1 << 0;
export const DIALOG_MAIN_MENU = DIALOG_MENU | (1 << 1);
export const DIALOG_SUBMENU = DIALOG_MENU | (1 << 2);
export const DIALOG_BOX = 1 << 3;
export const DIALOG_OK = DIALOG_BOX | (1 << 4);
export const DIALOG_OK_CANCEL = DIALOG_BOX | (1 << 5);
export const DIALOG_YES_NO = DIALOG_BOX | (1 << 6);
export const DIALOG_CUSTOM = DIALOG_BOX | (1 << 7);

// tracker_status flags
export const NEED_UPDATE = 1 << 0;
export const INVERTED_PALETTE = 1 << 1;
export const DIR_MODULES_CHANGED = 1 << 2;
export const DIR_SAMPLES_CHANGED = 1 << 3;
export const DIR_INSTRUMENTS_CHANGED = 1 << 4;
export const CLASSIC_MODE = 1 << 5;
export const MAKE_BACKUPS = 1 << 6;
export const NUMBERED_BACKUPS = 1 << 7;
export const LAZY_REDRAW = 1 << 8;
export const SONG_NEEDS_SAVE = 1 << 9;
export const SOFTWARE_MOUSE_MOVED = 1 << 10;
export const CLIPPY_PASTE_SELECTION = 1 << 11;
export const CLIPPY_PASTE_BUFFER = 1 << 12;
export const DISKWRITER_ACTIVE = 1 << 13;
export const DISKWRITER_ACTIVE_PATTERN = 1 << 14;
export const MIDI_EVENT_CHANGED = 1 << 15;
export const STARTUP_FONTEDIT = 1 << 16;
export const META_IS_CTRL = 1 << 17;
export const ALTGR_IS_ALT = 1 << 18;
export const CRAYOLA_MODE = 1 << 20;
export const NO_NETWORK = 1 << 22;
export const MIDI_LIKE_TRACKER = 1 << 23;
export const PLAY_AFTER_LOAD = 1 << 24;

// enum tracker_time_display
export const TIME_OFF = 0, TIME_PLAY_ELAPSED = 1, TIME_PLAY_CLOCK = 2, TIME_PLAY_OFF = 3,
	TIME_ELAPSED = 4, TIME_CLOCK = 5, TIME_ABSOLUTE = 6, TIME_PLAYBACK = 7;

// enum tracker_vis_style
export const VIS_OFF = 0, VIS_FAKEMEM = 1, VIS_OSCILLOSCOPE = 2, VIS_VU_METER = 3,
	VIS_MONOSCOPE = 4, VIS_FFT = 5, VIS_SENTINEL = 6;

// enum page_numbers (include/page.h)
export const PAGE = Object.freeze(Object.fromEntries([
	"BLANK", "HELP", "ABOUT", "LOG", "PATTERN_EDITOR", "SAMPLE_LIST", "INFO", "CONFIG",
	"PREFERENCES", "MIDI", "MIDI_OUTPUT", "LOAD_MODULE", "SAVE_MODULE", "EXPORT_MODULE",
	"ORDERLIST_PANNING", "ORDERLIST_VOLUMES", "SONG_VARIABLES", "MESSAGE", "TIME_INFORMATION",
	"INSTRUMENT_LIST_GENERAL", "INSTRUMENT_LIST_VOLUME", "INSTRUMENT_LIST_PANNING",
	"INSTRUMENT_LIST_PITCH", "LOAD_SAMPLE", "LIBRARY_SAMPLE", "LOAD_INSTRUMENT",
	"LIBRARY_INSTRUMENT", "PALETTE_EDITOR", "FONT_EDIT", "WATERFALL", "MAX",
].map((n, i) => [n, i])));

// enum for help_index (include/page.h); order matches js/gen/helptext.js
export const HELP = Object.freeze(Object.fromEntries([
	"GLOBAL", "COPYRIGHT", "INFO_PAGE", "INSTRUMENT_LIST", "MESSAGE_EDITOR", "MIDI_OUTPUT",
	"ORDERLIST_PANNING", "ORDERLIST_VOLUME", "PATTERN_EDITOR", "ADLIB_SAMPLE", "SAMPLE_LIST",
	"PALETTES", "TIME_INFORMATION", "NUM_ITEMS",
].map((n, i) => [n, i])));

export const status = {
	current_page: PAGE.BLANK,
	previous_page: PAGE.BLANK,
	current_help_index: HELP.GLOBAL,
	dialog_type: DIALOG_NONE,
	flags: 0,
	time_display: TIME_PLAY_ELAPSED,
	vis_style: VIS_OSCILLOSCOPE,
	last_keysym: 0,
	last_orig_keysym: 0,
	last_keymod: 0,
	keymod: 0,
	now: new Date(),
};

export function need_update() { status.flags |= NEED_UPDATE; }
