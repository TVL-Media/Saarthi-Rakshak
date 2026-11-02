import { InvitePage } from './pages/InvitePage';
import { LivePage } from './pages/LivePage';
import { Notice } from './pages/Notice';

/** Two pages, picked from the SMS link: /i/<code> (invite) and /l/<code> (live). */
export function App() {
  const match = /^\/(i|l)\/([A-Za-z0-9_-]+)\/?$/.exec(window.location.pathname);
  if (!match) {
    return (
      <Notice title="Link not found">
        Open the link exactly as it came in the SMS from Sarthi Rakshak.
      </Notice>
    );
  }
  return match[1] === 'i' ? <InvitePage code={match[2]} /> : <LivePage code={match[2]} />;
}
