# PharmaCart transport input safety (B4)

Status: implemented, unit-tested, not yet wired into any transport
Scope: the rejection boundary that untrusted feed input must pass before any parser, adapter or projection sees it
Source input: *PharmaCart Builder Master Plan*, sections 18 and 34; acceptance criterion AC-013

`packages/transport-safety` holds pure guards for input that arrives from outside a trust boundary: dropped files, SFTP and email attachments, and any operator-supplied path. It contains no transport, no vendor code and no I/O beyond one deliberate symlink resolution. It adds no dependency; every check uses Node built-ins.

The package decides one thing only: whether input may proceed. It never repairs, sanitises or normalises hostile input, because a guard that rewrites input silently changes purchasing meaning. Every decision is a discriminated union carrying a stable reason code, so callers log why input was refused without re-deriving it.

## 1. Allowlisted root containment

`resolveContainedPath(root, untrustedPath)` accepts only a relative path that stays inside `root`, and rejects everything below with a named reason.

| Vector | Reason code |
| --- | --- |
| `../secrets.env`, `..\..\infra\.env`, `./feed.csv` | `relative_segment` |
| `/etc/passwd`, `\Windows\win.ini` | `absolute_path` |
| `C:\Windows\win.ini`, `c:feed.csv` | `drive_qualified_path` |
| `\\attacker\share\x.csv`, `//attacker/share/x.csv` | `unc_path` |
| `feed.csv\u0000/../../infra/.env`, embedded newline or `\u007f` | `control_character` |
| `NUL`, `nul.csv`, `COM1.txt`, `CONIN$` | `reserved_device_name` |
| `feed.csv:secrets` | `stream_separator` |
| `feed.csv.`, `feed.csv ` | `trailing_dot_or_space` |
| empty input, `feeds//feed.csv`, `branch-01/` | `empty_path`, `empty_segment` |
| over 1024 characters, or a segment over 255 | `path_too_long`, `segment_too_long` |

Both separators are treated as separators on every platform, so a Windows-shaped payload is refused on Linux and the reverse. Rejection is never platform-conditional; only the final case-sensitivity of the containment comparison follows the host.

`isPathWithinRoot` is exported separately because prefix comparison is the step most often written wrong. It requires a separator boundary, so `/srv/feed-dropback` is outside `/srv/feed-drop`, and it treats the root itself as outside.

`resolveContainedPath` is string-level and cannot see symlinks. `resolveContainedRealPath` adds that check: it resolves the nearest existing ancestor of the target, which keeps a not-yet-written file acceptable, then re-tests containment against the real root. A symlink inside the drop directory pointing at `infra/.env` is refused with `escapes_root`. Use the async form for anything that will actually be opened.

## 2. Untrusted XML inspection

`inspectUntrustedXml(bytes, limits?)` takes bytes, not a string, because encoding choice is itself an attack surface. A scanner that reads a decoded string cannot know what the downstream parser will decode.

Encoding is settled first. A UTF-16 or UTF-32 byte order mark, any NUL byte, invalid UTF-8, or an XML declaration naming a non-UTF-8 encoding is refused before any pattern matching. A UTF-8 byte order mark is accepted and stripped.

The scan then fails closed on every construct that carries external reference or expansion capability:

- Any `<!DOCTYPE`, which removes XXE and entity-expansion attacks including billion laughs in one rule, since both require a document type declaration.
- Any `<!ENTITY` or other markup declaration.
- Any named entity reference outside the five predefined ones, in text or in attribute values. Numeric character references remain legal.
- Any processing instruction other than a leading XML declaration, which covers `<?xml-stylesheet>`.
- Any XInclude namespace or `*:include` element, the external-reference vector that survives DTD rejection because it is ordinary markup.

Comments and CDATA are skipped as opaque, and attribute values are quote-aware, so a `>` inside an attribute does not end a tag. Depth, element count and byte length are bounded, defaulting to 64, 100,000 and 8 MiB. Unterminated or unbalanced markup is refused rather than guessed.

Rejection is deliberately over-broad: `<!-- <!DOCTYPE evil> -->` inside a comment is safe and still accepted, but any DOCTYPE outside one is refused whatever encodes it. A false refusal costs an operator a re-send; a false acceptance costs a file read.

## 3. Spreadsheet and CSV cell inspection

`inspectUntrustedCell` refuses the formula and DDE prefixes that spreadsheet applications execute on open: `=`, `+`, `-`, `@`, tab and carriage return. Leading whitespace and zero-width characters are stripped before the check, so `\u200b=1+1` and `\ufeff@SUM(A1)` are refused rather than slipping past a naive first-character test.

A value that is a plain signed number is accepted, so `-5` and `+3.5` remain usable quantities. This is the only exemption; `-2+3+cmd|' /c calc'!A0` is not a number and is refused.

`inspectUntrustedTable` applies the cell rule across a grid and bounds rows, columns and cell length, defaulting to 250,000, 512 and 32,768. A rejection reports the exact row and column so an operator can fix one cell instead of resubmitting a file blind.

## 4. Bounded decompression

`gunzipWithinBudget` caps compressed input, decompressed output and expansion ratio, defaulting to 16 MiB, 64 MiB and 200:1. The output cap is enforced by `maxOutputLength` inside zlib, so a decompression bomb is refused during inflation rather than after allocating it. Input that is not a gzip member is refused as `invalid_archive`, never as a parse attempt.

The ratio check runs after the size check because the two catch different attacks: a small archive that inflates a thousandfold passes an absolute cap that a legitimate large feed also passes.

## 5. Boundary

Delimited transport uses the table guard, and feed-ingestion composes transport guards; no API or scheduled drop-directory worker drives that pipeline yet, so AC-013 stays NOT RUN. Unit coverage of a guard is not the same as evidence that hostile input meets the guard before a parser; the criterion moves only when a real ingestion path is wired and the malicious-input corpus runs through it.

Three limits are deliberate and should not be mistaken for coverage. Archive member traversal, the zip-slip vector where an archive entry name escapes its extraction root, is not implemented here, because no archive extractor exists yet; `resolveContainedPath` is the intended guard for each entry name when one is built. Spreadsheet inspection covers cell values only, not the macro, external-link and DDE structures inside a workbook container, which need a container reader first. XML inspection covers well-formedness constructs, not schema validity, which belongs to the adapter layer.

The parsing guards are independently testable and carry no vendor assumptions. The real-path helper performs filesystem I/O; it is not a pure function. They must be called at the transport edge, before any adapter, and their rejection must be terminal for that input rather than a warning.
