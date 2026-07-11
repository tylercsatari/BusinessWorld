#!/usr/bin/env python3
"""Generate a local UI harness using only current real pipeline artifacts."""

from __future__ import annotations

import gzip
import json
from pathlib import Path


HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"


def read(name, fallback=None):
    path = CACHE / name
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else fallback


def main() -> None:
    hooks = {}
    for path in (CACHE / "discovery").glob("*.json"):
        hooks[path.stem] = json.loads(path.read_text(encoding="utf-8"))
    swap_sources = {}
    for path in sorted((CACHE / "swap-sources").glob("*.json.gz"))[:5]:
        source_id = path.name[:-len(".json.gz")]
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            swap_sources[source_id] = json.load(handle)
    payload = {
        "manifest": read("manifest.json", {"version": 4, "status": "building", "counts": {}, "separation": {}}),
        "progress": read("progress.json", {"version": 4, "status": "building", "stage": "real partial build"}),
        "findings": read("findings.json", {}),
        "corpus": read("corpus.json", {"rows": []}),
        "discovery": read("discovery-summary.json", {"rows": []}),
        "atlas": read("atlas.json", {"candidates": [], "maps": [], "projections": {}}),
        "all-span-atlas": read(
            "all-span-atlas.json", {"spans": [], "maps": [], "projections": {}}
        ),
        "manual-probe": read("manual-probe.json", None),
        "manual-projection": read("manual-projection.json", None),
        "cross-scope": read("cross-scope.json", {}),
        "swaps": read("swaps.json", None),
        "axes": read("axes.json", None),
        "registry": read("registry.json", {"rows": [], "stageCounts": {}}),
        "hooks": hooks,
        "swapSources": swap_sources,
    }
    encoded = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    html = f"""<!doctype html><meta charset=\"utf-8\"><title>Promise Lab real-data verification</title>
<body style=\"margin:0;background:#0b1120\"><main id=\"panel\" style=\"padding:14px;max-width:1500px;margin:auto\"></main>
<script>window.__PL_REAL={encoded};
const nativeFetch=window.fetch.bind(window);
window.fetch=async function(url,opts){{
  const path=new URL(url,location.href).pathname;
  const base='/api/longquant/promise-lab/';
  if(path.startsWith(base+'hook/')){{const id=decodeURIComponent(path.slice((base+'hook/').length));const v=window.__PL_REAL.hooks[id];return new Response(JSON.stringify(v||{{error:'real hook artifact not built'}}),{{status:v?200:404,headers:{{'Content-Type':'application/json'}}}});}}
  if(path.startsWith(base+'swap-source/')){{const id=decodeURIComponent(path.slice((base+'swap-source/').length));const v=window.__PL_REAL.swapSources[id];return new Response(JSON.stringify(v||{{error:'source not included in verification harness'}}),{{status:v?200:404,headers:{{'Content-Type':'application/json'}}}});}}
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
