// Jitsi Meet adapter (isolated content-script world).
//
// The isolated world cannot see the page's `window.APP` / `window.JitsiMeetJS`, so the real
// speaker/join/leave events are read by a page-context hook (meeting/jitsi-inject.js, a
// web_accessible_resource injected as a <script>) that postMessages them back here. Detection
// falls back to a DOM signature so it also works before the page JS is probed.

(function () {
  const ext = globalThis.browser ?? globalThis.chrome;

  // Jitsi Meet renders a large-video stage + per-participant video tiles. These ids/classes are
  // stable across the Jitsi Meet web app regardless of the (self-hosted) domain.
  const SIG = "#largeVideoContainer, #videoconference_page, div.videocontainer, #new-toolbox";

  let msgHandler = null;
  let injected = false;
  const dominant = { name: null };

  function injectHook() {
    if (injected) return;
    injected = true;
    const s = document.createElement("script");
    s.src = ext.runtime.getURL("meeting/jitsi-inject.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }

  globalThis.PAMeetingRegistry.register({
    name: "jitsi",
    detect(win) {
      try {
        // Page globals (visible when a test injects them, or in same-world contexts)...
        if (win && win.APP && win.APP.conference) return true;
        if (win && win.JitsiMeetJS) return true;
        // ...otherwise the DOM signature, which the isolated world CAN read.
        const d = win && win.document;
        return !!(d && d.querySelector && d.querySelector(SIG));
      } catch {
        return false;
      }
    },
    start(emit) {
      msgHandler = (ev) => {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.__pa_jitsi !== true) return;
        if (d.type === "dominant") {
          const name = d.name || "Sprecher";
          if (dominant.name && dominant.name !== name) {
            emit.speaker("tab", dominant.name, "stop");
          }
          dominant.name = name;
          emit.speaker("tab", name, "start");
        } else if (d.type === "join") {
          emit.meta("join", d.name || "", "");
        } else if (d.type === "leave") {
          emit.meta("leave", d.name || "", "");
        } else if (d.type === "title" && d.text) {
          emit.meta("title", "", d.text);
        }
      };
      window.addEventListener("message", msgHandler);
      injectHook();
    },
    stop() {
      if (msgHandler) window.removeEventListener("message", msgHandler);
      msgHandler = null;
      if (dominant.name) dominant.name = null;
      try {
        window.postMessage({ __pa_jitsi_cmd: "unhook" }, "*");
      } catch {
        /* page gone */
      }
    },
  });
})();
