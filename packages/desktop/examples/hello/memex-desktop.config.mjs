// How memex-desktop pack builds Memex Hello.
//
// MEMEX_HELLO_VARIANT=two builds Memex Hello Two, a second app for the shared-services proof.
// MEMEX_HELLO_SERVICES=<folder> makes the build carry the shared services: the folder holds the Memex Node and Memex
// User archives (tools/package.mjs of memex.node, scripts/package.mjs of memex.user) and services.json, which
// "memex-desktop services pin --from <folder> --pins <folder>/services.json" writes from them. A real app keeps its
// services.json in its repository, and its release workflow fetches the pinned archives.
const two = process.env.MEMEX_HELLO_VARIANT === 'two'
const services = process.env.MEMEX_HELLO_SERVICES

export default {
  builder: {
    app: two ? 'hellotwo' : 'hello',
    productName: two ? 'Memex Hello Two' : 'Memex Hello',
    output: two ? 'release-two' : 'release',
    copyright: 'Copyright (c) 2026 Tjalve Aarflot',
    homepage: 'https://github.com/ZarK/memex.core/tree/main/packages/desktop',
    maintainer: 'Tjalve Aarflot <tjalve.github@proton.me>',
    files: ['main.mjs', 'server.mjs', 'cli.mjs', 'paths.mjs', 'registry.mjs', 'identity.mjs', 'package.json', 'icons/icon.ico', 'icons/icon.png'],
    notices: 'build/notices',
    electronDist: 'node_modules/electron/dist',
    // The CLI shim (memex-hello call, mcp) runs cli.mjs with this program's own Node.js, which needs the runAsNode
    // fuse. Memex Hello accepts that; an app without a CLI leaves the fuse off.
    runAsNode: true,
  },
  cli: { entry: 'cli.mjs' },
  ...(services ? { services: { pins: `${services}/services.json`, from: services } } : {}),
  asar: {
    required: ['main.mjs', 'server.mjs', 'cli.mjs', 'node_modules/@tjalve/memex-desktop/assets/shell-preload.cjs'],
    forbiddenPrefixes: ['build/', 'release/', 'release-two/', 'proof/'],
  },
}
