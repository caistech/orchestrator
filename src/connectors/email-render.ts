// What the recipient actually sees.
//
// The first real client-facing email this system sent — a $60,000 quote — arrived as one unbroken
// line of text. The cause was a single expression: `html: <p>${escapeHtml(body)}</p>`. The drafter
// produces plain text with newlines and a bulleted scope; HTML collapses whitespace, so the
// paragraphs, the line breaks and the list all vanished into a run-on sentence. Nothing errored.
// The send was recorded as a success, and by every internal measure it was one.
//
// That is the whole reason this file exists: the transport reported delivery, and delivery is not
// the thing the business is judged on. A quote is a document a client forms an impression from
// before they read a number.
//
// WHERE THE LINE SITS. `@caistech/email-send` owns SENDING and the Spam Act footer; templates stay
// in the product, because they are its voice. This is the product's template. It deliberately does
// not touch the footer — that is appended by the package with the tenant's own legal identity.
//
// EMAIL HTML IS NOT WEB HTML. Gmail strips <style> blocks, Outlook renders through Word, and
// flexbox/grid are unreliable. So: tables for layout, inline styles only, a 600px max width, web-safe
// font stacks, and no external assets. It looks plain on purpose — a plain document that renders
// identically everywhere beats a designed one that collapses in Outlook.

export interface RenderedEmail {
  html: string;
  /** The plain-text alternative, cleaned the same way, so both parts say the same thing. */
  text: string;
}

export interface RenderOptions {
  body: string;
  /** The business as the recipient knows it — trading name where there is one. */
  businessName: string;
  /** 'quote' gets a document framing; everything else reads as a message. */
  kind?: string | null;
  /** Shown under the heading on a quote, so the document is dated. */
  dateLabel?: string;
}

/**
 * Strip a "Subject:" line the model wrote INTO the body.
 *
 * The per-kind drafting instruction told only the `email` kind not to do this, so quotes arrived
 * with their own subject repeated as the first line of the message. The instruction is now shared,
 * but this stays: four drafts written under the old prompt are still queued, and a body is sent
 * VERBATIM on approval — nothing downstream fills anything in. Cheap, and it fixes the ones already
 * written rather than only the ones written next.
 */
function stripLeadingSubject(body: string): string {
  return body.replace(/^\s*subject\s*:.*(\r?\n)+/i, '').trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface Block {
  type: 'paragraph' | 'list';
  lines: string[];
}

/**
 * Plain text → blocks.
 *
 * The drafter writes the way a person writes: blank lines between paragraphs, and a scope as
 * "- Service: …" lines. Both carry meaning that only survives if it is turned into real markup,
 * which is exactly what the old one-<p> render threw away.
 */
function toBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();

    if (!line) {
      current = null;
      continue;
    }

    const bullet = line.match(/^[-•*]\s+(.*)$/);
    if (bullet) {
      if (!current || current.type !== 'list') {
        current = { type: 'list', lines: [] };
        blocks.push(current);
      }
      current.lines.push(bullet[1]);
      continue;
    }

    if (!current || current.type !== 'paragraph') {
      current = { type: 'paragraph', lines: [] };
      blocks.push(current);
    }
    current.lines.push(line);
  }

  return blocks;
}

const TEXT = 'color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;';

function renderBlocks(blocks: Block[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'list') {
        const items = block.lines
          .map(
            (line) =>
              `<li style="${TEXT}font-size:15px;line-height:24px;margin:0 0 6px 0;">${escapeHtml(line)}</li>`,
          )
          .join('');
        return `<ul style="margin:0 0 16px 0;padding-left:20px;">${items}</ul>`;
      }
      // A single newline inside a paragraph is a deliberate break (an address, a sign-off), so it
      // becomes a <br> rather than being folded away like ordinary wrapping whitespace.
      const html = block.lines.map((line) => escapeHtml(line)).join('<br />');
      return `<p style="${TEXT}font-size:15px;line-height:24px;margin:0 0 16px 0;">${html}</p>`;
    })
    .join('');
}

export function renderEmail(options: RenderOptions): RenderedEmail {
  const body = stripLeadingSubject(options.body ?? '');
  const blocks = toBlocks(body);
  const isQuote = (options.kind ?? '').toLowerCase() === 'quote';

  // The business name at the top. A recipient decides whether an email is legitimate before they
  // read it, and the sender's identity is otherwise only in the footer, below the fold.
  const header = `
    <tr>
      <td style="padding:0 0 20px 0;border-bottom:1px solid #e5e7eb;">
        <div style="${TEXT}font-size:17px;font-weight:600;">${escapeHtml(options.businessName)}</div>
        ${
          isQuote
            ? `<div style="${TEXT}font-size:13px;color:#6b7280;margin-top:4px;">Quotation${
                options.dateLabel ? ` &middot; ${escapeHtml(options.dateLabel)}` : ''
              }</div>`
            : ''
        }
      </td>
    </tr>`;

  const html = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f6f7f9;padding:24px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:28px;">
        ${header}
        <tr><td style="padding-top:20px;">${renderBlocks(blocks)}</td></tr>
      </table>
    </td>
  </tr>
</table>`;

  return { html, text: body };
}
