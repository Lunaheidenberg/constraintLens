import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Run after the production build with CONSTRAINTLENS_TEST_BROWSER pointing at Edge or Chrome.
export const browser = process.env.CONSTRAINTLENS_TEST_BROWSER;

async function waitForPage(profile) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const [port] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/);
      const pages = await (await fetch("http://127.0.0.1:" + port + "/json/list", {
        signal: AbortSignal.timeout(500),
      })).json();
      const page = pages.find(({ type, url }) => type === "page" && url.startsWith("file:"));
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // The browser writes its port file during startup.
    }
    await delay(50);
  }
  throw new Error("Edge or Chrome did not expose the temporary test page");
}

export async function command(socket, method, params) {
  const reply = once(socket, "message", { signal: AbortSignal.timeout(22000) });
  socket.send(JSON.stringify({ id: 1, method, params }));
  const [{ data }] = await reply;
  const response = JSON.parse(data);
  if (response.error) throw new Error(response.error.message);
  return response.result;
}

export async function evaluate(socket, expression) {
  const response = await command(socket, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return response?.result.value ?? response?.exceptionDetails?.text;
}

export async function press(socket, key, windowsVirtualKeyCode, modifiers = 0) {
  const params = { key, code: key, windowsVirtualKeyCode, modifiers };
  await command(socket, "Input.dispatchKeyEvent", key === "Enter"
    ? { ...params, type: "keyDown", text: "\r" }
    : { ...params, type: "rawKeyDown" });
  await command(socket, "Input.dispatchKeyEvent", { ...params, type: "keyUp" });
}

export async function withProductionBrowser(prepareScenario, verify) {
  const dist = new URL("../dist/", import.meta.url);
  const index = await readFile(new URL("index.html", dist), "utf8");
  const asset = index.match(/<script\b[^>]*\bsrc="([^"]+\.js)"[^>]*><\/script>/)?.[1];
  const style = index.match(/<link\b[^>]*\bhref="([^"]+\.css)"[^>]*>/)?.[1];
  assert.ok(asset && style, "Run the production build first");
  const bundle = await readFile(new URL(asset.replace(/^\//, ""), dist), "utf8");
  const css = await readFile(new URL(style.replace(/^\//, ""), dist), "utf8");
  // Install the fetch stub before loading the production entry point.
  const html = '<!doctype html><html lang="vi"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>' +
    css + '</style><body><div id="root"></div>' +
    '<script>window.runBrowserScenario = (' + prepareScenario.toString() + ')();</script>' +
    '<script type="module">' + bundle.replaceAll("</script", "<\\/script") +
    '\nwindow.browserScenarioResult = window.runBrowserScenario().then(() => "passed", (error) => error.message);</script>';
  const tempRoot = await realpath(tmpdir());
  const directory = await realpath(await mkdtemp(join(tempRoot, "constraintlens-browser-")));
  assert.equal(dirname(directory), tempRoot);
  let child;
  let socket;
  try {
    const page = join(directory, "scenario.html");
    const profile = join(directory, "profile");
    await writeFile(page, html);
    child = spawn(browser, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--disable-background-networking",
      "--disable-sync", "--disable-component-update", "--host-resolver-rules=MAP * ~NOTFOUND",
      "--remote-debugging-port=0", "--user-data-dir=" + profile, pathToFileURL(page).href,
    ], { windowsHide: true, stdio: "ignore" });
    socket = await Promise.race([
      waitForPage(profile).then((url) => new WebSocket(url)),
      once(child, "error").then(([error]) => { throw error; }),
    ]);
    await once(socket, "open", { signal: AbortSignal.timeout(2000) });
    const outcome = await evaluate(socket, 'Promise.race([new Promise((resolve) => {' +
      'const poll = setInterval(() => { if (window.browserScenarioResult) { clearInterval(poll); resolve(window.browserScenarioResult); } }, 25);' +
      '}), new Promise((resolve) => setTimeout(() => resolve("Timed out waiting for React"), 20000))])');
    assert.equal(outcome, "passed");

    await verify(socket);
  } finally {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ id: 2, method: "Browser.close" }));
      await Promise.race([once(socket, "close"), delay(1500)]);
      socket.close();
    }
    if (child?.exitCode === null) child.kill();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}
