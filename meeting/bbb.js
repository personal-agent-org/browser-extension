// BigBlueButton adapter (isolated content-script world).
//
// Real speaker attribution: BBB's bigbluebutton-html5 frontend marks UI with stable `data-test`
// attributes. Selectors below are grounded in the upstream source:
//   - user list container:  Styled.Content            data-test="userListContent"
//       (imports/ui/components/user-list/user-list-content/component.jsx)
//   - each participant row:  Styled.UserItemContents   data-test="userListItem" | "userListItemCurrent"
//       carrying aria-label={user.name}  (…/user-participants/…/list-item/component.tsx)
//   - active speaker:        Styled.TalkingIndicatorButton  data-test={talking ? "isTalking" : "wasTalking"}
//       with the name as its label (imports/ui/components/nav-bar/…/talking-indicator/component.tsx)
// The name is read from aria-label on the roster row (clean), and from the label text on the
// talking pill (minus the visually-hidden "#description" span BBB nests while talking).
(function () {
  const SIG_SELECTOR = "[data-test='userListContent']";
  const PARTICIPANT_SELECTOR = "[data-test='userListItem'], [data-test='userListItemCurrent']";
  const TALKING_SELECTOR = "[data-test='isTalking']";

  // Roster row: the display name is a clean attribute.
  const participantNameOf = (el) => (el?.getAttribute?.("aria-label") || "").trim();

  // Talking pill: the visible label is the name; while talking BBB also nests a hidden
  // <span id="description"> (mute hint) inside the button, so strip it from textContent.
  const talkingNameOf = (el) => {
    if (!el) return "";
    let text = el.textContent || "";
    const desc = el.querySelector?.("#description");
    if (desc && desc.textContent) text = text.replace(desc.textContent, "");
    return text.trim();
  };

  globalThis.PAMeetingRegistry.register(
    globalThis.PAMeeting.makeDomAdapter({
      name: "bigbluebutton",
      sigSelector: SIG_SELECTOR,
      participantSelector: PARTICIPANT_SELECTOR,
      talkingSelector: TALKING_SELECTOR,
      participantNameOf,
      talkingNameOf,
    }),
  );
})();
