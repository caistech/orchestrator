// scripts/send-test-connection-email.ts
// Send a test Google Drive connection invitation email

import { senderFromEnv } from '@caistech/email-compliance';
import { createEmailSender } from '@caistech/email-send';

import { connectionBlurb, permissionSummary } from '../src/connectors/google-consent-copy';
import { isDriveAccess, isGmailAccess, type DriveAccess, type GmailAccess } from '../src/connectors/google';

const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const FROM_EMAIL = 'noreply@updates.corporateaisolutions.com'; // The only verified sender

interface SendTestEmailOptions {
  to: string;
  connectionLink?: string;
  /**
   * The levels this invitation is FOR. They are not decoration: the permission list is generated
   * from them, so an email describing a grant the owner was never offered is not possible here.
   * Least privilege by default — an invitation that over-describes is the failure worth avoiding.
   */
  driveAccess?: DriveAccess;
  gmailAccess?: GmailAccess;
}

async function sendTestConnectionEmail(opts: SendTestEmailOptions) {
  const {
    to,
    connectionLink = 'https://connect.kiraexec.com/api/connect/google?t=TEST_TOKEN_REPLACE_ME',
    driveAccess = 'picked',
    gmailAccess = 'none',
  } = opts;

  // What this connection actually grants, in his words, derived from the scopes rather than typed
  // out here. See google-consent-copy.ts for why that is not a stylistic preference.
  const { can, cannot } = permissionSummary(driveAccess, gmailAccess);
  const blurb = connectionBlurb(driveAccess, gmailAccess);

  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY not set in environment');
  }

  // WHOSE NAME IS ON THIS ONE — and why it is NOT a tenant's.
  //
  // Every other send in this repo carries the TENANT's identity, read per-send from their row and
  // refused outright when incomplete (see src/connectors/email.ts). This is the exception, and it is
  // the exception because of who is talking: this is us inviting an owner to connect his Google
  // account, before he is a sender at all. Putting a tenant's ABN on it would name a business that
  // has nothing to do with the message.
  //
  // Sourced from EMAIL_SENDER_* rather than typed in here. The identity is single-sourced in
  // portfolio-manifest.yaml and pushed by @caistech/portfolio-env-sync, so a hardcoded copy is a
  // second place to be wrong — and an ABN nobody re-reads is exactly the kind of wrong that only
  // surfaces when a recipient asks who they are actually dealing with. `senderFromEnv` THROWS when
  // the identity is absent rather than sending an unidentified email, which is the correct trade.
  const identity = senderFromEnv();
  const sender = createEmailSender({ apiKey: RESEND_API_KEY, sender: identity });

  // Extract first name from email (simple version)
  const firstName = to.split('@')[0].split('+')[0] || 'there';
  const displayName = firstName.charAt(0).toUpperCase() + firstName.slice(1);

  const subject = 'Connect Google Drive to Kira - Action Required';

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  
  <h2 style="color: #2563eb; margin-bottom: 20px;">Connect Google Drive to Kira</h2>
  
  <p>Hi <strong>${displayName}</strong>,</p>
  
  <p>To connect ${blurb} to Kira, click the button below:</p>
  
  <div style="text-align: center; margin: 30px 0;">
    <a href="${connectionLink}" style="display: inline-block; background: #2563eb; color: white; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px;">Connect Google Drive</a>
  </div>
  
  <!-- Warning Box -->
  <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 16px; margin: 24px 0; border-radius: 4px;">
    <h3 style="margin-top: 0; color: #92400e; font-size: 16px;">⚠️ You'll see a Google security warning</h3>
    <p style="margin-bottom: 8px; color: #78350f;">When you click the link, Google will show:</p>
    <p style="background: white; padding: 12px; border-radius: 4px; font-style: italic; color: #666; margin: 12px 0;">
      "Google hasn't verified this app"
    </p>
    <p style="margin-bottom: 0; color: #78350f;"><strong>This is expected and safe to proceed.</strong></p>
  </div>
  
  <!-- Why Box -->
  <div style="background: #f0f9ff; border-left: 4px solid #3b82f6; padding: 16px; margin: 24px 0; border-radius: 4px;">
    <h3 style="margin-top: 0; color: #1e40af; font-size: 16px;">Why this warning appears:</h3>
    <ul style="margin: 8px 0; padding-left: 20px; color: #1e3a8a;">
      <li>We're in Google's verification process (standard for new integrations)</li>
      <li>Your data is completely secure</li>
      <li>Only YOU control what Kira can access</li>
      <li>You can revoke access anytime</li>
    </ul>
  </div>
  
  <!-- Steps Box -->
  <div style="background: #f9fafb; border: 1px solid #e5e7eb; padding: 20px; margin: 24px 0; border-radius: 6px;">
    <h3 style="margin-top: 0; color: #111827; font-size: 16px;">To complete the connection:</h3>
    <ol style="margin: 0; padding-left: 20px; color: #374151;">
      <li style="margin-bottom: 8px;">Click <strong>"Advanced"</strong> (bottom left of warning screen)</li>
      <li style="margin-bottom: 8px;">Click <strong>"Go to Kira (unsafe)"</strong><br>
          <span style="font-size: 14px; color: #6b7280;">(This is Google's standard language - the app is safe)</span></li>
      <li style="margin-bottom: 8px;">Review the permissions being requested</li>
      <li>Click <strong>"Allow"</strong> to finish connecting</li>
    </ol>
  </div>
  
  <!-- What Kira Can Do — generated from the scopes this link actually requests -->
  <h3 style="color: #111827; margin-top: 32px;">What Kira will be able to do:</h3>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    ${can
      .map(
        (line) =>
          `<tr><td style="padding: 8px 0; color: #059669;">✓ ${line}</td></tr>`,
      )
      .join('\n    ')}
  </table>

  <h3 style="color: #111827; margin-top: 24px;">What it will not be able to do:</h3>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    ${cannot
      .map(
        (line) =>
          `<tr><td style="padding: 8px 0; color: #dc2626;">✗ ${line}</td></tr>`,
      )
      .join('\n    ')}
    <tr>
      <td style="padding: 8px 0; color: #dc2626;">✗ Act without you — anything that leaves your business comes to you for approval first</td>
    </tr>
  </table>
  
  <!-- Help -->
  <div style="background: #f9fafb; padding: 20px; margin: 32px 0; border-radius: 6px; border: 1px solid #e5e7eb;">
    <h3 style="margin-top: 0; color: #111827; font-size: 16px;">Need help?</h3>
    <p style="margin: 8px 0; color: #374151;">If you get stuck or have questions, reply to this email.</p>
  </div>
  
  <!-- Footer -->
  <div style="margin-top: 32px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
    <p style="color: #6b7280; font-size: 14px; margin: 0;">
      Thanks,<br>
      <strong>Dennis & the Kira Team</strong>
    </p>
  </div>
  
  <!-- PS -->
  <div style="margin-top: 24px; padding: 16px; background: #f0f9ff; border-radius: 6px;">
    <p style="margin: 0; color: #1e40af; font-size: 14px;">
      <strong>P.S.</strong> Once connected, you'll be able to ask Kira things like:<br>
      <span style="color: #3b82f6;">
        • "Find the quote I sent to John last week"<br>
        • "Draft a reply to my customer with the updated invoice"<br>
        • "What's Sarah's phone number?"<br>
        • "Write follow-ups for the quotes nobody has paid"
      </span>
    </p>
  </div>
  
  <!-- Test Notice -->
  <div style="margin-top: 32px; padding: 16px; background: #fee; border: 2px dashed #c00; border-radius: 6px;">
    <p style="margin: 0; color: #800; font-size: 12px; font-weight: bold;">
      🧪 TEST EMAIL - The connection link above is a placeholder. Replace TEST_TOKEN_REPLACE_ME with a real signed token before sending to customers.
    </p>
  </div>
  
</body>
</html>
`;

  const textBody = `Hi ${displayName},

To connect ${blurb} to Kira, please click the link below:

${connectionLink}

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

${can.map((line) => `✓ ${line}`).join('\n')}

WHAT IT WILL NOT BE ABLE TO DO:

${cannot.map((line) => `✗ ${line}`).join('\n')}
✗ Act without you — anything that leaves your business comes to you for approval first

---

WHY THIS WARNING APPEARS:

Google shows this warning for all apps in their review process. Once they approve our integration (typically 3-7 business days), this warning will disappear for all new connections.

Your data remains secure throughout. The warning is about verification status, not security risk.

---

NEED HELP?

If you get stuck or have questions, reply to this email.

Thanks,
Dennis & the Kira Team

---

P.S. Once connected, you'll be able to ask Kira things like:
• "Find the quote I sent to John last week"
• "Draft a reply to my customer with the updated invoice"
• "What's Sarah's phone number?"
• "Write follow-ups for the quotes nobody has paid"

---
🧪 TEST EMAIL - The connection link above is a placeholder.
`;

  console.log(`Sending test email to: ${to}`);
  console.log(`Subject: ${subject}`);

  const result = await sender.send({
    to,
    from: FROM_EMAIL,
    replyTo: FROM_EMAIL,
    subject,
    html: htmlBody,
    text: textBody,
    // Transactional: he asked to be connected, so this is the step he is waiting on rather than
    // marketing. That means the identification footer WITHOUT an unsubscribe — there is nothing here
    // to unsubscribe from, and offering it on an action-required onboarding email invites him to opt
    // out of the thing he asked for. Identity comes from the transport, configured above.
    compliance: { transactional: true },
  });

  return result;
}

// Run if called directly
const to = process.argv[2];
const connectionLink = process.argv[3];
const driveArg = process.argv[4] ?? 'picked';
const gmailArg = process.argv[5] ?? 'none';

if (!to) {
  console.error(
    'Usage: tsx scripts/send-test-connection-email.ts <email> [connectionLink] [drive] [gmail]',
  );
  console.error('  drive: picked (default) | readonly | full');
  console.error('  gmail: none (default) | draft | read');
  console.error('Example: tsx scripts/send-test-connection-email.ts you@example.com "" picked draft');
  process.exit(1);
}

// REFUSE a level we do not recognise rather than falling back to a default. A typo would otherwise
// send an email describing 'picked' access over a link that grants 'full' — the exact mismatch
// between what he was told and what he granted that this whole path exists to prevent.
if (!isDriveAccess(driveArg) || !isGmailAccess(gmailArg)) {
  console.error(`Unrecognised access level (drive="${driveArg}", gmail="${gmailArg}").`);
  console.error('drive must be picked|readonly|full; gmail must be none|draft|read.');
  process.exit(1);
}

sendTestConnectionEmail({ to, connectionLink, driveAccess: driveArg, gmailAccess: gmailArg })
  .then((result) => {
    console.log('✅ Email sent successfully!');
    console.log('Result:', JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error('❌ Error sending email:', error);
    process.exit(1);
  });
