// --- browser-bundle/05-natives.js ---
// The JavaScript built-ins the page JS uses, held where page script cannot
// replace them. This code runs in the page's own world (the URL engine and
// the live /detect.js script), where a site may declare `var Map = ...` or
// assign `Array.from = ...` (work24.go.kr ships its own global `Map`, which
// failed every capture with `states.set is not a function`).
//
// The URL engine runs this file once more, as a script on every new document
// before any page script (`Page::initialize` in crates/browser), and that run
// stashes what it built on `window.__impeccableNatives`, read-only and
// non-enumerable. Later runs take the stash. Without one (the live script tag,
// the extension's content script) the current globals are used as they are:
// the extension already runs in its own world, and live mode sees the user's
// own app.
//
// The `const` at the end shadows the globals for everything after it in the
// same function scope, which every consumer of these files provides (the
// in-page bundle's IIFE, the extension pieces, the URL engine's wrapper).
// Statics (`Array.from`, `JSON.stringify`, `Object.keys`, ...) are copied at
// capture time, so a later assignment to the shared object reaches nothing
// here. Prototype methods (`Map.prototype.set`) are not copied: a page that
// rewrites those is out of reach.
//
// The builder must reach every built-in through `g`, never by bare name:
// while it runs, the bare names are the `const` below, not yet initialized.

function __impeccableBuildNatives(g) {
  const O = g.Object;
  const R = g.Reflect;
  const freeze = O.freeze;
  // Own properties of `owner`, functions bound to it (`Array.from` and
  // `Promise.resolve` read `this`), onto `target`.
  const copyStatics = (owner, target) => {
    if (owner == null) return target;
    for (const name of O.getOwnPropertyNames(owner)) {
      if (name === 'length' || name === 'name' || name === 'prototype' || name === 'caller' || name === 'arguments') continue;
      let value;
      try { value = owner[name]; } catch { continue; }
      O.defineProperty(target, name, {
        value: typeof value === 'function' ? R.apply(g.Function.prototype.bind, value, [owner]) : value,
        enumerable: false, writable: false, configurable: false,
      });
    }
    return target;
  };
  const namespace = (owner) => (owner == null ? owner : freeze(copyStatics(owner, O.create(null))));
  // A constructor whose statics the page JS reads: calls and `new` reach the
  // native, `instanceof` still works, the statics are the copies.
  const callable = (native) => {
    if (typeof native !== 'function') return native;
    const facade = function (...args) {
      return new.target ? R.construct(native, args) : R.apply(native, undefined, args);
    };
    O.defineProperty(facade, 'prototype', { value: native.prototype, writable: false });
    return freeze(copyStatics(native, facade));
  };
  const bound = (name) => {
    const fn = g[name];
    return typeof fn === 'function' ? R.apply(g.Function.prototype.bind, fn, [g]) : undefined;
  };
  const perf = g.performance;
  return freeze({
    // Constructors used for `new` or calls only: the natives themselves.
    Map: g.Map, Set: g.Set, WeakMap: g.WeakMap, WeakSet: g.WeakSet,
    Error: g.Error, URL: g.URL, Image: g.Image, ResizeObserver: g.ResizeObserver,
    String: g.String, Boolean: g.Boolean,
    // Constructors whose statics are read.
    Array: callable(g.Array), Object: callable(g.Object), Number: callable(g.Number),
    Promise: callable(g.Promise),
    // Namespaces.
    JSON: namespace(g.JSON), Math: namespace(g.Math), Reflect: namespace(g.Reflect),
    CSS: namespace(g.CSS),
    performance: perf && typeof perf.now === 'function'
      ? freeze({ now: R.apply(g.Function.prototype.bind, perf.now, [perf]) })
      : perf,
    // Window functions.
    getComputedStyle: bound('getComputedStyle'), matchMedia: bound('matchMedia'),
    setTimeout: bound('setTimeout'), clearTimeout: bound('clearTimeout'),
    requestAnimationFrame: bound('requestAnimationFrame'),
  });
}

const __impeccableNatives = (() => {
  const g = typeof window !== 'undefined' ? window : globalThis;
  try {
    const stash = g.__impeccableNatives;
    if (stash && typeof stash === 'object') return stash;
  } catch { /* fall through */ }
  try { return __impeccableBuildNatives(g); } catch { /* fall through */ }
  return {
    Map: g.Map, Set: g.Set, WeakMap: g.WeakMap, WeakSet: g.WeakSet,
    Error: g.Error, URL: g.URL, Image: g.Image, ResizeObserver: g.ResizeObserver,
    String: g.String, Boolean: g.Boolean, Array: g.Array, Object: g.Object,
    Number: g.Number, Promise: g.Promise, JSON: g.JSON, Math: g.Math,
    Reflect: g.Reflect, CSS: g.CSS, performance: g.performance,
    getComputedStyle: g.getComputedStyle, matchMedia: g.matchMedia,
    setTimeout: g.setTimeout, clearTimeout: g.clearTimeout,
    requestAnimationFrame: g.requestAnimationFrame,
  };
})();

const {
  Map, Set, WeakMap, WeakSet, Error, URL, Image, ResizeObserver, String, Boolean,
  Array, Object, Number, Promise, JSON, Math, Reflect, CSS, performance,
  getComputedStyle, matchMedia, setTimeout, clearTimeout, requestAnimationFrame,
} = __impeccableNatives;
