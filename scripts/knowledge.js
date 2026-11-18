import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { KnowledgeClient } from '../src/knowledge-client.js';

const [command, nameOrId, ...files] = process.argv.slice(2);
if (!['create', 'add'].includes(command) || !nameOrId || !files.length) {
  console.error('Usage: npm run knowledge -- create "Team handbook" ./handbook.md\n       npm run knowledge -- add vs_ID ./another-document.txt');
  process.exitCode = 1;
} else {
  const client = new KnowledgeClient({ url: process.env.AGENTIC_WS_URL || 'ws://127.0.0.1:9000/v1/responses', token: process.env.AGENTIC_API_KEY || '' });
  try {
    const uploaded = [];
    for (const file of files) {
      const result = await client.upload(readFileSync(file), path.basename(file));
      uploaded.push(result.id);
      console.log(`Uploaded ${path.basename(file)} as ${result.id}`);
      if (command === 'add') await client.attach(nameOrId, result.id);
    }
    const store = command === 'create' ? await client.create(nameOrId, uploaded) : { id: nameOrId };
    console.log(`Knowledge base ready: ${store.id}\nAdd file_search to the allowed role's tools and set its vectorStoreIds to ["${store.id}"].`);
  } catch (error) {
    console.error(error.message);
    console.error('Successful uploads remain on the gateway. Use the printed file IDs to inspect or delete them if ingestion failed.');
    process.exitCode = 1;
  }
}
