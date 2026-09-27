"""End-to-end run of the Phase 1b pipeline against the known 18 Batch-1 lines (all FY2023/24, so
Step 5 / live Xero access is never reached — this batch is fully buildable and testable today).

Fixture source: the guidance workbook's own "Batch 1 Review" tab (same as verify_batch1.py), so
this is the real, corrected Batch 1 output — not a demo on synthetic data.

Reuses run.process_line() directly rather than keeping a second copy of the per-line logic — a
divergent duplicate is exactly how a real bug (the abs()-amount sign collision, the narrow
"No description" check) ended up fixed in one file and still live in the other, found 2026-09-27.

Run: python run_batch1.py
Output: output/batch1_corrected.xlsx (gitignored — real transaction data)
"""

import datetime as dt
import os

import openpyxl

import answers
import config
import dedupe
import fy2324_match
import narration
from report import write_report
from run import process_line


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
                "description": xero_shows or "No description",
                "contact_name": None,
            }
        )
    return lines


def main():
    csv_rows = narration.load_nab_csvs()
    seed = fy2324_match.load_seed()
    fixture = load_batch1_lines()

    # No live Xero access in this fixture-only run — every line here is FY2023/24, so
    # process_line() never reaches the FY2024/25 branch that would need history/chart.
    confirmed_answers = answers.load_answers()
    recon_lines = [process_line(l, csv_rows, seed, [], [], confirmed_answers) for l in fixture]

    dup_input = [{"id": l.xero_line_id, "amount": l.amount, "date": l.date} for l in recon_lines if l.date]
    dupes = dedupe.find_possible_duplicates(dup_input)
    dupe_ids = {d.line_a_id for d in dupes} | {d.line_b_id for d in dupes}
    for l in recon_lines:
        if l.xero_line_id in dupe_ids:
            l.flags.append("POSSIBLE_DUPLICATE")

    # See run.py's identical check for why this asserts on `action`, not on proposed_account
    # being present -- a descriptive label for a KNOWN FY2023/24 treatment is fine; a line going
    # through the FY2024/25 guess engine is not, and structurally can't happen here anyway.
    fy2324_guessed = [l for l in recon_lines if l.fy == "FY2023/24" and l.action in ("PROPOSE_CODING", "NO_CONFIDENT_PATTERN")]
    assert not fy2324_guessed, (
        f"ACCEPTANCE CRITERION VIOLATED: {len(fy2324_guessed)} FY2023/24 lines went through the "
        f"FY2024/25 coding-proposal engine — scope doc §8 requires zero."
    )

    os.makedirs("output", exist_ok=True)
    write_report(recon_lines, "output/batch1_corrected.xlsx")
    print(f"Wrote output/batch1_corrected.xlsx — {len(recon_lines)} lines, "
          f"{len(dupes)} possible-duplicate pairs, 0 FY2023/24 lines with a fresh coding proposal "
          f"(acceptance criterion holds).")


if __name__ == "__main__":
    main()
