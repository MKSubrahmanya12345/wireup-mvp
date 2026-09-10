import Link from 'next/link';

import { PromptForm } from '@/components/PromptForm';
import { env } from '@/lib/validation/env';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  // State the store mode loudly: a demo that forgets persistence is a lie.
  const memoryStore = env().store.mode === 'memory';
  return (
    <>
      <header className="topbar">
        <Link href="/" className="topbar__brand">
          <span className="topbar__mark">W</span>
          <span>Wireup</span>
        </Link>
        <span className="topbar__spacer" />
        <Link
          href="/admin"
          className="btn btn--sm"
          style={{
            marginRight: 14,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontWeight: 600,
            background: 'var(--bg-sunken)',
            border: '1px solid var(--border-strong)',
            color: 'var(--text)',
            padding: '4px 12px',
          }}
        >
          <span style={{ fontSize: 13 }}>⚙</span>
          <span>Admin Login</span>
        </Link>
        <span className="topbar__meta topbar__meta--landing">engineering copilot / ready</span>
      </header>

      <main className="landing">
        <div className="landing__inner">
          {memoryStore ? (
            <div
              className="store-banner"
              style={{
                border: '1px solid var(--border-strong)',
                background: 'var(--bg-sunken)',
                borderRadius: 10,
                padding: '10px 14px',
                marginBottom: 18,
                fontSize: 13.5,
                lineHeight: 1.45,
              }}
            >
              <strong>Dev mode — in-memory store.</strong> <code>MONGODB_URI</code> is not set, so projects live in
              this server process and are <em>lost on restart</em>. Everything else works: the doubt session, the
              build, the idea graph and both human channels. Set <code>MONGODB_URI</code> in <code>.env</code> for
              persistent storage.
            </div>
          ) : null}
          <div className="landing__beacon" aria-hidden="true">
            <span className="landing__beacon-orbit landing__beacon-orbit--outer" />
            <span className="landing__beacon-orbit landing__beacon-orbit--inner" />
            <span className="landing__beacon-core">W</span>
            <span className="landing__beacon-label">idea / signal / build</span>
          </div>
          <div className="landing__signal" aria-hidden="true">
            <span className="landing__signal-line" />
            <span>bench 01 / intake</span>
            <span className="landing__signal-line landing__signal-line--short" />
          </div>
          <p className="landing__eyebrow">BRIEF / DOUBTS / GRAPH / BUILD / EVERFLOW</p>
          <h1 className="landing__title">From "what if?" to wires on the bench.</h1>
          <p className="landing__subtitle">
            Give Wireup the messy version of your hardware idea. It settles the open questions with you, builds a
            grounded plan with real parts, power, pins and firmware — then keeps iterating on the project graph
            until every goal is met.
          </p>

          <div className="landing__form-label">
            <span>Tell the bench what you're making</span>
            <span className="landing__form-label-detail">one brief in · questions settled · a living project out</span>
          </div>
          <PromptForm />

          <div className="landing__proof">
            <span className="landing__proof-mark" aria-hidden="true" />
            <p className="landing__note">
              A fresh project every time. No account, no recycled plans, no black box between the brief and the bench.
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
