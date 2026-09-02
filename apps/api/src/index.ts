import { closePool } from "@easycal/db";
import { loadEnv } from "./env.js";
import { buildServer } from "./server.js";

const env = loadEnv();
const app = await buildServer(env);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app
      .close()
      .then(closePool)
      .then(() => process.exit(0));
  });
}

await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
