import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_VERSION = "2026-03-10";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9_.-]+$/;
const TAG_PATTERN = /^publish-[A-Za-z0-9._-]+$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw Object.assign(new Error(`${label} is missing or malformed.`), { reasonCode: "release-source" });
  }
  return value;
}

function parseRepository(value) {
  const parts = typeof value === "string" ? value.split("/") : [];
  if (parts.length !== 2 || parts.some(part => !REPOSITORY_PART_PATTERN.test(part))) {
    throw Object.assign(new Error("GITHUB_REPOSITORY must contain one owner and repository name."), { reasonCode: "release-source" });
  }
  return { owner: parts[0], repo: parts[1] };
}

function requireTagName(value) {
  if (typeof value !== "string" || !TAG_PATTERN.test(value)) {
    throw Object.assign(new Error("The release tag name is missing or malformed."), { reasonCode: "release-source" });
  }
  return value;
}

async function readGithubJson(fetchImpl, url, token, label) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw Object.assign(new Error(`${label} could not be read from GitHub.`), {
      reasonCode: "release-source-api",
      cause: error,
    });
  }
  if (!response?.ok) {
    throw Object.assign(new Error(`${label} could not be read from GitHub (HTTP ${response?.status ?? "unknown"}).`), {
      reasonCode: "release-source-api",
    });
  }
  try {
    const value = await response.json();
    if (!isRecord(value)) throw new Error("response root is not an object");
    return value;
  } catch (error) {
    throw Object.assign(new Error(`${label} returned malformed JSON.`), {
      reasonCode: "release-source-api",
      cause: error,
    });
  }
}

function requireValidVerification(value, label) {
  if (!isRecord(value) || value.verified !== true || value.reason !== "valid") {
    throw Object.assign(new Error(`${label} is not signed and verified by GitHub.`), {
      reasonCode: "release-source-signature",
    });
  }
}

export async function verifyReleaseIdentity(options) {
  const { owner, repo } = parseRepository(options.repository);
  const tagName = requireTagName(options.tagName);
  const eventSha = requireSha(options.eventSha, "The workflow commit");
  if (typeof options.token !== "string" || options.token.trim() === "") {
    throw Object.assign(new Error("GITHUB_TOKEN is required for release-source verification."), { reasonCode: "release-source-api" });
  }
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;
  const ref = await readGithubJson(
    options.fetchImpl ?? fetch,
    `${baseUrl}/git/ref/tags/${encodeURIComponent(tagName)}`,
    options.token,
    "The release tag reference",
  );
  if (ref.ref !== `refs/tags/${tagName}` || !isRecord(ref.object) || ref.object.type !== "tag") {
    throw Object.assign(new Error("The release reference must point to an annotated tag object."), {
      reasonCode: "release-source-tag",
    });
  }
  const tagObjectSha = requireSha(ref.object.sha, "The annotated tag object SHA");
  const tag = await readGithubJson(
    options.fetchImpl ?? fetch,
    `${baseUrl}/git/tags/${tagObjectSha}`,
    options.token,
    "The annotated release tag",
  );
  if (tag.tag !== tagName || requireSha(tag.sha, "The returned tag object SHA") !== tagObjectSha
    || !isRecord(tag.object) || tag.object.type !== "commit") {
    throw Object.assign(new Error("The annotated release tag does not match its requested reference and commit target."), {
      reasonCode: "release-source-tag",
    });
  }
  requireValidVerification(tag.verification, "The annotated release tag");
  const commitSha = requireSha(tag.object.sha, "The release commit SHA");
  if (commitSha !== eventSha) {
    throw Object.assign(new Error("The signed tag target does not match the workflow commit."), {
      reasonCode: "release-source-mismatch",
    });
  }
  const commit = await readGithubJson(
    options.fetchImpl ?? fetch,
    `${baseUrl}/commits/${commitSha}`,
    options.token,
    "The release commit",
  );
  if (requireSha(commit.sha, "The returned commit SHA") !== commitSha || !isRecord(commit.commit)) {
    throw Object.assign(new Error("The release commit response does not match the signed tag target."), {
      reasonCode: "release-source-mismatch",
    });
  }
  requireValidVerification(commit.commit.verification, "The release commit");
  return { owner, repo, tagName, commitSha, tagObjectSha };
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw Object.assign(new Error((result.stderr ?? "").trim() || `git ${args.join(" ")} failed.`), {
      reasonCode: "release-source-git",
    });
  }
  return String(result.stdout ?? "").trim();
}

export function verifyReleaseCheckout(commitSha, root = DEFAULT_ROOT, git = { run: runGit }) {
  const checkoutSha = requireSha(git.run(["rev-parse", "HEAD"], root), "The checked-out commit SHA");
  if (checkoutSha !== commitSha) {
    throw Object.assign(new Error("The checked-out commit does not match the signed release tag."), {
      reasonCode: "release-source-mismatch",
    });
  }
  git.run(["fetch", "--no-tags", "origin", "main"], root);
  try {
    git.run(["merge-base", "--is-ancestor", commitSha, "origin/main"], root);
  } catch (error) {
    throw Object.assign(new Error("The signed release commit is not reachable from protected main."), {
      reasonCode: "release-source-branch",
      cause: error,
    });
  }
  return { checkoutSha, baseRef: "origin/main" };
}

export async function verifyReleaseSource(options) {
  const identity = await verifyReleaseIdentity(options);
  const checkout = verifyReleaseCheckout(identity.commitSha, options.root ?? DEFAULT_ROOT, options.git);
  return { ...identity, ...checkout };
}

export async function main(env = process.env) {
  const result = await verifyReleaseSource({
    repository: env.GITHUB_REPOSITORY,
    tagName: env.GITHUB_REF_NAME,
    eventSha: env.GITHUB_SHA,
    token: env.GITHUB_TOKEN,
    root: env.GITHUB_WORKSPACE || DEFAULT_ROOT,
  });
  process.stdout.write(`Verified signed release source ${result.tagName} at ${result.commitSha}.\n`);
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
