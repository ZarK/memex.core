import type { ListedFile } from "./types.js";

/** A file changed less than this long ago is still being written. */
export const DEFAULT_QUIET_MS = 10_000;

/**
 * Whether a file is still settling: its modification time or its creation time is less than `quietMs` before `nowMs`.
 * The creation time catches a copy in progress, because a copy keeps the source's modification time. A time after
 * `nowMs` (a clock that runs ahead) does not count, so that such a file is not held back forever.
 */
export function isSettling(file: Pick<ListedFile, "modifiedMs" | "createdMs">, nowMs: number, quietMs: number = DEFAULT_QUIET_MS): boolean {
  const recent = (t: number | null): boolean => t !== null && t <= nowMs && nowMs - t < quietMs;
  return recent(file.modifiedMs) || recent(file.createdMs);
}
