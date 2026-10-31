import path from 'node:path'

// Memex Hello is built twice for the shared-services proof: Memex Hello, and Memex Hello Two, a second
// app that carries the same services (MEMEX_HELLO_VARIANT=two when packing). Each build knows which one it is from its
// program's name, which the installer gives it, so the server and the CLI agree with the shell.
export function helloIdentity(execPath = process.execPath, env = process.env) {
  const two = env.MEMEX_DESKTOP_APP === 'hellotwo' || path.basename(execPath).startsWith('Memex Hello Two') || path.basename(execPath).startsWith('memex-hellotwo')
  return two
    ? { app: 'hellotwo', productName: 'Memex Hello Two', folderName: 'Memex Hello Two Example', linuxFolderName: 'memex-hellotwo-example' }
    : { app: 'hello', productName: 'Memex Hello', folderName: 'Memex Hello Example', linuxFolderName: 'memex-hello-example' }
}
