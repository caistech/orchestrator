"""Step 4 — FY2023/24 matching (scope doc §4 Step 4). NEVER proposes new coding for this year;
Chequers already lodged it (5 Aug 2025). Every FY2023/24 line gets a match-or-flag, nothing else.

Interim seed source (scope doc §3): the guidance pack's own tabs, built by hand against Chequers'
DRAFT ledgers. This function is deliberately isolated so swapping in Rimal's FINAL ledgers later
(config.FY2324_FINAL_OWNER_A_DRAWINGS_LEDGER etc.) is a change to THIS file only.

v2 (2026-09-27) — rewritten after a real run produced 16 of 18 lines labelled MATCH_EXISTING when
almost none of them were. The bug: v1 treated "this (date, amount) appears somewhere in the
guidance pack" as equivalent to "this line is recorded in Chequers' actual ledger" -- but most
rows in the guidance pack are DENNIS'S OWN ANALYSIS about a line, and that analysis frequently
says "No -- not in the ledger", "internal transfer", or "label mismatch". Presence in the seed
pack is not a verdict; the SEED TAB'S OWN COLUMNS carry the verdict, and this version reads them
by their real, known structure instead of dumping every column into one free-text blob.
"""

import datetime as dt
from dataclasses import dataclass, field
from typing import Optional

import openpyxl

import config


@dataclass
class SeedEntry:
    date: Optional[dt.date]
    amount: float
    source_tab: str
    verdict: str  # 'FOUND' | 'NOT_FOUND' | 'INTERNAL_TRANSFER' | 'LABEL_MISMATCH' | 'UNVERIFIED'
    matched_ledger: Optional[str] = None
    matched_date: Optional[dt.date] = None
    matched_description: Optional[str] = None
    detail: str = ""  # human-readable, for the rationale column


def _to_date(value) -> Optional[dt.date]:
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    return None


def _load_batch1_review(ws) -> list[SeedEntry]:
    """Columns: Date, Amount, Xero shows, Bank narration, Already in Chequers FY23/24 ledgers?,
    Suggested action, Rimal notes."""
    entries = []
    for row in ws.iter_rows(min_row=5, values_only=True):
        date_val, amount, xero_shows, bank_narration, in_ledgers, suggested, _ = row
        if amount is None:
            continue
        in_ledgers_text = (in_ledgers or "").strip()
        suggested_text = (suggested or "").strip()

        if "LABEL MISMATCH" in in_ledgers_text.upper():
            verdict = "LABEL_MISMATCH"
        elif "internal transfer" in suggested_text.lower():
            verdict = "INTERNAL_TRANSFER"
        elif in_ledgers_text.lower().startswith("yes"):
            verdict = "FOUND"
        elif in_ledgers_text.lower().startswith("not checked"):
            verdict = "UNVERIFIED"
        elif in_ledgers_text.lower().startswith("no"):
            verdict = "NOT_FOUND"
        else:
            verdict = "UNVERIFIED"

        entries.append(
            SeedEntry(
                date=_to_date(date_val),
                amount=float(amount),
                source_tab="Batch 1 Review",
                verdict=verdict,
                matched_description=f"{xero_shows} | {in_ledgers_text}" if in_ledgers_text else xero_shows,
                detail=suggested_text or in_ledgers_text,
            )
        )
    return entries


def _load_internal_transfers(ws) -> list[SeedEntry]:
    """Every row in this tab IS an internal transfer, by definition (the tab's own header: "None
    of these are income"). No column-level judgement needed -- the verdict is fixed by which tab
    the row lives in."""
    entries = []
    for row in ws.iter_rows(min_row=5, values_only=True):
        if len(row) < 11 or row[3] is None:
            continue
        date_val, fy, direction, amount, bank_narration = row[0], row[1], row[2], row[3], row[4]
        passthrough_narration = row[8] if len(row) > 8 else None
        entries.append(
            SeedEntry(
                date=_to_date(date_val),
                amount=float(amount),
                source_tab="Internal Transfers",
                verdict="INTERNAL_TRANSFER",
                matched_description=(
                    f"Pass-through: {passthrough_narration}" if passthrough_narration
                    else "Pass-through: None found"
                ),
                detail=str(bank_narration or ""),
            )
        )
    return entries


def _load_dennis_transfers(ws) -> list[SeedEntry]:
    """Columns: Date, Amount, Bank narration, Data source, Match result, Ledger line matched,
    What the narration suggests, Rimal: how coded in final FY23/24?. "Match result" says "Matched"
    for essentially every row, but that only means "a candidate ledger line exists at this
    amount" -- NOT that Rimal has confirmed it. The real confirmation column (the last one) is
    blank for all of them, so this tab's own verdict is UNVERIFIED, not FOUND, until Rimal
    actually answers it."""
    entries = []
    for row in ws.iter_rows(min_row=5, values_only=True):
        if len(row) < 8 or row[1] is None:
            continue
        date_val, amount, bank_narration = row[0], row[1], row[2]
        narration_suggests = row[6]
        rimal_answer = row[7]
        verdict = "FOUND" if (rimal_answer and str(rimal_answer).strip()) else "UNVERIFIED"
        entries.append(
            SeedEntry(
                date=_to_date(date_val),
                amount=float(amount),
                source_tab="Dennis Transfers FY23-24",
                verdict=verdict,
                matched_description=str(narration_suggests or ""),
                detail=str(bank_narration or ""),
            )
        )
    return entries


SEED_LOADERS = {
    "Batch 1 Review": _load_batch1_review,
    "Internal Transfers": _load_internal_transfers,
    "Dennis Transfers FY23-24": _load_dennis_transfers,
}


def load_seed(path: str = None) -> list[SeedEntry]:
    path = path or config.GUIDANCE_PACK
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    entries: list[SeedEntry] = []
    for tab, loader in SEED_LOADERS.items():
        if tab in wb.sheetnames:
            entries.extend(loader(wb[tab]))
    return entries


VERDICT_TO_ACTION = {
    "FOUND": "MATCH_EXISTING",
    "NOT_FOUND": "FY24_UNRECORDED",
    "INTERNAL_TRANSFER": "LINKED_ACCOUNT",
    "LABEL_MISMATCH": "MATCH_CHECK_LABEL",
    "UNVERIFIED": "MATCH_UNVERIFIED",
}


@dataclass
class FY2324MatchResult:
    action: str
    matches: list[SeedEntry] = field(default_factory=list)


def match_fy2324(seed: list[SeedEntry], amount: float, line_date: dt.date, window_days: int = 7) -> FY2324MatchResult:
    # Compare SIGNED amounts, never abs() -- the seed tabs' own Amount columns are already signed
    # to match the NAB CSV convention (confirmed: "Out" rows are negative). Stripping sign before
    # comparing let a real -$8,165.52 spend (Dowell Windows) collide with a completely unrelated
    # +$8,165.52 internal-transfer RECEIPT on the same date that only shared its magnitude by
    # coincidence -- found running against live data, not assumed.
    candidates = [
        e
        for e in seed
        if abs(e.amount - amount) < 0.005
        and (e.date is None or abs((e.date - line_date).days) <= window_days)
    ]
    if not candidates:
        return FY2324MatchResult(action="FY24_UNRECORDED", matches=[])

    # Prefer an exact-date match (same precedent as narration.py) before falling back to the
    # window -- a recurring weekly transfer of the same amount means several genuinely distinct
    # transactions can share amount within 7 days.
    exact_date = [c for c in candidates if c.date == line_date]
    pool = exact_date or candidates

    verdicts = {c.verdict for c in pool}
    if len(verdicts) == 1:
        return FY2324MatchResult(action=VERDICT_TO_ACTION[verdicts.pop()], matches=pool)

    # UNVERIFIED ("haven't confirmed yet") is not a genuine conflict with any of the other,
    # more definitive verdicts -- it's simply less informative, and a second seed tab having
    # nothing to add should never downgrade a real finding into "ambiguous". Found running
    # against live data: the Dennis Transfers tab has its own UNVERIFIED row for a line the Batch
    # 1 Review tab had already determined NOT_FOUND, and treating that as a conflict produced
    # MATCH_AMBIGUOUS for a line that should have been the more useful FY24_UNRECORDED.
    definitive = verdicts - {"UNVERIFIED"}
    if len(definitive) == 1:
        pool = [c for c in pool if c.verdict != "UNVERIFIED"] or pool
        return FY2324MatchResult(action=VERDICT_TO_ACTION[definitive.pop()], matches=pool)

    # Different seed tabs give GENUINELY conflicting definitive verdicts -- report the
    # disagreement rather than picking one silently. INTERNAL_TRANSFER always wins: Step 2's own
    # bank-CSV tagging is independent evidence, and if any seed source called this a transfer,
    # that's not something a differently-worded seed row should be allowed to override.
    if "INTERNAL_TRANSFER" in verdicts:
        return FY2324MatchResult(action="LINKED_ACCOUNT", matches=pool)
    if "LABEL_MISMATCH" in verdicts:
        return FY2324MatchResult(action="MATCH_CHECK_LABEL", matches=pool)
    return FY2324MatchResult(action="MATCH_AMBIGUOUS", matches=pool)
