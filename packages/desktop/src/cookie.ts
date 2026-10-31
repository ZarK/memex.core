/** The token of a launch: 32 random bytes in base64url without padding (contracts/surfaces.md, Token). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The cookie of the app's UI: memex_<app>_token (contracts/surfaces.md). */
export function cookieName(app: string): string {
  return `memex_${app}_token`;
}

/** Whether a string has the form of a launch token. */
export function isLaunchToken(value: string): boolean {
  return TOKEN.test(value);
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
}

/** The cookie key check gave up waiting: the keychain lookup may still be open (macOS still asks the person). */
export class CookieKeyTimeoutError extends Error {
  override name = "CookieKeyTimeoutError";
}

/**
 * Whether Restart after a failed cookie key check must start a new process. Chromium looks the key up in the login
 * keychain once per process and keeps the answer, so after a refusal (Deny, a locked keychain that cannot ask, a broken
 * key) a restart of the server alone fails the same way. After a timeout the lookup is still open and may still succeed,
 * so a restart of the server is enough.
 */
export function cookieKeyFailureNeedsNewProcess(error: unknown): boolean {
  return !(error instanceof CookieKeyTimeoutError);
}

/** Runs work(), or rejects with timedOut() after timeoutMs. */
async function withTimeout<T>(work: () => Promise<T>, timeoutMs: number, timedOut: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timedOut()), timeoutMs);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Sets the token cookie with set(), or rejects after timeoutMs, so the shell shows its crash screen instead of waiting. */
export async function setTokenCookie(set: () => Promise<void>, timeoutMs: number): Promise<void> {
  await withTimeout(set, timeoutMs, () => new Error(`The sign-in cookie was not stored within ${duration(timeoutMs)}.`));
}

/** The part of Electron's safeStorage that checkSafeStorage uses. */
export interface AsyncSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string }>;
}

/**
 * Makes sure the app's cookie key is usable: encrypts and decrypts a short text with Electron's safeStorage, which uses
 * the same key as the cookie store. On macOS that key is the "<Product> Safe Storage" item in the login keychain, and
 * the first start creates it. The token cookie is a session cookie and never reaches the disk, so without this check the
 * key would be created only when the app first stores a cookie that lasts, and a locked or refused keychain would go
 * unnoticed. When the keychain is locked, macOS asks for its password; when it refuses, or nobody answers within
 * timeoutMs, this rejects and the shell shows its crash screen.
 */
export async function checkSafeStorage(storage: AsyncSafeStorage, productName: string, timeoutMs: number): Promise<void> {
  const reason = `The app's key in the login keychain ("${productName} Safe Storage")`;
  await withTimeout(
    async () => {
      if (!(await storage.isAsyncEncryptionAvailable())) throw new Error(`${reason} is not available: the keychain refused it.`);
      const probe = "memex-desktop";
      let sealed: Buffer;
      try {
        sealed = await storage.encryptStringAsync(probe);
      } catch (error) {
        throw new Error(`${reason} could not be used: the login keychain may be locked, or access to the key was denied (${(error instanceof Error ? error.message : String(error)).replace(/\.$/, "")}).`);
      }
      if (sealed.includes(Buffer.from(probe))) throw new Error(`${reason} did not encrypt.`);
      const { result } = await storage.decryptStringAsync(sealed);
      if (result !== probe) throw new Error(`${reason} did not decrypt what it encrypted.`);
    },
    timeoutMs,
    () => new CookieKeyTimeoutError(`${reason} was not available within ${duration(timeoutMs)}. The login keychain may be locked, or access to the key was denied.`),
  );
}

/** The details for session.cookies.set(): HttpOnly, SameSite=Strict, Path=/, for the app's own URL only. */
export function tokenCookieDetails(app: string, url: string, token: string): {
  url: string;
  name: string;
  value: string;
  path: string;
  httpOnly: true;
  secure: false;
  sameSite: "strict";
} {
  if (!isLaunchToken(token)) throw new Error("The token file does not hold a launch token.");
  return { url, name: cookieName(app), value: token, path: "/", httpOnly: true, secure: false, sameSite: "strict" };
}
