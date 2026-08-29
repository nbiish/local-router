import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentCommit, getCurrentVersion, checkUpdateStatus } from "../build/update-checker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

test("update-checker: getCurrentCommit returns a valid string", () => {
  const commit = getCurrentCommit(projectRoot);
  assert.ok(typeof commit === "string" && commit.length > 0);
});

test("update-checker: getCurrentVersion returns a semantic version string", () => {
  const version = getCurrentVersion(projectRoot);
  assert.match(version, /^\d+\.\d+\.\d+/);
});

test("update-checker: checkUpdateStatus returns structured status object", async () => {
  const status = await checkUpdateStatus(projectRoot, true);
  assert.ok(status);
  assert.ok(typeof status.currentVersion === "string");
  assert.ok(typeof status.currentCommit === "string");
  assert.ok(typeof status.hasUpdate === "boolean");
  assert.ok(typeof status.lastCheckedAt === "number");
});
