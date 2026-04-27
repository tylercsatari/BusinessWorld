// Pre-build a compact graph file the server can serve directly.
// Strips redundant `connections` array from each node (already captured by edges)
// and keeps only the top 10K derived_edges by |interaction_r|.
//
// Run: node _build_compact_graph.js
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "buildings/jarvis/graph.json");
const dst = path.join(__dirname, "buildings/jarvis/graph_compact.json");

console.log("Loading graph.json...");
const t0 = Date.now();
const data = JSON.parse(fs.readFileSync(src, "utf8"));
console.log(`  loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const nodes = (data.nodes || []).map(({ connections, ...rest }) => rest);
const allDe = data.derived_edges || [];
const derived_edges = allDe
    .filter(de => de.interaction_r != null)
    .sort((a, b) => Math.abs(b.interaction_r) - Math.abs(a.interaction_r))
    .slice(0, 10000);

const compact = {
    nodes,
    edges: data.edges || [],
    derived_edges,
    _meta: {
        total_derived_edges: allDe.length,
        returned_derived_edges: derived_edges.length,
        connections_stripped: true,
        built_at: new Date().toISOString(),
    },
};

fs.writeFileSync(dst, JSON.stringify(compact));
const sizeMB = fs.statSync(dst).size / 1024 / 1024;
console.log(`Written graph_compact.json: ${sizeMB.toFixed(2)}MB`);
console.log(`  nodes=${nodes.length}, edges=${(data.edges || []).length}, derived_edges=${derived_edges.length} (of ${allDe.length})`);
