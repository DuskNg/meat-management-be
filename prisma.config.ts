// Tải cấu hình môi trường động dựa trên biến NODE_ENV
import dotenv from "dotenv";
import path from "path";
import { defineConfig } from "prisma/config";

const nodeEnv = process.env.NODE_ENV || "development";
dotenv.config({ path: path.resolve(process.cwd(), `.env.${nodeEnv}`) });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "npx tsx prisma/seed.mts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
