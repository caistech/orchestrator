# Practice Intelligence — Orchestrator Capability

## Purpose

This capability executes Kira's Practice Intelligence skill.

Kira provides the intelligence model and reasoning framework.

The Orchestrator provides execution.

## Boundary

Kira:
- decides what information matters
- interprets evidence
- forms hypotheses
- qualifies opportunities
- determines strategic approach

Orchestrator:
- searches
- retrieves
- extracts
- transforms
- calls tools
- executes workflow
- manages state
- requests approval
- sends actions
- records outcomes

## Initial implementation

The capability should initially be implemented as a workflow composed of
functions/tools rather than a collection of autonomous agents.

Autonomous agents can be introduced later where repeated evidence shows that
an independent reasoning loop provides value.

## Primary workflow

Signal
→ Practice identification
→ Website research
→ Technology detection
→ Practice intelligence
→ Decision-maker identification
→ Qualification
→ Opportunity hypothesis
→ Outreach drafting
→ Human approval
→ Outreach
→ Outcome capture
→ Learning

## Safety

No external communication should be sent without an explicit approval state
unless a future Kira policy explicitly authorises autonomous communication.

No clinical decisions should be made.

No patient information should be exposed unnecessarily.

Research should use publicly available organisational information unless the
user explicitly provides additional authorised data.
