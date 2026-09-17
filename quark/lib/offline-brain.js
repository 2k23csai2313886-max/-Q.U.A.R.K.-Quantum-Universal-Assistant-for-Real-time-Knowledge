/**
 * Q.U.A.R.K. — compatibility shim.
 *
 * The reasoning core now lives in `lib/engine.js` (scored intents, local-first
 * routing, Hinglish + typo tolerance, Wikipedia and Stack Overflow knowledge).
 * This module re-exports it so existing imports keep working.
 */
export { offlinePlan, offlineReason, route, normalize, parseDuration, LOCAL_FIRST_THRESHOLD } from './engine.js';
