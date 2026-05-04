'use strict';
const fs = require('fs');
const path = require('path');
const base = '/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld/buildings/jarvis';

try {
  const de = JSON.parse(fs.readFileSync(path.join(base, 'derived_experiments.json'), 'utf8'));
  const arr = de.experiments || de;
  console.log('local derived_experiments:', Array.isArray(arr) ? arr.length : Object.keys(arr).length);
} catch(e) { console.log('derived_experiments error:', e.message); }

try {
  const g = JSON.parse(fs.readFileSync(path.join(base, 'graph.json'), 'utf8'));
  console.log('local graph derived_edges:', (g.derived_edges||[]).length);
} catch(e) { console.log('graph error:', e.message); }

try {
  const r = JSON.parse(fs.readFileSync(path.join(base, 'resolutions.json'), 'utf8'));
  console.log('local resolutions:', r.length);
} catch(e) { console.log('resolutions error:', e.message); }

try {
  const el = JSON.parse(fs.readFileSync(path.join(base, 'experiments_log.json'), 'utf8'));
  const arr = el.experiments || el;
  console.log('local experiments_log:', Array.isArray(arr) ? arr.length : Object.keys(arr).length);
} catch(e) { console.log('experiments_log error:', e.message); }
