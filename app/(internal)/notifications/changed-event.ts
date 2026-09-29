/**
 * Fired on the window after an inbox row's state changes (mark read, snooze,
 * resolve, assign), so the header bell re-counts without a table changing.
 * Kept in its own file so the bell does not import the whole list.
 */
export const ACTION_ITEMS_CHANGED_EVENT = 'agencyos:action-items-changed';
