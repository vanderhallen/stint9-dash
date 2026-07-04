#!/usr/bin/env python3
"""Generate a stint9 DB object from the official VLN sector-times CSV.
Reuses the existing Nordschleife track geometry (poly/cx/cy/gps/W/H) and
regenerates all per-car / per-class race data from the real CSV."""
import csv, json, re, bisect, collections, sys

CSV = "source/vln-2026-06-20-sektorzeiten.CSV"
GEOM = "tools/geom.json"   # track geometry (poly/cx/cy/gps/W/H) extracted once from data.js
EVENT_NAME = "1. ADAC Eifel-Trophy"   # not present in the CSV itself -> set per event
_m = re.search(r'(\d{4}-\d{2}-\d{2})', CSV)
EVENT_DATE = _m.group(1) if _m else ""   # derived from the CSV filename (onb/<date>/...)

PALETTE = ['#E6194B','#4363D8','#3CB44B','#911EB4','#42D4F4','#F032E6','#469990',
           '#E60073','#2E8B57','#1F77B4','#6A0DAD','#17BECF','#C71585','#00A878',
           '#2A5CFF','#7B2D8E']

def tod(s):
    """'12:08:32.610' -> seconds of day (float)."""
    s=s.strip()
    h,m,rest=s.split(':')
    return int(h)*3600+int(m)*60+float(rest)

def sec(s):
    """'1:11.243' / '49.898' / '1:02:03.4' -> seconds (float); '' -> None."""
    s=s.strip()
    if not s: return None
    parts=s.split(':')
    val=0.0
    for p in parts:
        val=val*60+float(p)
    return val

def numde(s):
    """German decimal '492,771' -> 492.771."""
    s=s.strip()
    return float(s.replace(',','.')) if s else None

# ---- parse ----
rows=[]
with open(CSV, encoding='cp1252') as f:
    for row in csv.DictReader(f, delimiter=';'):
        car=row['STNR'].strip()
        lap=int(row['RUNDE_NR'])
        secs=[sec(row['SEKTOR%d_ZEIT'%k]) for k in range(1,6)]
        if all(x is None for x in secs):
            continue  # nothing usable at all
        # NB: pit-IN laps (INPIT='J') legitimately have no S5 (nls-sector-layout.md:
        # the car diverts into the pits instead of crossing the S5 timing point) —
        # S1-S4 are still real, valid on-track driving and must not be discarded.
        rows.append(dict(
            car=car, lap=lap,
            klass=row['KLASSEKURZ'].strip(),
            secs=secs,
            tend=tod(row['TAGESZEIT']),
            rt=numde(row['RUNDENZEIT_IN_SEKUNDEN']),
            inpit=row['INPIT'].strip(),
            fast=row['DIESCHNELLSTE'].strip()=='J',
            drv=row['FAHRER1_NAME'].strip(),
            veh=row['FAHRZEUG'].strip(),
        ))

# group per car
bycar=collections.defaultdict(list)
for r in rows: bycar[r['car']].append(r)
for c in bycar: bycar[c].sort(key=lambda r:r['lap'])

cars=sorted(bycar.keys(), key=lambda c:(len(c),c))

# ---- per-car derived ----
legs={}; sectimes={}; pits={}; name={}; carclass={}; veh={}
boundtimes={}          # car -> sorted list of (time, lap, sector)
for c in cars:
    lg=[]; st={}; pit=[]; bt=[]
    for r in bycar[c]:
        L=r['lap']; s=r['secs']
        known=sum(x for x in s if x is not None)
        rt=r['rt'] if r['rt'] else known
        t0=r['tend']-rt
        cum=t0
        for k in range(5):
            if s[k] is None:
                continue  # e.g. S5 on a pit-in lap: no boundary, don't advance cum
            a=cum; cum=cum+s[k]
            lg.append([L, k+1, round(a,2), round(cum,2)])
            bt.append((round(cum,2), L, k+1))
        st[str(L)]=[(round(x,3) if x is not None else None) for x in s]
        if r['inpit']=='J': pit.append(L)
        name[c]=r['drv']; carclass[c]=r['klass']; veh[c]=r['veh']
    legs[c]=lg; sectimes[c]=st; pits[c]=sorted(pit)
    bt.sort()
    boundtimes[c]=bt

# ---- classes ----
classes=collections.defaultdict(list)
for c in cars: classes[carclass[c]].append(c)
classes={k:sorted(v,key=lambda c:(len(c),c)) for k,v in classes.items()}

classMaxN={}   # max lap count in class (x-axis extent)
classAvg={}    # mean green-lap sector times
for cls,cl in classes.items():
    mx=1; sums=[0.0]*5; cnt=0
    for c in cl:
        for r in bycar[c]:
            mx=max(mx, r['lap'])
            if r['inpit']=='N':
                for k in range(5): sums[k]+=r['secs'][k]
                cnt+=1
    classMaxN[cls]=mx
    classAvg[cls]=[round(sums[k]/cnt,1) if cnt else 0 for k in range(5)] if cnt else [0]*5

# ---- carcol: palette cycled within each class (per-class view distinguishes) ----
carcol={}
for cls,cl in classes.items():
    for i,c in enumerate(cl):
        carcol[c]=PALETTE[i%len(PALETTE)]

# ---- positions: within-class track position at each boundary ----
# progress(car,t) = #boundaries with time<=t  (bisect on boundtimes' time list)
chart={}; lappos={}
for cls,cl in classes.items():
    times={c:[b[0] for b in boundtimes[c]] for c in cl}
    for c in cl:
        bt=boundtimes[c]; ct=times[c]
        ch=[]; lp={}
        for idx,(t,L,s) in enumerate(bt):
            k=idx+1  # boundaries completed by c at time t
            pos=1
            for d in cl:
                if d==c: continue
                bd=bisect.bisect_right(times[d], t)
                if bd>k: pos+=1
                elif bd==k and bd>0 and times[d][bd-1]<t: pos+=1
            prog=round(((L-1)*5+s)/5, 4)
            ch.append([prog, pos, t])
            if s==5: lp[str(L)]=pos
        chart[c]=ch; lappos[c]=lp

# ---- assemble ----
geom=json.load(open(GEOM))
DB=dict(
    W=geom['W'], H=geom['H'], poly=geom['poly'],
    cx=geom['cx'], cy=geom['cy'], gps=geom['gps'],
    event=dict(name=EVENT_NAME, date=EVENT_DATE),
    classes=classes, classMaxN=classMaxN, classAvg=classAvg,
    name=name, carcol=carcol, drvtable={},
    legs=legs, chart=chart, sectimes=sectimes, lappos=lappos, pits=pits,
)

out=json.dumps(DB, separators=(',',':'), ensure_ascii=False)
open("tools/newDB.json","w",encoding="utf-8").write(out)

# ---- report ----
print("cars:", len(cars), " classes:", len(classes))
print("classes (name: cars / maxLaps):")
for cls in sorted(classes, key=lambda k:-len(classes[k])):
    print("  %-12s %3d cars  %2d laps  avg=%s" % (cls, len(classes[cls]), classMaxN[cls], classAvg[cls]))
tmin=min(g[2] for c in cars for g in legs[c]); tmax=max(g[3] for c in cars for g in legs[c])
print("global t range: %.1f .. %.1f (%.1f min)" % (tmin,tmax,(tmax-tmin)/60))
print("DB json size: %.1f KB" % (len(out)/1024))
# sanity: check one car's first laps position monotonic-ish
sc=classes[sorted(classes,key=lambda k:-len(classes[k]))[0]][0]
print("sample car %s pits=%s laps=%d firstchart=%s" % (sc, pits[sc], len(sectimes[sc]), chart[sc][:3]))
