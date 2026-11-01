# sync-kit, vendored

A copy of `sync-kit` 0.1.0, source commit `3a3e316`,
taken 2026-11-01T02:18:35.898Z.

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
