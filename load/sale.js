import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const api = __ENV.API_URL || 'http://api:3000';
const token = __ENV.OPERATOR_TOKEN || 'local-operator-token';
const stockout = new Counter('stockout_responses');
const throttled = new Counter('throttled_responses');
const serverErrors = new Rate('server_error_rate');
const duplicateRequests = new Counter('duplicate_requests');
const checkoutSuccess = new Counter('checkout_success');
const accepted = new Counter('accepted_requests');
const catalogLatency = new Trend('catalog_latency');
const checkoutLatency = new Trend('checkout_latency');
const cartLatency = new Trend('cart_latency');
const hot = ['load-hot-1', 'load-hot-2', 'load-hot-3'];

export const options = {
  scenarios: {
    traffic: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 2000),
      timeUnit: '1s',
      duration: __ENV.DURATION || '3m',
      preAllocatedVUs: Number(__ENV.PRE_VUS || 1000),
      maxVUs: Number(__ENV.MAX_VUS || 20000),
      exec: 'traffic',
    },
    restock: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '3m',
      exec: 'restock',
    },
  },
  thresholds: {
    server_error_rate: ['rate<0.005'],
    catalog_latency: ['p(95)<150'],
    checkout_latency: ['p(95)<500'],
    dropped_iterations: ['count<1'],
  },
};

let previous = null;
export function traffic() {
  const user = 'load-user-' + Math.ceil(Math.random() * 20000);
  const draw = Math.random();
  let response;
  if (draw < 0.7) {
    response = http.get(api + '/products?limit=24&offset=' + (Math.floor(Math.random() * 40) * 24));
    catalogLatency.add(response.timings.duration);
  } else if (draw < 0.9) {
    const isRetry = previous && Math.random() < 0.1;
    const sku = isRetry ? previous.sku : (Math.random() < 0.8 ? hot[Math.floor(Math.random() * 3)] : 'load-' + String(1 + Math.floor(Math.random() * 997)).padStart(4, '0'));
    const identity = isRetry ? previous.user : user;
    const key = isRetry ? previous.key : identity + '-' + Date.now() + '-' + Math.random();
    const payload = JSON.stringify({ items: [{ sku, quantity: 1 }] });
    response = http.post(api + '/orders', payload, { headers: { 'content-type': 'application/json', 'x-user-id': identity, 'Idempotency-Key': key } });
    checkoutLatency.add(response.timings.duration);
    if (!isRetry) previous = { sku, user: identity, key };
    else duplicateRequests.add(1);
    if (response.status === 201) checkoutSuccess.add(1);
    if (response.status === 409) stockout.add(1);
    if (response.status === 429) throttled.add(1);
  } else {
    response = http.get(api + '/cart', { headers: { 'x-user-id': user } });
    cartLatency.add(response.timings.duration);
  }
  if (response.status < 500) accepted.add(1);
  serverErrors.add(response.status >= 500);
  check(response, { 'expected API status': r => r.status < 500 });
}

export function restock() {
  for (let wave = 0; wave < 2; wave++) {
    sleep(Number(__ENV.RESTOCK_INTERVAL || 60));
    for (const sku of hot) {
      const response = http.post(api + '/operator/inventory/' + sku + '/adjust', JSON.stringify({ delta: 100 }), {
        headers: { 'content-type': 'application/json', 'x-operator-token': token },
      });
      check(response, { 'restock succeeded': r => r.status === 200 });
    }
  }
}
