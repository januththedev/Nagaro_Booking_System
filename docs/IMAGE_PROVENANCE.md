# Demo image provenance

Nagaro's demo/seed data ships with **generated illustrations**, not photographs. This note records
where they come from so nobody mistakes them for real pictures of TRACE Expert City.

## What they are

- Type: **procedurally generated architectural scenes** — flat vector-style interiors drawn with a
  hand-written PNG encoder.
- Renderer: `renderSpaceScenePng(width, height, spaceCode, variant)` in
  [`src/server/db/seed.js`](../src/server/db/seed.js).
- Format/geometry: 800×500 PNG, MIME `image/png`, roughly 315–378 KB per frame.
- Alt text: each frame carries a description that begins **"Illustrative rendering of …"**, and the
  public gallery labels frames as **images** (not photographs).

## When they are produced

Only while seeding:

- `node src/server/db/seed.js --demo`, or
- application start with `NAGARO_DEMO_SEED=true` **and** an empty `space` table
  (`maybeSeedDemoData` — it skips if any space already exists).

They are **never** generated while serving a page request, and they are written to the configured
upload directory (`NAGARO_UPLOAD_DIR`), then served through the normal `/media/:name` route — never
into the production public-asset directory.

## Guarantees

- **Deterministic:** identical `(code, variant)` always yields byte-identical bytes, so fixtures and
  screenshots are reproducible. Verified by `tests/unit/seedSceneImages.test.js`.
- **Distinct:** the cover frame and its alternate differ from each other and from every other space.
- **Inert:** served with `Content-Security-Policy: default-src 'none'; sandbox`,
  `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: same-origin`.

## Real imagery in production

Production spaces use staff-uploaded photographs through the admin image path, which validates real
image magic bytes and stores the file with a server-derived name. The seed renderer is a demo
convenience only and is not part of the production upload flow.
