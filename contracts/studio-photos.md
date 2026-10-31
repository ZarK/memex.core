# Studio photo tools contract (studio.photos.*)

**Version:** 1 (25 October 2026).

Memex Studio gives Memex Photos a fixed set of photo tools. Photos shows them on its items when Studio is installed, running, and ready. The tools of Memex.Node (upscale, denoise, colorize) are not part of this contract; Photos gets them from Node ([node-api.md](node-api.md)).

Photos calls the `/api/v1` of Studio with the rules of [surfaces.md](surfaces.md). Photos sends image bytes. Studio never reads the files or the database of Photos. Studio returns new files and a recipe. Photos keeps them as linked versions of the original, with the privacy flags of the original.

## Find Studio

1. Read the app record `<apps>/studio.json` ([surfaces.md](surfaces.md#app-record)). If Studio is not installed or not running, Photos shows the Studio tools as unavailable. Photos does not start Studio.
2. Call `studio.photos.status`. Photos shows only the tools that are ready.

## Tools

| `tool` | Does | Parameters | Output |
|---|---|---|---|
| `edit` | Changes the photo as the prompt says. With a mask, only the masked area changes, and Studio puts it back into the photo at the original resolution. | `prompt` (required); `maskUploadId` (a PNG, white is the area to change); `strength` (0 to 1, default 0.6) | image |
| `expand` | Adds image area outside the edges. | `margins`: `left`, `top`, `right`, `bottom` in pixels (at least one above 0); `prompt` | image |
| `relight` | Changes the light. | `prompt` (required, the light); `direction`: `left`, `right`, `top`, `bottom`, `front`, or `back` | image |
| `face-restore` | Repairs damaged or low-resolution faces. It can change how a person looks, so Photos shows a preview first. | `fidelity` (0 to 1, default 0.7; 1 keeps the face closest to the input) | image |
| `animate` | Makes a short video from the photo. A cut candidate for v1. | `prompt`; `seconds` (2 to 10, default 5) | video |

A submit has these fields:

| Field | Meaning |
|---|---|
| `tool` | One tool from the table above. |
| `params` | The parameters of that tool, from the table above. |
| `imageUploadId` | The photo, sent first with `POST /api/v1/uploads`: JPEG, PNG, TIFF, or WebP. Photos sends the full resolution. Photos converts RAW files before it sends them. |
| `quality` | `preview` (fast, smaller) or `final`. |
| `seed` | Optional. Studio picks one when it is missing and records it. |
| `source` | `{ "app": "photos", "kind": "item", "id": "..." }`. Studio copies it into the recipe. Studio does not use it to read anything. |

## Capabilities

| Id | Kind | Input | Output |
|---|---|---|---|
| `studio.photos.status` | read | none | `ready`, `version`, and `tools`: one entry for each tool with `ready`, and `reason` and `missing` when it is not ready |
| `studio.photos.submit` | write | the fields above | `{ "job": Job }` |
| `studio.photos.get` | read | `job` (the job id) | `{ "job": Job }` |
| `studio.photos.cancel` | write | `job` | `{ "job": Job }` |

`reason` is `comfyui_not_configured`, `comfyui_unreachable`, `models_missing`, `nodes_missing`, or `gpu_too_small`. `missing` lists the names of the missing models or nodes.

## Job

```json
{
  "id": "sj_5d1f0a2b",
  "tool": "edit",
  "state": "succeeded",
  "progress": { "percent": 100, "step": "Saving" },
  "createdAt": "2026-11-18T10:00:00Z",
  "finishedAt": "2026-11-18T10:00:41Z",
  "outputs": [
    {
      "name": "image",
      "state": "ready",
      "url": "/api/v1/files/f_77a0c3",
      "mediaType": "image/png",
      "bytes": 48213377,
      "sha256": "…64 hex…",
      "width": 6000,
      "height": 4000
    }
  ],
  "recipe": {
    "tool": "edit",
    "params": { "prompt": "Remove the lamp post", "strength": 0.6 },
    "seed": 184467,
    "quality": "final",
    "workflow": { "id": "photo-edit-masked", "version": "3" },
    "models": [{ "name": "…", "sha256": "…64 hex…" }],
    "studio": "1.0.0",
    "source": { "app": "photos", "kind": "item", "id": "it_0c9e" },
    "input": { "sha256": "…64 hex…", "width": 6000, "height": 4000 },
    "output": { "width": 6000, "height": 4000 },
    "enlarged": false
  },
  "error": null
}
```

- `state` is `queued`, `running`, `succeeded`, `failed`, or `cancelled`. `error` is the error body when the state is `failed`.
- `progress` has `percent` and `step` (a short text). It can include `previewUrl` while the job runs.
- An output `state` is `ready` or `withheld`. A withheld output has `reason` and no `url`.
- `recipe.enlarged` is true when the output was made at a smaller size and then enlarged.

## Rules

- Photos gets each output from its `url` with its Bearer token. It stores the output as a derivative linked to the source item, with the recipe. The privacy flags of the source item (hidden, sensitive) carry over to the derivative.
- Studio checks every output with its sensitivity check. When an output fails the check, or when the check cannot run, Studio withholds the output: `state` is `withheld` and `reason` is `sensitivity_check` or `checker_missing`. Photos says that Studio withheld the result, and why.
- Studio does not add the input or the outputs of a Photos job to its own library. It removes the upload and the output files one hour after the job ends, at the latest.
- Photos calls `studio.photos.get` at most two times each second for one job.
- When a tool is not ready, `studio.photos.submit` fails with 503 `tool_unavailable`, with `reason` in the message and the missing names in `hint`.

## Schema and fixtures

The JSON Schema is [schemas/studio/photos.json](../schemas/studio/photos.json). [fixtures/studio-photos/](fixtures/studio-photos/) holds a status, a submit, and jobs that run, succeed, and are withheld. The Photos test double serves them. Studio's tests check that its outputs match their shape.
