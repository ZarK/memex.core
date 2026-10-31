import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The Windows SID of the local system account. It can read every file anyway, so an access list may name it. */
const SYSTEM_SID = "S-1-5-18";

function system32(program: string): string {
  return path.join(process.env.SystemRoot ?? process.env.windir ?? `${process.env.SystemDrive ?? "C:"}\\Windows`, "System32", program);
}

/** The Windows account that runs this process. */
export interface Account {
  sid: string;
  /** true for an account of this computer (its domain is the computer name), false for a domain account. */
  ofThisComputer: boolean;
}

let account: Promise<Account> | undefined;

/** The Windows account that runs this process, from "whoami /user". */
export function currentAccount(): Promise<Account> {
  account ??= run(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true }).then(({ stdout }) => {
    const found = /^"([^"]*)","(S-1-[0-9-]+)"\s*$/.exec(stdout.trim());
    if (!found) throw new Error(`whoami /user did not give a SID: ${stdout.trim()}`);
    const domain = found[1]!.includes("\\") ? found[1]!.slice(0, found[1]!.indexOf("\\")) : "";
    const computer = process.env.COMPUTERNAME || os.hostname().split(".")[0]!.slice(0, 15);
    return { sid: found[2]!, ofThisComputer: computer !== "" && domain.toUpperCase() === computer.toUpperCase() };
  });
  account.catch(() => (account = undefined));
  return account;
}

/**
 * On Windows, replaces the access list of a file with exactly one entry: full control for this account, protected
 * from the folder. "icacls /inheritance:r /grant:r" is not enough: it removes only entries marked as inherited, and a
 * folder with an access list from before automatic inheritance (the user profile's Temp folder is one) gives new files
 * copies of its entries that are not marked, such as SYSTEM and Administrators. So the writer first runs
 * "icacls /reset", which drops every entry that is not inherited and takes the folder's entries again, marked as
 * inherited this time; then "/inheritance:r /grant:r" leaves this account alone. ("icacls /remove" fails on the SID
 * of a deleted account, and "icacls /restore" needs the restore privilege, which a normal account does not have.)
 * Then it reads the list back and throws when it names any other account, so the caller does not write a file that
 * other accounts can read. The system account is left out too: the rule is that only this account can read the file
 * (the check below tolerates SYSTEM only because SYSTEM reads every file through its privileges anyway). A writer
 * calls this on its temporary file while it is still empty, then writes the content and renames the file over the
 * real one (writing into the file and a rename in the same folder keep the list). Does nothing on macOS and Linux, where the file mode does this.
 */
export async function restrictToAccount(file: string): Promise<void> {
  if (process.platform !== "win32") return;
  const me = await currentAccount();
  await run(system32("icacls.exe"), [file, "/reset", "/q"], { windowsHide: true });
  await run(system32("icacls.exe"), [file, "/inheritance:r", "/grant:r", `*${me.sid}:F`, "/q"], { windowsHide: true });
  const sddl = await readSddl(file);
  const others = daclTrustees(sddl).filter((trustee) => !isThisAccount(trustee, me));
  if (!parseDacl(sddl, me).ok || others.length > 0) {
    const why = others.length > 0 ? ` (it names ${others.join(", ")})` : " (it takes entries from its folder)";
    throw new Error(`The access list of ${file} could not be set to this account only${why}.`);
  }
}

export interface AccessCheck {
  /** true when only this account (and the system account) can open the file. */
  ok: boolean;
  /** The SIDs other than this account and the system account that the access list allows. */
  others: string[];
  /** true when the file takes entries from its folder. */
  inherits: boolean;
}

/** On Windows, reads the access list of a file (as SDDL, so the names of accounts do not depend on the language). */
export async function checkAccountOnly(file: string): Promise<AccessCheck> {
  return parseDacl(await readSddl(file), await currentAccount());
}

/** The SDDL of a file's access list, from "icacls /save" (UTF-16LE: the file name, then its SDDL). */
async function readSddl(file: string): Promise<string> {
  const saved = path.join(os.tmpdir(), `memex-acl-${process.pid}-${randomBytes(4).toString("hex")}.txt`);
  try {
    await run(system32("icacls.exe"), [file, "/save", saved, "/q"], { windowsHide: true });
    const text = (await fs.readFile(saved)).toString("utf16le").replace(/^\uFEFF/, "");
    return text.split(/\r?\n/)[1] ?? "";
  } finally {
    await fs.rm(saved, { force: true });
  }
}

/** The DACL of an SDDL string: whether it is protected from the folder, and its entries. */
function readDacl(sddl: string): { protectedList: boolean; entries: { type: string; flags: string; trustee: string }[] } | null {
  const dacl = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
  if (!dacl) return null;
  const entries = [...dacl[2]!.matchAll(/\(([^)]*)\)/g)].map(([, ace]) => {
    const [type = "", flags = "", , , , trustee = ""] = ace!.split(";");
    return { type, flags, trustee };
  });
  return { protectedList: dacl[1]!.includes("P"), entries };
}

/** Every account an entry of the DACL names, allow or deny. */
function daclTrustees(sddl: string): string[] {
  return [...new Set((readDacl(sddl)?.entries ?? []).map((entry) => entry.trustee))];
}

/**
 * Whether an SDDL trustee is this account. SDDL writes two accounts of this computer as aliases: LA, the local
 * Administrator account (RID 500), and LG, the local Guest account (RID 501). A GitHub Actions Windows runner runs as
 * the local Administrator account, so there the one entry of the record reads "LA". An alias is this account only when
 * this account is an account of this computer with that RID; for a domain account, LA and LG are other accounts.
 */
function isThisAccount(trustee: string, account: Account): boolean {
  if (trustee === account.sid) return true;
  const rid = trustee === "LA" ? "500" : trustee === "LG" ? "501" : null;
  return rid !== null && account.ofThisComputer && account.sid.startsWith("S-1-5-21-") && account.sid.endsWith(`-${rid}`);
}

/** Checks the DACL part of an SDDL string: which SIDs it allows, and whether it takes entries from the folder. */
export function parseDacl(sddl: string, account: Account): AccessCheck {
  const dacl = readDacl(sddl);
  if (!dacl) return { ok: false, others: [], inherits: true };
  const others = new Set<string>();
  let inherits = !dacl.protectedList;
  for (const { type, flags, trustee } of dacl.entries) {
    if (flags.includes("ID")) inherits = true;
    if (type !== "A") continue;
    if (!isThisAccount(trustee, account) && trustee !== SYSTEM_SID && trustee !== "SY") others.add(trustee);
  }
  return { ok: !inherits && others.size === 0, others: [...others], inherits };
}
