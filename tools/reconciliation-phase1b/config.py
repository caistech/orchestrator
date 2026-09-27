"""Phase 1b config — the one place naming which real file is canonical.

Downloads holds several overlapping/versioned copies of the same source (v5, v6, "v6 repaired").
Never guess which one is current inside a pipeline step; resolve it once, here, with the reasoning
recorded, so a later change is a one-line edit instead of a re-audit.
"""

import os

DOWNLOADS = r"C:\Users\denni\Downloads"


def _p(filename: str) -> str:
    return os.path.join(DOWNLOADS, filename)


# GBTA's own NAB business account — the two CSV export windows that cover 17 May 2024 onward.
GBTA_NAB_CSV_1 = _p("GBTA NAB 17052024 TO 17052026.csv")
GBTA_NAB_CSV_2 = _p("GBTA NAB 22042025 TO 22052026.csv")
GBTA_NAB_CSVS = [GBTA_NAB_CSV_1, GBTA_NAB_CSV_2]

# Pre-17-May-2024 data has no CSV coverage (scope doc §3) — the v6 workbook's "Original GBTA NABB
# Business Tra" tab is the interim source until the PDF statements are pulled for that gap.
#
# v6 vs "v6 repaired": compared directly (2026-09-27) — both have the SAME 3260 rows, identical
# header and first/last data rows on this tab; the only difference is trailing empty columns and a
# float-precision artifact (56.700693 vs 56.700692999999994) consistent with a file-repair pass
# fixing something OTHER than this tab's data. No data difference found. Using "repaired" as
# canonical since it's the more recently validated file, not because a difference was found.
GBTA_NABB_V6_WORKBOOK = _p("GBTA NABB Business Transactions FY 2023 24 25 v6 repaired at 22052026.xlsx")
GBTA_NABB_V6_SHEET = "Original GBTA NABB Business Tra"

# The guidance pack is BOTH a reference (its Batch 1 Review tab is the answer key we verify against)
# AND, per scope doc §3, the interim FY23/24 match seed until Rimal supplies the FINAL ledgers.
GUIDANCE_PACK = _p("GBTA_Reconciliation_Guidance_Pack_for_Rimal.xlsx")

FY2425_HANDOVER_PACK = _p("Copy of GBTA_FY2024-25_Accountant_Handover_Pack - Updated 12 Aug 26.xlsx")

# NOT YET HELD (scope doc open questions #3 and #4). Left as None rather than a guessed path — a
# missing file must fail loudly if a step tries to read it, never silently skip.
LINKED_NAB_ACCOUNT_STATEMENTS = None
FY2324_FINAL_OWNER_A_DRAWINGS_LEDGER = None
FY2324_FINAL_RELATED_PARTY_JE = None
FY2324_FINAL_ATO_RECONCILIATION = None

# Xero connection — the SAME live connection already wired for Global Buildtech Australia Pty Ltd,
# reused read-only. No changes to the orchestrator's own connector or its `connections` row.
ORCHESTRATOR_SUPABASE_PROJECT_REF = "xuzvurmprexhalnxgsdu"
GBTA_TENANT_ID = "bdde9f4c-0653-4d32-b3f4-0a731e32fe10"
XERO_ORG_TENANT_ID = "867e784c-2f0c-4a6a-a631-beebc393a828"  # Xero's own org id, not our tenant_id

# GBTA's fiscal year boundary (Australian FY: 1 Jul – 30 Jun). Scope doc §2/§8: FY2023/24 lines are
# match-only (already lodged); FY2024/25 onward gets fresh coding proposals.
import datetime as _dt
FY2324_END = _dt.date(2024, 6, 30)


def is_fy2324(line_date: _dt.date) -> bool:
    return line_date <= FY2324_END
