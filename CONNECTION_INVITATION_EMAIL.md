# Google Connection — Invitation Email

## ADAPTED FOR KIRA CUSTOMERS

> ⚠️ **The permission list is NOT fixed, and must not be copied blind.**
>
> The owner chooses how much Drive and how much Gmail he grants, during Kira's setup. Those two
> choices build the consent screen he will see, so the email describing it has to follow them. A
> template that states one permission list is wrong for most owners — the previous version of this
> file promised "we only request access to files YOU explicitly share" (true only on `picked`) and
> "Kira CANNOT read your personal emails" (false on `read`) to everyone who received it.
>
> **The canonical source is `src/connectors/google-consent-copy.ts`**, which generates the ✓/✗ lines
> from the two levels and is pinned to the actual scope sets by `google-consent-copy.test.ts`.
> `scripts/send-test-connection-email.ts` renders this email from it. Prefer sending through the
> script. If you are composing by hand, take the lines from §2 below — do not invent them.

---

## 1. The two choices this email has to reflect

| Drive | What he is granting | The scope |
|---|---|---|
| `picked` | Only files he opens or shares with Kira | `drive.file` |
| `readonly` | Read anything in his Drive | `drive.readonly` |
| `full` | Read **and change** anything in his Drive | `drive` |

| Gmail | What he is granting | The scope |
|---|---|---|
| `none` | Nothing. No mailbox access at all. | — |
| `draft` | Write into his drafts; he reviews and sends | `gmail.compose` |
| `read` | The above, **plus reading his mailbox** | `gmail.readonly` + `gmail.compose` |

**Contacts is always requested, always read-only** (`contacts.readonly` + `contacts.other.readonly`).
Say "and addresses Google saved from your past emails" rather than just "your contacts" — *other
contacts* is wider than people assume, and discovering it afterwards feels like something was hidden.

**`gmail.send` is never requested, at any level.** Outbound mail goes through Resend so it carries the
business's own identity, the Spam Act footer and the approval gate. Never write "send emails on your
behalf" in the Google permission list — it describes a permission the consent screen will not show.

---

## 2. Permission lines, by level

Take the ✓ block matching his Drive choice, the ✓ block matching his Gmail choice, the contacts line,
then the ✗ lines that apply.

**✓ Drive** — pick one
- `picked` — Open the files you choose to share with Kira — and only those
- `readonly` — Read the files in your Google Drive, to find quotes, invoices and client details
- `full` — Read and edit files in your Google Drive

**✓ Gmail** — pick one
- `none` — *(nothing; omit)*
- `draft` — Write a message into your Gmail drafts, for you to review and send yourself
- `read` — the `draft` line, **plus** — Read your Gmail, so it can tell you whether a customer ever replied

**✓ Contacts** — always
- Look up your saved contacts, and addresses Google saved from your past emails, to find who to send to

**✗ What it cannot do** — include each line only where it is true
- `picked` only — Reach anything else in your Drive — it never sees the files you have not shared
- `picked` + `readonly` — Change, move or delete any of your files
- `none` — Touch your email — this connection asks for no access to your mailbox
- `draft` — Read your email — it can only put a draft into your drafts folder
- `draft` + `read` — Send anything from your Gmail — outbound mail goes out for your approval first
- always — Act without you — anything that leaves your business comes to you for approval first

> The last Gmail ✗ matters more than it looks. `gmail.compose` is the narrowest scope Google publishes
> that can create a draft, and it *also* permits sending — there is no draft-only scope. So the screen
> he sees implies sending. That line is what closes the gap between what Google implies and what the
> system does.

---

## 3. Email body (plain text)

```
Hi [First Name],

To connect [BLURB] to Kira, please click the link below:

[Connection Link]

---

⚠️ IMPORTANT: You'll see a Google security warning

When you click the link, Google will show a screen that says:

  "Google hasn't verified this app"

This is expected and safe to proceed. Here's what's happening:

• We're currently in Google's verification process (this is standard for new integrations)
• We only ask for the access listed below — nothing else
• You can untick anything on the Google screen, and Kira works with whatever you allow
• You can revoke access anytime from your Google Account settings

---

TO COMPLETE THE CONNECTION:

1. Click "Advanced" (bottom left of the warning screen)
2. Click "Go to Kira (unsafe)"
   (This is Google's standard language - the app is safe)
3. Review the permissions being requested
4. Click "Allow" to finish connecting

---

WHAT KIRA WILL BE ABLE TO DO:

[✓ lines from §2, for HIS levels]

WHAT IT WILL NOT BE ABLE TO DO:

[✗ lines from §2, for HIS levels]
✗ Act without you — anything that leaves your business comes to you for approval first

---

WHY THIS WARNING APPEARS:

Google shows this warning for all apps in their review process. Once they approve our integration
(typically 3-7 business days), this warning will disappear for all new connections.

Your data remains secure throughout. The warning is about verification status, not security risk.

---

NEED HELP?

If you get stuck or have questions:
• Reply to this email
• Call us at [support phone]

Thanks,
[Your Name]
Kira Support Team

---

P.S. Once connected, you'll be able to ask Kira things like:
• "Find the quote I sent to John last week"
• "Draft a reply to my customer with the updated invoice"
• "What's Sarah's phone number?"
```

**`[BLURB]`** is `connectionBlurb(drive, gmail)` — e.g. *"the Google Drive files you choose, your
Gmail and your contacts"*, or *"your Google Drive and your contacts"* when Gmail is `none`. It names
Gmail only when Gmail was actually requested.

**On the P.S.** — the examples must stay inside what he granted. "Email my customer the updated
invoice" was in the old copy and overstates it on `draft`, where Kira writes the draft and *he*
sends. "Send a follow-up to all unpaid quotes" is worse: it describes autonomous outbound on a
system where everything outbound is approved first.

---

## 4. HTML version

Generated, not maintained here — `scripts/send-test-connection-email.ts` builds both the HTML and
plain-text bodies from `permissionSummary()`. A second hand-kept HTML copy is how this file drifted
out of agreement with the code in the first place.

```bash
tsx scripts/send-test-connection-email.ts <email> "<connection-link>" <drive> <gmail>
# drive: picked | readonly | full     gmail: none | draft | read
tsx scripts/send-test-connection-email.ts you@example.com "" picked draft
```

It refuses an unrecognised level rather than defaulting, so a typo cannot send an email describing
`picked` over a link that grants `full`.

---

## 5. Variables to replace

- `[First Name]` — Customer's first name
- `[Connection Link]` — The signed connect token URL (`https://connect.kiraexec.com/api/connect/google?t=...`)
- `[BLURB]` — from `connectionBlurb(drive, gmail)`, see §3
- `[Your Name]` — Support team member name
- `[support phone]` — Support phone number

---

## 6. Timing

**Send this email:**
- Immediately after the owner completes Kira setup, where the Drive/Gmail levels are chosen
- When he manually requests a Google connection
- As part of the onboarding checklist

**Follow up if no action after:** 3 days (gentle reminder), 7 days (final, with an offer to help).

---

## 7. Post-verification update (send when Google approves)

```
Subject: Good News - Google Connection Now Streamlined

Hi [First Name],

Quick update: Our Google integration is now fully verified!

If you haven't connected yet, you'll now see a much simpler connection
process - no security warnings.

[Connection Link]

Already connected? No action needed - everything continues working normally.

Thanks,
[Your Name]
Kira Support Team
```

---

## 8. Before sending to a real customer

1. Send it to yourself **at the levels that customer will actually be offered**.
2. Click through and reach the Google consent screen.
3. **Compare the screen against the list in the email, line by line.** This is the check that matters
   — the permissions Google shows are the truth, and the email is a claim about them.
4. Check it on both desktop and mobile.
5. Show it to someone unfamiliar with OAuth and ask them what they think they are agreeing to.

---

Last updated: 2026-08-15
Permission copy: generated from `src/connectors/google-consent-copy.ts`
