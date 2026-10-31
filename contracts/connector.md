# Connector contract

A connector moves data from a source into the entity spine. Every domain module and every third-party integration follows the same four steps.

## Steps

1. **Ingest.** Read from the source: poll an API, receive a webhook, watch a folder, or parse a file the user provides.
2. **Normalize.** Transform source records into the module's domain shape. Parse dates to ISO 8601 UTC. Parse amounts to integer minor units (øre, cents). Keep the raw source value when parsing is lossy.
3. **Write with provenance.** For each record:
   - Compute a stable `content_hash` from the fields that identify the record in its source.
   - Look up `provenance` by `(source, content_hash)`. If a row exists, the record is already imported: skip it or update it. Never create a duplicate entity.
   - Otherwise create the entity, the domain-table row, and a `provenance` row in one transaction. From schema 0.3 the database refuses a second row with the same `(source, content_hash)`.
   - Set `batch_id` to the import run, `file_hash` to the SHA-256 of the source file, and `reader` to the parser and its version, so that a run can be listed and undone and a changed parser can be found ([derived-facts.md](derived-facts.md#provenance-v2)).
   - [`@tjalve/memex-import`](../packages/import/README.md) does these steps for file imports: the app gives readers (detect, read, write), and the package walks, hashes, dedupes, writes provenance, previews, commits per file, and undoes a batch.
4. **Expose tools.** The module's MCP server and CLI expose the imported data. See [surfaces.md](surfaces.md).

## Source naming

`source` is a namespaced string that identifies the pipeline, not the file:

- `import:csv:sparebank1`
- `import:pdfcsv:kontoutskrifter`
- `connector:actual`

`source_ref` holds the specific origin: a file path, a statement id, or an external record id.

## Rules

- A connector never writes another module's tables.
- A connector never deletes entities. Use `deleted_at` (soft delete) and record why. One exception: an import may remove the rows it wrote by undoing its own batch through the change journal (`@tjalve/memex-import` batch undo).
- Re-running an import over the same input must be a no-op.
