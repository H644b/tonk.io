---
name: Tonk Workbench
description: The original Bonk visual world with native navigation and optional independent-server tools.
colors:
  native-teal: "#009688"
  workbench-teal: "#007f73"
  workbench-close: "#006b61"
  help-link: "#005f56"
  workbench-link: "#006a60"
  brown: "#795548"
  native-brown-hover: "#7f5d51"
  workbench-brown-hover: "#624235"
  paper: "#e2e2e2"
  native-panel: "#cfd8dc"
  help-rail: "#bfcbd0"
  help-rail-hover: "#b1c0c6"
  help-code: "#e8ecee"
  ink: "#242424"
  white: "#ffffff"
  muted-copy: "#4c4c4c"
  hash-copy: "#454545"
  status-error: "#823026"
  divider: "#b7b7b7"
  field-border: "#9d9d9d"
  help-table-line: "#a8b6bd"
  pack-line: "#a4b2b9"
  pack-progress-track: "#b7c3c9"
  stage: "#1a2733"
  navigation-bar: "#273749c7"
  navigation-even: "#1e2c3c"
  navigation-odd: "#1d2937"
  navigation-hover: "#2d435a"
  native-xp-track: "#131c27"
  native-xp-fill: "#473aaf"
  consent-backdrop: "rgba(0, 0, 0, 0.45)"
typography:
  title:
    fontFamily: "Future, sans-serif"
    fontSize: "24px"
    fontWeight: 700
  headline:
    fontFamily: "Future, sans-serif"
    fontSize: "23px"
    fontWeight: 700
  subheading:
    fontFamily: "Future, sans-serif"
    fontSize: "20px"
    fontWeight: 700
  room-title:
    fontFamily: "Future, sans-serif"
    fontSize: "19px"
    fontWeight: 700
  body:
    fontFamily: "Future, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.4
  consent-body:
    fontFamily: "Future, sans-serif"
    fontSize: "18px"
    lineHeight: 1.4
  detail:
    fontFamily: "Future, sans-serif"
    fontSize: "15px"
    lineHeight: 1.4
  compact-label:
    fontFamily: "Future, sans-serif"
    fontSize: "14px"
    lineHeight: 1.3
  loading-detail:
    fontFamily: "Future, sans-serif"
    fontSize: "16px"
    lineHeight: 1.4
  native-panel-title:
    fontFamily: "futurept_b1, sans-serif"
    fontSize: "20px"
    lineHeight: "32px"
  native-action:
    fontFamily: "futurept_b1, sans-serif"
    letterSpacing: "0.4px"
  native-top-action:
    fontFamily: "futurept_b1, sans-serif"
    fontSize: "16px"
    lineHeight: "34px"
  native-top-action-phone:
    fontFamily: "futurept_b1, sans-serif"
    fontSize: "14px"
    lineHeight: "34px"
  native-xp:
    fontFamily: "futurept_medium, sans-serif"
    fontSize: "11px"
    lineHeight: "12px"
  help-title:
    fontFamily: "futurept_b1, sans-serif"
    fontSize: "24px"
    lineHeight: 1.4
  help-heading:
    fontFamily: "futurept_b1, sans-serif"
    fontSize: "30px"
    lineHeight: 1.2
  help-heading-phone:
    fontFamily: "futurept_b1, sans-serif"
    fontSize: "26px"
    lineHeight: 1.2
  help-subheading:
    fontFamily: "futurept_b1, sans-serif"
    fontSize: "23px"
    lineHeight: 1.3
  help-body:
    fontFamily: "futurept_book, sans-serif"
    fontSize: "18px"
    lineHeight: 1.5
  help-action:
    fontFamily: "futurept_book_fixed, sans-serif"
    fontSize: "17px"
    lineHeight: 1.4
  help-topic-phone:
    fontFamily: "futurept_book_fixed, sans-serif"
    fontSize: "16px"
    lineHeight: 1.4
  code:
    fontFamily: "ui-monospace, monospace"
    fontSize: "13px"
    lineHeight: 1.5
  help-code:
    fontFamily: "ui-monospace, monospace"
    fontSize: "14px"
    lineHeight: 1.6
  profile-hash:
    fontFamily: "ui-monospace, monospace"
    fontSize: "12px"
    lineHeight: 1.5
rounded:
  native-control: "2px"
  workbench-control: "3px"
  native-panel: "7px"
spacing:
  tight: "4px"
  small: "8px"
  medium: "10px"
  field-gap: "12px"
  row-inset: "14px"
  reading-gap: "16px"
  help-inset: "18px"
  drawer-inset: "22px"
  help-rail-inset: "24px"
  article-inset: "28px"
components:
  button-workbench:
    backgroundColor: "{colors.brown}"
    textColor: "{colors.white}"
    rounded: "{rounded.workbench-control}"
    padding: "8px 15px"
  button-workbench-hover:
    backgroundColor: "{colors.workbench-brown-hover}"
  button-close:
    backgroundColor: "{colors.workbench-close}"
    textColor: "{colors.white}"
    typography: "{typography.compact-label}"
    padding: "8px 15px"
    rounded: "{rounded.workbench-control}"
  button-native:
    backgroundColor: "{colors.brown}"
    textColor: "{colors.white}"
    typography: "{typography.native-action}"
    rounded: "{rounded.native-control}"
  button-native-hover:
    backgroundColor: "{colors.native-brown-hover}"
  button-native-top:
    textColor: "{colors.white}"
    typography: "{typography.native-top-action}"
    rounded: "0"
    height: "34px"
    padding: "0 12px"
  button-native-top-hover:
    backgroundColor: "{colors.navigation-hover}"
  button-native-top-active:
    backgroundColor: "{colors.navigation-even}"
  field-workbench:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.workbench-control}"
    padding: "9px"
    width: "100%"
  tab-workbench:
    textColor: "{colors.ink}"
    rounded: "3px 3px 0 0"
    padding: "9px 4px"
  tab-workbench-selected:
    backgroundColor: "{colors.workbench-teal}"
    textColor: "{colors.white}"
  panel-native:
    backgroundColor: "{colors.native-panel}"
    rounded: "{rounded.native-panel}"
  panel-native-title:
    backgroundColor: "{colors.native-teal}"
    textColor: "{colors.white}"
    typography: "{typography.native-panel-title}"
    rounded: "3px 3px 0 0"
    height: "32px"
  topic-help:
    backgroundColor: "{colors.help-rail}"
    textColor: "{colors.ink}"
    typography: "{typography.help-action}"
    rounded: "0"
    padding: "9px 24px"
  topic-help-hover:
    backgroundColor: "{colors.help-rail-hover}"
  topic-help-current:
    backgroundColor: "{colors.brown}"
    textColor: "{colors.white}"
  consent-panel:
    backgroundColor: "{colors.native-panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.native-panel}"
    width: "min(560px, calc(100% - 28px))"
  consent-title:
    backgroundColor: "{colors.workbench-teal}"
    textColor: "{colors.white}"
    typography: "{typography.title}"
    padding: "14px 22px"
  progress-pack:
    backgroundColor: "{colors.pack-progress-track}"
    height: "8px"
    width: "100%"
  progress-pack-fill:
    backgroundColor: "{colors.workbench-teal}"
---
# Design System: Tonk Workbench

## Overview

**Creative North Star: "The original Bonk game, with an optional workbench"**

The shipped Bonk client is the visual authority. Its Futura PT lettering, teal title bars, warm brown actions, gray windows, native icons, skins, editors, and rendered game geometry establish the world. This record refreshes the existing system for the user-approved native navigation, Help, XP placement, code-modpack Workbench, and consent extension.

Workbench and Fullscreen belong to the original dark top navigation. The workbench uses the same font assets and familiar flat controls in a compact utility layer; deeper teal marks its header, selected tabs, and focus. Help uses the original classic teal and gray materials for sustained reading. The game retains the whole viewport beneath optional tools, and opening a drawer does not resize the renderer.

**Key Characteristics:**
- Original game assets and native interface materials remain authoritative.
- Native navigation owns Workbench and Fullscreen; the home menu owns Help.
- Compact Futura PT controls sit on gray panels with teal structural bars.
- Brown buttons carry actions; selected Workbench tabs use deeper teal.
- Explicit content consent precedes room code execution.

## Colors

Teal organizes the interface, brown identifies actions, and gray panels separate controls from the dark game ground. Frontmatter owns the exact palette; the sidecar records sources and the deliberate extension steps.

### Primary
- **Native Teal**: classic window and lobby title bars, Help's title bar, and native focus enhancement.
- **Workbench Teal**: drawer header, selected tabs, tab underline, progress, selection, and shell focus.
- **Workbench Close**: compact Close action inside the drawer header and Help's focus treatment.
- **Help Link / Workbench Link**: distinct deeper teal link treatments retained from their respective stylesheets. Help Link also provides the consent focus outline.

### Secondary
- **Warm Brown**: native classic actions, Help's selected topic, added buttons, uploads, and scrollbar thumbs.
- **Native Brown Hover / Workbench Brown Hover**: original classic controls lighten on hover; added shell controls darken. Preserve this distinction.
- **Status Error**: the persistent shell status output's rust-brown copy.

### Tertiary
- **Native XP Fill**: the original purple progress fill retained by the native XP nodes and reward animation.

### Neutral
- **Paper Gray / Native Panel Gray**: continuous Workbench drawer and tabs / native lobby, Help reading ground, and consent body.
- **Help Rail / Help Rail Hover / Help Code**: topic-column ground, its hover state, and the light code-example inset.
- **Ink / White**: reading and form text / lettering on colored actions and bars.
- **Muted Copy / Hash Copy**: connection text / exact-profile metadata.
- **Divider / Field Border / Help Table Line / Pack Line**: separate rows, white fields, reference-table rows, and code-pack groups without inventing a card grid.
- **Pack Progress Track**: muted ground beneath the Workbench progress accent.
- **Stage Blue / Navigation Bar / Navigation Even / Navigation Odd / Navigation Hover**: full-frame page ground, translucent native top bar, alternating native destinations, and their common hover state. Pressed top-navigation actions use Navigation Even.
- **Native XP Track**: the compact native progress track, edge, and segment marks within identity.
- **Consent Backdrop**: native-dialog dimming while an executable-content decision or approved download owns interaction.

**The Native Materials Rule.** Extend the original teal, brown, gray, and Futura relationship; preserve native assets and game colors rather than applying a blanket renderer recolor.

## Typography

**Display and Body Font:** Futura PT, registered in the shell as `Future` from `fptbook.otf` and `fptb.otf`, with `sans-serif` fallback. Native registrations retain `futurept_light`, `futurept_book`, `futurept_book_fixed`, `futurept_medium`, `futurept_b1`, and `futurept_bold`.

**Character:** rounded geometric lettering with compact utility copy and bold Workbench headings. The native interface uses its shipped face registrations instead of replacing them with synthesized weights. The frontmatter records the real roles, including intentional new smaller navigation/loading steps and larger Help headings.

- **Workbench:** title, headline, subheading, room/legacy title, body, detail, and compact label roles preserve the shell's existing hierarchy. Room titles and the legacy-tools summary share the room-title step. The consent-body role records the existing larger dialog text; the removed introductory copy has no separate type role.
- **Native navigation:** top actions share native bold lettering and a fixed control line box; the phone action role is smaller. Identity XP uses the native medium face and its compact status line.
- **Help:** a native bold title, article heading, subheading, book reading face, and fixed-book action face form a separate reading hierarchy. Phone headings and topic actions have explicit observed roles; phone article body uses the shell body size with Help's inherited line-height.
- **Source and identity:** script text and phone code blocks use the code role; desktop Help code has its own reading role. Exact profile hashes use the smaller monospace role and wrap inside their containers. Inline Help code uses a relative (0.85em) size.

**The Same Lettering Rule.** Use the shipped Futura assets for interface additions. Reserve monospace for source examples, script editing, and exact content hashes.

## Layout

The shell has no scrolling document or surrounding marketing frame. Its iframe fills the width and dynamic viewport height (`100dvh`); the enhanced native page and game container fill their available dimensions. Optional tools overlay the frame.

The native top bar is (35px) high on desktop. Identity groups the original preview, name, level, and XP nodes; names truncate before crowding controls. Workbench follows identity with auto space, then Fullscreen and the retained native icon actions. Host-only Lobby appears through the same navigation. At `max-width: 1000px`, player count hides and the retained icon actions narrow. At `max-width: 700px`, the bar wraps to (70px), identity has a bounded share, added text actions compact, and icon actions distribute across the remaining rows. Native runtime visibility remains authoritative, including while the parent drawer owns focus.

Help occupies the game container below that bar, using the matching desktop or phone top inset. The desktop reading layout has a (235px) independently scrolling topic column and a flexible article. Article children are bounded to (74ch), with padding adapting around a (76ch) measure. At `max-width: 700px`, topics become a horizontal scrolling rail, the article scrolls vertically with (22px 18px) padding, and code/table wrappers scroll horizontally. The teal title bar keeps Help and Back to game together.

The right drawer spans the viewport height and is at most (440px) wide. It scrolls internally, has (22px) side/bottom padding, a full-bleed header, and sticky equal-width tabs. Related fields share a flexible row with a (12px) gap. Lists use separators rather than individual cards. At `max-width: 600px`, the drawer uses the full width; its header respects the top safe area. Pack links, host actions, and consent actions wrap.

Consent is centered in the browser's native modal top layer, at most (560px) wide, with (14px) minimum viewport clearance and an internally scrolling maximum height. At `max-width: 600px`, body padding compacts and the two decision buttons share a flexible row. Exact hashes wrap inside the dialog.

Retained phone bottom navigation has five equal destinations at (20%) width and (60px) height, with its separate PLAY lettering. The phone lobby remains a vertical scrolling column: Playing, team lock, Spectating, Game Settings, then Chat. It is inset (8px), sized to `calc(100% - 80px)` height, and has bottom padding for scrolling access. The four main panels retain heights of (190px), (120px), (300px), and (220px). Long player names truncate before their status controls.

**The Whole Viewport Rule.** Added tools overlay the full game frame; opening or closing them must not change renderer dimensions.

**The Native Ownership Rule.** Keep Workbench and Fullscreen in the original top navigation, Help between Skins and Friend List, and XP within the navigation identity.

## Elevation & Depth

Mostly flat materials use restrained, functional shadows. Teal bars, gray surfaces, thin native highlights, and row dividers provide structure. Original artwork and rendering retain their own depth. The removed toolbar has no active shadow token.

### Shadow Vocabulary
- **Native window / button, including consent:** `1px 1px 5px -2px rgba(0,0,0,0.63)`.
- **Native field:** `1px 1px 4px -2px rgba(0,0,0,0.4)`.
- **Drawer:** `-6px 0 24px #0005` identifies the right overlay edge.

The added shell has no CSS transition or entrance-animation system. Visibility, selection, hover, focus, and progress-state changes are immediate; native runtime motion and XP animation remain native. Consent dimming belongs to its top-layer interaction state.

## Shapes

Native panels and consent use gently rounded corners, with tighter actions and title-bar tops. Workbench buttons and fields share compact corners; native top actions are square and inherit the bar's dividing edges. Exact radii live in frontmatter. Native circular icon controls and player shapes remain native. Fields, fieldsets, table rows, and pack lists use thin (1px) strokes. The compact identity XP track has a (5px) height within its original progress container; its fill and segment nodes retain native ownership.

## Components

### Buttons
Brown rectangles with white lettering are the shared action primitive. Added controls use their recorded padding variants and darken on hover; native classic actions, including home Help and Help's return action, lighten. Shell disabled buttons use opacity (0.55); code-pack disabled actions keep a default cursor, while other shell busy controls use a wait cursor. Shell keyboard focus is a (3px) Workbench-teal outline offset by (3px). Native enhancement focus uses the same dimensions in Native Teal; Help and consent retain their separate recorded deep-teal treatments.

### Inputs / Fields
White fields span their container with ink text, a thin gray border, compact corners, and teal caret/focus. Labels sit above fields; select and file affordances remain native. Textareas resize vertically with a (100px) minimum; script source uses monospace and a (140px) minimum. No separate shell field-error variant is implemented.

### Cards / Containers
Native panels retain gray bodies, teal title bars, and native controls. Workbench is a continuous gray drawer. Room, mod, and map entries use divided rows; room names are bold and metadata smaller. Server packs use a thin outlined fieldset and legend, with compact checkbox rows. The profile summary is a white inset block. Imported pack artwork belongs to that pack rather than the base design system.

### Navigation
Workbench and Fullscreen are real native top-bar buttons. They retain native hover and pressed surfaces, expose expanded/pressed state, and use a white inset focus outline. Fullscreen changes to Exit fullscreen and returns focus to the frame after the browser request. Host-only Lobby shares that bar. The removed floating toolbar, Hide action, and reveal control are obsolete.

Workbench tabs are equal flex items on a sticky gray strip with a teal bottom rule. Selection fills a tab teal with white text; unselected tabs remain transparent with ink text. The implementation exposes `tablist`, `tab`, and `aria-selected` with click selection; an arrow-key tab model is not implemented. Retained native bottom destinations remain NEWS, FRIENDS, PLAY, SKINS, and TUTORIAL.

### Native Home Help and Reading Surface
Home Help sits immediately below Skins and above Friend List, using the same native brown menu action. It opens the labeled Help surface and focuses Back to game. Underlying menu/game/bottom-navigation content becomes inert; closing or Escape restores the prior control. The current topic is brown with white lettering; unselected topics use ink on the rail and a muted hover. Controls opens directly with the key table, Settings guidance, and Modding documentation action. Source examples, API tables, and long hashes have their own horizontal or wrapping containment. The sixteen topics retain the technical modding reference. Publishing captures cover Controls and Custom modes; the latter uses the Workbench's actual Default rules label.

### Identity XP
The original preview, name, level, and progress nodes are grouped within the native navigation identity. When native progress is visible, name and level align above its compact bar; the numeric/status text sits alongside the track. Existing reward/fill animation objects and measurements remain native. This placement is documented from source; no signed-in XP screenshot was supplied.

### Workbench Drawer and Code Modpacks
The labeled drawer is a modal dialog (`aria-modal="true"`). Opening stores the invoker, focuses Close, and makes the game wrapper inert. Tab and Shift+Tab wrap among visible enabled controls. Escape or Close dismisses it and restores the invoker when available, otherwise the native Workbench action. Scrolling remains internal and canvas dimensions remain unchanged.

Mods starts with Modpacks and the Modding help / Download Orb Kit example actions, then This room, Available packs, Custom mode, and Upload pack. These direct labels replace the removed feature introduction. Game rules uses Default rules for the native-base option. Host controls expose their unavailable state and actions wrap. Exact hashes use contained monospace text; registrations and status use the detail hierarchy. Appearance tools and earlier isolated scripts remain in the expandable legacy section below the full code-pack workflow.

### Mod Consent and Protected Loading
Room code consent uses native `dialog.showModal()`, a deeper-teal title bar, gray body, source-native corners and shadow, and the recorded backdrop. It presents a compact code-pack/asset count, the warning “Mods can access your game and account data. Only download packs you trust.”, pack identities, and the exact Profile SHA-256 hash. Leave Room sits beside Download & Join and receives initial focus; Escape declines.

After acceptance, the same protected dialog changes to Loading room modpack, hides the accept action and permission paragraph, exposes progress/live status, and retains Leave Room. Ready closes it; a failed load retains the protected surface with an error title. These loading/error appearances and keyboard execution are source-supported, with no supplied visual capture for those states. Hash verification describes content identity rather than trustworthiness.

## Do's and Don'ts

### Do:
- **Do** preserve original assets, Futura lettering, native teal bars, brown actions, gray panels, and editor geometry.
- **Do** use deeper Workbench teal for its header, selected tabs, progress, and shell focus.
- **Do** retain the native top-bar hover, pressed, visibility, and responsive behavior for added navigation actions.
- **Do** keep Help readable through its desktop topic column and phone topic rail, with article scrolling and a visible return action.
- **Do** preserve drawer focus entry, containment, inert background, Escape dismissal, and focus restoration.
- **Do** keep exact-profile identity, executable-code disclosure, Leave Room, and Download & Join together in the protected consent dialog.
- **Do** keep the original XP nodes and animation ownership while fitting progress beneath the name and level.
- **Do** let the phone lobby scroll vertically while retaining its native panels and controls.

### Don't:
- **Don't** replace the original interface with a landing page or generic dashboard identity.
- **Don't** restore the removed floating toolbar or reveal control.
- **Don't** replace native art, icons, or skins with invented approximations.
- **Don't** turn optional imported mod styling into base-system tokens.
- **Don't** hide consent decisions behind overflowing hashes or dismiss the protected loading state before readiness.
- **Don't** promote source-only XP/loading states or partial parity coverage into verified design or product claims.
