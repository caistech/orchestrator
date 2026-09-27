"""Entrypoint — wires all 7 steps together against the FULL live unreconciled backlog (scope doc
§7: batch size 50, oldest first, FY2023/24 and FY2024/25 in SEPARATE batches).

Needs XERO_CLIENT_ID / XERO_CLIENT_SECRET as environment variables (never commit them).

Run: python run.py
Output: output/fy2324_batch_N.xlsx, output/fy2425_batch_N.xlsx (gitignored — real transaction data)
"""

import datetime as dt
import os
import sys
from typing import Optional

import answers
import config
import dedupe
import fy2324_match
import fy2425_propose
import narration
import rules
import transfers
import xero_client
from report import ReconLine, write_report

BATCH_SIZE = 50


def fetch_all_unreconciled(access_token: str, org_tenant_id: str) -> list[dict]:
    """Mirrors src/reconciliation-detector.ts's own page-walk exactly (same bound: stop at page
    50 / ~5000 lines rather than walking unattended forever)."""
    lines = []
    page = 1
    while page <= 50:
        data = xero_client.xero_get(
            f"/BankTransactions?where=IsReconciled==false&order=Date%20ASC&page={page}",
            access_token,
            org_tenant_id,
        )
        batch = data.get("BankTransactions", [])
        if not batch:
            break
        for t in batch:
            line_items = t.get("LineItems") or [{}]
            description = (t.get("Reference") or "").strip() or (
                line_items[0].get("Description") or ""
            ).strip()
            date_str = t.get("DateString") or t.get("Date")
            line_date = None
            if date_str:
                try:
                    line_date = dt.datetime.fromisoformat(date_str.split("T")[0]).date()
                except ValueError:
                    pass
            total = t.get("Total")
            signed_amount = -total if (total is not None and t.get("Type") == "SPEND") else total
            lines.append(
                {
                    "id": t.get("BankTransactionID"),
                    "date": line_date,
                    "amount": signed_amount,
                    "description": description or "No description",
                    "contact_name": (t.get("Contact") or {}).get("Name"),
                }
            )
        if len(batch) < 100:
            break
        page += 1
    return lines


# Templated, non-blank starting-point questions per action/flag. Not as specific as a hand-written
# question (a human still reads and can sharpen these), but the field must never be blank — a
# blank "question" column next to a line marked "needs review" was one of the real bugs found
# running this against live data: it looks answered when nothing was ever asked.
QUESTION_TEMPLATES = {
    "FY24_UNRECORDED": "This line wasn't found in the ledgers/notes we hold — can you confirm how it was (or should be) coded in the FINAL FY23/24 accounts?",
    "MATCH_UNVERIFIED": "A candidate ledger entry may exist for this line but hasn't been confirmed against the real ledger — can you confirm which entry (if any) this matches?",
    "MATCH_CHECK_LABEL": "The ledger label for this line doesn't match its actual amount/date — can you confirm which entry this really is, and correct the label?",
    "DIRECTOR_LOAN_REVIEW": "Is there a receipt/business purpose on file for this transfer, or should it be treated as drawings?",
    "RELATED_PARTY_REVIEW": "Should this be treated as a NatureZen related-party item rather than a GBTA cost?",
    "LINKED_ACCOUNT_CHECK": "This wasn't found in the GBTA bank data we hold — was it paid from the second, linked NAB account?",
}


def _question_for(action: str, flags: list[str]) -> tuple[Optional[str], str]:
    """Returns (question_text, owner). Priority: action-level question first (it's the primary
    thing needing an answer), then the first flag with a template."""
    if action in QUESTION_TEMPLATES:
        from report import FLAG_OWNER
        return QUESTION_TEMPLATES[action], FLAG_OWNER.get(action, "Rimal")
    for f in flags:
        if f in QUESTION_TEMPLATES:
            from report import FLAG_OWNER
            return QUESTION_TEMPLATES[f], FLAG_OWNER.get(f, "Rimal")
    return None, ""


def process_line(
    line: dict,
    csv_rows: list[narration.BankCsvRow],
    seed: list[fy2324_match.SeedEntry],
    history: list[fy2425_propose.CodingExample],
    chart: list[fy2425_propose.ChartAccount],
    confirmed_answers: Optional[dict] = None,
) -> ReconLine:
    line_date = line["date"]
    amount = line["amount"]
    xero_desc = line["description"]

    # ALWAYS attempt the real bank-CSV lookup, regardless of what Xero's own description says.
    # Xero sometimes carries a non-empty but uninformative placeholder ("No bank statement line")
    # rather than a genuinely empty field — a strict `== "No description"` check missed those
    # entirely (found running against live data: 6 internal-transfer lines were never even
    # checked against the CSV or the transfer/rule logic because of exactly this). Real bank
    # narration is always preferred over Xero's own text when both exist.
    bank_narration_text = ""
    bank_category = ""
    merchant = ""
    rule_flags = rules.RuleFlags()
    match_text_for_rules = xero_desc
    funding_pair_id = None

    if line_date is not None:
        match = narration.find_narration(csv_rows, amount, line_date)
        if match.row:
            bank_narration_text = match.row.transaction_details
            bank_category = match.row.category
            merchant = match.row.merchant_name
            match_text_for_rules = bank_narration_text
        elif xero_desc and xero_desc not in ("No description", "No bank statement line"):
            match_text_for_rules = xero_desc
            bank_narration_text = xero_desc  # no CSV coverage for this date (e.g. pre-17-May-2024)
            # — still show Xero's own text rather than leaving the Detail tab blank.

        fake_row = narration.BankCsvRow(
            date=line_date, amount=amount, transaction_type="", transaction_details=match_text_for_rules,
            category=bank_category, merchant_name=merchant, processed_on=None, source_file="xero",
        )
        is_transfer = transfers.is_internal_transfer(fake_row)

        if is_transfer:
            # A transfer is money movement, not a cost -- it must NEVER inherit a cost-type flag
            # (RELATED_PARTY_REVIEW, ATO_ICA, GST rules) just because its own NAB memo happens to
            # mention what it was raised for ("Arb GLN", "ATO GST MAY 2024"). That substance
            # belongs to the payment it funded, not to this credit line (found on real output:
            # a $866.25 CREDIT was flagged RELATED_PARTY_REVIEW and routed to Ken, when the actual
            # related-party item is the Hewson Timber PAYMENT it funded, on a different line).
            pass_through = transfers.find_pass_through(csv_rows, match.row) if match.row else None
            if pass_through:
                funding_pair_id = pass_through.counterpart.transaction_details
        else:
            rule_flags = rules.apply_hard_rules(fake_row, is_transfer)
    else:
        is_transfer = False
        pass_through = None

    fy = "FY2023/24" if (line_date is None or config.is_fy2324(line_date)) else "FY2024/25"

    matched_ledger, matched_date, matched_description = None, None, None
    proposed_account, proposed_tax, confidence, propose_rationale = None, None, "n/a", ""

    if is_transfer:
        # Step 2's own bank-CSV tagging is direct evidence and takes priority over whatever the
        # seed tabs separately say — matches the scope doc's own Step 4 table exactly ("Internal
        # transfer (Step 2) -> LINKED_ACCOUNT").
        action = "LINKED_ACCOUNT"
        confidence = "High"
        proposed_account = "Linked NAB account (bank/clearing) — not income"
        rule_flags = rules.RuleFlags(flags=["LINKED_ACCOUNT"])
        if funding_pair_id:
            propose_rationale = (
                f"NAB-categorised internal transfer — the linked NAB account, never income or "
                f"expense. Funds: {funding_pair_id} — check THAT payment's own treatment "
                f"separately; this transfer itself is not the cost."
            )
        else:
            propose_rationale = (
                "NAB-categorised internal transfer — the linked NAB account, never income or "
                "expense. No same-day counterpart found."
            )
    elif fy == "FY2023/24":
        match_result = fy2324_match.match_fy2324(seed, amount, line_date) if line_date else None
        action = match_result.action if match_result else "FY24_UNRECORDED"
        if match_result and match_result.matches:
            # Only a genuine citation (MATCH_EXISTING / MATCH_CHECK_LABEL) may show a
            # matched_ledger/matched_date -- these must come from the seed entry's OWN parsed
            # citation, never the seed tab's own name or the transaction's own date. Confirmed
            # wrong on real output: every "match" cited "Batch 1 Review" (our own analysis tab,
            # not Chequers' ledger) with a date that was just the transaction's own date copied
            # across (Haper showed the transaction date 17 May when the real JE is dated 5 Jun).
            candidates_with_citation = [m for m in match_result.matches if m.matched_ledger]
            best = candidates_with_citation[0] if candidates_with_citation else match_result.matches[0]
            if action in ("MATCH_EXISTING", "MATCH_CHECK_LABEL"):
                matched_ledger = best.matched_ledger
                matched_date = best.matched_date
            matched_description = best.matched_description
        confidence = "High" if action == "MATCH_EXISTING" else "Medium" if action in ("MATCH_UNVERIFIED", "MATCH_CHECK_LABEL") else "Low"
        propose_rationale = "FY2023/24 — match only, never a fresh proposal."
        # A descriptive label, not a Xero account CODE, and never written anywhere (this tool has
        # no write path at all) -- but where the treatment genuinely IS known, showing it beats
        # leaving the column blank next to a confident verdict. Only set where something is
        # actually known; MATCH_UNVERIFIED stays blank rather than guessing.
        if "GST_FREE_INTERNATIONAL_TRAVEL" in rule_flags.flags:
            proposed_account, proposed_tax = "Travel - International", "GST Free Expenses"
        elif action == "MATCH_EXISTING":
            proposed_account = "As coded by Chequers"
        elif action == "FY24_UNRECORDED" and "DIRECTOR_LOAN_REVIEW" in rule_flags.flags:
            proposed_account = "Owner A Drawings"
    else:
        direction = "spend" if amount < 0 else "receive"
        proposal = fy2425_propose.propose(
            match_text_for_rules, line["contact_name"], history, chart, direction, bank_category
        )
        proposed_account, proposed_tax = proposal.account_code, proposal.tax_type
        confidence, propose_rationale = proposal.confidence, proposal.rationale
        action = "PROPOSE_CODING" if proposal.account_code else "NO_CONFIDENT_PATTERN"

    flags = rule_flags.flags
    rationale = ", ".join(rule_flags.notes) if rule_flags.notes else propose_rationale

    question, owner = _question_for(action, flags)

    # Point 1 -- an already-confirmed answer overrides the mechanical result and clears the
    # question. Without this, a re-run re-asks a question that was already answered in a real
    # conversation (found reviewing the corrected Batch 1 output: Napa/Santa Rosa still asked
    # "which entry", and the $280/$500 lines still asked whether a receipt existed, despite both
    # having been answered directly).
    answer = (confirmed_answers or {}).get(line["id"])
    if answer:
        if answer.action:
            action = answer.action
        if answer.proposed_account:
            proposed_account = answer.proposed_account
        if answer.proposed_tax_type:
            proposed_tax = answer.proposed_tax_type
        confirmed_note = f"CONFIRMED ({answer.answered_by}): {answer.note}" if answer.note else f"Confirmed by {answer.answered_by}."
        rationale = f"{confirmed_note} {rationale}".strip()
        question = ""

    return ReconLine(
        xero_line_id=line["id"],
        date=line_date,
        amount=amount,
        direction="Spend" if amount < 0 else "Receive",
        fy=fy,
        xero_description=xero_desc,
        bank_narration=bank_narration_text,
        bank_category=bank_category,
        merchant=merchant,
        funding_pair_id=funding_pair_id,
        action=action,
        proposed_account=proposed_account,
        proposed_tax_type=proposed_tax,
        matched_ledger=matched_ledger,
        matched_date=matched_date,
        matched_description=matched_description,
        confidence=confidence,
        rationale=rationale,
        flags=flags,
        question=question or "",
    )


def main():
    client_id = os.environ.get("XERO_CLIENT_ID")
    client_secret = os.environ.get("XERO_CLIENT_SECRET")
    if not client_id or not client_secret:
        print("XERO_CLIENT_ID / XERO_CLIENT_SECRET must be set. Not running against live Xero.")
        sys.exit(1)

    conn = xero_client.connection_for(config.GBTA_TENANT_ID)
    token = xero_client.access_token_for(conn)

    print("Fetching full unreconciled backlog from Xero...")
    all_lines = fetch_all_unreconciled(token, config.XERO_ORG_TENANT_ID)
    print(f"{len(all_lines)} unreconciled lines found.")

    csv_rows = narration.load_nab_csvs()
    seed = fy2324_match.load_seed()
    chart = fy2425_propose.fetch_chart_of_accounts(token, config.XERO_ORG_TENANT_ID)
    raw_history = fy2425_propose.fetch_coding_history(token, config.XERO_ORG_TENANT_ID)
    history = fy2425_propose.enrich_with_bank_narration(raw_history, csv_rows)
    confirmed_answers = answers.load_answers()
    print(f"{len(confirmed_answers)} confirmed answer(s) loaded from {answers.ANSWERS_PATH}.")

    recon_lines = [process_line(l, csv_rows, seed, history, chart, confirmed_answers) for l in all_lines]

    dup_input = [{"id": l.xero_line_id, "amount": l.amount, "date": l.date} for l in recon_lines if l.date]
    dupes = dedupe.find_possible_duplicates(dup_input)
    dupe_ids = {d.line_a_id for d in dupes} | {d.line_b_id for d in dupes}
    for l in recon_lines:
        if l.xero_line_id in dupe_ids:
            l.flags.append("POSSIBLE_DUPLICATE")

    fy2324_lines = sorted((l for l in recon_lines if l.fy == "FY2023/24"), key=lambda l: l.date or dt.date.min)
    fy2425_lines = sorted((l for l in recon_lines if l.fy == "FY2024/25"), key=lambda l: l.date or dt.date.min)

    # The real invariant (scope doc §8): the FY24/25 pattern-matching GUESS engine (Step 5) must
    # never run against a lodged year. proposed_account itself is allowed to carry a descriptive
    # label for FY2023/24 lines with a known treatment (e.g. "Linked NAB account", "Owner A
    # Drawings") -- that's grounded in an actual determination, not a guess, and the reference
    # correction Dennis produced by hand does exactly this. What must never happen is a FY2023/24
    # line getting Step 5's PROPOSE_CODING/NO_CONFIDENT_PATTERN action, which only fy2425_propose
    # can produce.
    fy2324_guessed = [l for l in fy2324_lines if l.action in ("PROPOSE_CODING", "NO_CONFIDENT_PATTERN")]
    assert not fy2324_guessed, (
        f"ACCEPTANCE CRITERION VIOLATED: {len(fy2324_guessed)} FY2023/24 lines went through the "
        f"FY2024/25 coding-proposal engine — scope doc §8 requires zero."
    )

    os.makedirs("output", exist_ok=True)
    written = []
    for label, lines in [("fy2324", fy2324_lines), ("fy2425", fy2425_lines)]:
        for i in range(0, len(lines), BATCH_SIZE):
            batch = lines[i : i + BATCH_SIZE]
            batch_num = i // BATCH_SIZE + 1
            suffix = os.environ.get("OUTPUT_SUFFIX", "")
            path = f"output/{label}_batch_{batch_num}{suffix}.xlsx"
            write_report(batch, path)
            written.append((path, len(batch)))

    print(f"\n{len(recon_lines)} total lines processed ({len(fy2324_lines)} FY2023/24, "
          f"{len(fy2425_lines)} FY2024/25). {len(dupes)} possible-duplicate pairs.")
    for path, count in written:
        print(f"  wrote {path} ({count} lines)")


if __name__ == "__main__":
    main()
