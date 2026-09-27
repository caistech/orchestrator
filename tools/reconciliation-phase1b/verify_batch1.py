"""Verification step 1-3 from the Phase 1b plan: run the new narration + transfer-tagging + FY-gate
logic against the real 18 Batch-1 lines, using the guidance workbook's OWN "Batch 1 Review" tab as
the fixture (not hand-typed) and the answer key (not a separate assertion I could get wrong twice).

Run: python verify_batch1.py
"""

import datetime as dt
import io
import sys

import openpyxl

import config
import narration
import transfers

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


def load_batch1_fixture():
    wb = openpyxl.load_workbook(config.GUIDANCE_PACK, read_only=True, data_only=True)
    ws = wb["Batch 1 Review"]
    rows = list(ws.iter_rows(min_row=5, values_only=True))  # header is row 4
    fixture = []
    for r in rows:
        date_val, amount, xero_shows, bank_narration, in_chequers, suggested_action, _ = r
        if amount is None:
            continue
        line_date = date_val.date() if isinstance(date_val, dt.datetime) else None
        fixture.append(
            {
                "date": line_date,
                "amount": float(amount),
                "xero_shows": xero_shows,
                "bank_narration": bank_narration,
                "in_chequers": in_chequers,
                "suggested_action": suggested_action,
            }
        )
    return fixture


def main():
    fixture = load_batch1_fixture()
    print(f"Loaded {len(fixture)} Batch-1 lines from the guidance workbook.\n")

    csv_rows = narration.load_nab_csvs()
    print(f"Loaded {len(csv_rows)} NAB CSV rows from {len(config.GBTA_NAB_CSVS)} files.\n")

    fy_gate_failures = 0
    narration_matches = 0
    narration_misses = 0
    transfer_correctly_tagged = 0
    transfer_missed = 0

    for line in fixture:
        label = f"{line['xero_shows']!r} ${line['amount']}"

        # --- FY gate (Step 3) ---
        if line["date"] is not None:
            in_fy2324 = config.is_fy2324(line["date"])
            if not in_fy2324:
                print(f"⚠️  FY GATE UNEXPECTED: {label} on {line['date']} is NOT FY2023/24")
                fy_gate_failures += 1

        # --- Narration (Step 1) — only for lines Xero has no description for ---
        if line["xero_shows"] == "No description" and line["date"] is not None:
            match = narration.find_narration(csv_rows, line["amount"], line["date"])
            found = match.row.transaction_details if match.row else None
            expected = line["bank_narration"] or ""
            if found and found.strip() in expected.strip() or (found and expected.strip() in found.strip()):
                narration_matches += 1
            else:
                narration_misses += 1
                print(f"❌ NARRATION MISS: {label} on {line['date']}")
                print(f"    expected (workbook): {expected}")
                print(f"    found (this tool)  : {found}  flag={match.flag}")

            # --- Transfer tagging (Step 2), only meaningful once we have a real CSV row ---
            if match.row is not None:
                tagged = transfers.is_internal_transfer(match.row)
                should_be_transfer = "internal transfer" in (line["suggested_action"] or "").lower()
                if tagged == should_be_transfer:
                    transfer_correctly_tagged += 1
                else:
                    transfer_missed += 1
                    print(
                        f"❌ TRANSFER TAG MISMATCH: {label} — tagged={tagged}, "
                        f"expected={should_be_transfer} (workbook says: {line['suggested_action']})"
                    )

    print("\n--- Summary ---")
    print(f"FY-gate failures (should be 0):            {fy_gate_failures}")
    print(f"Narration matches / misses:                 {narration_matches} / {narration_misses}")
    print(f"Transfer-tag correct / mismatched:           {transfer_correctly_tagged} / {transfer_missed}")


if __name__ == "__main__":
    main()
