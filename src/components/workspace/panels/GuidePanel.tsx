'use client';

/**
 * BUILD GUIDE — the human-readable, step-by-step instructions. The rendered
 * guide is front and centre; the raw markdown / section index are only revealed
 * under "details".
 */

import { useState } from 'react';

import { Badge, Card, CopyButton, DownloadButton, Empty, Loader, Markdown, SectionTitle } from '../ui';
import { CodeView } from '../syntax';
import { useHub } from '../hub-context';

type Tab = 'guide' | 'markdown' | 'bom';

export function GuidePanel() {
  const { project, running, details } = useHub();
  const instructions = project?.artifacts.instructions ?? null;
  const [tab, setTab] = useState<Tab>('guide');

  if (!instructions) {
    return (
      <Card title="Build guide" wide count="none yet">
        {running ? (
          <Loader label="Writing the step-by-step build instructions" />
        ) : (
          <Empty>No build guide was generated.</Empty>
        )}
      </Card>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'guide', label: 'guide' },
    { id: 'bom', label: `bill of materials (${instructions.billOfMaterials.length})` },
    { id: 'markdown', label: 'raw' },
  ];

  return (
    <Card
      title="Build guide"
      wide
      count={`${instructions.sections.length} steps`}
      actions={
        <span className="row row--tight">
          {tabs.map((entry) => (
            <button key={entry.id} type="button" className={tab === entry.id ? 'filter filter--active' : 'filter'} onClick={() => setTab(entry.id)}>
              {entry.label}
            </button>
          ))}
          <CopyButton text={instructions.markdown} label="copy" />
          <DownloadButton filename="instructions.md" content={instructions.markdown} mime="text/markdown" label="download" />
        </span>
      }
      footer={<span>{instructions.estimatedBuildTimeMinutes ? `about ${instructions.estimatedBuildTimeMinutes} min to build` : 'build time not estimated'}</span>}
    >
      {tab === 'guide' ? (
        <>
          {instructions.billOfMaterials.length > 0 ? (
            <div className="guide__bom">
              <SectionTitle>What you'll need</SectionTitle>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>item</th>
                      <th className="num">qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {instructions.billOfMaterials.map((entry, index) => (
                      <tr key={`${entry.name}-${index}`}>
                        <td>{entry.name}</td>
                        <td className="num">{entry.quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
          <Markdown source={instructions.markdown} />
        </>
      ) : null}

      {tab === 'bom' ? (
        <>
          <SectionTitle>Bill of materials</SectionTitle>
          {instructions.billOfMaterials.length === 0 ? (
            <Empty>The bill of materials is empty.</Empty>
          ) : (
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
          )}
        </>
      ) : null}

      {tab === 'markdown' ? (
        <CodeView content={instructions.markdown} language="markdown" maxHeight={560} />
      ) : null}

      {details && instructions.markdown && tab === 'guide' ? (
        <p className="faint small" style={{ marginTop: 10 }}>
          Raw markdown is available under the "raw" tab.
        </p>
      ) : null}
    </Card>
  );
}
