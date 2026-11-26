import { Network, INF, type Meta, type ScanResult } from './engine';
let net: Network;
let last: ScanResult[] = [];
type Origin = { lat: number; lon: number };
self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') {
    net = new Network(m.meta as Meta, m.bin as ArrayBuffer);
    (self as any).postMessage({ type: 'ready' });
  } else if (m.type === 'scan') {
    net.setDay(m.day);
    last = (m.origins as Origin[]).map((o) => net.scan(o.lat, o.lon, m.t0, m.maxSecs));
    const arrs = last.map((r) => r.arr.slice());
    (self as any).postMessage(
      { type: 'scan', id: m.id, arrs, ms: last.reduce((a, r) => a + r.ms, 0), scanned: last.reduce((a, r) => a + r.connectionsScanned, 0), nConn: net.nConn },
      arrs.map((a) => a.buffer)
    );
  } else if (m.type === 'trace') {
    const r = last[m.origin];
    if (!r) return;
    (self as any).postMessage({ type: 'trace', req: m.req, origin: m.origin, stop: m.stop, legs: net.trace(r, m.stop) });
  } else if (m.type === 'profile') {
    net.setDay(m.day);
    const o = m.origin as Origin, out: number[] = [];
    for (let t = 4 * 3600; t < 24 * 3600; t += 1800) {
      const r = net.scan(o.lat, o.lon, t, m.maxSecs);
      let n = 0;
      for (let i = 0; i < r.arr.length; i++) if (r.arr[i] < INF) n++;
      out.push(n);
    }
    (self as any).postMessage({ type: 'profile', id: m.id, counts: out });
  }
};
