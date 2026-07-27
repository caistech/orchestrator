'use client';

// The confirm step in front of an irreversible, customer-facing send.
//
// It names the RECIPIENT rather than asking "are you sure?". A generic confirmation trains people to
// click through it; naming the person who is about to receive the email is what catches the row you
// did not mean to be looking at. Same reason the amount and the client name are on the card above.
//
// Discard does NOT confirm. It sends nothing, and the drafted work stays in the record — making
// someone confirm a safe action is how the confirm on the dangerous one loses its meaning.

import { useState } from 'react';

export function ConfirmSend({
  taskId, recipient, summary, action,
}: {
  taskId: string;
  recipient: string | null;
  summary: string;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="inline">
        <button className="primary" type="button" onClick={() => setConfirming(true)}>
          Approve and send…
        </button>
        <form action={action}>
          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="approve" value="false" />
          <button type="submit">Discard</button>
        </form>
      </div>
    );
  }

  return (
    <div className="card" style={{ borderColor: 'var(--acc)', marginBottom: 0 }}>
      <strong>Send this now?</strong>
      <p style={{ color: 'var(--mut)', margin: '.5rem 0 .9rem' }}>
        {recipient
          ? <>It goes to <strong>{recipient}</strong> as soon as the next send runs. You cannot recall it.</>
          : <>There is <strong>no recipient</strong> on this one, so it cannot be sent — it will be refused rather than delivered.</>}
        {' '}({summary})
      </p>
      <div className="inline">
        <form action={action}>
          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="approve" value="true" />
          <button className="primary" type="submit" disabled={!recipient}>
            Yes — send to {recipient ?? '(nobody)'}
          </button>
        </form>
        <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
      </div>
    </div>
  );
}
