"""Read payment truth, then ask the order API to apply its normal transitions."""
import json
import os
import time
import uuid

import httpx
import psycopg

DATABASE_URL = os.getenv("DATABASE_URL", "postgres://sale:sale@localhost:5432/sale")
PAYMENT_URL = os.getenv("PAYMENT_URL", "http://localhost:3001")
API_URL = os.getenv("API_URL", "http://localhost:3000")
TOKEN = os.getenv("OPERATOR_TOKEN", "local-operator-token")
PAYMENT_TOKEN = os.getenv("PAYMENT_INTERNAL_TOKEN", "local-payment-token")


def record_case(conn, order_id, kind, details):
    with conn.cursor() as cursor:
        cursor.execute(
            "SELECT 1 FROM reconciliation_cases WHERE order_id IS NOT DISTINCT FROM %s "
            "AND kind=%s AND resolved_at IS NULL LIMIT 1",
            (order_id, kind),
        )
        if cursor.fetchone() is None:
            cursor.execute(
                "INSERT INTO reconciliation_cases(id,order_id,kind,details) VALUES(%s,%s,%s,%s)",
                (uuid.uuid4(), order_id, kind, json.dumps(details)),
            )
            conn.commit()


def pending_operations(conn):
    marker = None
    while True:
        query = (
            "SELECT o.updated_at,o.id,o.status,r.expires_at,p.kind,p.provider_key,p.status,p.amount_cents,"
            "r.expires_at + interval '30 seconds' <= clock_timestamp() AS close_due "
            "FROM orders o JOIN reservations r ON r.order_id=o.id "
            "JOIN payment_operations p ON p.order_id=o.id "
            "WHERE o.status IN ('PENDING_PAYMENT','PAYMENT_REVIEW','REFUND_PENDING') "
            "AND p.status IN ('IN_FLIGHT','UNKNOWN','SUCCEEDED') "
            "AND NOT (o.status='REFUND_PENDING' AND p.kind='CAPTURE') "
        )
        if marker is not None:
            query += "AND (o.updated_at,o.id,p.provider_key) > (%s,%s,%s) "
        query += "ORDER BY o.updated_at,o.id,p.provider_key LIMIT 200"
        with conn.cursor() as cursor:
            cursor.execute(query, marker if marker is not None else ())
            operations = cursor.fetchall()
        if not operations:
            break
        for row in operations:
            marker = (row[0], row[1], row[5])
            yield row[1:]


def reconcile_once(conn, http):
    for order_id, order_status, expires_at, kind, provider_key, op_status, amount_cents, close_due in pending_operations(conn):
        if kind == "CAPTURE" and order_status == "REFUND_PENDING":
            continue
        try:
            response = http.get(PAYMENT_URL + "/operations/" + provider_key)
            if response.status_code == 404:
                if kind == "CAPTURE" and close_due:
                    response = http.post(
                        PAYMENT_URL + "/operations/" + provider_key + "/close",
                        headers={"x-payment-token": PAYMENT_TOKEN},
                        json={"order_id": str(order_id), "amount_cents": amount_cents},
                    )
                else:
                    continue
            response.raise_for_status()
            payment = response.json()
            result = {
                "order_id": str(order_id),
                "kind": kind,
                "status": payment["status"],
                "occurred_at": payment["occurred_at"],
                "provider_key": provider_key,
            }
            settled = http.post(
                API_URL + "/internal/settle",
                headers={"x-operator-token": TOKEN},
                json=result,
            )
            settled.raise_for_status()
            if kind == "REFUND" and result["status"] == "FAILED":
                record_case(conn, order_id, "REFUND_FAILED", {"provider_key": provider_key})
            with conn.cursor() as cursor:
                cursor.execute(
                    "UPDATE reconciliation_cases SET resolved_at=clock_timestamp() "
                    "WHERE order_id=%s AND kind IN ('PAYMENT_RECONCILIATION','PAYMENT_NOT_FOUND') AND resolved_at IS NULL",
                    (order_id,),
                )
                conn.commit()
        except Exception as error:
            print("payment reconciliation error", order_id, error, flush=True)
            record_case(conn, order_id, "PAYMENT_RECONCILIATION", {"error": str(error)})

    with conn.cursor() as cursor:
        cursor.execute(
            "SELECT i.sku,i.reserved,i.sold,"
            "COALESCE((SELECT sum(ri.quantity) FROM reservation_items ri "
            "JOIN reservations r ON r.order_id=ri.order_id WHERE ri.sku=i.sku AND r.status='HELD'),0),"
            "COALESCE((SELECT sum(ri.quantity) FROM reservation_items ri "
            "JOIN reservations r ON r.order_id=ri.order_id WHERE ri.sku=i.sku AND r.status='CONSUMED'),0) "
            "FROM inventory i"
        )
        stock = cursor.fetchall()
    for sku, reserved, sold, held_items, consumed_items in stock:
        if reserved != held_items or sold != consumed_items:
            print("inventory drift", sku, reserved, held_items, sold, consumed_items, flush=True)
            record_case(conn, None, "INVENTORY_DRIFT:" + sku, {
                "reserved": reserved,
                "held_items": held_items,
                "sold": sold,
                "consumed_items": consumed_items,
            })
        else:
            with conn.cursor() as cursor:
                cursor.execute(
                    "UPDATE reconciliation_cases SET resolved_at=clock_timestamp() "
                    "WHERE kind=%s AND resolved_at IS NULL",
                    ("INVENTORY_DRIFT:" + sku,),
                )
                conn.commit()


if __name__ == "__main__":
    while True:
        try:
            with psycopg.connect(DATABASE_URL) as connection, httpx.Client(timeout=4) as client:
                reconcile_once(connection, client)
        except Exception as exc:
            print("reconciler cycle failed", exc, flush=True)
        time.sleep(5)
