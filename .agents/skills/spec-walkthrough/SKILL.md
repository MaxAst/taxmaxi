---
name: spec-walkthrough
description: Walk the founder through a completed or in-flight spec as its tech lead — what was built, which numbers changed on purpose, and what to test by hand. Use when the user asks what a spec delivered, wants to catch up on an epic, or asks what they should manually test.
---

# Spec Walkthrough

You are the **tech lead who ran this spec**, briefing the founder. They know the product deeply but have not watched the work happen. Speak in first person about the work. Your job is not to summarize the spec — it is to transfer three things: what the product does differently now, which numbers changed on purpose, and exactly what to test by hand.

Follow the plain-speech rules from `pr-walkthrough` (describe by behavior before naming, sentences that survive alone, one concrete example carried through, cold-read pass before delivering). They apply to every section below.

Apply `AGENTS.md` "Communication" to the story: explain any unfamiliar relationship through the running example before describing what changed. For in-flight specs, distinguish proposed work from merged and deployed behavior.

## 1. Gather state, not events

The spec issue's comment thread is an event log. Do not reconstruct the story from it. Read, in this order:

1. The issue body — the final spec, decisions, and checklist. This is the plan as it ended.
2. Every merged PR on the checklist (`gh pr list --state merged --search "NNN in:body"` plus checklist links). PR descriptions carry the result classification and pasted decisions — that is your index.
3. Report comments only (benchmarks, comparison reports, completion summaries) — the events worth reading. Skip amendment archaeology; the body already reflects it.
4. ADRs promoted by this spec, and gap issues filed by its harvest.

## 2. Check what is deployed

Prod is the latest git tag; anything after it on main is not deployed. Say plainly whether the work being walked through is live, or needs a local dev run to test, and how to start it.

## 3. Sort the PRs

Three bins, straight from the PR descriptions:

- **Result-changing** — the same input now produces different numbers or different behavior, each backed by a pasted decision. These are the heart of the walkthrough and the test plan.
- **New surface** — endpoints, tables, jobs, SDK methods, UI that did not exist. Testable, but nothing old to compare against.
- **Result-preserving** — refactors proven identical by differential or parity tests. These get one line and no manual testing; say what proved them.

## 4. Deliver the walkthrough

**The story.** What problem this spec solved and the approach, in a few sentences, through one running example (a real asset, a real sale). Include the one or two design turns that explain the final shape — not the full history.

**What exists now that did not.** A short map of the new surfaces, grouped by what the founder can touch (API, CLI, app) versus what runs underneath (tables, jobs). At most one small mermaid diagram, only if it answers a question prose lists badly (see the diagram rules in `docs/agents/delivery-process.md`).

**Numbers that changed on purpose.** Every recorded result change in one plain sentence each: what looks different, why the old number was wrong or the new one is required, and where the decision is recorded. These are the things that will look like bugs to someone who remembers the old output — the founder must know them before testing, or they will re-file settled decisions as findings.

**Manual test plan.** The centerpiece. Derive one check per result change and per new surface; skip result-preserving work entirely. Each check:

- concrete steps: the command, screen, or request, runnable against the founder's real local data;
- the expected outcome, including expected blockers ("this sale shows no gain and a blocker code — that is correct, it is waiting on #NNN");
- ranked with result-changing checks first, riskiest at the top.

Real user data stays local. If any part of the plan or its results is worth posting, follow the redaction rule in `docs/agents/issue-tracker.md`.

**Expected rough edges.** The gaps already filed (link each issue) so the founder neither re-files them nor mistakes them for regressions. State what is deliberately absent and where its future home is.

**Confessions.** As the tech lead: the shortcuts, the paths no test exercises, the decisions I would revisit — each pointing at evidence (a file, a skipped case, a deferred task). If honest inspection finds none, say so and say why.

Before delivering, do the cold-read pass. Offer to save the manual test plan as a local file the founder can tick through.

The walkthrough changes no code, no issues, and no state — it is a briefing.
