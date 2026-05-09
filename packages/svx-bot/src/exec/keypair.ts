/**
 * Sui keypair loader.
 *
 * Resolution order:
 *   1. SUI_PRIVATE_KEY_BECH32 env (suiprivkey1...) — preferred for headless.
 *   2. The active address from the local sui CLI keystore
 *      (~/.sui/sui_config/sui.keystore + sui.aliases) — for dev convenience.
 *
 * The keypair is constructed lazily and cached. We never log the private key.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromBase64 } from '@mysten/bcs';
import yaml from 'js-yaml';
import { log } from '../util/log.js';

let cached: { keypair: Ed25519Keypair; address: string } | null = null;

export interface LoadedKey {
  keypair: Ed25519Keypair;
  address: string;
}

export function loadOperatorKey(): LoadedKey {
  if (cached) return cached;

  const fromEnv = process.env.SUI_PRIVATE_KEY_BECH32;
  if (fromEnv && fromEnv.startsWith('suiprivkey')) {
    const { schema, secretKey } = decodeSuiPrivateKey(fromEnv);
    if (schema !== 'ED25519') {
      throw new Error(`only ed25519 keys supported (got ${schema})`);
    }
    const kp = Ed25519Keypair.fromSecretKey(secretKey);
    cached = { keypair: kp, address: kp.toSuiAddress() };
    return cached;
  }

  // Fall back to the local sui CLI keystore.
  const home = os.homedir();
  const cfgPath = path.join(home, '.sui', 'sui_config', 'client.yaml');
  if (!fs.existsSync(cfgPath)) {
    throw new Error(
      `No SUI_PRIVATE_KEY_BECH32 in env, and no client.yaml at ${cfgPath}. ` +
        `Set SUI_PRIVATE_KEY_BECH32, or run \`sui client new-address ed25519\`.`,
    );
  }
  const raw = fs.readFileSync(cfgPath, 'utf8');
  const cfg = yaml.load(raw) as {
    active_address?: string;
    keystore?: { File?: string };
  };
  const activeAddr = cfg.active_address;
  const keystorePath = cfg.keystore?.File;
  if (!activeAddr || !keystorePath) {
    throw new Error(`malformed client.yaml at ${cfgPath} — missing active_address or keystore`);
  }
  const keys = JSON.parse(fs.readFileSync(keystorePath, 'utf8')) as string[];
  for (const encoded of keys) {
    // Each entry is base64-encoded "[scheme byte | 32-byte priv key]" (Sui's wallet format).
    const buf = fromBase64(encoded);
    if (buf.length !== 33) continue;
    const scheme = buf[0];
    if (scheme !== 0x00) continue; // 0 = ed25519
    const secret = buf.slice(1);
    const kp = Ed25519Keypair.fromSecretKey(secret);
    if (kp.toSuiAddress().toLowerCase() === activeAddr.toLowerCase()) {
      cached = { keypair: kp, address: kp.toSuiAddress() };
      log.info('svx.keypair.loaded', { address: cached.address, source: 'local sui keystore' });
      return cached;
    }
  }
  throw new Error(`no ed25519 key matching active address ${activeAddr} found in keystore ${keystorePath}`);
}
