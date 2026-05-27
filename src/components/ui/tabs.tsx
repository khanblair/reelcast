"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface TabsProps {
  defaultValue: string;
  children: ReactNode;
  className?: string;
  onValueChange?: (value: string) => void;
}

function Tabs({ defaultValue, children, className, onValueChange }: TabsProps) {
  const [value, setValue] = useState(defaultValue);

  function handleValueChange(newValue: string) {
    setValue(newValue);
    onValueChange?.(newValue);
  }

  return (
    <div className={cn("w-full", className)} data-tabs-value={value}>
      {typeof children === "object" && children !== null
        ? Array.isArray(children)
          ? children.map((child) => {
              if (child && typeof child === "object" && "props" in child) {
                return { ...child, props: { ...child.props, value, onValueChange: handleValueChange } };
              }
              return child;
            })
          : children
        : children}
    </div>
  );
}

interface TabsListProps {
  children: ReactNode;
  className?: string;
  value?: string;
  onValueChange?: (value: string) => void;
}

function TabsList({ children, className, value, onValueChange }: TabsListProps) {
  return (
    <div
      className={cn(
        "inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground",
        className,
      )}
    >
      {Array.isArray(children)
        ? children.map((child) => {
            if (child && typeof child === "object" && "props" in child) {
              return { ...child, props: { ...child.props, activeValue: value, onValueChange } };
            }
            return child;
          })
        : children}
    </div>
  );
}

interface TabsTriggerProps {
  value: string;
  children: ReactNode;
  className?: string;
  activeValue?: string;
  onValueChange?: (value: string) => void;
}

function TabsTrigger({ value, children, className, activeValue, onValueChange }: TabsTriggerProps) {
  const isActive = activeValue === value;
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
        isActive
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
        className,
      )}
      onClick={() => onValueChange?.(value)}
    >
      {children}
    </button>
  );
}

interface TabsContentProps {
  value: string;
  children: ReactNode;
  className?: string;
}

function TabsContent({ value: _value, children, className }: TabsContentProps) {
  return (
    <div
      className={cn("mt-4", className)}
      role="tabpanel"
    >
      {children}
    </div>
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
