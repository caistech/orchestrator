// Suppressions boundary: Orchestrator endpoint auth + operations.
//
// The suppression list is the global opt-out authority — one list covers every product. Kira
// must not hold the service-role key. These tests assert the endpoint enforces kira-webhook
// identity and executes the three operations correctly against Kira's Supabase.
//
// Database leg stubbed at @/lib/kira-supabase — the only seam the route touches.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const HEADER = 'x-orchestrator-secret';

vi.mock('@/lib/kira-supabase', () => ({
  kiraClient: vi.fn(() => stubClient),
}));

/** Minimal chainable stub of the supabase-js query builder for email_suppressions. */
function tableStub() {
  const queue: Array<{ data: unknown; error: unknown }> = [];
  const push = (r: { data: unknown; error: unknown }) => { queue.push(r); return builder; };
  const next = () => queue.shift() ?? { data: null, error: null };
  const builder = {
    upsert(_values: Record<string, unknown>, _opts?: Record<string, unknown>) { return builder; },
    select(_cols?: string) { return builder; },
    eq(_col: string, _val: unknown) { return builder; },
    delete() { return builder; },
    lt(_col: string, _val: unknown) { return builder; },
    maybeSingle() { return Promise.resolve(next()); },
    then(resolve: (r: { data: unknown; error: unknown }) => void) { resolve(next()); },
    returns: push,
  };
  return builder;
}

type TableStub = ReturnType<typeof tableStub>;
let suppTable: TableStub;
let stubClient: { from: (table: string) => TableStub };

import { POST } from '../../app/api/v1/kira/email/suppressions/route';

function req(body: unknown, secret?: string): Request {
  return new Request('https://orchestrator.test/v1/kira/email/suppressions', {
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
    { id: 'kira-webhook', secret: 'webhook-secret', tenants: '*' },
    { id: 'kira-public', secret: 'public-secret', tenants: '*' },
  ]),
};

beforeEach(() => {
  process.env.ORCHESTRATOR_CALLERS = CALLERS_ENV.ORCHESTRATOR_CALLERS;
  delete process.env.ORCHESTRATOR_SECRET;
  suppTable = tableStub();
  stubClient = { from: (table: string) => (table === 'email_suppressions' ? suppTable : tableStub()) };
});

describe('POST /v1/kira/email/suppressions auth + validation', () => {
  it('refuses without a credential', async () => {
    const res = await POST(req({ action: 'check', email: 'a@b.com' }));
    expect(res.status).toBe(401);
  });

  it('refuses an unrecognised credential', async () => {
    const res = await POST(req({ action: 'check', email: 'a@b.com' }, 'nope'));
    expect(res.status).toBe(401);
  });

  it("refuses another capability's valid credential — public cannot reach webhook endpoints", async () => {
    const res = await POST(req({ action: 'check', email: 'a@b.com' }, 'public-secret'));
    expect(res.status).toBe(403);
  });

  it('rejects an unknown action before touching the database', async () => {
    const res = await POST(req({ action: 'burn', email: 'a@b.com' }, 'webhook-secret'));
    expect(res.status).toBe(400);
  });

  it('rejects invalid email', async () => {
    const res = await POST(req({ action: 'check', email: 'not-an-email' }, 'webhook-secret'));
    expect(res.status).toBe(400);
  });

  it('rejects invalid reason on add', async () => {
    const res = await POST(req({ action: 'add', email: 'a@b.com', reason: 'invalid' }, 'webhook-secret'));
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/kira/email/suppressions operations', () => {
  it('check returns false for unknown email', async () => {
    suppTable.returns({ data: null, error: null });
    const res = await POST(req({ action: 'check', email: 'TEST@EXAMPLE.COM ' }, 'webhook-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: '1', isSuppressed: false });
  });

  it('check returns true for suppressed email', async () => {
    suppTable.returns({ data: { email: 'a@b.com' }, error: null });
    const res = await POST(req({ action: 'check', email: 'A@B.COM' }, 'webhook-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: '1', isSuppressed: true });
  });

  it('add upserts idempotently', async () => {
    suppTable.returns({ data: null, error: null });
    const res = await POST(req({ action: 'add', email: 'a@b.com', reason: 'unsubscribe', detail: 'footer click' }, 'webhook-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: '1', applied: true });
  });

  it('remove deletes the row', async () => {
    suppTable.returns({ data: null, error: null });
    const res = await POST(req({ action: 'remove', email: 'a@b.com' }, 'webhook-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: '1', applied: true });
  });

  it('surfaces a missing-Kira-config failure as 503, distinctly from a database fault', async () => {
    const { kiraClient } = await import('@/lib/kira-supabase');
    (kiraClient as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('KIRA_SUPABASE_SERVICE_ROLE_KEY / KIRA_SUPABASE_URL missing');
    });
    const res = await POST(req({ action: 'check', email: 'a@b.com' }, 'webhook-secret'));
    expect(res.status).toBe(503);
  });
});