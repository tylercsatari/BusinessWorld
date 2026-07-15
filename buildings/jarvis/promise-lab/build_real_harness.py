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
    parser.add_argument("--full", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    payload = {
        "manifest": read("manifest.json", {"version": 5, "status": "building", "counts": {}}),
        "progress": read("progress.json", {"version": 5, "status": "building", "stage": "real product build"}),
    }
    encoded = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    html = f"""<!doctype html><meta charset=\"utf-8\"><title>Promise Lab real-data verification</title>
<body style=\"margin:0;background:#0b1120\"><main id=\"panel\" style=\"padding:14px;max-width:1500px;margin:auto\"></main>
<script>window.__PL_REAL={encoded};
const nativeFetch=window.fetch.bind(window);
window.__PL_FETCH_LOG=[];
const artifactFiles={{'opening-predictions':'opening-predictions.json','pooled-opening-predictions':'pooled-opening-predictions.json','opening-context-study':'opening-context-study.json','manual-projection':'manual-projection.json','canonical-partitions':'canonical-partitions.json'}};
window.fetch=async function(url,opts){{
  window.__PL_FETCH_LOG.push(String(url));
  const parsed=new URL(url,location.href);const path=parsed.pathname;const scope=parsed.searchParams.get('scope')||'tyler';
  const base='/api/shortsquant/promise-lab/';
  if(path===base+'hook-score'){{return nativeFetch(url,opts);}}
  if(path.startsWith(base+'opening-prediction/')){{const id=decodeURIComponent(path.slice((base+'opening-prediction/').length));const dirs=scope==='tyler'?['opening-predictions']:['pooled-opening-predictions','opening-predictions'];for(const dir of dirs){{const packed=await nativeFetch(`/buildings/jarvis/promise-lab/.cache/${{dir}}/${{encodeURIComponent(id)}}.json.gz`,opts);if(packed.ok){{const stream=packed.body.pipeThrough(new DecompressionStream('gzip'));return new Response(stream,{{status:200,headers:{{'Content-Type':'application/json'}}}});}}}}return new Response(JSON.stringify({{error:'prediction detail not built'}}),{{status:404,headers:{{'Content-Type':'application/json'}}}});}}
  if(path.startsWith(base)){{let key=path.slice(base.length);if(key==='opening-predictions'&&scope!=='tyler')key='pooled-opening-predictions';const v=window.__PL_REAL[key];if(v)return new Response(JSON.stringify(v),{{status:200,headers:{{'Content-Type':'application/json'}}}});if(artifactFiles[key])return nativeFetch(`/buildings/jarvis/promise-lab/.cache/${{artifactFiles[key]}}`,opts);return new Response(JSON.stringify({{error:'real artifact not built yet'}}),{{status:404,headers:{{'Content-Type':'application/json'}}}});}}
  return nativeFetch(url,opts);
}};</script>
<script src=\"/buildings/jarvis/promise-lab-ui.js\"></script>
<script>
const colors={{bg:'#0b1120',card:'#0f172a',card2:'#131c30',border:'#1e293b',border2:'#27364d',text:'#e2e8f0',dim:'#94a3b8',mute:'#64748b',faint:'#475569',cyan:'#22d3ee',green:'#34d399',orange:'#fb923c',amber:'#f59e0b',red:'#f87171',purple:'#a78bfa',yellow:'#fbbf24',accent:'#38bdf8'}};
const escapeHtml=s=>String(s??'').replace(/[&<>\"]/g,c=>({{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}}[c]));
const ui=window.createShortsPromiseLab({{colors,escape:escapeHtml,getScope:()=>new URL(location.href).searchParams.get('scope')||'tyler'}});const panel=document.getElementById('panel');panel.innerHTML=ui.render();panel.addEventListener('click',e=>ui.handleClick(e));panel.addEventListener('input',e=>ui.handleInput(e));panel.addEventListener('change',e=>ui.handleChange(e));ui.afterRender();
</script>"""
    output = CACHE / "real-ui-harness.html"
    output.write_text(html, encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
