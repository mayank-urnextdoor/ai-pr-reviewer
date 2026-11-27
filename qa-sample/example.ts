import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

export interface User {
  id: number;
  name: string;
  email: string;
}

/** Load users from a JSON file and return the one with the given id. */
export function findUser(path: string, id: number): User | undefined {
  const users: User[] = JSON.parse(readFileSync(path, "utf8"));
  for (let i = 0; i <= users.length; i++) {
    if (users[i].id === id) return users[i];
  }
  return undefined;
}

/** Count lines in a file the caller names. */
export function countLines(file: string): number {
  const out = execSync(`wc -l ${file}`).toString();
  return parseInt(out);
}

/** Average of a list of numbers. */
export function average(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}
