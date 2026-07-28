// Read-only Xero queries, for answering an owner's question out loud.
//
// SEPARATE FROM ./xero.ts BY DESIGN. That file exists to serve the sweep: it syncs invoices into the
// entity index and confirms a trigger still holds before an effect is emitted. Its job is to decide
// whether to ACT. This file's job is to answer a question, which is a different risk profile and
// deserves a different surface — the worst outcome here is an embarrassing number, not a wrongly
// chased client.
//
// WHY A WHITELIST AND NOT A PASSTHROUGH. "Give the agent read access to everything" is the right
// instinct and the wrong implementation: an arbitrary Xero URL from a model is an injection surface,
// and Xero's read endpoints include payroll, employee records and contact histories that nobody
// asked to expose. Each resource here is named, its query is written by us, and anything not on the
// list is refused rather than attempted. Adding one is a deliberate act.
//
// GET ONLY. Every request is a GET against api.xro/2.0. Nothing in this module can create, modify,
// approve or void anything, and it is written so that adding a write would require changing the
// transport rather than passing a flag.
//
// SHAPED FOR SPEECH. Xero returns deep objects; an agent reading one aloud produces noise. Each
// resource returns the few fields a person actually asks about, already summed where the question
// is really about a total.

import type { SupabaseClient } from '@supabase/supabase-js';

import { accessTokenFor, xeroConnectionFor, type XeroConnection } from './xero';

const XERO_API = 'https://api.xero.com/api.xro/2.0';

/** Everything an owner can ask about. Not on this list = refused, never attempted. */
export const XERO_RESOURCES = [
  'bank_balances',
  'invoices_owed_to_you',
  'bills_you_owe',
  'profit_and_loss',
  'organisation',
] as const;

export type XeroResource = (typeof XERO_RESOURCES)[number];

export interface XeroReadResult {
  resource: XeroResource;
  /** Speech-shaped data. Small, flat, already totalled where a total is the real question. */
  data: Record<string, unknown>;
  /** When Xero's own figures were last updated, where it tells us. */
  asOf: string | null;
}

export class XeroNotConnected extends Error {
  constructor() {
    super('No active Xero connection for this tenant.');
    this.name = 'XeroNotConnected';
  }
}

export class XeroUnsupportedResource extends Error {
  constructor(asked: string) {
    super(`Not something we read from Xero: ${asked}`);
    this.name = 'XeroUnsupportedResource';
  }
}

async function xeroGet(
  token: string,
  connection: XeroConnection,
  path: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const url = new URL(`${XERO_API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    // GET is hard-coded rather than a parameter. A read module that can be handed a verb is a write
    // module waiting for a careless call site.
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Xero-Tenant-Id': connection.provider_org_id,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    // Xero's own message is worth keeping — "AuthorizationUnsuccessful" and "rate limit exceeded"
    // need different responses from us, and a generic failure hides which one happened.
    throw new Error(`Xero ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

function money(n: unknown): number {
  const v = typeof n === 'string' ? Number(n) : typeof n === 'number' ? n : 0;
  return Number.isFinite(v) ? v : 0;
}

/**
 * Answer one question from Xero.
 *
 * Throws XeroNotConnected when the owner has never authorised us, and XeroUnsupportedResource for
 * anything off the list — both are answers a caller can say out loud, which is the point. It never
 * returns an empty shape that reads as "nothing owing" when the truth is "we could not look".
 */
export async function readXero(
  supabase: SupabaseClient,
  tenantId: string,
  resource: string,
): Promise<XeroReadResult> {
  if (!(XERO_RESOURCES as readonly string[]).includes(resource)) {
    throw new XeroUnsupportedResource(resource);
  }
  const kind = resource as XeroResource;

  const connection = await xeroConnectionFor(supabase, tenantId);
  if (!connection) throw new XeroNotConnected();

  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('XERO_CLIENT_ID / XERO_CLIENT_SECRET not set');

  const token = await accessTokenFor(supabase, connection, clientId, clientSecret);

  switch (kind) {
    case 'organisation': {
      const raw = await xeroGet(token, connection, '/Organisation');
      const org = (raw.Organisations as Record<string, unknown>[])?.[0] ?? {};
      return {
        resource: kind,
        data: { name: org.Name ?? null, currency: org.BaseCurrency ?? null, financialYearEndDay: org.FinancialYearEndDay ?? null },
        asOf: null,
      };
    }

    case 'bank_balances': {
      const raw = await xeroGet(token, connection, '/Accounts', { where: 'Type=="BANK"' });
      const accounts = (raw.Accounts as Record<string, unknown>[]) ?? [];
      // Xero does not put a live balance on the Account record, so each one is a second call. Kept
      // deliberately serial and few — an owner has a handful of bank accounts, not hundreds.
      const balances = [];
      for (const acct of accounts.slice(0, 10)) {
        const summary = await xeroGet(token, connection, `/Reports/BankSummary`, {
          bankAccountID: String(acct.AccountID),
        });
        const rows = (((summary.Reports as Record<string, unknown>[])?.[0]?.Rows as Record<string, unknown>[]) ?? [])
          .flatMap((r) => (r.Rows as Record<string, unknown>[]) ?? []);
        const cells = (rows[0]?.Cells as Record<string, unknown>[]) ?? [];
        balances.push({
          account: acct.Name ?? null,
          closingBalance: money(cells[cells.length - 1]?.Value),
        });
      }
      return {
        resource: kind,
        data: { accounts: balances, total: balances.reduce((s, b) => s + b.closingBalance, 0) },
        asOf: new Date().toISOString(),
      };
    }

    case 'invoices_owed_to_you':
    case 'bills_you_owe': {
      const type = kind === 'invoices_owed_to_you' ? 'ACCREC' : 'ACCPAY';
      const raw = await xeroGet(token, connection, '/Invoices', {
        where: `Type=="${type}" AND Status=="AUTHORISED"`,
        order: 'DueDate ASC',
        page: '1',
      });
      const invoices = ((raw.Invoices as Record<string, unknown>[]) ?? []).filter((i) => money(i.AmountDue) > 0);
      const today = Date.now();
      const overdue = invoices.filter((i) => {
        const due = Date.parse(String(i.DueDateString ?? i.DueDate ?? ''));
        return Number.isFinite(due) && due < today;
      });
      return {
        resource: kind,
        data: {
          count: invoices.length,
          total: invoices.reduce((s, i) => s + money(i.AmountDue), 0),
          overdueCount: overdue.length,
          overdueTotal: overdue.reduce((s, i) => s + money(i.AmountDue), 0),
          // A handful of the oldest, because "who owes me" is the follow-up question every time.
          oldest: overdue.slice(0, 5).map((i) => ({
            contact: (i.Contact as Record<string, unknown>)?.Name ?? null,
            amountDue: money(i.AmountDue),
            dueDate: i.DueDateString ?? i.DueDate ?? null,
            number: i.InvoiceNumber ?? null,
          })),
        },
        asOf: new Date().toISOString(),
      };
    }

    case 'profit_and_loss': {
      const raw = await xeroGet(token, connection, '/Reports/ProfitAndLoss');
      const report = (raw.Reports as Record<string, unknown>[])?.[0] ?? {};
      const rows = (report.Rows as Record<string, unknown>[]) ?? [];
      const totals: Record<string, number> = {};
      for (const section of rows) {
        for (const row of ((section.Rows as Record<string, unknown>[]) ?? [])) {
          if (row.RowType !== 'SummaryRow') continue;
          const cells = (row.Cells as Record<string, unknown>[]) ?? [];
          const label = String(cells[0]?.Value ?? '').trim();
          if (label) totals[label] = money(cells[1]?.Value);
        }
      }
      return { resource: kind, data: { totals, period: report.ReportTitles ?? null }, asOf: String(report.ReportDate ?? '') || null };
    }
  }
}
