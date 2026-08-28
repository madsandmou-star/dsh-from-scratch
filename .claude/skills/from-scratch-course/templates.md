# Course artifact skeletons

Copy and fill. Language follows the learner's, with technical terms kept in their original form. Paths assume a standalone course repository whose reference source is a pinned, read-only submodule.

## Directory layout

```
<course>/
├── README.md         # what this is, why it exists, the route, quick start
├── COURSE.md         # living syllabus: current stage detailed, later stages four lines each
├── AGENTS.md         # the method applied to this course; the reference-source rules
├── docs/<NN>-<stage>/<NN>-<lesson>/<NN>-<topic>.md
├── scripts/          # a link + citation checker, so lessons cannot rot silently
├── demos/            # one runnable script per situation shown in the prose, all keyless
├── src/              # teaching code, evolving in place across stages
└── <ref>/            # the reference source, pinned read-only (submodule)
```

## README.md

```markdown
# <Course name>

<One line: rebuild what, until the learner can do what.>

| | |
|---|---|
| Reference source | <path or repo, read-only> |
| Terminal goal | <honest, reachable> |
| Audience | <who this is for> |

## Why not just read the source
<The concrete failure mode of reading it directly: how far the reader gets before getting lost, and why — missing motivation, not missing intelligence.>
<Two or three abstractions, each with the pain that makes it make sense.>

## What you will learn
<Include the debug-is-the-real-skill note.>

## The route
<Phase 1 table: stage number + content.>
<Phase 2 table: stage number + pain + abstraction introduced.>

## Quick start
<Exact commands, including how to configure a key through an environment variable.>

## Layout
<Course tree, then a table mapping "what you want to look at" to real paths in the reference source.>
```

## COURSE.md

```markdown
# <Course name> syllabus

> Living document: a stage is detailed only when entered. Every stage ships something runnable.

## Phase 1 · <name>

### Stage N: <title>

> Goal: <one sentence>
>
> Deliverable: <what runs at the end>

#### Lessons
- **N.1 [<title>](docs/...)**
  - <bullet per idea, including the debug move and the real-source comparison>

#### Stage output
<file tree of what exists after this stage>

## Phase 2 · <name>

### Stage M: <title>
> Pain: <the concrete pain, in the learner's words>
> Introduces: <the abstraction>
> Compare against: <real path>

## Current status
- [x] Stage 0 …
- [ ] Stage N …

> Next: <the single next action>
```

## Lesson

```markdown
# N.M <title>

> Goal of this lesson: <one sentence>

## <The pain, or the concrete question>
<Reproduce it. Name the files that must change, the value that gets lost, the number that grows.>

## The solution, whole
<One sentence: what the solution is.>

<Before/after data-flow sketch — plain ASCII. Where it used to come from, where it comes from now.>

### All of the code
<The complete mechanism, tens of lines, readable in one screen. Not a fragment.>

### Using it
<The call site: how few lines it takes.>

### What it produces
<Real output, copied from the demo script.>

<Then, and only then:>

## <Detail 1: a choice made above, and why not the alternative>
## <Detail 2: …>

## Teaching debug: <the move>
<Which error line to read, what to log, where to breakpoint, how to prove it ran.>

## Compare against <the real system>
| | ours | theirs | why theirs is more complex |
|---|---|---|---|
<Last column names what the complexity bought. Close with the stage that repays the simplification.>

---

Next: [<next lesson>](...)
```

## Stage review

~~~markdown
# N.<last> Stage N review

## Checklist
```sh
<command>
# expected: <output>
```
<Include one command that exercises a failure path.>

| Checked | |
|---|---|
| <capability learned> | ✓ |

## What this stage produced
<file tree with new/changed marked>

## Compare against <the real system>
<gap table>

## Engineering-thinking summary
### 1. <A judgment, not an API>
<Why it generalizes beyond this stage.>

## What stage N taught
| Lesson | Ideas |

## Next stage's pain
<Concrete enough to itch. Name the fix the next stage brings, and what it costs.>
~~~

## Demo script

```js
// N.M <the one situation this script shows>
//   <exact command>

// Self-contained: its own temp working directory, no trace left, no credentials.
// Where the real system needs a paid service, drive a scripted fake so the output
// is identical on every run.
```

## Teaching code

```ts
// Stage N.M: <what this file is for>
//
// Run it:
//   <exact command>

// <Explain what this construct is when the reader may be meeting it for the first time.>
// <Explain why it is written this way when a plainer way exists.>
export function thing() {}

// Compare against <real path>: <what the real one does differently, and which stage closes the gap.>
```
