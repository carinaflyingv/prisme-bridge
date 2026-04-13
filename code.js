// Prisme Bridge — Figma Plugin
// Bidirectional Token Studio JSON ↔ Figma variable collections

figma.showUI(__html__, { width: 320, height: 480, title: 'Prisme Bridge' });

// ─── Constants ────────────────────────────────────────────────────────────────

const SEGMENT_MODES = new Set(['Beans', 'Fremy', 'BMO', 'Mr. Tibbs']);
const FUSION_MODES  = new Set(['light', 'dark']);

// ─── Utility helpers ──────────────────────────────────────────────────────────

function hexToRGB(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

function rgbaToHex({ r, g, b }) {
  const h = n => Math.round(n * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function isAlias(value) {
  return typeof value === 'string' && value.startsWith('{') && value.endsWith('}');
}

function isAliasVal(val) {
  return val !== null && typeof val === 'object' && typeof val.alias === 'string';
}

function parseAlias(aliasValue) {
  const raw   = aliasValue.replace(/^\{/, '').replace(/\}$/, '');
  const parts = raw.split('.');
  const last  = parts[parts.length - 1];
  if (SEGMENT_MODES.has(last)) {
    return { variableName: parts.slice(0, -1).join('/'), mode: last };
  }
  return { variableName: parts.join('/'), mode: null };
}

function parseSimpleAlias(aliasValue) {
  return aliasValue.replace(/^\{|\}$/g, '').replace(/\./g, '/');
}

function parseNumericValue(raw) {
  return parseFloat(String(raw).replace(/px$/i, '').trim());
}

function getFigmaType(tokenType) {
  if (tokenType === 'color') return 'COLOR';
  if (tokenType === 'fontFamilies' || tokenType === 'string') return 'STRING';
  return 'FLOAT';
}

function toTsAlias(figmaName) {
  return '{' + figmaName.replace(/\//g, '.') + '}';
}

function fmtNumber(n) {
  return String(Number.isInteger(n) ? n : parseFloat(n.toFixed(4)));
}

function setPath(obj, parts, value) {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]]) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(level, text) {
  figma.ui.postMessage({ type: 'log', level, text });
}

// ─── Flattening — Token Studio JSON → Map ─────────────────────────────────────

function flattenTokens(obj, stopKeys, pathParts, result) {
  if (!result) result = new Map();
  if (!pathParts) pathParts = [];

  if (obj && typeof obj.value !== 'undefined' && obj.type) {
    const name = pathParts.join('/');
    if (!result.has(name)) result.set(name, new Map());
    result.get(name).set('default', obj.value);
    return result;
  }

  for (const [key, val] of Object.entries(obj)) {
    if (stopKeys.has(key)) {
      const name = pathParts.join('/');
      if (!name) continue;
      if (val && typeof val.value !== 'undefined') {
        if (!result.has(name)) result.set(name, new Map());
        result.get(name).set(key, val.value);
      }
    } else if (val && typeof val.value !== 'undefined' && val.type) {
      const name = [...pathParts, key].join('/');
      if (!result.has(name)) result.set(name, new Map());
      result.get(name).set('default', val.value);
    } else if (val && typeof val === 'object') {
      flattenTokens(val, stopKeys, [...pathParts, key], result);
    }
  }
  return result;
}

function flattenGlobal(obj)  { return flattenTokens(obj, new Set(), [], new Map()); }
function flattenSegment(obj) { return flattenTokens(obj, SEGMENT_MODES, [], new Map()); }
function flattenFusion(obj)  { return flattenTokens(obj, FUSION_MODES, [], new Map()); }

function flattenSimple(obj, pathParts, result) {
  if (!result) result = new Map();
  if (!pathParts) pathParts = [];

  if (obj && typeof obj.value !== 'undefined' && obj.type !== undefined) {
    result.set(pathParts.join('/'), { value: obj.value, type: obj.type });
    return result;
  }
  for (const [key, val] of Object.entries(obj)) {
    if (val && typeof val === 'object') {
      flattenSimple(val, [...pathParts, key], result);
    }
  }
  return result;
}

// ─── Import: Global ───────────────────────────────────────────────────────────

async function importGlobal(flat) {
  for (const c of await figma.variables.getLocalVariableCollectionsAsync()) {
    if (c.name === 'Global') c.remove();
  }
  const col = figma.variables.createVariableCollection('Global');
  col.renameMode(col.defaultModeId, 'Value');
  const mid    = col.defaultModeId;
  const varMap = new Map();
  let errors   = 0;

  for (const [varName, modes] of flat) {
    try {
      const v = figma.variables.createVariable(varName, col, 'COLOR');
      varMap.set(varName, v);
      v.setValueForMode(mid, hexToRGB(modes.get('default')));
    } catch (e) {
      errors++;
    }
  }

  if (errors) log('warn', `⚠ Global: ${errors} variables had errors`);
  log('info', `✓ Global: ${flat.size} variables created`);
  return varMap;
}

// ─── Import: Segment ──────────────────────────────────────────────────────────

async function importSegment(flat) {
  for (const c of await figma.variables.getLocalVariableCollectionsAsync()) {
    if (c.name === 'Segment') c.remove();
  }

  // Resolve Global variables (may have been imported in same batch or prior session)
  const gVars = new Map();
  const cols  = await figma.variables.getLocalVariableCollectionsAsync();
  const gCol  = cols.find(c => c.name === 'Global');
  if (gCol) {
    for (const v of await figma.variables.getLocalVariablesAsync('COLOR')) {
      if (v.variableCollectionId === gCol.id) gVars.set(v.name, v);
    }
  }

  const col  = figma.variables.createVariableCollection('Segment');
  col.renameMode(col.defaultModeId, 'Beans');
  const mids = {
    Beans:       col.defaultModeId,
    Fremy:       col.addMode('Fremy'),
    BMO:         col.addMode('BMO'),
    'Mr. Tibbs': col.addMode('Mr. Tibbs'),
  };

  const unresolved = [];

  for (const [varName, modes] of flat) {
    const v = figma.variables.createVariable(varName, col, 'COLOR');
    for (const mode of ['Beans', 'Fremy', 'BMO', 'Mr. Tibbs']) {
      const value = modes.get(mode);
      if (value === undefined) continue;
      if (isAlias(value)) {
        const { variableName: targetName } = parseAlias(value);
        const target = gVars.get(targetName);
        if (target) {
          v.setValueForMode(mids[mode], figma.variables.createVariableAlias(target));
        } else {
          unresolved.push(`${varName}/${mode} → ${value}`);
        }
      } else {
        v.setValueForMode(mids[mode], hexToRGB(value));
      }
    }
  }

  if (unresolved.length) {
    log('warn', `⚠ Segment: ${unresolved.length} unresolved aliases (Global collection missing?)`);
  }
  log('info', `✓ Segment: ${flat.size} variables created`);
  return { unresolved };
}

// ─── Import: Prisme ───────────────────────────────────────────────────────────

async function importPrisme(flat) {
  for (const c of await figma.variables.getLocalVariableCollectionsAsync()) {
    if (c.name === 'Prisme' || c.name === 'Fusion') c.remove();
  }

  const sVars = new Map();
  const cols  = await figma.variables.getLocalVariableCollectionsAsync();
  const sCol  = cols.find(c => c.name === 'Segment');
  if (sCol) {
    for (const v of await figma.variables.getLocalVariablesAsync('COLOR')) {
      if (v.variableCollectionId === sCol.id) sVars.set(v.name, v);
    }
  }

  const col  = figma.variables.createVariableCollection('Prisme');
  col.renameMode(col.defaultModeId, 'light');
  const mids = {
    light: col.defaultModeId,
    dark:  col.addMode('dark'),
  };

  const unresolved = [];

  for (const [varName, modes] of flat) {
    const v = figma.variables.createVariable(varName, col, 'COLOR');
    for (const mode of ['light', 'dark']) {
      const value = modes.get(mode);
      if (value === undefined) continue;
      if (isAlias(value)) {
        const { variableName: targetName } = parseAlias(value);
        const target = sVars.get(targetName);
        if (target) {
          v.setValueForMode(mids[mode], figma.variables.createVariableAlias(target));
        } else {
          unresolved.push(`${varName}/${mode} → ${value}`);
        }
      } else {
        v.setValueForMode(mids[mode], hexToRGB(value));
      }
    }
  }

  if (unresolved.length) {
    log('warn', `⚠ Prisme: ${unresolved.length} unresolved aliases (Segment collection missing?)`);
  }
  log('info', `✓ Prisme: ${flat.size} variables created`);
  return { unresolved };
}

// ─── Import: Spacing ──────────────────────────────────────────────────────────

async function importSpacing(flat) {
  for (const c of await figma.variables.getLocalVariableCollectionsAsync()) {
    if (c.name === 'Spacing') c.remove();
  }
  const col    = figma.variables.createVariableCollection('Spacing');
  col.renameMode(col.defaultModeId, 'Value');
  const mid    = col.defaultModeId;
  const varMap = new Map();

  for (const [name, { value }] of flat) {
    const v = figma.variables.createVariable(name, col, 'FLOAT');
    v.setValueForMode(mid, parseNumericValue(value));
    varMap.set(name, v);
  }

  log('info', `✓ Spacing: ${flat.size} variables created`);
  return varMap;
}

// ─── Import: Radius ───────────────────────────────────────────────────────────

async function importRadius(flat, spacingVarMap) {
  for (const c of await figma.variables.getLocalVariableCollectionsAsync()) {
    if (c.name === 'Radius') c.remove();
  }

  // Fall back to looking up existing Spacing collection
  if (!spacingVarMap || spacingVarMap.size === 0) {
    spacingVarMap = new Map();
    const cols  = await figma.variables.getLocalVariableCollectionsAsync();
    const spCol = cols.find(c => c.name === 'Spacing');
    if (spCol) {
      for (const v of await figma.variables.getLocalVariablesAsync('FLOAT')) {
        if (v.variableCollectionId === spCol.id) spacingVarMap.set(v.name, v);
      }
    }
  }

  const col        = figma.variables.createVariableCollection('Radius');
  col.renameMode(col.defaultModeId, 'Value');
  const mid        = col.defaultModeId;
  const unresolved = [];

  for (const [name, { value }] of flat) {
    const v = figma.variables.createVariable(name, col, 'FLOAT');
    if (isAlias(String(value))) {
      const targetName = parseSimpleAlias(String(value));
      const target     = spacingVarMap.get(targetName);
      if (target) {
        v.setValueForMode(mid, figma.variables.createVariableAlias(target));
      } else {
        unresolved.push(`${name} → ${value}`);
        v.setValueForMode(mid, 0);
      }
    } else {
      v.setValueForMode(mid, parseNumericValue(value));
    }
  }

  if (unresolved.length) {
    log('warn', `⚠ Radius: ${unresolved.length} unresolved aliases (Spacing collection missing?)`);
  }
  log('info', `✓ Radius: ${flat.size} variables created`);
}

// ─── Import: Type Global ──────────────────────────────────────────────────────

async function importTypeGlobal(flat) {
  for (const c of await figma.variables.getLocalVariableCollectionsAsync()) {
    if (c.name === 'Type Global') c.remove();
  }
  const col    = figma.variables.createVariableCollection('Type Global');
  col.renameMode(col.defaultModeId, 'Value');
  const mid    = col.defaultModeId;
  const varMap = new Map();

  for (const [name, { value, type }] of flat) {
    const figType = getFigmaType(type);
    const v       = figma.variables.createVariable(name, col, figType);
    if (figType === 'FLOAT') {
      v.setValueForMode(mid, parseNumericValue(value));
    } else {
      v.setValueForMode(mid, String(value));
    }
    varMap.set(name, v);
  }

  log('info', `✓ Type Global: ${flat.size} variables created`);
  return varMap;
}

// ─── Import: Type Fusion ──────────────────────────────────────────────────────

async function importTypeFusion(flat, typeGlobalVarMap) {
  for (const c of await figma.variables.getLocalVariableCollectionsAsync()) {
    if (c.name === 'Type Fusion') c.remove();
  }

  if (!typeGlobalVarMap || typeGlobalVarMap.size === 0) {
    typeGlobalVarMap = new Map();
    const cols  = await figma.variables.getLocalVariableCollectionsAsync();
    const tgCol = cols.find(c => c.name === 'Type Global');
    if (tgCol) {
      for (const v of await figma.variables.getLocalVariablesAsync('FLOAT')) {
        if (v.variableCollectionId === tgCol.id) typeGlobalVarMap.set(v.name, v);
      }
    }
  }

  const col        = figma.variables.createVariableCollection('Type Fusion');
  col.renameMode(col.defaultModeId, 'Value');
  const mid        = col.defaultModeId;
  const unresolved = [];

  for (const [name, { value }] of flat) {
    const v = figma.variables.createVariable(name, col, 'FLOAT');
    if (isAlias(String(value))) {
      const targetName = parseSimpleAlias(String(value));
      const target     = typeGlobalVarMap.get(targetName);
      if (target) {
        v.setValueForMode(mid, figma.variables.createVariableAlias(target));
      } else {
        unresolved.push(`${name} → ${value}`);
        v.setValueForMode(mid, 0);
      }
    } else {
      v.setValueForMode(mid, parseNumericValue(value));
    }
  }

  if (unresolved.length) {
    log('warn', `⚠ Type Fusion: ${unresolved.length} unresolved aliases (Type Global collection missing?)`);
  }
  log('info', `✓ Type Fusion: ${flat.size} variables created`);
}

// ─── Export: Read collection from Figma ───────────────────────────────────────

async function readCollectionData(colName) {
  const allVars = await figma.variables.getLocalVariablesAsync();
  const varById = {};
  for (const v of allVars) varById[v.id] = v.name;

  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const col  = cols.find(c => c.name === colName);
  if (!col) return null;

  const vars = allVars.filter(v => v.variableCollectionId === col.id);
  return {
    modes: col.modes.map(m => ({ id: m.modeId, name: m.name })),
    variables: vars.map(v => ({
      name: v.name,
      type: v.resolvedType,
      valuesByMode: Object.fromEntries(
        col.modes.map(m => {
          const val = v.valuesByMode[m.modeId];
          if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS') {
            return [m.name, { alias: varById[val.id] || val.id }];
          }
          return [m.name, val];
        })
      ),
    })),
  };
}

// ─── Export: Converters ───────────────────────────────────────────────────────

function convertGlobal(colData) {
  const out = {};
  for (const v of colData.variables) {
    const val = Object.values(v.valuesByMode)[0];
    if (val == null) continue;
    const entry = isAliasVal(val)
      ? { value: toTsAlias(val.alias), type: 'color' }
      : { value: rgbaToHex(val), type: 'color' };
    setPath(out, v.name.split('/'), entry);
  }
  return out;
}

function convertSegment(colData) {
  const out = {};
  for (const v of colData.variables) {
    for (const [mode, val] of Object.entries(v.valuesByMode)) {
      if (val == null) continue;
      const entry = isAliasVal(val)
        ? { value: toTsAlias(val.alias), type: 'color' }
        : { value: rgbaToHex(val), type: 'color' };
      setPath(out, [...v.name.split('/'), mode], entry);
    }
  }
  return out;
}

function convertPrisme(colData, defaultSegment) {
  const out = {};
  for (const v of colData.variables) {
    for (const [mode, val] of Object.entries(v.valuesByMode)) {
      if (val == null) continue;
      let entry;
      if (isAliasVal(val)) {
        const aliasPath = val.alias.replace(/\//g, '.') + '.' + defaultSegment;
        entry = { value: '{' + aliasPath + '}', type: 'color' };
      } else {
        entry = { value: rgbaToHex(val), type: 'color' };
      }
      setPath(out, [...v.name.split('/'), mode], entry);
    }
  }
  return out;
}

function convertSpacingLike(colData) {
  const out = {};
  for (const v of colData.variables) {
    const val = Object.values(v.valuesByMode)[0];
    if (val == null) continue;
    const entry = isAliasVal(val)
      ? { value: toTsAlias(val.alias), type: 'spacing' }
      : { value: fmtNumber(val), type: 'spacing' };
    setPath(out, v.name.split('/'), entry);
  }
  return out;
}

function convertTypeGlobal(colData) {
  const out = {};
  for (const v of colData.variables) {
    const val = Object.values(v.valuesByMode)[0];
    if (val == null) continue;
    let entry;
    if (v.name.startsWith('font/size')) {
      entry = isAliasVal(val)
        ? { value: toTsAlias(val.alias), type: 'fontSizes' }
        : { value: `${fmtNumber(val)}px`, type: 'fontSizes' };
    } else if (v.name.startsWith('font/weight')) {
      entry = isAliasVal(val)
        ? { value: toTsAlias(val.alias), type: 'fontWeights' }
        : { value: String(Math.round(val)), type: 'fontWeights' };
    } else {
      entry = isAliasVal(val)
        ? { value: toTsAlias(val.alias), type: 'fontFamilies' }
        : { value: String(val), type: 'fontFamilies' };
    }
    setPath(out, v.name.split('/'), entry);
  }
  return out;
}

function convertTypeFusion(colData) {
  const out = {};
  for (const v of colData.variables) {
    const val = Object.values(v.valuesByMode)[0];
    if (val == null) continue;
    const entry = isAliasVal(val)
      ? { value: toTsAlias(val.alias), type: 'fontSizes' }
      : { value: `${fmtNumber(val)}px`, type: 'fontSizes' };
    setPath(out, v.name.split('/'), entry);
  }
  return out;
}

// ─── Message handler ──────────────────────────────────────────────────────────

figma.ui.onmessage = async function(msg) {
  try {
    // ── IMPORT ──────────────────────────────────────────────────────────────
    if (msg.type === 'import') {
      const { collections, files } = msg;
      let totalVars = 0;
      let spacingVarMap     = null;
      let typeGlobalVarMap  = null;

      const ORDER = ['global', 'segment', 'prisme', 'spacing', 'radius', 'typeGlobal', 'typeFusion'];

      for (const key of ORDER) {
        if (!collections.includes(key)) continue;
        const jsonStr = files[key];
        if (!jsonStr) {
          log('warn', `⚠ No file loaded for ${key} — skipping`);
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(jsonStr);
        } catch (e) {
          log('error', `✕ ${key}: malformed JSON — ${e.message}`);
          continue;
        }

        try {
          if (key === 'global') {
            const flat = flattenGlobal(parsed);
            await importGlobal(flat);
            totalVars += flat.size;
          } else if (key === 'segment') {
            const flat = flattenSegment(parsed);
            await importSegment(flat);
            totalVars += flat.size;
          } else if (key === 'prisme') {
            const flat = flattenFusion(parsed);
            await importPrisme(flat);
            totalVars += flat.size;
          } else if (key === 'spacing') {
            const flat = flattenSimple(parsed);
            spacingVarMap = await importSpacing(flat);
            totalVars += flat.size;
          } else if (key === 'radius') {
            const flat = flattenSimple(parsed);
            await importRadius(flat, spacingVarMap);
            totalVars += flat.size;
          } else if (key === 'typeGlobal') {
            const flat = flattenSimple(parsed);
            typeGlobalVarMap = await importTypeGlobal(flat);
            totalVars += flat.size;
          } else if (key === 'typeFusion') {
            const flat = flattenSimple(parsed);
            await importTypeFusion(flat, typeGlobalVarMap);
            totalVars += flat.size;
          }
        } catch (e) {
          log('error', `✕ ${key}: ${e.message}`);
        }
      }

      figma.ui.postMessage({
        type: 'done',
        text: `Import complete — ${totalVars} variables across ${collections.length} collection(s)`,
      });
    }

    // ── EXPORT ──────────────────────────────────────────────────────────────
    else if (msg.type === 'export') {
      const { collections, segment } = msg;
      const defaultSegment = segment || 'Fremy';

      const COL_MAP = {
        global:     { figmaName: 'Global',      fileName: 'global.json',      convert: d => convertGlobal(d) },
        segment:    { figmaName: 'Segment',      fileName: 'segment.json',     convert: d => convertSegment(d) },
        prisme:     { figmaName: 'Prisme',       fileName: 'fusion.json',      convert: d => convertPrisme(d, defaultSegment) },
        spacing:    { figmaName: 'Spacing',      fileName: 'spacing.json',     convert: d => convertSpacingLike(d) },
        radius:     { figmaName: 'Radius',       fileName: 'radius.json',      convert: d => convertSpacingLike(d) },
        typeGlobal: { figmaName: 'Type Global',  fileName: 'type-global.json', convert: d => convertTypeGlobal(d) },
        typeFusion: { figmaName: 'Type Fusion',  fileName: 'type-fusion.json', convert: d => convertTypeFusion(d) },
      };

      const exportedFiles = {};
      let totalVars  = 0;
      let fileCount  = 0;

      for (const key of collections) {
        const map = COL_MAP[key];
        if (!map) continue;

        const colData = await readCollectionData(map.figmaName);
        if (!colData) {
          log('warn', `⚠ "${map.figmaName}" collection not found in this file`);
          continue;
        }

        let tsJson;
        try {
          tsJson = map.convert(colData);
        } catch (e) {
          log('error', `✕ ${map.figmaName}: ${e.message}`);
          continue;
        }

        const count = colData.variables.length;
        totalVars  += count;
        fileCount++;
        exportedFiles[map.fileName] = JSON.stringify(tsJson, null, 2);
        log('info', `✓ ${map.figmaName}: ${count} vars → ${map.fileName}`);
      }

      figma.ui.postMessage({ type: 'export-result', files: exportedFiles });
      figma.ui.postMessage({
        type: 'done',
        text: `Export complete — ${totalVars} variables across ${fileCount} file(s)`,
      });
    }

    // ── EXPORT SINGLE ───────────────────────────────────────────────────────
    else if (msg.type === 'export-single') {
      const { key, segment } = msg;
      const defaultSegment = segment || 'Fremy';

      const COL_MAP = {
        global:     { figmaName: 'Global',      fileName: 'global.json',      convert: d => convertGlobal(d) },
        segment:    { figmaName: 'Segment',      fileName: 'segment.json',     convert: d => convertSegment(d) },
        prisme:     { figmaName: 'Prisme',       fileName: 'fusion.json',      convert: d => convertPrisme(d, defaultSegment) },
        spacing:    { figmaName: 'Spacing',      fileName: 'spacing.json',     convert: d => convertSpacingLike(d) },
        radius:     { figmaName: 'Radius',       fileName: 'radius.json',      convert: d => convertSpacingLike(d) },
        typeGlobal: { figmaName: 'Type Global',  fileName: 'type-global.json', convert: d => convertTypeGlobal(d) },
        typeFusion: { figmaName: 'Type Fusion',  fileName: 'type-fusion.json', convert: d => convertTypeFusion(d) },
      };

      const map = COL_MAP[key];
      if (!map) {
        figma.ui.postMessage({ type: 'export-single-result', key, error: `Unknown collection key: ${key}` });
        return;
      }

      const colData = await readCollectionData(map.figmaName);
      if (!colData) {
        figma.ui.postMessage({ type: 'export-single-result', key, error: `"${map.figmaName}" collection not found in this file` });
        return;
      }

      let tsJson;
      try {
        tsJson = map.convert(colData);
      } catch (e) {
        figma.ui.postMessage({ type: 'export-single-result', key, error: e.message });
        return;
      }

      figma.ui.postMessage({
        type: 'export-single-result',
        key,
        fileName: map.fileName,
        content:  JSON.stringify(tsJson, null, 2),
        varCount: colData.variables.length,
      });
    }

    // ── CLOSE ───────────────────────────────────────────────────────────────
    else if (msg.type === 'close') {
      figma.closePlugin();
    }

  } catch (err) {
    log('error', `Unexpected error: ${err.message}`);
    figma.ui.postMessage({ type: 'done', text: `Error: ${err.message}` });
  }
};
