// Run with Node.js to generate placeholder icons
// node generate-icons.js
const { createCanvas } = require('canvas');
const fs = require('fs');

[16, 48, 128].forEach(size => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1ab7ea';
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.18);
  ctx.fill();
  ctx.fillStyle = '#fff';
  const cx = size / 2, cy = size / 2, r = size * 0.28;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r * 1.1);
  ctx.lineTo(cx + r * 1.1, cy);
  ctx.lineTo(cx - r, cy + r * 1.1);
  ctx.closePath();
  ctx.fill();
  fs.writeFileSync(`icons/icon${size}.png`, canvas.toBuffer('image/png'));
  console.log(`Generated icon${size}.png`);
});
