# router-for-me

My fork of the CLIProxyAPI stack: `CLIProxyAPI/` (Go backend: proxy, management API, plugin host) and `Cli-Proxy-API-Management-Center/` (React dashboard, shipped as one `management.html`). The goal is a better dashboard for me to work with. When the dashboard needs more from the backend, I write my own plugins and edit the core where a plugin can't do it. It is one repo of mine: both upstreams are git subtrees, and this file, `.claude/`, our plugins in `plugins/` and anything else we add live beside them.

## A quick note

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

Treat the rest of this file as good defaults rather than hard rules, with one exception: the hazards below are not negotiable. The developer's preferences override everything else here.

## Hazards

[TBD]

## Upstream's own guidance

Each upstream ships an `AGENTS.md` with its layout, commands and conventions. Because this `CLAUDE.md` exists, Claude Code no longer reads `AGENTS.md` on its own, so both are imported here:

@CLIProxyAPI/AGENTS.md
@Cli-Proxy-API-Management-Center/AGENTS.md

Follow them, except where this file says otherwise. Don't edit them: our guidance lives here, and edits there only add merge conflicts.

## Fork discipline

Upstream ships more than one release a day and touches hundreds of files per minor version. Every line we change in an upstream file is a line that can conflict on the next sync.

- **Dashboard first, then a plugin, then core.** A dashboard feature that needs backend data gets it from a plugin of ours (`management.register` routes under `/v0/management/...`). Edit the core when a plugin can't do the job.
- **Our own plugins over third-party ones.** Use a third-party plugin only if it is open source, well maintained and not sketchy.
- **Keep the diff against upstream small.** Put new logic in new files. When an upstream file must change, make the smallest hunk that works. Don't reformat, rename, move or tidy upstream code we don't need to touch. `git diff backend/<tag> HEAD:CLIProxyAPI` (and `panel/<tag>` for the dashboard) is the record of what the fork changes.
- **Syncing.** `git subtree merge --squash` an upstream release tag into its directory (see `README.md`). Never rebase or force-push `main`. The backend and dashboard move together, as a matching pair of releases: the dashboard only speaks the v8 management API, and a dashboard newer than its backend breaks.

## Pattern consistency

Consistency over novelty, and in a fork it also keeps merges cheap. When adding code, match what is already here.

1. **Look for an analog first.** The closest existing feature, page, endpoint or executor. If one clearly applies, mirror its layout, naming and abstractions, and name the file you are mirroring in your first update.
2. **Partial analogs are normal.** Mirror what applies, use judgment on the rest, and call out where you diverged and why.
3. **No analog is fine when it is genuinely new.** Proceed and do not stall waiting for permission.
4. **Do not invent parallel patterns.** If upstream has a clear way to do something, do not roll a second one. This is the rule that is load-bearing, the rest is guidance.

If a strict mirror conflicts with my request, raise the conflict instead of silently deviating.

## Documentation

Most changes need no documentation. Why we diverged from upstream goes in the commit message, plus a one-line comment at the patch site when the reason isn't obvious from the code. No feature docs, file catalogs or summaries of merged work. Don't edit upstream's README or docs.

## Taste

- Comments describe how a thing is used, and move when the code moves. Use them mostly to describe functions, not to annotate every line of behavior. Prefer a better name over a comment, and when a block really needs one, one line stating the non-obvious invariant is the budget.
- Make every change as simple as possible and touch only what is necessary. Senior developer standards, no laziness.
- Carry a refactor of our own code all the way. Once the mechanical part is done, sweep for anything that exists only because of the old world and delete it. Upstream code we didn't otherwise need to touch stays as it is.
- In the dashboard, ship the smallest set of controls that covers the ask. Add no advice, disclaimers or text that repeats what the screen already shows, unless I ask for it. A placeholder is never bigger than its label, and an error is a short label with no full stop.
- Security is important, but should not be over-indexed on for local development setup and maintainer-only tooling. The secret hazards above still hold.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.
- Commit subjects are plain imperative sentences, like `Add per-key usage page to the dashboard`, not upstream's Conventional Commits. No `Co-Authored-By` trailer, here or in any repository of ours.
