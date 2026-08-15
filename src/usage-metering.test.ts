// Does a model call actually produce a record — and does a FAILED one?
//
// The whole reason for adopting call-grain telemetry here is stated in the dispatch route: "a 429, a
// timeout, a malformed completion all look identical to 'no draft'." That is a property of
// `askModel`'s return value, which is deliberately null in all three cases and stays that way. The
// claim being made by this change is that the RECORD now distinguishes them. That claim is worth
// asserting, because it is invisible from the outside: a metering bug produces exactly what a
// working meter with no traffic produces — nothing.
//
// So both fetches are stubbed: OpenAI's, and the meter's own POST to the cockpit. That is not a
// trick, it is the only seam that exists — the meter reports over `fetch` like everything else — and
// it means these assertions run against the REAL package with the REAL config resolution rather
// than a mock of it. What is not covered: whether the cockpit accepts the body. That is the other
// side of the contract and it lives over there.
//
// The token counts matter more than they look. `prompt_tokens` -> inputTokens and
// `completion_tokens` -> outputTokens is a mapping that compiles just as happily backwards, and a
// backwards one reads as a plausible bill forever.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classifyIntent } from './drafter';

const INGEST = 'https://cockpit.test/api/ingest/usage';

interface Captured {
  calls: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}

/** Stub both legs: the OpenAI call, and the meter's report of it. */
function stubFetch(openai: { status: number; body?: unknown }): Captured {
  const captured: Captured = { calls: [], events: [] };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) === INGEST) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        captured.calls.push(...(body.calls ?? []));
        captured.events.push(...(body.events ?? []));
        return new Response('{}', { status: 200 });
      }
      // The OpenAI leg.
      return new Response(JSON.stringify(openai.body ?? {}), { status: openai.status });
    }),
  );

  return captured;
}

const okResponse = (content: unknown) => ({
  status: 200,
  body: {
    model: 'gpt-4.1-mini-2026-04-14',
    usage: { prompt_tokens: 1200, completion_tokens: 45 },
    choices: [{ message: { content: JSON.stringify(content) } }],
  },
});

const CLASSIFIED = {
  kind: 'email',
  recipient_name: null,
  recipient_email: null,
  subject: null,
  due_hint: null,
  reason_if_unsupported: null,
  delivery: 'draft',
};

beforeEach(() => {
  process.env.USAGE_INGEST_URL = INGEST;
  process.env.USAGE_INGEST_TOKEN = 'test-token';
  process.env.USAGE_PRODUCT_SLUG = 'orchestrator';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.USAGE_INGEST_URL;
  delete process.env.USAGE_INGEST_TOKEN;
  delete process.env.USAGE_PRODUCT_SLUG;
});

describe('a successful call', () => {
  it('records one call, with the operation named and the tokens the right way round', async () => {
    const captured = stubFetch(okResponse(CLASSIFIED));

    const result = await classifyIntent('sk-test', 'email dave about the wavecrest quote');
    expect(result?.kind).toBe('email');

    expect(captured.calls).toHaveLength(1);
    const call = captured.calls[0] as Record<string, unknown>;
    expect(call.operation).toBe('classify_intent');
    expect(call.provider).toBe('openai');
    expect(call.status).toBe('ok');
    // The mapping that compiles just as happily backwards.
    expect(call.inputTokens).toBe(1200);
    expect(call.outputTokens).toBe(45);
    // What we ASKED for vs what SERVED it — equal today, and the divergence is why both exist.
    expect(call.modelRequested).toBe('gpt-4.1-mini');
    expect(call.modelUsed).toBe('gpt-4.1-mini-2026-04-14');
    // The free quality signal: we asked for json_object and got one.
    expect(call.structuredValid).toBe(true);
    expect(typeof call.latencyMs).toBe('number');
  });

  it('emits the unit events alongside the call, joined by callId', async () => {
    const captured = stubFetch(okResponse(CLASSIFIED));
    await classifyIntent('sk-test', 'email dave');

    const callId = (captured.calls[0] as Record<string, unknown>).callId;
    expect(callId).toBeTruthy();
    expect(captured.events.length).toBeGreaterThan(0);
    for (const event of captured.events) expect(event.callId).toBe(callId);
  });
});

describe('a failed call — the whole point', () => {
  it('records a 429 as a rate_limit error instead of vanishing', async () => {
    const captured = stubFetch({ status: 429 });

    // The caller's contract is UNCHANGED: still null, still swallowed, still the route's decision.
    const result = await classifyIntent('sk-test', 'email dave');
    expect(result).toBeNull();

    // But it is no longer indistinguishable from "no draft".
    expect(captured.calls).toHaveLength(1);
    const call = captured.calls[0] as Record<string, unknown>;
    expect(call.status).toBe('error');
    // Separated from auth and server, which need different responses from a human.
    expect(call.errorClass).toBe('rate_limit');
    expect(call.operation).toBe('classify_intent');
  });

  it('records a 401 as auth, not as the same failure as a 429', async () => {
    const captured = stubFetch({ status: 401 });
    expect(await classifyIntent('sk-bad', 'email dave')).toBeNull();
    expect((captured.calls[0] as Record<string, unknown>).errorClass).toBe('auth');
  });

  it('records a non-JSON completion as structurally invalid rather than as an empty draft', async () => {
    const captured = stubFetch({
      status: 200,
      body: {
        model: 'gpt-4.1-mini',
        usage: { prompt_tokens: 10, completion_tokens: 2 },
        choices: [{ message: { content: 'Sure! Here is your answer:' } }],
      },
    });

    expect(await classifyIntent('sk-test', 'email dave')).toBeNull();
    const call = captured.calls[0] as Record<string, unknown>;
    expect(call.structuredValid).toBe(false);
    expect(call.status).toBe('error');
  });
});

describe('unconfigured', () => {
  it('reports nothing and changes nothing — adopting this is risk-free', async () => {
    delete process.env.USAGE_INGEST_URL;
    delete process.env.USAGE_INGEST_TOKEN;
    delete process.env.USAGE_PRODUCT_SLUG;

    const captured = stubFetch(okResponse(CLASSIFIED));
    const result = await classifyIntent('sk-test', 'email dave');

    // The product still works, and nothing was sent anywhere.
    expect(result?.kind).toBe('email');
    expect(captured.calls).toHaveLength(0);
    expect(captured.events).toHaveLength(0);
  });
});
