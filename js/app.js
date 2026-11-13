// Late-bound function table shared by all modules.
//
// The C source calls freely across files (menu.c -> page.c -> song.c ...).
// Modules register what they implement here; anything not ported yet resolves
// to a stub that flashes a message, so missing pieces are visible instead of
// silently doing nothing. See PORTING.md for the status of each C file.

const impl = Object.create(null);
const missing = new Set();

export const app = new Proxy(impl, {
	get(target, name) {
		if (name in target) return target[name];
		return (...args) => {
			if (!missing.has(name)) {
				missing.add(name);
				console.warn(`not ported yet: ${String(name)}()`);
			}
			if (target.status_text_flash) target.status_text_flash(`Not ported yet: ${String(name)}`);
			return 0;
		};
	},
});

export function provide(functions) { Object.assign(impl, functions); }
export function is_ported(name) { return name in impl; }
export function missing_calls() { return [...missing]; }
// call an implementation only if some module has provided it (no "not ported" flash)
export function optional(name, ...args) { return name in impl ? impl[name](...args) : undefined; }
