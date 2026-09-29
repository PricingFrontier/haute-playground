# Running the playground

How the "Try in browser" playground on pricing-frontier.co.uk is run. This folder is kept
out of the session image (`.dockerignore`), so visitors never see it.

## The parts

- **Session image** `ghcr.io/pricingfrontier/haute-playground:latest`: plain `haute serve`
  on this repo's project. GitHub Actions (`.github/workflows/image.yml`) builds and checks
  it on every push to `main` that touches anything outside `launcher/`.
- **Sessions** run in the Fly app `pricing-frontier-playground`, one machine per visitor
  (`shared-cpu-4x`, 2 GB).
- **Launcher** (this folder) is the Fly app `pricing-frontier-launcher` at
  `play.pricing-frontier.co.uk`. It keeps a pool of ready session machines, hands one to
  each visitor, proxies their traffic, and ends sessions. Its settings are the `[env]` in
  `fly.toml`.

## Updating Haute

1. **Release Haute** (in the haute repo):
   1. Bump the version in a pull request: `uv version --bump patch --no-sync`. Then
      revert `uv.lock` to only Haute's own `version` line, because a full re-lock can
      reshuffle unrelated wheels.
   2. Merge it and wait for main's CI to pass for the merge commit. Release refuses a
      commit whose CI is still running, and it refuses a version PyPI already has.
   3. Run **Actions → Release → Run workflow** on `main`. Check that PyPI serves the new
      files (`https://pypi.org/project/haute/<version>/`); the JSON API can lag a few
      minutes.
2. **Point the playground at it** (this repo):
   1. In `pyproject.toml`, raise the pin to the new version (`haute>=X.Y.Z`).
   2. Run `uv lock --upgrade-package haute --refresh-package haute`. Only Haute's
      entries in `uv.lock` should change.
   3. Commit and push `main`. If Haute's Git panel has checked out
      `initial-pipeline-save` (it does when Haute runs in this folder), commit there,
      then `git branch -f main HEAD` and `git branch -f initial-pipeline HEAD` before
      `git push origin main`.
3. **Wait for the image.** The "Session image" workflow builds it, runs the proxy and
   lockdown checks, and pushes `:latest`, in about 7 minutes. Watch it with
   `gh run watch --repo PricingFrontier/haute-playground`.
4. **Refresh the pool.** Pool machines keep the image they were created with, so new
   visitors would still get the old Haute:

   ```
   launcher/refresh-pool.sh --dry-run   # the idle machines it would replace
   launcher/refresh-pool.sh
   ```

   It destroys only idle pool machines, never a session in use, and the launcher refills
   the pool on the new image within a minute or so. Sessions in use keep the old image
   until they end (30 minutes at most).
5. **Check it.** Start a session on the live site; Haute's toolbar shows its version.

The launcher itself does not need redeploying for a Haute update.

## Changing launcher settings

Edit `[env]` in `fly.toml`, then deploy from this folder: `fly deploy --ha=false`. It must
stay one machine, because it holds the claims in progress. Sessions in progress survive a
redeploy; Haute reconnects within about a second.

- `MAX_SESSIONS`: visitors at once. `MAX_SESSIONS_PER_IP`: per address.
- `POOL_RUNNING`: running pool machines, which hand over at once.
- `POOL_SUSPENDED`: suspended pool machines, which resume in about 2 s and cost only
  storage while they wait.
- `SESSION_MINUTES` and `SESSION_IDLE_SECONDS`: when sessions end.
- `ALLOWED_ORIGINS`: the pages that may start sessions. Add a local origin here for a
  while to try a local copy of the site.

## Usage

The launcher logs one JSON line per event and no IP addresses:

```
fly logs -a pricing-frontier-launcher --no-tail | grep session_claimed
```

Fly keeps only a short recent buffer, a couple of hours at most.
