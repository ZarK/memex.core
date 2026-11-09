# How a pull request merges

A pull request merges through the review gate on the developer's computer. The pull request's author cannot approve
it, so the only approval that can come is the one of the review app `qube-review[bot]`, and it is given per commit.

## What the approval rests on

`qube aie pr gate <number>` runs three review lanes on the pull request head:

- `code-quality` and `security`: a reviewer model reads the change.
- `release-ci-supply-chain`: the CI checks of this repository, run on this computer by
  `~/.qube/memex-checks/memex-checks.mjs`.

The app approves a commit only when all three lanes pass for that commit. A failed check is a blocking finding. A
check that cannot run (for example a missing tool) leaves the lane inconclusive, and nothing is approved.

The checks are the ones of `.github/workflows/reusable-ci.yml`, with the inputs of `.github/workflows/ci.yml` on
`origin/main` (not from the pull request, so a pull request cannot weaken them), on a clean clone of the pull request
head with scratch data folders:

1. a locked install (`pnpm install --frozen-lockfile --ignore-scripts`), then the build, the typecheck and the tests
   of the CI file
2. the license checks (the repository's own license and the dependencies)
3. gitleaks on the commits of the pull request
4. the attribution check on the commits and the pull request text

The CI file also runs on GitHub, and the gate does not depend on it.

To run only the checks: `node ~/.qube/memex-checks/memex-checks.mjs run --repo . --head <sha> --pr <number>`. The
exit code is 0 when everything passed, 1 when a check failed and 2 when a check could not run.

## Opening a pull request

The review evidence is kept per issue, so a pull request closes an issue (`Closes #<number>` in its description).
Branch from current `origin/main`: the gate reads `.qube/aie/config.json` from the checkout and distrusts a pull
request that changes it. The pull request that adds the policy cannot be reviewed by it, so it merges once, on the
checks, the CI run and an independent review of its diff.
