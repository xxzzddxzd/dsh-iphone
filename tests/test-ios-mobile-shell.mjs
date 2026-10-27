#!/usr/bin/env node
// Behaviour of the iPhone mobile shell. The stub DOM below implements only the
// selectors and events web/mobile-shell.js uses, so each assertion exercises the
// real file rather than a copy of its logic.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../web/mobile-shell.js", import.meta.url), "utf8");

function parseSimple(token) {
  let rest = token.trim();
  const notAttrs = [];
  rest = rest.replace(/:not\(\[([\w-]+)(?:="([^"]*)")?\]\)/g, (_, name, value) => {
    notAttrs.push([name, value]);
    return "";
  });
  const spec = { tag: null, classes: [], attrs: [], notAttrs };
  const tokenPattern = /^([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/;
  while (rest.length > 0) {
    const match = tokenPattern.exec(rest);
    if (match === null) throw new Error(`unsupported test selector: ${rest}`);
    if (match[1] !== undefined) spec.tag = match[1].toLowerCase();
    else if (match[2] !== undefined) spec.classes.push(match[2]);
    else spec.attrs.push([match[3], match[4]]);
    rest = rest.slice(match[0].length);
  }
  return spec;
}

function matchesSelector(element, selector) {
  return selector.split(",").some((part) => {
    const spec = parseSimple(part);
    if (spec.tag !== null && element.tagName.toLowerCase() !== spec.tag) return false;
    if (spec.classes.some(name => !element.classList.contains(name))) return false;
    for (const [name, value] of spec.attrs) {
      if (!element.hasAttribute(name)) return false;
      if (value !== undefined && element.getAttribute(name) !== value) return false;
    }
    for (const [name, value] of spec.notAttrs) {
      if (!element.hasAttribute(name)) continue;
      if (value === undefined || element.getAttribute(name) === value) return false;
    }
    return true;
  });
}

class StubEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.target = null;
    Object.assign(this, init);
  }
}

class StubElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.textContent = "";
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.style = {
      values: new Map(),
      setProperty: (name, value) => { this.style.values.set(name, value); },
      getPropertyValue: name => this.style.values.get(name) ?? "",
    };
    this.listeners = new Map();
    this.classList = { contains: name => this.className.split(/\s+/).includes(name) };
  }
  get children() { return this.childNodes.filter(node => node instanceof StubElement); }
  hasAttribute(name) { return this.attributes.has(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, value === undefined ? "" : String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(node) { node.parentNode = this; this.childNodes.push(node); return node; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
  remove() {
    if (this.parentNode === null) return;
    this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this);
    this.parentNode = null;
  }
  contains(node) {
    for (let current = node; current !== null && current !== undefined; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }
  matches(selector) { return matchesSelector(this, selector); }
  closest(selector) {
    for (let current = this; current instanceof StubElement; current = current.parentNode) {
      if (matchesSelector(current, selector)) return current;
    }
    return null;
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, event = new StubEvent(type)) {
    event.target = event.target ?? this;
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return event;
  }
  focus() {
    const document = this.ownerDocument;
    if (document.activeElement === this) return;
    const previous = document.activeElement;
    document.activeElement = this;
    if (previous instanceof StubElement) previous.dispatch("focusout", new StubEvent("focusout", { relatedTarget: this }));
    document.dispatch("focusin", new StubEvent("focusin", { target: this, relatedTarget: previous }));
  }
  blur() {
    if (this.ownerDocument.activeElement !== this) return;
    this.ownerDocument.activeElement = null;
    this.dispatch("focusout", new StubEvent("focusout", { relatedTarget: null }));
  }
  click() { this.dispatch("click", new StubEvent("click", { target: this })); }
}

class StubInput extends StubElement {}
class StubTextArea extends StubElement {}

class StubDocument {
  constructor() {
    this.listeners = new Map();
    this.visibilityState = "visible";
    this.activeElement = null;
    this.documentElement = new StubElement("html", this);
    this.body = new StubElement("body", this);
    this.documentElement.appendChild(this.body);
  }
  createElement(tagName) {
    if (tagName.toLowerCase() === "input") return new StubInput(tagName, this);
    if (tagName.toLowerCase() === "textarea") return new StubTextArea(tagName, this);
    return new StubElement(tagName, this);
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, event = new StubEvent(type)) {
    event.target = event.target ?? this;
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return event;
  }
  querySelector(selector) { return this.documentElement.querySelector(selector); }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
}

class StubObserver {
  constructor(callback) { this.callback = callback; StubObserver.instances.push(this); }
  observe() {}
  disconnect() { this.disconnected = true; }
}
StubObserver.instances = [];

function createEnvironment({ landscape = false, touch = true } = {}) {
  StubObserver.instances = [];
  const document = new StubDocument();
  const queries = new Map();
  const matchMedia = query => {
    if (!queries.has(query)) queries.set(query, { matches: false, listeners: new Set() });
    return {
      get matches() { return queries.get(query).matches; },
      addEventListener: (_type, listener) => { queries.get(query).listeners.add(listener); },
      removeEventListener: (_type, listener) => { queries.get(query).listeners.delete(listener); },
    };
  };
  queries.set("(max-width: 1023px)", { matches: true, listeners: new Set() });
  queries.set("(orientation: landscape)", { matches: landscape, listeners: new Set() });
  queries.set("(hover: none) and (pointer: coarse)", { matches: touch, listeners: new Set() });
  const setQuery = (query, matches) => {
    const entry = queries.get(query);
    if (entry === undefined || entry.matches === matches) return;
    entry.matches = matches;
    for (const listener of [...entry.listeners]) listener(new StubEvent("change"));
  };
  const window = { visualViewport: undefined, scrollX: 0, scrollY: 0, scrollTo() {} };
  const context = vm.createContext({
    window, document, matchMedia, MutationObserver: StubObserver, Element: StubElement,
    HTMLInputElement: StubInput, HTMLTextAreaElement: StubTextArea,
    requestAnimationFrame: fn => setTimeout(fn, 0), setTimeout, clearTimeout, Date, Math, parseFloat,
    console,
  });
  vm.runInContext(source, context);
  const menu = ({ checked = false } = {}) => {
    const surface = document.createElement("div");
    surface.setAttribute("data-menu-material", "");
    const field = document.createElement("input");
    const seat = document.createElement("button");
    seat.setAttribute("role", "menuitemradio");
    surface.append(field, seat);
    let current = null;
    if (checked) {
      current = document.createElement("button");
      current.setAttribute("role", "menuitemradio");
      current.setAttribute("aria-checked", "true");
      surface.append(current);
    }
    document.body.appendChild(surface);
    return { surface, field, seat, current };
  };
  const transcript = () => {
    const scroller = document.createElement("div");
    scroller.setAttribute("data-conversation-scroll", "");
    scroller.scrollHeight = 1_000;
    document.body.appendChild(scroller);
    return scroller;
  };
  const followTail = () => {
    const marker = document.createElement("div");
    marker.setAttribute("data-chat-following-tail", "");
    document.body.appendChild(marker);
  };
  const press = target => document.dispatch("pointerdown", new StubEvent("pointerdown", { target }));
  const setVisibility = value => {
    document.visibilityState = value;
    document.dispatch("visibilitychange", new StubEvent("visibilitychange"));
  };
  return {
    document, html: document.documentElement, observers: StubObserver.instances,
    cover: () => document.body.querySelector(".dsh-ios-settling-cover"),
    menu, transcript, followTail, press, setVisibility,
    setLandscape: value => setQuery("(orientation: landscape)", value),
  };
}

// The model menu focuses its search field while opening. On a touch device that
// focus must land on a menu seat instead, or the keyboard covers the list.
{
  const env = createEnvironment();
  const { field, seat } = env.menu();
  env.press(env.document.body);
  field.focus();
  assert.equal(env.document.activeElement, seat, "an indirect menu focus moves to a menu seat");
  seat.blur();
  field.focus();
  assert.equal(env.document.activeElement, seat, "a later programmatic focus is still redirected");
}
// The value in use is where the menu's own keyboard navigation starts.
{
  const env = createEnvironment();
  const { field, current } = env.menu({ checked: true });
  env.press(env.document.body);
  field.focus();
  assert.equal(env.document.activeElement, current, "an indirect menu focus starts at the value in use");
}
// A tap on the field itself is a deliberate request to type.
{
  const env = createEnvironment();
  const { field } = env.menu();
  env.press(field);
  field.focus();
  assert.equal(env.document.activeElement, field, "a direct tap keeps the keyboard");
}
// A pointer device has no software keyboard, so the official focus stays.
{
  const env = createEnvironment({ touch: false });
  const { field } = env.menu();
  env.press(env.document.body);
  field.focus();
  assert.equal(env.document.activeElement, field, "a pointer device keeps the menu search focus");
}
// iOS 16 shows a resumed web app at the previous app's orientation and rotates
// afterwards. The transient frame must not paint, and the transcript that frame
// re-anchored must return to the newest message.
{
  const env = createEnvironment();
  const scroller = env.transcript();
  env.followTail();
  assert.equal(env.cover().hidden, true, "no cover while portrait");
  env.setVisibility("hidden");
  env.setLandscape(true);
  env.setVisibility("visible");
  assert.equal(env.cover().hidden, false, "a landscape resume is covered");
  env.setLandscape(false);
  assert.equal(env.cover().hidden, true, "the cover leaves once portrait returns");
  assert.equal(scroller.scrollTop, 1_000, "the covered frame re-pins the newest message");
}
// A reader who scrolled up keeps that position: only follow-tail is restored.
{
  const env = createEnvironment();
  const scroller = env.transcript();
  env.setVisibility("hidden");
  env.setLandscape(true);
  env.setVisibility("visible");
  assert.equal(env.cover().hidden, false);
  env.setLandscape(false);
  assert.equal(scroller.scrollTop, 0, "a reader position is never overridden");
}
// iOS can flip the interface orientation a moment after the page becomes
// visible; that later landscape frame must be covered too, or the application
// paints landscape once before it rotates back.
{
  const env = createEnvironment();
  const scroller = env.transcript();
  env.followTail();
  env.setVisibility("hidden");
  env.setVisibility("visible");
  assert.equal(env.cover().hidden, true, "a portrait resume is not covered");
  env.setLandscape(true);
  assert.equal(env.cover().hidden, false, "the later landscape flip is covered");
  env.setLandscape(false);
  assert.equal(env.cover().hidden, true, "the cover leaves once portrait returns");
  assert.equal(scroller.scrollTop, 1_000, "the newest message is re-pinned");
}
// Rotating while DSH is already visible is covered as well: the client reads as
// portrait-only even when the device is turned.
{
  const env = createEnvironment();
  const scroller = env.transcript();
  env.followTail();
  env.setLandscape(true);
  assert.equal(env.cover().hidden, false, "an in-app rotation is covered");
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.equal(scroller.scrollTop, 1_000, "an in-app rotation still re-pins the newest message");
}
// The boot card is a neutral loading surface, so it stays visible and only the
// application that replaces it is covered.
{
  const env = createEnvironment({ landscape: true });
  assert.equal(env.cover().hidden, true, "the loading surface stays uncovered");
  const frame = env.document.createElement("div");
  frame.className = "pI_x6G_frame";
  env.document.body.appendChild(frame);
  for (const observer of env.observers) observer.callback([]);
  assert.equal(env.cover().hidden, false, "the application replacing the loading surface is covered");
}
// A portrait handoff is not a transient frame and must not delay the app.
{
  const env = createEnvironment();
  const frame = env.document.createElement("div");
  frame.className = "pI_x6G_frame";
  env.document.body.appendChild(frame);
  for (const observer of env.observers) observer.callback([]);
  assert.equal(env.cover().hidden, true, "a portrait handoff is never covered");
}
// A pointer device is not an iOS web app launch target.
{
  const env = createEnvironment({ touch: false });
  env.transcript();
  env.setVisibility("hidden");
  env.setLandscape(true);
  env.setVisibility("visible");
  assert.equal(env.cover().hidden, true, "a pointer device never shows the cover");
}

console.log("iOS mobile shell: menu keyboard, orientation cover and transcript anchoring passed");
