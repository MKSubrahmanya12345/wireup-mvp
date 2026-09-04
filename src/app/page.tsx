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
        <span className="topbar__meta">agentic hardware engineering</span>
      </header>

      <main className="landing">
        <div className="landing__inner">
          <p className="landing__eyebrow">Prompt → components → wiring → firmware → validation → fix</p>
          <h1 className="landing__title">Describe the hardware. Get the whole engineering package.</h1>
          <p className="landing__subtitle">
            An agent reads your request, picks real parts from the component database, plans power, pins and the wiring
            graph, writes the firmware, renders <span className="mono">diagram.json</span>, lists the libraries and the
            build steps — then validates the result and patches only what is broken.
          </p>

          <PromptForm />

          <p className="landing__note">
            Every submission creates a brand new project — nothing is cached or reused. No account required.
          </p>
        </div>
      </main>
    </>
  );
}
