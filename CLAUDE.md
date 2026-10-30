# router-for-me

My fork of the CLIProxyAPI stack: `CLIProxyAPI/` (Go backend: proxy, management API, plugin host) and `Cli-Proxy-API-Management-Center/` (React dashboard, shipped as one `management.html`). The goal is a better dashboard for me to work with. When the dashboard needs more from the backend, we add it where it fits best, in a plugin of ours or in the core. It is one repo of mine: both upstreams are git subtrees, and this file, `.claude/`, our plugins in `plugins/` and anything else we add live beside them.

## A quick note

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

Treat the rest of this file as good defaults rather than hard rules, with one exception: the hazards below are not negotiable. The developer's preferences override everything else here.

## Hazards

When we run into one, something that must never happen here because it breaks something live, leaks a secret or can't be undone, add it to this list right away as a single line: the rule and why.

- Never start a second proxy on a copy of `deploy/data/`. OAuth refresh tokens rotate, so whichever instance refreshes first leaves the other holding a dead token, and that can be the live one.
- Never write `*.json` files anywhere under `deploy/data/` except credentials. The backend walks that tree and loads every `*.json` as a credential, so plugin data uses another extension (`usage-stats` writes `.jsonl`).

## Upstream's own guidance

Each upstream ships an `AGENTS.md` with its layout, commands and conventions. Because this `CLAUDE.md` exists, Claude Code no longer reads `AGENTS.md` on its own, so both are imported here:

@CLIProxyAPI/AGENTS.md
@Cli-Proxy-API-Management-Center/AGENTS.md

Follow them, except where this file says otherwise. Don't edit them: our guidance lives here, and edits there only add merge conflicts.

## Fork discipline

Upstream ships more than one release a day and touches hundreds of files per minor version. Every line we change in an upstream file is a line that can conflict on the next sync.

- **Our own plugins over third-party ones.** Use a third-party plugin only if it is open source, well maintained and not sketchy.
- **Keep the diff against upstream small.** Put new logic in new files. When an upstream file must change, make the smallest hunk that works. Don't reformat, rename, move or tidy upstream code we don't need to touch. `scripts/fork-diff.sh` is the record of what the fork changes.
- **Syncing.** `scripts/sync-upstream.sh` merges an upstream release into each subtree with `git subtree merge --squash` (see `docs/operations/syncing-upstream.md`). Never rebase or force-push `main`. The backend and dashboard move together, as a matching pair of releases: the dashboard only speaks the v8 management API, and a dashboard newer than its backend breaks.

## Pattern consistency

Consistency over novelty, and in a fork it also keeps merges cheap. When adding code, match what is already here.

1. **Look for an analog first.** The closest existing feature, page, endpoint or executor. If one clearly applies, mirror its layout, naming and abstractions, and name the file you are mirroring in your first update.
2. **Partial analogs are normal.** Mirror what applies, use judgment on the rest, and call out where you diverged and why.
3. **No analog is fine when it is genuinely new.** Proceed and do not stall waiting for permission.
4. **Do not invent parallel patterns.** If upstream has a clear way to do something, do not roll a second one. This is the rule that is load-bearing, the rest is guidance.

If a strict mirror conflicts with my request, raise the conflict instead of silently deviating.

## Documentation

Most code changes do not need a documentation change. You can read the code. Our docs live in `docs/`. Upstream's READMEs and docs inside the subtrees are theirs: don't edit them.

- `docs/internals/` holds decisions and their reasons, constraints that span the backend, dashboard and plugins, and traps the source does not reveal. That includes why we diverged from upstream when the reason spans more than one file, or when it affects syncing. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the code answers the question, leave it out.
- Do not document features, enumerate fields, endpoints or settings, narrate control flow, keep file catalogs, or append summaries of merged work. The code, its types and the git history already record the implementation.
- No general education. How git subtree or OAuth refresh works in the abstract is not a document here. State our decision and link the spec for the concept.
- Reasoning local to one function is a code comment next to it. Reasoning that crosses files, layers or the backend/dashboard boundary goes in an internals page. Link to the source with a relative path instead of copying it.
- When a documented decision or constraint changes, rewrite or delete the affected text. Do not append a second account of the new behavior. A new page needs a distinct, durable reason to exist.
- `docs/operations/` holds maintainer procedures, such as syncing with upstream or building and deploying. Long and procedural is fine there.
- `docs/README.md` is the index. A page it does not link does not exist.
- Read the page before touching its subsystem.

## Taste

- Comments describe how a thing is used, and move when the code moves. Use them mostly to describe functions, not to annotate every line of behavior. Prefer a better name over a comment, and when a block really needs one, one line stating the non-obvious invariant is the budget.
- Make every change as simple as possible and touch only what is necessary. Senior developer standards, no laziness.
- Carry a refactor of our own code all the way. Once the mechanical part is done, sweep for anything that exists only because of the old world and delete it. Upstream code we didn't otherwise need to touch stays as it is.
- In the dashboard, ship the smallest set of controls that covers the ask. Add no advice, disclaimers or text that repeats what the screen already shows, unless I ask for it. A placeholder is never bigger than its label, and an error is a short label with no full stop.
- Security is important, but should not be over-indexed on for local development setup and maintainer-only tooling. The secret hazards above still hold.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.
- Commit subjects are plain imperative sentences, like `Add per-key usage page to the dashboard`, not upstream's Conventional Commits. No `Co-Authored-By` trailer, here or in any repository of ours.
