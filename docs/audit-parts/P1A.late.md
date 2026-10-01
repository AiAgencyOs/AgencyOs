### Late verifier results
| Verifier | rc | Result |
|---|---|---|
| media | 1 | 31/68 checks passed - image/voice reading needs the Graph + model stubs ("WhatsApp media reading is not configured on this deployment") |
| extractionretry | 0 | All checks passed |
| events | 0 | All checks passed (event vocabulary) |
| receipts | 0 | 34 checks passed (delivery receipts monotonic) |
| clauses | 0 | All checks passed |
| planset | 0 | Two or three plans, approved once, client picks one |
| reaper | 0 | All checks passed (stalled jobs recovered / parked dead) |
| claims | 0 | A claim of one takes one, and one job has one owner |
| announce / unannounced / booking | - | queued behind other agents' verifier runs; not completed when this report was finalised (NOT_RUN) |

