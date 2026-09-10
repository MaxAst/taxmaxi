# Atelier review prompts

Use `/atelier` in development. These prompts compare experiments; they do not approve shared changes. The issue body at #339 owns decisions. T04 needs Max's exact choice before promotion.

## Compare primitives

> Open Experiments and reset primitive dimensions. Compare A, B and C with the same dashboard, menu, form and button states. Keep the content fixed. Repeat in English and German, light and dark, at actual browser widths of 390 and 1280 px. Inspect the long action label, input text, numbers and menu wrapping. Explain the tradeoff of each treatment without selecting one for me.

## Inspect an interaction

> In treatment [A/B/C], use Tab to reach Continue, activate it with Space, and open Portfolio actions with Enter. Move through the menu with arrows, close it with Escape and check focus returns to the trigger. Edit Portfolio name and submit with Enter. Compare real hover/press/focus with the labeled specimens. Check disabled/loading controls cannot activate. Repeat with reduced motion enabled. Report the observed result and browser settings, not an inferred pass.

## Tune a candidate

> Reset first. In Primitive dimensions, adjust extra button height (0–12 px), extra corner radius (0–12 px) and type scale (0.90–1.20). These offsets apply equally to all three candidates; base geometry remains distinct. Record the candidate, base values and offsets. A saved DialKit preset is a draft, not approval or a production dependency.

## Give element feedback

> Start Agentation feedback mode, select an element inside `atelier-primitive-mono`, `atelier-primitive-geist` or `atelier-primitive-editorial`, and describe one specific problem. Copy the feedback and include locale, theme, actual viewport, treatment and tuning offsets. Do not include real account data. Package tool chrome may be English.

## Record the approval

> Compare the candidates on a physical touch device as well as desktop. Record font roles, button geometry, size, state treatment, long-label behavior and exact values in #339 T04 and atelier-review.md. Name any unresolved concerns. Until Max records this choice, keep all three candidates private and leave shared tokens/components unchanged.
