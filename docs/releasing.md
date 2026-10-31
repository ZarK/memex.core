# Releasing

The packages in `packages/` are released to npm under the `@tjalve` scope. Each package has its own version.

## Staged publishing only

Every release uses npm staged publishing. These rules apply to every package and every version:

- No direct publish. Do not use `npm publish` or `pnpm publish`, from CI or by hand. The one exception is the one-time first publish of a brand-new package name, which only reserves the name.
- No npm token, in the repository, in GitHub, or on a local machine for this purpose.
- CI stages each version with `npm stage publish`, through npm trusted publishing (OIDC). The trusted publisher of each package allows only `npm stage publish`.
- The owner approves each staged version on npm. A version is public only after that approval.

The full procedure, the GitHub and npm settings, retries, the emergency release of one package and the first publish of a new name are in [release-controls.md](release-controls.md).

## In short

```bash
pnpm release:prepare --dry-run      # what changes, and the stage order
pnpm release:prepare --write        # on a branch; review and merge
pnpm release --dry-run              # on a clean, current main
pnpm release                        # pushes the signed set tag
pnpm release:approve -- <tag>       # after the Publish workflow succeeds
```

A brand-new package name first needs `node scripts/reserve-package-name.mjs <package>`, run once by the owner, and then its stage-only trusted publisher on npm.

## Using the packages

The repositories that use these packages pin exact versions and wait 14 days before they take a new third-party release. Our own packages are exempt from the wait, so a new version can be used at once. In `pnpm-workspace.yaml`:

```yaml
minimumReleaseAge: 20160
minimumReleaseAgeExclude:
  - '@tjalve/*'
```

In `.github/dependabot.yml`, the cooldown excludes `@tjalve/*` in the same way.
