/**
 * Generic Figma Variable Exporter
 *
 * Exports ALL variable collections from a Figma file as Token Studio JSON.
 * Works with any Figma variable structure — no hardcoded collection names,
 * modes, or type assumptions.
 *
 * Usage:
 *   Step 1 — generate fetch script and run it in Figma:
 *     node src/exporter.js --generate-fetch-code > /tmp/figma-fetch.js
 *     # Run /tmp/figma-fetch.js in Figma via MCP (use_figma)
 *     # Paste the returned JSON string into figma-data.json
 *
 *   Step 2 — preview what will be exported (no files written):
 *     node src/exporter.js --from-json figma-data.json --dry-run
 *
 *   Step 3 — write Token Studio JSON files:
 *     node src/exporter.js --from-json figma-data.json
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  // Output folder for exported JSON files (relative to project root).
  // Change this to any path you prefer, e.g. 'tokens' or 'dist/tokens'.
  exportDir: 'export',
};

// Set at runtime when prisme.config.json is loaded. Used by convertValue to
// rewrite {Segment.x.y} aliases → {x.y.<defaultSegment>}.
let _segmentSuffix = null;

// When true: multi-mode collections produce one JSON file per mode.
//   Segment (CON/TPB/WFA/PRM)  →  CON.json, TPB.json, WFA.json, PRM.json
//   Fusion  (light/dark)       →  fusion-light.json, fusion-dark.json
//   Single-mode collections (Global, Spacing, …) are always one file — unaffected.
// When false: all modes are combined into a single file with modes nested inside each token:
//   Segment → segment.json  { "brand": { "primary700": { "CON": {…}, "TPB": {…} } } }
//   Fusion  → fusion.json   { "bg": { "default": { "light": {…}, "dark": {…} } } }
const SEPARATE_MODE_FILES = false;

// ─── Figma fetch script ───────────────────────────────────────────────────────

/**
 * Returns a self-contained Figma Plugin API script that reads every variable
 * collection in the file and returns their full contents as a JSON string.
 *
 * Alias targets include the collection name so cross-collection references
 * can be reconstructed as Token Studio dot-notation paths.
 */
function generateFetchCode() {
  return `(async function () {
  const allVars = figma.variables.getLocalVariables();
  const cols    = figma.variables.getLocalVariableCollections();
  const colNameById = Object.fromEntries(cols.map(c => [c.id, c.name]));
  const varInfoById = Object.fromEntries(
    allVars.map(v => [v.id, { name: v.name, colName: colNameById[v.variableCollectionId] }])
  );
  const result = {};
  for (const col of cols) {
    const vars = allVars.filter(v => v.variableCollectionId === col.id);
    result[col.name] = {
      modes: col.modes.map(m => ({ id: m.modeId, name: m.name })),
      variables: vars.map(v => ({
        name: v.name,
        type: v.resolvedType,
        valuesByMode: Object.fromEntries(
          col.modes.map(m => {
            const val = v.valuesByMode[m.modeId];
            if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS') {
              const info = varInfoById[val.id];
              // Encode as "CollectionName/var/name" — converted to {Collection.var.name} below
              return [m.name, { alias: info ? (info.colName !== 'Global' ? info.colName + '/' + info.name : info.name) : val.id }];
            }
            return [m.name, val];
          })
        )
      }))
    };
  }
  return JSON.stringify(result);
})();`;
}

// ─── Value helpers ────────────────────────────────────────────────────────────

function rgbaToHex({ r, g, b, a = 1 }) {
  const h  = n => Math.round(n * 255).toString(16).padStart(2, '0').toUpperCase();
  const ha = n => Math.ceil(n * 255).toString(16).padStart(2, '0').toUpperCase();
  const hex = `#${h(r)}${h(g)}${h(b)}`;
  return a < 1 ? hex + ha(a) : hex;
}

function isAlias(val) {
  return val !== null && typeof val === 'object' && typeof val.alias === 'string';
}

/**
 * Convert an alias path "var/name" → "{var.name}".
 * Strips any trailing ? (Figma export artifact) before converting.
 */
function toTsAlias(aliasPath) {
  return '{' + aliasPath.replace(/\?$/, '').replace(/\//g, '.') + '}';
}

/**
 * Format a FLOAT as a plain number string, stripping trailing decimal noise.
 */
function fmtNumber(n) {
  return String(Number.isInteger(n) ? n : parseFloat(n.toFixed(4)));
}

/**
 * Map Figma resolvedType → Token Studio type string.
 * Uses the most generic Token Studio types; no assumptions about variable
 * names or intended usage.
 */
function tsType(figmaType) {
  if (figmaType === 'COLOR')  return 'color';
  if (figmaType === 'STRING') return 'string';
  return 'number'; // FLOAT
}

/**
 * Slugify a collection name into a safe filename component.
 *   "Type Global"  → "type-global"
 *   "My Tokens!"   → "my-tokens"
 *   "Prisme"       → "prisme"
 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Slugify a mode name for use as a filename — preserves original casing,
 * strips everything that is not a letter or digit.
 *   "Beans"    → "Beans"
 *   "BMO"      → "BMO"
 *   "Mr. Tibbs"→ "MrTibbs"
 *   "light"    → "light"
 */
function slugifyMode(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Set a value at a nested object path, creating intermediate objects as needed.
 *   setPath(obj, ['bg', 'default'], value)  →  obj.bg.default = value
 */
function setPath(obj, parts, value) {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === undefined) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

// ─── Input normalizer ─────────────────────────────────────────────────────────

/**
 * Log the raw shape of the input so format issues are easy to diagnose.
 * Always runs before normalization; safe to leave enabled.
 */
function debugShape(raw) {
  process.stderr.write('\n[debug] Input shape:\n');

  if (Array.isArray(raw)) {
    process.stderr.write(`  top-level: Array(${raw.length})\n`);
    if (raw.length > 0) process.stderr.write(`  first entry keys: ${Object.keys(raw[0]).join(', ')}\n`);
    process.stderr.write('\n');
    return;
  }

  const topKeys = Object.keys(raw);
  process.stderr.write(`  top-level keys (${topKeys.length}): ${topKeys.join(', ')}\n`);

  // Shape: { collections, variables } — Figma native
  if (Array.isArray(raw.collections) && Array.isArray(raw.variables)) {
    process.stderr.write(`  → detected: Figma native export (collections + variables arrays)\n`);
    process.stderr.write(`  collections: ${raw.collections.length}, variables: ${raw.variables.length}\n`);
    process.stderr.write('\n');
    return;
  }

  // Shape: { "CollectionName": { ... }, "$extensions": ... }
  // Find first non-$ key and log its first 3 entries
  const firstColKey = topKeys.find(k => !k.startsWith('$'));
  if (firstColKey) {
    const colVal = raw[firstColKey];
    process.stderr.write(`  → detected: collection-keyed object\n`);
    process.stderr.write(`  first collection: "${firstColKey}"\n`);
    if (colVal && typeof colVal === 'object') {
      // Check if it has modes/variables (fetch-code shape A)
      if (Array.isArray(colVal.modes) || Array.isArray(colVal.variables)) {
        process.stderr.write(`  first collection has .modes=${JSON.stringify(colVal.modes?.slice(0,2))} .variables(${colVal.variables?.length})\n`);
      } else {
        // Variable names are the keys
        const varKeys = Object.keys(colVal);
        process.stderr.write(`  first collection variable count: ${varKeys.length}\n`);
        process.stderr.write(`  first 3 variable names: ${varKeys.slice(0, 3).join(', ')}\n`);
        for (const k of varKeys.slice(0, 3)) {
          process.stderr.write(`  [${k}] = ${JSON.stringify(colVal[k])}\n`);
        }
      }
    }
  }
  process.stderr.write('\n');
}

/**
 * Handle Figma native export format:
 *   { collections: [{id, name, modes:[{modeId,name}], variableIds:[...]}],
 *     variables:   [{id, name, resolvedType, variableCollectionId, valuesByMode:{modeId:val}}] }
 *
 * Reassembles into { [colName]: { modes:[{id,name}], variables:[{name,type,valuesByMode:{modeName:val}}] } }
 * by:
 *   - grouping variables by variableCollectionId
 *   - remapping valuesByMode keys from modeId → mode name
 *   - resolving VARIABLE_ALIAS values to { alias: "CollectionName/varName" }
 *   - skipping collections whose name starts with "$" (metadata / $extensions)
 */
function normalizeNative(raw) {
  const cols = raw.collections;
  const vars = raw.variables;

  const colById  = Object.fromEntries(cols.map(c => [c.id, c]));
  const varById  = Object.fromEntries(vars.map(v => [v.id, v]));

  const varsByColId = {};
  for (const v of vars) {
    if (!varsByColId[v.variableCollectionId]) varsByColId[v.variableCollectionId] = [];
    varsByColId[v.variableCollectionId].push(v);
  }

  const out = {};
  for (const col of cols) {
    if (col.name.startsWith('$')) continue; // skip $extensions / metadata

    const modeNameById = Object.fromEntries(col.modes.map(m => [m.modeId, m.name]));
    const colVars = varsByColId[col.id] || [];

    const normalizedVars = colVars.map(v => {
      const valuesByMode = {};
      for (const [modeId, val] of Object.entries(v.valuesByMode || {})) {
        const rawModeName = modeNameById[modeId];
        if (!rawModeName) continue;
        const modeName = GENERIC_MODE_NAMES.has(rawModeName.toLowerCase())
          ? rawModeName.toLowerCase()
          : rawModeName;
        if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS') {
          const targetVar = varById[val.id];
          if (targetVar) {
            const targetCol = colById[targetVar.variableCollectionId];
            valuesByMode[modeName] = { alias: (targetCol && targetCol.name !== 'Global' ? targetCol.name + '/' : '') + targetVar.name };
          } else {
            valuesByMode[modeName] = { alias: val.id };
          }
        } else {
          valuesByMode[modeName] = val;
        }
      }
      return { name: v.name, type: v.resolvedType, valuesByMode };
    });

    out[col.name] = {
      modes:     col.modes.map(m => ({ id: m.modeId, name: m.name })),
      variables: normalizedVars,
    };
  }
  return out;
}

/**
 * Flatten a collection object whose keys are variable names (or nested groups).
 *
 * Handles two sub-shapes:
 *
 *   E1 — flat variable map:
 *        { "stone/stone800": { value: "#333", type: "color" },
 *          "stone/stone800": { resolvedType: "COLOR", valuesByMode: {modeId: {r,g,b,a}} } }
 *
 *   E2 — nested Token Studio tree:
 *        { "stone": { "stone800": { value: "#333", type: "color" } } }
 *
 * Returns { modes: [{id,name}], variables: [{name, type, valuesByMode}] }
 */
function normalizeCollectionKeyed(colObj) {
  // Collect all leaf variable entries by recursively walking the tree.
  // A leaf is detected as: object with either (value + type) or (valuesByMode or resolvedType).
  const vars = [];
  const allModeKeys = new Set();

  function walk(node, pathParts) {
    if (!node || typeof node !== 'object') return;

    // W3C Design Token format: { $type, $value, $extensions? }
    if ('$value' in node && '$type' in node) {
      vars.push({ path: pathParts, entry: node, shape: 'w3c' });
      return;
    }

    // Token Studio leaf: { value, type }
    if ('value' in node && 'type' in node) {
      vars.push({ path: pathParts, entry: node, shape: 'ts' });
      return;
    }

    // Figma-style variable: { resolvedType, valuesByMode }
    if ('resolvedType' in node || 'valuesByMode' in node) {
      for (const k of Object.keys(node.valuesByMode || {})) allModeKeys.add(k);
      vars.push({ path: pathParts, entry: node, shape: 'figma' });
      return;
    }

    // Token Studio multi-mode variable: object where every non-$ child is a { value, type } leaf.
    // e.g. { "Beans": { value, type }, "Fremy": { value, type }, ... }
    // The children are mode entries — do NOT recurse; register child keys as mode names.
    const childEntries = Object.entries(node).filter(([k]) => !k.startsWith('$'));
    const allChildrenAreLeaves = childEntries.length > 1 && childEntries.every(
      ([, v]) => v && typeof v === 'object' && !Array.isArray(v) && 'value' in v && 'type' in v
    );
    if (allChildrenAreLeaves) {
      for (const [modeName] of childEntries) allModeKeys.add(modeName);
      vars.push({ path: pathParts, entry: node, shape: 'ts-multi' });
      return;
    }

    // Otherwise recurse into children (nested groups), skipping $-prefixed metadata
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$')) continue;
      walk(v, [...pathParts, k]);
    }
  }

  for (const [k, v] of Object.entries(colObj)) {
    if (k.startsWith('$')) continue;
    walk(v, [k]);
  }

  // Build modes list.
  // - figma shape: allModeKeys are modeIds — we can't know names yet, use modeId as name too
  // - ts-multi shape: allModeKeys are mode names (e.g. "Beans", "Fremy", "light", "dark")
  // - ts shape: no modeIds; treat as single-mode "Value"
  const hasMultiModeVars = vars.some(v => v.shape === 'figma' || v.shape === 'ts-multi');
  let modes;
  if (hasMultiModeVars && allModeKeys.size > 0) {
    modes = [...allModeKeys].map(id => ({ id, name: id }));
  } else {
    modes = [{ id: 'default', name: 'Value' }];
  }

  const modeNameById = Object.fromEntries(modes.map(m => [m.id, m.name]));

  // Build normalized variable list
  const variables = vars.map(({ path, entry, shape }) => {
    const name = path.join('/');

    if (shape === 'w3c') {
      const tokenType = entry['$type'];    // e.g. 'color', 'number', 'string'
      const raw       = entry['$value'];
      // Color: $value may be { colorSpace, components, alpha, hex } or a plain string.
      // Use components + alpha when available so alpha < 1 produces correct 8-digit hex.
      let value;
      if (tokenType === 'color') {
        if (raw && typeof raw === 'object' && Array.isArray(raw.components)) {
          const [r, g, b] = raw.components;
          value = rgbaToHex({ r, g, b, a: raw.alpha ?? 1 });
        } else if (raw && typeof raw === 'object' && raw.hex) {
          // No components array — use the pre-computed hex but still apply alpha
          // so 8-digit hex is produced when the token has transparency.
          const ha = n => Math.ceil(n * 255).toString(16).padStart(2, '0').toUpperCase();
          const a = raw.alpha ?? 1;
          value = raw.hex.toUpperCase() + (a < 1 ? ha(a) : '');
        } else {
          value = String(raw);
        }
      } else {
        value = String(raw);
      }
      const figmaType = tokenType === 'color' ? 'COLOR' : tokenType === 'number' ? 'FLOAT' : 'STRING';
      return { name, type: figmaType, valuesByMode: { Value: { value, type: tokenType } } };
    }

    if (shape === 'ts') {
      // Token Studio leaf — already has value+type, wrap in single-mode valuesByMode
      const figmaType = entry.type === 'color' ? 'COLOR' : entry.type === 'number' ? 'FLOAT' : 'STRING';
      return { name, type: figmaType, valuesByMode: { Value: entry } };
    }

    if (shape === 'ts-multi') {
      // Token Studio multi-mode variable: { modeName: { value, type }, ... }
      // Each child is a mode entry — keep them as-is in valuesByMode keyed by mode name.
      const valuesByMode = {};
      let figmaType = 'COLOR';
      for (const [k, v] of Object.entries(entry)) {
        if (k.startsWith('$')) continue;
        valuesByMode[k] = v;
        if (v.type === 'number' || v.type === 'spacing' || v.type === 'fontSizes' || v.type === 'fontWeights') figmaType = 'FLOAT';
        else if (v.type === 'string' || v.type === 'fontFamilies') figmaType = 'STRING';
      }
      return { name, type: figmaType, valuesByMode };
    }

    // Figma-style: { resolvedType, valuesByMode: { modeId: rawVal } }
    const valuesByMode = {};
    for (const [modeId, val] of Object.entries(entry.valuesByMode || {})) {
      const modeName = modeNameById[modeId] || modeId;
      valuesByMode[modeName] = val;
    }
    return { name, type: entry.resolvedType || 'COLOR', valuesByMode };
  });

  return { modes, variables };
}

/**
 * Normalize figma-data.json to { [collectionName]: { modes, variables } }.
 *
 * Handles five input shapes:
 *
 *   A — fetch-code output (object keyed by name, already correct):
 *       { "Global": { modes: [{id, name}], variables: [...] }, ... }
 *
 *   B — Figma native export (separate collections + variables arrays):
 *       { collections: [{id, name, modes:[{modeId,name}]}], variables: [{id, name, ...}] }
 *
 *   C — Figma native array of collection objects (each has embedded variables):
 *       [ { id, name, modes: [{modeId, name}], variables: [...] }, ... ]
 *
 *   D — Object keyed by collection ID (each value has its own .name):
 *       { "VariableCollectionId:123": { id, name, modes, variables } }
 *
 *   E — Collection-keyed object with variables nested directly inside:
 *       { "Global": { "stone/stone800": {value,type}, ... }, "$extensions": {...} }
 *
 *   F — Variable-level file (W3C DTCG or flat Token Studio):
 *       { "stone800": { "$type": "color", "$value": "#333" }, ... }
 *       Top-level keys are variable names, not collection names.
 *       Treated as a single collection; name comes from fallbackCollectionName.
 *
 * After normalization every collection is guaranteed to have:
 *   - modes:     array (may be empty)
 *   - variables: array (may be empty)
 *
 * @param {*}      raw                   Parsed JSON from the input file.
 * @param {string} fallbackCollectionName Used as the collection name for Shape F files.
 */
function normalizeData(raw, fallbackCollectionName = null) {
  // Shape B — Figma native export: separate top-level collections + variables arrays
  if (raw && Array.isArray(raw.collections) && Array.isArray(raw.variables)) {
    return normalizeNative(raw);
  }

  let entries;
  if (Array.isArray(raw)) {
    // Shape C — array of collection objects
    entries = raw.map((col, i) => [col.name || `Collection_${i}`, col]);
  } else {
    entries = Object.entries(raw).filter(([k]) => !k.startsWith('$'));
    // Shape D — keyed by ID: first value has its own .name that differs from the key
    const [firstKey, firstVal] = entries[0] || [];
    if (firstVal && typeof firstVal === 'object' && firstVal.name && firstKey !== firstVal.name) {
      entries = entries.map(([, col]) => [col.name || col.id, col]);
    }
    // Shape A — already keyed by name, pass through
  }

  // Shape F — variable-level file: top-level values are tokens, not collection containers.
  // Detected when the first non-$ value carries $type/$value (W3C DTCG) or value/type (TS leaf).
  // Treat the entire file as one collection named after the fallback.
  if (fallbackCollectionName && entries.length > 0) {
    const firstVal = entries[0][1];
    const isW3c    = firstVal && typeof firstVal === 'object' &&
                     ('$type' in firstVal || '$value' in firstVal);
    const isTsLeaf = firstVal && typeof firstVal === 'object' &&
                     'value' in firstVal && 'type' in firstVal &&
                     !Array.isArray(firstVal.modes) && !Array.isArray(firstVal.variables);
    if (isW3c || isTsLeaf) {
      return { [fallbackCollectionName]: normalizeCollectionKeyed(raw) };
    }
  }

  const out = {};
  for (const [name, col] of entries) {
    if (!col || typeof col !== 'object') continue;

    if (Array.isArray(col.modes) || Array.isArray(col.variables)) {
      // Shape A or D — has explicit modes/variables arrays
      out[name] = {
        ...col,
        modes:     Array.isArray(col.modes)     ? col.modes     : [],
        variables: Array.isArray(col.variables) ? col.variables : [],
      };
    } else {
      // Shape E — variables are nested directly as keys of the collection object
      out[name] = normalizeCollectionKeyed(col);
    }
  }
  return out;
}

// ─── Conversion ───────────────────────────────────────────────────────────────

/**
 * Convert a single Figma variable value to a Token Studio leaf entry.
 */
function convertValue(val, figmaType) {
  const type = tsType(figmaType);
  // { alias: 'Collection/var/name' } — built by fetch-code / normalizeNative.
  // Strip the collection-name prefix: Token Studio paths don't include Figma collection names.
  // Exception: keep the "Segment/" prefix so Segment alias rewriting can process it later.
  // Also strip any trailing ? that Figma occasionally appends to variable names.
  if (isAlias(val)) {
    const raw   = val.alias.replace(/\?$/, '');
    const parts = raw.split('/');
    const cleaned = (parts.length > 1 && parts[0].toLowerCase() !== 'segment')
      ? parts.slice(1).join('/')
      : raw;
    return { value: toTsAlias(cleaned), type };
  }
  // Already a Token Studio leaf { value, type } — pass through.
  // Uppercase raw hex strings; strip trailing ? from alias reference values;
  // rewrite {Segment.x.y} aliases when a defaultSegment is configured.
  if (val && typeof val === 'object' && 'value' in val && 'type' in val) {
    if (typeof val.value === 'string' && val.value.endsWith('?}')) {
      val = { ...val, value: val.value.replace(/\?\}$/, '}') };
    }
    if (val.type === 'color' && typeof val.value === 'string' && val.value.startsWith('#')) {
      return { ...val, value: val.value.toUpperCase() };
    }
    // Strip {Segment.x.y} prefix and append defaultSegment: {neutral.dm950.CON}
    // Strip {Global.x.y} prefix — Token Studio paths never include the collection name.
    if (typeof val.value === 'string') {
      const mSeg = val.value.match(/^\{[Ss]egment\.(.+)\}$/);
      if (mSeg && _segmentSuffix) return { ...val, value: `{${mSeg[1]}.${_segmentSuffix}}` };
      const mGlobal = val.value.match(/^\{Global\.(.+)\}$/);
      if (mGlobal) return { ...val, value: `{${mGlobal[1]}}` };
    }
    return val;
  }
  if (figmaType === 'COLOR')   return { value: rgbaToHex(val), type };
  if (figmaType === 'STRING')  return { value: String(val), type };
  return { value: fmtNumber(val), type }; // FLOAT
}

/**
 * Convert one collection's data to a Token Studio JSON object.
 *
 * Single-mode collections (e.g. Global, Spacing):
 *   Variable "bg/fill/default" → { bg: { fill: { default: { value, type } } } }
 *
 * Multi-mode collections (e.g. Segment with Pewter/Iris/Marigold/Ember):
 *   Variable "bg/fill/default" with modes A, B →
 *     { bg: { fill: { default: { A: { value, type }, B: { value, type } } } } }
 */
function convertCollection(colData, colName = null) {
  const out          = {};
  const modes        = Array.isArray(colData.modes)     ? colData.modes     : [];
  const variables    = Array.isArray(colData.variables) ? colData.variables : [];
  const isSingleMode = modes.length === 1;
  const singleMode   = isSingleMode ? modes[0].name : null;

  // Strip a collection-name prefix per variable.
  // When colName is provided, strip the first segment if it matches colName
  // (case-insensitive) and at least two segments remain.
  // Fallback: strip a shared prefix when every variable uses the same first
  // segment (e.g. "global/warm/warm900" → "warm/warm900").
  const colNameLower = colName ? colName.toLowerCase() : null;
  const firstSegs    = new Set(variables.map(v => v.name.split('/')[0]));
  const sharedStrip  = firstSegs.size === 1 && variables.every(v => v.name.includes('/'));

  for (const v of variables) {
    const allParts   = v.name.split('/');
    const stripThis  = colNameLower
      ? allParts[0].toLowerCase() === colNameLower && allParts.length > 1
      : sharedStrip;
    const parts      = stripThis ? allParts.slice(1) : allParts;

    if (isSingleMode) {
      const val = v.valuesByMode[singleMode];
      if (val == null) continue;
      setPath(out, parts, convertValue(val, v.type));
    } else {
      const modeEntries = {};
      for (const mode of modes) {
        const val = v.valuesByMode[mode.name];
        if (val == null) continue;
        modeEntries[mode.name] = convertValue(val, v.type);
      }
      setPath(out, parts, modeEntries);
    }
  }

  return out;
}

/**
 * Convert a multi-mode collection into one Token Studio JSON object per mode.
 * Returns an array of { fileName, tsJson } — one entry per mode.
 *
 * Each file contains the variables at their natural path with no mode nesting:
 *   Variable "bg/fill/default" in mode "Beans" → Beans.json: { bg: { fill: { default: { value, type } } } }
 *
 * Single-mode collections fall back to convertCollection (one file, same as before).
 */
// Generic mode names that need a collection prefix to be unambiguous.
const GENERIC_MODE_NAMES = new Set([
  'value', 'default', 'light', 'dark', 'mode 1', 'mode 2', 'mode 3', 'mode 4',
  'mode1', 'mode2', 'mode3', 'mode4',
]);

function modeFileName(modeName, colName) {
  const isGeneric = GENERIC_MODE_NAMES.has(modeName.toLowerCase());
  const base = slugifyMode(modeName);
  return isGeneric ? slugify(colName) + '-' + base + '.json' : base + '.json';
}

function convertCollectionSplit(colData, colName) {
  const modes     = Array.isArray(colData.modes)     ? colData.modes     : [];
  const variables = Array.isArray(colData.variables) ? colData.variables : [];

  if (modes.length <= 1) {
    const fileName = modes.length === 1 ? modeFileName(modes[0].name, colName) : 'output.json';
    return [{ fileName, tsJson: convertCollection(colData, colName) }];
  }

  const colNameLower = colName ? colName.toLowerCase() : null;
  const firstSegs    = new Set(variables.map(v => v.name.split('/')[0]));
  const sharedStrip  = firstSegs.size === 1 && variables.every(v => v.name.includes('/'));

  return modes.map(mode => {
    const out = {};
    for (const v of variables) {
      const val = v.valuesByMode[mode.name];
      if (val == null) continue;
      const allParts  = v.name.split('/');
      const stripThis = colNameLower
        ? allParts[0].toLowerCase() === colNameLower && allParts.length > 1
        : sharedStrip;
      const parts     = stripThis ? allParts.slice(1) : allParts;
      setPath(out, parts, convertValue(val, v.type));
    }
    return { fileName: modeFileName(mode.name, colName), tsJson: out };
  });
}

// ─── File loader ──────────────────────────────────────────────────────────────

/**
 * Rename the single default "Value" mode to a meaningful name derived from the
 * source filename.  Called once per file in the config-driven --all path so
 * that each per-mode file contributes a distinct mode to the merged collection.
 *
 * Only acts when the collection has exactly one mode called "Value" — the
 * generic default that normalizeCollectionKeyed assigns to flat Token Studio
 * files that carry no explicit mode information.  Files that already have real
 * mode names (e.g. a Figma native export with "light"/"dark") are untouched.
 *
 * Example:
 *   BMO.tokens.json normalizes to  { modes: [{name:"Value"}], variables: [{valuesByMode:{Value:…}}] }
 *   renameDefaultMode(col, "BMO")  { modes: [{name:"BMO"}],   variables: [{valuesByMode:{BMO:…}}]   }
 */
function renameDefaultMode(colData, newModeName) {
  const modes = colData.modes || [];
  if (modes.length !== 1 || modes[0].name !== 'Value') return colData;
  return {
    modes: [{ ...modes[0], name: newModeName }],
    variables: (colData.variables || []).map(v => {
      const valuesByMode = {};
      for (const [k, val] of Object.entries(v.valuesByMode || {})) {
        valuesByMode[k === 'Value' ? newModeName : k] = val;
      }
      return { ...v, valuesByMode };
    }),
  };
}

/**
 * Load a Token Studio (or W3C DTCG) JSON file as a single-mode collection.
 *
 * Unlike normalizeData + normalizeCollectionKeyed, this function NEVER applies
 * the ts-multi heuristic.  That heuristic collapses siblings that are all
 * { value, type } leaves into a multi-mode variable — which is correct for
 * genuine multi-mode TS files, but wrong for per-mode files where those
 * siblings are different tokens (e.g. theme/primary800, theme/primary700).
 *
 * This function simply recurses until it finds { value, type } or
 * { $type, $value } leaves, registering each as a separate variable in the
 * single mode named `modeName`.
 *
 * Example — BMO.tokens.json:
 *   { "theme": { "primary800": { value:"#1A2", type:"color" },
 *                "primary700": { value:"#2B3", type:"color" } } }
 *   → variables: [ {name:"theme/primary800", …, valuesByMode:{BMO:{value,type}}},
 *                  {name:"theme/primary700", …, valuesByMode:{BMO:{value,type}}} ]
 */
function loadFileAsMode(raw, modeName, segmentSuffix = null) {
  const variables = [];

  function walk(node, pathParts) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;

    // W3C DTCG leaf: { $type, $value, $extensions? }
    if ('$value' in node && '$type' in node) {
      const tokenType = node['$type'];
      const figmaType = tokenType === 'color' ? 'COLOR' : tokenType === 'number' ? 'FLOAT' : 'STRING';

      // Figma encodes alias targets in $extensions["com.figma.aliasData"].
      // When present, emit a Token Studio dot-notation reference instead of the
      // resolved hex value:  "marigold/marigold800" → "{marigold.marigold800}"
      const aliasData = node['$extensions']?.['com.figma.aliasData'];
      if (aliasData?.targetVariableName) {
        // When the alias targets the Segment collection and a defaultSegment is
        // configured, append the segment mode so the reference resolves to the
        // correct per-segment value:  {base.dm950} → {base.dm950.Fremy}
        //
        // Do NOT append if the targetVariableName already starts with the
        // collection name (e.g. "Segment/neutral/lm000") — that format embeds
        // the collection as a prefix and needs no suffix.
        // Strip trailing ? — Figma occasionally appends it to variable names as an artifact.
        // Use the exact targetVariableName with no mode fallback (Bug 3).
        const targetName      = aliasData.targetVariableName.replace(/\?$/, '');
        const setName         = aliasData.targetVariableSetName || '';
        const alreadyPrefixed = targetName
          .toLowerCase()
          .startsWith(setName.toLowerCase() + '/');
        // Strip the collection-name prefix when it is embedded in the variable name
        // (e.g. "Global/warm/warm800" → "warm/warm800"). Token Studio paths never
        // include the Figma collection name.
        const strippedName = alreadyPrefixed
          ? targetName.slice(setName.length + 1)
          : targetName;
        const needsSuffix = segmentSuffix && setName === 'Segment' && !alreadyPrefixed;
        const aliasPath   = needsSuffix
          ? strippedName + '/' + segmentSuffix
          : strippedName;
        variables.push({
          name: pathParts.join('/'),
          type: figmaType,
          valuesByMode: { [modeName]: { value: toTsAlias(aliasPath), type: tokenType } },
        });
        return;
      }

      const rawVal = node['$value'];
      let value;
      if (tokenType === 'color' && rawVal && typeof rawVal === 'object') {
        if (Array.isArray(rawVal.components)) {
          // Use components + alpha so floating-point precision issues are handled
          // by Math.round and alpha < 1 produces correct 8-digit hex.
          const [r, g, b] = rawVal.components;
          value = rgbaToHex({ r, g, b, a: rawVal.alpha ?? 1 });
        } else if (rawVal.hex) {
          // No components array — use the pre-computed hex but still apply alpha
          // so 8-digit hex is produced when the token has transparency.
          const ha = n => Math.ceil(n * 255).toString(16).padStart(2, '0').toUpperCase();
          const a = rawVal.alpha ?? 1;
          value = rawVal.hex.toUpperCase() + (a < 1 ? ha(a) : '');
        } else {
          value = String(rawVal);
        }
      } else {
        value = String(rawVal);
      }
      variables.push({
        name: pathParts.join('/'),
        type: figmaType,
        valuesByMode: { [modeName]: { value, type: tokenType } },
      });
      return;
    }

    // Token Studio leaf: { value, type }
    if ('value' in node && 'type' in node) {
      const t = node.type;
      const figmaType = t === 'color' ? 'COLOR'
        : (t === 'number' || t === 'spacing' || t === 'fontSizes' || t === 'fontWeights' || t === 'borderRadius') ? 'FLOAT'
        : 'STRING';
      variables.push({
        name: pathParts.join('/'),
        type: figmaType,
        valuesByMode: { [modeName]: node },
      });
      return;
    }

    // Recurse into children, skipping $-prefixed metadata
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('$')) continue;
      walk(v, [...pathParts, k]);
    }
  }

  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('$')) continue;
    walk(v, [k]);
  }

  return {
    modes:     [{ id: modeName, name: modeName }],
    variables,
  };
}

/**
 * Merge an array of single-collection data objects that all belong to the same
 * Figma collection but were exported as separate per-mode files.
 *
 * Modes are unioned by name (first occurrence wins for the id field).
 * Variables are matched by name across files; their valuesByMode maps are
 * combined so every variable ends up carrying all modes' values.
 *
 * Example:
 *   light.json  → { modes: [{name:"light"}],  variables: [{name:"bg/default", valuesByMode:{light:…}}] }
 *   dark.json   → { modes: [{name:"dark"}],   variables: [{name:"bg/default", valuesByMode:{dark:…}}] }
 *   merged      → { modes: [{name:"light"},{name:"dark"}],
 *                   variables: [{name:"bg/default", valuesByMode:{light:…, dark:…}}] }
 */
function mergeCollectionData(cols) {
  if (cols.length === 1) return cols[0];

  const seenModes  = new Set();
  const allModes   = [];
  const varsByName = new Map();

  for (const col of cols) {
    for (const m of (col.modes || [])) {
      if (!seenModes.has(m.name)) {
        seenModes.add(m.name);
        allModes.push(m);
      }
    }
    for (const v of (col.variables || [])) {
      if (!varsByName.has(v.name)) {
        varsByName.set(v.name, { name: v.name, type: v.type, valuesByMode: {} });
      }
      Object.assign(varsByName.get(v.name).valuesByMode, v.valuesByMode);
    }
  }

  return { modes: allModes, variables: [...varsByName.values()] };
}

/**
 * Rewrite Segment-prefixed Token Studio aliases so they resolve to the correct
 * per-segment mode value.
 *
 * Some design systems export aliases with the Figma collection name as a prefix:
 *   {Segment.neutral.dm950}
 * This format doesn't include the specific segment/mode, so Token Studio can't
 * resolve it.  Strip the prefix and append the default segment code instead:
 *   {Segment.neutral.dm950} → {neutral.dm950.CON}
 *
 * Only rewrites values that match /^\{[Ss]egment\..+\}$/.
 * Raw hex values, non-Segment aliases, and already-suffixed aliases are untouched.
 */
function rewriteSegmentAliases(colData, defaultSegment) {
  if (!defaultSegment) return colData;
  return {
    ...colData,
    variables: colData.variables.map(v => ({
      ...v,
      valuesByMode: Object.fromEntries(
        Object.entries(v.valuesByMode).map(([mode, val]) => {
          if (val && typeof val === 'object' && typeof val.value === 'string') {
            const m = val.value.match(/^\{[Ss]egment\.(.+)\}$/);
            if (m) return [mode, { ...val, value: `{${m[1]}.${defaultSegment}}` }];
          }
          return [mode, val];
        })
      ),
    })),
  };
}

/**
 * Load one or more JSON files. Each file is normalized independently —
 * no merging across files. Collections from multiple files are unioned by name
 * (last file wins on collision). Used by --from-json.
 *
 * The filename (without extension) is passed to normalizeData as a fallback
 * collection name so that variable-level files (W3C DTCG, flat Token Studio)
 * produce a single collection named after the file.
 */
function loadFiles(filePaths, { failOnError = true } = {}) {
  const keyedData = {};

  for (const fp of filePaths) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(fp, 'utf8'));
    } catch (err) {
      if (failOnError) {
        process.stderr.write(`Error reading ${basename(fp)}: ${err.message}\n`);
        process.exit(1);
      } else {
        process.stderr.write(`⚠ Skipping ${basename(fp)}: ${err.message}\n`);
        continue;
      }
    }

    debugShape(raw);

    // Derive collection name from filename — strips .tokens.json or .json
    const colName    = basename(fp).replace(/\.tokens\.json$/i, '').replace(/\.json$/i, '');
    const normalized = normalizeData(raw, colName);
    const normKeys   = Object.keys(normalized);

    // Single-collection file: always name the output after the input file,
    // not the internal collection name. WFA.tokens.json → WFA.json, not segment.json.
    if (normKeys.length === 1) {
      keyedData[colName] = normalized[normKeys[0]];
    } else {
      Object.assign(keyedData, normalized);
    }
  }

  return keyedData;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function printUsage() {
  process.stdout.write(`
Generic Figma Variable Exporter

Exports Figma variable collections to Token Studio JSON.

─── Single file (all collections) ───────────────────────────────────────────

  node src/exporter.js --from-json figma-data.json [--dry-run]

  Accepts any supported format:
    • Figma native export  ({ collections, variables })
    • Fetch-code output    ({ "CollectionName": { modes, variables } })
    • Token Studio JSON    (nested { value, type } trees)

  One collection per file also works:
    node src/exporter.js --from-json tokens/Global.tokens.json

─── All files in tokens/ ─────────────────────────────────────────────────────

  node src/exporter.js --all [--dry-run]

  Reads every .json file in tokens/, merges them, and writes all output to
  ${CONFIG.exportDir}/ in one run. Cross-collection aliases (e.g. Prisme → Segment
  → Global) resolve correctly because all files are loaded together.

─── Fetch code ───────────────────────────────────────────────────────────────

  node src/exporter.js --generate-fetch-code > /tmp/figma-fetch.js
  # Run in Figma via MCP, paste result into figma-data.json

Output files are written to ${CONFIG.exportDir}/ (configured at the top of this file).
\n`);
}

/**
 * Print the discovery table + mode debug, optionally write files.
 * Shared by --from-json and --all.
 *
 * @param {Array}   collections          Array of [colName, colData] pairs.
 * @param {boolean} dryRun               When true, no files are written.
 * @param {boolean} preserveFilenameCase When true, colName is used as-is for the
 *                                       output filename instead of being slugified.
 *                                       Pass true for --from-json so that the filename
 *                                       reflects the input file's original casing.
 */
function runExport(collections, dryRun, preserveFilenameCase = false) {
  // ── Discovery report ────────────────────────────────────────────────────────
  process.stdout.write(`\nFound ${collections.length} collection(s):\n\n`);
  process.stdout.write(
    '  ' +
    'Collection'.padEnd(22) + '  ' +
    'Modes'.padEnd(34) + '  ' +
    'Vars'.padEnd(5) + '  ' +
    'Output file\n'
  );
  process.stdout.write('  ' + '─'.repeat(74) + '\n');

  for (const [colName, colData] of collections) {
    if (!Array.isArray(colData.modes)) {
      process.stderr.write(`\n  ⚠ Unexpected structure for "${colName}":\n`);
      process.stderr.write(`    keys present : ${Object.keys(colData).join(', ')}\n`);
      process.stderr.write(`    modes value  : ${JSON.stringify(colData.modes)}\n`);
      process.stderr.write(`    (skipping this collection)\n`);
      continue;
    }
    const modeList  = colData.modes.map(m => m.name).join(', ');
    const varCount  = colData.variables.length;
    const isMulti   = SEPARATE_MODE_FILES && colData.modes.length > 1;
    const fileBase  = preserveFilenameCase ? colName : slugify(colName);
    const fileNames = isMulti
      ? colData.modes.map(m => modeFileName(m.name, colName)).join(', ')
      : fileBase + '.json';
    process.stdout.write(
      '  ' +
      colName.padEnd(22) + '  ' +
      modeList.padEnd(34) + '  ' +
      String(varCount).padEnd(5) + '  ' +
      fileNames + '\n'
    );
  }
  process.stdout.write('\n');

  // ── Mode separation debug ───────────────────────────────────────────────────
  process.stdout.write('[debug] Mode separation plan:\n');
  for (const [colName, colData] of collections) {
    if (!Array.isArray(colData.modes)) continue;
    const modeCount = colData.modes.length;
    const modeNames = colData.modes.map(m => m.name).join(', ');
    const isMultiD  = SEPARATE_MODE_FILES && modeCount > 1;
    const fileBaseD = preserveFilenameCase ? colName : slugify(colName);
    const outFiles  = isMultiD
      ? colData.modes.map(m => modeFileName(m.name, colName)).join(', ')
      : fileBaseD + '.json';
    process.stdout.write(
      `  ${colName.padEnd(18)}  modes=${modeCount}  [${modeNames}]  →  ${outFiles}\n`
    );
  }
  process.stdout.write('\n');

  if (dryRun) {
    process.stdout.write('[dry-run] No files written.\n\n');
    return;
  }

  // ── Write files ─────────────────────────────────────────────────────────────
  const exportDir = resolve(projectRoot, CONFIG.exportDir);
  mkdirSync(exportDir, { recursive: true });

  let totalVars  = 0;
  let totalFiles = 0;

  for (const [colName, colData] of collections) {
    if (!Array.isArray(colData.modes)) continue;
    const count  = colData.variables.length;
    totalVars   += count;
    const isMulti = SEPARATE_MODE_FILES && colData.modes.length > 1;

    if (isMulti) {
      const splitFiles = convertCollectionSplit(colData, colName);
      for (const { fileName, tsJson } of splitFiles) {
        writeFileSync(resolve(exportDir, fileName), JSON.stringify(tsJson, null, 2) + '\n');
        process.stdout.write(`✓ ${CONFIG.exportDir}/${fileName}  (${count} var${count !== 1 ? 's' : ''})\n`);
        totalFiles++;
      }
    } else {
      const tsJson    = convertCollection(colData, colName);
      const fileName  = (preserveFilenameCase ? colName : slugify(colName)) + '.json';
      const modeCount = colData.modes.length;
      writeFileSync(resolve(exportDir, fileName), JSON.stringify(tsJson, null, 2) + '\n');
      process.stdout.write(
        `✓ ${CONFIG.exportDir}/${fileName}` +
        `  (${count} var${count !== 1 ? 's' : ''}, ${modeCount} mode${modeCount !== 1 ? 's' : ''})\n`
      );
      totalFiles++;
    }
  }

  process.stdout.write(`\nExported ${totalVars} variables across ${totalFiles} file${totalFiles !== 1 ? 's' : ''}\n`);
}

async function main() {
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  // ── --generate-fetch-code ──────────────────────────────────────────────────
  if (args.includes('--generate-fetch-code')) {
    process.stdout.write(generateFetchCode() + '\n');
    return;
  }

  // ── --init ─────────────────────────────────────────────────────────────────
  // Interactive setup wizard: asks the user how to group their token files,
  // then writes prisme.config.json.  Run again at any time to reconfigure.
  if (args.includes('--init')) {
    const tokensDir = resolve(projectRoot, 'tokens');
    let tokenFiles;
    try {
      tokenFiles = readdirSync(tokensDir).filter(f => f.endsWith('.json')).sort();
    } catch (err) {
      process.stderr.write(`Error: could not read tokens/ directory\n  ${err.message}\n`);
      process.stderr.write('Create a tokens/ folder next to src/ and put your token files there.\n');
      process.exit(1);
    }
    if (tokenFiles.length === 0) {
      process.stdout.write('No .json files found in tokens/ — nothing to configure.\n');
      return;
    }

    const rl  = createInterface({ input: process.stdin, output: process.stdout });
    const ask = q => new Promise(res => rl.question(q, res));

    // Parse a comma-separated answer into matched filenames.
    // Accepts 1-based numbers from the displayed list, exact filenames,
    // or bare basenames (e.g. "CON" matches "CON.tokens.json").
    const parseSelection = (input, available) => {
      if (!input.trim()) return [];
      return input.split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => {
          const n = parseInt(s, 10);
          if (!isNaN(n) && n >= 1 && n <= available.length) return available[n - 1];
          const lower = s.toLowerCase();
          return available.find(f =>
            f.toLowerCase() === lower ||
            f.toLowerCase().replace(/\.tokens\.json$/i, '').replace(/\.json$/i, '') === lower
          ) || null;
        })
        .filter(Boolean);
    };

    const showList = files => files.forEach((f, i) =>
      process.stdout.write(`  ${String(i + 1).padStart(2)}. ${f}\n`)
    );

    let finalConfig = null;

    try {
      while (true) {
        let remaining = [...tokenFiles];
        const collections = {};

        // ── Q1: global / primitive files ───────────────────────────────────────
        process.stdout.write('\nFiles found in tokens/:\n');
        showList(remaining);
        const a1 = await ask(
          '\nQuestion 1:\n' +
          'Which files contain your global/primitive color values?\n' +
          '(comma-separated filenames or numbers, or press enter to skip)\n> '
        );
        const globalFiles = parseSelection(a1, remaining);
        if (globalFiles.length > 0) {
          collections['global'] = globalFiles;
          remaining = remaining.filter(f => !globalFiles.includes(f));
        }

        // ── Q2: brand / segment files ──────────────────────────────────────────
        if (remaining.length > 0) {
          process.stdout.write('\nRemaining files:\n');
          showList(remaining);
        }
        const a2 = await ask(
          '\nQuestion 2:\n' +
          'Which files are your brand/segment files that should be combined into one file?\n' +
          '(comma-separated, or press enter to skip)\n> '
        );
        const segmentFiles = parseSelection(a2, remaining);
        if (segmentFiles.length > 0) {
          remaining = remaining.filter(f => !segmentFiles.includes(f));
          // Q3: name for the combined segment output
          const a3 = await ask(
            '\nQuestion 3:\n' +
            'What do you want to call the combined segment output file?\n' +
            '(e.g. segment, brand, themes)\n> '
          );
          const segmentKey = a3.trim().toLowerCase().replace(/\.json$/i, '') || 'segment';
          collections[segmentKey] = segmentFiles;
        }

        // ── Q4: semantic / light / dark files ──────────────────────────────────
        if (remaining.length > 0) {
          process.stdout.write('\nRemaining files:\n');
          showList(remaining);
        }
        const a4 = await ask(
          '\nQuestion 4:\n' +
          'Which files are your semantic/light/dark files that should be combined?\n' +
          '(comma-separated, or press enter to skip)\n> '
        );
        const semanticFiles = parseSelection(a4, remaining);
        if (semanticFiles.length > 0) {
          remaining = remaining.filter(f => !semanticFiles.includes(f));
          // Q5: name for the combined semantic output
          const a5 = await ask(
            '\nQuestion 5:\n' +
            'What do you want to call the combined semantic output file?\n' +
            '(e.g. fusion, semantic, tokens)\n> '
          );
          const semanticKey = a5.trim().toLowerCase().replace(/\.json$/i, '') || 'semantic';
          collections[semanticKey] = semanticFiles;
        }

        // ── Q6: default segment + remaining files ──────────────────────────────
        if (remaining.length > 0) {
          process.stdout.write('\nRemaining files (each will become its own output file):\n');
          showList(remaining);
        }
        const a6 = await ask(
          '\nQuestion 6:\n' +
          'Any remaining files will each become their own output file.\n' +
          'What is your default segment or mode? (e.g. CON, Fremy, Default)\n> '
        );
        const defaultSegment = a6.trim() || 'Mode 1';

        // Remaining files → one entry each, key derived from filename
        for (const f of remaining) {
          const key = f
            .replace(/\.tokens\.json$/i, '')
            .replace(/\.json$/i, '')
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '');
          collections[key] = [f];
        }

        // ── Preview ────────────────────────────────────────────────────────────
        process.stdout.write('\nThis is how your files will be grouped:\n\n');
        for (const [key, files] of Object.entries(collections)) {
          process.stdout.write(`  ${key}.json  <-  ${files.join(', ')}\n`);
        }
        process.stdout.write(`\n  defaultSegment: "${defaultSegment}"\n\n`);

        const confirm = await ask('Does this look correct? (yes/no)\n> ');
        if (confirm.trim().toLowerCase().startsWith('y')) {
          finalConfig = { collections, defaultSegment };
          break;
        }
        process.stdout.write('\nStarting over...\n');
      }
    } finally {
      rl.close();
    }

    const configPath = resolve(projectRoot, 'prisme.config.json');
    writeFileSync(configPath, JSON.stringify(finalConfig, null, 2) + '\n');
    process.stdout.write('\nSetup complete. Run node src/exporter.js --all to export.\n\n');
    return;
  }

  // ── --from-json <file> ─────────────────────────────────────────────────────
  const fromJsonIdx = args.indexOf('--from-json');
  if (fromJsonIdx !== -1) {
    const jsonFile = args[fromJsonIdx + 1];
    if (!jsonFile || jsonFile.startsWith('--')) {
      process.stderr.write('Error: --from-json requires a file path argument\n');
      process.exit(1);
    }

    // Output filename always comes from the input filename, never from any
    // internal collection name found inside the JSON file.
    //   tokens/WFA.tokens.json  →  strip path  →  WFA.tokens.json
    //                           →  strip exts  →  WFA
    //                           →  output file →  WFA.json
    const outputBaseName = basename(jsonFile)
      .replace(/\.tokens\.json$/i, '')
      .replace(/\.json$/i, '');

    const figmaData = loadFiles([resolve(process.cwd(), jsonFile)]);
    const cols = Object.values(figmaData);

    // Merge ALL collections (including any legacy group) into a single entry
    // named after the input file. This prevents a separate legacy.json from
    // being emitted when the file contains a legacy group alongside the main
    // collection.
    let mergedData;
    if (cols.length === 1) {
      mergedData = cols[0];
    } else {
      const seenModes = new Set();
      const allModes  = [];
      const allVars   = [];
      for (const col of cols) {
        for (const m of (col.modes || [])) {
          if (!seenModes.has(m.name)) {
            seenModes.add(m.name);
            allModes.push(m);
          }
        }
        allVars.push(...(col.variables || []));
      }
      mergedData = { modes: allModes, variables: allVars };
    }

    // Rewrite {Segment.x.y} aliases → {x.y.defaultSegment} using prisme.config.json.
    // This fixes Fusion/semantic files whose aliases were exported with the Figma
    // collection name as a prefix instead of the per-segment mode suffix.
    let fromJsonDefaultSegment = null;
    try {
      const cfg = JSON.parse(readFileSync(resolve(projectRoot, 'prisme.config.json'), 'utf8'));
      fromJsonDefaultSegment = cfg.defaultSegment || null;
    } catch (_) {}
    mergedData = rewriteSegmentAliases(mergedData, fromJsonDefaultSegment);

    runExport([[outputBaseName, mergedData]], dryRun, true);
    return;
  }

  // ── --all ──────────────────────────────────────────────────────────────────
  if (args.includes('--all')) {
    const tokensDir = resolve(projectRoot, 'tokens');
    process.stdout.write(`\nLooking for .json files in: ${tokensDir}\n`);
    let files;
    try {
      files = readdirSync(tokensDir)
        .filter(f => f.endsWith('.json'))
        .map(f => resolve(tokensDir, f));
    } catch (err) {
      process.stderr.write(`Error: could not read tokens/ directory (${tokensDir})\n`);
      process.stderr.write(`  ${err.message}\n`);
      process.stderr.write('Create a tokens/ folder next to src/ and put your token files there.\n');
      process.exit(1);
    }
    if (files.length === 0) {
      process.stdout.write(`No .json files found in ${tokensDir}\n`);
      return;
    }
    process.stdout.write(`Found ${files.length} file(s):\n`);
    for (const f of files) process.stdout.write(`  ${basename(f)}\n`);

    // Try to load prisme.config.json for explicit collection→file mappings.
    const configPath = resolve(projectRoot, 'prisme.config.json');
    let config = null;
    try {
      const configRaw = JSON.parse(readFileSync(configPath, 'utf8'));
      if (configRaw && typeof configRaw.collections === 'object' && !Array.isArray(configRaw.collections)) {
        config = configRaw;
      }
    } catch (_) {
      // No config file or invalid JSON — will fall back to auto-grouping below.
    }

    if (config) {
      // Make defaultSegment available to convertValue for {Segment.x.y} rewrites.
      _segmentSuffix = config.defaultSegment || null;

      // ── Config-driven grouping ───────────────────────────────────────────────
      //
      // prisme.config.json defines the output collections explicitly:
      //   "segment": ["CON.tokens.json", "TPB.tokens.json", "WFA.tokens.json", "PRM.tokens.json"]
      //
      // The key becomes the output filename (segment → segment.json).
      // Files listed under a key are merged: their modes and variables are
      // combined so the output contains all modes nested inside each token.
      //
      // This is fully generic — works for any design system, any file names,
      // any collection structure.  The user controls everything through the config.
      process.stdout.write(`\nUsing prisme.config.json\n`);

      const allCollections = [];
      for (const [outputKey, inputFiles] of Object.entries(config.collections)) {
        const fileList = Array.isArray(inputFiles) ? inputFiles : [inputFiles];
        const cols = [];

        for (const fname of fileList) {
          const fpath = resolve(tokensDir, fname);
          let raw;
          try {
            raw = JSON.parse(readFileSync(fpath, 'utf8'));
          } catch (err) {
            process.stderr.write(`⚠ [${outputKey}] Skipping ${fname}: ${err.message}\n`);
            continue;
          }
          // Use loadFileAsMode instead of normalizeData so the ts-multi heuristic
          // never fires.  That heuristic incorrectly collapses sibling tokens
          // (e.g. theme/primary800, theme/primary700) into a single variable when
          // all siblings happen to be { value, type } leaves.  loadFileAsMode
          // recurses all the way to each leaf without any collapsing.
          const fileBase = fname.replace(/\.tokens\.json$/i, '').replace(/\.json$/i, '');
          const colData  = loadFileAsMode(raw, fileBase, config.defaultSegment || null);
          process.stderr.write(`  [${outputKey}] ${fname}: ${colData.variables.length} vars (mode: ${fileBase})\n`);
          cols.push(colData);
        }

        if (cols.length === 0) {
          process.stderr.write(`⚠ No data loaded for "${outputKey}" — skipping\n`);
          continue;
        }

        const beforeTotal = cols.reduce((sum, c) => sum + c.variables.length, 0);
        const merged      = mergeCollectionData(cols);
        const afterTotal  = merged.variables.length;
        process.stderr.write(
          `  [${outputKey}] merged: ${beforeTotal} vars across ${cols.length} file(s) → ` +
          `${afterTotal} vars, modes: [${merged.modes.map(m => m.name).join(', ')}]\n`
        );
        allCollections.push([outputKey, rewriteSegmentAliases(merged, config.defaultSegment || null)]);
      }

      if (allCollections.length === 0) {
        process.stdout.write('No tokens found — nothing to export.\n');
        return;
      }

      // preserveFilenameCase=true: outputKey is used as-is for the filename.
      runExport(allCollections, dryRun, true);

    } else {
      // ── Auto-grouping fallback (no prisme.config.json found) ─────────────────
      //
      // Normalizes each file and detects the internal collection name from its
      // structure.  Files that share the same internal name are merged together.
      //
      // Run `npm run init` to generate a prisme.config.json you can edit.
      process.stdout.write('\nNo prisme.config.json found — using auto-grouping.\n');
      process.stdout.write('Run `npm run init` to generate a config file.\n');

      const groups = new Map(); // internalColName → colData[]

      for (const file of files) {
        let raw;
        try {
          raw = JSON.parse(readFileSync(file, 'utf8'));
        } catch (err) {
          process.stderr.write(`⚠ Skipping ${basename(file)}: ${err.message}\n`);
          continue;
        }
        debugShape(raw);
        const fileBase   = basename(file).replace(/\.tokens\.json$/i, '').replace(/\.json$/i, '');
        const normalized = normalizeData(raw, fileBase);
        for (const [colName, colData] of Object.entries(normalized)) {
          if (!groups.has(colName)) groups.set(colName, []);
          groups.get(colName).push(colData);
        }
      }

      const allCollections = [];
      for (const [colName, cols] of groups) {
        allCollections.push([colName, mergeCollectionData(cols)]);
      }

      if (allCollections.length === 0) {
        process.stdout.write('No tokens found in any file — nothing to export.\n');
        return;
      }

      runExport(allCollections, dryRun);
    }
    return;
  }

  printUsage();
}

main();
