"""Checks every hand-written regex in coding_rules.py against the REAL example narrations in the
"Coding Rules" tab itself -- a wrong pattern here misclassifies real money, so this must pass
before the rules are trusted for anything.

Run: python verify_coding_rules.py
"""

import io
import sys

import openpyxl

import config
import coding_rules

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


def load_examples() -> dict[str, list[str]]:
    wb = openpyxl.load_workbook(config.GUIDANCE_PACK_V3, read_only=True, data_only=True)
    ws = wb["Coding Rules"]
    examples = {}
    for row in ws.iter_rows(min_row=4, values_only=True):
        rule_id = row[0]
        example_cell = row[8]
        if not rule_id or not example_cell:
            continue
        examples[str(rule_id)] = [line.strip() for line in str(example_cell).split("\n") if line.strip()]
    return examples


def main():
    examples = load_examples()
    covered = 0
    total = 0
    failures = 0

    PLACEHOLDER_EXAMPLES = {"(none in fy25/26 — guardrail)"}

    for rule_id, narrations in examples.items():
        rule = next((r for r in coding_rules.CODING_RULES if r.rule_id == rule_id), None)
        if rule is None:
            print(f"⚠️  {rule_id}: no rule implemented in coding_rules.py (skipping check)")
            continue
        real_narrations = [n for n in narrations if n.strip().lower() not in PLACEHOLDER_EXAMPLES]
        if not real_narrations:
            print(f"—  {rule_id}: no real example to check (guardrail with zero live hits)")
            continue
        total += 1
        matched_all = all(rule.pattern.search(n) for n in real_narrations)
        if matched_all:
            covered += 1
            print(f"✅ {rule_id}: matches all {len(real_narrations)} example narration(s)")
        else:
            failures += 1
            print(f"❌ {rule_id}: FAILS to match its own example(s):")
            for n in real_narrations:
                if not rule.pattern.search(n):
                    print(f"     {n!r}")

    # Real cross-check: simulate classify() itself (order + direction aware) for each example, and
    # confirm the rule that actually FIRES is the one the example belongs to -- a raw pattern
    # overlap is only a real problem if it would actually win the routing.
    cross_failures = 0
    for rule_id, narrations in examples.items():
        rule = next((r for r in coding_rules.CODING_RULES if r.rule_id == rule_id), None)
        if rule is None:
            continue
        direction = rule.direction or "spend"
        for n in narrations:
            if n.strip().lower() in PLACEHOLDER_EXAMPLES:
                continue
            result = coding_rules.classify(n, "", direction)
            if result is None or result.rule_id != rule_id:
                cross_failures += 1
                got = result.rule_id if result else "no match"
                print(f"⚠️  classify() on {rule_id}'s example {n!r} (direction={direction}) returned {got}, not {rule_id}")

    print(f"\n--- Summary ---")
    print(f"Rules implemented and checked: {total}/{len(examples)} tab rows with examples")
    print(f"Passing (match own examples):  {total - failures}")
    print(f"Failing:                        {failures}")
    print(f"Cross-matches (ambiguous order): {cross_failures}")


if __name__ == "__main__":
    main()
