/**
 * sanitize.js — Design token transformation script
 *
 * Usage:
 *   node src/sanitize.js --dry-run   Print summary without writing files
 *   node src/sanitize.js --apply     Write transformed files to tokens/
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TOKENS_DIR = join(__dirname, '..', 'tokens');

// ---------------------------------------------------------------------------
// Hex ↔ RGB ↔ HSL helpers
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return [r, g, b];
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  // h: 0-360, s: 0-100, l: 0-100
  return [h * 360, s * 100, l * 100];
}

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return [
    Math.round(f(0) * 255),
    Math.round(f(8) * 255),
    Math.round(f(4) * 255),
  ];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

// Normalise for comparison (strip alpha component for pure black/white check)
const SKIP_HEX = new Set(['#ffffff', '#000000']);

function transformHex(hex) {
  const normalized = hex.toLowerCase();
  // Strip optional alpha for skip check (we only have 6-digit hex in these files)
  if (SKIP_HEX.has(normalized)) return hex.toLowerCase();

  const [r, g, b] = hexToRgb(normalized);
  let [h, s, l] = rgbToHsl(r, g, b);

  h = (h + 15) % 360;
  l = Math.min(l + 5, 100);

  const [nr, ng, nb] = hslToRgb(h, s, l);
  return rgbToHex(nr, ng, nb);
}

// ---------------------------------------------------------------------------
// Alias value transformation
// ---------------------------------------------------------------------------

/**
 * Apply all alias path renames inside a "{...}" value string.
 * Returns the new string and a boolean indicating whether it changed.
 */
function transformAliasValue(value) {
  if (typeof value !== 'string') return [value, false];
  if (!value.startsWith('{') || !value.endsWith('}')) return [value, false];

  let inner = value.slice(1, -1);
  const original = inner;

  // Order: more specific patterns first to avoid double-renames.

  // Color family sub-key renames (handles legacy sub-path too)
  // warm.warm  →  stone.stone  (also warm.legacy.warm → stone.legacy.stone)
  inner = inner.replace(/\bwarm\.legacy\.warm/g, 'stone.legacy.stone');
  inner = inner.replace(/\bwarm\.warm/g, 'stone.stone');
  // warm top-level prefix (e.g. warm.warm800 already handled above; remaining warm. → stone.)
  inner = inner.replace(/\bwarm\./g, 'stone.');

  // coral.coral  →  petal.petal
  inner = inner.replace(/\bcoral\.legacy\.coral/g, 'petal.legacy.petal');
  inner = inner.replace(/\bcoral\.coral/g, 'petal.petal');
  inner = inner.replace(/\bcoral\./g, 'petal.');

  // orange.orange  →  amber.amber
  inner = inner.replace(/\borange\.legacy\.orange/g, 'amber.legacy.amber');
  inner = inner.replace(/\borange\.orange/g, 'amber.amber');
  inner = inner.replace(/\borange\./g, 'amber.');

  // green.green  →  sage.sage
  inner = inner.replace(/\bgreen\.legacy\.green/g, 'sage.legacy.sage');
  inner = inner.replace(/\bgreen\.green/g, 'sage.sage');
  inner = inner.replace(/\bgreen\./g, 'sage.');

  // indigo.indigo  →  iris.iris
  inner = inner.replace(/\bindigo\.indigo/g, 'iris.iris');
  inner = inner.replace(/\bindigo\./g, 'iris.');

  // peri.peri  →  dusk.dusk
  inner = inner.replace(/\bperi\.peri/g, 'dusk.dusk');
  inner = inner.replace(/\bperi\./g, 'dusk.');

  // cool.cool  →  mist.mist
  inner = inner.replace(/\bcool\.cool/g, 'mist.mist');
  inner = inner.replace(/\bcool\./g, 'mist.');

  // core.wired  →  core.slate
  inner = inner.replace(/\bcore\.wired/g, 'core.slate');

  // Segment group renames in paths
  inner = inner.replace(/\bneutral\./g, 'base.');
  inner = inner.replace(/\bbrand\./g, 'theme.');
  inner = inner.replace(/\bfargo\./g, 'canvas.');

  // Mode renames at the end of paths (suffix before closing "}")
  // These are suffixed as the last segment e.g. ".Crimson}" → ".Pewter}"
  inner = inner.replace(/\.Crimson$/, '.Pewter');
  inner = inner.replace(/\.Coral$/, '.Petal');
  inner = inner.replace(/\.Indigo$/, '.Iris');
  // .Ember stays as .Ember

  const changed = inner !== original;
  return [`{${inner}}`, changed];
}

// ---------------------------------------------------------------------------
// Key rename maps
// ---------------------------------------------------------------------------

// Top-level key renames for global.json (color families)
const GLOBAL_TOP_LEVEL_RENAMES = {
  warm: 'stone',
  cool: 'mist',
  coral: 'petal',
  orange: 'amber',
  indigo: 'iris',
  peri: 'dusk',
  green: 'sage',
  // "core" stays as "core"
};

// Sub-key prefix renames within each family in global.json
// Maps old prefix → new prefix (for keys like "warm010" → "stone010")
const GLOBAL_SUBKEY_RENAMES = {
  warm: 'stone',
  cool: 'mist',
  coral: 'petal',
  orange: 'amber',
  indigo: 'iris',
  peri: 'dusk',
  green: 'sage',
  // wired sub-keys inside core: handled separately
};

// Sub-key prefix renames inside the "core" group
const CORE_SUBKEY_RENAMES = {
  wired: 'slate',
};

// Top-level key renames for segment.json
const SEGMENT_TOP_LEVEL_RENAMES = {
  brand: 'theme',
  neutral: 'base',
  fargo: 'canvas',
};

// Top-level key renames for fusion.json
const FUSION_TOP_LEVEL_RENAMES = {
  'interactive-main': 'action',
};

// Mode key renames (used inside segment.json variables)
const MODE_RENAMES = {
  Crimson: 'Pewter',
  Coral: 'Petal',
  Indigo: 'Iris',
  // Ember stays
};

// ---------------------------------------------------------------------------
// Generic recursive helpers
// ---------------------------------------------------------------------------

/**
 * Deep-clone a plain JSON object.
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Rename a set of keys at a single object level (non-recursive).
 * Returns { renamed: newObj, count: numRenames }
 */
function renameKeys(obj, renameMap) {
  let count = 0;
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    const newKey = renameMap[key] !== undefined ? renameMap[key] : key;
    if (newKey !== key) count++;
    result[newKey] = val;
  }
  return { renamed: result, count };
}

// ---------------------------------------------------------------------------
// Statistics collectors
// ---------------------------------------------------------------------------

function makeStats() {
  return { hexTransforms: 0, keyRenames: 0, aliasUpdates: 0 };
}

// ---------------------------------------------------------------------------
// Transform global.json
// ---------------------------------------------------------------------------

function transformGlobal(data, stats, hexSamples) {
  let obj = deepClone(data);

  // 1. Rename top-level keys
  const topResult = renameKeys(obj, GLOBAL_TOP_LEVEL_RENAMES);
  stats.keyRenames += topResult.count;
  obj = topResult.renamed;

  // 2. For each family, rename sub-keys and transform hex values
  for (const [familyKey, familyVal] of Object.entries(obj)) {
    if (typeof familyVal !== 'object' || familyVal === null) continue;

    // Determine which sub-key rename map to use
    // familyKey is already the NEW name after top-level rename
    // We need to find the OLD prefix from the new family name
    const oldToNewFamily = Object.fromEntries(
      Object.entries(GLOBAL_TOP_LEVEL_RENAMES).map(([o, n]) => [n, o])
    );
    const oldFamilyName = oldToNewFamily[familyKey] || familyKey;
    const subKeyPrefix = GLOBAL_SUBKEY_RENAMES[oldFamilyName]; // new prefix for sub-keys

    const newFamily = {};
    for (const [subKey, subVal] of Object.entries(familyVal)) {
      let newSubKey = subKey;

      if (familyKey === 'core') {
        // Handle wiredNNN → slateNNN inside core
        for (const [oldPfx, newPfx] of Object.entries(CORE_SUBKEY_RENAMES)) {
          if (subKey.startsWith(oldPfx)) {
            newSubKey = newPfx + subKey.slice(oldPfx.length);
            stats.keyRenames++;
            break;
          }
        }
      } else if (subKeyPrefix) {
        // e.g. subKey "warm010" → "stone010"
        if (subKey.startsWith(oldFamilyName)) {
          newSubKey = subKeyPrefix + subKey.slice(oldFamilyName.length);
          stats.keyRenames++;
        }
      }

      // Handle nested "legacy" group
      if (subKey === 'legacy' && typeof subVal === 'object' && subVal !== null) {
        const newLegacy = {};
        for (const [legKey, legVal] of Object.entries(subVal)) {
          let newLegKey = legKey;
          if (subKeyPrefix && legKey.startsWith(oldFamilyName)) {
            newLegKey = subKeyPrefix + legKey.slice(oldFamilyName.length);
            stats.keyRenames++;
          }
          // Transform hex in legacy sub-entries
          newLegacy[newLegKey] = transformTokenValue(legVal, stats, hexSamples, true);
        }
        newFamily[newSubKey] = newLegacy;
        continue;
      }

      newFamily[newSubKey] = transformTokenValue(subVal, stats, hexSamples, true);
    }

    obj[familyKey] = newFamily;
  }

  return obj;
}

/**
 * Transform a single token object { value, type }.
 * applyHex: whether to attempt hex transformation on the value.
 */
function transformTokenValue(token, stats, hexSamples, applyHex) {
  if (typeof token !== 'object' || token === null) return token;

  const result = { ...token };

  if (typeof result.value === 'string') {
    if (applyHex && /^#[0-9a-fA-F]{6}$/.test(result.value)) {
      // It's a raw hex value
      const original = result.value;
      const transformed = transformHex(original);
      if (transformed.toLowerCase() !== original.toLowerCase()) {
        if (hexSamples.length < 5) {
          hexSamples.push({ original, transformed });
        }
        stats.hexTransforms++;
      }
      result.value = transformed;
    } else if (result.value.startsWith('{')) {
      // It's an alias reference
      const [newVal, changed] = transformAliasValue(result.value);
      if (changed) {
        stats.aliasUpdates++;
        result.value = newVal;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Transform segment.json
// ---------------------------------------------------------------------------

function transformSegment(data, stats) {
  let obj = deepClone(data);

  // 1. Rename top-level group keys
  const topResult = renameKeys(obj, SEGMENT_TOP_LEVEL_RENAMES);
  stats.keyRenames += topResult.count;
  obj = topResult.renamed;

  // 2. Recurse through the structure renaming mode keys and updating aliases
  obj = renameModesAndAliases(obj, stats);

  // 3. Apply specific value overrides (after all renames)
  //    theme.primary700.Pewter / theme.primary600.Pewter / theme.primary500.Pewter
  const overrides = {
    primary700: { Pewter: { value: '{stone.stone700}', type: 'color' } },
    primary600: { Pewter: { value: '{stone.stone600}', type: 'color' } },
    primary500: { Pewter: { value: '{stone.stone500}', type: 'color' } },
  };

  if (obj.theme) {
    for (const [tokenName, modeOverrides] of Object.entries(overrides)) {
      if (obj.theme[tokenName]) {
        for (const [mode, value] of Object.entries(modeOverrides)) {
          obj.theme[tokenName][mode] = value;
          // Count as alias update since we're injecting an alias reference
          stats.aliasUpdates++;
        }
      }
    }
  }

  return obj;
}

/**
 * Recursively walk a segment.json object:
 *  - Rename mode keys (Crimson→Pewter, Coral→Petal, Indigo→Iris) at the leaf level
 *  - Update alias values
 *
 * "Leaf level" is detected when all values are { value, type } objects
 * (i.e. the current object's values have a "value" property).
 */
function renameModesAndAliases(obj, stats) {
  if (typeof obj !== 'object' || obj === null) return obj;

  // Check if the direct children look like mode-keyed token objects
  // (i.e. values are { value: "...", type: "..." })
  const childVals = Object.values(obj);
  const isModeLevel = childVals.length > 0 && childVals.every(
    v => typeof v === 'object' && v !== null && 'value' in v && 'type' in v
  );

  if (isModeLevel) {
    // Rename mode keys and update alias values
    const result = {};
    for (const [key, val] of Object.entries(obj)) {
      const newKey = MODE_RENAMES[key] !== undefined ? MODE_RENAMES[key] : key;
      if (newKey !== key) stats.keyRenames++;

      // Update alias in the value
      const [newAliasVal, aliasChanged] = transformAliasValue(val.value);
      if (aliasChanged) stats.aliasUpdates++;

      result[newKey] = { ...val, value: newAliasVal };
    }
    return result;
  }

  // Otherwise recurse
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    result[key] = renameModesAndAliases(val, stats);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Transform fusion.json
// ---------------------------------------------------------------------------

function transformFusion(data, stats) {
  let obj = deepClone(data);

  // 1. Rename top-level keys
  const topResult = renameKeys(obj, FUSION_TOP_LEVEL_RENAMES);
  stats.keyRenames += topResult.count;
  obj = topResult.renamed;

  // 2. Recursively update alias values throughout
  obj = updateAliasesDeep(obj, stats);

  return obj;
}

/**
 * Recursively walk any object and update alias values in { value, type } tokens.
 */
function updateAliasesDeep(obj, stats) {
  if (typeof obj !== 'object' || obj === null) return obj;

  // If it looks like a token { value, type }, transform the value
  if ('value' in obj && 'type' in obj) {
    const [newVal, changed] = transformAliasValue(obj.value);
    if (changed) {
      stats.aliasUpdates++;
      return { ...obj, value: newVal };
    }
    return obj;
  }

  // Otherwise recurse into children
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    result[key] = updateAliasesDeep(val, stats);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`
Usage:
  node src/sanitize.js --dry-run   Simulate transformation, print summary
  node src/sanitize.js --apply     Write transformed files to tokens/
`.trim());
}

function loadTokens() {
  const globalData = JSON.parse(readFileSync(join(TOKENS_DIR, 'global.json'), 'utf8'));
  const segmentData = JSON.parse(readFileSync(join(TOKENS_DIR, 'segment.json'), 'utf8'));
  const fusionData = JSON.parse(readFileSync(join(TOKENS_DIR, 'fusion.json'), 'utf8'));
  return { globalData, segmentData, fusionData };
}

function runTransforms() {
  const { globalData, segmentData, fusionData } = loadTokens();

  const hexSamples = [];
  const globalStats = makeStats();
  const segmentStats = makeStats();
  const fusionStats = makeStats();

  const newGlobal = transformGlobal(globalData, globalStats, hexSamples);
  const newSegment = transformSegment(segmentData, segmentStats);
  const newFusion = transformFusion(fusionData, fusionStats);

  return {
    newGlobal, newSegment, newFusion,
    hexSamples,
    globalStats, segmentStats, fusionStats,
  };
}

function main() {
  const args = process.argv.slice(2);
  const flag = args[0];

  if (flag === '--dry-run') {
    const {
      newGlobal, newSegment, newFusion,
      hexSamples,
      globalStats, segmentStats, fusionStats,
    } = runTransforms();

    console.log('\n=== DRY RUN SUMMARY ===\n');

    console.log('--- Hex colour samples (global.json) ---');
    if (hexSamples.length === 0) {
      console.log('  (none)');
    } else {
      for (const { original, transformed } of hexSamples) {
        console.log(`  ${original}  →  ${transformed}`);
      }
    }

    console.log(`\nHex values transformed  : ${globalStats.hexTransforms}`);

    console.log('\n--- Key renames per file ---');
    console.log(`  global.json   : ${globalStats.keyRenames}`);
    console.log(`  segment.json  : ${segmentStats.keyRenames}`);
    console.log(`  fusion.json   : ${fusionStats.keyRenames}`);

    console.log('\n--- Alias references updated per file ---');
    console.log(`  global.json   : ${globalStats.aliasUpdates}`);
    console.log(`  segment.json  : ${segmentStats.aliasUpdates}`);
    console.log(`  fusion.json   : ${fusionStats.aliasUpdates}`);

    console.log('\n=== Transformed global.json ===\n');
    console.log(JSON.stringify(newGlobal, null, 2));

    console.log('\n=== Transformed segment.json ===\n');
    console.log(JSON.stringify(newSegment, null, 2));

    console.log('\n=== Transformed fusion.json ===\n');
    console.log(JSON.stringify(newFusion, null, 2));

  } else if (flag === '--apply') {
    const {
      newGlobal, newSegment, newFusion,
      globalStats, segmentStats, fusionStats,
    } = runTransforms();

    writeFileSync(join(TOKENS_DIR, 'global.json'), JSON.stringify(newGlobal, null, 2) + '\n', 'utf8');
    writeFileSync(join(TOKENS_DIR, 'segment.json'), JSON.stringify(newSegment, null, 2) + '\n', 'utf8');
    writeFileSync(join(TOKENS_DIR, 'fusion.json'), JSON.stringify(newFusion, null, 2) + '\n', 'utf8');

    const totalHex = globalStats.hexTransforms;
    const totalKeys = globalStats.keyRenames + segmentStats.keyRenames + fusionStats.keyRenames;
    const totalAliases = globalStats.aliasUpdates + segmentStats.aliasUpdates + fusionStats.aliasUpdates;

    console.log(`Applied: ${totalHex} hex transforms, ${totalKeys} key renames, ${totalAliases} alias updates`);

  } else {
    printUsage();
  }
}

main();
