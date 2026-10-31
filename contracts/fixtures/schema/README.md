# Schema 0.3 fixtures

Fixtures for [derived-facts.md](../../derived-facts.md). `packages/schema/test/schema.test.ts` checks every file. Memex.Photos (C#) uses them to write facts with the same ids, to read and write the corrections export, and to read provenance v2 rows. All data is fictional.

| File | Holds |
|---|---|
| `fact-ids.json` | `kind`, `scope`, `key`, and the fact `id` they give. One key has a character outside ASCII. |
| `facts.json` | A `writeFacts` input: four `photos.trips` facts. |
| `corrections.jsonl` | A corrections export: one correction of each op. |
| `resolved.json` | `resolveFact` for each fact after `facts.json` and `corrections.jsonl`, and the milestone that the user made. |
| `provenance-v2.json` | Provenance rows with `batch_id`, `file_hash`, and `reader`, as snake_case database columns. |

## C#

The JSON files use camelCase, except the provenance rows, which are database rows. Read them with `JsonSerializerDefaults.Web`. To write the corrections export byte for byte, leave out null properties, keep the property order of the record below, and do not escape characters outside ASCII. Keep `createdAt` a string: `DateTimeOffset` would write `+00:00` instead of `Z`.

```csharp
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

static string FactId(string kind, string scope, string key) =>
    kind + "_" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(scope + "\n" + key)))[..32];

record Correction(string Id, string Op, string App, string? Record, string[]? Records, string? Kind,
    JsonObject? Fields, string[]? Names, string CreatedAt);

var json = new JsonSerializerOptions(JsonSerializerDefaults.Web)
{
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
};
// One line: JsonSerializer.Deserialize<Correction>(line, json) and JsonSerializer.Serialize(c, json).
```

Checked on .NET 10: every id in `fact-ids.json` matches, and `corrections.jsonl` read and written line by line is byte-identical (with LF line endings).
