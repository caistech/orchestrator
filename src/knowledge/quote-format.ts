// Learning how THIS business writes a quote — flow 16's standing fact.
//
// This is the "read tool" half of flow 16, and it is deliberately NOT an agent that runs per quote.
// The format is an authoritative, slow-moving fact about the business (DATA_STANDARD D1), so it is
// extracted once, versioned, stored with provenance, and read cheaply thereafter. Re-deriving it on
// every quote would cost a Drive round trip plus an extraction call each time AND would let the same
// business get a different format on Tuesday than it got on Monday from the same documents. A format
// that is not stable is not a format.
//
// DEGRADE, DON'T FAKE (DATA_STANDARD R4). Every failure here returns a REASON rather than a
// plausible default. No Drive connection, no quotes found, nothing readable, the model unavailable —
// each is a distinct, reportable state, because the caller's correct response differs: connect
// Google, point us at the folder, ask the owner to attach one, try later. A generic "could not
// extract" collapses four different fixes into one shrug. The drafter falls back to its
// business-agnostic quote in every one of those cases, which is worse output but honest output.

import type { SupabaseClient } from '@supabase/supabase-js';

import { accessTokenFor, googleConnectionFor, listFiles, readFileText, type DriveFile } from '../connectors/google';

/**
 * The shape we keep. Everything here describes HOW they write, never WHAT any one quote said —
 * copying their documents into our database is what "we own our own records completely, and nobody
 * else's business records at all" forbids.
 */
export interface QuoteFormat {
  /** Section headings in the order they appear. The single most useful thing to copy. */
  sections: string[];
  /** How they express price — "line items with unit rates", "single lump sum", "stage payments". */
  priceExpression: string | null;
  /** "exclusive" | "inclusive" | "unstated" — never guessed; unstated is a real answer. */
  taxTreatment: string | null;
  /** How the document closes — "Regards, <name>, <role>" — shape, not the person. */
  signOff: string | null;
  /** Two or three sentences a drafter can imitate. */
  toneNotes: string | null;
  /** Anything recurring that does not fit above: terms, validity period, deposit rules. */
  conventions: string[];
}

export interface StoredQuoteFormat {
  version: number;
  structure: QuoteFormat;
  sourceFiles: Array<{ id: string; name: string; modifiedTime?: string }>;
  sampleExcerpt: string | null;
  confirmedAt: string | null;
  extractedAt: string;
}

/** Why we have no format. Each maps to a DIFFERENT thing the owner or operator must do. */
export type LearnFailure =
  | 'no_google_connection'
  | 'no_quotes_found'
  | 'nothing_readable'
  | 'model_unavailable'
  | 'extraction_failed';

export type LearnResult =
  | { ok: true; format: QuoteFormat; sources: DriveFile[]; excerpt: string | null }
  | { ok: false; failure: LearnFailure; detail: string };

/**
 * How we find candidate quotes.
 *
 * Name-based, and that is a real limitation stated rather than hidden: a business that files quotes
 * as "Job 1042" is invisible to this. The alternative — reading every document in the Drive and
 * asking a model which are quotes — costs a fortune, reads things we have no business reading, and
 * is worse at it than the owner pointing us at a folder. Naming a folder is the intended escape
 * hatch (`folderId`), and it is cheaper for everyone than cleverness here.
 */
const QUOTE_NAME_HINTS = ['quote', 'quotation', 'proposal', 'estimate', 'tender'];

/** Two is not a format, it is a coincidence; more than six adds cost without adding signal. */
const MIN_SAMPLES = 2;
const MAX_SAMPLES = 6;

/** Enough of a document to see its shape. Whole quotes would blow the context and add nothing. */
const EXCERPT_CHARS = 4000;

function buildQuery(folderId?: string): string {
  const nameClauses = QUOTE_NAME_HINTS.map((hint) => `name contains '${hint}'`).join(' or ');
  const parts = [`(${nameClauses})`];
  // A folder the owner named beats any name heuristic — it is his answer to "where do you keep
  // them", and it is the escape hatch for a business whose files are called "Job 1042".
  if (folderId) parts.push(`'${folderId}' in parents`);
  return parts.join(' and ');
}

const EXTRACT_SYSTEM = `
You are given excerpts from several quotes written by ONE business. Describe the FORMAT they share —
how this business writes a quote — so another writer could produce a new quote that looks like theirs.

Describe the shape only. Do NOT carry across any client name, price, address or project detail from
the samples: you are describing a template, not summarising documents.

Reply with ONLY a JSON object:
{"sections": [ordered section headings as they appear],
 "priceExpression": "how price is presented, one phrase",
 "taxTreatment": "exclusive" | "inclusive" | "unstated",
 "signOff": "the closing shape, with the person's name replaced by <name>",
 "toneNotes": "two or three sentences a writer could imitate",
 "conventions": [recurring things: validity period, deposit terms, inclusions/exclusions style]}
Use null for anything the samples do not show. Never invent a section they do not use.
`.trim();

async function askModel(apiKey: string, system: string, user: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      console.error(`[quote-format] model → ${res.status}`);
      return null;
    }
    const json = await res.json();
    return JSON.parse(json?.choices?.[0]?.message?.content ?? '{}');
  } catch (e) {
    console.error('[quote-format] model call failed:', e);
    return null;
  }
}

/**
 * Coerce whatever the model returned into the stored shape. Missing is null, never invented.
 *
 * Exported for testing rather than for use: the "no sections means no format" rule below is the one
 * invariant here that is either exactly right or silently wrong, and asserting it through a live
 * model call would test the model rather than the rule.
 */
export function parseExtractedFormat(raw: Record<string, unknown>): QuoteFormat | null {
  const sections = Array.isArray(raw.sections) ? raw.sections.map(String).filter(Boolean) : [];
  // A format with no sections is not a format. Storing one would put a confident-looking empty
  // structure in front of the drafter, which is worse than having none — it would stop the fallback
  // to the honest business-agnostic quote from ever firing.
  if (sections.length === 0) return null;

  return {
    sections,
    priceExpression: typeof raw.priceExpression === 'string' ? raw.priceExpression : null,
    taxTreatment: typeof raw.taxTreatment === 'string' ? raw.taxTreatment : null,
    signOff: typeof raw.signOff === 'string' ? raw.signOff : null,
    toneNotes: typeof raw.toneNotes === 'string' ? raw.toneNotes : null,
    conventions: Array.isArray(raw.conventions) ? raw.conventions.map(String).filter(Boolean) : [],
  };
}

/**
 * Read the tenant's own past quotes and extract the format they share.
 *
 * Does NOT write. Persisting is `saveQuoteFormat`, kept separate so a dry run can show the operator
 * exactly what would be stored before anything is.
 */
export async function learnQuoteFormat(
  supabase: SupabaseClient,
  tenantId: string,
  options: { apiKey: string; folderId?: string; maxSamples?: number } = { apiKey: '' },
): Promise<LearnResult> {
  if (!options.apiKey) {
    return { ok: false, failure: 'model_unavailable', detail: 'OPENAI_API_KEY is not set.' };
  }

  // Refreshing a Google token needs the OAuth client's own credentials, not just the connection.
  // Their absence is an OPERATOR gap — the server is not set up — which is why it reports as
  // no_google_connection with a detail that says so, rather than as something the owner did wrong.
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      failure: 'no_google_connection',
      detail: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured on this server.',
    };
  }

  const connection = await googleConnectionFor(supabase, tenantId);
  if (!connection) {
    return {
      ok: false,
      failure: 'no_google_connection',
      detail: 'This tenant has not connected Google, so there are no past quotes to read.',
    };
  }

  let accessToken: string;
  try {
    accessToken = await accessTokenFor(supabase, connection, clientId, clientSecret);
  } catch (error) {
    // A revoked or unrefreshable grant reads identically to "never connected" from outside, so it
    // is reported with the connector's own reason rather than as a bare throw.
    return { ok: false, failure: 'no_google_connection', detail: (error as Error).message };
  }

  const files = await listFiles(accessToken, {
    query: buildQuery(options.folderId),
    pageSize: Math.max(MAX_SAMPLES * 3, 25),
  });

  if (files.length === 0) {
    return {
      ok: false,
      failure: 'no_quotes_found',
      detail:
        'No files in Drive whose name looks like a quote. If they are filed under job numbers, ' +
        'pass the folder they live in with --folder.',
    };
  }

  // Most recent first (listFiles orders by modifiedTime desc) — a format drifts, and the current one
  // is the one worth copying.
  const limit = Math.min(options.maxSamples ?? MAX_SAMPLES, MAX_SAMPLES);
  const samples: Array<{ file: DriveFile; text: string }> = [];

  for (const file of files) {
    if (samples.length >= limit) break;
    let text: string | null = null;
    try {
      text = await readFileText(accessToken, file);
    } catch (e) {
      // One unreadable file must not fail the whole extraction — a Drive full of PDFs should still
      // yield the documents we CAN read.
      console.warn(`[quote-format] skipping ${file.name}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (text && text.trim().length > 200) samples.push({ file, text: text.slice(0, EXCERPT_CHARS) });
  }

  if (samples.length < MIN_SAMPLES) {
    return {
      ok: false,
      failure: 'nothing_readable',
      detail:
        `Found ${files.length} candidate file(s) but could read only ${samples.length}. ` +
        'PDFs and scans need extraction this connector does not do yet; Google Docs and text files work.',
    };
  }

  const user = samples
    .map((s, i) => `--- SAMPLE ${i + 1} (${s.file.name}) ---\n${s.text}`)
    .join('\n\n');

  const raw = await askModel(options.apiKey, EXTRACT_SYSTEM, user);
  if (!raw) {
    return { ok: false, failure: 'model_unavailable', detail: 'The extraction model returned nothing.' };
  }

  const format = parseExtractedFormat(raw);
  if (!format) {
    return {
      ok: false,
      failure: 'extraction_failed',
      detail: 'The model returned no sections, so there is no format to store.',
    };
  }

  return {
    ok: true,
    format,
    sources: samples.map((s) => s.file),
    // Evidence the owner can check the extraction against — a short quotation, not the document.
    excerpt: samples[0].text.slice(0, 600),
  };
}

/**
 * Persist as a NEW version rather than an update.
 *
 * If a re-extraction is worse than what it replaced — a folder of old templates, a bad sample — the
 * previous version is still there. An UPDATE would have destroyed the good one to store the bad one,
 * and nobody would know until a quote went out looking wrong.
 */
export async function saveQuoteFormat(
  supabase: SupabaseClient,
  tenantId: string,
  result: Extract<LearnResult, { ok: true }>,
): Promise<{ version: number }> {
  const { data: latest } = await supabase
    .from('quote_formats')
    .select('version')
    .eq('tenant_id', tenantId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  const version = ((latest?.version as number) ?? 0) + 1;

  const { error } = await supabase.from('quote_formats').insert({
    tenant_id: tenantId,
    version,
    structure: result.format,
    source_files: result.sources.map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime })),
    sample_excerpt: result.excerpt,
  });

  if (error) throw new Error(`quote format insert failed: ${error.message}`);
  return { version };
}

/** The current format for a tenant, or null. The cheap read every quote makes. */
export async function currentQuoteFormat(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<StoredQuoteFormat | null> {
  const { data } = await supabase
    .from('quote_formats')
    .select('version, structure, source_files, sample_excerpt, confirmed_at, extracted_at')
    .eq('tenant_id', tenantId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  return {
    version: data.version as number,
    structure: data.structure as QuoteFormat,
    sourceFiles: (data.source_files ?? []) as StoredQuoteFormat['sourceFiles'],
    sampleExcerpt: (data.sample_excerpt as string) ?? null,
    confirmedAt: (data.confirmed_at as string) ?? null,
    extractedAt: data.extracted_at as string,
  };
}

/**
 * The format as drafting instructions.
 *
 * Kept next to the extraction on purpose: the words used to describe a format and the words used to
 * ask for one must move together, and putting this in the drafter is how they drift apart.
 */
export function formatAsInstructions(stored: StoredQuoteFormat): string {
  const f = stored.structure;
  const lines = [
    'Write this quote in THIS BUSINESS\'S OWN FORMAT, taken from their past quotes:',
    `- Sections, in this order: ${f.sections.join(' → ')}`,
  ];
  if (f.priceExpression) lines.push(`- Price is presented as: ${f.priceExpression}`);
  if (f.taxTreatment) lines.push(`- Tax: amounts are ${f.taxTreatment}`);
  if (f.signOff) lines.push(`- Close with: ${f.signOff}`);
  if (f.conventions.length) lines.push(`- Their conventions: ${f.conventions.join('; ')}`);
  if (f.toneNotes) lines.push(`- Tone: ${f.toneNotes}`);
  lines.push(
    'Follow their structure even where a generic quote would differ. Do NOT copy any client, price ' +
      'or project detail from their past quotes — only the shape.',
  );
  return lines.join('\n');
}
