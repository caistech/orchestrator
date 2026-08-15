# OAuth Connection User Guidance

## For Customer Communications

### Current Status: Testing Mode (Unverified App)

The Google OAuth integration is currently in **Testing** mode while awaiting Google's verification. This means users will see an "unverified app" warning screen during the connection process.

> ⚠️ **What we ask for is per-owner, not fixed.** Each owner chooses his Drive level (`picked` /
> `readonly` / `full`) and his Gmail level (`none` / `draft` / `read`) during Kira's setup, and those
> choices build the consent screen. Any permission list stated as a constant will be wrong for most
> owners. **The canonical list lives in `src/connectors/google-consent-copy.ts`** and the full
> per-level table is in `CONNECTION_INVITATION_EMAIL.md` §1–2. This document covers the *warning
> screen* guidance, which is the same for everyone.

---

## Email/Communication Template

The invitation email itself is `CONNECTION_INVITATION_EMAIL.md` — use that, because its permission
lines follow the owner's actual levels. What belongs here is the part that does not vary: explaining
the unverified-app warning.

### Subject Line
```
Connect your Google account to [Your Business Name]
```

### The warning-screen block (safe to reuse verbatim)

```
IMPORTANT: You'll see a Google security warning

When you click the link, Google will show a screen that says:

  "Google hasn't verified this app"
  
This is expected and safe to proceed. Here's why:

• We're currently in Google's review process for verification
• We only ask for the access listed below — nothing else
• You can untick anything on the Google screen, and it will work with whatever you allow
• You can revoke access anytime from your Google account

TO CONTINUE:
1. Click "Advanced" (bottom left of the warning screen)
2. Click "Go to [App Name] (unsafe)" - this wording is Google's standard language
3. Review the permissions we're requesting
4. Click "Allow" to complete the connection
```

### What we're asking for

**Do not write this block by hand.** Take the ✓/✗ lines from `CONNECTION_INVITATION_EMAIL.md` §2 for
that owner's levels, or let `scripts/send-test-connection-email.ts` render them.

Three claims that were in this template and were wrong — worth naming so they do not come back:

| Old line | Why it was wrong |
|---|---|
| "We only request access to files YOU choose to share" | True on `picked` only. `readonly` and `full` reach the whole Drive. |
| "We do NOT read your personal emails" | True on `none` and `draft`. **False on `read`.** |
| "Ability to send emails on your behalf" | **Never** a Google permission — `gmail.send` is never requested. Outbound goes via Resend, from the business's own verified address, after approval. |

---

## In-App Instructions (Settings Page)

If you have a "Connect Google Drive" button in the app, add helper text above it:

```
📌 Connection Note

You'll see a Google security warning when connecting. This is because 
we're awaiting Google's verification (typically takes 3-7 days).

To proceed safely:
1. Click "Advanced" on the warning screen
2. Click "Go to [App Name] (unsafe)"
3. Review permissions and click "Allow"

Your data remains secure throughout this process.
```

---

## Screenshot Guidance (Optional)

Consider creating a simple visual guide showing:

1. **Screenshot 1**: The "Google hasn't verified this app" warning
   - Arrow pointing to "Advanced" link with text "Click here first"

2. **Screenshot 2**: The expanded warning
   - Arrow pointing to "Go to [App Name] (unsafe)" with text "Then click here"

3. **Screenshot 3**: The permission consent screen
   - Text: "Review and click Allow"

---

## FAQ to Include

**Q: Is this safe?**
A: Yes. The "unverified" status just means Google hasn't completed their review yet, not that there's a security risk. We're a registered business and your data is protected.

**Q: What does "unsafe" mean?**
A: It's Google's standard warning label for apps in Testing mode. Once verification completes (3-7 days), this warning disappears for all users.

**Q: What permissions are you requesting?**
A: *Depends on what that owner chose — answer from his levels, not from memory.*
- **Drive** — either only the files he shares (`picked`), or read access to his Drive (`readonly`), or read-and-edit (`full`)
- **Gmail** — either nothing (`none`), or writing into his drafts for him to review and send (`draft`), or that plus reading his mailbox (`read`)
- **Contacts** — always, always read-only: his saved contacts plus addresses Google auto-saved from his past emails

**Q: Can it send email as me?**
A: **No — at any level.** `gmail.send` is never requested. On `draft` it writes into his drafts and he sends them himself. Anything the system sends goes out through our own mail service, from the business's verified address, and only after he approves it.

**Q: Can it read my inbox?**
A: Only if he chose `read`. On `none` there is no mailbox access at all, and on `draft` it can put a draft in the drafts folder and cannot read anything. **Do not answer this one with a blanket no** — that was the single most misleading line in the previous version of this document.

**Q: Can I revoke access later?**
A: Absolutely. Visit https://myaccount.google.com/permissions and remove access anytime.

**Q: Can I untick some of it on the Google screen?**
A: Yes, and it will keep working with whatever is allowed — a missing permission degrades the relevant feature (a contact lookup falls back to asking him for the address) rather than breaking the connection. What was actually granted is read back from Google and recorded; nothing assumes the request was accepted in full.

**Q: When will this warning go away?**
A: Once Google completes verification (typically 3-7 business days). We'll notify you when it's approved.

---

## Post-Verification Update

Once Google approves the app (changes status from Testing → Production), send a follow-up:

```
Subject: Google Drive Connection - Verification Complete

Hi [Name],

Good news! Our Google integration is now fully verified. 

If you haven't connected yet, you'll now see a streamlined connection 
process without security warnings.

[Connect Google Drive Button]

Already connected? No action needed - everything continues working as normal.
```

---

## Technical Notes for Support Team

**Why the warning appears:**
- App is in Testing mode (max 100 users, 7-day re-consent)
- Not yet verified by Google
- Using `connect.kiraexec.com` custom domain (verified on our end)

**When it goes away:**
- Submit for verification via Google Cloud Console
- Typically 3-7 days for approval
- Then publish to Production status

**If a user gets stuck:**
1. Confirm they clicked "Advanced" then "Go to [App Name] (unsafe)"
2. Check they're using the correct Google account
3. Verify the connect token hasn't expired (tokens are single-use, time-limited)
4. Generate a fresh connection link if needed

---

## Implementation Checklist

- [ ] Update connection invitation email template
- [ ] Add helper text to in-app "Connect Google Drive" button
- [ ] Brief support team on expected user questions
- [ ] (Optional) Create visual screenshot guide
- [ ] Prepare post-verification follow-up email
- [ ] Add FAQ to website/help center

---

Last updated: 2026-08-12
Status: Testing mode, verification pending
