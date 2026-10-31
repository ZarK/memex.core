import { writeFile } from "node:fs/promises";

export const RECEIPT_SCHEMA = "memex-stage-set/v1";
export const RECEIPT_MARKER = "MEMEX_STAGE_RECEIPT=";
export const CHECKPOINT_MARKER = "MEMEX_STAGE_CHECKPOINT=";
export const STAGE_INTENT_MARKER = "MEMEX_STAGE_INTENT=";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA1 = /^[0-9a-f]{40}$/i;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

function receiptError(message) {
  return Object.assign(new Error(message), { reasonCode: "invalid-receipt" });
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0) throw receiptError(`${label} is missing.`);
  return value;
}

export function parseStageOutput(stdout, expected) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw Object.assign(new Error("npm stage publish did not return valid JSON."), {
      reasonCode: "stage-output",
      cause: error,
    });
  }
  const candidates = [parsed, ...(parsed && typeof parsed === "object" ? Object.values(parsed) : [])];
  const item = candidates.find(candidate => candidate?.name === expected.packageName && candidate?.version === expected.version);
  if (!item) {
    throw Object.assign(new Error(`npm stage publish did not confirm ${expected.packageName}@${expected.version}.`), {
      reasonCode: "stage-output",
    });
  }
  if (!UUID.test(item.stageId ?? "")) {
    throw Object.assign(new Error(`npm stage publish returned an invalid stage ID for ${expected.packageName}@${expected.version}.`), {
      reasonCode: "stage-output",
    });
  }
  if (!SHA1.test(item.shasum ?? "")) {
    throw Object.assign(new Error(`npm stage publish returned an invalid shasum for ${expected.packageName}@${expected.version}.`), {
      reasonCode: "stage-output",
    });
  }
  return Object.freeze({
    packageKey: expected.packageKey,
    packageName: expected.packageName,
    version: expected.version,
    tag: "latest",
    stageId: item.stageId.toLowerCase(),
    shasum: item.shasum.toLowerCase(),
  });
}

export function createReceipt(context, plannedPackages, stagedPackages, complete = false) {
  return {
    schema: RECEIPT_SCHEMA,
    complete,
    repository: context.repository,
    tag: context.tag,
    headSha: context.headSha,
    runId: String(context.runId),
    runAttempt: String(context.runAttempt ?? "1"),
    expectedPackages: plannedPackages.map(entry => ({
      packageKey: entry.packageKey,
      packageName: entry.packageName,
      version: entry.version,
      tag: "latest",
    })),
    packages: stagedPackages.map(entry => ({ ...entry })),
  };
}

export function encodeReceipt(receipt) {
  return Buffer.from(JSON.stringify(receipt), "utf8").toString("base64url");
}

export function decodeReceipt(encoded) {
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (error) {
    throw Object.assign(new Error("The release receipt marker is invalid."), {
      reasonCode: "invalid-receipt",
      cause: error,
    });
  }
}

export function findCompleteReceipt(log) {
  const markers = String(log).split(/\r?\n/)
    .filter(line => line.includes(RECEIPT_MARKER))
    .map(line => line.slice(line.indexOf(RECEIPT_MARKER) + RECEIPT_MARKER.length).trim());
  if (markers.length !== 1) {
    throw receiptError(`Expected one complete release receipt, found ${markers.length}.`);
  }
  return decodeReceipt(markers[0]);
}

export function findResumeReceipt(log) {
  let latestReceipt = null;
  let pendingIntent = null;
  for (const line of String(log).split(/\r?\n/)) {
    const checkpointAt = line.indexOf(CHECKPOINT_MARKER);
    const completeAt = line.indexOf(RECEIPT_MARKER);
    const intentAt = line.indexOf(STAGE_INTENT_MARKER);
    if (checkpointAt >= 0 || completeAt >= 0) {
      const marker = checkpointAt >= 0 ? CHECKPOINT_MARKER : RECEIPT_MARKER;
      const markerAt = checkpointAt >= 0 ? checkpointAt : completeAt;
      latestReceipt = decodeReceipt(line.slice(markerAt + marker.length).trim());
      pendingIntent = null;
    } else if (intentAt >= 0) {
      pendingIntent = decodeReceipt(line.slice(intentAt + STAGE_INTENT_MARKER.length).trim());
    }
  }
  return { receipt: latestReceipt, pendingIntent };
}

export function writeStageIntent(context, entry, output = process.stdout) {
  const intent = {
    repository: context.repository,
    tag: context.tag,
    headSha: context.headSha,
    runId: String(context.runId),
    runAttempt: String(context.runAttempt),
    packageKey: entry.packageKey,
    packageName: entry.packageName,
    version: entry.version,
  };
  output.write(`${STAGE_INTENT_MARKER}${encodeReceipt(intent)}\n`);
  return intent;
}

export const PUBLISH_JOB_NAME = "publish";
export const STAGE_STEP_NAME = "Stage selected packages";

// The staging conclusion of an earlier workflow attempt, from its job metadata. When the
// publish job never started (verify-source failed, or the npm-publish approval was
// rejected), GitHub lists that job without steps or not at all: nothing can have been
// staged, so the attempt counts as skipped. A started job lists every step, skipped ones
// included, so a missing stage step in a started job stays unknown (null) and fails closed.
export function stageConclusionFromMetadata(metadata) {
  const jobs = Array.isArray(metadata?.jobs) ? metadata.jobs : [];
  const stageStep = jobs.flatMap(job => Array.isArray(job?.steps) ? job.steps : [])
    .find(step => step?.name === STAGE_STEP_NAME);
  if (stageStep) return typeof stageStep.conclusion === "string" && stageStep.conclusion ? stageStep.conclusion : null;
  const publishJobs = jobs.filter(job => job?.name === PUBLISH_JOB_NAME);
  if (publishJobs.length === 0) return "skipped";
  if (publishJobs.every(job => !Array.isArray(job?.steps) || job.steps.length === 0)) return "skipped";
  return null;
}

export function restoreReceiptAttempt(attempt, context, plannedPackages) {
  const attemptNumber = Number(attempt?.attempt);
  const currentAttempt = Number(context.runAttempt);
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber >= currentAttempt) {
    throw receiptError("Checkpoint workflow attempt is invalid.");
  }
  if (attempt.headSha !== context.headSha) throw receiptError("Checkpoint workflow head does not match.");

  const restored = findResumeReceipt(attempt.log);
  if (restored.pendingIntent) {
    throw receiptError(`Workflow attempt ${attemptNumber} ended during an npm staging request.`);
  }
  if (!restored.receipt) {
    if (attempt.stageConclusion !== "skipped") {
      throw receiptError(`Workflow attempt ${attemptNumber} has no trustworthy staging checkpoint.`);
    }
    return null;
  }
  if (String(restored.receipt.runAttempt) !== String(attemptNumber)) {
    throw receiptError(`Workflow attempt ${attemptNumber} contains a checkpoint from another attempt.`);
  }
  const staged = resumeReceipt(restored.receipt, context, plannedPackages);
  return createReceipt(context, plannedPackages, staged, restored.receipt.complete);
}

export function validateReceipt(receipt, expected = {}, options = {}) {
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) throw receiptError("The release receipt schema is not supported.");
  if (options.allowIncomplete !== true && receipt.complete !== true) throw receiptError("The release receipt is incomplete.");
  if (typeof receipt.complete !== "boolean") throw receiptError("Receipt completion state is invalid.");
  requireText(receipt.repository, "Receipt repository");
  requireText(receipt.tag, "Receipt tag");
  requireText(receipt.runId, "Receipt run ID");
  if (!/^[1-9][0-9]*$/.test(receipt.runAttempt ?? "")) throw receiptError("Receipt run attempt is invalid.");
  if (!COMMIT_SHA.test(receipt.headSha ?? "")) throw receiptError("Receipt head SHA is invalid.");
  if (expected.repository && receipt.repository !== expected.repository) throw receiptError("Receipt repository does not match.");
  if (expected.tag && receipt.tag !== expected.tag) throw receiptError("Receipt tag does not match.");
  if (expected.headSha && receipt.headSha !== expected.headSha) throw receiptError("Receipt head SHA does not match.");
  if (expected.runId && String(receipt.runId) !== String(expected.runId)) throw receiptError("Receipt run ID does not match.");
  if (!Array.isArray(receipt.expectedPackages) || receipt.expectedPackages.length === 0) {
    throw receiptError("Receipt package plan is empty.");
  }
  if (!Array.isArray(receipt.packages)
    || receipt.packages.length > receipt.expectedPackages.length
    || (receipt.complete && receipt.packages.length !== receipt.expectedPackages.length)) {
    throw receiptError("Receipt does not contain the complete package plan.");
  }
  const keys = new Set();
  const stages = new Set();
  for (let index = 0; index < receipt.packages.length; index += 1) {
    const planned = receipt.expectedPackages[index];
    const staged = receipt.packages[index];
    if (planned.packageKey !== staged.packageKey || planned.packageName !== staged.packageName
      || planned.version !== staged.version || planned.tag !== staged.tag) {
      throw receiptError(`Receipt package ${index + 1} does not match the ordered plan.`);
    }
    requireText(staged.packageKey, "Package key");
    requireText(staged.packageName, "Package name");
    requireText(staged.version, "Package version");
    if (staged.tag !== "latest") throw receiptError(`Unsupported dist-tag for ${staged.packageName}.`);
    if (!UUID.test(staged.stageId ?? "")) throw receiptError(`Invalid stage ID for ${staged.packageName}.`);
    if (!SHA1.test(staged.shasum ?? "")) throw receiptError(`Invalid shasum for ${staged.packageName}.`);
    if (keys.has(staged.packageKey) || stages.has(staged.stageId)) throw receiptError("Receipt contains duplicate packages or stage IDs.");
    keys.add(staged.packageKey);
    stages.add(staged.stageId);
  }
  return receipt;
}

export function resumeReceipt(receipt, context, plannedPackages) {
  validateReceipt(receipt, {
    repository: context.repository,
    tag: context.tag,
    headSha: context.headSha,
    runId: context.runId,
  }, { allowIncomplete: true });
  const expected = plannedPackages.map(entry => ({
    packageKey: entry.packageKey,
    packageName: entry.packageName,
    version: entry.version,
    tag: "latest",
  }));
  if (JSON.stringify(receipt.expectedPackages) !== JSON.stringify(expected)) {
    throw receiptError("Checkpoint package plan does not match this release.");
  }
  return receipt.packages.map(entry => Object.freeze({ ...entry }));
}

export async function saveReceipt(receipt, filePath, output = process.stdout) {
  await writeFile(filePath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const prefix = receipt.complete ? RECEIPT_MARKER : CHECKPOINT_MARKER;
  output.write(`${prefix}${encodeReceipt(receipt)}\n`);
}

export function planApprovals(receipt, stages, publishedByName = new Map()) {
  validateReceipt(receipt);
  if (!Array.isArray(stages)) throw receiptError("npm staged package list is invalid.");
  return receipt.packages.map(entry => {
    const publishedVersions = publishedByName.get(entry.packageName);
    if (publishedVersions?.has(entry.version)) {
      const published = publishedVersions.get(entry.version);
      if (String(published).toLowerCase() !== entry.shasum) {
        throw receiptError(`Published shasum does not match for ${entry.packageName}@${entry.version}.`);
      }
      return Object.freeze({ ...entry, action: "skip-published" });
    }
    const matches = stages.filter(stage => stage?.id === entry.stageId);
    if (matches.length !== 1) throw receiptError(`Expected one active stage for ${entry.packageName}@${entry.version}.`);
    const stage = matches[0];
    if (stage.packageName !== entry.packageName || stage.version !== entry.version
      || stage.tag !== entry.tag || String(stage.shasum ?? "").toLowerCase() !== entry.shasum) {
      throw receiptError(`Active stage does not match the receipt for ${entry.packageName}@${entry.version}.`);
    }
    return Object.freeze({ ...entry, action: "approve" });
  });
}
