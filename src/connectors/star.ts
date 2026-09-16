// The STAR connector — Specialised Team Advisory & Recommendations (STUB).
//
// STAR is Brian Kerrigan's (Excelerating) specialist intelligence/methodology layer:
// enterprise-value analysis, cross-functional reasoning, diagnostic logic and prioritised
// recommendations, delivered from a large proprietary library. It is currently migrating from
// Custom GPTs to an Azure front end / Foundry back end (Brian, 2026-09-11/14).
//
// This is a STUB. The orchestration decision (2026-09-15, Dennis): Kira and STAR remain distinct
// products; Kira knows the business and its history, identifies what the business needs, and calls
// the appropriate STAR capability through the orchestrator. STAR returns the insight, Kira brings it
// back into business context, the consultant decides and intervenes, and outcomes flow back into
// Kira memory.
//
// While Brian finalises the Foundry/Azure shape, this module proves the CONTRACT:
//   - a STAR dispatch is accepted, journaled as done, and answers with a synthetic result
//   - nothing about the dispatch request changes when the real connector lands
// When the endpoint shape arrives, replace `callStar` with the real HTTP call inside it. The flow
// constants, the payload envelope, and the task lifecycle do not change.

export const STAR_FLOWS = ['STAR_DIAGNOSTIC', 'STAR_ROADMAP'] as const;
export type StarFlow = (typeof STAR_FLOWS)[number];

export interface StarRequest {
  intent: StarFlow;
  tenantId: string;
  payload: Record<string, unknown>;
}

export interface StarResponse {
  status: 'completed';
  result: Record<string, unknown>;
}

/**
 * The stub. Receives a dispatch, records it, answers with a synthetic completed result.
 *
 * The result deliberately carries the received intent and payload so a caller (or a reviewer on the
 * task row) can see that the stub answered exactly what was asked — proving the round trip end to
 * end before any real STAR logic exists.
 */
export async function callStar(request: StarRequest): Promise<StarResponse> {
  console.log('[STAR STUB] received:', JSON.stringify(request));
  return {
    status: 'completed',
    result: {
      stub: true,
      message: 'STAR stub — awaiting Brian/Foundry endpoint shape',
      receivedIntent: request.intent,
      receivedAt: new Date().toISOString(),
    },
  };
}

/** Convenience test: a given dispatch flow is a STAR flow, so the route can route to the stub. */
export function isStarFlow(flow: string | undefined | null): flow is StarFlow {
  return typeof flow === 'string' && (STAR_FLOWS as readonly string[]).includes(flow);
}