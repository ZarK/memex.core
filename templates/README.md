# Templates

## born-clean

The files every new Memex repository starts with, so its history never holds private data. Copy the contents of
[`born-clean`](born-clean) into the first commit of the new repository, then fill in the placeholders.

Before the first commit:

1. Add the `LICENSE` of the repository's group, with its full text: AGPL-3.0-or-later for apps, services and headless
   tools, MIT for libraries and clients (with the owner's name), GPL-3.0-or-later for ComfyUI nodes. Set the same id in
   `package.json` (`"license"`) and in the `license` input of `ci.yml`. The CI's `memex-licenses own` step fails
   without it.
2. Replace `<40-character commit SHA of memex.core>` in `ci.yml` with a commit of memex.core main, and set the
   `stack`, `build`, `typecheck` and `test` inputs.
3. Commit the lockfile: `pnpm-lock.yaml`, `package-lock.json`, or for .NET a `packages.lock.json` per project
   (`RestorePackagesWithLockFile` in `Directory.Build.props`). A repository without third-party dependencies says why
   in `memex-licenses.json` (`"noDependencies": "<reason>"`); otherwise `memex-licenses check` fails when it reads
   nothing.

| File | What it does |
| --- | --- |
| `.gitignore` | Keeps dependencies, build output, databases, keys, `.env` files, and scratch folders out of the repository. |
| `tests/fixtures/SOURCES.md` | Where each fixture comes from and its license. Fixtures are synthetic (made by a real program from made-up data) or from a public corpus. |
| `.npmrc`, `pnpm-workspace.yaml` | Exact versions, no install scripts, packages at least 14 days old. |
| `.github/workflows/ci.yml` | The CI: it calls [`reusable-ci.yml`](../.github/workflows/reusable-ci.yml) of memex.core, pinned by commit SHA. |
| `.github/dependabot.yml` | Weekly updates with a 14-day cooldown, for npm and the CI actions. |

## Settings outside the repository

A Memex app keeps nothing of a person in its repository or its install folder:

- Data in its data folder: `~/Memex/<App>`, or the folder that `MEMEX_<APP>_HOME` names (`@tjalve/memex-storage`).
- Settings in the data folder, or for a setting of one computer in the OS settings folder.
- Keys and passwords in the OS credential store: Windows Credential Manager, the macOS Keychain, or the Secret Service
  on Linux. CI proves the Linux path in a D-Bus session with gnome-keyring (the `keyring-test` input of the reusable
  CI).
- Caches and logs in the OS cache and log folders.

## The reusable CI

`reusable-ci.yml` runs, on every pull request, on Linux:

- gitleaks 8.30.1 (checked by SHA-256) on the commits of the pull request;
- `memex-licenses own` (the repository's own license against its group) and `memex-licenses check` (its dependencies);
- the install with a frozen lockfile and no install scripts (for .NET: exactly the SDK of `global.json`, then
  `dotnet restore --locked-mode`), then build,
  typecheck and tests;
- `memex-surfaces check` against the running app, when the repository has one (`surfaces-app`, `surfaces-start`);
- the Linux Secret Service, when the repository keeps keys there (`keyring-test`).

On main, a public repository also runs build, typecheck and tests on Windows and macOS. A private repository runs on
Linux only while it is private (`github.event.repository.private`), to stay within the Actions minutes of GitHub
Free. The workflow has no token permissions beyond reading the repository, and it never runs on
`pull_request_target`. A new push cancels the older run of the same pull request, but never a run on main, so the
commits of every push are checked.

## Dependabot

Dependabot proposes updates once a week, after a 14-day cooldown (`.github/dependabot.yml`), and security updates at
once. A proposal is checked by the CI like any pull request. The update itself lands as a commit by the owner that makes
the same change (and regenerates the lockfile with pnpm), because the history of a Memex repository holds only the
owner's commits. Dependabot then closes its pull
request, or the owner closes it with the reason. A fixed version younger than 14 days waits until it is 14 days old.

In memex.core the `DCO` check is required on main. It reads the commits of a pull request and needs a sign-off on
every commit, except the commits of the owner and of Dependabot in their own pull requests.
