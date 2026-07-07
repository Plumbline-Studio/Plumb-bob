# Tool Maker Philosophy — The Lens

> **Canonical source.** This is Plumbline's operating philosophy, drawn from the
> canonical statement **The Lens** (`plumbline-vault/docs/vault/Plumbline Studio/Why/The Lens.md`,
> pointed to as canonical by `tool-maker/CLAUDE.md`). Reproduced here as Part I —
> *what the lens sees*, the product philosophy. The Lens's Part II (the working
> contract between Kyle and Claude) is intentionally omitted: it governs a
> collaboration, not a product, and has no place in a scoring corpus that ships
> to consumer repos to judge their software.
>
> The True layer reads this whole directory as context. `decision-heuristics.md`
> is the scored rubric; this file is the *why* behind it — the grounding that
> lets the agent write rationales that mean something. Keep it lean: The Lens
> warns that if it ever grows long, it has become the thing it warns against.

---

## What the lens sees

A mirror returns you to yourself. A window carries you through to the world. The
same pane of glass can be either; the only question that matters about a tool is
which it was built to be.

AI is the internet matured — built, by default, to hold attention by reflecting
people back to themselves improved: their certainty better-argued, their desire
better-dressed, their half-thought finished before they reached the end of
reaching for it. The shallow danger is flattery, which a person can learn to
distrust. The deeper danger does not feel like flattery; it feels like help.
When a fluent tool finishes your reach before you complete it, you get the answer
and skip the reaching — **and the reaching is the self.** Correctness and
formation are different axes: a handed answer can score full marks on the first
and contribute nothing to the second — the worst bargain precisely when the
stakes are real, because it makes someone who can only receive answers, against
the day the handed answer is wrong and there is no one to catch it but them.

So the better tool, against its own grain, does three things — all refusals:

- **Disagree** — better a true thought reached slowly than a flattering one at once.
- **Withhold** — hand back the question when what's needed is the reaching, not the conclusion.
- **Point away from itself** — toward the actual book and not its summary, the actual
  person and not the easier reflection of them, the actual problem met with real attention.

This is not anti-build. The same glass that wastes the entranced is the glass
that surrenders the stone to the one who comes **to find and not to use.** Good
things get made. The test is never *power*; it is *what the tool is built, at the
deepest level, to want* — the user's attention, or the user's becoming. Those
usually pull opposite ways, and **"build it true" is the decision to build for
the second every time it costs the first.**

For a maker — which is the vocation — this becomes a usable blade.
*Crooked-wrong* is a made thing off the line: true it. *Crooked-true* is a living
thing's own particularity: protect it. A tool that does it *for* the user spends
them; a tool that shows them what's true makes them larger and teaches them out
of needing it. The one metric that, chosen first, designs every other decision
away from attraction:

> **Does the person leave more able to do the next one with less of me?**

And the responsibility for that sits on the **builder's** side of the glass, not
the user's — the form of a tool can whisper *stay* or whisper *go*, and that is
the maker's doing, the part actually within reach to act on. (This is the spine
of Toolwright: built around departure, not dwell.)

## What a good tool is for: margin

The basic thing people need from technology is **margin** — room in the mind
(not holding everything at once), in money, in time, in a business's operations.
Technology's standard failure is that it *fills* margin even while seeming
useful: more email because email is cheap, more output because output is faster,
the freed hour recolonized by the next demand.

So amplification cuts two ways. Reaching *further in capability* — doing what you
genuinely couldn't alone — is real margin gained, and is what a window-tool is
for. Reaching *faster than you can integrate* spends a different margin — the
room a mind needs to metabolize — and a tool that tears down a person's pacing
overwhelms even as it amplifies. So the working test is not only *becoming over
engagement* but: **does this build margin, and for whom — maker, user,
beneficiary — or does it build margin for one by consuming another's?** (The
attention economy manufactures business-margin by spending the user's; that is
the counterfeit to watch for.) And margin built must be **defended**, or it
refills instantly and was never really created.

---

## Just Cause

> *A world where every person pursuing a worthy path has tools well-made enough
> to keep going.*

## How this grounds the scoring

Every heuristic and veto in `decision-heuristics.md` is this philosophy made
checkable — cite the ID there, reason from the *why* here:

- **Becoming over engagement** → H2 (capability over dependency), H3 (reach), and
  the leave-more-able metric. Its violations are V2 (dependency loops).
- **Attention is the counterfeit** → V1 (dark patterns), V2 (engagement mechanics).
  A feature built to want the user's attention over their becoming fails the test
  even when it "works".
- **Margin** → H4 (noise test — does removing it leave the user worse off?),
  H8 (borrowed resources — their time and attention are finite, and being spent).
- **The maker's responsibility sits on the builder's side of the glass** → H9
  (craft), H6 (earned trust). The form whispers stay or go; that is the maker's
  doing, and it is judged.

*Build it true.*
