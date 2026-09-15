// The wire contract between a caller (Kira today) and an orchestrator.
//
// THIS FILE IS THE SEAM. It is deliberately the smallest thing that can be true of BOTH our
// orchestrator and a replacement — Gareth's swarm, a vendor, anything. Swapping implementations must
// be a config change (KIRA_SWARM_ADAPTER + a base URL), never a code change in the caller. That only
// holds if the contract is a NETWORK shape rather than our types: a replacement has to match JSON on
// the wire, and nothing else.
//
// It mirrors Kira's existing SwarmCoordinator interface (lib/kira/swarm/coordinator.ts) on purpose.
// Kira already dispatches every doable intent through that interface and handles ~3 owned kinds
// locally; the orchestrator adapter implements the same three methods over HTTP, so Kira's call
// sites do not change when it is plugged in.
//
// Versioned from the first line, because §Cross-cutting 26 is right: without a version field one
// party's change silently breaks another, and the breakage shows up as a task that quietly does
// nothing.

export const CONTRACT_VERSION = '1' as const;

/** The flat owner key — the SAME id Kira uses for memory and tasks. One business, one id. */
export type TenantId = string;

/** How the work arrived. ~85% of registry flows are not SAY; a contract that assumes speech is voice-shaped. */
export type Ingress = 'EVT' | 'STA' | 'CAL' | 'SAY' | 'HUM';

export type TaskState =
  | 'queued'
  | 'awaiting_approval'   // a draft exists and the delegation policy says a human decides
  | 'scheduled'           // approved or auto-approved, waiting for its due time
  | 'running'
  | 'done'
  | 'failed'
  | 'unsupported'         // nothing can route it — captured, never silently dropped
  | 'clarifying';         // held at the pre-gate: the request is under-specified and the CALLER is
                          // asking the owner for the outstanding fields (T1 / DESIGN §5.1).

/** The four things a dispatch must carry before it is runnable. Caller asks, gate enforces. */
export type ClarifyField = 'objective' | 'responsibleTier' | 'successCriteria' | 'dueAt';

/**
 * The clarify round-trip (T1). Two distinct messages share this shape, exactly like ApproveRequest
 * carries a decision and an optional patch in one object:
 *   - REQUEST: `required` lists the fields the caller still needs — opens/deepens the loop.
 *   - ANSWER:  `answers` supplies the caller-held answers — advances or closes the loop.
 */
export interface DispatchClarification {
  required?: ClarifyField[];
  /** Verbatim answers from the owner, keyed by field name. */
  answers?: Partial<Record<ClarifyField, string>>;
  /** Why the caller asked — journaled on the task so a reviewer later knows the un-said reason. */
  reason?: string;
}

/** POST /v1/dispatch */
export interface DispatchRequest {
  version: typeof CONTRACT_VERSION;
  tenantId: TenantId;
  /** Caller-supplied idempotency key. One trigger never dispatches twice, however often it is delivered. */
  intentId: string;
  ingress: Ingress;
  /** Raw text for SAY; for the other four, the event/threshold that fired. */
  utterance?: string;
  flow?: string;                          // registry flow id when the caller already knows it
  payload?: Record<string, unknown>;
  /** Context the caller already holds, so the orchestrator does not re-derive it. */
  context?: Record<string, unknown>;
  /**
   * The clarify round-trip (T1). Present ONLY when the caller is asking a question or answering one.
   * An ordinary dispatch omits it entirely and the gate leaves it untouched.
   */
  clarification?: DispatchClarification;
  correlationId?: string;                 // traces one trigger across every hop
}

export interface TaskDraft {
  kind: string;
  summary: string;
  /** The full drafted content a human approves. Sent VERBATIM — never leave a placeholder in it. */
  preview: string;
  artifact?: Record<string, unknown>;
}

export interface DispatchResponse {
  version: typeof CONTRACT_VERSION;
  taskGroupId: string;
  status: TaskState;
  draft?: TaskDraft;
  /** What the caller says to the human ("Drafted — say the word and I'll send it."). */
  message?: string;
  /** True when the send cannot complete until the human supplies a recipient. */
  needsRecipient?: boolean;
  /**
   * The CALLER'S OWN idempotency key, echoed. The answering round of a clarify loop must re-dispatch
   * the SAME intent (T1) — taskGroupId is the orchestrator's id and the caller has no way to derive
   * the key it coined itself, so the only safe echo is its own intentId.
   */
  intentId?: string;
  /** Present when status is 'clarifying': the question being asked, and its enforcement numbers. */
  clarifying?: {
    required: ClarifyField[];
    /** The question, phrased for a voice agent to read out ("Before I run with this I need…"). */
    prompt: string;
    /** Rounds already spent. The gate cancels once this passes `max`. */
    count: number;
    max: number;
    /** ISO — the request auto-cancels at this instant (TTL; DESIGN §5.1, D4). */
    ttlAt: string;
  };
}

/** POST /v1/tasks/:id/approve */
export interface ApproveRequest {
  version: typeof CONTRACT_VERSION;
  tenantId: TenantId;
  approve: boolean;
  /** Anything the human supplied at approval time (a recipient the classifier could not invent). */
  patch?: Record<string, unknown>;
  decidedBy?: string;
  reason?: string;
}

/** GET /v1/tasks/:id */
export interface TaskStatusResponse {
  version: typeof CONTRACT_VERSION;
  taskGroupId: string;
  status: TaskState;
  draft?: TaskDraft;
  message?: string;
  /** Present when status is 'clarifying' — the poll leg mirrors the ask from DispatchResponse. */
  clarifying?: {
    required: ClarifyField[];
    prompt: string;
    count: number;
    max: number;
    ttlAt: string;
  };
}

/** One row of the list leg. Enough to RECONSTRUCT a caller's missing mirror row, and no more. */
export interface TaskListItem {
  taskGroupId: string;
  status: TaskState;
  /** 'quote' | 'email' | 'reminder' when the classifier decided one; null when it did not. */
  kind: string | null;
  /** What the owner said, verbatim — the caller's row requires it and must not invent it. */
  utterance: string | null;
  summary: string | null;
  createdAt: string;
}

/**
 * GET /v1/tasks?tenantId=… — THE LIST LEG.
 *
 * The poll leg above can only ask about a task the caller already knows about, so it cannot answer
 * the one question that matters after a mirror write is lost: *what do you hold for this tenant that
 * I do not?* Every repair path on the caller's side starts from the rows it already has, which means
 * a task that never mirrored is unreachable by construction — it exists here, and on no screen there.
 *
 * `tenantId` is REQUIRED, and that is the whole security posture of this endpoint. A missing filter
 * on a by-id read leaks one task; a missing filter on a LIST returns every business's task summaries
 * in a single call. Absent or blank is a 400, never an implicit "all".
 */
export interface TaskListResponse {
  version: typeof CONTRACT_VERSION;
  tenantId: TenantId;
  tasks: TaskListItem[];
  /** True when the limit was hit — there is more to fetch, so a caller must not read "nothing else". */
  truncated: boolean;
}

/**
 * POST → the caller's webhook. The RETURN LEG.
 *
 * Most work does not finish inside the request that started it — a sweep fires at 4am, an approval
 * lands hours later, a connector retries. Without this the caller can only poll, and a voice agent
 * that must poll cannot say "that's gone out" at the moment it goes out.
 */
export interface TaskEventCallback {
  version: typeof CONTRACT_VERSION;
  tenantId: TenantId;
  taskGroupId: string;
  status: TaskState;
  event: string;                          // routed | gated | approved | executed | failed
  summary?: string;
  detail?: Record<string, unknown>;
  correlationId?: string;
  at: string;                             // ISO-8601
}

/**
 * PUT /v1/tenants/:tenantId/identity — WHOSE NAME IS ON THE EMAIL.
 *
 * Deliberately its OWN call rather than fields on DispatchRequest.context. The Spam Act footer
 * carries the tenant's legal identity, so this decides which business the world believes sent the
 * mail; it must be set once, on purpose, by a human who confirmed it — not carried along with every
 * task where a bad classification or a stale cache could quietly change it.
 *
 * A tenant provisioned by first contact has none of this, and the email connector refuses to send
 * without it. This is the only thing that lifts that refusal.
 */
export interface TenantIdentityRequest {
  version: typeof CONTRACT_VERSION;
  /** The registered legal entity — not the trading name. This is what the footer must say. */
  legalName: string;
  /** 11 digits. Stored normalised; the caller may send it spaced. */
  abn: string;
  /** Reply-capable postal address, already composed into one line. */
  postalAddress: string;
  /**
   * Where replies land. Optional on the wire and NOT optional in practice: absent, the connector
   * falls back to the sending domain, which is OURS — so the tenant's customer replies to a quote
   * and the tenant never sees it. Callers should always send it.
   */
  replyEmail?: string;
  /** Trading name, when it differs from the entity (a trust that trades under a business name). */
  tradingName?: string;
  /**
   * The verified address this tenant's mail is SENT FROM — "Factory2Key <noreply@updates.f2k.com.au>".
   *
   * Optional, and absent is a real state rather than an oversight: until the client's registrar has
   * added the DKIM and return-path records, there is no verified domain to send from, and the mail
   * goes out on the portfolio default with the tenant's identity in the footer. Set it only after
   * Resend reports the domain verified — an unverified domain is rejected at send time.
   */
  fromEmail?: string;
  /** When the owner authorised mail to go out under this ABN, ISO-8601. Recorded, not enforced. */
  authorisedAt?: string;
}

export interface TenantIdentityResponse {
  version: typeof CONTRACT_VERSION;
  tenantId: TenantId;
  /** True once legal_name + abn + postal_address are all present — i.e. sends are no longer refused. */
  canSend: boolean;
  error?: string;
}

/**
 * Auth between systems (§Cross-cutting 24). A shared secret in a header, checked fail-closed on
 * BOTH legs — an unset secret refuses the request rather than waving it through. These seams carry
 * live business data and can spend money; the posture matches the webhook routes, which refuse to
 * run without their signing secrets.
 */
export const ORCHESTRATOR_AUTH_HEADER = 'x-orchestrator-secret';
export const CALLBACK_AUTH_HEADER = 'x-orchestrator-callback-secret';
