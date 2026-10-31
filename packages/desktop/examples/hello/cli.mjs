// memex-hello: the CLI and the stdio MCP server of Memex Hello. The installed app runs it through its CLI shim
// (resources/bin/memex-hello.exe on Windows) with the Node.js inside the app's own Electron program.
import { runCli } from '@tjalve/memex-surfaces'
import { openDesktopApp } from '@tjalve/memex-desktop/server'
import { helloPaths } from './paths.mjs'
import { registry } from './registry.mjs'

const paths = helloPaths()
process.exitCode = await runCli(process.argv.slice(2), { registry, license: 'MIT', paths, apps: paths.apps, open: () => openDesktopApp() })
