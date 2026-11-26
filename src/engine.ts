// Reach engine: Connection Scan Algorithm over BMTC GTFS timetables (scheduled, not live).
export interface Meta {
  meta: { nStops: number; nRoutes: number; nPat: number; nTrips: number; nPatStops: number };
  stops: { n: string[]; lat: number[]; lon: number[] };
  routes: string[];
  kinds: string[];
}
export const INF = 0x3fffffff;
export const WALK_MPS = 1.25; // ~4.5 km/h
export const DETOUR = 1.3; // street-vs-straight-line factor
export const MAX_ACCESS_M = 1000;
export const MAX_TRANSFER_M = 250;
export const walkSecs = (m: number) => Math.round((m * DETOUR) / WALK_MPS);

export interface Leg {
  kind: 'walk' | 'bus';
  route?: string;
  from: number; // stop index, -1 = origin pin
  to: number;
  dep: number;
  arr: number;
}
export interface ScanResult {
  arr: Int32Array; // arrival seconds per stop, INF if unreached
  inConn: Int32Array;
  tripEnter: Int32Array;
  start: number;
  connectionsScanned: number;
  ms: number;
}

const M_PER_DEG_LAT = 111320;

export class Network {
  nStops: number;
  lat: Float64Array;
  lon: Float64Array;
  names: string[];
  routes: string[];
  kinds: string[];
  // patterns
  patRoute: Uint16Array;
  patOff: Uint32Array;
  patStops: Uint16Array;
  patArr: Uint16Array;
  patDep: Uint16Array;
  tripPat: Uint32Array;
  tripStart: Uint32Array;
  tripMask: Uint8Array;
  // footpaths (CSR)
  fpStart!: Uint32Array;
  fpTo!: Uint16Array;
  fpSecs!: Uint16Array;
  // grid for access
  private grid = new Map<number, number[]>();
  private cell = 0.01; // degrees ~1.1km
  // connections for selected day
  nConn = 0;
  cDep!: Int32Array;
  cArr!: Int32Array;
  cFrom!: Uint16Array;
  cTo!: Uint16Array;
  cTrip!: Int32Array;
  tripInstRoute!: Uint16Array;
  nTripInst = 0;
  day = -1;
  cosLat: number;

  constructor(meta: Meta, bin: ArrayBuffer) {
    const m = meta.meta;
    this.nStops = m.nStops;
    this.names = meta.stops.n;
    this.lat = Float64Array.from(meta.stops.lat);
    this.lon = Float64Array.from(meta.stops.lon);
    this.routes = meta.routes;
    this.kinds = meta.kinds;
    this.cosLat = Math.cos((12.97 * Math.PI) / 180);
    const P = m.nPat, N = m.nPatStops, T = m.nTrips;
    let o = 0;
    const u16 = (n: number) => { const a = new Uint16Array(bin.slice(o, o + n * 2)); o += n * 2; return a; };
    const u32 = (n: number) => { const a = new Uint32Array(bin.slice(o, o + n * 4)); o += n * 4; return a; };
    this.patRoute = u16(P);
    const cnt = u16(P);
    this.patStops = u16(N);
    this.patArr = u16(N);
    this.patDep = u16(N);
    this.tripPat = u32(T);
    this.tripStart = u32(T);
    this.tripMask = new Uint8Array(bin.slice(o, o + T));
    this.patOff = new Uint32Array(P + 1);
    for (let i = 0; i < P; i++) this.patOff[i + 1] = this.patOff[i] + cnt[i];
    this.buildGrid();
    this.buildFootpaths();
  }

  private key(i: number, j: number) { return i * 100003 + j; }
  private buildGrid() {
    for (let s = 0; s < this.nStops; s++) {
      const k = this.key(Math.floor(this.lat[s] / this.cell), Math.floor(this.lon[s] / this.cell));
      let a = this.grid.get(k);
      if (!a) this.grid.set(k, (a = []));
      a.push(s);
    }
  }
  distM(lat1: number, lon1: number, lat2: number, lon2: number) {
    const dy = (lat2 - lat1) * M_PER_DEG_LAT;
    const dx = (lon2 - lon1) * M_PER_DEG_LAT * this.cosLat;
    return Math.sqrt(dx * dx + dy * dy);
  }
  /** stops within radius metres of a point, with straight-line distance */
  near(lat: number, lon: number, radiusM: number): { s: number; d: number }[] {
    const out: { s: number; d: number }[] = [];
    const r = Math.ceil(radiusM / (this.cell * M_PER_DEG_LAT)) ;
    const ci = Math.floor(lat / this.cell), cj = Math.floor(lon / this.cell);
    for (let i = ci - r; i <= ci + r; i++)
      for (let j = cj - r; j <= cj + r; j++) {
        const a = this.grid.get(this.key(i, j));
        if (!a) continue;
        for (const s of a) {
          const d = this.distM(lat, lon, this.lat[s], this.lon[s]);
          if (d <= radiusM) out.push({ s, d });
        }
      }
    return out;
  }
  private buildFootpaths() {
    const n = this.nStops;
    const lists: { s: number; d: number }[][] = new Array(n);
    let total = 0;
    for (let s = 0; s < n; s++) {
      lists[s] = this.near(this.lat[s], this.lon[s], MAX_TRANSFER_M).filter((x) => x.s !== s);
      total += lists[s].length;
    }
    this.fpStart = new Uint32Array(n + 1);
    this.fpTo = new Uint16Array(total);
    this.fpSecs = new Uint16Array(total);
    let k = 0;
    for (let s = 0; s < n; s++) {
      this.fpStart[s] = k;
      for (const x of lists[s]) { this.fpTo[k] = x.s; this.fpSecs[k] = walkSecs(x.d); k++; }
    }
    this.fpStart[n] = k;
  }

  /** Build the sorted connection list for a weekday (0 = Monday). Includes after-midnight tails of the previous day. */
  setDay(day: number) {
    if (day === this.day) return;
    this.day = day;
    const prev = (day + 6) % 7;
    const T = this.tripStart.length;
    // count connections
    let cnt = 0;
    const active: number[] = []; // trip instance codes: t (today) or -(t+1)-... use two arrays
    const inst: { t: number; shift: number }[] = [];
    for (let t = 0; t < T; t++) {
      const p = this.tripPat[t];
      const len = this.patOff[p + 1] - this.patOff[p];
      if (this.tripMask[t] & (1 << day)) { inst.push({ t, shift: 0 }); cnt += len - 1; }
      if (this.tripMask[t] & (1 << prev)) {
        const last = this.patDep[this.patOff[p + 1] - 1] + this.tripStart[t];
        if (last >= 86400) { inst.push({ t, shift: -86400 }); cnt += len - 1; }
      }
    }
    void active;
    const dep = new Int32Array(cnt), arr = new Int32Array(cnt);
    const from = new Uint16Array(cnt), to = new Uint16Array(cnt), trip = new Int32Array(cnt);
    this.tripInstRoute = new Uint16Array(inst.length);
    let k = 0;
    inst.forEach((it, id) => {
      const p = this.tripPat[it.t];
      this.tripInstRoute[id] = this.patRoute[p];
      const o = this.patOff[p], e = this.patOff[p + 1];
      const base = this.tripStart[it.t] + it.shift;
      for (let i = o; i < e - 1; i++) {
        dep[k] = base + this.patDep[i]; arr[k] = base + this.patArr[i + 1];
        from[k] = this.patStops[i]; to[k] = this.patStops[i + 1]; trip[k] = id; k++;
      }
    });
    // keep only connections departing >= 0 and sort by dep (counting sort)
    let maxDep = 0;
    for (let i = 0; i < cnt; i++) if (dep[i] > maxDep) maxDep = dep[i];
    const B = maxDep + 2;
    const bucket = new Uint32Array(B + 1);
    for (let i = 0; i < cnt; i++) if (dep[i] >= 0) bucket[dep[i] + 1]++;
    for (let i = 0; i < B; i++) bucket[i + 1] += bucket[i];
    const total = bucket[B];
    const order = new Uint32Array(total);
    for (let i = 0; i < cnt; i++) if (dep[i] >= 0) order[bucket[dep[i]]++] = i;
    this.cDep = new Int32Array(total); this.cArr = new Int32Array(total);
    this.cFrom = new Uint16Array(total); this.cTo = new Uint16Array(total); this.cTrip = new Int32Array(total);
    for (let i = 0; i < total; i++) {
      const j = order[i];
      this.cDep[i] = dep[j]; this.cArr[i] = arr[j]; this.cFrom[i] = from[j]; this.cTo[i] = to[j]; this.cTrip[i] = trip[j];
    }
    this.nConn = total;
    this.nTripInst = inst.length;
  }

  private firstConn(t: number) {
    let lo = 0, hi = this.nConn;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cDep[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /** Earliest-arrival scan from a pin. t0 = departure seconds after midnight; maxSecs = travel-time budget. */
  scan(lat: number, lon: number, t0: number, maxSecs: number): ScanResult {
    const t1 = performance.now();
    const arr = new Int32Array(this.nStops).fill(INF);
    const inConn = new Int32Array(this.nStops).fill(-1);
    const tripEnter = new Int32Array(this.nTripInst).fill(-1);
    const limit = t0 + maxSecs;
    for (const { s, d } of this.near(lat, lon, MAX_ACCESS_M)) {
      const a = t0 + walkSecs(d);
      if (a <= limit && a < arr[s]) { arr[s] = a; inConn[s] = -2; }
    }
    // walking links from access stops
    for (let s = 0; s < this.nStops; s++) if (inConn[s] === -2) this.relaxWalk(s, arr, inConn, limit);
    let c = this.firstConn(t0), scanned = 0;
    const { cDep, cArr, cFrom, cTo, cTrip, nConn } = this;
    for (; c < nConn; c++) {
      const dep = cDep[c];
      if (dep > limit) break;
      scanned++;
      const tr = cTrip[c];
      if (tripEnter[tr] < 0) {
        if (arr[cFrom[c]] > dep) continue;
        tripEnter[tr] = c;
      }
      const a = cArr[c], to = cTo[c];
      if (a < arr[to] && a <= limit) {
        arr[to] = a; inConn[to] = c;
        this.relaxWalk(to, arr, inConn, limit);
      }
    }
    return { arr, inConn, tripEnter, start: t0, connectionsScanned: scanned, ms: performance.now() - t1 };
  }
  private relaxWalk(s: number, arr: Int32Array, inConn: Int32Array, limit: number) {
    const a0 = arr[s];
    for (let k = this.fpStart[s]; k < this.fpStart[s + 1]; k++) {
      const n = this.fpTo[k], a = a0 + this.fpSecs[k];
      if (a < arr[n] && a <= limit) { arr[n] = a; inConn[n] = -3 - s; }
    }
  }

  /** Journey legs (in travel order) to a reached stop. */
  trace(r: ScanResult, stop: number): Leg[] {
    const legs: Leg[] = [];
    let s = stop, guard = 0;
    while (guard++ < 40) {
      const ic = r.inConn[s];
      if (ic === -1) break;
      if (ic === -2) { legs.push({ kind: 'walk', from: -1, to: s, dep: r.start, arr: r.arr[s] }); break; }
      if (ic <= -3) {
        const f = -3 - ic;
        legs.push({ kind: 'walk', from: f, to: s, dep: r.arr[f], arr: r.arr[s] });
        s = f; continue;
      }
      const b = r.tripEnter[this.cTrip[ic]];
      legs.push({ kind: 'bus', route: this.routes[this.tripInstRoute[this.cTrip[ic]]], from: this.cFrom[b], to: s, dep: this.cDep[b], arr: r.arr[s] });
      s = this.cFrom[b];
    }
    return legs.reverse();
  }
}
