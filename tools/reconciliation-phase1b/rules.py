"""Step 5's hard classification rules (scope doc §5). These FLAG, they never resolve — every rule
here returns a flag string for a human (Rimal/Ken/Dennis) to confirm, never a final answer, per the
scope doc's own framing: "the agent flags but never resolves."
"""

import re
from dataclasses import dataclass, field
from typing import Optional

from narration import BankCsvRow

DENNIS_NAMES = re.compile(r"\bDENNIS\b", re.IGNORECASE)
GLENLOGAN_KEYWORDS = re.compile(r"\b(glen|glenlogan|glnlgn|gln)\b", re.IGNORECASE)
NZQ_KEYWORDS = re.compile(r"\b(nzq|naturezen|nature\s*zen|nz)\b", re.IGNORECASE)
F2K_KEYWORDS = re.compile(r"\bf2k\b", re.IGNORECASE)
WBFREE_KEYWORDS = re.compile(r"\bwbfree\b", re.IGNORECASE)

# Finance/lending merchants — repayments are financial supplies, no GST (scope §5 GST rules).
FINANCE_REPAYMENT_MERCHANTS = re.compile(
    r"\b(shift|attvest|zepto|moneyme|hunter\s*premium)\b", re.IGNORECASE
)

ATO_KEYWORDS = re.compile(r"\bATO\b")

# International-travel signal: overseas city/venue names seen in Batch 1 (Napa, Santa Rosa) plus a
# generic "overseas" heuristic — this is necessarily incomplete without a merchant-country map, so
# it is a FLAG-only heuristic, not a silent auto-classification.
OVERSEAS_TRAVEL_HINTS = re.compile(
    r"\b(napa|santa rosa|usa|united states)\b", re.IGNORECASE
)

REVERSAL_HINTS = re.compile(r"\b(reversal|reversed|autopay reversal)\b", re.IGNORECASE)


@dataclass
class RuleFlags:
    flags: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def add(self, flag: str, note: str = ""):
        self.flags.append(flag)
        if note:
            self.notes.append(note)


def apply_hard_rules(row: BankCsvRow, is_internal_transfer: bool) -> RuleFlags:
    """Run every applicable hard rule against one bank-CSV row. A row can carry more than one flag
    (e.g. a Dennis transfer that's ALSO a related-party payment) — this is deliberate; the scope
    doc's rules are not mutually exclusive."""
    result = RuleFlags()
    text = row.transaction_details

    if is_internal_transfer:
        result.add(
            "LINKED_ACCOUNT",
            "Transfer to/from the second, not-yet-in-Xero linked NAB account — never income or expense.",
        )

    if DENNIS_NAMES.search(text):
        result.add(
            "DIRECTOR_LOAN_REVIEW",
            "Transfer to/from Dennis McMahon — Division 7A implication. Narration hints indicate "
            "the CLAIMED purpose only; do not resolve without a receipt on file.",
        )

    if GLENLOGAN_KEYWORDS.search(text) or NZQ_KEYWORDS.search(text):
        result.add(
            "RELATED_PARTY_REVIEW",
            "Glenlogan/NZQ reference — Chequers treated FY23/24 Glenlogan costs as a NatureZen "
            "related-party receivable, not GBTA cost of sales. Needs Ken's confirmation.",
        )

    if F2K_KEYWORDS.search(text):
        result.add("F2K_ONCHARGE", "F2K-tagged — on-charge to Factory2Key, not a GBTA expense.")

    if WBFREE_KEYWORDS.search(text):
        result.add(
            "WBFREE_SETTLEMENT",
            "Payment to/from WBFREE Pty Ltd — F2K settlement; multi-payment settlement is normal.",
        )

    if ATO_KEYWORDS.search(text):
        result.add("ATO_ICA", "ATO payment — code to ATO Client Integrated Account, never an expense.")

    if FINANCE_REPAYMENT_MERCHANTS.search(text):
        result.add("GST_FREE_FINANCE", "Finance repayment — financial supply, no GST.")

    if OVERSEAS_TRAVEL_HINTS.search(text):
        result.add(
            "GST_FREE_INTERNATIONAL_TRAVEL",
            "Overseas travel hint in narration — international travel, GST-free/no input tax "
            "credit unless a tax invoice shows an Australian GST registration.",
        )

    if REVERSAL_HINTS.search(text):
        result.add("REVERSAL_PAIR", "Bounced/reversed transaction — exclude before any proposal.")

    return result


NORMALISE_TODO = (
    "Vendor normalisation (scope doc §5 'Data hygiene': the 1,098 descriptor->merchant pairs from "
    "the v6 extraction, WOTSO alone has 91) is NOT yet implemented -- no clean source tab was found "
    "in the v6 workbook's 70+ sheets in the time available this session. Do not fabricate a mapping; "
    "flag rows with cryptic/numeric-heavy narration as NEEDS_MERCHANT_NORMALISATION until the real "
    "map is located or rebuilt, rather than guessing a vendor name."
)


def needs_merchant_normalisation(row: BankCsvRow) -> bool:
    """A crude placeholder for the missing merchant map: flag narration that is mostly numeric
    reference codes with little recognisable vendor text, so these rows are visibly incomplete
    rather than silently under-normalised."""
    words = re.findall(r"[A-Za-z]{3,}", row.transaction_details)
    return len(words) <= 2
