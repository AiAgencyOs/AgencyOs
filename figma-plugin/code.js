/**
 * AgencyOS Design Import - Figma plugin (main thread).
 *
 * Takes one project's export from AgencyOS (the finalized screens and the selected design direction) and builds them in the open
 * Figma file: a "Direction" frame (palette and type), then one wireframe frame per screen with a frame for each state the screen
 * must handle. It draws STRUCTURE - names, roles, purposes, actions, required data, components - in the project's own colours and
 * fonts. It does not invent a visual design; a designer takes it from here. Every frame is named with the screen's key so AgencyOS
 * can match them back.
 *
 * The layout is plain data (`buildSpec`) and drawing is a thin pass over it (`render`), so the layout is tested in Node with no
 * Figma at all; only `render` touches the Figma API.
 *
 * Plain JavaScript on purpose: no build step, nothing to install - Figma loads this file as it is.
 */

/* global figma, __html__, module */

var GAP = 80;
var MOBILE = { w: 390, h: 844 };
var WEB = { w: 1280, h: 800 };
var STATE_SCALE = 0.55;
var STATES = [
  ['has_empty_state', 'Empty'],
  ['has_loading_state', 'Loading'],
  ['has_error_state', 'Error'],
  ['has_success_state', 'Success'],
];

function hex(value, fallback) {
  return typeof value === 'string' && /^#?[0-9a-fA-F]{6}$/.test(value.trim()) ? '#' + value.trim().replace('#', '').toLowerCase() : fallback;
}

function paletteOf(direction) {
  var p = (direction && direction.palette) || {};
  var primary = hex(p.primary, '#2f5bea');
  return {
    primary: primary,
    secondary: hex(p.secondary, primary),
    accent: hex(p.accent, primary),
    background: hex(p.background, '#ffffff'),
    surface: hex(p.surface, '#f4f5f7'),
    text: hex(p.textPrimary, '#14171f'),
    textMuted: hex(p.textSecondary, '#5b6270'),
    success: hex(p.success, '#1f9d55'),
    warning: hex(p.warning, '#d98a00'),
    error: hex(p.error, '#d64545'),
  };
}

/** Wide (web) when the screen targets desktop/web and not a phone; otherwise a phone-sized frame. */
function isWide(screen) {
  var d = (screen.devices || []).join(' ').toLowerCase();
  return /desktop|web|laptop/.test(d) && !/mobile|phone/.test(d);
}

function rect(x, y, w, h, fill, radius, stroke) {
  return { type: 'rect', x: x, y: y, w: w, h: h, fill: fill, radius: radius || 0, stroke: stroke || null };
}
function text(x, y, w, value, size, weight, fill) {
  return { type: 'text', x: x, y: y, w: w, text: String(value), size: size, weight: weight || 'Regular', fill: fill };
}

function lines(value) {
  return String(value || '')
    .split(/\r?\n|;|•/)
    .map(function (s) { return s.trim(); })
    .filter(Boolean)
    .slice(0, 8);
}

/** One screen's main wireframe: a header band, the purpose, then a block per action / data / component the screen declares. */
function screenFrame(screen, pal, size, label, stateNote) {
  var w = size.w;
  var h = size.h;
  var pad = 20;
  var children = [rect(0, 0, w, h, pal.background, 0, null), rect(0, 0, w, 64, pal.primary, 0, null)];
  children.push(text(pad, 22, w - pad * 2, label || screen.name, 18, 'Bold', '#ffffff'));
  var y = 84;
  if (stateNote) {
    children.push(rect(pad, y, w - pad * 2, 120, pal.surface, 12, null));
    children.push(text(pad + 16, y + 16, w - pad * 2 - 32, stateNote, 16, 'Bold', pal.text));
    children.push(text(pad + 16, y + 48, w - pad * 2 - 32, 'What the user sees in this state is for the designer to define - the screen must handle it.', 13, 'Regular', pal.textMuted));
    return children;
  }
  if (screen.purpose) {
    children.push(text(pad, y, w - pad * 2, screen.purpose, 14, 'Regular', pal.textMuted));
    y += 52;
  }
  children.push(text(pad, y, w - pad * 2, 'Role: ' + (screen.role || 'unspecified'), 12, 'Bold', pal.accent));
  y += 28;
  var blocks = [];
  lines(screen.requiredData).forEach(function (d) { blocks.push(['Data', d]); });
  (screen.components || []).slice(0, 6).forEach(function (c) { blocks.push(['Component', c]); });
  lines(screen.actions).forEach(function (a) { blocks.push(['Action', a]); });
  blocks.forEach(function (b) {
    if (y + 56 > h - 24) return;
    var isAction = b[0] === 'Action';
    children.push(rect(pad, y, w - pad * 2, 48, isAction ? pal.primary : pal.surface, isAction ? 24 : 10, null));
    children.push(text(pad + 14, y + 15, w - pad * 2 - 28, b[0] + ': ' + b[1], 13, isAction ? 'Bold' : 'Regular', isAction ? '#ffffff' : pal.text));
    y += 58;
  });
  return children;
}

function directionFrame(direction, pal) {
  var w = 720;
  var h = 480;
  var children = [rect(0, 0, w, h, pal.background, 0, pal.surface)];
  children.push(text(32, 28, w - 64, (direction && direction.name) || 'Design direction', 24, 'Bold', pal.text));
  if (direction && direction.summary) children.push(text(32, 64, w - 64, direction.summary, 13, 'Regular', pal.textMuted));
  var swatches = [['Primary', pal.primary], ['Secondary', pal.secondary], ['Accent', pal.accent], ['Surface', pal.surface], ['Success', pal.success], ['Warning', pal.warning], ['Error', pal.error], ['Text', pal.text]];
  swatches.forEach(function (s, i) {
    var x = 32 + (i % 4) * 168;
    var y = 130 + Math.floor(i / 4) * 120;
    children.push(rect(x, y, 152, 72, s[1], 12, pal.textMuted));
    children.push(text(x, y + 80, 152, s[0] + '  ' + s[1], 12, 'Regular', pal.text));
  });
  var t = (direction && direction.tokens) || {};
  var type = [];
  if (t.fontHeading) type.push('Headings: ' + t.fontHeading);
  if (t.fontBody) type.push('Body: ' + t.fontBody);
  if (t.radiusStyle) type.push('Corners: ' + t.radiusStyle);
  if (t.navigationStyle) type.push('Navigation: ' + t.navigationStyle);
  children.push(text(32, 380, w - 64, type.join('   |   ') || 'No design tokens recorded yet.', 13, 'Regular', pal.textMuted));
  return children;
}

/** The whole layout as plain data. Pure: the same payload always gives the same spec. */
function buildSpec(payload) {
  var pal = paletteOf(payload.direction);
  var frames = [];
  var x = 0;
  frames.push({ key: 'direction', screenId: null, name: 'Direction - ' + ((payload.direction && payload.direction.name) || 'none selected'), x: 0, y: 0, w: 720, h: 480, children: directionFrame(payload.direction, pal) });
  var y = 480 + GAP * 2;
  (payload.screens || []).forEach(function (screen) {
    var size = isWide(screen) ? WEB : MOBILE;
    var cursor = 0;
    frames.push({ key: screen.key, screenId: screen.id, name: screen.key + ' - ' + screen.name, x: cursor, y: y, w: size.w, h: size.h, children: screenFrame(screen, pal, size, screen.name, null) });
    cursor += size.w + GAP;
    STATES.forEach(function (st) {
      if (!(screen.states && screen.states[st[0]])) return;
      var small = { w: Math.round(size.w * STATE_SCALE), h: Math.round(size.h * STATE_SCALE) };
      frames.push({ key: screen.key + ':' + st[1].toLowerCase(), screenId: screen.id, name: screen.key + ' - ' + screen.name + ' (' + st[1] + ')', x: cursor, y: y, w: small.w, h: small.h, children: screenFrame(screen, pal, small, screen.name, st[1] + ' state') });
      cursor += small.w + GAP;
    });
    y += size.h + GAP * 2;
    x = Math.max(x, cursor);
  });
  return { pageName: 'AgencyOS - ' + ((payload.project && payload.project.name) || 'project'), palette: pal, frames: frames, width: x };
}

/** Draws a spec through the Figma API. `figma` is passed in so a test can hand in a fake. Returns what was created. */
async function render(figma, spec) {
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
  var page = figma.createPage();
  page.name = spec.pageName;
  await figma.setCurrentPageAsync(page);
  var created = [];
  function paint(node, color) {
    node.fills = [{ type: 'SOLID', color: rgb(color) }];
  }
  spec.frames.forEach(function (f) {
    var frame = figma.createFrame();
    frame.name = f.name;
    frame.resize(f.w, f.h);
    frame.x = f.x;
    frame.y = f.y;
    frame.clipsContent = true;
    frame.fills = [];
    page.appendChild(frame);
    f.children.forEach(function (c) {
      if (c.type === 'rect') {
        var r = figma.createRectangle();
        r.x = c.x; r.y = c.y; r.resize(c.w, c.h);
        r.cornerRadius = c.radius || 0;
        paint(r, c.fill);
        if (c.stroke) { r.strokes = [{ type: 'SOLID', color: rgb(c.stroke) }]; r.strokeWeight = 1; }
        frame.appendChild(r);
      } else {
        var t = figma.createText();
        t.fontName = { family: 'Inter', style: c.weight === 'Bold' ? 'Bold' : 'Regular' };
        t.fontSize = c.size;
        t.characters = c.text;
        t.x = c.x; t.y = c.y;
        t.resize(c.w, t.height);
        t.textAutoResize = 'HEIGHT';
        paint(t, c.fill);
        frame.appendChild(t);
      }
    });
    created.push({ key: f.key, screenId: f.screenId, name: f.name, nodeId: frame.id });
  });
  figma.viewport.scrollAndZoomIntoView(page.children);
  return { fileKey: figma.fileKey || null, pageId: page.id, pageName: page.name, frames: created };
}

function rgb(color) {
  var h = String(color).replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 };
}

if (typeof figma !== 'undefined' && typeof figma.showUI === 'function') {
  figma.showUI(__html__, { width: 420, height: 560, themeColors: true });
  figma.ui.onmessage = async function (msg) {
    try {
      if (msg.type === 'import') {
        var spec = buildSpec(msg.payload);
        var report = await render(figma, spec);
        figma.ui.postMessage({ type: 'done', report: report });
      } else if (msg.type === 'close') {
        figma.closePlugin();
      }
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
    }
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { buildSpec: buildSpec, render: render, paletteOf: paletteOf, isWide: isWide, hex: hex };
