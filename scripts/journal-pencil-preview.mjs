// Read-only static QA server. No API or database access.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, {'Content-Type':file.endsWith('.js') ? 'application/javascript' :
      file.endsWith('.css') ? 'text/css' : 'text/html', 'Cache-Control':'no-store'});
    res.end(body);
  } catch { res.writeHead(404).end(); }
}).listen(8098, '127.0.0.1', () => console.log('http://127.0.0.1:8098/scripts/journal-pencil-fixture.html'));
