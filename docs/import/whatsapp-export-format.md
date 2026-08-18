# WhatsApp chat export — the format, as measured

This is **not** an assumed format. It was measured against a real export the owner
provided (`WhatsApp Chat - … .zip`, extracted `_chat.txt`, 45 KB, 816 lines,
355 messages, 2026-08). The parser in `src/lib/import/whatsapp-chat.ts` is built
to these facts; when a second platform's export is measured, extend this file first.

## What the sample was (and was not)

- It is **one group chat** (a project/deal group), **not** the 1,200-lead
  population. 6 authors, of which several are the owner's own identities.
- Therefore it is a **format sample**, not lead data. See the import checkpoint.

## iOS export (`_chat.txt`) — MEASURED

- **Encoding:** UTF-8, **CRLF** (`\r\n`) line endings.
- **Message-start line:**
  `[DD/MM/YY, H:MM:SS<U+202F>AM/PM] <Author>: <message>`
  - Bytes verified: `[01/08/26, 12:19:10` + `U+202F` + `PM] …`.
  - Date `DD/MM/YY` here is **day-first** (the sample reaches `13/08`, so
    component-1 is the day). Order is **locale-dependent and not stated in the
    file** — the parser DETECTS it from the data and refuses to assign a
    timestamp when it stays ambiguous (all components ≤ 12). It never guesses.
  - Time is 12-hour with **`U+202F` (narrow no-break space)** before `AM/PM`.
- **Invisible marks** that MUST be normalized before matching:
  - `U+200E` LEFT-TO-RIGHT MARK — prefixes system and media lines.
  - `U+202A`/`U+202B`/`U+202C` bidi embedding/pop — wrap phone numbers.
  - `U+202F` narrow no-break space — inside the timestamp.
- **Group chat markers:** `You created this group`, `You added X and Y`,
  `<name> added <name-or-phone>`, `changed the group …`, the E2E-encryption
  notice. The author of a system line is the **group subject**.
- **Authors are display names**, taken from the exporter's address book. A raw
  phone appears as an author **only** for an unsaved contact. In the sample:
  **0 of 6 authors were phone numbers** — so a phone key is *usually absent*.
- **Media (this export excluded files):** `‎image omitted`, `‎document omitted`,
  `‎audio omitted`. An export *with* media instead carries `‎<attached: FILE>`.
- **Multi-line messages:** a message body continues on following lines until the
  next message-start line. 534 of 816 lines were continuations.

## Android export (`WhatsApp Chat with X.txt`) — NOT yet measured

Documented shape (recognized defensively, flagged as unverified until measured):
`M/D/YY, H:MM<space>AM/PM - <Author>: <message>` (dash separator, no brackets;
system lines have no `Author:`). The parser detects this shape and, if seen,
emits a warning that it was not verified against a real sample here.

## Consequences for matching (why "phone as primary key" needs the right export)

- A **group** export identifies people by **name**, not phone → weak/ambiguous key.
- For reliable phone-key matching we need one of:
  1. **Per-lead direct chats** (`WhatsApp Chat with <Lead>.txt`), where the
     counterpart's number is the chat identity; or
  2. a **contacts export** (vCard/CSV) mapping name ↔ phone; or
  3. an explicit owner decision to match on names, with the ambiguity handled as
     "manual review", never auto-create.
- **Historical messages are data, not consent.** Nothing in an export sets a
  `communication_consent` row. The parser output has no consent field at all.
