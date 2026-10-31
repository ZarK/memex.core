// Holds the app lock of contacts in its own process until standard input ends. Arguments: the data and state folders.
import { acquireAppLock } from "@tjalve/memex-storage";

const [data, state] = process.argv.slice(2);
const lock = await acquireAppLock({ app: "contacts", data, state });
process.stdout.write(`locked ${process.pid}\n`);
process.stdin.on("end", async () => {
  await lock.release();
  process.exit(0);
});
process.stdin.resume();
