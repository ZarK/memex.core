import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkTrustedPublishers } from "../../scripts/check-trusted-publishers.mjs";
import { PUBLISH_PACKAGES } from "../../scripts/publish-packages.mjs";

const ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/request?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-bearer",
};

function entry(packageKey, version = "0.1.1") {
  const allowed = PUBLISH_PACKAGES.get(packageKey);
  return { packageKey, packageName: allowed.filter, version, path: allowed.path, packageJson: allowed.packageJson, filter: allowed.filter };
}

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fakeFetch(answers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.startsWith(ENV.ACTIONS_ID_TOKEN_REQUEST_URL)) return json(200, { value: "github-id-token" });
    const name = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
    return answers[name] ?? json(404, { message: "OIDC token exchange error - package not found" });
  };
  return { fetchImpl, calls };
}

function sink() {
  let text = "";
  return { write: chunk => { text += chunk; }, get text() { return text; } };
}

describe("trusted publisher check", () => {
  it("asks npm for a token for every planned package and never prints the tokens", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "@tjalve/memex-sqlite": json(201, { token: "npm-publish-token-secret" }),
      "@tjalve/memex-schema": json(201, { token: "npm-publish-token-secret" }),
    });
    const output = sink();
    const results = await checkTrustedPublishers([entry("memex-sqlite"), entry("memex-schema", "0.4.0")], { env: ENV, fetch: fetchImpl, output });
    assert.deepEqual(results.map(result => result.ok), [true, true]);
    const exchanges = calls.filter(call => call.init.method === "POST");
    assert.deepEqual(exchanges.map(call => call.url), [
      "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@tjalve%2fmemex-sqlite",
      "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@tjalve%2fmemex-schema",
    ]);
    for (const call of exchanges) assert.equal(call.init.headers.Authorization, "Bearer github-id-token");
    const idRequests = calls.filter(call => call.init.method === undefined);
    for (const call of idRequests) assert.match(call.url, /&audience=npm%3Aregistry\.npmjs\.org$/);
    assert.doesNotMatch(output.text, /secret|github-id-token|request-bearer/);
    assert.match(output.text, /Trusted publishers accepted: 2 packages\./);
  });

  it("checks every package, names each refused one, and fails before staging", async () => {
    const { fetchImpl } = fakeFetch({
      "@tjalve/memex-schema": json(201, { token: "npm-publish-token-secret" }),
    });
    const output = sink();
    await assert.rejects(
      checkTrustedPublishers([entry("memex-sqlite"), entry("memex-schema", "0.4.0"), entry("memex-storage", "1.0.0")], { env: ENV, fetch: fetchImpl, output }),
      error => error.reasonCode === "trusted-publisher"
        && /2 of 3 packages: @tjalve\/memex-sqlite, @tjalve\/memex-storage\. Nothing was staged\./.test(error.message),
    );
    assert.match(output.text, /refused trusted publisher @tjalve\/memex-sqlite: HTTP 404 OIDC token exchange error - package not found\n/);
    assert.match(output.text, /ok trusted publisher @tjalve\/memex-schema\n/);
    assert.doesNotMatch(output.text, /secret/);
  });

  it("refuses a success answer without a token", async () => {
    const { fetchImpl } = fakeFetch({ "@tjalve/memex-sqlite": json(201, {}) });
    await assert.rejects(
      checkTrustedPublishers([entry("memex-sqlite")], { env: ENV, fetch: fetchImpl, output: sink() }),
      error => error.reasonCode === "trusted-publisher",
    );
  });

  it("fails closed without the GitHub OIDC variables and calls nothing", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    await assert.rejects(
      checkTrustedPublishers([entry("memex-sqlite")], { env: {}, fetch: fetchImpl, output: sink() }),
      error => error.reasonCode === "oidc-unavailable" && /id-token: write/.test(error.message),
    );
    assert.equal(calls.length, 0);
  });

  it("refuses a plan entry whose package name does not match the catalog", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    await assert.rejects(
      checkTrustedPublishers([{ ...entry("memex-sqlite"), packageName: "@other/memex-sqlite" }], { env: ENV, fetch: fetchImpl, output: sink() }),
      error => error.reasonCode === "plan",
    );
    assert.equal(calls.length, 0);
  });
});
