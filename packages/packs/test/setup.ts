import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point every Memex folder at a scratch folder before any test runs, so that the defaults of the storage library
// (~/Memex, %LOCALAPPDATA%\Memex, the XDG folders) are never the user's own.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memex-packs-test-"));
for (const [name, value] of Object.entries({
  MEMEX_HOME: path.join(scratch, "Memex"),
  MEMEX_ARCHIVE_HOME: path.join(scratch, "Memex", "Archive"),
  MEMEX_APPS_DIR: path.join(scratch, "Apps"),
  MEMEX_PACKS_DIR: path.join(scratch, "Packs"),
  MEMEX_NODE_HOME: path.join(scratch, "Memex", "Node"),
  MEMEX_SERVICES_DIR: path.join(scratch, "Services"),
  LOCALAPPDATA: path.join(scratch, "Local"),
  XDG_CONFIG_HOME: path.join(scratch, "config"),
  XDG_DATA_HOME: path.join(scratch, "data"),
  XDG_STATE_HOME: path.join(scratch, "state"),
  XDG_CACHE_HOME: path.join(scratch, "cache"),
})) {
  process.env[name] = value;
}
