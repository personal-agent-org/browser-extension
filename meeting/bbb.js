// BigBlueButton adapter (isolated content-script world).
//
// Built on the shared DOM-observer factory: real MutationObserver framework, per-platform
// selectors below. bigbluebutton-html5 tags its UI with `data-test` attributes, but we could
// NOT inspect a live instance here, so the exact selector strings are TODO constants. The
// framework (detect + talking/participant diffing) is real; only these strings need verifying.
//
// Source to verify against: https://github.com/bigbluebutton/bigbluebutton
//   bigbluebutton-html5/imports/ui/components/{user-list,nav-bar,...}
(function () {
  // TODO(bbb): confirm against bigbluebutton-html5. The user list panel is a stable signature.
  const SIG_SELECTOR = "[data-test='userListContent'], [data-test='userList']";
  // TODO(bbb): each participant row.
  const PARTICIPANT_SELECTOR = "[data-test='userListItem']";
  // TODO(bbb): BBB renders a talking indicator; verify its attribute/marker.
  const TALKING_SELECTOR = "[data-test='talkingIndicatorElement'], [data-test='isTalking']";

  globalThis.PAMeetingRegistry.register(
    globalThis.PAMeeting.makeDomAdapter({
      name: "bigbluebutton",
      sigSelector: SIG_SELECTOR,
      participantSelector: PARTICIPANT_SELECTOR,
      talkingSelector: TALKING_SELECTOR,
      // TODO(bbb): the display name typically lives in an aria-label / data-test-user-name.
      nameOf: (el) =>
        (
          (el &&
            (el.getAttribute?.("data-test-user-name") ||
              el.getAttribute?.("aria-label") ||
              el.textContent)) ||
          ""
        ).trim(),
    }),
  );
})();
