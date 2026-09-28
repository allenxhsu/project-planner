# Vendored copy of ui-kit

Do not edit anything in this folder. The source is `../ui-kit`; change it
there and refresh this copy. Only the directories listed below are managed,
and a refresh replaces them wholesale.

- Package: ui-kit 0.2.0
- Source commit: fd5c61c
- Copied: 2026-09-28T14:47:47.233Z
- Contents: css/ adapters/ fonts/ js/ tokens/ swift/

From `Project/` (the folder that holds this copy):

    node ../ui-kit/scripts/copy-into.mjs ./ui-kit            # refresh
    node ../ui-kit/scripts/copy-into.mjs --check ./ui-kit    # verify; exit 1 on drift
