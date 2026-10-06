// Shared browser-context measurement for the Playwright and gstack smoke runners.
// Only temporary DOM fixtures are changed; no application state is written.
/* global document, window, getComputedStyle */
export function measureQueueCapsule(count = null) {
  const pill = document.getElementById("loose-ends-pill");
  const capsule = document.getElementById("queue-pill");
  const nav = document.getElementById("date-nav");
  if (!pill || !capsule || !nav) return null;
  const wasHidden = pill.hidden;
  const badges = [...capsule.querySelectorAll(".queue-seg-count")];
  const saved = badges.map(badge => [badge.textContent, badge.style.display]);
  try {
    pill.hidden = false;
    if (count !== null) badges.forEach(badge => {
      badge.textContent = String(count);
      badge.style.display = badge.id === "waiting-pill-nav-count" && count === 0 ? "none" : "";
    });
    const capsuleBox = capsule.getBoundingClientRect();
    const navBox = nav.getBoundingClientRect();
    const doors = [...capsule.querySelectorAll(".queue-seg")];
    const doorBoxes = doors.map(door => door.getBoundingClientRect());
    const otherBottoms = [...nav.children]
      .filter(child => child !== capsule && getComputedStyle(child).display !== "none")
      .map(child => child.getBoundingClientRect().bottom);
    const mobile = window.innerWidth <= 760;
    return {
      looseEndsVisible: getComputedStyle(pill).display !== "none" && pill.getBoundingClientRect().width > 0,
      fiveDoorsInOrder: doors.map(door => door.id).join() === "triage-pill-nav,loose-ends-pill,waiting-pill-nav,unscheduled-pill-nav,whenever-pill-nav",
      dedicatedRow: !mobile || capsuleBox.top >= Math.max(...otherBottoms),
      doorsShareOneRow: doorBoxes.every(door => Math.abs(door.top - doorBoxes[0].top) < 1),
      capsuleFillsNav: !mobile || capsuleBox.width >= navBox.width - 1,
      capsuleInsideViewport: capsuleBox.left >= 0 && capsuleBox.right <= window.innerWidth,
      doorsInsideCapsule: doorBoxes.every(door => door.left >= capsuleBox.left && door.right <= capsuleBox.right + 0.5),
      capsuleLabelsUnclipped: doors.every(door => {
        const label = door.querySelector("span:first-child");
        return label.scrollWidth <= label.clientWidth && label.scrollHeight <= label.clientHeight;
      }),
      countsUnclipped: badges.every(badge => getComputedStyle(badge).display === "none" ||
        (badge.scrollWidth <= badge.clientWidth && badge.scrollHeight <= badge.clientHeight)),
      doorsTouchHeight: doorBoxes.every(door => door.height >= 44),
      doorsTouchWidth: doorBoxes.every(door => door.width >= 44)
    };
  } finally {
    pill.hidden = wasHidden;
    badges.forEach((badge, i) => {
      badge.textContent = saved[i][0];
      badge.style.display = saved[i][1];
    });
  }
}
