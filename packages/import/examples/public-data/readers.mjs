// Example readers for public data: USGS earthquake feeds (CSV and GeoJSON) and
// Natural Earth countries and populated places (GeoJSON). An app keeps readers
// like these in its own code; memex-import does the rest.
//
//   memex-import preview <folder> --db quakes.db --readers examples/public-data/readers.mjs
//
// See README.md in this folder for the files, where they come from, and their licenses.
import { migrate } from "@tjalve/memex-sqlite";
import { parseCsv, tableRecords, toIsoUtc } from "../../dist/index.js";

/** The example's own tables. Domain rows are keyed by their entity. */
export function setup(db) {
  migrate(db, "example.public-data", [
    {
      name: "0001_quakes_and_places.sql",
      sql: `CREATE TABLE quake (
  entity_id TEXT PRIMARY KEY REFERENCES entity(id),
  event_id TEXT NOT NULL,
  time TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  depth_km REAL,
  magnitude REAL,
  magnitude_type TEXT,
  place TEXT,
  kind TEXT,
  status TEXT,
  network TEXT
);
CREATE INDEX idx_quake_time ON quake(time);
CREATE TABLE place (
  entity_id TEXT PRIMARY KEY REFERENCES entity(id),
  ne_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  iso_a2 TEXT,
  iso_a3 TEXT,
  latitude REAL,
  longitude REAL,
  population INTEGER
);
CREATE INDEX idx_place_iso_a3 ON place(iso_a3, kind);
`,
    },
  ]);
}

const QUAKE_SOURCE = "import:usgs:earthquakes";
const number = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** A quake record, or the reason it cannot be used. */
function quake(fields) {
  if (!fields.id) return { skip: "no event id" };
  const time = toIsoUtc(fields.time ?? "");
  if (!time) return { skip: `the time ${JSON.stringify(fields.time)} cannot be read` };
  const latitude = number(fields.latitude);
  const longitude = number(fields.longitude);
  if (latitude === null || longitude === null) return { skip: "no position" };
  return {
    identity: { event: fields.id },
    data: {
      event_id: fields.id,
      time,
      latitude,
      longitude,
      depth_km: number(fields.depth),
      magnitude: number(fields.mag),
      magnitude_type: fields.magType || null,
      place: fields.place || null,
      kind: fields.type || null,
      status: fields.status || null,
      network: fields.net || null,
    },
  };
}

function writeQuake(data, ctx) {
  const id = ctx.createEntity("example.quake");
  ctx.insert("quake", { entity_id: id, ...data });
  return id;
}
const describeQuake = (q) => `${q.time} M${q.magnitude ?? "?"} ${q.place ?? `${q.latitude}, ${q.longitude}`}`;

/** USGS earthquake feed as CSV (https://earthquake.usgs.gov/earthquakes/feed/v1.0/csv.php). */
export const usgsCsv = {
  id: "example.usgs-quakes.csv",
  version: 1,
  label: "USGS earthquakes (CSV)",
  source: QUAKE_SOURCE,
  repeats: "duplicate",
  detect(sample) {
    return /^﻿?time,latitude,longitude,depth,mag,magType,/.test(sample.head) ? 90 : 0;
  },
  async *read(entry) {
    const rows = parseCsv(await entry.text(), ",");
    const { records, empty } = tableRecords(rows, 0);
    for (const record of records) {
      const q = quake(record.values);
      yield "skip" in q ? { ref: `row ${record.row}`, skip: q.skip } : { ref: `row ${record.row}`, ...q };
    }
    for (let i = 0; i < empty; i += 1) yield { ref: "an empty row", skip: "the row is empty" };
  },
  write: writeQuake,
  describe: describeQuake,
};

/** USGS earthquake feed as GeoJSON (https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php). */
export const usgsGeoJson = {
  id: "example.usgs-quakes.geojson",
  version: 1,
  label: "USGS earthquakes (GeoJSON)",
  source: QUAKE_SOURCE,
  repeats: "duplicate",
  detect(sample) {
    return /"type"\s*:\s*"FeatureCollection"/.test(sample.head) && sample.head.includes("earthquake.usgs.gov") ? 90 : 0;
  },
  async *read(entry) {
    const json = JSON.parse(await entry.text());
    const features = Array.isArray(json.features) ? json.features : [];
    for (const [index, feature] of features.entries()) {
      const ref = `feature ${index + 1}`;
      const p = feature?.properties ?? {};
      const [longitude, latitude, depth] = feature?.geometry?.coordinates ?? [];
      const q = quake({ id: feature?.id, time: p.time, latitude, longitude, depth, mag: p.mag, magType: p.magType, place: p.place, type: p.type, status: p.status, net: p.net });
      yield "skip" in q ? { ref, skip: q.skip } : { ref, ...q };
    }
  },
  write: writeQuake,
  describe: describeQuake,
};

/** Natural Earth countries (Admin-0) and populated places as GeoJSON (https://www.naturalearthdata.com). */
export const naturalEarth = {
  id: "example.natural-earth.geojson",
  version: 1,
  label: "Natural Earth (GeoJSON)",
  source: "import:natural-earth",
  repeats: "duplicate",
  detect(sample) {
    return /"type"\s*:\s*"FeatureCollection"/.test(sample.head) && /"featurecla"\s*:/.test(sample.head) ? 80 : 0;
  },
  async *read(entry) {
    const json = JSON.parse(await entry.text());
    for (const [index, feature] of (json.features ?? []).entries()) {
      const ref = `feature ${index + 1}`;
      const p = feature?.properties ?? {};
      const neId = number(p.ne_id ?? p.NE_ID);
      const name = p.name ?? p.NAME ?? p.ADMIN;
      if (neId === null) {
        yield { ref, skip: "no Natural Earth id" };
        continue;
      }
      if (!name) {
        yield { ref, skip: "no name" };
        continue;
      }
      const country = p.featurecla === "Admin-0 country";
      const iso = (v) => (typeof v === "string" && /^[A-Z]{2,3}$/.test(v) ? v : null);
      const [x, y] = feature?.geometry?.type === "Point" ? feature.geometry.coordinates : [p.LABEL_X, p.LABEL_Y];
      yield {
        ref,
        identity: { ne_id: neId },
        data: {
          ne_id: neId,
          kind: country ? "country" : p.featurecla ?? "place",
          name,
          iso_a2: iso(country ? p.ISO_A2_EH ?? p.ISO_A2 : p.iso_a2),
          iso_a3: iso(country ? p.ISO_A3_EH ?? p.ISO_A3 : p.adm0_a3),
          latitude: number(country ? y : p.latitude ?? y),
          longitude: number(country ? x : p.longitude ?? x),
          population: number(country ? p.POP_EST : p.pop_max),
        },
      };
    }
  },
  write(data, ctx) {
    const id = ctx.createEntity(data.kind === "country" ? "example.country" : "example.place");
    ctx.insert("place", { entity_id: id, ...data });
    // A place is linked to its country when the country is in the database.
    if (data.kind !== "country" && data.iso_a3) {
      const country = ctx.db.get("SELECT entity_id FROM place WHERE kind = 'country' AND iso_a3 = ?", data.iso_a3);
      if (country) ctx.link(id, country.entity_id, "example.in-country");
    }
    return id;
  },
  describe: (p) => `${p.kind}: ${p.name}${p.iso_a3 ? ` (${p.iso_a3})` : ""}`,
};

export const readers = [usgsCsv, usgsGeoJson, naturalEarth];
