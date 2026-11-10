import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { allowlistedEntry } from "./run-publish-plan.mjs";

// Before the job builds or stages anything, ask npm for a trusted-publishing token for every
// package in the plan, the same request npm makes in `npm stage publish`. A package whose
// trusted publisher does not match this run fails here, before any stage intent is written,
// so the stage step is skipped and a re-run of the same workflow run starts from nothing.
// The tokens are only checked for presence and then dropped; they are never printed.

export const REGISTRY = "https://registry.npmjs.org";
const AUDIENCE = "npm:registry.npmjs.org";

function escapedName(packageName) {
  return packageName.replace("/", "%2f");
}

function safeMessage(value) {
  return String(value ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
}

async function requestIdToken(env, fetchImpl) {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) {
    throw Object.assign(new Error("The job has no GitHub OIDC token request variables. Check `id-token: write` on the publish job."), {
      reasonCode: "oidc-unavailable",
    });
  }
  const response = await fetchImpl(`${url}&audience=${encodeURIComponent(AUDIENCE)}`, {
    headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
  });
  if (!response.ok) {
    throw Object.assign(new Error(`GitHub refused the OIDC token request with HTTP ${response.status}.`), {
      reasonCode: "oidc-unavailable",
    });
  }
  const body = await response.json();
  if (typeof body?.value !== "string" || body.value.length === 0) {
    throw Object.assign(new Error("GitHub returned no OIDC token."), { reasonCode: "oidc-unavailable" });
  }
  return body.value;
}

export async function checkTrustedPublisher(packageName, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const idToken = await requestIdToken(env, fetchImpl);
  const response = await fetchImpl(`${REGISTRY}/-/npm/v1/oidc/token/exchange/package/${escapedName(packageName)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, Accept: "application/json" },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok && typeof body?.token === "string" && body.token.length > 0) {
    return { packageName, ok: true, status: response.status };
  }
  return { packageName, ok: false, status: response.status, message: safeMessage(body?.message ?? body?.error ?? "") };
}

export async function checkTrustedPublishers(packages, options = {}) {
  const output = options.output ?? process.stdout;
  const results = [];
  for (const entry of packages) {
    if (allowlistedEntry(entry).filter !== entry.packageName) {
      throw Object.assign(new Error(`Publish plan names ${entry.packageName} for ${entry.packageKey}.`), { reasonCode: "plan" });
    }
    const result = await checkTrustedPublisher(entry.packageName, options);
    results.push(result);
    output.write(result.ok
      ? `ok trusted publisher ${result.packageName}\n`
      : `refused trusted publisher ${result.packageName}: HTTP ${result.status} ${result.message}\n`);
  }
  const refused = results.filter(result => !result.ok);
  if (refused.length > 0) {
    throw Object.assign(new Error(`npm refused the trusted publisher of ${refused.length} of ${results.length} packages: ${refused.map(result => result.packageName).join(", ")}. Nothing was staged. Correct the trusted publishers on npm, then re-run this workflow run.`), {
      reasonCode: "trusted-publisher",
    });
  }
  output.write(`Trusted publishers accepted: ${results.length} packages.\n`);
  return results;
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    const plan = JSON.parse(await readFile(path.resolve(process.argv[2] ?? "publish-plan.json"), "utf8"));
    if (!plan || !Array.isArray(plan.packages) || plan.packages.length === 0) throw new Error("Publish plan has no packages.");
    await checkTrustedPublishers(plan.packages);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
