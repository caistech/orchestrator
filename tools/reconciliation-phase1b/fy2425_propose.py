"""Step 5 — FY2024/25+ coding proposals (scope doc §4 Step 5).

Deterministic pattern-match against the business's own prior coding history, NOT an LLM call —
this avoids needing a third credential (OPENAI_API_KEY) and, more importantly, is a closer fit to
the scope doc's own instruction to "prefer a documented prior pattern over a generic guess": a
direct lookup against what this business actually did before is more auditable than an LLM
re-deriving the same judgement probabilistically. Field mapping mirrors
src/connectors/xero.ts's fetchChartOfAccounts/fetchCodingHistory exactly (same Accounts/
BankTransactions shapes, proven working in that file).
"""

import datetime as dt
import re
from dataclasses import dataclass
from typing import Optional

import narration
import xero_client


@dataclass
class ChartAccount:
    code: str
    name: str
    account_type: str
    tax_type: Optional[str]


@dataclass
class CodingExample:
    description: str
    contact_name: Optional[str]
    account_code: Optional[str]
    tax_type: Optional[str]
    date: Optional[dt.date] = None
    amount: Optional[float] = None


@dataclass
class Proposal:
    account_code: Optional[str]
    tax_type: Optional[str]
    confidence: str  # 'High' | 'Medium' | 'Low'
    rationale: str


def fetch_chart_of_accounts(access_token: str, org_tenant_id: str) -> list[ChartAccount]:
    data = xero_client.xero_get('/Accounts?where=Status=="ACTIVE"', access_token, org_tenant_id)
    return [
        ChartAccount(
            code=str(a.get("Code", "")),
            name=str(a.get("Name", "")),
            account_type=str(a.get("Type", "")),
            tax_type=a.get("TaxType"),
        )
        for a in data.get("Accounts", [])
    ]


def fetch_coding_history(access_token: str, org_tenant_id: str, limit: int = 200) -> list[CodingExample]:
    """Same endpoint/shape as xero.ts's fetchCodingHistory, but a larger default limit (200, not
    50) — this runs as a one-off local batch job, not a per-request LLM context budget, so a
    bigger pattern-matching corpus is free here."""
    data = xero_client.xero_get(
        "/BankTransactions?where=IsReconciled==true&order=Date%20DESC&page=1",
        access_token,
        org_tenant_id,
    )
    raw = data.get("BankTransactions", [])[:limit]
    out = []
    for t in raw:
        line_items = t.get("LineItems") or [{}]
        description = (t.get("Reference") or "").strip() or (line_items[0].get("Description") or "").strip()
        date_str = t.get("DateString") or t.get("Date")
        line_date = None
        if date_str:
            try:
                line_date = dt.datetime.fromisoformat(date_str.split("T")[0]).date()
            except ValueError:
                pass
        # Xero's Total is always positive; Type carries direction separately (confirmed against
        # live data 2026-09-27 -- SPEND rows returned a positive Total, which silently broke the
        # amount-based join against the signed NAB CSV convention: 93 of 100 examples matched
        # nothing until this was signed to match).
        total = t.get("Total")
        signed_amount = -total if (total is not None and t.get("Type") == "SPEND") else total
        out.append(
            CodingExample(
                description=description,
                contact_name=(t.get("Contact") or {}).get("Name"),
                account_code=line_items[0].get("AccountCode"),
                tax_type=line_items[0].get("TaxType"),
                date=line_date,
                amount=signed_amount,
            )
        )
    return out


def enrich_with_bank_narration(
    history: list[CodingExample], csv_rows: list[narration.BankCsvRow]
) -> list[CodingExample]:
    """Xero's own reconciled history is often a thin, generic label ("GBTA OH", contact
    "Unknown") rather than the real merchant name — confirmed against live data (2026-09-27):
    the first 10 reconciled examples pulled had no usable merchant text at all. Reuse Step 1's
    same join (amount + date -> real NAB CSV narration) to attach the real merchant/category text
    onto each history example BEFORE building the keyword index, or matching against it is
    matching against noise."""
    enriched = []
    for h in history:
        if h.date is None or h.amount is None:
            enriched.append(h)
            continue
        match = narration.find_narration(csv_rows, h.amount, h.date)
        if match.row:
            merged = f"{h.description} {match.row.transaction_details} {match.row.category} {match.row.merchant_name}".strip()
            enriched.append(
                CodingExample(
                    description=merged,
                    contact_name=h.contact_name,
                    account_code=h.account_code,
                    tax_type=h.tax_type,
                    date=h.date,
                    amount=h.amount,
                )
            )
        else:
            enriched.append(h)
    return enriched


# Generic banking/narration vocabulary that carries no merchant signal — without this, "WOTSO
# direct debit" matched "SHIFT ... reversal of debit" purely on the word "debit" (confirmed
# against live data 2026-09-27: this produced a real, wrong Medium-confidence proposal).
STOPWORDS = {
    "the", "and", "for", "pty", "ltd", "inc", "pos", "eftpos", "online", "transfer", "debit",
    "credit", "direct", "payment", "trans", "gbta", "oh", "reversal", "reversed", "npp", "bpay",
}


def _keywords(text: str) -> set[str]:
    return {
        w.lower()
        for w in re.findall(r"[A-Za-z]{3,}", text)
        if w.lower() not in STOPWORDS
    }


def propose(
    narration_text: str,
    contact_name: Optional[str],
    history: list[CodingExample],
    chart: list[ChartAccount],
) -> Proposal:
    """Match by keyword overlap against prior coding examples. A tie or no match is Low confidence
    with no account/tax proposed — degrade, don't fake (DATA_STANDARD R4), never invent a code the
    chart of accounts doesn't have."""
    valid_codes = {a.code for a in chart}
    target_keywords = _keywords(narration_text) | _keywords(contact_name or "")

    scored: list[tuple[int, CodingExample]] = []
    for example in history:
        if not example.account_code or example.account_code not in valid_codes:
            continue
        example_keywords = _keywords(example.description) | _keywords(example.contact_name or "")
        overlap = len(target_keywords & example_keywords)
        if overlap > 0:
            scored.append((overlap, example))

    if not scored:
        return Proposal(
            account_code=None,
            tax_type=None,
            confidence="Low",
            rationale="No prior coding history keyword-matches this narration — no confident pattern.",
        )

    scored.sort(key=lambda x: x[0], reverse=True)
    top_score = scored[0][0]
    top_matches = [e for score, e in scored if score == top_score]

    # Agreement among the top matches raises confidence; disagreement caps it.
    codes_at_top = {e.account_code for e in top_matches}
    if len(codes_at_top) > 1:
        return Proposal(
            account_code=None,
            tax_type=None,
            confidence="Low",
            rationale=(
                f"Keyword overlap found but prior coding disagrees across matches "
                f"({', '.join(sorted(codes_at_top))}) — not a confident single pattern."
            ),
        )

    best = top_matches[0]
    confidence = "High" if (top_score >= 2 and len(top_matches) >= 2) else "Medium"
    return Proposal(
        account_code=best.account_code,
        tax_type=best.tax_type,
        confidence=confidence,
        rationale=(
            f"Matches {len(top_matches)} prior coding example(s) with {top_score} shared "
            f"keyword(s), e.g. {best.description!r} -> account {best.account_code}."
        ),
    )
