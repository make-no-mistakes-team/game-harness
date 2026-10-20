---
name: GameHarness
description: Dark operator workspace for real Minecraft runs and execution evidence.
colors:
  page: "#08050b"
  surface: "#0c1214"
  hover: "#202a2c"
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
  evidence-bg: "#080d0f"
  evidence-text: "#d9e2df"
  selected-tab: "#192012"
  selected-evidence: "#1a251b"
  frame-highlight: "#e0ece7"
  list-divider: "#354143"
typography:
  headline:
    fontFamily: '"Jura", sans-serif'
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  title:
    fontFamily: '"Jura", sans-serif'
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.35
  subsection:
    fontFamily: '"Jura", sans-serif'
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.4
  body:
    fontFamily: '"Jura", sans-serif'
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.5
  label:
    fontFamily: '"Jura", sans-serif'
    fontSize: "0.875rem"
    fontWeight: 700
    lineHeight: 1.5
  control:
    fontFamily: '"IBM Plex Mono", monospace'
    fontSize: "0.9375rem"
    fontWeight: 500
    lineHeight: 1.5
  input:
    fontFamily: '"IBM Plex Mono", monospace'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  evidence:
    fontFamily: '"IBM Plex Mono", monospace'
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.7
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
  large-screen: "48px"
components:
  button-primary:
    backgroundColor: "{colors.text}"
    textColor: "{colors.action-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.square}"
    padding: "10px 14px"
  button-primary-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.action-ink}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.square}"
    padding: "10px 14px"
  button-secondary-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.text}"
  button-disabled:
    backgroundColor: "transparent"
    textColor: "{colors.disabled-text}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.error}"
    typography: "{typography.control}"
    rounded: "{rounded.square}"
    padding: "10px 14px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.control}"
    rounded: "{rounded.square}"
    padding: "10px 4px"
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
  evidence-row:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.square}"
    padding: "14px 16px"
    width: "100%"
  evidence-row-selected:
    backgroundColor: "{colors.selected-evidence}"
  evidence-block:
    backgroundColor: "{colors.evidence-bg}"
    textColor: "{colors.evidence-text}"
    typography: "{typography.evidence}"
    padding: "12px"
---

# Design System: GameHarness

## Overview

**Creative North Star: "The Operator Console"**

GameHarness uses a dark working surface: sharp outlined controls, quiet near-black panels, pale text, and restrained lime emphasis. The live game occupies the main area. Setup, run controls, and inspectable evidence surround it without obscuring the view.

This records the shipped Integration Spike interface. Connection, rendering, inference, action effects, and task completion remain separate states. A real terrain view or a recorded policy effect does not establish a complete Playable MVP or a completed game goal. The interface keeps waiting, unavailable, failed, and stopped states readable.

**Key Characteristics:**
- Opaque gameplay with compact operational chrome.
- Jura headings and explanations; IBM Plex Mono controls and evidence.
- Square frames and flat surfaces with visible keyboard focus.
- Real state and inspectable records instead of simulated activity.

## Colors

Violet-black surroundings and cool near-black chrome keep the game distinct; lime marks interaction and state, while salmon identifies errors and destructive controls. Frontmatter values are normative.

### Primary

- **Signal lime** (`accent`): focus outlines, links, ready indicators, selected tabs, state text, and primary-button hover. It signals attention, not proof of success.

### Secondary

- **Warning salmon** (`error`): errors, destructive-action text, and the error-notice border. Pair it with explicit wording.

### Neutral

- **Violet-black field** (`page`) and **console black** (`surface`): outer workspace and opaque working surfaces.
- **Pale text** (`text`) and **quiet text** (`muted`): main content and supporting explanations. Primary buttons reverse pale text into a fill with dark `action-ink` lettering.
- **Divider gray** (`line`), **frame gray** (`frame`), and **frame highlight** (`frame-highlight`): ordinary controls and separators, major working boundaries, and the top edge of the game and evidence frames.
- **Hover surface** (`hover`), **selected tab** (`selected-tab`), and **selected evidence** (`selected-evidence`): distinct interaction states on the dark surface.
- **Disabled text / line** (`disabled-text`, `disabled-line`) and **placeholder** (`placeholder`): unavailable controls and input hints, with full opacity.
- **Evidence black / text** (`evidence-bg`, `evidence-text`) and **list divider** (`list-divider`): readable source blocks and dense record lists.

**The State Before Color Rule.** Every readiness, error, and run state has readable text; color supports the label rather than replacing it.

## Typography

**Display and Body Font:** Jura, with sans-serif fallback. The interface has compact headings rather than a separate large display style.

**Control and Evidence Font:** IBM Plex Mono, with monospace fallback. Both families are bundled through font imports; the shipped weights are Jura (500, 700) and IBM Plex Mono (400, 500).

Jura gives headings and explanations their angular character. IBM Plex Mono keeps commands, timestamps, identifiers, quantities, source, and form values legible. Pixel and Monocraft-style lettering are explicitly rejected for English readability.

### Hierarchy

| Role | Application |
| --- | --- |
| Headline | Product heading; reduces to (1.25rem) at the narrow breakpoint. |
| Title | Main section headings; game heading uses (1.25rem), run-toolbar heading (1.125rem). |
| Subsection | Evidence and supporting headings; empty-view heading uses the headline size. |
| Body | Explanations at the base size; setup and empty-state supporting copy also use (0.9375rem). Setup prose is limited to (70ch); viewer guidance to (48ch). |
| Label | Form labels; lower-priority metadata uses (0.75rem) or (0.8125rem). |
| Control | Buttons; summaries retain the same size with line height (1.6). Tabs use (1rem), state text (0.875rem). |
| Input | Text fields and selects; task textarea uses line height (1.6). |
| Evidence | Source and JSON blocks; event summaries use (0.875rem) and line height (1.65). Player measurements use tabular numerals. |

**The Readable Controls Rule.** Keep Jura for explanation and IBM Plex Mono for operation and evidence; preserve the user-selected readable lettering.

## Layout

The workspace is centered with a maximum width (1728px) and minimum page width (280px). Default outer padding is (24px 32px 16px). The main working grid gives remaining width to gameplay and (352px) to evidence, separated by (24px). The header and readiness strip stay compact; setup expands inline, not over the game.

Small groups use the compact and small spacing steps. Sections separate with the section step. Borders divide task entry, current-run details, inventory, and evidence rather than enclosing each item in another card.

| Width condition | Shipped behavior |
| --- | --- |
| At least (1600px) | Side padding becomes (48px). Viewer height is `min(46vw, 720px)`, capped at (68svh). |
| At most (1150px) | Outer padding becomes (20px); evidence bay narrows to (336px), column gap to (16px). Viewer changes from (16:9) to (4:3); task fields stack. |
| At most (900px) | Gameplay and evidence stack; evidence stops being sticky. Viewer returns to (16:9), task fields become two columns, and record lists cap at (360px). |
| At most (600px) | Outer padding becomes (16px 12px); header, setup, task fields, and authorization input row stack. Run actions span the available width; toolbar actions occupy three equal columns. |

The run toolbar stays above gameplay with a sticky top offset (16px), reduced to (8px) on narrow screens. The desktop evidence bay uses the same default offset. The viewer keeps a minimum height (280px). Record lists scroll within `min(46svh, 460px)` on larger screens; evidence blocks cap at (360px). Long values wrap, and code blocks remain scrollable.

## Elevation & Depth

Depth comes from opaque surface tones and thin frames. The game uses a stronger outline than surrounding controls; the pale top edge distinguishes the main working frames. There are no raised card shadows, translucent panels, or decorative blur in the shipped stylesheet. The selected tab's inset line is a state marker, not elevation.

**The Opaque View Rule.** Keep the actual game view opaque and unobscured; place setup and evidence beside or below it.

## Shapes

Controls and working frames have square corners. Ordinary strokes are (1px); the game frame is (2px). Small ready indicators are square (6px), while checkboxes retain native control geometry at (20px). Keep these functional shapes instead of adding ornamental pills or rounded dashboard cards.

## Components

### Buttons

Compact, rectangular controls name the action they perform. Standard buttons have minimum height (44px), a single divider-colored border, and the control typography. Primary Start/Resume and authorization actions use the pale fill; ordinary actions are outlined; destructive actions use warning text. Text actions remove the border and use a narrow inline inset.

Hover changes the background and border; primary hover uses signal lime. Ordinary pressed buttons use a muted green surface (`#303b29`); primary buttons retain their filled variant. Text-action hover adds an underline with offset (4px). Disabled controls use the disabled tokens, a not-allowed cursor, and full opacity. Busy buttons append an ellipsis. State transitions affect color, background, and border over (140ms ease-out).

### Inputs / Fields

Fields fill their available width, use console-black backgrounds, divider-colored borders, and square corners. Text values use IBM Plex Mono. Textareas resize vertically and start at minimum height (112px). Placeholders use their own token; the caret uses signal lime. Select options retain the dark surface. Checkboxes use the accent while keeping native behavior.

### Navigation

The evidence bay uses two equal-width tabs. Selected tabs combine signal text, a dark green fill, and an inset bottom line. Each tab is at least (52px) tall. Arrow keys move between tabs; Home and End choose the first and last tab. Setup is a button-controlled inline disclosure, and secondary material uses native details/summary controls rather than a separate navigation system.

### Cards / Containers

The game console and evidence bay are working frames, not generic content cards. Both use opaque console-black fill and pale borders. The game has a stronger outline; the bay stays thin. Header rows use compact padding (8px 16px); evidence sections use the medium inset. Setup has two columns on larger screens and a darker violet fill (`#100d15`), with padding (20px 24px).

### Activity and Policy Evidence

Records are full-width text buttons with separate metadata and summary lines. A thin divider separates rows; a green-tinted fill identifies the selected record. Selecting an event or policy pauses live follow without pausing the game or run. Resume live restores follow. Evidence expands within the bay, and immutable policy source remains readable in a preformatted block. Empty lists explain what has not yet been recorded.

### Focus and Browser Surfaces

Keyboard focus uses an accent outline (2px) with offset (3px); list-item focus moves inside the row with offset (-3px) to avoid clipping. A skip link reaches run controls. Text selection reverses page-colored text onto accent fill; links use underline offset (4px). Scrollbars use a muted green-gray thumb (`#849692`) against the page. Reduced-motion preferences remove transitions and animation. Forced-colors mode restores system text and control-border colors.

## Do's and Don'ts

### Do:

- **Do** keep the real game view prominent, opaque, and separate from setup and evidence.
- **Do** pair status color with factual labels for connection, rendering, inference, effects, and run state.
- **Do** preserve Jura explanations and IBM Plex Mono controls, values, and evidence.
- **Do** keep run controls reachable as the layout stacks, with visible focus and readable wrapped content.
- **Do** show unknown, empty, pending, failed, paused, and stopped states explicitly.

### Don't:

- **Don't** replace unavailable gameplay or missing records with simulated footage or successful-looking sample data.
- **Don't** present Integration Spike evidence as completed Playable MVP acceptance or game-goal success.
- **Don't** reintroduce pixel lettering or decorative monospace headings.
- **Don't** turn the workspace into a decorative hero or a mosaic of metric cards.
