"use client";

import { motion } from "framer-motion";
import { Fan } from "lucide-react";
import { cn } from "@/lib/utils";

interface FanIconProps {
  /** Whether the fan is currently running. When true, the icon spins. */
  spinning: boolean;
  className?: string;
  /** Optional override for the icon color; defaults to currentColor. */
  colorClassName?: string;
}

/**
 * Animated fan icon used on device cards. When `spinning` is true,
 * the icon rotates continuously with framer-motion's loop animation.
 */
export function FanIcon({ spinning, className, colorClassName }: FanIconProps) {
  return (
    <motion.span
      className={cn("inline-flex", className)}
      animate={spinning ? { rotate: 360 } : { rotate: 0 }}
      transition={
        spinning
          ? { duration: 1.2, ease: "linear", repeat: Infinity }
          : { duration: 0.2 }
      }
      aria-hidden="true"
    >
      <Fan className={cn("size-full", colorClassName)} />
    </motion.span>
  );
}
