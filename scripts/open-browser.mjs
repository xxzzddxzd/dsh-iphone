#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { exchange, launchUrl } from "./web-auth.mjs";

try {
  const target = process.argv[2] ?? "mac";
  const browser = process.env.DSH_BROWSER ?? "Safari";
  const url = await launchUrl(target);
  await exchange(url);
  execFileSync("open", ["-a", browser, url.href], { stdio: "ignore" });
  console.log(`Opened ${target} DSH in ${browser} at ${url.origin}; launch token withheld.`);
} catch {
  console.error("Could not open authenticated DSH. Check the service, SSH, tunnel, and browser name.");
  process.exitCode = 1;
}
