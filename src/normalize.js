/**
 * Token Scale Normalizer
 *
 * Applies the standard numeric suffix convention to global.json
 * and updates all alias references in segment.json.
 *
 * Scale mapping:
 *   010 → 25
 *   050 → 75
 *   915 → merge into 900 (delete key, refs → 900)
 *   935 → merge into 950 (delete key, refs → 950)
 *
 * Usage:
 *   node src/normalize.js --dry-run
 *   node src/normalize.js --apply
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const tokensDir = resolve(root, 'tokens');

function load(f) { return JSON.parse(readFileSync(resolve(tokensDir, f), 'utf8')); }
function save(f, obj) { writeFileSync(resolve(tokensDir, f), JSON.stringify(obj, null, 2) + '\n'); }

// ─── Scale rules ──────────────────────────────────────────────────────────────

// Direct renames: old suffix → new suffix (key is renamed)
const RENAME_SUFFIX = {
  '010': '25',
  '050': '75',
};

// Merges: key with this suffix is DELETED; all refs pointing to it
// should instead point to the merge target suffix.
const MERGE_SUFFIX = {
  '915': '900',
  '935': '950',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Walk global.json and rename/merge keys based on scale rules.
 * Returns { newObj, renames: [{from, to}], merges: [{deleted, target}] }
 * Each call returns its OWN renames/merges (no shared closure state).
 */
function walkGroup(group, familyName) {
  const out = {};
  const renames = [];
  const merges  = [];

  for (const [k, v] of Object.entries(group)) {
    // Detect numeric suffix
    const m = k.match(/^([a-z]+)(\d{2,4})$/i);
    if (m) {
      const [, prefix, suffix] = m;
      if (RENAME_SUFFIX[suffix]) {
        const newKey = prefix + RENAME_SUFFIX[suffix];
        renames.push({ from: `${familyName}/${k}`, to: `${familyName}/${newKey}` });
        out[newKey] = v;
        continue;
      }
      if (MERGE_SUFFIX[suffix]) {
        const targetSuffix = MERGE_SUFFIX[suffix];
        merges.push({
          deleted: `${familyName}/${k}`,
          target:  `${familyName}/${prefix}${targetSuffix}`,
        });
        // Skip — don't add this key to output (it merges into target)
        continue;
      }
    }
    // Recurse into sub-groups (e.g. legacy)
    if (v && typeof v === 'object' && !('value' in v)) {
      const sub = walkGroup(v, `${familyName}/${k}`);
      renames.push(...sub.renames);
      merges.push(...sub.merges);
      out[k] = sub.newObj;
    } else {
      out[k] = v;
    }
  }
  return { newObj: out, renames, merges };
}

function normalizeGlobal(obj) {
  const allRenames = [];
  const allMerges  = [];
  const newObj = {};

  for (const [family, group] of Object.entries(obj)) {
    if (group && typeof group === 'object' && !('value' in group)) {
      const { newObj: out, renames, merges } = walkGroup(group, family);
      allRenames.push(...renames);
      allMerges.push(...merges);
      newObj[family] = out;
    } else {
      newObj[family] = group;
    }
  }

  return { newObj, renames: allRenames, merges: allMerges };
}

/**
 * Update alias references in a JSON file (segment or fusion).
 * Returns { newObj, changes: [{from, to, count}] }
 */
function updateAliasRefs(obj, renames, merges) {
  // Build a flat string-replacement map:
  // For renames: {family.oldKey} → {family.newKey}
  // For merges:  {family.deletedKey} → {family.targetKey}
  const replacements = new Map();

  for (const { from, to } of renames) {
    // global key "stone/stone010" → alias path "stone.stone010"
    const fromAlias = '{' + from.replace(/\//g, '.') + '}';
    const toAlias   = '{' + to.replace(/\//g, '.') + '}';
    replacements.set(fromAlias, toAlias);
  }
  for (const { deleted, target } of merges) {
    const fromAlias = '{' + deleted.replace(/\//g, '.') + '}';
    const toAlias   = '{' + target.replace(/\//g, '.') + '}';
    replacements.set(fromAlias, toAlias);
  }

  const changes = [];
  let totalCount = 0;

  function walkAndReplace(node) {
    if (!node || typeof node !== 'object') return node;
    if ('value' in node) {
      let v = node.value;
      for (const [from, to] of replacements) {
        // Also handle alias paths with a mode suffix: {stone.stone010.Pewter}
        // The base alias {stone.stone010} → {stone.stone25}
        // so {stone.stone010.Pewter} → {stone.stone25.Pewter}
        const withSuffixFrom = from.slice(0, -1); // strip closing }
        const withSuffixTo   = to.slice(0, -1);
        if (typeof v === 'string') {
          if (v === from) {
            changes.push({ from, to, key: 'exact' });
            totalCount++;
            v = to;
          } else if (v.startsWith(withSuffixFrom + '.')) {
            const newV = withSuffixTo + v.slice(withSuffixFrom.length);
            changes.push({ from: v, to: newV, key: 'with-suffix' });
            totalCount++;
            v = newV;
          }
        }
      }
      return { ...node, value: v };
    }
    const out = {};
    for (const [k, child] of Object.entries(node)) {
      out[k] = walkAndReplace(child);
    }
    return out;
  }

  const newObj = walkAndReplace(obj);

  // Summarize by replacement pair
  const countMap = new Map();
  for (const c of changes) {
    const key = `${c.from} → ${c.to}`;
    countMap.set(key, (countMap.get(key) || 0) + 1);
  }

  const summaryChanges = [...countMap.entries()].map(([label, count]) => {
    const [from, to] = label.split(' → ');
    return { from, to, count };
  });

  return { newObj, changes: summaryChanges, totalCount };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const apply  = args.includes('--apply');

  if (!dryRun && !apply) {
    process.stdout.write('Usage: node src/normalize.js --dry-run | --apply\n');
    return;
  }

  const globalRaw  = load('global.json');
  const segmentRaw = load('segment.json');
  const fusionRaw  = load('fusion.json');

  // 1. Normalize global.json
  const { newObj: newGlobal, renames, merges } = normalizeGlobal(globalRaw);

  // 2. Update alias refs in segment.json
  const { newObj: newSegment, changes: segChanges, totalCount: segCount } =
    updateAliasRefs(segmentRaw, renames, merges);

  // 3. Update alias refs in fusion.json (usually none, but check)
  const { newObj: newFusion, changes: fusChanges, totalCount: fusCount } =
    updateAliasRefs(fusionRaw, renames, merges);

  // ─── Dry-run output ─────────────────────────────────────────────────────────

  const mode = dryRun ? '[DRY-RUN]' : '[APPLY]';

  process.stdout.write(`\n${mode} Token Scale Normalization\n`);
  process.stdout.write('='.repeat(60) + '\n\n');

  process.stdout.write(`GLOBAL.JSON — key renames (${renames.length})\n`);
  for (const { from, to } of renames) {
    process.stdout.write(`  rename  ${from.padEnd(36)} → ${to}\n`);
  }
  if (merges.length) {
    process.stdout.write(`\nGLOBAL.JSON — key merges/deletions (${merges.length})\n`);
    for (const { deleted, target } of merges) {
      process.stdout.write(`  delete  ${deleted.padEnd(36)} → refs redirect to ${target}\n`);
    }
  }

  process.stdout.write(`\nSEGMENT.JSON — alias ref updates (${segCount} occurrences)\n`);
  if (segChanges.length === 0) {
    process.stdout.write('  (none)\n');
  }
  for (const { from, to, count } of segChanges) {
    process.stdout.write(`  ${String(count).padStart(2)}×  ${from.padEnd(36)} → ${to}\n`);
  }

  process.stdout.write(`\nFUSION.JSON — alias ref updates (${fusCount} occurrences)\n`);
  if (fusChanges.length === 0) {
    process.stdout.write('  (none)\n');
  }
  for (const { from, to, count } of fusChanges) {
    process.stdout.write(`  ${String(count).padStart(2)}×  ${from.padEnd(36)} → ${to}\n`);
  }

  // Summary
  const totalRenames = renames.length;
  const totalMerges  = merges.length;
  const totalAliasUpdates = segCount + fusCount;

  process.stdout.write('\n' + '─'.repeat(60) + '\n');
  process.stdout.write(`SUMMARY\n`);
  process.stdout.write(`  global.json  : ${totalRenames} keys renamed, ${totalMerges} keys deleted (merged)\n`);
  process.stdout.write(`  segment.json : ${segCount} alias refs updated\n`);
  process.stdout.write(`  fusion.json  : ${fusCount} alias refs updated\n`);
  process.stdout.write(`  Total changes: ${totalRenames + totalMerges + totalAliasUpdates}\n`);

  if (dryRun) {
    process.stdout.write('\nRun with --apply to write files.\n\n');
    return;
  }

  // ─── Apply ──────────────────────────────────────────────────────────────────

  save('global.json',  newGlobal);
  save('segment.json', newSegment);
  save('fusion.json',  newFusion);

  process.stdout.write('\n✓ Files written. Reimport Global and Segment collections into Figma.\n\n');
}

main();
