// Trusted raster input only; invoked inside the bounded rendering worker.
import sharp from 'sharp';

function removeSolidBackground(pixels, width, height) {
  const corners = [0, width - 1, (height - 1) * width, width * height - 1];
  // Prefer an opaque corner whose color is shared by the most other corners.
  const distance = (a, b) => [0,1,2].reduce((sum, c) => sum + (pixels[a*4+c] - pixels[b*4+c]) ** 2, 0);
  const opaque = corners.filter(i => pixels[i*4+3] > 127);
  if (!opaque.length) return;
  const target = opaque.reduce((best, i) => opaque.filter(j => distance(i,j) < 3000).length > opaque.filter(j => distance(best,j) < 3000).length ? i : best);
  const visited = new Uint8Array(width * height), queue = new Uint32Array(width * height);
  let tail = 0;
  const add = i => { if (!visited[i]) { visited[i] = 1; queue[tail++] = i; } };
  for (let x=0;x<width;x++) { add(x); add((height-1)*width+x); }
  for (let y=0;y<height;y++) { add(y*width); add(y*width+width-1); }
  // Save target RGB before clearing any pixels.
  const color = Array.from(pixels.subarray(target*4, target*4+3));
  for (let head=0;head<tail;head++) {
    const i=queue[head], x=i%width, y=Math.floor(i/width);
    const near = color.reduce((sum,c,k) => sum+(pixels[i*4+k]-c)**2,0) < 3000;
    if (pixels[i*4+3] > 0 && !near) continue;
    pixels[i*4+3] = 0;
    if (x>0) add(i-1); if (x+1<width) add(i+1);
    if (y>0) add(i-width); if (y+1<height) add(i+width);
  }
}

export async function imageFrames(bytes, settings) {
  let decoded;
  try {
    decoded = await sharp(Buffer.from(bytes), { limitInputPixels: 16_000_000, animated: false }).rotate().resize(512, 512, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch { throw new Error('Image decoding failed. Use a PNG, JPEG, GIF or WebP below 16 megapixels.'); }
  let { data, info: { width, height } } = decoded;
  if (settings.background === 'solid') removeSolidBackground(data, width, height);
  if (!data.some((value,i) => i%4===3 && value>127)) throw new Error('Background removal erased the image. Use background=keep or a transparent cutout.');
  // Crop transparent margins before scaling so photos and generated artwork
  // have a consistent visual size. Work at 2x for a smooth cutout contour.
  let left=width, right=0, top=height, bottom=0;
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) if(data[(y*width+x)*4+3]>32) {
    left=Math.min(left,x); right=Math.max(right,x); top=Math.min(top,y); bottom=Math.max(bottom,y);
  }
  const edge=settings.motion==='spin' ? 310 : 368;
  const cropped=await sharp(data,{raw:{width,height,channels:4}})
    .extract({left,top,width:right-left+1,height:bottom-top+1})
    .resize(edge,edge,{fit:'inside'}).raw().toBuffer({resolveWithObject:true});
  data=cropped.data; width=cropped.info.width; height=cropped.info.height;
  const pad=8, w=width+pad*2, h=height+pad*2;
  const bordered=Buffer.alloc(w*h*4);
  // White outline around nontransparent pixels, then place the original image.
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) if (data[(y*width+x)*4+3]>127) {
    for(let dy=-6;dy<=6;dy++) for(let dx=-6;dx<=6;dx++) if(dx*dx+dy*dy<=36) {
      const i=((y+pad+dy)*w+x+pad+dx)*4; bordered.fill(255,i,i+4);
    }
  }
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const source=(y*width+x)*4, dest=((y+pad)*w+x+pad)*4;
    const alpha=data[source+3]/255;
    if(!alpha) continue;
    for(let c=0;c<3;c++) bordered[dest+c]=Math.round(data[source+c]*alpha+bordered[dest+c]*(1-alpha));
    bordered[dest+3]=Math.max(bordered[dest+3],data[source+3]);
  }
  const png=await sharp(bordered,{raw:{width:w,height:h,channels:4}}).png().toBuffer();
  return Array.from({length:20},(_,i)=>{
    const phase=i*2*Math.PI/20;
    let angle=0, scale=1, y=0, stretch=1;
    if(settings.motion==='bounce') { y=-16*(1-Math.cos(phase))/2; stretch=1-0.035*Math.cos(phase); }
    if(settings.motion==='wiggle') angle=12*Math.sin(phase);
    if(settings.motion==='pulse') scale=1+0.08*Math.sin(phase);
    if(settings.motion==='float') y=8*Math.sin(phase);
    if(settings.motion==='spin') angle=360*i/20;
    return {duration_ms:60,svg:`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><g transform="translate(128 ${128+y}) rotate(${angle}) scale(${scale/stretch} ${scale*stretch})"><image x="${-w/4}" y="${-h/4}" width="${w/2}" height="${h/2}" href="data:image/png;base64,${png.toString('base64')}"/></g></svg>`};
  });
}
