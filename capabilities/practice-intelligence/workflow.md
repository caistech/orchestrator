# Practice Intelligence Workflow

## Workflow ID

practice-intelligence-v1

## Trigger

One of:

- receptionist job advertisement
- medical secretary job advertisement
- practice manager vacancy
- new practice detected
- practice expansion
- manually supplied practice
- other organisational signal

## Stage 1 — Signal capture

Input:

- source
- URL
- title
- organisation
- location
- extracted text

Output:

Normalised signal object.

## Stage 2 — Practice identification

Determine:

- practice name
- website
- location
- parent group if applicable

If uncertain, flag for research.

## Stage 3 — Website research

Retrieve relevant pages:

- home
- about
- team
- services
- contact
- appointments
- booking
- patient information

Do not retrieve unnecessary pages indefinitely.

## Stage 4 — Technology detection

Determine whether the practice uses:

- Healthengine
- HotDoc
- another online booking system
- no visible online booking
- unknown
- AI receptionist
- other relevant automation

Record evidence for every technology conclusion.

### Technology qualification

If Healthengine is identified:

- do not approach the practice as a direct AI receptionist prospect
- classify the opportunity as potentially relevant to Healthengine/platform partnership
- preserve the practice intelligence as evidence of market demand

If HotDoc is identified:

- record HotDoc as the existing platform
- continue practice qualification unless another exclusion applies
- determine whether there is an identifiable gap or adjacent opportunity

If another platform is identified:

- record the platform
- assess whether it creates an integration constraint or opportunity

If no booking/AI infrastructure is visible:

- treat this as a potentially stronger direct opportunity
- continue research before qualification

If an existing AI receptionist is identified:

- record the provider
- assess whether the practice should be excluded from direct outreach

## Stage 5 — Practice intelligence

Extract:

- clinicians
- services
- locations
- administrative functions
- patient access channels
- operational signals
- apparent workload
- growth signals

Separate facts from inference.

## Stage 6 — Decision-maker identification

Search available public organisational sources.

Rank likely decision-makers.

Return:

- person
- role
- evidence
- confidence
- recommended contact

## Stage 7 — Qualification

Apply Kira's Practice Intelligence qualification rules.

Possible outcomes:

- direct_opportunity
- potential_opportunity
- platform_partnership
- low_priority
- exclude
- insufficient_information

## Stage 8 — Opportunity hypothesis

Produce:

- observed problem
- organisational interpretation
- potential agentic opportunity
- human boundary
- confidence

## Stage 9 — Outreach recommendation

Generate a personalised outreach recommendation.

Do not send automatically.

State:

- recommended recipient
- recipient role
- reason for selecting the recipient
- organisational observation
- relevant signal
- opportunity hypothesis
- personalisation points
- proposed channel
- proposed message

## Stage 10 — Approval

Set:

status = pending_approval

Human approves, edits or rejects.

## Stage 11 — Execution

On approval:

- send message
- record timestamp
- record channel
- record recipient

## Stage 12 — Learning

Record:

- response
- meeting
- rejection
- objection
- opportunity
- outcome

Make structured learning available to Kira's memory/governance layer.

Learning must not silently modify Kira's knowledge.

Observed outcomes should be recorded as new evidence and made available
to the Memory Governance Layer for subsequent reasoning.