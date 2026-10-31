# Releasing a Memex desktop app

Every Memex desktop app is released by the reusable workflows
[`desktop-release.yml`](../.github/workflows/desktop-release.yml) and
[`desktop-draft-release.yml`](../.github/workflows/desktop-draft-release.yml) of this repository. The app's repository calls them
on a `v<X.Y.Z>` tag, or on a release candidate tag `v<X.Y.Z>-rc.<N>` (the beta channel; its draft is marked as a
prerelease). The package versions must match the tag (`1.0.0-rc.1` for `v1.0.0-rc.1`). The workflow builds the
installers on Windows, macOS and Linux, checks them and starts each one on a clean GitHub runner. The app's own checks
run next, and then the second workflow makes a draft GitHub release. The owner reads the draft and publishes it.

## What a release run does

| Job | Runs on | Does |
| --- | --- | --- |
| Plan | Linux | Decides release or dry run, and where macOS builds. Only a push of a `v<X.Y.Z>` tag is a release. |
| Gates | Linux | Frozen install with no install scripts, build, the version check (the `package.json` files agree, and match the tag of a release), typecheck and tests. |
| Installers | Windows, macOS, Linux | Electron from its release zip (checked by SHA-256), the app's `prepare` commands, `memex-desktop pack` (CLI shims, electron-builder with the Memex base config, the `app.asar` check, `SHA256SUMS.txt`). Uploads the installers with `SHA256SUMS-<os>.txt`, and the extracted contents of each build as `desktop-contents-<os>`. |
| Smoke test | Windows, macOS, Linux (always GitHub runners) | Checks the checksums, installs each installer into a scratch folder (NSIS silent per user; the dmg copied out of its image, with its signature checked; the deb with apt; the AppImage) and starts the app with `MEMEX_DESKTOP_SMOKE`: it must start its server, show its first page and quit by itself. Uploads a picture and the text of the page. |
| Release set | Linux | Joins the three `SHA256SUMS-<os>.txt` into one `SHA256SUMS.txt` after it checks every digest against the downloaded bytes and that every platform is there (`memex-desktop checksums --merge`). |
| Build provenance | Linux | Release of a public repository only. GitHub artifact attestations for every installer. No checkout. GitHub makes attestations for private repositories only on Enterprise Cloud, so a private app repository releases without them and its release notes say so. |
| Draft release | Linux | Release only, from `desktop-draft-release.yml` after the app's own checks. A draft release for the tag with the installers and `SHA256SUMS.txt`, and notes that say how to check a download and how to open an unsigned app. A prerelease for an rc tag. It refuses a tag that has a release already. No checkout. |

Every other run (a branch push, a manual run) is a dry run: the same builds and smoke tests, with the
installers kept as workflow artifacts for 7 days, and no attestations and no release.

An app with `builder.updates` also publishes the update files that its installed copies read: `latest.yml` (`rc.yml`
for a release candidate), `latest-linux.yml` and the blockmaps. Each build job uploads them with its installers
(`UPDATE-FILES-<os>.txt` lists them), the release set joins them, and the draft release attaches them. See
[Updates](../packages/desktop/README.md#updates).

The installers are named `<Product.With.Dots>-<version>-<windows|macos|linux>-<arch>.<ext>`:

| System | Installer |
| --- | --- |
| Windows | `.exe` (NSIS, x64, per user, no administrator) |
| macOS | `.dmg` (arm64) |
| Linux | `.AppImage` and `.deb` (x64) |

## Signing

Nothing is signed yet. Windows installers and programs are unsigned. macOS builds carry an ad-hoc signature with the
hardened runtime (an unsigned bundle with changed fuses does not start on Apple silicon). Signing comes with the
Developer ID and notarization on macOS and the OV certificate on Windows; until then the draft release notes say how to
open an unsigned app (Windows SmartScreen "More info, Run anyway"; macOS System Settings, Privacy & Security, "Open
Anyway").

## The contents of a build

`memex-desktop extract <release> --out <dir>` writes, for each build, the files of `app.asar` (and
`app.asar.unpacked`) and the rest of the `resources` folder (the CLI shims and the notices). Electron's own files are
left out: they are the same for every app. The folder is the `desktop-contents-<os>` artifact of the run, so that the
app's own release workflow can run its checks on what the build ships before it makes the draft.

`extract` writes the files of first-party packages under `node_modules.first-party`. First-party means every
`@tjalve/*` package and every package that the app's nearest `pnpm-lock.yaml` does not take from the registry (`link:`
workspace packages, `file:` tarballs and folders, git and URL packages). Registry packages stay under `node_modules`.

## The smoke test

`MEMEX_DESKTOP_SMOKE=<absolute folder>` starts any app on the shell in smoke-test mode. The app runs as always (its
server, its folders, the token cookie, the sandbox). The shell records its events in `events.jsonl`; when the first
page of the app has loaded, it writes `window.png`, `window.txt` and `result.json` and quits. When the crash screen
shows instead, `result.json` says why. `memex-desktop smoke --program <installed program> --out <empty folder>` starts
the app this way and fails unless the first page answered with HTTP 2xx (a server error page also loads in the window),
shows text, was captured as a picture, and the app quit by itself. `--expect <text>` (the workflow input
`smoke-expect`) also requires that text on the first page; the shell waits up to 20 seconds for it, because a page
fills in after it has loaded.

## An app's release workflow

`.github/workflows/release.yml` in the app's repository:

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions: {}

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  desktop:
    uses: ZarK/memex.core/.github/workflows/desktop-release.yml@<40-character memex.core commit SHA>
    permissions:
      contents: read
      id-token: write      # build provenance
      attestations: write  # build provenance
    with:
      app-directory: desktop
      artifact-base: Memex.Photos
      typecheck: pnpm typecheck
      test: pnpm test
      smoke-expect: Memex Photos   # text the first page must show
      prepare: |
        node "$MEMEX_CORE/packages/licenses/dist/bin.js" check --repo "$GITHUB_WORKSPACE" --electron-dist node_modules/electron/dist
        node "$MEMEX_CORE/packages/licenses/dist/bin.js" notices --out build/notices --repo "$GITHUB_WORKSPACE" --electron-dist node_modules/electron/dist --product "Memex Photos"
      macos-runner: github   # self-hosted once the release Mac serves this repository

  checks:
    needs: desktop
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - run: echo "The app's own checks of the run's artifacts go here."

  draft:
    needs: [desktop, checks]
    if: needs.desktop.outputs.release == 'true'
    uses: ZarK/memex.core/.github/workflows/desktop-draft-release.yml@<the same SHA>
    permissions:
      contents: write      # the draft release
    with:
      tag: ${{ needs.desktop.outputs.tag }}
      prerelease: ${{ needs.desktop.outputs.prerelease }}
      attested: ${{ needs.desktop.outputs.attested }}
      artifact-base: Memex.Photos
```

The app needs `electron` and `electron-builder` as exact dev dependencies and a `memex-desktop.config.mjs` (see the
memex-desktop README). The tools come from memex.core at the pinned commit, so the SHA moves the workflow and its tools
together. A dry run is the same call from a branch or with `workflow_dispatch`; memex.core runs one on Memex Hello for
every change of the desktop shell (`desktop-example.yml`).

## GitHub controls of an app repository

The owner sets these once per app repository. `<repo>` is the repository name.

Only the owner creates `v*` tags, and nobody moves or deletes one (the same rules as the `publish-*` tags here):

```bash
gh api -X POST repos/ZarK/<repo>/rulesets --input - <<'JSON'
{"name": "Release tag creation", "target": "tag", "enforcement": "active",
 "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
 "rules": [{"type": "creation"}],
 "bypass_actors": [{"actor_id": 39051, "actor_type": "User", "bypass_mode": "always"}]}
JSON
gh api -X POST repos/ZarK/<repo>/rulesets --input - <<'JSON'
{"name": "Immutable release tags", "target": "tag", "enforcement": "active",
 "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
 "rules": [{"type": "update"}, {"type": "deletion"}], "bypass_actors": []}
JSON
```

Workflow runs from outside contributors wait for approval. This alone does not keep a pull request away from a
self-hosted runner: an approved run can name any runner labels, and the approval page does not show them. The release
Mac's job hook (below) is what refuses every job that is not a release:

```bash
gh api -X PUT repos/ZarK/<repo>/actions/permissions/fork-pr-contributor-approval -f approval_policy=all_external_contributors
```

## The release Mac (self-hosted runner)

The macOS build of a release moves to the release Mac, where the Developer ID key will live. Until then it runs
on GitHub's macOS runners (`macos-runner: github`). The runner takes only release jobs. The workflow sends a job to it
only for a pushed release tag and stops at once if anything else reaches it, but any other workflow of the repository
could name the runner's labels. So the runner itself refuses every other job, with a job hook that the job cannot
change.

Rules for the runner:

- It runs as its own standard macOS user, `memexrelease`, never as the owner's account. A release job runs the app's
  build scripts and electron-builder, so it must not see the owner's home folder, the Memex data folders, the login
  keychain or the archive jobs.
- A separate user alone does not hide the owner's files. macOS puts every local user in the group `staff`, and a home
  folder is `drwxr-x---` with the group `staff`, so `memexrelease` can read every file in the owner's home folder that
  others may read. Step 1 closes the owner's home folder to other users and checks it.
- A job hook refuses every job that is not the repository's `release.yml` on a pushed `v<X.Y.Z>` or `v<X.Y.Z>-rc.<N>`
  tag: a branch push, a manual run, or a pull request run that the owner approved fail before their first step. The
  hook script belongs to root, and the launch daemon (also root's) names it, so a job cannot change it. The runner is
  not ephemeral: what one job leaves in `memexrelease`'s home stays for the next one, which is acceptable only because
  every job that runs there is the owner's own release build.
- Repositories on a personal account have no shared runners: each app repository registers its own runner, each in
  its own folder of `memexrelease`, with the labels `self-hosted`, `macOS`, `ARM64` and `memex-release`.
- It starts at boot as a launch daemon of `memexrelease`, so it does not need that user to be logged in. Release jobs
  build and sign; the smoke tests run on GitHub's runners.

The owner runs these steps on the release Mac. Creating the user, the hook and the launch daemon needs the administrator
password.

1. The runner user (standard account, no administrator rights), and the owner's home folder closed to other users:

   ```bash
   sudo sysadminctl -addUser memexrelease -fullName "Memex release runner" -password -
   chmod 700 "$HOME"
   # The check: this must fail with "Permission denied". Do not go on while it lists the folder.
   sudo -u memexrelease ls "$HOME"
   ```

   Data that lives outside the home folder (for example a Memex folder on another volume) needs the same check.

2. The job hook, owned by root:

   ```bash
   sudo mkdir -p /Library/Memex/runner
   sudo tee /Library/Memex/runner/job-started.sh > /dev/null <<'HOOK'
   #!/bin/sh
   # Refuses every job that is not the repository's release workflow on a pushed release tag.
   refuse() { echo "The release Mac refuses this job: $1"; exit 1; }
   [ "$GITHUB_EVENT_NAME" = push ] || refuse "the event is $GITHUB_EVENT_NAME, not a tag push."
   tag=${GITHUB_REF#refs/tags/}
   [ "refs/tags/$tag" = "$GITHUB_REF" ] || refuse "$GITHUB_REF is not a tag."
   printf '%s' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' || refuse "$tag is not a release tag."
   [ "$GITHUB_WORKFLOW_REF" = "$GITHUB_REPOSITORY/.github/workflows/release.yml@$GITHUB_REF" ] || refuse "the workflow is $GITHUB_WORKFLOW_REF."
   echo "Release job: $GITHUB_REPOSITORY $tag."
   HOOK
   sudo chown -R root:wheel /Library/Memex/runner
   sudo chmod 755 /Library/Memex/runner /Library/Memex/runner/job-started.sh
   # The check: both must print "The release Mac refuses this job".
   sudo -u memexrelease env GITHUB_EVENT_NAME=pull_request GITHUB_REF=refs/pull/1/merge /Library/Memex/runner/job-started.sh
   sudo -u memexrelease env GITHUB_EVENT_NAME=push GITHUB_REF=refs/tags/v1.0.0 GITHUB_REPOSITORY=ZarK/memex.photos \
     GITHUB_WORKFLOW_REF=ZarK/memex.photos/.github/workflows/other.yml@refs/tags/v1.0.0 /Library/Memex/runner/job-started.sh
   ```

3. Nothing else to install: the Xcode command line tools are already on the Mac for every user, and each job sets up
   Node.js and pnpm itself (`actions/setup-node`, `pnpm/action-setup`).

4. The runner, version 2.338.0 (checked by SHA-256), once per app repository:

   ```bash
   sudo -u memexrelease -i
   repo=memex.photos            # the app repository
   mkdir -p ~/runners/$repo && cd ~/runners/$repo
   curl -fsSL -o runner.tar.gz https://github.com/actions/runner/releases/download/v2.338.0/actions-runner-osx-arm64-2.338.0.tar.gz
   echo "df4cebda25c86a886ed204e49fee63f5c2e7cec5f447b5c98440a826bbdf9df2  runner.tar.gz" | shasum -a 256 -c -
   tar xzf runner.tar.gz
   # A registration token from the owner's account (valid one hour):
   #   gh api -X POST repos/ZarK/$repo/actions/runners/registration-token --jq .token
   ./config.sh --unattended --url https://github.com/ZarK/$repo --token <token> \
     --name m2max-$repo --labels memex-release --work _work
   exit
   ```

5. A launch daemon per runner, as `memexrelease`, with the job hook:

   ```bash
   repo=memex.photos
   dir=$(sudo -u memexrelease -i sh -c 'echo "$HOME"')/runners/$repo
   sudo tee /Library/LaunchDaemons/to.memex.runner.$repo.plist > /dev/null <<PLIST
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0"><dict>
     <key>Label</key><string>to.memex.runner.$repo</string>
     <key>UserName</key><string>memexrelease</string>
     <key>WorkingDirectory</key><string>$dir</string>
     <key>ProgramArguments</key><array><string>$dir/run.sh</string></array>
     <key>EnvironmentVariables</key><dict>
       <key>ACTIONS_RUNNER_HOOK_JOB_STARTED</key><string>/Library/Memex/runner/job-started.sh</string>
     </dict>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
     <key>StandardOutPath</key><string>$dir/runner.log</string>
     <key>StandardErrorPath</key><string>$dir/runner.log</string>
   </dict></plist>
   PLIST
   sudo launchctl bootstrap system /Library/LaunchDaemons/to.memex.runner.$repo.plist
   ```

6. In the app's release workflow, set `macos-runner: self-hosted`. The next release tag builds macOS on the release Mac;
   its log shows "Release job: ..." from the hook. To stop a runner: `sudo launchctl bootout system/to.memex.runner.<repo>`.

The runner updates itself when GitHub asks; GitHub refuses runners that are too old, so the version above only sets
the first install.
