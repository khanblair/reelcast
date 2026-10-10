import { describe, expect, test } from "bun:test";
import { SIDEBAR_INIT_SCRIPT, SIDEBARS, sidebarAttribute, sidebarStorageKey } from "./sidebar-collapse";

/** Run the pre-paint script against a fake <html> and a fake localStorage. */
function run(stored: Record<string, string>, opts: { storageThrows?: boolean } = {}) {
  const attributes = new Map<string, string>();
  const documentElement = { setAttribute: (name: string, value: string) => attributes.set(name, value) };
  const localStorage = {
    getItem: (key: string) => {
      if (opts.storageThrows) throw new Error("SecurityError");
      return key in stored ? stored[key] : null;
    },
  };
  new Function("document", "localStorage", SIDEBAR_INIT_SCRIPT)({ documentElement }, localStorage);
  return attributes;
}

describe("sidebar pre-paint script", () => {
  test("marks only the sidebars stored as collapsed, with the attribute the CSS variants look for", () => {
    const attributes = run({ [sidebarStorageKey("admin")]: "collapsed", [sidebarStorageKey("app")]: "expanded" });
    expect([...attributes]).toEqual([[sidebarAttribute("admin"), "collapsed"]]);
    expect(sidebarAttribute("admin")).toBe("data-sidebar-admin");
  });

  test("covers every sidebar and leaves <html> alone when nothing is stored", () => {
    const all = Object.fromEntries(SIDEBARS.map((name) => [sidebarStorageKey(name), "collapsed"]));
    expect([...run(all).keys()].sort()).toEqual(SIDEBARS.map(sidebarAttribute).sort());
    expect(run({}).size).toBe(0);
  });

  test("never throws when storage is blocked", () => {
    expect(() => run({}, { storageThrows: true })).not.toThrow();
    expect(run({}, { storageThrows: true }).size).toBe(0);
  });
});
