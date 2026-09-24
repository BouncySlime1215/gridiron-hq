/** SELF-01b bias flags: RED stub. */
export const MIN_FIT_N = 4;
export const MIN_EVAL_N = 4;
export const OVERPAY_HORIZON_WEEKS = 4;
export const KILLED_BIASES = Object.freeze([]);
export function walkForward() { return { candidates: [] }; }
export function followEvents() { return { state: 'ok', events: [], excluded: {} }; }
export function overpayEvents() { return { state: 'ok', events: [], unscorable: {} }; }
export function selfBiasFlags() { return { state: 'ok', follow: {}, flags: [], held: 0, held_by_reason: {} }; }
