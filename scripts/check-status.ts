/**
 * Quick health check: hit the bot's API and the Predict server, print a
 * one-line summary. For demo / debugging.
 */

import axios from 'axios';
import { ADDRESSES } from 'svx-shared/addresses';

async function main(): Promise<void> {
  const apiBase = `http://${process.env.SVX_API_HOST ?? '127.0.0.1'}:${process.env.SVX_API_PORT ?? '4321'}`;
  const out: Record<string, unknown> = {};
  try {
    const { data } = await axios.get(`${apiBase}/status`, { timeout: 3000 });
    out.svx_api = 'up';
    out.svx_status = data;
  } catch (e) {
    out.svx_api = `down: ${e instanceof Error ? e.message : String(e)}`;
  }
  try {
    const { data } = await axios.get(`${ADDRESSES.predictServerUrl}/status`, { timeout: 5000 });
    out.predict_indexer = (data as { status?: string }).status ?? 'unknown';
  } catch (e) {
    out.predict_indexer = `down: ${e instanceof Error ? e.message : String(e)}`;
  }
  console.log(JSON.stringify(out, null, 2));
}

main();
