import csv, json, gzip, struct, sys
from collections import defaultdict
import numpy as np
D='data/'
def t(s):
    h,m,x=s.split(':'); return int(h)*3600+int(m)*60+int(x)
# calendar
cal={}
for r in csv.DictReader(open(D+'calendar.txt')):
    m=0
    for i,d in enumerate(['monday','tuesday','wednesday','thursday','friday','saturday','sunday']):
        if r[d]=='1': m|=1<<i
    cal[r['service_id']]=m
routes={}
for r in csv.DictReader(open(D+'routes.txt')):
    routes[r['route_id']]=(r['route_short_name'],r['route_desc'])
trips={}
for r in csv.DictReader(open(D+'trips.txt')):
    trips[r['trip_id']]=(r['route_id'],cal.get(r['service_id'],0),r['trip_headsign'])
stops={}
for r in csv.DictReader(open(D+'stops.txt')):
    stops[r['stop_id']]=(r['stop_name'],float(r['stop_lat']),float(r['stop_lon']))
# stop times grouped by trip (file is sorted by trip presumably)
st=defaultdict(list)
for r in csv.DictReader(open(D+'stop_times.txt')):
    st[r['trip_id']].append((int(r['stop_sequence']),r['stop_id'],t(r['arrival_time']),t(r['departure_time'])))
print('trips with times',len(st))
used=sorted({s for v in st.values() for _,s,_,_ in v})
sidx={s:i for i,s in enumerate(used)}
rused=sorted({trips[k][0] for k in st if k in trips})
ridx={r:i for i,r in enumerate(rused)}
pats={}; plist=[]; tl=[]
for k,v in st.items():
    if k not in trips or len(v)<2: continue
    v.sort()
    t0=v[0][3]
    rid,mask,head=trips[k]
    key=(ridx[rid],tuple(sidx[s] for _,s,_,_ in v),tuple(a-t0 for *_,a,d in v),tuple(d-t0 for *_,a,d in v))
    if key not in pats:
        pats[key]=len(plist); plist.append(key)
    tl.append((pats[key],t0,mask))
print('patterns',len(plist),'trips',len(tl),'stops',len(used))
# binary
out=bytearray()
def a(arr,dt): 
    global out; out+=np.asarray(arr,dtype=dt).tobytes()
meta={'nStops':len(used),'nRoutes':len(rused),'nPat':len(plist),'nTrips':len(tl)}
# patterns: route u16, n u16
a([p[0] for p in plist],'<u2'); a([len(p[1]) for p in plist],'<u2')
a([x for p in plist for x in p[1]],'<u2')
a([x for p in plist for x in p[2]],'<u2'); a([x for p in plist for x in p[3]],'<u2')
a([x[0] for x in tl],'<u4'); a([x[1] for x in tl],'<u4'); a([x[2] for x in tl],'<u1')
meta['nPatStops']=sum(len(p[1]) for p in plist)
import os
os.makedirs('public/data',exist_ok=True)
open('public/data/reach.bin.gz','wb').write(gzip.compress(bytes(out),9))
names=[stops[s][0] for s in used]
js={'meta':meta,'stops':{'n':names,'lat':[round(stops[s][1],5) for s in used],'lon':[round(stops[s][2],5) for s in used]},
 'routes':[routes[r][0] for r in rused],'kinds':[routes[r][1] for r in rused]}
json.dump(js,open('public/data/reach-meta.json','w'),separators=(',',':'),ensure_ascii=False)
gzip.open('public/data/reach-meta.json.gz','wb',9).write(open('public/data/reach-meta.json','rb').read()); os.remove('public/data/reach-meta.json')
print(len(out), os.path.getsize('public/data/reach.bin.gz'), os.path.getsize('public/data/reach-meta.json.gz'))
