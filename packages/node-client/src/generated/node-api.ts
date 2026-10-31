// Generated from openapi/node.v1.yaml by scripts/generate.mjs. Do not edit.
// The sha256 of the contract file (LF line ends): b40c9c03a689035238f064530dfce697e0021acaf1bf9e5c1a30b10ba7e36d66

export const NODE_CONTRACT_SHA256 = "b40c9c03a689035238f064530dfce697e0021acaf1bf9e5c1a30b10ba7e36d66";

/** The one error body of every Memex HTTP API, MCP tool error, and CLI --json failure. See contracts/surfaces.md. */
export interface ErrorBody {
  error: ErrorDetail;
}

export interface ErrorDetail {
  code: string;
  message: string;
  field?: string;
  hint?: string;
}

export interface Health {
  /** draining after POST /v1/drain: a newer copy takes over. A client reads the app record again. */
  status: "ok" | "draining";
  app: "node";
  version: string;
}

export interface Status {
  version: string;
  startedAt: string;
  devices: StatusDevicesItem[];
  lanes: Record<string, StatusLanesValue>;
  leases: number;
  sessions: number;
  backends: number;
}

export interface StatusDevicesItem {
  id: string;
  kind: "gpu" | "cpu";
  name: string;
  memoryBytes?: number;
  freeMemoryBytes?: number;
  provider?: "webgpu" | "coreml" | "cpu";
}

export interface StatusLanesValue {
  running: number;
  waiting: number;
}

export interface Drain {
  draining: true;
  /** The process that drains. It exits when held is 0, or after the drain time. */
  pid: number;
  version: string;
  /** Requests, streams, and leases that Node still serves. */
  held: number;
}

/** The app id from contracts/storage.md. */
export type AppId = string;

/** <app>.<name>, for example photos.food-reading. */
export type FunctionId = string;

export type Lane = "live" | "interactive" | "background" | "idle";

export type BatchKey = string;

export type Sha256 = string;

export interface ModelPin {
  id: string;
  sha256?: Sha256;
  fingerprint?: Sha256;
}

export interface Wait {
  /** Known values: queued, higher-lane, live-session, batching, model-loading, model-swap, device-busy, lease-held, backend-limit, backend-down, pack-missing, idle-only. A client shows detail for a value that it does not know. */
  reason: string;
  /** A sentence that an app can show. */
  detail: string;
  since: string;
  /** Work that Node starts before this one. */
  ahead?: number;
  /** Set for backend-down. */
  retryAt?: string;
}

/** An input file, by upload or inline (at most 4 MiB after decoding). */
export interface Bytes {
  upload?: string;
  base64?: string;
  mediaType?: string;
}

export interface Upload {
  id: string;
  sha256: Sha256;
  bytes: number;
  mediaType: string;
  expiresAt: string;
}

export interface FunctionDeclaration {
  name: string;
  /** The Node capabilities that the function uses. */
  capabilities: string[];
  lane: Lane;
  runsIn: "node" | "app";
  required: boolean;
  /** The packs of the default model, in Node's catalog. */
  packs: string[];
}

export interface Registration {
  app: AppId;
  version: string;
  minNodeVersion?: string;
  functions: FunctionDeclaration[];
}

export interface RegistrationResult {
  node: RegistrationResultNode;
  functions: FunctionState[];
}

export interface RegistrationResultNode {
  id: string;
  version: string;
}

export interface FunctionState {
  id: FunctionId;
  app: AppId;
  capabilities: string[];
  lane: Lane;
  runsIn: "node" | "app";
  route: Route;
  state: "ready" | "needs-pack" | "needs-acceptance" | "needs-backend" | "unavailable";
  /** A sentence that an app can show when the state is not ready. */
  reason?: string;
  models?: ModelPin[];
}

export interface Route {
  kind: "auto" | "url" | "node";
  backend?: string;
  model?: string;
  /** The most calls of the function at this backend. */
  concurrency?: number;
  /** More servers. The function shares its calls between them. */
  also?: RouteTarget[];
}

export interface RouteTarget {
  backend: string;
  model: string;
  concurrency?: number;
}

export interface Capability {
  name: string;
  call: "run" | "job" | "openai" | "session" | "lease";
  engine?: "onnx" | "generative" | "backend";
  models?: ModelPin[];
  state: "ready" | "needs-pack" | "needs-backend" | "unavailable";
  reason?: string;
}

export interface Routes {
  /** auto or url. node (every function without its own route goes to another Node) is reserved for v2. */
  default: Route;
  functions: Record<string, Route>;
}

export interface WorkFields {
  app: AppId;
  function: FunctionId;
  lane?: Lane;
  model?: ModelPin;
  batchKey?: BatchKey;
}

export interface RunRequest {
  app: AppId;
  function: FunctionId;
  lane?: Lane;
  model?: ModelPin;
  batchKey?: BatchKey;
  /** The input of the capability: EmbedTextInput, ImagesInput (embed.image, ocr, faces, sensitivity.check), or ImageTagsInput. */
  input: Record<string, unknown>;
  deadlineMs?: number;
}

export interface RunResult {
  /** The output of the capability: EmbedOutput, ImageTagsOutput, OcrOutput, FacesOutput, or SensitivityOutput. */
  result: Record<string, unknown>;
  record: ResultRecord;
}

export interface ResultRecord {
  node: ResultRecordNode;
  app: AppId;
  function: FunctionId;
  capability: string;
  route: "auto" | "url" | "node";
  engine: "onnx" | "generative" | "backend";
  backend: ResultRecordBackend | null;
  models: ModelUsed[];
  device: string | null;
  lane: Lane;
  batchKey: BatchKey | null;
  queuedMs: number;
  runMs: number;
  finishedAt: string;
}

export interface ResultRecordNode {
  id: string;
  version: string;
}

export interface ResultRecordBackend {
  id: string;
  type: "openai" | "node";
  url: string;
}

export interface ModelUsed {
  id: string;
  version?: string;
  sha256?: Sha256;
  fingerprint?: Sha256;
}

export interface JobRequest {
  app: AppId;
  function: FunctionId;
  lane?: Lane;
  model?: ModelPin;
  batchKey?: BatchKey;
  /** The input of the capability: FoodInput or ImageToolInput. */
  input: Record<string, unknown>;
}

export type JobState = "waiting" | "running" | "succeeded" | "failed" | "cancelled";

export interface Job {
  id: string;
  app: AppId;
  function: FunctionId;
  lane: Lane;
  model?: ModelPin | null;
  batchKey?: BatchKey | null;
  state: JobState;
  wait: Wait | null;
  progress: JobProgress | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The output of the capability (FoodOutput, ImageToolOutput) when the job succeeded. */
  result: Record<string, unknown> | null;
  outputs: JobOutputsItem[];
  record: ResultRecord | null;
  error: ErrorBody | null;
}

export interface JobProgress {
  done: number;
  total: number;
  unit: string;
}

export interface JobOutputsItem {
  name: string;
  mediaType: string;
  bytes: number;
  sha256: Sha256;
  preview: boolean;
}

export interface JobEnvelope {
  job: Job;
}

export interface LeaseRequest {
  app: AppId;
  function: FunctionId;
  lane?: Lane;
  model?: ModelPin;
  batchKey?: BatchKey;
  /** gpu for any GPU, or gpu:<index>. */
  device: string;
  /** The device memory that the app expects to use. */
  memoryBytes: number;
}

export interface Lease {
  id: string;
  app: AppId;
  function: FunctionId;
  lane: Lane;
  model?: ModelPin | null;
  batchKey?: BatchKey | null;
  state: "waiting" | "granted" | "yielding" | "ended";
  device: string | null;
  wait: Wait | null;
  yieldBy: string | null;
  expiresAt: string;
}

export interface LeaseEnvelope {
  lease: Lease;
}

export interface QueueItem {
  id: string;
  type: "run" | "job" | "lease" | "session";
  app: AppId;
  function: FunctionId;
  lane: Lane;
  model?: ModelPin | null;
  batchKey?: BatchKey | null;
  state: "waiting" | "running";
  wait: Wait | null;
  since: string;
}

export interface SessionRequest {
  app: AppId;
  function: FunctionId;
  modalities: Array<"audio" | "image">;
  instructions?: string;
  voice?: string;
}

export interface Session {
  id: string;
  function: FunctionId;
  pipeline: "node" | "relay";
  /** The backend id for a relay. */
  backend: string | null;
  /** Open the WebSocket before this time. */
  expiresAt: string;
  url: string;
}

export interface Pack {
  id: string;
  title: string;
  kind: "model" | "map" | "data" | "corpus" | "tool";
  state: "not-installed" | "installing" | "installed" | "needs-acceptance" | "refused";
  /** The active version. */
  active: string | null;
  versions: PackVersionsItem[];
  /** The license object of the manifest (schemas/packs/pack.json). */
  license: Record<string, unknown>;
  acceptance?: PackAcceptance;
  install: PackInstall | null;
  /** The folder of the active version. */
  path: string | null;
  usedBy: AppId[];
  manifest?: Record<string, unknown>;
}

export interface PackVersionsItem {
  version: string;
  digest: Sha256;
  bytes: number;
  installed: boolean;
}

export interface PackAcceptance {
  needed: boolean;
  textSha256: Sha256 | null;
}

export interface PackInstall {
  version: string;
  phase?: "downloading" | "verifying" | "activating" | "done" | "failed";
  bytesDone: number;
  bytesTotal: number;
  startedAt: string;
  error?: PackProgressError | null;
}

export interface PackProgressError {
  code: string;
  message: string;
}

export interface PackLocation {
  path: string;
  move: PackLocationMove | null;
  warning: PackLocationWarning | null;
  /** For a move that starts, the new folder and its sync warning. */
  target?: PackLocationTarget;
}

/** The last move; it stays after it ends. */
export interface PackLocationMove {
  to: string;
  phase?: "copying" | "checking" | "removing" | "done" | "failed";
  bytesDone: number;
  bytesTotal: number;
  error?: PackProgressError | null;
}

export interface PackLocationWarning {
  /** The sync client that covers the folder. */
  client: string;
  text?: string;
}

/** For a move that starts, the new folder and its sync warning. */
export interface PackLocationTarget {
  path?: string;
  warning?: PackLocationTargetWarning | null;
}

export interface PackLocationTargetWarning {
  client: string;
  text?: string;
}

export interface BackendModel {
  id: string;
  capabilities: Array<"chat" | "vision" | "embed.text" | "stt" | "tts" | "realtime">;
}

export interface Backend {
  id: string;
  type: "openai" | "node";
  url: string;
  label: string;
  /** True for a loopback or private address. */
  local: boolean;
  state: "available" | "unavailable";
  models: BackendModel[];
  /** The limit of calls from Node at the same time now. */
  concurrency: number;
  concurrencyFrom?: "set" | "reported" | "learned";
  hasKey: boolean;
  lastProbeAt?: string | null;
}

export interface BackendCreate {
  url: string;
  type: "openai" | "node";
  label?: string;
  apiKey?: string;
  concurrency?: number;
}

export interface BackendPatch {
  label?: string;
  /** null removes the stored key. */
  apiKey?: string | null;
  /** The limit of the user. null removes it. */
  concurrency?: number | null;
  /** The capabilities that the user sets for each model. */
  models?: BackendModel[];
}

export interface EmbedTextInput {
  texts: string[];
  type: "query" | "passage";
}

export interface ImagesInput {
  images: Bytes[];
}

export interface ImageTagsInput {
  images: Bytes[];
  labels?: string[];
}

export interface EmbedOutput {
  /** L2-normalized, one for each input. */
  vectors: number[][];
  dims: number;
}

/** [x, y, width, height] in pixels of the input image. */
export type Box = number[];

export interface ImageTagsOutput {
  results: ImageTagsOutputResultsItem[];
}

export interface ImageTagsOutputResultsItem {
  tags: ImageTagsOutputResultsItemTagsItem[];
}

export interface ImageTagsOutputResultsItemTagsItem {
  label: string;
  score: number;
}

export interface OcrOutput {
  results: OcrOutputResultsItem[];
}

export interface OcrOutputResultsItem {
  text: string;
  lines: OcrOutputResultsItemLinesItem[];
}

export interface OcrOutputResultsItemLinesItem {
  text: string;
  box: Box;
  score: number;
}

export interface FacesOutput {
  results: FacesOutputResultsItem[];
}

export interface FacesOutputResultsItem {
  faces: FacesOutputResultsItemFacesItem[];
}

export interface FacesOutputResultsItemFacesItem {
  box: Box;
  score: number;
  landmarks: number[][];
  vector: number[];
}

export interface SensitivityOutput {
  results: SensitivityOutputResultsItem[];
}

export interface SensitivityOutputResultsItem {
  sensitive: boolean;
  score: number;
}

export interface FoodInput {
  /** The photos of one meal. */
  images: Bytes[];
  takenAt?: string;
}

export interface Estimate {
  value: number;
  low: number;
  high: number;
}

export interface FoodOutput {
  /** The food check. */
  food: boolean;
  foodScore?: number;
  /** The blend weights that made the values. Absent unless reading is done. */
  blend?: string;
  /** off when no reading model can run; skipped when the food check found no food. */
  reading: "done" | "off" | "skipped";
  items: FoodOutputItemsItem[];
  nutrients: FoodOutputNutrients | null;
}

export interface FoodOutputItemsItem {
  name: string;
  grams: Estimate;
}

/** Grams, except kcal. */
export interface FoodOutputNutrients {
  kcal: Estimate;
  protein: Estimate;
  fat: Estimate;
  carbs: Estimate;
  sugar?: Estimate;
  fiber?: Estimate;
  alcohol?: Estimate;
}

export interface ImageToolInput {
  image: Bytes;
  /** image.upscale only. */
  scale?: 2 | 4;
}

/** The image is the job output named "image" (16-bit PNG). */
export interface ImageToolOutput {
  recipe: ImageToolOutputRecipe;
}

export interface ImageToolOutputRecipe {
  capability: string;
  models: ModelUsed[];
  tiles: number;
  input: ImageToolOutputRecipeInput;
  output: ImageToolOutputRecipeOutput;
}

export interface ImageToolOutputRecipeInput {
  sha256: Sha256;
  width: number;
  height: number;
}

export interface ImageToolOutputRecipeOutput {
  width: number;
  height: number;
}

/** A request or response body of the OpenAI API. Node does not restate it. */
export type OpenAIObject = Record<string, unknown>;

/** An OpenAI response body with the added field memex. */
export interface OpenAIResponse {
  memex?: ResultRecord;
}

export interface ListCapabilitiesResponse {
  items: Capability[];
}

export interface ListFunctionsResponse {
  items: FunctionState[];
}

export interface CreateUploadResponse {
  upload: Upload;
}

export interface ListJobsResponse {
  items: Job[];
}

export interface GetQueueResponse {
  items: QueueItem[];
}

export interface PrepareSessionResponse {
  session: Session;
}

export interface ListPacksResponse {
  items: Pack[];
}

export interface MovePacksRequest {
  path: string;
}

export interface InstallPackRequest {
  version?: string;
}

export interface AcceptPackLicenseRequest {
  app: AppId;
  version: string;
  textSha256: Sha256;
}

export interface ListBackendsResponse {
  items: Backend[];
}

export interface DiscoverBackendsResponse {
  items: DiscoverBackendsResponseItemsItem[];
}

export interface DiscoverBackendsResponseItemsItem {
  url: string;
  type: "openai";
  models: BackendModel[];
}

export interface ListVoicesResponse {
  voices: ListVoicesResponseVoicesItem[];
}

export interface ListVoicesResponseVoicesItem {
  id: string;
  name: string;
  /** BCP 47 tag. */
  language: string;
}

/** How a response body is read. */
export type ResponseKind = "json" | "events" | "text" | "bytes" | "none" | "websocket";

/** One request of an operation, for NodeApiBase.send. */
export interface OperationRequest {
  operation: string;
  method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  body?: { kind: "json"; value: unknown } | { kind: "bytes"; value: Uint8Array; mediaType: string };
  response: ResponseKind;
  /** The status of success. */
  status: number;
}

/** A server-sent event. data is the parsed JSON when it is JSON, else the text. */
export interface NodeEvent {
  event: string;
  data: unknown;
}

/** A binary response: the bytes, their media type, and the response headers. */
export interface NodeBinary {
  mediaType: string;
  bytes: Uint8Array;
  headers: Record<string, string>;
}

/** Every operation of the contract: method, path, and how its response is read. */
export const NODE_OPERATIONS = {
  getHealth: { method: "GET", path: "/health", response: "json" },
  getStatus: { method: "GET", path: "/v1/status", response: "json" },
  drain: { method: "POST", path: "/v1/drain", response: "json" },
  registerApp: { method: "POST", path: "/v1/apps/register", response: "json" },
  listCapabilities: { method: "GET", path: "/v1/capabilities", response: "json" },
  listFunctions: { method: "GET", path: "/v1/functions", response: "json" },
  getRoutes: { method: "GET", path: "/v1/routes", response: "json" },
  putRoutes: { method: "PUT", path: "/v1/routes", response: "json" },
  createUpload: { method: "POST", path: "/v1/uploads", response: "json" },
  run: { method: "POST", path: "/v1/run", response: "json" },
  listJobs: { method: "GET", path: "/v1/jobs", response: "json" },
  createJob: { method: "POST", path: "/v1/jobs", response: "json" },
  getJob: { method: "GET", path: "/v1/jobs/{id}", response: "json" },
  deleteJob: { method: "DELETE", path: "/v1/jobs/{id}", response: "json" },
  jobEvents: { method: "GET", path: "/v1/jobs/{id}/events", response: "events" },
  getJobOutput: { method: "GET", path: "/v1/jobs/{id}/outputs/{name}", response: "bytes" },
  createLease: { method: "POST", path: "/v1/leases", response: "json" },
  getLease: { method: "GET", path: "/v1/leases/{id}", response: "json" },
  releaseLease: { method: "DELETE", path: "/v1/leases/{id}", response: "json" },
  renewLease: { method: "POST", path: "/v1/leases/{id}/renew", response: "json" },
  leaseEvents: { method: "GET", path: "/v1/leases/{id}/events", response: "events" },
  getQueue: { method: "GET", path: "/v1/queue", response: "json" },
  prepareSession: { method: "POST", path: "/v1/sessions/prepare", response: "json" },
  endSession: { method: "DELETE", path: "/v1/sessions/{id}", response: "none" },
  realtime: { method: "GET", path: "/v1/realtime", response: "websocket" },
  listPacks: { method: "GET", path: "/v1/packs", response: "json" },
  getPackLocation: { method: "GET", path: "/v1/packs/location", response: "json" },
  movePacks: { method: "PUT", path: "/v1/packs/location", response: "json" },
  getPack: { method: "GET", path: "/v1/packs/{id}", response: "json" },
  removePack: { method: "DELETE", path: "/v1/packs/{id}", response: "json" },
  installPack: { method: "POST", path: "/v1/packs/{id}/install", response: "json" },
  packEvents: { method: "GET", path: "/v1/packs/{id}/events", response: "events" },
  getPackLicense: { method: "GET", path: "/v1/packs/{id}/license", response: "text" },
  acceptPackLicense: { method: "POST", path: "/v1/packs/{id}/accept", response: "json" },
  listBackends: { method: "GET", path: "/v1/backends", response: "json" },
  addBackend: { method: "POST", path: "/v1/backends", response: "json" },
  discoverBackends: { method: "POST", path: "/v1/backends/discover", response: "json" },
  changeBackend: { method: "PATCH", path: "/v1/backends/{id}", response: "json" },
  removeBackend: { method: "DELETE", path: "/v1/backends/{id}", response: "none" },
  listModels: { method: "GET", path: "/v1/models", response: "json" },
  createChatCompletion: { method: "POST", path: "/v1/chat/completions", response: "json" },
  createEmbeddings: { method: "POST", path: "/v1/embeddings", response: "json" },
  createTranscription: { method: "POST", path: "/v1/audio/transcriptions", response: "json" },
  createSpeech: { method: "POST", path: "/v1/audio/speech", response: "bytes" },
  listVoices: { method: "GET", path: "/v1/audio/voices", response: "json" },
} as const;

export type NodeOperation = keyof typeof NODE_OPERATIONS;

/**
 * The operations of the Memex.Node API as methods. A subclass sends the requests (NodeClient: over the pipe or socket
 * of the app record). The realtime WebSocket is not a method: open realtimePath(session) on the same transport.
 */
export abstract class NodeApiBase {
  protected abstract send(request: OperationRequest): Promise<unknown>;

  /** Health without paths or user data (GET /health) */
  getHealth(): Promise<Health> {
    return this.send({ operation: "getHealth", method: "GET", path: `/health`, response: "json", status: 200 }) as Promise<Health>;
  }

  /** Version, devices, and work in each lane (GET /v1/status) */
  getStatus(): Promise<Status> {
    return this.send({ operation: "getStatus", method: "GET", path: `/v1/status`, response: "json", status: 200 }) as Promise<Status>;
  }

  /** Stop taking new work and stop when the held work ends (the service launcher, before a newer copy starts) (POST /v1/drain) */
  drain(): Promise<Drain> {
    return this.send({ operation: "drain", method: "POST", path: `/v1/drain`, response: "json", status: 202 }) as Promise<Drain>;
  }

  /** State the functions and packs of an app at start (POST /v1/apps/register) */
  registerApp(body: Registration): Promise<RegistrationResult> {
    return this.send({ operation: "registerApp", method: "POST", path: `/v1/apps/register`, body: { kind: "json", value: body }, response: "json", status: 200 }) as Promise<RegistrationResult>;
  }

  /** What Node can do now (GET /v1/capabilities) */
  listCapabilities(): Promise<ListCapabilitiesResponse> {
    return this.send({ operation: "listCapabilities", method: "GET", path: `/v1/capabilities`, response: "json", status: 200 }) as Promise<ListCapabilitiesResponse>;
  }

  /** Every registered function with its route and state (GET /v1/functions) */
  listFunctions(): Promise<ListFunctionsResponse> {
    return this.send({ operation: "listFunctions", method: "GET", path: `/v1/functions`, response: "json", status: 200 }) as Promise<ListFunctionsResponse>;
  }

  /** The default route and the route of each function (GET /v1/routes) */
  getRoutes(): Promise<Routes> {
    return this.send({ operation: "getRoutes", method: "GET", path: `/v1/routes`, response: "json", status: 200 }) as Promise<Routes>;
  }

  /** Replace the routes (settings; for an action of the user) (PUT /v1/routes) */
  putRoutes(body: Routes): Promise<Routes> {
    return this.send({ operation: "putRoutes", method: "PUT", path: `/v1/routes`, body: { kind: "json", value: body }, response: "json", status: 200 }) as Promise<Routes>;
  }

  /** Store bytes for a later call (up to 1 GiB) (POST /v1/uploads) */
  createUpload(body: Uint8Array, mediaType: string): Promise<CreateUploadResponse> {
    return this.send({ operation: "createUpload", method: "POST", path: `/v1/uploads`, body: { kind: "bytes", value: body, mediaType }, response: "json", status: 201 }) as Promise<CreateUploadResponse>;
  }

  /** A short call that returns its result (POST /v1/run) */
  run(body: RunRequest): Promise<RunResult> {
    return this.send({ operation: "run", method: "POST", path: `/v1/run`, body: { kind: "json", value: body }, response: "json", status: 200 }) as Promise<RunResult>;
  }

  /** listJobs (GET /v1/jobs) */
  listJobs(query?: { app?: AppId; state?: JobState }): Promise<ListJobsResponse> {
    return this.send({ operation: "listJobs", method: "GET", path: `/v1/jobs`, query: { "app": query?.app === undefined ? undefined : String(query.app), "state": query?.state === undefined ? undefined : String(query.state) }, response: "json", status: 200 }) as Promise<ListJobsResponse>;
  }

  /** A long call with progress, outputs, and cancel (POST /v1/jobs) */
  createJob(body: JobRequest): Promise<JobEnvelope> {
    return this.send({ operation: "createJob", method: "POST", path: `/v1/jobs`, body: { kind: "json", value: body }, response: "json", status: 202 }) as Promise<JobEnvelope>;
  }

  /** getJob (GET /v1/jobs/{id}) */
  getJob(id: string): Promise<JobEnvelope> {
    return this.send({ operation: "getJob", method: "GET", path: `/v1/jobs/${encodeURIComponent(id)}`, response: "json", status: 200 }) as Promise<JobEnvelope>;
  }

  /** Cancel a job that has not ended, or remove a job that has ended (DELETE /v1/jobs/{id}) */
  deleteJob(id: string): Promise<JobEnvelope> {
    return this.send({ operation: "deleteJob", method: "DELETE", path: `/v1/jobs/${encodeURIComponent(id)}`, response: "json", status: 200 }) as Promise<JobEnvelope>;
  }

  /** Server-sent events: 'event: job' with the full Job as data (GET /v1/jobs/{id}/events) */
  jobEvents(id: string): Promise<AsyncIterable<NodeEvent>> {
    return this.send({ operation: "jobEvents", method: "GET", path: `/v1/jobs/${encodeURIComponent(id)}/events`, response: "events", status: 200 }) as Promise<AsyncIterable<NodeEvent>>;
  }

  /** getJobOutput (GET /v1/jobs/{id}/outputs/{name}) */
  getJobOutput(id: string, name: string): Promise<NodeBinary> {
    return this.send({ operation: "getJobOutput", method: "GET", path: `/v1/jobs/${encodeURIComponent(id)}/outputs/${encodeURIComponent(name)}`, response: "bytes", status: 200 }) as Promise<NodeBinary>;
  }

  /** Ask for a device for model work in the app's own process (POST /v1/leases) */
  createLease(body: LeaseRequest): Promise<LeaseEnvelope> {
    return this.send({ operation: "createLease", method: "POST", path: `/v1/leases`, body: { kind: "json", value: body }, response: "json", status: 201 }) as Promise<LeaseEnvelope>;
  }

  /** getLease (GET /v1/leases/{id}) */
  getLease(id: string): Promise<LeaseEnvelope> {
    return this.send({ operation: "getLease", method: "GET", path: `/v1/leases/${encodeURIComponent(id)}`, response: "json", status: 200 }) as Promise<LeaseEnvelope>;
  }

  /** releaseLease (DELETE /v1/leases/{id}) */
  releaseLease(id: string): Promise<LeaseEnvelope> {
    return this.send({ operation: "releaseLease", method: "DELETE", path: `/v1/leases/${encodeURIComponent(id)}`, response: "json", status: 200 }) as Promise<LeaseEnvelope>;
  }

  /** Keep the lease (every 10 seconds) (POST /v1/leases/{id}/renew) */
  renewLease(id: string): Promise<LeaseEnvelope> {
    return this.send({ operation: "renewLease", method: "POST", path: `/v1/leases/${encodeURIComponent(id)}/renew`, response: "json", status: 200 }) as Promise<LeaseEnvelope>;
  }

  /** Server-sent events: 'event: lease' with the full Lease as data (GET /v1/leases/{id}/events) */
  leaseEvents(id: string): Promise<AsyncIterable<NodeEvent>> {
    return this.send({ operation: "leaseEvents", method: "GET", path: `/v1/leases/${encodeURIComponent(id)}/events`, response: "events", status: 200 }) as Promise<AsyncIterable<NodeEvent>>;
  }

  /** All waiting and running work, each with its wait reason (GET /v1/queue) */
  getQueue(query?: { app?: AppId }): Promise<GetQueueResponse> {
    return this.send({ operation: "getQueue", method: "GET", path: `/v1/queue`, query: { "app": query?.app === undefined ? undefined : String(query.app) }, response: "json", status: 200 }) as Promise<GetQueueResponse>;
  }

  /** Prepare a live voice or vision session (POST /v1/sessions/prepare) */
  prepareSession(body: SessionRequest): Promise<PrepareSessionResponse> {
    return this.send({ operation: "prepareSession", method: "POST", path: `/v1/sessions/prepare`, body: { kind: "json", value: body }, response: "json", status: 201 }) as Promise<PrepareSessionResponse>;
  }

  /** endSession (DELETE /v1/sessions/{id}) */
  endSession(id: string): Promise<void> {
    return this.send({ operation: "endSession", method: "DELETE", path: `/v1/sessions/${encodeURIComponent(id)}`, response: "none", status: 204 }) as Promise<void>;
  }

  /** WebSocket with the OpenAI Realtime events listed in contracts/node-api.md. The path to open as a WebSocket. */
  realtimePath(session: string): string {
    return `/v1/realtime?session=${encodeURIComponent(session)}`;
  }

  /** listPacks (GET /v1/packs) */
  listPacks(): Promise<ListPacksResponse> {
    return this.send({ operation: "listPacks", method: "GET", path: `/v1/packs`, response: "json", status: 200 }) as Promise<ListPacksResponse>;
  }

  /** getPackLocation (GET /v1/packs/location) */
  getPackLocation(): Promise<PackLocation> {
    return this.send({ operation: "getPackLocation", method: "GET", path: `/v1/packs/location`, response: "json", status: 200 }) as Promise<PackLocation>;
  }

  /** Move the store (settings; for an action of the user) (PUT /v1/packs/location) */
  movePacks(body: MovePacksRequest): Promise<PackLocation> {
    return this.send({ operation: "movePacks", method: "PUT", path: `/v1/packs/location`, body: { kind: "json", value: body }, response: "json", status: 202 }) as Promise<PackLocation>;
  }

  /** getPack (GET /v1/packs/{id}) */
  getPack(id: string): Promise<Pack> {
    return this.send({ operation: "getPack", method: "GET", path: `/v1/packs/${encodeURIComponent(id)}`, response: "json", status: 200 }) as Promise<Pack>;
  }

  /** Remove every version that no registered app pins (DELETE /v1/packs/{id}) */
  removePack(id: string): Promise<Pack> {
    return this.send({ operation: "removePack", method: "DELETE", path: `/v1/packs/${encodeURIComponent(id)}`, response: "json", status: 200 }) as Promise<Pack>;
  }

  /** installPack (POST /v1/packs/{id}/install) */
  installPack(id: string, body?: InstallPackRequest): Promise<Pack> {
    return this.send({ operation: "installPack", method: "POST", path: `/v1/packs/${encodeURIComponent(id)}/install`, body: body === undefined ? undefined : { kind: "json", value: body }, response: "json", status: 202 }) as Promise<Pack>;
  }

  /** Server-sent events: 'event: pack' with the full Pack as data (GET /v1/packs/{id}/events) */
  packEvents(id: string): Promise<AsyncIterable<NodeEvent>> {
    return this.send({ operation: "packEvents", method: "GET", path: `/v1/packs/${encodeURIComponent(id)}/events`, response: "events", status: 200 }) as Promise<AsyncIterable<NodeEvent>>;
  }

  /** getPackLicense (GET /v1/packs/{id}/license) */
  getPackLicense(id: string): Promise<string> {
    return this.send({ operation: "getPackLicense", method: "GET", path: `/v1/packs/${encodeURIComponent(id)}/license`, response: "text", status: 200 }) as Promise<string>;
  }

  /** acceptPackLicense (POST /v1/packs/{id}/accept) */
  acceptPackLicense(id: string, body: AcceptPackLicenseRequest): Promise<Pack> {
    return this.send({ operation: "acceptPackLicense", method: "POST", path: `/v1/packs/${encodeURIComponent(id)}/accept`, body: { kind: "json", value: body }, response: "json", status: 200 }) as Promise<Pack>;
  }

  /** listBackends (GET /v1/backends) */
  listBackends(): Promise<ListBackendsResponse> {
    return this.send({ operation: "listBackends", method: "GET", path: `/v1/backends`, response: "json", status: 200 }) as Promise<ListBackendsResponse>;
  }

  /** Add a backend (settings; for an action of the user) (POST /v1/backends) */
  addBackend(body: BackendCreate): Promise<Backend> {
    return this.send({ operation: "addBackend", method: "POST", path: `/v1/backends`, body: { kind: "json", value: body }, response: "json", status: 201 }) as Promise<Backend>;
  }

  /** Look for backends on 127.0.0.1 at the ports 11434, 1234, 8080, and 8000. Adds nothing. (POST /v1/backends/discover) */
  discoverBackends(): Promise<DiscoverBackendsResponse> {
    return this.send({ operation: "discoverBackends", method: "POST", path: `/v1/backends/discover`, response: "json", status: 200 }) as Promise<DiscoverBackendsResponse>;
  }

  /** changeBackend (PATCH /v1/backends/{id}) */
  changeBackend(id: string, body: BackendPatch): Promise<Backend> {
    return this.send({ operation: "changeBackend", method: "PATCH", path: `/v1/backends/${encodeURIComponent(id)}`, body: { kind: "json", value: body }, response: "json", status: 200 }) as Promise<Backend>;
  }

  /** removeBackend (DELETE /v1/backends/{id}) */
  removeBackend(id: string): Promise<void> {
    return this.send({ operation: "removeBackend", method: "DELETE", path: `/v1/backends/${encodeURIComponent(id)}`, response: "none", status: 204 }) as Promise<void>;
  }

  /** OpenAI List models (GET /v1/models) */
  listModels(headers: { memexApp: AppId }): Promise<OpenAIObject> {
    return this.send({ operation: "listModels", method: "GET", path: `/v1/models`, headers: { "Memex-App": headers?.memexApp }, response: "json", status: 200 }) as Promise<OpenAIObject>;
  }

  /** OpenAI Chat Completions, with streaming and image input (POST /v1/chat/completions) */
  createChatCompletion(headers: { memexApp: AppId; memexFunction: FunctionId; memexLane?: Lane; memexBatchKey?: BatchKey }, body: OpenAIObject): Promise<OpenAIResponse> {
    return this.send({ operation: "createChatCompletion", method: "POST", path: `/v1/chat/completions`, headers: { "Memex-App": headers?.memexApp, "Memex-Function": headers?.memexFunction, "Memex-Lane": headers?.memexLane, "Memex-Batch-Key": headers?.memexBatchKey }, body: { kind: "json", value: body }, response: "json", status: 200 }) as Promise<OpenAIResponse>;
  }

  /** OpenAI Embeddings (POST /v1/embeddings) */
  createEmbeddings(headers: { memexApp: AppId; memexFunction: FunctionId; memexLane?: Lane; memexBatchKey?: BatchKey }, body: OpenAIObject): Promise<OpenAIResponse> {
    return this.send({ operation: "createEmbeddings", method: "POST", path: `/v1/embeddings`, headers: { "Memex-App": headers?.memexApp, "Memex-Function": headers?.memexFunction, "Memex-Lane": headers?.memexLane, "Memex-Batch-Key": headers?.memexBatchKey }, body: { kind: "json", value: body }, response: "json", status: 200 }) as Promise<OpenAIResponse>;
  }

  /** OpenAI Transcriptions (multipart form) (POST /v1/audio/transcriptions) */
  createTranscription(headers: { memexApp: AppId; memexFunction: FunctionId; memexLane?: Lane }, body: Uint8Array, contentType: string): Promise<OpenAIResponse> {
    return this.send({ operation: "createTranscription", method: "POST", path: `/v1/audio/transcriptions`, headers: { "Memex-App": headers?.memexApp, "Memex-Function": headers?.memexFunction, "Memex-Lane": headers?.memexLane }, body: { kind: "bytes", value: body, mediaType: contentType }, response: "json", status: 200 }) as Promise<OpenAIResponse>;
  }

  /** OpenAI Speech. The header Memex-Result has the ResultRecord as base64url JSON. (POST /v1/audio/speech) */
  createSpeech(headers: { memexApp: AppId; memexFunction: FunctionId; memexLane?: Lane }, body: OpenAIObject): Promise<NodeBinary> {
    return this.send({ operation: "createSpeech", method: "POST", path: `/v1/audio/speech`, headers: { "Memex-App": headers?.memexApp, "Memex-Function": headers?.memexFunction, "Memex-Lane": headers?.memexLane }, body: { kind: "json", value: body }, response: "bytes", status: 200 }) as Promise<NodeBinary>;
  }

  /** The voices of the text-to-speech route (a Memex addition) (GET /v1/audio/voices) */
  listVoices(headers: { memexApp: AppId; memexFunction: FunctionId }): Promise<ListVoicesResponse> {
    return this.send({ operation: "listVoices", method: "GET", path: `/v1/audio/voices`, headers: { "Memex-App": headers?.memexApp, "Memex-Function": headers?.memexFunction }, response: "json", status: 200 }) as Promise<ListVoicesResponse>;
  }
}
