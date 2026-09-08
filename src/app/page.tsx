import Link from 'next/link';

import { PromptForm } from '@/components/PromptForm';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  return (
    <>
      <header className="topbar">
        <Link href="/" className="topbar__brand">
          <span className="topbar__mark">W</span>
          <span>Wireup</span>
        </Link>
        <span className="topbar__spacer" />
        <span className="topbar__meta topbar__meta--landing">engineering copilot / ready</span>
      </header>

      <main className="landing">
        <div className="landing__inner">
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
          <p className="landing__eyebrow">BRIEF / PARTS / WIRING / FIRMWARE / VALIDATION</p>
          <h1 className="landing__title">From "what if?" to wires on the bench.</h1>
          <p className="landing__subtitle">
            Give Wireup the messy version of your hardware idea. Get back a grounded build plan with real parts,
            power, pins, firmware, and the next move worth making.
          </p>

          <div className="landing__form-label">
            <span>Tell the bench what you're making</span>
            <span className="landing__form-label-detail">one brief in / one build plan out</span>
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