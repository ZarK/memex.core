import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

// The example readers import the built package (dist), as an app would.
const readers = fileURLToPath(new URL("../examples/public-data/readers.mjs", import.meta.url));
let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "memex-import-cli-"));
  await fs.mkdir(path.join(dir, "drop"));
  // Two rows in the layout of the USGS CSV feed, and the same two events in its GeoJSON layout.
  await fs.writeFile(
    path.join(dir, "drop", "week.csv"),
    "time,latitude,longitude,depth,mag,magType,nst,gap,dmin,rms,net,id,updated,place,type,horizontalError,depthError,magError,magNst,status,locationSource,magSource\n" +
      '2025-01-01T00:00:00.000Z,1,2,3,4.5,mb,,,,,us,us0001,2025-01-01T01:00:00.000Z,"Somewhere, Sea",earthquake,,,,,reviewed,us,us\n' +
      "2025-01-02T00:00:00.000Z,5,6,7,2.1,ml,,,,,ci,ci0002,2025-01-02T01:00:00.000Z,Elsewhere,earthquake,,,,,automatic,ci,ci\n" +
      "not a time,5,6,7,2.1,ml,,,,,ci,ci0003,,Nowhere,earthquake,,,,,automatic,ci,ci\n",
  );
  await fs.writeFile(
    path.join(dir, "drop", "week.geojson"),
    JSON.stringify({
      type: "FeatureCollection",
      metadata: { url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson" },
      features: [
        { type: "Feature", id: "us0001", properties: { time: 1735689600000, mag: 4.5 }, geometry: { type: "Point", coordinates: [2, 1, 3] } },
        { type: "Feature", id: "ci0002", properties: { time: 1735776000000, mag: 2.1 }, geometry: { type: "Point", coordinates: [6, 5, 7] } },
      ],
    }),
  );
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(argv, (t) => (out += t), (t) => (err += t));
  return { code, out, err };
}

describe("memex-import CLI", () => {
  it("previews, commits, re-runs, lists, and undoes", { timeout: 60_000 }, async () => {
    const db = path.join(dir, "cli.db");
    const drop = path.join(dir, "drop");
    const empty = JSON.parse((await run("digest", "--db", db, "--readers", readers, "--json")).out) as { hash: string };

    const preview = await run("preview", drop, "--db", db, "--readers", readers);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain("Nothing was written");
    expect(preview.out).toContain("week.csv [example.usgs-quakes.csv/1]: 3 records: 2 new, 1 skipped");
    expect(preview.out).toContain("week.geojson [example.usgs-quakes.geojson/1]: 2 records: 0 new, 2 duplicate");
    expect(preview.out).toContain("Every file and every record is accounted for.");
    expect(JSON.parse((await run("digest", "--db", db, "--readers", readers, "--json")).out).hash).toBe(empty.hash);

    const commit = JSON.parse((await run("commit", drop, "--db", db, "--readers", readers, "--json")).out) as { batchId: string; totals: { records: { new: number } } };
    expect(commit.totals.records.new).toBe(2);
    const again = JSON.parse((await run("commit", drop, "--db", db, "--readers", readers, "--json")).out) as { totals: { records: { new: number } } };
    expect(again.totals.records.new).toBe(0);

    const batches = await run("batches", "--db", db);
    expect(batches.out).toContain(commit.batchId);
    const show = await run("show", commit.batchId, "--db", db);
    expect(show.out).toContain("imported     week.csv");

    const undo = await run("undo", commit.batchId, "--db", db);
    expect(undo.code).toBe(0);
    expect(undo.out).toContain("quake -2");
    expect(JSON.parse((await run("digest", "--db", db, "--readers", readers, "--json")).out).hash).toBe(empty.hash);
    expect((await run("undo", commit.batchId, "--db", db)).code).toBe(1);
  });

  it("explains its usage", async () => {
    expect((await run("frobnicate")).code).toBe(2);
    expect((await run("preview", "--db", path.join(dir, "x.db"))).err).toContain("--readers is required");
  });
});
