---
name: GameHarness
description: Fixed desktop operator workspace for authentic gameplay and inspectable execution evidence.
colors:
  page: "#08050b"
  surface: "#0c1214"
  hover: "#202a2c"
  pressed: "#303b29"
  text: "#f2f4f2"
  muted: "#b5c1bf"
  line: "#667577"
  frame: "#b6c5c3"
  accent: "#d5ff70"
  error: "#ff9e93"
  action-ink: "#080a0b"
  disabled-text: "#929c9d"
  disabled-line: "#465354"
  placeholder: "#a1acad"
  viewer-bg: "#030405"
  evidence-bg: "#080d0f"
  evidence-text: "#d9e2df"
  selected-tab: "#192012"
  frame-highlight: "#e0ece7"
  list-divider: "#354143"
typography:
  headline:
    fontFamily: '"Jura", sans-serif'
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  dialog-title:
    fontFamily: '"Jura", sans-serif'
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.4
  title:
    fontFamily: '"Jura", sans-serif'
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.4
  subsection:
    fontFamily: '"Jura", sans-serif'
    fontSize: "1.0625rem"
    fontWeight: 700
    lineHeight: 1.4
  body:
    fontFamily: '"Jura", sans-serif'
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.5
  label:
    fontFamily: '"Jura", sans-serif'
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.5
  context:
    fontFamily: '"Jura", sans-serif'
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.5
  control:
    fontFamily: '"IBM Plex Mono", monospace'
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.5
  input:
    fontFamily: '"IBM Plex Mono", monospace'
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  evidence:
    fontFamily: '"IBM Plex Mono", monospace'
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.7
  metadata:
    fontFamily: '"IBM Plex Mono", monospace'
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  square: "0"
spacing:
  tight: "4px"
  label: "6px"
  compact: "8px"
  control: "10px"
  small: "12px"
  medium: "16px"
  inset: "20px"
  section: "24px"
  wide: "32px"
components:
  button-primary:
    backgroundColor: "{colors.text}"
    textColor: "{colors.action-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.square}"
    padding: "8px 12px"
  button-primary-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.action-ink}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.square}"
    padding: "8px 12px"
  button-secondary-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.text}"
  button-secondary-active:
    backgroundColor: "{colors.pressed}"
  button-disabled:
    backgroundColor: "transparent"
    textColor: "{colors.disabled-text}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.error}"
    typography: "{typography.control}"
    rounded: "{rounded.square}"
    padding: "8px 12px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.control}"
    rounded: "{rounded.square}"
    padding: "8px 4px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.input}"
    rounded: "{rounded.square}"
    padding: "10px 12px"
    width: "100%"
  evidence-tabs:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.square}"
  evidence-tab-selected:
    backgroundColor: "{colors.selected-tab}"
    textColor: "{colors.accent}"
  console-frame:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.square}"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.square}"
    width: "min(1000px, calc(100vw - 64px))"
  evidence-row:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.square}"
    padding: "14px 12px"
    width: "100%"
  strategy-card:
    textColor: "{colors.text}"
    rounded: "{rounded.square}"
    padding: "16px 0"
  evidence-block:
    backgroundColor: "{colors.evidence-bg}"
    textColor: "{colors.evidence-text}"
    typography: "{typography.evidence}"
    padding: "12px"
---

# Design System: GameHarness

## Overview

**Creative North Star: "The Operator Console"**

GameHarness uses a dark working surface: sharp outlined controls, quiet near-black panels, pale text, and restrained lime emphasis. The approved desktop layout preserves the incumbent reference palette, Jura and IBM Plex Mono pairing, and flat operational frames. Authentic gameplay leads; compact controls and current context support observation.

The standalone Electron window keeps the game and run controls in one fixed viewport. Setup and detailed evidence open on demand in bounded dialogs. Provider connection, game session, player life, video, inference, execution, and objective success have separate factual labels. Minecraft is the first implemented game view; the GameHarness identity remains independent of any game or provider.

**Key Characteristics:**
- Authentic opaque gameplay with compact operational chrome.
- Jura headings and explanations; IBM Plex Mono controls and evidence.
- Square frames and flat surfaces with visible keyboard focus.
- A fixed desktop workspace with bounded disclosure and explicit uncertainty.

## Colors

Violet-black surroundings and cool near-black chrome keep the game distinct; lime marks interaction and state, while salmon identifies errors and destructive controls. Frontmatter values are normative.

### Primary

- **Signal lime** (`accent`): focus outlines, links, selected evidence tabs, run-state text, input carets, and primary-button hover. It signals attention without asserting task success.

### Secondary

- **Warning salmon** (`error`): error wording, destructive-action text, notice borders, and retained-frame warnings. Pair it with explicit labels.

### Neutral

- **Violet-black field** (`page`) and **console black** (`surface`): the workspace ground and opaque working chrome.
- **Pale text** (`text`) and **quiet text** (`muted`): principal content and supporting explanations. Primary actions reverse pale fill into dark `action-ink` lettering.
- **Divider gray** (`line`), **frame gray** (`frame`), **frame highlight** (`frame-highlight`), and **list divider** (`list-divider`): control outlines, game/dialog boundaries, the game's pale top edge, and quieter internal separators.
- **Hover surface** (`hover`), **pressed surface** (`pressed`), and **selected tab** (`selected-tab`): interaction states, distinct from factual game outcomes.
- **Disabled text / line** (`disabled-text`, `disabled-line`) and **placeholder** (`placeholder`): unavailable controls and input hints, kept at full opacity.
- **Viewer black** (`viewer-bg`): authentic-frame surround and aspect-ratio bars. **Evidence black / text** (`evidence-bg`, `evidence-text`): source and diagnostic blocks.

**The State Before Color Rule.** Every readiness, error, and run state has readable text; color supports the label rather than replacing it.

## Typography

**Display and Body Font:** Jura, with sans-serif fallback. The product uses compact headings rather than a separate oversized display style.

**Control and Evidence Font:** IBM Plex Mono, with monospace fallback. Bundled Latin and Cyrillic fonts supply Jura (500, 700) and IBM Plex Mono (400, 500).

Jura gives explanations their angular character while Plex keeps commands, source, identifiers, and quantities legible. The reference establishes the palette and form language; the user-selected readable fonts replace its pixel lettering.

### Hierarchy

| Role | Application |
| --- | --- |
| Headline | The single-line product heading and the empty-video heading; the latter uses line height (1.4). |
| Dialog title | Named headings for Settings, History, evidence, source, promotion, and diagnostics. |
| Title / subsection | Supporting headings in dialog bodies. Game and context headings use the body size at weight (700). |
| Body / label | Explanatory prose and form labels. Dialog copy is limited to (72ch); empty-video guidance to (48ch). |
| Context | Current goal, exact program identity and status, latest activity, connection text, and run guidance. |
| Control | Action labels; video-state labels use the same size at weight (400). Run-state text uses Plex at (0.875rem). |
| Input | Typed values and selected options. |
| Evidence | Source and JSON blocks. Record metadata uses line height (1.6); measurements use tabular numerals. |
| Metadata | The compact video footer. The workspace footer uses Jura at the same size. Keep this tier for supporting metadata, not task or program content. |

**The Readable Controls Rule.** Keep Jura for explanation and IBM Plex Mono for operation and evidence; preserve the user-selected readable lettering.

## Layout

The shipped surface is a standalone Electron desktop window, initially (1440×900) with a minimum window size (1000×650). These are the required desktop compositions. The renderer fills (100dvh); the document and application root do not scroll. There is no shipped mobile composition.

A compact header, flexible main work area, bottom run toolbar, and small readiness footer form one vertical workspace. Default outer padding is (12px 16px 8px), with a (12px) gap. The main grid reserves `calc(25% - 12px)` for the right context panel and the remaining width for the game, separated by (12px). Gameplay therefore receives at least 75% of the main work-area width while the panel is visible. Hiding the panel leaves one full-width game column.

The game frame fills the available height between the header and bottom controls. Its small title and video-footer rows stay outside the image. The WebGL canvas contains the authentic native frame, preserves its aspect ratio, and may leave dark bars. Resizing the working area changes presentation without restarting the game.

The context panel separates a scrollable current-context area from five nonshrinking usage counters. Session/player life, goal, exact executing-program identity and version/status, and latest activity wrap within the panel. Supplied goal prompts remain complete; genuinely long custom tasks use a labeled full-task disclosure, and long activity summaries identify their full-record action. Source, model/action details, inventory, usage, history, revisions, and diagnostics belong in dialogs rather than a permanent evidence bay.

Dialogs are capped to the viewport with an outer margin (32px), a fixed header, and an internally scrolling body. Headers use padding (16px 24px); bodies use (20px 24px 24px). Settings uses two equal columns with gaps (24px 32px); task configuration spans both. Source blocks cap at (420px) and scroll without reflowing source lines; wide diagnostic tables scroll inside their own container.

| Desktop condition | Behavior |
| --- | --- |
| Width at most (1100px) | Side padding becomes (12px), workspace gap (8px), header gap (12px), and navigation gap (6px). The explanatory footer suffix hides; Inventory stays available. |
| Height at most (760px) | Context sections tighten their spacing and usage rows lose extra vertical gap. Goal and program content remain readable; the context area can scroll while usage and bottom controls stay separate. |
| Panel hidden | Gameplay expands horizontally; the header toggle restores the same context panel. |

The stylesheet also contains a below-minimum-width fallback at (760px). It is outside the supported Electron window range and does not establish mobile acceptance or a second layout contract.

**The Fixed Workspace Rule.** Keep the game and bottom run controls inside the desktop viewport; let context and dialog bodies absorb overflow instead of the page.

## Elevation & Depth

Opaque tones and thin frames establish hierarchy without raised shadows or blur. The game has a pale top edge; dialogs have a pale frame and a violet-black backdrop at (85% opacity). That backdrop identifies a modal interruption, not a glass material. The selected evidence tab uses an inset accent line (2px) solely as a state marker. Ordinary button transitions affect color, background, and border over (140ms ease-out); reduced-motion preferences remove authored transitions and animation.

**The Opaque View Rule.** Keep gameplay opaque and visually separate from chrome; open setup and evidence in explicit dialogs rather than blending them into the image.

## Shapes

Controls, dialogs, and game frames have square corners with thin strokes (1px). Separators divide working sections without surrounding every value with another card. Native checkboxes retain their functional geometry at (20px); the system has no ornamental pill or badge vocabulary. Focus is a lime outline (2px) with offset (3px), moved inward to (-3px) for evidence tabs and record rows.

## Components

### Buttons

Compact outlined rectangles name their actions. Standard controls use minimum height (44px) and the frontmatter padding. Start, Resume, Create run, and authorization use pale fill; ordinary actions remain transparent; destructive actions use salmon text; quiet text actions use muted text and a transparent border.

Hover changes the ordinary background and border; primary hover changes to lime with dark text. Pressed ordinary controls use the pressed surface. Disabled controls retain full opacity, disabled colors, and a not-allowed cursor. Busy actions append an ellipsis. Video reconnect is a compact local variant with minimum height (36px); workspace-footer actions use (28px). These exceptions do not shrink the main run controls.

### Inputs / Fields

Fields use opaque console-black fill, divider borders, square corners, and Plex values. Labels remain Jura. Focus uses the shared outline; the caret is lime. Disabled fields retain readable disabled colors. Textareas resize vertically within (100–260px). Native selects and checkboxes retain their expected behavior; disclosure summaries expose additional world-management controls within Settings.

### Navigation

Header actions open History and Settings, reconnect the service, and hide or show the context panel. They remain a compact horizontal group at supported desktop sizes. Evidence lives in a dialog with eleven tabs: Programs, Executions, Revisions, Trace, Comparison, Learning, Life, Planning, Usage, Activity, and Inventory. Selected tabs use lime text, a green-black fill, and the inset accent line. Arrow keys cycle through tabs; Home and End select the first and last. The nonshrinking tab strip scrolls horizontally within the dialog, independently of its scrolling body.

### Game Frame

One opaque framed view contains real native game imagery, including the game's own hand and HUD. Those pixels are content, not reusable UI artwork or a synthetic state layer. The read-only WebGL canvas accepts no manual gameplay input. Before a frame arrives, an honest empty state offers Settings. Stale, disconnected, or idle retained frames dim to (60% opacity) and carry an explicit warning that they are not current gameplay. The compact streaming footer shows resolution and measured drawn FPS; capture-to-draw delay, frame age, and clock qualifications stay in diagnostics.

Ordinary player death leaves a healthy native session and live video connected. The vanilla death screen comes only from the real framebuffer; it is not a transport error or an HTML overlay. Respawn requires an explicit model choice, with no human Respawn control. Loading and respawning labels distinguish waiting for native readiness from connection faults.

### Current Context and Usage

The sidebar presents session/player life, the current goal, exact executing program, and latest real activity as readable text and clearly named inspection actions. Life opens authoritative session/life state and bounded retained death context; missing episodes remain missing, and last authorized context is not an inferred cause of death. Program identity uses its short name or exact skill identifier, with version and status separately visible. The lower usage section always keeps Uncached input, Cache read, Cache write, Output, and Calls together. Unknown remains distinct from zero. Detailed usage retains cost and request-purpose evidence in its dialog.

Run guidance keeps agent control separate from the session: Pause, Stop run, and goal completion leave a healthy client/video connected, and paused control does not freeze world ticks. A new task can reuse that session; Stop world ends it.

### Dialogs and Working Containers

Native modal dialogs carry named headings, Close actions, Escape behavior, focus containment, and restoration to the opening control. Settings and task entry, retained history, evidence categories, source/StrategyCards, evidence-backed promotion, and diagnostics share the same bounded frame. StrategyCards are definition lists with a label column (130px), not decorative cards. Errors use explicit wording and bounded notice regions. Opening evidence does not resume a retained run.

### Records and Source

History, program, and execution records are full-width text buttons with Jura titles, Plex metadata, thin bottom dividers, and inward focus outlines. They open the corresponding evidence rather than maintaining the former selected-row live-follow interface. Immutable source is inert text in preformatted dark blocks; it never becomes executable page content. Diagnostics distinguish measured backend timing from browser video measurements and request samples only while open.

Trace, Comparison, Learning, and Planning reuse labeled controls, flat separators, and native disclosures inside the bounded evidence body:

- Trace pages show actual instrumented conditions, API requests/results, authorized observations, and attributed timing, with execution selection, a loaded-page filter, paging, and explicit omissions. Within an expanded branch record, structured conditions and recorded decisions lead, with exact-source access and session/life, version, and hash attribution; the complete Raw record is nested and initially collapsed. Missing source-point metadata is labeled rather than reconstructing a condition.
- Comparison pairs exact immutable versions and StrategyCards with sample counts, controlled-condition qualifications, source changes, and explicit omissions. Descriptive differences do not establish causal improvement; missing measurements remain unknown.
- Learning pages retain opportunities, model-authored decisions/reasons, linked traces, objective samples, and budget omissions. Measured candidates are not automatically better; unmeasured candidates have no demonstrated improvement.
- Planning distinguishes bounded model-selected lookahead from executing work. Intent, budgets, measured overlap, and session/life basis precede a disclosure of exact source, validation, and admission state. The view cannot activate a staged plan; overlap does not prove causal speedup.

### Accessibility and System States

A skip link reaches bottom run controls. Links retain underlines and a visible focus outline; text selection uses lime fill with dark lettering. Scrollbars remain visible on bounded scrolling surfaces. Reduced-motion and forced-colors preferences are respected. Idle, starting, stale, disconnected, failed, paused, stopped, and unknown states use factual text; program completion remains separate from objective success.

## Do's and Don'ts

### Do:

- **Do** keep authentic gameplay dominant and opaque, with bottom run controls visible at both required desktop sizes.
- **Do** pair status color with factual labels for connection, session/player life, video, inference, execution, and run state.
- **Do** preserve Jura explanations and IBM Plex Mono controls, values, and evidence.
- **Do** preserve complete supplied goals, exact program identity/status, and all five usage counters; use bounded disclosure for longer context.
- **Do** keep setup and detailed evidence in named, keyboard-accessible dialogs with internal scrolling.
- **Do** lead branch details with structured conditions and exact-source access, retain session/life and version/hash attribution, and nest the complete Raw record initially collapsed.
- **Do** show sample counts, source/condition qualifications, and explicit omissions; keep comparisons descriptive and model-authored intent distinct from measured outcomes.
- **Do** show unknown, empty, pending, failed, paused, and stopped states explicitly.

### Don't:

- **Don't** replace unavailable gameplay or missing records with simulated footage or successful-looking sample data.
- **Don't** turn the native game's HUD, hand, scenery, or aspect bars into interface artwork.
- **Don't** treat ordinary death as a transport fault, replace its real framebuffer with an HTML death screen, or add a human Respawn control.
- **Don't** restore global scrolling, inline setup expansion, a permanent evidence bay, or a mobile layout requirement.
- **Don't** shrink task or program text into the metadata tier to make the desktop fit.
- **Don't** reintroduce pixel lettering, decorative monospace headings, blur, raised dashboard cards, or ornamental pills.
- **Don't** copy the reference's branding, artwork, or application logic, or imply official game/provider affiliation.
- **Don't** present a rendered frame, completed program, or infrastructure check as proof of objective success or Playable MVP acceptance.
- **Don't** present trace diagnostics as hidden reasoning, infer a death cause from last context, or claim causal improvement or speedup from candidates, descriptive comparisons, or planning overlap.
