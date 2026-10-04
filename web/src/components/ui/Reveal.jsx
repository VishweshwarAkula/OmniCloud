import { motion, useReducedMotion } from "motion/react";
import { fadeUp, stagger } from "../../lib/motion";

/** Fade-up on first entering the viewport (IntersectionObserver under the hood). */
export function Reveal({ as = "div", children, className, delay = 0, ...props }) {
  const reduce = useReducedMotion();
  const M = motion[as];
  if (reduce) return <M className={className} {...props}>{children}</M>;
  return (
    <M
      className={className}
      variants={fadeUp}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-80px" }}
      transition={{ delay }}
      {...props}
    >
      {children}
    </M>
  );
}

export function RevealGroup({ as = "div", children, className, step = 0.08, ...props }) {
  const reduce = useReducedMotion();
  const M = motion[as];
  return (
    <M
      className={className}
      variants={reduce ? undefined : stagger(step)}
      initial={reduce ? undefined : "hidden"}
      whileInView={reduce ? undefined : "show"}
      viewport={{ once: true, margin: "-80px" }}
      {...props}
    >
      {children}
    </M>
  );
}

export function RevealItem({ as = "div", children, className, ...props }) {
  const reduce = useReducedMotion();
  const M = motion[as];
  return (
    <M className={className} variants={reduce ? undefined : fadeUp} {...props}>
      {children}
    </M>
  );
}
