// The Xero connector.
//
// Two jobs, and they are deliberately separate because they fail differently:
//
//   1. SYNC  — pull invoices into the entity index, so the sweep has real rows to find.
//   2. CONFIRM — before an effect is emitted, ask Xero whether the trigger STILL holds.
//
// Job 2 is the one that matters, and it is why the projection is safe to keep. `syncInvoices` writes
// a snapshot that is stale the instant it lands; `XeroSourceConfirmer` is the thing standing between
// that snapshot and an email. Chasing an invoice the client paid this morning is the single most
// embarrassing action this system can take, and the seed's INV-0977 exists to prove this code path
// kills it.
//
// We remain an INDEX, not a system of record (ORCHESTRATOR_SPEC §9). Xero owns the invoice. We hold
// a stable local id, the few attributes the sweep and the gate need, and a pointer home. Anything
// else stays in Xero and is fetched when it is actually needed.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { SweepEntity } from '../rules';
import type { ConfirmResult, SourceConfirmer } from '../confirm';

const XERO_API = 'https://api.xero.com/api.xro/2.0';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';

export interface XeroConnection {
  id: string;
  tenant_id: string;
  provider_org_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

/**
 * A valid access token, refreshing if needed.
 *
 * Xero access tokens last 30 minutes and REFRESH TOKENS ROTATE ON EVERY USE — the old one is dead
 * the moment the new one is issued. So the new pair is persisted before it is used, and a failure to
 * persist is fatal rather than logged: continuing with a token we did not save means the connection
 * is lost at the next refresh, with no way to recover it except asking the client to re-consent.
 */
export async function accessTokenFor(
  supabase: SupabaseClient,
  connection: XeroConnection,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const expiresAt = new Date(connection.expires_at).getTime();
  // 60s of headroom: a token that expires mid-request is indistinguishable from a revoked one.
  if (expiresAt - Date.now() > 60_000) return connection.access_token;

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: connection.refresh_token }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    await supabase.from('connections').update({ last_error: `refresh failed: ${detail}` }).eq('id', connection.id);
    throw new Error(`Xero refresh failed (${res.status}): ${detail}`);
  }
  const tok = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };

  const { error } = await supabase
    .from('connections')
    .update({
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
      last_error: null,
    })
    .eq('id', connection.id);
  if (error) {
    // Fatal on purpose — see the note above. A rotated token we failed to store is a connection we
    // have already lost; carrying on would hide that until the next refresh.
    throw new Error(`Xero token rotated but could not be saved (${error.message}) — connection would be lost.`);
  }
  return tok.access_token;
}

async function xeroGet(path: string, token: string, orgId: string): Promise<any> {
  const res = await fetch(`${XERO_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Xero-tenant-id': orgId,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Xero ${path} → ${res.status} ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

/**
 * Pull AUTHORISED (i.e. owing) sales invoices into the entity index.
 *
 * Deliberately narrow: only what the sweep's thresholds and the gate's bands actually read. Pulling
 * the whole ledger would make us a second, worse copy of Xero — the thing §9 says not to become.
 */
export async function syncInvoices(
  supabase: SupabaseClient,
  connection: XeroConnection,
  clientId: string,
  clientSecret: string,
): Promise<{ upserted: number }> {
  const token = await accessTokenFor(supabase, connection, clientId, clientSecret);
  const data = await xeroGet(
    '/Invoices?where=Type=="ACCREC"%20AND%20Status=="AUTHORISED"&order=DueDate',
    token,
    connection.provider_org_id,
  );

  const today = new Date();
  let upserted = 0;

  for (const inv of (data.Invoices ?? []) as any[]) {
    const due = inv.DueDateString ? new Date(inv.DueDateString) : null;
    // days_overdue is DERIVED here rather than stored by Xero, and it is the column every debtor
    // rule compares against. Negative means not yet due — kept as a negative rather than clamped to
    // zero so "due in 3 days" stays distinguishable from "due today".
    const daysOverdue = due ? Math.floor((today.getTime() - due.getTime()) / 86_400_000) : null;

    const { error } = await supabase.from('entities').upsert(
      {
        tenant_id: connection.tenant_id,
        kind: 'invoice',
        mode: 'projected',
        source_system: 'xero',
        source_id: inv.InvoiceID,
        synced_at: new Date().toISOString(),
        display_name: `${inv.InvoiceNumber ?? 'Invoice'} ${inv.Contact?.Name ?? ''}`.trim(),
        email: inv.Contact?.EmailAddress ?? null,
        account_type: 'trade',
        days_overdue: daysOverdue,
        attributes: {
          amount: inv.AmountDue,
          currency: inv.CurrencyCode,
          customer: inv.Contact?.Name,
          invoice_number: inv.InvoiceNumber,
          due_date: inv.DueDateString,
          status: inv.Status,
        },
      },
      { onConflict: 'tenant_id,source_system,source_id' },
    );
    if (!error) upserted += 1;
  }

  await supabase.from('connections').update({ last_synced_at: new Date().toISOString() }).eq('id', connection.id);
  return { upserted };
}

/**
 * The decision half. Asks Xero whether this invoice is still owing, immediately before we act on it.
 *
 * `AmountDue <= 0` or a status of PAID/VOIDED/DELETED means the trigger has evaporated since the
 * sync — which is the ordinary case, not an exception: someone paid.
 */
export class XeroSourceConfirmer implements SourceConfirmer {
  readonly system = 'xero';

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly connection: XeroConnection,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  async confirm(entity: SweepEntity): Promise<ConfirmResult> {
    if (entity.kind !== 'invoice' || !entity.source_id) return { ok: true };
    try {
      const token = await accessTokenFor(this.supabase, this.connection, this.clientId, this.clientSecret);
      const data = await xeroGet(`/Invoices/${entity.source_id}`, token, this.connection.provider_org_id);
      const inv = data.Invoices?.[0];
      if (!inv) return { ok: false, reason: 'invoice no longer exists in Xero' };

      if (['PAID', 'VOIDED', 'DELETED'].includes(inv.Status)) {
        return { ok: false, reason: `source of record reports ${inv.Status} — projection was stale` };
      }
      if (typeof inv.AmountDue === 'number' && inv.AmountDue <= 0) {
        return { ok: false, reason: 'nothing outstanding at source — projection was stale' };
      }
      return { ok: true };
    } catch (e) {
      // UNREACHABLE IS NOT "PROBABLY FINE". Degrade, don't fake: an outage must not become
      // permission to chase people from a snapshot nobody can verify.
      return { ok: false, unreachable: true, reason: `Xero unreachable: ${String((e as Error).message).slice(0, 120)}` };
    }
  }
}

/** The live connection for a tenant, or null when they have not connected (or have revoked). */
export async function xeroConnectionFor(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<XeroConnection | null> {
  const { data } = await supabase
    .from('connections')
    .select('id, tenant_id, provider_org_id, access_token, refresh_token, expires_at')
    .eq('tenant_id', tenantId)
    .eq('provider', 'xero')
    .is('revoked_at', null)
    .maybeSingle();
  return (data as XeroConnection) ?? null;
}
