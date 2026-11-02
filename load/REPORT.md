# Local verification — 2026-11-02

Environment: Apple M4 Pro, 24 GiB RAM, arm64, Docker Engine 28.3.2; PostgreSQL 17 containers, Node.js 22 containers. k6 ran in a container on the same Docker network as the API. These are local measurements, not production capacity.

## Concurrent stock test

`npm test` used a separate `sale_test` database. Of 5,000 concurrent application calls for one SKU with 100 units, 100 reserved and 4,900 received a stock conflict. After settling every winning payment twice, the row was `available=0, reserved=0, sold=100`. The application pool allowed at most 20 simultaneous DB connections, so 5,000 calls were outstanding concurrently but not all executing SQL at the same instant.

## 20-second k6 peak

Command:

```sh
docker run --rm --network flash-sale-platform_default \
  -e RATE=2000 -e DURATION=20s -e RESTOCK_INTERVAL=5 \
  -v "$PWD/load:/scripts" grafana/k6 \
  run --summary-export=/scripts/peak-summary.json /scripts/sale.js
```

The database was freshly initialized, then seeded with 1,000 load SKUs. The script used 20,000 possible user IDs, 70% catalog reads, 20% checkout attempts and 10% cart reads; 80% of checkouts targeted three hot SKUs. For this shortened run, restocks occurred at 5 and 10 seconds. The full three-minute profile with restocks at 60 and 120 seconds is defined but has not been run.

| Measurement | Observed |
| --- | ---: |
| HTTP requests | 40,008 |
| Achieved rate | 2,000.12 requests/s |
| Dropped iterations | 0 |
| HTTP 5xx | 0 |
| Catalog p95 | 1.14 ms |
| Checkout p95, including stockouts | 2.45 ms |
| Cart p95 | 0.48 ms |
| Stockout responses (409) | 5,368 |
| Successful checkout responses, including idempotent replays | 2,590 |
| Unique confirmed orders after drain | 2,374 |
| Pending outbox rows after drain | 0 |
| Invalid inventory rows | 0 |
| SKU rows with reservation/sold-counter drift | 0 |
| Multiple successful capture records for one order | 0 |

The complete k6 export is [peak-summary.json](peak-summary.json). k6 counts 409 stockouts under its generic `http_req_failed` metric; the custom `server_error_rate` excludes them. Only up to five VUs were active at once because responses were very fast. This run demonstrates the configured arrival rate on one local machine, while the separate stock test exercises many concurrent attempts. It does not demonstrate 20,000 simultaneous connections.

## Partial failure

With the reconciler stopped, `SIM_TIMEOUT_AFTER_COMMIT_RATE=1` and `SIM_DROP_WEBHOOK_RATE=1`, a newly created order became `PAYMENT_REVIEW` with a `HELD` reservation while the simulator ledger showed `SUCCEEDED`. Restarting the Python reconciler changed that order to `CONFIRMED` and its reservation to `CONSUMED`. This reproduces a debit that precedes the order confirmation transaction.

## Limits

The run uses a local payment simulator and a single PostgreSQL instance for orders. It has no real provider, cross-region replication, customer authentication, fulfillment service, or production operational history. The tests cover the stated transitions and workload; they do not prove behavior under arbitrary infrastructure failures or longer sustained peaks.
