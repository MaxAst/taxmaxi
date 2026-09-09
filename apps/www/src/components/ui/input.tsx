import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const inputVariants = cva(
  "w-full min-w-0 border border-transparent text-base transition-[color,box-shadow,background-color] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      variant: {
        default: "rounded-3xl bg-input/50",
        auth: "rounded-lg border-[#d9d2bc] bg-white text-[#1e4d40] shadow-sm placeholder:text-[#2a6857]/60 focus-visible:border-[#1e4d40] focus-visible:ring-[#1e4d40]/20 disabled:bg-[#ebe5d8] dark:border-[#2a3a35] dark:bg-[#2a3a35] dark:text-[#8ab4a3] dark:placeholder:text-[#8ab4a3]/60 dark:focus-visible:border-[#8ab4a3] dark:focus-visible:ring-[#8ab4a3]/25 dark:disabled:bg-[#23322d]",
      },
      size: {
        default: "h-9 px-3 py-1 md:text-sm",
        // 44 px tall for touch. The base `text-base` stays on small screens so
        // iOS Safari does not zoom into the field on focus.
        touch: "h-11 px-3 py-2 md:text-sm",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Input({
  className,
  type,
  variant = "default",
  size = "default",
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & VariantProps<typeof inputVariants>) {
  return (
    <input
      type={type}
      data-slot="input"
      data-variant={variant}
      data-size={size}
      className={cn(inputVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Input }
