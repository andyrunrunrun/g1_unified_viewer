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
  assert.match(styles, /@media\s*\(max-width:\s*1480px\)\s*\{[\s\S]*\.industrial-layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(280px,\s*330px\)\s+minmax\(0,\s*1fr\)/);
});

test('viewer stage is visually owned by the MuJoCo render instead of a CSS overlay grid', () => {
  assert.doesNotMatch(styles, /\.mujoco-stage::before/);
  assert.match(styles, /\.industrial-layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(250px,\s*0\.78fr\)\s+minmax\(820px,\s*1\.9fr\)\s+minmax\(250px,\s*0\.78fr\)/);
  assert.match(styles, /\.layout\s*\{[\s\S]*align-items:\s*start/);
  assert.match(styles, /\.viewer-frame\s*\{[\s\S]*background:\s*var\(--stage-bg\)/);
});

test('industrial console layout prioritizes viewer and collapses diagnostics', () => {
  assert.match(styles, /\.industrial-layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(250px,\s*0\.78fr\)\s+minmax\(820px,\s*1\.9fr\)\s+minmax\(250px,\s*0\.78fr\)/);
  assert.match(styles, /\.workflow-rail,\s*\.control-rail\s*\{[\s\S]*overflow-x:\s*hidden/);
  assert.match(styles, /\.mujoco-stage\s*\{[\s\S]*height:\s*calc\(100vh - 224px\)/);
  assert.match(styles, /\.diagnostics-panel:not\(\[open\]\) \.debug-grid\s*\{[\s\S]*display:\s*none/);
  assert.match(styles, /\.viewer-overlay\s*\{[\s\S]*display:\s*grid/);
  assert.match(styles, /\.viewer-overlay\s*\{[\s\S]*border-radius:\s*0/);
  assert.match(styles, /\.command-button\s*\{[\s\S]*display:\s*inline-flex/);
  assert.match(styles, /\.control-icon\s*\{[\s\S]*width:\s*15px/);
});

test('day and night themes are driven by console theme tokens', () => {
  assert.match(styles, /:root,\s*:root\[data-theme="dark"\],\s*\.industrial-shell\[data-theme="dark"\]\s*\{/);
  assert.match(styles, /:root\[data-theme="light"\],\s*\.industrial-shell\[data-theme="light"\]\s*\{/);
  assert.match(styles, /color-scheme:\s*light/);
  assert.match(styles, /--bg:/);
  assert.match(styles, /--surface:/);
  assert.match(styles, /--viewer-shell:/);
  assert.match(styles, /--stage-bg:/);
  assert.match(styles, /background:\s*var\(--body-bg\)/);
  assert.match(styles, /\.theme-toggle-button\s*\{[\s\S]*border-color:\s*transparent/);
  assert.match(styles, /\.theme-icon-sun/);
  assert.match(styles, /\.theme-icon-moon/);
});

test('global language toggle stays compact in the top bar', () => {
  assert.match(styles, /\.language-toggle\s*\{[\s\S]*display:\s*inline-flex/);
  assert.match(styles, /\.language-toggle\s*\{[\s\S]*flex:\s*0 0 auto/);
  assert.match(styles, /\.language-toggle\s*\{[\s\S]*border:\s*1px solid color-mix\(in srgb,\s*var\(--amber\)\s*22%,\s*var\(--line\)\s*78%\)/);
  assert.match(styles, /\.language-toggle\s*\{[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--surface\)\s*76%,\s*var\(--surface-2\)\s*24%\)/);
  assert.match(styles, /\.language-toggle-options\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(38px,\s*auto\)\)/);
  assert.match(styles, /\.language-toggle button\s*\{[\s\S]*min-height:\s*28px/);
  assert.match(styles, /\.language-toggle button\s*\{[\s\S]*font-size:\s*13px/);
  assert.match(styles, /\.language-toggle button\.active\s*\{[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--amber\)\s*18%,\s*var\(--surface-3\)\s*82%\)/);
  assert.match(styles, /\.language-icon\s*\{[\s\S]*width:\s*16px/);
});

test('top command bar uses a compact status rail and action cluster', () => {
  assert.match(styles, /\.command-bar\s*\{[\s\S]*grid-template-columns:\s*auto minmax\(0,\s*1fr\)\s+auto/);
  assert.match(styles, /\.topbar-controls\s*\{[\s\S]*display:\s*(grid|contents)/);
  assert.match(styles, /\.topbar-status-strip\s*\{[\s\S]*display:\s*grid/);
  assert.match(styles, /\.topbar-status-strip\s*\{[\s\S]*grid-template-columns:\s*minmax\(68px,\s*0\.72fr\)\s+minmax\(62px,\s*0\.64fr\)\s+minmax\(62px,\s*0\.64fr\)/);
  assert.match(styles, /\.topbar-status-strip\s*\{[\s\S]*border-radius:\s*999px/);
  assert.match(styles, /\.topbar-status-strip\s*\{[\s\S]*gap:\s*4px/);
  assert.match(styles, /\.topbar-toolbar\s*\{[\s\S]*display:\s*inline-flex/);
  assert.match(styles, /\.topbar-toolbar\s*\{[\s\S]*gap:\s*8px/);
  assert.match(styles, /\.topbar-mode-cluster\s*\{[\s\S]*gap:\s*8px/);
  assert.match(styles, /\.topbar-mode-cluster\s*\{[\s\S]*padding:\s*6px/);
  assert.match(styles, /\.topbar-mode-cluster\s*\{[\s\S]*border:\s*1px solid color-mix\(in srgb,\s*var\(--amber\)\s*22%,\s*var\(--line\)\s*78%\)/);
  assert.match(styles, /\.topbar-icon-button\s*\{[\s\S]*width:\s*48px/);
  assert.match(styles, /\.topbar-icon-button\s*\{[\s\S]*min-height:\s*32px/);
  assert.match(styles, /\.topbar-icon-button span\s*\{[\s\S]*position:\s*absolute/);
  assert.match(styles, /\.physics-toggle-card\s*\{[\s\S]*min-height:\s*44px/);
  assert.match(styles, /\.physics-toggle-card\s*\{[\s\S]*min-width:\s*152px/);
  assert.match(styles, /\.physics-toggle-copy strong\s*\{[\s\S]*letter-spacing:\s*0\.16em/);
  assert.match(styles, /\.physics-toggle-indicator\s*\{[\s\S]*width:\s*10px/);
  assert.match(styles, /\.physics-compact-toggle\s*\{[\s\S]*border-color:\s*color-mix\(in srgb,\s*var\(--amber\)\s*20%,\s*var\(--line\)\s*80%\)/);
  assert.match(styles, /\.status-chip\s*\{[\s\S]*min-height:\s*35px/);
  assert.match(styles, /\.status-chip\s*\{[\s\S]*border-radius:\s*999px/);
  assert.match(styles, /\.status-chip\s*\{[\s\S]*padding:\s*9px 10px 9px 14px/);
  assert.match(styles, /\.status-chip::before\s*\{[\s\S]*border-radius:\s*999px/);
  assert.match(styles, /\.physics-toggle-card\.active,\s*\.physics-compact-toggle\.active\s*\{[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--amber\)\s*14%,\s*var\(--surface-2\)\s*86%\)/);
});

test('topbar status rail keeps compact chips without a policy toolbar badge', () => {
  assert.match(styles, /\.topbar-status-strip\s*\{[\s\S]*min-width:\s*0/);
  assert.match(styles, /\.status-chip\s*\{[\s\S]*min-width:\s*0/);
  assert.match(styles, /\.status-chip\s*\{[\s\S]*overflow:\s*hidden/);
  assert.match(styles, /\.viewer-status-chip\s*\{[\s\S]*min-width:\s*68px/);
  assert.match(styles, /\.truncate-badge\s*\{[\s\S]*justify-content:\s*flex-start/);
  assert.doesNotMatch(styles, /\.toolbar-policy-chip\s*\{/);
  assert.doesNotMatch(styles, /\.badge-label\s*\{/);
  assert.doesNotMatch(styles, /\.badge-value\s*\{/);
});

test('top command bar keeps its two-column header at the main layout breakpoint', () => {
  const wideLayoutMedia = styles.match(/@media\s*\(max-width:\s*1320px\)\s*\{(?<body>[\s\S]*?)\n\}/);
  assert.ok(wideLayoutMedia, 'missing 1320px layout breakpoint');
  assert.match(wideLayoutMedia.groups.body, /\.topbar,\s*\.status-grid,\s*\.viewer-stage-header\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(wideLayoutMedia.groups.body, /\.viewer-toolbar\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(styles, /@media\s*\(max-width:\s*980px\)\s*\{[\s\S]*\.topbar-status-strip\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /@media\s*\(max-width:\s*860px\)\s*\{[\s\S]*\.viewer-overlay\s*\{[\s\S]*grid-template-columns:\s*1fr/);
});

test('motion start transition toggle is compact and cannot stretch the motion panel', () => {
  assert.match(styles, /\.toggle-row\s*\{[\s\S]*grid-template-columns:\s*auto minmax\(0,\s*1fr\)/);
  assert.match(styles, /\.toggle-row\s*\{[\s\S]*border:\s*1px solid var\(--line\)/);
  assert.match(styles, /\.toggle-copy\s*\{[\s\S]*min-width:\s*0/);
  assert.match(styles, /\.toggle-copy small\s*\{[\s\S]*line-height:\s*1\.25/);
  assert.match(styles, /\.motion-start-transition-toggle\s*\{[\s\S]*border-color:\s*color-mix\(in srgb,\s*var\(--accent-2\)\s*36%,\s*var\(--line\)\s*64%\)/);
  assert.match(styles, /\.motion-start-transition-toggle\s*\{[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--surface-2\)\s*88%,\s*var\(--accent-2\)\s*12%\)/);
  assert.match(styles, /\.motion-start-transition-toggle \.toggle-copy strong\s*\{[\s\S]*color:\s*color-mix\(in srgb,\s*var\(--accent-2\)\s*78%,\s*var\(--ink\)\s*22%\)/);
});

test('target smoothing control keeps alpha input compact inside the motion panel', () => {
  assert.match(styles, /\.target-smoothing-control\s*\{[\s\S]*grid-template-columns:\s*auto minmax\(0,\s*1fr\)/);
  assert.match(styles, /\.target-smoothing-alpha\s*\{[\s\S]*grid-template-columns:\s*auto auto minmax\(0,\s*1fr\)/);
  assert.match(styles, /\.target-smoothing-alpha\s*\{[\s\S]*gap:\s*6px/);
  assert.match(styles, /\.target-smoothing-alpha input\[type="range"\]\s*\{[\s\S]*width:\s*100%/);
  assert.match(styles, /\.target-smoothing-alpha input\[type="range"\]\s*\{[\s\S]*margin:\s*0/);
  assert.match(styles, /\.target-smoothing-alpha input\[type="range"\]\s*\{[\s\S]*padding:\s*0/);
  assert.match(styles, /\.target-smoothing-alpha input\[type="range"\]\s*\{[\s\S]*border:\s*0/);
  assert.match(styles, /\.target-smoothing-alpha input\[type="range"\]\s*\{[\s\S]*border-radius:\s*0/);
  assert.match(styles, /\.target-smoothing-alpha input\[type="range"\]\s*\{[\s\S]*appearance:\s*none/);
  assert.match(styles, /\.target-smoothing-alpha input\[type="range"\]\s*\{[\s\S]*--target-smoothing-progress:\s*0%/);
  assert.match(styles, /\.target-smoothing-alpha input\[type="range"\]::-webkit-slider-runnable-track\s*\{[\s\S]*var\(--target-smoothing-progress\)/);
  assert.match(styles, /\.target-smoothing-alpha input\[type="range"\]::-webkit-slider-thumb\s*\{[\s\S]*margin-top:\s*-4px/);
  assert.match(styles, /\.target-smoothing-alpha input\[type="range"\]::-moz-range-track\s*\{[\s\S]*background:\s*color-mix/);
  assert.match(styles, /\.target-smoothing-alpha input\[type="range"\]::-moz-range-progress\s*\{/);
  assert.match(styles, /\.target-smoothing-alpha input\[type="range"\]::-moz-range-progress\s*\{[\s\S]*linear-gradient/);
  assert.match(styles, /\.target-smoothing-alpha input\[type="range"\]::-moz-range-thumb\s*\{[\s\S]*width:\s*16px/);
  assert.match(styles, /\.alpha-value\s*\{[\s\S]*justify-self:\s*start/);
  assert.match(styles, /\.alpha-value\s*\{[\s\S]*font-variant-numeric:\s*tabular-nums/);
  assert.match(styles, /\.target-smoothing-panel\s*\{[\s\S]*border-color:\s*color-mix\(in srgb,\s*var\(--amber\)\s*40%,\s*var\(--line\)\s*60%\)/);
  assert.match(styles, /\.target-smoothing-panel\s*\{[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--surface-2\)\s*88%,\s*var\(--amber\)\s*12%\)/);
  assert.match(styles, /\.target-smoothing-panel \.toggle-copy strong,\s*\.target-smoothing-alpha \.alpha-value\s*\{[\s\S]*color:\s*var\(--amber\)/);
});

test('timeline slider keeps a live progress fill while staying inset from the card edges', () => {
  assert.match(styles, /#timeline\s*\{[\s\S]*padding:\s*0 4px/);
  assert.match(styles, /#timeline\s*\{[\s\S]*--timeline-progress:/);
  assert.match(styles, /#timeline::-webkit-slider-runnable-track\s*\{/);
  assert.match(styles, /#timeline::-webkit-slider-runnable-track\s*\{[\s\S]*var\(--timeline-progress\)/);
  assert.match(styles, /#timeline::-webkit-slider-runnable-track\s*\{[\s\S]*\/\s*var\(--timeline-progress\)\s*100%\s*no-repeat/);
  assert.match(styles, /#timeline::-webkit-slider-thumb\s*\{[\s\S]*margin-top:\s*-5px/);
  assert.match(styles, /#timeline::-moz-range-track\s*\{/);
  assert.match(styles, /#timeline::-moz-range-track\s*\{[\s\S]*var\(--timeline-progress\)/);
  assert.match(styles, /#timeline::-moz-range-track\s*\{[\s\S]*\/\s*var\(--timeline-progress\)\s*100%\s*no-repeat/);
  assert.match(styles, /#timeline::-moz-range-thumb\s*\{/);
});

test('side rails keep vertical scrolling while clipping horizontal overflow', () => {
  const railBlock = styles.match(/\.workflow-rail,\s*\.control-rail\s*\{(?<body>[\s\S]*?)\n\}/);
  const sidebarBlock = styles.match(/\.sidebar\s*\{(?<body>[\s\S]*?)\n\}/);

  assert.ok(railBlock, 'missing rail overflow block');
  assert.ok(sidebarBlock, 'missing sidebar overflow block');
  assert.match(railBlock.groups.body, /overflow-y:\s*auto/);
  assert.match(railBlock.groups.body, /overflow-x:\s*hidden/);
  assert.match(sidebarBlock.groups.body, /overflow-x:\s*hidden/);
  assert.doesNotMatch(sidebarBlock.groups.body, /overflow:\s*hidden/);
});

test('motion tree cannot grow beyond the left panel when relative paths are long', () => {
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

test('evaluation workbench keeps metrics dense and side-rail safe', () => {
  assert.match(styles, /\.evaluation-panel\s*\{[\s\S]*overflow:\s*hidden/);
  assert.match(styles, /\.metric-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.metric-tile\s*\{[\s\S]*min-width:\s*0/);
  assert.match(styles, /\.metric-tile strong\s*\{[\s\S]*font-variant-numeric:\s*tabular-nums/);
  assert.match(styles, /\.metric-tile \.metric-label\s*\{[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(styles, /\.contact-force-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
});

test('camera presets and recording controls are compact icon commands', () => {
  assert.match(styles, /\.viewer-actions\s*\{[\s\S]*display:\s*grid/);
  assert.match(styles, /\.viewer-command-strip\s*\{[\s\S]*display:\s*grid/);
  assert.match(styles, /\.viewer-command-strip\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(140px,\s*160px\)/);
  assert.match(styles, /\.camera-preset-field\s*\{[\s\S]*display:\s*grid/);
  assert.match(styles, /\.camera-preset-field\s*\{[\s\S]*grid-template-columns:\s*auto minmax\(0,\s*1fr\)/);
  assert.match(styles, /\.camera-preset-field select\s*\{[\s\S]*min-height:\s*34px/);
  assert.match(styles, /\.viewer-control-cluster\s*\{[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.recording-controls\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.recording-file-field\s*\{[\s\S]*display:\s*grid/);
  assert.match(styles, /\.recording-file-field input\s*\{[\s\S]*font-size:\s*11px/);
  assert.match(styles, /\.recording-dot\s*\{[\s\S]*border-radius:\s*999px/);
  assert.match(styles, /\.comparison-results\s*\{[\s\S]*max-height:/);
});

test('data browser, motion workflow, and trim export use denser compact typography', () => {
  assert.match(styles, /\.data-browser-card\s*\.panel-title h2,\s*\.motion-workflow-card\s*\.panel-title h2,\s*\.trim-export-card\s*\.panel-title h2\s*\{[\s\S]*font-size:\s*16px/);
  assert.match(styles, /\.data-browser-card\s*\.panel-title p,\s*\.motion-workflow-card\s*\.panel-title p,\s*\.trim-export-card\s*\.panel-title p\s*\{[\s\S]*font-size:\s*11px/);
  assert.match(styles, /\.data-browser-card input,\s*\.data-browser-card select,\s*\.motion-workflow-card input,\s*\.trim-export-card input,\s*\.trim-export-card select\s*\{[\s\S]*min-height:\s*36px/);
  assert.match(styles, /\.data-browser-card \.command-button,\s*\.motion-workflow-card \.command-button,\s*\.trim-export-card \.command-button\s*\{[\s\S]*min-height:\s*34px/);
  assert.match(styles, /\.trim-export-card\s*\{[\s\S]*scroll-margin-top:\s*18px/);
});

test('stage header and controls scale down motion labels and helper text', () => {
  assert.match(styles, /\.viewer-stage-header\s*\{[\s\S]*gap:\s*18px/);
  assert.match(styles, /\.viewer-stage-header\s*\{[\s\S]*padding:\s*16px 18px 14px/);
  assert.match(styles, /\.viewer-stage-header\s*\{[\s\S]*border-radius:\s*0/);
  assert.match(styles, /\.stage-heading\s*\{[\s\S]*gap:\s*8px/);
  assert.match(styles, /\.stage-motion-name\s*\{[\s\S]*font-size:\s*24px/);
  assert.match(styles, /\.viewer-toolbar\s*\{[\s\S]*padding:\s*0/);
  assert.match(styles, /\.viewer-control-cluster \.command-button\s*\{[\s\S]*font-size:\s*11px/);
  assert.match(styles, /\.viewer-control-cluster \.command-button\s*\{[\s\S]*min-height:\s*36px/);
});

test('evaluation comparison is promoted into the main workbench and advanced panel stays recording-focused', () => {
  assert.match(styles, /\.primary-comparison-section\s*\{[\s\S]*padding:\s*12px 14px/);
  assert.match(styles, /\.primary-comparison-section\s*\{[\s\S]*border:\s*1px solid var\(--line\)/);
  assert.match(styles, /\.comparison-section-header\s*\{[\s\S]*display:\s*flex/);
  assert.match(styles, /\.comparison-section-header p\s*\{[\s\S]*font-size:\s*10px/);
  assert.match(styles, /\.comparison-selects\.inline-comparison-selects\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.inline-comparison-results\s*\{[\s\S]*max-height:\s*132px/);
  assert.match(styles, /\.recording-panel\s*\{[\s\S]*padding:\s*14px 16px 16px/);
  assert.match(styles, /\.recording-panel-title\s*\{[\s\S]*gap:\s*4px/);
  assert.match(styles, /\.policy-control-card \.panel-title p,\s*\.evaluation-control-card \.panel-title p\s*\{[\s\S]*font-size:\s*10px/);
  assert.match(styles, /\.difficulty-strip span\s*\{[\s\S]*font-size:\s*10px/);
  assert.match(styles, /\.difficulty-strip strong\s*\{[\s\S]*font-size:\s*15px/);
  assert.match(styles, /\.difficulty-strip small\s*\{[\s\S]*font-size:\s*10px/);
  assert.match(styles, /\.metric-tile\s*\{[\s\S]*font-size:\s*11px/);
  assert.match(styles, /\.contact-force-row\s*\{[\s\S]*font-size:\s*11px/);
  assert.match(styles, /\.comparison-row\s*\{[\s\S]*font-size:\s*11px/);
  assert.match(styles, /\.metric-tile strong\s*\{[\s\S]*font-size:\s*13px/);
  assert.match(styles, /\.contact-force-row strong\s*\{[\s\S]*font-size:\s*13px/);
  assert.match(styles, /\.comparison-row strong\s*\{[\s\S]*font-size:\s*13px/);
  assert.match(styles, /\.reference-overlay-stack\s*\{[\s\S]*gap:\s*8px/);
  assert.match(styles, /\.reference-overlay-toggle\s*\{[\s\S]*min-height:\s*52px/);
  assert.match(styles, /\.reference-overlay-toggle\s*\{[\s\S]*padding:\s*8px 10px/);
  assert.match(styles, /\.difficulty-strip\s*\{[\s\S]*background:\s*var\(--surface-2\)/);
});

test('workspace styling promotes a stage-first composition with refined side rails', () => {
  assert.match(styles, /\.industrial-layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(250px,\s*0\.78fr\)\s+minmax\(820px,\s*1\.9fr\)\s+minmax\(250px,\s*0\.78fr\)/);
  assert.match(styles, /\.left-rail,\s*\.right-rail,\s*\.stage-column\s*\{[\s\S]*display:\s*grid/);
  assert.match(styles, /\.stage-column\s*\{[\s\S]*gap:\s*0/);
  assert.match(styles, /\.viewer-stage-panel\s*\{[\s\S]*padding:\s*0/);
  assert.match(styles, /\.viewer-stage-panel\s*\{[\s\S]*border-radius:\s*0/);
  assert.match(styles, /\.viewer-stage-header\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
  assert.match(styles, /\.stage-motion-name\s*\{[\s\S]*font-size:/);
  assert.match(styles, /\.viewer-stage-shell\s*\{[\s\S]*border-radius:\s*0/);
  assert.match(styles, /\.viewer-overlay\s*\{[\s\S]*border-radius:\s*0/);
});

test('advanced sections use collapsible premium cards instead of permanent full-weight blocks', () => {
  assert.match(styles, /\.advanced-panel,\s*\.debug-drawer\s*\{[\s\S]*padding:\s*0/);
  assert.match(styles, /\.advanced-summary\s*\{[\s\S]*cursor:\s*pointer/);
  assert.match(styles, /\.advanced-summary,\s*\.debug-summary\s*\{[\s\S]*padding:\s*12px 14px/);
  assert.match(styles, /\.advanced-summary h2,\s*\.debug-summary h2\s*\{[\s\S]*font-size:\s*14px/);
  assert.match(styles, /\.advanced-summary p,\s*\.debug-summary p\s*\{[\s\S]*font-size:\s*10px/);
  assert.match(styles, /\.advanced-summary > span,\s*\.debug-summary > span\s*\{[\s\S]*font-size:\s*9px/);
  assert.match(styles, /\.advanced-summary::-webkit-details-marker\s*\{[\s\S]*display:\s*none/);
  assert.match(styles, /\.advanced-body\s*\{[\s\S]*padding:\s*16px 18px 18px/);
  assert.match(styles, /\.reference-overlay-toggle\s*\{[\s\S]*border-width:\s*1px/);
  assert.match(styles, /\.global-reference-overlay-toggle\s*\{[\s\S]*border-color:\s*color-mix\(in srgb,\s*var\(--accent-2\)\s*36%,\s*var\(--line\)\s*64%\)/);
  assert.match(styles, /\.global-reference-overlay-toggle\s*\{[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--surface-2\)\s*88%,\s*var\(--accent-2\)\s*12%\)/);
  assert.match(styles, /\.relative-reference-overlay-toggle\s*\{[\s\S]*border-color:\s*color-mix\(in srgb,\s*var\(--amber\)\s*40%,\s*var\(--line\)\s*60%\)/);
  assert.match(styles, /\.relative-reference-overlay-toggle\s*\{[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--surface-2\)\s*88%,\s*var\(--amber\)\s*12%\)/);
  assert.match(styles, /\.diagnostics h3\s*\{[\s\S]*font-size:\s*10px/);
  assert.match(styles, /\.diagnostics-panel:not\(\[open\]\) \.debug-grid\s*\{[\s\S]*display:\s*none/);
});
