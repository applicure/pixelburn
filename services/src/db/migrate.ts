import { loadConfig } from "../config.js";
import { createDb, runMigrations } from "./client.js";

const cfg = loadConfig();
const h = createDb(cfg.DATABASE_URL, { max: 1 });
await runMigrations(h);
console.log("migrations applied");
await h.close();
