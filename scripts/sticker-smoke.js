// Real-model sticker check without connecting to Slack. Output stays local.
import 'dotenv/config';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AgenticClient, clientSettings, outputText } from '../src/agentic-client.js';
import { renderSticker, stickerTool } from '../src/sticker.js';

const args = process.argv.slice(2);
let imagePath = '';
const flag = args.indexOf('--image');
if (flag >= 0) {
  if (!args[flag+1]) throw new Error('Use --image /path/to/image.png followed by the prompt.');
  imagePath = args.splice(flag, 2)[1];
}
const description = args.join(' ') || 'a happy orange cat doing a little dance';
const sourceImages = imagePath ? { image_1: readFileSync(imagePath) } : {};
const content = [{ type: 'input_text', text: `Create one small animated GIF sticker: ${description}. Use create_sticker.${imagePath ? ' Animate the attached image with ID image_1.' : ' Draw 4 to 8 compact SVG frames.'}` }];
if (imagePath) {
  const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' })[path.extname(imagePath).toLowerCase()];
  if (!mime) throw new Error('Use a PNG, JPEG, GIF or WebP image.');
  content.push({ type: 'input_image', image_url: `data:${mime};base64,${sourceImages.image_1.toString('base64')}`, detail: 'auto' });
}
const client = new AgenticClient(clientSettings());
const dir = path.resolve('.runtime/sticker-smoke');
let count = 0;
try {
  const result = await client.respond({
    input: [{ type: 'message', role: 'user', content }],
    instructions: 'Design an expressive, consistent character with a transparent background and a white outer border. Use compact basic SVG shapes. You must invoke create_sticker. Once it succeeds, confirm briefly. If it returns an error, fix the artwork and retry.',
    tools: [stickerTool], store: false,
    functionHandlers: { create_sticker: async raw => {
      if (count) return { ok: false, error: 'One sticker is enough for this check.' };
      try {
        const args = JSON.parse(raw);
        const file = await renderSticker(args, { sourceImages });
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(path.join(dir, file.filename), file.buffer, { mode: 0o600 });
        writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(args), { mode: 0o600 });
        count++;
        console.log(`Created ${path.join(dir, file.filename)} (${file.buffer.length} bytes)`);
        return { ok: true, filename: file.filename };
      } catch (error) { console.log(`Renderer correction requested: ${error.message}`); return { ok: false, error: error.message }; }
    } },
  });
  if (!count) throw new Error('The model did not create a sticker. Check tool calling on the upstream model.');
  console.log(outputText(result));
} finally { client.close(); }
