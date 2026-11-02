import type { LivePoint, LiveView } from '@sarthi/shared';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { io } from 'socket.io-client';
import { api, ApiError } from '../api';
import { clock, phoneForDisplay, timeAgo } from '../format';
import { LiveMap } from '../map/LiveMap';
import { Footer } from './Footer';
import { Loading } from './InvitePage';
import { Brand, Notice } from './Notice';

/** The page reloads its data this often even without live updates. */
const RELOAD_MS = 60_000;
/** Accuracy worse than this is shown as "approximate". */
const APPROXIMATE_M = 100;

type State =
  | { step: 'loading' }
  | { step: 'ended' }
  | { step: 'error'; message: string }
  | { step: 'live'; view: LiveView };

/** /l/<code>: live location during an SOS or a shared journey. */
export function LivePage({ code }: { code: string }) {
  const [state, setState] = useState<State>({ step: 'loading' });
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    try {
      const view = await api.live(code);
      setOffline(false);
      setState({ step: 'live', view });
    } catch (err) {
      const e = err as ApiError;
      if (e.code === 'link_expired') setState({ step: 'ended' });
      else if (e.code === 'offline') setOffline(true);
      else setState((s) => (s.step === 'live' ? s : { step: 'error', message: e.message }));
    }
  }, [code]);

  useEffect(() => {
    void load();
    const reload = window.setInterval(() => void load(), RELOAD_MS);
    // "2 min ago" stays correct.
    const clockTimer = window.setInterval(() => tick((n) => n + 1), 15_000);

    const socket = io({ path: '/g/socket.io', auth: { code }, transports: ['websocket'] });
    socket.on('location', (point: LivePoint) => {
      setState((s) =>
        s.step === 'live' && (!s.view.location || s.view.location.recordedAt <= point.recordedAt)
          ? {
              step: 'live',
              view: {
                ...s.view,
                location: point,
                batteryPct: point.batteryPct ?? s.view.batteryPct,
              },
            }
          : s,
      );
    });
    socket.on('changed', () => void load());
    socket.on('ended', () => void load());
    // After a lost connection, catch up on anything missed.
    socket.io.on('reconnect', () => void load());

    return () => {
      window.clearInterval(reload);
      window.clearInterval(clockTimer);
      socket.disconnect();
    };
  }, [code, load]);

  if (state.step === 'loading') return <Loading />;
  if (state.step === 'ended') {
    return <Notice title="This alert has ended.">The live location is no longer shared.</Notice>;
  }
  if (state.step === 'error') {
    return (
      <Notice title="Could not load the live location" tone="warn">
        {state.message}
      </Notice>
    );
  }

  const { view } = state;
  const name = view.person.firstName;
  const isSos = view.kind === 'sos';
  const ended = view.status === 'ended';

  const respond = async () => {
    setBusy(true);
    setActionError(null);
    try {
      setState({ step: 'live', view: await api.responding(code) });
    } catch (err) {
      setActionError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={`page live live-${view.kind}`}>
      <Brand />
      <section
        className={`banner ${ended ? 'banner-ok' : isSos ? 'banner-sos' : 'banner-journey'}`}
      >
        <h1>{headline(view)}</h1>
        <p>{subline(view)}</p>
      </section>

      {offline && (
        <p className="warning" role="alert">
          No internet connection. Showing the last update we received.
        </p>
      )}
      {view.lostContact && !ended && (
        <p className="warning" role="alert">
          We lost contact with {name}’s phone. The map shows the last location we received.
        </p>
      )}

      <LiveMap
        tone={view.kind}
        point={view.location}
        destination={
          view.journey
            ? { ...view.journey.destination, label: view.journey.destinationLabel }
            : null
        }
        route={view.journey?.route}
      />

      <section className="card facts-grid">
        <Fact label="Last update">
          {view.location ? (
            <>
              {timeAgo(view.location.recordedAt)}{' '}
              <span className="muted">({clock(view.location.recordedAt)})</span>
            </>
          ) : (
            'No location yet'
          )}
        </Fact>
        {view.location?.accuracyM != null && view.location.accuracyM > APPROXIMATE_M && (
          <Fact label="Accuracy">Approximate, within {Math.round(view.location.accuracyM)} m</Fact>
        )}
        <Fact label="Battery">{view.batteryPct != null ? `${view.batteryPct}%` : '—'}</Fact>
        {isSos && <Fact label="Blood group">{view.person.bloodGroup ?? 'Not given'}</Fact>}
        {view.journey && <Fact label="Expected by">{clock(view.journey.expectedArrivalAt)}</Fact>}
      </section>

      {isSos && !ended && (
        <section className="card actions-card">
          {view.youAreResponding ? (
            <p className="responding" role="status">
              ✓ You’re responding. {name} and the other guardians can see this.
            </p>
          ) : (
            <button
              className="btn btn-primary btn-big"
              disabled={busy}
              onClick={() => void respond()}
            >
              I’m responding
            </button>
          )}
          {actionError && (
            <p className="error" role="alert">
              {actionError}
            </p>
          )}
          <div className="actions">
            {view.person.phone && (
              <a className="btn btn-plain" href={`tel:${view.person.phone}`}>
                Call {name}
                <span className="muted"> {phoneForDisplay(view.person.phone)}</span>
              </a>
            )}
            <a className="btn btn-danger" href="tel:112">
              Call 112
            </a>
          </div>
        </section>
      )}

      {view.guardians.length > 1 && (
        <section className="card">
          <h2>Guardians</h2>
          <ul className="guardians">
            {view.guardians.map((g, i) => (
              <li key={i}>
                <span>
                  {g.firstName}
                  {g.isYou && <span className="muted"> (you)</span>}
                </span>
                <span className={`pill pill-${g.status}`}>{STATUS[g.status]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Footer />
    </main>
  );
}

const STATUS = { alerted: 'Alerted', opened: 'Seen', responding: 'Responding' } as const;

function headline(view: LiveView): string {
  const name = view.person.firstName;
  if (view.kind === 'sos') return view.status === 'ended' ? `${name} is safe` : `SOS from ${name}`;
  if (view.outcome === 'arrived') return `${name} reached ${view.journey?.destinationLabel} safely`;
  if (view.status === 'ended') return `${name} ended the journey`;
  return `${name} is on the way to ${view.journey?.destinationLabel}`;
}

function subline(view: LiveView): string {
  if (view.kind === 'sos') {
    return view.status === 'ended'
      ? `The SOS ended at ${clock(view.endedAt ?? view.startedAt)}. This page closes soon.`
      : `Started at ${clock(view.startedAt)}. If you can’t reach ${view.person.firstName}, call 112.`;
  }
  return view.status === 'ended'
    ? 'Live location sharing has stopped. This page closes soon.'
    : `Started at ${clock(view.startedAt)}. You can follow the live location here.`;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <div className="fact-label">{label}</div>
      <div className="fact-value">{children}</div>
    </div>
  );
}
