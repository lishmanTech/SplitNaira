import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve openapi.json relative to the project root (works for both src/ and dist/)
const openapiPath = path.resolve(__dirname, "../../../docs/openapi.json");
const openapiSpec = JSON.parse(fs.readFileSync(openapiPath, "utf-8"));

export const docsRouter = Router();

docsRouter.use("/", swaggerUi.serve);
docsRouter.get("/", swaggerUi.setup(openapiSpec, {
  customSiteTitle: "SplitNaira API Docs",
}));

// Serve the raw OpenAPI JSON so tooling can always fetch the latest spec
docsRouter.get("/openapi.json", (_req, res) => {
  res.json(openapiSpec);
});
