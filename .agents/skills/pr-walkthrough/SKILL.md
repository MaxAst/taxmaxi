---
name: pr-walkthrough
description: Walk the user through a PR as its author, prepping them to review it. Use when the user wants a PR, branch, or pending changes explained before reviewing, or asks to be prepped for a review.
---

# PR Walkthrough

You are the **author** of these changes, briefing a coworker who is about to review them. Assume they know the repository conventions but may be new to the changed subsystem. Speak in first person about the work ("I moved X because…"), not as a neutral reporter. Your job is to make their review faster and sharper: route their attention to the code that deserves scrutiny, and hand over the doubts only the author knows about.

## 1. Pin down the diff

Decide what "the PR" is, in this order: a PR number or URL the user gave (`gh pr view` / `gh pr diff`), otherwise the current branch against its merge-base with the main branch, otherwise uncommitted changes. State which one you picked.

Done when you have the exact diff and its base.

## 2. Do the author's homework

Read the full diff — every changed file, not the stat summary. Then gather the intent: the linked issue, the PR description, and the commit messages along the branch. Where the diff changes existing behavior, read enough surrounding code to know what callers will see differently.

Done when every changed file is read and you can say, for each one, why it changed.

## 3. Write in plain speech

Apply `AGENTS.md` "Communication": respect the reader's stated knowledge and use the running example to explain how the relevant parts relate, not just what each term means. Establish that relationship before the change and its consequences.

The reviewer may not have touched this subsystem for weeks, and the issue behind the PR is often newer than anything in their head. Write the whole briefing for a reader who knows the product but has none of the subsystem's vocabulary loaded. Defining a term once does not license using it afterwards — a definition read once does not stick.

Rules:

- Describe a thing by what it does before you name it: "the table that stores which decision is in force (`asset_resolution_current_state`)". Afterwards keep using the plain description; use the code name only where the reviewer needs it to find the code.
- Each sentence must survive on its own. Do not build a sentence on a term the reader would have to scroll back to re-learn — neither a code name nor a general term like "projection" or "compare-and-set". Say what happens instead.
- Unfold compressed noun phrases into cause and effect. Not "compare-and-set bound to both revisions" but "the write fails if anything changed since the admin looked, and they are told to re-check".
- Pick one concrete example — a real provider, asset, and admin action — and carry it through the whole briefing. Explain each mechanism as what happens to that example, not as an abstract property.
- Prefer everyday words over the repo's invented ones, including the documented domain terms. Reach for a domain term only when the review needs it to discuss the code, and ground it in plain words at that spot.

**Terms.** section: only when several code names are unavoidable in the hotspots. Each entry says what the thing does in plain words first, then gives the name.

Done when someone who has read only the issue title can follow every sentence without a glossary or a scroll-back.

## 4. Give the walkthrough

Deliver in this shape:

**Terms.** Include this only when several subsystem-specific terms are needed. For each term, state what it means in this PR and why it matters.

**The story.** A few sentences: what problem this solves and the approach I took — the "why" the diff can't show. Mention any path I tried and abandoned if it explains the final shape. Define isolated unfamiliar terms inline.

**Hotspots.** The places the review should spend its time, ranked. Each gets a clickable `file:line` pointer and one or two sentences on what to check there and why it carries risk — core logic, a behavior change, a rule that must hold, a subtle interaction with existing code. Routine changes (renames, lockfiles, generated code, import shuffles) get a single line binning them as skimmable.

**Confessions.** My genuine doubts, as the author, each naming its file: a shortcut I took, an edge case I never exercised, a test I didn't write, a design choice I went back and forth on, a place where the code drifted from what the issue asked. Derive each confession from evidence in the diff — an untested path, an assumption, a TODO — so the reviewer can go look. If honest inspection turns up none, say so and say what gives me that confidence.

Before delivering, do a cold-read pass: read the briefing as someone who last thought about this area weeks ago. Any sentence that uses an invented noun before the briefing has described that thing in everyday words fails — rewrite it.

Done when every changed file is either covered by a hotspot or binned as routine, every confession points at code, and the briefing passes the cold-read pass.

The deliverable is the briefing — leave the code untouched and let the reviewer decide what to act on.
