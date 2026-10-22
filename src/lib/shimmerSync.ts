/**
 * Every skeleton's shimmer sweeps in step, whenever it was mounted. A CSS
 * animation starts at its first keyframe when its element appears, so a
 * skeleton that replaces another — the home page's code arriving, then its
 * data — would start the sweep over mid-pass. Starting each sweep from the
 * document timeline's origin instead puts every one at the same place in its
 * pass, and a hand-over carries the sweep on unbroken.
 *
 * The sweep runs on the skeleton's ::after, whose animations an element's
 * own getAnimations() does not list; `subtree` does.
 */
export const SHIMMER_ANIMATION_NAME = "shimmer-sweep";

export function syncShimmerSweeps(target: Document = document) {
  const align = (event: AnimationEvent) => {
    if (event.animationName !== SHIMMER_ANIMATION_NAME) return;
    const element = event.target;
    if (!(element instanceof Element) || !element.getAnimations) return;
    for (const animation of element.getAnimations({ subtree: true })) {
      if (
        (animation as CSSAnimation).animationName === SHIMMER_ANIMATION_NAME
      ) {
        animation.startTime = 0;
      }
    }
  };
  target.addEventListener("animationstart", align);
  return () => target.removeEventListener("animationstart", align);
}
