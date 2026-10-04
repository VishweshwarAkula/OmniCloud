export const spring = { type: "spring", stiffness: 260, damping: 30, mass: 0.9 };
export const easeSpring = [0.32, 0.72, 0, 1];

export const fadeUp = {
  // transform + opacity only: animating filter/blur is a GPU repaint hog.
  hidden: { opacity: 0, y: 28 },
  show: { opacity: 1, y: 0, transition: { duration: 0.75, ease: easeSpring } },
};

export const stagger = (step = 0.07, delay = 0) => ({
  hidden: {},
  show: { transition: { staggerChildren: step, delayChildren: delay } },
});
