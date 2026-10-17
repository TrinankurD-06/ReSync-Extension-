#!/usr/bin/env node
import { main } from '../src/index.js';

main(process.argv).catch((e) => {
  console.error(`resync: ${e?.message ?? e}`);
  if (process.env.RESYNC_DEBUG) console.error(e?.stack);
  process.exit(1);
});
