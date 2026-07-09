// OpenTalk adapter (isolated content-script world).
//
// OpenTalk's web frontend is a React + LiveKit app. Grounded in the upstream source
// (gitlab.opencode.de/opentalk/web-frontend, app/src/components):
//   - meeting view containers:  data-testid="SpeakerView-Container" | "cinemaCell" | "ParticipantWindow"
//   - per participant tile:     ParticipantWindow  data-testid="ParticipantWindow"
//   - display name:             AvatarContainer     data-testid="avatarContainer"  (renders {displayName})
//
// IMPORTANT — no DOM speaker attribution: the active speaker comes from LiveKit's
// useSpeakingParticipants() hook and is applied ONLY as CSS (GridCell's `highlight` prop is
// stripped via styled `shouldForwardProp`, GridView/GridCell.tsx). There is no DOM attribute or
// stable class for "who is talking", and the LiveKit Room lives in redux (state.livekit.room),
// not on window — so a content script cannot attribute utterances to names the way it can for
// Jitsi/BigBlueButton. We therefore omit `talkingSelector` and set `attributesSpeakers:false`,
// which makes the offscreen capture segment the tab audio itself (energy VAD, generic "Sprecher"
// label) so a full transcript is still produced; the participant roster below still names who was
// present (best-effort: the name is only in the DOM while a tile shows its avatar).
(function () {
  const SIG_SELECTOR =
    "[data-testid='SpeakerView-Container'], [data-testid='cinemaCell'], [data-testid='ParticipantWindow']";
  const PARTICIPANT_SELECTOR = "[data-testid='ParticipantWindow']";

  // The display name is rendered as the AvatarContainer's text; present when the tile shows an
  // avatar (camera off). Fall back to a data-display-name attribute if a future build adds one.
  const participantNameOf = (el) => {
    if (!el) return "";
    const avatar = el.querySelector?.("[data-testid='avatarContainer']");
    const name = (avatar?.textContent || el.getAttribute?.("data-display-name") || "").trim();
    return name;
  };

  globalThis.PAMeetingRegistry.register(
    globalThis.PAMeeting.makeDomAdapter({
      name: "opentalk",
      sigSelector: SIG_SELECTOR,
      participantSelector: PARTICIPANT_SELECTOR,
      // No talkingSelector: OpenTalk keeps speaking state out of the DOM (see header).
      attributesSpeakers: false,
      participantNameOf,
    }),
  );
})();
