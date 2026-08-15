// What we tell the owner this connection can do — derived from the scopes, never written twice.
//
// WHY THIS IS CODE AND NOT PROSE IN A TEMPLATE.
//
// The invitation email lists what Kira will and will not be able to reach. Until now that list was
// typed by hand into two markdown templates and a script, as a FIXED set, and it said things that
// were true of one configuration and false of another:
//
//   "We only request access to files YOU explicitly share"  — true on 'picked', false on 'full'
//   "Kira CANNOT read your personal emails"                 — true on 'draft', false on 'read'
//   "Send emails on your behalf"                            — never true of the Google grant at all
//
// The last one is the instructive one. `gmail.send` is deliberately never requested (outbound goes
// through Resend so it carries the tenant's identity, the Spam Act footer and the approval gate), so
// a line promising it described a permission the consent screen would never show. The owner reads
// the list, clicks through, sees something different, and the one document whose entire job is
// earning his trust has already misdescribed itself.
//
// A wrong permission claim is not a typo. It is a consent defect: he agreed to a description, and
// the description was not what he granted. So the claims are generated from the same two choices
// that build the scope string, and `google-consent-copy.test.ts` asserts they agree with
// `scopesFor()` for every combination — if a scope moves and the copy does not, the suite goes red
// rather than an email going out.

import type { DriveAccess, GmailAccess } from './google';

export interface PermissionSummary {
  /** What the grant genuinely permits, in the owner's language. */
  can: string[];
  /**
   * What it genuinely does NOT permit. Only ever claims a limit that the SCOPES enforce — never one
   * that merely reflects how the code currently behaves, because a limit the vendor does not
   * enforce is a promise about our future good conduct, and this list reads as a guarantee.
   */
  cannot: string[];
}

const DRIVE_CAN: Record<DriveAccess, string> = {
  picked: 'Open the files you choose to share with Kira — and only those',
  readonly: 'Read the files in your Google Drive, to find quotes, invoices and client details',
  full: 'Read and edit files in your Google Drive',
};

const GMAIL_CAN: Record<GmailAccess, string[]> = {
  none: [],
  draft: ['Write a message into your Gmail drafts, for you to review and send yourself'],
  read: [
    'Write a message into your Gmail drafts, for you to review and send yourself',
    'Read your Gmail, so it can tell you whether a customer ever replied',
  ],
};

export function permissionSummary(drive: DriveAccess, gmail: GmailAccess): PermissionSummary {
  const can = [
    DRIVE_CAN[drive],
    ...GMAIL_CAN[gmail],
    // Both contacts scopes are read-only. "Other contacts" is named explicitly because it is wider
    // than people assume — it is every address Google auto-saved from mail he has sent — and finding
    // that out afterwards feels like something was hidden, even though he ticked it.
    'Look up your saved contacts, and addresses Google saved from your past emails, to find who to send to',
  ];

  const cannot: string[] = [];

  // Drive. 'picked' is the only level where the app cannot reach the rest of the Drive, and
  // 'readonly' is the only one where it cannot change anything.
  if (drive === 'picked') {
    cannot.push('Reach anything else in your Drive — it never sees the files you have not shared');
  }
  if (drive !== 'full') {
    cannot.push('Change, move or delete any of your files');
  }

  // Gmail. One statement per level, never two — at 'none', "cannot touch your email" already says
  // everything a "cannot send from Gmail" line would, and the pair reads as though the second is
  // walking back the first.
  if (gmail === 'none') {
    cannot.push('Touch your email — this connection asks for no access to your mailbox');
  } else {
    if (gmail === 'draft') {
      cannot.push('Read your email — it can only put a draft into your drafts folder');
    }
    // Stated whenever a mailbox scope IS requested, because `gmail.compose` is the scope Google
    // shows him and it reads as permission to send — there is no draft-only scope to ask for. This
    // is the line that closes the gap between what the consent screen implies and what happens:
    // `gmail.send` is never requested, so nothing here can put mail on the wire from his address.
    cannot.push('Send anything from your Gmail — outbound mail goes out for your approval first');
  }

  return { can, cannot };
}

/**
 * The one-line answer to "what am I connecting?", for the sentence above the button.
 *
 * Gmail is named only when it was actually asked for. Listing it unconditionally is how the old copy
 * came to promise a mailbox permission to owners who had chosen none.
 */
export function connectionBlurb(drive: DriveAccess, gmail: GmailAccess): string {
  const parts = [drive === 'picked' ? 'the Google Drive files you choose' : 'your Google Drive'];
  if (gmail !== 'none') parts.push('your Gmail');
  parts.push('your contacts');
  const last = parts.pop();
  return `${parts.join(', ')} and ${last}`;
}
