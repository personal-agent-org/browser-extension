import { test } from "node:test";
import assert from "node:assert/strict";

// The adapter files are authored without import/export: loaded as classic content scripts in the
// browser, they populate globalThis. In Node they are plain side-effecting ESM modules, so
// importing them (registry FIRST) sets up globalThis.PAMeetingRegistry exactly as in the browser.
// A detect() takes a `win` shim, so this is fully DOM-free.
import "../meeting/registry.js";
import "../meeting/jitsi.js";
import "../meeting/bbb.js";
import "../meeting/opentalk.js";

// A `win` whose document.querySelector matches iff the selector text contains one of `hits`.
function fakeWin(extra = {}, hits = []) {
  return {
    document: {
      querySelector: (sel) => (hits.some((h) => sel.includes(h)) ? { matched: sel } : null),
    },
    ...extra,
  };
}

test("registry.detect returns the first matching adapter and null when none match", () => {
  const reg = globalThis.PAMeetingRegistry;
  // Jitsi via a page global (as a test would inject) wins.
  assert.equal(reg.detect(fakeWin({ APP: { conference: {} } })).name, "jitsi");
  // Jitsi via its DOM signature.
  assert.equal(reg.detect(fakeWin({}, ["#largeVideoContainer"])).name, "jitsi");
  // An unrelated page matches nothing.
  assert.equal(reg.detect(fakeWin({}, ["#some-random-app"])), null);
});

test("bigbluebutton is detected by its user-list signature, not by hostname", () => {
  const reg = globalThis.PAMeetingRegistry;
  const win = fakeWin({}, ["userListContent"]);
  const a = reg.detect(win);
  assert.equal(a.name, "bigbluebutton");
});

test("opentalk is detected by its participant-window signature", () => {
  const reg = globalThis.PAMeetingRegistry;
  const win = fakeWin({}, ["ParticipantWindow"]);
  const a = reg.detect(win);
  assert.equal(a.name, "opentalk");
});

test("adapters declare whether they attribute speakers from the DOM", () => {
  const by = Object.fromEntries(globalThis.PAMeetingRegistry.all().map((a) => [a.name, a]));
  // Jitsi (event hook) and BigBlueButton (data-test=isTalking) attribute real speakers.
  assert.equal(by.jitsi.attributesSpeakers, true);
  assert.equal(by.bigbluebutton.attributesSpeakers, true);
  // OpenTalk keeps speaking state out of the DOM -> offscreen VAD segments the tab audio instead.
  assert.equal(by.opentalk.attributesSpeakers, false);
});

test("every registered adapter exposes the common interface", () => {
  for (const a of globalThis.PAMeetingRegistry.all()) {
    assert.equal(typeof a.name, "string");
    assert.equal(typeof a.detect, "function");
    assert.equal(typeof a.start, "function");
    assert.equal(typeof a.stop, "function");
  }
  assert.deepEqual(
    globalThis.PAMeetingRegistry.all().map((a) => a.name),
    ["jitsi", "bigbluebutton", "opentalk"],
  );
});

test("a broken adapter's detect() throwing does not blind the registry", () => {
  const reg = globalThis.PAMeetingRegistry;
  reg.register({
    name: "boom",
    detect() {
      throw new Error("nope");
    },
    start() {},
    stop() {},
  });
  // Registered last, so the good adapters still resolve; an unmatched page is still null.
  assert.equal(reg.detect(fakeWin({}, ["#largeVideoContainer"])).name, "jitsi");
  assert.equal(reg.detect(fakeWin({}, ["#nothing-here"])), null);
});
