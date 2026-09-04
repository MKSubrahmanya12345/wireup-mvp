'use client';

/**
 * INSTRUCTIONS card — the generated build guide: rendered markdown, the raw
 * markdown, the section index and the bill of materials.
 */

import { useState } from 'react';

import { Badge, Card, CopyButton, DownloadButton, Empty, Loader, Markdown, SectionTitle } from '../ui';
import { CodeView } from '../syntax';
import { plural, type CardProps } from './types';

type Tab = 'rendered' | 'markdown' | 'sections' | 'bom';

export function InstructionsCard({ project, running, activity }: CardProps) {
  const instructions = project?.artifacts.instructions ?? null;
  const [tab, setTab] = useState<Tab>('rendered');
  const [openSection, setOpenSection] = useState<string | null>(null);

  if (!instructions) {
    return (
      <Card title="Instructions" wide count="build guide">
        {running ? (
          <Loader label="Writing the build guide from the wiring graph and pin map" detail={activity} />
        ) : (
          <Empty>No instructions were generated.</Empty>
        )}
      </Card>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'rendered', label: 'rendered' },
    { id: 'markdown', label: 'instructions.md' },
    { id: 'sections', label: `sections (${instructions.sections.length})` },
    { id: 'bom', label: `bom (${instructions.billOfMaterials.length})` },
  ];

  return (
    <Card
      title="Instructions"
      wide
      count={`${plural(instructions.sections.length, 'section')}`}
      actions={
        <span className="row row--tight">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={tab === entry.id ? 'filter filter--active' : 'filter'}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
          <CopyButton text={instructions.markdown} label="copy md" />
          <DownloadButton filename="instructions.md" content={instructions.markdown} mime="text/markdown" label="download" />
        </span>
      }
      footer={
        <span>
          {instructions.estimatedBuildTimeMinutes
            ? `estimated build time ${instructions.estimatedBuildTimeMinutes} min · `
            : 'build time not estimated · '}
          {plural(instructions.markdown.length, 'character')} · generated {instructions.generatedAt}
        </span>
      }
    >
      {tab === 'rendered' ? <Markdown source={instructions.markdown} /> : null}

      {tab === 'markdown' ? <CodeView content={instructions.markdown} language="markdown" maxHeight={560} /> : null}

      {tab === 'sections' ? (
        <>
          {[...instructions.sections]
            .sort((a, b) => a.order - b.order)
            .map((section) => {
              const open = openSection === section.id;
              return (
                <div className="part" key={section.id}>
                  <button
                    type="button"
                    className="part__head"
                    onClick={() => setOpenSection(open ? null : section.id)}
                    aria-expanded={open}
                  >
                    <span className="faint mono-sm">{open ? '▾' : '▸'}</span>
                    <span className="part__name">
                      {section.order}. {section.title}
                    </span>
                    <span className="part__id">{section.id}</span>
                    <Badge>{plural(section.body.length, 'char')}</Badge>
                  </button>
                  {open ? (
                    <div className="part__body">
                      <Markdown source={section.body} />
                    </div>
                  ) : null}
                </div>
              );
            })}
        </>
      ) : null}

      {tab === 'bom' ? (
        <>
          <SectionTitle>Bill of materials</SectionTitle>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>item</th>
                  <th className="num">qty</th>
                  <th>notes</th>
                </tr>
              </thead>
              <tbody>
                {instructions.billOfMaterials.map((entry, index) => (
                  <tr key={`${entry.name}-${index}`}>
                    <td>{entry.name}</td>
                    <td className="num">{entry.quantity}</td>
                    <td className="small muted">{entry.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {instructions.billOfMaterials.length === 0 ? <Empty>The bill of materials is empty.</Empty> : null}
        </>
      ) : null}
    </Card>
  );
}
