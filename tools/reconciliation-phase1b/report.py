"""Step 7 — output format (scope doc §7). One .xlsx per batch: Summary, Flagged, Detail.

Detail columns exactly as specified: xero_line_id, date, amount, direction, fy, xero_description,
bank_narration, bank_category, merchant, funding_pair_id, action, proposed_account,
proposed_tax_type, matched_ledger, matched_date, matched_description, confidence, rationale,
flags, question.
"""

import datetime as dt
from dataclasses import dataclass, field
from typing import Optional

import openpyxl
from openpyxl.styles import Font, PatternFill

REVIEW_FLAGS = {
    "DIRECTOR_LOAN_REVIEW",
    "RELATED_PARTY_REVIEW",
    "F2K_ONCHARGE",
    "WBFREE_SETTLEMENT",
    "LINKED_ACCOUNT",
    "FY24_UNRECORDED",
    "MATCH_AMBIGUOUS",
    "MATCH_CHECK_LABEL",
    "AMBIGUOUS",
    "POSSIBLE_DUPLICATE",
    "GST_FREE_FINANCE",
    "GST_FREE_INTERNATIONAL_TRAVEL",
    "REVERSAL_PAIR",
    "NEEDS_MERCHANT_NORMALISATION",
    "NO_NARRATION_SOURCE",
    "NO_CONFIDENT_PATTERN",
    "MATCH_UNVERIFIED",
}

# Who to route each flag to first — matches scope doc §5/§10's own framing of who answers what.
FLAG_OWNER = {
    "DIRECTOR_LOAN_REVIEW": "Dennis",
    "RELATED_PARTY_REVIEW": "Ken",
    "F2K_ONCHARGE": "Rimal",
    "WBFREE_SETTLEMENT": "Rimal",
    "LINKED_ACCOUNT": "Rimal",
    "FY24_UNRECORDED": "Rimal",
    "MATCH_AMBIGUOUS": "Rimal",
    "MATCH_CHECK_LABEL": "Rimal",
    "AMBIGUOUS": "Rimal",
    "POSSIBLE_DUPLICATE": "Rimal",
    "GST_FREE_FINANCE": "Rimal",
    "GST_FREE_INTERNATIONAL_TRAVEL": "Rimal",
    "REVERSAL_PAIR": "Rimal",
    "NEEDS_MERCHANT_NORMALISATION": "Dennis",
    "NO_NARRATION_SOURCE": "Dennis",
    "NO_CONFIDENT_PATTERN": "Rimal",
    # Must stay in sync with run.py's QUESTION_TEMPLATES action keys -- a key present in one but
    # not the other is exactly how this dict silently under-counted "Questions for Rimal" earlier
    # today (MATCH_UNVERIFIED had a real, unanswered question but no owner mapping here, so it
    # was invisible to both the Flagged tab and the Summary count).
    "MATCH_UNVERIFIED": "Rimal",
}


@dataclass
class ReconLine:
    xero_line_id: str
    date: Optional[dt.date]
    amount: float
    direction: str  # 'Spend' | 'Receive'
    fy: str  # 'FY2023/24' | 'FY2024/25'
    xero_description: str
    bank_narration: str = ""
    bank_category: str = ""
    merchant: str = ""
    funding_pair_id: Optional[str] = None
    action: str = ""
    proposed_account: Optional[str] = None
    proposed_tax_type: Optional[str] = None
    matched_ledger: Optional[str] = None
    matched_date: Optional[dt.date] = None
    matched_description: Optional[str] = None
    confidence: str = ""
    rationale: str = ""
    flags: list[str] = field(default_factory=list)
    question: str = ""


DETAIL_COLUMNS = [
    "xero_line_id", "date", "amount", "direction", "fy", "xero_description", "bank_narration",
    "bank_category", "merchant", "funding_pair_id", "action", "proposed_account",
    "proposed_tax_type", "matched_ledger", "matched_date", "matched_description", "confidence",
    "rationale", "flags", "question",
]


def _effective_flags(line: ReconLine) -> list[str]:
    """`action` (MATCH_AMBIGUOUS, FY24_UNRECORDED, NO_CONFIDENT_PATTERN, ...) and `flags` (the
    hard-rule flags: DIRECTOR_LOAN_REVIEW, LINKED_ACCOUNT, ...) are separate fields on ReconLine,
    but REVIEW_FLAGS/FLAG_OWNER need to see both — without this, a line whose ONLY issue is
    MATCH_AMBIGUOUS never reached the Flagged tab at all (found 2026-09-27 running against the
    real live backlog: 2 genuinely ambiguous lines were silently missing from Flagged)."""
    return ([line.action] if line.action else []) + line.flags


def _row_for(line: ReconLine) -> list:
    return [
        line.xero_line_id, line.date, line.amount, line.direction, line.fy,
        line.xero_description, line.bank_narration, line.bank_category, line.merchant,
        line.funding_pair_id, line.action, line.proposed_account, line.proposed_tax_type,
        line.matched_ledger, line.matched_date, line.matched_description, line.confidence,
        line.rationale, ", ".join(line.flags), line.question,
    ]


def write_report(lines: list[ReconLine], output_path: str) -> None:
    wb = openpyxl.Workbook()

    # --- Summary ---
    summary = wb.active
    summary.title = "Summary"
    summary["A1"] = f"Reconciliation batch — {len(lines)} lines"
    summary["A2"] = f"Generated {dt.datetime.now().isoformat(timespec='seconds')}"

    by_action: dict[str, int] = {}
    # Spend and receive kept SEPARATE, never netted -- a $5,000 spend line and a $5,000 receive
    # line summing to $0 tells a reviewer nothing true about either of them (found reviewing real
    # output: the FY2023/24 total showed -$8,494.93, an arbitrary figure from netting unrelated
    # money in against unrelated money out).
    by_fy_spend: dict[str, float] = {}
    by_fy_receive: dict[str, float] = {}
    for l in lines:
        by_action[l.action] = by_action.get(l.action, 0) + 1
        if l.amount < 0:
            by_fy_spend[l.fy] = by_fy_spend.get(l.fy, 0.0) + (-l.amount)
        else:
            by_fy_receive[l.fy] = by_fy_receive.get(l.fy, 0.0) + l.amount

    row = 4
    summary.cell(row=row, column=1, value="Action").font = Font(bold=True)
    summary.cell(row=row, column=2, value="Count").font = Font(bold=True)
    row += 1
    for action, count in sorted(by_action.items()):
        summary.cell(row=row, column=1, value=action)
        summary.cell(row=row, column=2, value=count)
        row += 1

    row += 1
    summary.cell(row=row, column=1, value="FY").font = Font(bold=True)
    summary.cell(row=row, column=2, value="Total spend ($)").font = Font(bold=True)
    summary.cell(row=row, column=3, value="Total receive ($)").font = Font(bold=True)
    row += 1
    for fy in sorted(set(by_fy_spend) | set(by_fy_receive)):
        summary.cell(row=row, column=1, value=fy)
        summary.cell(row=row, column=2, value=round(by_fy_spend.get(fy, 0.0), 2))
        summary.cell(row=row, column=3, value=round(by_fy_receive.get(fy, 0.0), 2))
        row += 1

    # Count LINES THAT ACTUALLY HAVE A QUESTION, never "any row with an owned flag" -- the
    # six LINKED_ACCOUNT rows have no question at all (a transfer just IS a transfer, nothing to
    # ask), but "LINKED_ACCOUNT" maps to an owner in FLAG_OWNER, so the old count included them
    # anyway. Confirmed wrong on real output: Rimal showed 12 when only a handful of rows had a
    # real, non-blank question.
    def _owner_for(line: ReconLine) -> Optional[str]:
        if not line.question:
            return None
        return next((FLAG_OWNER[f] for f in _effective_flags(line) if f in FLAG_OWNER), None)

    row += 1
    questions_for_dennis = [l for l in lines if _owner_for(l) == "Dennis"]
    summary.cell(row=row, column=1, value=f"Questions for Dennis: {len(questions_for_dennis)}").font = Font(bold=True)
    row += 1
    questions_for_rimal = [l for l in lines if _owner_for(l) == "Rimal"]
    summary.cell(row=row, column=1, value=f"Questions for Rimal: {len(questions_for_rimal)}").font = Font(bold=True)
    row += 1
    questions_for_ken = [l for l in lines if _owner_for(l) == "Ken"]
    summary.cell(row=row, column=1, value=f"Questions for Ken: {len(questions_for_ken)}").font = Font(bold=True)

    # --- Flagged ---
    flagged = wb.create_sheet("Flagged")
    yellow = PatternFill(start_color="FFFF99", end_color="FFFF99", fill_type="solid")
    header = DETAIL_COLUMNS + ["for"]
    for col, name in enumerate(header, start=1):
        flagged.cell(row=1, column=col, value=name).font = Font(bold=True)
    r = 2
    for line in lines:
        effective = _effective_flags(line)
        if not any(f in REVIEW_FLAGS for f in effective):
            continue
        for col, value in enumerate(_row_for(line), start=1):
            flagged.cell(row=r, column=col, value=value).fill = yellow
        owner = next((FLAG_OWNER[f] for f in effective if f in FLAG_OWNER), "Rimal")
        flagged.cell(row=r, column=len(header), value=owner).fill = yellow
        r += 1

    # --- Detail ---
    detail = wb.create_sheet("Detail")
    for col, name in enumerate(DETAIL_COLUMNS, start=1):
        detail.cell(row=1, column=col, value=name).font = Font(bold=True)
    for r, line in enumerate(lines, start=2):
        for col, value in enumerate(_row_for(line), start=1):
            detail.cell(row=r, column=col, value=value)

    wb.save(output_path)
