"""The "Coding Rules" tab from the v3 guidance pack -- 30 rules built from 1,118 real FY25/26 NAB
lines, each with a real Xero account, GST/tax treatment, and example narrations. This is a much
richer source than fy2425_propose.py's keyword-overlap match against Xero's own thin coding
history (which found almost nothing useful against live data), and it's the intended primary
classifier for Step 5 (FY2024/25+) going forward.

Patterns below are HAND-WRITTEN from the tab's own "Example narrations" column, not auto-inferred
from the free-text "Pattern / what it is" column -- a wrong regex here misclassifies real money,
so each pattern is checked against the real example strings before being trusted (see
verify_coding_rules.py). Applied in the tab's own stated order: "first matching rule wins".
"""

import re
from dataclasses import dataclass
from typing import Optional

import config


@dataclass
class CodingRule:
    rule_id: str
    pattern: "re.Pattern"
    account: str
    tax_type: str
    direction: Optional[str]  # 'spend' | 'receive' | None (either)
    how_to_apply: str  # 'Bank rule' | 'Manual' | 'Cash code OK' -- confidence signal
    notes: str


def _rx(*fragments: str) -> "re.Pattern":
    return re.compile("|".join(fragments), re.IGNORECASE)


# Order matches the Coding Rules tab exactly -- "first matching rule wins".
CODING_RULES: list[CodingRule] = [
    CodingRule(
        "G1", _rx(r"\bONLINE \w+ .*GLOBAL BUILD\b"),
        "NAB Linked Account (bank) or clearing account", "BAS Excluded", None, "Bank rule",
        "Guardrail -- internal transfer to/from the linked NAB account. Never income or expense.",
    ),
    CodingRule(
        "G2", _rx(r"\bREVERSAL OF DEBIT\b", r"\bREVERSED\b"),
        "Same account as the original debit", "Same as original", None, "Manual",
        "Bounced/reversed debit -- match the reversal against the original; the pair nets to nil.",
    ),
    CodingRule(
        "D1", _rx(r"MR DENNIS PATRICK MC", r"\bDENNIS MCMAHON\b", r"\bDennis Mcmahon\b"),
        "Director Loan Account (credit)", "BAS Excluded", "receive", "Bank rule",
        "Money in from Dennis -- Div 7A repayment. Reduces the director loan balance.",
    ),
    CodingRule(
        "D3", _rx(r"Autopay Dennis McMahon", r"DT\.\w+ 10002219"),
        "Director Loan Account (debit)", "BAS Excluded", "spend", "Bank rule",
        "Zepto 'Autopay Dennis McMahon' debit -- personal loan autopay. Only code the ones NOT "
        "reversed (check G2 first). Dennis to confirm what loan this is.",
    ),
    CodingRule(
        "D2", _rx(r"\bDENNIS MCMAHON\b"),
        "Director Loan Account (debit)", "BAS Excluded", "spend", "Bank rule",
        "Transfer out to Dennis -- drawing/advance. Division 7A. Only code as an expense if Dennis "
        "supplies a receipt.",
    ),
    CodingRule(
        "I1", _rx(r"\bNATUREZEN\b"),
        "Loan to related party — NatureZen (asset)", "BAS Excluded", None, "Bank rule",
        "NatureZen Constructions Qld -- intercompany, not a GBTA cost. Ken to confirm.",
    ),
    CodingRule(
        "I2", _rx(r"\bFACTORY2KEY\b", r"\bFactory2Key Pty Ltd\b"),
        "Loan to related party — Factory2Key (asset)", "BAS Excluded", None, "Bank rule",
        "Factory2Key -- intercompany on-charge.",
    ),
    CodingRule(
        "I3", _rx(r"\bWBFREE PTY LTD\b"),
        "Match to GBTA invoice (Accounts receivable) — revenue per invoice", "Per invoice", "receive",
        "Manual",
        "WBFREE Pty Ltd ATF WWBFREE Unit Trust -- F2K-related receipt. Several payments can settle "
        "one invoice; Dennis to supply the invoice list.",
    ),
    CodingRule(
        "F1", _rx(r"\bSHIFT DEBIT\b", r"\bSPLPT-\d+\b"),
        "Shift loan (liability)", "BAS Excluded (financial supply)", "spend", "Bank rule",
        "Shift finance repayment. Watch for bounced autopays (G2).",
    ),
    CodingRule(
        "F2", _rx(r"\bATTVEST FINANCE\b"),
        "Premium funding liability / Insurance", "BAS Excluded", "spend", "Bank rule",
        "Attvest -- insurance premium funding repayment.",
    ),
    CodingRule(
        "F3", _rx(r"\bMoneyMe\b", r"EZI\*MoneyMe"),
        "Director Loan Account unless Dennis confirms a business loan", "BAS Excluded", "spend",
        "Manual",
        "MoneyMe loan repayment. Dennis to confirm whose loan.",
    ),
    CodingRule(
        "B1", _rx(r"NAB INTNL TRAN FEE"),
        "Bank Fees", "GST Free", None, "Bank rule",
        "NAB international transaction fee. Refunds ('REV') go to the same account.",
    ),
    CodingRule(
        "B2", _rx(r"INTEREST CHARGED"),
        "Interest Expense", "GST Free", "spend", "Bank rule",
        "Account interest.",
    ),
    CodingRule(
        "T1", _rx(r"\bATO PAYMENT\b", r"\bATO\w*I002\b", r"ATO Global Buildtech"),
        "ATO Client Integrated Account", "BAS Excluded", None, "Bank rule",
        "ATO payment or refund. Never income or expense.",
    ),
    CodingRule(
        "T2", _rx(r"BPAY ASIC\b"),
        "ASIC Fees and Charges", "GST Free", "spend", "Bank rule",
        "ASIC fees.",
    ),
    CodingRule(
        "S1", _rx(r"PAYPAL AUSTRALIA GLOBAL BUILDTECH", r"RENDER\.COM", r"\bXAI LLC\b", r"X\.AI/"),
        "Computer Software costs / Subscriptions", "GST Free (no ATC) unless tax invoice shows AU GST",
        "spend", "Bank rule",
        "Overseas software/AI subscription. No GST credit by default.",
    ),
    CodingRule(
        "S2", _rx(r"Google CLOUD", r"XERO AU"),
        "Subscriptions", "GST on Expenses (check invoice)", "spend", "Bank rule",
        "Australian subscription (Xero, Google, NAB Bookkeeper).",
    ),
    CodingRule(
        "S3", _rx(r"\bOptus Billing\b"),
        "Telephone & Internet", "GST on Expenses", "spend", "Bank rule",
        "Business phone. Dennis to confirm business % if any private use.",
    ),
    CodingRule(
        "S4", _rx(r"\bWOTSO\b"),
        "Rent / Office Expenses", "GST on Expenses", "spend", "Bank rule",
        "WOTSO coworking. Appears under many descriptors -- rule on the word 'WOTSO' itself.",
    ),
    CodingRule(
        "S5", _rx(r"LegalVisi", r"LEGALVISION"),
        "Legal expenses", "GST on Expenses", "spend", "Bank rule",
        "LegalVision legal subscription. Many attempts bounced (G2).",
    ),
    CodingRule(
        "S6", _rx(r"GRAHAM MOFFAT"),
        "Consulting Costs (or NatureZen recharge)", "Check invoice", "spend", "Bank rule",
        "Nominated supervisor fees. Ken to confirm GBTA cost or recharge to NatureZen.",
    ),
    CodingRule(
        "R1", _rx(r"LUKE VAN OS", r"Kiaanas Quest"),
        "Match to invoice — Construction Revenue", "GST on Income (per invoice)", "receive", "Manual",
        "Customer receipt. Ken to confirm GBTA vs NatureZen revenue -- passed through same day in "
        "some cases.",
    ),
    CodingRule(
        "R2", _rx(r"9 Brushwood Court", r"TRIT EL WH TRT S"),
        "DENNIS TO IDENTIFY", "—", "receive", "Manual",
        "Large inter-bank credit (~$178k). Not coded until Dennis explains.",
    ),
    CodingRule(
        "P3", _rx(r"\bATM\b", r"EFTEX ATM", r"BBL ATM"),
        "Director Loan Account (debit)", "BAS Excluded", "spend", "Bank rule",
        "Cash withdrawal. Default personal unless Dennis has a receipt.",
    ),
    CodingRule(
        "M4", _rx(r"\bBUNNINGS\b", r"FLEXIHIRE", r"INGHAM MANUFACTURES"),
        "Materials or Tools and Equipment", "GST on Expenses", "spend", "Manual",
        "Hardware/materials. Which project?",
    ),
    CodingRule(
        "M3", _rx(r"\bBP IDALIA\b", r"\bAMPOL\b", r"UNITED CRANBROOK"),
        "Motor Vehicle Fuel and Oil", "GST on Expenses", "spend", "Cash code OK",
        "Fuel. Business % to confirm if the vehicle is also used privately.",
    ),
    CodingRule(
        "X1", _rx(r"\bIB Ref\b", r"\bTT\d+ "),
        "Contractors / Consulting Costs", "GST Free", "spend", "Manual",
        "International transfer out (TT). Dennis to name the supplier and purpose.",
    ),
    CodingRule(
        "P2", _rx(r"NETFLIX\.COM", r"muscle-booster\.io"),
        "Director Loan Account (debit)", "BAS Excluded", "spend", "Bank rule",
        "Personal spend (named merchant). Dennis to flag if any of these are business.",
    ),
]


def classify(narration_text: str, category: str, direction: str) -> Optional[CodingRule]:
    """First matching rule wins, matching the tab's own stated evaluation order. `direction` is
    'spend' or 'receive'; a rule with a fixed direction only matches that direction."""
    for rule in CODING_RULES:
        if rule.direction and rule.direction != direction:
            continue
        if rule.pattern.search(narration_text or ""):
            return rule
    return None
