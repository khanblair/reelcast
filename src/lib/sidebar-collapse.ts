/**
 * Collapsible sidebars: names, storage keys and the pre-paint restore script.
 *
 * A collapsed sidebar is expressed as `data-sidebar-<name>="collapsed"` on <html>, and the layout reacts to it in
 * CSS only (the `app-rail:` and `admin-rail:` variants in globals.css). The root layout inlines
 * SIDEBAR_INIT_SCRIPT before anything renders, so a collapsed sidebar is already collapsed on the first paint
 * instead of opening and then snapping shut. No React state is involved in the layout itself.
 *
 * This file has no React and no "use client": the (server) root layout imports it. The hook lives in
 * use-sidebar-collapse.ts.
 */

export const SIDEBARS = ["app", "admin"] as const;
export type SidebarName = (typeof SIDEBARS)[number];

export const sidebarStorageKey = (name: SidebarName) => `reelcast:sidebar:${name}`;
export const sidebarAttribute = (name: SidebarName) => `data-sidebar-${name}`;

/** Runs synchronously in <body> before the layout. Tolerates blocked storage (private mode, cookies disabled). */
export const SIDEBAR_INIT_SCRIPT = `try{var d=document.documentElement,s=localStorage;${JSON.stringify(
  SIDEBARS,
)}.forEach(function(n){if(s.getItem("reelcast:sidebar:"+n)==="collapsed")d.setAttribute("data-sidebar-"+n,"collapsed")})}catch(e){}`;
