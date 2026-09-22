// QA-only mock of the modern API envelope (NOT part of the repo). Shapes copied from src/modules/*/routes.
import http from 'node:http';
const user = { id: 1, email: 'trader@velora.test', fullName: 'Sara Ahmadi', role: 'user', plan: 'pro', timezone: 'Asia/Tehran', locale: process.env.MOCK_LOCALE || 'fa', createdAt: '2026-01-10T08:00:00Z', aiConsent: true };
const tokens = { accessToken: 'qa-token', expiresIn: 900, tokenType: 'Bearer', user };
const ok = (data) => JSON.stringify({ status: 'success', data, error: null, timestamp: new Date().toISOString() });
const err = (code, status, message) => JSON.stringify({ status: 'error', data: null, error: { code, message, messageKey: 'errors.notFound' }, timestamp: new Date().toISOString() });
const accounts = [
  { id: 11, provider: 'metaapi', platform: 'mt5', broker: 'Vittaverse', server: 'Vittaverse-Server', mtLogin: '813578', label: 'حساب 813578', accountNumber: '813578', currency: 'USD', leverage: '1:500', status: 'active', syncStatus: 'synced', lastSyncedAt: '2026-09-21T14:22:00Z', connectedAt: '2026-08-01T10:00:00Z', balance: '10432.50', equity: '10510.20', createdAt: '2026-08-01T10:00:00Z' },
  { id: 12, provider: 'manual', platform: 'mt4', broker: null, server: null, mtLogin: null, label: 'Demo MT4', accountNumber: '90021', currency: 'USD', leverage: null, status: 'active', syncStatus: 'idle', lastSyncedAt: null, connectedAt: null, balance: '5000.00', equity: '4980.00', createdAt: '2026-08-15T10:00:00Z' },
];
const syms = ['XAUUSD','EURUSD','BTCUSD','US30','GBPJPY','NAS100'];
const trades = Array.from({ length: 14 }, (_, i) => {
  const pl = ((i * 37) % 11 - 4) * 41.5; const d = new Date(Date.UTC(2026, 8, 20 - i, 9 + (i % 6), 15));
  return { id: 100 + i, symbol: syms[i % syms.length], direction: i % 3 ? 'buy' : 'sell', entryPrice: '2458.30', exitPrice: '2461.10', volume: '0.50', contractSize: '100', commission: '3.50', swap: '0.00', profitLoss: pl.toFixed(2), rMultiple: (pl / 120).toFixed(2), stopLoss: '2452.00', takeProfit: '2470.00', accountId: 11, openTime: d.toISOString(), closeTime: new Date(d.getTime() + 3.6e6).toISOString(), occurredOpenAtUtc: d.toISOString(), occurredCloseAtUtc: new Date(d.getTime() + 3.6e6).toISOString(), timeStatus: 'exact', sourceTimezone: 'UTC', sourceTimezoneSource: 'broker', sourceCalendar: 'gregorian', rawOpenText: null, rawCloseText: null, session: ['london','newyork','asia'][i % 3], strategyTag: ['FVG','Order Block 15M','Breakout'][i % 3], emotionalScore: (i % 5) + 1, notes: i % 4 ? 'Clean setup, followed the plan.' : null, source: i % 2 ? 'manual' : 'metaapi', createdAt: d.toISOString(), updatedAt: d.toISOString() };
});
const curve = Array.from({ length: 30 }, (_, i) => ({ date: new Date(Date.UTC(2026, 7, 23 + i)).toISOString().slice(0, 10), pnl: (Math.sin(i / 3) * 120).toFixed(2), equity: (10000 + i * 45 + Math.sin(i / 2) * 200).toFixed(2) }));
const summary = { tradeCount: 14, wins: 9, losses: 4, breakeven: 1, winRate: 0.6429, totalPnl: '1284.50', profitFactor: '2.14', averageR: '1.32', bestTrade: '290.50', worstTrade: '-166.00', equityCurve: curve };
const strategies = [{ strategy: 'Order Block 15M', tradeCount: 6, winRate: 0.72, pnl: '890.00' }, { strategy: 'FVG', tradeCount: 5, winRate: 0.6, pnl: '410.50' }, { strategy: 'Breakout', tradeCount: 3, winRate: 0.33, pnl: '-16.00' }];
const tickets = [
  { id: 7, subject: 'همگام‌سازی حساب MT5 متوقف شده', status: 'open', waiting_for: 'admin', unread_user_count: 0, last_message_at: '2026-09-20 14:02' },
  { id: 5, subject: 'Invoice for Pro plan', status: 'pending', waiting_for: 'user', unread_user_count: 2, last_message_at: '2026-09-18 09:40' },
  { id: 2, subject: 'Password reset email not received', status: 'closed', waiting_for: 'none', unread_user_count: 0, last_message_at: '2026-08-30 11:15' },
];
const thread = (id) => ({ conversation: tickets.find((t) => t.id === id) || tickets[0], messages: [
  { id: 1, sender_type: 'user', body: 'سلام، از دیروز حساب من سینک نمی‌شود.\nوضعیت روی "in progress" مانده است.', created_at: '2026-09-19 18:20' },
  { id: 2, sender_type: 'admin', body: 'Thanks — we are checking the MetaAPI connection for login 813578.', created_at: '2026-09-20 14:02' },
] });
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname.replace(/\/$/, ''); const m = req.method;
  res.setHeader('content-type', 'application/json');
  const send = (s, b) => { res.statusCode = s; res.end(b); };
  if (p === '/api/v1/auth/refresh' && m === 'POST') return send(200, ok({ tokens }));
  if (p === '/api/v1/auth/me') return send(200, ok({ user }));
  if (p === '/api/v1/auth/me/preferences') return send(200, ok({ user }));
  if (p === '/api/v1/auth/logout') return send(200, ok({ loggedOut: true }));
  if (p === '/api/v1/accounts' && m === 'GET') return send(200, ok({ accounts }));
  if (p === '/api/v1/dashboard/summary') return send(200, ok({ summary }));
  if (p === '/api/v1/dashboard/equity-curve') return send(200, ok({ equityCurve: curve }));
  if (p === '/api/v1/dashboard/strategies') return send(200, ok({ strategies }));
  if (p === '/api/v1/trades' && m === 'GET') { const l = Number(u.searchParams.get('limit') || 30); return send(200, ok({ items: trades.slice(0, l), total: trades.length, page: 1, limit: l })); }
  if (p === '/api/v1/trades' && m === 'POST') return send(201, ok({ trade: trades[0] }));
  if (p === '/api/v1/support/tickets' && m === 'GET') return send(200, ok({ tickets, unread_total: 2 }));
  const t = p.match(/^\/api\/v1\/support\/tickets\/(\d+)$/); if (t) return send(200, ok(thread(Number(t[1]))));
  return send(404, err('NOT_FOUND', 404, 'Route not found: ' + p));
}).listen(8080, '127.0.0.1', () => console.log('mock api on 8080'));
