---
name: orchestrate
description: "Become the delivery orchestrator for an epic, as the session's opening act. Pass a spec issue number for a checklist epic (orchestrate 247) or epic labels for a queue of small issues (orchestrate assets transactions)."
disable-model-invocation: true
---

Adopt the orchestrator role for one epic and run it to completion. This replaces the old generate-prompt-and-paste flow: the role definitions live in this skill's directory as templates, and you bind it at startup by reading the tracker — no generated prompt file.

## Startup

1. Parse the argument. A number → **spec epic** (one issue, delivery checklist). Labels → **queue epic** (open issues matching those labels plus the launch milestone, worked in the given label order).
2. Load your role: read `.agents/skills/orchestrate/orchestrator-prompt-template.md` (spec epic) or `.agents/skills/orchestrate/queue-orchestrator-template.md` (queue epic). That template IS your constitution for this session — every placeholder binds to what the tracker says today, and you re-read the template whenever in doubt or after context compaction.
3. Bind the placeholders live: the spec body or issue queue, the ADRs its area touches, the closing/harvest records of the epics that changed the ground, gates and their approver, other active streams. The tracker is the state; never write bindings down as private notes that can rot.
4. Spec epic only: if `.agents/skills/implement-NNN/` does not exist yet, generate it from this directory's `worker-skill-template.md`, commit, and push before spawning any worker (worktrees only see committed state). Queue epics have no worker skill — each issue body plus its recorded comments is the worker's spec.
5. Before doing anything else, reply with your understanding: the queue or checklist you will work, the gates that stop you, any issues carrying do-not-implement decisions, and the never-edit-code rule — then adopt the standing goal of completing the epic and start. If the maintainer's opening message adds constraints, they govern.

## Then

Follow the loaded template exactly: pickup audits, worker spawns, review judgment from the durable rule homes, merges, stop conditions. The newest recorded decision on the tracker always wins over the template and over this skill.

For explanations and blocked decisions, follow `AGENTS.md` "Communication" and the template's "How to communicate" section. Make the relationship and consequence clear before presenting the decision the maintainer needs to make.

## Improving the templates

The templates in this directory are the durable home of everything the epics teach about execution. When a running epic surfaces a lesson that belongs in every future epic, edit the template here — not only the running session's behavior — and note it in the spec's Harvest log.
