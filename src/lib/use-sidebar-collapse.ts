"use client";

import { useEffect } from "react";
import { sidebarAttribute, sidebarStorageKey, type SidebarName } from "./sidebar-collapse";

const isCollapsed = (name: SidebarName) => document.documentElement.hasAttribute(sidebarAttribute(name));

function apply(name: SidebarName, collapsed: boolean) {
  const root = document.documentElement;
  if (collapsed) root.setAttribute(sidebarAttribute(name), "collapsed");
  else root.removeAttribute(sidebarAttribute(name));
}

function readStored(name: SidebarName): boolean | null {
  try {
    const value = localStorage.getItem(sidebarStorageKey(name));
    return value === null ? null : value === "collapsed";
  } catch {
    return null;
  }
}

function writeStored(name: SidebarName, collapsed: boolean) {
  try {
    localStorage.setItem(sidebarStorageKey(name), collapsed ? "collapsed" : "expanded");
  } catch {
    // Storage is blocked: the choice still applies for this page view, it just is not remembered.
  }
}

/** Collapse or expand a sidebar. The layout follows the <html> attribute in CSS, so nothing else needs to re-render. */
export function setSidebarCollapsed(name: SidebarName, collapsed: boolean) {
  apply(name, collapsed);
  writeStored(name, collapsed);
}

export function toggleSidebar(name: SidebarName) {
  setSidebarCollapsed(name, !isCollapsed(name));
}

/**
 * Mount once in each desktop sidebar (never in the mobile sheet). It:
 * - catches up with the saved choice if the pre-paint script did not run (stale cached HTML, blocked inline scripts);
 * - follows a change made in another tab;
 * - toggles on Ctrl/Cmd+B, but only while the sidebar is on screen (viewport at least `shortcutMinWidth` wide) and
 *   not while typing, so bold in editors and text fields keeps working.
 */
export function useSidebarCollapseBehavior(name: SidebarName, shortcutMinWidth: number) {
  useEffect(() => {
    const stored = readStored(name);
    if (stored !== null && stored !== isCollapsed(name)) apply(name, stored);

    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== sidebarStorageKey(name)) return;
      apply(name, readStored(name) === true);
    };

    const wide = window.matchMedia(`(min-width: ${shortcutMinWidth}px)`);
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "b" || !wide.matches) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      toggleSidebar(name);
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [name, shortcutMinWidth]);
}
