# Isolated code-check reproductions

The script imports only the packet contract (audited to import `node:crypto`) and evaluates an extracted quote-selection function with synthetic values in an isolated JavaScript context. It does not import database-owning app modules or call providers.

Run `node code-checks/probe-plan-gaps.mjs` from the extracted handoff directory. The repository path is declared near the top; adjust it if the checkout moved. The script writes `PLAN-CODE-CHECKS.json` next to the handoff documents. These are reproductions of inspected behavior, not replacements for regression tests in the repository. After fixes, validate expected rejections and consumer behavior rather than expecting the old failure outputs forever.

Existing pure test command actually run in the repository during planning: `node --test test/forecast-packet-contract.test.js`. Result: 14 passed, 0 failed. Full application tests and live-data training were not run in this planning review.
