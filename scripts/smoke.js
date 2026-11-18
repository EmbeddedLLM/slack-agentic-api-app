// Explicitly invoked by an operator; sends one prompt to their configured gateway.
import 'dotenv/config';
import { AgenticClient, clientSettings, outputText } from '../src/agentic-client.js';
const client = new AgenticClient(clientSettings());
try {
  const result = await client.respond({ input: 'Say hello in one short sentence.', store: false, tools: [] });
  console.log(outputText(result));
  console.log('WebSocket Responses connection succeeded.');
} finally {
  client.close();
}
