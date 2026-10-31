import { access, copyFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ATTEMPTS = 8;
const DEFAULT_DELAY_MS = 25;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function retryFileOperation(operation, options) {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      failure = error;
      if (options.shouldRetry && !options.shouldRetry(error)) throw error;
      if (attempt < attempts) await (options.delay ?? delay)(delayMs);
    }
  }
  throw failure;
}

export async function restorePublishDependencies(packageJsonPath, options = {}) {
  const resolvedPackageJsonPath = path.resolve(packageJsonPath);
  const backupPath = `${resolvedPackageJsonPath}.publish-backup`;
  const retryOptions = {
    attempts: options.attempts,
    delayMs: options.delayMs,
    delay: options.delay,
  };
  try {
    await retryFileOperation(
      () => (options.access ?? access)(backupPath),
      { ...retryOptions, shouldRetry: error => error?.code !== "ENOENT" },
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: true, restored: false, packageJsonPath: resolvedPackageJsonPath };
    }
    throw error;
  }

  await retryFileOperation(
    () => (options.copyFile ?? copyFile)(backupPath, resolvedPackageJsonPath),
    retryOptions,
  );
  await retryFileOperation(() => (options.unlink ?? unlink)(backupPath), retryOptions);
  return { ok: true, restored: true, packageJsonPath: resolvedPackageJsonPath };
}

export async function main(argv = process.argv.slice(2)) {
  const packageJsonPath = path.resolve(argv[0] ?? "package.json");
  try {
    const report = await restorePublishDependencies(packageJsonPath);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, restored: false, packageJsonPath })}\n`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && path.normalize(process.argv[1]) === path.normalize(fileURLToPath(import.meta.url));
if (invoked) await main();
