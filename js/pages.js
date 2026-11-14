// Registers the ported pages. Each page module fills in its pages[] entry.
import './sample-edit.js';
import './page_samples.js';
import './page_instruments.js';
import './page_loadmodule.js';
import './page_loadsample.js';
import './page_info.js';
import './page_vars.js';
import './page_misc.js';
import './page_message.js';
import './page_config.js';
import './page_palette.js';
import './page_timeinfo.js';
import './page_midi.js';
import './page_waterfall.js';
import './itf.js';
import { font_init } from './fonts.js';
import { dmoz_init } from './dmoz.js';
import { optional } from './app.js';
import { status, PAGE } from './state.js';
dmoz_init().then(() => {
	font_init();
	if (status.current_page === PAGE.LOAD_MODULE) optional('refresh_module_list');
});
