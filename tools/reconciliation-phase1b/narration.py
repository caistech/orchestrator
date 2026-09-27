"""Step 1 — enrich an unreconciled Xero bank line with its real bank narration.

Xero's own Reference/LineItems description is frequently empty (9 of Batch 1's 18 lines had
nothing). The NAB CSV export always carries a narration for the same line. This module builds an
index of the CSV once, then looks up the best match for a given (amount, date).
"""

import csv
import datetime as dt
from dataclasses import dataclass
from typing import Optional

import config


@dataclass
class BankCsvRow:
    date: dt.date
    amount: float
    transaction_type: str
    transaction_details: str
    category: str
    merchant_name: str
    processed_on: Optional[dt.date]
    source_file: str


def _parse_nab_date(value: str) -> Optional[dt.date]:
    value = (value or "").strip()
    if not value:
        return None
    # NAB CSV format confirmed against the real file 2026-09-27: "16 May 26" == %d %b %y.
    return dt.datetime.strptime(value, "%d %b %y").date()


def load_nab_csvs(paths=None) -> list[BankCsvRow]:
    """Load every NAB CSV into one flat list. Duplicate rows across the two export windows
    (17052024_TO_17052026 and 22042025_TO_22052026 overlap by design) are left in — narration
    lookup only needs ONE match, and de-duplication is Step 6's job, not this module's."""
    paths = paths or config.GBTA_NAB_CSVS
    rows: list[BankCsvRow] = []
    for path in paths:
        with open(path, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for raw in reader:
                d = _parse_nab_date(raw.get("Date", ""))
                if d is None:
                    continue
                try:
                    amount = float(raw.get("Amount", "0") or 0)
                except ValueError:
                    continue
                rows.append(
                    BankCsvRow(
                        date=d,
                        amount=amount,
                        transaction_type=(raw.get("Transaction Type") or "").strip(),
                        transaction_details=(raw.get("Transaction Details") or "").strip(),
                        category=(raw.get("Category") or "").strip(),
                        merchant_name=(raw.get("Merchant Name") or "").strip(),
                        processed_on=_parse_nab_date(raw.get("Processed On", "")),
                        source_file=path,
                    )
                )
    return rows


@dataclass
class NarrationMatch:
    row: Optional[BankCsvRow]
    ambiguous_candidates: list[BankCsvRow]
    flag: Optional[str]  # 'NO_NARRATION_SOURCE' | 'AMBIGUOUS' | None


def find_narration(
    rows: list[BankCsvRow], amount: float, line_date: dt.date, window_days: int = 3
) -> NarrationMatch:
    """Step 1's join: account + amount (signed) + date, ±window_days. Prefer an exact date match;
    more than one candidate on the same date is AMBIGUOUS (scope doc §4 Step 1), never guessed."""
    candidates = [
        r
        for r in rows
        if abs(r.amount - amount) < 0.005
        and abs((r.date - line_date).days) <= window_days
    ]
    if not candidates:
        return NarrationMatch(row=None, ambiguous_candidates=[], flag="NO_NARRATION_SOURCE")

    exact_date = [r for r in candidates if r.date == line_date]
    pool = exact_date or candidates

    # De-dupe identical rows seen twice because the two CSV export windows overlap by design
    # (load_nab_csvs() keeps the overlap; that's a real duplicate transaction to catch in Step 6,
    # not a genuine ambiguity here — the SAME real bank line appearing in both files is one
    # candidate, not two).
    seen = set()
    deduped = []
    for r in pool:
        key = (r.date, r.amount, r.transaction_details)
        if key not in seen:
            seen.add(key)
            deduped.append(r)
    pool = deduped

    if len(pool) == 1:
        return NarrationMatch(row=pool[0], ambiguous_candidates=[], flag=None)

    # Multiple DISTINCT same-date (or same-window) candidates for the same amount — don't pick
    # silently.
    return NarrationMatch(row=pool[0], ambiguous_candidates=pool, flag="AMBIGUOUS")
