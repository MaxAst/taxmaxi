---
name: spec
description: "Upgrade a gap issue into a spec with a delivery checklist, in place. Run after the definition lane's grounding and grilling are done. Pass the issue number, e.g. /spec 247."
disable-model-invocation: true
---

Upgrade one gap issue into a spec by rewriting its body. The issue number is the argument. Templates and rules live in `docs/agents/delivery-process.md` — read its "Spec template", "Grounding and proof", "Diagrams in specs", and "Delivery checklist rules" sections first and follow them exactly.

Do NOT interview the user. Synthesize from what already exists: the conversation, the gap issue, research notes, grilling outcomes, and the codebase.

Apply `AGENTS.md` "Communication" when writing the body or explaining a seam: establish unfamiliar roles and relationships with one small example before asking the maintainer to assess the design. Keep the glossary's names precise without assuming the names explain how the parts work together.

## Process

1. **Gather.** Read the gap issue (`gh issue view <NNN> --comments`), the conversation context, and any research or grilling outcomes it references. If one-way-door decisions are still open — questions whose answer only the maintainer can give and that are expensive to reverse — stop and list them; the grill happens before the spec, not inside it.

2. **Ground.** Explore the current code the spec touches. Use the domain glossary vocabulary (`CONTEXT.md` via `CONTEXT-MAP.md`) throughout, and respect the ADRs in the area. Apply the process doc's conditional flow trace before cutting tasks.

3. **Sketch the seams.** Prefer existing seams; use the highest seam possible; propose new ones only at the highest point you can — the ideal number is one. Check with the maintainer that the seams match their expectations before writing the body.

4. **Write the body** per the spec template in the process doc: Problem (grown from the gap), Solution with a short user-visible behavior list, Decisions (every intentional result change; cross-spec decisions go to ADRs instead — write the ADR, do not inline the decision), Testing and seams with the process doc's behavior/task/test/outcome mapping, Out of scope, Delivery checklist, empty Harvest log. Add at most two mermaid diagrams per the diagram rules, only where one answers a question a reviewer would otherwise ask.

5. **Cut the checklist** per the delivery checklist rules: one PR per checkbox, 5–8 file target, each task's text carrying its acceptance behavior, result classification, seam, and decisions to quote; verification tasks name the exact values they verify; deletion tasks get an answer-key gate naming the maintainer as approver; place joined proof as soon as its seams exist per "Grounding and proof"; the final task is always the Harvest.

6. **Absorb.** If other gap issues are covered by this spec, close each with a comment "absorbed into #<NNN>" and list them in the spec's Problem section.

7. **Publish.** Replace the issue body (`gh issue edit <NNN> --body-file ...`), keep the issue number and title (retitle only if the gap title no longer fits), swap `needs-triage` for `ready-for-agent`, and post one comment noting the upgrade (an event). Then tell the maintainer the spec is ready to arm.

The issue body is the plan from this moment on. Anything that later changes the plan edits the body; comments stay events.
