"""Point 1 — an answer-intake mechanism, so a question already answered (by Dennis, Rimal or Ken)
is never asked again on a re-run. Without this, every re-run re-asks "which entry, if any?" and
"do you have a receipt?" even after those were answered in conversation — the exact problem found
reviewing the corrected Batch 1 output, where Dennis's own confirmed answers weren't reflected.

Deliberately a flat, human-editable JSON file, not a database -- this is a handful of confirmed
facts per batch, reviewed and added by a person, not a high-volume store. Keyed by the real Xero
BankTransactionID, since that's the one stable identifier that survives a re-run against live data
(dates/amounts can shift slightly on re-fetch; the id does not).
"""

import json
import os
from dataclasses import dataclass
from typing import Optional

ANSWERS_PATH = os.path.join(os.path.dirname(__file__), "answers.json")


@dataclass
class Answer:
    action: Optional[str] = None
    proposed_account: Optional[str] = None
    proposed_tax_type: Optional[str] = None
    rationale: Optional[str] = None
    answered_by: str = ""
    note: str = ""


def load_answers(path: str = None) -> dict[str, Answer]:
    path = path or ANSWERS_PATH
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    return {
        xero_line_id: Answer(**entry)
        for xero_line_id, entry in raw.items()
    }


def save_answer(xero_line_id: str, answer: Answer, path: str = None) -> None:
    path = path or ANSWERS_PATH
    answers = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            answers = json.load(f)
    answers[xero_line_id] = {
        "action": answer.action,
        "proposed_account": answer.proposed_account,
        "proposed_tax_type": answer.proposed_tax_type,
        "rationale": answer.rationale,
        "answered_by": answer.answered_by,
        "note": answer.note,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(answers, f, indent=2, sort_keys=True)
