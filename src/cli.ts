#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { compile } from './compiler';

function usage() {
  console.error('Usage: rustyscript compile <file.rsc>');
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 2 || argv[0] !== 'compile') usage();
  const infile = argv[1];
  if (!fs.existsSync(infile)) {
    console.error('File not found:', infile);
    process.exit(2);
  }
  const src = fs.readFileSync(infile, 'utf8');
  try {
    const out = compile(src, infile);
    const outpath = path.join(path.dirname(infile), path.basename(infile, '.rsc') + '.js');
    fs.writeFileSync(outpath, out, 'utf8');
    console.log('Wrote', outpath);
  } catch (err: any) {
    console.error('Compile error:', err.message || err);
    process.exit(1);
  }
}

main();
