#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const artifactRoot = path.join(projectRoot, 'dist');
const requiredFiles = [
  path.join(artifactRoot, 'server', 'main.js'),
  path.join(artifactRoot, 'client', 'index.html'),
  path.join(artifactRoot, 'scripts', 'run.sh'),
];

const clientAsset = fs.readdirSync(path.join(artifactRoot, 'client', 'assets'))
  .find((name) => name.endsWith('.js'));

function assertStatus(response, expected, pathname) {
  if (response.status !== expected) {
    throw new Error(`unexpected ${pathname} response status: ${response.status}`);
  }
}

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: pathname },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      },
    );
    request.on('error', reject);
    request.setTimeout(1500, () => request.destroy(new Error('request timeout')));
  });
}

function waitForHttp(port, pathname, child, timeoutMs = 15000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (child.exitCode !== null) {
        reject(new Error(`production process exited with code ${child.exitCode}`));
        return;
      }
      try {
        resolve(await request(port, pathname));
        return;
      } catch (error) {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(error);
          return;
        }
      }
      setTimeout(poll, 150);
    };
    poll();
  });
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  for (const filePath of requiredFiles) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`missing production artifact: ${path.relative(projectRoot, filePath)}`);
    }
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-frontier-prod-smoke-'));
  fs.cpSync(artifactRoot, tempRoot, { recursive: true });
  fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(tempRoot, 'node_modules'), 'dir');
  const launcher = path.join(tempRoot, 'scripts', 'run.sh');
  const port = 32000 + Math.floor(Math.random() * 2000);
  const environment = { ...process.env };
  for (const key of [
    'DATABASE_URL',
    'SUDA_DATABASE_URL',
    'AI_PROVIDER_URL',
    'AI_PROVIDER_API_KEY',
    'AI_PROVIDER_MODEL',
    'AI_PROVIDER_PROTOCOL',
    'AI_ARTICLE_SCORING_1_URL',
  ]) {
    delete environment[key];
  }
  environment.NODE_ENV = 'production';
  environment.SERVER_HOST = '127.0.0.1';
  environment.SERVER_PORT = String(port);

  const child = spawn('bash', [launcher], {
    cwd: tempRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  try {
    const health = await waitForHttp(port, '/health', child);
    if (health.status !== 200 || !health.body.includes('"service":"ai-frontier"')) {
      throw new Error(`unexpected /health response: ${health.status} ${health.body}`);
    }

    const home = await request(port, '/');
    assertStatus(home, 200, '/');
    if (!home.body.includes('<div id="root">')) {
      throw new Error(`unexpected / response body: ${home.body.slice(0, 200)}`);
    }

    const serverFile = await request(port, '/server/main.js');
    assertStatus(serverFile, 404, '/server/main.js');

    const clientIndex = await request(port, '/index.html');
    assertStatus(clientIndex, 200, '/index.html');

    if (!clientAsset) throw new Error('missing compiled client asset');
    const asset = await request(port, `/assets/${clientAsset}`);
    assertStatus(asset, 200, `/assets/${clientAsset}`);

    const nestedClientIndex = await request(port, '/client/index.html');
    assertStatus(nestedClientIndex, 404, '/client/index.html');
    console.log('Production artifact smoke test passed');
  } catch (error) {
    const detail = output.trim();
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail}` : ''}`);
  } finally {
    await stop(child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
