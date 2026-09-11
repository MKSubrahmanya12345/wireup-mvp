/**
 * Project Atlas verifier — deterministic, offline, no Mongo, no model.
 */

import assert from 'node:assert/strict';

import { buildProjectAtlas, planAtlasTransform } from '@/modules/project-atlas';

const source = `Guitar profile
body: mahogany
neck: maple
fretboard: rosewood
strings: 6
scale length: 25.5 in
pickups: 2 humbuckers
tuning: standard E
finish: sunburst`;

function check(label: string, fn: () => void): void {
  fn();
  console.log(`  ✓ ${label}`);
}

console.log('wireup · project atlas verifier (offline)');

const atlas = buildProjectAtlas([{ title: 'Guitar profile', kind: 'profile', content: source }]);
const replay = buildProjectAtlas([{ title: 'Guitar profile', kind: 'profile', content: source }]);

check('source is content-addressed', () => {
  assert.equal(atlas.sources[0]?.contentHash, replay.sources[0]?.contentHash);
  assert.equal(atlas.sources[0]?.chars, source.length);
});
check('graph is non-empty and repeatable by id', () => {
  assert.ok(atlas.nodes.length >= 8);
  assert.ok(atlas.edges.length >= 8);
  assert.deepEqual(atlas.nodes.map((node) => node.id), replay.nodes.map((node) => node.id));
  assert.deepEqual(atlas.edges.map((edge) => edge.id), replay.edges.map((edge) => edge.id));
});
check('numeric facts are preserved with units', () => {
  assert.ok(atlas.metrics.some((metric) => metric.value === 6 && metric.unit === 'count'));
  assert.ok(atlas.metrics.some((metric) => metric.value === 25.5 && metric.unit === 'in'));
  assert.equal(atlas.quantification.metricCount, 2);
});
check('coverage and confidence are explicit numbers', () => {
  assert.ok(atlas.quantification.coverage > 0.8);
  assert.ok(atlas.quantification.confidence > 0.8);
  assert.equal(atlas.quantification.unresolvedCount, 0);
});

const java = planAtlasTransform(atlas, { language: 'java', packageName: 'demo.guitar' });
check('Java adapter produces an approval-gated project', () => {
  assert.equal(java.status, 'ready');
  assert.equal(java.requiresApproval, true);
  assert.ok(java.files.some((file) => file.path.endsWith('/GuitarProfile.java')));
  assert.ok(java.files.some((file) => file.path === 'pom.xml'));
  assert.ok(java.mappings.some((mapping) => mapping.targetPath === 'GuitarProfile.strings' && mapping.targetType === 'int'));
  assert.ok(java.mappings.some((mapping) => mapping.targetPath === 'GuitarProfile.scaleLength' && mapping.targetType === 'double'));
  assert.ok(java.files.find((file) => file.path.endsWith('Parser.java'))?.content.includes('scale-length'));
});

const unsupported = planAtlasTransform(atlas, { language: 'kotlin' });
check('missing adapters stay honest', () => {
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.files.length, 0);
  assert.ok(unsupported.gaps.length > 0);
});

console.log(`✓ Atlas checks passed — ${atlas.quantification.nodeCount} nodes, ${atlas.quantification.edgeCount} edges, ${atlas.quantification.metricCount} metrics, ${java.files.length} Java project files`);
