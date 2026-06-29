import json, os
for i in range(1,12):
    r="phase%d"%i
    f="/home/ubuntu/hookrl/runs/%s/manifest.jsonl"%r
    if not os.path.exists(f): continue
    P=[]
    for l in open(f):
        try: P.append(json.loads(l)["pctile"])
        except: pass
    if not P: continue
    P.sort()
    print("%s: n=%d  median=%.0fth  p75=%.0fth  best=%.0fth"%(r,len(P),P[len(P)//2]*100,P[int(len(P)*0.75)]*100,P[-1]*100))
