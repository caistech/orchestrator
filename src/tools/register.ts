// The tool register — what this system is able to do to the world, as data.
//
// WHY THIS EXISTS. `effects.kind` is an open text column (invoice.create, calendar.book, …), and the
// drain used to query exactly one value of it. An effect of any other kind was therefore accepted,
// stored, and never executed: no error, no retry, no alert, status stuck at `pending` while every
// screen looked healthy. That is the same silent-failure shape that once held four approved emails —
// including a $60,000 quote — for three days behind a hardcoded tenant constant.
//
// So the drain no longer names a kind. It asks THIS register what it can execute, and it reports
// anything pending that this register does not cover. An unregistered kind becomes loud rather than
// invisible, which is the whole point: a check that quietly does nothing is indistinguishable from
// one that passed.
//
// THE SPLIT THIS MUST NEVER BLUR (EXECUTION_LAYER.md §6): read tools are available to any handler and
// cannot change anything; effect tools are NOT in a handler's tool set at all — a handler emits an
// effect, and a separate dispatcher performs it once the gate has cleared. Registering a tool here
// makes it EXECUTABLE BY THE DRAIN. It does not, and must not, hand it to anything that reasons.

import registerJson from '../../config/tools.json';

/**
 * `read` — a handler may call it at any time; it cannot change the world.
 * `effect` — emitted into the outbox and performed by the drain, only after the gate cleared.
 */
export type ToolClass = 'read' | 'effect';

export interface ToolEntry {
  /** Matches `effects.kind` EXACTLY. This is the join between the register and the outbox. */
  kind: string;
  class: ToolClass;
  label: string;
  /** Which connector performs it — 'resend', 'xero', 'google'. Recorded on the effect row too. */
  connector: string;
  /** True when the tenant must hold a live `connections` row for that provider first. */
  requiresConnection: boolean;
  /** True when the tenant must have legal_name + abn + postal_address before this may run. */
  requiresSenderIdentity: boolean;
  idempotent: boolean;
  maxAttempts: number;
  /** Registry flow ids this unlocks — makes EXECUTION_LAYER §16.3 sequencing computable. */
  flowsUnlocked: string[];
  notes?: string;
}

interface RegisterFile {
  version: number;
  tools: ToolEntry[];
}

/**
 * Validation THROWS rather than filtering.
 *
 * A malformed entry that is quietly skipped produces exactly the failure this register was built to
 * end — an effect kind that looks registered, is not, and silently never runs. Same reasoning as
 * `parseCallers`: an empty-but-valid registry is the dangerous shape, not the loud one.
 */
function validate(raw: unknown): ToolEntry[] {
  const file = raw as RegisterFile;
  if (!file || !Array.isArray(file.tools)) {
    throw new Error('config/tools.json: expected { version, tools: [...] }');
  }

  const seen = new Set<string>();
  for (const t of file.tools) {
    if (!t?.kind || typeof t.kind !== 'string') {
      throw new Error('config/tools.json: every tool needs a non-empty `kind`.');
    }
    if (seen.has(t.kind)) {
      // Two entries for one kind means one of them is dead and nobody knows which. Refuse.
      throw new Error(`config/tools.json: duplicate kind "${t.kind}".`);
    }
    seen.add(t.kind);

    if (t.class !== 'read' && t.class !== 'effect') {
      throw new Error(`config/tools.json: "${t.kind}" needs class "read" or "effect".`);
    }
    if (!t.connector) {
      throw new Error(`config/tools.json: "${t.kind}" needs a connector.`);
    }
    if (typeof t.maxAttempts !== 'number' || t.maxAttempts < 1) {
      throw new Error(`config/tools.json: "${t.kind}" needs maxAttempts >= 1.`);
    }
    if (!Array.isArray(t.flowsUnlocked)) {
      throw new Error(`config/tools.json: "${t.kind}" needs flowsUnlocked (use [] if none yet).`);
    }
  }
  return file.tools;
}

const TOOLS: ToolEntry[] = validate(registerJson);

/** Every registered tool, both classes. */
export function allTools(): ToolEntry[] {
  return TOOLS;
}

/** The kinds the DRAIN is able to execute. Read tools are never in this list. */
export function executableKinds(): string[] {
  return TOOLS.filter((t) => t.class === 'effect').map((t) => t.kind);
}

export function toolFor(kind: string): ToolEntry | null {
  return TOOLS.find((t) => t.kind === kind) ?? null;
}

/**
 * Is this kind something the drain may perform?
 *
 * A `read` tool answers FALSE here even though it is registered — registering a read tool must never
 * make it executable through the outbox, or the read/effect split would be a naming convention
 * rather than a boundary.
 */
export function isExecutable(kind: string): boolean {
  return toolFor(kind)?.class === 'effect';
}
