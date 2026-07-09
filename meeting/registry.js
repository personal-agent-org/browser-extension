// Meeting platform-adapter registry (isolated content-script world).
//
// Authored WITHOUT import/export on purpose: MV3 lists these files in the manifest
// `content_scripts.js` array where they run as CLASSIC scripts sharing one global scope
// (they talk to each other via `globalThis.PAMeeting*`). A module with no import/export is
// byte-identical to a classic script, so Node can ALSO `import` it for unit tests - the file
// just populates globalThis as a side effect (see test/meeting.test.js).
//
// An adapter is `{ name, detect(win) -> bool, start(emit), stop() }`. `emit` is
// `{ speaker(stream, name, event), meta(kind, name, text) }`. Detection is by platform
// SIGNATURE (page globals / DOM), never by hostname: these are self-hosted OSS platforms
// that live on arbitrary domains.

(function () {
  const adapters = [];

  const registry = {
    register(adapter) {
      adapters.push(adapter);
      return adapter;
    },
    all() {
      return adapters.slice();
    },
    // First adapter whose detect() matches, or null. Order = registration order.
    detect(win) {
      for (const a of adapters) {
        try {
          if (a.detect(win)) return a;
        } catch {
          /* a broken adapter must not blind the others */
        }
      }
      return null;
    },
  };

  globalThis.PAMeetingRegistry = registry;

  // Shared factory for DOM-observed platforms (BigBlueButton, OpenTalk): detection is a CSS
  // signature; join/leave are derived by diffing the participant list on every DOM mutation, and
  // speaker start/stop by diffing a "talking" indicator IF the platform exposes one in the DOM.
  //
  // `attributesSpeakers`: some platforms (BigBlueButton) mark the active speaker with a stable DOM
  // attribute, so we can attribute each utterance to a name. Others (OpenTalk, a LiveKit app) keep
  // the speaking state in JS only and filter it out of the DOM, so per-speaker attribution is not
  // possible from a content script — such an adapter omits `talkingSelector` and sets
  // `attributesSpeakers:false`, which tells the offscreen capture to segment the tab audio itself
  // (energy VAD, generic "speaker" label) so a transcript is still produced.
  //
  // The talking indicator and the participant row often render the display name differently, so
  // `talkingNameOf` / `participantNameOf` can be given separately (both fall back to `nameOf`).
  function makeDomAdapter(cfg) {
    const nameOf =
      cfg.nameOf ||
      ((el) => ((el && (el.getAttribute?.("data-name") || el.textContent)) || "").trim());
    const talkingNameOf = cfg.talkingNameOf || nameOf;
    const participantNameOf = cfg.participantNameOf || nameOf;

    return {
      name: cfg.name,
      attributesSpeakers: cfg.attributesSpeakers !== false,
      _obs: null,
      detect(win) {
        try {
          const d = win && win.document;
          return !!(d && d.querySelector && d.querySelector(cfg.sigSelector));
        } catch {
          return false;
        }
      },
      start(emit) {
        const doc = globalThis.document;
        let talking = new Set();
        let present = new Set();

        const scan = () => {
          if (cfg.talkingSelector) {
            const nowTalking = new Set();
            doc.querySelectorAll(cfg.talkingSelector).forEach((el) => {
              const n = talkingNameOf(el);
              if (n) nowTalking.add(n);
            });
            for (const n of nowTalking) if (!talking.has(n)) emit.speaker("tab", n, "start");
            for (const n of talking) if (!nowTalking.has(n)) emit.speaker("tab", n, "stop");
            talking = nowTalking;
          }

          if (cfg.participantSelector) {
            const nowPresent = new Set();
            doc.querySelectorAll(cfg.participantSelector).forEach((el) => {
              const n = participantNameOf(el);
              if (n) nowPresent.add(n);
            });
            for (const n of nowPresent) if (!present.has(n)) emit.meta("join", n, "");
            for (const n of present) if (!nowPresent.has(n)) emit.meta("leave", n, "");
            present = nowPresent;
          }
        };

        const obs = new MutationObserver(() => scan());
        obs.observe(doc.body || doc.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
        });
        this._obs = obs;
        scan();
      },
      stop() {
        if (this._obs) this._obs.disconnect();
        this._obs = null;
      },
    };
  }

  globalThis.PAMeeting = { makeDomAdapter };
})();
