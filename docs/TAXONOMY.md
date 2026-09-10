# Taxonomy

Every row that lands in D1, from any channel, carries these classification fields. This is what makes post-event analysis a SQL query instead of a reading exercise. Code copy: `hook/lib/taxonomy.mjs` (client) and the top of `worker/src/index.js` in the reference repo (https://github.com/RippleDevRel/xrpl-devex-capture.git) (server), kept identical by `tests/taxonomy.test.mjs` in the reference repo.

## `surface`: where the friction sits

| value | meaning | examples |
|---|---|---|
| `protocol` | ledger behaviour, transaction semantics, amendments | tec codes, flag semantics, vault share maths, rippling |
| `docs` | xrpl.org, XLS specs, tutorials, reference pages | missing field description, wrong snippet, outdated tutorial |
| `sdk` | client libraries | xrpl.js, xrpl-py, xrpl4j, xrpl-rust, wallet SDKs |
| `infra` | networks and services | testnet or devnet availability, faucet, explorers, rippled or clio RPC, WebSocket disconnects |
| `tooling` | the developer's local environment for this event | starter repo, XRPL AI Starter Kit, MPP SDK, this capture system itself, Claude Code, env setup |
| `unknown` | classifier could not decide | only used by automated capture and, rarely, `/xrpl-feedback`; never by reflection or analysis |

## `friction_type`: what kind of friction

| value | meaning |
|---|---|
| `retry_loop` | same operation attempted 2+ times before success |
| `doc_gap` | a question the docs should have answered |
| `wrong_model` | developer believed something false about how the protocol works |
| `expectation` | "expected X, got Y", including cases where Y was correct |
| `error_message` | a result code or error that did not point at the actual cause |
| `dead_end` | something attempted then abandoned |
| `workaround` | hand-rolled code for something the SDK or protocol should provide |
| `docs_broken` | a copied snippet or tutorial step that failed as written |
| `terminology` | inconsistent or incorrect use of terms (assets vs shares, redeem vs withdraw, vault owner vs loan broker) |
| `timing` | elapsed time from first attempt to first success, per transaction type |
| `praise` | something that worked well and is worth keeping. Allowed only via `/xrpl-feedback`. Excluded from friction reports, included in a separate "What worked" section of the cross-team report. |
| `raw` | automated capture with no classification yet (hooks only) |

## Supporting fields

- `feature`: free-form short tag, lowercase, hyphenated. Examples: `xls-65`, `xls-66`, `mpt`, `amm`, `payment-channels`, `credentials`, `permissioned-domains`, `nft`, `escrow`, `checks`, `dex`, `trust-lines`, `rlusd`, `mpp`, `x402`, `starter-kit`. The per-event config declares `focus_features` (for example `["xls-65", "xls-66"]`), used for report ordering and given to the skills as context; any feature can be recorded. Hooks infer it from the transaction type (`Vault*` is `xls-65`, `Loan*` and `LoanBroker*` are `xls-66`, `MPToken*` is `mpt`, and so on, see `tx_type_features` in the allowlist) or from keywords, otherwise `null`.
- `evidence`: `observed | reported | inferred`. Hooks always write `observed`. The analysis skill writes what it can defend. `/xrpl-feedback` writes `reported`. Reflection writes `inferred`.
- `channel`: `hook | reflection | feedback | analysis`.
- `kind`: `session_start | prompt | tool_result | package_install | retry_resolved | compact | session_end` for hooks; `reflection`, `feedback`, `analysis` for the other channels.
- `tx_type`: canonical XRPL transaction type when identifiable (`VaultCreate`, `LoanSet`, `Payment`). Canonical casing always comes from the allowlist, never from the matched text: `loanSet.js` is recorded as `LoanSet`. Nullable.
- `result_code`: canonical result code when present (`tecNO_PERMISSION`, `temBAD_AMOUNT`). Unknown codes with a known prefix are normalized to `tec` plus uppercase. Nullable.
- `attempts`, `elapsed_seconds`: set on `retry_resolved` rows and on later attempts of a retry loop; analysis friction items carry `attempts` and `minutes_lost` (stored as `elapsed_seconds`).
- `failed`: 0 or 1 on `tool_result` rows.
- `text`: prompt text, feedback text, tool output excerpt, URL or search query. `summary`: one line. `payload`: JSON for anything else (allowlist matches, normalized command, packages, analysis rank).

## Channel rules enforced by validation

| rule | where |
|---|---|
| `praise` only on `feedback` | client and server |
| `raw` only on `hook` | client and server |
| `timing` not on `reflection` (it comes from hooks or analysis) | client and server |
| `unknown` surface not on `reflection` or `analysis` | client and server |
| `kind` must belong to the channel | client and server |
| reflection `text` 50 to 2000 characters, `summary` under 140 | client and server |
| `feature` lowercase hyphenated, at most 40 characters | client and server |
| `tx_type` must be a known transaction type, `result_code` must have a known prefix | client (`submit.mjs`) |
