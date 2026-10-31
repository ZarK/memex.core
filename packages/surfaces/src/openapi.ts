import { z } from "zod";
import type { Capability, Registry } from "./registry.js";

/** JSON Schema (draft 2020-12, as OpenAPI 3.1 uses) of a zod schema, without $schema. */
export function jsonSchema(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Record<string, unknown>;
  return rest;
}

/** The JSON Schema of a capability input. Unknown fields are an error, as the registry parses them. */
export function inputSchema(cap: Capability): Record<string, unknown> {
  return jsonSchema(cap.input.strict(), "input");
}

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const ERRORS = {
  "400": errorResponse("Invalid input or JSON"),
  "401": errorResponse("No token, or a wrong one"),
  "404": errorResponse("Unknown capability or record"),
  "409": errorResponse("Conflict"),
  "422": errorResponse("Rejected"),
  "500": errorResponse("Internal error"),
};

/** OpenAPI 3.1 for every capability of the registry, with /health. */
export function openApi(registry: Registry) {
  const paths: Record<string, unknown> = {
    "/health": {
      get: {
        operationId: "health",
        summary: "Health",
        security: [],
        responses: {
          "200": {
            description: "The app runs",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status", "app", "version"],
                  properties: { status: { const: "ok" }, app: { type: "string" }, version: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  };
  for (const cap of registry.capabilities) {
    const input = inputSchema(cap);
    const output = cap.output ? jsonSchema(cap.output, "output") : { type: "object" };
    const operation = (method: "get" | "post") => ({
      operationId: `${method}_${cap.id.replace(/\./g, "_")}`,
      summary: cap.title,
      description: cap.description,
      tags: [cap.id.split(".")[1]],
      ...(method === "post"
        ? { requestBody: { required: false, content: { "application/json": { schema: input } } } }
        : {
            parameters: [
              {
                name: "input",
                in: "query",
                required: false,
                description: "The input as JSON. The fields may also be given as separate query parameters.",
                content: { "application/json": { schema: input } },
              },
            ],
          }),
      responses: { "200": { description: "The result", content: { "application/json": { schema: output } } }, ...ERRORS },
      "x-memex-kind": cap.kind,
    });
    paths[`/api/v1/${cap.id}`] = cap.kind === "read" ? { get: operation("get"), post: operation("post") } : { post: operation("post") };
  }
  return {
    openapi: "3.1.0",
    info: { title: registry.name, version: registry.version, "x-memex-app": registry.app },
    servers: [{ url: "/" }],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "The token of this launch, from the file the app record names." } },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: { code: { type: "string" }, message: { type: "string" }, field: { type: "string" }, hint: { type: "string" } },
            },
          },
        },
      },
    },
  };
}
