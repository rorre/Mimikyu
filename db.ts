import { text, sqliteTable, int } from "drizzle-orm/sqlite-core";

export const recordsTable = sqliteTable("records", {
  id: int().primaryKey(),
  name: text().notNull(),
  password: text().notNull(),
  timeElapsed: int(),
  body: text(),
});
