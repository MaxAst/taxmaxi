---
name: harvest
description: "Run a spec's final harvest task: promote durable knowledge, file remaining gaps, delete the spec's scaffolding, update templates, close the issue. Pass the issue number, e.g. /harvest 212."
---

Run the harvest for one spec issue — always its last checklist task. The full rules live in `docs/agents/delivery-process.md` ("Harvest", "Durable homes", "Gap issue template"); this skill is the operational order.

## Process

1. **Collect.** Read the spec's Harvest log section, then sweep the whole epic once: every merged PR's description (result classifications and pasted decisions), the report comments, and the recorded decisions in the body. You are looking for three ores: durable knowledge, remaining gaps, and lessons for the reusable machinery.

2. **Promote** everything that meets the bar, into its durable home:
   - Quoted from outside this spec, or a deliberate "do not undo" → an ADR (`docs/adr/`, next number, house format).
   - Changes user-visible numbers → legal reference data, treatment codes, or an ADR — whichever actually carries it to users and auditors.
   - Rule for how agents work → `AGENTS.md` or `docs/agents/`.
   - New domain term → the owning context's `CONTEXT.md`.
     A decision that meets no bar dies with the spec; that is the intended outcome for most of them.

3. **File the gaps.** Every unresolved finding becomes its own `needs-triage` issue via the `capture` skill — problem only, no solutions, with evidence links back to this spec's PRs and reports. Add each to the relevant roadmap map issue. Then run the blocker sweep: list the active runs' blocker codes with counts from the live database — every code that has no recorded rule and no open issue gets a gap issue. This check exists because #212's harvest missed its largest blocker (staking classification, over a thousand events) while filing a smaller one. Before trusting the counts, check the active runs' ages against the last fact replay: #149's harvest found the 2022–2025 active runs predated the leg replays, so every one of their blockers pointed at a deleted row. Count from fresh runs only; file staleness as its own gap. Query through `psql` with the `PG*` values from `apps/server/.env`; join `active_calculation_runs` to `calculation_run_blockers` and group by `code`. Record schema compatibility separately from input freshness and distinguish live evidence from disposable-copy evidence, following the process document’s Harvest rule. Real user data stays out of public issues per `docs/agents/issue-tracker.md`.

4. **Delete the scaffolding.** Remove `.agents/skills/implement-NNN/` and its `.claude/skills/` symlink. It references dead checklist state; keeping it invites accidental use. (Orchestrator prompts no longer exist as files — the `orchestrate` skill binds its templates live.)

5. **Improve the machinery.** Fold what the epic taught into the reusable homes: the `orchestrate` templates, the `spec`/`harvest`/process docs, AGENTS.md. If a lesson is too big to fold in now, file it as a gap issue instead of dropping it.

6. **Close.** Post one closing summary comment (an event): what shipped, what was promoted where, which gap issues were filed. Tick the harvest checkbox in the body, then close the issue. A spec written before the current template may have no harvest checkbox and no Harvest log section (#149 had neither); add the checkbox as the last task and tick it, so the body records that the harvest ran.

7. **Offer the walkthrough.** Tell the maintainer the spec is closed and `/spec-walkthrough NNN` is available for the catch-up briefing and manual test plan.

All promotion edits (ADRs, AGENTS.md, glossary, templates) are repo changes — commit them with a `docs`-typed conventional commit referencing the spec, or hand them to the maintainer uncommitted if the session must not commit.
