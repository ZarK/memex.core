// The node:sqlite adapter. node:sqlite is built into Node 22.13 and later, so
// this adapter needs no dependency. It lives in its own entry point
// (@tjalve/memex-sqlite/node-sqlite) so that an app on better-sqlite3 never
// loads node:sqlite.
import { DatabaseSync } from "node:sqlite";
import type { SqliteDriver } from "./driver.js";

export const nodeSqlite: SqliteDriver = {
  name: "node:sqlite",
  open(path, { readonly }) {
    // Foreign keys are set by openDatabase; node:sqlite's own default is on as well.
    const db = new DatabaseSync(path, { readOnly: readonly });
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        const statement = db.prepare(sql);
        return {
          run: (...params) => statement.run(...params),
          get: (...params) => statement.get(...params),
          all: (...params) => statement.all(...params),
          readBigInts: (on) => statement.setReadBigInts(on),
        };
      },
      close: () => db.close(),
    };
  },
};
