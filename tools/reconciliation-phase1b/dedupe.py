"""Step 6 — duplicate check (scope doc §4 Step 6).

Flags POSSIBLE_DUPLICATE where two Xero bank lines share account + amount + date (±2 days) and one
came from an imported statement while the other came from the bank feed. This is the scope doc's
own suspected cause of the 30 June 2024 bank-gap variance (§4, §6).

Xero's /BankTransactions doesn't expose "imported vs bank-feed" directly on the transaction itself
in the shape this tool reads (Type is SPEND/RECEIVE, not import-source) -- BankTransactionID
prefixes/patterns and the source_file distinction on our OWN CSV rows are the only signal
available without a deeper Xero API call this build doesn't make. This module flags candidate
DUPLICATE PAIRS by amount+date proximity; confirming "imported statement vs bank feed" is a human
check against the Xero UI, same as scope doc §6 frames it (a suspected cause, not a proven one).
"""

import datetime as dt
from dataclasses import dataclass


@dataclass
class DupeCandidate:
    line_a_id: str
    line_b_id: str
    amount: float
    date_a: dt.date
    date_b: dt.date


def find_possible_duplicates(lines: list[dict], window_days: int = 2) -> list[DupeCandidate]:
    """`lines` is a list of {'id': ..., 'amount': float, 'date': date} — deliberately the minimal
    shape, so this composes with whatever Step 1-5 already produced rather than importing a new
    line type."""
    candidates: list[DupeCandidate] = []
    seen_pairs = set()
    for i, a in enumerate(lines):
        for b in lines[i + 1 :]:
            if a["id"] == b["id"]:
                continue
            pair_key = tuple(sorted([a["id"], b["id"]]))
            if pair_key in seen_pairs:
                continue
            if abs(a["amount"] - b["amount"]) < 0.005 and abs(
                (a["date"] - b["date"]).days
            ) <= window_days:
                seen_pairs.add(pair_key)
                candidates.append(
                    DupeCandidate(
                        line_a_id=a["id"],
                        line_b_id=b["id"],
                        amount=a["amount"],
                        date_a=a["date"],
                        date_b=b["date"],
                    )
                )
    return candidates
