/**
 * Component Variable Reconnect
 *
 * Generates Figma Plugin API code that rebinds all known component
 * variable connections after a collection reimport breaks them.
 *
 * Run after reimporting any collection that components reference:
 *   node src/reconnect.js | pbcopy
 *   # then paste into Figma via MCP (use_figma)
 *
 * Components covered:
 *   Button/Primary — 48 variants (Ginormous / Standard / Nano × all states)
 *   Input Field    — 4 variants  (Default / Focus / Error / Disabled)
 *
 * Variable mappings (by collection/name — resolved dynamically at runtime):
 *
 *   Button fill:
 *     Default/Hover/Pressed → Prisme: bg/fill/primary/default|hover|pressed
 *     Disabled              → Prisme: bg/fill/primary/disabled
 *   Button text:
 *     Default/Hover/Pressed → Prisme: text/inverse
 *     Disabled              → Prisme: text/subtle
 *   Button icon:
 *     Default/Hover/Pressed → Prisme: icon/inverse
 *     Disabled              → Prisme: text/subtle
 *   Button corner radius:
 *     Ginormous → Radius: RadiusL
 *     Standard  → Radius: RadiusS
 *     Nano      → Radius: RadiusXS
 *   Button padding (H) / gap:
 *     Ginormous → Spacing: Space300 / Space100
 *     Standard  → Spacing: Space200 / Space100
 *     Nano      → Spacing: Space150 / Space075
 *
 *   Input fill:
 *     Default/Focus/Error → Prisme: bg/default
 *     Disabled            → Prisme: bg/fill/primary/disabled
 *   Input stroke color / weight:
 *     Default  → Prisme: action/secondary/default  @ 1px
 *     Focus    → Prisme: action/focus/border        @ 2px
 *     Error    → Prisme: action/error/primary       @ 1px
 *     Disabled → Prisme: action/secondary/disabled  @ 1px
 *   Input text / label:
 *     Default/Focus/Error → Prisme: text/default
 *     Disabled            → Prisme: text/subtle
 *   Input helper text:
 *     Default/Focus/Disabled → Prisme: text/subtle
 *     Error                  → Prisme: action/error/primary
 *   Input corner radius: Radius: RadiusXS
 *   Input padding (H):  Spacing: Space200
 */

// ─── Node IDs ─────────────────────────────────────────────────────────────────

// Button variants: [nodeId, size, state, hasText, hasIcon]
const BUTTON_VARIANTS = [
  // Ginormous
  ['59:11',  'Ginormous', 'Default',  true,  false],
  ['59:13',  'Ginormous', 'Hover',    true,  false],
  ['59:15',  'Ginormous', 'Pressed',  true,  false],
  ['59:17',  'Ginormous', 'Disabled', true,  false],
  ['59:51',  'Ginormous', 'Default',  false, true ],
  ['59:54',  'Ginormous', 'Hover',    false, true ],
  ['59:57',  'Ginormous', 'Pressed',  false, true ],
  ['59:60',  'Ginormous', 'Disabled', false, true ],
  ['59:19',  'Ginormous', 'Default',  true,  true ],
  ['59:23',  'Ginormous', 'Hover',    true,  true ],
  ['59:27',  'Ginormous', 'Pressed',  true,  true ],
  ['59:31',  'Ginormous', 'Disabled', true,  true ],
  ['59:35',  'Ginormous', 'Default',  true,  true ],
  ['59:39',  'Ginormous', 'Hover',    true,  true ],
  ['59:43',  'Ginormous', 'Pressed',  true,  true ],
  ['59:47',  'Ginormous', 'Disabled', true,  true ],
  // Standard
  ['59:63',  'Standard',  'Default',  true,  false],
  ['59:65',  'Standard',  'Hover',    true,  false],
  ['59:67',  'Standard',  'Pressed',  true,  false],
  ['59:69',  'Standard',  'Disabled', true,  false],
  ['59:71',  'Standard',  'Default',  true,  true ],
  ['59:75',  'Standard',  'Hover',    true,  true ],
  ['59:79',  'Standard',  'Pressed',  true,  true ],
  ['59:83',  'Standard',  'Disabled', true,  true ],
  ['59:87',  'Standard',  'Default',  true,  true ],
  ['59:91',  'Standard',  'Hover',    true,  true ],
  ['59:95',  'Standard',  'Pressed',  true,  true ],
  ['59:99',  'Standard',  'Disabled', true,  true ],
  ['59:103', 'Standard',  'Default',  false, true ],
  ['59:106', 'Standard',  'Hover',    false, true ],
  ['59:109', 'Standard',  'Pressed',  false, true ],
  ['59:112', 'Standard',  'Disabled', false, true ],
  // Nano
  ['59:115', 'Nano',      'Default',  true,  false],
  ['59:117', 'Nano',      'Hover',    true,  false],
  ['59:119', 'Nano',      'Pressed',  true,  false],
  ['59:121', 'Nano',      'Disabled', true,  false],
  ['59:123', 'Nano',      'Default',  true,  true ],
  ['59:127', 'Nano',      'Hover',    true,  true ],
  ['59:131', 'Nano',      'Pressed',  true,  true ],
  ['59:135', 'Nano',      'Disabled', true,  true ],
  ['59:139', 'Nano',      'Default',  true,  true ],
  ['59:143', 'Nano',      'Hover',    true,  true ],
  ['59:147', 'Nano',      'Pressed',  true,  true ],
  ['59:151', 'Nano',      'Disabled', true,  true ],
  ['59:155', 'Nano',      'Default',  false, true ],
  ['59:158', 'Nano',      'Hover',    false, true ],
  ['59:161', 'Nano',      'Pressed',  false, true ],
  ['59:164', 'Nano',      'Disabled', false, true ],
];

// Input variants: [nodeId, state, labelId, frameId, inputTextId, helperTextId]
const INPUT_VARIANTS = [
  ['151:221', 'Default',  '151:222', '151:223', '151:224', '151:225'],
  ['151:226', 'Focus',    '151:227', '151:228', '151:229', '151:230'],
  ['151:231', 'Error',    '151:232', '151:233', '151:234', '151:235'],
  ['151:236', 'Disabled', '151:237', '151:238', '151:239', '151:240'],
];

// ─── Code generator ───────────────────────────────────────────────────────────

export function generateReconnectCode() {
  const lines = [];
  const p = s => lines.push(s);

  p(`(async () => {`);
  p(`  await figma.currentPage.loadAsync();`);
  p(``);
  p(`  // ── Variable lookup ─────────────────────────────────────────────────`);
  p(`  function getV(col, name) {`);
  p(`    const c = figma.variables.getLocalVariableCollections().find(x => x.name === col);`);
  p(`    if (!c) return null;`);
  p(`    return figma.variables.getLocalVariables().find(v => v.variableCollectionId === c.id && v.name === name);`);
  p(`  }`);
  p(``);
  p(`  const P = {`);
  p(`    bgDefault:      getV('Prisme', 'bg/default'),`);
  p(`    bgFillDefault:  getV('Prisme', 'bg/fill/primary/default'),`);
  p(`    bgFillHover:    getV('Prisme', 'bg/fill/primary/hover'),`);
  p(`    bgFillPressed:  getV('Prisme', 'bg/fill/primary/pressed'),`);
  p(`    bgFillDisabled: getV('Prisme', 'bg/fill/primary/disabled'),`);
  p(`    actSecondary:   getV('Prisme', 'action/secondary/default'),`);
  p(`    actSecDisabled: getV('Prisme', 'action/secondary/disabled'),`);
  p(`    actFocus:       getV('Prisme', 'action/focus/border'),`);
  p(`    actError:       getV('Prisme', 'action/error/primary'),`);
  p(`    textDefault:    getV('Prisme', 'text/default'),`);
  p(`    textSubtle:     getV('Prisme', 'text/subtle'),`);
  p(`    textInverse:    getV('Prisme', 'text/inverse'),`);
  p(`    iconInverse:    getV('Prisme', 'icon/inverse'),`);
  p(`  };`);
  p(``);
  p(`  // ── Helpers ──────────────────────────────────────────────────────────`);
  p(`  function setFillVar(node, v) {`);
  p(`    if (!v || !node) return;`);
  p(`    const base = (node.fills && node.fills.length > 0) ? node.fills[0] : { type: 'SOLID', color: { r:1,g:1,b:1 } };`);
  p(`    node.fills = [figma.variables.setBoundVariableForPaint({ ...base, type: 'SOLID' }, 'color', v)];`);
  p(`  }`);
  p(`  function setStrokeVar(node, v, weight) {`);
  p(`    if (!v || !node) return;`);
  p(`    const base = (node.strokes && node.strokes.length > 0) ? node.strokes[0] : { type: 'SOLID', color: { r:0,g:0,b:0 } };`);
  p(`    node.strokes = [figma.variables.setBoundVariableForPaint({ ...base, type: 'SOLID' }, 'color', v)];`);
  p(`    if (weight !== undefined) { node.strokeWeight = weight; node.strokeAlign = 'INSIDE'; }`);
  p(`  }`);
  p(`  function setRadiusVar(node, v) {`);
  p(`    if (!v || !node) return;`);
  p(`    node.setBoundVariable('topLeftRadius',     v);`);
  p(`    node.setBoundVariable('topRightRadius',    v);`);
  p(`    node.setBoundVariable('bottomLeftRadius',  v);`);
  p(`    node.setBoundVariable('bottomRightRadius', v);`);
  p(`  }`);
  p(`  function setSpacingVar(node, prop, v) {`);
  p(`    if (!v || !node) return;`);
  p(`    node.setBoundVariable(prop, v);`);
  p(`  }`);
  p(``);
  p(`  // ── Radius & spacing lookup ───────────────────────────────────────────`);
  p(`  const radiusL  = getV('Radius', 'RadiusL');`);
  p(`  const radiusS  = getV('Radius', 'RadiusS');`);
  p(`  const radiusXS = getV('Radius', 'RadiusXS');`);
  p(`  const sp300 = getV('Spacing', 'Space300');`);
  p(`  const sp200 = getV('Spacing', 'Space200');`);
  p(`  const sp150 = getV('Spacing', 'Space150');`);
  p(`  const sp100 = getV('Spacing', 'Space100');`);
  p(`  const sp075 = getV('Spacing', 'Space075');`);
  p(`  const sp050 = getV('Spacing', 'Space050');`);
  p(``);
  p(`  // ── BUTTONS ──────────────────────────────────────────────────────────`);

  for (const [id, size, state, hasText, hasIcon] of BUTTON_VARIANTS) {
    const isDisabled = state === 'Disabled';
    const fillVar  = isDisabled ? 'P.bgFillDisabled' :
                     state === 'Hover'    ? 'P.bgFillHover' :
                     state === 'Pressed'  ? 'P.bgFillPressed' : 'P.bgFillDefault';
    const textVar  = isDisabled ? 'P.textSubtle'  : 'P.textInverse';
    const iconVar  = isDisabled ? 'P.textSubtle'  : 'P.iconInverse';
    const radiusVar = size === 'Ginormous' ? 'radiusL' : size === 'Standard' ? 'radiusS' : 'radiusXS';
    const padVar    = size === 'Ginormous' ? 'sp300'   : size === 'Standard' ? 'sp200'   : 'sp150';
    const gapVar    = size === 'Nano'      ? 'sp075'   : 'sp100';

    p(`  {`);
    p(`    const n = figma.getNodeById(${JSON.stringify(id)});`);
    p(`    if (n) {`);
    p(`      setFillVar(n, ${fillVar});`);
    p(`      setRadiusVar(n, ${radiusVar});`);
    if (hasText || hasIcon) {
      p(`      setSpacingVar(n, 'paddingLeft',  ${padVar});`);
      p(`      setSpacingVar(n, 'paddingRight', ${padVar});`);
      p(`      setSpacingVar(n, 'itemSpacing',  ${gapVar});`);
    }
    p(`      for (const c of (n.children || [])) {`);
    if (hasText) {
      p(`        if (c.type === 'TEXT') setFillVar(c, ${textVar});`);
    }
    if (hasIcon) {
      p(`        if (c.type === 'INSTANCE') for (const gc of (c.children || [])) if (gc.type === 'VECTOR') setFillVar(gc, ${iconVar});`);
    }
    p(`      }`);
    p(`    }`);
    p(`  }`);
  }

  p(``);
  p(`  // ── INPUT FIELDS ─────────────────────────────────────────────────────`);

  const inputConfigs = [
    { id: '151:221', state: 'Default',  labelId: '151:222', frameId: '151:223', textId: '151:224', helperId: '151:225' },
    { id: '151:226', state: 'Focus',    labelId: '151:227', frameId: '151:228', textId: '151:229', helperId: '151:230' },
    { id: '151:231', state: 'Error',    labelId: '151:232', frameId: '151:233', textId: '151:234', helperId: '151:235' },
    { id: '151:236', state: 'Disabled', labelId: '151:237', frameId: '151:238', textId: '151:239', helperId: '151:240' },
  ];

  for (const { state, labelId, frameId, textId, helperId } of inputConfigs) {
    const isDisabled = state === 'Disabled';
    const isError    = state === 'Error';
    const fillVar    = isDisabled ? 'P.bgFillDisabled' : 'P.bgDefault';
    const strokeVar  = state === 'Focus'    ? 'P.actFocus' :
                       state === 'Error'    ? 'P.actError' :
                       state === 'Disabled' ? 'P.actSecDisabled' : 'P.actSecondary';
    const strokeW    = state === 'Focus' ? 2 : 1;
    const labelVar   = isDisabled ? 'P.textSubtle' : 'P.textDefault';
    const textVar2   = isDisabled ? 'P.textSubtle' : 'P.textDefault';
    const helperVar  = isError ? 'P.actError' : 'P.textSubtle';

    p(`  // ${state}`);
    p(`  setFillVar(figma.getNodeById(${JSON.stringify(labelId)}), ${labelVar});`);
    p(`  setFillVar(figma.getNodeById(${JSON.stringify(frameId)}), ${fillVar});`);
    p(`  setStrokeVar(figma.getNodeById(${JSON.stringify(frameId)}), ${strokeVar}, ${strokeW});`);
    p(`  setSpacingVar(figma.getNodeById(${JSON.stringify(frameId)}), 'paddingLeft',  sp200);`);
    p(`  setSpacingVar(figma.getNodeById(${JSON.stringify(frameId)}), 'paddingRight', sp200);`);
    p(`  setRadiusVar(figma.getNodeById(${JSON.stringify(frameId)}), radiusXS);`);
    p(`  setFillVar(figma.getNodeById(${JSON.stringify(textId)}), ${textVar2});`);
    p(`  setFillVar(figma.getNodeById(${JSON.stringify(helperId)}), ${helperVar});`);
  }

  p(``);
  p(`  figma.notify('✓ Reconnected 48 button variants + 4 input field variants', { timeout: 4000 });`);
  p(`})()`);

  return lines.join('\n');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function printUsage() {
  process.stdout.write(`
Component Variable Reconnect

Generates Figma Plugin API code to rebind all component variable connections
after a collection reimport. Run this whenever Prisme, Radius, or Spacing
collections are reimported.

Usage:
  node src/reconnect.js             # print code to stdout
  node src/reconnect.js | pbcopy    # copy to clipboard (macOS)

Then paste the output into Figma via MCP (use_figma).
\n`);
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  printUsage();
} else {
  process.stdout.write(generateReconnectCode() + '\n');
}
