import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Product = { sku: string; name: string; description: string; price_cents: number; currency: string; image_url: string; available: number };
type Order = { id: string; status: string; amount_cents: number; expires_at?: string; reservation?: { expires_at: string }; payments?: { kind: string; status: string }[] };
const API = import.meta.env.VITE_API_URL || 'http://localhost:3003';
const user = localStorage.getItem('sale-user') || crypto.randomUUID();
localStorage.setItem('sale-user', user);
const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);

async function request<T>(path: string, init: RequestInit = {}, extra: Record<string, string> = {}): Promise<T> {
  const response = await fetch(API + path, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-user-id': user, ...extra, ...init.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body as T;
}

function App() {
  const [view, setView] = useState<'store' | 'operator'>('store');
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [order, setOrder] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [operatorToken, setOperatorToken] = useState(sessionStorage.getItem('operator-token') || '');
  const [inventory, setInventory] = useState<(Product & { total: number; reserved: number; sold: number })[]>([]);
  const [review, setReview] = useState<{ review: { id: string; status: string }[]; cases: { id: string; kind: string }[]; outbox_pending: number } | null>(null);

  const refresh = async () => {
    try {
      setProducts(await request<Product[]>('/products'));
      const current = await request<{ items: { sku: string; quantity: number }[] }>('/cart');
      setCart(Object.fromEntries(current.items.map(i => [i.sku, i.quantity])));
    } catch (error) { setMessage(String(error)); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!order?.id || ['CONFIRMED','REFUNDED','CANCELLED','EXPIRED','PAYMENT_FAILED'].includes(order.status)) return;
    const timer = setInterval(async () => {
      try { setOrder(await request<Order>('/orders/' + order.id)); await refreshProducts(); } catch { /* next poll */ }
    }, 1500);
    return () => clearInterval(timer);
  }, [order?.id, order?.status]);
  const refreshProducts = async () => setProducts(await request<Product[]>('/products'));
  const updateCart = async (sku: string, quantity: number) => {
    try {
      await request('/cart/items/' + sku, { method: 'PUT', body: JSON.stringify({ quantity }) });
      setCart(current => ({ ...current, [sku]: quantity }));
      setMessage('');
    } catch (error) { setMessage(String(error)); }
  };
  const checkout = async () => {
    const items = Object.entries(cart).filter(([, quantity]) => quantity > 0).map(([sku, quantity]) => ({ sku, quantity }));
    if (!items.length) return;
    setBusy(true); setMessage('');
    try {
      const created = await request<Order>('/orders', { method: 'POST', body: JSON.stringify({ items }) }, { 'Idempotency-Key': crypto.randomUUID() });
      setOrder(created);
      await Promise.all(items.map(item => request('/cart/items/' + item.sku, { method: 'PUT', body: JSON.stringify({ quantity: 0 }) })));
      setCart({});
      await refreshProducts();
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!order) return;
    try { setOrder({ ...order, ...await request<Order>('/orders/' + order.id + '/cancel', { method: 'POST' }, { 'Idempotency-Key': crypto.randomUUID() }) }); }
    catch (error) { setMessage(String(error)); }
  };
  const refreshOperator = async () => {
    if (!operatorToken) return;
    try {
      const headers = { 'x-operator-token': operatorToken };
      const [stock, status] = await Promise.all([
        request<typeof inventory>('/operator/inventory', {}, headers),
        request<NonNullable<typeof review>>('/operator/reconciliation', {}, headers),
      ]);
      setInventory(stock); setReview(status); setMessage('');
    } catch (error) { setMessage(String(error)); }
  };
  useEffect(() => { if (view === 'operator') void refreshOperator(); }, [view, operatorToken]);
  const adjust = async (sku: string, delta: number) => {
    try {
      await request('/operator/inventory/' + sku + '/adjust', { method: 'POST', body: JSON.stringify({ delta }) }, { 'x-operator-token': operatorToken });
      await refreshOperator(); await refreshProducts();
    } catch (error) { setMessage(String(error)); }
  };
  const itemCount = Object.values(cart).reduce((sum, n) => sum + n, 0);
  const total = products.reduce((sum, p) => sum + (cart[p.sku] || 0) * p.price_cents, 0);
  const hero = products[0];

  return <div className="app">
    <header className="topbar">
      <button className="wordmark" onClick={() => setView('store')}>DROP<span> / LAB</span></button>
      <nav aria-label="Main navigation">
        <button className={view === 'store' ? 'active' : ''} onClick={() => setView('store')}>Store</button>
        <button className={view === 'operator' ? 'active' : ''} onClick={() => setView('operator')}>Operations</button>
      </nav>
      <div className="topbar-right">SALE SESSION <span className="dot" /> <strong>{itemCount} IN BAG</strong></div>
    </header>
    {view === 'store' ? <>
      <section className="hero" style={{ backgroundImage: hero ? 'linear-gradient(90deg, rgba(13,19,18,.95) 0%, rgba(13,19,18,.73) 42%, rgba(13,19,18,.10) 100%), url(' + hero.image_url + ')' : undefined }}>
        <div className="hero-copy">
          <div className="eyebrow"><span className="pulse" /> LIMITED DROP / LIVE NOW</div>
          <h1>Good things<br/>go fast.</h1>
          <p>Small runs. Clear prices. Five minutes to make it yours.</p>
          <a href="#collection" className="hero-link">Explore the drop <span>↗</span></a>
        </div>
        <div className="hero-index">001 — CURATED ESSENTIALS</div>
      </section>
      <section className="collection" id="collection">
        <div className="section-head"><div><span className="eyebrow dark">THE CURRENT DROP</span><h2>Objects worth keeping.</h2></div><p>Availability is checked when your order is placed. A reservation lasts five minutes.</p></div>
        <div className="products">
          {products.map((product, index) => <article className="product" key={product.sku}>
            <div className="product-image"><img src={product.image_url} alt={product.name}/><span className="index">0{index + 1}</span></div>
            <div className="product-info"><div><h3>{product.name}</h3><p>{product.description}</p></div><strong>{money(product.price_cents)}</strong></div>
            <div className="product-action"><span>{product.available > 0 ? product.available + ' AVAILABLE' : 'SOLD OUT'}</span><button disabled={product.available === 0} onClick={() => void updateCart(product.sku, (cart[product.sku] || 0) + 1)}>{cart[product.sku] ? 'ADD ANOTHER +' : 'ADD TO BAG +'}</button></div>
          </article>)}
        </div>
      </section>
      <aside className="bag">
        <div><span className="eyebrow dark">YOUR BAG / {itemCount} ITEMS</span><div className="bag-items">{Object.entries(cart).filter(([, q]) => q > 0).map(([sku, quantity]) => <div key={sku}><span>{products.find(p => p.sku === sku)?.name || sku} <small>× {quantity}</small></span><button onClick={() => void updateCart(sku, quantity - 1)}>−</button></div>)}{!itemCount && <p>Nothing in your bag yet.</p>}</div></div>
        <div className="bag-checkout"><div><span>TOTAL</span><strong>{money(total)}</strong></div><button disabled={!itemCount || busy} onClick={() => void checkout()}>{busy ? 'PLACING ORDER…' : 'PLACE ORDER'} <span>↗</span></button></div>
      </aside>
      {order && <section className="order-strip"><div><span className="eyebrow">LATEST ORDER / {order.id.slice(0, 8)}</span><h2>{order.status.replaceAll('_', ' ')}</h2><p>{order.status === 'PAYMENT_REVIEW' ? 'The payment outcome is being checked. Your reservation stays held meanwhile.' : order.status === 'CONFIRMED' ? 'Your order is confirmed.' : 'Keep this page open for the latest status.'}</p></div><div><span>{money(order.amount_cents)}</span><button onClick={() => void cancel()} disabled={['CANCELLED','REFUNDED','EXPIRED','PAYMENT_FAILED'].includes(order.status)}>CANCEL / REFUND ↗</button></div></section>}
    </> : <main className="operations">
      <div className="ops-title"><div><span className="eyebrow dark">DROP / CONTROL ROOM</span><h1>Operations</h1><p>Inventory, payment review and reconciliation.</p></div><button className="outline" onClick={() => void refreshOperator()}>REFRESH ↻</button></div>
      {!operatorToken ? <div className="token-entry"><label htmlFor="operator-token">OPERATOR TOKEN</label><input id="operator-token" type="password" placeholder="Enter local demo token" onChange={event => { sessionStorage.setItem('operator-token', event.target.value); setOperatorToken(event.target.value); }}/></div> : <>
        <div className="ops-stats"><div><span>SKUS</span><strong>{inventory.length}</strong></div><div><span>RESERVED UNITS</span><strong>{inventory.reduce((n, i) => n + i.reserved, 0)}</strong></div><div><span>ORDERS IN REVIEW</span><strong>{review?.review.length ?? '—'}</strong></div><div><span>OUTBOX PENDING</span><strong>{review?.outbox_pending ?? '—'}</strong></div></div>
        <section className="ops-section"><div className="ops-section-head"><h2>Inventory</h2><span>ADJUST AVAILABLE STOCK</span></div><div className="table-wrap"><table><thead><tr><th>SKU</th><th>AVAILABLE</th><th>RESERVED</th><th>SOLD</th><th>TOTAL</th><th>ACTION</th></tr></thead><tbody>{inventory.map(row => <tr key={row.sku}><td><strong>{row.name}</strong><small>{row.sku}</small></td><td>{row.available}</td><td>{row.reserved}</td><td>{row.sold}</td><td>{row.total}</td><td><button onClick={() => void adjust(row.sku, 10)}>+10</button><button onClick={() => void adjust(row.sku, -10)}>−10</button></td></tr>)}</tbody></table></div></section>
        <section className="ops-section"><div className="ops-section-head"><h2>Payment review</h2><span>{review?.review.length ?? 0} OPEN</span></div>{review?.review.length ? review.review.map(row => <div className="review-row" key={row.id}><code>{row.id}</code><span>{row.status}</span></div>) : <p className="empty">No orders need review.</p>}</section>
        <section className="ops-section"><div className="ops-section-head"><h2>Reconciliation cases</h2><span>{review?.cases.length ?? 0} OPEN</span></div>{review?.cases.length ? review.cases.map(row => <div className="review-row" key={row.id}><code>{row.id.slice(0, 8)}</code><span>{row.kind}</span></div>) : <p className="empty">No unresolved discrepancies.</p>}</section>
      </>}
    </main>}
    {message && <div className="toast" role="alert">{message}<button onClick={() => setMessage('')}>×</button></div>}
    <footer><span>DROP / LAB</span><span>A CONCURRENCY STUDY, NOT A LIVE STORE</span><span>© 2026</span></footer>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
