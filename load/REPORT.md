# Local verification — 2026-11-03

Environment: Apple M4 Pro, 24 GiB RAM, arm64, Docker Engine 28.3.2; PostgreSQL 17 containers, Node.js 22 containers. k6 ran in a container on the same Docker network as the API. These are local measurements, not production capacity. Both runs used a freshly initialized database, 1,000 load SKUs, 20,000 possible user IDs, 70% catalog reads, 20% checkout attempts and 10% cart reads. Eighty percent of checkouts targeted three hot SKUs; 10% reused a prior idempotency key. The two scenarios add 100 units to each hot SKU at the indicated intervals.

## Concurrent stock test

`npm test` used a separate `sale_test` database. All six tests passed. Of 5,000 concurrently outstanding application calls for one SKU with 100 units, 100 reserved and 4,900 received a stock conflict. After settling every winning payment twice, the row was `available=0, reserved=0, sold=100`. Other tests cover simultaneous idempotency keys, replay of a 409 after restocking, atomic multi-SKU rollback, late capture after cancellation or expiry, a failed refund retried with a fresh provider key, stale refund events, and API clock skew. The application pool allowed at most 20 simultaneous DB connections: the 5,000 calls were outstanding together but not executing SQL at the same instant.

## k6 results

The complete three-minute command was:

```sh
docker run --rm --network flash-sale-platform_default \
  -e RATE=2000 -e DURATION=3m -e RESTOCK_INTERVAL=60 \
  -v "$PWD/load:/scripts" grafana/k6 \
  run --summary-export=/scripts/full-summary.json /scripts/sale.js
```

A separate 20-second run used `DURATION=20s`, `RESTOCK_INTERVAL=5`, and `peak-summary.json`. Both runs passed the configured thresholds: catalog p95 < 150 ms, checkout p95 < 500 ms, HTTP 5xx < 0.5%, and zero dropped iterations.

The reconciler's database-clock grace check and keyset pagination were finalized after the k6 runs and verified separately below. They do not change the catalog, cart, checkout, or worker request paths exercised by k6.

| Measurement | 20 seconds | 3 minutes |
| --- | ---: | ---: |
| HTTP requests | 40,008 | 360,009 |
| Achieved rate | 2,000.05/s | 2,000.00/s |
| Dropped iterations | 0 | 0 |
| HTTP 5xx | 0 | 0 |
| Catalog p95 | 3.68 ms | 1.13 ms |
| Checkout p95, including stockouts | 13.62 ms | 3.40 ms |
| Cart p95 | 1.61 ms | 0.70 ms |
| Stockout responses (409) | 5,359 | 56,567 |
| Successful checkout responses, including idempotent replays | 2,541 | 15,461 |
| Unique confirmed orders after drain | 2,311 | 13,945 |
| Pending outbox rows after drain | 0 | 0 |
| Orders in payment review after drain | 0 | 0 |
| Invalid inventory rows | 0 | 0 |
| SKU rows with reservation/sold-counter drift | 0 | 0 |
| Multiple successful capture records for one order | 0 | 0 |

Raw k6 exports: [20-second summary](peak-summary.json) and [three-minute summary](full-summary.json). k6 counts 409 stockouts under its generic `http_req_failed` metric; the custom `server_error_rate` excludes them. The longest observed checkout was about 396 ms in the full run. Up to 16 VUs were active at once because responses were fast. This demonstrates the configured arrival rate on one local machine, **not** 20,000 simultaneous connections or production capacity.

## Partial failures

With the reconciler stopped, `SIM_TIMEOUT_AFTER_COMMIT_RATE=1` and `SIM_DROP_WEBHOOK_RATE=1`, an order became `PAYMENT_REVIEW` with a `HELD` reservation while the simulator ledger showed `SUCCEEDED`. Restarting the Python reconciler changed the order to `CONFIRMED` and the reservation to `CONSUMED`. A separate end-to-end check produced `FAILED` on an initial refund, then `REFUNDED` after an operator retry with a new provider key. The simulator's close operation was checked in both sequential orders and in 100 concurrent capture/close races using `node load/verify-close.mjs`; each key retained one result across repeated calls. In an end-to-end recovery check, the worker was stopped, a new capture was marked `IN_FLIGHT`, and its reserve expiry was moved 31 seconds into the past. Python closed the missing payment key, changed the order to `PAYMENT_FAILED`, and released the reserve. A later capture with that key returned the stored `FAILED`. The reconciler's keyset pager was checked with 205 eligible operations and returned all 205 across its 200-row boundary. Deliberate process pauses during the payment race have not been tested.

## Limits

The project uses a local payment simulator and a single PostgreSQL instance for orders. It has no real provider, cross-region replication, production authentication, fulfillment service, or production operational history. The measured latency is specific to the stated local machine and workload. The tests and runs do not prove behavior under arbitrary infrastructure failures.
