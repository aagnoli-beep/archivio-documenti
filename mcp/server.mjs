#!/usr/bin/env node
/**
 * Server MCP locale "Archivio di casa" (stdio) per Claude Desktop / Claude Code.
 * Configurazione: ~/.config/archivio-documenti/config.json { apiUrl, secret } oppure variabili
 * ARCHIVIO_API_URL, ARCHIVIO_SECRET, ARCHIVIO_DOWNLOAD_DIR (default ~/Downloads/Archivio).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { registerTools } from './tools.mjs';

function readLocalConfig() {
  try { return JSON.parse(readFileSync(path.join(os.homedir(), '.config', 'archivio-documenti', 'config.json'), 'utf8')); } catch { return {}; }
}
const LOCAL = readLocalConfig();
const API_URL = process.env.ARCHIVIO_API_URL || LOCAL.apiUrl || '';
const SECRET = process.env.ARCHIVIO_SECRET || LOCAL.secret || '';
const DOWNLOAD_DIR = process.env.ARCHIVIO_DOWNLOAD_DIR || LOCAL.downloadDir || path.join(os.homedir(), 'Downloads', 'Archivio');

export async function api(action, payload = {}) {
  if (!API_URL || !SECRET) throw new Error('Server MCP non configurato: mancano ARCHIVIO_API_URL o ARCHIVIO_SECRET');
  const res = await fetch(API_URL, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, secret: SECRET, ...payload }) });
  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); } catch { throw new Error('Risposta non valida dal backend (HTTP ' + res.status + '): ' + txt.slice(0, 200)); }
  if (!json.ok) throw new Error(json.error || 'Errore del backend');
  return json.data;
}

export function createServer() {
  const server = new McpServer({ name: 'archivio-di-casa', version: '1.1.0' });
  registerTools(server, api, {
    z,
    saveFile: async (name, bytes, cartella) => {
      const dir = cartella || DOWNLOAD_DIR;
      await fs.mkdir(dir, { recursive: true });
      const dest = path.join(dir, name);
      await fs.writeFile(dest, bytes);
      return dest;
    }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await createServer().connect(new StdioServerTransport());
}
