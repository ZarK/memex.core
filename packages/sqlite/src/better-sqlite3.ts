// The better-sqlite3 adapter. better-sqlite3 is a peer dependency: the app
// installs it (it has a native build). The adapter is typed against the small
// part of its API that it uses, so this package needs neither the module nor
// its types to build.
import { createRequire } from "node:module";
import type { RunResult, SqliteDriver } from "./driver.js";

/** The part of a better-sqlite3 statement that the adapter uses. */
export interface BetterSqlite3Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  safeIntegers(on?: boolean): unknown;
}

/** The part of a better-sqlite3 database that the adapter uses. */
export interface BetterSqlite3Database {
  exec(sql: string): unknown;
  prepare(sql: string): BetterSqlite3Statement;
  close(): unknown;
}

export type BetterSqlite3Constructor = new (path: string, options?: { readonly?: boolean }) => BetterSqlite3Database;

/**
 * A driver on better-sqlite3. Pass the module's default export, or nothing to
 * load "better-sqlite3" from the app's dependencies on the first open.
 */
export function betterSqlite3(Database?: BetterSqlite3Constructor): SqliteDriver {
  let ctor = Database;
  return {
    name: "better-sqlite3",
    open(path, { readonly }) {
      ctor ??= createRequire(import.meta.url)("better-sqlite3") as BetterSqlite3Constructor;
      const db = new ctor(path, { readonly });
      return {
        exec: (sql) => db.exec(sql),
        prepare: (sql) => {
          const statement = db.prepare(sql);
          return {
            run: (...params) => statement.run(...params),
            get: (...params) => statement.get(...params),
            all: (...params) => statement.all(...params),
            readBigInts: (on) => void statement.safeIntegers(on),
          };
        },
        close: () => db.close(),
      };
    },
  };
}
