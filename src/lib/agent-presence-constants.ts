/** An open interval not heartbeated for this long means the app is gone (laptop closed, tab
 *  killed): the person is not signed in any more. The app heartbeats every minute. */
export const PRESENCE_STALE_MS = 3 * 60_000;
