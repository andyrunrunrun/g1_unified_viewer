# SONIC-Style Unified Control Panel Design

## Summary

This design updates the current web control panel into a SONIC-inspired unified console while preserving the existing `G1 Unified Viewer` architecture:

- `SessionController` remains the single source of truth
- the MuJoCo native viewer remains the primary high-frequency runtime and the only place for real drag-based perturbation
- the web panel becomes a cleaner, integrated control surface for data browsing, playback, trim/export, policy control, diagnostics, and testing

The SONIC reference informs visual direction and interaction organization only. It does **not** justify removing current capabilities.

## Goals

1. Replace the current diagnostics-heavy web UI with a cleaner, more integrated control console.
2. Preserve all current product capabilities:
   - path scanning
   - browser tree navigation
   - multi-format motion loading
   - playback and seeking
   - trim and export
   - policy selection, activation, stop, and step
   - diagnostics visibility
3. Add a dedicated testing area for physics/runtime experiments.
4. Add real mouse drag perturbation in the native MuJoCo viewer.
5. Surface viewer interaction and test status back into the web panel through `SessionSummary`.

## Non-Goals

1. This change does not convert the product into a pure web viewer.
2. This change does not replace the native MuJoCo viewer with Three.js or another browser renderer.
3. This change does not redesign importer/exporter formats or policy protocols.
4. This change does not split the web panel into a frontend build system in this iteration.

## Existing Constraints

The current codebase already has the right architectural base for this change:

- [`g1_viewer/session.py`](/home/huanghao/source/code/g1_unified_viewer/g1_viewer/session.py) owns session state and should remain the single source of truth.
- [`g1_viewer/api.py`](/home/huanghao/source/code/g1_unified_viewer/g1_viewer/api.py) already exposes grouped session and policy endpoints consumed by the web panel.
- [`g1_viewer/static/index.html`](/home/huanghao/source/code/g1_unified_viewer/g1_viewer/static/index.html) is currently a single-file control panel and can be restyled and reorganized in place.
- [`g1_viewer/viewer_runtime.py`](/home/huanghao/source/code/g1_unified_viewer/g1_viewer/viewer_runtime.py) owns the passive MuJoCo viewer loop and is the correct place to bridge real viewer interaction into session state.

## Preserved Capabilities

The following features are mandatory and must survive the redesign unchanged in capability:

- file tree browsing via `/api/browser/list`
- loading motions through `/api/session/load`
- support for current motion formats and existing format detection behavior
- playback controls via `/api/session/playback`
- trim controls and export via `/api/session/trim` and `/api/trim_export`
- policy listing and activation via `/api/policies`, `/api/policies/active`, and `/api/policies/step`
- diagnostics visibility for:
  - viewer connection
  - camera state
  - observation summary
  - action summary
  - logs
  - last error

No implementation step may remove these features in order to imitate the SONIC demo layout.

## UX Direction

The new web panel should feel closer to a simulation console than a traditional dashboard.

### Visual Style

- deep, low-saturation dark base
- glass-like floating panels with restrained blur
- a single accent color for active state and controls
- compact, high-signal labels
- fewer large headings and less explanatory prose in the default view

### Interaction Principles

- high-frequency controls remain always visible
- diagnostic detail moves into secondary sections instead of dominating the page
- the page should present one coherent runtime, not a collection of unrelated cards
- test affordances should feel first-class, not hidden dev-only controls

## Information Architecture

The web panel keeps all current capabilities, but reorganizes them into clearer sections.

### Left Panel: Data

Responsibilities:

- root path input
- scan action
- browser tree
- active motion highlighting

Behavior:

- this remains the primary entry point for discovering and loading clips
- directory expansion stays lazy
- active motion stays visually pinned/highlighted

### Left Panel: Motion

Responsibilities:

- current clip summary
- timeline
- frame input
- playback controls
- loop state

Behavior:

- the timeline remains command-driven and backfilled from session state
- play, pause, stop, seek, and loop stay mapped to the current grouped endpoints

### Left Panel: Trim & Export

Responsibilities:

- trim start/end fields
- mark current frame as trim start/end
- export trimmed sequence

Behavior:

- these controls stay visible but should be visually subordinate to data and motion controls

### Left Panel: Policy

Responsibilities:

- policy list
- policy selection
- start/stop policy
- single-step test

Behavior:

- policy selection remains explicit
- the active policy remains visible in both the panel and the global status area

### Left Panel: Test

Responsibilities:

- physics toggle
- reset test state
- preset perturbation controls
- drag state summary
- last test event summary

Behavior:

- these controls are new
- they do not replace policy or playback controls

### Right Status Area

Responsibilities:

- current motion
- current frame
- playback state
- physics state
- active policy
- viewer connection
- active drag state

Behavior:

- this should be short and glanceable
- it is not a dump of raw JSON

### Secondary Diagnostics

Responsibilities:

- logs
- observation summary
- action summary
- camera summary
- last error details

Behavior:

- diagnostics remain available
- diagnostics should move into a lower visual priority area such as collapsible panels or a bottom section

## Runtime Interaction Model

### Source of Truth

`SessionController` remains the only canonical place for:

- motion/session state
- playback state
- trim state
- active policy state
- physics state
- viewer status
- test status
- drag interaction summary

The native viewer may detect interaction, but it must write interaction summaries back into `SessionController`.

The web panel may trigger test commands, but it must not invent its own local truth for runtime state.

### Native Viewer Drag Perturbation

Real drag-based perturbation must live in the native MuJoCo viewer.

Implementation direction:

- use the passive MuJoCo viewer’s built-in perturbation support instead of building a custom picking/rendering stack
- read viewer perturbation state during the runtime loop after synchronization
- translate the current perturbation/selection state into a compact session-facing summary
- expose that summary through `SessionSummary`

Reasoning:

- this is lower risk than rewriting picking logic from scratch
- it works with the existing MuJoCo runtime rather than competing with it
- it keeps the web panel as an observer/controller, which matches the current architecture

### Web Test Commands

The web panel will not perform direct drag interaction on the robot. Instead it will:

- display current drag state from the native viewer
- trigger preset runtime perturbation commands through the backend

This avoids pretending the browser is the primary simulation surface when it is not.

## Data Model Changes

`SessionSummary` needs new structured fields for test and viewer interaction state.

### Viewer Interaction Summary

Add a new summary object with fields equivalent to:

- `drag_active: bool`
- `selected_body_id: int | null`
- `selected_body_name: str | null`
- `perturb_mode: str`
- `force_magnitude: float | null`
- `last_drag_timestamp: float | null`

Purpose:

- let the web panel show whether the user is actively dragging in the native viewer
- report which body is under perturbation
- provide a simple “what is happening now” summary

### Test State Summary

Add a new summary object with fields equivalent to:

- `last_test_event: str | null`
- `last_test_status: str | null`
- `last_impulse_command: dict`
- `pending_impulse: bool`

Purpose:

- let the web panel show test lifecycle state
- let the backend track whether a web-issued perturbation command still needs to be consumed

The exact model names may vary, but they should be explicit and typed rather than folded into `last_policy_result` or `last_action_summary`.

## API Changes

### Keep Existing Endpoints

These must remain intact:

- `GET /api/session`
- `POST /api/browser/list`
- `POST /api/session/load`
- `POST /api/session/playback`
- `POST /api/session/trim`
- `POST /api/session/physics`
- `GET /api/policies`
- `POST /api/policies/active`
- `POST /api/policies/step`
- `POST /api/trim_export`

### Add Minimal Test Endpoints

Add only the minimum new endpoints required for testing:

- `POST /api/viewer/test/impulse`
- `POST /api/viewer/test/reset`

#### `POST /api/viewer/test/impulse`

Purpose:

- queue a simple perturbation request for the native viewer/runtime to consume

Payload should include:

- direction or preset name
- magnitude
- duration
- optional target body hint

Behavior:

- reject if no active sequence
- reject if viewer is not connected
- reject if physics is off
- record the pending command in session state

#### `POST /api/viewer/test/reset`

Purpose:

- clear pending test commands and recent test summaries

Behavior:

- also clears stale drag/test status when needed

## Native Viewer Changes

[`g1_viewer/viewer_runtime.py`](/home/huanghao/source/code/g1_unified_viewer/g1_viewer/viewer_runtime.py) will expand from keyboard-only control into keyboard plus viewer-interaction reporting.

### Required Additions

1. Read MuJoCo viewer perturbation state each frame.
2. Detect whether a drag/perturbation is active.
3. Resolve the selected body id and, if practical, body name from the model.
4. Push a compact interaction summary into `SessionController`.
5. Consume any pending impulse command from the controller and apply the perturbation to the runtime.
6. Expand the on-screen overlay to include test/drag hints without crowding existing controls.

### Reset Rules

Viewer interaction state should be cleared when:

- the viewer disconnects
- a new clip is loaded
- the session is stopped/reset
- physics is turned off
- the user explicitly calls test reset

## Session Controller Changes

[`g1_viewer/session.py`](/home/huanghao/source/code/g1_unified_viewer/g1_viewer/session.py) will need:

- new state holders for test commands and viewer interaction summary
- write methods for viewer interaction updates
- lifecycle-aware reset/clear behavior
- summary serialization for the new fields

Key rule:

- test state must be reset deliberately when session lifecycle changes would otherwise leave stale status visible

Examples:

- loading a new clip must clear drag/test artifacts from the previous clip
- stopping policy/physics must not leave `drag_active=true`

## Web Panel Changes

[`g1_viewer/static/index.html`](/home/huanghao/source/code/g1_unified_viewer/g1_viewer/static/index.html) will be restyled and reorganized in place.

### Scope

- keep a single static HTML file for this iteration
- rewrite layout and styles to match the new console structure
- preserve current command wiring
- add test controls and test state rendering
- demote raw diagnostics into secondary regions

### New Web Behaviors

- render a compact status area from `SessionSummary`
- render a `Test` section with preset perturbation actions
- render live drag status from session data
- disable test actions when prerequisites are not met

### Explicit UI Rules

- do not hide file browsing or format-related loading controls
- do not remove policy selection in favor of a single hard-coded policy
- do not remove trim/export controls
- do not replace diagnostics with marketing text or decorative fillers

## Error Handling

The redesign should make failure modes more explicit.

### Web Panel

- show command errors in a consistent status area
- disable test controls when the current session cannot support them
- distinguish between `viewer disconnected`, `physics off`, and `no active motion`

### Backend

- validate test requests before queuing them
- clear stale pending commands when lifecycle changes invalidate them
- avoid silently auto-enabling physics for test commands in this iteration

### Native Viewer

- failure to resolve viewer interaction metadata should degrade to “unknown interaction” rather than breaking the runtime loop

## Testing Strategy

### Automated Tests

Extend API and controller tests for:

- new `SessionSummary` fields
- test endpoint validation
- pending impulse lifecycle
- reset behavior when loading/stopping/toggling physics
- root page smoke test updated for the new panel structure

Existing tests for session, policy, browser, and root page behavior should continue to pass with updated expectations where layout text changes.

### Manual Smoke Tests

Manual verification is required for:

- native viewer drag perturbation
- live drag status reflected in the web panel
- impulse buttons affecting the runtime only when viewer and physics are active
- stale state clearing across:
  - clip load
  - stop
  - physics off
  - viewer disconnect

## Rollout Order

Recommended implementation order:

1. Extend models and session state for test/drag summaries.
2. Add backend test endpoints and lifecycle handling.
3. Add viewer interaction reporting and pending impulse consumption in the native viewer.
4. Rebuild the static web panel layout and styling.
5. Reconnect diagnostics and test rendering.
6. Update and run automated tests.
7. Perform manual smoke testing for viewer drag behavior.

## Risks

1. The biggest functional risk is stale interaction state surviving across session resets.
2. The biggest UX risk is overcompressing existing features while pursuing a cleaner SONIC-like appearance.
3. The biggest implementation risk is assuming native viewer perturbation metadata is richer than it really is; the design should tolerate only partial metadata if necessary.

## Acceptance Criteria

The redesign is complete when all of the following are true:

1. The web panel looks and behaves like a unified control console rather than a diagnostics-first dashboard.
2. All existing functional controls remain available:
   - browsing
   - loading
   - playback
   - trim/export
   - policy selection/control
   - diagnostics
3. The web panel contains a first-class `Test` section.
4. The native viewer supports real mouse drag perturbation.
5. The web panel reflects live drag/test state from session data.
6. Test commands are validated against session prerequisites.
7. Automated tests cover the new backend/session behavior.
