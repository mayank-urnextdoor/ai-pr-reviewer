import * as github from "@actions/github";
import { run } from "./main.js";
import { createClient } from "./reviewer.js";

await run({
  context: github.context,
  createOctokit: (token) => github.getOctokit(token),
  createClient,
});
