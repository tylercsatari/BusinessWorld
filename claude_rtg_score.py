#!/usr/bin/env python3
"""Score any promise line on the Claude RTG promise axes (longform/claude-rtg/promise_axes.json).

The thumbnail workflow applied to text: each axis is a frozen blend direction + percentile ladder
learned from the 208 real hooks. The input is embedded exactly like the training hooks were
(full text · mean clause chunks · topic-removed residual chunks · delexicalized skeleton) and
projected onto every axis. Axes that beat their permutation baseline are flagged trusted."""
import argparse, json, os, re, tempfile, time

import numpy as np
import longquant_score as LS

AXES_KEY = "longform/claude-rtg/promise_axes.json"

def segment_keep_conn(text):
    toks = text.split()
    conns = {"and", "but", "so", "because", "however"}
    starts = [0]
    for i in range(1, len(toks)):
        w = toks[i].lower().strip(",.?!")
        prev = toks[i - 1]
        if w in conns and prev.endswith(","): starts.append(i)
        elif w in conns and i - starts[-1] >= 4: starts.append(i)
        elif prev.endswith((".", "?", "!")): starts.append(i)
    starts = sorted(set(starts))
    out = []
    for si, s0 in enumerate(starts):
        s1 = starts[si + 1] if si + 1 < len(starts) else len(toks)
        seg = " ".join(toks[s0:s1]).strip(" ,")
        if seg: out.append(seg)
    merged = []
    for c in out:
        if merged and len(c.split()) < 3: merged[-1] += " " + c
        else: merged.append(c)
    return merged if merged else [text]

FUNC = set(("i you he she it we they me him her them my your his its our their this that these those a an the and but or so because however although though if when where which who what how why is are was were be been being am do does did done have has had having will would can could should may might must not no nor never always to of in on at by for with from as into onto over under about around before after during between against off out up down again once here there then than too very just only even still also both each few more most other some such own same s t don didn wasn weren isn aren won wouldn couldn shouldn ll re ve d m o y ain now").split())
def skeleton(text):
    out = []
    for w in text.split():
        core = re.sub(r"[^a-z']", "", w.lower())
        if core in FUNC or core == "": out.append(w.lower())
        elif re.match(r"^[\d$,.%]+", w): out.append("N")
        else: out.append("something")
    return re.sub(r"(something )+", "something ", " ".join(out) + " ").strip()

def load_axes():
    cdir = tempfile.gettempdir()
    try:
        etag = LS.s3.head_object(Bucket=LS.BUCKET, Key=AXES_KEY).get("ETag")
    except Exception:
        etag = None
    path = os.path.join(cdir, "crtg_axes_%s.json" % LS.cache_tag(etag))
    if not os.path.exists(path):
        LS.download_file(AXES_KEY, path)
    return json.load(open(path))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    args = ap.parse_args()
    text = re.sub(r"\s+", " ", args.text).strip()[:500]
    if len(text) < 4:
        print(json.dumps({"error": "text too short"}))
        return
    bundle = load_axes()
    segs = segment_keep_conn(text)
    e_full = LS.norm(LS.embed([{"text": text}]))
    e_chunks = [LS.norm(LS.embed([{"text": s[:500]}])) for s in segs]
    e_skels = [LS.norm(LS.embed([{"text": skeleton(s)[:500]}])) for s in segs]

    def space_vec(sp):
        if sp == "full": v = e_full
        elif sp == "chunk": v = np.mean(e_chunks, 0)
        elif sp == "skel": v = np.mean(e_skels, 0)
        elif sp == "resid":
            rs = []
            for cv in e_chunks:
                r0 = cv - (cv @ e_full) * e_full
                n = np.linalg.norm(r0)
                if n > 1e-6: rs.append(r0 / n)
            v = np.mean(rs, 0) if rs else np.zeros(LS.DIM, np.float32)
        n = np.linalg.norm(v)
        return v / n if n > 1e-6 else v

    vecs = {sp: space_vec(sp) for sp in ("full", "chunk", "resid", "skel")}
    out_axes = []
    for a in bundle.get("axes", []):
        blend = np.asarray(a["blend"], np.float32)
        ladder = np.asarray(a["ladder"], np.float32)
        proj = float(vecs[a["space"]] @ blend)
        pct = round(float(np.searchsorted(ladder, proj)) / max(1, len(ladder) - 1) * 100, 1)
        out_axes.append({"id": a["id"], "space": a["space"], "outcome": a["outcome"], "method": a["method"],
                         "pct": pct, "heldout_spearman": a["heldout_spearman"], "permP": a["permP"],
                         "trusted": bool(a["permP"] <= 0.05 and a["heldout_spearman"] >= 0.15)})
    print(json.dumps({"text": text, "chunks": segs, "skeleton": [skeleton(s) for s in segs],
                      "axes": out_axes, "builtAt": bundle.get("builtAt")}))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        print(json.dumps({"error": str(e)[:220], "trace": traceback.format_exc()[-400:]}))
