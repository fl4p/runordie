# Git hooks

## `pre-commit` — auto-stamp the menu build version

Stamps the current commit datetime (UTC) into the `.mver` line of `index.html`
(the "RUN OR DIE · v…" tag shown at the bottom of the menu), so the displayed
build version never goes stale. It only fires when `index.html` is part of the
commit, and is written defensively so it can never block a commit.

### Enable (once per clone — `core.hooksPath` lives in `.git/config`, which isn't committed)

```sh
git config core.hooksPath .githooks
```

Worktrees share the same config, so this covers them too. Deploy is unchanged:
GitHub Pages serves `master:index.html` directly, and the stamp is already baked
into the committed file.
