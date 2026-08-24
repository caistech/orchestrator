// Alert-throttle boundary: Orchestrator endpoint auth + atomic throttle decision.
//
// This is the authoritative blast-radius reducer for the public /api/kira/ask endpoint.
// The decision is atomic at the Orchestrator boundary: SELECT count + INSERT = single lock.
// Semantics preserved from Kira's original: 10m window, 5/window ceiling, 24h retention, SHA256 key.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const HEADER = 'x-orchestrator-secret';

vi.mock('@/lib/kira-supabase', () => ({
  kiraClient: vi.fn(() => stubClient),
}));

/** Minimal chainable stub of the supabase-js query builder for unanswered_alert_sends. */
function tableStub() {
  const queue: Array<{ data: unknown; error: unknown; count?: number | null }> = [];
  const push = (r: { data: unknown; error: unknown; count?: number | null }) => { queue.push(r); return builder; };
  const next = () => queue.shift() ?? { data: null, error: null, count: null };
  const builder = {
    select(_cols?: string) { return builder; },
    eq(_col: string, _val: unknown) { return builder; },
    gt(_col: string, _val: unknown) { return builder; },
    lt(_col: string, _val: unknown) { return builder; },
    insert(_values: Record<string, unknown>) { return builder; },
    delete() { return builder; },
    maybeSingle() { return Promise.resolve(next()); },
    then(resolve: (r: { data: unknown; error: unknown; count?: number | null }) => void) { resolve(next()); },
    returns: push,
  };
  return builder;
}

type TableStub = ReturnType<typeof tableStub>;
let alertTable: TableStub;
let stubClient: { from: (table: string) => TableStub };

import { POST } from '../../app/api/v1/kira/email/alert-throttle/route';

function req(body: unknown, secret?: string): Request {
  return new Request('https://orchestrator.test/v1/kira/email/alert-throttle', {
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
  alertTable = tableStub();
  stubClient = { from: (table: string) => (table === 'unanswered_alert_sends' ? alertTable : tableStub()) };
});

describe('POST /v1/kira/email/alert-throttle auth + validation', () => {
  it('refuses without a credential', async () => {
    const res = await POST(req({ utterance: 'hello' }));
    expect(res.status).toBe(401);
  });

  it('refuses kira-public credential', async () => {
    const res = await POST(req({ utterance: 'hello' }, 'public-secret'));
    expect(res.status).toBe(403);
  });

  it('rejects empty utterance', async () => {
    const res = await POST(req({ utterance: '' }, 'webhook-secret'));
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/kira/email/alert-throttle operations', () => {
  it('allows first utterance', async () => {
    // 1st count (dup check) = 0, 2nd count (ceiling) = 0, insert succeeds
    alertTable
      .returns({ data: null, count: 0, error: null })
      .returns({ data: null, count: 0, error: null })
      .returns({ data: null, error: null });
    const res = await POST(req({ utterance: 'first ask' }, 'webhook-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: '1', allowed: true });
  });

  it('rejects duplicate within 10m window', async () => {
    alertTable.returns({ data: null, count: 1, error: null });
    const res = await POST(req({ utterance: 'same ask' }, 'webhook-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: '1', allowed: false, reason: 'duplicate within the window' });
  });

  it('rejects when ceiling of 5 per window reached', async () => {
    alertTable
      .returns({ data: null, count: 0, error: null })
      .returns({ data: null, count: 5, error: null });
    const res = await POST(req({ utterance: 'sixth ask' }, 'webhook-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: '1', allowed: false, reason: 'ceiling of 5 per 10m reached' });
  });

  it('throws on DB error so Kira falls back to in-memory limiter', async () => {
    alertTable.returns({ data: null, count: null, error: { message: 'db down' } });
    const res = await POST(req({ utterance: 'boom' }, 'webhook-secret'));
    expect(res.status).toBe(500);
  });

  it('surfaces missing-Kira-config as 503', async () => {
    const { kiraClient } = await import('@/lib/kira-supabase');
    (kiraClient as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('KIRA_SUPABASE_SERVICE_ROLE_KEY / KIRA_SUPABASE_URL missing');
    });
    const res = await POST(req({ utterance: 'hi' }, 'webhook-secret'));
    expect(res.status).toBe(503);
  });
});