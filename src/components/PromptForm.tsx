'use client';

/**
 * Page 1 — the only input the user needs.
 *
 * Submitting creates a brand new project (never a cached one) and navigates to
 * the workspace, where the agent console streams the real pipeline.
 */

import { useRouter } from 'next/navigation';
import { useCallback, useState, type FormEvent } from 'react';

const EXAMPLES: { title: string; prompt: string }[] = [
  {
    title: 'Bluetooth RC car',
    prompt:
      'Build a Bluetooth-controlled RC car with an ESP32, two DC gear motors driven through an L298N, an HC-05 for commands from my phone, and a HC-SR04 that stops the car before it hits obstacles.',
  },
  {
    title: 'Plant watering monitor',
    prompt:
      'Arduino Uno based plant monitor: a soil moisture sensor and a DHT22 report over serial, an LED warns when the soil is dry, and a relay switches a 5 V pump for three seconds when needed.',
  },
  {
    title: 'Motion alarm node',
    prompt:
      'ESP32 security node: a PIR sensor triggers a buzzer and an RGB LED, an MPU6050 detects tampering, and status is streamed over Bluetooth, powered from a 9 V battery with a regulator.',
  },
];

const MIN_LENGTH = 8;
const MAX_LENGTH = 4000;

export function PromptForm() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      if (busy) return;

      const trimmed = prompt.trim();
      if (trimmed.length < MIN_LENGTH) {
        setError(`Describe the project in at least ${MIN_LENGTH} characters.`);
        return;
      }
      if (trimmed.length > MAX_LENGTH) {
        setError(`Prompts are limited to ${MAX_LENGTH} characters.`);
        return;
      }

      setBusy(true);
      setError(null);
      setStage('Creating a new project record…');

      try {
        const response = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: trimmed }),
        });

        const payload = (await response.json().catch(() => null)) as
          | { ok?: boolean; data?: { project?: { id?: string } }; error?: { message?: string; details?: string } }
          | null;

        if (!response.ok || !payload?.ok) {
          const message = payload?.error?.message ?? `The server responded with ${response.status}.`;
          const details = payload?.error?.details;
          throw new Error(details ? `${message} (${details})` : message);
        }

        const projectId = payload.data?.project?.id;
        if (!projectId) throw new Error('The server did not return a project id.');

        setStage('Project created — the agent is starting, opening the workspace…');
        router.push(`/project/${projectId}`);
        router.refresh();
      } catch (submitError) {
        setError(submitError instanceof Error ? submitError.message : String(submitError));
        setStage(null);
        setBusy(false);
      }
    },
    [busy, prompt, router],
  );

  const tooLong = prompt.length > MAX_LENGTH;

  return (
    <form className="prompt-form" onSubmit={submit}>
      <div className="prompt-form__head">
        <span>project brief</span>
        <span className="topbar__spacer" />
        <span>
          {prompt.length}/{MAX_LENGTH}
        </span>
      </div>

      <textarea
        className="prompt-form__textarea"
        value={prompt}
        placeholder="e.g. Bluetooth controlled RC car with an ESP32, two DC motors through an L298N, an HC-05 for phone commands and an ultrasonic sensor that stops before obstacles."
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit();
        }}
        disabled={busy}
        autoFocus
        spellCheck
        maxLength={MAX_LENGTH + 200}
        aria-label="Project description"
      />

      <div className="prompt-form__foot">
        <span className="prompt-form__hint">
          {busy && stage ? (
            <span className="row row--tight">
              <span className="dot dot--live" />
              <span className="mono-sm">{stage}</span>
            </span>
          ) : (
            <>
              Name the parts you want, or just the behaviour — the agent grounds everything in the component database.
              <span className="faint"> ⌘/Ctrl + Enter</span>
            </>
          )}
        </span>
        <button type="submit" className="btn btn--primary" disabled={busy || tooLong}>
          {busy ? 'Creating…' : 'Generate project'}
        </button>
      </div>

      {error ? (
        <p className="prompt-form__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="examples">
        {EXAMPLES.map((example) => (
          <button
            key={example.title}
            type="button"
            className="example"
            disabled={busy}
            onClick={() => {
              setPrompt(example.prompt);
              setError(null);
            }}
          >
            <span className="example__title">{example.title}</span>
            <span className="example__body">{example.prompt}</span>
          </button>
        ))}
      </div>
    </form>
  );
}
