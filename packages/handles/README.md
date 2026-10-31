# @tjalve/memex-handles

Handles as defined in [contracts/message.md](../../contracts/message.md#handles): phone numbers to E.164, lowercase email addresses, and platform handles as the source wrote them. One runtime dependency: [libphonenumber-js](https://www.npmjs.com/package/libphonenumber-js) (MIT), with its `min` metadata.

```ts
import { normalizeHandle } from "@tjalve/memex-handles";

normalizeHandle("(201) 555-0101", { region: "US" });
// { kind: "phone", raw: "(201) 555-0101", status: "normalized", value: "+12015550101" }

normalizeHandle("Bjorn Example <Bjorn@Example.org>", { service: "mail" });
// { kind: "email", raw: "Bjorn Example <Bjorn@Example.org>", status: "normalized", value: "bjorn@example.org" }

normalizeHandle("12015550102@s.whatsapp.net", { service: "whatsapp" });
// { kind: "platform", raw: "12015550102@s.whatsapp.net", status: "raw", value: "12015550102@s.whatsapp.net", phone: "+12015550102" }

normalizeHandle("PAKKE", { region: "NO", service: "sms" });
// { kind: "phone", raw: "PAKKE", status: "unparsed" }
```

`normalizeHandle()` never throws for bad input; a handle that cannot be read gets the status `unparsed`. It throws `HandlesError` with `code` `unknown-region` for a region that libphonenumber does not know. The region is configuration, not code: pass the user's setting. `normalizePhone()` and `normalizeEmail()` return the value or `undefined`.

Tests run the contract fixtures in `contracts/fixtures/handles/` and check the records in `contracts/fixtures/message/` against the JSON Schemas in `schemas/message/`.
