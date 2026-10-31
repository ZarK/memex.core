import os from 'node:os'
import path from 'node:path'
import { helloIdentity } from './identity.mjs'

// Memex Hello is not a Memex app id, so it keeps its folders under one root of its own instead of the folders of
// @tjalve/memex-storage. MEMEX_HELLO_ROOT moves the root.
export function helloPaths(env = process.env, platform = process.platform) {
  const home = os.homedir()
  const { folderName, linuxFolderName } = helloIdentity(process.execPath, env)
  const root = env.MEMEX_HELLO_ROOT
    || (platform === 'win32'
      ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), folderName)
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', folderName)
        : path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), linuxFolderName))
  return {
    root,
    data: path.join(root, 'Data'),
    cache: path.join(root, 'Cache'),
    logs: path.join(root, 'Logs'),
    state: path.join(root, 'State'),
    packs: path.join(root, 'Packs'),
    apps: path.join(root, 'Apps'),
    archive: path.join(root, 'Archive'),
  }
}
