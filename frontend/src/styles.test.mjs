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

test('motion tree cannot grow beyond the left panel when relative paths are long', () => {
  assert.match(styles, /\.sidebar\s*\{[\s\S]*overflow:\s*hidden/);
  assert.match(styles, /\.panel\s*\{[\s\S]*min-width:\s*0/);
  assert.match(styles, /\.status,\s*\.note\s*\{[\s\S]*font-size:\s*11px/);
  assert.match(styles, /\.status\s*\{[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(styles, /\.tree\s*\{[\s\S]*overflow-x:\s*hidden/);
  assert.match(styles, /\.tree-node\s*\{[\s\S]*min-width:\s*0/);
  assert.match(styles, /\.tree-text\s*\{[\s\S]*min-width:\s*0/);
  assert.match(styles, /\.tree-label,\s*\.tree-parent\s*\{[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(styles, /\.tree-label\s*\{[\s\S]*font-size:\s*12px/);
  assert.match(styles, /\.tree-parent\s*\{[\s\S]*font-size:\s*9px/);
});
