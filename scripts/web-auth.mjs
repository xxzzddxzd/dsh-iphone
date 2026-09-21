import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Keep launch tokens inside the process: callers never print the returned URL.
export async function launchUrl(target) {
  let log;
  let port;
  if (target === "mac") {
    log = await readFile(process.env.DSH_MAC_LOG ?? join(homedir(), "Library/Logs/dsh-mac.log"), "utf8");
    port = process.env.MAC_PORT ?? "3080";
  } else if (target === "iphone") {
    log = execFileSync("ssh", [
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
      "-p", process.env.DEVICE_PORT ?? "22",
      `${process.env.DEVICE_USER ?? "root"}@${process.env.DEVICE_HOST ?? "10.99.1.41"}`,
      "tail -c 200000 /var/root/dsh.log",
    ], { encoding: "utf8", maxBuffer: 250000 });
    port = process.env.LOCAL_PORT ?? "3081";
  } else {
    throw new Error("target must be mac or iphone");
  }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("invalid local port");
  const match = [...log.matchAll(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]{43}/g)].at(-1);
  if (!match) throw new Error(`${target}: no launch URL in service log`);
  const url = new URL(match[0]);
  url.port = port;
  return url;
}

export async function exchange(url) {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000) });
  const header = response.headers.get("set-cookie");
  if (response.status !== 303 || response.headers.get("location") !== "/" || !header) {
    throw new Error(`launch exchange failed (HTTP ${response.status}); check service and current log`);
  }
  await response.arrayBuffer();
  return { cookie: header.split(";", 1)[0], header };
}
