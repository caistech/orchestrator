// The beta-code boundary: pure verdicts, and the route's auth/validation shell.
//
// Two layers are asserted separately, because they fail differently. The pure functions decide
// WHOSE INVITATION STILL WORKS — a wrong branch there tells a real tester his fresh code is spent,
// and nothing in the UI would look broken. The route's shell decides WHO MAY ASK — a wrong branch
// there either locks every signup out or lets an anonymous stranger consume codes, and both of
// those are silent until someone notices real traffic failing or real codes vanishing.
//
// The database leg is stubbed at `@/lib/kira-supabase` — the only seam the route touches it through.
// That is not a trick; it is the boundary this migration created on purpose. What is NOT covered:
// whether Postgres itself honours the guarded-UPDATE lock. That is the one property the network hop
// cannot break (the UPDATE runs wholly inside Postgres) and it is asserted by the unique/guarded
// semantics in the migration, not by any client.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { checkBetaCode, normaliseBetaCode, type BetaCodeRow } from './beta-codes';

const NOW = new Date('2026-08-24T00:00:00Z');

function row(overrides: Partial<BetaCodeRow> = {}): BetaCodeRow {
  return {
    code: 'KIRA7H2K9QLM',
    email: 'tester@example.com',
    expires_at: '2099-01-01T00:00:00Z',
    redeemed_at: null,
    revoked_at: null,
    ...overrides,
  };
}

describe('normaliseBetaCode', () => {
  it('uppercases and strips separators from a pasted code', () => {
    expect(normaliseBetaCode('kira-7h2k-9qlm')).toBe('KIRA7H2K9QLM');
  });

  it('strips every non-alphanumeric, not just hyphens', () => {
    // An en-dash or non-breaking space must come out the same as a plain hyphen — the paste came
    // from a text message, and nobody retypes punctuation correctly.
    expect(normaliseBetaCode(' KIRA–7H2K\u00A09QLM.')).toBe('KIRA7H2K9QLM');
  });

  it('reduces whitespace-only input to empty so the route can refuse before querying', () => {
    expect(normaliseBetaCode('   ')).toBe('');
    expect(normaliseBetaCode(undefined as unknown as string)).toBe('');
  });
});

describe('checkBetaCode', () => {
  it('accepts a live row', () => {
    expect(checkBetaCode(row(), NOW)).toBeNull();
  });

  it('rejects a missing row as unknown', () => {
    expect(checkBetaCode(null, NOW)).toBe('unknown');
  });

  it('checks revocation before redemption — an operator kill wins over history', () => {
    const revoked = row({ revoked_at: '2026-01-01T00:00:00Z', redeemed_at: '2026-02-01T00:00:00Z' });
    expect(checkBetaCode(revoked, NOW)).toBe('revoked');
  });

  it('rejects a redeemed row', () => {
    expect(checkBetaCode(row({ redeemed_at: '2026-01-01T00:00:00Z' }), NOW)).toBe('redeemed');
  });

  it('rejects an expired row', () => {
    expect(checkBetaCode(row({ expires_at: '2026-08-23T23:59:59Z' }), NOW)).toBe('expired');
  });

  it('does not expire early on the boundary day', () => {
    expect(checkBetaCode(row({ expires_at: '2026-08-25T00:00:00Z' }), NOW)).toBeNull();
  });
});

// ── the route shell ─────────────────────────────────────────────────────────────

const HEADER = 'x-orchestrator-secret';

vi.mock('@/lib/kira-supabase', () => ({
  kiraClient: vi.fn(() => stubClient),
}));

/** Minimal chainable stub of the supabase-js query builder for beta_codes. */
function tableStub() {
  // Sequential results: peek reads the row, then claim's guarded re-read finds it gone. A single
  // fixed answer cannot express that sequence and would test the stub instead of the flow.
  const queue: Array<{ data: unknown; error: unknown }> = [];
  const push = (r: { data: unknown; error: unknown }) => {
    queue.push(r);
    return builder;
  };
  const next = () => queue.shift() ?? { data: null, error: null };
  const builder = {
    update(_values: Record<string, unknown>) { return builder; },
    select(_cols?: string) { return builder; },
    eq(_col: string, _val: unknown) { return builder; },
    is(_col: string, _val: unknown) { return builder; },
    maybeSingle() { return Promise.resolve(next()); },
    then(resolve: (r: { data: unknown; error: unknown }) => void) { resolve(next()); },
    returns: push,
  };
  return builder;
}

type TableStub = ReturnType<typeof tableStub>;
let codeTable: TableStub;
let stubClient: { from: (table: string) => TableStub };

import { POST } from '../../app/api/v1/kira/beta-codes/route';

function req(body: unknown, secret?: string): Request {
  return new Request('https://orchestrator.test/v1/kira/beta-codes', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { [HEADER]: secret } : {}),
    },
    body: JSON.stringify(body),
  });
}

const CALLERS_ENV = {
  ORCHESTRATOR_CALLERS: JSON.stringify([
    { id: 'kira-public', secret: 'public-secret', tenants: '*' },
    { id: 'kira-webhook', secret: 'webhook-secret', tenants: '*' },
  ]),
};

beforeEach(() => {
  process.env.ORCHESTRATOR_CALLERS = CALLERS_ENV.ORCHESTRATOR_CALLERS;
  delete process.env.ORCHESTRATOR_SECRET;
  codeTable = tableStub();
  stubClient = { from: (table: string) => (table === 'beta_codes' ? codeTable : tableStub()) };
});

describe('POST /v1/kira/beta-codes auth + validation', () => {
  it('refuses without a credential', async () => {
    const res = await POST(req({ action: 'peek', code: 'KIRA7H2K9QLM' }));
    expect(res.status).toBe(401);
  });

  it('refuses an unrecognised credential', async () => {
    const res = await POST(req({ action: 'peek', code: 'X' }, 'nope'));
    expect(res.status).toBe(401);
  });

  it("refuses another capability's valid credential — webhook cannot reach public endpoints", async () => {
    const res = await POST(req({ action: 'peek', code: 'X' }, 'webhook-secret'));
    expect(res.status).toBe(403);
  });

  it('rejects an unknown action before touching the database', async () => {
    const res = await POST(req({ action: 'burn', code: 'X' }, 'public-secret'));
    expect(res.status).toBe(400);
  });

  it('rejects a code that normalises to nothing', async () => {
    const res = await POST(req({ action: 'peek', code: ' -– ' }, 'public-secret'));
    expect(res.status).toBe(400);
  });

  it('requires a UUID userId only for link', async () => {
    const badLink = await POST(
      req({ action: 'link', code: 'X', userId: 'not-a-uuid' }, 'public-secret'),
    );
    expect(badLink.status).toBe(400);

    const strayUserId = await POST(
      req({ action: 'peek', code: 'X', userId: '11111111-1111-1111-1111-111111111111' }, 'public-secret'),
    );
    expect(strayUserId.status).toBe(400);
  });
});

describe('POST /v1/kira/beta-codes actions', () => {
  it('peek returns the bound email for a live code', async () => {
    codeTable.returns({
      // Deliberately includes a trailing space + mixed case: the port must behave EXACTLY like
      // Kira's peekBetaCode, which lowercases and nothing else. Trimming here while Kira does not
      // would be precisely the twin-drift the module warning forbids.
      data: { code: 'KIRA7H2K9QLM', email: 'Tester@Example.com ', expires_at: '2099-01-01T00:00:00Z', redeemed_at: null, revoked_at: null },
      error: null,
    });
    const res = await POST(req({ action: 'peek', code: 'kira-7h2k-9qlm' }, 'public-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ version: '1', ok: true, email: 'tester@example.com ' });
  });

  it('peek reports the reason enum, never the underlying state, for a used code', async () => {
    codeTable.returns({
      data: { code: 'C', email: 't@e.com', expires_at: '2099-01-01T00:00:00Z', redeemed_at: '2026-01-01T00:00:00Z', revoked_at: null },
      error: null,
    });
    const res = await POST(req({ action: 'peek', code: 'C' }, 'public-secret'));
    const body = await res.json();
    expect(body).toEqual({ version: '1', ok: false, reason: 'redeemed' });
  });

  it('claim reports already-redeemed when the guarded update wins no row', async () => {
    // First read (the peek gate) finds a live row; the guarded re-read after the update finds none —
    // another request claimed it between the two.
    codeTable
      .returns({ data: { code: 'C', email: 't@e.com', expires_at: '2099-01-01T00:00:00Z', redeemed_at: null, revoked_at: null }, error: null })
      .returns({ data: null, error: null });
    const res = await POST(req({ action: 'claim', code: 'C' }, 'public-secret'));
    const body = await res.json();
    expect(body).toEqual({ version: '1', ok: false, reason: 'redeemed' });
  });

  it('link never fails the request, but says honestly when the record was not written', async () => {
    codeTable.returns({ data: null, error: { message: 'update blocked' } });
    const res = await POST(
      req({ action: 'link', code: 'C', userId: '11111111-1111-1111-1111-111111111111' }, 'public-secret'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: '1', ok: true, applied: false });
  });

  it('release reports applied when a row was handed back', async () => {
    codeTable.returns({ data: [{ code: 'C' }], error: null });
    const res = await POST(req({ action: 'release', code: 'C' }, 'public-secret'));
    expect(await res.json()).toEqual({ version: '1', ok: true, applied: true });
  });

  it('surfaces a missing-Kira-config failure as 503, distinctly from a database fault', async () => {
    const { kiraClient } = await import('@/lib/kira-supabase');
    (kiraClient as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('KIRA_SUPABASE_SERVICE_ROLE_KEY / KIRA_SUPABASE_URL missing');
    });
    const res = await POST(req({ action: 'peek', code: 'C' }, 'public-secret'));
    expect(res.status).toBe(503);
  });
});
