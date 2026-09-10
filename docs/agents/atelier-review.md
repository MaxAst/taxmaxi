# Atelier primitive review

Status: T03 comparison prepared; no primitive treatment approved. T04 belongs to Max. These are synthetic examples, not live portfolio state.

## Candidates

All three use the same content, component tree, state set and dashboard/menu/form contexts. Shared Button, Input, Card, Typography and DropdownMenu provide the behavior. Private CSS changes type and button treatment only; Approved and production styles stay unchanged.

| Treatment                  | Heading            | Body / controls | Button starting height | Corner radius |
| -------------------------- | ------------------ | --------------- | ---------------------- | ------------- |
| A · Mono / pill            | JetBrains Mono 500 | JetBrains Mono  | 44 px                  | 999 px (pill) |
| B · Geist / rounded        | Geist 600          | Geist           | 44 px                  | 12 px         |
| C · Kanit + Inter / square | Kanit 600          | Inter           | 48 px                  | 4 px          |

Heading size starts at 24 px; body 16 px; controls 15 px with 1.4 line-height. Buttons can grow to wrap long labels. The dashboard value uses 32 px tabular numbers. Inputs stay at least 16 px and 44 px tall. Every candidate retains the green/cream semantic colors and existing translucent card surface.

Primitive dimensions adds 0–12 px to button height, 0–12 px to radius and scales type from 0.90–1.20. Starting offsets are 0 / 0 / 1.00. Reset before baseline comparison. A pill remains a pill under a radius offset; the alternatives remain distinct. Tool parameters do not choose fonts or promote a candidate.

## Review procedure

Select Experiments after the actual browser-width text is measured (the first server-rendered frame may not yet be interactive). Set the actual browser viewport, not only the width preset. Repeat every row for A, B and C. Each has default, held hover/focus/pressed specimens, disabled and loading buttons, a long action, a working menu and a local form. Held specimens are appearance references, not proof of interaction.

| Locale  | Theme | Actual viewport | Browser evidence                                 |
| ------- | ----- | --------------- | ------------------------------------------------ |
| English | Light | 390 px          | Chromium: A/B/C captured; no horizontal overflow |
| English | Dark  | 390 px          | Chromium: A/B/C captured; no horizontal overflow |
| German  | Light | 390 px          | Chromium: A/B/C captured; no horizontal overflow |
| German  | Dark  | 390 px          | Chromium: A/B/C captured; no horizontal overflow |
| English | Light | 1280 px         | Chromium: A/B/C captured; no horizontal overflow |
| English | Dark  | 1280 px         | Chromium: A/B/C captured; no horizontal overflow |
| German  | Light | 1280 px         | Chromium: A/B/C captured; no horizontal overflow |
| German  | Dark  | 1280 px         | Chromium: A/B/C captured; no horizontal overflow |

Observed in Chromium on 2026-09-09: all three candidates passed real Tab/Shift+Tab focus, Space activation, pointer hover/press, menu Enter/arrow/Escape focus return, and form Enter submission at German/dark/390 px. Each portalled menu matched its candidate font and fit the viewport. Disabled/loading controls remained disabled. Reduced-motion loading icons were static.

Keyboard: Tab to an actual enabled button, Space to activate; Enter opens the menu, arrows navigate, Escape returns focus. Enter submits the form without navigation or network requests. Check disabled/loading buttons are skipped. Check focus outlines and long menu items at 390 px.

Reduced motion: the loading icon stays still and the loading label remains visible. Press retains its inset shadow without displacement; the example menu opens without its shared scale/slide animation. Hover is enhancement only; all actions work without it.

Physical touch: **not yet verified**. Browser touch emulation is not a physical-device pass. Max must check tap targets, menu opening/closing, scrolling, long labels and input keyboard behavior on a physical device before T04 approval. DialKit and Agentation package accessibility/touch limitations should be reported separately from candidate behavior; Agentation is desktop-oriented.

Browser artifacts use `t03-{en|de}-{light|dark}-{390|1280}-{mono|geist|editorial}.png` in the local Playwright output directory, with additional `t03-interaction-*` and `t03-reduced-motion.png` captures. Reproduce with the settings above; screenshots are review evidence, not approval.

## Approval record — T04

- Selected treatment: pending Max.
- Font roles and weights: pending.
- Button dimensions and states: pending.
- Exact tuning values: pending.
- Physical-device evidence: pending.
- Unresolved concerns: pending review.

No shared changes are authorized by this document. Use the [reusable prompts](atelier-prompts.md) to record comparisons and feedback.
