'use strict';

const fs = require('node:fs');
const path = require('node:path');

const targetFile = path.resolve(__dirname, '..', 'trade.js');
const maxLines = Number.parseInt(process.env.TRADE_JS_MAX_LINES || '19000', 10);

if (!Number.isFinite(maxLines) || maxLines <= 0) {
  console.error(`Invalid TRADE_JS_MAX_LINES value: ${process.env.TRADE_JS_MAX_LINES || '(unset)'}`);
  process.exit(1);
}

const fileContents = fs.readFileSync(targetFile, 'utf8');
const lineCount = fileContents.split('\n').length;

if (lineCount > maxLines) {
  console.error(
    `Complexity budget exceeded for backend/trade.js: ${lineCount} lines (max allowed: ${maxLines}).`
  );
  process.exit(1);
}

console.log(`Complexity budget OK for backend/trade.js: ${lineCount}/${maxLines} lines.`);
