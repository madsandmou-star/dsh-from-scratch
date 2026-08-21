---
name: from-scratch-course
description: 'Use when building or continuing a "from scratch" learning course that rebuilds a large real codebase stage by stage — designing the stage roadmap, detailing the next stage, writing a lesson, adding teaching code, or running a stage review. Triggers include "从零开始学 X"、"写下一阶段的讲义"、"把这个仓库做成课程"、"我想搞懂 X 的原理"、"learn X from scratch", "teach me this codebase", "build a tutorial project for this repo", and any authoring work in this course repository.'
---

# Building a from-scratch course

A from-scratch course teaches a large system by **rebuilding a smaller one beside it**, one motivated step at a time, until the learner can read and change the real thing. The method below is distilled from [OpenCode From Scratch](https://github.com/hong-kailin/OpenCodeFromScratch); this repository *is* such a course, and its [AGENTS.md](../../../AGENTS.md) is the applied form.

Use it to start a course, to author one stage, or to review one. Skeletons for every artifact are in [templates.md](templates.md).

## The one idea

**Pain first, abstraction second.** An abstraction the learner has not yet suffered without is memorized, not understood. Every stage after the first phase opens by *reproducing a concrete pain* — "adding a seventh tool means editing three files", "the reply is lost when the process exits" — and only then introduces what the real system does about it.

Two corollaries that decide most authoring questions:

- **Nothing is introduced before it is needed.** If current code must mention a later concept, spend one sentence ("stage N covers this") and move on.
- **Nothing assumes a later lesson.** Writing lesson N, you may only assume lessons 1..N-1.

## Route design

Design the route once, before writing any lesson.

1. **State a terminal goal you can actually reach.** "A 1:1 replica" is honest only for a system small enough to replicate; for a system of a hundred packages or more, say what mastery means instead — *read any package, and ship a real plugin against a documented extension point*. An unreachable goal quietly turns the course into a lie.
2. **Find the target's spine.** Locate its core loop and the handful of services around it (in an agent harness: the loop, model transport, tools, prompt assembly, session state). Find the smallest composed example the repo already ships; that example is the shape the course grows toward.
3. **Split into two phases.**
   - **Phase 1 — the simplest thing that runs, no framework.** Rebuild each mechanism bare so the learner meets the raw facts the abstractions will later hide.
   - **Phase 2 — pain-driven evolution.** One stage per abstraction, each opened by its pain.
4. **Write the pain table before the stage list.** For every abstraction in the target, name the pain in the learner's own words. An abstraction with no expressible pain is one you do not yet understand well enough to teach — go read more source.
5. **Order by dependency, not by the target's package layout.** Ship a runnable thing at the end of every stage.

## The living syllabus

`COURSE.md` details **only the current stage** down to lesson level; every later stage stays four lines — goal, pain, abstraction introduced, where to compare against real source. Detailing stage 12 while writing stage 2 produces plans that are wrong by the time they are read.

Entering a new stage, the first action is to expand that stage's lessons in `COURSE.md`; the last action of a stage is to tick its box and rewrite the trailing "next step" line.

## Anatomy of a stage

A stage has a goal sentence, a runnable deliverable, three to six lessons, and a **stage review** as its final lesson. The review is not a summary — it is where the learning is consolidated:

- an **executable checklist**: commands plus expected output, including one command that shows a failure path;
- the **file inventory**: what this stage added or changed;
- the **gap table** against the real source: `| | ours | theirs | why theirs is more complex |`, where the last column names what the extra complexity *bought* (persistence, cancellation, permission, cross-process);
- an **engineering-thinking summary**: the judgments learned, never the APIs learned;
- the **next stage's pain**, previewed concretely enough to itch.

## Anatomy of a lesson

One file, one idea. Split past roughly 150 lines or at any clear topic change.

- **Do before naming.** Show what happens on screen, then name the concept behind it.
- **Code is the textbook.** Every snippet in the prose has a real, openable, runnable file behind it. No orphan snippets.
- **Teaching comments explain *what* and *why*.** This inverts the usual production rule, and is correct here: the reader may be seeing the syntax for the first time. Comments and code drift apart the moment you edit one without the other — don't.
- **No homework.** Never "now implement X yourself". The reader's time goes into *understanding*, not being tested.
- **Every lesson teaches one debug move**: which line of the error to read, what to log, where to breakpoint, how to prove the code even ran. A lesson that only shows the working answer has taught nothing about the day it stops working.
- **Compare to the real source** with verified paths: open the file before citing it, and name the stage where the simplification gets repaid.
- **Analogies must include where they break.** A wrong analogy costs more than none.

## Working with the learner

- **Offer choices at design forks** (which order, how far to simplify, which analogy) instead of silently picking. Building the learner's own engineering judgment is part of the deliverable.
- **Teach judgment, not vocabulary.** Assume a competent engineer who may be new to this stack: syntax gets explained as it appears, design decisions get argued.
- **Let the learner battle the material.** Re-explaining one concept three ways — different analogy, different level, different language — is the method working, not a failure.
- **Do not auto-commit.** Report what changed; the learner decides when it lands.

## Housekeeping that bites later

- **Pin the reference source, and make it read-only.** A course whose citations move under it starts lying. A standalone course repository pins the target as a submodule at one commit and records that commit in the README (the way OpenCode From Scratch records the upstream version it replicates); a course living inside the target repository gets this for free but must then satisfy that repository's gates. Either way: never edit the reference, and make a version bump its own deliberate change — it moves the whole comparison surface at once.
- **Make citations mechanically checkable.** Write every source reference as a uniform path (`` `ref/packages/...` ``) and ship a checker that verifies each one exists plus every relative link resolves. Without it, nothing tells you the course has rotted except a confused reader.
- **Keep the course out of the target's gates.** If the course lives inside the target repository, keep it out of the workspace, lint, and coverage, and check which repo-wide gates match by filename before naming files — an entry called `README.md` can pull the course into a bilingual-pairing or doc-budget gate it cannot satisfy. A standalone repository sidesteps this and can own its own toolchain; the cost is that the reference source is no longer one `grep` away, which the pinned submodule buys back.
- **Secrets never enter the repo.** Configuration carries the *name* of an environment variable; the real config file is gitignored.
- **Code evolves in place** across stages (real development does), and each stage review says which files it touched.

## Reviewing a lesson before it ships

1. Does it open with a pain or a concrete question — or does it open with a definition?
2. Can every snippet be opened as a file and run?
3. Does it use any concept the reader has not met yet, without a one-line deferral?
4. Does it teach one debug move?
5. Are all cited source paths and symbol names verified against the current tree?
6. Does the "why theirs is more complex" column say what the complexity bought?
7. Would the reader be able to *predict* the next stage's pain?

## Anti-patterns

| Anti-pattern | Why it fails |
|---|---|
| Framework first ("let's learn the DI system, then build") | The learner memorizes ceremony; the motivation never arrives |
| Encyclopedia stage (every option of every API) | Reference material posing as a tutorial; nothing is retained |
| Snippet-only prose | The reader cannot run it, so they cannot debug it, so they never own it |
| "Exercise: implement X" | Trades comprehension time for testing time |
| Forward references | Reader stalls on a concept the course promised not to need yet |
| Only-the-right-answer lessons | The first real error becomes a wall |
| Unverified source citations | One wrong path destroys trust in every other citation |
| Overclaimed terminal goal | The course silently becomes unfinishable |
