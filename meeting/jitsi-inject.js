// Jitsi page-context hook (runs in the PAGE world, injected as a web_accessible_resource by
// meeting/jitsi.js). It can see window.APP / window.JitsiMeetJS, subscribes to the live
// JitsiConference events, and postMessages plain data back to the isolated content script.
//
// NOTE: lib-jitsi-meet internals move between versions. The event NAMES are the public
// JitsiMeetJS.events.conference constants; reaching the JitsiConference room via
// APP.conference._room is the pragmatic path the Jitsi Meet app itself uses. Guarded in
// try/catch throughout and a no-op if the API is absent. --> needs live-instance QA.

(function () {
  const APP = window.APP;
  const JitsiMeetJS = window.JitsiMeetJS;
  if (!APP || !APP.conference || !JitsiMeetJS || !JitsiMeetJS.events) return;

  const post = (d) => {
    try {
      window.postMessage(Object.assign({ __pa_jitsi: true }, d), "*");
    } catch {
      /* ignore */
    }
  };

  const nameOf = (id) => {
    try {
      const p = APP.conference.getParticipantById && APP.conference.getParticipantById(id);
      return (p && (p.getDisplayName?.() || p._displayName)) || id;
    } catch {
      return id;
    }
  };

  let room = null;
  try {
    room = APP.conference._room; // the JitsiConference instance
  } catch {
    room = null;
  }
  if (!room || typeof room.on !== "function") return;

  const E = JitsiMeetJS.events.conference;
  const handlers = [];
  const on = (evt, fn) => {
    if (!evt) return;
    room.on(evt, fn);
    handlers.push([evt, fn]);
  };

  on(E.DOMINANT_SPEAKER_CHANGED, (id) => post({ type: "dominant", name: nameOf(id) }));
  on(E.USER_JOINED, (id, user) =>
    post({ type: "join", name: (user && user.getDisplayName?.()) || nameOf(id) }),
  );
  on(E.USER_LEFT, (id) => post({ type: "leave", name: nameOf(id) }));
  on(E.SUBJECT_CHANGED, (subject) => post({ type: "title", text: subject || "" }));

  // Emit an initial title from whatever the app already knows.
  try {
    const subj = (room.getMeetingUniqueId && APP.conference.roomName) || document.title;
    if (subj) post({ type: "title", text: String(subj) });
  } catch {
    /* ignore */
  }

  const unhook = (ev) => {
    if (ev.source !== window) return;
    if (!ev.data || ev.data.__pa_jitsi_cmd !== "unhook") return;
    for (const [evt, fn] of handlers) {
      try {
        room.off(evt, fn);
      } catch {
        /* ignore */
      }
    }
    handlers.length = 0;
    window.removeEventListener("message", unhook);
  };
  window.addEventListener("message", unhook);
})();
