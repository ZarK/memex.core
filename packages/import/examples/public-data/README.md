# Example: importing public data

[readers.mjs](readers.mjs) has three readers, as an app would keep them in its own code:

| Reader | Reads | Source (provenance) | Identity |
|---|---|---|---|
| `example.usgs-quakes.csv/1` | the USGS earthquake feed as CSV | `import:usgs:earthquakes` | the event id |
| `example.usgs-quakes.geojson/1` | the USGS earthquake feed as GeoJSON | `import:usgs:earthquakes` | the event id |
| `example.natural-earth.geojson/1` | Natural Earth countries and populated places as GeoJSON | `import:natural-earth` | the Natural Earth id |

The two USGS readers share a source, so an event imported from the CSV is a duplicate in the GeoJSON, and the other way around. `setup(db)` makes the tables `quake` and `place`. A populated place is linked to its country when the country is in the database.

## The files

No data file is kept in the repository. The files come from these places; the checksums are of the copies used for the run below.

| File | From | License | SHA-256 |
|---|---|---|---|
| `all_week.csv` | https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.csv (retrieved 25 Oct 2026) | US public domain (USGS); credit "U.S. Geological Survey" requested | `138601f2772f8f5030d752ec17687031f39548a582ae720de0edcbf35f856d5b` |
| `all_week.geojson` | https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson (retrieved 25 Oct 2026) | US public domain (USGS) | `df7f71f2f233beaf36a8896fd33a5903a80d8aa8d4b3b20a5b09f9264c245443` |
| `4.5_month.csv` | https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_month.csv (retrieved 25 Oct 2026) | US public domain (USGS) | `68a39ab0c69dfb3d8f486288ef9293d3c8a6b73e621e9e4266cfa09b42406a60` |
| `ne_110m_admin_0_countries.geojson` | https://github.com/nvkelso/natural-earth-vector, commit `ca96624a56bd078437bca8184e78163e5039ad19`, `geojson/` | Public domain (Natural Earth, see its LICENSE.md) | `6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f` |
| `ne_110m_populated_places_simple.geojson` | the same commit, `geojson/` | Public domain (Natural Earth) | `0dbd25c9ad8bd797ddf164b067f563be5c16be2c002254eb594862377963f9dc` |
| `LICENSE.md` | the same commit, `LICENSE.md` | Natural Earth's terms | `2631b5b39b6d1acc56de75235109b5af2dbb4b0ac5a127b6f06185977247fd4b` |

The USGS feeds change every few minutes, so a new download has other bytes and other events. The folder for the run was made from these files with ordinary programs:

```text
drop/
  damaged/all_week-cut.geojson      head -c 500000 all_week.geojson (a cut-off file)
  natural-earth/LICENSE.md
  natural-earth/ne_110m_admin_0_countries.geojson
  natural-earth/ne_110m_populated_places_simple.geojson
  packed/4.5_month.csv.gz           gzip -c 4.5_month.csv (gzip 1.14)
  packed/week-and-places.zip        Compress-Archive all_week.csv, ne_110m_populated_places_simple.geojson (Windows PowerShell)
  quakes/4.5_month.csv
  quakes/all_week.csv
  quakes/all_week.geojson
```

## The run

From `packages/import`, after `pnpm build`:

```bash
R=examples/public-data/readers.mjs
node dist/bin.js digest  --db public.db --readers $R            # empty: sha256 ef39c016...
node dist/bin.js preview drop --db public.db --readers $R       # 12 files, 5,095 records: 2,947 new, 2,148 duplicate
node dist/bin.js digest  --db public.db --readers $R            # still ef39c016...: the preview wrote nothing
node dist/bin.js commit  drop/quakes drop/packed drop/damaged --db public.db --readers $R   # batch A
node dist/bin.js commit  drop/natural-earth --db public.db --readers $R                     # batch B
node dist/bin.js commit  drop --db public.db --readers $R            # batch C: 0 new (5 unchanged, 3 copies)
node dist/bin.js commit  drop --db public.db --readers $R --reread   # batch D: every file read again, 0 new
node dist/bin.js undo    <D>, <C>, <B> --db public.db                # the digest after A is back
node dist/bin.js undo    <A> --db public.db                          # the empty digest is back
```

The counts agree with the files: 1,956 rows in `all_week.csv` and 1,956 features with the same ids in `all_week.geojson`; 763 rows in `4.5_month.csv`, 192 of them also in `all_week.csv`; 2,527 distinct events in all; 177 countries and 243 populated places. The cut-off GeoJSON file fails and writes nothing; the license file is unrecognised.
