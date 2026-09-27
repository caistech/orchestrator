"""End-to-end run of the Phase 1b pipeline against the known 18 Batch-1 lines (all FY2023/24, so
Step 5 / live Xero access is never reached — this batch is fully buildable and testable today).

Fixture source: the guidance workbook's own "Batch 1 Review" tab (same as verify_batch1.py), so
this is the real, corrected Batch 1 output — not a demo on synthetic data.

Run: python run_batch1.py
Output: output/batch1_corrected.xlsx (gitignored — real transaction data)
"""

import datetime as dt
import os

import openpyxl

import config
import dedupe
import fy2324_match
import narration
import rules
import transfers
from report import ReconLine, write_report


def load_batch1_lines():
    wb = openpyxl.load_workbook(config.GUIDANCE_PACK, read_only=True, data_only=True)
    ws = wb["Batch 1 Review"]
    lines = []
    for i, r in enumerate(ws.iter_rows(min_row=5, values_only=True)):
        date_val, amount, xero_shows, bank_narration, in_chequers, suggested_action, _ = r
        if amount is None:
            continue
        line_date = date_val.date() if isinstance(date_val, dt.datetime) else None
        lines.append(
            {
                "id": f"batch1-line-{i}",
                "date": line_date,
                "amount": float(amount),
                "xero_description": xero_shows,
            }
        )
    return lines


def main():
    csv_rows = narration.load_nab_csvs()
    seed = fy2324_match.load_seed()
    fixture = load_batch1_lines()

    recon_lines = []
    for line in fixture:
        amount = line["amount"]
        line_date = line["date"]
        xero_desc = line["xero_description"] or ""

        bank_narration_text = ""
        bank_category = ""
        merchant = ""
        is_transfer = False
        rule_flags = None

        if line_date is not None:
            if xero_desc == "No description" or not xero_desc:
                match = narration.find_narration(csv_rows, amount, line_date)
                if match.row:
                    bank_narration_text = match.row.transaction_details
                    bank_category = match.row.category
                    merchant = match.row.merchant_name
                    is_transfer = transfers.is_internal_transfer(match.row)
                    rule_flags = rules.apply_hard_rules(match.row, is_transfer)
                else:
                    rule_flags = rules.RuleFlags(flags=["NO_NARRATION_SOURCE"])
            else:
                # Xero already had a description — still run it through the transfer/rule check
                # using that description directly as the narration signal.
                fake_row = narration.BankCsvRow(
                    date=line_date, amount=amount, transaction_type="", transaction_details=xero_desc,
                    category="", merchant_name="", processed_on=None, source_file="xero",
                )
                is_transfer = transfers.is_internal_transfer(fake_row)
                rule_flags = rules.apply_hard_rules(fake_row, is_transfer)
                bank_narration_text = xero_desc

        # FY gate (Step 3) + FY23/24 matching (Step 4) — every line in this fixture is FY2023/24.
        fy = "FY2023/24" if (line_date is None or config.is_fy2324(line_date)) else "FY2024/25"
        match_result = None
        if fy == "FY2023/24":
            match_result = fy2324_match.match_fy2324(seed, amount, line_date) if line_date else None

        flags = (rule_flags.flags if rule_flags else [])
        action = match_result.action if match_result else ("FY24_UNRECORDED" if fy == "FY2023/24" else "PROPOSE_PENDING")
        matched_detail = match_result.matches[0].detail if (match_result and match_result.matches) else None

        recon_lines.append(
            ReconLine(
                xero_line_id=line["id"],
                date=line_date,
                amount=amount,
                direction="Spend" if amount < 0 else "Receive",
                fy=fy,
                xero_description=xero_desc,
                bank_narration=bank_narration_text,
                bank_category=bank_category,
                merchant=merchant,
                action=action,
                matched_description=matched_detail,
                confidence="See flags — FY2023/24 lines are match-only, never a fresh proposal",
                rationale=", ".join((rule_flags.notes if rule_flags else [])) or "No flags raised.",
                flags=flags,
            )
        )

    dup_input = [{"id": l.xero_line_id, "amount": l.amount, "date": l.date} for l in recon_lines if l.date]
    dupes = dedupe.find_possible_duplicates(dup_input)
    dupe_ids = {d.line_a_id for d in dupes} | {d.line_b_id for d in dupes}
    for l in recon_lines:
        if l.xero_line_id in dupe_ids:
            l.flags.append("POSSIBLE_DUPLICATE")

    fy2324_with_proposal = [l for l in recon_lines if l.fy == "FY2023/24" and l.proposed_account]
    assert not fy2324_with_proposal, (
        f"ACCEPTANCE CRITERION VIOLATED: {len(fy2324_with_proposal)} FY2023/24 lines got a "
        f"proposed_account — scope doc §8 requires zero."
    )

    os.makedirs("output", exist_ok=True)
    write_report(recon_lines, "output/batch1_corrected.xlsx")
    print(f"Wrote output/batch1_corrected.xlsx — {len(recon_lines)} lines, "
          f"{len(dupes)} possible-duplicate pairs, 0 FY2023/24 lines with a fresh coding proposal "
          f"(acceptance criterion holds).")


if __name__ == "__main__":
    main()
