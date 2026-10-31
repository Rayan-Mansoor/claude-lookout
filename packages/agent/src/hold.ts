import { unlinkSync, writeFileSync } from "node:fs";

/** Work that has to leave this machine before it may sleep. */
export interface Hold {
	/** Mark work as outstanding; call the returned function once it is done or given up. */
	take(): () => void;
}

/** For when nothing needs to know. */
export const noHold: Hold = { take: () => () => {} };

/**
 * A hold kept as a marker file: present while a state change or notification is still on its
 * way out, gone once everything has been sent. Keep-awake tools can wait for it before sleeping.
 */
export function fileHold(path: string): Hold {
	let outstanding = 0;
	return {
		take() {
			if (outstanding++ === 0) {
				try {
					writeFileSync(path, `${process.pid}\n`);
				} catch {}
			}
			let released = false;
			return () => {
				if (released) return;
				released = true;
				if (--outstanding === 0) {
					try {
						unlinkSync(path);
					} catch {}
				}
			};
		},
	};
}
