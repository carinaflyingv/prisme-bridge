/**
 * Prisme Token Importer
 *
 * Reads Token Studio JSON files and imports them as Figma variable collections
 * via the Figma Plugin API (use_figma MCP call).
 *
 * Configuration: optional prisme.config.json in project root.
 * Without config: scans tokens/ and creates one collection per file.
 *
 * Usage:
 *   node src/importer.js --dry-run
 *   node src/importer.js --generate-plugin-code <CollectionName|legacy-slug>
 *   node src/importer.js init
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';
import { resolve, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const TOKENS_DIR = resolve(projectRoot, 'tokens');
const CONFIG_FILE = resolve(projectRoot, 'prisme.config.json');

// ─── Legacy slug map (backward compat for --generate-plugin-code) ─────────────

const LEGACY_SLUG_MAP = {
  'global':       'Global',
  'segment':      'Segment',
  'fusion':       'Prisme',
  'spacing':      'Spacing',
  'radius':       'Radius',
  'type-global':  'Type Global',
  'type-fusion':  'Type Fusion',
};

// ─── Config loading ───────────────────────────────────────────────────────────

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.warn(`⚠ Could not parse prisme.config.json: ${e.message}`);
    return null;
  }
}

function scanTokenDir() {
  if (!existsSync(TOKENS_DIR)) throw new Error(`tokens/ folder not found at ${TOKENS_DIR}`);
  return readdirSync(TOKENS_DIR).filter(f => f.endsWith('.json')).sort();
}

function fileToCollectionName(filename) {
  const base = basename(filename, extname(filename)).replace(/\.tokens$/, '');
  return (LEGACY_SLUG_MAP[base] ?? base.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
}

/**
 * Build an ordered array of { name, filename } from config or auto-scan.
 * Order matters: dependencies must appear before the collections that alias them.
 */
function buildPlan(config, tokenFiles) {
  if (config?.collections && Object.keys(config.collections).length > 0) {
    return Object.entries(config.collections).map(([name, filename]) => ({ name, filename }));
  }
  return tokenFiles.map(f => ({ name: fileToCollectionName(f), filename: f }));
}

function resolveCollectionName(input, plan) {
  if (!input) return null;
  if (plan.some(p => p.name === input)) return input;
  const fromSlug = LEGACY_SLUG_MAP[input];
  if (fromSlug && plan.some(p => p.name === fromSlug)) return fromSlug;
  const ci = plan.find(p => p.name.toLowerCase() === input.toLowerCase());
  return ci ? ci.name : null;
}

// ─── Mode detection ───────────────────────────────────────────────────────────

/**
 * Auto-detect mode keys in a Token Studio JSON tree.
 *
 * A mode key set is confirmed when the same set of all-leaf-child keys
 * appears in 2+ distinct parent nodes. This correctly identifies:
 *   - segment.json  → {Beans, Fremy, BMO, Mr. Tibbs}
 *   - fusion.json   → {light, dark}
 *   - global.json   → {} (each color group appears only once)
 *   - spacing/radius/type files → {} (single-mode)
 *
 * Preserves JSON key insertion order for mode iteration.
 */
function detectModes(obj) {
  // Map from sorted-key fingerprint → { count, orderedKeys[] }
  const candidates = new Map();

  function scan(node) {
    if (!node || typeof node !== 'object' || 'value' in node) return;
    const entries = Object.entries(node);
    const leafEntries = entries.filter(([, v]) =>
      v && typeof v === 'object' && 'value' in v && 'type' in v
    );
    if (leafEntries.length === entries.length && leafEntries.length >= 2) {
      const orderedKeys = leafEntries.map(([k]) => k);
      const fingerprint = [...orderedKeys].sort().join('\x00');
      const prev = candidates.get(fingerprint);
      if (prev) {
        candidates.set(fingerprint, { count: prev.count + 1, orderedKeys: prev.orderedKeys });
      } else {
        candidates.set(fingerprint, { count: 1, orderedKeys });
      }
    } else {
      for (const [, v] of entries) {
        if (v && typeof v === 'object' && !('value' in v)) scan(v);
      }
    }
  }

  scan(obj);

  let best = null;
  for (const entry of candidates.values()) {
    if (entry.count >= 2 && (!best || entry.count > best.count)) best = entry;
  }
  // Return an ordered Set (JS Sets preserve insertion order)
  return best ? new Set(best.orderedKeys) : new Set();
}

// ─── Generic flattening ───────────────────────────────────────────────────────

/**
 * Flatten a Token Studio JSON tree.
 * Returns Map<varName, Map<mode, {value, tokenType}>>
 *
 * - With modes: mode keys are stop keys; parent path is variable name
 * - Without modes (empty Set): every {value,type} leaf is 'default' mode
 */
function flattenGeneric(obj, modes, pathParts = [], result = new Map()) {
  if (!obj || typeof obj !== 'object') return result;
  if ('value' in obj && 'type' in obj) {
    const name = pathParts.join('/');
    if (name) {
      if (!result.has(name)) result.set(name, new Map());
      result.get(name).set('default', { value: obj.value, tokenType: obj.type });
    }
    return result;
  }

  for (const [key, val] of Object.entries(obj)) {
    if (!val || typeof val !== 'object') continue;
    if (modes.has(key)) {
      // Mode key — parent path is variable name
      if ('value' in val && 'type' in val) {
        const name = pathParts.join('/');
        if (!name) continue;
        if (!result.has(name)) result.set(name, new Map());
        result.get(name).set(key, { value: val.value, tokenType: val.type });
      }
    } else if ('value' in val && 'type' in val) {
      // Leaf with no mode wrapper
      const name = [...pathParts, key].join('/');
      if (!result.has(name)) result.set(name, new Map());
      result.get(name).set('default', { value: val.value, tokenType: val.type });
    } else {
      flattenGeneric(val, modes, [...pathParts, key], result);
    }
  }
  return result;
}

// ─── Type helpers ─────────────────────────────────────────────────────────────

function isAlias(v) {
  return typeof v === 'string' && v.startsWith('{') && v.endsWith('}');
}

function tokenTypeToFigma(tokenType, value) {
  if (tokenType === 'color') return 'COLOR';
  if (tokenType === 'fontFamilies' || tokenType === 'string') return 'STRING';
  const n = parseFloat(String(value));
  if (!isNaN(n)) return 'FLOAT';
  return 'STRING';
}

function numericValue(v) {
  return parseFloat(String(v).replace(/px$/i, '').trim());
}

// Per-variable Figma type — uses first non-alias mode value
function getVarFigmaType(modeValues) {
  for (const { value, tokenType } of modeValues.values()) {
    if (!isAlias(String(value))) return tokenTypeToFigma(tokenType, value);
  }
  return 'COLOR'; // all aliases: default to COLOR
}

// Dominant type for a whole collection (for dep variable loading filter)
function collectionFigmaType(flat) {
  const types = new Set();
  for (const modes of flat.values()) {
    for (const { value, tokenType } of modes.values()) {
      if (!isAlias(String(value))) types.add(tokenTypeToFigma(tokenType, value));
    }
  }
  if (types.size === 1) return [...types][0];
  return null; // mixed — load all variable types
}

// ─── Alias resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a Token Studio alias against an ordered list of dependency collections.
 * Returns { depCol, varName } or null if unresolved.
 *
 * Handles both:
 *   {base.lm600.Fremy}  → strip mode suffix, look for "base/lm600" in Segment
 *   {stone.stone600}    → look for "stone/stone600" in Global
 *   {font.size.18}      → look for "font/size/18" in Type Global
 */
function resolveAlias(aliasStr, depCols) {
  const raw = aliasStr.replace(/^\{|\}$/g, '');
  const parts = raw.split('.');

  // Try stripping last part as a mode suffix
  const last = parts[parts.length - 1];
  for (const dep of depCols) {
    if (dep.modes.has(last)) {
      const varName = parts.slice(0, -1).join('/');
      if (dep.flat.has(varName)) return { depCol: dep, varName };
    }
  }

  // Plain varName lookup
  const varName = parts.join('/');
  for (const dep of depCols) {
    if (dep.flat.has(varName)) return { depCol: dep, varName };
  }

  return null;
}

// ─── Dependency detection ─────────────────────────────────────────────────────

/**
 * For each collection, find which other collections it aliases into.
 * Returns deps in the order they're first encountered in the flat map.
 */
function findDeps(col, allCols) {
  const seen = new Set();
  const deps = [];
  const others = allCols.filter(c => c !== col);

  for (const modeValues of col.flat.values()) {
    for (const { value } of modeValues.values()) {
      if (!isAlias(String(value))) continue;
      const resolved = resolveAlias(String(value), others);
      if (resolved && !seen.has(resolved.depCol.name)) {
        seen.add(resolved.depCol.name);
        deps.push(resolved.depCol);
      }
    }
  }
  return deps;
}

// ─── Plugin code generation ───────────────────────────────────────────────────

const HEXRGB = `  function hexToRGB(h){h=h.replace('#','');if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];return{r:parseInt(h.slice(0,2),16)/255,g:parseInt(h.slice(2,4),16)/255,b:parseInt(h.slice(4,6),16)/255};}`;

/**
 * Generate Figma Plugin API code for one collection.
 *
 * @param {object} col           - { name, flat, modes, deps }
 * @param {string} defaultSeg    - Segment mode to activate on all pages (e.g. 'Fremy')
 */
function generateCollectionCode(col, defaultSeg) {
  const L = [];
  const p = s => L.push(s);

  const modesArr = [...col.modes]; // ordered, preserves JSON key order
  const isSingleMode = modesArr.length === 0;
  const effectiveModes = isSingleMode ? ['default'] : modesArr;

  p(`(function () {`);
  p(HEXRGB);

  // Remove existing collection (idempotent)
  if (col.name === 'Prisme') {
    // Also catch legacy 'Fusion' name from older imports
    p(`  for (const c of figma.variables.getLocalVariableCollections()) {`);
    p(`    if (c.name === 'Prisme' || c.name === 'Fusion') c.remove();`);
    p(`  }`);
  } else {
    p(`  for (const c of figma.variables.getLocalVariableCollections()) {`);
    p(`    if (c.name === ${JSON.stringify(col.name)}) c.remove();`);
    p(`  }`);
  }

  // Load dep collections at runtime
  for (let i = 0; i < col.deps.length; i++) {
    const dep = col.deps[i];
    const figType = collectionFigmaType(dep.flat);
    const filterArg = figType ? JSON.stringify(figType) : '';
    p(`  const _c${i} = figma.variables.getLocalVariableCollections().find(c => c.name === ${JSON.stringify(dep.name)});`);
    p(`  const _v${i} = {};`);
    p(`  if (_c${i}) for (const v of figma.variables.getLocalVariables(${filterArg})) { if (v.variableCollectionId === _c${i}.id) _v${i}[v.name] = v; }`);
  }

  // Create collection
  p(`  const col = figma.variables.createVariableCollection(${JSON.stringify(col.name)});`);

  if (isSingleMode) {
    p(`  col.renameMode(col.defaultModeId, 'Value');`);
    p(`  const mid = col.defaultModeId;`);
  } else {
    const firstMode = modesArr[0];
    p(`  col.renameMode(col.defaultModeId, ${JSON.stringify(firstMode)});`);
    const modeEntries = modesArr.map((m, i) =>
      i === 0 ? `${JSON.stringify(m)}: col.defaultModeId` : `${JSON.stringify(m)}: col.addMode(${JSON.stringify(m)})`
    ).join(', ');
    p(`  const mid = { ${modeEntries} };`);
  }

  p(`  const V = {};`);

  // Create variables
  for (const [varName, modeValues] of col.flat) {
    const figType = getVarFigmaType(modeValues);
    p(`  V[${JSON.stringify(varName)}] = figma.variables.createVariable(${JSON.stringify(varName)}, col, ${JSON.stringify(figType)});`);

    for (const mode of effectiveModes) {
      const entry = modeValues.get(mode);
      if (!entry) continue;
      const { value } = entry;
      const modeIdExpr = isSingleMode ? 'mid' : `mid[${JSON.stringify(mode)}]`;

      if (isAlias(String(value))) {
        const resolved = resolveAlias(String(value), col.deps);
        if (resolved) {
          const i = col.deps.indexOf(resolved.depCol);
          p(`  if (_v${i}[${JSON.stringify(resolved.varName)}]) V[${JSON.stringify(varName)}].setValueForMode(${modeIdExpr}, figma.variables.createVariableAlias(_v${i}[${JSON.stringify(resolved.varName)}]));`);
        } else {
          p(`  // UNRESOLVED alias: ${value}`);
        }
      } else if (figType === 'COLOR') {
        p(`  V[${JSON.stringify(varName)}].setValueForMode(${modeIdExpr}, hexToRGB(${JSON.stringify(String(value))}));`);
      } else if (figType === 'FLOAT') {
        p(`  V[${JSON.stringify(varName)}].setValueForMode(${modeIdExpr}, ${numericValue(value)});`);
      } else {
        p(`  V[${JSON.stringify(varName)}].setValueForMode(${modeIdExpr}, ${JSON.stringify(String(value))});`);
      }
    }
  }

  // After creating a collection that aliases into a multi-mode collection,
  // set the defaultSegment mode on all pages so the alias chain resolves
  // through the correct brand (e.g. Fremy = iris/violet, not Beans = stone/brown).
  const multiModeDep = col.deps.find(d => d.modes.size > 1);
  if (multiModeDep && defaultSeg && multiModeDep.modes.has(defaultSeg)) {
    p(`  // Set ${JSON.stringify(defaultSeg)} as the active ${JSON.stringify(multiModeDep.name)} mode on all pages`);
    p(`  const _segCol = figma.variables.getLocalVariableCollections().find(c => c.name === ${JSON.stringify(multiModeDep.name)});`);
    p(`  if (_segCol) {`);
    p(`    const _segMode = _segCol.modes.find(m => m.name === ${JSON.stringify(defaultSeg)});`);
    p(`    if (_segMode) for (const pg of figma.root.children) { try { pg.setExplicitVariableModeForCollection(_segCol, _segMode.modeId); } catch(e) {} }`);
    p(`  }`);
  }

  p(`  figma.notify(${JSON.stringify(`✓ ${col.name}: ${col.flat.size} variables created`)}, { timeout: 3000 });`);
  p(`})();`);
  return L.join('\n');
}

// ─── Dry-run helpers ──────────────────────────────────────────────────────────

function printFileMappingTable(collections) {
  const COL_W = 20, FILE_W = 28, VARS_W = 5;
  const hr = '─'.repeat(COL_W + FILE_W + VARS_W + 40);
  console.log(`\n  ${'Collection'.padEnd(COL_W)} ${'File'.padEnd(FILE_W)} ${'Vars'.padStart(VARS_W)}  Modes`);
  console.log(`  ${hr}`);
  for (const col of collections) {
    const modeStr = col.modes.size > 0 ? [...col.modes].join(' · ') : 'Value';
    console.log(`  ${col.name.padEnd(COL_W)} ${col.filename.padEnd(FILE_W)} ${String(col.flat.size).padStart(VARS_W)}  ${modeStr}`);
  }
  console.log(`  ${hr}`);
}

function validateAllAliases(collections) {
  const unresolved = [];
  for (const col of collections) {
    const others = collections.filter(c => c !== col);
    for (const [varName, modeValues] of col.flat) {
      for (const [mode, { value }] of modeValues) {
        if (!isAlias(String(value))) continue;
        const resolved = resolveAlias(String(value), others);
        if (!resolved) {
          unresolved.push({ col: col.name, varName, mode, alias: value });
        }
      }
    }
  }
  return unresolved;
}

// ─── Init command ─────────────────────────────────────────────────────────────

function runInit() {
  if (existsSync(CONFIG_FILE)) {
    console.error('prisme.config.json already exists. Delete it first to re-initialize.');
    process.exit(1);
  }
  const tokenFiles = scanTokenDir();
  if (tokenFiles.length === 0) {
    console.error('No JSON files found in tokens/ — add your token files first.');
    process.exit(1);
  }
  const collections = {};
  for (const f of tokenFiles) collections[fileToCollectionName(f)] = f;
  const template = { collections, defaultSegment: 'Fremy' };
  writeFileSync(CONFIG_FILE, JSON.stringify(template, null, 2) + '\n', 'utf8');
  console.log(`\n✓ Created prisme.config.json`);
  console.log(`  ${tokenFiles.length} collections detected. Edit collection names and defaultSegment as needed.\n`);
  for (const [name, file] of Object.entries(collections)) {
    console.log(`    "${name}" ← ${file}`);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === 'init') {
    runInit();
    return;
  }

  const dryRun  = args.includes('--dry-run');
  const genCode = args.includes('--generate-plugin-code');
  const genIdx  = args.indexOf('--generate-plugin-code');

  const config        = loadConfig();
  const tokenFiles    = scanTokenDir();
  const plan          = buildPlan(config, tokenFiles);
  const defaultSeg    = config?.defaultSegment ?? 'Fremy';

  // Resolve target collection for code generation
  let targetColName = null;
  if (genCode) {
    const input = genIdx >= 0 ? args[genIdx + 1] : null;
    targetColName = resolveCollectionName(input, plan);
    if (!targetColName) {
      const available = plan.map(p => p.name).join(', ');
      console.error(`Unknown collection "${input}".\nAvailable: ${available}\nLegacy slugs: ${Object.keys(LEGACY_SLUG_MAP).join(', ')}`);
      process.exit(1);
    }
  }

  // Load and process all collections
  const collections = [];
  for (const { name, filename } of plan) {
    const filePath = resolve(TOKENS_DIR, filename);
    if (!existsSync(filePath)) {
      console.warn(`  ⚠ File not found: ${filename} (skipping "${name}")`);
      continue;
    }
    const raw   = JSON.parse(readFileSync(filePath, 'utf8'));
    const modes = detectModes(raw);
    const flat  = flattenGeneric(raw, modes);
    collections.push({ name, filename, modes, flat, deps: [] });
  }

  // Resolve deps for every collection
  for (const col of collections) col.deps = findDeps(col, collections);

  // ── Code generation mode ────────────────────────────────────────────────────
  if (genCode) {
    const col = collections.find(c => c.name === targetColName);
    if (!col) {
      console.error(`Collection "${targetColName}" could not be loaded.`);
      process.exit(1);
    }
    process.stdout.write(generateCollectionCode(col, defaultSeg) + '\n');
    return;
  }

  // ── Header ──────────────────────────────────────────────────────────────────
  console.log('Prisme Token Importer');
  console.log('━'.repeat(55));
  console.log(`Mode:            ${dryRun ? 'DRY RUN (no Figma changes)' : 'LIVE'}`);
  console.log(`Config:          ${config ? 'prisme.config.json' : 'none — auto-detected from tokens/'}`);
  console.log(`Default segment: ${defaultSeg}`);
  console.log(`Collections:     ${collections.length}`);

  // ── File mapping table ───────────────────────────────────────────────────────
  printFileMappingTable(collections);

  // ── Alias validation ─────────────────────────────────────────────────────────
  console.log('\nValidating aliases...');
  const unresolved = validateAllAliases(collections);
  if (unresolved.length === 0) {
    console.log('  ✓ All aliases resolve correctly');
  } else {
    console.warn(`  ⚠ ${unresolved.length} unresolved aliases:`);
    for (const u of unresolved) {
      console.warn(`    [${u.col}] ${u.varName} [${u.mode}] → ${u.alias}`);
    }
  }

  // ── Per-collection dry-run summary ───────────────────────────────────────────
  if (dryRun) {
    for (const col of collections) {
      const modeStr = col.modes.size > 0 ? [...col.modes].join(', ') : 'Value';
      console.log(`\n── ${col.name} ──────────────────────────────────────`);
      console.log(`  [DRY RUN] createCollection("${col.name}", modes=[${modeStr}])`);
      for (const [varName, modeValues] of col.flat) {
        const figType = getVarFigmaType(modeValues);
        console.log(`    [DRY RUN] createVariable("${varName}", type=${figType})`);
        for (const [mode, { value }] of modeValues) {
          const display = isAlias(String(value)) ? `alias(${value})` : String(value).slice(0, 40);
          console.log(`      [DRY RUN] setValue(mode=${mode}, value=${display})`);
        }
      }
      console.log(`  ✓ ${col.flat.size} variables`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n' + '━'.repeat(55));
  console.log('Summary');
  console.log('━'.repeat(55));
  for (const col of collections) {
    const modeStr = col.modes.size > 0
      ? `${col.modes.size} modes (${[...col.modes].join('/')})`
      : '1 mode (Value)';
    console.log(`  ${col.name.padEnd(20)} ${String(col.flat.size).padStart(3)} variables, ${modeStr}`);
  }
  const total = unresolved.length;
  console.log(total === 0
    ? '\n  ✓ All aliases resolved successfully'
    : `\n  ⚠ ${total} unresolved aliases (see above)`);

  if (dryRun) console.log('\n  [DRY RUN complete — no changes made to Figma]');
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
