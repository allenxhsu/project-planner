# Vendored copy of ui-kit

Do not edit anything in this folder. The source is `../ui-kit`; change it
there and refresh this copy. Only the directories listed below are managed,
and a refresh replaces them wholesale.

- Package: ui-kit 0.2.0
- Source commit: 932c0f8 + uncommitted changes
- Copied: 2026-09-26T04:08:19.108Z
- Contents: css/ adapters/ fonts/ js/ tokens/ swift/

From `Project/` (the folder that holds this copy):

    node ../ui-kit/scripts/copy-into.mjs ./ui-kit            # refresh
    node ../ui-kit/scripts/copy-into.mjs --check ./ui-kit    # verify; exit 1 on drift
