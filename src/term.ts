/** ANSI colours for the manager's console lines; plain text when stdout isn't a terminal or NO_COLOR is set. */
const enabled = !!process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (open: number, close: number) => (text: string) => (enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text);

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const cyan = wrap(36, 39);
export const yellow = wrap(33, 39);
