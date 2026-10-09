import Link from "next/link";
import type { Route } from "next";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * A link that looks like a small outline button. Use it instead of nesting a Button inside a Link,
 * which is invalid HTML and gives keyboard users two tab stops for one action.
 */
export function LinkButton({
  href,
  className,
  ...props
}: Omit<ComponentProps<typeof Link>, "href"> & { href: string }) {
  return (
    <Link
      href={href as Route}
      className={cn(
        "inline-flex h-8 items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        className
      )}
      {...props}
    />
  );
}
