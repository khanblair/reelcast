/**
 * Guard: every foreign key needs an index that LEADS with its column(s).
 *
 * Why it matters: Postgres does not index the referencing side of a foreign key. Deleting (or updating the key of)
 * a parent row runs `delete/update ... where <fk column> = $1` on the child table for ON DELETE CASCADE / SET NULL
 * (and a lookup for RESTRICT / NO ACTION). Without an index that is a sequential scan of the child table per parent
 * row, so deleting an account with N videos scans `ideas` N times. This test reads only the Drizzle schema (no
 * database), so it runs in CI and fails the moment a new foreign key is added without its index.
 *
 * What counts as covering an FK on columns (c1..cn): a btree index, primary key or unique constraint on the same
 * table whose first n columns are exactly c1..cn (any order). A PARTIAL index counts only when its predicate is
 * `<one of the fk columns> is not null`, because the lookups are equality (`col = $1`), which implies not null; an
 * index with any other predicate (`... where status = 'x'`) cannot serve them. Expression columns never count.
 */
import { describe, expect, test } from "bun:test";
import { is, sql, SQL } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig, index, integer, pgTable, primaryKey, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/**
 * Foreign keys that are deliberately NOT indexed, as "table.column" -> why that is safe. Keep this empty if you can:
 * an entry needs a real reason (for example a child table that is provably tiny and never grows).
 */
const ALLOWED_UNINDEXED: Record<string, string> = {};

const dialect = new PgDialect();
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
/** Compare columns by their (camelCase) property name: both sides of the comparison come from the same table. */
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function renderPredicate(where: SQL): string {
  return dialect.sqlToQuery(where).sql.replace(/"/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** True when the predicate is exactly `<column> is not null` for one of the foreign key's columns. */
function isNotNullOnFkColumn(where: SQL, fkColumns: string[]): boolean {
  const m = /^(?:\w+\.)?(\w+) is not null$/.exec(renderPredicate(where));
  return m !== null && fkColumns.some((c) => snake(c) === m[1]);
}

type AccessPath = { columns: string[]; where?: SQL };
type Uncovered = { table: string; columns: string[]; references: string };

/** Foreign keys of `tables` that no index / primary key / unique constraint leads with. */
function findUncoveredForeignKeys(tables: PgTable[]): { checked: number; uncovered: Uncovered[] } {
  let checked = 0;
  const uncovered: Uncovered[] = [];
  for (const table of tables) {
    const cfg = getTableConfig(table);
    // Every access path on this table that could serve an equality lookup, as the ordered columns it leads with.
    const paths: AccessPath[] = [];
    for (const idx of cfg.indexes) {
      if ((idx.config.method ?? "btree") !== "btree") continue;
      const columns: string[] = [];
      for (const c of idx.config.columns) {
        if (is(c as object, SQL)) break; // an expression column ends the usable prefix
        columns.push((c as { name: string }).name);
      }
      paths.push({ columns, where: idx.config.where });
    }
    for (const pk of cfg.primaryKeys) paths.push({ columns: pk.columns.map((c) => c.name) });
    for (const uc of cfg.uniqueConstraints) paths.push({ columns: uc.columns.map((c) => c.name) });
    for (const col of cfg.columns) if (col.primary || col.isUnique) paths.push({ columns: [col.name] });

    for (const fk of cfg.foreignKeys) {
      checked++;
      const ref = fk.reference();
      const fkCols = ref.columns.map((c) => c.name);
      const covered = paths.some(
        ({ columns, where }) =>
          columns.length >= fkCols.length &&
          sameSet(columns.slice(0, fkCols.length), fkCols) &&
          (where === undefined || isNotNullOnFkColumn(where, fkCols)),
      );
      if (!covered) uncovered.push({ table: cfg.name, columns: fkCols.map(snake), references: getTableConfig(ref.foreignTable).name });
    }
  }
  return { checked, uncovered };
}

const describeUncovered = (u: Uncovered) => `${u.table}(${u.columns.join(", ")}) -> ${u.references}`;
const key = (u: Uncovered) => `${u.table}.${u.columns.join(",")}`;

describe("foreign key indexes", () => {
  const isTable = (v: unknown): v is PgTable => is(v, PgTable);
  const tables = Object.values(schema as Record<string, unknown>).filter(isTable);

  test("the schema exports the tables and foreign keys this guard is meant to check", () => {
    // Positive control: an empty result must never pass vacuously (a renamed import or a broken filter).
    expect(tables.length).toBeGreaterThanOrEqual(20);
    expect(findUncoveredForeignKeys(tables).checked).toBeGreaterThanOrEqual(20);
  });

  test("every foreign key column has an index that leads with it (add the index, or justify it in ALLOWED_UNINDEXED)", () => {
    const { uncovered } = findUncoveredForeignKeys(tables);
    const unexpected = uncovered.filter((u) => !(key(u) in ALLOWED_UNINDEXED)).map(describeUncovered);
    expect(
      unexpected,
      "These foreign keys have no covering index, so deleting a parent row scans the child table once per parent row. " +
        "Add index(...).on(<fk column>) (add .where(sql`<col> is not null`) for a nullable column) in schema.ts, then `bun run db:generate`.",
    ).toEqual([]);
  });

  test("ALLOWED_UNINDEXED has no stale entries (each one names a real, still-uncovered foreign key and a reason)", () => {
    const uncoveredKeys = new Set(findUncoveredForeignKeys(tables).uncovered.map(key));
    for (const [k, why] of Object.entries(ALLOWED_UNINDEXED)) {
      expect(uncoveredKeys.has(k), `${k} is allow-listed but is covered or no longer exists; remove the entry`).toBe(true);
      expect(why.trim().length, `${k} needs a justification`).toBeGreaterThan(20);
    }
  });
});

describe("the guard itself", () => {
  const parent = pgTable("parent", { id: uuid().primaryKey() });
  const check = (child: PgTable) => findUncoveredForeignKeys([child]).uncovered.map(describeUncovered);

  test("reports a foreign key with no index at all", () => {
    const child = pgTable("child_none", { id: uuid().primaryKey(), parentId: uuid().references(() => parent.id) });
    expect(check(child)).toEqual(["child_none(parent_id) -> parent"]);
  });

  test("accepts a plain index, a composite index that leads with the column, and a unique index", () => {
    const plain = pgTable("child_plain", { id: uuid().primaryKey(), parentId: uuid().references(() => parent.id) }, (t) => [index("c1").on(t.parentId)]);
    const composite = pgTable(
      "child_composite",
      { id: uuid().primaryKey(), parentId: uuid().references(() => parent.id), at: integer() },
      (t) => [index("c2").on(t.parentId, t.at)],
    );
    const uniq = pgTable("child_unique", { id: uuid().primaryKey(), parentId: uuid().references(() => parent.id) }, (t) => [uniqueIndex("c3").on(t.parentId)]);
    expect([check(plain), check(composite), check(uniq)]).toEqual([[], [], []]);
  });

  test("accepts a primary key, a unique constraint, and an inline primary key / unique column", () => {
    const pk = pgTable("child_pk", { parentId: uuid().references(() => parent.id), n: integer() }, (t) => [primaryKey({ columns: [t.parentId, t.n] })]);
    const uc = pgTable("child_uc", { id: uuid().primaryKey(), parentId: uuid().references(() => parent.id) }, (t) => [unique("c4").on(t.parentId)]);
    const inlinePk = pgTable("child_inline_pk", { parentId: uuid().primaryKey().references(() => parent.id) });
    const inlineUnique = pgTable("child_inline_unique", { id: uuid().primaryKey(), parentId: uuid().unique().references(() => parent.id) });
    expect([check(pk), check(uc), check(inlinePk), check(inlineUnique)]).toEqual([[], [], [], []]);
  });

  test("does not accept an index where the foreign key is not the first column", () => {
    const child = pgTable(
      "child_second",
      { id: uuid().primaryKey(), parentId: uuid().references(() => parent.id), at: integer() },
      (t) => [index("c5").on(t.at, t.parentId)],
    );
    expect(check(child)).toEqual(["child_second(parent_id) -> parent"]);
  });

  test("does not accept an expression index on the column", () => {
    const child = pgTable(
      "child_expr",
      { id: uuid().primaryKey(), parentId: uuid().references(() => parent.id) },
      () => [index("c6").on(sql`(parent_id::text)`)],
    );
    expect(check(child)).toEqual(["child_expr(parent_id) -> parent"]);
  });

  test("accepts a partial index only when its predicate is `<fk column> is not null`", () => {
    const notNull = pgTable(
      "child_partial_ok",
      { id: uuid().primaryKey(), parentId: uuid().references(() => parent.id) },
      (t) => [index("c7").on(t.parentId).where(sql`parent_id is not null`)],
    );
    const other = pgTable(
      "child_partial_bad",
      { id: uuid().primaryKey(), parentId: uuid().references(() => parent.id), status: integer() },
      (t) => [index("c8").on(t.parentId).where(sql`status = 1`)],
    );
    expect(check(notNull)).toEqual([]);
    expect(check(other)).toEqual(["child_partial_bad(parent_id) -> parent"]);
  });
});
