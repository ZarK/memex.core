# Release controls

The packages in `packages/` are released to npm under the `@tjalve` scope from this
repository only, through npm staged publishing.

- A release starts when the owner pushes a publish tag. Merging to `main` never publishes.
- CI verifies the signed source, builds and tests the packages, and stages each new version
  with `npm stage publish`. It uses npm trusted publishing (OIDC): there is no npm token.
- The trusted publisher of each package allows only `npm stage publish`.
- The owner approves the staged versions on npm, with two-factor proof of presence. A version
  is public only after that approval.
- Nothing is published by hand from a workstation. The only exception is the one-time first
  publish of a brand-new package name (see [First publish of a new name](#first-publish-of-a-new-name)).

## GitHub controls

| Control | Setting |
| --- | --- |
| Environment `npm-publish` | Required reviewer: the owner (ZarK). Deployments only from tags that match `publish-*`. Administrators cannot bypass. |
| Ruleset "Publish tag creation" | Only the owner can create a `refs/tags/publish-*` tag. |
| Ruleset "Immutable publish tags" | Nobody can move or delete a `refs/tags/publish-*` tag. |
| Ruleset "protect main" | `main` cannot be deleted or force-pushed. |
| Actions | Only GitHub actions and `pnpm/action-setup`, each pinned to a full commit SHA. The default token is read-only. |

The environment cannot be limited to the `main` branch: a tag run is checked against the tag,
so a branch rule for `main` would refuse every release. The workflow checks `main` itself:
`scripts/verify-release-source.mjs` refuses a tag that is not a signed annotated tag, a commit
that GitHub has not verified as signed, and a commit that is not on `main`.

## npm trusted publisher

Configure each package on npmjs.com with this trusted publisher:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `ZarK` |
| Repository | `memex.core` |
| Workflow filename | `publish.yml` |
| Environment | `npm-publish` |
| Allowed action | `npm stage publish` |

Allow only `npm stage publish`. Do not allow direct publishing and do not create an npm token.

## Packages and their order

The release catalog is `RELEASE_PACKAGES` in `scripts/publish-packages.mjs`. A package comes
after every package of this repository that it depends on:

1. `@tjalve/memex-sqlite`
2. `@tjalve/memex-schema` (memex-sqlite)
3. `@tjalve/memex-storage`
4. `@tjalve/memex-archive` (memex-storage in its tests)
5. `@tjalve/memex-folders` (memex-storage)
6. `@tjalve/memex-import` (memex-archive, memex-folders, memex-schema, memex-sqlite)
7. `@tjalve/memex-facts` (memex-schema, memex-sqlite)
8. `@tjalve/memex-handles`
9. `@tjalve/memex-licenses`
10. `@tjalve/memex-surfaces` (memex-storage)
11. `@tjalve/memex-node-client` (memex-storage, memex-surfaces)
12. `@tjalve/memex-packs` (memex-node-client, memex-storage)
13. `@tjalve/memex-node-ui` (memex-node-client)
14. `@tjalve/memex-user-client` (memex-node-client, memex-sqlite, memex-storage, memex-surfaces)
15. `@tjalve/memex-desktop` (memex-storage; Electron is a peer dependency)

`pnpm release:check` (also part of the tests) fails when a public workspace package is
missing from the catalog, when the order is wrong, or when a package lacks its license,
repository, `files` or `publishConfig`, or has an install script.

In the repository the dependencies between packages are `workspace:*`. When CI stages a
package, it writes the exact version of each such dependency into the staged
`package.json` and puts the original back afterwards.

## Versions and the set version

Each package has its own version. The release set has a version too: the `version` of the
private root `package.json`. It names the set tag `publish-set-v<set version>`.

## Normal release

1. On a branch, generate the version changes:

   ```sh
   pnpm release:prepare --dry-run
   pnpm release:prepare --write
   ```

   The command finds the newest `publish-set-v*` tag reachable from HEAD, lists the
   packages that changed since then, and reads the live npm registry. It raises the patch
   version of each changed package once, and of each package that depends on a changed
   package at run time, and keeps a first version that is not on npm yet. When the set tag
   of the current set version is already on an older commit, it advances the set version
   once. It updates the lockfile with install scripts off. Before the first release there is
   no set tag, so every package counts as changed and keeps its unpublished version.

   Review and merge the changes through a normal pull request.

2. On a clean `main` that matches `origin/main`:

   ```sh
   git switch main
   git pull --ff-only origin main
   pnpm release --dry-run
   pnpm release
   ```

   `pnpm release --dry-run` prints the tag and the packages to stage, in order, and lists any
   package name that is not on npm yet. `pnpm release` refuses a dirty, stale, non-main or
   incompletely prepared checkout, refuses a package name that is not on npm, and refuses to
   move an existing tag. It creates the signed annotated tag and pushes only that tag.

3. The Publish workflow runs. The `publish` job waits for the owner's approval of the
   `npm-publish` environment on GitHub. Then it:

   - resolves the tag to the ordered plan (`scripts/resolve-publish-tag.mjs`), and repeats
     the preparation check, so a set tag pushed by hand on an unprepared commit fails;
   - installs with `pnpm install --frozen-lockfile --ignore-scripts`;
   - builds (`pnpm run build`), then runs the typecheck, the tests and the catalog check;
   - packs every package as it will be staged, installs the packed files into a folder
     outside the checkout with install scripts off and the 14-day minimum release age
     (`--min-release-age=14`, the same rule as `.npmrc`), imports every entry and starts
     every command with `--help` (`scripts/verify-installed-packages.mjs`). Its child
     processes do not get the job's OIDC token variables;
   - stages, in order, every version that is not on npm yet:

     ```sh
     npm stage publish . --access public --ignore-scripts --json
     ```

   The job prints one receipt (`MEMEX_STAGE_RECEIPT=`) that binds the ordered package names,
   versions, stage IDs and tarball shasums to the tag, the commit and the workflow run.
   Versions that are already public are skipped.

4. Approve the set:

   ```sh
   pnpm release:approve -- publish-set-v<set version>
   ```

   The command finds the successful workflow run for the tag, reads its receipt, and checks
   it against the local tag, `origin/main`, the package manifests at that commit, the active
   npm stages and the public registry. It shows the whole ordered set, asks you to type the
   tag, and then approves each stage with `npm stage approve`. npm asks for your two-factor
   proof of presence; the command does not bypass it.

   If approval stops part of the way, run the same command again. A package is skipped only
   when its public shasum matches the receipt.

## Retries

The job writes a checkpoint (`MEMEX_STAGE_CHECKPOINT=`) before staging and after each
confirmed stage, and an intent marker (`MEMEX_STAGE_INTENT=`) before each npm request. A
re-run of the same workflow run restores the latest checkpoint of an earlier attempt when it
matches the same run, tag, commit and package plan. If an attempt ended after an intent
without a confirming checkpoint, the re-run fails closed: inspect the npm stages by hand
instead of risking a second stage.

An earlier attempt that ended before its stage step ran counts as "nothing staged": the
stage step was skipped, or the publish job never started (`verify-source` failed, or the
`npm-publish` approval was rejected). When every earlier attempt is like that, the re-run
starts from an empty checkpoint, as the first attempt does. So after a failed
`verify-source` (for example a GitHub API error) or a rejected approval, re-run the same
workflow run.

If a re-run still fails closed and nothing from the set is public, the tag cannot be moved
or deleted and `pnpm release --retry` refuses (nothing to retry). The way out is a new
commit on `main`: `pnpm release:prepare --write` then advances the set version, because the
old set tag is on an older commit, and `pnpm release` creates the new set tag. For an
emergency package tag, raise that package's version.

If part of a set was approved and a later stage failed, keep the original tag. After the
pipeline is fixed on `main`:

```sh
pnpm release --retry --dry-run
pnpm release --retry
```

This creates the next free tag `publish-set-v<set version>-retry.<number>`. It requires the
original tag on `origin` as an ancestor of `main` and no change in any package folder since
that tag. The retry stages only the versions that are not public and writes a new receipt.

## Emergency release of one package

```sh
git tag -s publish-<package>-v<version> -m "Publish <package> <version>"
git push origin publish-<package>-v<version>
pnpm release:approve -- publish-<package>-v<version>
```

`<package>` is the npm name without the scope, for example `memex-node-client`. The tag
version must match the package's `package.json`. The workflow builds the package and the
workspace packages it depends on, runs its typecheck and tests, and stages only that package.
It refuses when a workspace package it depends on is not on npm at the exact version the
staged manifest names: release that one first, or use a set tag.

## First publish of a new name

npm staged publishing cannot create a package name, and the pipeline never falls back to a
direct publish. Each brand-new name is created once by the owner:

```sh
node scripts/reserve-package-name.mjs memex-sqlite
```

The script prints each step:

1. It refuses to run in CI or without an interactive terminal.
2. It finds the package in the release catalog.
3. It checks that the name is not on npm yet (if it is, it only prints the trusted publisher
   steps).
4. It shows your npm login (`npm whoami`). The login must own the `@tjalve` scope.
5. It writes the placeholder `<name>@0.0.0-reserve` in a temporary folder: `package.json`,
   `README.md` and `LICENSE` only, with no code and no scripts.
6. It lists what npm would publish and stops if that is not exactly those three files.
7. It asks you to type the package name, then runs
   `npm publish <folder> --access public --tag reserve --ignore-scripts`. npm asks for your
   two-factor code (or pass `--otp <code>`).
8. It waits until the registry shows the name and prints the trusted publisher settings to
   enter on npmjs.com.

`--dry-run` does everything except the publish. `--yes` skips only the typed confirmation of the name; npm still asks for your two-factor approval of every publish. `--no-wait` skips the wait for the public registry; check all names at the end with `npm access list packages @tjalve` and `npm trust list`. A name that is already in your account counts as reserved, even while the public registry has not caught up. Run it for one name at a time, in the order
above. After each name, configure its stage-only trusted publisher (the table above) and wait
until `npm view <name> versions` shows it. Only then does `pnpm release` accept the set.

The placeholder is a prerelease under the dist-tag `reserve`. The first approved release
becomes `latest`. Release preparation ignores `-reserve` versions. You can mark a placeholder
as deprecated with `npm deprecate <name>@0.0.0-reserve "<message>"`.

## Using the packages

Install with exact versions and install scripts off:

```sh
pnpm add --save-exact --ignore-scripts @tjalve/memex-storage@<version>
```

Repositories that use these packages keep a 14-day wait for third-party releases and exempt
`@tjalve/*` (`minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, and the Dependabot cooldown).
