// A small app for the tests: Memex Contacts with a few capabilities. It takes the library as an argument, so that
// the unit tests use src and the spawned app uses dist.
import { z } from "zod";

const people = [
  { id: "p1", name: "Ada Lovelace" },
  { id: "p2", name: "Alan Turing" },
  { id: "p3", name: "Grace Hopper" },
];

/** @param {typeof import("../../src/index.js")} lib */
export function demoRegistry(lib, options = {}) {
  const { createRegistry, defineRead, defineWrite, listInput, listOutput, writeResult, SurfaceError } = lib;
  const person = z.object({ id: z.string(), name: z.string() });
  const merges = new Map();
  return createRegistry({
    app: "contacts",
    name: "Memex Contacts",
    version: options.version ?? "1.0.0",
    capabilities: [
      defineRead({
        id: "contacts.persons.list",
        title: "List persons",
        description: "Lists persons by name. q filters by a part of the name. Then call contacts.persons.get for one.",
        input: z.object({ ...listInput({ limit: 2, max: 10 }), q: z.string().optional(), ids: z.array(z.string()).optional() }),
        output: listOutput(person),
        handler(input) {
          const offset = input.cursor ? Number(input.cursor) : 0;
          const found = people.filter((p) => (!input.q || p.name.includes(input.q)) && (!input.ids || input.ids.includes(p.id)));
          const items = found.slice(offset, offset + input.limit);
          return { items, next: offset + items.length < found.length ? String(offset + items.length) : null };
        },
      }),
      defineRead({
        id: "contacts.persons.get",
        title: "Get a person",
        description: "One person by id.",
        input: z.object({ id: z.string().min(1) }),
        output: person,
        handler(input) {
          const found = people.find((p) => p.id === input.id);
          if (!found) throw new SurfaceError("not_found", `There is no person ${input.id}.`, { field: "id", hint: "contacts.persons.list lists them." });
          return found;
        },
      }),
      defineRead({
        id: "contacts.persons.count",
        title: "Count persons",
        description: "The number of persons, through contacts.persons.list.",
        input: z.object({}),
        async handler(_input, ctx) {
          const page = await ctx.call("contacts.persons.list", { limit: 10 });
          return { count: page.items.length, origin: ctx.origin };
        },
      }),
      defineWrite({
        id: "contacts.persons.merge",
        title: "Merge persons",
        description: "Merges the person from into the person into.",
        input: z.object({ from: z.string(), into: z.string() }),
        output: writeResult({ into: z.string() }),
        annotations: { destructive: true, idempotent: true },
        handler(input) {
          if (input.idempotencyKey && merges.has(input.idempotencyKey)) return merges.get(input.idempotencyKey);
          const result = { changeId: input.dryRun ? null : `c${merges.size + 1}`, summary: `Merged ${input.from} into ${input.into}.`, into: input.into };
          if (input.idempotencyKey && !input.dryRun) merges.set(input.idempotencyKey, result);
          return result;
        },
      }),
      defineRead({
        id: "contacts.photos.inspect",
        title: "Inspect a photo",
        description: "Reads an upload by uploadId and returns its size and a made file.",
        input: z.object({ uploadId: z.string() }),
        handler(input, ctx) {
          const upload = ctx.upload(input.uploadId);
          return { bytes: upload.data.length, mediaType: upload.mediaType, file: ctx.file(Buffer.from(`size ${upload.data.length}`), "text/plain") };
        },
      }),
      defineWrite({
        id: "contacts.notes.add",
        title: "Add a note",
        description: "Adds a note and returns the process that wrote it.",
        input: z.object({}),
        output: writeResult({ pid: z.number() }),
        handler: () => ({ changeId: null, summary: "Added a note.", pid: process.pid }),
      }),
      defineRead({
        id: "contacts.jobs.run",
        title: "Run a job",
        description: "Keeps the process busy for ms milliseconds, as a long import does.",
        input: z.object({ ms: z.number().int().min(0).max(10_000) }),
        handler(input) {
          const end = Date.now() + input.ms;
          while (Date.now() < end);
          return { ran: input.ms };
        },
      }),
      defineRead({
        id: "contacts.secrets.list",
        title: "List secrets",
        description: "Not for agents.",
        input: z.object({}),
        mcp: false,
        handler: () => ({ items: [], next: null }),
      }),
    ],
  });
}
