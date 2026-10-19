# Rate CSV

An operator's rate CSV can be validated as a whole and serialized for export. Source: `packages/rating/src/csv.ts` and `csv.test.ts`; entry points are `parseRateCsv(text, currency)` and `formatRateCsv(entries)`.

## Sub-features

- `csv-import` requires ISO, Country, Destination Prefix, Description, Rate, in that order. ISO and Description may be empty. ISO is normalized to two uppercase letters. Country is required.
- `csv-errors` reports physical one-based line numbers and reasons without partial success.
- `csv-export` emits a header, four-decimal rates, LF lines, and a final newline.

## How to get to it (user POV)

- Drive the real package suite from the repository root. The admin tenant rate tab supports preview and commit. Tenant creation also accepts CSV.

## Driving it with package commands

Preconditions: installed dependencies.

```sh
pnpm exec vitest run packages/rating/src/csv.test.ts
```

- Require exit 0. Valid fixtures accept BOM, CRLF, blank lines, mandatory case-insensitive five-column header on the first nonblank line, quoted commas/doubled quotes, and trailing empty columns.
- Invalid fixtures return `ok: false` and line errors for duplicate prefixes, `00` prefixes, non-digit prefixes, blank country, negative/nondecimal rates, and more than four textual decimal places. Scientific notation is invalid. Any invalid row prevents a successful entries result; each row reports its first validation failure.
- Header-only/empty files report line 1, `文件没有费率行`. Export includes `ISO,Country,Destination Prefix,Description,Rate` and fixed four-decimal values; preserve the summary and exit code.

## Gotchas

- Cells are trimmed, including quoted cells. Line numbers include headers and blank lines.
- Duplicate detection records a syntactically valid prefix before validating its country/rate, so an invalid earlier row can establish a duplicate.
- Import rejects quoted multiline fields. Export quotes embedded newlines, so arbitrary country text does not always round-trip.
- Parsing does not create a database version. Use the stored-rate capability to verify persistence.

- Accepted headers include `ISO,Country,Destination Prefixes,Description,Rate` and `ISO,国家,号码前缀,说明,费率`. Old three-column headers and numeric headerless three-column rows return a dedicated migration message. Other invalid headers return one error and stop.
- `parseRateCsv` accepts `options.validateEntry` to combine contract errors with parser errors at physical line numbers. Country and Description limits are enforced by `adminRateEntrySchema`. Rate exports use quoting without formula neutralization to preserve round trips; CDR exports neutralize formulas.
