"""Step 4 — FY2023/24 matching (scope doc §4 Step 4). NEVER proposes new coding for this year;
Chequers already lodged it (5 Aug 2025). Every FY2023/24 line gets a match-or-flag, nothing else.

Interim seed source (scope doc §3): the guidance pack's own tabs, built by hand against Chequers'
DRAFT ledgers. This function is deliberately isolated so swapping in Rimal's FINAL ledgers later
(config.FY2324_FINAL_OWNER_A_DRAWINGS_LEDGER etc.) is a change to THIS file only.
"""

import datetime as dt
from dataclasses import dataclass
from typing import Optional

import openpyxl

import config

SEED_TABS = ["Batch 1 Review", "Internal Transfers", "Dennis Transfers FY23-24"]


@dataclass
class SeedEntry:
    date: Optional[dt.date]
    amount: float
    source_tab: str
    detail: str  # whatever "suggested action" / "match result" text that tab carries


def _to_date(value) -> Optional[dt.date]:
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    return None


def load_seed(path: str = None) -> list[SeedEntry]:
    """Read every seed tab present in the guidance pack. Column layout differs per tab (each was
    built for a different question), so this reads generically: first datetime-typed cell in the
    row is the date, first float-typed cell is the amount, everything else joins as detail text."""
    path = path or config.GUIDANCE_PACK
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    entries: list[SeedEntry] = []

    for tab in SEED_TABS:
        if tab not in wb.sheetnames:
            continue
        ws = wb[tab]
        for row in ws.iter_rows(values_only=True):
            row_date = None
            row_amount = None
            texts = []
            for cell in row:
                if row_date is None and isinstance(cell, (dt.datetime, dt.date)):
                    row_date = _to_date(cell)
                elif row_amount is None and isinstance(cell, (int, float)):
                    row_amount = float(cell)
                elif isinstance(cell, str) and cell.strip():
                    texts.append(cell.strip())
            if row_amount is None:
                continue  # header/blank/notes row, not a data row
            entries.append(
                SeedEntry(date=row_date, amount=row_amount, source_tab=tab, detail=" | ".join(texts))
            )
    return entries


@dataclass
class FY2324MatchResult:
    action: str  # 'MATCH_EXISTING' | 'MATCH_CHECK_LABEL' | 'MATCH_AMBIGUOUS' | 'FY24_UNRECORDED'
    matches: list[SeedEntry]


def match_fy2324(seed: list[SeedEntry], amount: float, line_date: dt.date, window_days: int = 7) -> FY2324MatchResult:
    candidates = [
        e
        for e in seed
        if abs(abs(e.amount) - abs(amount)) < 0.005
        and (e.date is None or abs((e.date - line_date).days) <= window_days)
    ]
    if not candidates:
        return FY2324MatchResult(action="FY24_UNRECORDED", matches=[])
    if len(candidates) == 1:
        return FY2324MatchResult(action="MATCH_EXISTING", matches=candidates)
    return FY2324MatchResult(action="MATCH_AMBIGUOUS", matches=candidates)
