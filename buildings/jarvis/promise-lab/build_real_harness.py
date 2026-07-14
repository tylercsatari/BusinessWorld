#!/usr/bin/env python3
"""Generate a local UI harness using only current real pipeline artifacts."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def read(name, fallback=None):
    path = CACHE / name
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else fallback


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--full", action="store_true",
        help="include the saved embedding and its validation artifacts",
    )
    args = parser.parse_args()
    payload = {
        "manifest": read("manifest.json", {"version": 5, "status": "building", "counts": {}}),
        "progress": read("progress.json", {"version": 5, "status": "building", "stage": "real product build"}),
        "component-lattice": read("component-lattice.json", {"rows": []}),
        "opening-20s": read("opening-20s.json", {"rows": []}),
        "manual-probe": read("manual-probe.json", None) if args.full else None,
        "manual-projection": read("manual-projection.json", None) if args.full else None,
        "cluster-outcomes": read("cluster-outcomes.json", None) if args.full else None,
        "latency-study": read("latency-study.json", None) if args.full else None,
        "canonical-partitions": read("canonical-partitions.json", None),
        "hook-quality": read("hook-quality.json", None),
        "hook-outcomes": read("hook-outcomes.json", None),
        "market-reward": read("market-reward.json", None),
        "hook-example-results": read("hook-example-results.json", None),
    }
    encoded = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    html = f"""<!doctype html><meta charset=\"utf-8\"><title>Promise Lab real-data verification</title>
<body style=\"margin:0;background:#0b1120\"><main id=\"panel\" style=\"padding:14px;max-width:1500px;margin:auto\"></main>
<script>window.__PL_REAL={encoded};
const nativeFetch=window.fetch.bind(window);
window.fetch=async function(url,opts){{
  const path=new URL(url,location.href).pathname;
  const base='/api/longquant/promise-lab/';
  if(path===base+'hook-score'){{return nativeFetch(url,opts);}}
  if(path.startsWith(base+'cluster-outcome/')){{const parts=path.slice((base+'cluster-outcome/').length).split('/');const packed=await nativeFetch(`/buildings/jarvis/promise-lab/.cache/cluster-outcomes-details/${{encodeURIComponent(parts[0]||'')}}/${{encodeURIComponent(parts[1]||'')}}.json.gz`,opts);if(!packed.ok)return packed;const stream=packed.body.pipeThrough(new DecompressionStream('gzip'));return new Response(stream,{{status:200,headers:{{'Content-Type':'application/json'}}}});}}
  if(path.startsWith(base+'latency-study/')){{const cluster=path.slice((base+'latency-study/').length);const packed=await nativeFetch(`/buildings/jarvis/promise-lab/.cache/latency-study-details/${{encodeURIComponent(cluster)}}.json.gz`,opts);if(!packed.ok)return packed;const stream=packed.body.pipeThrough(new DecompressionStream('gzip'));return new Response(stream,{{status:200,headers:{{'Content-Type':'application/json'}}}});}}
  if(path.startsWith(base+'component-lattice/')){{const id=decodeURIComponent(path.slice((base+'component-lattice/').length));const packed=await nativeFetch(`/buildings/jarvis/promise-lab/.cache/component-lattice/${{encodeURIComponent(id)}}.json.gz`,opts);if(!packed.ok)return packed;const stream=packed.body.pipeThrough(new DecompressionStream('gzip'));return new Response(stream,{{status:200,headers:{{'Content-Type':'application/json'}}}});}}
  if(path.startsWith(base+'opening-20s/')){{const id=decodeURIComponent(path.slice((base+'opening-20s/').length));const packed=await nativeFetch(`/buildings/jarvis/promise-lab/.cache/opening-20s/${{encodeURIComponent(id)}}.json.gz`,opts);if(!packed.ok)return packed;const stream=packed.body.pipeThrough(new DecompressionStream('gzip'));return new Response(stream,{{status:200,headers:{{'Content-Type':'application/json'}}}});}}
  if(path.startsWith(base)){{const key=path.slice(base.length);const v=window.__PL_REAL[key];return new Response(JSON.stringify(v||{{error:'real artifact not built yet'}}),{{status:v?200:404,headers:{{'Content-Type':'application/json'}}}});}}
  return nativeFetch(url,opts);
}};</script>
<script src=\"/buildings/jarvis/promise-lab-ui.js\"></script>
<script>
const colors={{bg:'#0b1120',card:'#0f172a',card2:'#131c30',border:'#1e293b',border2:'#27364d',text:'#e2e8f0',dim:'#94a3b8',mute:'#64748b',faint:'#475569',cyan:'#22d3ee',green:'#34d399',orange:'#fb923c',amber:'#f59e0b',red:'#f87171',purple:'#a78bfa',yellow:'#fbbf24',accent:'#38bdf8'}};
const escapeHtml=s=>String(s??'').replace(/[&<>\"]/g,c=>({{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}}[c]));
const ui=window.createLongQuantPromiseLab({{colors,escape:escapeHtml}});const panel=document.getElementById('panel');panel.innerHTML=ui.render();panel.addEventListener('click',e=>ui.handleClick(e));panel.addEventListener('input',e=>ui.handleInput(e));panel.addEventListener('change',e=>ui.handleChange(e));ui.afterRender();
</script>"""
    output = CACHE / "real-ui-harness.html"
    output.write_text(html, encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
