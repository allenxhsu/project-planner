# sync-kit, vendored

A copy of `sync-kit` 0.1.0, source commit `e5725f2`,
taken 2026-09-24T02:27:23.672Z.

Managed directories, overwritten wholesale on every refresh:

- `js/`
- `cjs/`
- `dist/`
- `swift/`

Do not edit anything in them; edit the source and copy again.

```sh
node ../sync-kit/scripts/copy-into.mjs ./sync-kit          # refresh
node ../sync-kit/scripts/copy-into.mjs --check ./sync-kit  # fail if this copy has drifted
```
