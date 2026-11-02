import type { InviteInfo } from '@sarthi/shared';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { Footer } from './Footer';
import { Brand, Notice } from './Notice';

type State =
  | { step: 'loading' }
  | { step: 'error'; error: ApiError }
  | { step: 'ask'; info: InviteInfo; confirmDecline: boolean; busy: boolean; failed?: string }
  | { step: 'accepted'; info: InviteInfo }
  | { step: 'declined'; info: InviteInfo };

/** /i/<code>: accept or decline being someone's safety guardian. */
export function InvitePage({ code }: { code: string }) {
  const [state, setState] = useState<State>({ step: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api
      .invite(code)
      .then((info) => {
        if (cancelled) return;
        if (info.status === 'accepted') setState({ step: 'accepted', info });
        else if (info.status === 'declined') setState({ step: 'declined', info });
        else setState({ step: 'ask', info, confirmDecline: false, busy: false });
      })
      .catch((error: ApiError) => !cancelled && setState({ step: 'error', error }));
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (state.step === 'loading') return <Loading />;
  if (state.step === 'error') {
    return state.error.code === 'link_expired' || state.error.code === 'not_found' ? (
      <Notice title="This invite link no longer works">
        {state.error.message} Ask the person who invited you to send a new invite from their app.
      </Notice>
    ) : (
      <Notice title="Could not open the invite" tone="warn">
        {state.error.message}
      </Notice>
    );
  }
  const who = state.info.inviterFirstName;
  if (state.step === 'accepted') {
    return (
      <Notice title="You are a safety guardian" tone="ok">
        You’ll get {who}’s alerts by SMS, with a link to their live location. You don’t need an app.
      </Notice>
    );
  }
  if (state.step === 'declined') {
    return (
      <Notice title="Invite declined">
        Your number was deleted. You won’t be added again by {who}.
      </Notice>
    );
  }

  const answer = async (accept: boolean) => {
    setState({ ...state, busy: true, failed: undefined });
    try {
      await (accept ? api.accept(code) : api.decline(code));
      setState({ step: accept ? 'accepted' : 'declined', info: state.info });
    } catch (err) {
      setState({ ...state, busy: false, failed: (err as ApiError).message });
    }
  };

  return (
    <main className="page">
      <Brand />
      <section className="card">
        <h1>
          {who} added you as a safety guardian, {state.info.guardianName}
        </h1>
        <p>
          If {who} presses SOS on Sarthi Rakshak, you will get an SMS with a link to see where they
          are. You may also get a message when they start or finish a journey.
        </p>
        <ul className="facts">
          <li>No app needed — everything comes by SMS.</li>
          <li>You only see {who}’s location during an SOS or a journey they share.</li>
          <li>You can stop at any time by asking {who} to remove you.</li>
        </ul>
        {state.failed && (
          <p className="error" role="alert">
            {state.failed}
          </p>
        )}
        {state.confirmDecline ? (
          <div className="confirm">
            <p>
              <strong>Decline?</strong> Your number will be deleted and {who} can’t add you again.
            </p>
            <div className="actions">
              <button
                className="btn btn-danger"
                disabled={state.busy}
                onClick={() => void answer(false)}
              >
                Yes, decline
              </button>
              <button
                className="btn btn-plain"
                disabled={state.busy}
                onClick={() => setState({ ...state, confirmDecline: false })}
              >
                Go back
              </button>
            </div>
          </div>
        ) : (
          <div className="actions">
            <button
              className="btn btn-primary"
              disabled={state.busy}
              onClick={() => void answer(true)}
            >
              Accept
            </button>
            <button
              className="btn btn-plain"
              disabled={state.busy}
              onClick={() => setState({ ...state, confirmDecline: true })}
            >
              Decline
            </button>
          </div>
        )}
      </section>
      <Footer />
    </main>
  );
}

export function Loading() {
  return (
    <main className="page" aria-busy="true">
      <Brand />
      <section className="card">
        <div className="skeleton skeleton-title" />
        <div className="skeleton" />
        <div className="skeleton short" />
      </section>
    </main>
  );
}
