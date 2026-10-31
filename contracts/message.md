# Message and call formats

**Version:** 1 (25 October 2026). The JSON Schemas are [schemas/message/memex.message-1.schema.json](../schemas/message/memex.message-1.schema.json) and [schemas/message/memex.call-1.schema.json](../schemas/message/memex.call-1.schema.json). The fixtures in [fixtures/message/](fixtures/message/) and [fixtures/handles/](fixtures/handles/) are part of this contract.

`memex.message/1` is one message from iMessage, SMS, MMS, WhatsApp, mail, another chat service, or an old chat log. `memex.call/1` is one phone, FaceTime, or app call. Converters make these records from the raw data in the archive ([archive.md](archive.md)). Memex.Conversations reads them, removes duplicates across sources, and keeps every record as an observation. The raw data stays in the archive; a record points back to it.

A file of records is JSON Lines: one record per line, UTF-8, `\n` line ends. One file holds one source's records. Where a conversion stores its files in the archive is part of the archive contract.

## Choices in version 1

- **Field names are camelCase**, as in the archive files (`status.json`, `index.jsonl`), so a converter reads and writes one naming style. The Conversations plan used snake_case (`body_text`, `time_quality`); Conversations reads `text` and `timeQuality` instead. A change to the names needs a new format version.
- **Mail is converted too.** Maildir stays the open copy and the raw source of mail. Converters also make `memex.message/1` records from it, so that one timeline has mail, chats and calls, and a mail record points back to its Maildir file through `source`.

## Handles

A handle is an address on a service: a phone number, an email address, or an account on a platform.

```json
{ "kind": "phone", "raw": "+1 201-555-0101", "status": "normalized", "value": "+12015550101" }
```

| Field | Meaning |
|---|---|
| `kind` | `phone`, `email`, or `platform` (a WhatsApp JID, a Telegram name, an MSN or Google Talk account). |
| `raw` | The text exactly as the source wrote it. It is never changed. |
| `status` | `normalized`: `value` is an E.164 number or a lowercase email address. `raw`: a platform handle; `value` is the raw text, trimmed. `unparsed`: the handle could not be read. |
| `value` | The handle to match on. Not present when `status` is `unparsed`. |
| `phone` | The E.164 number in a platform handle, when it has one (a WhatsApp JID of a person). |

Rules (the reference implementation is `normalizeHandle()` in `@tjalve/memex-handles`, `packages/handles`):

- **Phone numbers** become E.164 with libphonenumber. A number without a country code uses the default region, for example `NO`. The region is configuration, not code. Without a region, such a number is `unparsed`.
- **Email addresses** are trimmed and lowercased. `Name <address>` and `mailto:` give the address. There is no provider-specific rewriting, for example of dots in Gmail addresses.
- **Platform handles** keep their platform form. A WhatsApp JID with a phone number also gets `phone`.
- **Unparsed.** Short codes, sender names such as `PAKKE`, numbers with an extension, hidden callers (`""`), and text that does not parse are `unparsed`. An unparsed handle never matches a person automatically.
- **Kind.** The converter gives the kind when the source knows it. Otherwise: `tel:` is a phone, `mailto:` is an email, a WhatsApp JID is a platform handle, a handle on a platform service (`telegram`, `messenger`, `facebook-chat`, `gtalk`, `hangouts`, `msn`, `x-dm`, `skype`, `irc`) is a platform handle, a handle on `mail` or with `@` is an email, and all other handles are phone numbers.

## memex.message/1

```json
{
  "format": "memex.message/1",
  "id": "4D1B7C0E-1F2A-4B3C-9D8E-0A1B2C3D4E5F",
  "service": "imessage",
  "conversation": { "id": "iMessage;-;+12015550101", "kind": "one-to-one" },
  "sender": { "kind": "phone", "raw": "+12015550101", "status": "normalized", "value": "+12015550101" },
  "recipients": [{ "kind": "email", "raw": "Ada.Lovelace@example.com", "status": "normalized", "value": "ada.lovelace@example.com" }],
  "sentAt": "2026-10-23T18:41:07.512+02:00",
  "receivedAt": "2026-10-23T18:41:08.004+02:00",
  "text": "Look at the view from the cabin!",
  "attachments": [{ "sha256": "3582246f913c0a8437d0a3b0f5dfe6b440e17864eef7d6282c3e80ab771ccef5", "ext": "heic", "name": "IMG_0412.HEIC", "type": "image/heic", "size": 1843302 }],
  "edits": [{ "text": "Look at the veiw from the cabin!", "replacedAt": "2026-10-23T18:41:30+02:00" }],
  "source": { "path": "messages/imessage/mac-mini", "run": "20261023T170000Z-3f9a0c1e", "entry": "records/messages.jsonl", "record": "184467" },
  "converter": { "name": "memex-capture imessage", "version": "0.1.0" }
}
```

| Field | Required | Meaning |
|---|---|---|
| `format` | yes | `memex.message/1` |
| `id` | yes | The source's own id: the Apple message GUID, the mail `Message-ID`, the WhatsApp message id. When the source has none, the converter makes one that stays the same at every conversion, for example from the file and line. Unique in the source. |
| `service` | yes | `imessage`, `sms`, `mms`, `whatsapp`, `telegram`, `signal`, `messenger`, `facebook-chat`, `gtalk`, `hangouts`, `msn`, `skype`, `irc`, `x-dm`, `mail`. A new service needs no change to this contract. |
| `conversation` | yes | `id`: the source's thread id (the chat GUID, the first `Message-ID` of a mail thread, a group JID, the other account of a chat log). `kind`: `one-to-one`, `group`, or `mail-thread`. `title`: the group name, when the source has one. |
| `sender` | yes | The handle that sent the message. |
| `fromMe` | no | `true` when the owner sent it. |
| `recipients`, `cc`, `bcc` | no | Handles. `cc` and `bcc` are for mail. |
| `sentAt` | yes | When it was sent. RFC 3339 with an offset. |
| `receivedAt` | no | When it arrived, when the source knows. |
| `timeQuality` | no | `exact` (the default), `zone-guessed` (the source had local time without a zone, and the converter chose the offset), or `repaired` (the source time was wrong, for example 1970, and the converter took the time from elsewhere in the record). |
| `subject` | no | The subject of a mail. |
| `text` | no | The text as plain text. Not present when the message has no text. HTML and rich text stay in the raw source. |
| `attachments` | no | `sha256` names the bytes. A reader finds them by that hash in the `attachment` items of the source's `index.jsonl`, which give the pack (`file`), the zip `entry` and the stored `ext`. `ext` in the record is the extension this message gave and is information only: the archive stores each hash once per source, under the extension it had first, so a path built from the record can be wrong. `name`, `type` (media type) and `size` when known. `missing: true`, without `sha256`, when the source names an attachment whose bytes are gone. |
| `replyTo` | no | The `id` of the message this one answers, in the same source. |
| `edits` | no | Earlier versions of the text, oldest first: `text` and `replacedAt`. `text` is the latest version. |
| `deleted` | no | `reason`: `unsent` (the sender removed it for everyone) or `missing` (a later run did not find it in the source). `at` when known. The record stays. |
| `source` | yes | Where the raw record is. `path`: the source folder in the archive (`<domain>/<source>/<device>` or `imports/<yyyy-mm-dd>-<name>`). `run`: the run id that stored it. `entry`: the pack entry or database name. `record`: the source's own id for the record, or its position, for example `2004-03-02.txt:41`. |
| `converter` | yes | `name` and `version` of the tool that made the record. |

## memex.call/1

```json
{
  "format": "memex.call/1",
  "id": "6F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9",
  "service": "phone",
  "media": "audio",
  "handles": [{ "kind": "phone", "raw": "+1 201-555-0101", "status": "normalized", "value": "+12015550101" }],
  "direction": "incoming",
  "answered": true,
  "startedAt": "2026-10-23T19:02:11+02:00",
  "durationSeconds": 312.4,
  "source": { "path": "calls/callhistory/mac-mini", "run": "20261023T180000Z-5e6f7a8b", "entry": "records/calls.jsonl", "record": "Z_PK/5512" },
  "converter": { "name": "memex-capture calls", "version": "0.1.0" }
}
```

| Field | Required | Meaning |
|---|---|---|
| `format` | yes | `memex.call/1` |
| `id` | yes | The source's own id, as for a message. |
| `service` | yes | `phone`, `facetime`, `whatsapp`, `telegram`, `signal`, `messenger`, `skype`. |
| `media` | no | `audio` or `video`. |
| `handles` | yes | The other people on the call, at least one. A hidden caller is an `unparsed` phone handle with `raw` `""`. |
| `direction` | yes | `incoming` or `outgoing`. |
| `answered` | yes | `false` for a missed, declined, or unanswered call. |
| `startedAt` | yes | When the call started (rang). RFC 3339 with an offset. |
| `durationSeconds` | yes | The connected time; `0` when not answered. |
| `timeQuality`, `deleted`, `source`, `converter` | | As for a message. |

## Rules

- A record has no fields that the schema does not name. A source field without a place here stays in the raw source; `source` points to it.
- A converter never changes `raw`, and never drops a record without a reason in its conversion report (archive contract).
- Records refer to attachments by hash, never by path.
- Every `sha256` in a record is an `attachment` item in the index of the record's source. A converter that takes attachments out of a raw file (the MIME parts of a mail in a Maildir, the parts of an MMS in an SMS Backup+ file) stores the bytes with `putAttachment` in that source when it converts, so that they are in the index like any other attachment. Where a conversion writes its packs, and how it accounts for what it extracted, is part of the conversion run (archive contract). The converter writes a record only after the attachments it names are stored.
- Times keep the offset that the source gave. Readers compare instants.
- All example people, numbers and addresses in this contract and its fixtures are made up. Phone numbers are in the US range 555-0100 to 555-0199, which is kept for fiction (`+1 201-555-01xx`); the Norwegian numbers (`+47 400 00 0xx`) in [fixtures/handles/](fixtures/handles/) only show how a default region works. Addresses use `example.com`, `example.net` and `example.org`.
