"""Step 2 — internal transfers and pass-through pairs (scope doc §4 Step 2).

The 5 credits Phase 1 called "no confident category" were exactly this: funding transfers from a
second, not-yet-in-Xero linked NAB account, most paying a supplier or the ATO the same day. This
module is the fix for that specific class of error.
"""

import datetime as dt
import re
from dataclasses import dataclass
from typing import Optional

from narration import BankCsvRow

INTERNAL_TRANSFER_NARRATION = re.compile(r"^ONLINE \w+ .*GLOBAL BUILD$")


def is_internal_transfer(row: BankCsvRow) -> bool:
    if row.category.strip().lower() == "internal transfers":
        return True
    return bool(INTERNAL_TRANSFER_NARRATION.match(row.transaction_details.strip()))


@dataclass
class PassThroughMatch:
    counterpart: BankCsvRow
    project_keyword: Optional[str]


PROJECT_KEYWORDS = ["glen", "glnlgn", "gln", "nz", "oh", "f2k"]


def _extract_project_keyword(details: str) -> Optional[str]:
    lower = details.lower()
    for kw in PROJECT_KEYWORDS:
        if kw in lower:
            return kw
    return None


def find_pass_through(
    all_rows: list[BankCsvRow], transfer_row: BankCsvRow, window_days: int = 1
) -> Optional[PassThroughMatch]:
    """A same-amount, opposite-sign, non-internal line within ±window_days of the transfer."""
    target_amount = -transfer_row.amount
    for row in all_rows:
        if is_internal_transfer(row):
            continue
        if abs(row.amount - target_amount) < 0.005 and abs(
            (row.date - transfer_row.date).days
        ) <= window_days:
            return PassThroughMatch(
                counterpart=row,
                project_keyword=_extract_project_keyword(row.transaction_details),
            )
    return None
