// The copy and the scopes must agree, for every level the owner can choose.
//
// The twin of `google-consent-copy.test.ts`, and it exists for the same reason: a wrong permission
// claim is a consent defect rather than a typo. Every assertion derives its expectation from
// `scopesFor()` rather than restating it, so adding a scope without updating the copy goes red.
//
// The Microsoft-specific hazard this pins is the one the Google copy never had to worry about: there
// is no per-file tier, so no level may claim "only the files you choose". That sentence is the most
// reassuring thing we could say to a cautious owner and, on this vendor, it would be false at every
// level.

import { describe, expect, it } from 'vitest';

import { scopesFor, type FilesAccess } from './microsoft';
import { connectionBlurb, permissionSummary } from './microsoft-consent-copy';

const LEVELS: FilesAccess[] = ['readonly', 'readwrite', 'all'];
const each = (fn: (level: FilesAccess) => void) => LEVELS.forEach(fn);

const text = (level: FilesAccess) => {
  const s = permissionSummary(level);
  return [...s.can, ...s.cannot].join(' | ').toLowerCase();
};

describe('the file claims track the file scope', () => {
  it('promises nothing will be changed ONLY where no write scope was requested', () => {
    each((level) => {
      const canWrite = scopesFor(level).includes('Files.ReadWrite');
      const promises = text(level).includes('change, move or delete any of your files');
      // The dangerous direction is promising immutability over a grant that can write.
      expect(promises, level).toBe(!canWrite);
    });
  });

  it('promises shared files and SharePoint are out of reach ONLY where .All was not requested', () => {
    each((level) => {
      const reachesAll = scopesFor(level).includes('Files.ReadWrite.All');
      const promises = text(level).includes('reach files shared with you by others');
      expect(promises, level).toBe(!reachesAll);
    });
  });

  it('offers to save documents back exactly when a write scope was requested', () => {
    each((level) => {
      const canWrite = scopesFor(level).includes('Files.ReadWrite');
      expect(text(level).includes('save'), level).toBe(canWrite);
    });
  });
});

describe('the promise that holds at every level', () => {
  it('never claims per-file access, because Graph has no scope that would make it true', () => {
    // The Google copy says "and only those" on `drive.file` and it is enforced. Here it would be a
    // promise about our conduct dressed as a permission boundary.
    each((level) => {
      expect(text(level), level).not.toMatch(/only those/);
      expect(text(level), level).not.toMatch(/files you (choose|pick|share)/);
    });
  });

  it('states plainly that mail is untouched — at every level, because no mail scope is asked for', () => {
    each((level) => {
      expect(scopesFor(level), level).not.toMatch(/Mail\./);
      expect(text(level), level).toContain('asks for no access to your mailbox');
    });
  });

  it('never offers reading or sending mail as a capability', () => {
    // The failure the Google module was written after: a template advertising "Send emails on your
    // behalf" as a permission the consent screen would never show.
    each((level) => {
      const can = permissionSummary(level).can.join(' ').toLowerCase();
      expect(can, level).not.toMatch(/send/);
      expect(can, level).not.toMatch(/email|outlook|mailbox/);
    });
  });

  it('says something true and non-empty at every level', () => {
    each((level) => {
      const summary = permissionSummary(level);
      expect(summary.can.length, level).toBeGreaterThan(0);
      expect(summary.cannot.length, level).toBeGreaterThan(0);
    });
  });
});

describe('the blurb above the button', () => {
  it('names SharePoint exactly when the grant actually reaches it', () => {
    each((level) => {
      const reachesAll = scopesFor(level).includes('Files.ReadWrite.All');
      expect(connectionBlurb(level).toLowerCase().includes('sharepoint'), level).toBe(reachesAll);
    });
  });

  it('does not soften the widest level — he reads this immediately before consenting', () => {
    expect(connectionBlurb('all')).toBe('your OneDrive, files shared with you, and your company SharePoint');
    expect(connectionBlurb('readwrite')).toBe('your OneDrive');
    expect(connectionBlurb('readonly')).toBe('your OneDrive');
  });
});
