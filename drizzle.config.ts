import { defineConfig } from "drizzle-kit";

// Run through bun so .env.local is loaded: `bun run db:generate` / `db:migrate`.
// Migrations use the session-mode connection (port 5432); the app uses the pooler.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: { url: process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL! },
});
