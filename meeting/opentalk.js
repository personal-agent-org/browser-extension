// OpenTalk adapter (isolated content-script world).
//
// Same shape as the BigBlueButton adapter: real DOM-observer framework, TODO selector
// constants. We could NOT inspect a live OpenTalk web frontend here, so verify the strings
// against the upstream frontend before relying on speaker attribution.
//
// Source to verify against: https://gitlab.opencode.de/opentalk/web-frontend (controller frontend)
(function () {
  // TODO(opentalk): confirm the participant-list / meeting container signature.
  const SIG_SELECTOR = "[data-testid='ParticipantList'], [class*='MeetingView']";
  // TODO(opentalk): each participant entry.
  const PARTICIPANT_SELECTOR = "[data-testid='participant'], [data-testid='ParticipantListItem']";
  // TODO(opentalk): the active-speaker / talking marker.
  const TALKING_SELECTOR = "[data-testid='isSpeaking'], [class*='activeSpeaker']";

  globalThis.PAMeetingRegistry.register(
    globalThis.PAMeeting.makeDomAdapter({
      name: "opentalk",
      sigSelector: SIG_SELECTOR,
      participantSelector: PARTICIPANT_SELECTOR,
      talkingSelector: TALKING_SELECTOR,
      // TODO(opentalk): confirm where the display name is rendered.
      nameOf: (el) =>
        (
          (el && (el.getAttribute?.("data-display-name") || el.textContent)) ||
          ""
        ).trim(),
    }),
  );
})();
