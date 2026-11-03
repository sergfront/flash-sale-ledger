# DROP / LAB — flash sale platform

A portfolio implementation of a limited-stock sale. The central rule is simple: **a SKU cannot have more reserved and sold units than its recorded total**. The repository contains a React store and operator view, a Node.js/TypeScript order API and worker, a separate durable payment simulator, and a Python reconciliation process.

This is a local demonstration, not a claim about production traffic or a real payment provider.

The detailed Russian [architecture and implementation plan](docs/ARCHITECTURE.md) covers invariants, order states, failure sequences, tradeoffs, API, load targets, and the distributed follow-up.

## Run

Requires Docker Compose and Node.js 22+.

```sh
docker compose up --build -d
curl http://localhost:3003/health
```

- Store and operator UI: http://localhost:5173
- API: http://localhost:3003
- Payment simulator: http://localhost:3001
- PostgreSQL (for local scripts and tests): localhost:5435
- Local operator token: `local-operator-token`

The UI uses a generated `x-user-id` for demo identity. The operator view asks for the local token. Neither mechanism is production authentication.

```sh
docker compose logs -f api worker simulator reconciler
docker compose down
```

Use `docker compose down -v` only when you intentionally want to delete both local database volumes.

## Transaction boundary

`POST /orders` requires `Idempotency-Key` and a body such as:

```json
{"items":[{"sku":"camera","quantity":1}]}
```

One PostgreSQL transaction stores the idempotency result, order snapshot, reservation, stock movement, payment operation, and outbox command. For every SKU, `available >= quantity` is part of the inventory `UPDATE`. Multi-SKU orders update rows in SKU order. On a stock conflict, a savepoint rolls back every order and inventory write while the transaction commits the 409 response under the idempotency key. Repeating that key returns the same 409 even after a restock; a new purchase attempt needs a new key. Other failures roll back the transaction. The database checks:

```text
available >= 0; reserved >= 0; sold >= 0
available + reserved + sold = total
```

The worker leases outbox rows, calls the simulator with `capture:{order_id}`, and settles the result. The simulator has its own PostgreSQL database. Its idempotency key prevents a retry from charging twice. The API deduplicates webhook events and applies conditional order transitions. A payment timeout is an unknown result, so the reservation stays held while the Python service queries the simulator and asks the API to settle it.

Reservations expire after five minutes. If a payment attempt is still uncertain, the order enters `PAYMENT_REVIEW`; stock is not released until the outcome is known. After a grace period, reconciliation atomically closes a missing capture key in the simulator ledger: a concurrent capture either wins and is observed, or receives the stored failure. This permits safe release without treating a plain 404 as proof of failure. A late successful charge against a released or cancelled reservation creates a refund operation. A failed refund can be retried by the operator with a new provider key while retaining the failed attempt for audit. A monetary refund does not automatically restock the item.

The queue is PostgreSQL outbox polling. RabbitMQ is a documented next stage for independent consumers; it is not required for the local implementation. The `inbox` table is present for that extension.

## API routes

| Route | Purpose |
| --- | --- |
| `GET /products?limit=24&offset=0` | Catalog page and display availability |
| `GET /products/:sku` | Product detail |
| `GET /cart`, `PUT /cart/items/:sku` | Demo user's cart |
| `POST /orders`, `GET /orders/:id` | Reserve and inspect order |
| `POST /orders/:id/cancel` | Cancel or begin refund |
| `POST /payment-webhooks/simulator` | Signed simulator event |
| `GET /operator/inventory`, `POST /operator/inventory/:sku/adjust` | Stock inspection and adjustment |
| `GET /operator/reconciliation`, `POST /operator/orders/:id/refund` | Exception handling |
| `POST /operator/orders/:id/refund/retry` | Retry a failed refund with a fresh provider key |

Customer routes require `x-user-id`; order creation and cancellation also require `Idempotency-Key`. Operator routes require `x-operator-token`. The internal settlement route is intended only for the reconciler.

## Tests

```sh
npm install
npm run build
npm test
```

The tests create an isolated `sale_test` database on the local PostgreSQL server. Set `TEST_DATABASE_URL` to use a different test database. They exercise 5,000 concurrent attempts for 100 units, duplicate settlement, simultaneous idempotency keys, replay of a stock conflict after restocking, a late charge after cancellation, atomic rollback of a multi-SKU order, a charge reported after its reservation was released, and a failed refund retried with a new provider key. The expected result of the concurrency case is exactly 100 reservations and ultimately 100 sold units; all 4,900 losing attempts receive a stock conflict.

With the simulator running, `node load/verify-close.mjs` checks 100 concurrent capture/close races against its durable ledger.

## Failure demonstration

The simulator exposes deterministic fault rates. The following run makes every capture return a timeout **after** persisting the result and drops its webhook:

```sh
docker compose stop reconciler
SIM_TIMEOUT_AFTER_COMMIT_RATE=1 SIM_DROP_WEBHOOK_RATE=1 docker compose up -d --force-recreate simulator
curl -X POST http://localhost:3003/orders \
  -H 'content-type: application/json' \
  -H 'x-user-id: fault-demo' \
  -H 'Idempotency-Key: fault-demo-1' \
  -d '{"items":[{"sku":"speaker","quantity":1}]}'
```

The API order moves to `PAYMENT_REVIEW` while the simulator ledger has `SUCCEEDED`. Restarting `reconciler` causes the Python service to query the ledger and complete the order. Use `docker compose up -d --force-recreate simulator` without the two fault environment variables to restore normal behavior.

## Load profile

The k6 script in `load/sale.js` defines 1,000 SKUs, 20,000 possible user identities, a target of 2,000 requests/s for three minutes, 70% catalog reads, 20% checkout attempts, and 10% cart reads. Eighty percent of checkout attempts hit three hot SKUs. A separate scenario adds 100 units to each hot SKU at 60 and 120 seconds. Ten percent of checkout calls reuse a prior idempotency key. Business stockout responses are counted separately from HTTP 5xx.

Use fresh demo volumes if you want the load seed to start from its documented stock:

```sh
docker compose exec -T api npm run seed:load -w apps/api
docker run --rm --network flash-sale-platform_default \
  -v "$PWD/load:/scripts" \
  grafana/k6 run --summary-export=/scripts/summary.json /scripts/sale.js
```

For a short smoke run, set `-e RATE=50 -e DURATION=20s -e RESTOCK_INTERVAL=5` before the image name. To inject payment faults, recreate the simulator with `SIM_FAIL_RATE=.02 SIM_TIMEOUT_AFTER_COMMIT_RATE=.05 SIM_DROP_WEBHOOK_RATE=.05` in the environment. Record the Docker host's CPU, memory, architecture and database settings with the k6 summary; absolute latency targets are meaningful only with that context.

After a run, inspect the invariant directly:

```sh
docker compose exec -T db psql -U sale -d sale -c \
  "SELECT sku,total,available,reserved,sold FROM inventory WHERE total <> available+reserved+sold OR LEAST(available,reserved,sold)<0"
```

An empty result is necessary but not sufficient: compare `reserved` with held reservation items and `sold` with consumed reservation items, as the Python reconciler does.

## Honest portfolio claim

The committed [load report](load/REPORT.md) contains fresh 20-second and three-minute runs of this revision, with raw k6 exports and the local machine specification. These are local measurements, not production traffic.

The repository can substantiate the schema, state transitions, fault reproduction, concurrent test results, and any committed load report. It cannot substantiate real customer traffic or a production provider. State measured throughput and latency only after running the script on a recorded machine.
