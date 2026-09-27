'use strict';
// The keybindings and the platform's key glyphs (plain script; exposes window.PLKeys,
// and module.exports under node for the tests; loads right after components.js). Pure, no DOM.
// Components.actions re-exports all of it (renderer/actions.js).
//
//   KEYS                            the one keybinding table: frozen
//                                   [{id, key, shift, flow, args, gate, wip, inField, nav}] (see below)
//   matchKey(keydown, {mac}?) -> KEYS entry | null   ⌘ (mac) / Ctrl + key (+ Shift); no Alt, not both
//                                   modifiers, not while composing; repeats match
//   repeatBlocked(keydown, entry?) -> boolean   a key repeat that must not act (only nav entries repeat)
//   keyHint(id | entry | {key, shift, alt}, mac?) -> '⇧⌘Z' on macOS, 'Ctrl+Shift+Z' elsewhere ('' if unknown)
//   withKeyHint(title, id, mac?) -> 'title (⌘Z)': tooltips that show their shortcut
//   keyGlyph(name, mac?) -> a single key as the platform writes it: 'enter' '↵' | 'Enter',
//                                   'backspace' '⌫' | 'Delete'
//   modClick(mac?) -> '⌘-click' | 'Ctrl-click'
// `mac` defaults to Components.util.IS_MAC, read on every call.
(function () {
  const C = window.Components;
  const isMac = (mac) => (mac === undefined ? C.util.IS_MAC : !!mac);

  // The one keybinding table: ⌘ on macOS, Ctrl elsewhere (never with Alt, with both ⌘ and Ctrl, or
  // during IME composition), plus Shift exactly when `shift`. Entry fields:
  //   id       name for keyHint / withKeyHint (and the WIP action name)
  //   key      e.key, lower case ('enter' for Return), so Caps Lock doesn't matter
  //   flow     app.js runs PLFlows[flow](store, ...args), gated by availability()[gate]
  //            (Components.actions.shortcutFor)
  //   wip      the WIP panel runs it (details.js, composer.js inside the commit fields; PLWip.shortcut)
  //   inField  also runs while a text field has focus. ⌘Z / ⌘⇧Z are the field's own undo / redo
  //            there, and ⌘↵ / ⌘⇧↵ in a text field run only inside the commit fields (composer.js).
  //   nav      moves focus only. Repeat policy: a held key (e.repeat) re-runs a nav entry; every
  //            other entry writes or opens a dialog, so its repeats are swallowed without acting
  //            (repeatBlocked). The graph's j/k / arrows are navigation too and repeat.
  // An entry with neither flow nor wip is run by app.js itself: open (⌘O, the folder dialog for this
  // tab) and repoPicker (⌘P, the toolbar's repository picker; on the start screen it focuses the
  // search). They work in text fields and without a repo. Main's File > Open Repository… keeps its
  // own ⇧⌘O accelerator; ⌘T / ⌘W / ⌘1–9 / Ctrl+Tab are main's (tabs), not in this table.
  const NONE = Object.freeze([]);
  const KEYS = Object.freeze([
    { id: 'undo', key: 'z', shift: false, flow: 'undo', args: NONE, gate: 'undo', wip: null, inField: false, nav: false },
    { id: 'redo', key: 'z', shift: true, flow: 'redo', args: NONE, gate: 'redo', wip: null, inField: false, nav: false },
    { id: 'fetch', key: 'l', shift: false, flow: 'fetch', args: NONE, gate: 'fetch', wip: null, inField: true, nav: false },
    { id: 'branch', key: 'b', shift: false, flow: 'createBranch', args: Object.freeze([Object.freeze({})]), gate: 'branch', wip: null, inField: true, nav: false },
    { id: 'stageAll', key: 's', shift: true, flow: null, args: NONE, gate: null, wip: 'stageAll', inField: true, nav: false },
    { id: 'unstageAll', key: 'u', shift: true, flow: null, args: NONE, gate: null, wip: 'unstageAll', inField: true, nav: false },
    { id: 'focusMessage', key: 'm', shift: true, flow: null, args: NONE, gate: null, wip: 'focusMessage', inField: true, nav: true },
    { id: 'commit', key: 'enter', shift: false, flow: null, args: NONE, gate: null, wip: 'commit', inField: false, nav: false },
    { id: 'commitAll', key: 'enter', shift: true, flow: null, args: NONE, gate: null, wip: 'commitAll', inField: false, nav: false },
    { id: 'open', key: 'o', shift: false, flow: null, args: NONE, gate: null, wip: null, inField: true, nav: false },
    { id: 'repoPicker', key: 'p', shift: false, flow: null, args: NONE, gate: null, wip: null, inField: true, nav: false },
  ].map((k) => Object.freeze(k)));
  const KEY_BY_ID = new Map(KEYS.map((k) => [k.id, k]));

  // Hint glyphs: '⇧⌘Z' / '⌘↵' on macOS, 'Ctrl+Shift+Z' / 'Ctrl+Enter' elsewhere.
  const GLYPHS = {
    mac: { prefix: (shift, alt) => `${alt ? '⌥' : ''}${shift ? '⇧' : ''}⌘`, keys: { enter: '↵', backspace: '⌫' }, click: '⌘-click' },
    other: { prefix: (shift, alt) => `Ctrl+${alt ? 'Alt+' : ''}${shift ? 'Shift+' : ''}`, keys: { enter: 'Enter', backspace: 'Delete' }, click: 'Ctrl-click' },
  };
  const glyphs = (mac) => (isMac(mac) ? GLYPHS.mac : GLYPHS.other);

  /** The KEYS entry keydown `e` presses, or null. Pure; a key repeat matches too (see repeatBlocked). */
  function matchKey(e, { mac } = {}) {
    if (!e || e.isComposing || e.altKey) return null;
    if (isMac(mac) ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return null;
    const key = String(e.key || '').toLowerCase();
    return KEYS.find((k) => k.key === key && k.shift === !!e.shiftKey) || null;
  }

  /** True when `e` is a key repeat that must not act (the repeat policy above): swallow it. */
  const repeatBlocked = (e, entry = matchKey(e)) => !!(e && e.repeat) && !(entry && entry.nav);

  /** One key as the platform writes it ('enter' -> '↵' / 'Enter'); other keys in upper case. */
  function keyGlyph(name, mac) {
    const key = String(name || '');
    return glyphs(mac).keys[key.toLowerCase()] || key.toUpperCase();
  }

  /** Display text of a keybinding (KEYS id, entry or {key, shift, alt}); '' when unknown. */
  function keyHint(name, mac) {
    const k = typeof name === 'string' ? KEY_BY_ID.get(name) : name;
    if (!k || !k.key) return '';
    return `${glyphs(mac).prefix(!!k.shift, !!k.alt)}${keyGlyph(k.key, mac)}`;
  }

  /** 'title (⌘Z)': a tooltip followed by its keybinding (title unchanged when there is none). */
  function withKeyHint(title, name, mac) {
    const hint = keyHint(name, mac);
    return hint ? `${title} (${hint})` : title;
  }

  /** '⌘-click' on macOS, 'Ctrl-click' elsewhere (a click with the command modifier, util.modKey). */
  const modClick = (mac) => glyphs(mac).click;

  const api = { KEYS, matchKey, repeatBlocked, keyHint, withKeyHint, keyGlyph, modClick };
  if (typeof window !== 'undefined') window.PLKeys = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
