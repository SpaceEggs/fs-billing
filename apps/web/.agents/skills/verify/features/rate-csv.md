# Rate CSV

An operator's rate CSV can be validated as a whole and serialized for export. Source: `packages/rating/src/csv.ts` and `csv.test.ts`; entry points are `parseRateCsv(text, currency)` and `formatRateCsv(entries)`.

## Sub-features

- `csv-import` parses prefix, country/remark, and per-minute rate.
- `csv-errors` reports physical one-based line numbers and reasons without partial success.
- `csv-export` emits a header, four-decimal rates, LF lines, and a final newline.

## How to get to it (user POV)

- Drive the real package suite from the repository root. There is no file-upload or persisted CSV-import route yet.

## Driving it with package commands

Preconditions: installed dependencies.

```sh
pnpm test packages/rating/src/csv.test.ts
```

- Require exit 0. Valid fixtures accept BOM, CRLF, blank lines, optional case-insensitive header on the first nonblank line, quoted commas/doubled quotes, and trailing empty columns.
- Invalid fixtures return `ok: false` and line errors for duplicate prefixes, `00` prefixes, non-digit prefixes, blank country, negative/nondecimal rates, and more than four textual decimal places. Scientific notation is invalid. Any invalid row prevents a successful entries result; each row reports its first validation failure.
- Header-only/empty files report line 1, `文件没有费率行`. Export includes `prefix,country,rate` and fixed four-decimal values; preserve the summary and exit code.

## Gotchas

- Cells are trimmed, including quoted cells. Line numbers include headers and blank lines.
- Duplicate detection records a syntactically valid prefix before validating its country/rate, so an invalid earlier row can establish a duplicate.
- Import rejects quoted multiline fields. Export quotes embedded newlines, so arbitrary country text does not always round-trip.
- Parsing does not create a database version. Use the stored-rate capability to verify persistence.
