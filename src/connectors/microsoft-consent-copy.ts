// What we tell the owner a Microsoft connection can do — derived from the scopes, never written twice.
//
// The twin of `google-consent-copy.ts`, and it exists for the reason that file states: a wrong
// permission claim is not a typo, it is a consent defect. He agreed to a description, and the
// description was not what he granted.
//
// TWO THINGS HERE ARE HARDER THAN ON GOOGLE, and both push the copy in the same direction — say the
// wider thing plainly rather than the reassuring thing:
//
//   1. THERE IS NO PER-FILE TIER. Google's `drive.file` supports an honest "and only those", because
//      the vendor enforces it. Microsoft's narrowest delegated grant is the owner's whole OneDrive,
//      so no level here may claim that limit. Writing "only the files you choose" over a
//      `Files.ReadWrite` grant would be exactly the defect this module was built to end.
//   2. `all` IS WIDER THAN IT SOUNDS. `Files.ReadWrite.All` covers everything the owner can reach —
//      files colleagues have shared with him, and SharePoint document libraries belonging to the
//      business. An owner picturing "my documents" would be granting the company's. That is named
//      here in those words, because finding it out afterwards feels like something was hidden even
//      though he ticked it.

import type { FilesAccess } from './microsoft';

export interface PermissionSummary {
  /** What the grant genuinely permits, in the owner's language. */
  can: string[];
  /**
   * What it genuinely does NOT permit. Only ever claims a limit the SCOPES enforce — never one that
   * merely reflects how the code currently behaves, because a limit the vendor does not enforce is a
   * promise about our future good conduct, and this list reads as a guarantee.
   */
  cannot: string[];
}

const FILES_CAN: Record<FilesAccess, string> = {
  readonly: 'Read the files in your OneDrive, to find quotes, invoices and client details',
  readwrite: 'Read the files in your OneDrive, and save finished documents back into it',
  all: 'Read and save files across your OneDrive, files shared with you, and your company SharePoint',
};

export function permissionSummary(files: FilesAccess): PermissionSummary {
  const can = [FILES_CAN[files]];

  const cannot: string[] = [
    // Stated at every level, because mail is the thing an owner most expects a Microsoft connection
    // to reach — it is the same login as his Outlook. No mail scope is requested at all, so this is a
    // limit the grant enforces rather than a promise about our conduct.
    'Open, read or send your Outlook email — this connection asks for no access to your mailbox',
  ];

  if (files === 'readonly') {
    cannot.push('Change, move or delete any of your files');
  }

  if (files !== 'all') {
    // True at readonly and readwrite: both are scoped to his own drive, so a colleague's shared
    // folder and the company SharePoint are genuinely out of reach.
    cannot.push('Reach files shared with you by others, or anything in your company SharePoint');
  }

  return { can, cannot };
}

/**
 * The one-line answer to "what am I connecting?", for the sentence above the button.
 *
 * `all` is not softened. If the sentence he reads before clicking says "your OneDrive" and the
 * consent screen then asks for the whole tenancy, the one document whose job is earning his trust has
 * already misdescribed itself.
 */
export function connectionBlurb(files: FilesAccess): string {
  return files === 'all'
    ? 'your OneDrive, files shared with you, and your company SharePoint'
    : 'your OneDrive';
}
