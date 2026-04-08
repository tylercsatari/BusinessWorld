#!/usr/bin/env python3
"""Build real connection graph from results.tsv experiments."""
import csv, re, json
from collections import defaultdict

# Core outcome nodes that exist as connection targets
CORE_NODES = {
    "views": {"key":"views","label":"Views","layer":"views","resolution":"R0","depth":0},
    "keep": {"key":"keep","label":"Keep Rate","layer":"post","resolution":"R0","depth":0},
    "retention": {"key":"retention","label":"Retention","layer":"post","resolution":"R0","depth":0},
    "swipe_ratio": {"key":"swipe_ratio","label":"Swipe Away","layer":"post","resolution":"R0","depth":0},
}

def parse_target(notes, experiment_id, row):
    """Determine what this experiment measured against."""
    n = notes.lower()
    # Check notes for explicit target mentions
    if "vs keep" in n or "vs keep rate" in n or "vs swipe" in n:
        return "keep"
    if "vs retention" in n and "vs keep" not in n:
        return "retention"
    if "vs log(views)" in n or "vs views" in n or "vs log_views" in n:
        return "views"
    # loop_c/loop_d rows store the target in the r2_before column
    if experiment_id.startswith("loop_c") or experiment_id.startswith("loop_d"):
        r2b = (row.get("r2_before") or "").strip().lower()
        if r2b in ("keep", "retention", "end_retention", "share_rate", "max_cliff", "swipe_ratio"):
            if r2b == "end_retention":
                return "retention"
            return r2b if r2b in ("keep", "retention", "views") else "keep"
    # loop_c rows are causal tree = pre -> post (keep/retention)
    if experiment_id.startswith("loop_c"):
        return "keep"
    # loop_d rows are retention mapping
    if experiment_id.startswith("loop_d"):
        return "retention"
    # Default: views
    return "views"

def parse_r_value(notes, row, experiment_id):
    """Parse the r or r_partial value from notes, or from r2_after for loop_c/loop_d."""
    r = 0.0
    m = re.search(r"r_partial=([+-]?\d+\.?\d*)", notes)
    if m:
        try: r = float(m.group(1).rstrip("."))
        except: pass
    if not r:
        m = re.search(r"\br=([+-]?\d+\.?\d*)", notes)
        if m:
            try: r = float(m.group(1).rstrip("."))
            except: pass
    # For loop_c/loop_d, the r value is in r2_after column
    if not r and (experiment_id.startswith("loop_c") or experiment_id.startswith("loop_d")):
        r2a = (row.get("r2_after") or "").strip()
        try: r = float(r2a)
        except: pass
    return r

def parse_components(key, notes):
    """For composite indicators, find what they are composed of."""
    components = []
    # Look for z(X) patterns in notes
    z_matches = re.findall(r"z\(([a-z_][a-z0-9_]*)\)", notes, re.IGNORECASE)
    components.extend(z_matches)
    # Look for X*Y or X x Y patterns
    mult_matches = re.findall(r"([a-z_][a-z0-9_]+)[×\*]([a-z_][a-z0-9_]+)", notes, re.IGNORECASE)
    for a,b in mult_matches:
        components.extend([a,b])
    # If key has "_x_" (explicit cross product): split on _x_
    if "_x_" in key:
        parts = key.split("_x_")
        components.extend(parts)
    return list(set(components))

# Read results.tsv
rows = []
with open("buildings/jarvis/results.tsv") as f:
    reader = csv.DictReader(f, delimiter="\t")
    rows = list(reader)

# Build edges from experiments
edges = []  # {from: key, to: key, r: float, experiment: id}
signal_targets = defaultdict(set)  # what each signal was measured against

# Load existing registry
with open("buildings/jarvis/indicator-registry.json") as f:
    registry = json.load(f)
registry_keys = {ind["key"] for ind in registry["indicators"]}

for row in rows:
    exp_id = row.get("experiment_id","")
    new_signal = row.get("new_signal","").replace("discovery:","").strip()
    notes = row.get("notes","") or ""

    if not new_signal:
        continue

    # Parse r value
    r = parse_r_value(notes, row, exp_id)

    # Parse target
    target = parse_target(notes, exp_id, row)
    signal_targets[new_signal].add(target)

    # Add edge: signal -> target
    edges.append({"from": new_signal, "to": target, "r": r, "experiment": exp_id})

    # Check for component signals
    components = parse_components(new_signal, notes)
    for comp in components:
        if comp != new_signal and comp in registry_keys:
            # Component -> composite signal edge
            edges.append({"from": comp, "to": new_signal, "r": abs(r)*0.7, "experiment": exp_id})

# Deduplicate edges (keep highest r for each from->to pair)
edge_map = {}
for e in edges:
    key = (e["from"], e["to"])
    if key not in edge_map or abs(e["r"]) > abs(edge_map[key]["r"]):
        edge_map[key] = e
edges = list(edge_map.values())

# Add core node edges: keep -> views, retention -> views
edges.append({"from":"keep","to":"views","r":0.65,"experiment":"structural"})
edges.append({"from":"retention","to":"views","r":0.55,"experiment":"structural"})
edges.append({"from":"swipe_ratio","to":"views","r":0.65,"experiment":"structural"})

# Compute depth via topological sort
# Build adjacency: to -> list of from nodes
in_edges = defaultdict(list)
out_edges = defaultdict(list)
all_nodes = set(["views","keep","retention","swipe_ratio"])
for e in edges:
    in_edges[e["to"]].append(e["from"])
    out_edges[e["from"]].append(e["to"])
    all_nodes.add(e["from"])
    all_nodes.add(e["to"])

# Depth = sum of depths of what this node connects TO (additive)
depth_map = {"views":0,"keep":0,"retention":0,"swipe_ratio":0}

def compute_depth(node, visited=None):
    if visited is None: visited = set()
    if node in depth_map: return depth_map[node]
    if node in visited: return 1  # cycle guard
    visited.add(node)
    targets = out_edges.get(node, [])
    if not targets:
        depth_map[node] = 1
        return 1
    total = 0
    for t in targets:
        total += compute_depth(t, visited.copy())
    depth_map[node] = max(1, total)
    return depth_map[node]

for node in all_nodes:
    compute_depth(node)

# Update indicator registry with connections and depth
ind_map = {ind["key"]: ind for ind in registry["indicators"]}
for e in edges:
    fk = e["from"]
    if fk in ind_map:
        if "connections" not in ind_map[fk]:
            ind_map[fk]["connections"] = []
        ind_map[fk]["connections"].append({"to":e["to"],"r":e["r"],"experiment":e["experiment"]})
    # Update depth
    if fk in depth_map and fk in ind_map:
        ind_map[fk]["depth"] = depth_map[fk]

# Add core nodes to registry if not present
for key, node in CORE_NODES.items():
    if key not in ind_map:
        registry["indicators"].append(node)
        ind_map[key] = node

# Save updated registry
registry["indicators"] = list(ind_map.values())
registry["edges"] = edges  # store full edge list in registry
registry["total"] = len(registry["indicators"])

with open("buildings/jarvis/indicator-registry.json","w") as f:
    json.dump(registry, f, indent=2)

print(f"Total nodes: {len(registry['indicators'])}")
print(f"Total edges: {len(edges)}")
for target in ["views","keep","retention"]:
    count = sum(1 for e in edges if e["to"]==target)
    print(f"  -> {target}: {count} signals")
depth_dist = defaultdict(int)
for ind in registry["indicators"]:
    d = ind.get("depth",1)
    depth_dist[min(d,5)] += 1
print("Depth distribution:", dict(sorted(depth_dist.items())))
