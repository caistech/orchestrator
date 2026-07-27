# Referral Fee — declared regulatory position (AU accountants & tax agents)

**Version** 0.1 — desk research, pending legal review
**Owner** Dennis McMahon, Corporate AI Solutions
**Resolves** `TODOS.md` D1 (was T-B2) · **Pattern** `REGULATORY_INCLUSIONS.md` — declared, not assumed
**Researched** 2026-07-27

> ⚠️ **This is desk research against primary standards, not legal advice.** It is written to be
> handed to a lawyer for review, which is already a standing guardrail in Kira
> `docs/BROKER_CHANNEL_BUILD_STATE.md`. Confidence is marked per finding. Do not put any of this in
> front of an accountant as our compliance opinion until the review is done.

---

## 1. The headline — the answer to "what does disclosable mean"

**Referral fees to Australian accountants are permitted, and regulated by disclosure rather than
prohibition.** There is no general ban. The advisor's obligation is to *tell their client*, and the
standards are specific about what, when and in what form.

**One hard exception:** an accountant who provides **assurance services** (audit/review) to that
client **cannot accept the fee at all** — no disclosure cures it.

So our sentence *"we'll only pay it where you can disclose it and it doesn't cut across your
obligations"* is **supportable**, and can now be made concrete rather than vague.

---

## 2. The two regimes that stack

Both apply to the same person at the same time. An accountant who is also a registered tax agent —
which is most of them — must satisfy both.

### 2.1 APES 110 §330 — the ethical standard · confidence: HIGH

Issued by the **APESB** and adopted by **CPA Australia, CA ANZ and the IPA**, so it binds members of
all three bodies. Section 330 is *Fees and Other Types of Remuneration*.

**The obligation:** a member in public practice must **inform the client in writing** of:
- **that** a referral fee or commission is received,
- **who it is received from**, and
- **how it is calculated**.

The Code expressly contemplates our exact fact pattern — a commission received "in return for the
introduction of a new client", "the referral of an existing client to another firm or expert", or
"the sale of goods or services to a client".

**The prohibition:** receipts of commissions or similar benefits **in connection with assurance
engagements** create threats to independence for which **no safeguard is sufficient**. If the firm
audits or reviews that client, the fee is off the table.

⚠️ **Version check owed.** Fee-related provisions of APES 110 were amended by an Amending Standard
issued July 2022, effective **1 January 2023**. Confirm §330's current wording against the compiled
current version before quoting it.

### 2.2 TPB Code of Professional Conduct — the statutory regime · confidence: MEDIUM-HIGH

Under the **Tax Agent Services Act 2009**, administered by the **Tax Practitioners Board**. The
relevant obligation is the **conflicts of interest** Code item, with guidance in **TPB(I) 19/2014**
and **TPB(GS) 24/2014**.

Receiving a referral fee for sending a client to another provider **is** a conflict of interest, and
the practitioner must:
- **Disclose the conflict**, including **the amount of the commission** they will receive;
- **before or when the service is provided**, and at a time giving the client **reasonable time to
  assess its effect**;
- **specific to the service** the conflict relates to, and sufficient for an **informed decision**.

The TPB **recommends obtaining the client's positive consent** to act, and recommends that consent
be **a written statement from the client**.

⚠️ **Confidence caveat:** tpb.gov.au was unreachable across four attempts this session, so this rests
on TPB's own indexed content rather than a page I opened. The shape is consistent across independent
sources and matches the guidance numbering. **One confirming read of TPB(I) 19/2014 is owed.**

Also note the **Tax Agent Services (Code of Professional Conduct) Determination 2024**, which added
eight further Code obligations, phased in from 1 Jan 2025 / 1 Jul 2025 by firm size. Confirm none of
the new items bear on referral arrangements.

### 2.3 Licensed advisers — probably not engaged · confidence: MEDIUM

**Conflicted remuneration** under the Corporations Act (FoFA; ASIC **RG 246**) bans benefits that
could reasonably be expected to influence **financial product advice** or product choice.

**Our subscription is not a financial product**, so a referral fee for it should sit outside the
conflicted-remuneration ban — referral fees are not conflicted remuneration unless they induce the
adviser to act a certain way in relation to a financial product.

Two cautions: if a referrer holds an AFSL or is an authorised representative **and** the referral is
bundled with financial product advice, get specific advice. And the **"accountants' exemption" was
repealed on 1 July 2016** — it is frequently misremembered as still live, so do not let it appear in
any of our material.

---

## 3. What this changes in the product and the copy

The research converts a vague reassurance into four concrete build items.

**3.1 We supply the disclosure, they don't draft it.** The advisor's obligation is written
disclosure naming the payer, the basis and the amount. That is our information, not theirs — so
**the portal generates the disclosure statement** and the advisor hands it over. This is a feature,
not a legal footnote: it removes the single biggest friction in an accountant saying yes.

**3.2 Disclosure travels with the REFERRAL, not the invoice.** The TPB timing test is *before or when
the service is provided*, with time to assess. Our commission is earned at conversion, but the
conflict arises at introduction — so the disclosure must be attached to the referral step, not
surfaced later. Practically: it belongs with the `/r/[token]` link and the introduction record.

**3.3 The amount must be stateable up front.** "10% of the subscription" is a basis, not an amount,
and the band isn't known until the client is quoted. The disclosure therefore needs to state **the
basis plus the expected range** ($49.90–$499.90/month across current bands), not a single number it
can't yet know.

**3.4 Positive consent is capturable — and we already capture consent at signup.** Add the
referral-fee acknowledgment to the client's signup consent alongside the advisor-visibility consent
(D4). One surface, two obligations, and it produces the written record the TPB recommends the
advisor hold.

**3.5 The firm-level opt-out now has a real reason.** It was designed as a courtesy to firms whose
internal rules refuse fees. It is also the mechanism for the **assurance-client prohibition** — an
auditor of that client must not be paid, and the switch is how that is honoured. Worth asking the
question at advisor onboarding: *do you provide assurance services to this client?*

---

## 4. Residual risk and what's owed

| Item | State |
|---|---|
| Confirm current compiled APES 110 §330 wording (post-Jan-2023) | ✅ **CLOSED 2026-07-27** — see §4.1 |
| Check the 2024 TPB Determination items for referral-arrangement impact | ✅ **CLOSED 2026-07-27, no impact** — see §4.2 |
| One confirming read of TPB(I) 19/2014 primary PDF | 🟡 **Still owed** — tpb.gov.au unreachable across ~6 attempts (timeout / ECONNRESET). Position corroborated across three independent passes over TPB's own indexed pages, but not read directly. |
| Lawyer review of the disclosure wording + introducer agreement | **Owed** — already a standing guardrail in Kira's build state |
| Whether *we* have any obligation, or only the advisor | Assessed as **advisor-side only** — the obligations bind the practitioner, not the payer. Confirm with the lawyer. |

### 4.1 APES 110 — §330 is UNCHANGED by the 2022 fee amendments

The concern was that the Amending Standard (issued July 2022, effective **1 January 2023**) might
have moved §330's referral-fee provisions under us. **It did not.**

The 2022 fee amendments landed in **section 410 / Part 4A — auditor independence**, specifically the
fee-dependency thresholds including **AUST R410.14.1**, which requires a firm to evaluate
significance where total fees from multiple audit clients **referred from one source** exceed 20% of
the relevant firm/office/partner's total fees. That is a threshold about *audit independence*, not
about disclosing a commission to a client.

So §330's requirement — inform the client **in writing** of the referral fee, who it is from, and
how it is calculated — stands as stated in §2.1. Reference: **Compiled APES 110 (November 2022)**.
⚠️ A compilation later than Nov 2022 may exist; that is the most recent one surfaced here.

Incidental note: **AUST R410.14.1 is a reason a firm might decline our fee** that has nothing to do
with our arrangement — a firm receiving many audit referrals from one source has its own threshold
to watch. The firm-level opt-out already covers it.

### 4.2 The 2024 TPB Determination — no referral-fee impact

The eight new Code obligations are: upholding ethical standards · false or misleading statements ·
**conflicts of interest in activities undertaken for government** · confidentiality in dealings with
government · keeping proper client records · ensuring services provided on your behalf are competent
· quality management systems · keeping your clients informed.

**None addresses commercial referral fees.** The conflicts-of-interest item is scoped to *government*
work. "Keeping your clients informed" (s45) concerns disclosure of **prescribed events — misconduct
matters in the past five years** — not commissions.

Referral-fee obligations therefore continue to sit where §2.2 puts them: the original TASA Code
conflicts-of-interest item, **unchanged**. Application dates for the new obligations were 1 Jan 2025
(larger firms) and 1 Jul 2025 (100 or fewer employees), so they are in force — they simply don't
bear on this.

**The honest read:** nothing found suggests this arrangement is problematic. It is a common,
well-trodden structure with a clear disclosure path, one clean prohibition (assurance clients), and
a licensing edge case that almost certainly does not apply to us. The work left is confirmation and
drafting, not redesign.

---

## 5. SECOND WORKSTREAM — the advisor's AI-governance obligations

> Added 2026-07-27 after reviewing the GPS-AI *AI Safe Practice Toolkit*. **This is a different
> regulatory surface from §§1–4 and was not previously scoped.** The referral-fee question is *"may
> they be paid?"* This one is *"what does an accountant have to satisfy themselves about before
> putting an AI product in front of their client?"* Both arrive in the same demo.

### 5.1 The instruments

| Instrument | Status | Bears on |
|---|---|---|
| **TPB(GS) 55/2026** — *The use of Artificial Intelligence and the Code of Professional Conduct* | **FINAL — issued 22 July 2026.** Was exposure draft TPB(I) D62/2026 (24 Mar 2026, submissions closed 21 Apr) | A tax practitioner's obligations under the TASA Code when using AI in providing tax agent services |
| **APESB Technical Alert — Use of AI**, 31 October 2025 | Issued | Members' APES 110 obligations when using AI |
| **APES 110 technology provisions** | **In force from 1 January 2025** | Principle-based provisions on ethical use of technology, incl. AI — integrity, competence, due care, confidentiality |

⚠️ **Currency warning, and it is not hypothetical.** The toolkit that surfaced these warns on five
separate pages that D62/2026 is "still an exposure draft, not finalised guidance." It was finalised
**five days before we read it.** Anything in circulation on this topic should be date-checked before
being relied on — including this section.

### 5.2 Does it apply to us? Probably not directly — and that will not stop the question

These instruments govern the **practitioner's own use of AI in delivering tax agent services**. Our
client is the business owner; the accountant refers and does not operate the product, so on the face
of it a referral does not engage them.

Two caveats worth holding:
- If the accountant **reads or relies on a Kira output in their own file**, the position weakens.
- Regardless of strict application, **an accountant trained on this material will ask**, and "it
  doesn't apply to us" is a poor answer to someone doing their diligence properly.

### 5.3 What it changes for the build

**The demo will face a checklist.** Firms are being trained on a ten-question self-assessment and a
Public/Embedded/Enterprise classification card. Four of those questions point at a vendor:
data-processing terms · client consent to AI processing · a documented review step before AI output
reaches a client · a protocol for when an output is wrong.

**Answered → `Kira/docs/ADVISOR_AI_GOVERNANCE_ANSWERS.md`**, written only from what the product
actually does. Three positions taken there deliberately:

1. **We do not claim "Enterprise AI."** That tier requires no external data sharing; conversations go
   to ElevenLabs and responses come from third-party model providers. Claiming the tier would be
   false, and this audience checks.
2. **The strongest true fact is that the valuation is arithmetic, not AI** — a deterministic
   calculation from the owner's own inputs, reproducible and auditable, with the model version
   stored per snapshot. The AI is the *conversation*. Those are different systems and it matters
   which one they are being asked to trust.
3. **The gaps are listed explicitly** — no ISO 27001 / SOC 2 / 42001, no Australian data residency,
   no independent security audit, no published AI incident-response standard, no lawyer review yet.
   A vendor page that claims nothing checkable is worth nothing.

### 5.4 Owed

- **Read TPB(GS) 55/2026 directly** (tpb.gov.au unreachable from here across ~6 attempts today —
  the same wall that leaves TPB(I) 19/2014 outstanding).
- **Read the APESB Technical Alert (31 Oct 2025)** and confirm nothing in the 1 Jan 2025 technology
  provisions changes the §§1–4 position.
- **Write the AI incident-response standard.** It is the one genuine product gap the checklist
  surfaces, and it is small.
- **Decide whether Australian data residency is ever offered.** Today it is not, and it is the
  question a cautious firm is most likely to stop on.

---

## Sources

- [APES 110 Code of Ethics for Professional Accountants, Part 3 — CPA Australia](https://www.cpaaustralia.com.au/tools-and-resources/accounting-professional-and-ethical-standards/apes-110-code-of-ethics-for-professional-accountants/part-b)
- [APES 110 Restructured Code (APESB)](https://apesb.org.au/uploads/home/02112018000152_APES_110_Restructured_Code_Nov_2018.pdf)
- [APES 110 Amending Standard — Fees, July 2022 (APESB)](https://apesb.org.au/wp-content/uploads/2022/07/APES_110_Amending_Standard_Fees_July_2022.pdf)
- [Code of Professional Conduct — Tax Practitioners Board](https://www.tpb.gov.au/code-professional-conduct)
- [TPB(I) 19/2014 Managing conflicts of interest](https://www.tpb.gov.au/code-professional-conduct-managing-conflicts-interest-tpb-information-sheet-tpbi-192014)
- [TPB(GS) 24/2014 Managing conflicts of interest](https://www.tpb.gov.au/tpb-gs-24-2014-managing-conflicts-interest)
- [RG 246 Conflicted and other banned remuneration — ASIC](https://www.asic.gov.au/regulatory-resources/find-a-document/regulatory-guides/rg-246-conflicted-and-other-banned-remuneration/)
- [Future of Financial Advice (FOFA) reforms — ASIC](https://www.asic.gov.au/regulatory-resources/financial-services/regulatory-reforms/future-of-financial-advice-fofa-reforms/)

**§5 — AI governance:**
- [TPB(GS) 55/2026 The use of Artificial Intelligence and the Code of Professional Conduct](https://www.tpb.gov.au/tpbgs-552026-use-artificial-intelligence-and-code-professional-conduct) — final, 22 July 2026
- [Exposure Draft TPB(I) D62/2026](https://www.tpb.gov.au/exposure-draft-tpbi-d622026-use-artificial-intelligence-and-code-professional-conduct) — superseded by the above
- [APESB Technical Alert — Use of AI, 31 October 2025](http://apesb.org.au/wp-content/uploads/2025/10/TA_Use_of_AI_Oct_31_Oct_25.pdf)
- [APESB — Artificial Intelligence & Digital Technology](https://apesb.org.au/artificial-intelligence-and-digital-technology/)
- Source that surfaced them: GPS-AI *AI Safe Practice Toolkit v1* (Andrew Cooke), `Orchestrator/AI_Safe_Practice_Toolkit_v1.pdf`
