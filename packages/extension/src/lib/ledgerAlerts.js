// Where the background worker leaves the latest Decision Ledger alert for a tab (chrome.storage.session: cleared when
// the browser closes), and the text "Insert into chat" pastes. The side panel shows the alert as a banner.

/** @param {number} tabId */
export const ledgerAlertKey = (tabId) => `resync.ledgerAlert.${tabId}`;

/**
 * What "Insert into chat" puts in the message box (the user decides whether to send it).
 * @param {import('@resync/shared/ledger').Decision} d
 */
export function decisionInsertText(d) {
  const who = [d.author, d.createdAt?.slice(0, 10)].filter(Boolean).join(', ');
  return [`Team decision${who ? ` (${who})` : ''}: ${d.text}`, d.reason ? `Reason: ${d.reason}` : ''].filter(Boolean).join('\n');
}
