import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf-8');

test('layout switches out of three-column mode before fixed tracks can overflow', () => {
  const breakpointWidths = [...styles.matchAll(/@media\s*\(max-width:\s*(\d+)px\)/g)].map((match) => Number(match[1]));

  assert.ok(
    breakpointWidths.some((width) => width >= 1320),
    `expected a responsive breakpoint at or above 1320px, got ${breakpointWidths.join(', ')}`
  );
  assert.match(styles, /grid-template-columns:\s*minmax\(280px,\s*320px\)\s+minmax\(0,\s*1fr\)/);
});

test('viewer stage is visually owned by the MuJoCo render instead of a CSS overlay grid', () => {
  assert.doesNotMatch(styles, /\.mujoco-stage::before/);
  assert.match(styles, /grid-template-columns:\s*300px\s+minmax\(640px,\s*1fr\)\s+320px/);
  assert.match(styles, /\.layout\s*\{[\s\S]*align-items:\s*start/);
  assert.match(styles, /\.viewer-frame\s*\{[\s\S]*background:\s*#17283a/);
});
